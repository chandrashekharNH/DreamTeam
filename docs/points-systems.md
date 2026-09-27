# Fantasy Points Systems

Machine-readable versions are in `data/scoring/*.json` and are loaded by the app. The match format (ODI or T20) picks the table.

| File | Platform | Format | Status |
|---|---|---|---|
| `my11_odi.json` | My11Circle | ODI | Verified from my11circle.com/points-system.html (27 Sep 2026) |
| `dream11_odi.json` | Dream11 | ODI | Provisional: dream11.com was down (HTTP 502), values from third-party reports |
| `my11_t20.json` | My11Circle | T20 | User-provided table (below) |
| `dream11_t20.json` | Dream11 | T20 | User-provided table (below) |

---

## My11Circle — T20 (effective 17 April 2025, user-provided)

### Batting
| Event | Points |
|---|---|
| Run | +1 |
| Four bonus | +4 (per four) |
| Six bonus | +6 (per six) |
| 25-run bonus | +4 |
| 50-run bonus | +8 |
| 75-run bonus | +12 |
| 100-run bonus | +16 |
| Duck (excludes bowlers) | −2 |

Batting bonuses are cumulative: a 50 earns both the 25 (+4) and 50 (+8) bonuses.

### Batting strike rate (min. 20 runs scored OR 10 balls faced)
| Strike rate | Points |
|---|---|
| < 50 | −6 |
| 50 – 59.99 | −4 |
| 60 – 69.99 | −2 |
| 70 – 129.99 | 0 |
| 130 – 149.99 | +2 |
| 150 – 169.99 | +4 |
| 170 and above | +6 |

### Bowling
| Event | Points |
|---|---|
| Dot ball | +1 (per dot) |
| Wicket (except run-out) | +30 |
| LBW / Bowled bonus | +8 |
| Maiden over bonus | +12 |
| 3-wicket haul bonus | +4 |
| 4-wicket haul bonus | +8 |
| 5-wicket haul bonus | +12 |

Wicket-haul bonuses are cumulative: a 5-fer earns the 3-, 4- and 5-wicket bonuses on top of 30 per wicket.

### Bowling economy (min. 2 overs)
| Economy | Points |
|---|---|
| < 5 | +6 |
| 5.00 – 5.99 | +4 |
| 6.00 – 6.99 | +2 |
| 7.00 – 9.99 | 0 |
| 10.00 – 10.99 | −2 |
| 11.00 – 11.99 | −4 |
| 12.00 and above | −6 |

### Fielding
| Event | Points |
|---|---|
| Catch | +8 |
| 3-catch bonus | +4 |
| Stumping | +12 |
| Run-out (direct) | +12 |
| Run-out (multiple fielders) | +6 |

### Other
| Event | Points |
|---|---|
| Playing XI bonus | +4 |
| Captain | ×2 |
| Vice-captain | ×1.5 |

Super-over points are not counted. Concussion, X-Factor and Impact Player substitutes earn points only if they are in your fantasy XI.

---

## Dream11 — T20 (user-provided)

### Batting
| Event | Points |
|---|---|
| Run | +1 |
| Boundary (four) bonus | +4 (per four) |
| Six bonus | +6 (per six) |
| 30-run bonus | +4 |
| Half-century (50) bonus | +8 |
| Century (100) bonus | +16 |
| Duck (Bat / WK / AR) | −2 |

Bonuses do NOT stack at 100: a century earns only +16. Below 100 they stack, so a 50 earns +4 (30) and +8 (50).

### Batting strike rate (min. 10 balls; penalties only at SR ≤ 70)
| Strike rate | Points |
|---|---|
| Above 170 | +6 |
| 150.01 – 170 | +4 |
| 130 – 150 | +2 |
| 70 – 130 | 0 |
| 60 – 70 | −2 |
| 50 – 59.99 | −4 |
| Below 50 | −6 |

### Bowling
| Event | Points |
|---|---|
| Wicket (excluding run-out) | +25 |
| LBW / Bowled bonus | +8 |
| 3-wicket bonus | +4 |
| 4-wicket bonus | +8 |
| 5-wicket bonus | +12 |
| Maiden over | +12 |

Wicket-haul bonuses stack.

### Bowling economy (min. 2 overs)
| Economy | Points |
|---|---|
| Below 5 | +6 |
| 5 – 5.99 | +4 |
| 6 – 7 | +2 |
| 7.01 – 10 | 0 |
| 10 – 11 | −2 |
| 11.01 – 12 | −4 |
| Above 12 | −6 |

### Fielding
| Event | Points |
|---|---|
| Catch | +8 |
| 3-catch bonus | +4 |
| Stumping | +12 |
| Run-out (direct hit) | +12 |
| Run-out (not direct) | +6 |

### Other
| Event | Points |
|---|---|
| In announced lineup | +4 |
| Captain | ×2 |
| Vice-captain | ×1.5 |

No super-over points. Overthrow runs credit the striker, but an overthrow four earns no boundary bonus. More than 3 catches still earns only the single +4 bonus.

---

## My11Circle vs Dream11 — key T20 differences

| Category | Dream11 | My11Circle |
|---|---|---|
| Wicket | +25 | +30 |
| Duck | −2 | −2 |
| Dot ball | none | +1 each |
| Maiden | +12 | +12 |
| First batting bonus | +4 at 30 runs | +4 at 25 runs |
| SR floor | −2 starts at ≤ 70 | −2 at 60–69.99, harsher below |
| Century bonus | +16 (no stacking) | +16 (stacks with 25/50/75) |

Strategy notes from the user's table:
- Both systems reward wickets heavily, and My11Circle rewards bowlers even more (30 vs 25 per wicket, plus dot-ball points). Favour wicket-taking bowlers and all-rounders as C/VC on My11Circle.
- On Dream11, boundary hitters get strong value from the +4/+6 bonuses plus SR bonuses on short-boundary grounds.
- When batting second with dew, chasing batters can pile up SR bonuses.

---

## ODI tables

### My11Circle ODI (verified, New Point System effective 17 Apr 2025)
Run +1 · four +4 · six +6 · bonuses 25/50/75/100/125/150 = +4/+8/+12/+16/+20/+24 · duck −3 (excl. bowlers) ·
SR (min 20 runs or 10 balls): <30 −6, 30–39.99 −4, 40–49.99 −2, 50–99.99 0, 100–119.99 +2, 120–139.99 +4, ≥140 +6 ·
dot ball +1 per 3 dots · wicket +30 · LBW/bowled +8 · maiden +4 · 4w +4, 5w +8, 6w +12 ·
economy (min 5 overs): <2.5 +6, 2.5–3.49 +4, 3.5–4.49 +2, 4.5–6.99 0, 7–7.99 −2, 8–8.99 −4, ≥9 −6 ·
catch +8, 3-catch +4, stumping +12, run-out direct +12 / multiple +6 · Playing XI +4 · C ×2, VC ×1.5.

### Dream11 ODI (provisional)
See `data/scoring/dream11_odi.json`. The `fieldStatus` field records the source status of each value.
