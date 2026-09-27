// Claude-powered data collection: screenshot extraction + live web research.
// Every fact must come from the screenshot or a cited web source; unknowns stay null.
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant profile
  return client;
}
function configured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

// ---------- JSON-schema helpers (structured outputs: every object closed, every key required) ----------
const nul = s => ({ anyOf: [s, { type: 'null' }] });
const str = { type: 'string' }, num = { type: 'number' }, int = { type: 'integer' }, bool = { type: 'boolean' };
const obj = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const arr = items => ({ type: 'array', items });
const ROLE = { type: 'string', enum: ['WK', 'BAT', 'AR', 'BOWL'] };

const EXTRACT_SCHEMA = obj({
  platform: { type: 'string', enum: ['dream11', 'my11circle', 'other', 'unknown'] },
  teamA: nul(str), teamB: nul(str), teamAShort: nul(str), teamBShort: nul(str),
  format: { type: 'string', enum: ['ODI', 'T20', 'T10', 'Test', 'unknown'] },
  matchLabel: nul(str), series: nul(str), date: nul(str), startTime: nul(str), venue: nul(str), city: nul(str),
  tossText: nul(str), lineupsAnnounced: nul(bool),
  players: arr(obj({ name: str, team: nul(str), role: nul(ROLE), credits: nul(num), selectedByPercent: nul(num), announced: nul(bool) })),
  notes: nul(str),
});

const RESEARCH_SCHEMA = obj({
  match: obj({ teamA: str, teamB: str, teamAShort: str, teamBShort: str, format: { type: 'string', enum: ['ODI', 'T20', 'T10', 'Test', 'unknown'] }, matchLabel: nul(str), series: nul(str), date: nul(str), startTimeLocal: nul(str), venue: nul(str), city: nul(str), lat: nul(num), lon: nul(num), dayNight: nul(bool), status: nul(str) }),
  toss: obj({ status: { type: 'string', enum: ['done', 'pending', 'unknown'] }, winnerShort: nul(str), decision: nul({ type: 'string', enum: ['bat', 'field'] }), reportedAt: nul(str), sources: arr(str) }),
  xi: obj({ status: { type: 'string', enum: ['announced', 'probable', 'unknown'] }, teamA: arr(str), teamB: arr(str), sources: arr(str), conflicts: arr(str) }),
  players: arr(obj({
    name: str, teamShort: str, role: ROLE, battingPosition: nul(int), bowlingType: { type: 'string', enum: ['pace', 'spin', 'none'] }, bowlingStyle: nul(str),
    expectedOvers: nul(num), bowlsPowerplay: nul(bool), bowlsDeath: nul(bool), isKeeper: bool, isCaptain: bool, inXI: nul(bool),
    recentForm: obj({ matches: nul(int), innings: nul(int), notOuts: nul(int), runs: nul(num), balls: nul(num), fours: nul(num), sixes: nul(num), wickets: nul(num), overs: nul(num), runsConceded: nul(num), summary: nul(str), source: nul(str) }),
    venueRecord: obj({ matches: nul(int), runs: nul(num), wickets: nul(num), summary: nul(str), source: nul(str) }),
    notes: nul(str),
  })),
  venue: obj({
    name: nul(str),
    matchesSameFormat: arr(obj({ date: str, teams: str, battingFirst: nul(str), firstInnings: nul(str), firstInningsRuns: nul(int), firstInningsWkts: nul(int), secondInnings: nul(str), secondInningsRuns: nul(int), secondInningsWkts: nul(int), result: nul(str), winnerBattedFirst: nul(bool), source: nul(str) })),
    avgFirstInnings: nul(num), parScore: nul(str), pitchReport: nul(str),
    pitchType: { type: 'string', enum: ['BATTER_FRIENDLY', 'BALANCED', 'PACE_ASSIST', 'SPIN_ASSIST', 'SLOW', 'TWO_PACED', 'UNKNOWN'] },
    paceAssist: nul(bool), spinAssist: nul(bool), dewExpected: nul(bool), boundarySize: nul(str), sources: arr(str),
  }),
  weather: obj({ summary: nul(str), rainProbability: nul(num), source: nul(str) }),
  teamForm: obj({ teamA: nul(str), teamB: nul(str), source: nul(str) }),
  sources: arr(obj({ title: str, url: str, tier: int, publishedOrUpdated: nul(str) })),
  conflicts: arr(str),
  dataGaps: arr(str),
});

async function structured(system, content, schema, maxTokens = 16000) {
  const stream = getClient().beta.messages.stream({
    model: MODEL, max_tokens: maxTokens,
    betas: [FALLBACK_BETA], fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined the request (refusal).');
  if (msg.stop_reason === 'max_tokens') throw new Error('Structured output truncated (max_tokens).');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

// ---------- 1. Screenshot → match details ----------
async function extractMatch(images) {
  const content = [
    ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
    { type: 'text', text: 'Extract the cricket match details from these screenshot(s). They may come from a fantasy app (Dream11, My11Circle) or a cricket site. Copy only what is visible: teams, format, match label, series, date, start time, venue, toss text, and — if a player list is shown — each player\'s name, team, role (WK/BAT/AR/BOWL), credits, "selected by" percentage and announced/lineup status. Use null for anything not visible. Do not guess.' },
  ];
  return structured('You read screenshots precisely and never invent values that are not visible.', content, EXTRACT_SCHEMA, 16000);
}

// ---------- 2. Live research with web search / fetch ----------
function researchPrompt(input, nowIso) {
  return `Current time: ${nowIso}.
Research this cricket match for a fantasy-team model and report ONLY facts you can cite from sources you actually opened.

Match (from the user's screenshot, may be incomplete): ${JSON.stringify(input)}

Collect, preferring Tier 1 (official boards, ICC, the fantasy platform), then Tier 2 (ESPNcricinfo, Cricbuzz scorecards), then Tier 3 (established news), never unverified social posts:
1. Match: both teams (full + short codes), format, match label, series, date, local start time, venue, city, venue latitude/longitude, day/night.
2. Toss: has it happened? winner, decision, time reported.
3. Playing XIs: announced (official team sheets / scorecard) or only probable. List both XIs exactly. Note any source conflicts.
4. For every player in both XIs (or probable XIs): role (WK/BAT/AR/BOWL), expected batting position, bowling type (pace/spin/none), bowling style, expected overs and whether they bowl in the powerplay / death, keeper, captain, and recent form in THIS format over roughly the last 5–10 matches (matches, innings, not-outs, runs, balls, 4s, 6s, wickets, overs, runs conceded) with the source URL, plus any record at this venue.
5. Venue: recent matches of the SAME format at this venue (date, teams, who batted first, both innings totals and wickets, result), average first-innings score, par score, the latest pitch report, pitch type, pace/spin assistance, dew, boundary size.
6. Weather for the match window (rain probability).
7. Each team's recent form in this format.

Rules: never fabricate statistics, lineups, toss or pitch reports. If something cannot be verified, say so explicitly. Record conflicts between sources. Put every URL you rely on in your notes. Finish with a concise, well-organised research report.`;
}

async function research(input, onLog = () => {}) {
  const c = getClient();
  const nowIso = new Date().toISOString();
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 15 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10 },
  ];
  const messages = [{ role: 'user', content: researchPrompt(input, nowIso) }];
  let msg, continuations = 0;
  const collected = [];
  while (true) {
    onLog(continuations ? `Continuing research (pass ${continuations + 1})…` : 'Searching the web for toss, Playing XI, pitch, venue and form…');
    const stream = c.beta.messages.stream({
      model: MODEL, max_tokens: 64000, betas: [FALLBACK_BETA], fallbacks: 'default',
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
      tools, messages,
    });
    msg = await stream.finalMessage();
    for (const b of msg.content) {
      if (b.type === 'server_tool_use') onLog(`${b.name === 'web_search' ? 'Search' : 'Open'}: ${b.input.query || b.input.url || ''}`);
      if (b.type === 'text') collected.push(b.text);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) collected.push(`[source] ${r.title || ''} ${r.url} ${r.page_age || ''}`);
    }
    if (msg.stop_reason === 'refusal') throw new Error('Research declined (refusal).');
    if (msg.stop_reason === 'pause_turn' && continuations < 6) { messages.push({ role: 'assistant', content: msg.content }); continuations++; continue; }
    break;
  }
  onLog('Structuring research into the model schema…');
  const report = collected.join('\n');
  const data = await structured(
    'Convert a cricket research report into strict JSON. Use only facts present in the report; use null or empty arrays where the report has no verified value. Keep source URLs exactly as given.',
    [{ type: 'text', text: `Match input: ${JSON.stringify(input)}\n\nResearch report and sources:\n${report}` }],
    RESEARCH_SCHEMA, 32000);
  data._report = report;
  data._researchedAt = nowIso;
  data._model = MODEL;
  return data;
}

module.exports = { configured, extractMatch, research, MODEL };
