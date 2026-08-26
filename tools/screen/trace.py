#!/usr/bin/env python3
"""
Turn a folder of frames into a battle trace: who is out, at what HP, foe bar.

PLAN-SCREEN-READER step 4. The reader's job is not to describe pixels but to
emit one row per decision point, and an action prompt IS a decision point --
the game is asking what to do and everything on screen is stable.

Species comes free from the max HP. All six of this party have distinct maxima
(98, 112, 139, 102, 95, 108), so the number the status box already prints
identifies which Pokemon is out, with no sprite matching at all. That will not
hold for every party, so it degrades to "unknown" rather than guessing when two
share a maximum.

Deduplication is on the whole reading, so consecutive identical frames collapse
to one row and the output is a turn log rather than a frame dump.

Run: trace.py [FRAME_DIR]
"""
import glob
import json
import os
import subprocess
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify
import read_bar
import read_hp


def party_from_save():
    """species -> maxHP, straight from the battery save. Never ask, read it."""
    # Via party_maxhp.js, not read_save.js: max HP is DERIVED from species,
    # level, nature and IVs rather than stored in the save, so it has to be
    # computed through the engine. Doing it there rather than here also means
    # these are the same numbers the damage calculation uses.
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    try:
        out = subprocess.run(["node", os.path.join(root, "tools/party_maxhp.js"), "--json"],
                             capture_output=True, text=True, timeout=60).stdout
        d = json.loads(out.strip().split("\n")[-1])
    except Exception:
        return {}
    # Only unambiguous maxima identify a Pokemon. If two share one, both are
    # dropped and the trace says "?" rather than picking one.
    return {int(k): v for k, v in d.get("unique_by_max", {}).items()}


def trace(folder, by_max=None):
    by_max = by_max if by_max is not None else party_from_save()
    rows = []
    last = None
    for f in sorted(glob.glob(os.path.join(folder, "f*.png"))):
        img = Image.open(f)
        label, dist, _ = classify.classify(img)
        if label != "action_prompt" or dist > classify.TRUSTWORTHY:
            continue
        hp = read_hp.read_hp(img)
        bar = read_bar.read_bar(img)
        if hp is None or bar is None:
            continue
        rec = (by_max.get(hp[1], "?"), hp[0], hp[1], bar)
        if rec != last:
            rows.append({"frame": os.path.basename(f), "species": rec[0],
                         "hp": rec[1], "maxhp": rec[2], "foe_bar": rec[3]})
            last = rec
    return rows


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else \
        os.path.expanduser("~/rr-screen-corpus/surge_run7")
    by_max = party_from_save()
    print("party by max HP:", by_max or "(save unreadable; species will be '?')")
    rows = trace(folder, by_max)
    print(f"\n{len(rows)} decision points read from {os.path.basename(folder)}\n")
    print("  frame       you                     foe bar")
    for r in rows:
        bar = r["foe_bar"]
        meter = "#" * round(bar / 3) + "." * (16 - round(bar / 3))
        print(f"  {r['frame']:11s} {r['species']:<12s} {r['hp']:3d}/{r['maxhp']:<3d}   "
              f"{meter} {bar:2d}/48")
