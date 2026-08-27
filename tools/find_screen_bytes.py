#!/usr/bin/env python3
"""Find the bytes that tell you which battle screen is up.

Run: python3 tools/find_screen_bytes.py

Reads the labelled RAM snapshots that tools/lua/map_screens.lua dumps and looks
for addresses whose value is STABLE across frames that share a screen and
DIFFERENT between screens. That is the whole requirement: the agent has to be
able to ask "what is on screen right now" and get a reliable answer before it
is allowed to press anything.

The discipline here is the one this project keeps having to relearn. A window
built around a guess can only ever confirm the guess -- the action cursor was
guessed at 0x02023BCE and measured at 0x02023FF8, a kilobyte away. So this
scans whole regions and reports what actually separates the screens, including
how many other addresses do the same thing (a discriminator that is unique is
worth more than one of four hundred).

Three snapshots are labelled `action_menu`, `action_menu2` and `action_menu3`:
they are the SAME screen reached three different ways, and they are the control.
Any address that differs between them is tracking something else -- a frame
counter, an animation timer, the RNG -- and is thrown out no matter how nicely
it separates the other screens.
"""
import os
import sys
from collections import defaultdict

DIR = os.path.expanduser("~/rr-screen-corpus/screens/")
REGIONS = {"ew": 0x02020000, "iw": 0x03000000}

# Same screen, reached three ways. Anything not constant across these is noise.
CONTROL = ["action_menu", "action_menu2", "action_menu3"]


def load(label, region):
    path = os.path.join(DIR, "%s.%s.bin" % (label, region))
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return fh.read()


def main():
    if not os.path.isdir(DIR):
        sys.exit("no snapshots at " + DIR + " -- run tools/lua/map_screens.lua first")
    labels = sorted({f.split(".")[0] for f in os.listdir(DIR) if f.endswith(".bin")})
    if not labels:
        sys.exit("no .bin snapshots in " + DIR)
    print("snapshots: " + ", ".join(labels) + "\n")

    for region, base in REGIONS.items():
        snaps = {l: load(l, region) for l in labels}
        snaps = {l: v for l, v in snaps.items() if v}
        if len(snaps) < 2:
            continue
        size = min(len(v) for v in snaps.values())
        present_control = [c for c in CONTROL if c in snaps]
        if len(present_control) < 2:
            print("%s: no control pair, cannot separate screen state from noise"
                  % region)
            continue

        # 1. Throw out every address that moves between two snapshots of the
        #    SAME screen. Those are timers, counters and RNG, not screen state.
        stable = bytearray(size)
        ref = snaps[present_control[0]]
        for c in present_control[1:]:
            other = snaps[c]
            for i in range(size):
                if ref[i] != other[i]:
                    stable[i] = 1
        noisy = sum(stable)
        print("%s: %d of %d bytes differ between two snapshots of the SAME "
              "screen -- discarded as noise" % (region, noisy, size))

        # 2. Of what is left, keep addresses that take different values on
        #    different screens.
        groups = defaultdict(list)
        others = [l for l in snaps if l not in CONTROL]
        for i in range(size):
            if stable[i]:
                continue
            baseline = ref[i]
            differing = [l for l in others if snaps[l][i] != baseline]
            if not differing:
                continue
            # The signature: which screens this address distinguishes, and how.
            sig = tuple(sorted((l, snaps[l][i]) for l in others))
            groups[(baseline, sig)].append(base + i)

        if not groups:
            print("  nothing separates the screens in this region\n")
            continue

        ranked = sorted(groups.items(), key=lambda kv: len(kv[1]))
        print("  %d distinct discriminator patterns\n" % len(ranked))
        for (baseline, sig), addrs in ranked[:8]:
            print("  pattern held by %d address(es), e.g. 0x%08X"
                  % (len(addrs), addrs[0]))
            print("    action_menu = %d" % baseline)
            for label, value in sig:
                print("    %-16s = %d" % (label, value))
            if len(addrs) <= 6:
                print("    all: " + ", ".join("0x%08X" % a for a in addrs))
            print()


if __name__ == "__main__":
    main()
