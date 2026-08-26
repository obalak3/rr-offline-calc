#!/usr/bin/env python3
"""
Build the message-box font, and do it reproducibly rather than by hand.

The message box is where the game says what happened -- who sent out what, who
used which move, what it did. Reading it is the second half of the reader step
the twentieth pass makes step 0: read_name.py gives the foe's identity, this
gives its ACTION, and an identity plus an action is a trajectory rather than a
partial observation.

WHY A FONT HERE, AND NOT FOR THE NAMEPLATE. The nameplate holds one of five
known species, so whole-name templates are the right tool and a font would be
unvalidatable. The message box holds open-ended English over a large move
vocabulary, and templating whole phrases would need one template per move per
speaker. But unlike the nameplate the message font SEGMENTS: measured over the
corpus, every word splits into glyphs at blank columns, cleanly, because the
font is effectively 6px-advance. So letters are recoverable here and are the
right unit.

HOW THE LABELS ARE OBTAINED WITHOUT HAND-LABELLING 34 BITMAPS. Bootstrapping.
Seed with a few words whose identity is certain -- fixed phrasing the game
always uses, and the species on the two teams, which we know from trainer data
and the save. Extract their glyphs positionally. Then decode every other word
in the corpus: a word that comes back "?urge" or "?i?a?olt" has identified
itself, because only one string over this vocabulary fits. Feed those back and
repeat.

Three rounds take it from 20 letters to 34, and 204 of 275 distinct words in
the corpus decode completely. The check that this is right is not the count: it
is that every fully decoded word is a real English or Pokemon word (Leader,
sent, hurt, regained, super, effective, Victreebel, Discharge) and that the
learner reports ZERO conflicts -- no glyph bitmap was ever assigned two
different letters across all three rounds. A wrong seed shows up immediately as
a conflict or as garbage words, and neither appeared.

A TRAP WORTH RECORDING. The first version keyed glyphs on (bitmap, offset from
the top of the text band). That collapsed to nothing -- words decoded as all
"?" -- because the band's top edge moves depending on whether the line happens
to contain an ascender, so the same letter got a different key on different
lines. Keying on the bitmap alone fixed it and, measured, introduced no
ambiguity at all: 34 letters, zero collisions.

Run: /usr/local/bin/python3 tools/screen/build_msgfont.py
"""
import collections
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify
from read_message import BAND_MIN, GAP_MIN, INK, R0, R1, glyphs, split_words, text_bands

CORPUS = os.path.expanduser("~/rr-screen-corpus")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "msgfont.json")

# Words the game always spells the same way, plus the species on both teams.
# Both are known before we look at a single pixel: the phrasing is fixed by the
# ROM, our party comes from the save, Surge's team from trainer data.
# Keyed by glyph-width signature, not by rank: a rank shifts whenever the
# harvest changes and silently seeds the wrong word, which cost a build.
SEED_BY_SIGNATURE = {
    (5, 5, 5, 5): "used",
    (5, 5, 5): "The",
    (5, 5, 5, 5, 5, 1, 5, 5): "opposing",
    (5, 5, 5, 4, 5, 5, 5): "Lanturn",
    (5, 5, 2, 2, 1, 5, 5, 2, 4): "Bellibolt",
    (5, 1, 5, 5, 5, 5, 5, 5): "Mienshao",
    (5, 5, 5, 5, 5, 4, 5, 1, 5): "Manectric",
}

# Words that identify themselves once enough letters are known: no other string
# over this vocabulary matches the pattern.
ROUNDS = [
    {"?urge": "Surge", "?a??ot": "Pawmot", "?i?a?olt": "Vikavolt",
     "?incurchin": "Pincurchin", "?ictreebel": "Victreebel",
     "?reloom": "Breloom", "?illigant": "Lilligant"},
    {"?idden": "Hidden", "?rain": "Drain", "?ake": "Fake", "?ut": "Out",
     "energ?": "energy", "Bu??": "Buzz", "?iggersb?": "Diggersby",
     "e??ective": "effective"},
    {"?ock": "Rock", "?ave": "Wave", "?ce": "Ice", "?harge": "Charge",
     "?ecover": "Recover", "?olt": "Volt", "?witch": "Switch"},
]

# After the hand-written rounds, the remaining letters are recovered without
# any further human input: decode a word, and if exactly ONE name in the known
# vocabulary matches it treating "?" as a wildcard, that word has identified
# itself. The vocabulary is the two move pools and the two teams, all of which
# we know before looking at a pixel. Requiring a UNIQUE match is what makes
# this safe: "?ake" alone could be Fake, Take or Make, so it is left alone
# until enough other letters make it unambiguous.
VOCABULARY = [
    "Fake", "Out", "Drain", "Punch", "Detect", "Rock", "Tomb", "Take", "Down",
    "Bulldoze", "Double", "Kick", "Odor", "Sleuth", "Scald", "Confuse", "Ray",
    "Signal", "Beam", "Shock", "Wave", "Recover", "Sleep", "Powder", "Mega",
    "Headbutt", "Mach", "Force", "Palm", "Bullet", "Seed", "Sludge", "Leaf",
    "Storm", "Hidden", "Power", "Discharge", "Mud", "Shot", "Bug", "Buzz",
    "Thunder", "Ice", "Volt", "Switch", "Charge", "Parabolic", "Boost",
    "Pincurchin", "Bellibolt", "Vikavolt", "Manectric", "Pawmot", "Lanturn",
    "Mienshao", "Diggersby", "Lilligant", "Breloom", "Victreebel",
]


def harvest():
    """Every distinct word bitmap on every message frame in the corpus."""
    seen, store, frames = collections.Counter(), {}, []
    for f in sorted(glob.glob(os.path.join(CORPUS, "surge_run*", "*.png"))):
        im = Image.open(f).convert("RGB")
        a = np.asarray(im)
        if a.shape[:2] != (160, 240):
            continue
        label, dist, _ = classify.classify(im)
        if label != "message" or dist >= classify.TRUSTWORTHY:
            continue
        ws = []
        for band in text_bands(a):
            for w in split_words(band):
                rr, cc = w.any(axis=1), w.any(axis=0)
                if not rr.any() or w.sum() < 8:
                    continue
                sub = w[int(rr.argmax()):len(rr) - int(rr[::-1].argmax()),
                        int(cc.argmax()):len(cc) - int(cc[::-1].argmax())]
                k = (sub.shape, sub.tobytes())
                seen[k] += 1
                store[k] = w
                ws.append(k)
        frames.append(ws)
    return seen, store, frames


def main():
    seen, store, frames = harvest()
    order = [k for k, _ in seen.most_common()]
    print(f"{len(order)} distinct words over {len(frames)} message frames")

    font, conflicts = {}, []

    def learn(word_key, label):
        gs = glyphs(store[word_key])
        if len(gs) != len(label):
            return False
        for g, ch in zip(gs, label):
            k = (g.shape, g.tobytes())
            if k in font and font[k] != ch:
                conflicts.append((font[k], ch, label))
            font[k] = ch
        return True

    def decode(w):
        return "".join(font.get((g.shape, g.tobytes()), "?") for g in glyphs(w))

    def signature(k):
        return tuple(g.shape[1] for g in glyphs(store[k]))

    for sig, label in SEED_BY_SIGNATURE.items():
        hits = [k for k in order if signature(k) == sig]
        if not hits:
            print(f"  seed {label!r}: no word with signature {sig}")
            continue
        learn(hits[0], label)      # order is by frequency; the fixed phrasing wins
    for n, table in enumerate(ROUNDS, 1):
        for k in order:
            s = decode(store[k])
            if s in table:
                learn(k, table[s])
        got = sum(1 for k in order if "?" not in decode(store[k]))
        print(f"  round {n}: {len(set(font.values()))} letters, {got} words decoded")

    # Closure: keep matching against the vocabulary until nothing new is learned.
    for sweep in range(8):
        before = len(set(font.values()))
        for k in order:
            s = decode(store[k])
            if "?" not in s:
                continue
            # A "?" is a glyph we have NOT learned, so it cannot be a letter
            # we already know: if it were a "T", it would have decoded as one.
            # That rules out Take and Make for "?ake" and leaves Fake alone,
            # and it is a fact about the font rather than a tie-break.
            known = set(font.values())
            hits = [v for v in VOCABULARY
                    if len(v) == len(s)
                    and all(b not in known if a == "?" else a == b
                            for a, b in zip(s, v))]
            if len(hits) == 1:
                learn(k, hits[0])
        if len(set(font.values())) == before:
            break
    got = sum(1 for k in order if "?" not in decode(store[k]))
    print(f"  vocabulary closure: {len(set(font.values()))} letters, {got} words decoded")

    # "!" is its own token, separated from the sentence by a full word gap, and
    # is by a wide margin the most common single-glyph word in a battle log.
    singles = [k for k in order if len(glyphs(store[k])) == 1
               and decode(store[k]) == "?"]
    if singles:
        learn(singles[0], "!")
        print(f"  punctuation: '!' seeded from the commonest single-glyph token")

    if conflicts:
        print("CONFLICTS (a seed is wrong):", conflicts)
        return 1

    out = {}
    for (shape, bits), ch in font.items():
        arr = np.frombuffer(bits, dtype=bool).reshape(shape)
        out.setdefault(ch, []).append(
            ["".join("#" if v else "." for v in row) for row in arr])
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print(f"wrote {OUT}: {len(out)} letters, "
          f"{sum(len(v) for v in out.values())} glyph templates")
    return 0


if __name__ == "__main__":
    sys.exit(main())
