# Implementation plan: the restart driver (written 2026-08-24, late)

## STATUS

- **Phase 0a DONE** (4a1718e). bench_mirror no longer calls a timeout a loss.
- **Phase 0b DONE** (9092939). STATE.md's five stale claims corrected inline.
- **Phase 1 DONE** (ed335ac, eaa7941, 94103cb). Luby restart driver in
  `cleanWin`, ADDED to the portfolio rather than replacing it; absolute caps so
  a huge budget cannot starve it; and a deeper horizon rung gated on having
  actually seen lines run past the horizon.

      all 139 mirrors, 250k nodes    before      after
        clean wins                  113/139     125/139
        undecided                    23/139      11/139
        no clean line                 3/139       3/139
        actually LOST                 5/139       2/139

  Brock 6v6 mirror: undecided at 250,001 nodes / 93s -> FOUND 18T in 19,613 / 11s.
  Treasure Beach, with the rung: undecided at 250,001 -> FOUND 38T in 168,563.
  All 13 test files green; worker bundle rebuilt and passing.
- **NEXT: Phase 3 (min-loss).** Phase 2 (novelty) is explicitly gated on Phase 1
  saturating, and it has not -- restarts just took 12 of the 23 undecided
  mirrors, so there is more to get from allocation before reaching for novelty.
- **Still owed**: `bench_game.js` re-run ALONE (the instrument with the most
  headroom, 57% undecided when last measured). NOT comparable to its recorded
  42%: the generator changed since. Run it uncontended and treat it as a new
  baseline. Also the real-team Lt. Surge question via `hunt_parallel.js`.

The one-paragraph summary of the analysis: every failure of every engine in
this project's history is "undecided", never "impossible", and the search's
runtime is heavy-tailed in the classic Gomes/Selman/Kautz sense (Brock 6v6
mirror: 74 nodes down one opening, >250,000 down another). Every intervention
that ever paid (ordering, pairing table, fractional beam, portfolio, parallel
root split, hpBuckets) is a budget-allocation/restart strategy; every judgment
intervention (weights, AI fidelity, depth, prunes, MCTS) measured zero. The
principled form of what keeps working is a Luby-scheduled restart loop over
root openings. Measured across ~40 real fights: median ~10x fewer nodes, best
1,193x, multiple rescues, one regression under naive doubling that Luby's
schedule is designed for. Luby <= naive doubling on every fight tried.

## Phase 0a: bench_mirror stall-vs-loss fix (small, do first)

`tools/bench_mirror.js` classifies the weighted fallback as
`route.won ? 'wins, losing N' : 'LOSES THE FIGHT'` with `maxTurns: 40`. That
conflates a timeout with a wipe. Measured: 3 of the recorded "5 outright
losses" are cap artifacts; TREASURE BEA./SWIMMER AMARA is actually a CLEAN WIN
at 66 turns; ROUTE 13/ALMA wins losing 1 at 99T; VICTORY ROAD/COLBY wins
losing 2 at 135T. Only NELLE (real min-loss case) and ELITE FOUR LANCE (real
wipe) survive.

Fix: raise the fallback's `maxTurns` to 160 (Colby needs 135), and classify by
team state, not by `route.won` alone:

    wipe  = !route.won && route.losses === ourPartySize   -> "LOSES THE FIGHT"
    stall = !route.won && route.losses <  ourPartySize    -> "stalled, no verdict (not a loss)"

Do NOT use `route.stalled` for this: rr-solver.js sets
`stalled: stalled || (!wonIt && steps.length < maxTurns)`, so a genuine wipe
(which ends the loop early) also reads `stalled === true`. Losses-vs-party-size
is the reliable test. Verify against AMARA (should become a win at 160 turns)
and NELLE (should stay a loss).

## Phase 0b: STATE.md corrections (docs only)

1. "cheapWitness ... OFF by default ... certifying is the open work" -- FALSE.
   Commit 180019d made it ON by default (`opts.probe !== false`), running LAST,
   and certifying. Also record the A/B: on bench_early 15 it is worth exactly
   zero (99/135 with and without, identical per-fight); its 26-of-31 value was
   mirrors only. Mirrors are systematically easier (same team both sides, a
   shallow clean line usually exists); do not select mechanisms on mirror
   evidence alone.
2. Open question 1's "Lt. Surge REMATCH mirror undecided at 250k while the
   weighted search wins" -- resolved by the fractional-beam fix; it now solves
   in 15,533 nodes (re-verified today). The "Brock pattern recurs" warning is
   obsolete.
3. Open question 4's "this is the trigger for proof-number search" -- retract.
   TUNING.md's own later analysis is correct: cleanWin's opponent never
   branches, so this is single-agent pathfinding, and PNS targets a shape the
   problem does not have. The restart driver (this plan) is the response to the
   56M-node Surge result.
4. Worklist item 1 (min-loss) evidence: "5 outright losses" is really ~2 (see
   Phase 0a). Min-loss stays on the list (Phase 3) but is no longer the top
   item. Also STATE.md 1b's suspicion about TREASURE BEACH "LOSES (lost 0)"
   is confirmed: turn-cap artifact.
5. Add: bench_early is SATURATED -- planner 73% vs measured ceiling 74%,
   wins 20/20 of everything shown winnable, remainder undecided by the oracle
   too (same search). It cannot show search progress. Headline instruments are
   now the mirror sweep (23 undecided) and bench_game (57% undecided). Also
   the horizon note in Phase 1 below.

## Phase 1: the Luby restart driver in rr-exact.js (the main event)

Replace the two hunt passes (matchup-ordered + fractional beam) inside
`cleanWin` with a restart loop; KEEP the plain exhaustive completion as the
only thing that concludes. Prototype that produced today's numbers:
`tools/exp_luby.js` (committed alongside this plan; standalone, not in npm
test).

Design:

- Enumerate legal root actions once (the same enumeration `walk` uses at the
  root; do not hardcode 'm0..m3,s1..s5' -- fainted/empty slots shift indices).
- Luby sequence 1,1,2,1,1,2,4,1,1,2,4,8,... times a unit of roughly
  `budget / (numRoots * 8)`, floor ~150 nodes. Iteration i runs opening
  `roots[(i-1) % live.length]` full-width, full-horizon, with the cutoff as its
  node budget and a FRESH `seen` map.
- Per-opening bookkeeping: an opening whose restricted pass finishes without
  truncation, passOver, or gaveUp is DECIDED EMPTY and leaves the live set.
  This is sound by the same argument rr-search.js already relies on: the
  root's branches partition every line, and the caller owns the sum.
- Terminate: witness found (return it); every opening decided empty at full
  width and full horizon with no truncation anywhere -> `decided: true`; else
  budget/time out -> undecided, then fall through to the existing exhaustive
  completion pass over the still-live openings with whatever budget remains.
- `opts.passes` escape hatch and `hunt: false` must keep working; keep the
  restart driver behind the same `huntWorthIt` budget gate (>= ~50k) so cheap
  fights do not pay restart overhead (the portfolio had the same rule).
- Add horizon rungs to the schedule: after the 24-turn schedule settles
  nothing, one pass of rungs at `maxTurnsCeiling` (the app passes 40) BEFORE
  giving up -- measured case: TREASURE BEACH undecided at 250k/24T but FOUND
  in 5,990 nodes at 40T. Trap fixed here: the existing `blockedByHorizon`
  upward extension can never fire on budget-bound fights (a too-short horizon
  thrashes the budget and looks budget-bound; the test requires finishing the
  tree). An opening decided-empty at 24 turns is NOT decided at 40 -- track
  decided per (opening, horizon).
- hpBuckets stays available for non-concluding restarts exactly as it was for
  beam passes.

Soundness invariants that must survive (test_invariants.js checks most):
found lines replay clean; a narrowed/blurred/restricted-and-truncated pass
never concludes; determinism; more budget never loses a line; caches do not
leak between fights; step() never mutates input.

Definition of done / measurement (narrowest first, per James's test cadence):
1. `node tools/test_exact.js` and `node tools/test_invariants.js` green.
2. Spot set, no regression vs the shipped portfolio numbers: LT. SURGE team 1
   (witness ~15-23k nodes), MT. MOON t1 (~1-5k), BROCK 4v4 mirror
   (~26k or better), MISTY mirror (~13k).
3. The payoff set: BROCK 6v6 mirror (undecided@250k -> should now solve),
   the 23 undecided mirrors (`tools/bench_mirror.js "" 250000 --all`,
   expect several to fall), `tools/bench_game.js 2` (57% undecided is the
   number to move; NOTE: the re-run attempted today produced no output in
   ~40 min under CPU contention -- run it alone).
4. Rebuild the worker bundle (`node tools/build_worker.js` or
   `cd upstream-calc && npm run build`) and `node tools/test_worker.js`,
   or the app keeps the old engine.
5. The real-team Surge question: `tools/hunt_parallel.js` resumes from
   checkpoints (5/7 openings already settled). Re-run under the new driver.

## Phase 2 (only if Phase 1 saturates): novelty pruning

Width-based search (Lipovetzky & Geffner IW/BFWS) is the principled version of
hpBuckets (which measured 19%): prune states containing no novel small feature
tuple (active mon each side, HP band, status, stat stages, hazards). Restart
passes only, never concluding passes. This targets the measured diagnosis
directly (wide tree, HP drift, transposition table idle). Hypothesis, not a
proven win: measure on Misty (the one fight nothing has moved -- confirmed
today unmoved at horizons 24/40/60, 400k nodes) and Elite Four.

## Phase 3: min-loss, scoped honestly

The Nuzlocke cut is one line (`countFainted(next.me) > before`, rr-exact.js
~line 564, and its twin in winChance ~1112). Generalize to a loss budget k,
iterate k=0,1,2. The cut is what makes search affordable, so measure blowup on
NELLE first (2v2, k=0 tree exhausts in 1,051 nodes; the k=1 win exists at turn
10, verified). Value: ~2 fights in 139 plus honest advice when clean is
impossible, which the real run will eventually need.

## Phase 4 (parallel to everything, needs James): real-game validation

No line this project has produced has ever been played in the actual game.
Protocol: pick one certified line for a real upcoming fight, James plays it,
log predicted-vs-actual AI move each turn. One deviation is worth more than
any benchmark. The AI model's ~880 scoring sites remain unported; this is the
only test of whether the model's argmax matches reality.

## Where today's raw evidence lives

`REVIEW-2026-08-24.md` has all numbers. The session scratchpad
(/private/tmp/claude-501/...) may be gone; every number needed was copied into
that file. Prototype: `tools/exp_luby.js`.
