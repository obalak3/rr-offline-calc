# The register of unproven assumptions

James, 2026-09-01: *"I feel like we have stuff in the background that is actually
limiting us, and instead of just realizing them while things go wrong I'd rather
fix them now."*

This is that audit. Every entry is a decision that shapes what the planner plays
and was never measured, mostly added as a counterweight when the models beneath
it were weak, and mostly kept long after those models were fixed.

**The single most useful result of the audit is the base rate.** Of the entries
resolved so far, roughly half dissolved on contact with data: they were not
defects at all, and several had been treated as known defects in the docs for
weeks. Suspicion accumulates faster than measurement retires it. Read that as a
warning about this file's remaining entries, not as a reason to trust them.

## Retired by measurement, no code changed

| # | assumption | what the data said |
|---|---|---|
| 3 | pricing scores the foe without `semiSmart`, while live Surge runs all three flag bits | changes the committed choice on **0.0% of 173** realistic positions. May still matter off-Surge. |
| 17a | `turnsOut` is decisions-counted, not game-read, so it drifts | **1 disagreement in 4558** archived consecutive turn pairs. It is correct. |
| 17b | crits might be recoverable from the decision-time RNG seed | best of 32 draw offsets predicts the roll index **27.3%** against a **24.3%** chance baseline, over 835 turns. Not recoverable. |
| 20 | `results.tsv` has 151 rows and no LOSS, so losses are being swallowed | **zero wiped episodes in the entire turn archive.** Two independent instruments agree: there have been no live losses on Surge. |
| 8 | the replacement port "does NOT reproduce the Bellibolt observation" (docs, for weeks, on ONE observed event) | graded against **all 425** archived replacement events: **76% top-1, 89% top-2, against a ceiling of 80%**, because 26 of 106 contexts are genuinely stochastic. The pinned failure is a coin: Manectric 19 / Pawmot 16 over 35 identical contexts. Four points of headroom total. |
| - | "a graded lookahead penalty was tried live and nearly wiped the team" | the arm is `ee478e7` on an unmerged branch whose own message begins PARKED, UNVALIDATED; **one** of 151 results rows carries it and it is a **WIN**; the version stamp shows it ran for at most the last ~97s of one episode. The claim first appears in a doc rewrite two days later. |

## Fixed, measured, and earned its place

| # | change | evidence |
|---|---|---|
| — | `RR_ENTRY_MODEL=confident` (James's ruling: trust the prediction, hedge only when a genuinely uncertain choice would be **fatal** to the incoming Pokemon) | pooled over two independent paired runs, 180 episodes: wins dead level (p=1.00), **zero-death 11 vs 2, McNemar p=0.0225**, mean survivors 0.41 → 0.68. Replicates separately (6-1, then 5-1). **The one change that has earned a live trial.** |
| — | five AI-port rule fixes (stale-struct filter, incoming-damage, KO gate, drain-after-standing, Thunder Wave vs Ground) | port **61% → 79% exact, 77% → 90% argmax**; per-matchup committed-choice accuracy 81% → 84%, with a standing instrument that separates a ceiling from a defect |
| — | `path.ahead` was always 0 for every returned path | the panel's line verdict compared on immediate cost alone, the turn log printed "rest of the fight 0.00", and the bias measurement returned a perfect zero on 1608 rows. Decisions were never affected. |

## Refuted

| # | claim | result |
|---|---|---|
| — | the whole-fight gameplan (arm D) would benefit most once the value model was fixed | **12/100 against 29/100, p=0.0076.** It lost *worse* on the improved stack. Fifth independent confirmation that more commitment to the model loses even as the model improves. |
| 1 | reading THEIR damage at the top roll is "the last untested member of the pessimism family" | median-roll pricing scores 20/100 against 29/100 with zero-death 7 → 1. The top-roll reading is **load-bearing**. Hedging what the opponent *chooses* was wasteful; hedging how hard they *hit* is protective. |

## Implemented, flagged off, still unmeasured

`RR_NO_DOUBLE_BOOK` (#10), `RR_LOOKAHEAD_SEES_US` (#12), `RR_TIE_MODEL` (#13,
and note it shipped **default-on** and unmeasured, which was a mistake — it is an
arm in the queue and comes out if it does not earn its place), `RR_RISK_WEIGHT`
(#9), `RR_FOE_ROLL` (#1, refuted above), `VETO=1` (#4, the harness emulation).

**#4 deserves its own note.** The death veto has overridden roughly a tenth of
live decisions since the night the planner walked Lilligant into Mach Punch. Its
own comment concedes "the pricing it distrusts is not the pricing it was written
against." Its benefit has never been measured, and until the harness emulation
existed it *could not be* — every offline arm this project has ever run compared
planners in a world with no veto.

## Open, and James's to decide (gameplay)

- **#2 status moves are priced as sacrifices.** `until: {foeStatus:'brn'}` is
  unsatisfiable in the deterministic pricer, so "Scald until burned, then close"
  prices as Lanturn 139 → 63 → 2 → **dead**, outcome `kill`, deathRisk 1.00. It
  does not undervalue the burn; it converts the plan into a sacrifice and the
  market then correctly rejects it. Options: stochastic pricing (breaks the
  stability the honest-dice work bought), fire only theirs (the assume-the-worst
  family, just overturned), or report status as a probability the way `deathRisk`
  already is (recommended). Interim guard worth having either way: make an
  unsatisfiable `until` fail the leg rather than grind the Pokemon to death.
- **#5** `RR_CARRY_PROGRESS` default. Multi-move legs still replay move 0 forever
  live, and use-count handovers never fire, so typed panel lines of 2+ legs only
  ever run their first leg.
- **#7** the priced opponent never voluntarily switches.

## Known, accepted, on the record

TEMPO=0.4 is fitted on Surge and its flat-per-turn shape means a death is worth
15 turns at whole-fight horizons; `turnRate()` already implements the derived
alternative and has never been A/B'd. The flat 8 is measured load-bearing in
both directions and dissolves only when the optimism it counterweights does
(#10). STICK=0.75 cannot resist 8-point score flips and is downstream of #10/#12.
Mega evolution is unmodelled. Roughly 849 AI scoring sites are unported, so
off-Surge port accuracy is simply unknown. And the harness opponent is our own
port, which flatters `confident` by construction — live remains the only
authority.
