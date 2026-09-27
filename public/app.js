// DreamTeam — Pure GL Decision Engine UI.
// Tabs: Match Setup (screenshot upload → extract → research) · Dream11 Team · My11Circle Team.
const App = (() => {
  const E = Engine;
  const TABS = [['setup', 'Match Setup'], ['dream11', 'Dream11 Team'], ['my11', 'My11Circle Team']];
  let seed, state, status, weather = null, tab = 'setup';
  let shots = [], extracted = null, jobTimer = null, versions = [];
  const cache = {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f0 = v => (v == null || Number.isNaN(v) ? '—' : Math.round(v));
  const f1 = v => (v == null || Number.isNaN(v) ? '—' : (+v).toFixed(1));
  const pc = v => (v * 100).toFixed(0) + '%';
  const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const NDA = '<span class="nda">INSUFFICIENT DATA</span>';
  const teams = () => seed.teams || ['IND', 'WI'];
  const tname = t => seed.teamNames?.[t] || t;
  const pill = t => `<span class="pill ${teams()[0] === t ? 'ind' : 'wi'}">${esc(t)}</span>`;
  const link = id => { const s = seed.sources?.[id]; return s ? (s.url ? `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)) : esc(id || '—'); };
  const tossText = () => seed.toss?.winner ? `${tname(seed.toss.winner)} won the toss, chose to ${seed.toss.decision}` : 'Toss pending';
  const batFirstText = () => seed.toss?.batFirst ? `${seed.toss.batFirst} bat first` : 'toss pending (both orders simulated)';

  async function api(path, opts) { const r = await fetch(path, opts); return r.json(); }
  async function save(patch) { Object.assign(state, patch); try { await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); } catch { } }
  async function loadAll() {
    [seed, state, status] = await Promise.all([api('/api/seed'), api('/api/state').catch(() => ({})), api('/api/status')]);
    weather = await api('/api/weather').catch(() => null);
    versions = await api('/api/versions').catch(() => []);
    for (const k in cache) delete cache[k];
  }

  // ---------- per-platform pipeline ----------
  function run(key) {
    const P = seed.platforms[key];
    const cfg = { ...P.scoring, ...((state.scoringOverride || {})[key] || {}) };
    const cons = P.constraints;
    // screenshot credits / ownership belong only to the platform the screenshot came from
    const shotKey = { dream11: 'dream11', my11circle: 'my11' }[seed.screenshot?.platform];
    const pseed = shotKey === key ? seed : { ...seed, players: seed.players.map(p => ({ ...p, credit: null, ownership: null })) };
    const pstate = { ...state, credits: (state.credits2 || {})[key] || {}, roles: (state.roles2 || {})[key] || {}, xiConfirmed: null };
    const xi = E.xiStatus(pseed, pstate);
    const players = E.buildPlayers(pseed, pstate, xi.xi);
    const cond = E.conditions(seed, weather, { tossKnown: !!seed.toss?.batFirst, batFirst: seed.toss?.batFirst });
    const condPre = E.conditions(seed, weather, { tossKnown: false });
    const n = 2000;
    const sim = E.simulate(players, cond, cfg, n, 20260927);
    const simPre = E.simulate(players, condPre, cfg, n, 20260927);
    const summ = E.summarize(sim), summPre = E.summarize(simPre);
    const tossDelta = Object.fromEntries(players.map((p, j) => [p.id, summ[j].mean - summPre[j].mean]));
    const vIdx = E.venueIndex(seed);
    const gp = E.glPlayers(players, summ, seed, tossDelta, vIdx);
    const W = { ...E.GL_WEIGHTS };
    const team = E.optimiseGL(players, sim, summ, gp, cfg, cons, W, vIdx.shift);
    const combos = team.ok ? E.cvcCombos(players, sim, summ, gp, team.S, cfg, seed, 5) : [];
    if (team.ok && combos.length) { team.C = combos[0].C; team.VC = combos[0].VC; const t = E.teamTotals(sim, team.S, team.C, team.VC, cfg); Object.assign(team, { mean: E.mean(t), p90: E.pct(t, 90), p95: E.pct(t, 95), ceiling: E.pct(t, 99), floor: E.pct(t, 10), risk: E.riskBand(t) }); }
    const checks = team.ok ? validate(players, team, cfg, cons, xi) : [];
    const ownershipReal = players.filter(p => typeof p.ownership === 'number').length >= players.length / 2;
    return { key, P, cfg, cons, xi, players, cond, sim, summ, summPre, tossDelta, vIdx, gp, W, team, combos, checks, ownershipReal };
  }

  function validate(players, t, cfg, cons, xi) {
    const S = t.S.map(j => players[j]); const rc = { WK: 0, BAT: 0, AR: 0, BOWL: 0 }; S.forEach(p => rc[p.role]++);
    const tc = Object.fromEntries(teams().map(k => [k, S.filter(p => p.team === k).length]));
    const verified = /VERIFIED|USER-PROVIDED/.test(cfg.status || '') && !/PROVISIONAL/.test(cfg.status || '');
    return [
      ['11 players', S.length === 11, ''],
      ['Correct credits', t.creditsKnown && t.credits <= cons.credits, t.creditsKnown ? `${f1(t.credits)} / ${cons.credits}` : 'Credits not available — cap not enforced (upload the platform screenshot or enter credits)'],
      ['Correct role limits', Object.keys(cons.roles).every(r => rc[r] >= cons.roles[r][0] && rc[r] <= cons.roles[r][1]), `WK ${rc.WK} · BAT ${rc.BAT} · AR ${rc.AR} · BOWL ${rc.BOWL}`],
      ['Team limits valid', teams().every(k => tc[k] <= cons.maxFromTeam), teams().map(k => `${k} ${tc[k]}`).join(' · ')],
      ['All players in Playing XI', xi.confirmed && S.every(p => xi.byPlayer[p.id].status === 'CONFIRMED'), xi.confirmed ? 'Official XI' : 'XI not announced yet — PROBABLE XI used; refresh after the toss'],
      ['C valid', t.S.includes(t.C), players[t.C].name],
      ['VC valid', t.S.includes(t.VC) && t.C !== t.VC, players[t.VC].name],
      ['Current scoring system', verified, cfg.status || cfg.version],
      ['Venue data validated', true, `${seed.venue?.formatMatches?.length || 0} same-format venue matches with sources`],
      ['Toss incorporated', !!seed.toss?.winner, seed.toss?.winner ? tossText() + ' → full model re-run' : 'Toss pending — both batting orders simulated'],
      ['Pitch incorporated', !!seed.venue?.pitchType && seed.venue.pitchType !== 'UNKNOWN', seed.venue?.pitchType || 'UNKNOWN'],
      ['No duplicate player', new Set(t.S).size === 11, ''],
      ['No unavailable player', !seed.officialXI || S.every(p => seed.officialXI[p.team]?.includes(p.id)), seed.officialXI ? 'Only announced players considered' : 'Probable XI'],
    ];
  }

  // ---------- rendering ----------
  function render() {
    $('#nav').innerHTML = TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" onclick="App.go('${k}')">${l}</button>`).join('');
    $('#modelVersion').textContent = E.MODEL_VERSION;
    const m = seed.match;
    $('.fixture').innerHTML = `<div class="teams">${esc(m.title.toUpperCase())}</div><div class="sub">${esc([m.matchNo, m.dateLabel || m.date, m.city, m.type].filter(Boolean).join(' · '))}</div>`;
    $('#topStatus').innerHTML = `<span class="pill ${seed.toss?.winner ? 'ok' : 'warn'}">${esc(seed.toss?.winner ? `Toss: ${seed.toss.winner} ${seed.toss.decision}` : 'Toss pending')}</span><span class="pill ${seed.officialXI ? 'ok' : 'warn'}">XI: ${seed.officialXI ? 'announced' : 'probable'}</span><button class="btn" id="refreshBtn" onclick="App.refresh()" title="Fetch latest toss, Playing XI, pitch, venue and weather, then rebuild both teams">⟳ Refresh</button>`;
    if (tab === 'setup') { $('#view').innerHTML = setupView(); bindSetup(); return; }
    if (!cache[tab]) { $('#view').innerHTML = '<div class="card">Running 2,000 simulated matches and the GL optimiser…</div>'; setTimeout(() => { try { cache[tab] = run(tab); } catch (e) { cache[tab] = { error: e }; } render(); }, 30); return; }
    if (cache[tab].error) { $('#view').innerHTML = `<div class="banner">Model error: ${esc(cache[tab].error.message)}</div>`; console.error(cache[tab].error); return; }
    try { $('#view').innerHTML = view(cache[tab]); } catch (e) { $('#view').innerHTML = `<div class="banner">RENDER ERROR: ${esc(e.message)}</div>`; console.error(e); }
  }

  // ---------- Match Setup ----------
  function setupView() {
    const m = seed.match, ex = extracted;
    const claudeOk = status?.claude;
    const inputRow = (k, label, v, type = 'text') => `<label class="row small" style="justify-content:space-between;gap:8px">${label}<input style="flex:1;max-width:260px" data-in="${k}" type="${type}" value="${esc(v ?? '')}"></label>`;
    return `
    ${claudeOk ? '' : `<div class="banner"><b>Claude is not configured.</b> Screenshot reading and live data refresh use Claude (vision + web search). Stop the server and start it with <code>ANTHROPIC_API_KEY=sk-ant-… npm start</code>. Until then you can browse the saved match below.</div>`}
    ${(seed.changes || []).length ? `<div class="banner ok"><b>Latest refresh changed:</b> ${seed.changes.map(esc).join(' · ')}</div>` : ''}
    <div class="grid two">
      <div class="card"><h3>1 · Upload match screenshot</h3>
        <div id="drop" class="drop"><b>Drop screenshots here</b>, click to choose, or paste (Ctrl/⌘+V)<br><span class="small muted">Match page or Dream11 / My11Circle contest page, up to 5 images. Player lists with credits and "selected by %" are read too.</span>
          <input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden></div>
        <div class="row" id="thumbs" style="margin-top:8px">${shots.map((s, i) => `<div class="thumb"><img src="data:${s.mediaType};base64,${s.data}"><button onclick="App.dropShot(${i})">×</button></div>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="btn" ${!shots.length || !claudeOk ? 'disabled' : ''} onclick="App.extract()">Read screenshot</button><button class="btn ghost" onclick="App.manual()">Enter details manually</button><span id="exStatus" class="small muted"></span></div>
      </div>
      <div class="card"><h3>2 · Confirm match details</h3>
        ${ex ? `<div class="grid two" style="gap:6px">
          ${inputRow('teamA', 'Team A', ex.teamA)}${inputRow('teamAShort', 'Team A code', ex.teamAShort)}
          ${inputRow('teamB', 'Team B', ex.teamB)}${inputRow('teamBShort', 'Team B code', ex.teamBShort)}
          <label class="row small" style="justify-content:space-between">Format<select data-in="format">${['ODI', 'T20', 'T10'].map(f => `<option ${ex.format === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
          ${inputRow('matchLabel', 'Match', ex.matchLabel)}${inputRow('series', 'Series', ex.series)}${inputRow('date', 'Date', ex.date)}
          ${inputRow('startTime', 'Start time', ex.startTime)}${inputRow('venue', 'Venue', ex.venue)}${inputRow('city', 'City', ex.city)}
          <label class="row small" style="justify-content:space-between">Screenshot from<select data-in="platform">${['dream11', 'my11circle', 'other', 'unknown'].map(f => `<option ${ex.platform === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
          ${ex.players?.length ? `<details style="margin-top:8px"><summary class="small">${ex.players.length} players read from screenshot (credits / selected-by)</summary><div class="scroll"><table><tr><th>Player</th><th>Team</th><th>Role</th><th class="n">Credits</th><th class="n">Sel %</th><th>Announced</th></tr>${ex.players.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.team)}</td><td>${esc(p.role)}</td><td class="n">${p.credits ?? '—'}</td><td class="n">${p.selectedByPercent ?? '—'}</td><td>${p.announced == null ? '—' : p.announced ? 'yes' : 'no'}</td></tr>`).join('')}</table></div></details>` : ''}
          <div class="row" style="margin-top:10px"><button class="btn" ${claudeOk ? '' : 'disabled'} onclick="App.analyse()">3 · Fetch data &amp; build teams</button><span class="small muted">Claude searches the web for toss, Playing XI, pitch, venue history, form and weather (≈1–3 min).</span></div>`
        : `<p class="small muted">Upload a screenshot (or enter details manually) to begin.</p>`}
        <div id="jobBox"></div>
      </div>
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card"><h3>Current match</h3><div class="kv"><span>Match</span><b>${esc(m.title)} · ${esc(m.matchNo || '')}</b><span>Format</span><span>${esc(m.type || m.format)}</span><span>Venue</span><span>${esc(m.venue)}</span><span>Toss</span><span>${esc(tossText())}</span><span>Playing XI</span><span>${seed.officialXI ? 'Announced' : 'Probable / not announced'}</span><span>Data collected</span><span>${when(seed.meta?.seedCollectedAt)}</span><span>Players</span><span>${seed.players.length}</span></div>
        <div class="row" style="margin-top:10px"><button class="btn" onclick="App.go('dream11')">Dream11 Team →</button><button class="btn" onclick="App.go('my11')">My11Circle Team →</button>${status?.isDefault ? '' : '<button class="btn ghost" onclick="App.resetDefault()">Back to sample match</button>'}</div>
        ${(seed.dataGaps || []).length ? `<p class="small"><b>Data gaps:</b> ${seed.dataGaps.map(esc).join(' · ')}</p>` : ''}${(seed.conflicts || []).length ? `<p class="small"><b>Conflicts:</b> ${seed.conflicts.map(esc).join(' · ')}</p>` : ''}</div>
      <div class="card"><h3>Refresh history</h3>${versions.length ? `<table><tr><th>Collected</th><th>Toss</th><th>XI</th><th>Changes</th></tr>${versions.map(v => `<tr><td class="small">${when(v.at)}</td><td class="small">${esc(v.toss)}</td><td class="small">${esc(v.xi)}</td><td class="small">${esc(v.changes.join('; ') || '—')}</td></tr>`).join('')}</table>` : '<p class="small muted">No refreshes yet for this match.</p>'}
        <p class="small muted">Every refresh is saved as a new version, and the teams are rebuilt from the newest data. Strategy: <a href="/docs/gl-strategy.md" target="_blank">GL strategy</a> · Points: <a href="/docs/points-systems.md" target="_blank">points systems</a></p></div>
    </div>`;
  }
  function bindSetup() {
    const drop = $('#drop'), file = $('#file');
    if (!drop) return;
    drop.onclick = () => file.click();
    file.onchange = () => addFiles(file.files);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
    if (job.running) pollJob();
  }
  async function addFiles(list) {
    for (const f of [...list].slice(0, 5 - shots.length)) {
      if (!/^image\//.test(f.type)) continue;
      const data = await shrink(f);
      shots.push(data);
    }
    render();
  }
  // downscale large screenshots client-side (keeps uploads small, text stays legible)
  function shrink(file) {
    return new Promise(res => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1800, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        res({ mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] });
      };
      img.src = url;
    });
  }
  document.addEventListener('paste', e => { if (tab !== 'setup') return; const files = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()); if (files.length) addFiles(files); });

  const job = { running: false };
  function pollJob(onDone) {
    job.running = true; clearInterval(jobTimer);
    const box = () => $('#jobBox') || $('#refreshBox');
    jobTimer = setInterval(async () => {
      const j = await api('/api/job').catch(() => null); if (!j) return;
      const el = box();
      if (el) el.innerHTML = `<div class="joblog"><b>${j.state === 'running' ? '⏳ Working…' : j.state === 'done' ? '✓ Done' : j.state === 'error' ? '✗ Failed' : ''}</b> <span class="small muted">${j.startedAt ? Math.round((Date.now() - new Date(j.startedAt)) / 1000) + 's' : ''}</span>${j.log.slice(-12).map(l => `<div class="small mono">${esc(l.msg)}</div>`).join('')}</div>`;
      if (j.state !== 'running') {
        clearInterval(jobTimer); job.running = false;
        const btn = $('#refreshBtn'); if (btn) btn.disabled = false;
        if (j.state === 'done') { await loadAll(); tab = tab === 'setup' && !onDone ? 'dream11' : tab; if (onDone) onDone(); render(); }
      }
    }, 1500);
  }

  // ---------- team view ----------
  function view(R) {
    const { players, summ, gp, team, combos, P, cfg } = R;
    if (!team.ok) return `<div class="banner">${esc(team.reason)}</div>${inputs(R)}`;
    const S = team.S, by = r => S.filter(j => players[j].role === r);
    const card = j => `<div class="pcard" onclick="App.player('${players[j].id}')">${j === team.C ? '<span class="cvc c">C</span>' : j === team.VC ? '<span class="cvc vc">VC</span>' : ''}<b>${esc(players[j].name)}</b><small>${esc(players[j].team)} · exp ${f0(summ[j].mean)} · P90 ${f0(summ[j].p90)}${players[j].credit != null ? ' · ' + players[j].credit + 'cr' : ''}</small><small class="tier ${gp[j].cls}">${gp[j].cls}</small></div>`;
    const warn = /PROVISIONAL/.test(cfg.status || '') ? `<div class="banner"><b>${esc(P.label)} scoring is PROVISIONAL:</b> ${esc(cfg.status)}. Edit it under <i>Points system</i> to match your app.</div>` : '';
    const xiWarn = seed.officialXI ? '' : `<div class="banner"><b>Playing XI not announced yet.</b> This team uses the PROBABLE XI. Press ⟳ Refresh after the toss to rebuild it from the official line-ups.</div>`;
    const changes = (seed.changes || []).length ? `<div class="banner ok"><b>Updated after refresh:</b> ${seed.changes.map(esc).join(' · ')}</div>` : '';
    const diffs = players.map((p, j) => j).filter(j => summ[j].p90 >= E.pct(summ.map(s => s.p90), 40)).sort((a, b) => gp[b].differential - gp[a].differential).slice(0, 5);
    const risky = S.filter(j => riskList(R, j).length);
    const split = teams().map(k => `${k} ${S.filter(j => players[j].team === k).length}`).join(' / ');
    return `${changes}${xiWarn}${warn}
    <div class="final-hero"><h1>FINAL HIGH-UPSIDE GL TEAM · ${esc(P.label.toUpperCase())}</h1><div class="sub" style="margin-top:6px">${esc(seed.match.title)} · ${esc(seed.match.matchNo || '')} · ${esc(seed.match.venue || '')} · ${esc(batFirstText())} · data ${when(seed.meta?.seedCollectedAt)}</div></div>
    <div class="grid two" style="margin-top:14px"><div class="pitch">${['WK', 'BAT', 'AR', 'BOWL'].map(r => `<div class="lbl">${r}</div><div class="lane">${by(r).map(card).join('')}</div>`).join('')}</div>
    <div class="col"><div class="card"><div class="row" style="gap:18px"><div><div class="muted small">CAPTAIN</div><div class="row"><span class="cvc c">C</span><b style="font-size:18px">${esc(players[team.C].name)}</b></div></div><div><div class="muted small">VICE-CAPTAIN</div><div class="row"><span class="cvc vc">VC</span><b style="font-size:18px">${esc(players[team.VC].name)}</b></div></div></div>
      <div class="grid three" style="margin-top:12px">${[['Expected Points', f0(team.mean)], ['P90', f0(team.p90)], ['Ceiling (P99)', f0(team.ceiling)], ['GL Score', f1(team.obj)], ['Venue Score', f0(team.venue)], ['Differentiation', f0(team.diff)]].map(([l, v]) => `<div><div class="muted small">${l}</div><div class="big" style="font-size:22px">${v}</div></div>`).join('')}</div>
      <div class="row" style="margin-top:10px"><span class="pill ${team.risk.band === 'Extreme GL' ? 'bad' : 'warn'}">Risk: ${team.risk.band}</span><span class="small muted">CV ${f1(team.risk.cv * 100)}% · P95 ${f0(team.p95)} · floor ${f0(team.floor)} · ${split} · credits ${team.creditsKnown ? f1(team.credits) : 'n/a'}</span></div>
      <p class="small muted">Winning construction: <b>${esc(team.start)}</b> after local search. Best script coverage: <b>${esc(E.SCRIPTS[team.best])}</b> (×${f1(team.scriptLift[team.best])}). ${team.uniqueVsAvg} of 11 differ from the highest-average team. ${team.candidates.toLocaleString()} candidate teams evaluated. Differential basis: ${R.ownershipReal ? 'real "selected by %" from your screenshot' : 'MODEL_DIFFERENTIAL (no ownership data)'}.</p>
      <p class="small">If ${esc(E.SCRIPTS[team.best].split(' (')[0].toLowerCase())} happens, these 11 have the model's strongest path to an exceptional score. That is not a guarantee.</p></div>
      <div class="card"><h3>Candidate C/VC combinations</h3>${combos.map((o, i) => `<div style="padding:6px 0;border-bottom:1px dashed var(--line)"><b>${i + 1}. C: ${esc(players[o.C].name)} · VC: ${esc(players[o.VC].name)}</b> <span class="pill info">GL leverage ${f1(o.score)}</span><div class="small muted">${o.types.join(' · ')} · team P90 ${f0(o.p90)} / P95 ${f0(o.p95)} · corr ${o.corr.toFixed(2)} (${esc(o.script)})${o.complementary ? ' · complementary scoring routes' : ''}</div></div>`).join('')}</div></div></div>

    <div class="card" style="margin-top:14px"><h3>Final team — why each player</h3><div class="scroll"><table><tr><th>Player</th><th>Role</th><th class="n">Pos</th><th class="n">Exp</th><th class="n">Median</th><th class="n">P90</th><th class="n">P95</th><th class="n">Venue</th><th class="n">Diff</th>${R.ownershipReal ? '<th class="n">Sel %</th>' : ''}<th>Class</th><th>Reasons</th></tr>
      ${S.map(j => `<tr class="click" onclick="App.player('${players[j].id}')"><td><b>${esc(players[j].name)}</b> ${pill(players[j].team)} ${j === team.C ? '<span class="cvc c">C</span>' : j === team.VC ? '<span class="cvc vc">VC</span>' : ''}</td><td>${players[j].role}</td><td class="n">${players[j].pos}${players[j].posAlt ? '/' + players[j].posAlt : ''}</td><td class="n">${f0(summ[j].mean)}</td><td class="n">${f0(summ[j].median)}</td><td class="n">${f0(summ[j].p90)}</td><td class="n">${f0(summ[j].p95)}</td><td class="n">${f0(gp[j].venue)}</td><td class="n">${f0(gp[j].differential)}</td>${R.ownershipReal ? `<td class="n">${players[j].ownership ?? '—'}</td>` : ''}<td class="tier ${gp[j].cls}">${gp[j].cls}</td><td class="small">${reasons(R, j).map(esc).join(' · ')}</td></tr>`).join('')}</table></div></div>

    <div class="grid two" style="margin-top:14px"><div class="card"><h3>Top differentials <span class="pill warn">${R.ownershipReal ? 'ownership from screenshot' : 'MODEL_DIFFERENTIAL · no ownership data'}</span></h3>${diffs.map(j => `<p class="small"><b>${esc(players[j].name)}</b> ${pill(players[j].team)} ${S.includes(j) ? '<span class="pill ok">IN TEAM</span>' : ''}<br>Why: P90 ${f0(summ[j].p90)} vs mean ${f0(summ[j].mean)}${players[j].ownership != null ? `, selected by ${players[j].ownership}%` : ''}; best in ${esc(E.SCRIPTS[gp[j].bestScript].split(' (')[0])} (×${f1(gp[j].scriptRatio[gp[j].bestScript])}).<br>Venue: ${gp[j].venueSample ? `sourced record, n=${gp[j].venueSample}` : 'condition fit only — no player venue record'} · Role: ${roleText(players[j], gp[j])}<br>Risk: ${esc(riskList(R, j).join('; ') || 'standard')} · P95 ${f0(summ[j].p95)}</p>`).join('')}</div>
      <div class="card"><h3>Risk analysis</h3>${risky.map(j => `<p class="small"><b>${esc(players[j].name)}</b>: ${esc(riskList(R, j).join('; '))}</p>`).join('') || '<p class="small">No high-risk flags.</p>'}
      <h3 style="margin-top:12px">Validation</h3>${R.checks.map(([n, ok, note]) => `<div class="check"><span class="${ok ? 'y' : 'n'}">${ok ? '✓' : '✗'}</span><span>${esc(n)} <span class="muted small">${esc(note)}</span></span></div>`).join('')}</div></div>
    ${decisionLogic(R)}${scriptsCard(R)}${playerTable(R)}${venueCard(R)}${pointsCard(R)}${inputs(R)}${copyCard(R)}`;
  }

  function roleText(p, g) { return `No.${p.pos}${p.posAlt ? '/' + p.posAlt : ''}, ~${f0(g.exp.balls)} balls${p.bowl ? `, ~${f1(g.exp.overs)} overs (${esc(p.bowl.style)})` : ''}`; }
  function reasons(R, j) {
    const p = R.players[j], g = R.gp[j], F = R.cond.F, out = [];
    if (g.exp.balls >= F.overs * 0.6) out.push(`~${f0(g.exp.balls)} exp. balls (No.${p.pos}) · P(50+) ${pc(g.exp.p50)}`);
    if (p.bowl && g.exp.overs >= F.maxOv * 0.5) out.push(`~${f1(g.exp.overs)} ov · ${f1(g.exp.wkts)} exp. wkts · P(3+ wkts) ${pc(g.exp.pW3)}`);
    if (p.bowl && g.exp.balls >= 10) out.push('two scoring routes (bat + ball)');
    for (const e of p.evidence.filter(e => ['form', 'venue', 'matchup'].includes(e.kind))) out.push(e.label);
    if (Math.abs(g.toss) >= 1.5) out.push(`toss ${g.toss > 0 ? '+' : ''}${f1(g.toss)} pts`);
    if (p.wk) out.push(`keeper: ${f1(g.exp.catches)} exp. dismissals`);
    out.push(`strongest script: ${E.SCRIPTS[g.bestScript].split(' (')[0]} (×${f1(g.scriptRatio[g.bestScript])})`);
    return out.slice(0, 4);
  }
  function riskList(R, j) {
    const p = R.players[j], s = R.summ[j], g = R.gp[j], F = R.cond.F, r = [];
    if (g.exp.balls < F.overs * 0.4 && !(p.bowl && g.exp.overs >= F.maxOv * 0.6)) r.push('Low batting opportunity');
    if (p.bowl && p.bowl.quota <= F.parttime) r.push('Uncertain bowling overs');
    if (p.posAlt || p.posNote) r.push('Batting slot uncertain');
    if (!p.evidence.some(e => e.kind === 'form')) r.push('Recent form not verified');
    if (g.venueSample && g.venueSample < 5) r.push('Small venue sample');
    if (g.scriptRatio[g.bestScript] >= 1.4) r.push(`High dependency on ${g.bestScript}`);
    if (R.xi.byPlayer[p.id]?.status !== 'CONFIRMED') r.push('XI not confirmed');
    if (s.floor < 10) r.push(`Floor ${f0(s.floor)}`);
    return r;
  }
  function decisionLogic(R) {
    const { players, summ, gp, team } = R;
    const top = (f, k = 3) => players.map((p, j) => j).sort((a, b) => f(b) - f(a)).slice(0, k).map(j => esc(players[j].name)).join(', ');
    const dropped = team.avgRef.S.filter(j => !team.S.includes(j)).map(j => esc(players[j].name));
    return `<div class="card" style="margin-top:14px"><h3>Final decision logic</h3><div class="kv small">
      <span>Highest venue-adjusted ceiling</span><span>${top(j => summ[j].p90 * gp[j].venue / 60)}</span>
      <span>Benefit most from today's pitch</span><span>${top(j => gp[j].venue)}</span>
      <span>Gain most from the toss</span><span>${seed.toss?.winner ? top(j => gp[j].toss) : 'Toss pending'}</span>
      <span>Multiple scoring routes</span><span>${players.map((p, j) => j).filter(j => gp[j].exp.balls >= 10 && gp[j].exp.overs >= R.cond.F.maxOv * 0.4).map(j => esc(players[j].name)).join(', ') || '—'}</span>
      <span>Can win a GL if their script occurs</span><span>${top(j => summ[j].p95)}</span>
      <span>Provide differentiation</span><span>${top(j => gp[j].differential * (summ[j].p90 > 60 ? 1 : 0.5))}</span>
      <span>Highest-leverage C/VC</span><span>${esc(players[team.C].name)} / ${esc(players[team.VC].name)}</span>
      <span>Strongest script covered</span><span>${esc(E.SCRIPTS[team.best])}</span>
      <span>Sacrificed for differentiation</span><span>${dropped.join(', ') || 'none'}</span></div></div>`;
  }
  function scriptsCard(R) {
    const sp = R.summ[0].scriptProb; const { players, summ } = R;
    return `<div class="card" style="margin-top:14px"><h3>Match-script engine <span class="pill info">MODEL OUTPUT · ${R.sim.n} sims</span></h3><table><tr><th>Script</th><th class="n">Probability</th><th>Players who benefit most</th></tr>
      ${Object.entries(E.SCRIPTS).map(([k, name]) => `<tr><td><b>${k}</b> ${esc(name)}</td><td class="n">${pc(sp[k])}</td><td class="small">${players.map((p, j) => [j, (summ[j].byScript[k] ?? 0) - summ[j].mean]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([j, d]) => `${esc(players[j].name)} (+${f0(d)})`).join(', ')}</td></tr>`).join('')}</table>
      <p class="small muted">Probabilities come from the simulation (priors plus venue, toss, pitch and weather adjustments). They overlap, so they don't sum to 100%.</p></div>`;
  }
  function playerTable(R) {
    const { players, summ, gp } = R;
    return `<div class="card" style="margin-top:14px"><h3>Player role · ceiling · variance model</h3><div class="scroll"><table><tr><th>Player</th><th>Role</th><th class="n">Pos</th><th class="n">Balls</th><th class="n">Runs</th><th class="n">4s/6s</th><th class="n">Overs</th><th class="n">Wkts</th><th class="n">Exp</th><th class="n">Floor</th><th class="n">Med</th><th class="n">P75</th><th class="n">P90</th><th class="n">P95</th><th class="n">Var</th><th class="n">Venue</th><th class="n">Diff</th><th class="n">GL value</th><th class="n">Toss Δ</th><th>Class</th></tr>
      ${players.map((p, j) => j).sort((a, b) => gp[b].glValue - gp[a].glValue).map(j => { const p = players[j], s = summ[j], g = gp[j]; return `<tr class="click" onclick="App.player('${p.id}')"><td>${esc(p.name)} ${pill(p.team)}${R.team.S.includes(j) ? ' ✓' : ''}</td><td>${p.role}</td><td class="n">${p.pos}</td><td class="n">${f0(g.exp.balls)}</td><td class="n">${f0(g.exp.runs)}</td><td class="n">${f1(g.exp.fours)}/${f1(g.exp.sixes)}</td><td class="n">${f1(g.exp.overs)}</td><td class="n">${f1(g.exp.wkts)}</td><td class="n"><b>${f0(s.mean)}</b></td><td class="n">${f0(s.floor)}</td><td class="n">${f0(s.median)}</td><td class="n">${f0(s.p75)}</td><td class="n">${f0(s.p90)}</td><td class="n">${f0(s.p95)}</td><td class="n">${f0(g.variance)}</td><td class="n">${f0(g.venue)}</td><td class="n">${f0(g.differential)}</td><td class="n">${f1(g.glValue * 100)}</td><td class="n">${g.toss >= 0 ? '+' : ''}${f1(g.toss)}</td><td class="tier ${g.cls}">${g.cls}</td></tr>`; }).join('')}</table></div>
      <p class="small muted">Only sourced recent form is used; missing form falls back to role/position priors (MODEL PRIOR). Toss Δ = toss-adjusted projection minus the toss-unknown projection (full model re-run).</p></div>`;
  }
  function venueCard(R) {
    const { idx, variance: v } = R.vIdx; const ms = seed.venue?.formatMatches || [];
    return `<div class="grid two" style="margin-top:14px"><div class="card"><h3>Venue GL index · ${esc(seed.venue?.name || '')}</h3><table>${Object.entries(idx).map(([k, o]) => `<tr><td>${k}</td><td class="n">${o.v == null ? NDA : o.v}</td><td class="small muted">${esc(o.note)}</td></tr>`).join('')}</table>
      ${ms.length ? `<h3 style="margin-top:10px">Recent ${esc(seed.match.format)} matches at venue</h3><table>${ms.slice(0, 10).map(x => `<tr><td class="small">${esc(x.date)}</td><td class="small">${esc(x.teams)}</td><td class="small">${esc(x.inn1 || x.inn1Runs)}</td><td class="small">${esc(x.inn2 || x.inn2Runs || '')}</td><td class="small muted">${esc(x.result || '')} ${x.source ? '· ' + link(x.source) : ''}</td></tr>`).join('')}</table>` : ''}</div>
      <div class="card"><h3>Venue variance · pitch · weather</h3><div class="kv"><span>Avg / median 1st inns</span><span>${f0(v.avgFirst)} / ${f0(v.medianFirst)}</span><span>Recency-weighted 1st inns</span><span>${f0(v.recencyFirst)}</span><span>SD 1st inns</span><span>${f0(v.sdFirst)}</span><span>Highest / lowest</span><span>${f0(v.highest)} / ${f0(v.lowest)}</span><span>Avg wkts (SD)</span><span>${f1(v.avgWkts)} (${f1(v.sdWkts)})</span><span>VENUE VARIANCE SCORE</span><b>${v.score} / 100</b><span>Strategy</span><span>${esc(v.strategy)}</span><span>Pitch</span><span>${esc(seed.venue?.pitchType || 'UNKNOWN')}</span><span>Toss</span><span>${esc(tossText())}</span></div>
      ${(seed.venue?.pitchText || []).map(p => `<p class="small">“${esc(p.text)}” <span class="muted">— ${link(p.source)}</span></p>`).join('')}
      <ul class="small">${R.cond.notes.map(n => `<li>${esc(n.t)}${n.src ? ` <span class="muted">[${link(n.src)}]</span>` : ''}</li>`).join('')}</ul></div></div>`;
  }
  function pointsCard(R) {
    const c = R.cfg, fs = c.fieldStatus || {};
    const row = (l, v, k) => `<tr><td>${l}</td><td class="n"><b>${v}</b></td><td class="small muted">${esc(fs[k] || '')}</td></tr>`;
    const bonusMode = { cumulative: 'stack', highest: 'highest only', 'stack-below-100': 'stack below 100' }[c.milestoneMode] || c.milestoneMode;
    return `<div class="card" style="margin-top:14px"><h3>Points system — ${esc(c.name)} ${esc(c.format || seed.match.format)} <span class="pill ${/PROVISIONAL/.test(c.status || '') ? 'warn' : 'ok'}">${esc((c.status || '').split(' —')[0] || 'CONFIG')}</span></h3><div class="small">${esc(c.version)} · source: ${link(c.source)} · <a href="/docs/points-systems.md" target="_blank">all tables</a></div>
      <div class="grid two" style="margin-top:8px"><table>
      ${row('Run', '+' + c.run, 'run')}${row('Four / six bonus', `+${c.four} / +${c.six}`, 'four')}
      ${row('Milestones', c.milestones.map(([m, p]) => `${m}:+${p}`).join(' ') + ` (${bonusMode})`, 'milestones')}${row('Duck (non-bowlers)', c.duck, 'duck')}
      ${row('Strike rate', `min ${c.srMinRuns < 999 ? c.srMinRuns + ' runs or ' : ''}${c.srMinBalls} balls`, 'sr')}
      ${row('Dot ball', c.dotsPerPoint ? `+${c.dotPoint} per ${c.dotsPerPoint}` : 'none', 'dots')}${row('Wicket / LBW-bowled', `+${c.wicket} / +${c.lbwBowled}`, 'wicket')}
      ${row('Hauls', c.hauls.map(([w, p]) => `${w}w:+${p}`).join(' ') + ` (${c.haulMode === 'cumulative' ? 'stack' : 'highest'})`, 'hauls')}${row('Maiden', '+' + c.maiden, 'maiden')}
      ${row('Economy', `min ${c.econMinOvers} ov`, 'econ')}${row('Catch / 3-catch / stumping', `+${c.catch} / +${c.threeCatchBonus} / +${c.stumping}`, 'fielding')}${row('Run-out direct / other', `+${c.runoutDirect} / +${c.runoutIndirect}`, 'fielding')}
      ${row('Playing XI', '+' + c.playingXI, 'playingXI')}${row('Captain / VC', `×${c.captain} / ×${c.viceCaptain}`, 'cvc')}</table>
      <div><p class="small">SR bands: ${c.srBands.map(([a, b, p]) => `${a}–${b > 999 ? '∞' : b}: ${p > 0 ? '+' : ''}${p}`).join(' · ')}</p><p class="small">Economy bands: ${c.econBands.map(([a, b, p]) => `${a}–${b}: ${p > 0 ? '+' : ''}${p}`).join(' · ')}</p>
      ${(c.conflicts || []).map(x => `<p class="small"><b>Conflict · ${esc(x.field)}</b>: ${x.values.map(v => `${v.value}`).join(' vs ')} → using ${x.resolved}. ${esc(x.rule)}</p>`).join('')}
      <h3>Edit scoring (match your app)</h3><div class="grid two">${['four', 'six', 'duck', 'wicket', 'lbwBowled', 'maiden', 'dotsPerPoint', 'dotPoint', 'catch', 'playingXI'].map(k => `<label class="row small" style="justify-content:space-between">${k}<input class="num" data-sc="${k}" value="${c[k]}"></label>`).join('')}</div>
      <div class="row" style="margin-top:6px"><button class="btn" onclick="App.saveScoring()">Apply &amp; re-run</button><button class="btn ghost" onclick="App.resetScoring()">Reset</button></div></div></div></div>`;
  }
  function inputs(R) {
    const cr = (state.credits2 || {})[R.key] || {}, ro = (state.roles2 || {})[R.key] || {};
    const xi = R.xi.xi;
    return `<details class="card" style="margin-top:14px"><summary><b>${esc(R.P.label)} credits &amp; roles</b> <span class="small muted">(auto-filled from a ${esc(R.P.label)} screenshot; the ${R.cons.credits}-credit cap applies once every player has a credit)</span></summary>
      <div class="grid two" style="margin-top:10px">${teams().map(t => `<table><tr><th>${esc(tname(t))}</th><th>Role</th><th class="n">Credits</th></tr>${(xi[t] || []).map(id => { const p = R.players.find(x => x.id === id) || seed.players.find(x => x.id === id); return `<tr><td>${esc(p.name)}</td><td><select data-ro="${id}">${['WK', 'BAT', 'AR', 'BOWL'].map(r => `<option ${(ro[id] || p.role) === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td><td class="n"><input class="num" type="number" step="0.5" data-cr="${id}" value="${cr[id] ?? p.credit ?? ''}" placeholder="—"></td></tr>`; }).join('')}</table>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="App.saveInputs()">Save &amp; re-optimise</button><span class="small muted">Limits: ${Object.entries(R.cons.roles).map(([r, [a, b]]) => `${r} ${a}–${b}`).join(' · ')} · max ${R.cons.maxFromTeam}/team.</span></div></details>`;
  }
  function copyCard(R) {
    const { players, team } = R; const by = r => team.S.filter(j => players[j].role === r);
    const txt = [`FINAL HIGH-UPSIDE GL TEAM — ${R.P.label}`, `${seed.match.title} · ${seed.match.matchNo || ''}`, '',
      ...['WK', 'BAT', 'AR', 'BOWL'].flatMap(r => [r + ':', ...by(r).map(j => players[j].name + (j === team.C ? ' (C)' : j === team.VC ? ' (VC)' : '')), '']),
      `CAPTAIN: ${players[team.C].name}`, `VICE-CAPTAIN: ${players[team.VC].name}`, '',
      `Expected Points: ${f0(team.mean)}`, `P90: ${f0(team.p90)}`, `Ceiling: ${f0(team.ceiling)}`, `GL Score: ${f1(team.obj)}`, `Venue Score: ${f0(team.venue)}`, `Differentiation Score: ${f0(team.diff)}`, `Risk Level: ${team.risk.band}`].join('\n');
    return `<div class="card" style="margin-top:14px"><h3>Copy-ready</h3><div class="textout" id="copytxt">${esc(txt)}</div><button class="btn ghost" style="margin-top:8px" onclick="navigator.clipboard.writeText(document.getElementById('copytxt').innerText)">Copy</button></div>`;
  }
  function playerDetail(id) {
    const R = cache[tab]; const j = R.players.findIndex(p => p.id === id); const p = R.players[j], s = R.summ[j], g = R.gp[j];
    return `<h2>${esc(p.name)} ${pill(p.team)} <span class="tier ${g.cls}">${g.cls}</span></h2><p class="small muted">${esc(R.P.label)} scoring</p>
      <div class="grid three"><div class="card"><h3>Distribution</h3><div class="kv"><span>Floor (P10)</span><span>${f0(s.floor)}</span><span>Median</span><span>${f0(s.median)}</span><span>Expected</span><b>${f1(s.mean)}</b><span>P75</span><span>${f0(s.p75)}</span><span>P90</span><b>${f0(s.p90)}</b><span>P95</span><span>${f0(s.p95)}</span><span>P(100+ pts)</span><span>${pc(s.p100)}</span></div></div>
      <div class="card"><h3>Role / opportunity</h3><div class="kv"><span>Bat position</span><span>${p.pos}</span><span>Exp. balls / runs</span><span>${f0(g.exp.balls)} / ${f0(g.exp.runs)}</span><span>Exp. 4s / 6s</span><span>${f1(g.exp.fours)} / ${f1(g.exp.sixes)}</span><span>P(50+) / P(100+)</span><span>${pc(g.exp.p50)} / ${pc(g.exp.p100)}</span><span>Exp. overs / wkts</span><span>${f1(g.exp.overs)} / ${f1(g.exp.wkts)}</span><span>P(3+ wkts)</span><span>${pc(g.exp.pW3)}</span><span>OPPORTUNITY_SCORE</span><b>${f0(g.opportunity)}</b>${p.credit != null ? `<span>Credits</span><span>${p.credit}</span>` : ''}${p.ownership != null ? `<span>Selected by</span><span>${p.ownership}%</span>` : ''}</div></div>
      <div class="card"><h3>GL scores</h3><div class="kv"><span>VENUE_PLAYER_SCORE</span><span>${f0(g.venue)}${g.venueSample ? ` (n=${g.venueSample})` : ' (no record)'}</span><span>Role security</span><span>${f0(g.role)}</span><span>DIFFERENTIAL</span><span>${f0(g.differential)}</span><span>PLAYER_VARIANCE</span><span>${f0(g.variance)}</span><span>GL_VALUE</span><b>${f1(g.glValue * 100)}</b><span>Toss-adjusted Δ</span><span>${f1(g.toss)}</span></div></div></div>
      <div class="card" style="margin-top:12px"><h3>Scripts</h3>${Object.entries(E.SCRIPTS).map(([k, n]) => `<div class="row small" style="justify-content:space-between"><span>${esc(n)}</span><span class="mono">${f0(s.byScript[k])} pts (×${f1(g.scriptRatio[k])})</span></div>`).join('')}
      <h3 style="margin-top:10px">Evidence & derivation</h3><ul class="small">${p.evidence.map(e => `<li>${esc(e.label)} — ${link(e.source)}</li>`).join('')}${p.batTrail.concat(p.bowlTrail || []).map(t => `<li class="muted">${esc(t)}</li>`).join('')}${p.posNote ? `<li class="muted">${esc(p.posNote)}</li>` : ''}</ul><p class="small"><b>Risk:</b> ${esc(riskList(R, j).join('; ') || 'standard')}</p></div>`;
  }

  const collectInput = () => { const o = { ...extracted }; document.querySelectorAll('[data-in]').forEach(el => { o[el.dataset.in] = el.value || null; }); return o; };

  return {
    async init() {
      const h = location.hash.slice(1); if (TABS.some(([k]) => k === h)) tab = h;
      await loadAll();
      const j = await api('/api/job').catch(() => null);
      render();
      if (j?.state === 'running') pollJob();
      setInterval(async () => { weather = await api('/api/weather').catch(() => weather); for (const k in cache) delete cache[k]; if (tab !== 'setup') render(); }, 15 * 60 * 1000);
    },
    go(k) { tab = k; history.replaceState(null, '', '#' + k); render(); window.scrollTo(0, 0); },
    player(id) { $('#modalBody').innerHTML = playerDetail(id); $('#modal').classList.remove('hidden'); },
    closeModal() { $('#modal').classList.add('hidden'); },
    dropShot(i) { shots.splice(i, 1); render(); },
    manual() { const m = seed.match.matchInput || {}; extracted = { platform: 'unknown', teamA: '', teamB: '', teamAShort: '', teamBShort: '', format: 'T20', matchLabel: '', series: '', date: '', startTime: '', venue: '', city: '', players: [], ...(status.isDefault ? {} : m) }; render(); },
    async extract() {
      $('#exStatus').textContent = 'Reading screenshot with Claude…';
      const r = await api('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: shots }) }).catch(e => ({ ok: false, message: e.message }));
      if (!r.ok) { $('#exStatus').textContent = r.message || 'Extraction failed'; return; }
      extracted = r.data; render();
    },
    async analyse() {
      const input = collectInput();
      if (!input.teamA || !input.teamB) { alert('Enter both team names.'); return; }
      const r = await api('/api/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
      if (!r.ok) { alert(r.message || 'A research job is already running.'); return; }
      pollJob();
    },
    async refresh() {
      if (!status.claude) { alert('Refresh needs Claude. Start the server with ANTHROPIC_API_KEY=… npm start'); return; }
      const r = await api('/api/refresh', { method: 'POST' });
      if (!r.ok) { alert(r.message || 'A refresh is already running.'); return; }
      $('#refreshBtn').disabled = true;
      $('#view').insertAdjacentHTML('afterbegin', '<div class="card" id="refreshBox" style="margin-bottom:14px"></div>');
      pollJob(() => {});
    },
    async resetDefault() { await api('/api/reset-default', { method: 'POST' }); extracted = null; await loadAll(); render(); },
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
