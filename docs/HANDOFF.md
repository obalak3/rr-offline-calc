# Handoff -- 2026-08-27 (evening)

Read this, then `docs/VALIDATION-LOG.md`, then `docs/METHOD.md`.
Domain facts (both teams, why Pawmot is the wall, the Baby-Doll Eyes plan) are
in memory as `reference-rr-surge-domain` -- read that FIRST, it is the thing
that keeps having to be re-explained.

## The goal, unchanged

Beat LT. Surge (`RadicalRed.ss5`) **losing nobody but Lilligant**. James has
done this himself. Once it is reliable the target becomes **zero deaths**,
which he also believes is possible. Anything less is not the win.

## STATE: the cap is beaten -- first ZERO-DEATH win, 2026-08-27 19:30

The late-fight switch loop is root-caused and fixed (`6f7cc5e`), and the first
clean episode on that commit beat Surge with ALL SIX ALIVE:

    54/98  112/112  54/139  70/102  95/95  61/108   their five all at 0

That exceeds the cap (lose nobody but Lilligant). It is ONE episode. The open
question is now RELIABILITY: let the rotation run and count how often the
zero-death (or Lilligant-only) win repeats, per git version, in results.tsv.

### What the loop was (full decomposition in docs/VALIDATION-LOG.md)

The pricer gave the simulated foe its literal argmax; late-fight that argmax
is Volt Switch, so every simulated duel ended turn one with outcome 'left'.
All 68 candidates at turn 592 priced identically -- one turn of tempo plus the
same flat lookahead -- and the 68-way tie broke by generation order, flipping
with whoever was standing. Both directions of the flip priced their switch as
a free absorb entry. Sixteen switches, two deaths, no attack landed.

Fix, no new constants: `committedChoice` (duels.js, shared with paths.js) --
the sim foe plays its best COMMITTED action, because their switching only
reorders the duels (policy.js doctrine). And the engine now fails an immune
damaging move outright: Volt Switch into a Ground type strands its user.

`RR_EXPLAIN=1 node tools/agent.js --probe <turn.json>` prints the finalist
market with price decomposition and sim lines. This is what cracked it; use
it first on any future bad decision.

## What is running

- mGBA + `tools/lua/bootstrap.lua`. It now watches `agent_impl.lua` itself, so
  editing the Lua no longer needs `~/rr-agent/reload` touched by hand.
- `node tools/agent.js`, logging to `~/rr-agent/node.log`.
- Rotation pinned to ss5 only (`~/rr-agent/saves.txt`). ss1-ss3 are early
  fights and James does not want them run.
- Outcomes `~/rr-agent/results.tsv` (now carries a git-version column), turn
  archive `~/rr-agent/turns/`.
- mGBA can be restarted entirely from the shell: kill it, relaunch by direct
  exec, then AppleScript `File > Load recent script > bootstrap.lua`. It no
  longer needs James to click through the scripting menu.
- **The agent is a long-running process.** It fingerprints its own sources and
  announces `STALE` once if they change; restart it after any edit.

## Fixed today, each verified

All of these are the same underlying shape: **the live agent rebuilds state
from RAM every turn and `createState` zeroes everything**, so anything tracked
across turns is lost unless carried explicitly.

- **Every observation of the opponent was written to `st.foe.team[0]`** instead
  of the active. HP, status, PP and STAT STAGES all landed on Pincurchin. This
  is why Baby-Doll Eyes never handed over: the -1 went onto the wrong Pokemon,
  Pawmot always read at neutral Attack, and Lilligant stood there clicking until
  it died. (`abbc732`)
- **`justEntered` was read in `policy.js` and set nowhere** -- one read, zero
  writes -- so the entry-only move rule had never once fired and Mienshao never
  used Fake Out on a switch-in. (`755c4ed`)
- **`protectChain` was zeroed every rebuild**, so Detect looked like a free turn
  forever and got spammed in front of a Pawmot on 22 HP. (`d5a2eae`)
- **Candidates were generated against a FULL-HEALTH target** (cache keyed on
  foe+terrain only). With Pawmot on 41/99 and a Drain Punch band of 52-63 in
  hand, no candidate said "finish it" -- so it switched Diggersby in, Diggersby
  died in one hit, Pawmot drained back to 97. That repeated in five runs.
  (`afd9db7`)
- **Plans were PRICED against a full-health target too** -- `chooseAction` built
  the entry state with our HP and their dead list, and dropped the target's own
  HP. Same bug, second place. (`1a0eaf3`)
- **Losses were never recorded**: a whiteout heals the party before the
  post-battle read, so every loss logged as UNCLEAR and vanished. The 11-0
  record was never true. Now latched from in-battle reads. (`e4d0961`)
- **`TEMPO`/`SPEND` were out of scope in the no-kill fallback**, so every
  fallback turn threw and fell through to greedy one-turn scoring. (`e4d0961`)
- **Bellibolt has ZERO EVs**, not the sheet's 100: max HP 125, not 133. All five
  opponents now compute RAM-exact. (`f512e31`)
- `buildState` no longer hands `createState` a null team, which used to kill the
  whole agent process and look exactly like the emulator being stuck.

## Open, in rough priority order

- **Reliability of the win.** One zero-death episode is n=1; the 11-0 record
  was once false too. Count episodes per version in results.tsv before
  claiming anything.
- **Vikavolt Roost stall.** The committed sim foe attacks, the real Vikavolt
  Roosts; live it took ~15 Rock Tombs and won only because Roost has 16 PP.
  Safe, slow, unpriced.
- **Chip/absorb legs are generated against a full-HP party**, so plan labels
  promise chippers that execution skips ("Lanturn chips it" at 6 HP goes
  straight to the finisher). Prices are honest; labels lie; candidate list
  floods with aliases of the same degenerate plan.
- **The lookahead can invert a better plan.** Prices each remaining opponent
  independently, flat 8 when it finds nothing (that flatness was half the
  loop tie). Depth is MEASURED AT 5; do not retune without James.
- **Telemetry is untrustworthy in three places**: wrong foe species in some
  turn headers, "expecting to deal 0 and take 0" always zero, impossible
  resolved-damage numbers on switch turns. Audit before quoting any of them.
- Chip chains (`RR_NO_CHIP_CHAINS` disables) remain unproven either way.
- Crits still not predictable from the decision-time seed (see the negative
  result in VALIDATION-LOG); refit needs post-band-fix rows.
- Mega evolution unmodelled (Intimidate fires twice).
- Opponent predictor is 56% live; the committed-choice fix reduced how much a
  wrong pivot prediction can hurt, but the port gap stands.

## How to work on this

Measure live. `tools/test_replan.js` never calls `buildState` and therefore
cannot see any of today's bugs; it reported 0/12 wipes while live play was fine
and sent a whole investigation the wrong way. Offline is a crash check, not
evidence.

Reproduce an archived turn directly with
`node tools/agent.js --probe ~/rr-agent/turns/turnNNNNN.json`, which also prints
why the planner returned nothing. Note the probe does NOT restore `turnsOut`
from the archive, so entry-only moves can look legal when live they were not --
that mistake produced one confident and completely wrong comparison today.
