# Handoff -- 2026-08-27 (evening)

Read this, then `docs/VALIDATION-LOG.md`, then `docs/METHOD.md`.
Domain facts (both teams, why Pawmot is the wall, the Baby-Doll Eyes plan) are
in memory as `reference-rr-surge-domain` -- read that FIRST, it is the thing
that keeps having to be re-explained.

## The goal, unchanged

Beat LT. Surge (`RadicalRed.ss5`) **losing nobody but Lilligant**. James has
done this himself. Once it is reliable the target becomes **zero deaths**,
which he also believes is possible. Anything less is not the win.

## THE OPEN PROBLEM -- late-fight collapse

**This is the only thing that matters right now.** James, watching it live:

> "The problems I am talking about never happen early game, they are all late
> game... The baby doll eyes plan was great and the current hit pawmot with leaf
> storm while manectric switches to pawmot is also working great. The problem
> seems more to me like the model goes crazy after a certain amount of turns
> pass. The problem isn't the engine, something happens when the game goes too
> long."

The evidence, from the fight of 18:50 (turns 592-613):

- **Turns 592-607: sixteen consecutive switches**, Mienshao -> Diggersby ->
  Mienshao -> Breloom -> Mienshao -> Lilligant ..., no attack landed, our side
  taking a free hit every turn. Diggersby died in it.
- **Turn 608 onward it simply worked**: Fake Out, then Rock Tomb five times.
  James: Fake Out + 2 Rock Tombs "would have literally won the game".

What the log shows during the loop, and this is the shape of the bug:

    592  Mienshao out  PLAN "spe -1, psn, then Mienshao KILLS"      -> switch to Diggersby
         [switch margin 9.93 vs staying in ("... then Mienshao SOFTENS + Breloom closes")]
    593  Diggersby out PLAN "spe -1, psn, then Mienshao SOFTENS..."  -> switch to Mienshao
         [switch margin 9.85 vs staying in ("... then Mienshao KILLS")]
    594  Mienshao out  ... identical to 592
    595  Diggersby out ... identical to 593

**The same two plans swap prices depending on which Pokemon is standing.**
Whichever plan needs the Pokemon that is NOT out wins, so the agent switches,
and next turn the other one wins. The margin is ~10, so the incumbent bonus
(`STICK`, 0.75) cannot hold it. A margin of ~10 is roughly `illegal death 6 +
4 * deathRisk`, which suggests every "stay" line is priced as the active dying
-- so both Pokemon are individually correct to flee, and the fleeing is what
kills them.

PP was checked and RULED OUT: Mienshao sat on 3,10,4,15 through the whole loop.

Next step: get `planJobs` for turns 592-595 out of `~/rr-agent/turns/` and find
why the "stay" variant is priced ~10 worse than the "switch" variant when they
are the same plan seen from two sides.

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

- **The late-fight switch loop above.** Everything else is noise next to it.
- **The lookahead can invert a better plan.** It prices each remaining opponent
  independently, assumes one healthy Pokemon handles all of them, and returns a
  flat 8 when it finds nothing. Depths 12 and 30 lose every run; it sits at 5
  only because deeper is worse. It has **never been tested off**. Do not retune
  it without James -- these are the fitted constants he wants derived.
- **Chip chains (`RR_CHIP_CHAINS`) are default ON and unproven.** They do not
  displace the Baby-Doll Eyes plan (checked: identical top-6 ordering, BDE at
  ranks 4/7/13 either way), but they have never been shown to help.
- **Crits cannot currently be predicted from the decision-time seed.** The LCG
  is solved (`v*0x41C64E6D + 12345`) and the seed is read every turn as
  `obs.rng`, but a fixed draw offset fits at 85% against an 82% "always guess
  no-crit" baseline -- noise. The per-move draw order (one draw per luck event:
  accuracy, crit, damage, secondary) is the right model and the damage roll IS
  locatable within a single move+context (Sludge alone: draw 3, consistent
  across 16 rows, p ~ 1e-10). Refitting needs rows recorded AFTER today's band
  fixes; the historical ones are contaminated (Scald shows a 67% "crit" rate,
  which is the old Bellibolt 133-vs-125 error, not crits).
- Mega evolution unmodelled (Intimidate fires twice).
- Opponent predictor is 56% live, not the 75.5% the offline fixture claims.

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
