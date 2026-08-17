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
- [ ] **4-slot UI**: two of mine, two of theirs.
- [ ] **Empty / fainted slots**, giving 2v1 and 1v1. Spread damage must follow
      the table above as slots empty.
- [ ] **The core question**: "if he uses X and Y onto my Mienshao, does it die?"
      Show the worst-case enemy move pair per target, plus the full grid.
- [ ] **Auto-assign**: the 19 battles the sheet flags `BATTLE EFFECT: DOUBLES`
      should open in this mode with both enemy slots filled.
- [ ] Reuse the trainer panel's level scaling and Minimal Grinding Mode rather
      than duplicating them.

## Notes

- Reworking the existing UI is explicitly acceptable; this may end up feeling
  like a different project.
- `allAdjacentFoes` (Rock Slide, Heat Wave) hits opponents only.
  `allAdjacent` (Earthquake, Surf, Discharge) also hits your own partner —
  which is why a 2v1 Earthquake keeps its penalty while a 2v1 Rock Slide does not.
