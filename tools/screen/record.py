#!/usr/bin/env python3
"""
Record a corpus of distinct battle frames, once, to build the classifiers from.

The steady-state policy in PLAN-SCREEN-READER.md is that frames are never
archived: capture, extract an event, discard the pixels. This tool is the
deliberate exception, and it is bounded. Reading the screen needs templates for
the digits, the HP bars, and the four screen states, and those have to be cut
from real frames of this ROM at this window size. One recording session yields
them; after that the reader never writes a frame again except into the capped
debug bucket.

Only CHANGED frames are kept, which is what makes a whole battle fit in a few
hundred files instead of a few thousand: the screen is static most of the time,
sitting on a message or waiting for input.

Frames land in the scratch directory, never in the repo.

Run:  record.py [--max 400] [--every 0.0] [--out DIR]
Stop: ctrl-c, or it stops itself at --max.
"""

import argparse
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture

# Two frames differing by less than this on a 0..1 scale are the same screen as
# far as a corpus is concerned. Set well below the change a single text
# character makes, so a new message always counts as new.
CHANGE = 0.004


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=400, help="stop after this many kept frames")
    ap.add_argument("--every", type=float, default=0.0, help="seconds between captures")
    ap.add_argument("--out", default=os.path.join(capture.SCRATCH, "corpus"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print(f"recording to {args.out}")
    print("play normally. ctrl-c to stop.\n")

    kept = 0
    seen = 0
    last = None
    blank_notice = 0
    t0 = time.time()

    try:
        while kept < args.max:
            try:
                img = capture.frame()
            except (capture.NotVisible, capture.Occluded):
                # Expected whenever the emulator is not the visible Space. Say so
                # once rather than every 80 ms, and keep waiting.
                if not blank_notice:
                    print("waiting: mGBA is not visible or is covered by another "
                          "window (bring it to the front)")
                    blank_notice = 1
                time.sleep(0.5)
                continue
            if blank_notice:
                print("...capturing again")
                blank_notice = 0
            seen += 1
            a = np.asarray(img, dtype=np.int16)
            if last is None or np.abs(a - last).mean() / 255.0 > CHANGE:
                img.save(os.path.join(args.out, f"f{kept:04d}.png"))
                kept += 1
                last = a
                if kept % 25 == 0:
                    rate = seen / (time.time() - t0)
                    print(f"  kept {kept:4d} / seen {seen:5d}   {rate:.1f} Hz")
            if args.every:
                time.sleep(args.every)
    except KeyboardInterrupt:
        print("\nstopped")

    dt = time.time() - t0
    print(f"\nkept {kept} distinct frames from {seen} captures in {dt:.0f}s")
    if seen:
        print(f"sustained {seen / dt:.1f} Hz  "
              f"(~{0.33 * seen / dt:.1f} frames per battle message at 3x speed)")
    print(f"corpus: {args.out}")


if __name__ == "__main__":
    main()
