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

**3. A damage matrix.** Your attacker's four moves against all six enemy
Pokémon at once, so you can see the whole fight on one screen.

**4. A saved team.** Keep up to six of your own Pokémon in `localStorage` and
click to swap which one is attacking.

Everything the stock calculator does still works untouched — including picking
any Pokémon by hand for wild encounters that aren't in the sheet.

---

## Running it

```bash
cd upstream-calc
npm install      # once, needs network
npm run build    # produces upstream-calc/dist/
```

Then open `upstream-calc/dist/index.html`. **No server required** — the trainer
data is loaded as a plain script, specifically so the page works from `file://`
when you have no network at all.

If you prefer a server:

```bash
cd upstream-calc/dist && python3 -m http.server 8777
```

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

## How the data is verified

The sheet lists no IVs, but it *does* print each Pokémon's Speed stat. The
extractor recomputes Speed from level, base stat, EVs and nature, then solves
for the IV that reproduces the printed value. That is a genuine cross-check:
it independently validates the level, nature, and EV parsing for every block it
can check.

Current state: **185 of 196 checkable Pokémon reconcile exactly (94.4%)**.

The 11 that don't are known and expected, not silent failures:

| Case | Why |
| --- | --- |
| Ditto ×3 | Imposter transforms; the sheet lists post-transform Speed |
| SOUPERCELL ×6 | A level-250 joke boss whose printed Speed assumes you're level 85 |
| Ghost Marowak | Special-cased in-game |
| Koga's Greninja | Off by exactly 1 |

They are flagged with `speedVerified: false` in the data and default to 31 IVs.

Most Pokémon (595 of 792) have levels that scale to your own — the sheet writes
these as "Highest Lv" or "Highest Lv -2" for rematch and postgame trainers. Set
**My highest Lv** in the panel and those resolve automatically.

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
tools/test_critko.js          checks for the crit-aware KO engine
upstream-calc/                the vendored MIT calculator
  src/js/rr-critko.js           crit-aware KO probability      (new, mine)
  src/js/rr-trainers.js         trainer panel + team manager   (new, mine)
  src/js/data/rr-trainers-data.js  generated dataset           (new, generated)
  src/css/rr-panel.css          panel styles                   (new, mine)
  src/index.template.html       +4 lines, the only upstream file touched
```

---

## Known limitations

- Crit-aware KO chances do **not** fold in entry hazards or end-of-turn residual
  damage (weather, poison, Leftovers). Those live inside the upstream KO
  routine, which isn't exported piecewise. The stock KO line, which does include
  them, is always shown alongside.
- Battle effects the sheet notes for some fights (permanent sandstorm, doubles,
  rain teams) are displayed but **not** auto-applied to the Field section — set
  those yourself.
- The high-crit-ratio move list is maintained by hand in `rr-critko.js`. If
  Radical Red diverges from mainline crit ratios, that's the one place to fix.
