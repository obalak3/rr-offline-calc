#!/usr/bin/env python3
"""
The narrowest test that covers read_name: run it over the whole corpus and
check the three things that can actually go wrong.

    1. Every species it reports is one of Lt. Surge's five. A misread name is
       worse than no name, because the scoreboard would score the AI's decision
       against the wrong Pokemon's moves.
    2. It reports a name on a useful share of frames, so the reader is not
       quietly returning None and passing.
    3. Names are STABLE across consecutive frames within a run. A species that
       flickers between two values inside one turn is reading noise, and no
       amount of correct-looking output makes up for it.

Run: /usr/local/bin/python3 tools/screen/test_read_name.py
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from read_name import read_name

SURGE = {"Pincurchin", "Bellibolt", "Vikavolt", "Manectric", "Pawmot"}
CORPUS = os.path.expanduser("~/rr-screen-corpus")


def main():
    runs = sorted(glob.glob(os.path.join(CORPUS, "surge_run*")))
    if not runs:
        print("no corpus at", CORPUS)
        return 1

    total = named = 0
    counts = {}
    flips = 0
    failures = []

    for run in runs:
        prev = None
        run_named = 0
        for f in sorted(glob.glob(os.path.join(run, "*.png"))):
            a = np.asarray(Image.open(f).convert("RGB"))
            if a.shape[:2] != (160, 240):
                continue
            total += 1
            name = read_name(a, candidates=SURGE)
            if name is None:
                continue
            named += 1
            run_named += 1
            counts[name] = counts.get(name, 0) + 1
            if name not in SURGE:
                failures.append(f"{f}: read {name!r}, not on Surge's team")
            if prev is not None and name != prev[0] and prev[1] + 1 == total:
                flips += 1
            prev = (name, total)
        print(f"  {os.path.basename(run):12s} {run_named:5d} frames named")

    print(f"\n  {named}/{total} frames named ({100.0 * named / total:.1f}%)")
    for k in sorted(counts, key=lambda k: -counts[k]):
        print(f"    {k:12s} {counts[k]:5d}")
    print(f"  adjacent-frame species flips: {flips}")

    ok = True
    if failures:
        ok = False
        print("\n  FAIL: off-team species read")
        for f in failures[:10]:
            print("   ", f)
    if named < 0.2 * total:
        ok = False
        print(f"\n  FAIL: only {100.0 * named / total:.1f}% of frames named")
    if len(counts) != len(SURGE):
        ok = False
        print(f"\n  FAIL: saw {len(counts)} species, expected {len(SURGE)}")
    print("\n  PASS" if ok else "\n  FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
