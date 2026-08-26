#!/usr/bin/env python3
"""
Read a quicksave, say what the dice have already decided.

This is the feature the whole RNG thread existed for. James: "I can quicksave
and if you can find something just from that without me having to reload that
is fair game." No reloading, no scouting: one save state, and the next rolls
are stated before he commits to a move.

WHAT IS STATED AND WHY IT CAN BE. The battle generator at 0x020386D0 is
deterministic, and the next damage event consumes its draws at fixed offsets:

    crit  = ((draw#3 >> 16) % 24) == 0
    roll  =  (draw#4 >> 16) % 16          (0 = max damage .. 15 = min)

Calibrated on 256 trials of one position, then validated on 23/23 damage
events from a DIFFERENT run's wild and trainer fights (tools/analyze_run.py),
where a wrong model almost always leaves no consistent base damage. That
cross-run check is what makes this tool honest rather than hopeful.

WHAT IS DELIBERATELY NOT STATED. Rolls beyond the next damage event. The
divergence experiment measured different moves consuming different numbers of
draws (3 to 14), so second-event predictions depend on which move is chosen
in between; a table of "the next five rolls" would be confidently wrong. One
event, stated plainly, is what the data supports.

Run: next_rolls.py [savestate.ssN]     (defaults to the newest RadicalRed.ss*)
"""
import glob
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from savestate import EW_LEN, EW_OFF, IW_LEN, IW_OFF, load

MUL, ADD, MASK = 1103515245, 12345, 0xFFFFFFFF
RNG = 0x020386D0
MON, SIZE = 0x02023BE4, 0x58

import json
HERE = os.path.dirname(os.path.abspath(__file__))
IDM = json.load(open(os.path.join(HERE, "fixtures", "rr-id-map.json")))


def word(raw, addr, size=4):
    if addr >= 0x03000000:
        base, seg = 0x03000000, raw[IW_OFF:IW_OFF + IW_LEN]
    else:
        base, seg = 0x02000000, raw[EW_OFF:EW_OFF + EW_LEN]
    o = addr - base
    return int.from_bytes(seg[o:o + size], "little")


def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
    else:
        states = sorted(glob.glob(os.path.expanduser("~/RadicalRed-mGBA/RadicalRed.ss*")),
                        key=os.path.getmtime)
        if not states:
            print("no save states found")
            return 1
        path = states[-1]

    raw = load(path)
    seed = word(raw, RNG)

    v, draws = seed, []
    for _ in range(4):
        v = (MUL * v + ADD) & MASK
        draws.append(v >> 16)
    crit = (draws[2] % 24) == 0
    roll = draws[3] % 16

    print("state: %s" % os.path.basename(path))
    for label, base in (("you", MON), ("foe", MON + SIZE)):
        sp = word(raw, base, 2)
        if sp:
            hp, mx = word(raw, base + 0x28, 2), word(raw, base + 0x2C, 2)
            print("  %-4s %-14s %d/%d" % (label, IDM["species"].get(str(sp), sp), hp, mx))

    print("")
    print("  NEXT DAMAGE EVENT (whoever attacks first):")
    print("    crit: %s" % ("YES" % () if crit else "no"))
    print("    roll: %d of 0..15  ->  %d%% of max damage"
          % (roll, 100 - roll))
    if crit:
        print("    a crit multiplies the base by 1.5 BEFORE the roll")
    print("")
    print("  Applies to the FIRST damaging hit after this save, either side.")
    print("  Anything after that depends on which moves get chosen in between,")
    print("  and is deliberately not predicted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
