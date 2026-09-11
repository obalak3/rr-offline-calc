# The calculator

Where the project started, and still the one part anyone can use without the
emulator setup: a fully offline Pokémon Radical Red damage calculator with
every trainer battle pre-loaded and KO chances that account for critical hits.
It works from `file://` with no server and no network.

Built on the [Radical Red damage calculator](https://github.com/RadicalRedShowdown/calc)
(MIT), vendored under `upstream-calc/` with the upstream code left intact so
the additions stay a reviewable diff. Only `src/index.template.html` and one
line of the theme toggle are modified upstream; everything else is new files
(`rr-critko.js`, `rr-trainers.js`, `rr-doubles.js`, `rr-dex.js`, `rr-save.js`,
`rr-panel.css`, and the generated data bundles).

## What it adds

- **Every trainer battle, one click away.** 167 battles across the game's nine
  sections, 792 Pokémon with real levels, natures, abilities, items, moves and
  EVs. Click a battle, click an enemy, the defender side fills in.
- **Crit-aware KO chances.** The stock calculator's KO chance assumes a fixed
  crit state. This blends each hit's true critical probability: move ratios,
  Super Luck, Scope Lens, Razor Claw, Leek, Lucky Punch, Focus Energy,
  Merciless, Battle Armor and Shell Armor. Reported as "OHKO 7.8% / 2HKO 63.2%".
- **Doubles, inside the same page.** Two more panels under the first two, a
  combined readout per attacked Pokémon, spread damage that follows the number
  of targets actually hit (so a 2v1 Rock Slide is full damage and a 2v1
  Earthquake is not, because it still hits your partner), focus-fire KO odds as
  a real convolution of independent rolls. Battles the sheet flags as doubles
  switch it on; you choose which two of the enemy team are out.
- **A saved team**, importable from the game's battery `.sav`: your party
  exactly, natures solved from the stored stats, PC boxes included. Drag the
  `.sav` onto the panel. `npm run link-save` puts a symlink to the emulator's
  save in your home folder so it is two clicks away in any file dialog.
- **A Story Order view**: all 96 story trainers in the order you meet them,
  grouped by level cap, optional fights marked. Your own level follows the cap
  of the selected battle.
- **Speed order** for the whole enemy team using real final Speed (Scarf,
  Tailwind, paralysis, weather abilities, boosts), with what it would take to
  outrun each one.
- **Automatic field effects** from the sheet's battle notes (permanent weather,
  terrain, omni-boosts), with anything it cannot apply listed rather than
  skipped.
- **The Pokédex, offline**: all 1343 entries, stats, abilities with text,
  movepools, evolutions.
- **A black theme** by default.

## The advisor panel

An in-page precursor of the agent's planner: pick a battle, who is out on each
side, current HP, and it ranks every option on the opponent's worst reply, or
searches for a route where nothing of yours faints and reports how much bad
luck that route survives. It never claims a Pokémon dies, only that a safe
route was or was not found. Singles only; the search runs on the main thread.
The live agent superseded it, but it still works.

## How the data is checked

- The roster is cross-checked against an independent extraction of the same
  ROM, the community Radical Red Pokédex
  ([JwowSquared/Radical-Red-Pokedex](https://github.com/JwowSquared/Radical-Red-Pokedex)):
  1200 dex entries, every species present, base stats identical. Two documented
  exceptions (Unfezant and Jellicent have gender-dependent stats in this hack
  and the calculator ships one gender each) are allowlisted so any new
  discrepancy still fails. `node tools/verify_roster.js`.
- The sheet prints each trainer Pokémon's Speed. The extractor solves for the
  IV that reproduces it, which independently validates the level, nature and EV
  parsing: 184 of 196 checkable entries reconcile exactly. The 12 that do not
  are known (Ditto after Imposter, a level-250 joke boss, the Ghost Marowak,
  one off-by-one, one Hidden Power parity conflict) and flagged
  `speedVerified: false`.
- All 792 trainer Pokémon are loaded through the real page in a headless DOM
  and read back (`node tools/test_load_all.js`, ~5 min). This caught two bugs
  no unit test could: abilities silently falling back to the species default,
  and Hidden Power's type being rewritten by the calculator.
- With the crit rate set to zero the crit-aware KO engine reproduces the
  upstream calculator's exact KO probabilities across 219 matchups
  (`node tools/test_critko.js`).
- `node tools/test_offline.js` opens the built page as a real `file://` URL,
  where `localStorage` can be denied and `history.replaceState` throws; both
  broke it once and neither shows over http.

## Running it

```bash
npm install && npm run build      # -> upstream-calc/dist/index.html; open it directly
node tools/test_page.js           # panel behaviour, ~30 s
node tools/test_doubles.js        # the doubles page
node tools/test_offline.js        # the file:// guarantee
```

`npm run build` builds upstream and then prunes everything the page does not
use (13 MB to 5.6 MB). `index.html` asks not to be cached and every asset is
hash-stamped, so a normal reload picks up a rebuild.

Refreshing the trainer data and the Pokédex is the only thing that needs
network:

```bash
python3 tools/fetch_sheet.py && python3 tools/extract_trainers.py && npm run build
curl -sSL https://raw.githubusercontent.com/JwowSquared/Radical-Red-Pokedex/master/data.js -o data/rr-dex-data.js
node tools/fetch_growth.js && node tools/build_dex.js && npm run build
```

## Known limits

- Crit-aware KO chances do not fold in entry hazards or residual damage; the
  stock KO line, which does, is shown alongside.
- Inverse battles, banned types and mid-battle transformations are listed as
  not applied rather than silently ignored.
- Hidden abilities cannot be read from a save (the ability bit in the
  personality value only distinguishes the two ordinary slots). Boxed Pokémon
  store no stats, so they come in without an exact nature; their levels are
  exact, from stored experience and the growth curve.
- Hidden Power's type is fixed by IV parity, so a carrier gets the canonical
  spread for its type and the Speed IV is fitted within that parity class.
- The high-crit-ratio move list is maintained by hand in `rr-critko.js`.

## Traps worth knowing if you touch the page

The calculator wires everything up once at startup for the panels that exist
then. A panel created later inherits none of it, and every gap is silent: empty
dropdowns, a set that loads a species but no moves, a move row still reading
"???" that feeds wrong overrides into the damage call. The doubles panels copy
options from the live originals and bind their own handlers for that reason.
`select2` on the set selector has no `initSelection`, so setting its value
re-renders the previous label; the label is written directly. Google's
spreadsheet exports omit cached formula values, so the per-tab CSV export is the
only one that keeps the level column.
