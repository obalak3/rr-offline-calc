#!/usr/bin/env python3
"""
Does the message reader recover the right moves?

The check that matters is not "did it decode something" but "is what it decoded
a move the Pokemon in question actually carries". Both move pools are known
independently of the pixels -- ours from the save, Surge's from trainer data --
so a decoded move that is not in the relevant pool is a real failure, and this
is a genuine external check rather than the reader agreeing with itself.

Run: /usr/local/bin/python3 tools/screen/test_read_message.py
"""
import collections
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify
from read_message import read_move

CORPUS = os.path.expanduser("~/rr-screen-corpus")

# James's party, from tools/read_save.js on the corpus save.
OURS = {
    "Fake Out", "Drain Punch", "Detect", "Rock Tomb",
    "Take Down", "Bulldoze", "Double Kick", "Odor Sleuth",
    "Scald", "Confuse Ray", "Signal Beam", "Shock Wave",
    "Recover", "Baby-Doll Eyes", "Sleep Powder", "Mega Drain",
    "Headbutt", "Mach Punch", "Force Palm", "Bullet Seed",
    "Sludge", "Leaf Storm",
}
# Lt. Surge's five, from trainer data. Kept as a set because which Pokemon is
# out is read separately by read_name; this checks the team-level pool.
THEIRS = {
    "Hidden Power", "Discharge", "Mud Shot", "Bug Buzz", "Thunder Wave",
    "Ice Punch", "Thunder Punch", "Volt Switch", "Charge Beam", "Scald",
    "Parabolic Charge", "Drain Punch", "Mach Punch", "Boost", "Roost",
}


def main():
    files = sorted(glob.glob(os.path.join(CORPUS, "surge_run*", "*.png")))
    if not files:
        print("no corpus at", CORPUS)
        return 1

    reads = collections.Counter()
    unreadable = collections.Counter()
    frames = 0
    for f in files:
        im = Image.open(f).convert("RGB")
        a = np.asarray(im)
        if a.shape[:2] != (160, 240):
            continue
        label, dist, _ = classify.classify(im)
        if label != "message" or dist >= classify.TRUSTWORTHY:
            continue
        frames += 1
        got = read_move(a)
        if got is None:
            continue
        side, move = got
        if "?" in move:
            unreadable[(side, move)] += 1
        else:
            reads[(side, move)] += 1

    print(f"  {frames} message frames, {sum(reads.values())} move readings, "
          f"{len(reads)} distinct")
    bad = []
    for (side, move), n in reads.most_common():
        pool = THEIRS if side == "foe" else OURS
        ok = move in pool
        if not ok:
            bad.append((side, move, n))
        print(f"    {'FOE ' if side == 'foe' else 'OURS'} {move:20s} {n:5d}"
              f"{'' if ok else '   <-- NOT IN POOL'}")
    if unreadable:
        print(f"\n  {sum(unreadable.values())} readings had unknown glyphs:")
        for (side, move), n in unreadable.most_common(8):
            print(f"    {side:4s} {move:24s} {n}")

    ok = True
    if bad:
        ok = False
        print(f"\n  FAIL: {len(bad)} move(s) not in the carrier's pool")
    if len(reads) < 15:
        ok = False
        print(f"\n  FAIL: only {len(reads)} distinct moves read")
    print("\n  PASS" if ok else "\n  FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
