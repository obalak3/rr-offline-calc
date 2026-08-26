#!/usr/bin/env python3
"""
Read an mGBA save state, and find the RNG seeds inside it BY BEHAVIOUR.

James, 2026-08-26: "Since the rolls are decided at the start of the battle, is
there a way for us to find it out... it is recorded somewhere in the quicksave
file." It is, and this is the tool for getting at it.

WHAT A SAVE STATE IS. mGBA writes a PNG whose custom `gbAs` chunk is a
zlib-compressed GBASerializedState, 0x61000 bytes, laid out as

    0x00300  IWRAM   32 KiB   -> GBA 0x03000000
    0x08300  EWRAM  256 KiB   -> GBA 0x02000000

Verified by locating the player's party in EWRAM: six 100-byte structs whose
unencrypted tails carry level 34 and exactly our six known max HPs. Three
copies are present, one of them in battle order with the active Pokemon first.

WHY ADDRESSES DO NOT WORK HERE. Vanilla FireRed keeps gRngValue at 0x03005000;
in this ROM that word is zero. Radical Red is a heavily modified build and its
symbols have moved, so nothing can be read off a published address map.

THE TECHNIQUE THAT DOES WORK: find the seed by how it EVOLVES. Both generators
are linear congruential with known constants, taken from source:

    AIRandom   (ai_util.c:45)  seed = 1103515245 * seed + 24691
    Gen-3 Random()             seed = 0x41C64E6D * seed + 0x00006073

So given two save states from the SAME battle at different moments, the seed's
memory location is the word whose value in the later state equals the LCG
applied some small number of times to its value in the earlier one. Nothing
else in RAM evolves that way, and each extra state kills the coincidences.

This is what makes the whole idea practical: it needs no symbol table, no
disassembly, and no knowledge of where CFRU allocated gNewBS.

Run:  savestate.py STATE.ss1 [STATE2.ss2]
      one state  -> dump what we can identify
      two states -> hunt for the seeds
"""
import struct
import sys
import zlib

# CORRECTED 2026-08-26. These were 0x300 and 0x8300, guessed from a plausible
# reading of mGBA's struct, and WRONG -- which invalidated every address this
# file produced and sent a whole day of memory probing at addresses that do not
# exist. The right values are pinned by two independent facts, not by guessing:
# under this mapping the LCG-fitting word lands exactly on 0x03005000 (vanilla
# FireRed gRngValue, which the ROM names beside the multiplier 0x41C64E6D), and
# the player's party lands exactly on 0x02024284 (vanilla gPlayerParty). The
# regions also tile the state exactly: 0x19000 + 0x8000 + 0x40000 = 0x61000.
IW_OFF, IW_LEN = 0x19000, 0x8000
EW_OFF, EW_LEN = 0x21000, 0x40000

AI_MUL, AI_ADD = 1103515245, 24691          # ai_util.c:45
G3_MUL, G3_ADD = 0x41C64E6D, 0x00006073     # vanilla Gen-3 Random()
MASK = 0xFFFFFFFF


def load(path):
    """The decompressed GBASerializedState from an mGBA .ss file."""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(path + " is not an mGBA PNG save state")
    i, chunks = 8, {}
    while i < len(data) - 8:
        length = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        chunks[kind] = chunks.get(kind, b"") + data[i + 8:i + 8 + length]
        i += 12 + length
    if b"gbAs" not in chunks:
        raise ValueError("no gbAs chunk; not a GBA state?")
    return zlib.decompress(chunks[b"gbAs"])


def regions(raw):
    return {"IWRAM": (0x03000000, raw[IW_OFF:IW_OFF + IW_LEN]),
            "EWRAM": (0x02000000, raw[EW_OFF:EW_OFF + EW_LEN])}


def find_party(ew):
    """Party structs, located by known level and max HP rather than address."""
    known = {98, 112, 139, 102, 95, 108}
    out = []
    for base in range(0, len(ew) - 600, 4):
        got = []
        for k in range(6):
            o = base + 100 * k
            level = ew[o + 0x54]
            cur, mx = struct.unpack("<HH", ew[o + 0x56:o + 0x5A])
            if level != 34 or mx not in known or cur > mx:
                got = None
                break
            got.append((cur, mx))
        if got:
            out.append((0x02000000 + base, got))
    return out


def hunt(raw_a, raw_b, mul, add, max_steps=4096):
    """Words that evolve from state A to state B under this LCG.

    Reported with the number of advances, which is itself informative: the AI
    seed advances only when the AI calls it, so a small step count across a few
    turns is what a real hit looks like.
    """
    hits = []
    for name, (base, a) in regions(raw_a).items():
        b = regions(raw_b)[name][1]
        for off in range(0, min(len(a), len(b)) - 4, 4):
            x = struct.unpack("<I", a[off:off + 4])[0]
            y = struct.unpack("<I", b[off:off + 4])[0]
            if x == y or x == 0 or y == 0:
                continue
            v = x
            for step in range(1, max_steps + 1):
                v = (mul * v + add) & MASK
                if v == y:
                    hits.append((name, base + off, x, y, step))
                    break
    return hits


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    raw_a = load(sys.argv[1])
    print("state 1: %s, %d bytes" % (sys.argv[1], len(raw_a)))
    ew = regions(raw_a)["EWRAM"][1]
    for addr, mons in find_party(ew)[:3]:
        print("  party at 0x%08X: %s" % (
            addr, " ".join("%d/%d" % m for m in mons)))

    if len(sys.argv) < 3:
        print("\npass a SECOND state from the same battle to hunt for the seeds")
        return 0

    raw_b = load(sys.argv[2])
    print("state 2: %s, %d bytes" % (sys.argv[2], len(raw_b)))
    for label, mul, add in (("AIRandom", AI_MUL, AI_ADD),
                            ("Gen-3 Random", G3_MUL, G3_ADD)):
        hits = hunt(raw_a, raw_b, mul, add)
        print("\n  %s candidates: %d" % (label, len(hits)))
        for name, addr, x, y, step in hits[:12]:
            print("    %s 0x%08X  %08X -> %08X  after %d advance(s)"
                  % (name, addr, x, y, step))
    return 0


if __name__ == "__main__":
    sys.exit(main())
