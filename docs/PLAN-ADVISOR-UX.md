# The advisor at the table: where advice appears, faints, and speed

Written 2026-08-25. Companion to `PLAN-SCREEN-READER.md`, which covers HOW the
app sees the game. This covers what that plan left open: where the advice
reaches James, what happens at faints, and how it coexists with playing sped up.

Two constraints from James, both hard, and they drive everything below:

- **No audio.** The app may not speak. Output must be visual.
- **No switching between the game and a website.** Advice has to be readable
  without leaving the game.

Those two together rule out both a spoken advisor and a browser tab. What is
left is a small always-on-top panel beside the emulator, which is what this
plan builds.

## 1. Where the advice appears: a pinned HUD next to the game

    +---------------------+   +------------------+
    |                     |   |  YOU  Mienshao   |
    |   mGBA  663x480     |   |       62/98      |
    |   windowed          |   |  FOE  Pawmot     |
    |                     |   |       ~41/121    |
    |                     |   |------------------|
    |                     |   |  > DRAIN PUNCH   |
    +---------------------+   |  kills 11/16     |
                              |  crit = you die  |
                              +------------------+

- **Tkinter**, which ships with the python.org 3.12 build already in use. One
  `Toplevel` with `-topmost 1`, no dependencies to install, no pyobjc.
- Positioned beside the mGBA window, not over it, so it never occludes the
  frame the reader is capturing. Both fit: mGBA is 663x480 and the screen is
  1440x900 logical.
- It shows, at all times: both HP values, the recommended action in large
  text, and this turn's risk in one line. Nothing scrolls, nothing needs
  clicking, and it is legible from a glance at the corner of the eye.
- The terminal stays a log for debugging. It is not the interface.

**This requires WINDOWED play.** That used to be a cost, because windowed play
was where OpenEmu's fast-forward was worst. It is not a cost any more: speed is
now a persistent setting rather than a key you hold (section 4), so windowed at
a fixed size is strictly better. Fixed size also means the screen reader's
calibration stays valid indefinitely.

## 2. Decision points, including the faint flows

The reader classifies SCREENS, not just messages. Four states drive everything,
each a cheap template check on the normalized 240x160 frame:

    action prompt      "What will X do?" box      -> show the move
    party screen       forced or voluntary switch -> show the send-in
    shift prompt       "Will you switch?" box     -> show stay/switch
    battle frame       status boxes present       -> keep tracking

**Normal turn.** Prompt appears; the advisor has already rebuilt state from
last turn's events and re-planned one turn deep (milliseconds); the HUD updates
before James has finished reading the message box.

**Our Pokemon faints.** Reader sees the faint, then the party screen. The
advisor picks a replacement by searching the bench (bench HP tracked from the
save read at battle start plus observed events) and the HUD shows "SEND IN
LANTURN". The Nuzlocke-aware heuristic stays correct for our side.

**Foe's Pokemon faints.** Two sub-cases, detected at the first foe faint, no
configuration:

- *Set mode:* the replacement just arrives. The reader classifies its species
  from the foe status box against the at-most-six candidates from trainer data
  and re-plans. Zero questions asked.
- *Shift mode:* the game names the replacement BEFORE our decision, so the
  reader classifies it and the HUD shows stay-or-switch while the prompt is up.

## 3. What the screen reader does to the switch-in problem

VALIDATION-LOG.md's headline deviation (we predicted Vikavolt, the game sent
Bellibolt, voiding the sheet from turn 4) came from `chooseReplacement` being
our own invented heuristic applied to the FOE, whose real logic
(`GetMostSuitableMonToSwitchInto`, never ported) we do not model.

The reader changes the class of the problem: **the foe's replacement stops
being a prediction and becomes an observation.** One-turn re-planning means
there is no long script for a wrong guess to void. Same for the AI's voluntary
switches (`ShouldSwitchToAvoidDeath`): we see them, we re-plan.

Where the unported logic still bites at one-turn depth: on a turn where we KO,
which move to KO with (or whether to pivot) depends on what comes in next. Fix
that needs no CFRU port: on KO turns evaluate our candidates against the
WORST CASE over the foe's remaining bench, which is fully known from trainer
data and is at most five mons. Cheap, and in the existing adversarial style.

The port is demoted, not cancelled. Every observed replacement gets logged
while James plays, which builds the test set for free. Port it when moving past
one-turn depth, with the Bellibolt position as test case one.

## 4. Speed: SOLVED, and the settings are verified

OpenEmu's fast forward is hold-only (a toggle has been requested for years and
never implemented: issues #4528, #4886, #1874) with open reports of the key
silently doing nothing (#4800, #4801), which matches the jank James hit. Not
fixable on our side.

**Now running in mGBA standalone (0.10.5), same core OpenEmu used, so the same
ROM and battery save.** Verified working 2026-08-25:

    always 3x, no keypress    fpsTarget=180 in config  (60 x 3)
    audio off                 mute=1, fastForwardMute=1
    toggle FF speed           fastForwardRatio=3
    survives restart          confirmed by cold relaunch: 180.5 fps

Config lives at **`~/.config/mgba/config.ini`** (NOT
`~/Library/Application Support/mGBA/`, which does not exist), and is written
only on a clean quit -- edit it with mGBA closed or the changes are lost.
Backup at `config.ini.bak-2026-08-25`.

Files: `~/RadicalRed-mGBA/RadicalRed.gba` and `RadicalRed.sav`, copies, so the
OpenEmu install is untouched. Save backed up to
`.checkpoints/live-run-backup-2026-08-25.sav`. **`~/RadicalRed.sav` still points
at the OpenEmu copy** -- re-point it at the mGBA copy before trusting
`tools/read_save.js`, and do that once, deliberately, so there is one live save.

Launch with `/Applications/mGBA.app/Contents/MacOS/mGBA <rom>` rather than
`open -a`: a direct exec skips the Gatekeeper "downloaded from the Internet"
dialog that blocks the app on launch. Terminal cannot clear the quarantine
attribute itself (no App Management permission).

The whole game now runs at 3x with nothing held down, which was the actual
requirement. A held key for unbounded speed on top of that is a nice-to-have,
not on the critical path, and is parked.

## 5. The measured constraint that 3x creates

Benchmarked 2026-08-25 on this machine:

    screencapture, full screen (2880x1800)   169 ms/frame    5.9 Hz
    screencapture, region 663x480             77 ms/frame   13.0 Hz

At 3x, a message that would sit on screen for a second at 1x sits for ~330 ms.
At 13 Hz that is about four frames, and the two-sample stability rule spends
two of them. It works, but the margin is thin, and it dictates the design:

- **Region capture is mandatory** for the loop. Full-screen capture is for
  calibration only; at 5.9 Hz it would see ~2 frames per message and miss
  things. This is now a requirement, not an optimisation.
- **Do not spawn one `screencapture` per frame if it can be helped.** 77 ms is
  mostly process startup. If step 1 proves too tight, the escape hatch is a
  single long-lived capture process rather than dropping to 1x.
- **The reader must detect that it is missing messages** (events inconsistent
  with HP deltas, or unstable frames dominating) and say so on the HUD, rather
  than emit a confident wrong reading. A wrong reading is worse than a gap
  because the advisor will plan on it.
- If it turns out to be genuinely too tight, the cheapest fix is a lower speed
  for advised battles only, since James said he can play important fights
  unsped. That is the fallback, not the plan.

## 6. Wiring

Two processes, one pipe, matching where the logic already lives:

    tools/screen/watch.py      capture loop, calibrate, classify screens,
                               read HP, emit JSONL events on stdout
    tools/advisor_live.js      consume events, hold battle state, re-plan one
                               turn deep (rr-plan/rr-battle), drive the HUD,
                               append to the validation log

Python owns pixels (Pillow + numpy on `/usr/local/bin/python3`, never the conda
base). Node owns the battle. The HUD is a third small Tk process fed by the
advisor over a pipe, so a HUD crash cannot take the reader down. JSONL schema
is the one in PLAN-SCREEN-READER.md.

**Sequencing trick that de-risks message classification:** the foe's move can
usually be INFERRED before it can be read. Our HP is exact (digits), so damage
taken is exact; intersect it with the 16-roll damage sets of the foe's four
known moves and the answer is often unique. So the advisor becomes useful with
only HP reading and screen classification working, and move-name templates
later confirm rather than carry. Where the intersection is ambiguous or empty
(a status move, an unmodelled effect), that is exactly when the HUD asks or
banks a debug frame.

## 7. Build order

0. **Emulator setup.** DONE. mGBA at 3x, muted, persistent, verified.
   Remaining: re-point `~/RadicalRed.sav`, set in-game text speed FAST, turn
   battle animations off if the hack allows.
1. **Capture + calibrate** (`tools/screen/capture.py`). Find the viewport from
   pixels, store the rect, prove a clean 240x160 frame. Checkpoint: one saved
   frame eyeballed, plus a measured sustained frame rate on the REGION.
2. **Screen-state classifier.** The four states from section 2. Checkpoint:
   prints the right state name throughout one real battle.
3. **HP reading.** Our digits exact; foe bar to 1/48 plus roll intersection.
   Checkpoint: agrees with `read_save.js` out of battle, tracks a known hit.
4. **Turn segmentation + JSONL.** Checkpoint: exactly one event per turn over a
   full battle, no duplicates, no misses.
5. **Advisor + HUD.** watch.py -> advisor_live.js -> Tk panel. Advice at action
   prompts and party screens, foe move by damage inference, low confidence
   shown as such. Checkpoint: James plays one gym battle start to finish
   without opening the calculator site.
6. **Message classification.** Crit, faint, status, berry, then move names
   against the four candidates. Closes the inference gaps.
7. **Later: port CFRU switch-in AI**, against the replacements logged by then.

Steps 0-5 are the product. 6 hardens it, 7 deepens it.
