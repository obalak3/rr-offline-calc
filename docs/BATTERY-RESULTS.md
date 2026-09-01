# Battery results, night of 2026-08-31 / 09-01

Verdicts applied mechanically from `docs/BATTERY-PREREG.md`, which was written
and committed before any arm ran. Every comparison is seed-paired and tested with
McNemar's exact binomial on the discordant episodes.

## Read this before any number below

**The baseline moved mid-night and earlier numbers are not comparable.** The AI
port went from 61% to 76% exact agreement with the game's own score sheet, and in
this harness the opponent IS that port. On the same fight with the same seeds the
control fell from **32/80 to 16/80**. It now finds KOs it used to miss. Anything
measured before commit `3e7009f` was played against an easier opponent.

## The arms

| arm | Surge, matched control, n=240 | verdict |
|---|---|---|
| **A** control, current live behaviour | 50/240 | - |
| **B** `RR_NOANSWER_FLOOR` + `RR_CARRY_PROGRESS` | 35/80 vs 32/80 (old baseline) | INCONCLUSIVE |
| **C** commitment, replan only on divergence | 15/80 vs 32/80 (old baseline) | **FAILS** |
| **D** whole-fight gameplan, plan-and-repair | **52/240** | INCONCLUSIVE |

### D, the headline, at n=240

```
wins            control 50    arm 52
paired          both won 10, neither 148, ARM ONLY 42, CONTROL ONLY 40
McNemar exact   p = 0.9122   (82 discordant pairs)
zero-death      control 4     arm 0
switch rate     control 38%   arm 30%      (live winning play is 24%)
```

**Dead even.** The encouraging n=80 reading (23 vs 16, p=0.26) was noise, which is
exactly what n=240 was run to find out.

Note the zero-death column: 4 against 0. Not significant on its own, but D scored
0 clean wins in both its 80-episode and its 240-episode runs, and the
pre-registration names a falling zero-death rate as a failure condition. D would
not have passed even if the win column had gone its way.

### What D does deliver, and why it does not convert

D genuinely does what it was built to do. It holds a plan for 73% of turns, a
median of 9 turns per plan, and cuts the switch rate from 38% to 30%, the closest
anything has come to live play's 24%.

**It just does not turn that into wins.** That is the most important single
result of the night, because it undermines the thesis that drove most of the
work: churn was assumed to be causal, and removing 8 points of it changed nothing.

Its plans are bimodal, 431 one-leg against 241 five-leg with almost nothing
between, and 1676 of 2351 build attempts fail and fall through to the incumbent
planner (overwhelmingly at team HP below 25%, which is the search honestly
reporting a lost position). So D is largely the control with committed sequences
layered on top, and it lands on the control's number.

## More search loses, for the fourth independent time

| experiment | result |
|---|---|
| historical uniform depth sweep (5, 8, 12, 30) | wipes at 12 and 30 |
| `RR_DEEP_SCAN` past the LOOKAHEAD cut | 27/60 to 8/60 and 7/60 |
| gameplan beam 3x4 to 8x8 | 23/80 to 17/80 |

The wide beam found strictly better-looking plans by its own scoring (cost 27.64
losing one Pokemon, against 36.44 losing two) and played worse. Search amplifies
whatever bias the value estimator carries, and this estimator is biased.

**This is the finding to act on.** The bottleneck is not the planning
architecture, it is the value model underneath it. Four experiments now say that
making the planner look further or believe more of what it sees costs games.

## Measured dead ends, recorded so they are not retried

- **The no-answer flat 8 cannot be repaired by tuning it.** Lowering it
  (`RR_DEEP_SCAN`) lost 4 sigma. Flooring it at the dearest real answer
  (`RR_NOANSWER_FLOOR`) was a wash. It is load-bearing pessimism, not an
  estimate, and it appears to be a counterweight to optimism generated elsewhere.
- **Drift-based divergence cannot work against the plan's own trace.** Measured
  over 530 held turns: median **-0.39**, p90 +0.24, only 1% of turns more than
  0.5 behind. Reality comes out BETTER than the plan expects, because pricePath
  simulates their damage at the top roll and charges entries the worst plausible
  move. The trajectory is a pessimistic bound, not a forecast.
- **Level-scaled extra fights were degenerate.** Erika 0/80 for every arm,
  Misty 80/80. Zero discordant pairs, no information. Fights for a battery have
  to be chosen for competitiveness, not level.

## What passed

Nothing. The pre-registration requires a win on the paired test on at least two
fights with the zero-death rate not falling. One arm failed, two are
inconclusive, and only one fight produced information at all.

That is the honest outcome and it is what the referee was written to produce.
