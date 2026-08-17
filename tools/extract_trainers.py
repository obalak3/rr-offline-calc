#!/usr/bin/env python3
"""
Extract every trainer battle from the community Radical Red trainer sheet
into JSON the offline calculator can load.

Source sheet (compiled by the Radical Red community -- see README for credit):
  https://docs.google.com/spreadsheets/d/1ES8L4OzeJ8rCuMWFNvrDaZKArqR7Vys2ytFxjx2pbwE/

Input is the per-tab CSV export, NOT the .xlsx/.ods export: Google omits cached
values for formula cells in those, which wipes out most level fields. The CSV
export renders formulas *and* preserves the literal grid (blank rows included),
which the gviz endpoint does not.

  python3 tools/fetch_sheet.py              # refresh data/csv/*.csv (needs network)
  python3 tools/extract_trainers.py         # data/csv -> rr-trainers.json

Standard library only.
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import OrderedDict, Counter

# gid -> segment name. Identified by content; see tools/fetch_sheet.py.
SEGMENTS = OrderedDict([
    ("1410111071", "Kanto Leaders"),
    ("2075653688", "Kanto Rematch"),
    ("2145471124", "Johto Leaders"),
    ("1150799580", "Rivals"),
    ("1998272076", "Team Rocket"),
    ("1752505021", "Mini Bosses"),
    ("739017967", "Optional Bosses"),
    ("1411568458", "Indigo League"),
    ("2140479091", "Postgame"),
])
ORDER_GID = "306634858"

# Pokemon label columns (1-based); base stats at +1, EVs at +3.
MON_COLS = [5, 10, 15, 20, 25, 30]

OFF_LEVEL, OFF_NATURE, OFF_ABILITY, OFF_ITEM = 1, 4, 5, 6
OFF_MOVES = (7, 8, 9, 10)
OFF_BASESTATS = 13
OFF_SPEEDSTAT = 19
OFF_BASESTATS_HEADER = 12

STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"]

NATURES = {
    "Hardy": (None, None), "Docile": (None, None), "Serious": (None, None),
    "Bashful": (None, None), "Quirky": (None, None),
    "Lonely": ("atk", "def"), "Brave": ("atk", "spe"),
    "Adamant": ("atk", "spa"), "Naughty": ("atk", "spd"),
    "Bold": ("def", "atk"), "Relaxed": ("def", "spe"),
    "Impish": ("def", "spa"), "Lax": ("def", "spd"),
    "Timid": ("spe", "atk"), "Hasty": ("spe", "def"),
    "Jolly": ("spe", "spa"), "Naive": ("spe", "spd"),
    "Modest": ("spa", "atk"), "Mild": ("spa", "def"),
    "Quiet": ("spa", "spe"), "Rash": ("spa", "spd"),
    "Calm": ("spd", "atk"), "Gentle": ("spd", "def"),
    "Sassy": ("spd", "spe"), "Careful": ("spd", "spa"),
}

FORM_SUFFIX = {"-A": "-Alola", "-G": "-Galar", "-H": "-Hisui", "-P": "-Paldea"}

NO_ITEM = {"no item", "none", "-", ""}

# Typos / shorthand in the sheet that generic matching cannot recover.
CORRECTIONS = {
    "ability": {
        "Comotose": "Comatose",            # sheet typo
        "Swords of Ruin": "Sword of Ruin",  # sheet typo
        # Only occurrence is Lorelei's Calyrex-Ice, which is the Glastrier rider.
        "As One": "As One (Glastrier)",
    },
    "move": {
        "Drain Kiss": "Draining Kiss",
        "Pow-Up Punch": "Power-Up Punch",
    },
    "item": {
        "Abomasnite": "Abomasite",          # sheet typo
        "Applite": "Appletunite",           # Appletun's mega stone
        "HeavyD. Boots": "Heavy-Duty Boots",
    },
    "species": {
        # "-I" is the Incarnate forme, which the calc stores under the bare name.
        "Landorus-I": "Landorus",
        "Enamorus-I": "Enamorus",
        "Tornadus-I": "Tornadus",
        "Thundurus-I": "Thundurus",
        "Indeedee-M": "Indeedee",           # male is the base entry
        "Ursaluna-BM": "Ursaluna-Bloodmoon",
        "Urshifu-S": "Urshifu",             # Single Strike is the base entry
        "Wishiwashi-S-Sch": "Wishiwashi-Sevii-School",
    },
}

# Hidden Power IV spreads, loaded from data/calc-names.json at startup.
HIDDEN_POWER_IVS = {}

# Natures the sheet leaves deliberately unspecified.
NATURE_PLACEHOLDERS = {"random", "any", "?"}


# ------------------------------------------------------------------ grid input

def read_grid(path):
    """CSV -> {(row, col): text}, both 1-based, blanks dropped."""
    grid = {}
    with open(path, encoding="utf8") as fh:
        for r, row in enumerate(csv.reader(fh), start=1):
            for c, value in enumerate(row, start=1):
                value = value.strip()
                if value:
                    grid[(r, c)] = value
    return grid


def cell(grid, r, c):
    return grid.get((r, c))


def as_int(value):
    if value is None:
        return None
    try:
        return int(round(float(str(value).replace(",", "").strip())))
    except ValueError:
        return None


# -------------------------------------------------------------------- levels

LEVEL_RE = re.compile(r"^highest\s*lv\.?\s*([+-]\s*\d+)?$", re.I)


def parse_level(raw):
    """Return {'type':'fixed','value':N} or {'type':'relative','offset':N}.

    Rematch and Postgame trainers scale to the player's highest-level Pokemon,
    written in the sheet as "Highest Lv" or "Highest Lv -2".
    """
    if raw is None:
        return None
    fixed = as_int(raw)
    if fixed is not None:
        return {"type": "fixed", "value": fixed}
    m = LEVEL_RE.match(raw.replace("\n", " ").strip())
    if m:
        offset = int(m.group(1).replace(" ", "")) if m.group(1) else 0
        return {"type": "relative", "offset": offset}
    return {"type": "unknown", "raw": raw}


# ----------------------------------------------------------------- stat math

def compute_stat(key, base, iv, ev, level, nature):
    if key == "hp":
        return (2 * base + iv + ev // 4) * level // 100 + level + 10
    value = (2 * base + iv + ev // 4) * level // 100 + 5
    up, down = NATURES.get(nature, (None, None))
    if up == key:
        value = value * 11 // 10
    elif down == key:
        value = value * 9 // 10
    return value


def solve_speed_iv(base, ev, level, nature, target, parity=None, preferred=None):
    """Back-solve the Speed IV from the sheet's printed Speed stat.

    The sheet does not list IVs. Prefer 31, then 0 (the documented Gyro Ball /
    Trick Room case), else the highest IV that reproduces the printed stat.

    `parity` constrains the search to even or odd IVs. That matters for Hidden
    Power: its type is fixed by the parity of the six IVs, so the Speed IV can
    only be adjusted within one parity class without silently changing the
    move's type. `preferred` is tried first when it is among the matches.
    """
    candidates = [iv for iv in range(32)
                  if parity is None or iv % 2 == parity]
    matches = [iv for iv in candidates
               if compute_stat("spe", base, iv, ev, level, nature) == target]
    if not matches:
        fallback = preferred if preferred is not None else (
            31 if parity is None else max(candidates))
        return fallback, False
    order = [preferred, 31, 0] if preferred is not None else [31, 0]
    for choice in order:
        if choice is not None and choice in matches:
            return choice, True
    return max(matches), True


HIDDEN_POWER_RE = re.compile(r"^Hidden Power (\w+)$")


def hidden_power_type(moves):
    for move in moves:
        m = HIDDEN_POWER_RE.match(move or "")
        if m:
            return m.group(1)
    return None


# --------------------------------------------------------------- name lookup

def dotted_to_regex(raw):
    """"Headlon. Rush" -> ^Headlon\\w* Rush$  (the sheet abbreviates to fit cells)."""
    parts = []
    for token in re.split(r"(\s+|-)", raw):
        if token.endswith("."):
            parts.append(re.escape(token[:-1]) + r"[\w'-]*")
        else:
            parts.append(re.escape(token))
    return re.compile("^" + "".join(parts) + "$", re.I)


def squash(text):
    """Punctuation-insensitive key: "Soft Boiled" and "Soft-Boiled" agree."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def form_keys(suffix_words):
    """Shorthand spellings the sheet might use for a form suffix.

    "Mega-X"     -> MX, MegaX, MegaX, XMega ...
    "Sevii-Mega" -> SM, SeviiMega, SeviiM, MegaS  (the sheet writes "MegaS")
    """
    initials = "".join(w[0] for w in suffix_words)
    joined = "".join(suffix_words)
    keys = {initials, joined,
            suffix_words[0] + "".join(w[0] for w in suffix_words[1:]),
            suffix_words[-1] + "".join(w[0] for w in suffix_words[:-1])}
    return {squash(k) for k in keys if k}


class Normalizer:
    def __init__(self, names):
        self.pools = {}
        for kind, key in (("species", "species"), ("move", "moves"),
                          ("item", "items"), ("ability", "abilities")):
            pool = list(names[key])
            self.pools[kind] = {
                "exact": set(pool),
                "lower": {p.lower(): p for p in pool},
                "squash": {squash(p): p for p in pool},
                "all": pool,
            }
        self.natures = set(names["natures"])
        self.unresolved = []

    def _lookup(self, kind, text):
        pool = self.pools[kind]
        if text in pool["exact"]:
            return text
        return (pool["lower"].get(text.lower())
                or pool["squash"].get(squash(text)))

    def resolve(self, kind, raw, context, quiet=False):
        if raw is None:
            return None
        text = raw.replace("’", "'").strip()
        text = CORRECTIONS.get(kind, {}).get(text, text)

        hit = self._lookup(kind, text)
        if hit:
            return hit

        # trailing note, e.g. "Thick Fat (Mega)" -- but never break a real
        # parenthesised name such as "As One (Glastrier)".
        stripped = re.sub(r"\s*\([^)]*\)\s*$", "", text).strip()
        if stripped != text:
            hit = self._lookup(kind, stripped)
            if hit:
                return hit

        # cell-width abbreviations: "Headlon. Rush", "HeavyD. Boots"
        if "." in text:
            pattern = dotted_to_regex(text)
            hits = [p for p in self.pools[kind]["all"] if pattern.match(p)]
            if len(hits) == 1:
                return hits[0]
            if len(hits) > 1:
                self.unresolved.append(
                    (kind, raw, context + " [ambiguous: %s]"
                     % ", ".join(sorted(hits)[:4])))
                return min(hits, key=len)

        if not quiet:
            self.unresolved.append((kind, raw, context))
        return None

    def species_name(self, raw, context):
        text = raw.replace("’", "'").strip()
        text = CORRECTIONS["species"].get(text, text)
        hit = self._lookup("species", text)
        if hit:
            return hit

        # regional shorthand: "Geodude-A" -> "Geodude-Alola"
        m = re.match(r"^(.*?)(-[AGHP])$", text)
        if m:
            candidate = self._lookup("species", m.group(1) + FORM_SUFFIX[m.group(2)])
            if candidate:
                return candidate

        # generic form shorthand: "Charizard-MegaY", "Necrozma-DM", "Milotic-S"
        if "-" in text:
            base, suffix = text.rsplit("-", 1)
            base_hit = self._lookup("species", base) or base
            prefix = base_hit + "-"
            candidates = [s for s in self.pools["species"]["all"]
                          if s.startswith(prefix)]
            wanted = squash(suffix)
            hits = [s for s in candidates
                    if wanted in form_keys(s[len(prefix):].split("-"))]
            if len(hits) == 1:
                return hits[0]
            if not hits:  # last resort: unique prefix of the joined suffix
                hits = [s for s in candidates
                        if squash(s[len(prefix):]).startswith(wanted)]
                if len(hits) == 1:
                    return hits[0]
            if len(hits) > 1:
                self.unresolved.append(
                    ("species", raw,
                     context + " [ambiguous: %s]" % ", ".join(sorted(hits)[:4])))
                return min(hits, key=len)

        return self.resolve("species", text, context)

    def move_name(self, raw, context):
        if raw is None:
            return None
        text = raw.strip()
        if text in ("-", "", "No Move"):
            return None
        m = re.match(r"^HP\s+(\w+)$", text, re.I)
        if m:
            text = "Hidden Power " + m.group(1).capitalize()
        return self.resolve("move", text, context)

    def item_name(self, raw, context):
        if raw is None or raw.strip().lower() in NO_ITEM:
            return None
        return self.resolve("item", raw, context)

    def nature_name(self, raw, context):
        text = (raw or "Serious").strip().split("\n")[0].capitalize()
        if text.lower() in NATURE_PLACEHOLDERS:
            return None  # genuinely unspecified in the sheet
        if text not in self.natures:
            self.unresolved.append(("nature", raw, context))
            return "Serious"
        return text

    def ability_cell(self, raw, context):
        """Ability cells may hold several lines / alternatives.

        "Blaze\\nDrought"            -> ability Blaze, after-Mega Drought
        "Flame Body\\nor Quick Draw" -> ability Flame Body, alternative Quick Draw
        "Intimidate (Both)"          -> ability Intimidate
        "Guts or No Guard"           -> ability Guts, alternative No Guard
        """
        if raw is None:
            return None, [], None
        lines = [l.strip() for l in raw.split("\n") if l.strip()]
        if not lines:
            return None, [], None

        alternatives, mega = [], None
        for extra in lines[1:]:
            if re.match(r"^or\s+", extra, re.I):
                alternatives.append(re.sub(r"^or\s+", "", extra, flags=re.I))
            else:
                mega = extra

        head = re.sub(r"\((?:both|either)\)", "", lines[0], flags=re.I).strip()
        pieces = re.split(r"\s+or\s+", head, flags=re.I)
        primary = pieces[0].strip()
        alternatives.extend(p.strip() for p in pieces[1:])

        primary = self.resolve("ability", primary, context) if primary else None
        alts = [a for a in (self.resolve("ability", x, context)
                            for x in alternatives) if a]
        mega = self.resolve("ability", mega, context) if mega else None
        return primary, alts, mega


# ------------------------------------------------------------- block parsing

def slugify(*parts):
    text = "-".join(p for p in parts if p)
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def collect_annotations(grid, header_row, block_start):
    """Battle-effect / variant banners sitting above a block.

    The sheet distinguishes by emphasis: "(!)" marks a per-battle variant
    ("IF RIVAL HAS SQUIRTLE"), while "(!!!)" marks a note about the whole
    section ("ALL SPEED STATS IN THIS SECTION ASSUME YOU'RE LEVEL 100").
    Only the former identifies a battle.
    """
    variants, effects, section_notes = [], [], []
    for r in range(max(block_start, header_row - 4), header_row):
        for c in range(1, 34):
            value = cell(grid, r, c)
            if not value:
                continue
            flat = value.replace("\n", " ").strip()
            if flat.upper().startswith("BATTLE EFFECT"):
                effects.append(flat)
            elif flat.startswith("(!"):
                bangs = len(flat) - len(flat.lstrip("(!")) - 1
                text = re.sub(r"^\(!+\)\s*", "", flat)
                (section_notes if bangs >= 3 else variants).append(text)
    return variants, effects, section_notes


def parse_segment(grid, segment_name, norm, warnings):
    header_rows = sorted({r - OFF_BASESTATS_HEADER
                          for (r, c), v in grid.items() if v == "BASE STATS"})

    battles = []
    seen = Counter()
    for idx, h in enumerate(header_rows):
        previous_end = header_rows[idx - 1] + OFF_SPEEDSTAT if idx else 1
        trainer_cell = cell(grid, h, 3) or cell(grid, h, 4) or "UNKNOWN"
        parts = [p.strip() for p in trainer_cell.split("\n") if p.strip()]
        title = " / ".join(parts[:-1]) if len(parts) >= 2 else None
        trainer = parts[-1] if parts else "UNKNOWN"

        variants, effects, section_notes = collect_annotations(grid, h, previous_end)
        variant = variants[0] if variants else None

        team = []
        for c in MON_COLS:
            raw_name = cell(grid, h, c)
            if not raw_name:
                continue
            ctx = "%s / %s / row %d" % (segment_name, trainer, h)

            level = parse_level(cell(grid, h + OFF_LEVEL, c))
            nature = norm.nature_name(cell(grid, h + OFF_NATURE, c), ctx)
            ability, alt_abilities, mega_ability = norm.ability_cell(
                cell(grid, h + OFF_ABILITY, c), ctx)
            item = norm.item_name(cell(grid, h + OFF_ITEM, c), ctx)

            moves = []
            for off in OFF_MOVES:
                resolved = norm.move_name(cell(grid, h + off, c), ctx)
                if resolved:
                    moves.append(resolved)

            base, evs = {}, {}
            for i, key in enumerate(STAT_KEYS):
                base[key] = as_int(cell(grid, h + OFF_BASESTATS + i, c + 1)) or 0
                evs[key] = as_int(cell(grid, h + OFF_BASESTATS + i, c + 3)) or 0

            sheet_speed = as_int(cell(grid, h + OFF_SPEEDSTAT, c + 3))

            # Hidden Power's type is set by the parity of the six IVs, so a
            # Pokemon carrying it needs the matching spread or the calculator
            # will silently rewrite the move to whatever its IVs imply. The
            # sheet states the move outright, so the type wins; the Speed IV is
            # only an inference and gets fitted within that parity class.
            hp_type = hidden_power_type(moves)
            spread = HIDDEN_POWER_IVS.get(hp_type, {}) if hp_type else {}
            ivs = {k: spread.get(k, 31) for k in STAT_KEYS}
            speed_parity = ivs["spe"] % 2 if hp_type else None
            speed_preferred = ivs["spe"] if hp_type else None

            speed_verified = None
            if sheet_speed is not None and level and level["type"] == "fixed":
                iv, ok = solve_speed_iv(base["spe"], evs["spe"],
                                        level["value"], nature, sheet_speed,
                                        parity=speed_parity,
                                        preferred=speed_preferred)
                ivs["spe"] = iv
                speed_verified = ok
                if not ok:
                    warnings.append(
                        "%s: %s lv%s %s -> sheet Speed %s, max computable %s"
                        % (ctx, raw_name, level["value"], nature, sheet_speed,
                           compute_stat("spe", base["spe"], 31, evs["spe"],
                                        level["value"], nature)))

            species = norm.species_name(raw_name, ctx)
            team.append(OrderedDict([
                ("species", species or raw_name),
                ("sheetName", raw_name),
                ("level", level),
                ("nature", nature),
                ("ability", ability),
                ("altAbilities", alt_abilities),
                ("megaAbility", mega_ability),
                ("item", item),
                ("moves", moves),
                ("baseStats", base),
                ("evs", evs),
                ("ivs", ivs),
                ("hiddenPower", hp_type),
                ("sheetSpeed", sheet_speed),
                ("speedVerified", speed_verified),
            ]))

        if not team:
            continue

        base_id = slugify(segment_name, trainer, variant)
        seen[base_id] += 1
        battle_id = base_id if seen[base_id] == 1 else "%s-%d" % (base_id, seen[base_id])

        battles.append(OrderedDict([
            ("id", battle_id),
            ("trainer", trainer),
            ("title", title),
            ("variant", variant),
            ("effects", effects),
            ("notes", section_notes),
            ("row", h),
            ("team", team),
        ]))
    return battles


def parse_trainer_order(grid):
    entries = []
    max_row = max(r for r, _ in grid)
    for r in range(1, max_row + 1):
        name = cell(grid, r, 4)
        if not name:
            continue
        cap = as_int(cell(grid, r, 6))
        location = cell(grid, r + 1, 4)
        optional = (cell(grid, r - 1, 3) or "").upper().startswith("(OPTIONAL")
        if cap is None and location is None:
            continue
        entries.append(OrderedDict([
            ("name", name), ("location", location),
            ("levelCap", cap), ("optional", optional),
        ]))
    return entries


# -------------------------------------------------------------------- report

def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("--csvdir", default=os.path.join(here, "data", "csv"))
    ap.add_argument("--names", default=os.path.join(here, "data", "calc-names.json"))
    # Emitted as a plain script assigning a global, not as .json, so the built
    # page works when opened straight from disk (file://), where XHR is blocked.
    ap.add_argument("--out", default=os.path.join(
        here, "upstream-calc", "src", "js", "data", "rr-trainers-data.js"))
    args = ap.parse_args()

    with open(args.names) as fh:
        names = json.load(fh)
    global HIDDEN_POWER_IVS
    HIDDEN_POWER_IVS = names.get("hiddenPowerIVs", {})
    if not HIDDEN_POWER_IVS:
        print("WARNING: no Hidden Power IV spreads in %s; regenerate it with "
              "node tools/dump_calc_names.js" % args.names)
    norm = Normalizer(names)
    warnings = []

    segments, total = [], 0
    for gid, segment_name in SEGMENTS.items():
        grid = read_grid(os.path.join(args.csvdir, gid + ".csv"))
        battles = parse_segment(grid, segment_name, norm, warnings)
        total += len(battles)
        segments.append(OrderedDict([("name", segment_name), ("battles", battles)]))
        print("  %-16s %3d battles" % (segment_name, len(battles)))

    order = parse_trainer_order(read_grid(
        os.path.join(args.csvdir, ORDER_GID + ".csv")))

    payload = OrderedDict([
        ("source", "https://docs.google.com/spreadsheets/d/"
                   "1ES8L4OzeJ8rCuMWFNvrDaZKArqR7Vys2ytFxjx2pbwE/"),
        ("note", "Trainer data compiled by the Radical Red community. "
                 "Generated by tools/extract_trainers.py."),
        ("trainerOrder", order),
        ("segments", segments),
    ])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        if args.out.endswith(".js"):
            fh.write("// Generated by tools/extract_trainers.py -- do not edit.\n")
            fh.write("var RR_TRAINER_DATA = ")
            json.dump(payload, fh, separators=(",", ":"))
            fh.write(";\n")
        else:
            json.dump(payload, fh, separators=(",", ":"))

    mons = [m for s in segments for b in s["battles"] for m in b["team"]]
    print("\n%d battles / %d Pokemon / %d trainer-order entries"
          % (total, len(mons), len(order)))
    print("-> %s (%.0f KB)" % (args.out, os.path.getsize(args.out) / 1024.0))

    fixed = [m for m in mons if m["level"] and m["level"]["type"] == "fixed"]
    relative = [m for m in mons if m["level"] and m["level"]["type"] == "relative"]
    unknown = [m for m in mons if not m["level"] or m["level"]["type"] == "unknown"]
    print("\nlevels: %d fixed, %d relative-to-player, %d unparsed"
          % (len(fixed), len(relative), len(unknown)))
    for m in unknown[:5]:
        print("   unparsed level: %s %s" % (m["sheetName"], m["level"]))

    checked = [m for m in mons if m["speedVerified"] is not None]
    good = [m for m in checked if m["speedVerified"]]
    print("speed cross-check: %d/%d reconciled (%.1f%%) of the %d checkable"
          % (len(good), len(checked),
             100.0 * len(good) / max(len(checked), 1), len(checked)))
    print("solved Speed IVs: %s"
          % sorted(Counter(m["ivs"]["spe"] for m in good).items()))

    missing_moves = sum(1 for m in mons if not m["moves"])
    print("Pokemon with no moves parsed: %d" % missing_moves)

    hp_mons = [m for m in mons if m["hiddenPower"]]
    hp_checked = [m for m in hp_mons if m["speedVerified"] is not None]
    hp_ok = [m for m in hp_checked if m["speedVerified"]]
    print("Hidden Power carriers: %d (%d checkable, %d still reconcile)"
          % (len(hp_mons), len(hp_checked), len(hp_ok)))

    if norm.unresolved:
        by_kind = {}
        for kind, raw, ctx in norm.unresolved:
            by_kind.setdefault(kind, {}).setdefault(raw, ctx)
        print("\nUNRESOLVED (%d distinct):" % sum(len(v) for v in by_kind.values()))
        for kind, items in sorted(by_kind.items()):
            print("  %s (%d):" % (kind, len(items)))
            for raw, ctx in sorted(items.items())[:40]:
                print("     %-30s %s" % (repr(raw)[:30], ctx))
    else:
        print("\nAll species/move/item/ability names resolved.")

    if warnings:
        print("\nSPEED MISMATCHES (%d):" % len(warnings))
        for w in warnings[:20]:
            print("  " + w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
