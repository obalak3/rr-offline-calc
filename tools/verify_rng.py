#!/usr/bin/env python3
"""
Confirm (or kill) an RNG-seed candidate using two states seconds apart.

Why this test and not the outcome test. Labelling states by what the roll did
-- burn, no burn -- sounds decisive and is not: the number of Random() calls
between the save point and the roll is unknown, so the test carries a free
parameter k, and searching a few thousand k's finds a fit for almost any word.
Measured on the real candidates, 825 of 4000 advance counts "worked", which is
exactly the rate chance predicts. That test cannot distinguish anything.

What IS decisive is the LCG recurrence with a BOUNDED k. Save twice on the same
screen a few seconds apart. Nothing happens in between except frames, so the
true seed has advanced by a small, plausible number of steps, while an
unrelated word has no reason to be any iterate of itself within that bound.
Report every word that fits and how far it moved; the seed should be the one
whose step count scales with the seconds waited.

Usage:  verify_rng.py EARLY.ss LATE.ss [max_steps]
"""
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from savestate import EW_LEN, EW_OFF, IW_LEN, IW_OFF, load

GENS = (("Gen-3 Random()", 0x41C64E6D, 0x00006073),
        ("AIRandom", 1103515245, 24691))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    a, b = load(sys.argv[1]), load(sys.argv[2])
    steps = int(sys.argv[3]) if len(sys.argv) > 3 else 200000

    for label, mul, add in GENS:
        print("\n  %s, up to %d advances" % (label, steps))
        for name, off, ln, base in (("IWRAM", IW_OFF, IW_LEN, 0x03000000),
                                    ("EWRAM", EW_OFF, EW_LEN, 0x02000000)):
            x = np.frombuffer(a[off:off + ln], dtype="<u4").astype(np.uint64)
            y = np.frombuffer(b[off:off + ln], dtype="<u4").astype(np.uint64)
            live = (x != y) & (x != 0) & (y != 0)
            if not live.any():
                continue
            idx = np.nonzero(live)[0]
            v = x[idx].copy()
            target = y[idx]
            found = np.zeros(len(idx), dtype=np.int64)
            M, A, MOD = np.uint64(mul), np.uint64(add), np.uint64(0xFFFFFFFF)
            for k in range(1, steps + 1):
                v = (v * M + A) & MOD
                hit = (v == target) & (found == 0)
                if hit.any():
                    found[hit] = k
            got = np.nonzero(found)[0]
            print("    %s: %d live words, %d fit the recurrence" % (name, len(idx), len(got)))
            order = got[np.argsort(found[got])]
            for i in order[:12]:
                print("      0x%08X  %08X -> %08X  after %d advances"
                      % (base + int(idx[i]) * 4, int(x[idx[i]]), int(y[idx[i]]), found[i]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
