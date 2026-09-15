# The battle screen map

Measured 2026-08-26 by `tools/lua/map_screens.lua` and `map_screens2.lua`,
analysed offline. Every value below was reached from at least two different save
states by at least two different routes.

This document exists so that nothing ever presses a button without first
knowing what is on screen. James's requirement, and the right one:

> "you need to be fully aware of what every screen looks like. Don't give me
>  tests where you are randomly clicking."

Every button failure this project has had came from breaking that rule: a
DOWN-walk that kept re-selecting the same Pokemon, a menu that bounced in and
out ten times, an action cursor guessed a kilobyte from where it actually
lives.

## Which screen is up

    0x03004FE0    the PLAYER's battle-controller function pointer

| value        | screen                                        |
|--------------|-----------------------------------------------|
| `0x0802E439` | action menu (FIGHT / BAG / POKEMON / RUN)     |
| `0x0802EA11` | move list                                     |
| `0x08030685` | party screen (list AND its submenu)           |
| `0x0802E3B5` | not our input: animating, or holding on text  |

`0x03004FE4` is the same pointer for the opponent's controller and moves
through its own set of values as the turn resolves.

CONFIRMED, not assumed: three action-menu snapshots in pass one, reached by
three different routes on `ss1`, all read `0x0802E439`; pass two repeated all
three screens on `ss2` and got the same values again. A pointer that survives
both a change of route and a change of save state is tracking the screen rather
than the history.

## Choosing things, by writing rather than by pressing

    0x02023FF8    action cursor    0 FIGHT, 1 BAG, 2 POKEMON, 3 RUN
    0x02023FFC    move cursor      0..3, laid out as a 2x2 grid
    0x0203B0A9    party slot       0..5, and 7 for "nothing / cancel"

The move cursor was found the way the action cursor was and the way the guessed
address was not: press a direction inside the move list, diff against a CONTROL
dump of the same screen with nothing pressed, and keep the byte that moves like
a cursor. It reads 0 at slot 0, 1 after RIGHT, 3 after RIGHT+DOWN, 2 after DOWN
-- the only byte in 64KB of scanned RAM that matches the grid, and it sits four
bytes after the action cursor, which is where the move cursor belongs if these
are adjacent fields of one struct. Two independent reasons to believe it.

Writing the cursor and pressing A is strictly better than navigating with
directions: directions can only be pressed blind, and BAG and RUN become
structurally unreachable because no direction key is ever pressed at the action
menu.

The party screen is a 2x3 GRID in party order -- left column slots 0, 2, 4;
right column 1, 3, 5 -- which is why every DOWN-only walk failed. The slot byte
holds the slot itself, so the grid never has to be navigated.

`0x0203B0A9` reads 7 after backing out of the party screen, in both passes. 7 is
the CANCEL entry, not a party slot; an agent that reads 7 is not on a Pokemon.

## The rest of the battle, already measured

    0x02023BE4    gBattleMons, 0x58 per battler
                  +0x00 species  +0x0C moves[4]  +0x20 ability  +0x24 pp[4]
                  +0x28 hp       +0x2A level     +0x2C maxHP    +0x2E item
    0x02024284    gPlayerParty
    0x02000091    the AI's chosen TARGET   (move slot, or destination party index)
    0x0200005B    the AI's action flag     (1 switch, 0 move)
    0x020386D0    the battle RNG   mul 0x41C64E6D, add 12345
                  crit = ((draw#3 >> 16) % 24) == 0
                  roll =  (draw#4 >> 16) % 16

## Not yet mapped

- The FORCED SWITCH party screen, after one of ours faints. It may or may not
  share `0x08030685` with the voluntary one, and it has no CANCEL.
- Battle end, and the return to the overworld.
- Learn-a-move and evolution prompts.

These are all recognisable as "a screen whose pointer value I do not have", so
the agent stops and reports rather than pressing something. They will be
captured from live play instead of scripted, since scripting a faint on an
archived state is more work than watching one happen.

---

# Double battles, measured 2026-09-14

By `tools/headless/dscan.c` on two of James's own save states, both taken at a
doubles action menu: `RadicalRed.ss7` (GAME CORNER GUARD -- Hypno and
Aerodactyl, against Accelgor and Greninja) and `RadicalRed.ss8` (ROCKET HIDE.
LEFT GUARD -- Weezing-Galar and Slaking). Nothing was pressed live; every line
below is from the windowless core, and the same script twice gives the same
frame count and the same HP.

## The controller table, which is what "whose turn is it" means

    0x03004FE0 + 4 * battler    that battler's controller function pointer

    battler 0   ours, left      asked FIRST
    battler 1   theirs, left
    battler 2   ours, RIGHT     asked SECOND
    battler 3   theirs, right

`0x03004FE0` is the value the singles map calls "the PLAYER's controller" and
`0x03004FE4` is what it calls "the opponent's": both are just entries of this
table. In a double battle the second question of the turn arrives on
**battler 2's** pointer, and battler 0's sits at the busy value throughout, so
an agent that only watches `0x03004FE0` sees the turn stop halfway and waits
forever. Same four screen values as singles (action `0x0802E439`, moves
`0x0802EA11`, party `0x08030685`, busy `0x0802E3B5`).

## The target picker, which singles does not have

    0x090AB46D    controller value: CHOOSE A TARGET
    0x03004FF4    the target cursor: a BATTLER INDEX, not a slot
    0x090AB8B9    where B at the target picker goes. It stays there. Do not.

Reached after choosing a single-target move. The cursor starts on the
opponent across from the chooser (1 for battler 0) and the d-pad walks it
1 -> 3 -> 2 -> 3 -> 1: either opponent, or your own partner, never yourself.

**The cursor can be WRITTEN, like every other cursor here.** Verified by whose
HP moved, one full turn each, Accelgor attacking:

| target written | result |
| --- | --- |
| (none, default 1) | Hypno 142 -> 65 |
| 3 | Aerodactyl 138 -> 118 |
| 2 | our own Greninja 139 -> 66 |

The same write works for battler 2's own target step (Greninja's Scald sent to
Aerodactyl: 138 -> 1). So a doubles action is chosen exactly the way a singles
action is -- write the cursor, press A -- and no direction is ever pressed
blind.

**A spread move skips the picker entirely.** Greninja's Icy Wind (`allFoes`)
went from the move list straight to the turn resolving, and both opponents
took damage. So the target step is CONDITIONAL: wait a bounded number of
frames for `0x090AB46D`, and if it does not come, the move needed no target.

## The cursors are per-battler arrays

    0x02023FF8 + battler    action cursor   (0 FIGHT, 1 BAG, 2 POKEMON, 3 RUN)
    0x02023FFC + battler    move cursor     (0..3, the 2x2 grid)

Measured: with battler 2's move list open, RIGHT moved `0x02023FFE`, not
`0x02023FFC`. The singles map's two addresses are element 0 of each array,
which is why they worked when only battler 0 ever chose.

## The shape of a turn

    c0 = action   ->  write action cursor 0, A
    c0 = moves    ->  write move cursor, A
    c0 = 0x090AB46D (if it comes) -> write 0x03004FF4, A
    c2 = action   ->  same three steps for battler 2
    then the turn resolves

**B at battler 2's action menu goes back to battler 0's action menu** and
re-asks the first Pokemon (measured: c0 returns to `0x0802E439`). So B is not
a safe recovery key in doubles the way it is in singles.

A pivot suspends the turn: Accelgor's U-turn resolved and the party screen
opened on battler 0 before battler 2 had moved.

## Still not mapped

- The forced switch after a faint: which battler's controller asks, and
  whether both ask at once when two faint on the same turn.
- Partner battles (Silph Co with Brendan, Cerulean Cave with Lance), where one
  of our two slots is an NPC's. Deliberately out of scope; see
  `docs/PLAN-DOUBLES.md`.
