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
