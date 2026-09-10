# Double battles -- the agent's plan (opened 2026-09-10)

Not to be confused with `DOUBLES-SPEC.md` at the repo root, which is the
CALCULATOR page's 2v2 mode and is finished. This document is about the live
agent learning to play a double battle.

## Why now

James beat Erika on 2026-09-08 (Rillaboom / Meowscarada / Mega Venusaur /
Meganium / Electrode-Hisui, win, nobody lost). The level cap is 44. The next
three battles in the game are all doubles:

| order | trainer | cap | their four |
| --- | --- | --- | --- |
| 26 | GAME CORNER GUARD | 47 | Hypno, Aerodactyl, Granbull, Obstagoon |
| 27 | ROCKET HIDE. LEFT GUARD | 47 | Weezing-Galar, Slaking, Crobat, Dipplin |
| 28 | ROCKET HIDE. RIGHT GUARD | 47 | Talonflame, Shiftry, Toxicroak, Eelektross |

All three are "you minus 3/4" relative levels, four Pokemon each, two out at a
time, both of our slots ours to play. Doubles is not a feature request, it is
the next door in the run.

His team at cap 44 (max HP is the fingerprint):

    Accelgor 138        U-turn, Bug Buzz, Giga Drain, Yawn
    Granbull 155        Fire Fang, Thunder Fang, Jaw Lock, Play Rough
    Kilowattrel 129     Electroweb, Air Slash, Roost, Volt Switch
    Toxtricity 133      Poison Jab, Growl, Overdrive, Nuzzle
    Sandslash-Alola 133 Icicle Spear, Fury Cutter, Ice Shard, Metal Claw
    Gyarados 151        Ice Fang, Aqua Tail, Crunch, Leer

Live abilities still to be confirmed from the battle struct on the first
doubles turn (the party record only carries the PID slot). The listed
possibilities put Intimidate on both Granbull and Gyarados, Punk Rock on
Toxtricity, Volt Absorb or Static on Kilowattrel.

## James's decisions, 2026-09-10

1. **Build against the three Rocket guards**, in run order, as the rehearsal
   loop: he saves before the fight, the agent plays it, we fix and replay
   until it plays the way he wants. Same protocol as Surge s5.
2. **Partner battles are NOT COVERED.** Silph Co (Ariana & Archer with partner
   Brendan, cap 56) and Cerulean Cave (Giovanni with partner Lance, cap 80)
   give one slot to an NPC we do not control. Marked not done deliberately.
   **When doubles otherwise looks finished, REMIND HIM about this** -- his
   instruction, in his words: "if we ever get to a point where we think we
   have finished double battles remind me it."
3. **Zero faints is the target**, same bar as singles.
4. **About 10 seconds of thinking per turn.** Rank every joint action cheaply,
   then play the best 16 on the hidden game for real.

## Where the agent stands today

Singles from top to bottom. Measured 2026-09-10:

- **Actuator** (`tools/lua/agent_impl.lua`) ships `battler(MON)` and
  `battler(MON + SIZE)`, which are battlers 0 and 1, plus the bare species of
  battlers 2 and 3 as `b2sp`/`b3sp`. Its phase machine is
  wait -> await -> mv_open -> mv_pick -> settle, or sw_open -> sw_pick ->
  sw_confirm -> settle. **There is no target-selection phase**, and it answers
  one prompt per turn, not two.
- **Screen map** (`docs/SCREEN-MAP.md`) covers the action menu, move list and
  party screen. The target-selection screen is not mapped and neither is the
  forced switch.
- **Engine** (`rr-battle.js`) holds `side.active` as ONE index and
  `step(state, myAction, foeAction)` takes ONE action per side. 2831 lines
  built on that shape.
- **Enemy AI port** (`rr-ai.js`) scores one attacker against one defender:
  `plausible(state, key)` where key is "me" or "foe". No target choice, no
  doubles rules. `docs/RR-AI.md` says nothing about either.
- **Planner** is built on duels, one of ours against one of theirs.
- **Oracle** presses one action and reads battlers 0 and 1.
- **Today's behaviour**: `isDoubles(obs)` sees four battlers, the agent writes
  the hands-off marker, the actuator presses nothing, the panel says the fight
  is James's. Nothing breaks; he plays it.

What already exists and helps: every one of the 1074 moves carries a real
`target` field (834 selected, 63 allFoes, 25 allAdjacent, 11 special, 5
random, 4 foeSide, 1 ally), and the calculator has spread damage and focus
fire (`RRCritKO.targetsHit`, `analyseFocusFire`, `fieldForMove`).

**Naming trap, found 2026-09-10:** the dex calls a both-opponents move
`allFoes`; `RRCritKO.targetsHit` tests for `allAdjacentFoes`, the Showdown
name used by the calculator's own move objects. Feeding dex records straight
into that helper makes every spread move read as single-target, silently.

## The approach: the real game is the evaluator

**Do not port the engine and the AI to doubles.** Five separate measurements
in this project say more search loses and that the value model is the
bottleneck (depth sweep, RR_DEEP_SCAN, gameplan beam, arm C, arm D). A
doubles engine plus doubles AI targeting is the largest speculative build
available here, and it would produce a worse opponent model than the one the
hidden core gives us for free. The oracle is what actually won run 16.

So: enumerate joint actions, let the engine's damage numbers narrow them, and
play the survivors on the real game.

Arithmetic. Each of our two actives has about 4 moves times up to 2 targets
plus up to 4 switches, so 8 to 12 actions each, and 64 to 144 joint actions.
At 0.7 s a probe that is one to two minutes a turn played straight. Ranking
first on damage numbers and playing only the best 16, in parallel, fits the
10-second budget.

## Stages, each with its own acceptance test

**Stage 1 -- map the doubles screens.** Measurement only, nothing presses.
Needed: the controller pointer value for target selection, the target cursor
address, the order the two prompts arrive in, what B does on the second
prompt, the forced-switch flow when two faint at once, and confirmation that
battler 2 is ours-right and 3 is theirs-right. James's rule applies in full:
nothing presses a button before the screen is known.
*Accept when* the hidden core plays a complete doubles turn twice from one
save state and gets the same answer both times.

**Stage 2 -- see the whole field.** The actuator ships all four battlers and
says which slot is being asked; the observation and `teamsFor` build a 2v2
position.
*Accept when* the printed position matches a screenshot of the same turn,
Pokemon for Pokemon, HP for HP. Still nothing presses.

**Stage 3 -- the doubles oracle.** One call plays a joint action (two actions
plus their targets) on the windowless core and reports the real after-state.
*Accept when* two identical calls agree, and a hand-checked line matches what
the same line does live.

**Stage 4 -- advisor.** Rank every joint action on damage, play the best 16 on
the oracle, score the real after-states with the position score, print the
recommendation while James plays.
*Accept when* he judges the recommendations turn by turn on a saved guard
fight, the same way Surge was judged.

**Stage 5 -- let it press.** Only after stage 4 reads right, per fight, with
the same stand-down switch that exists today.

## Doubles knowledge the position score will need

- A fainted opponent takes no actions, so focus fire is usually worth more
  than one hit each. Removing one of their two removes half their offence.
- A spread move that hits both is worth about 1.5 times its single-target
  damage while both are alive (0.75 each). Toxtricity's Overdrive and
  Kilowattrel's Electroweb are the two he has, both `allFoes`, so neither
  hits our own partner.
- Intimidate lands on both of their actives, so it is worth double what the
  singles score gives it. Granbull and Gyarados both list it.
- Speed control protects two Pokemon at once: Electroweb's drop, Nuzzle's
  paralysis.
- Fake Out denies one of their two actions on the turn it arrives, which is
  worth more here than in singles. James's existing Fake Out rules stand.
- `allAdjacent` moves (Earthquake, Surf, Discharge) hit our own partner. None
  are on the current six, but the engine must know the difference before any
  team change.

## Outside the battle

In doubles the game leads with party slots one and two. That is an overworld
decision the agent cannot make from inside a fight, so the agent should print
a recommended party order before a doubles fight rather than try to fix the
lead pair by switching on turn one.
