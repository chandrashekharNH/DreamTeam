// Converts Claude research JSON (+ screenshot extraction) into the engine's seed format.
const fs = require('fs');
const path = require('path');

const SCORING_DIR = path.join(__dirname, '..', 'data', 'scoring');
const TIER_REL = { 1: 0.95, 2: 0.9, 3: 0.7, 4: 0.3 };
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function loadScoring(platform, format) {
  const f = format === 'T20' || format === 'T10' ? 't20' : 'odi';
  return JSON.parse(fs.readFileSync(path.join(SCORING_DIR, `${platform}_${f}.json`), 'utf8'));
}
function loadConstraints() { return JSON.parse(fs.readFileSync(path.join(SCORING_DIR, 'constraints.json'), 'utf8')); }

function nameMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const la = String(a).trim().split(/\s+/).pop().toLowerCase(), lb = String(b).trim().split(/\s+/).pop().toLowerCase();
  return la === lb && (x.includes(y.slice(0, 3)) || y.includes(x.slice(0, 3)));
}

function build(research, input) {
  const R = research, m = R.match;
  const format = ['ODI', 'T20', 'T10'].includes(m.format) ? m.format : (input?.format === 'T20' ? 'T20' : 'ODI');
  const maxOv = format === 'ODI' ? 10 : format === 'T10' ? 2 : 4;
  const A = (m.teamAShort || m.teamA.slice(0, 3)).toUpperCase(), B = (m.teamBShort || m.teamB.slice(0, 3)).toUpperCase();
  const teamCode = t => { const n = norm(t); if (!n) return null; if (n === norm(A) || n === norm(m.teamA) || norm(m.teamA).startsWith(n)) return A; if (n === norm(B) || n === norm(m.teamB) || norm(m.teamB).startsWith(n)) return B; return null; };

  // sources
  const sources = {};
  const urlId = new Map();
  const addSrc = (url, title, tier) => {
    if (!url) return null;
    if (urlId.has(url)) return urlId.get(url);
    const id = 'src' + (urlId.size + 1);
    let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
    const t = tier || (/(bcci|icc-cricket|windiescricket|cricket\.com\.au|ecb|pcb|dream11|my11circle)/.test(host) ? 1 : /(espncricinfo|cricinfo|cricbuzz|espn\.com)/.test(host) ? 2 : 3);
    sources[id] = { name: title || host || url, tier: t, reliability: TIER_REL[t] || 0.5, url, fetchedAt: R._researchedAt };
    urlId.set(url, id); return id;
  };
  for (const s of R.sources || []) addSrc(s.url, s.title, s.tier);
  sources.screenshot = { name: 'User screenshot (fantasy app / match page)', tier: 1, reliability: 0.9, url: null, fetchedAt: input?._uploadedAt || null };
  sources.model_prior = { name: 'Model prior (generic assumption — NOT a player statistic)', tier: 0, reliability: 0.4, url: null, fetchedAt: null };
  sources.open_meteo = { name: 'Open-Meteo hourly forecast (live API)', tier: 2, reliability: 0.8, url: 'https://open-meteo.com/', fetchedAt: 'live' };
  sources.user_points_doc = { name: 'User-provided points table (docs/points-systems.md)', tier: 1, reliability: 0.85, url: null, fetchedAt: null };
  sources.my11_points = { name: 'My11Circle official points system page', tier: 1, reliability: 0.95, url: 'https://www.my11circle.com/points-system.html', fetchedAt: '2026-09-27T13:44:00+05:30' };
  sources.d11_reports = { name: "Dream11 'new points system' reports", tier: 3, reliability: 0.5, url: 'https://ddream11.com/blog/dream11-points-system-guide-2026', fetchedAt: null };
  sources.d11_legacy = { name: 'CricJosh Dream11 ODI comparison table', tier: 3, reliability: 0.5, url: 'https://cricjosh.in/blog/dream11-points-system-explained-2026', fetchedAt: null };
  sources.d11_official = { name: 'Dream11 official points page', tier: 1, reliability: 0.95, url: 'https://www.dream11.com/fantasy-cricket/point-system', fetchedAt: null };
  const src = u => addSrc(u) || null;

  // screenshot players (credits / roles / ownership)
  const shot = (input?.players || []).filter(p => p.name);
  const shotFor = name => shot.find(p => nameMatch(p.name, name));

  // players
  const used = new Set();
  const players = [];
  const posCounter = { [A]: 0, [B]: 0 };
  const roleOrder = { BAT: 0, WK: 0, AR: 1, BOWL: 2 };
  const rp = (R.players || []).slice().sort((a, b) => (a.battingPosition ?? 20 + roleOrder[a.role] * 3) - (b.battingPosition ?? 20 + roleOrder[b.role] * 3));
  for (const p of rp) {
    const team = teamCode(p.teamShort) || teamCode(p.teamShort?.slice(0, 3));
    if (!team) continue;
    let id = slug(p.name) || 'p' + players.length; while (used.has(id)) id += '-2'; used.add(id);
    const s = shotFor(p.name);
    const pos = p.battingPosition || null;
    const quota = p.bowlingType === 'none' ? 0 : Math.min(maxOv, p.expectedOvers ?? (p.role === 'BOWL' ? maxOv : p.role === 'AR' ? Math.round(maxOv * 0.6) : 0));
    players.push({
      id, name: p.name, team, role: s?.role || p.role, pos, wk: !!p.isKeeper, captain: !!p.isCaptain,
      bowl: quota > 0 ? { type: p.bowlingType === 'spin' ? 'spin' : 'pace', style: p.bowlingStyle || (p.bowlingType === 'spin' ? 'Spin' : 'Pace'), quota,
        pp: p.bowlsPowerplay ? 1 : p.bowlingType === 'spin' ? 0.2 : 0.6, mid: 1, death: p.bowlsDeath ? 1 : 0.3 } : null,
      credit: s?.credits ?? null, ownership: s?.selectedByPercent ?? null, _raw: p,
    });
  }
  // fill missing batting positions: keep listed order within each team
  for (const t of [A, B]) {
    const tp = players.filter(p => p.team === t);
    const taken = new Set(tp.map(p => p.pos).filter(Boolean));
    let next = 1;
    for (const p of tp.filter(p => !p.pos).sort((a, b) => roleOrder[a.role] - roleOrder[b.role])) { while (taken.has(next)) next++; p.pos = Math.min(11, next); taken.add(next); p.posNote = 'Batting position not reported — inferred from role order (MODEL PRIOR)'; }
    posCounter[t] = tp.length;
  }

  // XI
  const findId = (name, team) => (players.find(p => p.team === team && nameMatch(p.name, name)) || {}).id;
  const xiA = (R.xi.teamA || []).map(n => findId(n, A)).filter(Boolean), xiB = (R.xi.teamB || []).map(n => findId(n, B)).filter(Boolean);
  const xiSrc = (R.xi.sources || []).map(src).filter(Boolean);
  const xiReports = xiA.length && xiB.length ? [{ source: xiSrc[0] || 'model_prior', timestamp: R._researchedAt, [A]: xiA, [B]: xiB }] : [];
  // players flagged inXI:false by research are dropped from XI reports implicitly
  const officialXI = R.xi.status === 'announced' && xiA.length === 11 && xiB.length === 11 ? { [A]: xiA, [B]: xiB, sources: xiSrc.length ? xiSrc : ['model_prior'], timestamp: R._researchedAt, note: `Announced XIs per ${xiSrc.map(s => sources[s]?.name).join(' + ') || 'research'}` } : null;
  // If no XI reports, fall back to first 11 per team from the player list (probable)
  if (!xiReports.length) {
    const guess = t => players.filter(p => p.team === t && p._raw.inXI !== false).slice(0, 11).map(p => p.id);
    xiReports.push({ source: 'model_prior', timestamp: R._researchedAt, [A]: guess(A), [B]: guess(B) });
  }

  // evidence + form (only with a source URL)
  const evidence = [], form = {};
  for (const p of players) {
    const f = p._raw.recentForm, v = p._raw.venueRecord;
    if (f && f.source && ((f.balls || 0) > 0 || (f.overs || 0) > 0)) {
      form[p.id] = { inns: f.innings || f.matches || 0, no: f.notOuts || 0, runs: f.runs || 0, balls: f.balls || 0, fours: f.fours || 0, sixes: f.sixes || 0, overs: f.overs || 0, wkts: f.wickets || 0, conceded: f.runsConceded || 0, source: sources[src(f.source)]?.name || f.source };
      evidence.push({ player: p.id, kind: 'form', metric: 'formSummary', value: null, sample: f.matches || f.innings || null, label: f.summary || `Recent ${format}: ${f.runs ?? '—'} runs / ${f.balls ?? '—'} balls, ${f.wickets ?? '—'} wkts`, source: src(f.source) });
    }
    if (v && v.source && (v.matches || v.runs || v.wickets)) {
      evidence.push({ player: p.id, kind: 'venue', metric: v.wickets ? 'venueWkts' : 'venueRuns', value: v.wickets || v.runs || 0, sample: v.matches || 1, label: v.summary || `At venue: ${v.runs ?? 0} runs, ${v.wickets ?? 0} wkts in ${v.matches ?? '?'} matches`, source: src(v.source) });
    }
    if (p._raw.notes) evidence.push({ player: p.id, kind: 'note', metric: 'note', value: null, label: p._raw.notes, source: null });
    delete p._raw;
  }

  // toss
  const tw = R.toss.status === 'done' ? teamCode(R.toss.winnerShort) : null;
  const toss = tw ? { winner: tw, decision: R.toss.decision || 'field', batFirst: R.toss.decision === 'bat' ? tw : (tw === A ? B : A), reports: (R.toss.sources || []).map(u => ({ source: src(u), text: `${tw} won the toss and chose to ${R.toss.decision}`, timestamp: R.toss.reportedAt || R._researchedAt })) } : { winner: null, decision: null, batFirst: null, reports: [] };

  // venue
  const vm = (R.venue.matchesSameFormat || []).map(x => ({ date: x.date, teams: x.teams, batFirst: x.battingFirst, inn1: x.firstInnings, inn1Runs: x.firstInningsRuns, inn1Wkts: x.firstInningsWkts, inn2: x.secondInnings, inn2Runs: x.secondInningsRuns, inn2Wkts: x.secondInningsWkts, result: x.result, winnerBattedFirst: x.winnerBattedFirst, notes: '', source: src(x.source) || 'model_prior', dayNight: '' })).filter(x => x.inn1Runs != null);
  const vSrc = (R.venue.sources || []).map(src).filter(Boolean);
  const start = parseStart(m.date, m.startTimeLocal);

  const cons = loadConstraints();
  const plat = (key, label) => ({ label, scoring: loadScoring(key, format), constraints: cons[key] });

  return {
    meta: { seedCollectedAt: R._researchedAt, generatedBy: `Claude research (${R._model})`, xiUpdatedAt: R._researchedAt },
    teams: [A, B],
    teamNames: { [A]: m.teamA, [B]: m.teamB },
    match: { id: slug(`${m.teamA}-${m.teamB}-${m.matchLabel || ''}-${m.date || ''}`), title: `${m.teamA} vs ${m.teamB}`, matchNo: m.matchLabel || format, series: m.series, date: (m.date || '').slice(0, 10), dateLabel: m.date || '', type: `${format}${m.dayNight ? ' (Day/Night)' : ''}`, format, venue: m.venue || R.venue.name || '', city: (m.city || '').toUpperCase(), start, lat: m.lat, lon: m.lon, status: m.status },
    sources, toss, xiReports, xiNotes: (R.xi.conflicts || []).map(t => ({ source: xiSrc[0] || 'model_prior', text: t, players: [], type: 'conflict' })), officialXI,
    players, evidence, form,
    teamForm: { [A]: { last5: R.teamForm.teamA || '—', source: src(R.teamForm.source) }, [B]: { last5: R.teamForm.teamB || '—', source: src(R.teamForm.source) } },
    venue: {
      name: R.venue.name || m.venue, odiMatches: vm, formatMatches: vm,
      avgFirstInnings: { value: R.venue.avgFirstInnings ?? (vm.length ? Math.round(vm.reduce((a, x) => a + x.inn1Runs, 0) / vm.length) : null), source: vSrc[0] || null },
      parScore: { value: R.venue.parScore, source: vSrc[0] || null }, seamerAvg: null,
      pitchText: R.venue.pitchReport ? [{ source: vSrc[0] || 'model_prior', text: R.venue.pitchReport }] : [],
      pitchType: R.venue.pitchType, paceAssist: R.venue.paceAssist, spinAssist: R.venue.spinAssist, dewExpected: R.venue.dewExpected,
      boundaries: { value: R.venue.boundarySize, label: R.venue.boundarySize || 'DATA NOT AVAILABLE' },
    },
    weatherNews: R.weather.summary ? [{ source: src(R.weather.source) || 'model_prior', text: R.weather.summary + (R.weather.rainProbability != null ? ` (rain ${R.weather.rainProbability}%)` : '') }] : [],
    platforms: { dream11: plat('dream11', 'Dream11'), my11: plat('my11', 'My11Circle') },
    screenshot: input ? { platform: input.platform, players: shot, uploadedAt: input._uploadedAt || null } : null,
    conflicts: R.conflicts || [], dataGaps: R.dataGaps || [],
    researchReport: R._report,
  };
}

function parseStart(date, time) {
  if (!date) return null;
  const d = new Date(`${date} ${time || ''}`.trim());
  return isNaN(d) ? null : d.toISOString();
}

module.exports = { build, loadScoring, loadConstraints };
