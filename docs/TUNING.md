# What has been measured

Numbers come from `tools/bench_early.js 15` unless stated: 9 real early-game
battles against 15 generated teams, 135 fights, scored on **clean wins** (won
losing nothing), which is what a Nuzlocke cares about.

Read this before tuning anything. Most of these were expensive to find, several
contradict what looked obvious, and one of them is a retraction.

## Where it stands

    clean wins   62%      (360 fights; a dumb "always hit hardest" baseline gets 20%)
    won at all   71%
    lost         1.87 Pokemon per fight

## The benchmark was measuring the wrong fights (2026-08-23)

**Every number recorded here before this date was measured against teams no
player would ever field.** The generator picked species with a base stat total
under 480, intended to exclude legendaries. What it actually excluded was most
*fully evolved* Pokemon, so it sent a **level 44 Poliwag, Psyduck, Paras and
Gloom** into Lt. Surge and called it a level advantage.

Teams now evolve with their level (`evolve()` in `tools/bench_early.js`), using
the dex's own evolution table: methods 4/22/23 are level-ups, 7 is a stone and 1
is friendship (both assumed available from level 28), and **254 is Mega
evolution, which must never be applied** -- the player does not get a free Mega.
Move pools are accumulated along the whole evolution line, because a Poliwrath
still knows what it learned as a Poliwag and several evolved forms have almost
no level-up list of their own.

The headline barely moved (59% -> 60% on the same 135 fights), so this did not
flatter the planner. What it changed is which conclusions survive.

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
(Measured pre-2026-08-23, so on the old teams. The direction held across six
settings, which is why it is still trusted, but it deserves a re-run.)

## What does not help

**RETRACTED: "deeper search makes it worse."** That finding was an artifact of
the broken generator. Re-measured on real teams:

                    135 fights   360 fights
    lookahead 2         60%          62%
    lookahead 3         61%          61%

Depth is **neutral** in the 2-4 range, not harmful. Depth 3 costs 5x the time
for no gain and depth 4 does not finish, so **lookahead 2 stays the default on
cost grounds, not quality grounds**. The explanation previously recorded here --
that depth compounds AI-model error -- is not supported and should not be
repeated.

**Monte Carlo search over the real objective, so far.** rr-mcts.js scores lines
by playing the battle out and reading how it ended, rather than by a weighted
sum. On a 45-fight subset, with both engines executing deterministically so
neither is charged for luck the other avoids:

    solver (proxy, depth 2)     60%
    mcts   400 iterations       53%    7.8s per fight
    mcts  1200 iterations       56%   33.7s per fight

Not yet worth switching to. It does have the property the proxy search lacks --
quality rises with budget (47/49/51/53/56% across 50 to 1200 iterations) where
depth 2, 3 and 4 are flat -- but it is far more expensive and still behind. Its
rollout policy only switches below a third HP, so it will systematically
undervalue switch-heavy lines, which are exactly the ones that win hard fights.

Given that the ceiling work shows this problem is exactly solvable, sampling is
probably the wrong tool for it: an exhaustive search that finds the line is both
faster and CORRECT, where MCTS is neither.

**Porting more AI fidelity changed nothing.** 68% of trainer move evaluations
were getting no adjustment at all, concentrated in `secondary` (559 sites),
`damaging` (552), `selfSwitch` (503) and `boost` (175, which had **never** been
scored). Setup scoring and pivot scoring were both ported, and the rules are
demonstrably live -- a setup move is now among the AI's top picks in 96 of 662
positions and a pivot in 88 -- yet:

    before the port    80/135  (59%)
    after the port     80/135  (59%)

Identical. The predictions genuinely changed and the win rate did not move at
all. Combined with the retraction above, the hypothesis that "AI fidelity is the
lever" has evidence against it from both directions. The port was kept because
it is correct behaviour, but the clone-per-bench-member it originally used made
the benchmark 3x slower and was replaced with an active-index swap.

**Playout evaluation.** 52% against 59%. The playout POLICY is the weak part
("hit hardest, switch if dying"), not the idea.

**Raising progress or health weights.** Every combination tried scored at or
below the default. `progress: 250` is clearly worse at 54%.

**`turnCost` does nothing, by construction.** `depthUsed * turnCost` is constant
across all leaves at the same depth, so it cannot separate two actions. It only
bites between terminal and non-terminal leaves.

## Searching exactly beats scoring positions (2026-08-24)

The largest single improvement in the project, and it came from changing the
question rather than tuning the answer. rr-exact.js looks for a line that
provably loses nobody and falls back to the weighted search only when it cannot
settle the question. Same 135 fights, same teams:

                          won at all   clean   per fight
    exact search             72%        71%      2.9s
    weighted search          70%        61%      0.27s

Ten points. And the shape matters as much as the number: the exact engine won 97
fights and 96 of them were clean. It essentially never wins dirty, because it is
optimising the actual objective rather than a proxy for it.

    fights not cleanly won   weighted -> exact
    BROCK                       3/15  ->  0/15
    PEWTER / FALKNER            7/15  ->  2/15
    MT. MOON ARCHER            13/15  ->  7/15
    MISTY, SURGE               15/15  -> 15/15   (need more than an 8s cap)

For contrast, three separate fixes to the weighted search -- AI fidelity, loss
weighting, the forcing bug -- each improved the decision they targeted and each
left the number at exactly 81/135. The ceiling was the evaluation itself.

Wired into the advisor's "Plan this fight" with a five second cap, since it runs
on the main thread and the fallback always returns something playable.

**Two bugs this direction exposed that a heuristic would have hidden forever.**
Both were found by reading a printed line move by move, which is possible only
because an exact search has to justify itself:

- Self-Destruct did not knock the user out. The engine simulated it as an
  ordinary attack, and the search proudly returned a "proved" clean run through
  Surge whose turn 17 was Weezing exploding and whose turn 18 was Weezing
  switching out.
- The time limit did not stop the search. It fired on one node in 1024 and set a
  flag that nothing else read, so the other 1023 carried on: a 12 second cap ran
  over three minutes and stopped only when the node budget ran out. Cost an
  entire overnight benchmark run. The node budget check has the same shape and
  survives by accident, because every later node also exceeds the budget.

## The headline number was measured against the wrong denominator

`tools/ceiling.js` answers a question that should have been asked first: how
many of these fights can be won cleanly AT ALL? It is exactly computable, and
not by luck -- the benchmark scores routes under DETERMINISTIC dynamics (median
rolls, the AI's argmax reply) and trainer teams are fully known, so "does a
clean win exist" is plain reachability in a finite graph. What makes it
affordable is the Nuzlocke objective itself: the moment one of yours faints the
branch is dead and gets cut, so only lines where nothing has died are explored.

    a clean win EXISTS            12  (67%)
    provably IMPOSSIBLE            0  (0%)
    undecided (budget ran out)     6  (33%)

    the planner won cleanly       11
    of the fights it COULD win  11/12  (92%)   <- the real score

**Nothing was proven impossible.** Every failure is either a fight known to be
winnable or one the oracle could not decide within budget, and the undecided
ones are exactly the fights the planner fails: Misty, Surge and Mt. Moon.

So "62% clean wins", compared against an imagined 100%, understates the planner
badly. Against what has been shown to be achievable it is at 92%. The remaining
problem is not judgement, it is compute: making the hard fights decidable.
Report both numbers, and never the first one alone.

## Which fights are actually hard

`levelOffset` in the benchmark options is a diagnostic knob: if a fight stays
unwinnable as the player's level advantage grows, the fight is not hard, the
planner is broken. Clean-win rate by level advantage over the trainer:

    player advantage    +2     +8    +15
    overall            61%    89%    93%

    GYM LEADER BROCK    50%   100%   100%
    MISTY                0%    10%*   --      (*scales normally with level)
    LT. SURGE            0%     0%    38%
    MT. MOON ARCHER      0%    60%   100%

Everything scales with level except **Lt. Surge, which is the one genuine
outlier**: 5 of 8 teams still drop a Pokemon at +15 levels, i.e. a fully evolved
level 47 team losing to level 32-34. Tracing it showed no single broken
mechanic -- Focus Sash fires once and correctly, damage in both directions is
sane, terrain applies -- so the cost is spread across a long fight with four
Volt Switch users, two healing moves, Intimidate and permanent Electric Terrain.
That fight is the next thing to dig into.

The 90% exit threshold at +2 levels is probably not reachable: Misty, Surge and
Mt. Moon are hard fights for a random level-matched six, and a real player brings
a chosen team with items and TMs.

## Traps

**Verify that an edit applied.** Four evaluator fixes were reported, committed
and described in messages without ever being in the code, because Python string
replacement silently does nothing when the anchor does not match. The symptom
was weights appearing to have no effect at any value, including absurd ones, and
it cost hours of hunting a search bug that did not exist. Assert the change is
present before trusting a measurement.

**Check the benchmark's INPUTS, not just its discrimination.** The old generator
was validated by showing it separated the planner (59%) from a dumb baseline
(20%), and that test passed while it was feeding in level 44 Poliwags. A
benchmark can discriminate perfectly and still measure a situation that never
occurs. Look at the actual teams and fights it produces.

**One fight is not evidence.** 135 samples puts the standard error near 4 points,
so a 3-point gap between two settings is noise. This is why the depth question
needed 360 fights to answer.

**Call signatures.** `damageRolls(state, attackerKey, moveName)` takes three
arguments and returns `{noCrit, crit}`, not `rolls`. Passing a defender key made
every move in Surge's team read as "no damage", which looked exactly like an
engine bug for several minutes.

## Two orderings, each of which breaks the other's fight (2026-08-24)

The hard fights were attacked by making the exact search FIND lines faster
rather than by changing what it looks for. Two levers were built and measured
separately, on the assumption that both would help. Only one of them helps any
given fight, and each one destroys the other's result.

`tools/bench_hunt.js` is the instrument. It runs `RRExact.cleanWin` on the three
fights that fail across the board and reports found / decided / nodes per fight,
because a nine-fight win rate cannot tell "no clean line exists" from "the search
ran out", and that is the distinction this work turns on.

**The pairing table** (`rr-matchup.js`) solves every 1v1 up front and orders
switches by who wins the matchup. **The beam** tries only the first few ranked
actions per node. Same fight, same team, node budget only, no clock:

    MT. MOON ARCHER, team 2         verdict      nodes
      neither (the engine as was)   undecided   150,000
      pairing table only            FOUND 12T     4,279
      beam only                     undecided   150,000
      both                          FOUND 12T     5,065

    LT. SURGE, team 1               verdict      nodes
      neither (the engine as was)   FOUND 23T    86,776
      pairing table only            undecided   200,000
      beam only                     FOUND 23T    47,487
      both                          undecided   200,000

Read those two tables together. The pairing table is worth 35x on Mt. Moon and
is a **loss** on Surge, where the search finds the 23-turn line without it and
cannot find it at all with it. The reason is legible rather than mysterious: the
Surge line is won by setting up Growth twice on a Pokemon the table rates a poor
pairing, so a prior that ranks "wins the 1v1" highest steers away from precisely
the move that wins.

So neither ordering dominates, and the honest response is not to pick one. The
search now runs a **portfolio**: a cheap table-ordered pass, then a beam pass
without the table, then the plain exhaustive pass with the bulk of the budget.
Restarting under a different order cannot change which lines exist, so this is
free of soundness cost -- only the exhaustive pass may ever conclude, and its
configuration is the engine exactly as it was.

**Misty resisted everything.** Beam widths 2 through Infinity at horizons 10, 16
and 24, none found a line and none decided the question:

    beam 2      exhausts its tree in 242 nodes, finding nothing
    beam 3      exhausts in 1,223
    beam 5+     runs out of budget at 150,000

A narrow beam finishing that fast is worth reading carefully: it is not evidence
that Misty is unwinnable, it is evidence that the beam threw the winning lines
away. Misty remains undecided and is the open question.

**A caution this exercise earned.** The pairing table was built, tested, measured
on one fight, and looked like a 35x win. It took a second fight to discover it
also loses fights outright. `TUNING.md` already said one fight is not evidence;
this is the first time that rule caught something that would otherwise have
shipped as an unambiguous improvement.

## The ceiling was measured with a weaker search than the planner (2026-08-24)

`tools/ceiling.js` carried a private copy of the clean-win search, with a comment
promising it was kept identical to the real one. It had drifted: it ranked every
switch at `-1`, the rule `rr-exact.js` abandoned once the proved Surge line
turned out to attack on turn one and switch on turn two. It also graded "the
planner" by running `RRSolver`, which the app stopped asking two commits earlier.

So the oracle was answering with a worse search than the planner it was grading,
and every fight it called undecided was a fight a better search might have
settled -- which is the number the whole tool exists to report. It now calls
`RRExact.cleanWin` and grades `RRExact.planRoute`. **The 67% / 0% / 33% figures
recorded above predate this and should not be quoted until it is re-run.**

Team generation and battle selection now live in `tools/lib/harness.js`, shared
by both benchmarks, so the two cannot drift apart again.

## The portfolio was worse than every pass in it (2026-08-24)

Worth recording as a bug because it looked exactly like a tradeoff, and it was
measured as one for most of a session before anybody checked it against its own
components.

Same fight, same team, node budget only:

    LT. SURGE, team 1                  verdict      nodes
      the beam pass, run alone         FOUND 23T     7,423
      the plain search, run alone      FOUND 23T    86,776
      all of them, as the portfolio    undecided   300,002

A combination losing to each of its parts is not a tuning result, it is a
defect. The cause: `exhaustive` was being used for two unrelated questions --
"is this pass entitled to conclude that no clean line exists" and "does this
pass get the rest of the budget". The table-ordered first pass is full width at
full horizon, so it answered yes to the first, so it was handed the entire
budget, so the beam pass behind it never ran. Separating the two flags:

    LT. SURGE, the portfolio, fixed    FOUND 23T    22,585   (3.8x the plain search)

**The lesson is about the measurement, not the code.** Every earlier number for
the portfolio was real, reproducible, and meaningless, and it took comparing the
whole against its own parts to see it. When a combination underperforms, check
that it is running what you think it is running before concluding anything about
the ideas in it.

## Where the hard fights stand after the portfolio (2026-08-24)

`tools/bench_hunt.js 3`, 400,000 nodes and 60 s per fight, single threaded, the
same conditions as the baseline it is compared against:

                        witnesses found    median nodes-to-witness
      before                 2/9                    --
      after                  3/9                 4,279 (Mt. Moon)
                                                27,585 (Surge)

    per fight        before            after
      MISTY          0/3 undecided     0/3 undecided
      LT. SURGE      1/3               1/3, at 27,585 nodes against 86,776
      MT. MOON       1/3               2/3

Nothing was proved impossible in either run, so every failure is still a fight
that might be winnable. The Surge witness costs a third of what it did, and Mt.
Moon went from one team in three to two.

This is the single-threaded number. The app now deals the opening moves across
one worker per core, which multiplies the positions reachable in the same wall
clock rather than steering the search -- so the fights sitting just past a
60-second budget here are the ones most likely to fall in the app.

**Misty is the honest failure.** No beam width, no horizon, no ordering and no
budget tried so far has produced either a line or a verdict.
