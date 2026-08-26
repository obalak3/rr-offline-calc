#!/usr/bin/env python3
"""
Build trainer sets from save states, for fights our data does not have.

score_oracle.js can only score a decision when the engine can BUILD the
position, which needs the trainer's team in our data. Of the five fights
recorded so far, three are route trainers absent from the spreadsheet our
trainer data came from, so 49 of 59 real AI decisions were unscorable. That is
a data gap, not a fidelity result -- and the emulator can close it.

gBattleMons carries everything a set needs, already verified field by field
against known values: species at +0x00, moves at +0x0C, ability at +0x20, HP at
+0x28, level at +0x2A, max HP at +0x2C, item at +0x2E. Reading it from a save
state needs no emulator at all.

WHAT THIS CANNOT DO, and it bounds the idea. Only the ACTIVE Pokemon is in
gBattleMons, so one save state yields one set per side, not a team. Filling a
bench needs states where those Pokemon are out, or the oracle logging them as
they switch in. Stats are also the battle's CURRENT values, so anything already
boosted or lowered would be captured wrong; nothing here is boosted, but a
state captured mid-fight could be.

Emitted as JSON for the JS side to consume.

Run: extract_sets.py [STATE ...]
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from savestate import EW_LEN, EW_OFF, load

MON, SIZE = 0x02023BE4, 0x58
O_SP, O_MOVES, O_ABILITY, O_HP, O_LEVEL, O_MAX, O_ITEM = (
    0x00, 0x0C, 0x20, 0x28, 0x2A, 0x2C, 0x2E)

HERE = os.path.dirname(os.path.abspath(__file__))
IDMAP = json.load(open(os.path.join(HERE, "fixtures", "rr-id-map.json")))


def read_side(ew, base):
    def u(addr, size):
        o = addr - 0x02000000
        return int.from_bytes(ew[o:o + size], "little")
    sp = u(base + O_SP, 2)
    moves = [u(base + O_MOVES + i * 2, 2) for i in range(4)]
    return {
        "species_id": sp,
        "species": IDMAP["species"].get(str(sp), str(sp)),
        "level": u(base + O_LEVEL, 1),
        "maxHP": u(base + O_MAX, 2),
        "curHP": u(base + O_HP, 2),
        "ability_id": u(base + O_ABILITY, 1),
        "ability": IDMAP["abilities"].get(str(u(base + O_ABILITY, 1)), "?"),
        "item_id": u(base + O_ITEM, 2),
        "moves": [IDMAP["moves"].get(str(m), str(m)) for m in moves if m],
    }


def main():
    paths = sys.argv[1:] or [
        os.path.expanduser("~/RadicalRed-mGBA/RadicalRed.ss%d" % i)
        for i in range(1, 6)]
    out = []
    for p in paths:
        if not os.path.exists(p):
            continue
        ew = load(p)[EW_OFF:EW_OFF + EW_LEN]
        rec = {"state": os.path.basename(p),
               "ours": read_side(ew, MON),
               "foe": read_side(ew, MON + SIZE)}
        out.append(rec)
        f, o = rec["foe"], rec["ours"]
        print("%-22s ours %-12s L%-3d | foe %-12s L%-3d %-18s %s"
              % (rec["state"], o["species"], o["level"],
                 f["species"], f["level"], f["ability"], ", ".join(f["moves"])))
    dest = os.path.join(HERE, "fixtures", "extracted-sets.json")
    json.dump(out, open(dest, "w"), indent=1)
    print("\nwrote " + dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
