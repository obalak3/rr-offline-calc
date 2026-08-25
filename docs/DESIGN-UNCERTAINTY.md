# What the plan should actually be, given that we do not know everything

Written 2026-08-25 after the first real-game validation. This is the design
conversation that reset the project's target, and it survives here because none
of it is in the code yet.

James's framing, which is the spec: *"I wanted it to win independent of whether
it uses Bug Buzz or Mud Shot. I want a plan that holds either way."* And: the
original point was to know **when the range matters** -- to be able to say "this
plan works, but 7% of the time the move crits and your X dies" -- and then to
actively choose the line where that chance is lowest. *"We need to be in the
middle of the Showdown bots where they have no clue what the opponent will do,
and a 100% accurate we-know-everything bot."*

The project had drifted from that. It optimised for finding A line at median
rolls against the AI's single top-scoring move, which is the we-know-everything
end of that spectrum, and then measured itself on whether such a line exists.

## Three different uncertainties, wanting three different treatments

**1. Real randomness we can enumerate.** Damage rolls (16, uniform), crits
(known rate), and exact AI ties -- CFRU literally does
`AIRandom() % numOfBestMoves`, so a tie is a fair die we know the sides of.
These have KNOWN PROBABILITIES, so they want probabilistic treatment: carry
P(clean) through the tree, bucketing rolls by whether they cross a threshold
that changes what happens next (kills, survives to Sitrus, 2HKO boundary),
because that is the only part of a roll that matters. This is what produces the
sentence James asked for.

**2. Our own model error.** The Mud Shot turn. We do not know the true score is
103 vs 100; we know OUR PORT says so, and the port is admittedly incomplete
(~880 CFRU scoring sites, none transcribed). You cannot put a probability on
your own ignorance, so this wants ADVERSARIAL treatment inside a bounded margin:
the plan must hold for every opponent move within M points of our predicted top.
M is the dial between the two poles -- M=0 is the omniscient bot, M=infinity is
the Showdown bot. M=3 covers one unported `INCREASE_VIABILITY(3)`, the smallest
adjustment CFRU makes.

**3. The player's input burden.** A real constraint, not a UX nicety. It rules
out "re-plan every turn by hand", because James would have to type both sides'
moves and HP every turn. This is what the screen reader exists to remove; see
`PLAN-SCREEN-READER.md`.

## The product is a policy, not a line

"A plan that holds either way" is a strategy tree. `certify` already SEARCHES
one -- it branches over the full tie set and kill-buckets -- and then throws the
tree away, keeping only a yes/no. The deliverable should be the tree, printed as
something playable.

### Why "most branches collapse" is FALSE, and what survives

The tempting claim is that a fork where our reply is the same either way is not
a fork. James killed this: if Bug Buzz vs Mud Shot leaves Victreebel at 21 or 59,
that 38 HP is a fork that never closes. It sits silent until turn 12 when
Victreebel comes back in and the question "does it survive a Charge Beam" has
different answers. **The printing problem is the state-divergence problem**, and
divergences compound.

What survives, and is the actual design:

- **Condition on present state, not history.** "If they used X on 3 and Y on 7"
  is unprintable. "Bringing Victreebel back: if it is at 46+, do X, else Y" is
  one glanceable check, and it does not care which combination of flips produced
  the number. Our side shows exact HP in game; the foe shows a bar, so any
  condition on THEIR exact HP is an illegal plan by construction -- the search
  may only condition on what a player can see (which move they used, whether the
  berry popped, whether the bar is red).
- **Carry the divergence as an INTERVAL and check the pessimistic end.** If the
  script holds at the worst end, there is no fork and nothing is printed, even
  though the states differ. A fork is printed only where the worst end fails and
  the best end does not, and the fork condition is exactly that threshold.
  This bounds the artifact by DECISION-RELEVANT crossings rather than by
  2^(near-ties).
- **Prefer plans that RE-CONVERGE their own state.** Some moves shrink the
  interval: Recover to full collapses it to a point, a Regenerator pivot
  partially closes it, a Volt Absorb switch into an Electric move takes zero
  damage with no roll at all, and a denied turn (Fake Out, sleep) means the
  opponent contributes no branch that turn. A planner that tracks intervals
  prefers these structurally, with no tuned weight.
- **Declare re-sync points when the interval genuinely blows up.** "Before turn
  12, tell me Victreebel's HP" -- one number, scheduled in advance, rather than
  per-turn bookkeeping. Rare, small, predicted; and the plan should be
  embarrassed about each one.

## The interaction contract, in order of preference

1. **No question.** The next action is the same across the whole interval.
   This should be the common case; if it is not, the LINE is bad.
2. **"Did it use X or Y?"** -- discrete, zero effort, already observed.
3. **"Is Victreebel at 46 or more?"** -- a yes/no threshold, never "enter HP".
   The threshold comes out of the search: the exact point the plan flips.
4. **Exact entry, only at a declared re-sync**, and only the values that matter.

**Crits are observable**, so they are never a question -- the game announces
them. They want a precomputed contingency: most turns "a crit here changes
nothing, continue"; a few turns "a crit here kills, and here is the response".
Those few are exactly the "7% of the time your X dies" spots from the spec.

## UNKNOWN IS NOT LOSS (fixed 2026-08-25, and why it was the priority)

James beat Lt. Surge with the real team and lost NOBODY, in a fight this project
had left clean-undecided at 84M nodes and only won at lossBudget 2. His point:
"don't tell me runs aren't possible." Retrying a run many times is how a PLAYER
learns what the AI does; the app already knows, so it should be finding winning
lines in most cases, sometimes losing Pokemon and sometimes not.

That is partly an objective problem -- item 3 below, promoted -- and partly a
plain defect, found in `winChance` and now fixed.

**The defect.** Every way the search gave up returned the value a defeat
returns. Node budget exhausted, turn horizon reached, and no opponent model for
a position all returned 0, exactly like losing a Pokemon. Because exhaustion
also short-circuits every remaining node, a search that ran out of budget
reported a chance near zero regardless of what it had already proved.

**Why it matters more than an ordinary bug.** The errors are not symmetric.
Every one of those collapses biases the answer DOWNWARD, so the tool
systematically described fights as worse than they are -- which is precisely
the complaint. It is also the same shape as the reliability floor this project
already removed once: a lower bound rendered as a percentage reads as a win
rate, and that misreading is the design's fault, not the reader's.

**The fix.** A node answers with two numbers: `v`, mass that provably reaches a
clean win, and `u`, mass never examined. A real loss contributes to neither, and
the truth lies in `[v, v+u]`. `certify` exposes `unknown`, `upper` and
`uninformative`. `chance` itself is unchanged, verified bit-identical against
the pre-fix engine by `tools/measure_unknown.js`, because quietly moving a
number the solver proves things with would be worse than the bug.

Measured on the real Surge fight: it now says 0% proved / 100% UNKNOWN at every
budget up to 400k, instead of a bare 0% that reads as "you lose".

**The other thing that measurement showed:** that fight runs about 800 nodes per
second, so twenty seconds buys ~16k nodes where millions are needed. Whole-fight
probability is not affordable live at all. That is independent support for the
screen reader's one-turn-deep re-planning, where the budget is ample and the
floor is meaningful.

## The metric this all points at

**The best plan is the one that wins while asking the fewest questions.**

That is now measurable: `tools/check_forks.js` counts, for a candidate line, the
turns where an in-margin opponent move breaks the script, the turns where a
damage roll decides a KO, and the turns where only a crit kills. It is the first
objective this project has had that matches what the artifact is FOR.

Its first result is damning and useful: the real team's Lt. Surge line needs a
fork at **all 24 of its 24 turns**, 6 of them exact ties, with 3 roll-decided
KOs and 6 crit-fragile turns -- four of them consecutive in the Lilligant
Recover stall. The tool found in two lines of output that the stall section is
the worst part of the plan, which no benchmark ever surfaced. It also says long
stall lines are the wrong SHAPE under uncertainty: every extra turn is another
tie, another roll, another crit window. Short lines are not a nicety, they are
the objective.

Caveat on that measurement, recorded honestly: the check is deliberately harsh.
On a deviation it plays the UNMODIFIED script onward, so "breaks" means the
rigid script fails, not that no repair exists. The interesting follow-up is to
allow local repair at each fork and see how many rejoin. The exact-tie turns are
real coin flips regardless.

## Why the margin cannot simply be widened

The obvious move is to branch over everything within M=3. Measured: 100% of the
Surge line's positions have a runner-up within 3, so M=3 branches at every turn,
which is 2^24 lines. **The margin is a sound idea and it is unaffordable as a
search.** What IS affordable is the same idea as a CHECK on an existing line --
verify and patch, which is roughly linear in line length times branch count,
instead of exponential.

## The fragility numbers, measured

On the real team's Surge line, scoring the AI at all 24 positions:

    exact ties (gap 0)      7/24  (29%)
    runner-up within 3     24/24  (100%)

`RR-AI.md` previously put ties at about 7% of positions. Exact ties alone are
29% here. Three points is one `INCREASE_VIABILITY(3)`.

## Fake Out, rederived three times

James has raised this repeatedly and the design keeps agreeing with him from new
directions:

1. The mechanic is modelled correctly -- measured: turn 1 Fake Out deals 16,
   takes 0, and DENIES Pincurchin's turn, where Drain Punch deals 0 (they pivot)
   and takes 48. So it is a choice failure, not a modelling gap.
2. The weighted search charges Fake Out a full turn while its two-turn horizon
   cannot see the turn it denies. That is structural, not a weight to tune.
3. Under the uncertainty design it is undervalued a THIRD way, and this is the
   deepest one: **a denied turn is a turn with no opponent branch** -- no tie, no
   margin, no roll, no divergence. On a line where every turn is a coin flip,
   removing a coin flip is worth more than the 16 damage. Robust planning prices
   this for free; the weighted evaluator never could.

The same argument covers sleep, and switches into immunities (Volt Absorb).

## Build order when this is picked up

1. Robustness CHECK and patch on existing lines (cheapest, biggest step toward
   "holds either way"). `check_forks.js` is the measurement half; the patch half
   -- re-search the branch locally and see if it rejoins -- is not built.
2. Short-line preference in the search. Currently it takes the FIRST line found;
   on Brock the restart driver returned an 18-turn line where a 13-turn one
   exists.
3. P(clean) reporting, with the risk located by turn. `winChance` half-exists.
4. Robust SEARCH last, and only where the check keeps failing.

Note that the screen reader (`PLAN-SCREEN-READER.md`) changes the priority of
all of this: with true state each turn, nothing needs predicting 24 turns out,
and only the one-turn-ahead risk math (item 3) stays essential.
