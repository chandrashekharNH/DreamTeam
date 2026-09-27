// Offline end-to-end test: research JSON → adapter → engine → GL team, for a fictional T20 fixture.
const test = require('node:test');
const assert = require('node:assert');
const adapter = require('../lib/adapter');
const E = require('../public/engine');

function fixture() {
  const mk = (team, i) => {
    const role = i === 0 ? 'WK' : i < 5 ? 'BAT' : i < 8 ? 'AR' : 'BOWL';
    return { name: `${team} Player ${i + 1}`, teamShort: team, role, battingPosition: i + 1, bowlingType: i >= 5 ? (i % 2 ? 'spin' : 'pace') : 'none', bowlingStyle: null,
      expectedOvers: i >= 8 ? 4 : i >= 5 ? 2 : null, bowlsPowerplay: i === 8 || i === 9, bowlsDeath: i === 10, isKeeper: i === 0, isCaptain: i === 1, inXI: true,
      recentForm: { matches: null, innings: null, notOuts: null, runs: null, balls: null, fours: null, sixes: null, wickets: null, overs: null, runsConceded: null, summary: null, source: null },
      venueRecord: { matches: null, runs: null, wickets: null, summary: null, source: null }, notes: null };
  };
  const players = [...Array(11)].map((_, i) => mk('AAA', i)).concat([...Array(11)].map((_, i) => mk('BBB', i)));
  return {
    match: { teamA: 'Alpha', teamB: 'Beta', teamAShort: 'AAA', teamBShort: 'BBB', format: 'T20', matchLabel: 'Test match', series: null, date: '2026-10-01', startTimeLocal: '19:30', venue: 'Test Ground', city: 'Nowhere', lat: null, lon: null, dayNight: true, status: 'upcoming' },
    toss: { status: 'pending', winnerShort: null, decision: null, reportedAt: null, sources: [] },
    xi: { status: 'probable', teamA: players.slice(0, 11).map(p => p.name), teamB: players.slice(11).map(p => p.name), sources: ['https://example.org/xi'], conflicts: [] },
    players,
    venue: { name: 'Test Ground', matchesSameFormat: [], avgFirstInnings: null, parScore: null, pitchReport: null, pitchType: 'UNKNOWN', paceAssist: null, spinAssist: null, dewExpected: null, boundarySize: null, sources: [] },
    weather: { summary: null, rainProbability: null, source: null }, teamForm: { teamA: null, teamB: null, source: null },
    sources: [{ title: 'Example', url: 'https://example.org/xi', tier: 3, publishedOrUpdated: null }], conflicts: [], dataGaps: ['Test fixture'],
    _researchedAt: '2026-10-01T10:00:00Z', _model: 'test', _report: '',
  };
}

test('adapter + engine build a valid T20 GL team for both platforms', () => {
  const input = { platform: 'dream11', players: [{ name: 'AAA Player 1', team: 'AAA', role: 'WK', credits: 9, selectedByPercent: 80, announced: null }] };
  const seed = adapter.build(fixture(), input);
  assert.deepStrictEqual(seed.teams, ['AAA', 'BBB']);
  assert.strictEqual(seed.match.format, 'T20');
  assert.strictEqual(seed.platforms.my11.scoring.wicket, 30);
  assert.strictEqual(seed.platforms.dream11.scoring.wicket, 25);
  assert.strictEqual(seed.officialXI, null);
  for (const key of ['dream11', 'my11']) {
    const cfg = seed.platforms[key].scoring, cons = seed.platforms[key].constraints;
    const xi = E.xiStatus(seed, {});
    const P = E.buildPlayers(seed, {}, xi.xi);
    assert.strictEqual(P.length, 22);
    assert.ok(P.every(p => !p.bowl || p.bowl.quota <= 4), 'T20 quota cap');
    const cond = E.conditions(seed, null, { tossKnown: false });
    const sim = E.simulate(P, cond, cfg, 600);
    const inn1 = E.mean(sim.sims.map(s => s.inn1));
    assert.ok(inn1 > 130 && inn1 < 220, `T20 first innings ${inn1}`);
    const summ = E.summarize(sim);
    const gp = E.glPlayers(P, summ, seed, {}, E.venueIndex(seed));
    const team = E.optimiseGL(P, sim, summ, gp, cfg, cons, E.GL_WEIGHTS, 0);
    assert.ok(team.ok);
    assert.strictEqual(new Set(team.S).size, 11);
    const combos = E.cvcCombos(P, sim, summ, gp, team.S, cfg, seed, 5);
    assert.ok(combos.length >= 3 && combos[0].C !== combos[0].VC);
  }
});

test('Dream11 T20 milestone rule: bonuses stack below 100, century alone at 100+', () => {
  const cfg = require('../data/scoring/dream11_t20.json');
  const line = r => ({ ...E.emptyLine(), runs: r, balls: r, out: 1 });
  assert.strictEqual(E.fantasyPoints(line(55), cfg, 'BAT').bonus, 12);   // 30 (+4) + 50 (+8)
  assert.strictEqual(E.fantasyPoints(line(101), cfg, 'BAT').bonus, 16);  // century only
  const my = require('../data/scoring/my11_t20.json');
  assert.strictEqual(E.fantasyPoints(line(101), my, 'BAT').bonus, 4 + 8 + 12 + 16);
});
