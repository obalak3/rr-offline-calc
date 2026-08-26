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
