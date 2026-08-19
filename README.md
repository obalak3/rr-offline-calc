# Radical Red offline calculator

A fully offline Pokémon Radical Red damage calculator with **every trainer
battle in the game pre-loaded**, plus **KO chances that account for critical
hits**.

Built for playing on a plane: no network, no retyping enemy movesets, no
mental arithmetic about whether a crit changes the outcome.

> This project stands on the [Radical Red damage calculator][calc] (MIT) and a
> community-maintained trainer spreadsheet. See
> **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)** — the damage engine and
> the trainer data are other people's work, and the credit is theirs.

[calc]: https://github.com/RadicalRedShowdown/calc

---

## What it adds

**1. Every trainer battle, one click away.** 167 battles across the game's 9
sections (Kanto Leaders, Kanto Rematch, Johto Leaders, Rivals, Team Rocket, Mini
Bosses, Optional Bosses, Indigo League, Postgame) — 792 Pokémon with their real
levels, natures, abilities, items, moves, and EVs. Click a battle, click an
enemy, and the defender side fills in.

**2. Crit-aware KO chances.** The stock calculator's crit checkbox only forces
crits on or off; its KO chance assumes a fixed crit state. This build reports
the blended probability — "OHKO 7.8% / 2HKO 63.2%" — treating each hit as
critical with its true probability, including the effect of move crit ratios
(Slash, Stone Edge, …), Super Luck, Scope Lens / Razor Claw / Leek / Lucky
Punch, Focus Energy, Merciless, and Battle Armor / Shell Armor.

**3. Doubles.** Not a second page but the same one, grown: two more Pokémon
panels stacked under the first two, two more move lists, and a combined readout
underneath. Battles the sheet flags as doubles select it on their own, singles
battles switch back, and you choose which two of the enemy team are actually on
the field — including 2v1, where spread moves stop being halved. Damage,
targeting and the crit maths all follow.

**4. A saved team.** Keep your own Pokémon in `localStorage` and click to put
one on the field — either slot, in doubles. **Import from save** reads them
straight out of the game's battery `.sav`: your party exactly, natures solved
from the stored stats, plus everything in your PC boxes. **Drag the `.sav` onto
the panel** and it imports — see below, because finding that file is otherwise
the worst part of this.

**5. A Story Order view.** All 96 story trainers in the order you meet them,
grouped by level cap, with optional fights marked — so you can find the battle
you're standing in front of without guessing which section it's in.

**6. A black theme by default.** The stock dark theme is retinted to true black
and turned on out of the box; the calculator's own toggle still works, and an
explicit choice is still respected.

**7. Speed order.** Who moves first, for the whole enemy team at once, using
real final Speed — Choice Scarf, Tailwind, paralysis, weather abilities and
boosts all counted. When something outruns you it says what it would take to
turn that around ("needs 64 Speed EVs"), or tells you plainly that it is out of
reach.

**8. Automatic field effects.** 59 battles carry notes like permanent sandstorm
or omni-boosted opponents; selecting one sets the weather, terrain, and stat
boosts to match. Toggleable, and the panel says which notes it couldn't apply.

**9. The Pokédex, offline.** All 1343 entries — stats, types, abilities with
their descriptions, full movepools and evolution methods — searchable without a
connection.

**10. Your level follows the level cap.** Selecting a battle puts your own
Pokémon at the cap for that point in the game, both slots of it, so the numbers
mean something before you touch anything.

Everything the stock calculator does still works untouched — including picking
any Pokémon by hand for wild encounters that aren't in the sheet.

---

## Running it

```bash
cd upstream-calc
npm install      # once, needs network
npm run build    # produces upstream-calc/dist/
```

`npm run build` from the repo root does the same and then prunes everything the
page does not use, which is most of what upstream ships: four other
calculators' pages, their data and controls, the engine's test suite, and
minified bundles nothing loads. That takes `dist/` from 13 MB to 5.6 MB.

After a rebuild, just reload the page — `index.html` asks not to be cached, and
every asset it names is hash-stamped, so a normal refresh picks the new build
up. (It did not always: a cached page made an already-fixed bug appear to come
back, because the browser was still running the build that had it.)

Then open `upstream-calc/dist/index.html`. **No server required** — the trainer
data is loaded as a plain script, specifically so the page works from `file://`
when you have no network at all.

If you prefer a server:

```bash
cd upstream-calc/dist && python3 -m http.server 8777
```

---

## Importing your team without hunting for the save file

Emulators keep battery saves somewhere inconvenient. OpenEmu puts them under
`~/Library/Application Support/OpenEmu/<core>/Battery Saves`, and Finder hides
`~/Library`, so every import through a file dialog means typing a path.

Two ways around it, and the second is the good one:

```bash
npm run link-save     # drops ~/RadicalRed.sav pointing at the real save
```

That is a symlink, not a copy: the emulator writes through it, so it is always
the current save and there is no stale duplicate to import by mistake. Your home
folder is in every file dialog's sidebar, so the file is then two clicks away.

Better: **drag the `.sav` straight onto the trainer panel.** The panel takes the
drop wherever it lands, so once a Finder window is open on the save — or on
`~/RadicalRed.sav` — importing is one drag, no dialog at all. Save the game,
drag again, and the newer file is read.

The save has to be the battery save the emulator writes (`.sav`), not a save
state. Save states are the emulator's own memory dump and hold no save data in
this format.

---

## Refreshing the trainer data

Only needed when the community sheet changes. Requires network.

```bash
python3 tools/fetch_sheet.py         # cache the sheet's tabs into data/csv/
python3 tools/extract_trainers.py    # -> upstream-calc/src/js/data/rr-trainers-data.js
cd upstream-calc && npm run build
```

The extractor prints a report every run: battle counts, unresolved names, and a
speed cross-check (see below). Standard library only, no pip installs.

---

## Refreshing the Pokédex

Also only needed when the upstream data changes, and also needs network.

```bash
curl -sSL https://raw.githubusercontent.com/JwowSquared/Radical-Red-Pokedex/master/data.js \
  -o data/rr-dex-data.js
node tools/fetch_growth.js           # the six experience curves, cached in data/
node tools/build_dex.js              # -> upstream-calc/src/js/data/rr-dex-data.js
npm run build
```

The growth curves are separate because the dex snapshot does not carry them, and
importing a Pokémon out of a PC box needs one: a stored Pokémon keeps its
experience but not its level.

---

## Does it know every Pokémon?

Yes, and that is checked rather than assumed. `tools/verify_roster.js` compares
the bundled calculator against the community Radical Red Pokédex
([JwowSquared/Radical-Red-Pokedex](https://github.com/JwowSquared/Radical-Red-Pokedex),
the data behind <https://dex.radicalred.net>) — an independent extraction of the
same ROM. Two independent sources agreeing means something; the calculator
agreeing with itself would not.

Result across all **1200 distinct dex entries**: every species is present, base
stats agree stat-for-stat, and every ability is selectable.

Two documented exceptions: Radical Red gives **Unfezant** and **Jellicent**
gender-dependent base stats, and the calculator ships only one gender of each
(Unfezant's female spread, Jellicent's male). Neither appears in any trainer
battle, so it only matters if one is on your own team — edit the base stats by
hand in that case. They're allowlisted so any *new* discrepancy still fails.

```bash
node tools/verify_roster.js
```

## How the data is verified

The sheet lists no IVs, but it *does* print each Pokémon's Speed stat. The
extractor recomputes Speed from level, base stat, EVs and nature, then solves
for the IV that reproduces the printed value. That is a genuine cross-check:
it independently validates the level, nature, and EV parsing for every block it
can check.

Current state: **184 of 196 checkable Pokémon reconcile exactly (93.9%)**.

The 12 that don't are known and expected, not silent failures:

| Case | Why |
| --- | --- |
| Ditto ×3 | Imposter transforms; the sheet lists post-transform Speed |
| SOUPERCELL ×6 | A level-250 joke boss whose printed Speed assumes you're level 85 |
| Ghost Marowak | Special-cased in-game |
| Koga's Greninja | Off by exactly 1 |
| Brendan's Sceptile-Mega | Hidden Power needs an even Speed IV, the printed Speed an odd one |

They are flagged with `speedVerified: false` in the data and default to 31 IVs.

Most Pokémon (595 of 792) have levels that scale to your own — the sheet writes
these as "Highest Lv" or "Highest Lv -2" for rematch and postgame trainers. Set
**My highest Lv** in the panel and those resolve automatically.

Every one of the **792 trainer Pokémon** is also loaded through the real page in
a headless DOM and read back out, checking species, ability, item, level and
moves against the sheet. All 792 pass. This caught two bugs that unit tests
could not, both about upstream DOM behaviour rather than arithmetic: abilities
silently falling back to the species default, and Hidden Power's type being
rewritten by the calculator.

```bash
node tools/test_page.js        # panel behaviour, ~30s
node tools/test_offline.js     # the file:// guarantee, ~10s
node tools/test_load_all.js    # all 792 Pokemon, ~5min
```

`test_offline.js` is the one that matters for the whole point of this project.
It opens the built page as a real `file://` URL, where two things differ from
serving over loopback and both used to break it: `localStorage` can be denied
outright, and `history.replaceState` throws on a file URL. Neither showed up
over http.

The crit engine has its own checks:

```bash
node tools/test_critko.js
```

The strongest of these sweeps 219 matchups and asserts that with the crit rate
set to zero, our DP reproduces the upstream calculator's exact KO probabilities.
Worst observed difference: `0`.

---

## Layout

```
data/csv/                     cached sheet tabs (the extractor's input)
tools/fetch_sheet.py          refresh the cache (needs network)
tools/extract_trainers.py     CSV -> trainer dataset, with a validation report
tools/dump_calc_names.js      export the calculator's canonical name lists
tools/verify_roster.js        cross-check the roster against the RR Pokedex
tools/build_dex.js            RR Pokedex snapshot -> the offline dex bundle
tools/fetch_growth.js         cache the six experience curves (needs network)
tools/link_save.js            put a shortcut to the battery save in ~/
tools/prune_dist.js           strip everything the page does not reference
tools/stamp_dist.js           hash-stamp the lazily loaded Pokedex bundle
tools/test_critko.js          checks for the crit-aware KO engine
tools/test_page.js            drives the built page in a headless DOM
tools/test_doubles.js         drives doubles: format, facing, both your slots
tools/test_offline.js         opens it as file://, with no server at all
tools/test_save.js            reads a real .sav and checks nothing is invented
tools/test_import.js          drops a .sav on the page and follows it into the team
tools/test_load_all.js        loads all 792 trainer Pokemon and verifies them
upstream-calc/                the vendored MIT calculator
  src/js/rr-critko.js           crit-aware KO probability      (new, mine)
  src/js/rr-trainers.js         trainer panel + team manager   (new, mine)
  src/js/rr-doubles.js          doubles, inside the same page  (new, mine)
  src/js/rr-dex.js              the offline Pokedex            (new, mine)
  src/js/rr-save.js             battery-save importer          (new, mine)
  src/js/data/rr-trainers-data.js  generated dataset           (new, generated)
  src/js/data/rr-dex-data.js       generated dex bundle        (new, generated)
  src/css/rr-panel.css          panel styles                   (new, mine)
  src/index.template.html       mode row, credits, script tags
  src/js/dark-theme-toggle.js   1 changed line (dark by default)
```

---

## Known limitations

- Crit-aware KO chances do **not** fold in entry hazards or end-of-turn residual
  damage (weather, poison, Leftovers). Those live inside the upstream KO
  routine, which isn't exported piecewise. The stock KO line, which does include
  them, is always shown alongside.
- Weather, terrain and omni-boost effects are applied automatically, and so is
  the doubles format. Inverse battles, banned types and mid-battle
  transformations have no equivalent in the calculator; they're shown and
  explicitly listed as not applied, rather than silently ignored.
- The save importer does not know where the ability slot lives in the save, so
  imports default to each species' **ability 1** and the panel's dropdown
  changes it. Measured against a party whose abilities were read off the game's
  own summary screen, that default is right 5 times in 6 — it is only wrong for
  a Pokémon actually holding its second ability.

  What has been ruled out, exhaustively rather than by eye: every bit position
  in both record types, at widths 1-3 (a slot number) and 8-10 (an ability id),
  constrained both by known abilities and by the rule that a value must name a
  slot the species actually has. Nothing survives that is not inside a field
  already accounted for — an item id, an experience total, a nickname's letters,
  a stat. Gen 3's own mechanism is ruled out too: bit 31 of the IV word is the
  ability selector in vanilla, but a Pokémon known to hold its second ability
  has it clear, and with the game's perfect-IV setting every IV word in the file
  reads 0x3fffffff, leaving no spare bits. Settling it needs two saves differing
  only in one Pokémon's ability; diffing those points straight at the byte.
- A Pokémon in a PC box stores no stats, so the nature fingerprint that pins a
  party member's nature exactly is not available: stored Pokémon come in as
  Adamant or Modest by whichever attacking stat is higher. Their levels are
  exact — derived from the stored experience and the species' growth curve.
- Hidden Power's type is fixed by the parity of the six IVs, so a Pokémon
  carrying it gets the type's canonical IV spread and the Speed IV is fitted
  within that parity class. One Pokémon (Brendan's Sceptile-Mega) cannot satisfy
  both; the stated move type wins and it's flagged `speedVerified: false`.
- The high-crit-ratio move list is maintained by hand in `rr-critko.js`. If
  Radical Red diverges from mainline crit ratios, that's the one place to fix.
