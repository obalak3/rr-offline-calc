#!/usr/bin/env python3
"""
What the game just said, and in particular WHICH MOVE was used by WHOM.

This is the other half of the reader step the twentieth pass makes step 0.
read_name.py gives the foe's identity; without the action too, a recording is
a partial observation rather than a trajectory, and the opponent scoreboard has
nothing to score.

GEOMETRY, measured. The box holds two text lines, at rows 124-132 and 139-148 of
the canonical 240x160 frame, and a message may wrap across both. An earlier
window of rows 130-160 cut the first line in half and produced word bitmaps
three pixels tall; the bands are found by ink rather than assumed, so a line
that moves does not silently truncate.

INK IS EXACTLY WHITE, as everywhere else in this reader.

WORDS are runs separated by >= 3 blank columns; LETTERS are runs separated by
any blank column. Both thresholds are measured against the corpus rather than
chosen: the font advances 6px with 5px glyphs, so inter-letter gaps are 1px and
inter-word gaps are 3px or more, with no overlap between the two.

The font is built by bootstrapping; see build_msgfont.py, which explains how the
labels are obtained without hand-labelling and what checks make it trustworthy.

WHY GATE ON THE MESSAGE SCREEN. Menus and the party screen also put white pixels
in these rows, and they decode to confident-looking garbage. classify() already
tells us which screen we are on, so the caller should only trust a reading when
it says "message". read_move() does not enforce this -- the caller may have
already classified the frame -- so callers that have not should check.
"""
import json
import os

import numpy as np

INK = (255, 255, 255)
R0, R1 = 120, 152       # the two-line message area
BAND_MIN = 5            # a text line is at least this tall; anything less is chrome
GAP_MIN = 3             # blank columns separating words

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "msgfont.json")
_FONT = None


def _font():
    """(shape, bits) -> letter, loaded once."""
    global _FONT
    if _FONT is None:
        with open(_PATH) as fh:
            raw = json.load(fh)
        _FONT = {}
        for ch, templates in raw.items():
            for rows in templates:
                arr = np.array([[c == "#" for c in row] for row in rows])
                _FONT[(arr.shape, arr.tobytes())] = ch
    return _FONT


def text_bands(a):
    """The message area's text lines, as boolean masks."""
    if a.shape[0] < R1:
        return []
    m = np.all(a[R0:R1, :] == INK, axis=-1)
    rows = m.any(axis=1)
    out, r = [], 0
    while r < len(rows):
        if not rows[r]:
            r += 1
            continue
        s = r
        while r < len(rows) and rows[r]:
            r += 1
        if r - s >= BAND_MIN:
            out.append(m[s:r])
    return out


def split_words(band):
    cols = band.any(axis=0)
    runs, start, gap = [], None, 0
    for c in range(len(cols)):
        if cols[c]:
            if start is None:
                start = c
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= GAP_MIN:
                runs.append((start, c - gap + 1))
                start, gap = None, 0
    if start is not None:
        runs.append((start, len(cols)))
    return [band[:, a0:a1] for a0, a1 in runs]


def glyphs(word):
    """Letter bitmaps, each trimmed to its own ink.

    Trimmed vertically as well as horizontally, and that matters: keying a
    glyph on its offset within the text band collapses the whole font, because
    the band's top edge depends on whether the line happens to contain an
    ascender. Measured, the bitmap alone is unambiguous -- 34 letters, no two
    sharing a bitmap.
    """
    cols = word.any(axis=0)
    out, c = [], 0
    while c < len(cols):
        if not cols[c]:
            c += 1
            continue
        s = c
        while c < len(cols) and cols[c]:
            c += 1
        g = word[:, s:c]
        rr = g.any(axis=1)
        if not rr.any():
            continue
        out.append(g[int(rr.argmax()):len(rr) - int(rr[::-1].argmax())])
    return out


def read_words(img):
    """Every word in the message area, in reading order, undecodable ones as '?'."""
    a = np.asarray(img.convert("RGB")) if hasattr(img, "convert") else img
    font = _font()
    out = []
    for band in text_bands(a):
        for w in split_words(band):
            if w.sum() < 8:
                continue
            out.append("".join(font.get((g.shape, g.tobytes()), "?") for g in glyphs(w)))
    return out


def read_move(img):
    """(side, move) if this frame says someone used a move, else None.

    side is "foe" when the sentence names the opposing Pokemon and "ours"
    otherwise, which is how the ROM distinguishes them: our own Pokemon are
    named bare, theirs are always "The opposing X".

    The move name is everything between "used" and the end of the sentence. A
    name containing "?" is returned as-is rather than guessed at, so a caller
    can tell "I could not read it" from "it was Thunderbolt".
    """
    words = read_words(img)
    if "used" not in words:
        return None
    i = words.index("used")
    tail = [w for w in words[i + 1:] if w != "!"]
    if not tail:
        return None
    # Only a real "!" token is dropped. Stripping a trailing "?" here would
    # silently turn an unreadable last letter into a shorter, wrong-but-
    # plausible move name: "Charge Beam" came back as "Charge Bea" and passed
    # every check except the move pool.
    move = " ".join(tail).strip()
    if not move:
        return None
    side = "foe" if "opposing" in words[:i] else "ours"
    return side, move
