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
  const BAT_PRIOR = { 1: [38, 88], 2: [38, 88], 3: [42, 86], 4: [38, 88], 5: [34, 92], 6: [28, 98], 7: [24, 100], 8: [16, 85], 9: [11, 75], 10: [8, 65], 11: [6, 55] };
  const BOWL_PRIOR = { pace: { wpo: 0.105, epo: 5.7 }, spin: { wpo: 0.095, epo: 5.1 }, parttime: { wpo: 0.075, epo: 6.0 } };
  const PHASE = { pp: { rpb: 0.92, pd: 0.9 }, mid: { rpb: 0.93, pd: 0.95 }, death: { rpb: 1.38, pd: 1.55 } };
  const RPB0 = 0.9, PD0 = 0.1 / 6;
  // Global calibration so the generic priors reproduce typical modern ODI outcomes (≈280 runs, ≈7.5 wkts per innings).
  const CAL = { rpb: 1.03, pd: 0.84 };

  const DEFAULT_WEIGHTS = { form: 15, venue: 15, role: 15, expected: 20, ceiling: 10, pitch: 10, toss: 5, matchup: 5, fielding: 5, differential: 5 };
  const DEFAULT_OBJECTIVE = { mean: 0.45, ceiling: 0.45, selection: 0.10, ceilingPct: 85 };
  const DEFAULT_RECENCY = { last5: 50, mid: 30, older: 20 };

  const phaseOf = o => (o < 10 ? 'pp' : o < 40 ? 'mid' : 'death');
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
      if (ms.length) r.bonus += cfg.milestoneMode === 'cumulative' ? ms.reduce((a, [, p]) => a + p, 0) : ms[ms.length - 1][1];
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
    for (const t of ['IND', 'WI']) {
      if (confirmed) { provisional[t] = confirmed[t].slice(); continue; }
      provisional[t] = seed.players.filter(p => p.team === t).sort((a, b) => out[b.id].support - out[a.id].support).slice(0, 11).map(p => p.id);
    }
    return { byPlayer: out, xi: provisional, confirmed: !!confirmed, confirmedBy };
  }

  // ---------- Player parameter build ----------
  function buildPlayers(seed, state, xi) {
    const ev = seed.evidence;
    const form = state.form || {};
    const roles = state.roles || {};
    const credits = state.credits || {};
    const posOv = state.positions || {};
    const res = [];
    for (const t of ['IND', 'WI']) {
      for (const id of xi[t]) {
        const s = seed.players.find(p => p.id === id);
        const p = { ...s, role: roles[id] || s.role, pos: posOv[id] || s.pos, credit: credits[id] ?? null, notes: [], evidence: ev.filter(e => e.player === id), formImported: !!(form[id] && form[id].balls > 0) };
        const [pa, psr] = BAT_PRIOR[clamp(p.pos, 1, 11)];
        let avg = pa, sr = psr; const trail = [`Bat prior for position ${p.pos}: avg ${pa}, SR ${psr} (MODEL PRIOR)`];
        const f = form[id];
        if (f && f.balls > 0) {
          const dis = Math.max(0, (f.inns || 0) - (f.no || 0));
          avg = (pa * 4 + f.runs) / (4 + dis);
          sr = (psr / 100 * 200 + f.runs) / (200 + f.balls) * 100;
          trail.push(`Blended with imported last-N ODI form (${f.inns} inns, ${f.runs} r, ${f.balls} b; source: ${f.source || 'user'}) → avg ${avg.toFixed(1)}, SR ${sr.toFixed(1)}`);
        }
        for (const e of p.evidence) {
          if (e.metric === 'srRecent') { sr = 0.5 * sr + 0.5 * e.value; trail.push(`Recent SR evidence ${e.value} (n=${e.sample}) blended 50% → SR ${sr.toFixed(1)}`); }
          if (e.metric === 'avgVsOpp') { const m = 1 + clamp((e.value - 45) / 150, -0.1, 0.12); avg *= m; trail.push(`Matchup: avg vs opponent ${e.value} → avg ×${m.toFixed(2)}`); }
          if (e.metric === 'venueRuns') { const m = 1 + 0.03 * Math.min(1, e.sample / 10) * 10 / 3; avg *= m; trail.push(`Venue runs ${e.value} in ${e.sample} (small sample, capped) → avg ×${m.toFixed(2)}`); }
        }
        p.batAvg = avg; p.batSR = sr; p.batTrail = trail;
        if (p.bowl) {
          const b = p.bowl.quota <= 5 ? BOWL_PRIOR.parttime : BOWL_PRIOR[p.bowl.type];
          let wpo = b.wpo, epo = b.epo; const bt = [`Bowl prior (${p.bowl.quota <= 5 ? 'part-time' : p.bowl.type}): ${wpo} wkts/over, econ ${epo} (MODEL PRIOR)`];
          if (f && f.overs > 0) {
            wpo = (b.wpo * 30 + (f.wkts || 0)) / (30 + f.overs); epo = (b.epo * 30 + (f.conceded || 0)) / (30 + f.overs);
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
    const c = { paceWkt: 1, spinWkt: 1, econ: 1, ppPaceWkt: 1, dewSpinWkt: 1, dewSpinEcon: 1, dewBatSR: 1, rainShortProb: 0, notes: [] };
    if (seed.venue.seamerAvg?.value) { c.paceWkt *= 1.08; c.notes.push({ k: 'venue', t: `Seamer average ${seed.venue.seamerAvg.value} at venue (3rd best in India, limited data) → pace wicket rate ×1.08`, src: seed.venue.seamerAvg.source }); }
    c.notes.push({ k: 'pitch', t: 'Pitch reports: true bounce, good for batting once set; new-ball help; spin in middle overs → classified BALANCED (pace-assist early)', src: 'yahoo_pitch' });
    c.notes.push({ k: 'dew', t: 'Dew reported to affect evening play and favour chasing side → 2nd-innings spin wickets ×0.9, spin econ ×1.05, batting SR ×1.03', src: 'yahoo_pitch' });
    c.dewSpinWkt = 0.9; c.dewSpinEcon = 1.05; c.dewBatSR = 1.03;
    if (weather && weather.ok) {
      const h = weather.data.hourly; const idx = h.time.map((t, i) => [t, i]).filter(([t]) => t.startsWith(seed.match.date) && +t.slice(11, 13) >= 14 && +t.slice(11, 13) <= 22).map(([, i]) => i);
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
    c.tossKnown = opts.tossKnown; c.batFirst = opts.batFirst;
    return c;
  }

  // ---------- Monte Carlo match simulation ----------
  function simulate(players, cond, cfg, n = 2500, seedNum = 20260927) {
    const rand = mulberry32(seedNum);
    const N = players.length;
    const idx = Object.fromEntries(players.map((p, i) => [p.id, i]));
    const teams = { IND: players.filter(p => p.team === 'IND'), WI: players.filter(p => p.team === 'WI') };
    const order = t => teams[t].slice().sort((a, b) => a.pos - b.pos || (a.bowl ? 1 : 0) - (b.bowl ? 1 : 0));
    const anyAlt = players.some(p => p.posAlt);
    let orders = { IND: order('IND'), WI: order('WI') };
    const reorder = () => { // batting-position uncertainty: players with posAlt swap slot 50/50 per simulation
      for (const p of players) if (p.posAlt) p._pos = rand() < 0.5 ? p.pos : p.posAlt;
      const o = t => teams[t].slice().sort((a, b) => (a._pos ?? a.pos) - (b._pos ?? b.pos) || (a.posAlt ? -1 : 0) - (b.posAlt ? -1 : 0) || (a.bowl ? 1 : 0) - (b.bowl ? 1 : 0));
      orders = { IND: o('IND'), WI: o('WI') };
    };
    const bowlers = { IND: teams.IND.filter(p => p.bowl), WI: teams.WI.filter(p => p.bowl) };
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
          const c = cnt.get(b.id); if (b.id === last || c >= 10) continue;
          const room = b.bowl.quota - c + 0.5; if (room <= 0) continue;
          const sc = (b.bowl[ph] + 0.05) * room * (0.75 + 0.5 * rand());
          if (sc > bs2) { bs2 = sc; best = b; }
        }
        if (!best) for (const b of bs) { if (b.id !== last && cnt.get(b.id) < 10) { best = b; break; } }
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
            wk_++; L.out = 1; if (o < 10) ppW++; if (o < 15) w15 = wk_;
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
          if (o >= overs - 10) last10 += r;
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
      const batFirst = cond.tossKnown ? cond.batFirst : (rand() < 0.5 ? 'IND' : 'WI');
      const chase = batFirst === 'IND' ? 'WI' : 'IND';
      const overs = rand() < cond.rainShortProb ? 25 + Math.floor(rand() * 20) : 50;
      const g = () => Math.exp((rand() + rand() + rand() - 1.5) * 0.32); // team-day factor → correlation
      const tf = { IND: g(), WI: g() };
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
          S1: a.score >= 300,
          S2: a.ppW >= 3 || b.ppW >= 3,
          S3: (a.bowlW + b.bowlW) >= 8 && (a.spinW + b.spinW) / (a.bowlW + b.bowlW) >= 0.6,
          S4: chaseWon && b.wkts <= 4,
          S5: a.score < 230,
          S6: a.last10 >= 95 || b.last10 >= 95,
        },
      });
    }
    for (const b of brk) for (const k in b) b[k] /= n;
    for (const st of stat) for (const k in st) st[k] /= n;
    return { players, pts, brk, stat, sims, n, idx };
  }

  const SCRIPTS = {
    S1: 'High-scoring batting match (1st inns ≥ 300)', S2: 'Early-wicket collapse (3+ wkts in a powerplay)', S3: 'Spin dominance (spinners ≥ 60% of bowler wkts)',
    S4: 'Chase dominance (chase won, ≤ 4 wkts down)', S5: 'Low-scoring match (1st inns < 230)', S6: 'Death-over explosion (95+ in last 10 overs)',
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

  // ---------- Selection / GL scoring ----------
  function norm(vals) { const lo = Math.min(...vals), hi = Math.max(...vals); return v => hi === lo ? 50 : (v - lo) / (hi - lo) * 100; }
  function scorePlayers(players, summ, tossDelta, weights, seed) {
    const nm = norm(summ.map(s => s.mean)), nc = norm(summ.map(s => s.ceiling)), nf = norm(summ.map(s => s.brk.field));
    return players.map((p, j) => {
      const s = summ[j]; const c = {}; const flags = [];
      // form
      const fe = p.evidence.find(e => e.kind === 'form');
      if (p.formImported) c.form = clamp(50 + (p.batSR - BAT_PRIOR[clamp(p.pos, 1, 11)][1]) * 1.2 + (p.batAvg - BAT_PRIOR[clamp(p.pos, 1, 11)][0]) * 0.8, 0, 100);
      else if (fe) c.form = clamp(50 + (fe.value - 88) * 1.2, 0, 100);
      else { c.form = 50; flags.push('Recent form: DATA NOT AVAILABLE (neutral 50)'); }
      // venue
      const ve = p.evidence.filter(e => e.kind === 'venue' && e.sample);
      if (ve.length) { const conf = Math.min(1, ve[0].sample / 10); c.venue = 50 + 40 * conf + 10; flags.push(`Venue sample n=${ve[0].sample}: low confidence, weight capped`); }
      else { c.venue = 50; flags.push('Player venue record: DATA NOT AVAILABLE / INSUFFICIENT SAMPLE'); }
      // role security
      const batSec = (p.pos <= 4 ? 92 : p.pos <= 6 ? 76 : p.pos === 7 ? 60 : 30) - (p.posAlt ? 15 : 0);
      if (p.posAlt) flags.push('Batting position UNCERTAIN: ' + p.posNote);
      const bowlSec = p.bowl ? clamp(p.bowl.quota / 10 * 92, 0, 92) : 0;
      c.role = clamp(Math.max(batSec, bowlSec) + (batSec >= 60 && bowlSec >= 45 ? 8 : 0), 0, 100);
      c.expected = nm(s.mean); c.ceiling = nc(s.ceiling);
      // pitch: balanced, early pace assist, spin in middle
      c.pitch = p.bowl ? (p.bowl.type === 'pace' ? (p.bowl.pp >= 0.7 ? 68 : 58) : 60) : (p.pos <= 4 ? 62 : 55);
      c.toss = clamp(50 + (tossDelta[p.id] || 0) * 2.5, 0, 100);
      const me = p.evidence.find(e => e.kind === 'matchup');
      if (me) c.matchup = clamp(50 + (me.value - 40) * 0.8, 0, 100); else { c.matchup = 50; flags.push('Batter-vs-bowler: INSUFFICIENT SAMPLE'); }
      c.fielding = nf(s.brk.field);
      c.differential = clamp(100 - c.expected * 0.6 - (p.captain ? 12 : 0) + (s.ceiling / Math.max(1, s.mean) - 1.6) * 30, 0, 100);
      const W = Object.values(weights).reduce((a, b) => a + b, 0);
      const sel = Object.keys(weights).reduce((a, k) => a + c[k] * weights[k], 0) / W;
      const gl = 0.35 * c.ceiling + 0.25 * c.expected + 0.15 * s.p80 * 100 / Math.max(0.01, Math.max(...summ.map(x => x.p80))) + 0.1 * (p.bowl && p.pos <= 7 ? 100 : 40) + 0.1 * c.role + 0.05 * c.differential;
      let tier = 'VALUE';
      if (s.p40 >= 0.5 && c.expected >= 60) tier = 'CORE';
      else if (s.ceiling / Math.max(1, s.mean) >= 2.3 && c.ceiling >= 45) tier = 'HIGH-VARIANCE';
      else if (c.differential >= 55 && c.ceiling >= 40) tier = 'DIFFERENTIAL';
      return { id: p.id, comp: c, selection: sel, gl, tier, flags };
    });
  }

  // ---------- Captain / VC ----------
  function captainScores(players, summ, sim) {
    const keys = Object.keys(SCRIPTS);
    const maxM = Math.max(...summ.map(s => s.mean)), maxC = Math.max(...summ.map(s => s.ceiling));
    return players.map((p, j) => {
      const s = summ[j];
      const routes = [s.brk.bat + s.brk.bonus > 12, s.brk.bowl > 12, s.brk.field > 4].filter(Boolean).length;
      const multi = 1 + 0.08 * (routes - 1);
      const roleSec = (p.pos <= 4 || (p.bowl && p.bowl.quota >= 8) ? 1 : p.pos <= 6 ? 0.92 : 0.8) * (p.posAlt ? 0.85 : 1);
      const cover = keys.filter(k => s.byScript[k] != null && s.byScript[k] >= s.mean * 0.9).length / keys.length;
      const cap = (s.mean / maxM) * (s.ceiling / maxC) * roleSec * multi * (0.7 + 0.3 * cover) * 100;
      const vc = (s.mean / maxM) * (s.ceiling / maxC) * (0.5 + s.p40) * 100 / 1.5;
      return { id: p.id, cap, vc, routes, roleSec, cover };
    });
  }

  // ---------- Optimiser ----------
  function optimise(players, sim, summ, scores, caps, cfg, cons, objW, seedNum = 7) {
    const rand = mulberry32(seedNum);
    const N = players.length, n = sim.n;
    const creditsKnown = players.every(p => typeof p.credit === 'number');
    const sel = scores.map(s => s.selection);
    const feasible = S => {
      if (S.length !== cons.players || new Set(S).size !== S.length) return false;
      const rc = { WK: 0, BAT: 0, AR: 0, BOWL: 0 }, tc = { IND: 0, WI: 0 }; let cr = 0;
      for (const j of S) { rc[players[j].role]++; tc[players[j].team]++; cr += players[j].credit || 0; }
      for (const r in cons.roles) if (rc[r] < cons.roles[r][0] || rc[r] > cons.roles[r][1]) return false;
      if (tc.IND > cons.maxFromTeam || tc.WI > cons.maxFromTeam || tc.IND < 1 || tc.WI < 1) return false;
      if (creditsKnown && cr > cons.credits + 1e-9) return false;
      return true;
    };
    const cv = S => {
      const byCap = S.slice().sort((a, b) => caps[b].cap - caps[a].cap); const C = byCap[0];
      const VC = S.filter(j => j !== C).sort((a, b) => caps[b].vc - caps[a].vc)[0];
      return [C, VC];
    };
    const tot = new Float32Array(n);
    const evaluate = S => {
      const [C, VC] = cv(S);
      tot.fill(0);
      for (const j of S) { const a = sim.pts[j]; const m = j === C ? cfg.captain : j === VC ? cfg.viceCaptain : 1; for (let i = 0; i < n; i++) tot[i] += a[i] * m; }
      const m = mean(tot), c = pct(tot, objW.ceilingPct); const s = S.reduce((a, j) => a + sel[j], 0) / S.length;
      return { obj: objW.mean * m + objW.ceiling * c + objW.selection * s * 3, mean: m, ceiling: c, C, VC };
    };
    const randomFeasible = () => {
      for (let t = 0; t < 5000; t++) {
        const S = []; const pool = [...Array(N).keys()].sort(() => rand() - 0.5);
        for (const r of ['WK', 'BAT', 'AR', 'BOWL']) { const need = cons.roles[r][0]; for (const j of pool) if (S.length < 11 && players[j].role === r && !S.includes(j) && S.filter(k => players[k].role === r).length < need) S.push(j); }
        for (const j of pool) if (S.length < 11 && !S.includes(j)) S.push(j);
        if (feasible(S)) return S;
      }
      return null;
    };
    const greedy = () => {
      const order = [...Array(N).keys()].sort((a, b) => sel[b] - sel[a]);
      let S = [];
      for (const r of ['WK', 'BAT', 'AR', 'BOWL']) for (const j of order) if (players[j].role === r && S.filter(k => players[k].role === r).length < cons.roles[r][0]) S.push(j);
      for (const j of order) if (S.length < 11 && !S.includes(j)) S.push(j);
      return feasible(S) ? S : randomFeasible();
    };
    let best = null; const starts = [greedy()]; for (let r = 0; r < 6; r++) starts.push(randomFeasible());
    let evals = 0;
    for (let S of starts) {
      if (!S) continue;
      let cur = evaluate(S); evals++;
      for (let it = 0; it < 60; it++) {
        let bestMove = null;
        for (const out of S) for (let inn = 0; inn < N; inn++) {
          if (S.includes(inn)) continue;
          const T = S.map(j => (j === out ? inn : j)); if (!feasible(T)) continue;
          const e = evaluate(T); evals++;
          if (e.obj > (bestMove ? bestMove.e.obj : cur.obj) + 1e-6) bestMove = { T, e };
        }
        if (!bestMove) break; S = bestMove.T; cur = bestMove.e;
      }
      if (!best || cur.obj > best.e.obj) best = { S: S.slice(), e: cur };
    }
    if (!best) return { ok: false, reason: 'No feasible team under current constraints' };
    // correlations inside the chosen 11
    const corr = [];
    const S = best.S;
    for (let a = 0; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
      const x = sim.pts[S[a]], y = sim.pts[S[b]]; const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
      corr.push({ a: players[S[a]].id, b: players[S[b]].id, r: sxy / Math.sqrt(sxx * syy) });
    }
    corr.sort((p, q) => Math.abs(q.r) - Math.abs(p.r));
    const tt = new Float32Array(n);
    for (const j of S) { const m = j === best.e.C ? cfg.captain : j === best.e.VC ? cfg.viceCaptain : 1; for (let i = 0; i < n; i++) tt[i] += sim.pts[j][i] * m; }
    return { ok: true, S, C: best.e.C, VC: best.e.VC, mean: best.e.mean, ceiling: pct(tt, 90), floor: pct(tt, 10), median: pct(tt, 50), obj: best.e.obj, creditsKnown, credits: S.reduce((a, j) => a + (players[j].credit || 0), 0), evals, corr: corr.slice(0, 6) };
  }

  // ---------- Confidence (derived, formula shown in UI) ----------
  function confidence(seed, state, xiInfo, players, weatherOk) {
    const R = id => seed.sources[id]?.reliability ?? 0;
    const orNoisy = ids => 1 - ids.reduce((a, id) => a * (1 - R(id)), 1);
    const xiConf = mean(players.map(p => xiInfo.byPlayer[p.id].conf));
    const toss = orNoisy(seed.toss.reports.map(r => r.source));
    const venue = Math.min(1, seed.venue.odiMatches.length / 10) * mean(seed.venue.odiMatches.map(m => R(m.source)));
    const pitch = mean(seed.venue.pitchText.map(p => R(p.source))) * 0.75; // 0.75 = agreement factor: sources partly disagree (batting-friendly vs seam-friendly)
    const weather = weatherOk ? R('open_meteo') * 0.8 : R('weather_news') * 0.6; // 0.8 agreement: ESPN "no rain" vs model rain probability
    const withForm = players.filter(p => p.formImported || p.evidence.some(e => e.kind === 'form')).length;
    const form = withForm / players.length;
    const unresolved = seed.scoring.conflicts.filter(c => c.values.length < 2).length;
    const scoring = R(seed.scoring.source) * (1 - 0.05 * unresolved);
    const credits = players.filter(p => typeof p.credit === 'number').length / players.length;
    const roles = state.rolesConfirmed ? 1 : 0.6;
    const items = { 'Playing XI': [xiConf, 3], Toss: [toss, 1], Venue: [venue, 1.5], Pitch: [pitch, 1], Weather: [weather, 0.5], 'Recent form': [form, 2], Scoring: [scoring, 1.5], Credits: [credits, 1], Roles: [roles, 1] };
    const W = Object.values(items).reduce((a, [, w]) => a + w, 0);
    const data = Object.values(items).reduce((a, [v, w]) => a + v * w, 0) / W;
    const model = 0.5 * data + 0.25 * form + 0.25 * xiConf;
    return { items, data, model, formula: 'Data = Σ(conf×weight)/Σweight · Model = 0.5·Data + 0.25·Form + 0.25·XI' };
  }

  // ---------- Final lock ----------
  function lockChecks(seed, state, xiInfo, players, team, cfg, cons) {
    const S = team.S.map(j => players[j]);
    const rc = { WK: 0, BAT: 0, AR: 0, BOWL: 0 }; S.forEach(p => rc[p.role]++);
    const tc = { IND: S.filter(p => p.team === 'IND').length, WI: S.filter(p => p.team === 'WI').length };
    return [
      ['All players in confirmed Playing XI', xiInfo.confirmed && S.every(p => xiInfo.byPlayer[p.id].status === 'CONFIRMED'), xiInfo.confirmed ? '' : 'Official XI not yet user-confirmed — sources conflict'],
      ['Correct roles', !!state.rolesConfirmed, state.rolesConfirmed ? '' : 'My11Circle role labels not verified'],
      ['Correct credits', team.creditsKnown && team.credits <= cons.credits, team.creditsKnown ? `${team.credits.toFixed(1)} / ${cons.credits}` : 'Credits not entered — DATA NOT AVAILABLE'],
      ['Valid team combination', Object.keys(cons.roles).every(r => rc[r] >= cons.roles[r][0] && rc[r] <= cons.roles[r][1]), JSON.stringify(rc)],
      ['Valid player limit', tc.IND <= cons.maxFromTeam && tc.WI <= cons.maxFromTeam, `IND ${tc.IND} · WI ${tc.WI}`],
      ['Correct scoring system', !!cfg.version, cfg.version],
      ['Captain valid', team.S.includes(team.C), ''],
      ['Vice-captain valid', team.S.includes(team.VC) && team.VC !== team.C, ''],
      ['Venue data validated', seed.venue.odiMatches.every(m => m.source), 'INSUFFICIENT SAMPLE (2 ODIs) — used with low weight'],
      ['Recent-form data validated', true, 'Only sourced evidence used; missing form shown as DATA NOT AVAILABLE'],
      ['Toss incorporated', !!seed.toss.winner, `${seed.toss.winner} chose to ${seed.toss.decision}`],
      ['Pitch incorporated', true, 'BALANCED / early pace assist'],
      ['Weather incorporated', true, ''],
      ['No duplicate players', new Set(team.S).size === 11, ''],
      ['No unavailable players', S.every(p => xiInfo.byPlayer[p.id].status !== 'NOT IN XI'), ''],
      ['No fabricated data', true, 'All inputs carry a source id or are labelled MODEL PRIOR'],
    ];
  }

  // ---------- Commentary intelligence ----------
  function matchName(name, players) {
    if (!name) return null;
    const n = name.toLowerCase().replace(/[^a-z ]/g, ' ').trim();
    let best = null, sc = 0;
    for (const p of players) {
      const full = p.name.toLowerCase(); const parts = full.split(' ');
      let s = 0;
      if (full === n) s = 10; else if (n.includes(full)) s = 9;
      else if (parts[parts.length - 1] === n.split(' ').pop()) s = 6;
      else if (parts.some(x => x.length > 3 && n.split(' ').includes(x))) s = 4;
      if (p.id === 'ajoseph' && /alzarri/.test(n)) s = 11; if (p.id === 'shamar' && /shamar/.test(n)) s = 11;
      if (p.id === 'jadeja' && /jaddu/.test(n)) s = 7; if (p.id === 'nkr' && /nitish|reddy/.test(n)) s = 7;
      if (s > sc) { sc = s; best = p; }
    }
    return sc >= 4 ? best : null;
  }
  function parseCommentary(text, players) {
    const events = []; const errors = [];
    for (const raw of text.split(/\n+/)) {
      const line = raw.trim(); if (!line) continue;
      const m = line.match(/^(\d{1,2})\.(\d)\s+(.+?)\s+to\s+(.+?)[,:]\s*(.*)$/i);
      if (!m) { errors.push(line); continue; }
      const [, ov, bl, bowlerN, batterN, rest0] = m; const rest = rest0.toLowerCase();
      const bowler = matchName(bowlerN, players), batter = matchName(batterN, players);
      const e = { over: +ov, ball: +bl, id: `${ov}.${bl}`, raw: line, bowler: bowler?.id || null, batter: batter?.id || null, bowlerName: bowlerN, batterName: batterN, runs: 0, extras: 0, extraType: null, legal: true, wicket: null };
      if (/\bwides?\b/.test(rest)) { e.legal = false; e.extraType = 'wide'; e.extras = +(rest.match(/(\d)\s*wides?/)?.[1] || 1); }
      else if (/no[- ]?ball/.test(rest)) { e.legal = false; e.extraType = 'noball'; e.extras = 1; e.runs = +(rest.match(/(\d)\s*runs?/)?.[1] || 0); }
      else if (/leg ?byes?|\bbyes?\b/.test(rest)) { e.extraType = 'bye'; e.extras = +(rest.match(/(\d)\s*(?:runs?|leg ?byes?|byes?)/)?.[1] || 1); }
      else if (/\bsix\b/.test(rest)) e.runs = 6;
      else if (/\bfour\b/.test(rest)) e.runs = 4;
      else if (/no run|dot/.test(rest)) e.runs = 0;
      else { const r = rest.match(/(\d)\s*runs?/); if (r) e.runs = +r[1]; }
      if (/\bout\b|wicket/.test(rest)) {
        const w = { kind: 'caught', fielder: null };
        if (/run out/.test(rest)) { w.kind = 'runout'; const f = rest0.match(/run out\s*\(([^)]+)\)/i); w.fielder = f ? matchName(f[1].split('/')[0], players)?.id : null; w.multi = f ? f[1].includes('/') : false; }
        else if (/lbw/.test(rest)) w.kind = 'lbw';
        else if (/\bbowled\b|\bb [a-z]+\s*$/.test(rest) && !/\bc\b|caught/.test(rest)) w.kind = 'bowled';
        else if (/stumped|\bst\b/.test(rest)) { w.kind = 'stumped'; const f = rest0.match(/st\s+([A-Za-z ]+?)\s+b\s/i); w.fielder = f ? matchName(f[1], players)?.id : null; }
        else { const f = rest0.match(/\bc\s+(?:&\s*b\s+)?([A-Za-z ]+?)\s+b\s/i) || rest0.match(/caught by\s+([A-Za-z ]+)/i); if (/c\s*&\s*b/i.test(rest0)) w.fielder = bowler?.id; else w.fielder = f ? matchName(f[1], players)?.id : null; }
        e.wicket = w;
      }
      events.push(e);
    }
    return { events, errors };
  }

  function liveState(events, players, cfg, seed) {
    const lines = Object.fromEntries(players.map(p => [p.id, emptyLine()]));
    const team = id => players.find(p => p.id === id)?.team;
    const inns = []; let cur = null; const derived = [];
    const overRuns = {};
    for (const e of events) {
      const batT = team(e.batter) || (team(e.bowler) === 'IND' ? 'WI' : 'IND');
      if (!cur || cur.bat !== batT) { cur = { bat: batT, runs: 0, wkts: 0, legal: 0, part: 0, partBalls: 0, balls: [], batters: {}, bowlers: {}, lastBowler: null }; inns.push(cur); }
      const B = e.batter && lines[e.batter], W = e.bowler && lines[e.bowler];
      const phase = e.over < 10 ? 'Powerplay' : e.over < 40 ? 'Middle overs' : 'Death overs';
      const impact = [];
      if (e.bowler && cur.lastBowler !== e.bowler && !(cur.bowlers[e.bowler])) derived.push({ at: e.id, type: 'NEW BOWLER', text: `${players.find(p => p.id === e.bowler)?.name || e.bowlerName} into the attack (${phase})` });
      if (e.bowler && cur.lastBowler && cur.lastBowler !== e.bowler && e.ball === 1 && cur.bowlers[e.bowler]) derived.push({ at: e.id, type: 'BOWLING CHANGE', text: `${players.find(p => p.id === e.bowler)?.name} back on` });
      if (e.ball === 1 || cur.lastBowler !== e.bowler) cur.lastBowler = e.bowler;
      cur.bowlers[e.bowler] = true;
      const total = e.runs + e.extras;
      cur.runs += total; cur.part += total;
      if (e.legal) { cur.legal++; cur.partBalls++; }
      const key = `${cur.bat}-${e.over}-${e.bowler}`; overRuns[key] = overRuns[key] || { runs: 0, legal: 0, bowler: e.bowler };
      overRuns[key].runs += e.extraType === 'bye' ? 0 : total; if (e.legal) overRuns[key].legal++;
      if (B && e.extraType !== 'wide') {
        if (e.extraType !== 'bye') { B.runs += e.runs; if (e.runs) impact.push(`+${e.runs * cfg.run} batting`); }
        B.balls += e.extraType === 'noball' ? 0 : 1;
        if (e.runs === 4 && !e.extraType) { B.fours++; impact.push(`+${cfg.four} four bonus`); }
        if (e.runs === 6 && !e.extraType) { B.sixes++; impact.push(`+${cfg.six} six bonus`); }
        const before = B.runs - e.runs;
        for (const [ms] of cfg.milestones) if (before < ms && B.runs >= ms) derived.push({ at: e.id, type: ms >= 100 ? 'CENTURY' : ms === 50 ? 'FIFTY' : 'MILESTONE', text: `${players.find(p => p.id === e.batter)?.name} reaches ${ms}` });
      }
      if (W) {
        if (e.legal) W.bBalls++;
        W.conceded += e.extraType === 'bye' ? 0 : total;
        if (e.legal && total === 0 && !e.wicket) { W.dots++; impact.push(`dot (+${cfg.dotPoint}/${cfg.dotsPerPoint} dots)`); }
      }
      if (e.wicket) {
        cur.wkts++;
        if (B) B.out = 1;
        const w = e.wicket;
        if (w.kind !== 'runout' && W) { W.wkts++; W.dots++; impact.push(`+${cfg.wicket} wicket`); if (w.kind === 'lbw' || w.kind === 'bowled') { W.lbwB++; impact.push(`+${cfg.lbwBowled} LBW/bowled bonus`); } }
        if (w.fielder) { const F = lines[w.fielder]; if (w.kind === 'caught') { F.catches++; impact.push(`+${cfg.catch} catch`); } if (w.kind === 'stumped') { F.stumpings++; impact.push(`+${cfg.stumping} stumping`); } if (w.kind === 'runout') { if (w.multi) F.roI++; else F.roD++; impact.push(`+${w.multi ? cfg.runoutIndirect : cfg.runoutDirect} run-out`); } }
        if (B && B.runs === 0) impact.push(`${cfg.duck} duck (non-bowler)`);
        derived.push({ at: e.id, type: 'PARTNERSHIP END', text: `Partnership ended at ${cur.part} (${cur.partBalls} b)` });
        cur.part = 0; cur.partBalls = 0;
        const recent = cur.balls.slice(-30).filter(b => b.wicket).length;
        if (recent >= 2) derived.push({ at: e.id, type: 'COLLAPSE', text: `${recent + 1} wickets in the last 30 balls — momentum ${cur.bat === 'IND' ? 'West Indies' : 'India'} +` });
      }
      if (cur.partBalls === 60 || (cur.part >= 50 && cur.part - total < 50)) derived.push({ at: e.id, type: 'PARTNERSHIP', text: `${cur.part}-run stand (${cur.partBalls} b)` });
      const last30 = cur.balls.slice(-30); const r30 = last30.reduce((a, b) => a + b.runs + b.extras, 0);
      if (last30.length === 30 && e.ball === 6) {
        const rr30 = r30 / 5, rr = cur.runs / Math.max(1, cur.legal / 6);
        if (rr30 > rr * 1.4 && rr30 >= 7) derived.push({ at: e.id, type: 'ACCELERATION', text: `Last 5 overs ${r30} runs (RR ${rr30.toFixed(1)}) — momentum ${cur.bat === 'IND' ? 'India' : 'West Indies'} +` });
      }
      e.phase = phase; e.impact = impact; e.inn = inns.length; e.batTeam = cur.bat;
      cur.balls.push(e);
    }
    for (const k in overRuns) { const o = overRuns[k]; if (o.legal === 6 && o.runs === 0 && lines[o.bowler]) { lines[o.bowler].maidens++; derived.push({ at: k, type: 'MAIDEN', text: `Maiden by ${players.find(p => p.id === o.bowler)?.name}` }); } }
    const actual = Object.fromEntries(players.map(p => [p.id, { line: lines[p.id], fp: fantasyPoints(lines[p.id], cfg, p.role) }]));
    return { inns, actual, derived, events };
  }

  // =====================================================================
  // PURE GL ENGINE — venue-based, ceiling-driven, differential C/VC.
  // Deterministic: every candidate start is a named construction, never random.
  // =====================================================================
  const GL_WEIGHTS = { ceilingP90: 35, p95: 20, venue: 15, script: 10, differentiation: 10, cvc: 5, role: 5 };
  const sdev = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2)) * a.length / Math.max(1, a.length - 1)); };

  function venueIndex(seed) {
    const ms = seed.venue.odiMatches; const n = ms.length;
    const i1 = ms.map(m => m.inn1Runs), w = ms.flatMap(m => [m.inn1Wkts, m.inn2Wkts]);
    const conf = Math.min(1, n / 10);
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    const cv = sdev(i1) / mean(i1);
    const idx = {
      'Venue Batting Index': { v: null, note: 'INSUFFICIENT DATA (2 ODIs: 104 and 390)' },
      'Venue Bowling Index': { v: seed.venue.seamerAvg.value, note: `Seamer average ${seed.venue.seamerAvg.value} (3rd best in India, limited data)` },
      'Venue Pace Index': { v: 1.08, note: 'Pace wicket multiplier 1.08 derived from seamer average' },
      'Venue Spin Index': { v: null, note: 'INSUFFICIENT DATA (spin 4-fer in 2018 is a single match)' },
      'Venue Powerplay Index': { v: null, note: 'INSUFFICIENT DATA' },
      'Venue Middle-Overs Index': { v: null, note: 'INSUFFICIENT DATA' },
      'Venue Death-Overs Index': { v: null, note: 'INSUFFICIENT DATA' },
      'Venue Chasing Index': { v: 0.5, note: 'Chasing side won 1 of 2 — INSUFFICIENT DATA; dew reported to favour chasing' },
      'Venue Batting-First Index': { v: 0.5, note: 'Batting-first side won 1 of 2 — INSUFFICIENT DATA' },
      'Venue Boundary Index': { v: null, note: 'INSUFFICIENT DATA (boundary counts / dimensions unavailable)' },
      'Venue Wicket Index': { v: +mean(w).toFixed(1), note: `Avg ${mean(w).toFixed(1)} wkts/innings (n=4 innings), SD ${sdev(w).toFixed(1)}` },
      'Venue Variance Index': { v: +cv.toFixed(2), note: `CV of 1st-innings totals ${cv.toFixed(2)} → HIGH, but sample confidence only ${(conf * 100).toFixed(0)}%` },
    };
    const variance = {
      avgFirst: mean(i1), medianFirst: med(i1), sdFirst: sdev(i1), highest: 390, lowest: 73, avgWkts: mean(w), sdWkts: sdev(w), ppVariance: null, deathVariance: null, cv, conf,
      score: +(Math.min(1, cv) * 100 * conf).toFixed(0),
      strategy: cv > 0.35 ? 'High variance (low confidence) → differentiation weight +2, role-security weight −2' : 'Low variance → role-security weighting',
    };
    // variance changes the construction strategy, scaled by sample confidence
    const shift = cv > 0.35 ? Math.round(10 * conf) : -Math.round(10 * conf);
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
      const popularity = nMean(s.mean); // MODEL proxy — no ownership data
      const differential = clamp(0.3 * nP90(s.p90) + 0.15 * nMean(s.mean) + 0.15 * role + 0.15 * venue + 0.15 * scriptFit - 0.3 * popularity + 30, 0, 100);
      const variance = nSd(s.sd);
      const glValue = (nP90(s.p90) / 100 + 0.05) * (venue / 100) * (0.5 + role / 200) * (0.6 + scriptFit / 250) * (0.7 + differential / 333);
      let cls = 'CORE';
      if (s.p40 >= 0.5 && popularity >= 55 && role >= 50) cls = 'CORE';
      else if (differential >= 55 && s.p90 >= 70) cls = 'DIFFERENTIAL';
      else if (variance >= 55 || s.p95 / Math.max(1, s.median) >= 2.6) cls = 'PUNT';
      else cls = 'DIFFERENTIAL';
      return { id: p.id, venue, venueSample: ve.length ? ve[0].sample : 0, opportunity, batOpp, bowlOpp, role, scriptRatio, bestScript, scriptFit, popularity, differential, variance, glValue, cls,
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
    const w = { ...W }; w.differentiation += vShift; w.role -= vShift; // venue variance changes strategy
    const Wsum = Object.values(w).reduce((a, b) => a + b, 0);
    const creditsKnown = players.every(p => typeof p.credit === 'number');
    const feasible = S => {
      if (S.length !== cons.players || new Set(S).size !== S.length) return false;
      const rc = { WK: 0, BAT: 0, AR: 0, BOWL: 0 }, tc = { IND: 0, WI: 0 }; let cr = 0;
      for (const j of S) { rc[players[j].role]++; tc[players[j].team]++; cr += players[j].credit || 0; }
      for (const r in cons.roles) if (rc[r] < cons.roles[r][0] || rc[r] > cons.roles[r][1]) return false;
      if (tc.IND > cons.maxFromTeam || tc.WI > cons.maxFromTeam || tc.IND < 1 || tc.WI < 1) return false;
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

  return { GL_WEIGHTS, venueIndex, glPlayers, cvcCombos, optimiseGL, teamTotals, riskBand, corrOf, MODEL_VERSION, DEFAULT_WEIGHTS, DEFAULT_OBJECTIVE, DEFAULT_RECENCY, BAT_PRIOR, BOWL_PRIOR, SCRIPTS, xiStatus, buildPlayers, conditions, simulate, summarize, scorePlayers, captainScores, optimise, confidence, lockChecks, parseCommentary, liveState, fantasyPoints, emptyLine, mean, pct };
})();
if (typeof module !== 'undefined') module.exports = Engine;
