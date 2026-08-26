#!/usr/bin/env python3
"""
Find the RNG in RAM by DIFFERENTIAL comparison of labelled save states.

James's experimental design, 2026-08-26, and it is a much better one than the
two-states-from-one-battle approach it replaces. That version failed for a
reason worth recording: across a few turns of the same battle 6,824 EWRAM words
change and the seed has advanced an unknown number of times, so there is
nothing to anchor on.

His version: restart the battle, play to the SAME point, quicksave, then take
the action whose outcome is random -- Scald, which burns 30% of the time -- and
label the state by what happened. Repeat.

Now the states are nearly identical in everything except the randomness, and
the label says which way the randomness went. The seed is a word that
partitions the states the same way the outcomes do. That is an ordinary
differential memory search, and it needs no address map, no symbol table, and
no assumption about how many times anything advanced.

WHY THE LABEL MATTERS SO MUCH. Without it, every word that differs is a
candidate. With it, a candidate must ALSO split burn-states from no-burn-states
consistently, which almost nothing does by accident. Each additional labelled
state roughly squares the filtering.

Usage:
    find_rng.py burn:STATE1.ss3 noburn:STATE2.ss4 burn:STATE3.ss5 ...

Prefix each file with its observed outcome. Any two labels work as long as they
are used consistently; "burn" and "noburn" are just names.
"""
import collections
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from savestate import EW_LEN, EW_OFF, IW_LEN, IW_OFF, load


def words(raw, off, ln):
    return np.frombuffer(raw[off:off + ln], dtype="<u4")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    labelled = []
    for arg in sys.argv[1:]:
        if ":" not in arg:
            print("each file needs a label, e.g. burn:state.ss3")
            return 1
        label, path = arg.split(":", 1)
        labelled.append((label, path, load(path)))
    groups = collections.Counter(l for l, _, _ in labelled)
    print("%d states: %s" % (len(labelled), dict(groups)))
    if len(groups) < 2:
        print("need at least two DIFFERENT outcomes to partition on")
        return 1

    for name, off, ln, base in (("IWRAM", IW_OFF, IW_LEN, 0x03000000),
                                ("EWRAM", EW_OFF, EW_LEN, 0x02000000)):
        mats = np.stack([words(raw, off, ln) for _, _, raw in labelled])
        labels = [l for l, _, _ in labelled]

        # A candidate must be CONSTANT within each outcome group and DIFFERENT
        # between them. That is the signature of a value that decides the roll.
        ok = np.ones(mats.shape[1], dtype=bool)
        per_group = {}
        for g in groups:
            rows = mats[[i for i, l in enumerate(labels) if l == g]]
            ok &= (rows == rows[0]).all(axis=0)
            per_group[g] = rows[0]
        gs = list(groups)
        differs = np.zeros(mats.shape[1], dtype=bool)
        for i in range(len(gs)):
            for j in range(i + 1, len(gs)):
                differs |= per_group[gs[i]] != per_group[gs[j]]
        hits = np.nonzero(ok & differs)[0]

        # Also report the weaker "just differs somewhere" count, so a run that
        # finds nothing can be told apart from a run where the states were too
        # dissimilar for the strict test to mean anything.
        anydiff = int((mats != mats[0]).any(axis=0).sum())
        print("\n  %s: %d words differ across states; %d survive the partition test"
              % (name, anydiff, len(hits)))
        for i in hits[:20]:
            vals = ", ".join("%s=%08X" % (g, per_group[g][i]) for g in gs)
            print("    0x%08X   %s" % (base + int(i) * 4, vals))
        if len(hits) > 20:
            print("    ... %d more" % (len(hits) - 20))
    print("\nA true seed should appear in EWRAM (gNewBS is heap-allocated) or")
    print("IWRAM, and should survive as more labelled states are added.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
