# Reading the game off the screen

Decided 2026-08-25, James's call, and the reasoning is worth keeping because it
is not "this is the best engineering". Three routes exist to knowing the true
battle state (see "The three routes" below); screen reading is the hardest of
them and the one he wants, because the result is the one that satisfies him and
because once it works he only has to play the game. That is a legitimate reason
and this file does not relitigate it.

**What it buys is not a convenience.** Every hard problem this project has left
is a consequence of not knowing the true state: the 24-question Surge line, the
near-tie fragility, min-loss, the whole robustness design. If the app can see
the board it never has to PREDICT twenty-four turns -- it re-plans one turn at a
time from a known position, and the search gets cheaper every turn as the fight
shrinks. It also makes the validation campaign free: every real AI choice gets
logged while James just plays, which is the dataset that calibrates the AI model
and finds the missing scoring rules.

## STORAGE POLICY (asked first, so answered first)

**Frames are never archived.** The loop is: capture to ONE scratch file,
extract a small event, discard the pixels. The scratch file is overwritten
several times a second and never grows.

    per frame     ~200 KB, overwritten in place, deleted at exit
    per turn      one JSONL line, a few hundred bytes
    per battle    a few KB
    whole run     kilobytes

The single exception is a **debug bucket**: when the reader sees a message box
it cannot classify, it keeps THAT frame so it can be labelled later, capped
(default 50 frames, oldest evicted). That is the mechanism that lets the reader
learn new strings instead of guessing, and it is bounded by construction.

## The environment, verified 2026-08-25 (do not re-derive)

    OpenEmu               running, mGBA core
    screencapture         /usr/sbin/screencapture, present
    python3               /usr/local/bin/python3, arm64 (python.org build)
    Pillow 12.1.0         present          numpy 1.26.4   present
    pyobjc / Quartz       NOT installed
    tesseract             NOT installed  -- and NOT needed, see below
    node                  v22.23.2
    Screen Recording      GRANTED and CONFIRMED WORKING 2026-08-25:
                          a full-screen capture returns 2880x1800 with real
                          content (mean pixel 190, not black). Note 2880x1800
                          is RETINA/physical pixels on a 1440x900 logical
                          screen, so everything downstream must work from the
                          captured image's own dimensions, never from logical
                          window coordinates.

**Use `/usr/local/bin/python3`, never the conda base.** `~/opt/anaconda3` is
Intel/Rosetta and Striim's build depends on its PATH ordering; leave it alone.

**Permissions.** `screencapture` needs Screen Recording (System Settings >
Privacy & Security > Screen Recording) for the terminal app, and the app must be
QUIT AND REOPENED after granting -- it does not take effect live. Without it the
command fails with `could not create image from display`. AppleScript window
geometry additionally needs Accessibility, which is why the design below avoids
AppleScript entirely and calibrates from pixels instead.

## The insight that makes this tractable: it is classification, not OCR

The instinct is "read the text on screen", which means OCR, which means
tesseract on a tiny bitmap font, which is miserable and unreliable.

**We never need to read arbitrary text.** At every moment we know the small set
of things the game could possibly be saying:

- the foe's move is one of **four**, and we know which four from trainer data
- the foe's species is one of at most six, known from trainer data
- our own moves and species are known exactly from the save
- the interesting events are a fixed vocabulary: a critical hit, a faint, a
  stat drop, a status, a berry, super/not very effective

So the job is to decide which of a handful of known strings is on screen, not to
transcribe an unknown one. That is template matching against candidates we can
enumerate, and it is far more accurate than OCR precisely because the candidate
set is tiny.

## What to read, easiest and most valuable first

**1. Our own HP -- exact, easy, high value.** The game prints our active
Pokemon's HP as digits at a fixed place in the status box. Ten digit templates,
fixed positions, exact number. This alone pins the damage we took, which is the
whole damage model checked every turn for free.

**2. The foe's HP -- to within a point or two, by inference. MEASURED 2026-08-25,
and the original claim here was wrong.** The game shows the foe only as a bar,
but we know its MAX HP from trainer data and our own damage roll is one of
sixteen discrete values, so intersecting the bar's filled width with those
sixteen candidates narrows it sharply.

This file used to claim the answer is "usually UNIQUE". `tools/hp_from_bar.js`
measures it over real trainer teams with the real party read off the save, using
the ROM's own bar model (`filled = floor(cur * 48 / max)`, never 0 while alive):

    party level 34 (now)      exact 57.5%    mean spread 0.49 HP    worst 2 HP
    foes up to level 60       exact 38.4%    mean spread 1.01 HP    worst 4 HP
    foes up to level 100      exact 25.3%    mean spread 1.46 HP    worst 6 HP

So exactness is a minority outcome and it DEGRADES over the game, because a
bigger HP pool makes each bar pixel worth more. The design survives anyway, for
a reason worth stating precisely: **the bar alone bounds the error to about
max/48 regardless of history**, so the foe's HP never drifts -- it is re-pinned
to a couple of points every single frame, and tracking error cannot accumulate.

And the imprecision is nearly invisible to decisions. Taking each end of the
interval and asking how many of our sixteen rolls kill:

    party level 34     72 of  8,617 decisions differ   0.84%
    up to level 100    86 of 112,307 decisions differ  0.08%
    worst disagreement 5 of 16 rolls

**The runtime rule this hands us:** compute the kill count at both ends of the
interval. If they agree -- over 99% of the time -- the uncertainty cannot change
what to do, so say nothing. If they differ, that is exactly and only when the
foe's HP is worth a question, and it is rare enough to afford asking. That is
the interaction contract from `DESIGN-UNCERTAINTY.md` falling out of a
measurement rather than a guess.

**3. Whose turn it is / turn boundaries.** The message box changing is the clock.

**4. The foe's move.** Match the message region against the four candidates,
rendered or captured. This is the one that needs the template work.

**5. Events.** Crit, faint, stat change, status, berry -- fixed strings, and
each one is a flag on the turn's event.

## Architecture

    capture      screencapture -x -R <viewport>  ->  one scratch PNG
    normalize    downscale to exactly 240x160 (GBA framebuffer), nearest
                 neighbour, because the image is integer-scaled pixel art
    extract      fixed-rect reads: HP digits, HP bars, message box
    classify     template match against the KNOWN candidate set for this fight
    emit         one JSONL event per turn
    advise       re-plan from the observed state, print the next move

Everything downstream of `normalize` works on a canonical 240x160 frame, so the
rest of the system is independent of window size, scaling and fullscreen.

## Calibration, done once per window geometry

No AppleScript, no Accessibility. Capture the full screen, then find the
emulator viewport by pixel evidence:

- the GBA framebuffer is 240x160, so the viewport is a rectangle of aspect 3:2
- it is usually an exact integer multiple (2x, 3x, 4x...) which makes the scan
  cheap and unambiguous
- letterboxing is a solid colour, so the content rect is found by trimming
- confirm by checking known invariants of a battle frame (the two status boxes
  and the message box are in fixed relative positions)

Store the resulting rect in `.checkpoints/screen-calib.json` and reuse it. A
re-calibration is one command and is needed only when the window moves or
resizes. The reader should DETECT a bad calibration (invariants fail) and say so
loudly rather than emit garbage.

## Turn segmentation

Battle text is a sequence of messages, not one string, and animations obscure
the screen mid-turn. So:

- sample at ~5 Hz (plenty; a message is on screen far longer than 200 ms)
- only trust a frame where the message box is STABLE across two samples
- a turn is the span between our move being selected and the box returning to
  the "what will X do" prompt
- collect every message seen in that span, in order; that is the turn's event
  list, and it naturally captures "it used X" + "a critical hit" + "Y fainted"

Set the in-game TEXT SPEED to FAST but not instant, and turn battle animations
OFF if that is available -- it makes messages the dominant thing on screen.

## Event schema (one JSONL line per turn)

    {"t":"turn","n":3,
     "me":{"species":"Victreebel","hp":85,"maxhp":108},
     "foe":{"species":"Vikavolt","hpFrac":0.61,"hp":63,"maxhp":104},
     "myMove":"Sludge","foeMove":"Mud Shot",
     "flags":["crit"],"confidence":{"foeMove":0.98,"myHP":1.0}}

`confidence` matters: a low-confidence classification must be surfaced, not
silently believed. A wrong reading is worse than a missing one, because the
advisor will plan on it.

## The advisor loop, which is the point of all this

    watch the event stream
    on each turn:
        rebuild the true state from the event (exact HP both sides)
        re-plan from THAT state
        print the single next action, plus this turn's risks

One-turn-ahead planning is cheap, exact, and it dissolves the fork problem:
nothing is ever predicted twenty-four turns out. What survives from the
robustness design is the ONE-TURN risk math -- this turn's crit exposure and
roll-decided KOs -- which is exactly `DESIGN-UNCERTAINTY.md`'s class 1, and it
stays valuable. Min-loss stays valuable too, for fights with no clean path.

## Build order, with a checkpoint at each step

1. **Capture + calibrate.** Prove we can get a clean 240x160 battle frame.
   Deliverable: `tools/screen/capture.py` writing a normalized frame, and a
   calibration file. Check: eyeball a saved frame once, then stop saving.
2. **Read our HP.** Digit templates from that frame. Check: matches what
   `read_save.js` says out of battle, and tracks correctly in battle.
3. **Read both HP bars.** Check: the inferred foe HP agrees with our own damage
   calc after a known hit.
4. **Turn segmentation.** Check: emits exactly one event per turn for a whole
   battle, no duplicates, no misses.
5. **Message classification.** Start with the fixed vocabulary (crit, faint),
   then foe moves against the known four. Check: run it over a battle James has
   already played and compare against his written notes.
6. **Live advisor.** Wire the event stream into re-planning.

Steps 1-4 are worth having even if 5 proves hard: HP plus turn boundaries alone
already lets the advisor re-plan with only the foe's move asked for, which cuts
the input burden to one word per turn.

## The three routes, recorded so the choice stays informed

    screen reading     no emulator internals, works with OpenEmu as-is,
                       hardest, chosen
    save-state parse   OpenEmu quick-save writes an mGBA state; the state
                       contains all 256 KB of work RAM at a known offset, so
                       one hotkey per turn gives EXACT everything. Much easier
                       than screen reading, much less satisfying.
    mGBA + Lua         mGBA standalone has a scripting API with direct memory
                       reads; a script streams battle state every frame, zero
                       input, zero inference. The end state on pure engineering
                       grounds. Requires leaving OpenEmu (the save file copies
                       across, same core).

If screen reading stalls on step 5, the honest fallback is to take the foe's
move as one typed word per turn and keep everything else automatic. That already
achieves most of the goal.

## Traps to expect

- **Retina scaling.** `screencapture` returns physical pixels; a "720x480"
  window may capture at 1440x960. Normalize by ratio, never by assuming.
- **The frame is mid-animation.** Require stability across two samples.
- **Occlusion.** The emulator window must be visible for a region capture.
- **A wrong calibration silently produces plausible garbage.** Assert the
  battle-frame invariants every frame and refuse to emit when they fail.
- **Do not trust a classification below threshold.** Emit `unknown`, keep the
  frame in the debug bucket, and ask.
