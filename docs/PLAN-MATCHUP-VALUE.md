# The matchup table as the advisor's value function

Planned 2026-08-25, after the live advisor measured 8/9 on level-appropriate
fights with Lt. Surge as the one loss. This is the plan for the "third form"
of valuing a move: not a scripted route (dead, the screen reader replaced it),
not a live deep search (tried, measured worse at 100x the cost, see commit
92c7c54), but a team-level matchup table standing where the route's foresight
used to be.

## The idea in one paragraph

A battle is a sequence of 1v1s connected by switches, and a switch costs one
free hit. So the value of a position is: with who I have left at the HP they
have left, can I still cover everyone the foe has left, and how cheaply. A move
is good if the position after it has better coverage at lower cost; a switch is
good only if the coverage it buys is worth the free hit it hands over. That is
one shared currency for attacks, switches and denied turns, which is exactly
what the race heuristic lacks: its preferences are circular because each option
is scored against a different projected future, and circular preferences are
how the advisor oscillated on Surge.

## What already exists (do not rebuild)

`rr-matchup.js` solves every (mine, theirs) pairing as a real 1v1 through
`RRExact.cleanWin`, from clean full-HP starts, with the field carried along
(Surge's permanent Electric Terrain is in the cells). Each cell already has:

    beats       a verified 1v1 win exists
    turns       how long it takes
    endHPFrac   HP remaining after winning -- the chaining currency
    dealFrac    hardest hit as fraction of their HP -- damage floor
    takeFrac    hardest hit taken -- the price of a free hit
    hopeless    unwinnable, claimed only by a FINISHED search

Known soundness rule, kept: the table may ORDER and VALUE, it must never let
the exhaustive search PRUNE. An advisor ranking moves is the ordering use, so
this plan is on the safe side of that line.

## What is missing, in dependency order

### 1. Cells that reflect the fight in progress

The table is a prior from full HP. Live, two corrections matter:

- **The active pairing is re-solved from the actual position** -- current HP,
  boosts, status -- not the clean prior. One 1v1 at a small budget, the cell
  that matters most, recomputed each turn.
- **Bench cells are HP-scaled, not re-solved.** Re-solving all 36 every turn is
  the expensive road and probably unnecessary: a bench mon's cell changes only
  when its HP changed since the cell was built. Refresh lazily: re-solve a
  cell only when that mon's HP fraction has moved by more than ~15% since the
  cell was computed. Typically two mons change per turn, so this is a handful
  of cheap 1v1s, not 36.

Measure the actual cost first (phase 0): `RRMatchup.build` prints `elapsedMs`
and nobody has looked at it from a live loop. If a full rebuild is under
~100ms, lazy refresh may be unnecessary complexity -- delete it from the plan.

### 2. The value function itself, V(position)

V0 is deliberately greedy, no sequencing:

    for each surviving foe j:
        cost(j) = min over my surviving i of price(i beats j)
        price   = (1 - endHPFrac) + switch-in tax if i is not active
                  where the tax = their best hit on i (takeFrac)
                  + hazard entry damage from the LIVE state
        uncovered foe (no i with beats, and no chip path) = large penalty
    V = -(sum of costs) - (penalty * uncovered) + small bonus for my spare HP

Known blind spots of V0, accepted on purpose and written here so nobody
mistakes them for oversights:

- One mon can cover two foes in sequence (endHPFrac chains); greedy min-cost
  treats coverage as independent. Fix in phase 4 only if measurement demands.
- Fake Out's denied turn is priced at zero rather than positive. V0 merely
  stops PUNISHING it, which the race did. Pricing tempo is future work.
- Status/stall wins appear only insofar as cleanWin found them inside the 1v1.

### 3. Ranking by V

For each legal action this turn: play the one-turn exchange against the same
plausible foe replies the advisor already uses, evaluate V on the resulting
position, rank by V-after, break ties with this turn's existing risk math
(crit exposure, roll-decided KOs). Same shape as `rankKey`, one commensurable
number where the race term was. Behind `opts.matchupRank`, default OFF until
it wins on measurement.

The tempo charge and the cycle guard STAY during evaluation. If V is a real
value function the guard should never fire, and "forced: 0 across the run" is
itself a test that the preferences stopped being circular.

## Acceptance bar, fixed before any code

Measured on `tools/measure_live.js` (maxLevel 40 set, same seeds, same foe
argmax):

    1. wins >= 8/9, no new losses
    2. WINS LT. SURGE, the fight the whole redesign is about
    3. <= 50ms per decision on average
    4. cycle guard fires zero times
    5. the never-switch diagnostic no longer beats the advisor on Surge

If it clears 1, 3, 4 but not 2: keep it OFF, publish the failing turn as a
fixture, and diagnose from evidence. Three hypotheses about this subsystem have
been wrong in one day; the fixture-first rule is what kept that cheap.

## Build order

0. **Measure the build cost live.** One tool run: table build time from a
   mid-fight state, and per-cell re-solve time. Decides lazy vs full refresh.
1. **`valueOf(state, table)` in rr-matchup.js** (V0 above), with unit tests
   pinned to the measured Surge failure: at the turn-20 position, Take Down
   from the immune Diggersby must outrank every switch; at the turn-1
   position, the advisor's opening must not be a retreat.
2. **`opts.matchupRank` in rr-plan.js**: swap the race term for V-after,
   keep survival and risk terms, wire through live.js unchanged.
3. **A/B on measure_live**, plus test_live drift/latency checks. Compare
   against both the current heuristic and the never-switch diagnostic.
4. **Only if needed:** sequencing refinement (chained endHPFrac, foe-order
   DP over the small subsets), lazy-refresh tuning, tempo pricing.
5. On clearing the bar: default ON, race term demoted to the fallback flag,
   VALIDATION-LOG entry, memory updated.

## Why this and not more search

The live search failed for a measured reason: within any live budget it proves
nothing on hard fights (100% unknown, flat ranking), because it is asked to
prove things about a 6v6. The table asks the same engine thirty-six questions
it CAN answer (4 moves, no switching, 14 turns) and composes the answers. Same
prover, decomposed problem. And unlike the race, the composition is over one
shared table, so options are compared on commensurable futures -- which is the
property whose absence caused every failure the live advisor has shown so far.
