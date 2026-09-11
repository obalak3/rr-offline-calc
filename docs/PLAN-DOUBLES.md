# Double battles -- the agent's plan (opened 2026-09-10)

Not to be confused with the CALCULATOR page's 2v2 mode (`docs/CALCULATOR.md`),
which is finished. This document is about the live agent learning to play a
double battle.

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
4. **About 10 seconds of thinking per turn.** His words: "if you are doing
   the best 16 per turn then the first option is good enough". The budget is
   his; HOW the turn is decided inside it is the open question below.

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

## What is settled about the approach

**The real game is the evaluator of the immediate turn.** The oracle plays a
joint action on the windowless core and reports the truth, which absorbs
everything an engine would have to be taught: Neutralizing Gas switching off
Intimidate and Volt Absorb, Dry Skin healing off an Aqua Tail, Sniper crits,
the AI's real target choice. **The engine and the AI port are not being
ported to 2v2.** Not because "more search loses" (that measurement was about
the planner's own lookahead with an optimistic model), but because the oracle
makes an engine unnecessary for the turn in front of us, and any deeper look
is cheaper as real rollouts than as a model.

**The doubles brain is a separate, small path.** The singles brain is three
thousand lines that assume one Pokemon a side; threading two actives through
it would break singles and not produce doubles. Shared and reused: party and
foe decoding (`teamsFor`, `speciesName`), the position score, the oracle
wrapper, the actuator, the panel. Nothing else.

**Arithmetic.** Each of our two actives has about 4 moves times up to 2
targets plus up to 4 switches, 8 to 12 actions each, 64 to 144 joint actions
minus conflicts (both cannot switch to the same Pokemon). Singles probes cost
0.7 s; a doubles turn has two decisions, target picks and four animations, so
expect 1 to 2 s. **The live oracle path is SERIAL today** (`rivals.map(a =>
runOne(a))` with execFileSync); parallel probing does not exist yet. This Mac
has 8 cores, 4 fast, shared with the emulator James is watching. Sixteen
probes at 1.5 s four at a time is about 6 s. The 10-second budget is
UNMEASURED until stage 3 measures it.

## The decision layer: DECIDED with James, 2026-09-10

This is the part the first draft decided alone ("rank every joint action on
damage, play the best 16") and it was wrong in two ways. The ranker IS the
value model in disguise: the 16 that hit hardest never include a switch, an
Electroweb, a Nuzzle or an Intimidate pivot, which rebuilds the "too focused
on killing" complaint of 2026-09-08 by design. And it sees one turn: against
these guards the danger is in turn two (Dark Void's sleep, Talonflame's
Tailwind, Neutralizing Gas standing), and a one-turn read cannot see that no
safe pair of moves is left next turn.

**Chosen: C with A as the floor.** Short lines with conditions, priced by
PLAYING them on the hidden core; the one-turn real check (A) runs before every
press as the safety net, with the next-turn removal read on the chosen
after-state. **Lines come from the agent's own doubles idioms first** (focus
fire, spread first, speed control first, Intimidate cycling, absorb switches);
James's words: "We can start off by letting the agent play. If it is making
mistakes I can mark it and we can fix it." Same loop as singles: he flags a
turn, we reproduce it from the archived snapshot, fix, replay the save. Typed
panel lines remain available and are priced the same way. Time: normal turns
must fit his ~10 s; the extra probes of longer lines are spent only when the
one-turn read finds no safe pair of moves.

The options as they were weighed, kept for the record:

**A. One turn, real, with a safety read.** Build the 16 as a portfolio (both
hit one target; split; each switch with the partner's best hit; each speed or
status move with an attack; the hardest hits fill the rest), play them for
real, score the after-states, then ask the calculator's focus-fire math
whether their two attackers can remove one of ours before it moves next turn,
and refuse those. Sees: this turn exactly, next turn's worst case roughly.
Cannot see: a two-turn idea (drop their speed now so both of ours move first
from now on, then focus fire).

**B. Two turns, real.** As A, then for the best few joint actions save the
after-state and play a handful of our replies for real. Sees turn two with
the AI's real answers, including what it does after Tailwind or Dark Void.
Costs roughly twice the probes. Still no idea longer than two turns.

**C. Lines, priced by playing them.** Plans the way James and the singles
agent think: "Electroweb and Overdrive this turn, then both onto Aerodactyl,
Gyarados in when Hypno drops" -- short sequences of joint actions with
conditions, generated from doubles families (focus fire, spread, speed
control first, Intimidate cycling, switch to absorb) and from James's typed
panel lines. Each line is priced by PLAYING it on the hidden core: a
three-turn line costs three probes, not a tree, because from a save state the
fight is deterministic given our actions. Sixteen lines of three turns is
about 48 probes, 15 to 20 s at four in parallel. The one-turn check of A stays
as the safety net before every press. Sees: the fight the way a person plans
it, verified on the real game. Cannot see: branches (a line is one path; if
the AI does something the line did not assume, it is re-priced next turn --
the singles plan-and-repair loop).

**D. Port the engine and the AI to 2v2 and reuse the singles planner.** The
most lookahead and the most risk: a 2831-line one-active engine, a
one-defender AI port, months of work, and an opponent model worse than the
hidden core's. Listed for completeness.

Whatever is chosen, the fallback when the oracle is unavailable (no snapshot,
timeout) must be stated in code, because in doubles there is no planner
underneath to fall back on. Options: the portfolio's calculator pick, or ask
James at the panel.

## Risks the first draft missed

- **No snapshot is written while the agent stands down.** The save-state
  write lives in the `await` phase; under hands-off the script returns before
  it. In a doubles fight today the agent stands down, so stage 1 has no state
  to measure from. Either James presses a save-state key at the first doubles
  action menu, or one small script change snapshots while hands-off. This is
  the first blocker.
- **Partner battles need active detection.** If the doubles path ever presses
  in Silph Co it will believe it controls a Pokemon it does not. Rule: in a
  partner fight the Pokemon in our right slot is not in our party. One
  comparison; must be in the code before stage 5, plus the dataset's "WITH
  PARTNER" string as the second reading.
- **The 0.75 spread modifier is verified against the calculator, not the
  ROM.** Stage 3's first hand-checked line measures it.
- **The position score is singles-shaped.** Importance comes from a 1v1 duel
  table; speed conditions are read against one opponent. Usable as a first
  cut (HP-weighted sum, kills, faints), to be adapted once the decision layer
  is chosen.
- **The 16 are the agent's whole field of view.** Whatever is not in the set
  the oracle plays is never checked. The composition of that set matters more
  than its size.

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
