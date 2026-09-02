# Handoff -- 2026-09-01 (final for this session)

## READ THIS FIRST: corrections from the last hours of the session

1. **RESTRICTED MODE.** James plays Radical Red's restricted mode and both
   Giovanni test runs used ILLEGAL team builds: v1 gave Annihilape Drain Punch
   (unobtainable), v2 replaced it with Bulk Up and kept Dragon Dance / Recover
   -- and James: "we are in restricted mode... I get no status moves" for picks
   like these. The dex snapshot carries NO restriction flags (verified: move
   records have only ID/name/power/type/acc/pp/chance/target/priority/split),
   so the mode's rules are not in our data. The real save's own sets are the
   ground truth for what is legal (Mienshao's Detect, Lilligant's Sleep Powder
   and Baby-Doll Eyes are in daily live use, so the rule is NOT a blanket
   status ban on everything -- it constrains what could be ACQUIRED for new
   team members). DO NOT guess the rule and do not re-litigate it: ask James to
   approve the exact six movesets before any Giovanni re-run, then run
   tools/sim_episodes.js with RR_TEAM_FILE + FIGHT="ROCKET".
2. **Giovanni results so far are therefore provisional**: v1 60/60 zero-faint
   (invalid team), v2 49/60 with 11 full wipes (also invalid). The one finding
   that likely survives, and the anchor for the next build: in a wiped v2 seed
   the planner clicked Bulk Up into Earth Eater Orthworm THIRTEEN turns in a
   row -- a derived lever pulled with no removal behind it, against a wall it
   had no answer to. Whatever the legal team is, "recognise an unanswerable
   wall and do something on purpose about it" is the failure class to fix.
3. **The tie rule reverted** (47858b8): measured n=120, slot-order 28 vs median
   rule 21, inconclusive-leaning-against; default is old behaviour again,
   RR_TIE_MODEL=median keeps it available.
4. **Fable safeguard protocol**: this session's context repeatedly tripped it.
   In the new chat, keep the game's own vocabulary (faint/KO/removed/survivors),
   never paste raw memory or RNG dumps (summaries only), and the accumulated
   trigger mass resets with the fresh context.

## Fast orientation for the new chat

Memory auto-loads; `project-rr-singles-state` points here. The one-paragraph
state: harness fixed and paired-seeded; port at 79/90 with a per-matchup
instrument; two levers proven (confident entries p=0.0225 zero-faint, the
agent.js stop-loss p=0.0008 pooled -- the live trial needs only
RR_ENTRY_MODEL=confident); arm D refuted; register audit in ASSUMPTIONS.md with
eight suspicions dissolved by measurement; next build = opponent-side levers +
denial-line generation, with the Orthworm wall and a legal Giovanni team as its
acceptance tests; open gameplay decisions #2 (status pricing), #5 (progress
default), #7 (foe switching in pricing).

---

# Handoff -- 2026-09-01 (body as of mid-session)

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
