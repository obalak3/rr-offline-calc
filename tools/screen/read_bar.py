#!/usr/bin/env python3
"""
The foe's HP, which the game shows only as a bar.

PLAN-SCREEN-READER step 3, and the interesting one: the opponent's exact HP is
never printed, so it has to be inferred. What the bar gives us is a fraction to
1/48; combining that with the foe's max HP (known from trainer data) and the
sixteen discrete damage values our move can roll usually pins it to a point or
two. See tools/lib/hpbar.js, which does that arithmetic and was measured.

MEASURED GEOMETRY, not guessed. Printing the raw pixels along the bar row shows
it runs from column 52 to column 99 inclusive -- exactly 48 pixels, which is the
GBA health bar -- on rows 33 and 34 of the canonical 240x160 frame.

EXACT COLOURS, no thresholds. This is pixel art, so the bar is drawn in a small
fixed palette and matching it exactly is both simpler and more reliable than any
brightness rule. Counted over 600 real frames, the bar contains:

    (0, 189, 33)     green, healthy
    (165, 132, 41)   yellow, below half
    (165, 74, 90)    red, low
    (66, 66, 66)     the depleted groove
    (0, 165, 24) / (140, 115, 33) / (57, 57, 57)   the darker shade of each,
                                                   the bar is two rows and the
                                                   lower one is shaded

An earlier attempt used brightness thresholds and reported a bar 65 pixels wide
with zero filled on frames that plainly had a health bar. Thresholds invent
problems that exact palette matching does not have.
"""
import os

import numpy as np
from PIL import Image

ROW = 33
COL0, COL1 = 52, 100          # [52, 100) = 48 pixels
WIDTH = COL1 - COL0

FILLED = {
    (0, 189, 33), (0, 165, 24),        # green
    (165, 132, 41), (140, 115, 33),    # yellow
    (165, 74, 90), (140, 57, 74),      # red
}
EMPTY = {(66, 66, 66), (57, 57, 57)}


def read_bar(img):
    """Filled pixels out of 48, or None if this frame has no foe health bar."""
    a = np.asarray(img.convert("RGB"))
    if a.shape[0] < ROW + 1 or a.shape[1] < COL1:
        return None
    row = a[ROW, COL0:COL1]
    filled = empty = 0
    for px in row:
        t = (int(px[0]), int(px[1]), int(px[2]))
        if t in FILLED:
            filled += 1
        elif t in EMPTY:
            empty += 1
    # Every pixel has to be one or the other, or we are not looking at a bar.
    if filled + empty < WIDTH - 2:
        return None
    return filled


def read_fraction(img):
    """Foe HP as a fraction in [0,1], or None."""
    n = read_bar(img)
    return None if n is None else n / WIDTH


if __name__ == "__main__":
    import glob
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import classify
    pats = sys.argv[1:] or [os.path.expanduser("~/rr-screen-corpus/surge_run7/f0*.png")]
    files = []
    for p in pats:
        files.extend(sorted(glob.glob(p)))
    ok = 0
    seq = []
    for f in files:
        img = Image.open(f)
        if classify.classify(img)[0] != "action_prompt":
            continue
        n = read_bar(img)
        if n is None:
            continue
        ok += 1
        if not seq or seq[-1] != n:
            seq.append(n)
    print(f"{ok} action-prompt frames with a readable bar")
    print("bar sequence (deduped, /48):", " ".join(str(n) for n in seq[:40]))
