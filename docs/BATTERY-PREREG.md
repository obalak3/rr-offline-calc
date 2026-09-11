# Pre-registration: the plan-architecture battery

Written **before any battery arm was run**, and committed before the runs start,
so the decision rule cannot be chosen after seeing the numbers. This document is
the referee. If a result is good and the rule below says it fails, it fails.

## Why this file exists

Three identical control runs of `tools/sim_episodes.js` returned **27/60, 25/60
and 22/60**. That is ordinary binomial spread (sigma about 3.8 wins at n=60), and
it means the unpaired comparisons used earlier could only ever see very large
effects. It was enough to condemn `RR_DEEP_SCAN` (27 to 8, about 4 sigma) and
nowhere near enough to judge `RR_NOANSWER_FLOOR` (22 vs 24), which was reported
as "a wash" when the honest statement is that the instrument could not tell.

Two things follow, and both are implemented before any arm runs:

1. **Common random numbers.** Every source of chance in an episode is driven by
   one seeded generator, seeded per episode from `SEED + ep * 7919`. Episode 17
   of arm A faces the same rolls as episode 17 of arm B. Verified: identical
   seeds produce byte-identical per-episode results, and different seeds do not.
2. **A pre-registered decision rule**, below.

## Arms

All arms run the same harness, the same fights, the same seeds. Flags default
off unless the arm names them.

| arm | what it is |
|---|---|
| **A** | control: current live behaviour |
| **B** | `RR_NOANSWER_FLOOR=1 RR_CARRY_PROGRESS=1` -- the two correct-but-unproven fixes together, in case they only pay in combination |
| **C** | commitment only: the current single-foe planner, but following its plan until a divergence test fires instead of re-planning every turn |
| **D** | the whole-fight gameplan, plan-and-repair (James's design; the original plan note is in git history) |
| **E** | D with the top TWO predicted replacements priced instead of one |

**C exists to decompose D.** D combines two ingredients: commitment to a plan,
and pricing the whole fight as one sequence. If D wins, C is what says which
ingredient did the work. Without C, a win by D is uninterpretable.

## D and E may not enter the battery unless they pass a gate first

Measured play is not the first test. A variant that plays well by abandoning the
things James has repeatedly said matter is not a candidate, and a bad
implementation losing would be recorded as evidence against a good idea.

From archived live positions, D must:

1. produce the **Baby-Doll Eyes line against Pawmot** (an Attack drop, not a
   Speed drop -- all four of Pawmot's moves are physical punches with Iron Fist,
   so lowering Attack beats it and speed control does not);
2. play **Fake Out on the turn a holder arrives**, and not gate it on the flinch
   landing;
3. **contain a costed answer to Pawmot** -- a leg that actually kills it,
   simulated from the position the earlier legs leave behind.

**AMENDED 2026-09-01, after the gate had already fired, on James's ruling.** The
criterion originally read "not spend Victreebel on Pincurchin", taken from
the original line-planner note (git history), where the motivating disaster is Victreebel being
spent sweeping Pincurchin and Pawmot then beating the whole team. The first
gameplan built tripped it: it opens Victreebel on Pincurchin, and answers Pawmot
with Lilligant's Baby-Doll Eyes instead.

Changing a pre-registered criterion after seeing which one it tripped is exactly
what pre-registration exists to prevent, so this is recorded rather than quietly
edited, and the gate's original verdict stands in commit 15e79d1. It is amended
because the criterion was WRONG, not because the result was inconvenient. James:
"If we need Victreebel to kill Pawmot we don't start with Victreebel. If
Lilligant can kill Pawmot then we can start with Victreebel. If starting with
some other Pokemon and killing Pawmot with Victreebel is better then do that.
This is about maximizing the advantage we have in encounters."

The original criterion named a piece. The requirement is about the plan: Pawmot
must be answered, and which Pokemon answers it is the planner's business. A
criterion that reserves a named Pokemon regardless of the rest of the plan would
forbid the very trade the architecture exists to find.

**If D fails the gate it does not run tonight.** The night then runs A, B, C and
a `FINALISTS` 4/8/all sweep, and D waits for a supervised session. A missing
number is recoverable; a confident wrong number about the main idea is not.

## Primary metric and decision rule

Per fight, per arm-versus-control:

- Episodes are **paired by seed**. Each pair is a **win for the arm** (arm won,
  control lost), a **loss** (control won, arm lost), or a tie.
- The test is **McNemar's exact binomial sign test on the discordant pairs**,
  two-sided, at **p < 0.05**.

A variant **PASSES** only if, on at least two of the fights:

- it beats control on the paired test at p < 0.05, **and**
- its **zero-death rate does not fall** (episodes ending with all six alive).

A variant **FAILS** if it loses the paired test at p < 0.05 on any fight.

Anything else is **INCONCLUSIVE**, and inconclusive is reported as inconclusive.
It is not reported as "promising", and it does not earn a live flag.

## What no result may do

- No arm is enabled in live play by this battery. A PASS earns a supervised live
  trial with James at the panel, one fight at a time, and nothing more.
- No single-arm win rate is quoted as a prediction of live play. The harness
  opponent is our port of the ROM AI (77% argmax on faithful positions) and its
  replacements come from `RRAISwitching`, which does not reproduce the one
  confirmed real-game miss. The harness compares arms; it does not forecast.
- `test_replan.js` is not evidence of anything except its own history.

## Fights

Level-appropriate for the save the team is read from, so a variant that overfits
Surge's five Pokemon shows itself. Surge is included because it is the fight
every constant in the planner was fitted on, and therefore the one most likely to
flatter the incumbent.

## Free rider

Every arm also logs, per turn, the lookahead's `ahead` against the realized
remaining cost of the fight from that position. That gives the lookahead's bias
map per opponent at no extra CPU, and bias is the quantity behind every failed
experiment so far: `RR_DEEP_SCAN` failed because believing more of an optimistic
estimate spends Pokemon on futures that are not real.
