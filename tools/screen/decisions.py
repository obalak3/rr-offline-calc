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


def replacements(folder, by_max):
    """Foe replacements, with OUR HP READ AT THE FAINT rather than at the prompt.

    James, 2026-08-26, having replayed the same position from a save state:
    one-shot Bellibolt and the AI sends Vikavolt; two-shot it with Mega Drain
    and it sends Pawmot, "because Pawmot can now one shot my Victreebel with
    Ice Punch". Our engine reproduces the threshold exactly -- Pawmot scores 1
    at Victreebel 90/108 and 44 at 80/108, which is KO_FOE (+31) switching on.

    So the replacement is a DETERMINISTIC function of the position at the
    faint, and the apparent randomness in the recordings was our own
    measurement: the state at the turn-start prompt is not the state the AI
    scores. Both attacks resolve in between, and our HP at the faint is what
    decides whether the incoming Pokemon can kill.

    This reads our HP from the LAST FRAME BEFORE the foe's nameplate changes,
    which is that state.
    """
    # Each frame contributes a snapshot only when the nameplate is readable,
    # so the bar and the nameplate always describe the SAME Pokemon. Sampling
    # them independently reads the incoming Pokemon's full bar as if it were
    # the outgoing one's, which made every event look like a voluntary switch.
    rows = []
    prev = None
    last_foe_move = None
    saw_faint = False
    for f in sorted(glob.glob(os.path.join(folder, "f*.png"))):
        img = Image.open(f).convert("RGB")
        a = np.asarray(img)
        if a.shape[:2] != (160, 240):
            continue
        label, dist, _ = classify.classify(img)
        if dist > classify.TRUSTWORTHY:
            continue
        if label == "message":
            words = read_message.read_words(a)
            got = read_message.read_move(a)
            if got is not None and got[0] == "foe" and "?" not in got[1]:
                last_foe_move = got[1]
            # The authoritative cause signal. The outgoing Pokemon's HP BAR is
            # not usable for this: the plate stays up while the bar drains, so
            # the last frame showing the old name can read 39/48 on a Pokemon
            # that is dying. The game just says it.
            if "fainted" in words and "opposing" in words:
                saw_faint = True
        name = read_name.read_name(a, candidates=SURGE)
        if name is None:
            continue
        hp = read_hp.read_hp(img)
        bar = read_bar.read_bar(img)
        snap = {"name": name,
                "hp": hp if (hp is not None and by_max.get(hp[1])) else None,
                "bar": bar}
        if prev is not None and name != prev["name"] and prev["hp"] is not None:
            # THREE things change the nameplate and only one is the routine we
            # score. A faint runs CalcMostSuitableMonToSwitchInto; a Volt Switch
            # or U-turn pivot runs pivotTo, a different decision entirely.
            # Scoring a pivot with the replacement routine is not a miss, it is
            # the wrong question -- and Surge pivots, Volt Switch is read 11
            # times in this corpus.
            #
            # They separate on the OUTGOING Pokemon's bar, which is why the
            # snapshot has to be taken on a frame that still shows its plate.
            pivot_moves = ("Volt Switch", "U-turn", "Flip Turn", "Parting Shot")
            # Neither signal alone is complete: the recorder keeps only CHANGED
            # frames, so a faint message can be missed entirely, and the bar is
            # only reliable once it has finished draining. Together they agree.
            if saw_faint or prev["bar"] == 0:
                cause = "faint"
            elif last_foe_move in pivot_moves:
                cause = "pivot"
            else:
                cause = "switch"
            rows.append({
                "kind": "replacement", "cause": cause,
                "run": os.path.basename(folder), "frame": os.path.basename(f),
                "out": prev["name"], "in": name,
                "us": by_max.get(prev["hp"][1]), "our_hp": prev["hp"][0],
                "our_maxhp": prev["hp"][1], "out_bar": prev["bar"],
                "last_foe_move": last_foe_move,
            })
            last_foe_move = None
            saw_faint = False
        if snap["hp"] is None and prev is not None and prev["name"] == name:
            snap["hp"] = prev["hp"]          # carry the last good reading forward
        prev = snap
    return rows


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    folders = args or sorted(
        glob.glob(os.path.expanduser("~/rr-screen-corpus/surge_run*")))
    by_max = trace_mod.party_from_save()
    if not by_max:
        print("save unreadable; cannot identify our side", file=sys.stderr)
        return 1
    mode = "--replacements" if "--replacements" in sys.argv else "decisions"
    total = 0
    for folder in folders:
        rows = (replacements(folder, by_max) if mode == "--replacements"
                else decisions(folder, by_max))
        for row in rows:
            print(json.dumps(row))
            total += 1
    print(f"{total} {mode.lstrip('-')} from {len(folders)} recordings", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
