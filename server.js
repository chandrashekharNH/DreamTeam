// DreamTeam GL engine — zero-framework Node server.
// Serves the SPA, reads screenshots and researches matches with Claude, caches weather, versions every data refresh.
const http = require('http');
const fsBoot = require('fs'), pathBoot = require('path');
// load .env (local, gitignored) before anything reads process.env
try { for (const l of fsBoot.readFileSync(pathBoot.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } } catch { }
const fs = require('fs');
const path = require('path');
const claude = require('./lib/claude');
const adapter = require('./lib/adapter');

const PORT = process.env.PORT || 5177;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const DEFAULT_SEED = path.join(DATA, 'seed.json');
const CURRENT = path.join(DATA, 'current.json');
const STATE = path.join(DATA, 'state.json');
const MATCHES = path.join(DATA, 'matches');

const readJSON = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };
const currentSeed = () => readJSON(CURRENT) || readJSON(DEFAULT_SEED);

// ---------- cache (static data cached, live data refreshed) ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit.data, cache: 'hit' };
  try { const data = await fn(); cache.set(key, { at: Date.now(), data }); return { ...data, cache: 'miss' }; }
  catch (e) { if (hit) return { ...hit.data, cache: 'stale', error: String(e.message || e) }; throw e; }
}

async function geocode(city) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json(); const g = j.results?.[0];
  return g ? { lat: g.latitude, lon: g.longitude } : null;
}
async function weather() {
  const seed = currentSeed();
  let { lat, lon, city } = seed.match;
  if ((lat == null || lon == null) && city) { const g = await geocode(city.split(',')[0]).catch(() => null); if (g) ({ lat, lon } = g); }
  if (lat == null || lon == null) return { ok: false, status: 'UNAVAILABLE', message: 'Venue location unknown — weather not fetched.' };
  return cached(`weather:${lat},${lon}`, 10 * 60 * 1000, async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,cloud_cover,wind_speed_10m,dew_point_2m` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover,precipitation&timezone=auto&forecast_days=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
    return { ok: true, source: 'open_meteo', data: await r.json(), fetchedAt: new Date().toISOString() };
  });
}

// ---------- research job (one at a time) ----------
let job = { state: 'idle', log: [], startedAt: null, finishedAt: null, error: null, kind: null };
function startJob(kind, input, images) {
  if (job.state === 'running') return false;
  job = { state: 'running', log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, kind, step: 1 };
  const log = t => job.log.push({ t: new Date().toISOString(), msg: t });
  (async () => {
    try {
      if (images) {
        log('Step 1/3 · Reading the uploaded image…');
        input = await claude.extractMatch(images);
        input._uploadedAt = new Date().toISOString();
        writeJSON(path.join(DATA, 'last-extract.json'), input);
        if (!input.teamA || !input.teamB) throw new Error('Could not find both team names in the image. Upload a clearer match screenshot.');
        log(`Found: ${input.teamA} vs ${input.teamB} · ${input.format} · ${input.matchLabel || ''} · ${input.venue || 'venue not shown'}${input.players?.length ? ` · ${input.players.length} players with credits` : ''}`);
      }
      job.step = 2;
      log(kind === 'refresh' ? 'Refreshing latest toss, Playing XI, pitch and venue data…' : 'Step 2/3 · Researching toss, Playing XI, pitch, venue, form and weather…');
      const research = await claude.research(input, log);
      job.step = 3;
      log('Step 3/3 · Applying points systems and GL strategy…');
      const seed = adapter.build(research, input);
      seed.match.matchInput = input;
      const prev = readJSON(CURRENT);
      seed.changes = prev && prev.match?.id === seed.match.id ? diff(prev, seed) : [];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeJSON(path.join(MATCHES, seed.match.id, `${stamp}.json`), seed);
      writeJSON(CURRENT, seed);
      // new match → clear per-match user overrides
      const st = readJSON(STATE, {});
      if (st.matchId !== seed.match.id) writeJSON(STATE, { matchId: seed.match.id });
      log(`Done — ${seed.players.length} players, toss: ${seed.toss.winner ? seed.toss.winner + ' ' + seed.toss.decision : 'pending'}, XI: ${seed.officialXI ? 'announced' : 'probable'}.`);
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = e.status === 401 ? 'Anthropic API key is invalid — check ANTHROPIC_API_KEY.' : e.status === 429 ? 'Rate limited by the Anthropic API — wait a minute and retry.' : String(e.message || e);
      log('Error: ' + job.error);
    } finally { job.finishedAt = new Date().toISOString(); }
  })();
  return true;
}
function diff(a, b) {
  const out = [];
  const t = s => s.toss?.winner ? `${s.toss.winner} won, chose to ${s.toss.decision}` : 'pending';
  if (t(a) !== t(b)) out.push(`Toss: ${t(a)} → ${t(b)}`);
  const xi = s => (s.teams || []).map(k => (s.officialXI?.[k] || s.xiReports?.[0]?.[k] || []).slice().sort().join(',')).join('|');
  if (xi(a) !== xi(b)) {
    const names = s => new Set(Object.values(s.officialXI || s.xiReports?.[0] || {}).filter(Array.isArray).flat());
    const A = names(a), B = names(b);
    const inn = [...B].filter(x => !A.has(x)), out_ = [...A].filter(x => !B.has(x));
    out.push(`Playing XI changed: +${inn.join(', ') || '—'} / −${out_.join(', ') || '—'}`);
  }
  if (!!a.officialXI !== !!b.officialXI) out.push(`XI status: ${a.officialXI ? 'announced' : 'probable'} → ${b.officialXI ? 'announced' : 'probable'}`);
  if ((a.venue?.pitchText?.[0]?.text || '') !== (b.venue?.pitchText?.[0]?.text || '')) out.push('Pitch report updated');
  return out;
}

// ---------- http ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req, limit = 30e6) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > limit) { reject(new Error('Upload too large (max ~20 MB)')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
const NEED_KEY = { ok: false, status: 'NOT_CONFIGURED', message: 'Claude is not configured. Start the server with ANTHROPIC_API_KEY=… npm start to enable screenshot reading and live data refresh.' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/status') return send(res, 200, { claude: claude.configured(), model: claude.MODEL, match: currentSeed().match, isDefault: !fs.existsSync(CURRENT), job: { state: job.state, kind: job.kind } });
    if (url.pathname === '/api/seed') return send(res, 200, currentSeed());
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, readJSON(STATE, {}));
    if (url.pathname === '/api/state' && req.method === 'POST') {
      const patch = await body(req, 1e6); const s = { ...readJSON(STATE, {}), ...patch, savedAt: new Date().toISOString() };
      writeJSON(STATE, s); return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/weather') {
      try { return send(res, 200, await weather()); }
      catch (e) { return send(res, 200, { ok: false, status: 'UNAVAILABLE', message: 'Open-Meteo unavailable: ' + e.message }); }
    }
    if (url.pathname === '/api/extract' && req.method === 'POST') {
      if (!claude.configured()) return send(res, 200, NEED_KEY);
      const { images } = await body(req);
      if (!Array.isArray(images) || !images.length || images.length > 5) return send(res, 400, { ok: false, message: 'Send 1–5 images.' });
      const bad = images.find(i => !/^image\/(png|jpeg|webp|gif)$/.test(i.mediaType));
      if (bad) return send(res, 400, { ok: false, message: 'Images must be PNG, JPEG, WEBP or GIF.' });
      const data = await claude.extractMatch(images);
      data._uploadedAt = new Date().toISOString();
      writeJSON(path.join(DATA, 'last-extract.json'), data);
      return send(res, 200, { ok: true, data });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const { apiKey } = await body(req, 1e4);
      const key = String(apiKey || '').trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return send(res, 400, { ok: false, message: 'That does not look like an Anthropic API key (it should start with sk-ant-).' });
      try { await claude.setKey(key); }
      catch (e) { return send(res, 400, { ok: false, message: e.status === 401 ? 'Anthropic rejected this key (invalid or revoked).' : e.status === 404 ? `Key works but has no access to ${claude.MODEL}.` : 'Could not verify key: ' + e.message }); }
      const envPath = path.join(ROOT, '.env');
      const lines = (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : []).filter(l => l && !l.startsWith('ANTHROPIC_API_KEY='));
      fs.writeFileSync(envPath, lines.concat(`ANTHROPIC_API_KEY=${key}`).join('\n') + '\n', { mode: 0o600 });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/process' && req.method === 'POST') {
      if (!claude.configured()) return send(res, 200, NEED_KEY);
      const { images } = await body(req);
      if (!Array.isArray(images) || !images.length || images.length > 5) return send(res, 400, { ok: false, message: 'Upload 1–5 images.' });
      if (images.some(i => !/^image\/(png|jpeg|webp|gif)$/.test(i.mediaType))) return send(res, 400, { ok: false, message: 'Images must be PNG, JPEG, WEBP or GIF.' });
      return send(res, 200, { ok: startJob('process', null, images), job });
    }
    if (url.pathname === '/api/analyse' && req.method === 'POST') {
      if (!claude.configured()) return send(res, 200, NEED_KEY);
      const { input } = await body(req, 1e6);
      if (!input || !input.teamA || !input.teamB) return send(res, 400, { ok: false, message: 'Team names are required.' });
      return send(res, 200, { ok: startJob('analyse', input), job });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (!claude.configured()) return send(res, 200, NEED_KEY);
      const input = currentSeed().match.matchInput;
      if (!input) return send(res, 400, { ok: false, message: 'No match input stored — upload a screenshot first.' });
      return send(res, 200, { ok: startJob('refresh', input), job });
    }
    if (url.pathname === '/api/job') return send(res, 200, job);
    if (url.pathname === '/api/versions') {
      const id = currentSeed().match.id; const dir = path.join(MATCHES, id || '_');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
      return send(res, 200, files.map(f => { const s = readJSON(path.join(dir, f)); return { file: f, at: s.meta?.seedCollectedAt, toss: s.toss?.winner ? `${s.toss.winner} ${s.toss.decision}` : 'pending', xi: s.officialXI ? 'announced' : 'probable', changes: s.changes || [] }; }));
    }
    if (url.pathname === '/api/reset-default' && req.method === 'POST') { if (fs.existsSync(CURRENT)) fs.unlinkSync(CURRENT); writeJSON(STATE, {}); return send(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/docs/')) {
      const f = path.join(ROOT, path.normalize(url.pathname));
      if (f.startsWith(path.join(ROOT, 'docs')) && fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'text/plain');
    }
    const file = path.join(PUB, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(PUB) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { ok: false, message: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`DreamTeam GL engine at http://localhost:${PORT} · Claude ${claude.configured() ? 'configured (' + claude.MODEL + ')' : 'NOT configured — set ANTHROPIC_API_KEY'}`));
