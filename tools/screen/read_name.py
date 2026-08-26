#!/usr/bin/env python3
"""
The FOE's species, read off its nameplate.

PLAN-SCREEN-READER's missing step, and the one the twentieth pass makes step 0:
without the foe's identity a recording is a partial observation rather than a
trajectory, so it cannot feed the opponent scoreboard, cannot test the
switch-cache hypothesis against the recorded replacement events, and cannot
reconstruct a state to start a curriculum episode from.

GEOMETRY, measured not guessed. The foe's plate sits top-left, above the health
bar that read_bar.py reads at row 33. Printing the raw pixels shows the text
band occupies rows 20-28 and columns 18-105 of the canonical 240x160 frame, and
the plate reads

    <species name>      <gender>  Lv<level>

left-aligned name, a wide blank gutter, then the level field on the right.

INK IS EXACTLY WHITE. Counted over the region, the only colours present are the
box fill (49,49,49), its shading (66,66,66), the gender symbol (82,99,255) and
pure white text. So the mask is an equality test, in the same spirit as
read_bar.py's palette match and for the same reason: thresholds invent problems
that exact matching does not have. An earlier brightness rule here also picked
up the box border.

WHY WHOLE-NAME TEMPLATES RATHER THAN OCR. Segmenting the band into letters gave
228 distinct glyphs over the corpus, because adjacent letters touch and the
plate is drawn progressively as it slides in. Matching the whole name as one
bitmap gives 5 -- exactly Lt. Surge's five Pokemon. We always know the trainer's
team from trainer data, so the candidate set is tiny and known in advance; this
is classification against a known set, not reading arbitrary text.

The general-font version is deliberately NOT built. It cannot be validated,
because the corpus contains exactly one trainer. Record a second and it becomes
worth doing; see docs/STATE.md.

REJECTING INCOMPLETE PLATES is what took the strip count from 101 to 34. During
the slide-in the name is half-drawn, and a half-drawn name is a bitmap that
matches nothing but looks plausible. A plate is only accepted when the level
field on the right of the gutter is also present, which cannot happen until the
plate is fully drawn.

Everything left over after that -- 29 of the 34 -- is battle transition
graphics, solid blocks of white that no template matches. They are rejected by
the same rule that rejects a wrong species: an exact match or nothing.
"""
import json
import os

import numpy as np

INK = (255, 255, 255)
ROW0, ROW1 = 20, 29
COL0, COL1 = 18, 106
MIN_GUTTER = 4          # blank columns separating the name from the level field

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "names.json")
_TEMPLATES = None


def _templates():
    """species -> boolean bitmap, loaded once."""
    global _TEMPLATES
    if _TEMPLATES is None:
        with open(_PATH) as fh:
            raw = json.load(fh)
        _TEMPLATES = {
            name: np.array([[c == "#" for c in row] for row in spec["rows"]])
            for name, spec in raw.items()
        }
    return _TEMPLATES


def extract_strip(a):
    """The name bitmap from a frame array, or None if there is no complete plate.

    Trimmed to its ink on all four sides so the result does not depend on where
    in the band the text happens to sit.
    """
    if a.shape[0] < ROW1 or a.shape[1] < COL1:
        return None
    mask = np.all(a[ROW0:ROW1, COL0:COL1] == INK, axis=-1)
    cols = mask.any(axis=0)
    if not cols.any():
        return None
    first = int(cols.argmax())
    if first > 4:
        return None                       # the name is left-aligned; this is not one
    end, gap, split = first, 0, None
    for c in range(first, len(cols)):
        if cols[c]:
            end, gap = c, 0
        else:
            gap += 1
            if gap >= MIN_GUTTER and split is None:
                split = end
    if split is None or not cols[split + 1:].any():
        return None                       # no level field: the plate is still drawing
    sub = mask[:, first:split + 1]
    rows = sub.any(axis=1)
    if not rows.any():
        return None
    r0 = int(rows.argmax())
    r1 = len(rows) - int(rows[::-1].argmax())
    return sub[r0:r1]


def read_name(img, candidates=None):
    """The foe's species, or None.

    `candidates` restricts matching to the species the trainer is known to
    carry, which is the whole point of the design: it turns reading text into
    picking from a list of five. Passing None matches every template we hold.
    """
    a = np.asarray(img.convert("RGB")) if hasattr(img, "convert") else img
    strip = extract_strip(a)
    if strip is None:
        return None
    for name, tpl in _templates().items():
        if candidates is not None and name not in candidates:
            continue
        if tpl.shape == strip.shape and np.array_equal(tpl, strip):
            return name
    return None
