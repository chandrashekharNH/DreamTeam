# DreamTeam — Pure GL Decision Engine

Upload a match screenshot, and the app reads it, researches the match live (toss, Playing XI, pitch, venue history, form, weather), applies the **Dream11** and **My11Circle** points systems and the GL strategy, and builds one high-upside GL team per platform. **⟳ Refresh** re-fetches the latest data and rebuilds both teams.

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start     # http://localhost:5177
npm test                                   # offline pipeline tests
```

Without an API key the app still opens with the saved sample match (India vs West Indies, 1st ODI), but screenshot reading and Refresh are disabled.

## Flow
1. **Match Setup** — drop, choose or paste 1–5 screenshots (match page or Dream11/My11Circle contest page). Claude vision extracts the teams, format, venue and date, plus any credits and "selected by %" shown.
2. Confirm or edit the details, then **Fetch data & build teams**. Claude (`claude-opus-5`, web search + web fetch) collects cited facts, which are converted into strict JSON (`lib/claude.js`) and then the model format (`lib/adapter.js`).
3. **Dream11 Team** / **My11Circle Team** tabs: 2,000 ball-by-ball simulations → per-player floor/median/P90/P95 → GL optimiser → C/VC leverage → validation.
4. **⟳ Refresh** — re-researches the same match. Every refresh is saved in `data/matches/<id>/`, and changes (toss, XI, pitch) are shown.

## Saved rules
- `docs/points-systems.md` + `data/scoring/*.json` — Dream11 and My11Circle, ODI and T20
- `docs/gl-strategy.md` — the Pure GL decision-engine strategy and where each rule is implemented

## Data honesty
Every fact carries a source; missing data is shown as INSUFFICIENT DATA and falls back to labelled generic priors. Ownership is used only when it comes from your screenshot. The Dream11 ODI table is provisional (the official page was down when it was saved).
