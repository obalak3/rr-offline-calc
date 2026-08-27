# Handoff -- 2026-08-27

Read this, then `docs/VALIDATION-LOG.md`, then `docs/METHOD.md`.

## The goal, unchanged

Beat LT. Surge (`RadicalRed.ss5`) **losing nobody but Lilligant**. James has done
this himself and says it is comfortably possible. Anything else is not the win.

## What is running

- mGBA with `tools/lua/bootstrap.lua` loaded; it re-reads `tools/lua/agent_impl.lua`
  whenever `~/rr-agent/reload` changes (`date +%s > ~/rr-agent/reload`).
- The brain: `node tools/agent.js`, logging to `~/rr-agent/node.log`.
- Rotation pinned to Surge via `~/rr-agent/saves.txt`.
- Outcomes: `~/rr-agent/results.tsv`. Turn archive: `~/rr-agent/turns/`.
- **One engine only**: `upstream-calc/src/js/rr-battle.js`, loaded by both the live
  agent and any offline script through `tools/lib/harness.js`. There is no separate
  offline engine. When an offline test disagrees with the game, the STATE was built
  wrong, not the engine.

## The live record (what actually matters)

11 fights, 11 wins, 0 losses. Casualties:

| casualties | fights |
|---|---|
| Mienshao + Lilligant | 7 |
| **Lilligant only (the target)** | **1** |
| other | 3 |

So the target is reachable and not yet reliable, and **Mienshao dying is the
dominant failure**. **Caveat found 2026-08-27 (evening): those 7 are mostly the
same trajectory.** Seven rows in results.tsv end with the byte-identical HP
vector `0/98 112/112 82/139 0/102 95/95 62/108`, ~250s apart -- the reload loop
replaying a near-deterministic fight. Count the record by distinct trajectory,
not by row. The conclusion stands (the modal trajectory kills Mienshao) but the
sample is ~5 distinct outcomes, not 11. Rows now carry a git-version column so
future changes are judged against the rows they produced; 2-3 replays per change
is enough.

## THE NEXT THING TO BUILD (James's diagnosis, unaddressed)

> "there is almost never a killing line. There is a multiple moves doing chip
> damage which ends up killing line"
> "It was switching lanturn in and out and doing scald damage then killing with
> something else etc. That is not a OHKO plan, that is a chip plan"

`tools/lib/candidates.js` cannot express that. Every family it builds ends with
ONE designated Pokemon duelling the foe to death:

1. solo -- `duelLines(...).find(l => l.outcome === 'kill')`
2. lever + killer -- change the position, then one killer duels it
3. closer -- hand the last hit to a priority attacker

Measured on 200 live plans: 194 were two-leg, 6 were solo duels. There is no
family for "A chips, B chips, C finishes" where no single Pokemon has a killing
line, which is what James actually does and what works.

The job format can already express it -- `jobDone` in `tools/lib/policy.js`
supports `until: {uses, selfHp, foeHp, foeStatus, foeVolatile, foeBoost, entered}`
-- so a chip line is a list of `{mon, moves: ['*'], until: {selfHp: ...}}` legs.
What is missing is generation.

Two attempts at the surrounding symptom were rejected by James and should NOT be
retried as-is: a +2.5 switch penalty in the one-turn fallback, and a best-effort
chip branch bolted onto `chooseAction`. His objection is architectural and right:

> "this stuff should be internal to the ai not external rules for surge"

Tempo stays for now; **raise it again when moving to the next fight**.

## Fixed and verified today

- **Switching works: 17/17** (was 3/126). Three causes: the party screen is a
  two-column grid and DOWN only walks one column (cursor cycles 0,2,4,7); screen
  ids were being used to decide the switch had committed; and the party is
  renumbered mid-fight. Display slot == RAM slot. Switch commands now carry the
  target's max HP + level and the actuator re-resolves against live RAM at the
  moment of the press.
- **Outcomes are recorded at all.** 239 fights had been played without recording
  one, so nothing could be judged.
- **Tempo cost in the planner** stopped a 12-turn Lanturn/Lilligant ping-pong.
  Value 0.4 swept on this fight; at 0 the team is wiped, at 1.3 it wipes again.
- **A pivot is no longer a failed line.** Vikavolt Volt Switches away, which
  discarded 39 of its 48 lines. It went from 8 no-plan/0 plan to 0/2.
- **Lookahead depth 5, measured.** Depths 12 and 30 lose every run: the
  continuation prices each remaining opponent INDEPENDENTLY, so it assumes one
  healthy Pokemon handles all of them, and looking deeper finds more lines that
  quietly reuse a Pokemon already committed. Fixing that means pricing the
  remaining opponents as one combination.
- **Engine: Fake Out off a pivot was impossible.** `turnsOut` was incremented at
  the end of the switch-in turn, so a Pokemon's first action was refused as "not
  on the way in". Fixed with `enteredThisTurn`. Verified three ways: pivot Fake
  Out flinches, the turn after fails, a lead still flinches on turn 1.
- **turnsOut is now tracked live.** `B.createState` zeroes it for everyone and the
  agent rebuilds state every turn, so the active always looked freshly arrived and
  Fake Out was spammed. The agent counts decisions since the active last changed,
  and `pricePath` carries it through `entry.turnsOut`.
- **Planned turns now predict.** That branch built its answer with `all: []` and
  `theirs: null`, which is why the log read "they will: none" and "expecting to
  take 0" -- the plan was computed against an opponent that does nothing. Added a
  veto: if the planned action kills our own active this turn and does not KO the
  foe, take the best non-lethal alternative.
- **Bellibolt's stats now match RAM (all five opponents do).** The sheet gave
  it 100 HP EVs; RAM says zero, which reproduces its entire stat line exactly.
  Fixed in `foeSets` via a RAM-verified corrections table in harness.js, so the
  live agent, planner, and benchmarks all see it. (The handoff's "Pincurchin
  99/95" was a mix-up: Pincurchin computes 95 = RAM; the 99 is Pawmot's.) Likely
  also explains Lanturn's Scald landing above its band max vs Bellibolt: an HP
  bar converted with max 133 instead of 125 inflates observed damage by 6.4%.
  Re-verify live.
- **Predictor ties break on damage.** Against a Victreebel that both moves KO,
  Thunder Punch (39) and Ice Punch (80) both scored 109 and we answered the weaker
  one. Now predicts Ice Punch, matching the game.

## Open

- The chip-plan family above. This is the main one.
- Switch spam persists on fallback turns; the right fix is to stop needing the
  fallback (see above), not to penalise switching in it.
- Fitted constants that are not yet internal to the AI: tempo 0.4, `dyingNext` 45,
  illegal death 6, expendable death 2. James wants these derived, not tuned.
- Mega evolution is unmodelled: the base form arrives, evolves the same turn, and
  the ability fires twice (Manectric gets Intimidate twice, so -2).
- `B.legalActions` does not enforce Fake Out's entry-only restriction; only
  execution fails. Anything trusting legality can plan an illegal move.
- Predictor accuracy since turn 2600: Pawmot 47%, Vikavolt 20%, Manectric 0/8,
  Bellibolt 0/4. Switch *scoring* is still not ported (`rr-ai.js` returns BASE).

## How to work on this

Measure live, not offline. A single deterministic offline trajectory said the
casualty was Lanturn; the live distribution is Mienshao + Lilligant in 7 of 11.
Tuning against that trajectory produced two wrong conclusions today.
