# Pure GL / Mega GL Decision Engine — Strategy Specification

Venue-based · high-calculation · high-variance · differential C/VC.
This is the user's strategy spec, saved as provided. The app follows it (see "Implementation map" at the end).

The engine's only objective is to build **high-upside, differentiated GL teams** from: venue history, recent venue matches, pitch behaviour, toss, Playing XI, player role, batting position, bowling phase, recent form, player venue record, matchups, fantasy scoring, match scripts, player ceiling, variance, differential combinations and captain/VC leverage.

Do NOT build a safe Small League team. Do NOT simply select the highest average fantasy scorers. Do NOT select players because they are famous. Do NOT create random teams. Every player and every C/VC combination must have a measurable reason.

## 1. Primary objective
Optimise **GL UPSIDE + DIFFERENTIATION + VENUE FIT + MATCH-SCRIPT COVERAGE**, not average fantasy points alone. Deliberately look for scenarios where a lower-selected player can outscore a highly selected one.
Outputs: Team A (primary high-upside GL), Team B (alternative venue-risk construction), Team C (alternative match-script construction), and multiple C/VC combinations ranked by leverage. If the user asks for ONE final team, pick the construction with the strongest calculated GL profile.

## 2. Never use randomness
Every alternative team must represent a different match script, player correlation, venue interpretation, risk structure or C/VC strategy (e.g. A = high-scoring batting venue, B = early wickets, C = spin-dominant, D = chasing advantage, E = lower-scoring two-paced).

## 3. Venue is the foundation — VENUE GL INDEX
Venue Batting, Bowling, Pace, Spin, Powerplay, Middle-Overs, Death-Overs, Chasing, Batting-First, Boundary, Wicket and Variance indices.

## 4. Venue recency weighting
Last 5 relevant matches = highest weight; last 10 = medium-high; last 15 = medium; older = low. Prioritise the same format, same venue, similar season, similar day/night and similar pitch. For an ODI, ODI data must dominate. Never mix T20 data into the primary ODI model, and label any T20/Test data separately.

## 5. Venue variance engine
Average and median first-innings score, standard deviation, highest, lowest, average wickets, SD of wickets, powerplay variance and death-over variance → **VENUE VARIANCE SCORE**. High variance → increase differential weighting; low variance → increase role-security weighting. Use variance to change the construction strategy; high variance is not automatically better.

## 6. Pitch-behaviour engine
Probabilities of pace dominance, spin dominance, a batting-friendly match, a low-scoring match, a high-scoring match, early wickets and death-over acceleration. Calculate them only from historical evidence, otherwise mark **INSUFFICIENT DATA**.

## 7. Toss adjustment
After the toss, recalculate the entire model rather than adding a bonus. The toss can change batting and bowling projections, expected wickets, overs and runs, chasing value, dew impact, spin/pace value and C/VC candidates → **TOSS_ADJUSTED_PLAYER_SCORE**.

## 8. Playing XI lock
Once the official XI is confirmed, remove every unavailable player: no injured, dropped, non-playing substitute or unconfirmed players.

## 9. Player role model
For each player: expected batting position, balls, runs, boundary opportunities, bowling overs (PP/middle/death), wicket probability and fielding opportunity. Role matters more than career reputation.

## 10. Player venue score
**VENUE_PLAYER_SCORE** from runs, average, SR, wickets, bowling average, economy, dismissals, fielding, recent venue matches and similar-condition matches, with sample-size correction (2 matches = low confidence; 10+ = stronger). A tiny sample must not dominate.

## 11. Recent form score
Last 5 and last 10 matches in the format: runs, SR, average, balls, wickets, economy, dots, boundaries, sixes, catches. Role-adjusted: 35 at No. 7 is not the same as 35 at No. 1.

## 12. Expected opportunity score
**OPPORTUNITY_SCORE** = batting + bowling + fielding opportunity. Opener = high batting; death bowler = high wicket opportunity; all-rounder = two routes; part-time bowler = lower certainty.

## 13. Fantasy point calculator
Use the current platform scoring config (never hard-coded or outdated): expected batting, bowling, fielding, bonus and negative points → **EXPECTED_FANTASY_POINTS**.

## 14. Ceiling model
**CEILING_SCORE** from the probability of 50+, 100+, multiple wickets, 3+ and 4+ wickets, maidens, boundary bursts, sixes, catches, stumpings and combined bat + ball. Calculate P50/P75/P90/P95, and lean heavily on P90/P95.

## 15. Floor vs ceiling
Every player gets floor, median, expected and ceiling. For pure GL, a player with expected 55 / ceiling 150 can beat one with expected 65 / ceiling 85, if role and venue support that ceiling.

## 16. Variance score
**PLAYER_VARIANCE**. High: aggressive opener, death bowler, attacking keeper, finisher, strike spinner on a turning pitch. Low: anchor, low-wicket bowler, limited role. Use it for GL construction, but don't automatically prefer it.

## 17. Differential score
**DIFFERENTIAL_SCORE** = expected points + ceiling + role + venue fit + match-script fit − expected popularity. If ownership is unavailable, never invent it: compute **MODEL_DIFFERENTIAL** and label it.

## 18. True GL value
**GL_VALUE = Ceiling × Venue Fit × Role Security × Match-Script Fit × Differential Factor**, normalised.

## 19. Match-script engine (at least 6 scripts)
1. High-scoring batting match: openers, No. 3, aggressive middle order, death hitters, wicket-taking bowlers.
2. Early-wicket collapse: opening and strike bowlers, middle-order rescuers.
3. Spin dominance: strike spinners, spin all-rounders, good players of spin.
4. Chase dominance: the chasing top order and finishers; second-innings bowlers only if conditions help.
5. Low-scoring match: strike bowlers, all-rounders, keepers, batters who can survive and score.
6. Death-over explosion: death hitters, death bowlers, final-10-over involvement.

## 20. Match-script probability
Script probabilities must be model outputs from evidence, never fabricated.

## 21. Correlation engine
Positive: opener + same-team No. 3; opener + same-team keeper; batting all-rounder + team batting success. Negative: top-order batter + opposing strike bowler; players from competing scripts. Use correlation to build differentiated teams.

## 22. Construction philosophy
Build the best 11-player GL construction, not the "best 11 players".

## 23. Core / Differential / Punt
CORE = strong role + projection. DIFFERENTIAL = upside + lower expected popularity. PUNT = high variance, depends on one script. Mix them deliberately and let the optimiser decide the numbers.

## 24. Team differentiation score
Unique players, captain and VC uniqueness, match-script uniqueness, correlation structure, venue strategy.

## 25–27. Captain / VC engines
**CAPTAIN_GL_SCORE** = expected × ceiling × venue fit × role opportunity × script coverage × differential factor. Captain types: SAFE-HIGH-CEILING, DIFFERENTIAL, VENUE-SPECIALIST, MATCH-SCRIPT, HIGH-VARIANCE (only when the data supports the type). **VC_GL_SCORE** is scored independently (ceiling, venue, role, script, differential, correlation with C). The VC is not simply the second-highest projection.

## 28–31. C/VC combinations, leverage, correlation, venue
Generate mathematically distinct pairs → CAPTAIN_LEVERAGE, VICE_CAPTAIN_LEVERAGE, CVC_COMBINATION_SCORE (high ceiling, differentiated, strong role and venue fit, a coherent script, complementary routes). Avoid negatively correlated C/VC unless it deliberately represents opposite scripts (e.g. C = Team A opener, VC = Team B strike bowler). Venue evidence lifts the relevant candidates: spinners when spin wickets are elevated, death bowlers when death wickets are high, top order when top-order batting dominates.

## 32–34. Generation and objective
Evaluate 500–5,000 candidate teams (expected, P90, P95, ceiling, variance, venue fit, script fit, differentiation, C/VC leverage, correlation, risk). The highest-average team is not automatically the answer. Configurable, backtestable objective:
**GL Objective = 35% Ceiling + 20% P95 + 15% Venue Fit + 10% Match-Script Fit + 10% Differentiation + 5% C/VC Leverage + 5% Role Security**

## 34. Risk bands
Moderate GL / High GL / Extreme GL from calculated variance. Never call a team "safe".

## 35–39. Team types, multiple teams, exposure
A Primary GL · B Venue Contrarian · C Bowling Upside · D Batting Explosion · E Differential C/VC. Show multiple teams only on request, with no near-duplicates and controlled player/C/VC exposure; vary captains deliberately.

## 40. Final validation
11 players, credits, role limits, team limits, all in the Playing XI, C and VC valid, current scoring, venue validated, toss and pitch incorporated, no duplicate or unavailable players.

## 41–44. Output
FINAL HIGH-UPSIDE GL TEAM (WK/BAT/AR/BOWL), Captain, Vice-Captain, Expected Points, P90, Ceiling, GL Score, Venue Score, Differentiation Score, Risk Level; candidate C/VC combinations with leverage and reasons; up to 5 differentials (why, venue evidence, role evidence, risk, ceiling); risk analysis (low batting opportunity, small venue sample, uncertain overs, poor form, one-script dependency).

## 45. Final decision logic
Which players have the highest venue-adjusted ceiling? Benefit most from today's pitch? Gain from the toss? Have multiple scoring routes? Can win a GL if their script occurs? Provide differentiation? Which C/VC has the most leverage? Which construction covers the strongest scripts? Who should be sacrificed for differentiation?

## 46–47. Absolute rule and principle
Optimise for VENUE + ROLE + OPPORTUNITY + CEILING + VARIANCE + MATCH SCRIPT + DIFFERENTIATION + C/VC LEVERAGE, never fame, popularity, average only, "safe", recent score only or reputation. A GL team is a mathematical hypothesis: "if this venue/toss/pitch/script combination occurs, these 11 have the strongest calculated path to an exceptional score." Never claim a win, never fabricate, keep every projection traceable to verified data.

---

## Implementation map (where each rule lives)

| Spec | Code |
|---|---|
| Venue GL index, variance, recency | `Engine.venueIndex` |
| Role / opportunity / venue / differential / GL value / class | `Engine.glPlayers` |
| Ball-by-ball match simulation, toss and dew re-run, 6 scripts | `Engine.simulate`, `Engine.conditions` |
| Deterministic named constructions + local search, GL objective | `Engine.optimiseGL` |
| C/VC leverage, types, correlation | `Engine.cvcCombos` |
| Risk band | `Engine.riskBand` |
| Platform scoring | `data/scoring/*.json` via `Engine.fantasyPoints` |
| Validation | `validate()` in `public/app.js` |
| Data collection (screenshot → match → live research) | `lib/claude.js` |
