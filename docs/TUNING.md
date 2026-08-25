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

## The real team against Lt. Surge: still undecided, and now bounded (2026-08-24)

    party  Mienshao, Diggersby, Lanturn, Lilligant, Breloom, Victreebel, all L34
    foe    Pincurchin L32, Vikavolt L33, Bellibolt L33, Pawmot L33,
           Manectric-Mega L34

    6,000,001 nodes, 323 s, single threaded    UNDECIDED

Not found, not disproved, which is the same answer as the 3,000,002-node attempt
on 2026-08-22 -- but twice the budget and with the portfolio and pairing table in
place. Doubling the budget did not move it.

One number here is worth more than the verdict: this fight runs at **18,565
nodes per second**, against 2,500 to 3,800 on the generated benchmark teams. Per
node it is five times cheaper than the fights being used to tune the search, so
budget rather than time is what binds here, and a much larger run is affordable
-- 60 million nodes is under an hour single threaded, and the app now splits
across cores.

What this does NOT license is a claim that the fight is unwinnable. Nothing has
been proved impossible in any run recorded in this file.

## The ceiling, re-measured with the engine that ships (2026-08-24)

`node tools/ceiling.js 3 300000`, the first run since the oracle stopped using
its own stale copy of the search:

                                    was (stale oracle)    now
      a clean win EXISTS              12  (67%)          20  (74%)
      provably IMPOSSIBLE              0  (0%)            0  (0%)
      undecided (budget ran out)       6  (33%)           7  (26%)
      of the fights it COULD win      11/12  (92%)       20/20  (100%)

    per battle            possible / impossible / undecided | planner won
      BROCK                  3 / 0 / 0   | 3/3
      MISTY                  0 / 0 / 3   | 0/3
      LT. SURGE              1 / 0 / 2   | 0/3
      PEWTER / FALKNER       2 / 0 / 1   | 3/3
      ROUTE 22 RIVAL         9 / 0 / 0   | 9/9
      VIRIDIAN BRENDAN       3 / 0 / 0   | 3/3
      MT. MOON ARCHER        2 / 0 / 1   | 2/3

**The planner now wins every fight anybody has shown to be winnable.** It also
won a Falkner fight the ORACLE could not decide, which is why the per-battle
column beats the summary and why `missed` still reads 1: the two are counted
against different denominators. That reporting quirk is in `ceiling.js` and is
worth tidying, but it does not affect the headline.

Read the shape rather than the percentage. Judgement is no longer where anything
is lost -- **every remaining failure is a fight nobody has decided**, and nothing
in any run has ever been proved impossible. Misty is 0 for 3 on both sides of the
table: not merely unwon, undecided.

## Iterative deepening: measured, and it does not work here (2026-08-24)

The idea was to start the search shallow and climb, so short lines are found
first -- a genuinely better answer, since a 12-turn win exposes you to half the
critical hits of a 23-turn one. Rungs at 10, 16 and 24 turns:

    LT. SURGE, team 1                verdict      nodes
      one horizon of 24              FOUND 23T    22,585
      rungs at 10, 16, 24            FOUND 23T   178,592

Eight times worse. Surge's line is 23 turns long, so neither shallow rung can
contain it, and they cost 126,000 nodes proving that.

**The assumption iterative deepening rests on is false here.** It works when the
shallow tree is a small fraction of the deep one, which holds for a tall narrow
tree. This tree is wide and shallow: a 10-turn search on Misty already exceeds
150,000 nodes, which is as much as a 24-turn one. Depth is not what makes these
fights expensive; breadth is.

What survives is the useful half of the idea, going the other way. The search now
extends the horizon UPWARD, and only when the horizon is what stopped it -- the
full-width pass finished everything inside 24 turns and truncated. Then "no clean
line in 24 turns" is a fact and 32 is the next question. It is off unless a
caller names a ceiling, and it is inert on both hard fights, which is correct:
they are budget-bound, not horizon-bound.

## The five ability fixes cost the early game nothing (2026-08-24)

`tools/bench_early.js 15 '{"engine":"exact"}'`, after Rock Head, Magic Guard,
Serene Grace, Speed Boost, Magic Bounce, Skill Link and Iron Barbs all changed
how damage and turns are computed:

    won losing NOTHING   96/135  (71%)   identical to before
    won at all          105/135  (78%)
    2.17s per fight                      against 2.15 before

Expected, and worth having anyway: none of those abilities appears on a trainer
before the Surge cap, and the generated teams rarely roll one. The point of the
check was that the fixes touch the damage path, and a change to the damage path
that quietly moved the headline would have been very hard to find later.

## What the engine will get wrong LATER (2026-08-24)

Every measurement above is taken on the nine early battles up to the Surge cap.
There are 167 battles. `tools/audit_coverage.js` asks the question the benchmark
structurally cannot: across the WHOLE game, what do trainers carry that the
engine does not understand?

Speed problems announce themselves -- the search sits there. Coverage problems
do not: the engine simulates the mechanic it does not model as something
simpler, finds a clean line through the misunderstanding, and reports it with
exactly the same confidence as a real one.

**Moves are completely covered.** All 421 distinct trainer moves are known, none
is a status move simulated as doing nothing, and none has an unapplied
secondary. The move-effects work holds up across the whole game.

**Abilities had four real gaps**, invisible to every benchmark here because
nothing before the Surge cap carries them:

    Rock Head       16 uses, from Kanto Rematch    recoil was applied anyway
    Serene Grace    10 uses, from Johto Leaders    secondary chance not doubled
    Magic Guard      4 uses, from Mini Bosses      recoil was applied anyway
    Reckless         2 uses                        (damage only, calc handles)

Rock Head is the one that mattered. Head Smash recoils for half the damage
dealt, so the engine had **Mega Aggron beating itself to death** over a few
turns, and a search is entitled to "win" by waiting for an opponent that in the
real game never dies. Three Mega Aggrons appear in Johto Leaders. Both are fixed
with tests in `tools/test_battle.js`.

**Still open, ranked by how much they change a fight** (from the audit's list of
64 abilities neither the engine nor the calculator mentions, 183 uses):

    Skill Link             6 uses   FIXED: was three hits instead of five
    Speed Boost            4 uses   FIXED: turn order was wrong from turn two
    Iron Barbs             4 uses   FIXED: contact chip on our side was missed
    Magic Bounce           4 uses   FIXED: status moves now bounce back
    Moxie / Beast Boost   12 uses   left alone, and the reason is interesting

**Why Moxie was skipped.** It raises Attack whenever its holder scores a knock
out, and against the clean-win search it can essentially never fire: the moment
a trainer's Pokemon knocks out one of ours the branch is worth zero and is cut,
so the boosted state is never explored. It matters only on the `winChance` and
fallback paths, where losses are counted rather than cutting. Worth doing
eventually, worth nothing now.

**The direction of an error decides its priority.** Skill Link and Iron Barbs
both made the engine OPTIMISTIC -- it underestimated incoming damage by forty
per cent on a Cloyster's Icicle Spear, and missed chip damage on our own side
entirely. A planner whose whole job is to not lose a Pokemon can survive being
too cautious; being too hopeful is how a run ends.

The rest of the list is mostly genuinely inert in a battle simulation (Illuminate,
Frisk, Gluttony) or informational (Trace, Pressure). Re-run the audit before
each new stretch of the game rather than trusting this list to stay current.

**Method note.** The first version of this audit checked only our engine and
reported 173 missing abilities, nearly all of them damage abilities the vendored
calculator handles perfectly. A list that long is a list nobody reads, and the
four real problems were sitting in it undistinguished. It now searches both.

## The coverage prune does not fire (2026-08-24)

Plan step 4: cut a branch when some surviving foe cannot be beaten one on one by
anyone still standing. Built, wired into the beam passes only (it is unsound in
general -- a foe nobody beats alone can be worn down by several taking turns),
and measured on three fights against two teams:

    fight                    prune off        prune on
      MISTY t1               250,001 nodes    250,001 nodes
      MISTY t2               250,001 nodes    250,001 nodes
      MT. MOON t1              1,191 nodes      1,191 nodes
      SURGE t1                20,085 nodes     20,085 nodes

**Identical node counts everywhere**, so the cut never fired once. That is not
surprising in hindsight: it needs a foe that EVERY surviving Pokemon fails
against, and six of yours against three to five of theirs almost always leaves
somebody who can do the job. It would only bite on a nearly-lost position, which
in a Nuzlocke search is a position that was already cut for other reasons.

Removed. `RRMatchup.anyCoverageGap` is kept, tested, and unused: the pairing
table's ordering is where its value turned out to be. The turns-lower-bound
prune planned alongside it was not built, since the same objection applies with
more force -- it needs a bound that boosts can invalidate.

**Worth remembering as a pattern.** Ordering has been worth 10x to 35x on these
fights; both prunes proposed have been worth nothing. On this problem, deciding
what to look at FIRST beats deciding what not to look at.

## The whole game, measured for the first time (2026-08-24)

`tools/bench_game.js 1`, a deliberately small budget (30,000 nodes, 8 s) so the
shape shows through rather than the budget:

    segment            lvl   clean      won   undecided
      Kanto Leaders     80      1/7      1/7        4
      Johto Leaders     12      1/1      1/1        1
      Rivals            81      4/6      4/6        0
      Team Rocket       83      1/7      2/7        4
      Mini Bosses       83      1/5      2/5        3
      Indigo League     85      0/9      0/9        4
      Postgame         100      1/1      1/1        0

      overall                  9/36 clean, 16/36 undecided

**The Elite Four is 0 for 9**, and four of those nine are undecided rather than
lost, which is the same signature the hard early fights have: the search did not
fail to find a win, it failed to finish.

Read against the 71% clean on the early nine, this is the honest state of the
project: **the engine is good at the fights it has been measured on and unproven
everywhere else.** Every tuning decision in this file was taken on nine battles
out of thirty-six, all of them from the first tenth of the run.

Some of the gap is budget -- 30,000 nodes is a tenth of what the hard early
fights need, and a level 85 six-on-six is a bigger tree than a level 20 gym.
Some of it will not be. Re-run at a realistic budget before concluding either.

## Lt. Surge, real team, 56 million nodes: still undecided (2026-08-24)

    7 processes x 8,000,000 nodes = 56,000,007 nodes, 1,565 s
    UNDECIDED

Nine times the budget of the 6M single-threaded attempt, at 38-63k nodes a
second against 18.5k, with the pairing table and the portfolio in place. Five of
the seven shares FINISHED their openings and found nothing; two ran out.

So the answer is genuinely not close to the surface, and one more doubling of
compute is not obviously the thing that finds it. What the run does establish is
narrower and still useful: **most of the opening moves are settled.** Five
sevenths of the root is now known to contain no clean line, and the checkpoint
records which -- a resumed run searches only what is left.

This is the trigger the plan named for the reserve lever. Proof-number search is
now the candidate rather than more cores.

## The late-game benchmark was measuring the wrong fights, again (2026-08-24)

The first whole-game run reported the Elite Four at 0 for 9 and it was not the
planner. `bench_game` inherited the generator's species pool, which is hard-coded
to the Kanto lines a player might have before the third gym, so the Elite Four
was being fought by a **level 87 Pikachu, Electrode and Kingler** against
Zacian-Crowned, Iron Valiant, Great Tusk and Mega Lucario. The search proved
that unwinnable in 161 nodes and was right to.

**This file already records this mistake.** "The benchmark was measuring the
wrong fights (2026-08-23)" is about a base-stat filter that sent level 44
Poliwags into Lt. Surge. It was written down, the lesson was explicit, and it
happened again in a new form the moment the benchmark reached a part of the game
nobody had looked at. So it is worth stating as a rule rather than an anecdote:

> **A generated team must be the team someone would actually have at that point
> in the run, and reaching a new part of the game means asking that question
> again from scratch.**

Three things were wrong, of which only the first was obvious:

    species pool   Kanto lines only, at every level
    EVs            zero, at every level -- about fifty stat points at level 85
    items          Oran Berry, at every level

All three now scale with level, and **the early game is untouched**: below level
40 the pool, spread and item are exactly what they were, so every number
recorded above keeps its meaning. Verified by generating a level 36 team before
and after and getting the same six species.

**Now fixed too: TM and tutor moves.** Sets were built from level-up moves only,
so Medicham arrived at the Elite Four with Power Trick, Reversal, Recover and
Counter. `species.tmMoves` is a list of **TM numbers**, not move ids -- they run
0 to 125 and sort ascending, which is what gives it away -- and the dex carries
the lookup at top level as `tmMoves` and `tutorMoves`, 128 entries each. Read
straight as move ids they decode to nonsense (Medicham learning Gust and Horn
Attack), which is what made the first attempt call the format undecipherable.
Through the lookup, Medicham gets Close Combat, Zen Headbutt, Psychic, Brick
Break and Aura Sphere.

Late-game sets now take two level-up moves and two taught ones, so they keep the
STAB they grew up with and gain the coverage a player would have added:

    Aggron         Heavy Slam / Metal Burst / Superpower / Earthquake
    Appletun       Dragon Pulse / Energy Ball / Leaf Storm / Draco Meteor
    Crabominable   Close Combat / Gigaton Hammer / Protect / Substitute

Early game is untouched at every step -- pool, EVs, item and moves all branch on
level, and below 40 they are exactly what they were.

## Every hard fight in the game fails the same way (2026-08-24)

The Elite Four re-probed with a team somebody would actually bring (fully
evolved, trained, Sitrus):

       budget    verdict      nodes    horizon hit?
        50,000   undecided   50,001    no
       200,000   undecided  200,001    no
       800,000   undecided  800,001    no

Against 161 nodes and IMPOSSIBLE with the old untrained pool. So the trained team
is not obviously losing -- the search simply cannot settle it, and **the horizon
is not what stops it**, at any budget.

That is now the same signature everywhere: Misty, Lt. Surge on the real team at
56 million nodes, and the Elite Four all come back undecided, none of them
horizon-bound, none proved impossible. One failure mode, at every stage of the
game, and it is breadth.

Which tells us what the tree looks like. It is **wide and shallow, not deep**:
about ten actions a turn, four moves and up to six switches, over fights that
resolve in ten to twenty-four turns. Depth costs nothing; branching costs
everything. That rules some tools in and others out:

    ordering            measured 10x to 35x        the only thing that has worked
    parallel search     measured 3.4x              real, and already spent
    prunes              measured 0                 both attempts inert
    deeper horizons     measured inert             not the constraint
    shallower first     measured 8x WORSE          the shallow tree is not small

And it points at the one thing not yet tried: **the opponent does not branch.**
`cleanWin` asks the AI for a single reply, so the search is not a game tree at
all, it is single-agent pathfinding through a graph where only our choices
multiply. Game-tree machinery -- proof-number search, alpha-beta -- is aimed at a
shape this problem does not have. The tools that fit a wide single-agent graph
are better duplicate detection and better ordering, and duplicate detection has
never been looked at: the visited set keys on exact HP, so two positions one
point apart are explored twice over.

## Blurring near-identical positions: small, real, free (2026-08-24)

The diagnosis said the tree is wide and the visited set keys on exact HP, so in
a twenty-turn fight where HP drifts every turn almost nothing is ever revisited
and the transposition table has nothing to do. `positionKey(state, {hpBuckets})`
rounds HP into bands so near-identical positions get the same name.

Measured as a single beam pass with the whole budget, so bucketing is the only
variable:

    fight              buckets   verdict      nodes
      LT. SURGE         exact    FOUND 23T     7,584
      LT. SURGE            20    FOUND 23T     7,517
      LT. SURGE             8    FOUND 23T     6,174     19% fewer
      ELITE FOUR BRUNO  exact    undecided   150,001
      ELITE FOUR BRUNO     20    undecided   150,001
      ELITE FOUR BRUNO      8    undecided   150,001     no change

So it helps where a witness is findable and does nothing where it is not. Kept
at 8 bands, and the honest caveat is that this is **one fight's worth of
evidence** -- `TUNING.md` says elsewhere that one fight is not evidence, and that
applies here too. It is kept because the downside is structurally bounded rather
than because the number is convincing: bucketing runs only in the beam pass,
which is a lottery ticket either way, and the exhaustive pass behind it still
searches exact positions. A blurred pass that misses a line costs nothing that
the pass behind it does not recover.

**It must never reach a concluding pass.** Two positions in one band really can
differ -- one survives the hit, the other does not -- so a blurred search can
miss a line, and reporting "no clean line exists" on that basis would be the one
lie this module must not tell. `tools/test_exact.js` asserts both halves: that a
bucketed search finds what the exact one finds on a fight where both can, and
that any line it returns really does lose nobody.

## Hard fights with everything turned on (2026-08-24)

`tools/bench_hunt.js 2`, 300,000 nodes and 45 s, portfolio plus pairing table
plus bucketing:

    GYM LEADER MISTY      found 0/2   undecided 2
    GYM LEADER LT. SURGE  found 1/2   undecided 1   witness at 21,175 nodes
    MT. MOON ARCHER       found 2/2                 witness at  4,279 nodes

    witnesses found      3/6

Mt. Moon is now solved on every team tried, at a cost that was 150,000-plus and
undecided before any of this work. Surge's witness has come down from 86,776 to
21,175. Misty remains the one fight nothing has moved.

## Held items had gaps too, and one of them was dangerous (2026-08-24)

The ability audit found four real bugs, so there was no reason to assume items
were cleaner. They were not. `tools/audit_coverage.js` now covers them.

**Lum Berry, on seventeen trainer Pokemon, ate nothing.** It cures the status the
instant it lands, so the target loses no turn at all -- and the search was free
to build plans around a Sleep Powder the opponent shrugs off before it costs
them anything. This party runs **two** Sleep Powders. Fixed in `setStatus`,
which is the single door every status comes through: moves, secondaries,
abilities and hazards alike.

**Life Orb, on sixty-seven, had the upside and none of the cost.** The
calculator already applies its damage bonus, so leaving out the tenth-of-max-HP
recoil made those Pokemon simply tougher than they are. That direction loses
winnable fights rather than losing runs, but it is wrong either way.

**Rocky Helmet** is Iron Barbs in an item slot and shares its code.

### Detecting this properly took three attempts, and that is the lesson

    grep the sources           118 "gaps", nearly all imaginary
    probe with one Normal move 140 "gaps", worse -- a type item cannot show
    probe across 18 types      116, with the false positives that remain
                               explainable

Grep said Mystic Water, Sharp Beak and Chople Berry were unhandled. All three
are handled perfectly -- the calculator works from item DATA rather than named
branches, and Chople really does halve a super-effective hit from 110 to 55. An
audit that reports a hundred imaginary gaps is an audit nobody reads, and the
real ones drown in it.

What remains is a **triage list, not a bug list**, and it says so in the output.
The probe is one attacker against one defender, so anything needing a particular
target still shows: Eviolite wants something unevolved, resist berries want a
matching weakness. Confirm before fixing.

    Weakness Policy   10 uses   FIXED: +2 both attacks on a super hit

**Power Herb turned out to be a non-issue, for an interesting reason.** It skips
the charge turn of a two-turn move -- and two-turn moves are not modelled at
all. Solar Beam, Fly and Meteor Beam carry no charge mechanic, so the engine
already fires every one of them immediately, which is to say **it already treats
everybody as holding a Power Herb.** Adding the item would change nothing.

The real gap underneath is that charge turns do not exist, and its direction is
the safe one: the engine gives the opponent their damage a turn early, so it
thinks fights are harder than they are. That costs winnable fights rather than
losing runs, and fixing it means adding turn structure rather than an item, so
it is parked deliberately rather than forgotten.

Still open, ranked by whether the error flatters us or them:

    charge turns      ~10 uses  two-turn moves fire instantly     safe direction
    Booster Energy     14 uses  Protosynthesis and Quark Drive    mixed

**Flame Orb and Toxic Orb: fixed, and the reasoning was wrong first time.** They
were filed as "cancelling errors, low priority" on the assumption that Guts was
unmodelled too. Guts is modelled -- by the calculator, which was never checked
because grep found nothing. Measured directly, a burned Machamp with Guts hits
for 164 where a burned one without it hits 55 and a healthy one hits 110, so
Guts is correctly giving 1.5x AND cancelling the burn penalty.

That flips the priority completely. **Every** trainer orb is paired with an
ability that wants the status:

    Ursaluna, Obstagoon, Ursaring, Conkeldurr  Flame Orb + Guts        6
    Gliscor, Breloom                           Toxic Orb + Poison Heal 5
    Zangoose                                   Toxic Orb + Toxic Boost 1

So the engine was leaving an Ursaluna un-burned, therefore un-Guts-boosted,
therefore hitting at 110 instead of 164. Making the opponent a third weaker than
they are is the direction that ends runs.

**Poison Heal had to go in at the same time**, and this is why the two were done
together rather than one at a time: adding the orb alone would have had Gliscor
taking toxic damage where the real one gains an eighth of its health, a swing of
a quarter of its HP per turn, wrong in exactly the same dangerous direction the
orb fix exists to correct.

The lesson repeats today's other one. **Grep said Guts was unhandled; measurement
said otherwise, and the priority built on the grep was backwards.**

## Two gaps that closed themselves under inspection (2026-08-24)

Both were on the audit's shortlist and neither needed code, which is worth
recording so nobody spends a day building them.

**Mega evolution.** 127 trainer Pokemon hold a mega stone -- and 113 are already
listed with the mega SPECIES. `Aggron-Mega` carries 140 attack and 230 defence
against Aggron's 110 and 180, so the calculator is already fighting the mega
form. The stone is decoration on top of a Pokemon that has already transformed,
and the damage probe confirms it moves no number.

**Power Herb**, per above: the engine has no charge turns, so it already fires
every two-turn move immediately. Everyone effectively holds one.

The pattern in both: an item that looks unmodelled because nothing mentions it,
where the mechanic is really handled somewhere else entirely. Measure before
building.

## The fixes were verified against real trainer data, not just unit tests

Unit tests prove a mechanic works in a position built to exercise it. They do not
prove the mechanic ever fires in a fight anybody will have. Checked against Gym
Leader Blaine, who carries both:

    Exeggutor @ Lum Berry     Sleep Powder lands, status comes back null,
                              berry consumed -- the plan a search would have
                              built on that sleep is correctly refused
    Slither Wing @ Life Orb   attacks with First Impression and loses 23 HP,
                              which is exactly 238/10

Nine of the thirty-six fixed-level singles battles carry two or more of the
newly-modelled mechanics, including Koga, Blaine, Clair and three Victory Road
trainers. **None of them is in the nine-battle early benchmark**, which is why
every one of these bugs survived until the whole-game audit: the only early
exposure is a single Flittle with Speed Boost in the Falkner fight.

## Doubles is missing, not broken (2026-08-24)

Worth stating because it is the one place the app could have been quietly wrong
and is not. Selecting a double battle disables the advisor and says why:

> This is a double battle, and the advisor only understands singles. Nothing
> here models a second Pokemon on each side: no spread damage, no redirection,
> no partner. Rather than answer the 1v1 question and look confident about it,
> it stops.

`tools/test_advisor.js` asserts both that it refuses and that clicking anyway
produces no ranking. 27 of 167 battles are doubles, several of them before
Misty, so this is a real feature gap -- but it is a gap the user can see, which
is the only acceptable kind.

## Protosynthesis and Quark Drive were applied by nobody (2026-08-24)

Measured, not grepped: a Great Tusk in permanent sun dealt exactly 132 with
Protosynthesis and 132 without, and an Iron Hands on Electric Terrain dealt 176
either way. Neither the engine nor the calculator knew them.

22 trainer Pokemon carry one, and the spread is what makes this matter:

    GYM LEADER BROCK        Great Tusk @Booster Energy      <- the FIRST gym
    GYM LEADER LT. SURGE    Iron Treads, Iron Hands         <- under his own
                                                               permanent terrain
    ELITE FOUR BRUNO        four of them
    plus Sabrina, Koga, Blaine, Clair, Lorelei, Agatha, Lance, both rivals

Booster Energy triggers the ability with no weather or terrain at all, which is
precisely why trainers hold one, and 14 of them do.

**Modelled as one boost stage, which is deliberately an overestimate.** The real
ability gives 1.3x on the best stat (1.5x if that stat is Speed) and a boost
stage is 1.5x, so this hands the opponent slightly more than they really get.
That is the direction to be wrong in -- a planner that exists to avoid losing a
Pokemon should overestimate what it is facing -- and the alternative is teaching
every damage path a multiplier concept it does not have, for one ability.

Now 132 against 198 with sun or a Booster Energy, and the control ability is
unchanged.

**This one touches the early benchmark.** Brock is one of the nine battles, so
unlike every other fix today the 71% headline can genuinely move. Re-measured
below.

## Where the coverage audit ended (2026-08-24)

Verified by measurement, so the shortlist can be closed rather than left looming:

    Eviolite     Chansey takes 249 bare and 169 holding one   handled
    Shuca Berry  Magnezone takes 148 bare and 74 holding one  handled
    Chople Berry 110 bare, 55 holding one                     handled
    Mega stones  the SPECIES is already the mega form         not needed
    Power Herb   no charge turns exist; everyone has one      not needed

So the 112 items the triage list still shows are overwhelmingly probe artifacts:
one attacker against one defender cannot see an item that needs a particular
target. What genuinely remains is narrow and mostly safe-direction -- White Herb
restoring lowered stats, Black Sludge, Light Clay and Damp Rock extending
durations, Scope Lens changing crit rate rather than a damage roll.

**Final tally of the audit**, which began as a question about whether the engine
would work in fights nobody had benchmarked:

    moves        421 distinct, 0 gaps
    abilities    Rock Head, Magic Guard, Serene Grace, Speed Boost, Magic
                 Bounce, Skill Link, Iron Barbs, Rough Skin, Poison Heal,
                 Protosynthesis, Quark Drive                        11 fixed
    items        Lum Berry, Life Orb, Rocky Helmet, Weakness Policy,
                 Flame Orb, Toxic Orb                                6 fixed
    verified fine  Guts, burn halving, Eviolite, resist berries, type-boost
                   items, Choice items, Assault Vest, mega forms

Seventeen mechanics, none of which any benchmark in this repo would ever have
caught, because the nine early battles exercise exactly one of them (a Flittle
with Speed Boost) and Brock's Great Tusk.

The pattern worth carrying forward: **grep found imaginary gaps and missed real
ones in both directions.** It said Mystic Water and Guts were unhandled when
both work perfectly, and it could not see that Protosynthesis does nothing.
Every conclusion here that turned out to be right came from measuring the
mechanic, not from reading the source.

## Seventeen correctness fixes cost the early game nothing (2026-08-24)

`tools/bench_early.js 15 '{"engine":"exact"}'`, run against the engine after the
whole audit landed:

    won losing NOTHING   96/135  (71%)   unchanged
    won at all          105/135  (78%)   unchanged
    2.14s per fight                      against 2.15 before

    hardest, unchanged:  MISTY 15/15, SURGE 15/15, MT. MOON 7/15, FALKNER 2/15

The interesting part is Brock. Protosynthesis is the one fix that touches a
battle in this benchmark -- his Great Tusk holds a Booster Energy and now gets
its boost -- and **Brock is still 15/15 clean**. So the opponent got measurably
stronger in that fight and the planner still never loses anybody in it.

Read together with the audit: the engine became materially more accurate without
the planner becoming worse at what it already did. That is the outcome to want
from a correctness pass, and it is not the automatic one -- a fix that made the
opponent stronger could easily have cost clean wins.

## Electromorphosis, found by looking at the fight actually being played

Eighteenth mechanic, and it turned up by asking a different question from the
audit's: not "what does the whole game use" but "what is in the fight this save
is about to face".

**There are two Lt. Surge battles**, and they are different teams:

    Kanto Leaders   Pincurchin, Vikavolt, Bellibolt, Pawmot, Manectric-Mega
    Kanto Rematch   Iron Treads, Bellibolt, Rotom-Wash, Pawmot, Manectric-Mega,
                    Iron Hands

The Quark Drive bodies are in the REMATCH, not the gym fight, so the 56-million
node "undecided" verdict on the real team stands -- it was computed against a
correctly modelled opponent. Worth knowing before reading any result that says
"SURGE", since `bench_hunt` and `bench_early` both take the gym one and
`bench_game` takes both.

Bellibolt is in both, and it has **Electromorphosis**, which charges it every
time it is hit and doubles its next Electric move. Nothing in the stack knew it:
Discharge stayed at 48 damage where the real one hits for 96 on the second turn.
Half power on an opponent's attack is the direction that ends runs.

Applied to the damage rather than the move's power, because the calculator has
no concept of being charged. Doubling damage is a shade more than doubling
power, the formula carrying constant terms, so it errs very slightly toward a
stronger opponent -- the right way to be wrong.

## The whole game, measured properly for the first time (2026-08-24)

`tools/bench_game.js 2`, 120,000 nodes and 12 s per fight, against the engine
with all eighteen correctness fixes and correct late-game teams:

    won at all           33/72  (46%)
    won losing NOTHING   30/72  (42%)
    search undecided     41/72  (57%)
    7.52s per fight

    segment            lvl   clean      won   undecided
      Kanto Leaders     80     3/14     3/14       10
      Johto Leaders     12      2/2      2/2        0
      Rivals            81     9/12    10/12        3
      Team Rocket       83     7/14     8/14        8
      Mini Bosses       83     7/10     8/10        2
      Indigo League     85     0/18     0/18       18
      Postgame         100      2/2      2/2        0

**The Elite Four is 0 for 18 and every single one is UNDECIDED.** Not one was
decided and lost. That is the answer to the question this benchmark was built to
ask: the late game is a **compute** problem, exactly like Misty and Surge, and
not a capability problem. Nothing anywhere in this file has ever been proved
impossible.

**Read the budget before reading the number.** This run gives each fight 120,000
nodes and twelve seconds. The app gives 60 million nodes, no clock, and one
worker per core. So 42% is a floor produced by a deliberately starved
configuration, not an estimate of what the tool does for a player -- the
comparison that matters is the *shape*: 57% undecided says the search is running
out of time, everywhere, rather than reaching wrong answers.

The three segments that finish cleanly (Johto, Rivals, Postgame) are the ones
with smaller or lower-level teams. Cost scales with the size of the fight, which
is what a wide-tree diagnosis predicts.

## The third time this benchmark measured teams nobody would field (2026-08-24)

Species right, levels right, EVs right, items right -- and the **moves** were two
random level-up picks plus two random TMs. That produced:

    Medicham    Recover / Counter / Pain Split / Drain Punch   one attack
    Beheeyem    Guard Split / Power Split / Return / Toxic     effectively none
    Crabominable Close Combat / Gigaton Hammer / Protect / Substitute

Nobody walks into the Elite Four like that. **A Nuzlocke restricts WHICH Pokemon
you have; it does not stop you teaching them their best moves.** So a random
species with a chosen moveset is the honest model of a Nuzlocke team, and a
random species with a random moveset is not a model of anything -- which means
the 0/18 on the Indigo League was measuring a handicap the benchmark invented.

Sets above level 40 are now chosen: the strongest same-type attack first, then
the strongest attacks of DIFFERENT types for coverage, then at most one utility
move. Accuracy is priced in, because a 120-power move landing 70% of the time is
worse than a 90-power one that always lands and a player choosing moves knows
it. Deterministic, so the benchmark stays reproducible.

    Medicham    Focus Punch / Psychic / Energy Ball / Detect
    Magmortar   Overheat / Focus Punch / Steam Eruption / Leer
    Beheeyem    Synchronoise / Meteor Beam / Thunderbolt / Psychic Terrain

Early game untouched again, verified by the same fingerprint: `ec3d71803436a23f`
before and after.

**The rule, stated for the third time and hopefully the last:** every part of a
generated team is a claim about what a player would have. Species, level,
evolution, EVs, item AND moves. Getting five of six right still measures a team
nobody would field.

## Restricted mode bans player moves, and the generator ignored them (2026-08-24)

This save is on Restricted / Minimal Grinding, which is a rules change rather
than a difficulty setting, and it is **asymmetric**: the player loses a long list
of moves and abilities, the trainers keep everything. That asymmetry is exactly
why the AI's weather and terrain are permanent -- Pincurchin still has Electric
Surge, and the engine is right to model Lt. Surge's terrain as never expiring.

The generator was handing the player moves it cannot legally have: 20 of 240
generated Pokemon carried one, including Electric Terrain, Quiver Dance and
Toxic Spikes. Same class of error as the Poliwags and the level 87 Pikachu, in
the opposite direction -- this one flattered the player.

Now filtered, and banned abilities are swapped for their documented replacements
(Speed Boost to Infiltrator, Magic Bounce to Magic Guard, Moxie to Unnerve)
rather than left blank. Early sets change slightly too, since a level-up list can
contain a banned move, so the early fingerprint moves from `ec3d71803436a23f` to
`02727428303d05a6`. That is a correctness fix rather than a drift: the old sets
were illegal.

**Growth is not on the banned list**, which matters because the proved Lt. Surge
line sets up Growth twice and would otherwise have been an illegal line all
along.

Worth keeping in proportion, though: whether the planner wins Surge *with*
Growth is not the question. Whether it wins at all is.

## Every generated team in this project's history fought without abilities

The dex stores `names`, an array. The generator read `.name`. So this line, in
place since the commit that created the benchmark:

    ability: ability && ability.name ? ability.name : undefined

has silently produced `undefined` for **every generated Pokemon in every
measurement ever taken here.** No Levitate, no Intimidate, no Volt Absorb, no
Regenerator, nothing.

The trainers were unaffected -- their sets come from the community spreadsheet
with ability names as strings -- so the error was **one-sided**: it handicapped
the player and left the opponent whole. Every number in this file was measured
with the player's team missing a mechanic the opponent had.

It surfaced from an unrelated direction. `tools/counter_team.js` prints the team
it builds, and the ability column was a row of dashes. Nothing else in the repo
ever printed that column, which is why a bug this size survived a benchmark, a
ceiling check, a whole-game run and a coverage audit.

**Worth generalising:** the audit that found seventeen mechanics was looking at
what the ENGINE does with a team. This was wrong in the team itself. A tool that
prints its inputs would have caught it on day one.

**And there was a second layer under it.** With `names` fixed, 392 species of
1343 still came out with nothing, because ability id 0 is an EMPTY SLOT and more
than a quarter of the dex has one in the first position -- Mismagius keeps
Levitate in slot two, Tinkaton keeps Mold Breaker there, Beheeyem keeps Analytic.
Reading `abilities[0]` blindly is wrong even once the field name is right. Taking
the first slot that actually resolves brings it to **0 species without an
ability, from 1343**.

Both halves were invisible for the same reason: nothing ever printed the column.

**The app was never affected, and why not is the useful part.** The page reads
the BUILT dex (`upstream-calc/src/js/data/rr-dex-data.js`), where `build_dex.js`
has already normalised abilities into `{name, hidden, slot}` objects -- and
`rr-save.js` resolves them through a rule that `tools/test_save.js` asserts.
The harness reads the RAW snapshot (`data/rr-dex-data.js`) and normalises it
itself, badly. **The bug lived exactly where the test was not.**

`tools/test_harness.js` now covers the generator the way `test_save.js` covers
the importer: that every one of 1343 species resolves an ability, that no banned
move reaches a player team, and that a late-game team is six distinct fully
evolved Pokemon with trained spreads and at least two attacking moves each --
the four things that have now gone wrong in turn.

Left as future work rather than done now: the harness should read the BUILT dex
and delete its own normalisation entirely, which is the same unification that
fixed `ceiling.js`. Not done while a benchmark was running, and not urgent, since
the current normalisation is now verified correct rather than merely present.

## The first benchmark taken with the player's abilities working (2026-08-24)

`tools/bench_early.js 15 '{"engine":"exact"}'`, the first run after the three
ability bugs and after `bench_early` stopped generating its own teams:

    won losing NOTHING   96/135  (71%)   unchanged in total
    won at all          103/135  (76%)   was 78%
    1.70s per fight                      was 2.09

    hardest:  MISTY 15/15, LT. SURGE 14/15, MT. MOON 8/15, FALKNER 2/15

**The headline held and the composition moved**, which is the honest result.
Lt. Surge produced a clean win for the first time in this benchmark's history
(14 failures against 15), Mt. Moon lost one, and the whole thing runs a fifth
faster.

That the total did not move is explicable rather than suspicious: Misty and Surge
are 29 of the 39 failures and both are compute-bound, so handing the player its
abilities cannot help a search that never finishes. The fights that abilities
could decide were already being won.

**Three tools were found carrying private duplicates of shared logic today**, and
each silently refused a fix that had already been made and verified:

    ceiling.js   its SEARCH, ranking every switch at -1 like the old engine
    bench_early  its GENERATOR, still reading `ability.name`
    ceiling.js   its GENERATOR, the same

The middle one is the instructive case. Two full 135-fight runs completed after
the shared harness was fixed, both reported an unchanged 71%, and that looked
like evidence the abilities did not matter. It was evidence the fix had not
arrived. **A number that does not move after a fix you believe in is a claim to
check, not a result to accept.**

## Properties checked by measurement rather than by reading (2026-08-24)

    27 found lines replayed independently   all lose nobody, all finish the foe
    27 beam+bucket searches                 none falsely reported "decided"
     9 fights re-solved on warm caches      no cross-fight contamination

The last one matters because `positionKey` does not encode species, so a cache
surviving between two different fights could in principle answer one with the
other's reply. Deliberately leaving the caches warm across fights changed no
verdict.

## The correctness pass finally moved the number (2026-08-24)

`tools/bench_early.js 15 '{"engine":"exact"}'`, after roughly twenty fixes to
the engine, the AI model and the generator:

    won losing NOTHING   99/135  (73%)   was 96/135 (71%)
    won at all          103/135  (76%)
    1.85s per fight

Three clean wins that were not there before. Small, and it is the first genuine
movement in this benchmark for a long time -- every earlier "unchanged 71%" was
either a fix that had not reached the generator or a fix that could not help a
search which never finishes.

## Lt. Lance does not get easier with levels, and that breaks the level sweep

`tools/counter_team.js` sweeps the player's level apart to separate "the search
failed" from "the fight is genuinely that hard". Against ELITE FOUR LANCE it
separates nothing:

    +2 levels    undecided       +15 levels   undecided
    +8 levels    undecided       +25 levels   undecided

The reason is not the search. **At +25 levels -- a level 110 team against his
85 -- Iron Jugulis's Dark Hole still does 78% of our bulkiest Pokemon's maximum
HP.** Lance two-shots anything, however overlevelled, so a clean win may simply
not exist and no amount of searching will find one. Beam 1 and beam 2 EXHAUST
their trees (372 and 7,732 nodes) rather than running out of budget, which points
the same way.

His team is built for it, and the shape is worth recording:

    Aerodactyl @Focus Sash     Stealth Rock, Stone Edge -- survives one hit
    Melmetal @Assault Vest     Double Iron Bash
    Iron Jugulis @Booster      Dark Hole, Aeroblast -- the two-shot
    Dragonite @Weakness Policy Dragon Dance, Multiscale -- hitting it super
                               effectively hands it +2/+2
    Dialga-Primal              Roar of Time, Rest/Sleep Talk
    Salamence-Mega             Dragon Dance -- and the AI's top pick, scored 103

**So the level sweep is the wrong instrument for endgame bosses.** It works on
the early gyms, where more levels really do make a fight trivial, and it tells
you nothing where the opponent's damage does not scale with your bulk. Validating
the search needs a fight where a clean win is DEMONSTRABLE, which means working
up from fights already solved rather than down from the hardest fight in the game.

Also worth noting for the counter-team builder: picking on type matchups is the
wrong axis against an opponent who two-shots you regardless. Bulk and speed are
what matter there.

## Mirror matches, and the exact search losing to the heuristic (2026-08-24)

`tools/bench_mirror.js` gives us exactly the opponent's team -- same species,
levels, moves, items, abilities -- plus one level to break speed ties. Every
other benchmark confounds the planner's skill with the team it was handed; a
mirror removes the team entirely, so what is left is whether our side chooses
better than a one-ply scorer with no lookahead.

**The bare bones work.** Early game, 8 of 9 clean, and the two fights that fail
against random teams fall cheaply:

    LT. SURGE      clean win in    206 nodes
    KOGA (6v6)     clean win in     85 nodes
    MT. MOON       clean win in     75 nodes
    MISTY          clean win in 12,859 nodes

**A true mirror is the harder side to play**, which is worth knowing before
reading any of it: this engine hands every speed tie to the opponent, so with
identical Pokemon we move second forever. All three 2v2 Rival fights came back
"no clean line exists" at parity and are won in 19 to 32 nodes with one level.

### The finding that matters: Brock

    exact search    undecided at 200,000 nodes, at maxTurns 24, 32 AND 40
                    (the horizon is never even reached)
    weighted search WINS, LOSING NOBODY, in 16 turns

Replayed independently against the AI's real replies: 16 turns, zero losses, all
four of his Pokemon down. **A clean line exists and the exact search cannot find
it** -- so this is not a hard fight, it is a search failure, and it inverts the
premise the architecture rests on. `TUNING.md` above says "searching exactly
beats scoring positions"; here the heuristic beats the exhaustive search outright.

Why Brock specifically is legible from his team: two Sturdy users, Berry Juice,
Protect and a Custap Berry Self-Destruct. Nothing dies to one hit, so **no move
ever registers as a kill** -- and `ordered()` ranks kills first, damage second,
switches last. With no kills available the ordering degenerates to raw damage,
while the line that actually wins is patient and switch-heavy: four Gyro Balls,
a pivot, four Bulldozes, another pivot. The winning move is almost never the
hardest-hitting one.

That is a concrete, reproducible target rather than a vague "make it faster",
and it is the first time a fight this project fails has been shown to be
winnable by something already in the repo.

## Why Brock could not be found, and the beam that was not a beam (2026-08-24)

James asked the right question: the exact search is exhaustive, so with enough
time it must find the 16-turn line the weighted search already found. Why does
it not?

**Measured first.** Brock's mirror, plain exhaustive search, no hunt passes:

    200,000 nodes    undecided
    1,000,000        undecided
    4,000,000        undecided     (2.5 minutes)

So it is not close. And the reason is not that the winning move is buried --
Rock Tomb sits **second of seven** in the ordering, right behind Bulldoze. The
problem is what depth-first does with that: it takes Bulldoze and explores
everything underneath it before ever trying Rock Tomb, and everything underneath
Bulldoze is about 7^15, roughly 4.7 trillion positions. **The search never gets
past its first guess.**

Both mechanisms that normally make this affordable are defeated by this
particular fight:

    the Nuzlocke cut       abandons any branch where one of ours faints. Brock's
                           mirror has two Sturdy users and Berry Juice, so almost
                           nothing dies and almost nothing is cut. Being hard to
                           kill makes the search HARDER.
    the transposition      catches repeated positions. This is a long grind where
    table                  HP drifts a point or two every turn, and HP is part of
                           a position's identity, so almost nothing repeats.

**And checking that turned up a real bug.** The portfolio exists to hedge against
exactly this -- a beam pass that reaches deep quickly instead of drowning in one
branch. The beam was 8. A 4v4 has **seven** legal actions:

    Math.min(7, 8) = 7      the beam restricted nothing

So in every small fight the portfolio was a matchup-ordered pass, an identical
unrestricted pass, and the exhaustive one: two of three passes doing the same
work. The hedge built for Brock's situation was inert in it.

Beams are now a FRACTION of the branching factor (0.4, floor of two), so they
narrow in a 4v4 as well as a 6v6:

    Brock mirror, before   undecided at 4,000,000 nodes
    Brock mirror, after    CLEAN WIN in 23,796 nodes, and a 13-turn line --
                           three turns SHORTER than the weighted search's 16

Early-game mirrors go from 8 of 9 to **9 of 9**.

## The cheap-witness probe, and why it is off by default

If the weighted search produces a line that loses nobody, that line is a witness
and the exact search need not rediscover it. `planRoute` can run it first as a
probe. On Brock it turned 200,000 fruitless nodes into a clean line in 269 ms.

It is **opt-in** (`probe: true`) rather than the default, because measuring it
exposed the cost: on a fight that genuinely certifies, the probe returns
`line-found` with no certificate where the real search returns `certified`. It
trades a provable answer for an unprovable one to save 200 ms, and it does it
silently. The idea is sound for the case it was built for; it needs to certify
the line it borrows before it can be the default.

## Ordering by the weighted evaluator: measured, and parked (2026-08-24)

James's proposal, and the natural synthesis: the weighted search has judgement
and no search, the exact search has search and crude judgement, and ordering is
the one place they combine without either's weakness mattering -- a wrong order
costs time and can never change which lines exist.

Built it (`valueOrder` on a pass, `RRSolver.positionValue` exported) and measured
it on mirrors, where the team is not a variable. As a REPLACEMENT for damage
ordering:

    fight            damage ordering       evaluator ordering
      BROCK          undecided, 200k       undecided, 200k  (43% slower)
      LT. SURGE      win 23T,  238 nodes   win 14T,  120 nodes   5.6x faster
      MISTY          win 18T,  358         win 21T,  360        neutral
      FALKNER        win 11T,   56         win 24T,  115        2x worse
      BRENDAN        win 11T,   50         win 11T,   50        identical
      MT. MOON       win 15T,   82         win 15T,   76        marginal

**It did not crack Brock, which was the entire motivation.** Large win on Surge,
real loss on Falkner, neutral elsewhere -- the same shape as the pairing table,
where no ordering dominates. The per-node cost came out at about 1.4x rather
than the 2x predicted, so the estimate was pessimistic.

As an ADDED pass rather than a replacement, which is the safer design: **inert.**
Identical node counts on five of six fights, because the passes ahead of it
already find the line. Only Misty moved, slightly better (40,362 against 50,360)
with a slightly longer line.

**Parked, reachable only behind `valueOrder: true`.** The honest reason is that
the beam fix got there first: Brock went from undecided-at-4,000,000 to solved in
23,796 nodes an hour earlier, and with that in place the evaluator pass has
nothing left to contribute. The idea remains sound and the hook is in the code
if a future fight wants it.

**Worth keeping either way:** the search now has a second ordering available that
is cheap to try on any fight that resists, and `RRSolver.positionValue` is
exported, which is the piece that was missing.

## The full mirror sweep: 139 fights, every non-doubles battle (2026-08-24)

`tools/bench_mirror.js "" 250000 --all`, our team IS their team plus one level.
Run with the OLD absolute beam, so it predates the fix that solved Brock:

    clean wins    108/139  (78%)
    no clean line     3/139
    undecided        28/139

    won the fight at all   134/139
    actually LOST            5/139

**The two lines answer different questions and only the second is a verdict on
the planner.** A clean win is the Nuzlocke objective and some fights fail it on
merit -- Blaine and Clair come back "wins, losing 2", which is the fight won and
the objective missed. Losing outright, with the same team and a level in hand
against a one-ply scorer with no lookahead, is the planner and nothing else.

Five outright losses in 139 is the number to attack, and 28 undecided is the
number most likely to move: every one of them was measured with the beam that
did not narrow, and Brock -- which was in that category -- went from undecided at
four million nodes to a clean 13-turn win in 23,796 once the beam became a
fraction of the branching factor.
