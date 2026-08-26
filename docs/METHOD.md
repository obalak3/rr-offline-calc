# What method is actually right, and why the project keeps thrashing

Written 2026-08-25 in answer to James: "We are constantly going back and forth
through tactics, and not progressing... I would much rather have the right
method and we can't yet fix the computing speed than something that shows good
in statistics but has no future."

He is describing a real pattern. Every uncertainty in this game has spawned its
own idea. Crits produced one design, ignoring crits produced another, median
rolls produced a third, AI ties produced a fourth. That is the signature of not
having decided what KIND of problem this is.

## 1. What kind of problem this is, stated exactly

A Radical Red singles battle, from our side, is a **Markov decision process**.
Not a game. The distinction is not pedantry and it is the root of the confusion.

- The state is fully observed (with the screen reader) and Markov: the next
  state depends only on the current one and both sides' actions.
- Our actions are a small discrete set, about nine per turn.
- **The opponent is not an adversary. It is a known stochastic policy.** CFRU
  computes scores and takes the argmax, breaking exact ties with
  `AIRandom() % numOfBestMoves` (`ai_master.c:360`). We have ported that. It
  does not model us, it does not adapt, it does not deceive.
- Everything else that varies -- 16 damage rolls, crits, accuracy, secondary
  effects, paralysis, sleep duration, the AI's tie coin-flips -- is a chance
  event with a KNOWN probability.
- The objective is a utility over terminal outcomes: won with nobody lost is
  best, won having lost k is worse in k, losing the fight is worst.

Everything in the previous paragraph is already true and already implemented.
Nothing in it is a guess.

## 2. The category error that caused the thrashing

Because the opponent is not adversarial, **there is nothing to prove and nobody
to prove it against.** Yet the project's central search is `cleanWin`, which
asks "does a line exist that wins with no luck at all", and its verifier
`certify` asks "does this hold under every outcome with nonzero probability".
Those are questions about an adversary who chooses the dice.

Nobody chooses the dice. The dice have a distribution, and the right question
about a distribution is an expectation, not a guarantee.

This single misframing explains every dead end recorded in this repo:

- **Proof mode makes luck-dependent wins invisible.** `maxroll` fires a
  secondary only when guaranteed or when it belongs to the OPPONENT
  (`rr-battle.js:1558`), so our 30% Scald burn never lands. James's clean win
  runs through a burn and a sleep. The search was structurally unable to find
  the line he actually plays, at any node count.
- **It makes the answer binary when the truth is a probability.** James has now
  played this fight eight times: no clean win in the first six, then one, with
  crits deciding it. "Is there a guaranteed clean line" has the answer NO and
  that answer is useless. "What is the best move and how often does it work" is
  the question with a useful answer.
- **The adversarial margin M was an attempt to patch this.** It exists because
  our AI port is incomplete, so it is MODEL uncertainty being handled as if it
  were an opponent's malice. Widening M to cover our ignorance branches at every
  turn and explodes; measured, 100% of positions in a Surge line have a runner-up
  within 3 points. Model uncertainty should widen a DISTRIBUTION, not spawn a
  minimax.

## 3. What follows, and it is not a new idea in this repo

If it is an MDP, the method is to estimate the action-value

    Q(s,a) = E[ utility | take a in s, then play on ]

and pick the best. The expectation is over the real chance distribution, which
means crits, rolls, paralysis, sleep length and AI ties are all handled by the
SAME mechanism -- they are just chance nodes with known probabilities. That is
the unification James is asking for. There is no separate crit design and roll
design and tie design; there is one distribution and one expectation over it.

`rr-mcts.js` already says this, in its own header, written 2026-08-23:

> the opponent is a known stochastic policy, which makes this a Markov decision
> process rather than a game, and MCTS is the right tool for it

**The project reached the correct conclusion, measured it once, and walked
away.** `docs/STATE.md` records the verdict: "lost on singles (56% against 60%)
and is kept only because doubles has 576 action-pairs per turn". It is loaded by
the harness, covered by tests, and wired into nothing.

## 4. Why that verdict does not survive scrutiny

The commit that shelved it also recorded the one number that matters:

    iterations   50    150   400
    clean win    47%   49%   51%

**Quality rises with budget.** And in the same commit: the incumbent proxy
search is FLAT in depth -- lookahead 2, 3 and 4 all land within noise, and three
separate targeted improvements each left it at exactly 81/135. One method
converts compute into quality; the other cannot. That is precisely the
distinction James drew between "the right method whose speed we can't fix yet"
and "good statistics with no future", and the project picked the second.

The 56%-vs-60% verdict is also untrustworthy on four independent grounds, every
one of which was established later:

1. **Sample size.** 45 fights. We established today that even 180 fights cannot
   separate a real effect from a dumb baseline (`bench_live`, where "my HP minus
   twice theirs" matched a considered value function). A 4-point gap on 45
   fights is noise.
2. **Invented terrain.** Measured 2026-08-23, before the discovery that the
   engine gave the AI PERMANENT weather and terrain. Every fight whose lead sets
   terrain was simulated with it up for the whole battle.
3. **Invented replacements.** Before the CFRU switch-in port. We proved today
   that this matters enormously: the Surge lossBudget-2 line is found at 8.1M
   nodes against the old invented heuristic and undecided at 9.8M against the
   real one. Pre-port numbers describe an opponent that does not exist.
4. **Confounded teams.** Generated teams, which `bench_mirror`'s own header
   warns conflates planner quality with team quality, and which James says is
   decisive in this hack: "if you didn't properly build the teams, Radical Red
   restricted won't help you at all."

A verdict resting on 45 fights, an invented mechanic, an invented opponent and a
confounded team generator is not a verdict.

## 5. The refinement: sample the future, enumerate the present

Plain MCTS has one real weakness here and it is worth naming rather than
glossing. The Nuzlocke objective is dominated by RARE CATASTROPHES -- a crit at
roughly 1/24 that takes a Pokemon out. Sampling estimates common outcomes well
and rare ones badly, and here the rare one is exactly what we care about.

But we do not need sampling for the rare events, because the ones that matter
are one turn away and there are few of them. So:

- **Enumerate this turn exactly.** The immediate outcome distribution is small
  once bucketed by consequence: does it kill, does it survive, did the crit
  land, did the tie go the other way. This gives a CALIBRATED number for the
  risk we are about to take, which is the sentence James asked for a month ago:
  "this plan works, but 7% of the time the move crits and your X dies".
- **Estimate the future by sampling.** Beyond this turn, precision is neither
  achievable nor needed; what is needed is a value that improves with compute.

That is one architecture, it handles every source of uncertainty by the same
mechanism, it is exactly calibrated where calibration is possible and honestly
approximate where it is not, and it converts compute into quality. It is also a
turn-by-turn method by construction, which is what the screen reader delivers.

## 6. What would make this wrong

Stated so it is falsifiable rather than a preference:

- If the opponent turned out to adapt to us, this would be a game and minimax
  would be back. It does not; the CFRU source is read and ported.
- If MCTS at a large budget still lost to the proxy search on a benchmark with a
  real opponent, real teams and a large sample, the scaling argument would be
  empty. That test has never been run -- every comparison predates the fixes.
- If the rare catastrophes turned out NOT to be one turn away, root enumeration
  would not cover them and the variance problem would return.

## 7. The one thing to do next

Re-run the MCTS-versus-incumbent comparison, at several budgets, against the
CORRECTED opponent and on `bench_mirror` (which controls for team quality). Not
to tune anything. To find out whether the only method in this repo that converts
compute into quality was discarded on a measurement that four later discoveries
invalidated.

---

# Checking the answer again: the shelved tool was not doing the thing

Instructed to doubt my own conclusion, I read `rr-mcts.js` rather than trusting
its header. The framework is right and the implementation does not implement it.
That matters more than the verdict it was shelved on, because it means the 51%
measured something other than the method being argued for.

## Three defects, each of which alone would sink it

**1. The rollouts are deterministic and use median rolls.** `runRollout`
advances with `{mode: "maxroll", risks: {roll: "median"}}`. So beyond the first
few plies there are no crits, no missed moves, and -- because `maxroll` fires a
secondary only when guaranteed or when it belongs to the OPPONENT
(`rr-battle.js:1558`) -- our own 30% burns never land. **The rollouts inherit
precisely the blindness that made `cleanWin` unable to see James's winning
line.** A method whose entire justification is "it samples the real
distribution" was sampling a deterministic, biased one.

The code defends this: "variance matters where the decision is made, near the
root, and the tree samples it there; twenty turns deep it is noise that the
average washes out." That is right about VARIANCE and wrong about BIAS. Median
rolls with no crits and no player secondaries is not noise around the truth, it
is a consistent shift away from it, and averaging more of it does not help.

**2. The rollout policy cannot represent the winning strategy.** `rolloutAction`
is a deterministic argmax over `damage / defender.curHP`, with status moves
scored a flat 0.05 because `damageRolls` returns null for them. Any attack doing
more than 5% of the target's remaining health beats Sleep Powder. So a rollout
will essentially never put anything to sleep, and a position whose value comes
from sleeping Pawmot is scored as though that option did not exist.

This generalises into the principle the whole question turns on:

> **A sampling method can only discover strategies its sampling distribution can
> generate.** A rollout policy with no support on status moves makes status
> strategies invisible, no matter how many iterations are run.

That is the same failure as proof mode's, arrived at by a different road. One
forbids the line by refusing luck; the other forbids it by never trying the
move.

**3. The rollout cache freezes one sample per position.** `rolloutCache` memoises
the leaf value on `positionKey`, justified by the rollouts being deterministic --
which they are, per defect 1. But if defect 1 is fixed and rollouts start
sampling, this cache turns N samples into 1 and the estimate stops converging.
The two are coupled: fixing the sampling requires removing the cache, and the
cache is there because sampling was removed for speed.

## What this does to the earlier conclusion

It strengthens it and narrows it. The framework argument stands on its own
reasoning: known stochastic opponent, known chance distributions, fully observed
Markov state, so it is an MDP and the answer is an expectation over the real
distribution. Nothing in the code changes that.

But "we already had MCTS and it lost" is now void on FIVE grounds rather than
four. Sample size, invented terrain, invented replacements, confounded teams --
and now the implementation did not sample the distribution it was supposed to be
sampling. The 51% is not evidence about the method.

## What the method actually requires, stated as conditions

Not "use MCTS". These are the properties any correct answer must have here, and
they fall out of the problem rather than from a preference for an algorithm:

1. **Expectation over the true distribution**, with crits, accuracy, secondary
   effects, paralysis, sleep duration and AI ties all treated as what they are:
   chance events with known probabilities. One mechanism, not one design per
   uncertainty.
2. **Full support in whatever generates candidate futures.** Every legal move
   must have nonzero probability of being explored, or strategies using it are
   invisible by construction. This is the condition both of our existing
   searches violate, in opposite ways.
3. **Anytime, and improving with compute.** The one property measured and
   recorded on both methods: MCTS gave 47/49/51% at 50/150/400 iterations, the
   proxy search was flat across lookahead 2, 3 and 4 and stuck at exactly 81/135
   through three targeted fixes.
4. **Exact where exactness is cheap.** The dangerous events -- a crit that kills
   something -- are one turn away and few. Enumerate them at the root for a
   calibrated number; sample only the future beyond, where precision is neither
   affordable nor needed.
5. **No unbiased-sample caching.** Memoising a stochastic estimate on position
   destroys convergence.

Condition 2 is the one that has never been satisfied by anything in this repo,
and it is the reason the same fight keeps being unwinnable by every method we
try.

---

# Third pass: two uncertainties are conflated, and it costs 3.5x per ply

Measured over 90 real Lt. Surge positions (every pairing of both teams at 100%,
60% and 35% health), enumerating one turn against the true outcome distribution:

    our legal actions                              9.0
    foe actions, TRUE distribution (argmax+ties)   1.44
    foe actions, margin set (RRAI.plausible, M=5)  5.08
    successors per turn, true distribution         19.8
    successors per turn, margin set                66.0

Two conclusions, and the second is the important one.

## Condition 4 is confirmed, decisively

One turn fully enumerated -- damage bucketed by consequence, crits, accuracy,
secondaries and AI ties all included -- is about **20 successors** against the
real distribution, 66 even against the inflated one. Exact enumeration at the
root is free. There is no reason to sample the current turn, ever, and every
reason not to: it is the turn whose risk we most need calibrated and it is the
cheapest one to get exactly right.

## The conflation: a margin is not a probability

`RRAI.plausible` returns everything within M points of the top score, and the
searches branch over it as though the opponent might do any of them. But CFRU
takes the ARGMAX and splits uniformly only among EXACT ties. A move three points
below the best is not something the AI does rarely; it is something the AI does
never.

So the margin set is not a distribution over what the opponent will do. It is a
confession about what WE do not know -- our port is 31 rules of roughly 880, so
our computed argmax might not be the game's. Those are different objects:

- **Chance uncertainty**: the dice, and the AI's genuine coin-flips. Known
  probabilities. Correct treatment is an EXPECTATION, and the branching is 1.44.
- **Model uncertainty**: our scoring may be wrong. Not a probability at all, and
  no probability can be honestly assigned to it. Correct treatment is a
  ROBUSTNESS CHECK on the action we chose -- "would this still be my move if the
  AI's second choice were really its first?" -- which costs one re-evaluation,
  not a branch at every ply.

Branching over the margin prices our ignorance as though it were the game's
randomness, and it does so multiplicatively. 3.5x per ply is 3.5^d: at six plies
that is about 1,800 times more nodes for a fight that is not 1,800 times more
uncertain. **This is a large part of why every search in this repo is
unaffordable**, and it is not a tuning parameter, it is a category error with a
measurable price.

Note that `winChance` already gets this right -- its `replies()` collects only
the tied-at-maximum set -- while `rr-solver.js` branches over
`plausibleFoeActions` in six places. The repo is inconsistent with itself about
what the opponent is.

## The corrected architecture, in one paragraph

At the root, enumerate this turn exactly over the true distribution: our nine
actions against the AI's 1.44, with damage bucketed by consequence and crits,
accuracy and secondaries included. That is ~20 successors, it is free, and it
yields a calibrated statement of the risk being taken right now. Beyond the
root, estimate by sampling with a policy that has support on every legal move,
so nothing is invisible by construction. Handle model uncertainty once, at the
end, by asking whether the chosen action survives the AI's second-best being its
best -- not by branching on it. Re-plan every turn from the observed state, so
the exact part is applied 25 times over a fight and the approximate part only
ever has to rank, never to be precise.

Every uncertainty in this game is then handled by exactly one mechanism, chosen
because of what kind of uncertainty it is rather than because of which feature
prompted it.

---

# Fourth pass: correcting my own number, and what survives

Told to doubt my own data, I re-measured the branching claim over the full
health range instead of three points. The claim was wrong in a way that matters.

    our HP    foe tie size (boss flags)   union over 3 flag sets   inflation
      100%              1.20                       4.50              3.75x
       80%              1.20                       4.50              3.75x
       60%              1.23                       4.50              3.65x
       45%              1.40                       4.50              3.21x
       35%              1.90                       4.50              2.37x
       25%              2.77                       4.50              1.63x
       15%              3.97                       4.50              1.13x
        8%              4.23                       4.50              1.06x

    mean across the range: 2.24, not the 1.44 I reported

I had sampled 100%, 60% and 35% -- exactly the healthy regime -- and quoted the
average as though it described a fight. It does not. **The opponent's true tie
count rises from 1.2 to 4.2 as our Pokemon is worn down**, for the reason found
earlier today: as a target weakens, more of the AI's moves become kill-capable,
they collect the same bonus, and the argmax set widens. So the branching factor
is smallest where nothing is at stake and largest where the fight is decided.

(I also caught a bug in the first version of this measurement: the union column
deduplicated by move NAME, collapsing every switch into one, so it compared
against a differently-counted quantity and reported the union as narrower than
one of its own members. Fixed by keying both sides identically. Two errors in
two passes on the same claim is a fair rate for numbers produced quickly.)

## What this does to the argument

**The category error stands, and is now better supported.** The margin set
inflates by 3.75x precisely where fights are NOT decided -- at high health,
where the AI is nearly deterministic and there is least to be uncertain about.
Where the fight is actually decided, at low health, the real tie set has grown
to meet it and the inflation falls to 1.06x. So branching over the margin buys
almost nothing where it matters and costs almost everything where it does not.
That is a worse trade than I described, not a better one.

**But the cost is smaller than I claimed.** 2.24 rather than 1.44 as the honest
mean, against a margin set of 4.50, is 2.0x per ply rather than 3.5x. At six
plies that is ~64x, not ~1800x. Still large enough to matter, and still a
category error, but I overstated it by more than an order of magnitude and
should say so.

**And a third uncertainty appears that I had folded into the second.** The union
is over three trainer flag-sets because per-trainer AI flags are ROM data absent
from our dataset. That is not the same as unported scoring rules. It is
resolvable rather than merely unknown: a gym leader is a boss, and using the
boss flags alone for a gym is a factual claim about the game, not an assumption.
So of the 4.50, most of the width is a data gap that could be closed for the
fights we care about, rather than an irreducible ignorance about scoring.

Three distinct things, then, each wanting a different treatment:

1. **Chance** (dice, crits, accuracy, genuine ties): known probabilities,
   treat as an expectation. Branching 1.2 to 4.2 depending on how hurt we are.
2. **Missing trainer flags**: a data gap, closable per trainer class. Do not pay
   3.75x for it on a gym leader we can identify.
3. **Unported scoring rules**: genuine model uncertainty, no honest probability.
   One robustness check on the chosen action, not a branch at every ply.

The architecture from the previous pass is unchanged; the numbers attached to it
are corrected, and the reason the conflation is expensive is now more precise
than "3.5x": it is that we pay most where we know most.

---

# Fifth pass: everything reduces to one problem, and we have already measured
# that both of our answers to it fail

## Turn-by-turn is not a compromise. It is optimal.

Worth stating because it has been treated as a practical concession forced by
the screen reader. It is not. In a Markov decision process, the optimal policy
is exactly the greedy policy with respect to the optimal value function:

    pi*(s) = argmax_a  E[ r + V*(s') | s, a ]

So "just tell me the best move this turn, every turn" is not an approximation of
planning. It IS optimal planning, provided V is right. There is no additional
power in producing a twenty-four turn script; a script is only a record of what
the greedy policy would have done if the dice cooperated, which is why every
script this project has produced broke at the first tie.

That collapses the whole question. Search depth, line-finding, proof, the loss
ladder, the margin -- all of it is machinery for one purpose: estimating

    V(s) = P(win with nobody lost | play well from here)

Get V right and the rest is one enumerated turn, which we measured as ~20
successors and therefore free.

## We have tried both standard ways to get V, and measured both failing

**Handcrafted V.** `rr-plan.js`'s race heuristic, and `RRMatchup.valueOf`.
Measured: the race heuristic has intransitive preferences and oscillated for
twenty turns; the matchup value function was beaten by "my health minus twice
theirs" in a null test, meaning the pairing table it was built on contributed
nothing detectable at n=9 fights. And the proxy search built on such an
evaluation was FLAT in depth -- lookahead 2, 3 and 4 within noise, three
targeted improvements each leaving it at exactly 81/135. A handcrafted V encodes
the strategies its author thought of, and is blind to the rest by construction.

**Rollout V.** `rr-mcts.js`. Measured today: its rollout policy scores status
moves a flat 0.05, so it never sleeps anything, and its rollouts run at median
damage with our secondaries suppressed. It cannot value a position whose worth
comes from sleeping Pawmot, because it never sleeps Pawmot in any sample. A
rollout V inherits every blindness of the rollout policy.

These are not two bugs. They are the same fact twice: **an estimate of V is only
as good as the strategies its estimator can represent, and both of ours were
given estimators that cannot represent the strategy that wins this fight.**

## Which leaves exactly three options, and only one has a future

1. **Search deep enough that V stops mattering.** If the search reaches terminal
   states, V is only needed at the horizon and its bias is irrelevant. Measured
   cost: at ~20 successors per turn with the true distribution, reaching turn 25
   is 20^25. Not a budget problem, an impossibility. Rejected.

2. **Keep handcrafting V and add the missing strategies by hand.** This is what
   the project has been doing all day: notice sleep matters, add a sleep term;
   notice ties matter, add a tie term. It is unbounded work, each addition needs
   its own tuning, and the null test says we cannot even measure whether an
   addition helped at the sample sizes we have. This is the "good statistics, no
   future" path James named.

3. **Learn V from experience against the fixed opponent.** The environment is
   unusually favourable for this and the reasons are specific rather than
   hopeful: the opponent is a FIXED, KNOWN, non-adapting policy, so this is
   ordinary reinforcement learning against a stationary environment rather than
   self-play against a moving target; the simulator runs at tens of thousands of
   steps per second; the reward is well-defined and terminal (won clean / won
   losing k / lost); and episodes are short, twenty to forty turns.

Option 3 is the only one whose quality is not bounded by what we thought to
encode. It is also the one that turns compute into quality, which is the single
property James asked to optimise for and the single property the shelved MCTS
demonstrably had.

## The version of option 3 that does not require a research project

Not "train a network and hope". The standard construction is iterated policy
improvement, and each half already exists here:

    search with the current V   ->  produces better decisions than V alone
    record what search decided  ->  train V toward those decisions
    repeat

The search half is the enumerated root plus sampling that we have already
justified. The V half starts as anything at all -- even "my health minus twice
theirs", which the null test showed is no worse than our considered attempt --
and improves from data rather than from someone thinking of a term.

Crucially this makes the sleep line discoverable rather than requiring it to be
known: search only has to stumble on sleeping Pawmot ONCE in any episode for the
outcome to be recorded, and V then learns that such positions are good, which
makes search reach them more often. Neither half needs to be told about sleep,
terrain timing, or tie-collapsing. Those are exactly the things we have spent
today hand-discovering one at a time.

## What would make this wrong, stated so it can be checked

- If the state cannot be featurised well enough for V to generalise across
  positions, learning gains nothing over a lookup table and the state space is
  far too large for a table. This is the real technical risk and it is a
  question about representation, not about the framework.
- If episodes against the real trainer set are too few to learn from, the data
  is insufficient. Mitigated by the simulator: episodes are generated, not
  played.
- If the opponent were not stationary, this would be self-play with all its
  instabilities. It is stationary; the CFRU source is read and ported.

---

# Sixth pass: the state is NOT Markov, and it explains the Bellibolt miss

Before defending the learning conclusion I checked its foundation: is the state
actually Markov? If the opponent carries hidden state we do not model, the MDP
framing is unsound and everything above it is built on sand.

It does carry hidden state.

## The mechanism, from the source

`ai_switching.c:1967`:

    static void CalcMostSuitableMonSwitchIfNecessary(void)
    {
        if (!gNewBS->ai.calculatedAISwitchings[gActiveBattler] && BATTLER_ALIVE(...))
        {
            CalcMostSuitableMonToSwitchInto();
            gNewBS->ai.calculatedAISwitchings[gActiveBattler] = TRUE;
        }
    }

and `CalcMostSuitableMonToSwitchInto` itself opens with

    if (gBattleStruct->monToSwitchIntoId[gActiveBattler] != PARTY_SIZE)
        return gBattleStruct->monToSwitchIntoId[gActiveBattler];

**The AI decides who it will send in ONCE and remembers the answer.** The
decision is therefore made at some moment which need not be the moment of the
faint, and it is evaluated against the position as it stood THEN.

## It predicts the one real observation we have

The Bellibolt miss has resisted every explanation today. Re-running our port
from different moments in the fight:

    at the faint (Pincurchin dead, Victreebel 90hp, -2 SpA)   -> Vikavolt
    at turn start (Pincurchin alive, full SpA)                -> Manectric-Mega
    the PREVIOUS turn (Lanturn out, Pincurchin alive)         -> BELLIBOLT

The game sent Bellibolt. A decision cached from an earlier turn -- when Lanturn,
not Victreebel, was the Pokemon it was scoring against -- produces exactly the
observed answer, and no other moment does.

## Why this matters more than one fixed prediction

**The battle is not Markov in the state we model.** Two identical-looking
positions can have different futures depending on what the AI decided earlier
and is still holding. That is a genuine violation, not a modelling nicety, and
it has three consequences:

1. **The state must be augmented.** Add the AI's cached switch target (and the
   flag saying whether it has been computed) to the state. With that included
   the process is Markov again and everything above this section stands. Without
   it, our simulator can diverge from the game at every faint, which is exactly
   the class of error that voided the Surge sheets.
2. **It explains a whole category of "AI randomness" we have been attributing to
   coin flips.** James described planning around a switch he had seen before and
   getting something else. Some of that is the genuine 50% tie in
   `ai_switching.c:2437`. But some of it is this: the answer depended on when the
   AI last looked, which depends on the history of the fight rather than its
   current state.
3. **It is testable at scale and we already have the data.** The recordings hold
   about forty replacement events across eight runs. Reading the foe's species
   from the frames -- the one reader step still missing -- turns this from an
   n=1 story into a real measurement. That is now the highest-value use of the
   screen reader, above anything to do with advice.

## What it does to the conclusion

It does not overturn it; it repairs a hole in it. An MDP requires a Markov
state, we do not have one, and the fix is to include the hidden variable rather
than to abandon the framework. Worth noting that this is a hole no amount of
value-function learning would have papered over: a learner given a non-Markov
state learns a blurred average over the histories that led there, and would have
been permanently confused about replacements for reasons no benchmark would
explain.

---

# Seventh pass: correcting the sixth, and a claim from the second

## The Bellibolt match was weak evidence and I presented it as strong

I tested FOUR moments in the fight against a field of four or five candidates,
and reported the one that matched as though it confirmed a hypothesis. With four
draws from a field that size, at least one match arises by chance roughly two
times in three. That is a multiple-comparisons artifact, not a result, and the
confidence in the previous section was unearned.

What survives is the mechanism, which is independent of the match:

    GetMostSuitableMonToSwitchIntoByParty:
        CalcMostSuitableMonSwitchIfNecessary();     // skipped if already computed
        option1 = bestMonIdToSwitchInto[...][0];
        if (option1 == PARTY_SIZE || party[option1].hp == 0)   // only if DEAD
            CalcMostSuitableMonToSwitchInto();                 // ...recompute

The replacement really is computed once and reused, and recomputed only when the
cached choice has died. So the decision can be older than the position it is
applied to. That is a fact about the source. Whether it explains our one
observation is unproven, and the test is the ~40 replacement events sitting in
James's recordings, not four hand-picked moments.

**Limitation recorded honestly:** I could not find where
`calculatedAISwitchings` is reset. It is not in `ai_switching.c`,
`battle_start_turn_start.c` or `battle_util.c`. Until that is found, the LIFETIME
of the cache is unknown -- per turn, per switch, or per battle -- and those imply
very different behaviour. I am not going to guess which.

## A claim from the second pass was wrong: the AI does adapt

I wrote, as the foundation of the MDP argument, that the opponent "does not
model us, it does not adapt, it does not deceive". The first two are false.
`battle_start_turn_start.c` carries:

    //Prepare switching anti-AI abuse
    gNewBS->ai.previousMonIn[i]       = 0xFF;
    gNewBS->ai.secondPreviousMonIn[i] = 0xFF;
    ...
    case ABILITY_INTIMIDATE:
        gNewBS->ai.switchesInARow[i] = 2;  //So the AI gets smart if the player
                                           //immediately switches out

The AI tracks which Pokemon we sent in on the previous two occasions and how
many times we have switched in a row, explicitly to punish switch-spamming. It
also carries its own `randSeed`. So it has memory of OUR behaviour and reacts to
it.

**Does this break the framework? No, but it changes what "the state" is.** The
AI is still a FIXED function -- it does not learn, its rules do not change, and
it is not optimising against us. A fixed policy that depends on recent history is
still a stationary policy over an augmented state, so this remains an MDP
provided the state includes what the AI remembers: its cached switch target, the
previous two Pokemon we sent in, and our switch streak.

The correction that matters is to the phrase, not the conclusion. "Not
adversarial" is right. "Does not model us" was wrong, and I had used it to argue
that no opponent modelling was needed. Some IS needed: not prediction of an
adaptive opponent, but bookkeeping of the variables it remembers.

## Consequence for everything above

The list of state we must track to be Markov now reads:

    the battle state we already model
  + the AI's cached switch target and whether it has been computed
  + previousMonIn, secondPreviousMonIn (our last two switch-ins)
  + switchesInARow (our switch streak)
  + possibly the AI's randSeed, which makes its "random" choices a deterministic
    stream rather than fresh coin flips

That last one is worth staring at. If ties are drawn from a seeded stream rather
than true randomness, then two runs from the same save with the same inputs
would produce the SAME "coin flips" -- which is testable against James's
recordings, and which would mean some of what we have been modelling as
irreducible chance is in principle predictable. I do not claim it is exploitable.
I claim we do not currently know, and that we have been assuming otherwise.

---

# Eighth pass: the seventh pass was wrong, and James's play caught it

I wrote that the AI adapts to switch-spam, retracting a premise the whole
framework rests on. James: "I have never had this happen."

He is right. Checked across all five AI source files -- `ai_switching.c`,
`ai_advanced.c`, `ai_negatives.c`, `ai_positives.c`, `ai_util.c`, about 570KB of
decision code -- plus `battle_util.c` and `battle_start_turn_start.c`:

    switchesInARow   appears 3 times, ALL WRITES, never read
    previousMonIn    appears 3 times, ALL WRITES, never read

They are dead state. Something writes them; nothing consults them. **I read
INTENT from a comment and reported it as BEHAVIOUR.** The comment says "so the
AI gets smart if the player immediately switches out", and the code that would
act on it does not exist in any file I can find. A comment describes what
someone meant to build, not what runs.

So the second pass stands as originally written: **the opponent does not model
us and does not adapt.** The MDP framing needs no repair on this count, and the
state does not need our switch history in it.

By contrast, the variables that ARE consulted:

    monToSwitchIntoId       39 mentions, ~36 of them reads
    calculatedAISwitchings  read in the guard at ai_switching.c:1970
    pivotTo, randSeed       read

So the CACHE finding survives -- the AI's chosen replacement is real state that
is genuinely consulted -- while the ADAPTATION finding does not. The distinction
is exactly whether the variable is read, and I did not check that before
reporting.

## The methodological lesson, which is the point of this pass

Three times today James's experience of playing this game has overturned
something I derived from sources or measurements: permanent terrain (invented
mechanic I accepted), the clean win being unreliable (I had assumed his
remembered win proved a reliable line existed), and now this. The pattern in my
errors is consistent and worth naming:

**I treat a plausible artifact -- a comment, a matching number, a suggestive
grep -- as evidence, without checking the one thing that would distinguish
evidence from coincidence.** A comment is not behaviour unless the variable is
read. A matching prediction is not confirmation unless you count how many
predictions you made. A slow benchmark is not a regression unless you check the
baseline you are comparing against.

For a system whose entire value is telling someone what will happen, that is the
failure mode that matters most, and the correction has come from outside the
data every time.

---

# Ninth pass: the AI's "coin flips" are a deterministic stream

Applying the eighth pass's lesson -- check that a thing is USED, not merely
present -- to the last loose end: the AI's `randSeed`. It passes the test.
`AIRandom()` is called throughout the switching and decision code.

`ai_util.c:45`:

    u16 AIRandom()
    {
        if (gBattleTypeFlags & BATTLE_TYPE_MOCK_BATTLE)
            return Random(); //Use regular random since AI vs AI isn't exploitable

        gNewBS->ai.randSeed = 1103515245 * gNewBS->ai.randSeed + 24691;
        return gNewBS->ai.randSeed >> 16;
    }

seeded once per battle at `battle_start_turn_start.c:681` with `Random32()`.

So every AI tie-break, every 50% switch decision and every 25% chance in the
game comes from a **linear congruential generator with known constants**, not
from the game's ordinary randomness. The author's comment is an admission: the
separate path exists BECAUSE the seeded one is considered exploitable against a
human player.

## What this does and does not change

**It does not change how we should plan.** The seed is drawn from `Random32()`
at battle start and is unobservable to us. Over an unknown, uniformly-distributed
seed, treating each tie as an independent uniform draw gives the correct
expectation, which is what an MDP needs. Our modelling is right.

**It does change three things we have been saying loosely.**

1. "Coin flip" is technically wrong. Within a single battle the outcomes are
   deterministic given the seed, and consecutive draws are related by the LCG
   rather than independent. The probability we compute is really "the fraction of
   seeds that produce a clean win", which is the same number but a different
   object, and it matters for anything reasoning about correlation between turns.
2. **It confirms the replay advice I gave James was right, for a reason I did
   not know at the time.** I told him battery-save reloads sample fresh dice
   while save states reproduce them. That is exactly right here: the seed is set
   at battle start, so re-entering the fight redraws it, while reloading a
   mid-battle save state restores the seed and replays the same AI decisions.
   Save-state scouting of a tie cannot work -- not because the tie re-rolls, as
   I said earlier, but because it re-rolls IDENTICALLY.
3. It means the AI's randomness is in principle recoverable. Each observed tie
   leaks a bit or two of a 32-bit state, and the stream also advances on calls we
   cannot see, so a battle does not leak enough to solve it from screen reading.
   I am not claiming this is exploitable. I am recording that it is not
   impossible in the way true randomness would be, and that the developer thought
   so too.

## Where the research stands after nine passes

The framework has survived every check I have been able to devise:

- It is an MDP: fixed non-adapting opponent (verified by the read-test after a
  false alarm), known chance distributions, fully observed state.
- Turn-by-turn greedy on a good value function is optimal, not a compromise.
- Enumerate the current turn exactly (~20 successors, free); sample beyond.
- The margin set is model uncertainty masquerading as probability, costing ~2x
  per ply where we know most and nothing where we know least.
- Everything reduces to estimating V, and both of our estimators are blind to
  the strategies that win, for the same reason: they cannot represent what they
  were not told about.
- One genuine gap in the Markov property remains: the AI's cached replacement
  target, which IS read (36 reads) and must be part of the state.

The one thing I would still not bet on is the sixth pass's claim that the cache
explains the Bellibolt miss. The mechanism is real; the evidence for that
particular explanation is four hand-picked moments and one match, which is worth
very little. The test is the ~40 replacement events in the recordings, and it
needs the foe's species read off the screen. That remains the single highest-value
next step, and it is a reader task rather than a search task.

---

# Tenth pass: the objective is mis-specified, and it makes us too cautious
# exactly where caution is worthless

Nine passes stress-tested the METHOD. None questioned the OBJECTIVE. It has an
error, and unlike most of what I have found today it changes what the advisor
should actually recommend.

## What is currently encoded

`rr-mcts.js` reward:

    clean win            1.0
    win losing k         0.40 / (1 + k)      -> 0.20 for one loss
    lost / unresolved    ~0.05 (progress-weighted)
    wiped                ~0.01

justified in the comment as: "in a Nuzlocke a lost battle usually ends the run".

## The premise is false for the player we are building this for

James resets. Across eight recorded Lt. Surge attempts, both of the wins that
cost a Pokemon were followed by a reset -- he reloaded and played it again. A
lost battle does not end his run. It costs him ten minutes.

If a dirty win is reset just as a loss is, then the two outcomes have the SAME
value to him, and the true utility is close to binary:

    clean win            1
    everything else      0

## Why this matters, quantified

With the current numbers, a certain win costing one Pokemon scores 0.20. So the
search prefers a GUARANTEED dirty win over any clean-win chance below 20%. Under
the binary utility it should prefer any clean chance above zero, because a dirty
win is worth nothing.

That is not a rounding difference. It is a sign flip in behaviour across the
whole 0-20% band, which is exactly the desperate positions where the choice
between playing safe and gambling actually arises. **In a position where the
clean win is slipping away, the correct play for a resetting player is to take
the highest-variance line that still has any chance, and the current objective
tells it to do the opposite.**

This is the same class of error as the proof-mode blindness and the rollout
policy: not a bug, a mis-specification that makes an entire category of correct
play unreachable. And it would never show up as a benchmark regression, because
the benchmark scores clean-win RATE, and a search that secures dirty wins loses
nothing measurable by trading away low-probability clean ones.

## The correction is a parameter, not a constant

I am not claiming binary is right either, and this is where I have to be careful
not to over-infer. Those eight attempts were a testing session in which James was
deliberately hunting a clean win to give me data. In ordinary play he may well
accept a death and continue -- a Nuzlocke without any accepted deaths is not
really the game being played.

So the honest statement is that **the relative value of a dirty win is a player
preference that is currently hard-coded with a false justification.** It should
be explicit and settable, because it materially changes advice:

    dirty-win value 0.20   play safe, bank the win, accept the loss  (current)
    dirty-win value 0.00   gamble for clean, reset if it fails       (resetting)

and the right value is a question for James rather than for a benchmark. It is
also the first thing on this list that could be shipped as a visible control
rather than a hidden constant, since the player is the one who knows whether he
is going to reset.

## What this does to the framework

Nothing structural. It is the reward function of the MDP, not the method for
solving it. But it is worth noticing that nine passes of careful reasoning about
HOW to search never once asked what we were searching FOR, and the answer had a
false premise sitting in a comment the whole time.

---

# Eleventh pass: the objective is not a count, it is an identity, and the player
# wants to choose the casualty

James, correcting the tenth pass: "A pokemon loss does not end the run for me.
Losing the WRONG pokemon ends the run for me. I am fine with losing a Golem, but
I am not fine losing a Kingambit. If a pokemon of mine has to die, I would rather
be able to pick which one it should be."

This breaks both objectives I proposed, and it is better than either.

## What is wrong with everything encoded so far

    rr-mcts reward:   0.40 / (1 + losses)      -- counts losses
    my tenth pass:    clean win 1, else 0      -- counts them at all-or-nothing

Both treat Pokemon as interchangeable. They are not. Losing the sixth-best
Pokemon and losing the linchpin score identically under a count, and that is not
a small distortion -- it is the difference between a run continuing and a run
ending, which is the only thing the player actually cares about.

## The correct shape

Each Pokemon carries a cost of losing it, set by the player, and the terminal
reward reads:

    lost the battle          0
    won                      1 - sum of costs of the Pokemon that died

with a protected Pokemon simply having cost 1, so losing it makes even a won
battle worth nothing. "Expendable" is cost near 0. The current count-based
reward is the special case where every cost is equal, which is exactly the
assumption James is rejecting.

Two consequences follow immediately, and both are behaviours the app cannot
currently produce:

1. **Sacrifice becomes a legitimate plan, not a failure.** If Golem is cheap,
   a line that trades Golem for a safe win is close to optimal rather than a
   0.20-scored consolation. The advisor should be willing to SAY "let Golem take
   this hit", which is a sentence it has no way to reach today.
2. **The risk-seeking conclusion from the tenth pass becomes conditional, which
   is more useful than it was.** Gamble hard to avoid losing Kingambit. Do not
   gamble at all to avoid losing Golem -- bank the win. A single scalar objective
   cannot express that; per-Pokemon costs express it exactly.

## "I would rather pick which one it should be" is a control, not just a reward

The second half of his sentence is a different request from the first and I do
not want to collapse them. He is not only saying the values differ; he is saying
he wants the CHOICE. That means the advisor should accept a constraint and plan
under it:

    "Kingambit must survive this fight."
    "Golem is expendable."

A constraint is not merely a weight. It prunes: any line where Kingambit faints
is dead, which makes the search cheaper rather than more expensive, and it
converts a diffuse preference into something the player states once and the app
respects for the rest of the fight. It also matches how he actually thinks --
he brought Hatterene specifically to control a tie, so he already plays by
imposing structure on the fight rather than by optimising a number.

## What this does and does not change

**The method is untouched.** An MDP takes an arbitrary terminal reward; making
it per-Pokemon changes what we compute, not how.

**The value function must carry more information.** Terminal states currently
collapse to "won, k losses". They now have to say WHICH k, so anything learned
or estimated has to keep the identity of the dead. That is a real requirement on
the representation, and it is the first concrete constraint anything has placed
on how V should be featurised.

**And the objective is now explicitly time-varying.** Which Pokemon matter
changes across a playthrough -- his examples came with "these are examples that
might change during the playthrough". So this cannot be a constant in the source
under any circumstances. It is an input, it changes between fights, and it is
the second thing today that turns out to belong to the player rather than to us.

---

# Twelfth pass: where the per-Pokemon costs come from, and the whole stack

James said the costs "might change during the playthrough". That is the clue
worth following, because a quantity that changes is derived from something, and
naming what it is derived from closes the last hole in the objective.

## The cost of losing a Pokemon is its contribution to the rest of the run

Why is Kingambit expensive and Golem cheap? Not because of stats. Because of
what is COMING. Kingambit answers threats in fights ahead that nothing else on
the team answers; Golem is replaceable in the roles it fills. When the upcoming
fights change, the costs change -- which is exactly the behaviour he described.

Written down, the battle objective's parameters are derivatives of the run:

    c_i  =  how much worse the REST OF THE RUN goes without Pokemon i
         =  V_run(team)  -  V_run(team minus i)

So there are two nested problems, and we have been conflating them:

    RUN level:     which fights are ahead, which Pokemon answer them,
                   what is worth catching, training and preserving
    BATTLE level:  given costs from above, play this fight

This is not an unwelcome complication. It is a structure that explains several
things at once:

- **Why the costs cannot live in the source.** They are a function of the
  remaining run, and the remaining run changes every gym.
- **Why James's "team composition helper" is the same feature, not a separate
  one.** "Look through the PC and say if you brought this it could solve this
  problem" is asking for V_run(team + candidate) - V_run(team). Same quantity,
  evaluated over a different choice. Build one and the other follows.
- **Why sacrifice can be correct.** If Golem's marginal contribution to the
  remaining run is small, spending it to secure a win is not a failure, it is
  the right trade, and only a run-level view can say so.

There is a circularity -- the run value depends on battle outcomes, which depend
on the costs, which come from the run value. It is the ordinary hierarchical
kind and it is resolved the ordinary way: approximate the run level coarsely
(can the remaining team still answer the remaining threats?) and let the battle
level be exact. We already have the machinery for the coarse part; that is what
the matchup table was built for, and coverage over FUTURE trainers is the job it
is actually shaped for rather than scoring the current position.

## The whole stack, stated once

Twelve passes, and I want it in one place so it can be attacked as a whole:

    PROBLEM      A Markov decision process. Verified: the opponent is a fixed,
                 non-adapting policy (the "adapts to switching" code is dead --
                 written, never read), all chance has known probabilities, the
                 state is observable via the screen reader.

    STATE        The battle, plus the AI's cached replacement target, which IS
                 read (36 sites) and makes the process non-Markov if omitted.

    OBJECTIVE    Terminal, per Pokemon: won is 1 minus the summed COST of the
                 dead, lost is 0. Costs are set by the player or derived as
                 marginal contribution to the remaining run. A protected
                 Pokemon is a constraint, which prunes rather than costs.

    UNCERTAINTY  Three kinds, three treatments, and conflating them is what has
                 made searches unaffordable:
                   chance (rolls, crits, ties)  -> expectation over the TRUE
                     distribution; foe branching 1.2 healthy to 4.2 nearly dead
                   missing trainer flags        -> a data gap; look it up, a gym
                     leader is a boss
                   unported scoring rules       -> no honest probability; ONE
                     robustness check on the chosen action, never a branch per ply

    METHOD       Turn by turn, which is optimal rather than a compromise: the
                 optimal policy is greedy on the optimal value function.
                 Enumerate THIS turn exactly (~20 successors, free, and it is
                 where the killing crits live). Estimate the future by sampling
                 with full support over every legal move.

    VALUE        The one hard problem, and both existing estimators are blind
                 to the strategies that win: handcrafted ones encode what their
                 author thought of, rollout ones inherit their policy's
                 blindness. Learn it against the fixed opponent, improving
                 search and value alternately, so the sleep line is DISCOVERED
                 rather than needing to be known.

## What I would still attack if I had another pass

The value representation. Everything above is settled enough to build on, and
the one genuinely open technical question is whether a battle state can be
featurised so that V generalises across positions -- because if it cannot,
learning degenerates to a lookup table over a space far too large for one, and
the whole stack rests on a step nobody has shown is possible here.

---

# Thirteenth pass: is the value learnable here? Data is affordable; features are
# the real question

The last open item. If a battle state cannot be represented so that value
generalises, the whole stack rests on an impossible step.

## The trap I nearly walked into

The obvious representation is the features we already compute: matchup costs,
coverage gaps, HP fractions, the things `RRMatchup.valueOf` uses. That would be
a mistake, and it is the same mistake for the third time today. **A value learned
over handcrafted features inherits the blindness of those features.** If nothing
in the feature vector can express "sleep becomes available once terrain expires",
then no amount of training discovers it -- the learner cannot represent the
distinction, so it averages over it.

Proof mode forbade the line by refusing luck. The rollout policy forbade it by
never trying the move. Handcrafted features would forbid it by being unable to
describe the position. Same failure, third road.

So the representation has to be raw enough for the structure to be discoverable
rather than pre-decided: HP fractions, status one-hots, boost stages, PP, field
and hazard flags, species and move identity. A few hundred numbers, none of them
encoding a strategy.

## Measured: generating experience is affordable

Full episodes played to termination, sampling the real outcome distribution
(`mode: "odds"`), single-threaded:

    episodes/sec         95
    steps/sec         1,873
    mean steps/episode 19.7
    100,000 episodes     18 minutes
    1,000,000 episodes  2.9 hours

Slower than I expected -- odds-mode forking costs roughly 14x the search's
maxroll stepping, which is the price of sampling the distribution honestly
rather than at median rolls. Still: hours, not weeks, and trivially parallel
across cores.

**Data volume is therefore not the bottleneck**, and that is worth stating
because it is the reason "just learn it" usually fails on hobby projects.

## Two properties of this problem that make it much smaller than it looks

1. **Uniform random play has FULL SUPPORT by construction.** A random legal move
   picks Sleep Powder about one time in nine. So the exploration condition that
   both existing estimators violate is satisfied for free by the dumbest possible
   policy. The sleep line is reachable in random play; it is only unreachable in
   our *clever* policies. That is a striking inversion and it is the strongest
   argument that learning can find what handcrafting could not.
2. **We do not need a general Pokemon AI.** We need V for ONE team against the
   specific trainers ahead. James's party is six known Pokemon; the opponent is a
   known trainer. That collapses the generalisation burden enormously compared
   to Showdown-style bots that must handle arbitrary teams. When the team
   changes, retrain -- which the numbers above say costs minutes.

## What I am still not sure of, stated plainly

The measured episodes averaged 19.7 steps under RANDOM play, which is shorter
than the ~26-turn fights James plays, because random play loses quickly. So the
figure above is the cost of generating BAD experience. Good experience -- longer
fights, guided by a partially-trained value -- costs more per episode, and how
much more is unmeasured.

And random play, while it has full support, has terrible sample efficiency for a
line requiring a specific five-turn setup. Reaching "survive the terrain, then
sleep" by chance is rare. The standard fix is exactly the alternating scheme
already proposed -- search with the current value, train on what search chose --
because search concentrates the sampling where value says it matters, and value
improves where search explored. Neither half needs to know about sleep.

That is not a gap in the argument so much as the reason the argument specifies
iterated improvement rather than plain supervised learning from random play.
