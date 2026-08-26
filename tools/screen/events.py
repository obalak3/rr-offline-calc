#!/usr/bin/env python3
"""
Turn a trace into battle EVENTS: damage taken, damage dealt, replacements.

The trace says what the screen showed. This says what HAPPENED, which is what
the model can be checked against. Three kinds fall out of consecutive rows with
no message-box reading at all:

    damage taken       our HP dropped while the same Pokemon stayed out
    damage dealt       the foe's bar dropped
    replacement        the foe's bar JUMPED UP -- something fainted and a fresh
                       Pokemon came in at full health

The last one matters more than it looks. Validating the switch-in port needs
exactly these boundaries, and they arrive for free from a bar reading rather
than from classifying "Leader Lt. Surge sent out Pawmot!".

WHAT THIS IS FOR. Every damage-taken event is a number our damage model must be
able to reproduce. "Lanturn took 41" is checkable: if the engine says the only
moves available deal 60-70, the model is wrong, and it is wrong about a real
fight rather than a synthetic one. That is the cheapest validation this project
has access to, and it costs nothing but recording play.

Known gap: the foe's species and its move are not read yet (PLAN-SCREEN-READER
step 5), so an event says how much damage happened but not what caused it. Our
HP being exact means the move can often be INFERRED by intersecting the damage
with the sixteen-roll sets of the foe's known moves -- see PLAN-ADVISOR-UX.md --
which is why this is worth having before the message classifier exists.

Run: events.py [FRAME_DIR]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trace as tracemod


def events(rows):
    out = []
    for a, b in zip(rows, rows[1:]):
        if a["species"] == b["species"] and b["hp"] < a["hp"]:
            out.append({"kind": "damage_taken", "who": a["species"],
                        "amount": a["hp"] - b["hp"], "from_hp": a["hp"],
                        "to_hp": b["hp"], "frame": b["frame"]})
        if a["species"] != b["species"]:
            out.append({"kind": "we_switched", "from": a["species"],
                        "to": b["species"], "frame": b["frame"]})
        if b["foe_bar"] < a["foe_bar"]:
            out.append({"kind": "damage_dealt", "bar_from": a["foe_bar"],
                        "bar_to": b["foe_bar"], "frame": b["frame"]})
        elif b["foe_bar"] > a["foe_bar"]:
            # A bar can only go UP by a fresh Pokemon arriving. Healing would
            # show as a rise too, so this is "replacement or heal" strictly
            # speaking; on a trainer team without recovery items it is a
            # replacement, and the message box settles it once step 5 exists.
            out.append({"kind": "foe_replaced", "bar_from": a["foe_bar"],
                        "bar_to": b["foe_bar"], "frame": b["frame"]})
    return out


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else \
        os.path.expanduser("~/rr-screen-corpus/surge_run7")
    rows = tracemod.trace(folder)
    ev = events(rows)
    counts = {}
    for e in ev:
        counts[e["kind"]] = counts.get(e["kind"], 0) + 1
    print(f"{len(rows)} decision points -> {len(ev)} events from {os.path.basename(folder)}")
    for k in sorted(counts):
        print(f"   {k:15s} {counts[k]}")
    print()
    for e in ev:
        if e["kind"] == "damage_taken":
            print(f"   {e['who']:<12s} took {e['amount']:3d}   ({e['from_hp']} -> {e['to_hp']})")
        elif e["kind"] == "foe_replaced":
            print(f"   foe replaced  (bar {e['bar_from']} -> {e['bar_to']})")
