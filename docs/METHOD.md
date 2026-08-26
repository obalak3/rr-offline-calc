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
