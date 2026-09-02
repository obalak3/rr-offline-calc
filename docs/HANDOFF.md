# Handoff -- 2026-09-01

Read this, then `docs/ASSUMPTIONS.md` (the audit of background decisions and
what measurement did to each), then memory `project-rr-singles-state` and
`feedback-rr-working-agreement`. Domain facts live in memory
`reference-rr-surge-domain` -- including the 2026-09-01 correction: speed
control DOES work on Pawmot; the constraint is delivering the dropper safely.

**A superseded version of this file claimed a graded lookahead arm "was tried
live and nearly wiped the team." That is false** -- see ASSUMPTIONS.md. Several
other long-standing "known defects" also dissolved under measurement this week.
When this project tells you something is broken, check the instrument first;
that has been the correct call eight times now.

## The mode

James restarted the playthrough and drives the overworld; the agent plays the
fights he hands it. `~/rr-agent/load.txt` empty, `restart` absent,
`EXPENDABLE=""`. Historical per-fight rates are not comparable across builds or
across the AI-port fixes below. Column 4 of results.tsv is SURVIVORS.

## What is established (all paired-seed, referee: tools/compare_arms.py)

- **The AI port**: 61%->79% exact, 77%->90% argmax against the game's own
  score sheet, after five rule fixes and a stale-row filter. `--score-live`
  prints a per-matchup accuracy table that separates a genuine gap from the
  game's own coin flips (in-argmax-set column).
- **`RR_ENTRY_MODEL=confident`** (James's ruling: price entries against the
  predicted move; hedge only when an uncertain choice would be fatal to the
  incoming mon): wins level, **zero-faint episodes 11 vs 2, p=0.0225** pooled
  over two independent runs. Earned a live trial; live needs only this flag.
- **The last-resort override in agent.js ("veto")**: measured for the first
  time via harness emulation (VETO=1) -- **keep it**. Pooled 120 paired
  episodes: p=0.0008 on wins, the strongest single lever measured. Plan-level
  expected value plus an execution-level stop-loss beats either alone.
- **Arm D (whole-fight gameplan): refuted**, 12/100 vs 29/100, p=0.0076, and it
  got WORSE as the value model improved. Fifth independent instance of the same
  law: more search/commitment over the value estimator loses. Do not retry
  without changing the estimator.
- **Their top-roll damage reading is load-bearing** (median-roll arm lost).
  Hedging what the opponent CHOOSES was waste; hedging how hard they HIT is
  protection.
- **The Giovanni stress test** (RR_TEAM_FILE, James's hand-built team at cap 47
  vs ROCKET HIDE. GIOVANNI): first pass 60/60 wins with zero faints, but it
  leaned on an Annihilape Drain Punch James says is unobtainable by then; the
  legal re-run (Bulk Up instead) was in flight at handoff -- read
  ~/.claude/jobs/*/tmp/night/gio60b.txt or re-run.

## The harness (tools/sim_episodes.js)

Paired seeded dice (game's own LCG; SEED + ep*7919), per-episode CSV via
EPISODES=, arms via env flags, TRACE=1 for turn-by-turn. `mode:'sample'` in
rr-battle.js is the honest dice. tools/test_replan.js is history, not evidence.
Referee: tools/compare_arms.py (seed-paired McNemar; self-tested).
Pre-registration discipline: docs/BATTERY-PREREG.md. Instrument variance:
identical controls at n=60 spread over 5 wins, so pair everything.

## Open decisions (James's, gameplay)

1. **Status moves price as sacrifices** (#2 in ASSUMPTIONS.md): an
   `until:{foeStatus}` on a sub-100% move is unsatisfiable in the deterministic
   pricer, so "Scald until burn lands, then close" grinds the user down and
   prices as a concession. Recommended: report status probability like
   deathRisk; interim guard: unsatisfiable `until` fails the leg.
2. **RR_CARRY_PROGRESS default** (#5): off, so multi-move legs replay move 0
   live and multi-leg panel lines only run their first leg. Correct fix,
   unproven benefit.
3. **#7**: the priced opponent never voluntarily switches.

## The next build (agreed direction, not started)

Opponent-side levers + denial-line generation: run `leversFor` on THEIR team,
price plans against their levers ripening (the sim already presses setup moves
-- verified: Roaring Moon's Dragon Dance scores 107 "+7 safe to set up"), and
let generation aim our levers at their threats, not only at their HP.
Acceptance test: the generator must propose a sensible answer to a setup
sweeper on a fight with no recorded history, must propose James's known-good
Surge lines unprompted (they currently verdict "never proposed"), and the
sacred-position gate stays green. No named strategies; everything derived from
data, per James: there are no general rules in this game, and a rule fitted to
one fight is the 19th move of one chess line.

## Still flagged-off and unmeasured

RR_NO_DOUBLE_BOOK, RR_LOOKAHEAD_SEES_US, RR_RISK_WEIGHT. RR_TIE_MODEL shipped
default-ON unmeasured (a mistake); its arm may still be running -- read
night/t120.txt, and revert to slot if it did not earn its place.

## Practical

- Long runs: one arm at a time under caffeinate; wide batches kept getting
  killed. macOS has no `timeout`.
- The agent and Lua are a long-running pair; edits do nothing until restart;
  version.txt gets -STALE on source change.
- Fable's safeguard trips on this project's accumulated wording; keep to the
  game's own terms (faint, KO, removed, survivors) and never paste raw memory
  or RNG dumps into the transcript -- summaries only.
