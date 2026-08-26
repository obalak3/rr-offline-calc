#!/usr/bin/env python3
"""
Our own HP, read exactly, from the digits the game prints.

This is the easiest and most valuable thing on the screen (PLAN-SCREEN-READER
step 1): the player's status box prints "cur/max" as text, so unlike the foe's
bar there is nothing to infer. It pins the damage we took every turn, which
checks the whole damage model for free.

NOT OCR. The glyphs are pixel art rendered at a fixed size, so identical digits
are byte-identical bitmaps. The table in digits.json was built by extracting
every glyph from 2001 real action-prompt frames and DEDUPLICATING exactly: 17
distinct bitmaps came out, containing all ten digits and the slash. A k-means
attempt on the same data collapsed into empty clusters and was thrown away --
clustering is the wrong tool for something that is already exact.

Segmentation is by blank columns, which works because the font is spaced. A
glyph that is not in the table is returned as '?' rather than guessed at, and a
line containing '?' should not be trusted.
"""
import base64
import json
import os

import numpy as np
from PIL import Image

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "digits.json")
_T = None


def _table():
    global _T
    if _T is None:
        with open(_PATH) as f:
            d = json.load(f)
        glyphs = {}
        for ch, g in d["glyphs"].items():
            bits = np.frombuffer(base64.b64decode(g["bits"]), dtype=bool)
            glyphs[ch] = bits.reshape(g["h"], g["w"])
        d["_glyphs"] = glyphs
        _T = d
    return _T


def read_line(img):
    """The HP text as a string, e.g. '98/98'. '?' marks an unknown glyph."""
    t = _table()
    a = np.asarray(img.convert("L").crop(tuple(t["band"])), dtype=np.float32)
    on = a > t["threshold"]
    cols = on.sum(0)
    out = []
    x, n = 0, len(cols)
    while x < n:
        if cols[x] == 0:
            x += 1
            continue
        s = x
        while x < n and cols[x] > 0:
            x += 1
        g = on[:, s:x]
        rows = np.where(g.sum(1) > 0)[0]
        if not len(rows):
            continue
        gg = g[rows.min():rows.max() + 1, :]
        # Same size filter the table was built with. The band also contains the
        # HP bar and the EXP bar, which are wide solid runs, not glyphs; without
        # this they segment as one enormous "character" and nothing matches.
        if not (4 <= gg.shape[0] <= 9 and 1 <= gg.shape[1] <= 7):
            continue
        hit = "?"
        for ch, ref in t["_glyphs"].items():
            if ref.shape == gg.shape and np.array_equal(ref, gg):
                hit = ch
                break
        out.append(hit)
    return "".join(out)


def read_hp(img):
    """(current, max) or None if the line could not be read cleanly."""
    s = read_line(img)
    if "?" in s or "/" not in s:
        return None
    cur, _, mx = s.partition("/")
    if not cur.isdigit() or not mx.isdigit():
        return None
    return int(cur), int(mx)


def read_hp_checked(img, known_maxes):
    """(current, max) only if the max is one the party actually has.

    A free and total check on misreads, and it costs nothing because the party
    is known from the save. Measured over 8200 recorded frames: the five main
    party maxes were read hundreds of times each, while every bad reading landed
    on a value no Pokemon in the party has (93, 13, 10, 1) and totalled about
    0.5%. Every one of those is rejected here.

    It also catches the subtler failure. A misread that produced a plausible
    NUMBER would otherwise flow into the advisor as truth; requiring the max to
    match pins the reading to a real Pokemon, so the only surviving errors are
    ones where the current HP is wrong while the max happens to be right.
    """
    r = read_hp(img)
    if r is None:
        return None
    return r if r[1] in known_maxes else None


if __name__ == "__main__":
    import glob
    import sys
    pats = sys.argv[1:] or [os.path.expanduser("~/rr-screen-corpus/surge_run7/f0*.png")]
    files = []
    for p in pats:
        files.extend(sorted(glob.glob(p)))
    ok = bad = 0
    seen = []
    for f in files:
        r = read_hp(Image.open(f))
        if r:
            ok += 1
            if not seen or seen[-1] != r:
                seen.append(r)
        else:
            bad += 1
    print(f"{len(files)} frames: {ok} read cleanly, {bad} not readable")
    print("HP sequence (deduped):", " ".join(f"{c}/{m}" for c, m in seen[:40]))
