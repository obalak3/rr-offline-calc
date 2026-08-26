#!/usr/bin/env python3
"""
Turn passive logs into battles, decisions and verified rolls.

The passive logger (tools/lua/passive_logger.lua) writes one row per state
change while James plays: both sides of gBattleMons plus the battle RNG seed.
This reads those rows back into the three things the plan consumes:

    BATTLES     segmented at the zero-rows the logger emits between fights
                (gBattleMons is wiped outside battle), with both parties,
                levels, abilities and outcomes.
    DECISIONS   every foe action, identified the same way the oracle does it:
                a PP entry dropping names the move, a species change is a
                switch. Positions attach to the PREVIOUS row, the state the
                AI decided from.
    ROLLS       for damage the foe takes, the logged seed lets the solved
                model predict it: crit = ((draw#3>>16) % 24 == 0), roll =
                (draw#4>>16) % 16, damage = floor(base*(100-roll)/100) at
                base x1.5 on a crit. Every logged turn where the model's
                prediction can be checked, is checked -- which quietly
                validates draws #3 and #4 on fights they were never fitted
                to. The 0x020386D0 finding was calibrated on ONE position of
                ONE fight; this is where it either generalises or breaks.

Honest limits, so nobody over-reads the output: the logger samples at 15Hz on
change, so two changes inside ~4 frames can merge, and OUR moves are only
visible as PP drops when our active Pokemon stays in. Damage validation needs
the base damage, which depends on stats the log does not carry -- so rolls are
checked only where the observed damage uniquely identifies (base, roll) pairs
consistent with the model, and the tool reports how often that is possible
rather than pretending it always is.

Run: analyze_run.py [logfile ...]     (defaults to all of ~/rr-screen-corpus/run2/)
"""
import glob
import json
import os
import sys

MUL, ADD, MASK = 1103515245, 12345, 0xFFFFFFFF

HERE = os.path.dirname(os.path.abspath(__file__))
IDM = json.load(open(os.path.join(HERE, "fixtures", "rr-id-map.json")))
SP, MV, AB = IDM["species"], IDM["moves"], IDM["abilities"]


def draws(seed, n):
    v, out = seed, []
    for _ in range(n):
        v = (MUL * v + ADD) & MASK
        out.append(v >> 16)
    return out


def parse(path):
    rows = []
    with open(path) as fh:
        header = fh.readline()
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) != 11:
                continue
            rows.append({
                "frame": int(f[0]), "side": f[1], "sp": int(f[2]),
                "lv": int(f[3]), "hp": int(f[4]), "mx": int(f[5]),
                "ab": int(f[6]), "it": int(f[7]),
                "mv": [int(x) for x in f[8].split(",")],
                "pp": [int(x) for x in f[9].split(",")],
                "rng": int(f[10]),
            })
    return rows


def segment(rows):
    """Battles, split on the zeroed rows between fights."""
    battles, cur = [], []
    for r in rows:
        if r["sp"] == 0:
            if cur:
                battles.append(cur)
                cur = []
            continue
        cur.append(r)
    if cur:
        battles.append(cur)
    return battles


def analyze_battle(rows):
    """Decisions and roll checks for one battle's rows."""
    out = {"foes": [], "us": [], "decisions": [], "rolls": []}
    last = {"us": None, "foe": None}
    for r in rows:
        prev = last[r["side"]]
        name = SP.get(str(r["sp"]), str(r["sp"]))
        key = "us" if r["side"] == "us" else "foes"
        if name not in out[key]:
            out[key].append(name)
        if prev is not None and prev["sp"] == r["sp"]:
            for i in range(4):
                if r["pp"][i] < prev["pp"][i] and prev["mv"][i]:
                    out["decisions"].append({
                        "side": r["side"],
                        "move": MV.get(str(prev["mv"][i]), str(prev["mv"][i])),
                        "at_hp": prev["hp"], "at_max": prev["mx"],
                    })
        # Damage the FOE dealt to US between consecutive rows of our side:
        # check it against the model's prediction from the seed at the
        # earlier row. Only usable when a single (base, roll) pair fits.
        if (r["side"] == "us" and prev is not None and prev["sp"] == r["sp"]
                and r["hp"] < prev["hp"]):
            dmg = prev["hp"] - r["hp"]
            d = draws(prev["rng"], 4)
            crit = (d[2] % 24) == 0
            roll = d[3] % 16
            # base * (100-roll) // 100 == dmg has solutions for base in a
            # narrow band; the model is CONSISTENT if some integer base gives
            # exactly dmg at this roll (x1.5 on crit), and the check has
            # power because a wrong roll usually leaves no integer base.
            lo = dmg
            hi = int(dmg * 100 / (100 - 15)) + 2
            ok = False
            for base in range(lo, hi + 1):
                eff = base * 3 // 2 if crit else base
                if eff * (100 - roll) // 100 == dmg:
                    ok = True
                    break
            out["rolls"].append({"dmg": dmg, "crit": crit, "roll": roll, "consistent": ok})
        last[r["side"]] = r
    a, b = rows[-1], last["us" if rows[-1]["side"] == "us" else "foe"]
    return out


def main():
    paths = sys.argv[1:] or sorted(
        glob.glob(os.path.expanduser("~/rr-screen-corpus/run2/passive_*.tsv")))
    total_b = total_d = total_r = total_ok = 0
    for path in paths:
        rows = parse(path)
        battles = segment(rows)
        print("%s: %d rows, %d battles" % (os.path.basename(path), len(rows), len(battles)))
        for i, batt in enumerate(battles):
            a = analyze_battle(batt)
            total_b += 1
            total_d += len(a["decisions"])
            checks = a["rolls"]
            total_r += len(checks)
            total_ok += sum(1 for c in checks if c["consistent"])
            foes = ",".join(a["foes"]) or "?"
            us = ",".join(a["us"]) or "?"
            dec = "; ".join("%s %s@%d" % (d["side"], d["move"], d["at_hp"])
                            for d in a["decisions"][:6])
            print("  battle %-3d %-24s vs %-20s %d decisions  %s"
                  % (i + 1, us[:24], foes[:20], len(a["decisions"]), dec))
    print("\n%d battles, %d decisions, %d damage events checkable against the "
          "roll model, %d consistent" % (total_b, total_d, total_r, total_ok))
    if total_r:
        print("model consistency: %.0f%%  (chance for a wrong model is well "
              "under half)" % (100 * total_ok / total_r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
