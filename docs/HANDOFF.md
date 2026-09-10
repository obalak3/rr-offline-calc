# Handoff -- current as of 2026-09-10 (head e7f4398, branch battle-solver = main)

Everything before 2026-09-05 is in docs/HANDOFF-HISTORY.md, verbatim. This file
is the whole current picture. Read docs/ASSUMPTIONS.md for engine assumptions.

## 1. What this is

A self-playing battle agent for James's Pokemon Radical Red rehearsal run:

- **Actuator** `tools/lua/bootstrap.lua` -> `agent_impl.lua` inside mGBA. Reads
  battle RAM every frame, writes `~/rr-agent/state.json` when the game asks for
  an action, presses what `~/rr-agent/cmd.json` says. Hot-reloads agent_impl.lua
  on `touch ~/rr-agent/reload` (NOT on the file's own mtime).
- **Brain** `tools/agent.js` (Node). Decodes the party records, builds the
  engine state, runs the planner, checks the answer against the oracle, writes
  cmd.json. Panel `tools/control.js` on :8420 (separate process).
- **Planner** `tools/lib/`: candidates.js (line generation, families 1-7),
  paths.js (pricePath simulation), replan.js (market: shortlist, lookahead,
  death-last partition, switch rule), policy.js (executor), duels.js,
  gameplan.js (rest-of-fight estimate), difficulty.js (tier + clean answers),
  position.js (position score), enablers.js (levers), oracle.js (headless core).
- **Engine** `upstream-calc/src/js/rr-battle.js` (+ rr-ai.js, the enemy AI
  port, 76% exact / 89% top-2 on Surge). Rebuild the site bundle with
  `npm run build` after data changes.
- **Oracle** `tools/headless/oracle` -- a windowless mGBA 0.10.5 core (see 3).

## 2. James's rules (do not relearn these)

- **Explain before patching.** When he asks WHY, answer in game terms (what it
  believed, which step of his line it could not see), propose, then WAIT.
- **"Move 1" / "the first turn" means the first decision of the current
  fight.** Read the fight from its first turn; name the turn being answered.
- **The oracle is legal only because it is invisible.** Nothing may appear on
  his screen: no rewind in the window he watches, no second window. A hidden
  core is fine. Loading a state is what F5 does, so `loadstate` is fine.
- **A stat move is not an improvement by itself.** Speed drop on a slow
  Pokemon, Attack drop on a special attacker = nothing. Measured, never
  labelled. Growl into Mega Venusaur was called "unacceptable"; it is now
  gated at generation and guarded by `node tools/test_growl.js`.
- **Improving the position counts, in balance.** Healing Lanturn (the answer
  to their Electric types), an Attack drop on a real physical wall, a sleep --
  worth what they measurably change, never enough to stall forever.
- Fake Out: if Mienshao/Hitmonlee is already in, Fake Out first turn almost
  no matter what; never switch in just to Fake Out unless a priced plan needs
  the stolen turn (Regenerator makes the Mienshao cycle self-funding).
- Zero deaths is the target; "nobody but Lilligant" is the Surge cap.
- Crits are ignored in the death read (his call). Legal moves = ban-list
  clean AND obtainable by that fight; list TM picks for him to veto.
- Never stream per-turn monitor events at him; one waiter per fight.
- Live-run etiquette: check `ioreg HIDIdleTime` and the frontmost app; do not
  take the screen while he is working; never drive windows while the display
  is asleep. Do not launch a second live agent (`node -e require(agent.js)`
  starts one).

## 3. How to run

    # emulator (direct exec skips Gatekeeper); -t loads a state at start
    /Applications/mGBA.app/Contents/MacOS/mGBA -t ~/RadicalRed-mGBA/RadicalRed.ss1 ~/RadicalRed-mGBA/RadicalRed.gba
    # script: Tools > Scripting... > File > Load recent script > bootstrap.lua
    # (System Events can click those menus; the Scripting window then has focus
    #  -- raise the game window before sending game keys)
    # brain
    cd ~/rr-offline-calc && EXPENDABLE="" nohup node tools/agent.js > ~/rr-agent/agent-node.log 2>&1 &
    # panel
    node tools/control.js
    # load a state without touching any window
    echo /Users/omerbalak/RadicalRed-mGBA/RadicalRed.ss5 > ~/rr-agent/loadstate
    # unattended runs: RR_ASK_TIMEOUT=20 (panel wait, default 300 s)

Health: `stat -f %Sm ~/rr-agent/heartbeat` must be recent (the Lua died
silently once); `[oracle gate: ...]` on every decision in agent-node.log.

Save states: ss1 (Sep 8 22:42) and ss4 (22:36) hold James's latest progress;
ss3 is from Sep 5; ss5 = Surge (the rehearsal test); .sav last written Sep 3.

Tests: `node tools/test_plan.js` (planner, 0 failures), `node tools/test_growl.js`
(the Growl regression), `node tools/audit_mechanics.js` (engine effect
surface, 0 gaps). test_battle.js has 3 pre-existing unrelated failures.

Analysis of a played fight: copy the log into the run's turns dir first
(`cp ~/rr-agent/agent-node.log ~/rr-agent/turns/<dir>/`), then
`node tools/analyze_fight.js ~/rr-agent/turns/<dir> [from] [to]` (turn by
turn: plan, played, resolved, PLAN CHANGED / DEATH / PANEL ASK, CHURN line).
`node tools/audit_damage.js <dir>...` compares every hit we landed with the
engine's roll range.

## 4. The oracle (2026-09-08)

`tools/headless/oracle <rom> <state.ss> move N | switch RAMSLOT | peek [--save out.ss]`
loads a save state taken on our action menu, presses exactly what the
actuator presses, runs until the game asks again, prints before/committed/
after JSON plus an `obs` line in state.json format (feed it to `--probe`).
~0.7 s per action. This ROM's battle RNG is consumed per call and restored by
the state, so the oracle's answer for an action IS the live outcome.

Build (once): clone mGBA 0.10.5 into tools/headless/mgba-src, cmake into
mgba-build with `-DCMAKE_POLICY_VERSION_MINIMUM=3.5`, ffmpeg OFF, PNG pinned to
/opt/homebrew/opt/libpng (Mono's ancient png.h wins otherwise and states fail
to load), system zlib; then `tools/headless/build.sh`. Homebrew's libmgba is
broken (links a removed ffmpeg) and brew cannot build from source here (old
Command Line Tools).

Live wiring: the actuator writes `~/rr-agent/turn.ss` one second into every
menu via `emu:saveStateBuffer(10)` + Lua io (`saveStateFile` writes 397312
zero bytes -- write-only VFile bug, same as the C core unless opened RDWR).
agent.js waits up to 2 s for it, then plays the chosen action and every legal
rival, scores each real after-state with the position score (+their HP
removed, +1000 per kill, -30 x importance per faint), and replaces the plan
only if a rival beats it by RR_ORACLE_MARGIN (25 HP-equivalents). The death
veto's dodge is just a rival now (its unverified guess once made a 24-switch
carousel). A plan that IS a bait/absorb line is verified on its second turn;
a verified heal >= 15% of the absorber beats a same-turn kill unless it is
their last Pokemon. `[oracle NNNNms: ...]` lines say what it saw.

Party menu: the battle party screen draws from its own copy at 0x020158AC in
DISPLAY order (RAM order with one swap per switch so far); the oracle and the
actuator find the target there by species + max HP (retry every frame up to a
second, RAM slot fallback). Active's RAM index: u16 at 0x02023BCE.

## 5. The position score (2026-09-08, position.js)

- importance(ours) = 1 + 0.5 per remaining opponent this Pokemon is a clean
  answer to (difficulty.js duel table). HP term = sum importance x HP fraction;
  heals are credited (they were clamped to zero before).
- Their conditions: Attack/Sp.Atk drops and burn = damage their REAL moves no
  longer do to our living Pokemon; Speed drops/paralysis = hits avoided only
  where turn order flips; sleep = turns lost; poison/burn chip. Our boosts =
  damage added. Capped at one Pokemon (RR_POS_CAP). RR_POSITION=0 restores the
  flat price.
- Generation gate (candidates.js condMatters): a stat lever is offered only if
  the imposed condition moves their best hit on some living Pokemon of ours by
  >= 3%, flips an order, or raises our best hit (Def/SpD); paired conditions
  must justify every part.
- Absorbers count Electric STATUS moves (Bellibolt throws Thunder Wave at
  Mienshao; Volt Absorb eats it and heals).
- Switch rule: a switch must beat staying on the immediate price as well as
  on the total (the rest-of-fight guess alone may not justify it).

## 6. Results (all live)

Surge s5 (rehearsal): old code WIN-1 | runs 2-3 WIPE (same crit replayed) |
4 WIN-2 | 5 WIN-2 | 6 WIN-4 | 7 WIN-1 | 8 WIN-0 | 9 WIN-0 (replay of 8) |
2026-09-08: three wipes while the snapshot was zeros (old sequence replayed)
| run 16 WIN-0 on a NEW route (Bellibolt, Vikavolt, Pawmot, Manectric-Mega,
Pincurchin) with the oracle live: Manectric-Mega fell to James's dance
(Mienshao in, Lanturn absorbs Volt Switch +66 twice).
James's own fight 2026-09-08 (Rillaboom / Mega Venusaur / Meowscarada route):
WIN, no deaths, with the two flagged mistakes (turn 221 switch, turn 229
Growl) now fixed and the Growl one under test.

From a save state the fight is deterministic given our actions (RNG per
call); repeated identical runs measure nothing. The Lua's own restart path
reseeds the RNG; F5 and `loadstate` do not.

## 7. Open items, in order

1. Switch churn (35-83% per segment in run 16): a dodge switch that only
   delays still scores too well on one turn. Candidates: a tempo cost in the
   oracle score for a turn that removes no HP from them; two-turn oracle
   roll-outs for the top few candidates.
2. Turn 221 (Accelgor vs Rillaboom, switch instead of Bug Buzz): fixed by the
   immediate-price switch rule; James said it "can be discussed" -- a value
   question, not to be changed further without him.
3. Damage gap: Mienshao's Drain Punch into Pawmot lands at 62-81% of the
   engine's range every run (both sides' stats verified equal to live; Fake
   Out, Scald, Bug Buzz, Rock Tomb match). James to check in game / on the
   RR calc site. Every "Mienshao kills Pawmot in N" is one hit optimistic.
4. Their damage is not audited (audit_damage covers our hits only).
5. A second rehearsal fight to test on, James's choice.
6. Unmodelled: Parental Bond; AI flags constant for all trainers.

## 8. Instruments and flags

Probe: `RR_PROBE_LINES=N RR_PROBE_PREV=<prev turn json> node tools/agent.js --probe <turn json>`
plus RR_PROBE_LINES_MATCH=<regex> (per-line simulated log with `fs` foe
status, `fa` real foe active, `nu` engine notes), RR_PROBE_DMG=1 (damage
table, with RR_PROBE_DIFFICULTY=gen), RR_PROBE_DUEL=1 / RR_PROBE_DUEL_MON,
RR_EXPLAIN=1 RR_EXPLAIN_N=10 (here/ahead per finalist; RR_EXPLAIN_GREP),
RR_DEBUG_LEVERS=1 (every lever duel and gate verdict), RR_DEBUG_BAIT,
RR_DEBUG_OPENER, RR_DEBUG_BEST, RR_DEBUG_ORACLE.
Planner knobs: RR_POSITION, RR_POS_IMPORTANCE (0.5), RR_POS_CAP (1),
RR_DEATH_LAST, RR_AHEAD_DEATH (3), RR_SWITCH_MARGIN (0.5), RR_FINALISTS (4),
RR_CARRY_PROGRESS, RR_FOE_ROLL, RR_CAREFUL, RR_CRIT_RISK, RR_ENTRY_MODEL.
Agent knobs: RR_ORACLE (0 = off), RR_ORACLE_MARGIN (25), RR_ASK_TIMEOUT,
RR_JITTER_MS (900; harmless, does not change rolls), RR_WILD, RR_DOUBLES,
EXPENDABLE (default nobody).

## 9. Gotchas that cost hours

- zsh does not word-split `$var`: `for a in "switch 1"; ./oracle ... $a`
  passes one argument. Use `sh -c` or arrays.
- `emu:saveStateFile` and `VFileOpen(O_WRONLY|O_CREAT)` write zero files.
- `tell application "mGBA" to activate` can leave another app in front (and
  the Scripting window takes game keys after a script load); state loads go
  through `~/rr-agent/loadstate`.
- The agent's turn log is overwritten on restart: copy it into the run's turns
  dir before analysing.
- A quick decision (< 1 s) gets no oracle check by design.
- Party record ability = PID slot only; hidden abilities come from the battle
  struct byte (Pawmot = Iron Fist), which foeTeamFor now uses for the active.
