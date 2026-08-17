#!/usr/bin/env python3
"""
Refresh the cached copy of the Radical Red trainer spreadsheet.

Needs network. Run this when the community sheet has been updated, then re-run
extract_trainers.py. Everything else in this project works offline.

  python3 tools/fetch_sheet.py

Why CSV and not .xlsx/.ods: Google's binary exports omit cached values for
formula cells, which wipes out most of the level column. The per-tab CSV export
renders formulas and preserves the literal grid, blank rows included -- the
gviz endpoint renders formulas but drops blank rows, which breaks the fixed row
offsets the parser relies on.

Credit for the underlying data: the Radical Red community.
See THIRD-PARTY-NOTICES.md.
"""

import os
import sys
import urllib.request

SHEET_ID = "1ES8L4OzeJ8rCuMWFNvrDaZKArqR7Vys2ytFxjx2pbwE"

# gid -> human-readable tab name. Identified by content, since Google does not
# expose tab names next to gids in any stable public endpoint.
TABS = {
    "704367260": "Main",
    "306634858": "Trainer Order",
    "1410111071": "Kanto Leaders",
    "2075653688": "Kanto Rematch",
    "2145471124": "Johto Leaders",
    "1150799580": "Rivals",
    "1998272076": "Team Rocket",
    "1752505021": "Mini Bosses",
    "739017967": "Optional Bosses",
    "1411568458": "Indigo League",
    "2140479091": "Postgame",
}

URL = ("https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s")


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = os.path.join(here, "data", "csv")
    os.makedirs(outdir, exist_ok=True)

    failures = 0
    for gid, name in TABS.items():
        path = os.path.join(outdir, gid + ".csv")
        try:
            with urllib.request.urlopen(URL % (SHEET_ID, gid), timeout=60) as resp:
                body = resp.read()
        except Exception as exc:              # noqa: BLE001 - report and continue
            print("  FAIL %-16s %s" % (name, exc))
            failures += 1
            continue
        if not body.strip():
            print("  FAIL %-16s empty response" % name)
            failures += 1
            continue
        with open(path, "wb") as fh:
            fh.write(body)
        print("  ok   %-16s %6d bytes -> data/csv/%s.csv" % (name, len(body), gid))

    if failures:
        print("\n%d tab(s) failed; existing cached copies were left alone." % failures)
        return 1
    print("\nAll %d tabs cached. Now run: python3 tools/extract_trainers.py" % len(TABS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
