// Match-detail extraction from OCR text (runs in the browser; also importable in Node for tests).
// Heuristic by design: the user reviews and corrects every field before Process.
const MatchText = (() => {
  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  const ROLE_HEAD = [
    [/^(wk|wicket[- ]?keepers?)\b/i, 'WK'], [/^(bat|batters?|batsmen|batsman)\b/i, 'BAT'],
    [/^(ar|all[- ]?rounders?)\b/i, 'AR'], [/^(bowl|bowlers?)\b/i, 'BOWL'],
  ];
  const clean = s => String(s || '').replace(/[|•·©®_*~“”"]/g, ' ').replace(/\s+/g, ' ').trim();

  function parse(text) {
    const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
    const all = lines.join('\n');
    const out = { platform: 'unknown', teamA: '', teamB: '', teamAShort: '', teamBShort: '', format: 'unknown', matchLabel: '', series: '', date: '', startTime: '', venue: '', city: '', tossText: '', players: [], notes: '' };

    if (/dream\s?11/i.test(all)) out.platform = 'dream11';
    else if (/my\s?11\s?circle/i.test(all)) out.platform = 'my11circle';

    // teams: "India vs West Indies", "IND v WI"
    for (const l of lines) {
      const m = l.match(/([A-Za-z][A-Za-z .&'-]{1,40}?)\s+(?:vs\.?|v\/s|v\.?)\s+([A-Za-z][A-Za-z .&'-]{1,40})/i);
      if (!m) continue;
      const strip = s => s.replace(/\b(\d+(st|nd|rd|th)\b.*|match\b.*|odi\b.*|t20i?\b.*|t10\b.*|test\b.*|live\b.*|upcoming\b.*)$/i, '').trim();
      const a = strip(m[1]), b = strip(m[2]);
      if (a.length < 2 || b.length < 2) continue;
      if (/^[A-Z]{2,5}$/.test(a) && /^[A-Z]{2,5}$/.test(b)) { if (!out.teamAShort) { out.teamAShort = a; out.teamBShort = b; } if (!out.teamA) { out.teamA = a; out.teamB = b; } }
      else if (!out.teamA || /^[A-Z]{2,5}$/.test(out.teamA)) { out.teamA = a; out.teamB = b; }
    }
    if (out.teamA && !out.teamAShort) { out.teamAShort = abbr(out.teamA); out.teamBShort = abbr(out.teamB); }

    const fm = all.match(/\b(ODI|0DI|T20[I1l|]?|T-20|T10|Test)\b/i);
    if (fm) out.format = /^[o0]di$/i.test(fm[1]) ? 'ODI' : /^t-?20/i.test(fm[1]) ? 'T20' : /^t10$/i.test(fm[1]) ? 'T10' : 'Test';
    const ml = all.match(/\b(\d+(?:st|nd|rd|th)\s+(?:ODI|T20[I1l]?|T10|Test|Match))\b/i) || all.match(/\b(Match\s*\d+|Final|Semi[- ]?Final|Qualifier\s*\d?|Eliminator)\b/i);
    if (ml) out.matchLabel = ml[1];

    const dm = all.match(new RegExp(`\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s*\\d{4})\\b`, 'i')) || all.match(new RegExp(`\\b(${MONTH}\\s+\\d{1,2},?\\s*\\d{4})\\b`, 'i'))
      || all.match(/\b(\d{4}-\d{2}-\d{2})\b/) || all.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/) || all.match(new RegExp(`\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH})\\b`, 'i')) || all.match(/\b(today|tomorrow)\b/i);
    if (dm) out.date = dm[1];
    const tm = all.match(/\b(\d{1,2}[:.]\d{2}\s*(?:AM|PM)?\s*(?:IST|GMT|BST|AEST|local)?)(?![\d.%])/i);
    if (tm) out.startTime = tm[1].trim();

    const vl = lines.find(l => /\b(stadium|ground|oval|park|arena|gardens|cricket club|sports hub|academy)\b/i.test(l) && l.length < 120);
    if (vl) { const parts = vl.split(','); out.venue = vl.replace(/^venue\s*[:\-]?\s*/i, ''); if (parts.length > 1) out.city = parts[parts.length - 1].trim(); }
    const sl = lines.find(l => /\b(series|tour of|trophy|cup|league|premier|championship)\b/i.test(l) && l.length < 100);
    if (sl) out.series = sl;
    const tl = lines.find(l => /\btoss\b/i.test(l));
    if (tl) out.tossText = tl;

    // players: "<name> ... <credits>" with optional "Sel by 45.2%" and team code, under role headers
    let role = null;
    const codes = [out.teamAShort, out.teamBShort].filter(Boolean);
    for (const l of lines) {
      const head = ROLE_HEAD.find(([re]) => re.test(l) && l.length < 30);
      if (head) { role = head[1]; continue; }
      const cr = l.match(/(?:^|\s)(\d{1,2}(?:\.\d)?)\s*(?:cr|credits?)?\s*$/i);
      if (!cr) continue;
      const credits = +cr[1]; if (credits < 4 || credits > 12.5) continue;
      const sel = l.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
      let name = l.slice(0, cr.index).replace(/(sel(?:ected)?\s*by)?\s*\d{1,3}(?:\.\d{1,2})?\s*%/i, '').replace(/\b\d+(\.\d+)?\s*(pts|points)?\b/gi, '');
      let team = '';
      for (const c of codes) { const re = new RegExp(`\\b${c}\\b`); if (re.test(name)) { team = c; name = name.replace(re, ''); } }
      name = clean(name.replace(/[^A-Za-z .'-]/g, ' '));
      if (name.split(' ').filter(w => w.length > 1).length < 1 || name.length < 3 || /^(credits?|points|sel by|selected by|players?)$/i.test(name)) continue;
      if (out.players.some(p => p.name.toLowerCase() === name.toLowerCase())) continue; // same player on several screenshots
      out.players.push({ name, team, role: role || '', credits, selectedByPercent: sel ? +sel[1] : null });
    }
    return out;
  }
  function abbr(name) {
    const w = String(name).trim().split(/\s+/);
    return (w.length > 1 ? w.map(x => x[0]).join('') : name.slice(0, 3)).toUpperCase().slice(0, 4);
  }
  return { parse };
})();
if (typeof module !== 'undefined') module.exports = MatchText;
