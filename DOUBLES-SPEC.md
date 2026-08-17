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

## UI shape (revised after first attempt)

The first version listed all 16 move combinations per target. Too much text and
too much to read. Replaced with a board that mirrors the calculator's own
layout:

- Two columns, You and Opponent, second Pokemon stacked under the first.
- Each card: a species dropdown, target buttons naming the two opposing
  Pokemon, and its moves with damage and KO chance against the current target.
- Click a move to choose it; click a target to redirect. Until you click,
  each Pokemon shows its hardest-hitting move against its current target,
  so the board is useful before any input (defaulting to slot 0 would sit on
  Trick Room and say nothing).
- One summary line per Pokemon being attacked: combined damage and KO chance,
  and which moves produced it. Nothing else.
