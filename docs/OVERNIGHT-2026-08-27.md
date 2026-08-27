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
