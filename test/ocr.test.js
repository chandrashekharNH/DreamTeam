const test = require('node:test');
const assert = require('node:assert');
const M = require('../public/ocr');

test('parses real tesseract output of a fantasy screenshot (with OCR slips)', () => {
  const ocr = 'Dream11 Mega Contest\n\nAlpha Kings vs Beta Rangers\n\n3rd T201 12 Oct 2026 7:30 PM IST\nRiverside Cricket Ground, Springfield\nBATTERS\n\nJohn Carter AK Selby 71.5% 9.5\nSam Wells BR Selby 40% 8\n';
  const d = M.parse(ocr);
  assert.strictEqual(d.platform, 'dream11');
  assert.deepStrictEqual([d.teamA, d.teamB, d.teamAShort, d.teamBShort], ['Alpha Kings', 'Beta Rangers', 'AK', 'BR']);
  assert.strictEqual(d.format, 'T20');
  assert.strictEqual(d.matchLabel, '3rd T201');
  assert.strictEqual(d.venue, 'Riverside Cricket Ground, Springfield');
  assert.deepStrictEqual(d.players.map(p => [p.name, p.team, p.role, p.credits, p.selectedByPercent]), [['John Carter', 'AK', 'BAT', 9.5, 71.5], ['Sam Wells', 'BR', 'BAT', 8, 40]]);
});

test('match page without player list', () => {
  const d = M.parse('West Indies tour of India 2026\nIND vs WI\n1st ODI · 27 Sep 2026 · 2:00 PM\nGreenfield International Stadium, Thiruvananthapuram');
  assert.deepStrictEqual([d.teamAShort, d.teamBShort, d.format, d.matchLabel, d.date, d.city], ['IND', 'WI', 'ODI', '1st ODI', '27 Sep 2026', 'Thiruvananthapuram']);
  assert.strictEqual(d.players.length, 0);
});
