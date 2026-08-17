# Double battle mode — working spec

Requirements as they arrive, so nothing is lost between sessions. Tick items
as they land.

## Requirements

- [x] **Engine: focus fire.** Combined KO probability when several attackers aim
      at one target. Not a sum of averages: each attack rolls damage and crits
      independently, so it is a convolution. `RRCritKO.analyseFocusFire`.
- [x] **Engine: spread damage depends on targets actually hit**, not on the
      format. Verified against the engine:
      | Situation | Targets | Damage |
      | --- | --- | --- |
      | 2v2 Rock Slide | 2 | 34 (0.75x) |
      | 2v1 Rock Slide | 1 | 45 (full) |
      | 2v1 Earthquake, own partner alive | 2 | 135 (0.75x, it hits the partner) |
      | Earthquake alone vs one | 1 | 180 (full) |
      | Stone Edge (single target) | 1 | unaffected |
      `RRCritKO.targetsHit` / `fieldForMove`.
- [x] **4-slot UI**: two of mine, two of theirs.
- [x] **Empty / fainted slots**, giving 2v1 and 1v1. Spread damage must follow
      the table above as slots empty.
- [x] **The core question**: "if he uses X and Y onto my Mienshao, does it die?"
      Answered by an interactive board, not a list of possibilities: pick a
      move on each Pokemon, point it at a target, read the combined result.
- [x] **Auto-assign**: the 19 battles the sheet flags `BATTLE EFFECT: DOUBLES`
      should open in this mode with both enemy slots filled.
- [x] Reuse the trainer panel's level scaling and Minimal Grinding Mode rather
      than duplicating them.

## Notes

- Reworking the existing UI is explicitly acceptable; this may end up feeling
  like a different project.
- `allAdjacentFoes` (Rock Slide, Heat Wave) hits opponents only.
  `allAdjacent` (Earthquake, Surf, Discharge) also hits your own partner —
  which is why a 2v1 Earthquake keeps its penalty while a 2v1 Rock Slide does not.

## Verified in the browser

Sabrina's `BATTLE EFFECT: DOUBLES` battle auto-fills all four slots. Against
Hatterene + Indeedee-F it reports, for a level 50 Mienshao:

    Mienshao 140 HP -- guaranteed OHKO, 292.9 - 517.1%
    Hatterene Expanding Force + Indeedee-F Expanding Force

Emptying one opponent slot switches the header to `2v1` and restores full
spread damage: Dazzling Gleam 16.8 - 29.7% -> 22.2 - 39.5%, and the "spread"
tag disappears. Single-target moves are unchanged.

## UI shape (final)

Two earlier attempts built a separate panel below the calculator. Wrong: the
request was for the calculator *itself* to become a 2v2.

A **Doubles** button sits with the mode buttons. Switching it on adds Pokemon 3
under Pokemon 1 and Pokemon 4 under Pokemon 2 -- real panels with every control
the originals have -- and moves Import/Export below them. Each panel gains a
target row naming the two opposing Pokemon; a summary line per attacked Pokemon
reports the combined damage and KO chance. Selecting a battle the sheet flags
DOUBLES switches the mode on and loads the first two opponents; selecting a
single battle switches it back off.

### What made this awkward

The calculator wires everything up once, at startup, for the panels present
then. A panel created later inherits none of it, and each gap is silent:

- `select2` is attached inside `$(document).ready`, so the extra panels are
  stamped from markup captured at parse time, before that runs. Cloning the
  live panels instead drags along broken widget state and loses form values.
- The move, ability, item and type dropdowns are filled in the gen-change
  handler, so a new panel's selects are empty. Options are copied across from
  the live original.
- The set-selector's change handler is bound directly, so new panels get their
  own `applySet`, which also populates the forme list -- `createPokemon` reads
  the species from there whenever a species has alternate formes, and returns a
  null name if it is empty.
- The move-selector handler is bound the same way. Its effects are *not*
  cosmetic: `getMoveDetails` reads `.move-bp` and `.move-type` back out as
  overrides, so a move row still reading "???" calculates the wrong damage.
  Verified after the fix: Expanding Force 80 Psychic, Hyper Voice 90 Normal,
  and the summary agrees with a direct engine call.

## Choosing which two you face

The enemy chip row is now a field selector, not a loader. Clicking a Pokemon
puts it on the field; in doubles two can be up at once, badged 1 and 2, and a
third click evicts the oldest. Pick one goes to Pokemon 2, pick two to
Pokemon 4. In singles clicking simply selects; there is no second slot to take
a Pokemon off for. Leaving doubles trims the field back to one.

### Fixed here

- **Panels showed the wrong name.** A panel could read "Chillet" while showing
  Talonflame's stats. The select2 on the set-selector sits on an input with no
  `initSelection`, so asking select2 to set the value re-renders the label from
  nothing and restores the previous text. The label is now written directly,
  before and after the change event -- before, because upstream's forme handler
  reads the species out of that label.
- **Selection carried across modes.** Leaving doubles left two Pokemon selected
  while only one could be on the field, so the next click deselected instead of
  selecting.

## Level caps

The player is assumed to be sitting at the level cap for whichever battle is
selected, which is what makes rematch and postgame trainers (whose levels are
written relative to yours) show real numbers without typing a level first. The
caps come from the Trainer Order tab and reach battles through the same matching
the Story Order view uses; the cap is shown next to the trainer's name. An "at
cap" checkbox turns it off, and the level stays editable either way.

The order tab stops at the Elite Four, so Postgame battles fall back to 100,
per the sheet's own "Post Game (100)" note. Verified: Brock 15, Misty 27,
Koga 68, Sabrina 59, Postgame 100. Rematch caps (Brock 59, Erika 68) are the
sheet's own values, not a mis-mapping.

## Still open

- My Team is empty; add real Pokemon to make the numbers meaningful.
