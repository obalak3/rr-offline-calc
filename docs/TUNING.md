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

Still wrong, and parked deliberately: sets are built from **level-up moves
only**. A real late-game team is largely TMs and tutors, and Medicham arriving
at the Elite Four with Power Trick, Reversal, Recover and Counter is not a team
anybody would bring. The dex carries `tmMoves` and `tutorMoves`, but the arrays
are indices into a scheme that does not decode as plain move IDs -- mapping them
straight gives Medicham Gust and Horn Attack -- so decoding it is its own task.
**Until that is done, late-game numbers are a floor and not a measurement.**

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
