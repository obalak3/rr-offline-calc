#!/usr/bin/env python3
"""
Learn a screen-state codebook from the recorded corpus.

WHY A CODEBOOK AND NOT RULES. The obvious approach is hand-written region
checks: "if the bottom-right box is light and has four words, it's the action
menu". That is a pile of magic numbers that breaks on the first screen nobody
anticipated. Instead this clusters the bottom third of every recorded frame --
which is exactly where the game announces what kind of screen it is -- and keeps
the cluster centres as templates. Classifying a new frame is then nearest
centroid, and adding a screen we have never seen means recording it and
re-running this, not editing thresholds.

The bottom third is downsampled hard (30x8) on purpose. We want the LAYOUT of
the box -- full-width message, split menu, party grid -- not the text inside it.
Reading the text is a separate job with a much smaller candidate set.

Labels are assigned by hand once, from a contact sheet, and stored beside the
centroids. Several centroids may share a label: "message box" looks different
depending on how much text is in it, and that is fine, a codebook is allowed
more than one entry per class.

Run: build_classifier.py [--k 10] [--corpus DIR]
Writes tools/screen/screens.json
"""
import argparse, glob, json, os
import numpy as np
from PIL import Image

CROP = (0, 104, 240, 160)   # bottom third: message box / menus live here
SMALL = (30, 8)


def features(img):
    a = np.asarray(img.convert("RGB").crop(CROP).resize(SMALL), dtype=np.float32)
    return a.reshape(-1) / 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--corpus", default=os.path.expanduser("~/rr-screen-corpus"))
    ap.add_argument("--step", type=int, default=3)
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.corpus, "surge_run*", "f*.png")))[:: args.step]
    if not files:
        raise SystemExit("no frames found under " + args.corpus)
    V = np.array([features(Image.open(f)) for f in files])
    print(f"{len(files)} frames sampled")

    rng = np.random.default_rng(0)
    C = V[rng.choice(len(V), args.k, replace=False)].copy()
    for _ in range(40):
        lab = ((V[:, None, :] - C[None, :, :]) ** 2).sum(-1).argmin(1)
        for k in range(args.k):
            if (lab == k).any():
                C[k] = V[lab == k].mean(0)

    counts = np.bincount(lab, minlength=args.k).tolist()
    out = {
        "crop": CROP, "small": SMALL,
        "centroids": C.tolist(),
        "counts": counts,
        # Filled in by hand from the contact sheet; see LABELS below.
        "labels": [None] * args.k,
        "examples": [files[int(np.where(lab == k)[0][len(np.where(lab == k)[0]) // 2])]
                     if counts[k] else None for k in range(args.k)],
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screens.json")
    with open(path, "w") as f:
        json.dump(out, f)
    print("wrote", path)
    for k in range(args.k):
        print(f"  centroid {k}: {counts[k]:5d} frames   {out['examples'][k]}")


if __name__ == "__main__":
    main()
