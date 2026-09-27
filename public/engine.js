// Cricket GL Intelligence — decision engine.
// Layers: validation -> cricket analysis -> fantasy projection (Monte Carlo) -> GL optimisation.
// Nothing in here invents player statistics: player-specific inputs come only from sourced evidence
// or user-imported form; everything else is an explicitly labelled generic ODI prior.
const Engine = (() => {
  const MODEL_VERSION = 'GLX-2.0.0 · Pure GL engine (venue · ceiling · differential C/VC)';

  // ---------- RNG ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Generic ODI priors (labelled MODEL PRIOR everywhere they surface) ----------
  // Per-format generic priors. Global calibration (CAL) makes them reproduce typical outcomes:
  // ODI ≈ 270 runs / 7.8 wkts per innings; T20 ≈ 170 runs / 7 wkts.
  const FMT = {
    ODI: { overs: 50, maxOv: 10, ppEnd: 10, deathStart: 40, parttime: 5, shortMin: 25, shortRange: 20, w15: 15,
      BAT_PRIOR: { 1: [38, 88], 2: [38, 88], 3: [42, 86], 4: [38, 88], 5: [34, 92], 6: [28, 98], 7: [24, 100], 8: [16, 85], 9: [11, 75], 10: [8, 65], 11: [6, 55] },
      BOWL_PRIOR: { pace: { wpo: 0.105, epo: 5.7 }, spin: { wpo: 0.095, epo: 5.1 }, parttime: { wpo: 0.075, epo: 6.0 } },
      PHASE: { pp: { rpb: 0.92, pd: 0.9 }, mid: { rpb: 0.93, pd: 0.95 }, death: { rpb: 1.38, pd: 1.55 } },
      RPB0: 0.9, PD0: 0.1 / 6, CAL: { rpb: 1.03, pd: 0.84 }, hi: 300, lo: 230, deathBig: 95, collapsePP: 3 },
    T20: { overs: 20, maxOv: 4, ppEnd: 6, deathStart: 15, parttime: 2, shortMin: 8, shortRange: 10, w15: 6,
      BAT_PRIOR: { 1: [28, 138], 2: [28, 138], 3: [30, 135], 4: [28, 138], 5: [25, 142], 6: [21, 145], 7: [17, 140], 8: [12, 125], 9: [8, 110], 10: [6, 95], 11: [4, 85] },
      BOWL_PRIOR: { pace: { wpo: 0.34, epo: 8.5 }, spin: { wpo: 0.31, epo: 7.7 }, parttime: { wpo: 0.25, epo: 8.9 } },
      PHASE: { pp: { rpb: 1.0, pd: 0.85 }, mid: { rpb: 0.92, pd: 1.0 }, death: { rpb: 1.22, pd: 1.35 } },
      RPB0: 1.38, PD0: 0.33 / 6, CAL: { rpb: 1.07, pd: 0.9 }, hi: 190, lo: 145, deathBig: 60, collapsePP: 3 },
  };
  FMT.T10 = { ...FMT.T20, overs: 10, maxOv: 2, ppEnd: 3, deathStart: 7, parttime: 1, shortMin: 5, shortRange: 4, w15: 3, hi: 110, lo: 80, deathBig: 45 };
  const fmtOf = seed => FMT[seed?.match?.format] || FMT.ODI;


  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pct = (arr, p) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
  const mean = arr => { let s = 0; for (const v of arr) s += v; return s / arr.length; };

  // ---------- Fantasy scoring ----------
  function band(bands, v) { for (const [lo, hi, pts] of bands) if (v >= lo && v < hi) return pts; return 0; }
  function fantasyPoints(l, cfg, role, inXI = true) {
    const r = { xi: inXI ? cfg.playingXI : 0, bat: 0, bowl: 0, field: 0, bonus: 0, neg: 0 };
    if (l.balls > 0 || l.out) {
      r.bat += l.runs * cfg.run;
      r.bonus += l.fours * cfg.four + l.sixes * cfg.six;
      const ms = cfg.milestones.filter(([m]) => l.runs >= m);
      if (ms.length) r.bonus += cfg.milestoneMode === 'cumulative' || (cfg.milestoneMode === 'stack-below-100' && l.runs < 100) ? ms.reduce((a, [, p]) => a + p, 0) : ms[ms.length - 1][1];
      if (l.out && l.runs === 0 && role !== 'BOWL') r.neg += cfg.duck;
      if (l.runs >= cfg.srMinRuns || l.balls >= cfg.srMinBalls) {
        const s = band(cfg.srBands, l.runs / l.balls * 100);
        if (s < 0) r.neg += s; else r.bonus += s;
      }
    }
    if (l.bBalls > 0) {
      r.bowl += l.wkts * cfg.wicket + l.lbwB * cfg.lbwBowled + (cfg.dotsPerPoint ? Math.floor(l.dots / cfg.dotsPerPoint) * cfg.dotPoint : 0) + l.maidens * cfg.maiden;
      const h = cfg.hauls.filter(([w]) => l.wkts >= w);
      if (h.length) r.bonus += cfg.haulMode === 'cumulative' ? h.reduce((a, [, p]) => a + p, 0) : h[h.length - 1][1];
      if (l.bBalls / 6 >= cfg.econMinOvers) {
        const e = band(cfg.econBands, l.conceded / (l.bBalls / 6));
        if (e < 0) r.neg += e; else r.bonus += e;
      }
    }
    r.field += l.catches * cfg.catch + (l.catches >= 3 ? cfg.threeCatchBonus : 0) + l.stumpings * cfg.stumping + l.roD * cfg.runoutDirect + l.roI * cfg.runoutIndirect;
    r.total = r.xi + r.bat + r.bowl + r.field + r.bonus + r.neg;
    return r;
  }
  const emptyLine = () => ({ runs: 0, balls: 0, fours: 0, sixes: 0, out: 0, bBalls: 0, conceded: 0, wkts: 0, lbwB: 0, dots: 0, maidens: 0, catches: 0, stumpings: 0, roD: 0, roI: 0 });

  // ---------- Playing XI engine ----------
  function xiStatus(seed, state) {
    const reports = seed.xiReports.filter(r => !r.superseded);
    // Official XI: user confirmation wins; otherwise a seed officialXI backed by ≥2 agreeing reliable sources.
    const confirmed = state.xiConfirmed || seed.officialXI || null;
    const confirmedBy = state.xiConfirmed ? 'user' : seed.officialXI ? seed.officialXI.sources : null;
    const out = {};
    for (const p of seed.players) {
      const hits = reports.filter(r => r[p.team].includes(p.id));
      const relIn = hits.reduce((a, r) => a + seed.sources[r.source].reliability, 0);
      const relAll = reports.reduce((a, r) => a + seed.sources[r.source].reliability, 0);
      const notes = seed.xiNotes.filter(n => n.players.includes(p.id));
      let status, conf;
      if (confirmed) {
        const inXI = confirmed[p.team].includes(p.id);
        status = inXI ? 'CONFIRMED' : 'NOT IN XI'; conf = 1;
      } else if (hits.length === reports.length) { status = 'CONSENSUS'; conf = relIn / relAll; }
      else if (hits.length === 0) { status = 'NOT REPORTED'; conf = 1 - relIn / relAll; }
      else { status = 'CONFLICTING SOURCES'; conf = relIn / relAll; }
      out[p.id] = { status, conf, support: relIn / relAll, reports: hits.map(r => r.source), notes };
    }
    // provisional XI: top-11 by weighted support per team (only used while official XI unconfirmed)
    const provisional = {};
    for (const t of seed.teams || ['IND', 'WI']) {
      if (confirmed) { provisional[t] = confirmed[t].slice(); continue; }
      provisional[t] = seed.players.filter(p => p.team === t).sort((a, b) => out[b.id].support - out[a.id].support).slice(0, 11).map(p => p.id);
    }
    return { byPlayer: out, xi: provisional, confirmed: !!confirmed, confirmedBy };
  }

  // ---------- Player parameter build ----------
  function buildPlayers(seed, state, xi) {
    const ev = seed.evidence;
    const form = { ...(seed.form || {}), ...(state.form || {}) };
    const F = fmtOf(seed);
    const roles = state.roles || {};
    const credits = state.credits || {};
    const posOv = state.positions || {};
    const res = [];
    for (const t of seed.teams || ['IND', 'WI']) {
      for (const id of xi[t] || []) {
        const s = seed.players.find(p => p.id === id);
        const p = { ...s, role: roles[id] || s.role, pos: posOv[id] || s.pos, credit: credits[id] ?? s.credit ?? null, notes: [], evidence: ev.filter(e => e.player === id), formImported: !!(form[id] && form[id].balls > 0) };
        const [pa, psr] = F.BAT_PRIOR[clamp(p.pos, 1, 11)];
        let avg = pa, sr = psr; const trail = [`Bat prior for position ${p.pos}: avg ${pa}, SR ${psr} (MODEL PRIOR)`];
        const f = form[id];
        if (f && f.balls > 0) {
          const dis = Math.max(0, (f.inns || 0) - (f.no || 0));
          avg = (pa * 4 + f.runs) / (4 + dis);
          const kb = F.overs * 4; sr = (psr / 100 * kb + f.runs) / (kb + f.balls) * 100;
          trail.push(`Blended with imported last-N ODI form (${f.inns} inns, ${f.runs} r, ${f.balls} b; source: ${f.source || 'user'}) → avg ${avg.toFixed(1)}, SR ${sr.toFixed(1)}`);
        }
        for (const e of p.evidence) {
          if (e.metric === 'srRecent') { sr = 0.5 * sr + 0.5 * e.value; trail.push(`Recent SR evidence ${e.value} (n=${e.sample}) blended 50% → SR ${sr.toFixed(1)}`); }
          if (e.metric === 'avgVsOpp') { const m = 1 + clamp((e.value - 45) / 150, -0.1, 0.12); avg *= m; trail.push(`Matchup: avg vs opponent ${e.value} → avg ×${m.toFixed(2)}`); }
          if (e.metric === 'venueRuns') { const m = 1 + 0.03 * Math.min(1, e.sample / 10) * 10 / 3; avg *= m; trail.push(`Venue runs ${e.value} in ${e.sample} (small sample, capped) → avg ×${m.toFixed(2)}`); }
        }
        p.batAvg = avg; p.batSR = sr; p.batTrail = trail;
        if (p.bowl) {
          p.bowl = { ...p.bowl, quota: Math.min(F.maxOv, p.bowl.quota) };
          const b = p.bowl.quota <= F.parttime ? F.BOWL_PRIOR.parttime : F.BOWL_PRIOR[p.bowl.type];
          let wpo = b.wpo, epo = b.epo; const bt = [`Bowl prior (${p.bowl.quota <= F.parttime ? 'part-time' : p.bowl.type}): ${wpo} wkts/over, econ ${epo} (MODEL PRIOR)`];
          if (f && f.overs > 0) {
            const k = F.maxOv * 3; wpo = (b.wpo * k + (f.wkts || 0)) / (k + f.overs); epo = (b.epo * k + (f.conceded || 0)) / (k + f.overs);
            bt.push(`Blended with imported form (${f.overs} ov, ${f.wkts} w, ${f.conceded} r) → ${wpo.toFixed(3)} w/o, econ ${epo.toFixed(2)}`);
          }
          for (const e of p.evidence) if (e.metric === 'venueWkts') { wpo *= 1.04; bt.push(`Venue wickets ${e.value} (n=${e.sample}, small sample) → wkt rate ×1.04`); }
          p.wpo = wpo; p.epo = epo; p.bowlTrail = bt;
        }
        res.push(p);
      }
    }
    return res;
  }

  // ---------- Conditions (venue / pitch / weather / toss) ----------
  function conditions(seed, weather, opts) {
    const F = fmtOf(seed), v = seed.venue || {};
    const c = { F, paceWkt: 1, spinWkt: 1, econ: 1, ppPaceWkt: 1, dewSpinWkt: 1, dewSpinEcon: 1, dewBatSR: 1, rainShortProb: 0, notes: [] };
    const pt = v.pitchType || 'UNKNOWN', ps = v.pitchText?.[0]?.source || null;
    if (v.seamerAvg?.value) { c.paceWkt *= 1.08; c.notes.push({ k: 'venue', t: `Seamer average ${v.seamerAvg.value} at venue (limited data) → pace wicket rate ×1.08`, src: v.seamerAvg.source }); }
    else if (v.paceAssist || pt === 'PACE_ASSIST') { const m = pt === 'PACE_ASSIST' ? 1.1 : 1.05; c.paceWkt *= m; c.notes.push({ k: 'pitch', t: `Pitch report: pace assistance → pace wicket rate ×${m}`, src: ps }); }
    if (v.spinAssist || pt === 'SPIN_ASSIST') { c.spinWkt *= 1.1; c.notes.push({ k: 'pitch', t: 'Pitch report: spin assistance → spin wicket rate ×1.10', src: ps }); }
    if (pt === 'BATTER_FRIENDLY') { c.econ *= 1.06; c.notes.push({ k: 'pitch', t: 'Batter-friendly surface → scoring rate ×1.06', src: ps }); }
    if (pt === 'SLOW' || pt === 'TWO_PACED') { c.econ *= 0.94; c.spinWkt *= 1.05; c.notes.push({ k: 'pitch', t: `${pt.replace('_', '-').toLowerCase()} surface → scoring ×0.94, spin wickets ×1.05`, src: ps }); }
    if (pt === 'BALANCED') c.notes.push({ k: 'pitch', t: 'Pitch classified BALANCED → no pitch multiplier', src: ps });
    if (pt === 'UNKNOWN' && !v.seamerAvg) c.notes.push({ k: 'pitch', t: 'Pitch report unavailable → no pitch adjustment (INSUFFICIENT DATA)', src: null });
    if (v.dewExpected) { c.dewSpinWkt = 0.9; c.dewSpinEcon = 1.05; c.dewBatSR = 1.03; c.notes.push({ k: 'dew', t: 'Dew expected → 2nd-innings spin wickets ×0.9, spin econ ×1.05, batting SR ×1.03', src: ps }); }
    else c.notes.push({ k: 'dew', t: 'Dew not reported → no dew adjustment', src: null });
    if (weather && weather.ok) {
      const h = weather.data.hourly, off = (weather.data.utc_offset_seconds || 0) * 1000;
      const st = seed.match.start ? new Date(new Date(seed.match.start).getTime() + off).toISOString().slice(0, 13) : null;
      const hours = seed.match.format === 'ODI' ? 9 : seed.match.format === 'T10' ? 2 : 4;
      let i0 = st ? h.time.findIndex(t => t.slice(0, 13) === st) : -1;
      let idx = i0 >= 0 ? h.time.slice(i0, i0 + hours).map((_, k) => i0 + k) : h.time.map((t, i) => [t, i]).filter(([t]) => t.startsWith(seed.match.date) && +t.slice(11, 13) >= 13).map(([, i]) => i);
      if (idx.length) {
        const rain = Math.max(...idx.map(i => h.precipitation_probability[i] ?? 0));
        const hum = mean(idx.slice(0, 4).map(i => h.relative_humidity_2m[i]));
        const cloud = mean(idx.slice(0, 4).map(i => h.cloud_cover[i]));
        c.rainShortProb = clamp(rain / 100 * 0.35, 0, 0.4);
        c.notes.push({ k: 'weather', t: `Peak rain probability in match window ${rain}% → modelled chance of a shortened match ${(c.rainShortProb * 100).toFixed(0)}% (heuristic: 0.35 × peak)`, src: 'open_meteo' });
        if (hum >= 70 && cloud >= 40) { c.ppPaceWkt = 1.05; c.notes.push({ k: 'weather', t: `First-session humidity ${hum.toFixed(0)}%, cloud ${cloud.toFixed(0)}% → powerplay pace wickets ×1.05`, src: 'open_meteo' }); }
        c.weather = { rain, hum, cloud };
      }
    } else c.notes.push({ k: 'weather', t: 'Live weather unavailable — weather adjustments disabled (no guessing)', src: null });
    c.tossKnown = opts.tossKnown && !!opts.batFirst; c.batFirst = opts.batFirst;
    return c;
  }

  // ---------- Monte Carlo match simulation ----------
  function simulate(players, cond, cfg, n = 2500, seedNum = 20260927) {
    const rand = mulberry32(seedNum);
    const N = players.length;
    const idx = Object.fromEntries(players.map((p, i) => [p.id, i]));
    const F = cond.F || FMT.ODI; const { PHASE, RPB0, PD0, CAL } = F;
    const phaseOf = o => (o < F.ppEnd ? 'pp' : o < F.deathStart ? 'mid' : 'death');
    const codes = [...new Set(players.map(p => p.team))];
    const teams = Object.fromEntries(codes.map(t => [t, players.filter(p => p.team === t)]));
    const order = t => teams[t].slice().sort((a, b) => a.pos - b.pos || (a.bowl ? 1 : 0) - (b.bowl ? 1 : 0));
    const anyAlt = players.some(p => p.posAlt);
    let orders = Object.fromEntries(codes.map(t => [t, order(t)]));
    const reorder = () => { // batting-position uncertainty: players with posAlt swap slot 50/50 per simulation
      for (const p of players) if (p.posAlt) p._pos = rand() < 0.5 ? p.pos : p.posAlt;
      const o = t => teams[t].slice().sort((a, b) => (a._pos ?? a.pos) - (b._pos ?? b.pos) || (a.posAlt ? -1 : 0) - (b.posAlt ? -1 : 0) || (a.bowl ? 1 : 0) - (b.bowl ? 1 : 0));
      orders = Object.fromEntries(codes.map(t => [t, o(t)]));
    };
    const bowlers = Object.fromEntries(codes.map(t => [t, teams[t].filter(p => p.bowl)]));
    const pts = players.map(() => new Float32Array(n));
    const brk = players.map(() => ({ xi: 0, bat: 0, bowl: 0, field: 0, bonus: 0, neg: 0 }));
    const stat = players.map(() => ({ balls: 0, runs: 0, fours: 0, sixes: 0, bBalls: 0, wkts: 0, conceded: 0, dots: 0, catches: 0, w3: 0, r50: 0, r100: 0, batted: 0 }));
    const sims = [];
    const lines = new Array(N);

    function schedule(bs, overs) {
      const cnt = new Map(bs.map(b => [b.id, 0])); const out = []; let last = null;
      for (let o = 0; o < overs; o++) {
        const ph = phaseOf(o);
        let best = null, bs2 = -1;
        for (const b of bs) {
          const c = cnt.get(b.id); if (b.id === last || c >= F.maxOv) continue;
          const room = b.bowl.quota - c + 0.5; if (room <= 0) continue;
          const sc = (b.bowl[ph] + 0.05) * room * (0.75 + 0.5 * rand());
          if (sc > bs2) { bs2 = sc; best = b; }
        }
        if (!best) for (const b of bs) { if (b.id !== last && cnt.get(b.id) < F.maxOv) { best = b; break; } }
        if (!best) best = bs.find(b => b.id !== last) || bs[0];
        cnt.set(best.id, cnt.get(best.id) + 1); out.push(best); last = best.id;
      }
      return out;
    }

    function innings(batT, bowlT, overs, target, second, tf) {
      const ord = orders[batT]; const fielders = teams[bowlT]; const wk = fielders.find(p => p.wk) || fielders[0];
      const sch = schedule(bowlers[bowlT], overs);
      let score = 0, wk_ = 0, s = 0, ns = 1, next = 2, ball = 0, ppW = 0, last10 = 0, w15 = 0, spinW = 0, bowlW = 0;
      const top3 = [ord[0].id, ord[1].id, ord[2].id]; let top3r = 0;
      for (let o = 0; o < overs && wk_ < 10; o++) {
        const bw = sch[o]; const bl = lines[idx[bw.id]]; const ph = phaseOf(o);
        const spin = bw.bowl.type === 'spin';
        let wm = (spin ? cond.spinWkt : cond.paceWkt) * PHASE[ph].pd * (ph === 'pp' && !spin ? cond.ppPaceWkt : 1);
        let em = cond.econ * PHASE[ph].rpb;
        if (second && spin) { wm *= cond.dewSpinWkt; em *= cond.dewSpinEcon; }
        let overRuns = 0;
        for (let b = 0; b < 6 && wk_ < 10; b++) {
          if (target && score > target) break;
          const bat = ord[s]; const L = lines[idx[bat.id]];
          let rpb = CAL.rpb * bat.batSR / 100 * (bw.epo / 6) / RPB0 * em * tf * (second ? cond.dewBatSR : 1);
          let pd = CAL.pd * (bat.batSR / 100) / bat.batAvg * (bw.wpo / 6) / PD0 * wm / tf;
          if (target) { // chase intent
            const need = (target + 1 - score) / Math.max(1, overs * 6 - ball), ratio = clamp(need / Math.max(0.3, rpb), 0.6, 2.2);
            const k = Math.pow(ratio, 0.5); rpb *= k; pd *= Math.pow(k, 1.4);
          } else if (ph === 'death' && wk_ <= 5) { rpb *= 1.08; pd *= 1.12; }
          if (rand() < 0.035) { score++; bl.conceded++; overRuns++; } // extras (wides/no-balls)
          ball++; bl.bBalls++; L.balls++;
          if (rand() < pd) {
            wk_++; L.out = 1; if (o < F.ppEnd) ppW++; if (o < F.w15) w15 = wk_;
            const u = rand();
            if (u < 0.05) { const f = fielders[Math.floor(rand() * fielders.length)]; const Lf = lines[idx[f.id]]; if (rand() < 0.5) Lf.roD++; else Lf.roI++; }
            else {
              bl.wkts++; bl.dots++; bowlW++; if (spin) spinW++;
              const v = rand();
              const lbwB = spin ? 0.36 : 0.32;
              if (v < lbwB) bl.lbwB++;
              else if (spin && v < lbwB + 0.04) lines[idx[wk.id]].stumpings++;
              else {
                const q = rand(); let c;
                if (q < (spin ? 0.12 : 0.28)) c = wk; else if (q < (spin ? 0.19 : 0.32)) c = bw;
                else { const pool = fielders.filter(f => f !== wk && f !== bw); c = pool[Math.floor(rand() * pool.length)]; }
                lines[idx[c.id]].catches++;
              }
            }
            if (next >= 11) break; s = next++;
            continue;
          }
          // run outcome: scale a base ODI distribution to the target runs-per-ball
          const k = clamp(rpb / 0.925, 0.2, 2.6);
          const p1 = 0.33 * Math.min(k, 1.5), p2 = 0.06 * k, p3 = 0.005 * k, p4 = 0.085 * k * (k > 1 ? 1.1 : 1), p6 = 0.02 * k * k;
          const x = rand(); let r = 0;
          if (x < p6) r = 6; else if (x < p6 + p4) r = 4; else if (x < p6 + p4 + p3) r = 3; else if (x < p6 + p4 + p3 + p2) r = 2; else if (x < p6 + p4 + p3 + p2 + p1) r = 1;
          score += r; bl.conceded += r; overRuns += r; L.runs += r;
          if (r === 4) L.fours++; if (r === 6) L.sixes++; if (r === 0) bl.dots++;
          if (top3.includes(bat.id)) top3r += r;
          if (o >= overs - (F.overs - F.deathStart)) last10 += r;
          if (r % 2 === 1) [s, ns] = [ns, s];
        }
        if (overRuns === 0 && bl.bBalls % 6 === 0) bl.maidens++;
        [s, ns] = [ns, s];
        if (target && score > target) break;
      }
      return { score, wkts: wk_, balls: ball, ppW, last10, w15, top3r, spinW, bowlW };
    }

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < N; j++) lines[j] = emptyLine();
      if (anyAlt) reorder();
      const batFirst = cond.tossKnown ? cond.batFirst : (rand() < 0.5 ? codes[0] : codes[1]);
      const chase = batFirst === codes[0] ? codes[1] : codes[0];
      const overs = rand() < cond.rainShortProb ? F.shortMin + Math.floor(rand() * F.shortRange) : F.overs;
      const g = () => Math.exp((rand() + rand() + rand() - 1.5) * 0.32); // team-day factor → correlation
      const tf = Object.fromEntries(codes.map(t => [t, g()]));
      const a = innings(batFirst, chase, overs, null, false, tf[batFirst]);
      const b = innings(chase, batFirst, overs, a.score, true, tf[chase]);
      for (let j = 0; j < N; j++) {
        const fp = fantasyPoints(lines[j], cfg, players[j].role);
        pts[j][i] = fp.total;
        for (const k of ['xi', 'bat', 'bowl', 'field', 'bonus', 'neg']) brk[j][k] += fp[k];
        const L = lines[j], st = stat[j];
        st.balls += L.balls; st.runs += L.runs; st.fours += L.fours; st.sixes += L.sixes; st.bBalls += L.bBalls; st.wkts += L.wkts; st.conceded += L.conceded; st.dots += L.dots; st.catches += L.catches + L.stumpings;
        if (L.wkts >= 3) st.w3++; if (L.runs >= 50) st.r50++; if (L.runs >= 100) st.r100++; if (L.balls > 0) st.batted++;
      }
      const chaseWon = b.score > a.score;
      sims.push({
        batFirst, overs, inn1: a.score, inn1W: a.wkts, inn2: b.score, inn2W: b.wkts, chaseWon,
        scripts: {
          S1: a.score >= F.hi,
          S2: a.ppW >= F.collapsePP || b.ppW >= F.collapsePP,
          S3: (a.bowlW + b.bowlW) >= 8 && (a.spinW + b.spinW) / (a.bowlW + b.bowlW) >= 0.6,
          S4: chaseWon && b.wkts <= 4,
          S5: a.score < F.lo,
          S6: a.last10 >= F.deathBig || b.last10 >= F.deathBig,
        },
      });
    }
    for (const b of brk) for (const k in b) b[k] /= n;
    for (const st of stat) for (const k in st) st[k] /= n;
    return { players, pts, brk, stat, sims, n, idx };
  }

  const SCRIPTS = {
    S1: 'High-scoring batting match', S2: 'Early-wicket collapse (3+ wkts in a powerplay)', S3: 'Spin dominance (spinners ≥ 60% of bowler wkts)',
    S4: 'Chase dominance (chase won, ≤ 4 wkts down)', S5: 'Low-scoring match', S6: 'Death-over explosion',
  };

  function summarize(sim) {
    const { players, pts, brk, sims } = sim;
    const scriptKeys = Object.keys(SCRIPTS);
    const scriptProb = Object.fromEntries(scriptKeys.map(k => [k, sims.filter(s => s.scripts[k]).length / sims.length]));
    return players.map((p, j) => {
      const a = pts[j]; const m = mean(a);
      const byScript = {};
      for (const k of scriptKeys) { let s = 0, c = 0; for (let i = 0; i < sims.length; i++) if (sims[i].scripts[k]) { s += a[i]; c++; } byScript[k] = c ? s / c : null; }
      const p40 = a.filter(v => v >= 40).length / a.length, p80 = a.filter(v => v >= 80).length / a.length;
      let v = 0; for (const x of a) v += (x - m) * (x - m); const sd = Math.sqrt(v / a.length);
      return { id: p.id, mean: m, floor: pct(a, 10), median: pct(a, 50), p75: pct(a, 75), ceiling: pct(a, 90), p90: pct(a, 90), p95: pct(a, 95), sd, p40, p80, p100: a.filter(x => x >= 100).length / a.length, brk: brk[j], stat: sim.stat[j], byScript, scriptProb };
    });
  }

  // ---------- helpers ----------
  function norm(vals) { const lo = Math.min(...vals), hi = Math.max(...vals); return v => hi === lo ? 50 : (v - lo) / (hi - lo) * 100; }
  // =====================================================================
  // PURE GL ENGINE — venue-based, ceiling-driven, differential C/VC.
  // Deterministic: every candidate start is a named construction, never random.
  // =====================================================================
  const GL_WEIGHTS = { ceilingP90: 35, p95: 20, venue: 15, script: 10, differentiation: 10, cvc: 5, role: 5 };
  const sdev = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2)) * a.length / Math.max(1, a.length - 1)); };

  function venueIndex(seed) {
    const v = seed.venue || {}, fmt = seed.match?.format || 'ODI';
    const ms = (v.formatMatches || v.odiMatches || []).filter(m => m.inn1Runs != null); const n = ms.length;
    const conf = Math.min(1, n / 10);
    const ID = `INSUFFICIENT DATA (${n} ${fmt} matches)`;
    const med = a => { const s = a.slice().sort((x, y) => x - y); return !s.length ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    // recency weights: last 5 = 50%, 6–10 = 30%, older = 20% (spec §4)
    const sorted = ms.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const rw = i => (i < 5 ? 0.5 / Math.min(5, n) : i < 10 ? 0.3 / Math.min(5, n - 5) : 0.2 / Math.max(1, n - 10));
    const wsum = sorted.reduce((a, _, i) => a + rw(i), 0);
    const recencyFirst = n ? sorted.reduce((a, m, i) => a + m.inn1Runs * rw(i), 0) / wsum : null;
    const i1 = ms.map(m => m.inn1Runs), w = ms.flatMap(m => [m.inn1Wkts, m.inn2Wkts]).filter(x => x != null);
    const cv = n >= 2 ? sdev(i1) / mean(i1) : null;
    const bf = ms.filter(m => m.winnerBattedFirst != null);
    const bfWin = bf.length ? bf.filter(m => m.winnerBattedFirst).length / bf.length : null;
    const F = fmtOf(seed);
    const idx = {
      'Venue Batting Index': n >= 3 ? { v: +(recencyFirst / (F.hi + F.lo) * 2).toFixed(2), note: `Recency-weighted 1st inns ${recencyFirst.toFixed(0)} vs format par ${(F.hi + F.lo) / 2}` } : { v: null, note: ID },
      'Venue Bowling Index': v.seamerAvg?.value ? { v: v.seamerAvg.value, note: `Seamer average ${v.seamerAvg.value} (limited data)` } : { v: null, note: ID },
      'Venue Pace Index': { v: v.seamerAvg?.value || v.paceAssist || v.pitchType === 'PACE_ASSIST' ? (v.pitchType === 'PACE_ASSIST' ? 1.1 : v.seamerAvg ? 1.08 : 1.05) : null, note: v.paceAssist || v.seamerAvg || v.pitchType === 'PACE_ASSIST' ? 'From pitch report / seamer record' : ID },
      'Venue Spin Index': { v: v.spinAssist || v.pitchType === 'SPIN_ASSIST' ? 1.1 : null, note: v.spinAssist || v.pitchType === 'SPIN_ASSIST' ? 'Pitch report: spin assistance' : ID },
      'Venue Powerplay Index': { v: null, note: ID + ' — phase splits unavailable' },
      'Venue Middle-Overs Index': { v: null, note: ID + ' — phase splits unavailable' },
      'Venue Death-Overs Index': { v: null, note: ID + ' — phase splits unavailable' },
      'Venue Chasing Index': { v: bfWin == null ? null : +(1 - bfWin).toFixed(2), note: bf.length ? `Chasing side won ${bf.filter(m => !m.winnerBattedFirst).length}/${bf.length}${bf.length < 5 ? ' — small sample' : ''}${v.dewExpected ? '; dew expected' : ''}` : ID },
      'Venue Batting-First Index': { v: bfWin == null ? null : +bfWin.toFixed(2), note: bf.length ? `Batting-first side won ${bf.filter(m => m.winnerBattedFirst).length}/${bf.length}` : ID },
      'Venue Boundary Index': { v: null, note: v.boundaries?.value ? `Boundary size: ${v.boundaries.value}` : ID },
      'Venue Wicket Index': w.length ? { v: +mean(w).toFixed(1), note: `Avg ${mean(w).toFixed(1)} wkts/innings (n=${w.length} innings), SD ${sdev(w).toFixed(1)}` } : { v: null, note: ID },
      'Venue Variance Index': cv != null ? { v: +cv.toFixed(2), note: `CV of 1st-innings totals ${cv.toFixed(2)} → ${cv > 0.2 ? 'HIGH' : 'LOW'}; sample confidence ${(conf * 100).toFixed(0)}%` } : { v: null, note: ID },
    };
    const hiCv = F === FMT.ODI ? 0.2 : 0.15;
    const variance = {
      avgFirst: n ? mean(i1) : null, medianFirst: med(i1), sdFirst: n >= 2 ? sdev(i1) : null, highest: n ? Math.max(...i1) : null, lowest: n ? Math.min(...ms.flatMap(m => [m.inn1Runs, m.inn2Runs]).filter(x => x != null)) : null,
      avgWkts: w.length ? mean(w) : null, sdWkts: w.length >= 2 ? sdev(w) : null, recencyFirst, cv, conf,
      score: cv == null ? 0 : +(Math.min(1, cv / (hiCv * 2)) * 100 * conf).toFixed(0),
      strategy: cv == null ? 'No venue sample → neutral strategy weights' : cv > hiCv ? `High variance (confidence ${(conf * 100).toFixed(0)}%) → differentiation weight up, role-security weight down` : 'Low variance → role-security weighting up',
    };
    const shift = cv == null ? 0 : cv > hiCv ? Math.round(10 * conf) : -Math.round(10 * conf);
    return { idx, variance, n, conf, shift };
  }

  function glPlayers(players, summ, seed, tossDelta, vIdx) {
    const nMean = norm(summ.map(s => s.mean)), nP90 = norm(summ.map(s => s.p90)), nP95 = norm(summ.map(s => s.p95)), nSd = norm(summ.map(s => s.sd));
    const keys = Object.keys(SCRIPTS);
    return players.map((p, j) => {
      const s = summ[j], st = s.stat;
      const ve = p.evidence.filter(e => e.kind === 'venue' && e.sample);
      const sampleConf = ve.length ? Math.min(1, ve[0].sample / 10) : 0;
      // VENUE_PLAYER_SCORE: sample-corrected evidence + venue condition fit (pace index / pitch notes)
      const condFit = p.bowl ? (p.bowl.type === 'pace' ? 62 : 55) : (p.pos <= 4 ? 58 : 52);
      const venue = clamp(condFit * (1 - sampleConf) + (ve.length ? 85 : condFit) * sampleConf, 0, 100);
      const batOpp = clamp(st.balls / 60 * 100, 0, 100), bowlOpp = clamp(st.bBalls / 60 * 100, 0, 100), fieldOpp = clamp(st.catches / 1 * 100, 0, 100);
      const opportunity = clamp(Math.max(batOpp, bowlOpp) + 0.35 * Math.min(batOpp, bowlOpp) + 0.1 * fieldOpp, 0, 100);
      const role = clamp(((p.pos <= 4 ? 92 : p.pos <= 6 ? 76 : p.pos === 7 ? 60 : 30) - (p.posAlt ? 12 : 0)) * 0.6 + (p.bowl ? p.bowl.quota * 9.2 : 0) * 0.6, 0, 100);
      const scriptRatio = Object.fromEntries(keys.map(k => [k, s.byScript[k] != null ? s.byScript[k] / Math.max(1, s.mean) : 1]));
      const bestScript = keys.slice().sort((a, b) => scriptRatio[b] - scriptRatio[a])[0];
      const scriptFit = clamp((keys.reduce((a, k) => a + s.scriptProb[k] * scriptRatio[k], 0) / Math.max(0.01, keys.reduce((a, k) => a + s.scriptProb[k], 0)) - 0.8) / 0.6 * 100, 0, 100);
      // real ownership from the uploaded screenshot when available, otherwise a projection-rank proxy (labelled MODEL)
      const ownVals = players.map(x => x.ownership).filter(x => typeof x === 'number');
      const popularity = typeof p.ownership === 'number' && ownVals.length >= players.length / 2 ? clamp(p.ownership, 0, 100) : nMean(s.mean);
      const differential = clamp(0.3 * nP90(s.p90) + 0.15 * nMean(s.mean) + 0.15 * role + 0.15 * venue + 0.15 * scriptFit - 0.3 * popularity + 30, 0, 100);
      const variance = nSd(s.sd);
      const glValue = (nP90(s.p90) / 100 + 0.05) * (venue / 100) * (0.5 + role / 200) * (0.6 + scriptFit / 250) * (0.7 + differential / 333);
      let cls = 'CORE';
      if (s.p40 >= 0.5 && popularity >= 55 && role >= 50) cls = 'CORE';
      else if (differential >= 55 && s.p90 >= 70) cls = 'DIFFERENTIAL';
      else if (variance >= 55 || s.p95 / Math.max(1, s.median) >= 2.6) cls = 'PUNT';
      else cls = 'DIFFERENTIAL';
      return { id: p.id, ownership: typeof p.ownership === 'number' ? p.ownership : null, venue, venueSample: ve.length ? ve[0].sample : 0, opportunity, batOpp, bowlOpp, role, scriptRatio, bestScript, scriptFit, popularity, differential, variance, glValue, cls,
        toss: tossDelta[p.id] || 0, exp: { balls: st.balls, runs: st.runs, fours: st.fours, sixes: st.sixes, overs: st.bBalls / 6, wkts: st.wkts, dots: st.dots, catches: st.catches, pW3: st.w3, p50: st.r50, p100: st.r100, pBat: st.batted } };
    });
  }

  function teamTotals(sim, S, C, VC, cfg, out) {
    const n = sim.n; const t = out || new Float32Array(n); t.fill(0);
    for (const j of S) { const a = sim.pts[j]; const m = j === C ? cfg.captain : j === VC ? cfg.viceCaptain : 1; for (let i = 0; i < n; i++) t[i] += a[i] * m; }
    return t;
  }
  function corrOf(x, y) { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; } return sxy / Math.sqrt(sxx * syy || 1); }

  function cvcCombos(players, sim, summ, gp, S, cfg, seed, limit = 5) {
    const out = []; const buf = new Float32Array(sim.n);
    for (const C of S) for (const VC of S) {
      if (C === VC) continue;
      const t = teamTotals(sim, S, C, VC, cfg, buf);
      out.push({ C, VC, mean: mean(t), p90: pct(t, 90), p95: pct(t, 95) });
    }
    const n90 = norm(out.map(o => o.p90)), n95 = norm(out.map(o => o.p95));
    for (const o of out) {
      const c = gp[o.C], v = gp[o.VC], sc = summ[o.C], sv = summ[o.VC];
      const r = corrOf(sim.pts[o.C], sim.pts[o.VC]);
      const routesC = [sc.brk.bat + sc.brk.bonus > 12, sc.brk.bowl > 12], routesV = [sv.brk.bat + sv.brk.bonus > 12, sv.brk.bowl > 12];
      const complementary = routesC[0] !== routesV[0] || routesC[1] !== routesV[1];
      o.capLev = 0.45 * n95(o.p95) / 100 + 0.25 * c.differential / 100 + 0.15 * c.venue / 100 + 0.15 * c.role / 100;
      o.vcLev = 0.4 * sv.p90 / Math.max(...summ.map(s => s.p90)) + 0.3 * v.differential / 100 + 0.3 * v.role / 100;
      o.corr = r; o.complementary = complementary;
      o.score = 100 * (0.35 * n95(o.p95) / 100 + 0.25 * n90(o.p90) / 100 + 0.2 * o.capLev + 0.1 * o.vcLev + 0.05 * (complementary ? 1 : 0) + 0.05 * (1 - Math.abs(r)));
      const types = [];
      if (sc.mean >= pct(summ.map(s => s.mean), 80) && sc.p90 >= pct(summ.map(s => s.p90), 80)) types.push('SAFE-HIGH-CEILING C');
      if (c.differential >= 60) types.push('DIFFERENTIAL C');
      if (c.venueSample > 0) types.push('VENUE-SPECIALIST C');
      if (c.scriptRatio[c.bestScript] >= 1.35) types.push(`MATCH-SCRIPT C (${c.bestScript})`);
      if (sc.p95 / Math.max(1, sc.median) >= 2.6) types.push('HIGH-VARIANCE C');
      o.types = types.length ? types : ['BALANCED C'];
      o.script = r < -0.05 ? 'Opposite-script hedge (negative correlation) — high-variance GL construction' : r > 0.15 ? 'Same-script stack (positive correlation)' : 'Independent scoring routes';
    }
    out.sort((a, b) => b.score - a.score);
    // keep combinations mathematically distinct: prefer different captains in the top list
    const picked = []; const seenC = new Map();
    for (const o of out) { const k = seenC.get(o.C) || 0; if (k >= 2) continue; seenC.set(o.C, k + 1); picked.push(o); if (picked.length >= limit) break; }
    return picked;
  }

  function riskBand(t) { const m = mean(t), sd = Math.sqrt(mean(Array.from(t, x => (x - m) ** 2))); const cv = sd / m; return { cv, band: cv < 0.2 ? 'Moderate GL' : cv < 0.27 ? 'High GL' : 'Extreme GL', sd }; }

  function optimiseGL(players, sim, summ, gp, cfg, cons, W, vShift) {
    const N = players.length, n = sim.n;
    const codes = [...new Set(players.map(p => p.team))];
    const w = { ...W }; w.differentiation += vShift; w.role -= vShift; // venue variance changes strategy
    const Wsum = Object.values(w).reduce((a, b) => a + b, 0);
    const creditsKnown = players.every(p => typeof p.credit === 'number');
    const feasible = S => {
      if (S.length !== cons.players || new Set(S).size !== S.length) return false;
      const rc = { WK: 0, BAT: 0, AR: 0, BOWL: 0 }, tc = Object.fromEntries(codes.map(t => [t, 0])); let cr = 0;
      for (const j of S) { rc[players[j].role]++; tc[players[j].team]++; cr += players[j].credit || 0; }
      for (const r in cons.roles) if (rc[r] < cons.roles[r][0] || rc[r] > cons.roles[r][1]) return false;
      if (codes.some(t => tc[t] > cons.maxFromTeam || tc[t] < 1)) return false;
      if (creditsKnown && cr > cons.credits + 1e-9) return false;
      return true;
    };
    const capQ = j => summ[j].p95 * (0.6 + gp[j].differential / 250) * (0.6 + gp[j].role / 250);
    const vcQ = j => summ[j].p90 * (0.6 + gp[j].differential / 250) * (0.7 + gp[j].role / 333);
    const buf = new Float32Array(n);
    const keys = Object.keys(SCRIPTS);
    let ref90 = 1, ref95 = 1, evals = 0;
    const metrics = S => {
      const C = S.slice().sort((a, b) => capQ(b) - capQ(a))[0];
      const VC = S.filter(j => j !== C).sort((a, b) => vcQ(b) - vcQ(a))[0];
      const t = teamTotals(sim, S, C, VC, cfg, buf);
      const p90 = pct(t, 90), p95 = pct(t, 95), m = mean(t);
      const venue = mean(S.map(j => gp[j].venue)), role = mean(S.map(j => gp[j].role)), diff = mean(S.map(j => gp[j].differential));
      const sumMean = S.reduce((a, j) => a + summ[j].mean, 0);
      const scriptLift = Object.fromEntries(keys.map(k => [k, S.reduce((a, j) => a + (summ[j].byScript[k] ?? summ[j].mean), 0) / sumMean]));
      const best = keys.slice().sort((a, b) => scriptLift[b] - scriptLift[a])[0];
      const script = clamp((scriptLift[best] - 1) / 0.4, 0, 1) * 100;
      const cvc = clamp((capQ(C) + 0.5 * vcQ(VC)) / (1.5 * Math.max(...S.map(capQ))) * 100, 0, 100);
      const obj = (w.ceilingP90 * p90 / ref90 * 100 + w.p95 * p95 / ref95 * 100 + w.venue * venue + w.script * script + w.differentiation * diff + w.cvc * cvc + w.role * role) / Wsum;
      evals++;
      return { S, C, VC, obj, mean: m, p90, p95, ceiling: pct(t, 99), floor: pct(t, 10), venue, role, diff, script, best, scriptLift, cvc, risk: riskBand(t) };
    };
    const byKey = f => [...Array(N).keys()].sort((a, b) => f(b) - f(a));
    const build = order => {
      const S = [];
      for (const r of ['WK', 'BAT', 'AR', 'BOWL']) for (const j of order) if (players[j].role === r && S.filter(k => players[k].role === r).length < cons.roles[r][0] && !S.includes(j)) S.push(j);
      for (const j of order) { if (S.length >= 11) break; if (S.includes(j)) continue; const T = S.concat(j); const rc = T.filter(k => players[k].role === players[j].role).length; const tc = T.filter(k => players[k].team === players[j].team).length; if (rc <= cons.roles[players[j].role][1] && tc <= cons.maxFromTeam) S.push(j); }
      if (feasible(S)) return S;
      // repair for credits: swap most expensive for cheapest feasible
      for (let it = 0; it < 40 && !feasible(S); it++) {
        const out = S.slice().sort((a, b) => (players[b].credit || 0) - (players[a].credit || 0))[0];
        const inn = order.filter(j => !S.includes(j) && players[j].role === players[out].role && (players[j].credit || 0) < (players[out].credit || 0)).pop();
        if (inn == null) break; S[S.indexOf(out)] = inn;
      }
      return feasible(S) ? S : null;
    };
    // reference = highest-average construction (what the GL objective must beat on ceiling, not copy)
    const avgTeam = build(byKey(j => summ[j].mean));
    if (!avgTeam) return { ok: false, reason: 'No feasible team under current constraints (check credits/role limits)' };
    { const r = metrics(avgTeam); ref90 = r.p90; ref95 = r.p95; }
    const starts = [
      ['Highest-average construction (reference)', byKey(j => summ[j].mean)],
      ['Ceiling construction (P90)', byKey(j => summ[j].p90)],
      ['P95 construction', byKey(j => summ[j].p95)],
      ['GL-value construction', byKey(j => gp[j].glValue)],
      ['Differential construction', byKey(j => gp[j].differential * summ[j].p90)],
      ...keys.map(k => [`Script construction — ${SCRIPTS[k]}`, byKey(j => summ[j].byScript[k] ?? 0)]),
    ];
    const results = [];
    for (const [label, order] of starts) {
      let S = build(order); if (!S) continue;
      let cur = metrics(S);
      for (let it = 0; it < 40; it++) {
        let best = null;
        for (const o of S) for (let j = 0; j < N; j++) {
          if (S.includes(j)) continue; const T = S.map(k => (k === o ? j : k)); if (!feasible(T)) continue;
          const e = metrics(T); if (e.obj > (best ? best.obj : cur.obj) + 1e-6) best = e;
        }
        if (!best) break; cur = best; S = best.S;
      }
      results.push({ label, ...cur });
    }
    results.sort((a, b) => b.obj - a.obj);
    const top = results[0];
    const avg = metrics(avgTeam);
    return { ok: true, ...top, S: top.S, start: top.label, candidates: evals, creditsKnown, credits: top.S.reduce((a, j) => a + (players[j].credit || 0), 0), weights: w, avgRef: avg, alternatives: results.slice(1, 4).map(r => ({ label: r.label, obj: r.obj, p90: r.p90, players: r.S.map(j => players[j].id) })), uniqueVsAvg: top.S.filter(j => !avgTeam.includes(j)).length };
  }

  return { GL_WEIGHTS, FMT, venueIndex, glPlayers, cvcCombos, optimiseGL, teamTotals, riskBand, corrOf, MODEL_VERSION, SCRIPTS, xiStatus, buildPlayers, conditions, simulate, summarize, fantasyPoints, emptyLine, mean, pct };
})();
if (typeof module !== 'undefined') module.exports = Engine;
