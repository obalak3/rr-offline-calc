#!/usr/bin/env python3
"""
One row per AI DECISION: the position the game was in, and what the AI did.

Step 1 of the twentieth-pass ordering needs this. The scoreboard asks whether
the game's observed action falls inside the set our AI port predicts, and that
question needs the two halves paired: the position as it stood when the AI
chose, and the choice itself.

WHICH POSITION TO PAIR WITH A MOVE, and it is not the frame the move is
announced on. By then our move has often already resolved and HP has changed.
The AI chose at the start of the turn, so the state to score against is the
last ACTION PROMPT before the message -- the moment the game asked us what to
do, when everything on screen is stable and nothing has resolved yet.

WHAT COMES FROM WHERE:
    our species, HP, max HP    read_hp, exact, species free from the maximum
    foe species                read_name, off the nameplate
    foe HP                     read_bar, as a count of 48ths
    the AI's move              read_message, gated on the message screen

A row is emitted only when ALL of those are present. A decision with a missing
half is not a weak data point, it is not a data point, and letting it through
would put a guess into the denominator of a fidelity number.

Output is JSONL on stdout so the JS side can score it; the engine, the AI port
and the trainer data all live there.

Run: decisions.py [FRAME_DIR ...]
"""
import glob
import json
import os
import sys

from PIL import Image
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify
import read_bar
import read_hp
import read_message
import read_name
import trace as trace_mod

SURGE = {"Pincurchin", "Bellibolt", "Vikavolt", "Manectric", "Pawmot"}


def decisions(folder, by_max):
    """AI decisions in this recording, oldest first."""
    rows = []
    pending = None          # the last action prompt we saw, fully read
    foe_seen = None         # the foe's species, which persists across messages
    for f in sorted(glob.glob(os.path.join(folder, "f*.png"))):
        img = Image.open(f).convert("RGB")
        a = np.asarray(img)
        if a.shape[:2] != (160, 240):
            continue
        label, dist, _ = classify.classify(img)
        if dist > classify.TRUSTWORTHY:
            continue

        name = read_name.read_name(a, candidates=SURGE)
        if name is not None:
            foe_seen = name

        if label == "action_prompt":
            hp = read_hp.read_hp(img)
            bar = read_bar.read_bar(img)
            if hp is None or bar is None:
                continue
            pending = {
                "frame": os.path.basename(f),
                "us": by_max.get(hp[1], None),
                "our_hp": hp[0], "our_maxhp": hp[1],
                "foe": foe_seen, "foe_bar": bar,
            }
            continue

        if label != "message" or pending is None:
            continue
        got = read_message.read_move(a)
        if got is None:
            continue
        side, move = got
        if side != "foe" or "?" in move:
            continue
        if pending["us"] is None or pending["foe"] is None:
            pending = None
            continue
        row = dict(pending)
        row["foe_move"] = move
        row["run"] = os.path.basename(folder)
        rows.append(row)
        pending = None          # one decision per prompt
    return rows


def main():
    folders = sys.argv[1:] or sorted(
        glob.glob(os.path.expanduser("~/rr-screen-corpus/surge_run*")))
    by_max = trace_mod.party_from_save()
    if not by_max:
        print("save unreadable; cannot identify our side", file=sys.stderr)
        return 1
    total = 0
    for folder in folders:
        for row in decisions(folder, by_max):
            print(json.dumps(row))
            total += 1
    print(f"{total} decisions from {len(folders)} recordings", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
