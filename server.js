// Cricket GL Intelligence — zero-dependency Node server.
// Serves the SPA, persists runtime state, caches static data and proxies live sources.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5177;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const SEED = path.join(ROOT, 'data', 'seed.json');
const STATE = path.join(ROOT, 'data', 'state.json');
const CRICAPI_KEY = process.env.CRICAPI_KEY || '';   // optional: https://cricketdata.org (free tier)
const CRICAPI_MATCH_ID = process.env.CRICAPI_MATCH_ID || '';

const cache = new Map(); // key -> {at, ttl, data}
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit.data, cache: 'hit', cachedAt: new Date(hit.at).toISOString() };
  try {
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return { ...data, cache: 'miss', cachedAt: new Date().toISOString() };
  } catch (e) {
    if (hit) return { ...hit.data, cache: 'stale', error: String(e.message || e), cachedAt: new Date(hit.at).toISOString() };
    throw e;
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function weather() {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const { lat, lon } = seed.match;
  // Open-Meteo: free, keyless, permitted for non-commercial use. Cached 10 minutes to respect limits.
  return cached('weather', 10 * 60 * 1000, async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,cloud_cover,wind_speed_10m,dew_point_2m` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover,precipitation` +
      `&timezone=Asia%2FKolkata&forecast_days=2`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
    const j = await r.json();
    return { ok: true, source: 'open_meteo', url: 'https://open-meteo.com/', data: j, fetchedAt: new Date().toISOString() };
  });
}

async function live() {
  if (!CRICAPI_KEY || !CRICAPI_MATCH_ID) {
    return { ok: false, status: 'NOT_CONFIGURED', message: 'Live score provider not configured. Set CRICAPI_KEY and CRICAPI_MATCH_ID (cricketdata.org) or paste commentary in the Commentary tab.' };
  }
  // Poll no faster than every 60s to stay inside the free-tier rate limit.
  return cached('live', 60 * 1000, async () => {
    const url = `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICAPI_KEY}&id=${CRICAPI_MATCH_ID}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('CricAPI HTTP ' + r.status);
    const j = await r.json();
    if (j.status !== 'success') throw new Error('CricAPI: ' + (j.reason || j.status));
    return { ok: true, source: 'cricapi', data: j.data, fetchedAt: new Date().toISOString() };
  });
}

function body(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/seed') return send(res, 200, fs.readFileSync(SEED, 'utf8'));
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, readState());
    if (url.pathname === '/api/state' && req.method === 'POST') {
      const patch = await body(req);
      const s = { ...readState(), ...patch, savedAt: new Date().toISOString() };
      writeState(s); return send(res, 200, { ok: true, savedAt: s.savedAt });
    }
    if (url.pathname === '/api/weather') {
      try { return send(res, 200, await weather()); }
      catch (e) { return send(res, 200, { ok: false, status: 'UNAVAILABLE', message: 'Source A (Open-Meteo) unavailable: ' + e.message + '. Data temporarily unavailable.' }); }
    }
    if (url.pathname === '/api/live') {
      try { return send(res, 200, await live()); }
      catch (e) { return send(res, 200, { ok: false, status: 'UNAVAILABLE', message: 'Live provider unavailable: ' + e.message }); }
    }
    let p = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(PUB, p);
    if (!file.startsWith(PUB) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`Cricket GL Intelligence running at http://localhost:${PORT}`));
