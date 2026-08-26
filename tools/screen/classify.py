#!/usr/bin/env python3
"""
Which kind of screen is this? Nearest centroid against the learned codebook.

Five states matter to the advisor and four of them are here:
    action_prompt   "What will X do?" -- a decision is pending, advise NOW
    move_menu       the four moves are open -- the player is mid-decision
    party           the party list -- a switch or a replacement is being chosen
    message         the box is saying something; the turn is still resolving
    other           title screen, PC, anything not part of a battle

The fifth, the "will you switch?" shift prompt, does not appear in 8200 frames
of Lt. Surge, because that trainer runs in Set mode. It is not implemented on
guesswork; record a trainer that offers it and rebuild the codebook.

`distance` comes back with every classification and is the honest confidence:
a frame unlike anything in the corpus lands far from every centroid, and a
caller should treat a large distance as "I have not seen this screen" rather
than trusting the nearest label.

CALIBRATED against the clean-win run (1000 frames), and the threshold is
measured rather than chosen:

    distance < 2.2    reliable. Every frame inspected at this range was right.
    distance > 2.2    do not trust the label. Every misclassification found sat
                      here: an action prompt read as "message" at 5.72, a party
                      submenu read as "move_menu" at 8.17.
    percentiles       p50 1.33, p75 1.85, p90 2.10, p99 8.07

The frames above the threshold are mostly screens the codebook has never seen --
the party submenu (Shift / Summary / Cancel), the Pokemon Skills summary page --
and menu frames where the cursor sits on a different entry. All three are fixed
the same way, by recording them and rebuilding, which is the point of a codebook
over hand-written rules.
"""

TRUSTWORTHY = 2.2
import json
import os

import numpy as np
from PIL import Image

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screens.json")
_MODEL = None


def _model():
    global _MODEL
    if _MODEL is None:
        with open(_PATH) as f:
            d = json.load(f)
        d["centroids"] = np.array(d["centroids"], dtype=np.float32)
        _MODEL = d
    return _MODEL


def features(img):
    m = _model()
    a = np.asarray(img.convert("RGB").crop(tuple(m["crop"])).resize(tuple(m["small"])),
                   dtype=np.float32)
    return a.reshape(-1) / 255.0


def classify(img):
    """(label, distance, centroid_index). Distance is the confidence signal."""
    m = _model()
    v = features(img)
    d = ((m["centroids"] - v) ** 2).sum(1)
    k = int(d.argmin())
    return m["labels"][k], float(np.sqrt(d[k])), k


if __name__ == "__main__":
    import glob
    import sys
    pats = sys.argv[1:] or [os.path.expanduser("~/rr-screen-corpus/surge_run7/f0*.png")]
    files = []
    for p in pats:
        files.extend(sorted(glob.glob(p)))
    tally = {}
    far = 0
    for f in files:
        lab, dist, _ = classify(Image.open(f))
        tally[lab] = tally.get(lab, 0) + 1
        if dist > 1.5:
            far += 1
    print(f"{len(files)} frames")
    for k in sorted(tally, key=lambda x: -tally[x]):
        print(f"  {k:14s} {tally[k]:5d}  ({100*tally[k]/len(files):.1f}%)")
    print(f"  far from any centroid (>1.5): {far}")
