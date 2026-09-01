#!/usr/bin/env python3
"""
Compare two battery arms on SEED-PAIRED episodes, by the rule fixed in
docs/BATTERY-PREREG.md before any arm was run.

    python3 tools/compare_arms.py control.csv arm.csv [label]

Why paired. Three identical control runs of tools/sim_episodes.js returned
27/60, 25/60 and 22/60 -- ordinary binomial spread, sigma about 3.8 wins. An
unpaired comparison at that n can only see very large effects: it was enough to
condemn RR_DEEP_SCAN (27 to 8) and nowhere near enough to judge
RR_NOANSWER_FLOOR (22 vs 24), which went into the log as "a wash" when the honest
statement is that the instrument could not tell.

sim_episodes.js seeds every source of chance per episode, so row i of two arms
faces the same opening dice. Differencing row by row removes the shared luck and
leaves the effect of the arm.

The test is McNemar's exact binomial on the DISCORDANT pairs -- episodes one arm
won and the other lost. Concordant pairs carry no information about which arm is
better and are correctly ignored, which is the whole reason this is more
sensitive than comparing two totals.
"""
import sys, csv
from math import comb


def load(path):
    rows = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            rows[r['seed']] = r
    return rows


def exact_two_sided(b, c):
    """P(a split at least this lopsided | fair coin), two-sided."""
    n = b + c
    if n == 0:
        return 1.0
    k = max(b, c)
    tail = sum(comb(n, i) for i in range(k, n + 1)) / (2.0 ** n)
    return min(1.0, 2.0 * tail)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    ctrl, arm = load(sys.argv[1]), load(sys.argv[2])
    label = sys.argv[3] if len(sys.argv) > 3 else 'arm vs control'
    seeds = sorted(set(ctrl) & set(arm), key=int)
    if not seeds:
        print(label + ': NO SHARED SEEDS -- the arms were not paired, nothing to compare')
        sys.exit(1)
    unpaired = (len(ctrl) - len(seeds)) + (len(arm) - len(seeds))

    b = c = both = neither = 0          # b: arm won only. c: control won only.
    zc = za = 0                          # zero-death episodes each side
    sc = sa = 0                          # survivors, summed
    for s in seeds:
        cw, aw = ctrl[s]['won'] == '1', arm[s]['won'] == '1'
        if aw and not cw:
            b += 1
        elif cw and not aw:
            c += 1
        elif aw and cw:
            both += 1
        else:
            neither += 1
        zc += 1 if ctrl[s]['survivors'] == '6' else 0
        za += 1 if arm[s]['survivors'] == '6' else 0
        sc += int(ctrl[s]['survivors'])
        sa += int(arm[s]['survivors'])

    p = exact_two_sided(b, c)
    n = len(seeds)
    print('=== ' + label + '  (n=' + str(n) + ' paired episodes'
          + (', %d unpaired ignored' % unpaired if unpaired else '') + ')')
    print('  wins            control %d   arm %d' % (c + both, b + both))
    print('  paired outcome  both won %d, neither %d, ARM ONLY %d, CONTROL ONLY %d'
          % (both, neither, b, c))
    print('  McNemar exact   p = %.4f  (on %d discordant pairs)' % (p, b + c))
    print('  zero-death      control %d   arm %d' % (zc, za))
    print('  mean survivors  control %.2f   arm %.2f' % (sc / n, sa / n))

    # The pre-registered rule, applied mechanically so it cannot be softened
    # after the fact. Note this reports the PER-FIGHT verdict; the pre-reg
    # requires a pass on at least two fights before a variant passes overall.
    if p < 0.05 and b > c and za >= zc:
        v = 'BEATS CONTROL on this fight'
    elif p < 0.05 and b > c:
        v = 'better on wins but ZERO-DEATH RATE FELL -- fails the pre-registered rule'
    elif p < 0.05 and c > b:
        v = 'LOSES to control on this fight'
    else:
        v = 'INCONCLUSIVE (not "promising" -- the instrument cannot tell)'
    print('  VERDICT         ' + v)
    return 0


if __name__ == '__main__':
    sys.exit(main())
