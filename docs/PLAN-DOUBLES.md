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

## Where it stands, 2026-09-14

**Stages 1 and 3 are done and stage 4 exists and has been measured.** Stage 2
(the live actuator) and stage 5 (letting it press) are not started, so the
agent still stands down in a double battle and James plays it.

The blocker recorded on 2026-09-10 -- no snapshot is written while the agent
stands down -- turned out not to matter: James had already saved two doubles
action menus himself. `RadicalRed.ss7` is the GAME CORNER GUARD (Hypno and
Aerodactyl, against Accelgor and Greninja) and `RadicalRed.ss8` is the ROCKET
HIDE. LEFT GUARD (Weezing-Galar and Slaking, against Claydol and Hitmonlee).
Everything below was measured on those two with nothing pressed on his screen.

| stage | what | state |
| --- | --- | --- |
| 1 | map the doubles screens | DONE, `docs/SCREEN-MAP.md` |
| 2 | actuator sees and answers both slots | not started |
| 3 | the doubles oracle | DONE, `tools/headless/doracle.c` |
| 4 | the advisor | first form done and measured |
| 5 | let it press | not started, needs 2 |

- **Stage 1** found the controller table at `0x03004FE0 + 4*battler` (the
  second question of a turn arrives on battler 2's entry, so watching only
  battler 0 sees a turn stop halfway), the target picker `0x090AB46D` whose
  cursor `0x03004FF4` holds a battler index and can be WRITTEN like every other
  cursor here, the fact that a spread move skips the picker, and the
  per-battler cursor arrays. Tool: `tools/headless/dscan.c`. Accepted: the same
  script twice gives the same frame count and the same HP.
- **Stage 3** is `tools/headless/doracle.c` and `tools/lib/doubles-oracle.js`,
  guarded by `tools/test_doubles_oracle.js` (18 checks, 0 failures: default and
  written targets including hitting our own partner, a spread move needing no
  target step, every switch arriving as the Pokemon asked for, a switch to
  someone already out refused, both sides switching at once, three identical
  calls agreeing). One full doubles turn costs about 1.1 s alone, and 0.3 to
  0.5 s per pair inside a batch of four to eight.
- **Stage 4** is `tools/doubles_advisor.js`. `--all` plays every legal pair and
  is the reference; the default plays a portfolio.

### The measurement that matters, and the decision it forces

Both fights offer 128 legal joint actions. Playing all of them takes 46 to 51 s
and is the ground truth. Three portfolios were measured against it:

| portfolio | ss7 | ss8 |
| --- | --- | --- |
| 14 pairs, ranked by move power | MISSED, 1035 against 1138 | -- |
| 24 pairs, every single action covered | MISSED, 1035 against 1138 | MISSED, 1032 against 1145 |
| the whole attack-against-attack product | FOUND 1138 in 15 s | FOUND 1145 in 27 s |

**Why the cheap ones lose, in game terms.** On ss7 the best line is Bug Buzz
and Water Shuriken both into Aerodactyl: it dies before it moves because Water
Shuriken has priority, and we take nothing. Ranked by power, Scald (80) beats
Water Shuriken (15), so a line costing 193 HP is offered instead. On ss8 the
best line is Extrasensory into Weezing-Galar while Fake Out FLINCHES Slaking,
for nothing; ranked by power, Brick Break (75) beats Fake Out (40) and the line
costs 90.

Neither priority nor a flinch is visible to any ranking, and neither lives in
either action alone. Both live in the PAIR. So the attack-against-attack
product is now played in full, and only switches and status moves are
represented by coverage.

**The cost is 48 to 57 pairs, and it FITS: 6.4 to 6.9 s a turn**, measured
twice on each fight at eight probes at a time, inside the roughly 10 s James
agreed to. It did NOT fit at first (15 and 27 s), and the difference was not
the portfolio: probes were running to the 6000-frame cap because a message box
holds the turn after a faint and nothing was answering it. Tapping A through
those messages, which the singles core has always done, ends each probe at the
next menu instead -- and makes the outcome more honest too, because the turn
now finishes rather than being cut off mid-resolution. So there is no budget
decision to re-take.

Nothing here is fitted to one fight: the second measurement was taken on the
fight the design was not built on, and it failed there first.

### Known gaps in the scoring, recorded rather than papered over

The advisor scores a real after-state with the singles formula: their HP
removed, a bounty per opponent removed, our HP lost, a charge per Pokemon of
ours that faints. It does NOT price their stat boosts going up, a Substitute
standing in front of them, sleep, or which of ours answers what, because
`position.js` is still one-against-one shaped.

### Conditions are now MEASURED, 2026-09-14 (doubles-position.js)

`tools/lib/doubles-position.js` builds a real 2v2 engine position out of the
oracle's observation -- each battler's species, level, moves, ability, item and
its REAL stats read off the battle struct -- and prices every condition the way
position.js does in singles, by measurement:

> a condition on THEIR side is worth the damage their real moves no longer do
> to our living Pokemon; one on OUR side is worth the damage our real moves no
> longer do to theirs; sleep is worth the turns lost. Nothing is worth anything
> for having a name.

The advisor adds the CHANGE in that value across the turn to its score, and
prints the terms. Two things it got right immediately on ss7:

- **An Attack drop on both of ours priced at zero**, correctly: Accelgor and
  Greninja are special attackers, so Granbull's Intimidate on arrival changes
  nothing measurable. That is James's own rule ("lowering the physical damage
  of a special attacker is just null") falling out of the measurement rather
  than being written down as an exception.
- **A three-turn sleep priced at -251 HP**, which is Greninja's own offence for
  the turns it loses. The line that reads "they lose 138 and a Pokemon, we lose
  17" fell from 1121 to 870 and out of the recommendation, because Dark Void
  had put Greninja to sleep behind it.

Two bugs were found and fixed on the way, both worth remembering: the struct's
sleep counter is turns REMAINING and counts down, while position.js's field of
the same name means turns lost so far, so mixing them priced a three-turn sleep
at zero; and folding the sleep term inside the horizon multiplier counted the
horizon twice.

**Importance landed the same day.** `fullState` decodes BOTH parties out of the
oracle's raw records, so `position.js`'s own answer table can be asked the
question it was built for: how many of their remaining Pokemon can this one of
ours remove cleanly. Nothing new was invented for doubles -- the same table,
the same question. It is measured once per position (about 0.7 s for the 6x6)
and reused for every probe, and the advisor now charges for WHO was lost rather
than for how many. On ss7 that reads Gyarados 3, Granbull and Skeledirge 2.5,
the rest 2; on ss8, Skeledirge and Gyarados 3 against Hitmonlee and Greninja
1.5. Neither recommendation changed, which is the right outcome: the weights
reorder what a mistake costs, not what a clean turn is worth.

`tools/test_doubles_advisor.js` pins all of it (14 checks): the two
recommendations, the coverage guarantee, the arrival guard, the time budget,
that Dark Void's sleep costs measured HP and ranks those lines below the clean
one, and that an Attack drop on a special attacker prices at nothing WHILE a
Sp.Atk drop on the same Pokemon prices as a real loss. The second half matters:
a zero proves nothing on its own.

### Playing a whole fight, 2026-09-15, and the defect it found

`tools/doubles_playthrough.js` takes the advisor's own recommendation, plays it
on the hidden game, feeds the result back in and repeats, so a plan that falls
apart on turn four shows up as a fight rather than as a turn. Opening well and
playing well are different claims and only the first had been checked.

**It immediately found a real defect.** The first run of the Game Corner guard
won in five turns but LOST ACCELGOR on turn three: it removed their Granbull
and paid a Pokemon for it, scoring 973, while "Accelgor U-turns out while Water
Shuriken chips Granbull" sat at 133 having taken 133 off them and lost nobody.

The arithmetic made that inevitable. Removing one of theirs is worth 1000;
losing one of ours costs 130 times its importance, about 260. So the agent will
ALWAYS trade a Pokemon for a kill, which is precisely backwards for the target
James set. Singles has had the answer since 2026-09-05 (`RR_DEATH_LAST` in
replan.js: a certain non-expendable faint ranks last) and doubles never got it.

Fixed the same way: **a line that loses nobody outranks one that does, whatever
the score**, with the score still ordering within each group and deciding alone
when every line loses someone (`RR_DOUBLES_DEATH_LAST=0` restores the total).
This is a statement of the objective, not a tuned constant.

**ALL THREE guard fights now play out won with SIX OF SIX STANDING**, each on
the team James built for it:

| fight | his leads | turns | standing | HP we lost | HP they lost | thinking |
| --- | --- | --- | --- | --- | --- | --- |
| Game Corner guard (ss7) | Accelgor + Greninja | 5 | 6/6 | 228 | 578 | 28.6 s |
| Rocket Hide. left guard (ss8) | Claydol + Hitmonlee | 5 | 6/6 | 98 | 591 | 33.6 s |
| Rocket Hide. right guard (ss3) | Greninja + Hitmonlee | 4 | 6/6 | 109 | 558 | 26.8 s |

Before the rule the first of those was 5/6.

**JAMES BUILDS A TEAM PER DOUBLES FIGHT**, chosen against that opponent -- his
words, 2026-09-15: "I change teams between every battle according to the enemy.
I made specific teams for each double battle." The three states carry three
different sixes and three different lead pairs, and that is deliberate, not
drift. So a test of the agent on any of these fights is a test against HIS
counter-team, and results do not transfer between them. The lead pair is his
decision too: the game leads with party slots one and two.

The third state was found rather than given. `RadicalRed.ss3` is saved on the
OVERWORLD, not at a menu, so the first scan missed it; tapping A on the hidden
core walked into the fight and showed Talonflame and Shiftry. `dscan --save`
now produces an action-menu state from an overworld one, which is how any
future fight can be set up without James having to save at exactly the right
moment. The regression test pins the turn-3
position itself: the clean U-turn line must win even though the trading line
scores higher on the total.

Still not priced: a Substitute standing in front of them, and hazards. Neither
appears in the three guard fights (checked against their movesets), so they are
recorded rather than urgent.

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
