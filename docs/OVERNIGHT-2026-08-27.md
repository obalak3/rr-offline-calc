# The overnight calibration run — what it measured

The live agent played **283 turns across ~35 fights** on five save states,
unattended, restarting fights by itself. It ended when mGBA's window closed
(the process survived with no window, so frames stopped); everything below was
already collected.

## The result that matters most

The opponent predictor, over 54 live turns where the opponent genuinely used a
move — its identity recovered from its PP afterwards, not assumed:

    decision byte 0x02000091      0/54
    ported AI model              41/54   (76%)

**The decision byte does not generalise.** Its 32/32 validation was real but
narrow: every label came from Surge-side states. Elsewhere it claims a SWITCH on
essentially every turn. This was flagged as a caveat when the byte was found,
and then built on anyway; the agent now detects it as stale and falls back.

**The ported AI model is genuinely good.** 76% here lands on the 75.5% the
offline scoreboard measured over 102 recorded decisions — an independent
confirmation, from live play against different trainers, of a number that until
now rested on a single fixture. That is the foundation `assumePrediction` needs.

It also scored 54% while allowed to "switch" to bench Pokemon that do not exist
(their bench is placeholders, since we cannot see it) and 76% once restricted to
moves. Modelling their real party is the obvious next gain.

## The damage model is fine

Ratio of actual damage to band MAXIMUM, 14 distinct observations:
median **0.92**, range 0.87–1.12. That is exactly the shape of a uniform roll
over 85–100% of maximum. Two apparent exceptions were both explained:

- **Hidden Power's type was lost.** A set rebuilt from RAM sees one move ID
  whose type comes from IVs, so it read plain "Hidden Power" and the calculator
  priced the default: measured 2.00x and 0.54x errors. AGENT-SIDE ONLY — the
  offline planner reads the type from the trainer file and was always right.
- **Burn residual was inside the damage number.** Damage was measured as HP
  before minus HP after across the whole turn, so a burn tick counted as part of
  the hit. Lanturn's Scald read 45 against a band topping out at 40: 40 + 5.

## The RNG draw order — NEGATIVE

No draw position within 64 of the action-menu seed is consistent with every
distinct observation. **A fixed offset is refuted**, not merely unconfirmed.

The 256/256 offline validation on isolated attacks stands. What does not hold is
advancing a seed captured at DECISION time to find the damage roll during a live
turn, because a turn consumes a varying number of draws that is not modelled.

I over-claimed the opposite early in the night on the strength of one row that
happened to fit. One row confirms nothing.

The blocker is not runtime: distinct observations stayed at three while rows
went 47 -> 198, because save-state replays are byte-identical.
**NEXT: read the seed at the moment of the damage calculation from a quicksave,
rather than trying to advance to it from decision time.**

## Known limitation

Voluntary switching does not execute. The party cursor byte 0x0203B0A9 is an
echo of the highlight, not the selection: writing it moves the highlight while
the game confirms whatever it really has selected, and it reads 0 on open
regardless. Grid navigation by real presses works (verified: "at slot 2 after 1
presses"), but the Shift confirmation still does not take. Switching is disabled
and a forced switch that fails three times restarts the fight — that hatch fired
19 times and kept the run alive.

## The offline planner's zero-loss Surge plan is REFUTED

Step 4 of `docs/PLAN-LINE-PLANNER.md` says every candidate plan gets
rollout-verified before it is believed. That step had never been run. It has now.

    REAL-DICE VERIFICATION of the combine.js plan, 30 episodes
      won:            0/30
      met the cap:    0/30
      deaths:         all six Pokemon, 30/30

The plan `combine.js` reports as losing NOBODY loses EVERYBODY, every time.

**The cause is a design flaw, not variance.** 30/30 identical outcomes is not
dice. `combine.js` walks their team in ROSTER order and prices each leg against
the accumulated HP cost of the legs before it. But the opponent chooses its own
replacement by matchup. Measured, 40 out of 40 samples:

    roster order predicts second:   Vikavolt
    who they actually send second:  Pawmot   (40/40)

So the hardest Pokemon on their team arrives SECOND, against a plan that
budgeted for it arriving fourth with three legs' worth of chip already spent
elsewhere. In the traced episode Pincurchin faints on turn 5, Pawmot arrives on
turn 6, and it beats Lilligant, Breloom, Mienshao and Victreebel in sequence.

This is exactly the failure the policy-table design was meant to prevent --
"their switching controls only the ORDER" -- but only EXECUTION was made
order-independent. The COST ACCOUNTING still assumes an order, so the HP budget
is spent in the wrong sequence and the feasibility check is meaningless.

The fix is not small: the combination search has to price each foe from the
positions it can ACTUALLY arrive in, which means searching over their
replacement policy rather than assuming a sequence. Their replacement choice is
at least predictable -- `chooseReplacement` is deterministic here, 40/40 -- so
it can be simulated rather than guessed.

Everything I said earlier about a zero-loss Surge line should be read with this
attached. The line was real at median rolls in the order it assumed; that order
does not happen.

## The planner, fixed to follow their real order

`pricePath` no longer rotates their team, and it now REPORTS who arrives after a
kill by simulating the replacement. `combine.js` follows that instead of walking
the roster, so different branches follow different orders -- which is correct,
because their choice depends on who we have out.

The honest answer that falls out:

    NO FEASIBLE COMBINATION from the order they actually play

at BEAM=12 and again at BEAM=30 / PER_NODE=12 / LIMIT=10. It is not search
width. Both runs reach ROUND 4 with branches alive and die at round 5: four of
their five can be killed inside the cap, and the last one beats whatever is left.

This is a better answer than the one it replaces -- a plan that claimed zero
losses and lost 30/30 -- but "not found" is not "impossible", and it should not
be read as the fight being unwinnable. James beats it losing one Pokemon. What
the search cannot currently express is the likely gap:

- ITEMS. No potion, no revive, nothing from the bag. A real run has them.
- Voluntary switching mid-leg, which the executor also cannot perform.
- Candidate shapes are still a handful of intents per foe, capped by LIMIT.

The next question worth asking is which of those three, added alone, makes a
line appear.

## A STATIC PLAN CANNOT SURVIVE REAL DICE — three experiments

Two real bugs were found and fixed in the combination search along the way:

1. It walked their ROSTER order. Their replacement is chosen by matchup: 40/40
   they send Pawmot second, where the roster says Vikavolt. `pricePath` now
   keeps their real order and SIMULATES who arrives after a kill.
2. Their dead came back to life. Each leg was priced from a fresh state, so the
   replacement simulation handed back Pokemon we had already killed -- one
   branch reached round five "facing" Manectric-Mega with Manectric-Mega in its
   own kill list. Their fainted are now carried between legs.

With both fixed, the search finds complete zero-loss combinations again. They
still do not survive:

    plan                                  real-dice result (30-40 episodes)
    median rolls, roster order            won 0/30,  all six dead
    median rolls, real order              won 1/30,  all six dead
    pessimistic damage taken, real order  won 0/40,  all six dead

Reading damage taken at the high roll -- the other half of the honest-dice fix
-- did not help. Two opposite dice assumptions both produce plans that die, so
the dice model is not what is wrong.

**The trace says what is.** The Pawmot leg was priced with Lilligant arriving
healthy. In play she arrives at 32%, because real dice moved the whole
trajectory, and the plan executes anyway:

    T6  Lanturn -> Lilligant      Pawmot Drain Punch   Lilligant enters at 32%
    T7  Lilligant Baby-Doll Eyes  Pawmot Ice Punch     Lilligant DIES

A fixed policy table has no way to notice the position has drifted from the one
it was priced against. Every leg after the first is priced against a predicted
state, and predictions decay.

**This is what James said at the outset:** "you are giving plans right now but
they will break, and you will need to recalibrate in a fight. Or you will need
to expertly bring in a pokemon. Or you will need to recalculate a path to kill
the pokemon." That is now a measured result rather than an intuition.

### What follows

The planner should not produce a script. It should re-price paths FROM THE
CURRENT POSITION every turn, which is what `pricePath` already takes an entry
state for. The combination search then answers "is there still a way through
from here", not "here is the sequence". The live agent's per-turn loop is the
right shape; it just has a greedy chooser where the path planner belongs.
