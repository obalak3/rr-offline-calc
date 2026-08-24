# Where this stands — 2026-08-24

Written as a handoff. `TUNING.md` holds the measurements and the traps;
`RR-AI.md` holds what is known about the game's AI. This file holds the current
architecture, what is actually fixed, and what is still open.

## The goal

Radical Red, singles, Nuzlocke rules: **win without losing a single Pokémon**.
A win costing one Pokémon is a failure. Everything below is judged by that and
not by win rate.

## Three engines exist. Know which one produced an answer.

| Engine | File | What it does | Trust |
| --- | --- | --- | --- |
| Weighted search | `rr-solver.js` | Fixed-depth (lookahead 2) minimax over a hand-weighted evaluation. Always returns something. | A guess. |
| Exact line-finder | `rr-exact.js` `cleanWin` | Depth-first search for a line where nothing faints, at **median rolls** against the AI's **top-scoring move**. | A real line, not a proof. |
| Certifier | `rr-exact.js` `certify` / `winChance` | Branches over the **full AI tie set** and over damage bucketed by whether it kills. Result of 1 means no reachable branch loses anybody. | The only thing entitled to say "proved". |

`RRExact.planRoute` asks the line-finder first and falls back to the weighted
search, tagging the result: `certified`, `line-found`, `no-clean-line-exists`,
`undecided`. The panel says which, in those words. **Anything the weighted
search produced is a guess and the UI must keep saying so.**

There is also `rr-mcts.js`, which lost on singles (56% against 60%) and is kept
only because doubles has roughly 576 action-pairs per turn where exhaustive
search is hopeless and sampling is the plausible tool.

## Where it runs

The app is a static page opened from `file://` — that is the point of the
project, so it works on a plane. The search runs in a Web Worker with **no time
cap**, live progress, and a Stop button.

Workers from `file://` are blocked (verified in Chrome: *"cannot be accessed
from origin 'null'"*), so the worker is built from a Blob, and the whole engine
is baked into a string by `tools/build_worker.js` — 24 calc files plus seven of
ours, about 1.2 MB. `tools/test_worker.js` runs that bundle in a fake worker
scope, because it is the one piece no other test can reach.

**The browser cannot be driven by tooling here.** The Chrome automation refuses
`file://` URLs, so every measurement in this repo is Node or jsdom. Serving
`dist` over `http://localhost` would allow real-Chrome UI testing, but NOT
worker questions, because `http://` permits plain workers and would give the
wrong answer.

## Numbers, and one caveat

    clean wins, 135 early-game fights
      dumb "hit hardest" baseline      20%
      weighted search                  61%
      exact line-finder                68%

**These predate the 2026-08-24 changes** (`deathRisk` to 0, `switchCost`, the
flinch fix, free-action ordering). Re-measure before quoting them.

Measured against fights *proven winnable* rather than against an imagined 100%,
the planner was at 11/12. `tools/ceiling.js` computes that ceiling; it needs
re-running because it shared a memoisation bug that has since been fixed.

Speed on Lt. Surge, generated team: **1,183,765 ms → 34,265 ms**, a 34x
improvement, from switch-matchup ordering (11x), deleting a clone-per-candidate
in `chooseReplacement` (1.8x), and caching `moveData` and `finalSpeed` (1.8x).
Every step verified by identical node counts, so behaviour never changed.

## The switch-churn problem: partly fixed

Symptom: routes like Mienshao → Victreebel → Breloom → Lilligant, eating a
Psyshock on every hop, to reach a Pokémon it could have switched to directly.
The detour then manufactures its own risk — the Pokémon arrives low enough that
something threatens it.

Three drivers. Two fixed, one not:

1. **FIXED. `deathChance` is active-only**, so switching resets it and collected
   up to `deathRisk` points for free. Default now 0. Measured: fewer switches
   *and* clean wins up from 61% to 64%.
2. **FIXED. Nothing said a switch costs a turn.** When attacking achieves
   nothing (a Fighting move into a Psychic type) attacking and switching scored
   the same and the tie broke arbitrarily. `switchCost: 60` is a tie-breaker,
   deliberately smaller than any real gain.
3. **NOT FIXED. `orderedMyActions` in `rr-solver.js` gives every switch
   `weight = -1`**, so among switches the order is just bench order. This is the
   direct cause of the chain above. `rr-exact.js` already ranks switches by the
   matchup they create; the same treatment has not been applied to the weighted
   search.

Combined effect of 1 and 2, over ~650 turns: back-to-back switches 78 → 32,
switch-backs 40 → 24. Better, not solved.

**A fourth driver, newly observed and not yet investigated:** Regenerator
stall-healing. Mienshao ↔ Lilligant ping-pong where each switch-out heals a
third of max HP. The evaluator likes the HP and nothing forces progress until
`forcing` trips after four turns without the opponent losing HP — and `forcing`
then bans switching entirely, which is its own blunt instrument.

## The central open problem: accumulating advantage

The weighted evaluator prices every turn in isolation, so anything whose payoff
accumulates is invisible to it. Named cases, all from the real team:

- **Fake Out** (Mienshao). Guaranteed flinch: free chip damage and the opponent
  loses a turn entirely.
- **Volt Absorb** (Lanturn). Switching into an Electric move converts damage
  into healing. The team gains HP.
- **Regenerator** (Mienshao). A third of max HP back for switching out, so a
  damaged pivot returns as a usable body.
- **Intimidate**. Each entry drops the opponent's Attack another stage,
  permanently reducing everything physical for the rest of the fight.

**A measurement that corrects the obvious diagnosis:** the evaluator is *not*
scoring moves in isolation — it is already state-based, and it already prefers
Fake Out. Measured at the real opening, Fake Out scores **335** against Drain
Punch's **308**, precisely because the resulting state keeps 55 HP. It loses
because two Drain Punches score a **900-point knockout inside the two-turn
horizon** and Fake Out does not. So this is a **horizon** problem, not a
representation problem, and "make the evaluation state-based" is already done.

Consequently: **do not fix this with weights.** Three separate weight and
fidelity fixes each improved the decision they targeted and each left the score
at exactly 81/135. Depth does not help either — lookahead 2, 3 and 4 all score
the same.

The leading candidate is **quiescence extensions**: do not stop at nominal depth
while the position is tactically unstable. Extend on a guaranteed flinch, a
switch, an absorb or Regenerator trigger, a status landing, a setup move, or a
Pokémon entering KO range. Not implemented.

The exact search does **not** have this problem — it plays to the end, so it
finds this play by itself. Its proved Surge line sets up Growth twice down to
17 HP before sustaining with Mega Drain, then switch-cycles. So a second
approach is simply to make the exact search finish more often.

A third, already started: use free actions as **ordering hints** in the exact
search, which is sound because ordering cannot change which lines exist.
`deniesTheirTurn` and `freeValueOfSwitch` in `rr-exact.js` rank guaranteed
flinches, absorbing switch-ins, Regenerator pivots and Intimidate entries ahead
of ordinary chip. **Effect not yet measured** — the generated benchmark teams
have none of these abilities, so the obvious test was inert.

## Open questions

1. **Is Lt. Surge cleanly winnable with the real team?** Unknown. 3,000,002
   nodes and 160 s: not found, not decided. A *generated* team's Surge fight was
   solved in 87k nodes, so the fight is winnable by some teams. Settling this
   needs a much longer run, or a better witness search.
2. **Does the free-action ordering help?** Unmeasured, per above. Needs a
   benchmark whose teams actually have these abilities.
3. **Do the 2026-08-24 changes hold up?** The headline numbers are stale.
4. **What is the real ceiling?** `ceiling.js` needs re-running after its
   memoisation fix.

## Known gaps, in rough priority order

1. **No clean line means no answer at all.** The search is all-or-nothing: it
   grinds for millions of nodes and returns nothing rather than "here is the
   line that costs you one Pokémon, and it should be this one". The most
   user-visible defect. Deliberately parked: the current focus is not losing
   anything at all.
2. **Quiescence** for the weighted search (above).
3. **Switch ordering** in `orderedMyActions` (driver 3 above).
4. **Regenerator stall-healing** (driver 4 above).
5. **Misty and Surge** are the only fights that fail across the board.
6. **Doubles.** Untouched. 27 of 167 battles, and NOT late-game: Mt. Moon /
   Super Nerd / Miguel and three Nugget Bridge fights are level-scaling, so they
   appear before Misty. Move targeting data is in (`target` on every move:
   selected / self / allFoes / allAdjacent / special / random / foeSide / ally).
   Spread damage is unavoidable — 18 distinct spread moves across those teams.
   Recommended architecture: a **separate module** reusing the damage and effect
   layer, not a refactor of the singles engine into a general N-slot one, since
   singles is heavily tested and works.
7. **Backup plans and sacrifice ranking** — which Pokémon to spend when losing
   one is unavoidable. Raised early, never started.

## Things that are settled, so nobody re-litigates them

- **Dominance pruning is unsound here.** "More HP is at least as good" fails
  because CFRU's `ShouldSwitchToAvoidDeath` is a threshold: a foe at lower HP
  can behave differently. Fine as a heuristic-search speedup, never in the
  certifier.
- **The JSON clone is the fast clone.** A hand-written structural copy measured
  1.81x slower (26.6 µs against 14.7 µs). Clone is only ~10% of a turn. It does
  need the explicit `Infinity` restore for permanent weather and terrain.
- **`turnCost` is inert by construction** — constant across leaves at the same
  depth.
- **Depth is neutral, not harmful.** The old "depth hurts" finding was an
  artifact of a broken benchmark generator and is retracted.
- **Read the team from the save, never ask for it.** `tools/read_save.js`. Two
  traps: load the Pokédex first, and create the `ArrayBuffer` inside the vm
  context.

## The real team, as of this save

    Mienshao   Lv34 Adamant Regenerator  @Sitrus  Fake Out, Drain Punch, Detect, Rock Tomb
    Diggersby  Lv34 Impish  Cheek Pouch  @Sitrus  Take Down, Bulldoze, Double Kick, Odor Sleuth
    Lanturn    Lv34 Modest  Volt Absorb  @Sitrus  Scald, Confuse Ray, Signal Beam, Shock Wave
    Lilligant  Lv34 Modest  Own Tempo    @Sitrus  Recover, Baby-Doll Eyes, Sleep Powder, Mega Drain
    Breloom    Lv34 Adamant Effect Spore @Sitrus  Headbutt, Mach Punch, Force Palm, Bullet Seed
    Victreebel Lv34 Modest  Chlorophyll  @Sitrus  Mega Drain, Sludge, Sleep Powder, Leaf Storm

Every move and ability is modelled; the engine reports nothing unmodelled for
this team. Note for Surge specifically: his permanent Electric Terrain blocks
sleep on grounded targets, so both Sleep Powders only work on Vikavolt, which
has Levitate.
