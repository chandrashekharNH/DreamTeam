// Pure GL Decision Engine — two tabs: Dream11 Team · My11Circle Team.
const App = (() => {
  const E = Engine;
  const TABS = [['dream11', 'Dream11 Team'], ['my11', 'My11Circle Team']];
  let seed, state, weather = null, tab = 'dream11';
  const cache = {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f0 = v => (v == null || Number.isNaN(v) ? '—' : Math.round(v));
  const f1 = v => (v == null || Number.isNaN(v) ? '—' : (+v).toFixed(1));
  const pc = v => (v * 100).toFixed(0) + '%';
  const NDA = '<span class="nda">INSUFFICIENT DATA</span>';
  const pill = t => `<span class="pill ${t === 'IND' ? 'ind' : 'wi'}">${t}</span>`;
  const link = id => { const s = seed.sources[id]; return s ? (s.url ? `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)) : esc(id); };

  async function save(patch) { Object.assign(state, patch); try { await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); } catch { } }

  // ---------- per-platform pipeline ----------
  function run(key) {
    const P = seed.platforms[key];
    const cfg = { ...P.scoring, ...((state.scoringOverride || {})[key] || {}) };
    const cons = P.constraints;
    const pstate = { ...state, credits: (state.credits2 || {})[key] || {}, roles: (state.roles2 || {})[key] || {}, xiConfirmed: null };
    const xi = E.xiStatus(seed, pstate);
    const players = E.buildPlayers(seed, pstate, xi.xi); // official XI only — unavailable players removed
    const cond = E.conditions(seed, weather, { tossKnown: true, batFirst: seed.toss.batFirst });
    const condPre = E.conditions(seed, weather, { tossKnown: false });
    const n = 2000;
    const sim = E.simulate(players, cond, cfg, n, 20260927);      // identical match draws across platforms (same seed)
    const simPre = E.simulate(players, condPre, cfg, n, 20260927);
    const summ = E.summarize(sim), summPre = E.summarize(simPre);
    const tossDelta = Object.fromEntries(players.map((p, j) => [p.id, summ[j].mean - summPre[j].mean]));
    const vIdx = E.venueIndex(seed);
    const gp = E.glPlayers(players, summ, seed, tossDelta, vIdx);
    const W = { ...E.GL_WEIGHTS, ...((state.glWeights || {})[key] || {}) };
    const team = E.optimiseGL(players, sim, summ, gp, cfg, cons, W, vIdx.shift);
    const combos = team.ok ? E.cvcCombos(players, sim, summ, gp, team.S, cfg, seed, 5) : [];
    if (team.ok && combos.length) { team.C = combos[0].C; team.VC = combos[0].VC; const t = E.teamTotals(sim, team.S, team.C, team.VC, cfg); Object.assign(team, { mean: E.mean(t), p90: E.pct(t, 90), p95: E.pct(t, 95), ceiling: E.pct(t, 99), floor: E.pct(t, 10), risk: E.riskBand(t) }); }
    const checks = team.ok ? validate(players, team, cfg, cons, xi, key) : [];
    return { key, P, cfg, cons, xi, players, cond, sim, summ, summPre, tossDelta, vIdx, gp, W, team, combos, checks };
  }

  function validate(players, t, cfg, cons, xi, key) {
    const S = t.S.map(j => players[j]); const rc = { WK: 0, BAT: 0, AR: 0, BOWL: 0 }; S.forEach(p => rc[p.role]++);
    const tc = { IND: S.filter(p => p.team === 'IND').length, WI: S.filter(p => p.team === 'WI').length };
    const d11 = key === 'dream11';
    return [
      ['11 players', S.length === 11, ''],
      ['Correct credits', t.creditsKnown && t.credits <= cons.credits, t.creditsKnown ? `${f1(t.credits)} / ${cons.credits}` : 'Credits not entered — credit cap not enforced'],
      ['Correct role limits', Object.keys(cons.roles).every(r => rc[r] >= cons.roles[r][0] && rc[r] <= cons.roles[r][1]), `WK ${rc.WK} · BAT ${rc.BAT} · AR ${rc.AR} · BOWL ${rc.BOWL} (role labels unverified)`],
      ['Team limits valid', tc.IND <= cons.maxFromTeam && tc.WI <= cons.maxFromTeam, `IND ${tc.IND} · WI ${tc.WI}`],
      ['All players in Playing XI', xi.confirmed && S.every(p => xi.byPlayer[p.id].status === 'CONFIRMED'), 'Official XI: ESPN scorecard + Outlook 13:39 IST'],
      ['C valid', t.S.includes(t.C), players[t.C].name],
      ['VC valid', t.S.includes(t.VC) && t.C !== t.VC, players[t.VC].name],
      ['Current scoring system', !d11, d11 ? 'Dream11 official page down — PROVISIONAL scoring' : cfg.version],
      ['Venue data validated', true, '2 ODIs — INSUFFICIENT DATA, low weight'],
      ['Toss incorporated', true, 'India bowl first → full model re-run (not a bonus)'],
      ['Pitch incorporated', true, 'BALANCED · early pace assist · dew later'],
      ['No duplicate player', new Set(t.S).size === 11, ''],
      ['No unavailable player', S.every(p => seed.officialXI[p.team].includes(p.id)), 'Siraj, Rutherford, Shamar Joseph, Paul, Nabi removed'],
    ];
  }

  // ---------- rendering ----------
  function render() {
    $('#nav').innerHTML = TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" onclick="App.go('${k}')">${l}</button>`).join('');
    $('#modelVersion').textContent = E.MODEL_VERSION;
    $('#topStatus').innerHTML = `<span class="pill ok">Toss: IND bowl</span><span class="pill ok">XI: official</span>`;
    if (!cache[tab]) { $('#view').innerHTML = '<div class="card">Running 2,000 simulated matches and the GL optimiser…</div>'; setTimeout(() => { cache[tab] = run(tab); render(); }, 30); return; }
    try { $('#view').innerHTML = view(cache[tab]); } catch (e) { $('#view').innerHTML = `<div class="banner">RENDER ERROR: ${esc(e.message)}</div>`; console.error(e); }
  }

  function view(R) {
    const { players, summ, gp, team, combos, P, key } = R;
    if (!team.ok) return `<div class="banner">${esc(team.reason)}</div>${inputs(R)}`;
    const S = team.S, by = r => S.filter(j => players[j].role === r);
    const card = j => `<div class="pcard" onclick="App.player('${players[j].id}')">${j === team.C ? '<span class="cvc c">C</span>' : j === team.VC ? '<span class="cvc vc">VC</span>' : ''}<b>${esc(players[j].name)}</b><small>${players[j].team} · exp ${f0(summ[j].mean)} · P90 ${f0(summ[j].p90)}</small><small class="tier ${gp[j].cls}">${gp[j].cls}</small></div>`;
    const warn = key === 'dream11' ? `<div class="banner"><b>Dream11 scoring is PROVISIONAL.</b> dream11.com returned "Server down!" (HTTP 502) at 14:10 IST, and third-party tables conflict: some report the new +4 four / +6 six bonuses, others the legacy +1/+2. The values used, and their status, are listed in <i>Points system</i> below. You can edit them there to match your app and re-run.</div>` : '';
    const inIND = S.filter(j => players[j].team === 'IND').length;
    const diffs = players.map((p, j) => j).filter(j => summ[j].p90 >= E.pct(summ.map(s => s.p90), 40)).sort((a, b) => gp[b].differential - gp[a].differential).slice(0, 5);
    const risky = S.filter(j => riskList(R, j).length);
    return `${warn}
    <div class="final-hero"><h1>FINAL HIGH-UPSIDE GL TEAM · ${esc(P.label.toUpperCase())}</h1><div class="sub" style="margin-top:6px">India vs West Indies · 1st ODI · 27 Sep 2026 · Thiruvananthapuram · WI bat first</div></div>
    <div class="grid two" style="margin-top:14px"><div class="pitch">${['WK', 'BAT', 'AR', 'BOWL'].map(r => `<div class="lbl">${r}</div><div class="lane">${by(r).map(card).join('')}</div>`).join('')}</div>
    <div class="col"><div class="card"><div class="row" style="gap:18px"><div><div class="muted small">CAPTAIN</div><div class="row"><span class="cvc c">C</span><b style="font-size:18px">${esc(players[team.C].name)}</b></div></div><div><div class="muted small">VICE-CAPTAIN</div><div class="row"><span class="cvc vc">VC</span><b style="font-size:18px">${esc(players[team.VC].name)}</b></div></div></div>
      <div class="grid three" style="margin-top:12px">${[['Expected Points', f0(team.mean)], ['P90', f0(team.p90)], ['Ceiling (P99)', f0(team.ceiling)], ['GL Score', f1(team.obj)], ['Venue Score', f0(team.venue)], ['Differentiation', f0(team.diff)]].map(([l, v]) => `<div><div class="muted small">${l}</div><div class="big" style="font-size:22px">${v}</div></div>`).join('')}</div>
      <div class="row" style="margin-top:10px"><span class="pill ${team.risk.band === 'Extreme GL' ? 'bad' : 'warn'}">Risk: ${team.risk.band}</span><span class="small muted">CV ${f1(team.risk.cv * 100)}% · P95 ${f0(team.p95)} · floor ${f0(team.floor)} · IND ${inIND} / WI ${11 - inIND} · credits ${team.creditsKnown ? f1(team.credits) : 'not entered'}</span></div>
      <p class="small muted">Winning construction: <b>${esc(team.start)}</b> after local search. Best script coverage: <b>${esc(E.SCRIPTS[team.best])}</b> (team scores ×${f1(team.scriptLift[team.best])} of its average in that script). ${team.uniqueVsAvg} of 11 players differ from the highest-average team. ${team.candidates.toLocaleString()} candidate teams evaluated.</p>
      <p class="small">If WI bat first on a balanced surface and <b>${esc(E.SCRIPTS[team.best].split(' (')[0].toLowerCase())}</b> happens, these 11 have the model's strongest path to an exceptional score. That is not a guarantee.</p></div>
      <div class="card"><h3>Candidate C/VC combinations</h3>${combos.map((o, i) => `<div style="padding:6px 0;border-bottom:1px dashed var(--line)"><b>${i + 1}. C: ${esc(players[o.C].name)} · VC: ${esc(players[o.VC].name)}</b> <span class="pill info">GL leverage ${f1(o.score)}</span><div class="small muted">${o.types.join(' · ')} · team P90 ${f0(o.p90)} / P95 ${f0(o.p95)} · corr ${o.corr.toFixed(2)} (${esc(o.script)})${o.complementary ? ' · complementary scoring routes' : ''}</div></div>`).join('')}<p class="small muted">The selected pair is #1. Leverage = 35% team P95 + 25% team P90 + 20% captain leverage (P95, differential, venue, role) + 10% VC leverage + 5% complementary routes + 5% low |correlation|.</p></div></div></div>

    <div class="card" style="margin-top:14px"><h3>Final team — why each player</h3><div class="scroll"><table><tr><th>Player</th><th>Role</th><th class="n">Pos</th><th class="n">Exp</th><th class="n">Median</th><th class="n">P90</th><th class="n">P95</th><th class="n">Venue</th><th class="n">Diff</th><th>Class</th><th>Reasons</th></tr>
      ${S.map(j => `<tr class="click" onclick="App.player('${players[j].id}')"><td><b>${esc(players[j].name)}</b> ${pill(players[j].team)} ${j === team.C ? '<span class="cvc c">C</span>' : j === team.VC ? '<span class="cvc vc">VC</span>' : ''}</td><td>${players[j].role}</td><td class="n">${players[j].pos}${players[j].posAlt ? '/' + players[j].posAlt : ''}</td><td class="n">${f0(summ[j].mean)}</td><td class="n">${f0(summ[j].median)}</td><td class="n">${f0(summ[j].p90)}</td><td class="n">${f0(summ[j].p95)}</td><td class="n">${f0(gp[j].venue)}</td><td class="n">${f0(gp[j].differential)}</td><td class="tier ${gp[j].cls}">${gp[j].cls}</td><td class="small">${reasons(R, j).map(esc).join(' · ')}</td></tr>`).join('')}</table></div></div>

    <div class="grid two" style="margin-top:14px"><div class="card"><h3>Top differentials <span class="pill warn">MODEL_DIFFERENTIAL · no ownership data</span></h3>${diffs.map(j => `<p class="small"><b>${esc(players[j].name)}</b> ${pill(players[j].team)} ${S.includes(j) ? '<span class="pill ok">IN TEAM</span>' : ''}<br>Why: P90 ${f0(summ[j].p90)} with a lower projected mean (${f0(summ[j].mean)}), so fewer teams are likely to carry him; best in ${esc(E.SCRIPTS[gp[j].bestScript].split(' (')[0])} (×${f1(gp[j].scriptRatio[gp[j].bestScript])}).<br>Venue: ${gp[j].venueSample ? `sourced record, n=${gp[j].venueSample} (low confidence)` : 'condition fit only — no player venue record'} · Role: ${roleText(players[j], gp[j])}<br>Risk: ${esc(riskList(R, j).join('; ') || 'standard')} · Ceiling (P95) ${f0(summ[j].p95)}</p>`).join('')}</div>
      <div class="card"><h3>Risk analysis</h3>${risky.map(j => `<p class="small"><b>${esc(players[j].name)}</b>: ${esc(riskList(R, j).join('; '))}</p>`).join('') || '<p class="small">No high-risk flags.</p>'}
      <h3 style="margin-top:12px">Validation</h3>${R.checks.map(([n, ok, note]) => `<div class="check"><span class="${ok ? 'y' : 'n'}">${ok ? '✓' : '✗'}</span><span>${esc(n)} <span class="muted small">${esc(note)}</span></span></div>`).join('')}</div></div>

    ${decisionLogic(R)}
    ${scriptsCard(R)}
    ${playerTable(R)}
    ${venueCard(R)}
    ${pointsCard(R)}
    ${inputs(R)}
    ${copyCard(R)}`;
  }

  function roleText(p, g) { return `No.${p.pos}${p.posAlt ? '/' + p.posAlt : ''}, ~${f0(g.exp.balls)} balls${p.bowl ? `, ~${f1(g.exp.overs)} overs (${esc(p.bowl.style)})` : ''}`; }
  function reasons(R, j) {
    const p = R.players[j], g = R.gp[j], out = [];
    if (g.exp.balls >= 35) out.push(`~${f0(g.exp.balls)} exp. balls (No.${p.pos}) · P(50+) ${pc(g.exp.p50)}`);
    if (p.bowl && g.exp.overs >= 5) out.push(`~${f1(g.exp.overs)} ov · ${f1(g.exp.wkts)} exp. wkts · P(3+ wkts) ${pc(g.exp.pW3)}`);
    if (p.bowl && g.exp.balls >= 12) out.push('two scoring routes (bat + ball)');
    for (const e of p.evidence.filter(e => ['form', 'venue', 'matchup'].includes(e.kind))) out.push(e.label);
    if (Math.abs(g.toss) >= 1.5) out.push(`toss ${g.toss > 0 ? '+' : ''}${f1(g.toss)} pts (${p.team === 'WI' ? 'bats first, day' : 'chases under lights, dew'})`);
    if (p.wk) out.push(`keeper: ${f1(g.exp.catches)} exp. dismissals`);
    out.push(`strongest script: ${E.SCRIPTS[g.bestScript].split(' (')[0]} (×${f1(g.scriptRatio[g.bestScript])})`);
    return out.slice(0, 4);
  }
  function riskList(R, j) {
    const p = R.players[j], s = R.summ[j], g = R.gp[j], r = [];
    if (g.exp.balls < 20 && !(p.bowl && g.exp.overs >= 6)) r.push('Low batting opportunity');
    if (p.bowl && p.bowl.quota <= 6) r.push('Uncertain bowling overs');
    if (p.posAlt) r.push('Batting slot uncertain');
    if (!p.evidence.some(e => e.kind === 'form')) r.push('Recent form not verified');
    if (g.venueSample && g.venueSample < 5) r.push('Small venue sample');
    if (g.scriptRatio[g.bestScript] >= 1.4) r.push(`High dependency on ${g.bestScript}`);
    if (s.floor < 10) r.push(`Floor ${f0(s.floor)}`);
    return r;
  }

  function decisionLogic(R) {
    const { players, summ, gp, team } = R;
    const top = (f, k = 3) => players.map((p, j) => j).sort((a, b) => f(b) - f(a)).slice(0, k).map(j => esc(players[j].name)).join(', ');
    const dropped = R.team.avgRef.S.filter(j => !team.S.includes(j)).map(j => esc(players[j].name));
    return `<div class="card" style="margin-top:14px"><h3>Final decision logic</h3><div class="kv small">
      <span>Highest venue-adjusted ceiling</span><span>${top(j => summ[j].p90 * gp[j].venue / 60)}</span>
      <span>Benefit most from today's pitch</span><span>${top(j => gp[j].venue)} (pace-assist index 1.08)</span>
      <span>Gain most from the toss</span><span>${top(j => gp[j].toss)}</span>
      <span>Multiple scoring routes</span><span>${players.map((p, j) => j).filter(j => gp[j].exp.balls >= 12 && gp[j].exp.overs >= 4).map(j => esc(players[j].name)).join(', ') || '—'}</span>
      <span>Can win a GL if their script occurs</span><span>${top(j => summ[j].p95)}</span>
      <span>Provide differentiation</span><span>${top(j => gp[j].differential * (summ[j].p90 > 60 ? 1 : 0.5))}</span>
      <span>Highest-leverage C/VC</span><span>${esc(players[team.C].name)} / ${esc(players[team.VC].name)}</span>
      <span>Strongest script covered</span><span>${esc(E.SCRIPTS[team.best])}</span>
      <span>Sacrificed for differentiation</span><span>${dropped.join(', ') || 'none'} (in the highest-average team, left out here)</span></div></div>`;
  }

  function scriptsCard(R) {
    const sp = R.summ[0].scriptProb; const { players, summ } = R;
    return `<div class="card" style="margin-top:14px"><h3>Match-script engine <span class="pill info">MODEL OUTPUT · ${R.sim.n} sims</span></h3><table><tr><th>Script</th><th class="n">Probability</th><th>Players who benefit most (pts in script vs avg)</th></tr>
      ${Object.entries(E.SCRIPTS).map(([k, name]) => `<tr><td><b>${k}</b> ${esc(name)}</td><td class="n">${pc(sp[k])}</td><td class="small">${players.map((p, j) => [j, (summ[j].byScript[k] ?? 0) - summ[j].mean]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([j, d]) => `${esc(players[j].name)} (+${f0(d)})`).join(', ')}</td></tr>`).join('')}</table>
      <p class="small muted">Probabilities come from the simulation (priors + venue/toss/weather adjustments), not from venue history. Historical pitch-behaviour probabilities are INSUFFICIENT DATA with 2 ODIs. Scripts overlap, so the column doesn't sum to 100%.</p></div>`;
  }

  function playerTable(R) {
    const { players, summ, gp } = R;
    return `<div class="card" style="margin-top:14px"><h3>Player role · ceiling · variance model (official XI only)</h3><div class="scroll"><table><tr><th>Player</th><th>Role</th><th class="n">Pos</th><th class="n">Balls</th><th class="n">Runs</th><th class="n">4s/6s</th><th class="n">Overs</th><th class="n">Wkts</th><th class="n">Opp.</th><th class="n">Exp</th><th class="n">Floor</th><th class="n">Med</th><th class="n">P75</th><th class="n">P90</th><th class="n">P95</th><th class="n">Var</th><th class="n">Venue</th><th class="n">Diff</th><th class="n">GL value</th><th class="n">Toss Δ</th><th>Class</th></tr>
      ${players.map((p, j) => j).sort((a, b) => gp[b].glValue - gp[a].glValue).map(j => { const p = players[j], s = summ[j], g = gp[j]; return `<tr class="click" onclick="App.player('${p.id}')"><td>${esc(p.name)} ${pill(p.team)}${R.team.S.includes(j) ? ' ✓' : ''}</td><td>${p.role}</td><td class="n">${p.pos}${p.posAlt ? '/' + p.posAlt : ''}</td><td class="n">${f0(g.exp.balls)}</td><td class="n">${f0(g.exp.runs)}</td><td class="n">${f1(g.exp.fours)}/${f1(g.exp.sixes)}</td><td class="n">${f1(g.exp.overs)}</td><td class="n">${f1(g.exp.wkts)}</td><td class="n">${f0(g.opportunity)}</td><td class="n"><b>${f0(s.mean)}</b></td><td class="n">${f0(s.floor)}</td><td class="n">${f0(s.median)}</td><td class="n">${f0(s.p75)}</td><td class="n">${f0(s.p90)}</td><td class="n">${f0(s.p95)}</td><td class="n">${f0(g.variance)}</td><td class="n">${f0(g.venue)}</td><td class="n">${f0(g.differential)}</td><td class="n">${f1(g.glValue * 100)}</td><td class="n">${g.toss >= 0 ? '+' : ''}${f1(g.toss)}</td><td class="tier ${g.cls}">${g.cls}</td></tr>`; }).join('')}</table></div>
      <p class="small muted">Per-player last-5/10 ODI form couldn't be verified (ESPNcricinfo blocks automated fetches), so projections are role/position-driven with sourced evidence only (e.g. Kohli: 2026 SR 106.66, avg 66.50 vs WI). Toss Δ = TOSS_ADJUSTED_PLAYER_SCORE minus the toss-unknown projection, from a full model re-run.</p></div>`;
  }

  function venueCard(R) {
    const { idx, variance: v } = R.vIdx;
    return `<div class="grid two" style="margin-top:14px"><div class="card"><h3>Venue GL index</h3><table>${Object.entries(idx).map(([k, o]) => `<tr><td>${k}</td><td class="n">${o.v == null ? NDA : o.v}</td><td class="small muted">${esc(o.note)}</td></tr>`).join('')}</table>
      <p class="small muted">Sources: ${link('venue_search')} · ${link('yahoo_pitch')} · ${link('espn_preview')}. ODI data only; T20 matches at this venue are excluded.</p></div>
      <div class="card"><h3>Venue variance engine</h3><div class="kv"><span>Avg / median 1st inns</span><span>${f0(v.avgFirst)} / ${f0(v.medianFirst)}</span><span>SD 1st inns</span><span>${f0(v.sdFirst)}</span><span>Highest / lowest</span><span>390/5 · 73</span><span>Avg wkts (SD)</span><span>${f1(v.avgWkts)} (${f1(v.sdWkts)})</span><span>Powerplay / death variance</span><span>${NDA}</span><span>VENUE VARIANCE SCORE</span><b>${v.score} / 100</b><span>Strategy</span><span>${esc(v.strategy)}</span><span>Recency weighting</span><span>Last 5 = both matches (2018, 2023); last 10/15 ${NDA}</span></div>
      <p class="small">Toss: India won and bowled (${seed.toss.reports.length} agreeing reports). The whole model was re-run with WI batting first in day conditions and India chasing with dew (2nd-innings spin wkts ×0.9, batting SR ×1.03). Weather: ${R.cond.weather ? `peak rain ${R.cond.weather.rain}% in match window (Open-Meteo) → ${pc(R.cond.rainShortProb)} of sims shortened` : 'unavailable'}.</p></div></div>`;
  }

  function pointsCard(R) {
    const c = R.cfg, fs = c.fieldStatus || {};
    const row = (l, v, k) => `<tr><td>${l}</td><td class="n"><b>${v}</b></td><td class="small muted">${esc(fs[k] || fs._all || '')}</td></tr>`;
    return `<div class="card" style="margin-top:14px"><h3>Points system — ${esc(c.name)} ODI <span class="pill ${R.key === 'my11' ? 'ok' : 'warn'}">${R.key === 'my11' ? 'VERIFIED' : 'PROVISIONAL'}</span></h3><div class="small">${esc(c.version)} · source: ${link(c.source)}${R.key === 'dream11' ? ' · official: ' + link('d11_official') : ''}</div>
      <div class="grid two" style="margin-top:8px"><table>
      ${row('Run', '+' + c.run, 'run')}${row('Four bonus', '+' + c.four, 'four')}${row('Six bonus', '+' + c.six, 'six')}
      ${row('Milestones', c.milestones.map(([m, p]) => `${m}:+${p}`).join(' ') + ` (${c.milestoneMode})`, 'milestones')}${row('Duck (non-bowlers)', c.duck, 'duck')}
      ${row('Strike rate', `min ${c.srMinRuns < 999 ? c.srMinRuns + ' runs or ' : ''}${c.srMinBalls} balls`, 'sr')}
      ${row('Dot ball', c.dotsPerPoint ? `+${c.dotPoint} per ${c.dotsPerPoint}` : 'none', 'dots')}${row('Wicket', '+' + c.wicket, 'wicket')}${row('LBW/Bowled', '+' + c.lbwBowled, 'lbwBowled')}
      ${row('Hauls', c.hauls.map(([w, p]) => `${w}w:+${p}`).join(' ') + ` (${c.haulMode})`, 'hauls')}${row('Maiden', '+' + c.maiden, 'maiden')}
      ${row('Economy', `min ${c.econMinOvers} ov`, 'econ')}${row('Catch / 3-catch', `+${c.catch} / +${c.threeCatchBonus}`, 'fielding')}${row('Stumping / RO direct / RO other', `+${c.stumping} / +${c.runoutDirect} / +${c.runoutIndirect}`, 'fielding')}
      ${row('Playing XI', '+' + c.playingXI, 'playingXI')}${row('Captain / VC', `×${c.captain} / ×${c.viceCaptain}`, 'cvc')}</table>
      <div><p class="small">SR bands: ${c.srBands.map(([a, b, p]) => `${a}–${b > 999 ? '∞' : b}: ${p > 0 ? '+' : ''}${p}`).join(' · ')}</p><p class="small">Economy bands: ${c.econBands.map(([a, b, p]) => `${a}–${b}: ${p > 0 ? '+' : ''}${p}`).join(' · ')}</p>
      ${(c.conflicts || []).map(x => `<p class="small"><b>Conflict · ${esc(x.field)}</b>: ${x.values.map(v => `${v.value} (${esc(seed.sources[v.source]?.name)})`).join(' vs ')} → using ${x.resolved}. ${esc(x.rule)}</p>`).join('')}
      <p class="small muted">Your pasted tables are T20 rules, so they aren't applied to this ODI.</p>
      <h3>Edit scoring (match your app)</h3><div class="grid two">${['four', 'six', 'duck', 'wicket', 'lbwBowled', 'maiden', 'dotsPerPoint', 'dotPoint', 'catch', 'playingXI'].map(k => `<label class="row small" style="justify-content:space-between">${k}<input class="num" data-sc="${k}" value="${c[k]}"></label>`).join('')}</div>
      <div class="row" style="margin-top:6px"><button class="btn" onclick="App.saveScoring()">Apply &amp; re-run</button><button class="btn ghost" onclick="App.resetScoring()">Reset</button></div></div></div></div>`;
  }

  function inputs(R) {
    const cr = (state.credits2 || {})[R.key] || {}, ro = (state.roles2 || {})[R.key] || {};
    return `<details class="card" style="margin-top:14px"><summary><b>${esc(R.P.label)} credits &amp; roles</b> <span class="small muted">(optional; enforces the ${R.cons.credits}-credit cap once every player has a credit)</span></summary>
      <div class="grid two" style="margin-top:10px">${['IND', 'WI'].map(t => `<table><tr><th>${t}</th><th>Role</th><th class="n">Credits</th></tr>${seed.officialXI[t].map(id => { const p = seed.players.find(x => x.id === id); return `<tr><td>${esc(p.name)}</td><td><select data-ro="${id}">${['WK', 'BAT', 'AR', 'BOWL'].map(r => `<option ${(ro[id] || p.role) === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td><td class="n"><input class="num" type="number" step="0.5" data-cr="${id}" value="${cr[id] ?? ''}" placeholder="—"></td></tr>`; }).join('')}</table>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="App.saveInputs()">Save &amp; re-optimise</button><span class="small muted">Limits: ${Object.entries(R.cons.roles).map(([r, [a, b]]) => `${r} ${a}–${b}`).join(' · ')} · max ${R.cons.maxFromTeam}/team. ${esc(R.cons.note || '')}</span></div></details>`;
  }

  function copyCard(R) {
    const { players, team } = R; const by = r => team.S.filter(j => players[j].role === r);
    const txt = [`FINAL HIGH-UPSIDE GL TEAM — ${R.P.label}`, 'India vs West Indies · 1st ODI', '',
      ...['WK', 'BAT', 'AR', 'BOWL'].flatMap(r => [r + ':', ...by(r).map(j => players[j].name + (j === team.C ? ' (C)' : j === team.VC ? ' (VC)' : '')), '']),
      `CAPTAIN: ${players[team.C].name}`, `VICE-CAPTAIN: ${players[team.VC].name}`, '',
      `Expected Points: ${f0(team.mean)}`, `P90: ${f0(team.p90)}`, `Ceiling: ${f0(team.ceiling)}`, `GL Score: ${f1(team.obj)}`, `Venue Score: ${f0(team.venue)}`, `Differentiation Score: ${f0(team.diff)}`, `Risk Level: ${team.risk.band}`].join('\n');
    return `<div class="card" style="margin-top:14px"><h3>Copy-ready</h3><div class="textout" id="copytxt">${esc(txt)}</div><button class="btn ghost" style="margin-top:8px" onclick="navigator.clipboard.writeText(document.getElementById('copytxt').innerText)">Copy</button></div>`;
  }

  function playerDetail(id) {
    const R = cache[tab]; const j = R.players.findIndex(p => p.id === id); const p = R.players[j], s = R.summ[j], g = R.gp[j];
    return `<h2>${esc(p.name)} ${pill(p.team)} <span class="tier ${g.cls}">${g.cls}</span></h2><p class="small muted">${esc(R.P.label)} scoring</p>
      <div class="grid three"><div class="card"><h3>Distribution</h3><div class="kv"><span>Floor (P10)</span><span>${f0(s.floor)}</span><span>Median</span><span>${f0(s.median)}</span><span>Expected</span><b>${f1(s.mean)}</b><span>P75</span><span>${f0(s.p75)}</span><span>P90</span><b>${f0(s.p90)}</b><span>P95</span><span>${f0(s.p95)}</span><span>P(100+ pts)</span><span>${pc(s.p100)}</span></div></div>
      <div class="card"><h3>Role / opportunity</h3><div class="kv"><span>Bat position</span><span>${p.pos}${p.posAlt ? ' or ' + p.posAlt : ''}</span><span>Exp. balls / runs</span><span>${f0(g.exp.balls)} / ${f0(g.exp.runs)}</span><span>Exp. 4s / 6s</span><span>${f1(g.exp.fours)} / ${f1(g.exp.sixes)}</span><span>P(50+) / P(100+)</span><span>${pc(g.exp.p50)} / ${pc(g.exp.p100)}</span><span>Exp. overs / wkts</span><span>${f1(g.exp.overs)} / ${f1(g.exp.wkts)}</span><span>P(3+ wkts)</span><span>${pc(g.exp.pW3)}</span><span>Exp. dismissals (field)</span><span>${f1(g.exp.catches)}</span><span>OPPORTUNITY_SCORE</span><b>${f0(g.opportunity)}</b></div></div>
      <div class="card"><h3>GL scores</h3><div class="kv"><span>VENUE_PLAYER_SCORE</span><span>${f0(g.venue)}${g.venueSample ? ` (n=${g.venueSample})` : ' (no record)'}</span><span>Role security</span><span>${f0(g.role)}</span><span>MODEL_DIFFERENTIAL</span><span>${f0(g.differential)}</span><span>PLAYER_VARIANCE</span><span>${f0(g.variance)}</span><span>GL_VALUE</span><b>${f1(g.glValue * 100)}</b><span>Toss-adjusted Δ</span><span>${f1(g.toss)}</span></div></div></div>
      <div class="card" style="margin-top:12px"><h3>Scripts</h3>${Object.entries(E.SCRIPTS).map(([k, n]) => `<div class="row small" style="justify-content:space-between"><span>${esc(n)}</span><span class="mono">${f0(s.byScript[k])} pts (×${f1(g.scriptRatio[k])})</span></div>`).join('')}
      <h3 style="margin-top:10px">Evidence & derivation</h3><ul class="small">${p.evidence.map(e => `<li>${esc(e.label)} — ${link(e.source)}</li>`).join('')}${p.batTrail.concat(p.bowlTrail || []).map(t => `<li class="muted">${esc(t)}</li>`).join('')}</ul><p class="small"><b>Risk:</b> ${esc(riskList(R, j).join('; ') || 'standard')}</p></div>`;
  }

  return {
    async init() {
      try { const h = location.hash.slice(1); if (TABS.some(([k]) => k === h)) tab = h; } catch { }
      [seed, state] = await Promise.all([fetch('/api/seed').then(r => r.json()), fetch('/api/state').then(r => r.json()).catch(() => ({}))]);
      weather = await fetch('/api/weather').then(r => r.json()).catch(() => null);
      render();
      setInterval(async () => { weather = await fetch('/api/weather').then(r => r.json()).catch(() => weather); for (const k in cache) delete cache[k]; render(); }, 15 * 60 * 1000);
    },
    go(k) { tab = k; history.replaceState(null, '', '#' + k); render(); window.scrollTo(0, 0); },
    player(id) { $('#modalBody').innerHTML = playerDetail(id); $('#modal').classList.remove('hidden'); },
    closeModal() { $('#modal').classList.add('hidden'); },
    async saveInputs() {
      const cr = {}, ro = {};
      document.querySelectorAll('[data-cr]').forEach(el => { if (el.value !== '') cr[el.dataset.cr] = +el.value; });
      document.querySelectorAll('[data-ro]').forEach(el => { ro[el.dataset.ro] = el.value; });
      await save({ credits2: { ...(state.credits2 || {}), [tab]: cr }, roles2: { ...(state.roles2 || {}), [tab]: ro } });
      delete cache[tab]; render();
    },
    async saveScoring() {
      const o = {}; document.querySelectorAll('[data-sc]').forEach(el => o[el.dataset.sc] = +el.value);
      o.version = seed.platforms[tab].scoring.version + ' · user-edited';
      await save({ scoringOverride: { ...(state.scoringOverride || {}), [tab]: o } }); delete cache[tab]; render();
    },
    async resetScoring() { const so = { ...(state.scoringOverride || {}) }; delete so[tab]; await save({ scoringOverride: so }); delete cache[tab]; render(); },
  };
})();
document.addEventListener('keydown', e => { if (e.key === 'Escape') App.closeModal(); });
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') App.closeModal(); });
App.init();
