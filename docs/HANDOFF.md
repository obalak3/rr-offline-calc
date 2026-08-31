# Handoff -- 2026-08-31

Read this, then `docs/ULTRACODE-BRIEF.md` (what to investigate next), then
`docs/VALIDATION-LOG.md` and `docs/METHOD.md`. Domain facts -- both teams, why
Pawmot is the wall, the Baby-Doll Eyes plan -- are in memory as
`reference-rr-surge-domain`; read that FIRST, it is the thing that keeps having
to be re-explained. How to work with James is `feedback-rr-working-agreement`.

## THE MODE CHANGED ON 2026-08-31

Until now this was a Surge grinder: one save state, reloaded in a loop,
episodes measured as a rate. **James is now restarting the whole playthrough
and going fight by fight.** He drives the overworld; the agent plays the
battles he hands it.

That makes most historical rates unquotable, because they were all measured on
one fight with one team at one point in the game. Do not carry them forward.

### What is configured for that, and why

| File / var | Setting | Why |
|---|---|---|
| `~/rr-agent/load.txt` | **empty** | Non-empty means the Lua loads that save state when the script starts. This is what yanked the emulator into Surge on 08-31. |
| `~/rr-agent/restart` | **absent** | Present enables the episode loop: at the end of a battle it rotates `saves.txt` and reloads. That is the grinder, not a playthrough. |
| `~/rr-agent/pause` | present = stopped | The panel's STOP button. Both halves honour it. |
| `EXPENDABLE` | `""` (nobody) | Every death priced as forbidden. `Lilligant` was the Surge-specific cap. |

In the overworld the Lua presses NOTHING -- it has no map and no business
acting there. So the loop is: James walks into a fight, presses RESUME, the
agent plays it, he presses STOP.

## Starting it from cold

```
/Applications/mGBA.app/Contents/MacOS/mGBA ~/RadicalRed-mGBA/RadicalRed.gba &
# direct exec, NOT `open -a` -- that hits the Gatekeeper dialog
osascript -e 'tell application "System Events" to tell process "mGBA" to \
  click menu item "Scripting..." of menu 1 of menu bar item "Tools" of menu bar 1'
osascript -e 'tell application "System Events" to tell process "mGBA" to \
  click menu item "/Users/omerbalak/rr-offline-calc/tools/lua/bootstrap.lua" \
  of menu 1 of menu item "Load recent script" of menu 1 \
  of menu bar item "File" of menu bar 1'
cd ~/rr-offline-calc
EXPENDABLE="" node tools/agent.js >> ~/rr-agent/node.log 2>&1 &
node tools/control.js > ~/rr-agent/control.log 2>&1 &   # panel on :8420
```

Once the scripting window is open it OWNS the macOS menu bar -- its `File`
menu is `Load script... / Load recent script / Reset`, which is how you can
tell it focused. System Events cannot enumerate mGBA's windows; only menus
work. Do not screenshot the whole desktop to check (James's own work is on it).

## The control panel -- http://localhost:8420

Three controls, all file-backed under `~/rr-agent/` so nothing depends on the
panel being up. No panel means no pause file and no answer file, which is
exactly the pre-panel behaviour.

- **STOP / RESUME** (`pause`). Held before the answer is written, which is the
  only clean moment: the emulator is already sitting on the action menu. Both
  halves stand down -- the Lua checks every tenth frame and presses nothing, so
  you can take the controller mid-battle.
- **Who dies** (`ask.json` -> `choice.json`). When the priced line concedes one
  of ours, the agent posts one row per distinct casualty set and WAITS. The
  answer is stored as the accepted CASUALTY SET per opponent, not as a move and
  not as the shape of the question -- see the three design notes below. Times
  out at `RR_ASK_TIMEOUT` (default 300s) so a forgotten tab cannot freeze a run.
- **Your line** (`line.json` -> `line_result.json`, recorded to `lines.jsonl`).
  Type a line in speech form; `tools/lib/userline.js` parses it to jobs and
  `chooseAction({userLine})` INJECTS it into the market, so it can win outright.

Three things about the panel that were each learned the hard way:

1. **The sacrifice answer must be an outcome.** A stored ACTION replays a
   decision about a board that no longer exists; a key on the shape of the
   question re-asks halfway through the plan it just approved, because the
   option list shrinks as a sacrifice is carried out.
2. **Liveness must be a server-counted open event stream, never a browser
   poll.** Chrome throttles `setInterval` in background tabs to ~1/min, so the
   agent saw a stale heartbeat, decided nobody was watching, and went back to
   spending Pokemon unasked -- observed live at turn 3510.
3. **Closing the tab must release the question.** An open tab is evidence of
   intent to supervise, not a promise to be present.

### The line box is the fastest way to get evidence

It distinguishes three failures that look identical from outside and need
opposite fixes:

- **never proposed by the generator** -> a hole in candidate generation
- **proposed and priced above the winner** -> a disagreement about value
- **cheaper on the full criterion and still lost** -> the `FINALISTS = 4` cut
  threw the better line away (only the top four on immediate cost ever get
  their lookahead priced)

Live example against Vikavolt, `lanturn scald then mienshao drain punch`:
total 13.71, kills in 5 turns, loses Lanturn at 100% death risk, ranked 5 of 22
priced lines, generator had NOT proposed it, planner's own line cost 10.70.

## Read this before believing any number

Repeatedly the "biggest bug" turned out to be the MEASUREMENT, and correct code
was nearly patched to match a broken yardstick.

- **The log lied about planlessness.** The death veto in agent.js nulled
  `plannerSaid` when it overrode a plan, so the turn printed "no plan found".
  Overrides now print `PLAN (OVERRIDDEN by the death veto)`.
- **The dump-based score corpus is mispaired.** EWRAM dumps are taken 45 frames
  after we commit. Grade with `--score-live` (joins `ai_truth.tsv`, paired by
  construction). `--score-diff` is history only.
- **Pre-terrain archives rebuild with a phantom field**, inflating Electric
  moves 1.3x. `RR_LIVE_FIELD_ONLY=1` restricts grading to faithful turns.
- **`node.log` concatenates every run.** Slice to the last `agent: watching`
  before analysing, or you will compare two different battles.
- **An auditor that does not model `jobDone` leg-skipping** produces a false
  "19% of turns don't play their plan". The real figure was 91% following.
- **`tools/test_replan.js` never calls `buildState`** and cannot see live bugs;
  it reported 0/12 wipes while live play was fine. Offline is a crash check.

## The enemy AI is READ, not guessed

Thinking struct at `0x020003A4` (battle.h:480): scores +4, moveConsidered +2,
aiFlags +12 (reads 7), simulatedRNG +24. Verified 737/737 against the chosen
slot. Port accuracy 59% exact-score / 77% argmax on faithful positions.

- **Their arithmetic is theirs.** CanKnockOut/Can2HKO compute WITHOUT crits;
  feeding crit-inclusive damage into transcribed gates broke Roost badly.
- **The two scoring passes are independent.** A penalty and a bonus both apply
  to the same move; short-circuiting after either loses the other. Found three
  separate times. Suspect it first for any remaining gap.

Other facts that cost repeated wrong guesses: terrain timer at `0x020179BC`;
the turn archive is per-session (`turns/<ISO>/`) because a flat folder
OVERWROTE evidence as the Lua's counter wrapped; our six Pokemon's stats match
RAM exactly, do not re-derive them.

## Where it stood on the Surge fight

Last ten episodes before the mode change, all on `af8bb60+`: **10 wins**,
survivors 6/4/5/3/4/4/4/5/4/5 -- so one zero-death win and a median of two
deaths. Earlier builds produced several cap-meeting wins and four zero-death
wins. n is small and the build changed underneath most of it. **Re-derive per
build; never quote a rate across builds.** Column 4 of `results.tsv` is
SURVIVORS, not deaths -- misread once already.

## What is still wrong

See `docs/ULTRACODE-BRIEF.md` for the investigation agenda. In short, the four
root causes found and deliberately NOT fixed, because they are James's calls:

1. **Expendable is priced flat.** Every non-forbidden death costs the same, so
   Lilligant -- the answer to Pawmot -- gets spent on whatever is convenient.
   The panel is a manual guard over this, not a repair.
2. **The lookahead dominates and is crude.** ~3.2x the immediate term, prices
   each remaining opponent INDEPENDENTLY (so one healthy Pokemon is assumed to
   answer all of them), and returns a flat 8 when it finds nothing. Depth is
   MEASURED at 5; deeper played strictly worse. A graded-penalty arm was tried
   live and nearly wiped -- **the no-answer penalty must never price cheaper
   than killing**, and shrinking the lookahead removes load-bearing fear.
3. **Multi-move jobs replay move 0 forever**, because `P.newProgress()` is
   fresh each decision while `pricePath` carries progress.
4. **Plan churn.** 38% wholesale plan change; on 43% of changed turns the old
   plan was not even REGENERATED. The incumbent re-offer (eb2369c) addresses
   only part of it.

Plus the standing items: the death veto in `agent.js` is still an external
reflex over a priced market (fires ~10% of decisions); `deathRisk` trusts the
single committed foe move while entry damage hedges the whole plausible set;
chip/absorb legs are generated against a full-HP party so labels lie; the
Vikavolt Roost stall is safe, slow and unpriced; crits are not predictable from
the decision-time seed; mega evolution is unmodelled.

## How to work on this

Measure live. Reproduce an archived turn with
`node tools/agent.js --probe ~/rr-agent/turns/<session>/turnNNNNN.json`; note
the probe does NOT restore `turnsOut`, so entry-only moves can look legal when
live they were not -- that produced one confident and completely wrong
comparison. `RR_EXPLAIN=1` prints the whole market; `RR_EXPLAIN_GREP` filters
to a substring, which is how you ask "was this line even in the market".

The agent fingerprints its own sources and announces `STALE` once if they
change. Restart it after any edit.
