# The line planner — implementation spec

Written 2026-08-26 night, immediately before a context clear, so that the next
session can start building without rediscovering anything. Everything below is
either MEASURED (a number and the tool that produced it) or JAMES'S DESIGN
(quoted). Nothing here is a guess presented as a fact; where something is a
guess it says so.

---

## 0. Why we are building this at all

The advisor now plays turns honestly and still loses Lt. Surge 6/6. The
diagnosis is no longer "the tactics are wrong" — those were fixed tonight
(assumePrediction + honest dice, see STATE.md). The failure is at the
ASSIGNMENT layer, and it is visible in one line:

> The advisor spends Victreebel — the only Pokemon on the team that OHKOs
> Pawmot — sweeping Pincurchin, which Breloom kills just as dead. By the time
> Pawmot actually arrives Victreebel is at 28 HP. Pawmot then beats the entire
> remaining team: Drain Punch heals it faster than we chip it, and it
> outspeeds all six.

A greedy turn ranker cannot see this, because on the turn it spends Victreebel
that move IS the best turn. The information it is missing is not about this
turn; it is that Victreebel is a scarce RESOURCE reserved for a foe that has
not appeared yet. That is a planning problem, not a search-depth problem, which
is why more MCTS budget never moved the win rate.

James's framing, which is the design:

> "It is not about matchups, it is about finding a line that can kill a
> pokemon."

> "The idea I have is like determining how we can defeat each pokemon
> individually. And you have a whole bunch of ways to beat it, prioritizing
> killing it while losing the least amount of hp %. Then we do that for every
> pokemon. Then we basically compare the damages for each line for different
> pokemon kills, and see whether the 20 damage gyarados took while killing x
> and the 40 damage it took to kill y kills it. This has to take into account
> switch in damages too somehow."

And the worked example of how he actually thinks, which is BACKWARD chaining:

> "When I calculate lines and there is a pokemon that is really hard to kill, I
> reverse engineer it. I say how do I kill Pawmot, and I see that I can hit it
> with Bulldoze with Diggersby (super effective and -speed), and then it is
> slowed down and I can kill it easier. Then I look at how do I bring in
> Diggersby without bringing it into death range. And I realize I have to
> either sleep it or sack a pokemon. That's where Lilligant dies."

---

## 1. The acceptance bar — do not move it

`tools/test_surge_cap.js`. James's exact words:

> "I am fine with AI losing pokemon. But I will give you a cap. Lilligant can
> die. No other pokemon on our side will die. I have beaten this boss like 3-4
> times with one pokemon dying, and easily. like don't even try to say anything
> he does makes sense until we get to that point."

Current: **0/6, CAP NOT MET.** That is the number to move. Not win rate, not
scoreboard fidelity, not node counts.

Second bar, his Gyarados variant — same Surge fight with Lilligant replaced by
Gyarados (level 34, Adamant, Intimidate, Aqua Fang / Ice Fang / Leer / Bite,
Sitrus Berry): "I can win that encounter 100% of the time 0 losses." So the
planner must find a ZERO-loss plan there. If it cannot, the planner is wrong,
not James.

---

## 2. What is already solved and must be USED, not rebuilt

**The opponent's next action is READABLE from a quicksave.** Verified 32/32.

    0x02000091  the AI's chosen TARGET   (mirror 0x020235C6)
                move turn   -> the MOVE SLOT it will use, 0..3
                switch turn -> the DESTINATION PARTY INDEX
    0x0200005B  action flag, 1 = switch, 0 = move (mirror 0x03000B81)

This changes the planner's uncertainty budget completely. At any turn James has
quicksaved, their action is not predicted, it is KNOWN. Caveat, honestly: all
32 labels came from Surge-side states; confirm on one other fight before
trusting it universally, the same discipline that validated the roll model.

**The dice are solved.** From the battle generator at `0x020386D0`
(mul 0x41C64E6D, add 12345):

    crit   = ((draw#3 >> 16) % 24) == 0
    roll   =  (draw#4 >> 16) % 16
    damage = floor(base * (100 - roll) / 100), base x1.5 on crit

256/256 on calibration, 4/4 holdout, 23/23 on a fresh run with different
species and levels. `tools/next_rolls.py` reads a quicksave and prints them.
So at a quicksave turn the planner can be told the exact damage it will deal
and take, not a distribution.

**Away from a quicksave**, both of those revert to models: the AI move
predictor is 75.5% exact-argmax (margin set 100% but 3.5 wide), and rolls are
a distribution. The planner must therefore be honest about WHICH regime each
step of a plan is in. See section 6.

---

## 3. Data model

### 3.1 A DUEL LINE
For an ordered pair (our Pokemon M, their Pokemon F), a line is a concrete way
M kills F. Fields:

    mon, foe
    moves[]            the actual sequence M clicks
    entry              precondition on M's state when it takes over vs F:
                         hpFrac >= x, or {fresh}, plus boosts/status required
    foeEntry           precondition on F: {healthy | asleep | slowed | chipped
                         to <= h | -1 atk from Intimidate | ...}
    cost               HP% M loses, MEDIAN roll for our damage dealt,
                       MAX roll for damage TAKEN (see 6.2 — this asymmetry is
                       mandatory and is the thing that killed Mienshao at
                       Brock T7 when it was symmetric)
    turns              how long it occupies
    products           what the line leaves behind for LATER duels:
                         persistent: status on F's teammates? no — status is
                           per-Pokemon, but chip damage, item removal
                           (Knock Off), entry hazards, weather/terrain turns,
                           and OUR remaining boosts persist
                         volatile:   OUR stat stages, which survive only until
                           WE switch; THEIR stat stages, which are laundered
                           the moment they switch
    risk               probability the line fails outright (crit, miss, freeze,
                       the 25% of turns the argmax predictor is wrong)

The volatile/persistent split is load-bearing and was learned the hard way:
their switching launders stat stages but never status, item removal, or chip.
So volatile investments (Leer stacks, Intimidate drops on a foe) are only worth
paying against a foe COMMITTED to staying in, and by section 2 we can often
read whether they are.

### 3.2 A TRANSITION COST
The handoff between duels is where the naive version of this idea breaks.
Whoever finishes F is the one who faces F's replacement's ENTRY. Price:
  - the free hit the incoming foe gets (or does not: if THEY switch, that turn
    is attack-free, see 4.3),
  - Intimidate / hazards / weather on entry,
  - the switch turn itself if WE rotate.

### 3.3 A BUDGET
Each of our Pokemon has HP% to spend. James's cap turns into constraints:
Lilligant budget = 100% (may die), everyone else's budget = 99% (may not).

---

## 4. Algorithm

### 4.1 Generate
For each (M, F) pair, enumerate duel lines. Do NOT do forward tree search here
— it failed at every budget tried, because the winning corridor looks locally
bad. Go BACKWARD from dead(F): find the move sets that reach lethal, then the
CONDITIONS that make them reach lethal (slowed, asleep, chipped, boosted), then
the ENABLERS of those conditions, bottoming out in facts about the current
state. Branching backward is tiny because the goals are few.
`tools/plan_fight.js` already has the vocabulary (beats / asleep / slowed /
fresh / free-entry-or-sacrifice) and the enabler tables. It currently only
LISTS matchups; the work is to make it emit priced lines.

### 4.2 Combine
Choose one line per enemy Pokemon plus an ORDER, subject to: every M's summed
costs (duel costs + transitions it eats) stay inside its budget. This is a
small assignment problem — 5-6 foes, 6 of ours, a handful of lines each — so
solve it exactly by branch-and-bound, not heuristically. Two properties we get
for free and should exploit:
  - **Infeasibility is informative.** If no assignment fits, the fight is
    flagged unwinnable-as-teamed BEFORE turn 1. That is also the
    team-composition helper James will want later.
  - **The scarce-resource bug disappears by construction.** Victreebel is
    ASSIGNED to Pawmot, so nothing may spend it on Pincurchin.

### 4.3 Their switching does not break the plan
James's insight, and it is the reason this is tractable:

> "what if whenever we basically see that an enemy is switching we switch with
> it"

Store the result as a POLICY TABLE keyed on their active Pokemon, not as a
sequence of turns. Then their switching controls only the ORDER in which the
duels happen, never whether the plan is valid. And double-switch turns are
attack-free, so a predicted switch of theirs is FREE repositioning for us.
Combined with section 2, at quicksave turns we KNOW the switch is coming and to
which slot.

The only real failure mode left is: no feasible assignment exists. Checkable
offline, before the fight.

### 4.4 Verify
Every candidate plan gets ~20 real-dice rollouts before it is believed. This is
not optional — the entire honest-dice reckoning happened because plans that
looked good under median rolls died under real ones.

### 4.5 Execute
Turn-level play stays the current assumePrediction ranker, but CONSTRAINED:
assigned roles are reserved (you may not spend Victreebel on Pincurchin), and
the ranker scores PROGRESS TOWARD THE CURRENT SUBGOAL rather than raw material.
Replan when a rollout-invalidating surprise happens (a crit, a miss, a foe move
outside the margin set), not every turn.

---

## 5. Build order (each step ends in a number, not a feeling)

1. `duelLines(M, F, entryState)` in a new `tools/lib/duels.js`, emitting priced
   lines with the median/max asymmetry. TEST: hand-check Victreebel vs Pawmot
   (should be a 1-turn 0-cost-ish OHKO line) and Diggersby vs Pawmot (should
   need slowed(Pawmot) and cost real HP).
2. Transition pricing. TEST: the Pincurchin -> Bellibolt handoff we have 6/6
   real observations of.
3. Branch-and-bound assignment + feasibility report on SURGE. TEST: does a
   feasible plan exist under James's cap? If yes, print it line by line — he
   has asked for full lines repeatedly and will ask again: "I am asking for the
   full line and you aren't giving it to me. Give me the full line. Line by
   line."
4. Rollout verification of the chosen plan, 20 real-dice runs.
5. Constrain the executor and re-run `tools/test_surge_cap.js`. THE NUMBER.
6. Only then: the Gyarados variant, expecting 0 losses.

---

## 6. Traps that have already cost days on this project

**6.1 Do not re-run refuted experiments.** Measured and dead, keep them dead:
step-4 trueDistribution (loses fights), tradeRank (no better), exactRoot (0/15),
MCTS scaling (does not move wins), the switch-cache explanation (13%, worse
than at-faint's 30%), the absorb-ability hypothesis (Pawmot is Iron Fist,
measured), "only bad moves left", type/ability data errors.

**6.2 The dice asymmetry.** Our kills at MEDIAN roll, our deaths at MAX roll.
Half of this shipped tonight (median for kills); the max-roll fear side is
STILL TODO and is the same class of bug in the opposite direction. Brock T7:
Force Palm rolls 18-24 into a 24-HP Onix; max-roll accounting called a 1-in-16
kill certain, concluded Onix never attacks, and Mienshao died on the 15-in-16.

**6.3 Three samples cannot test a slot hypothesis.** I concluded the AI decides
after the player commits, from three hand probes. James said "I bet it is
somewhere there. It might be something relating to the order of the moves. A
bit might point to the first slot" and he was right — the powered 32-label
dataset found it immediately. Build the harness, then conclude.

**6.4 Verify addresses by measurement, never by guess.** `0x02023BCE` for the
action cursor was wrong by ~1KB; the real one is `0x02023FF8`. Use a full-RAM
diff WITH A CONTROL condition (a no-key run, subtracted), and for multi-step
cursors the two-press constant-stride test. A window built around a guess can
only ever confirm the guess.

**6.5 Quit mGBA between Lua script loads.** Script loads STACK; closing the
Scripting window does not unload. Two copies fight over the emulator.

**6.6 Do not make James debug through six script loads.** His words: "You are
making me do too much unnecessary stuff." Batch the instrumentation.

**6.7 Present full lines, not summaries.** Repeated feedback, three times.

---

## 7. Loose ends, honestly listed

- Validate `0x02000091` / `0x0200005B` on a NON-Surge fight.
- Re-verify the ss3/ss4 hand labels; they record first-DETECTED action and are
  believed wrong, but that is not verified.
- `next_rolls.py` should print the full pre-click sheet: action + target + crit
  + roll, in one output.
- Wire the decision byte into the advisor to replace the model guess at
  quicksave turns.
- `tools/lua/label_decisions.lua` bounces ~10x when the target slot is already
  active. Harmless, slow. Fix = skip ahead when active did not change.
- `showline.js` blames the start-of-turn Pokemon when a switch-in dies.
- Pending long-uptime job: `caffeinate -i node tools/rerun_surge.js 60 2400`.
