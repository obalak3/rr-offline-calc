# Working rules for this repository

A self-playing battle agent for Pokemon Radical Red, played under Nuzlocke
rules: the run is won only if nothing on our side faints. `tools/agent.js` reads
the live emulator's memory, decides, and presses buttons through a Lua actuator.
`tools/headless/oracle` is a windowless copy of the game used to *try* an action
before committing to it.

Every rule below is attached to a specific failure. None is generic advice, and
none should be softened without a measurement that contradicts it.

## Announce any file edit before making it

State what you want to change and why, then wait, in the same turn. This covers
source, docs, and throwaway diagnostics alike. James watches the live agent and
reasons about it while you work; an unannounced edit invalidates whatever he is
looking at. Reading, grepping, and probing archives need no announcement.

## Never predict the opponent

The whole design exists to avoid it. The agent does not guess their move: it
plays ours on a hidden copy of the real game and reads what actually happened.
Any component that quietly scores "their worst plausible reply" has reintroduced
prediction, and that has already cost a correct line once, when a switch was
ranked badly against a move the opponent's Pokemon could not legally benefit
from using.

From a save state the fight is a deterministic function of *our* action sequence
alone. This is single-agent search, not minimax.

## The determinism depends on how we press

Identical actions at nine different start delays give identical results, but
only through the oracle's own press path, which holds A until the screen
changes. A fixed-frame scripted press can register once or twice depending on
frame alignment and breaks the property everything here rests on. **Every probe
must go through the oracle's press path.**

## The hidden copy is legitimate only while it is invisible

Nothing may appear on James's screen. No second emulator window, no rewind in
the window he is watching. Loading a save state in the headless core is fine;
that is what the quicksave key already does.

## Live play is the only authority for outcomes

Offline tests do not call `buildState`, so they cannot see the class of bug that
actually breaks live play. They are crash checks. An offline suite once reported
a clean sweep while live play was failing, and sent a whole day's work at the
wrong target.

## Do not add mechanisms; make the existing ones agree

The recurring bug shape, found many times: two parts of the system keep separate
ideas of the same position. Candidate *generation* and candidate *pricing* each
built their own state, both against a full-health target, and that was one bug
in two places.

The live agent rebuilds state from RAM every turn and `B.createState` zeroes
everything, so anything tracked across turns (turnsOut, protectChain,
justEntered, boosts, PP, HP) is lost unless carried explicitly. Check this first
for any "it behaves badly live but fine offline" report.

## Constants must be derived, not tuned

Several fitted numbers already exist and are known to be fitted. Do not add
more. A stat move is not an improvement by itself.

## The complaint is the spec

When a failure is reported, find that exact position and reproduce it before
changing anything. Reports have twice been treated as topics rather than
positions, and both times the resulting work was aimed at something else.

## Zero faints is the objective, not a heuristic

Any branch that loses one of ours is dead, and so is everything below it. Above
the scoring arithmetic sits the death-last rule (`tools/lib/deathlast.js`): a
line where everyone survives outranks one where someone does not, whatever the
score. This exists because the arithmetic charges a faint about 60 while a
removal pays 1000, so the numbers will trade a Pokemon for a KO. In a Nuzlocke
they are not interchangeable.

## Prune by shape, never by one score across shapes

Forced independently four times. Ranking moves and switches together by damage
makes switches invisible, because a switch deals nothing on the turn it happens
and its payoff arrives two turns later. Give each kind of action its own budget:
moves ranked by damage, switches ranked by what they take on arrival.

Never prune the root. The root is the decision actually being made.

## The agent is a long-running process

Editing a file changes nothing until it restarts. The Lua side needs
`~/rr-agent/reload` touched. Hours have been lost to a fix that was never
running.

## Switching is not the problem; needless switching is

Never add a blanket switch penalty; it has been rejected twice. A plan may
switch as often as it likes provided it reaches a removal.

## Vocabulary

Prefer the game's own words in generated text: faint, KO, removed, survivors.
Never paste raw memory or RNG dumps into a transcript; process them in a script
and print a summary. Code identifiers stay as they are.

## Commands that must never be run

Loading `tools/agent.js` into an ad-hoc node process starts a second agent
against the running game. A hook in `.claude/hooks/` refuses this; do not work
around it.

## Where things are

    tools/agent.js              the live singles brain
    tools/doubles_advisor.js    the doubles brain
    tools/headless/oracle.c     the hidden singles copy
    tools/headless/doracle.c    the hidden doubles copy
    tools/lib/                  shared decision pieces
    docs/SCREEN-MAP.md          verified RAM addresses
    docs/PLAN-SEARCH.md         how planning is done, and what was rejected
    docs/PLAN-DOUBLES.md        the doubles plan, including what it does NOT cover
