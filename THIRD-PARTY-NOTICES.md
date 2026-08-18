# Third-party notices

This project is built on other people's work. Nothing here would exist without
it, so the provenance is spelled out in full.

---

## 1. Pokémon Radical Red damage calculator

**Everything under `upstream-calc/` except the files listed in section 3.**

- Source: <https://github.com/RadicalRedShowdown/calc>
- Vendored at commit `7f3540035176b3db4386871956eec1c309aea26e` (2026-06-11)
- License: **MIT**, Copyright (c) 2013-2024 Honko and other contributors
- The original license text is retained verbatim at `upstream-calc/LICENSE`

This is itself a fork of Smogon's damage calculator:

- Source: <https://github.com/smogon/damage-calc>
- License: **MIT**, Copyright (c) 2013-2025 Honko and other contributors

The calculator credits, in its own words: *"Original is created by Honko and
maintained by Austin and Kris. Edited by Karthik."*

The MIT license permits use, modification, and redistribution provided the
copyright notice and permission notice are preserved. They are, both in
`upstream-calc/LICENSE` and in this file. The damage-calculation engine, the
Radical Red data tables, and the calculator UI are all their work, not mine.

### Modifications made to the vendored copy

Kept deliberately small so the diff against upstream stays reviewable:

| File | Change |
| --- | --- |
| `src/index.template.html` | 4 added lines (one stylesheet link, three script tags) plus one changed line so the dark theme is the default |
| `src/js/dark-theme-toggle.js` | 1 changed line: default to dark instead of following the OS setting |
| `src/index.template.html` | mode buttons replaced; they linked to other calculators this project does not build. The Field's format radio is hidden and driven from them instead |
| `src/js/rr-critko.js` | **new**, mine |
| `src/js/rr-trainers.js` | **new**, mine |
| `src/js/data/rr-trainers-data.js` | **new**, generated (see section 2) |
| `src/css/rr-panel.css` | **new**, mine |

No upstream logic was altered, removed, or rewritten.

---

## 2. Radical Red trainer data

**`data/csv/*.csv` and `upstream-calc/src/js/data/rr-trainers-data.js`**

Derived from the community-maintained Radical Red documentation spreadsheet:

<https://docs.google.com/spreadsheets/d/1ES8L4OzeJ8rCuMWFNvrDaZKArqR7Vys2ytFxjx2pbwE/>

That sheet was compiled by the Radical Red community (per the sheet itself, by
byte-copying game data and using the in-game Stat Scanner for EVs and IVs), and
it asks that corrections be reported in the `#documentation-reports` channel of
their Discord. **All credit for the underlying data belongs to them.**

`tools/extract_trainers.py` only reshapes that public data into JSON; it adds no
new game knowledge. If you spot a wrong level, moveset, or ability, the mistake
is almost certainly in this repo's parsing, not in their sheet — please check
against the sheet before reporting anything upstream to them.

The data is factual information about a fan-made ROM hack. It is included here
for interoperability, with attribution, and is not offered under this
repository's MIT license.

---

## 3. Radical Red Pokédex data

**`data/rr-dex-data.js` and `upstream-calc/src/js/data/rr-dex-data.js`**

- Source: <https://github.com/JwowSquared/Radical-Red-Pokedex>
  (the data behind <https://dex.radicalred.net>)
- Compiled by JwowSquared and contributors from the ROM.

Used for two things: the offline Pokédex, and `tools/verify_roster.js`, which
cross-checks the calculator's species data against it as an independent source.
`tools/build_dex.js` only reshapes it -- dropping the trainer table we already
have from the spreadsheet, and pre-rendering the evolution method strings -- and
adds no game knowledge of its own. All credit for the data belongs to them.

---

## 4. Experience growth curves

**`data/gr1.json` … `data/gr6.json`**

- Source: <https://pokeapi.co> (`/api/v2/growth-rate/1..6`)
- Cached by `tools/fetch_growth.js`; six requests, run only when refreshing.

A Pokémon in a PC box stores experience, not level, so importing one means
running its species' growth curve backwards. Nothing in the Radical Red dex
snapshot carries that, and there are only six curves, so the species lists come
from PokéAPI. Only the six lists are used -- which species is on which curve --
and the curve formulae themselves are the long-published ones. PokéAPI is a
free, community-run API; credit for assembling that data belongs to them and to
the Pokémon data community it draws on.

---

## 5. Pokémon

Pokémon and all related names are trademarks of Nintendo, Creatures Inc., and
GAME FREAK Inc. Pokémon Radical Red is an unofficial fan-made ROM hack. This
project is a non-commercial fan tool, is not affiliated with or endorsed by any
of the above, and ships no game assets or ROM data.
