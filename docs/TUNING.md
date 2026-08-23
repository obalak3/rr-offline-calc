# What has been measured

Numbers here come from `tools/bench_early.js 15` unless stated: 9 real
early-game battles against 15 generated teams, 135 fights, scored on **clean
wins** (won losing nothing), which is what a Nuzlocke cares about.

Read this before tuning anything. Most of these were expensive to find and
several contradict what looked obvious.

## Where it stands

    clean wins   59%      (a dumb "always hit hardest" baseline gets 20%)
    won at all   68%
    lost         2.09 Pokemon per fight

## What helps

**The AI model is worth 11 points.** Modelling what CFRU's AI will actually do,
versus assuming a worst-case opponent:

    lookahead 2, AI model     59%
    lookahead 2, worst case   48%

**Low death-risk weighting.** `deathChance` only measures the ACTIVE Pokemon, so
switching resets it. Weighted high, that pays the planner to pass the problem
down the party rather than solve it -- against Misty it switched three turns
running into the same Ice Punch. Swept:

    1000 -> 56%   700 -> 58%   500 -> 59%   300 -> 59%   150 -> 59%   0 -> 59%

Set to 300. Zero measures the same but the term encodes something real.

## What does not help

**Deeper search makes it worse -- and the reason is now measured.** Depth
compounds AI-model error. Running the same search against a worst-case opponent,
where there is no model to be wrong about, flips the direction:

                    depth 2    depth 3
    AI model          59%        56%     depth HURTS
    worst case        49%        56%     depth HELPS (+7, 90 fights)

So the model is worth 10 points at depth 2 and worth nothing at depth 3 -- by
then its errors have eaten its value, and both arms land in the same place. A
3-ply plan rests on two predicted replies instead of one, and each is a chance
to be wrong.

The consequence matters more than the finding: **more search cannot help until
the opponent model is better.** Depth is not the lever; AI fidelity is. That
puts the unported parts of CFRU's scoring -- ai_switching.c, the fighting-class
system, most of the ~880 scoring sites -- on the critical path, with a
measurable payoff rather than a hoped-for one.

**Playout evaluation.** 52% against 59%. Judged useless once before when the
evaluator was inert, so this retest was the real one. The playout POLICY is the
weak part ("hit hardest, switch if dying"), not the idea.

**Raising progress or health weights.** Every combination tried scored at or
below the default. `progress: 250` is clearly worse at 54%.

**`turnCost` does nothing, by construction.** `depthUsed * turnCost` is constant
across all leaves at the same depth, so it cannot separate two actions. It only
bites between terminal and non-terminal leaves.

## Traps

**Verify that an edit applied.** Four evaluator fixes were reported, committed
and described in messages without ever being in the code, because Python string
replacement silently does nothing when the anchor does not match. The symptom
was weights appearing to have no effect at any value, including absurd ones, and
it cost hours of hunting a search bug that did not exist. Assert the change is
present before trusting a measurement.

**One fight is not evidence.** 135 samples puts the standard error near 4 points,
so a 3-point gap between two settings is noise. The deathRisk result is
trustworthy because the direction held across six settings, not because 59 beat
56.

**Check the benchmark can see what you are changing.** An early version sent
four level-34 Pokemon into postgame boss fights and reported 6/28 as "the state
of the planner". Against a dumb baseline the current one separates 59% from 20%,
so it does measure play quality.
