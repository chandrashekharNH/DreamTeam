# DreamTeam — Pure GL Decision Engine (IND vs WI, 1st ODI, 27 Sep 2026)

Zero-dependency Node app with two tabs: **Dream11 Team** and **My11Circle Team**.

```bash
npm start   # http://localhost:5177
```

## What it does
- Ball-by-ball Monte Carlo (2,000 matches) using the official Playing XI, toss (India bowl first), venue, pitch and live weather (Open-Meteo)
- Scores each simulation with the platform's ODI points system, giving floor / median / expected / P75 / P90 / P95 per player
- GL optimiser: named constructions (P90, P95, GL-value, differential, one per match script) plus local search on
  35% P90 · 20% P95 · 15% venue · 10% script · 10% differentiation · 5% C/VC leverage · 5% role
- Ranked C/VC combinations, model differentials (no ownership data is invented), risk band, validation checks

## Data honesty
- `data/seed.json` holds every fact with a source id. Missing data is shown as INSUFFICIENT DATA.
- My11Circle ODI scoring is verified from the official page. Dream11 ODI scoring is **provisional** (official page was down) and can be edited in-app.
- Per-player recent form could not be verified, so projections rely on role/position priors plus the sourced evidence.
- Credits and role labels can be entered per platform. The credit cap is enforced once they are entered.
