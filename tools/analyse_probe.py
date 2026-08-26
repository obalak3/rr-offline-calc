#!/usr/bin/env python3
"""
Did writing the candidate address change what happened?

Reads seed_probe.tsv and answers one question: is the turn's outcome a
FUNCTION of the value we wrote? Three things are reported and they mean
different things.

    distinct outcomes     If every trial ends identically, the address is not
                          the seed and the whole line of enquiry on it is
                          dead. This is the result that saves days.

    determinism           The same written seed must always give the same
                          outcome. If it does not, either something else also
                          varies, or the write is being overwritten before it
                          is read.

    coverage              How many distinct outcomes, against how many a real
                          damage roll should produce. A damage roll has 16
                          values, so ~16 outcomes (or ~32 with crits) is what
                          a true seed looks like. Two outcomes would suggest
                          we are only seeing a secondary-effect coin flip.

Run: analyse_probe.py [seed_probe.tsv]
"""
import collections
import os
import sys


def main():
    path = (sys.argv[1] if len(sys.argv) > 1
            else os.path.expanduser("~/rr-screen-corpus/seed_probe.tsv"))
    if not os.path.exists(path):
        print("no probe output at", path)
        return 1
    rows = []
    with open(path) as fh:
        header = fh.readline().rstrip("\n").split("\t")
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != len(header):
                continue
            rows.append(dict(zip(header, (int(p) for p in parts))))
    if not rows:
        print("probe file has no data rows")
        return 1

    hp_keys = [k for k in rows[0] if k.startswith("hp")]
    outcomes = collections.Counter(tuple(r[k] for k in hp_keys) for r in rows)
    by_seed = collections.defaultdict(set)
    for r in rows:
        by_seed[r["seed_written"]].add(tuple(r[k] for k in hp_keys))
    kept = sum(1 for r in rows if r["seed_after"] == r["seed_written"])

    print("  %d trials, %d distinct outcomes" % (len(rows), len(outcomes)))
    print("  seed survived the write in %d/%d trials" % (kept, len(rows)))
    nondet = [s for s, o in by_seed.items() if len(o) > 1]
    print("  seeds giving more than one outcome: %d" % len(nondet))
    print("\n  most common outcomes (party HP after the turn):")
    for outcome, n in outcomes.most_common(8):
        print("    %-40s %d" % (" ".join(str(v) for v in outcome), n))

    print("")
    if len(outcomes) == 1:
        print("  VERDICT: writing this address changed NOTHING. It is not the")
        print("  value that decides the roll. Kill it and try the other")
        print("  candidate; a null here is worth more than more correlation.")
    elif nondet:
        print("  VERDICT: outcomes vary but are NOT a function of what we wrote.")
        print("  Either the write is overwritten before being read, or something")
        print("  else varies between trials. Check 'seed survived the write'.")
    elif len(outcomes) >= 8:
        print("  VERDICT: outcome is a clean function of this address, with the")
        print("  spread a real damage roll produces. This IS the seed. Next step")
        print("  is mapping value -> roll so a quicksave can be read directly.")
    else:
        print("  VERDICT: it is a function of the address, but with only %d"
              % len(outcomes))
        print("  outcomes. That is narrower than a damage roll's 16, so this may")
        print("  be a coin flip downstream of the seed rather than the seed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
