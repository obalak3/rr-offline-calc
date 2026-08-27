# The live run: every battle advised, every prediction checked

Started 2026-08-25. James is playing a fresh Radical Red run and the advisor
calls every battle BEFORE it is played. This is the experiment the project has
needed from the start: every number in TUNING.md is the engine agreeing with
itself, and this log is the only place where it meets the actual game.

## What gets recorded per battle

    battle          which fight, and the advisor's verdict + engine
                    (certified / line-found / no-clean-line / undecided-guess)
    forks flagged   what check_forks predicted could break the script
    what happened   the AI's actual moves vs predicted, turn by turn
    deviations      turn, predicted, actual -- and whether the plan HELD anyway
    outcome         result, losses, and whether any flagged fork/crit actually bit

## What we are testing

1. **Prediction accuracy.** RRAI's per-turn argmax against the real AI. The
   only prior data point is one Surge attempt: turns 1-2 matched, turn 3
   deviated on a near-tie (and a replay got the predicted move twice, so that
   was a tie, not a missing rule).
2. **The fork check's relevance.** check_forks flags turns where an in-margin
   move breaks the script. If real deviations land on flagged turns and spare
   the unflagged ones, the check earns its place as the core of the planned
   policy artifact. If deviations land where it flagged nothing, the margin of
   3 is wrong or the model is missing rules.
3. **Repeatable deviations.** A deviation that repeats on replay from a save is
   a missing AI rule worth porting. One that varies is a tie, already handled.

## Ground rules

- Save state before each advised battle, so deviations can be replayed.
- Read the team from the save (`node tools/read_save.js`), never from memory.
- The old run is backed up twice: `.checkpoints/surge-run-backup-2026-08-25.sav`
  and `~/Documents/surge-run-backup-2026-08-25.sav`.
- Difficulty and mode matter: the AI model's flags depend on difficulty, and
  Restricted mode changes what the player may legally have. Record the new
  run's settings here when chosen, and keep them fixed.

## Run settings

    Same rules as the previous run (Restricted / Minimal Grinding), same
    difficulty, and the same starter. Confirmed from the save when the first
    battle is read rather than from memory.

## Battles

    (one entry per battle, newest last)

---

## Old save, GYM LEADER LT. SURGE — the searched win-losing-2

The first line for this fight that is a searched result rather than a guess.
`cleanWin` with `lossBudget: 2`, 4,514,755 nodes, 194s. Clean (k=0) is undecided
at 84M nodes and k=1 undecided at 4M, so the bracket is "costs at most 2".

    you   Mienshao L34, Diggersby L34, Lanturn L34, Lilligant L34, Breloom L34, Victreebel L34
    them  Pincurchin L32, Vikavolt L33, Bellibolt L33, Pawmot L33, Manectric-Mega L34

      #   YOU          DO                    THEY            THEY DO           your HP   lost
      ------------------------------------------------------------------------------------------
       1  Mienshao     switch to Lanturn     Pincurchin      Discharge         139/139
       2  Lanturn      switch to Victreebel  Pincurchin      Scald              90/108
       3  Victreebel   Leaf Storm            Pincurchin      Hidden Power Ice   90/108
       4  Victreebel   Sludge                Vikavolt        Bug Buzz           53/108
       5  Victreebel   Sludge                Vikavolt        Bug Buzz          139/139   << LOST
       6  Lanturn      Scald                 Vikavolt        Bug Buzz           76/139
       7  Lanturn      Scald                 Vikavolt        Bug Buzz           76/139
       8  Lanturn      Scald                 Bellibolt       Hidden Power Gras  66/139
       9  Lanturn      Scald                 Bellibolt       Hidden Power Gras  22/139
      10  Lanturn      Scald                 Bellibolt       Hidden Power Gras 102/102   << LOST
      11  Lilligant    Mega Drain            Bellibolt       Parabolic Charge  102/102
      12  Lilligant    Mega Drain            Manectric-Mega  Flame Burst        79/102
      13  Lilligant    switch to Diggersby   Manectric-Mega  Flame Burst        80/112
      14  Diggersby    Bulldoze              Manectric-Mega  Hidden Power Gras  54/112
      15  Diggersby    switch to Mienshao    Manectric-Mega  Hidden Power Gras  65/98
      16  Mienshao     switch to Lilligant   Manectric-Mega  Volt Switch        48/102
      17  Lilligant    Baby-Doll Eyes        Pawmot          Drain Punch         9/102
      18  Lilligant    switch to Breloom     Pawmot          Drain Punch        58/95
      19  Breloom      switch to Mienshao    Pawmot          Ice Punch          67/98
      20  Mienshao     Drain Punch           Pawmot          Thunder Punch      62/98
      21  Mienshao     Drain Punch           Pawmot          Thunder Punch      33/98
      22  Mienshao     switch to Breloom     Manectric-Mega  Charge Beam        54/95
      23  Breloom      Mach Punch            Manectric-Mega  Flame Burst        54/95

HP is the ACTIVE Pokemon after the turn, so a jump to a full bar is the
replacement arriving -- which is what marks the losses. Victreebel dies turn 5,
Lanturn turn 10. Turn 17 is the dangerous one: Lilligant at 9/102.

### DEVIATION OBSERVED (James, from play): the wrong Pokemon comes in

**After Victreebel killed Pincurchin the game sent BELLIBOLT. We predict
VIKAVOLT.** Everything from turn 4 onward assumes Vikavolt, so the line is void
from that point.

This is a DIFFERENT AND MORE SERIOUS CLASS than the Mud Shot near-tie. Choosing
a replacement after a faint is a separate decision from choosing a move, it
happens after every faint (several times a fight), and it is not the kind of
thing that should be a coin flip.

**Root cause found, and it is not subtle.** `chooseReplacement` in
`rr-battle.js` is OUR OWN heuristic, applied to BOTH sides:

    score = (curHP - worst incoming hit) * 2 + our best hit

with a comment reading "Room to survive matters more than damage: this is a
Nuzlocke." That is sound reasoning for OUR side and simply wrong for the
opponent, who is not playing a Nuzlocke and who has real switch-in logic in
CFRU that has never been ported. So the opponent's replacement choice is
invented, not modelled.

**Why this is worth fixing before any move-scoring rule.** It is almost
certainly deterministic (so repeatable and testable), it fires several times per
battle, and getting it wrong invalidates an entire plan from that point --
unlike a move near-tie, which usually costs a few HP. It also means our
predictions were always going to break at the first faint, which is most of why
the Surge sheets have been so fragile in play.

**Next step when picked up:** port CFRU's switch-in selection (the party-menu /
`GetMostSuitableMonToSwitchInto` logic in `ai_master.c` and friends), keep the
Nuzlocke heuristic for OUR side only, and re-check against this exact position:
Pincurchin down to Leaf Storm, does the model send Bellibolt?

---

## OPEN REGRESSION: lossBudget 2 on Surge is no longer found (2026-08-25)

Re-ran the loss ladder on the real-team Lt. Surge fight after today's changes
(terrain no longer permanent, switch-in port). 30M node budget, 1200s per rung:

    clean          undecided at 20.3M nodes
    lossBudget 1   undecided at 20.8M nodes
    lossBudget 2   undecided at 21.4M nodes

**The third rung is a real regression.** It was previously FOUND at 4,514,755
nodes in 194s (line 56 above). It is now unfound at 21.4M, nearly five times the
budget. That is too large a gap to be the variance of a randomised restart
search, unlike an earlier scare today which turned out to be measured against a
misremembered baseline.

Two hypotheses tested and BOTH REJECTED, recorded so they are not retried:

1. *The switch-in port is slow.* It costs throughput, but fixing its worst
   offender (a per-candidate `toCalcPokemon`) took the port from 37us to 24.7us
   and moved whole-search throughput by 1.6%. Not the cause.
2. *The live terrain counter inflates the memo.* `positionKey` includes
   `terrainTurns`, which used to be the constant `Infinity` and now counts down
   5,4,3,2,1,0, so the same board at different points in the terrain clock is
   several keys instead of one. Plausible, and measured: distinct keys over the
   same slice of tree, counter live vs pinned, came out 1744 vs 1736. **1.00x.**
   Not the cause either.

So the cause is unknown. What is NOT yet ruled out: the switch-in port changes
which positions exist at all (both sides' replacements differ), so the tree is
genuinely a different tree rather than the same one searched more slowly, and a
line that existed against our invented replacement heuristic may simply not
exist against the real algorithm. That would make this a corrected result rather
than a regression, and it is the first thing to check.

Cheapest next probe: re-run lossBudget 2 with the port disabled via
`RR_DISABLE_SWITCH_PORT`, at a budget past 4.51M. If it is found there and not
with the port, the old line depended on the wrong opponent model.

## Mirror benchmark after today's changes (2026-08-25)

`bench_mirror.js --all`, the only benchmark here whose numbers compare across
time: both sides bring the trainer's own team, so it uses fixed trainer data
rather than the generator, and it controls for team quality.

                      historical      now
    clean wins           125          121 / 139
    undecided             11           16 / 139
    no line exists         -            2
    lost outright          -            3

Four clean wins down, five more undecided. Small, but it points the same way as
the Surge lossBudget-2 regression rather than against it.

**The important detail: this is a NODE budget, not a time budget** (200,001
nodes per fight). So the switch-in port's ~25% throughput cost cannot explain
it. Finding fewer lines with the same number of nodes means the TREE CHANGED,
not that the search got slower.

That is now the same conclusion from two independent measurements, and it
supports the leading hypothesis for the Surge regression: the switch-in port
changes which positions exist, on BOTH sides in a mirror, so lines that existed
against our invented replacement heuristic need not exist against the real
algorithm. If the port is faithful, these are corrected results rather than
regressions -- the earlier numbers were measured against an opponent that does
not exist.

That is a claim to test, not to assume. The probe is unchanged and cheap: re-run
with `RR_DISABLE_SWITCH_PORT` set and see whether the old numbers come back.

## RESOLVED: the "regressions" were corrections (2026-08-25)

`tools/probe_port_regression.js`, same fight, same rung, same budget:

    switch port OFF (our old invented heuristic)   FOUND, 23 turns, 8.1M nodes
    switch port ON  (ported CFRU algorithm)        undecided at 9.8M nodes

The 23-turn lossBudget-2 line is findable against the replacement model we
INVENTED, and not against the real one. So neither this nor the mirror drop
(125 -> 121 clean) is a regression. **The older, better-looking numbers were
measured against an opponent that does not exist.** Every result in this repo
predating the switch-in port shares that flaw, including the historical
4,514,755-node figure quoted above and every mirror number.

Strictly, "undecided" is not proof the line is gone -- it is proof we did not
find it in 9.8M nodes. But finding it at 8.1M with the port off and missing it
at 9.8M with the port on is a strong contrast, and it is the same story the
mirror tells at a fixed NODE budget where throughput cannot be the cause.

Two hypotheses were tested and rejected before this one, recorded above so they
are not retried: the port being slow (fixing its worst cost moved whole-search
throughput 1.6%) and the live terrain counter inflating the memo key (measured
at exactly 1.00x).

**Consequence worth stating plainly: the fights got harder because the opponent
got real.** Comparisons across the port boundary are meaningless, and a new
baseline has to be taken from here rather than measured against history.

## 2026-08-27 — live calibration run, overnight

Measured by the live agent (`tools/agent.js` + `tools/lua/agent_impl.lua`) over
231 resolved turns across five save states.

### The opponent predictor

54 turns where the opponent genuinely used a move, its identity recovered from
its PP rather than assumed:

    decision byte 0x02000091     0/54
    ported AI model             41/54   (76%)

76% lands on the 75.5% the offline scoreboard measured over 102 recorded
decisions — an independent confirmation, from live play against different
trainers, of a number that until now rested on one fixture. The byte is dead off
Surge: it claimed a SWITCH on essentially every turn. Its 32/32 validation was
real but narrow, drawn entirely from Surge-side states.

The model scored 54% while it was allowed to predict switching to bench Pokemon
that do not exist (their bench is placeholders, since we cannot see it) and 76%
once restricted to moves.

### The damage bands

19 distinct damage observations, ours and theirs, matched against the 16-value
band predicted before the turn:

    exactly on a band value             8  (42%)
    inside the range, between values    3  (16%)
    OUTSIDE the range                   8  (42%)

A band contains the true damage 58% of the time. Four misses are the Hidden
Power type error (a set rebuilt from RAM sees one move ID whose type comes from
IVs; fixed by looking the species up in the trainer data). Two remain unexplained:
Lanturn's Scald landing 2-12% above its own band maximum, which no roll can
produce, and Shroomish's Headbutt at 3.83x, too large for anything but the wrong
defender.

### The RNG draw order — NEGATIVE

No draw position within 64 of the action-menu seed is consistent with every
distinct observation. A FIXED offset is refuted, not merely unconfirmed.

The 256/256 offline validation on isolated attacks stands. What does not hold is
advancing a seed captured at DECISION time to locate the damage roll during a
live turn, because a turn consumes a varying number of draws that is not modelled.

The blocker is not runtime. Distinct observations have been stuck at three while
rows went 47 -> 147, because save-state replays are byte-identical and because
identifying a roll requires a band that contains the damage — see above.
NEXT: read the seed at the moment of the damage calculation from a quicksave,
rather than trying to advance to it from decision time.

### 2026-08-27 correction — live fidelity is 56%, not 76%

I quoted 41/54 = 76% repeatedly and said it independently confirmed the offline
scoreboard's 75.5%. Pooling every round of the calibration log — **151
move-turns with exact ground truth** — the ported model is **84/151 = 56%**. The
76% was a favourable subset and that confirmation claim does not hold.

The per-trainer AI flags hypothesis, proposed in the same breath, also fails:

    gym leader team (Surge)   37/65  (57%)
    route trainers            47/86  (55%)

No meaningful difference, so modelling every opponent with a gym leader's flags
is not what costs the accuracy.

What this changes:

- The offline scoreboard measured 75.5% on 102 curated Surge decisions. Live
  play across five save states says 56%. The fixture is easier than the real
  distribution of positions, so it flatters the model and should not be the
  number planning rests on.
- `assumePrediction` is on weaker ground than claimed. Committing to a single
  predicted action is a different proposition at 56% than at 76% — it is wrong
  nearly half the time. The margin set (100% membership, ~3.5 actions wide)
  matters more than I have been treating it, not less.

Also measured: the decision byte read 45 frames after commit is EXACT (21/21).
At 100 frames it is 19/21, because the value moves on to the next decision.
Forty-five frames is the window.

## 2026-08-27 -- switching, finally measured end to end

Switches landed on the intended Pokemon **17 / 17** (previously 3 / 126, then
0 / 23). Three separate bugs, each of which alone was enough to break it:

1. **The party screen is a two-column grid and DOWN only walks one column.**
   Logged live, the cursor byte cycled `0 -> 2 -> 4 -> 7 -> 0`: the left column
   and then Cancel. Every odd slot -- the whole right column -- was unreachable,
   so a switch to one of them could never happen however long it pressed.
2. **Screen ids were being used to decide the switch had committed.** Id 9 was
   read as the submenu when it is the list, so the agent confirmed on whoever
   was highlighted, which is the active, and the game answered "already in
   battle". The flow no longer consults screen ids at all; the active Pokemon
   changing is the only evidence accepted.
3. **The party is renumbered mid-fight.** A Pokemon coming in is swapped toward
   slot 0, seen directly as the 98 and the 102 trading RAM slots between two
   consecutive reads. An index computed by the planner could therefore name
   somebody else by the time A was pressed.

**Display position equals the RAM slot.** Measured by logging the six max HP
values in the *same tick* as the screenshot, each being a unique fingerprint:
screen showed 112, 139, 98, 102, 95, 108 down the two columns and RAM held
`0:112 1:139 2:98 3:102 4:95 5:108`. Identity, nothing swapped.

Four different mappings were derived before this, each by holding a screenshot
next to a RAM read taken moments apart, and they contradicted each other
because the thing being measured moves between those moments. **Two
observations of a changing system have to come from the same instant to be
compared at all.** That is the transferable lesson here, not the mapping.

The fix that makes it robust rather than merely correct: the command now
carries the target's **max HP and level as a fingerprint**, and the actuator
resolves it against live gPlayerParty at the moment of the press instead of
trusting the index. Staleness is now visible in the log rather than silent
("slot 3 is stale, 102 max HP is really in slot 0").

Open, and now the largest gap: **39% of decisions get no plan at all**
(54 PLAN vs 35 "no plan found" over 400 logged decisions) and fall back to
one-turn scoring, which is the greedy behaviour the planner was built to
replace.

## 2026-08-27 -- the target was met once, and why the agent kept switching

**WIN over Surge (ss5) losing nobody but Lilligant**, recorded live:
`61/98 112/112 15/139 0/102 95/95 6/108` against their side wiped. One of
three wins so far; the other two cost three and two Pokemon. So the cap is
reachable by this agent, not yet reliably.

Outcomes are now recorded at all (`~/rr-agent/results.tsv`). 239 fights had
been played without recording a single result, so "is it any good" had no
answer and changes were judged on whether individual clicks looked sensible.

**The switching was a missing tempo cost, diagnosed by James.** 69 of 120
decisions were switches, one run 41 deep. Followed offline, the planner
ping-ponged Lanturn and Lilligant for twelve consecutive turns while Pincurchin
stood untouched at 95 HP. The engine was fine -- a switch does take the hit on
the ARRIVING Pokemon, measured at 69 damage to Lanturn -- but the planner's
only currency was HP, and **Lanturn has Volt Absorb, so switching it into an
Electric move costs zero HP and was therefore free**. Nothing charged for the
turn itself.

Pricing a turn fixes it, and the value was swept by playing the whole fight out
at each setting rather than chosen by taste:

| tempo | result | casualties |
|-------|--------|------------|
| 0     | WIPED, 3 of theirs still standing | all six |
| 0.12  | won | Diggersby, Breloom |
| 0.25  | won | Diggersby, Breloom |
| 0.4   | won | Lanturn, Lilligant |
| 0.9   | won | Lanturn, Lilligant |
| 1.3   | WIPED | all six |

0.4 is now the default: one forbidden death instead of two. Judged against the
cap, not against the score.

**Pivoting is no longer treated as failure.** Requiring every line to end in a
kill discarded 39 of Vikavolt's 48 lines, because its set is Volt Switch / Bug
Buzz / Roost / Mud Shot and it leaves on its own. The planner reported no plan
and fell through to greedy scoring on one of the two hardest members of the
team. Vikavolt has gone from 8 no-plan / 0 plan to 0 / 2 in live play.

**Open, and now the whole of the no-plan problem: Pawmot.** Every remaining
"no plan found" is a Pawmot position (7+6+6+5+3 across five of ours). The
killing lines against it want Lilligant's Baby-Doll Eyes or Sleep Powder, and
Lilligant is the Pokemon the cap allows us to spend -- so by the time Pawmot is
out, the answer to it is often already dead. Lines that do not need Lilligant
exist but kill Mienshao. This is an ordering problem across the whole fight,
which is what the lookahead is for.

## 2026-08-27 -- Fake Out could not work in the simulation at all

James: "Forcing fake out never makes you lose. YOU did something wrong." He was
right twice over.

**My rule was broken.** It keyed the entry turn off `turnsOut === 0`, but
`B.createState` sets `turnsOut` to 0 for EVERY member, so in any state we build
-- live or inside the planner -- the active reads as having just arrived and the
rule fired on every single turn. That is what turned a won sweep into a wipe.

**And the engine was wrong underneath it.** `turnsOut` was incremented at the
end of every turn INCLUDING the one a Pokemon switched in on. Switch Mienshao in
on turn N, end of turn N takes it to 1, and its first action on turn N+1 is
refused as "not on the way in". Since Fake Out works on the first turn AFTER the
user enters, **the switch-in Fake Out -- the entire point of the move -- was
impossible to simulate**. The planner had been correctly refusing a move it had
been told does nothing, which is why it opened with Rock Tomb 14 times out of 16.

Fixed by not counting the arrival turn (`enteredThisTurn`). Verified three ways:
a pivoting Mienshao now flinches on its first action, the turn after correctly
fails, and a LEAD still flinches on turn 1 (no regression).

Effect on the whole fight, at the measured settings (depth 5):

| | before | after |
|---|---|---|
| tempo 0.4 casualties | Lanturn, Lilligant | **Lanturn only** |
| turns | 60 | 42 |
| turns with no plan | 32 | 14 |

Forcing the move is now indistinguishable from letting the search choose it, so
the override stays off (ENTRY_MOVE=1 to re-measure).

**The lesson is the one James applied**: a result that is impossible on domain
grounds -- "forcing a free flinch cannot lose you the game" -- is evidence of a
bug in the measurement, not a surprising discovery about the game. I had taken
the sweep at face value and written the finding up as real.

Still open: Lanturn dies, which the cap forbids; and the live predictor answers
"they will: none" against Pawmot while the same call offline returns Thunder
Punch, so plans there are built against an opponent that does nothing.

## 2026-08-27 (later) -- what the live log says, and two method failures

**Predictor tie-break.** Our AI port scores by category, not magnitude: a move
that KOs gets a flat +9 and how far past lethal it goes never enters the score.
Against a Victreebel that both moves kill, Thunder Punch (39 damage) and Ice
Punch (80) both scored 109 and we answered the weaker one, every time, while the
game used Ice Punch. Ties now break on damage. Accuracy on Pawmot since turn
2600: 31% -> 47%.

**Planned turns were predicting nothing at all.** The planner branch built its
decision with `all: []` and `theirs: null`, so on every planned turn the log read
"they will: none" and "expecting to deal 0 and take 0". The plan was being
computed against an opponent that does nothing, which is how Lilligant walked
into Mach Punch: probing that exact position, the one-turn scoring ranked every
move at -61.39 because Lilligant dies and switching at -2.45. It knew. Nobody
asked it.

**Plan shapes, measured on 200 live plans**: 194 two-leg, 6 solo duels. Every
family in candidates.js ends with one designated Pokemon duelling the foe to
death. James: "there is almost never a killing line. There is a multiple moves
doing chip damage which ends up killing line." The generator cannot express that.
This is the outstanding piece of work.

### Two method failures worth keeping

1. **I took an impossible result at face value.** Forcing Fake Out turned a won
   sweep into a total wipe and I wrote that up as a finding. James: "Forcing fake
   out never makes you lose. YOU did something wrong." He was right -- the rule
   keyed off `turnsOut === 0`, which `B.createState` sets for EVERY member, so it
   fired on every turn. A result that is impossible on domain grounds is evidence
   the measurement is broken.

2. **I substituted a convenient reproduction for the reported observation.**
   James said twice that Victreebel was healthy (108 HP) at the start of the
   Pawmot encounter. I kept analysing it at 29 HP because that was the position I
   had already reproduced, and drew conclusions from it. When the probe was
   finally run at 97/108 it ranked Leaf Storm 5.46 above every switch and
   predicted Ice Punch correctly -- the opposite of what I had been claiming.

## 2026-08-27 (evening) -- the record was counting one trajectory seven times, and Bellibolt's EVs were wrong

**The "Mienshao + Lilligant in 7 of 11" distribution is mostly one repeated
trajectory.** Seven consecutive results.tsv rows (1787858051..1787860347, ~250s
apart) end with the byte-identical HP vector `0/98 112/112 82/139 0/102 95/95
62/108`: the reload loop replaying a near-deterministic fight. The conclusion
survives -- the modal trajectory kills Mienshao -- but it is ~5 distinct
outcomes, not 11 samples, and rows from different code versions were
indistinguishable. Fixed: agent.js writes the git hash to version.txt at
startup and the Lua appends it as an 8th column on every result row. Given the
determinism, 2-3 replays per change is enough; the loop was stopped until the
chip-plan work lands.

**The newest, worst row (1787863024, only Mienshao alive at 26/98) is not
attributable.** Turns 2796-2843 of that fight are missing from the archive and
there is a 34-minute silence before it (15:52 to 16:26), consistent with a
stall or manual play rather than a visible crit fork. Ask James whether he
touched the emulator around 16:00 rather than digging further.

**Bellibolt: the sheet's 100 HP EVs are wrong; the game uses zero.** Computed
max HP was 133 against a RAM ground truth of 125, and the 8 HP gap is exactly
what 100 HP EVs contribute at L33. With zero EVs the ENTIRE stat line
reproduces: HP 125 and [atk,def,spe,spa,spd] = [51,82,44,82,70] (turn02851,
GBA stat order). All five Surge opponents now compute RAM-exact. Fixed as a
RAM-verified corrections table consulted by `foeSets` in harness.js, keyed by
trainer label + species so a regenerated data file keeps the fix.

The handoff's companion claim "Pincurchin 99/95" did not reproduce: Pincurchin
computes 95, which IS the RAM value; the 99 is Pawmot's max HP. One mon was
wrong, not two.

**Likely collateral resolution**: Lanturn's Scald landing 2-12% above its own
band maximum, one of the two unexplained band misses above. If the foe's HP
bar was converted to hit points using max 133 instead of 125, every observed
damage against Bellibolt is inflated by 133/125 = 6.4%, pushing true max rolls
past the predicted band. Plausible and cheap to check on the next live fight;
not yet verified.

## 2026-08-27 (evening) -- four instances of one bug, and the late-fight collapse

Every fix below is the same underlying shape: **the live agent rebuilds its
state from RAM every turn, and `B.createState` zeroes everything**, so anything
the engine tracks across turns is silently lost unless it is carried explicitly.
Four separate instances were found in one session. This is the first thing to
check for any "it plays stupidly live but is fine offline" report.

1. **Every observation of the opponent was written to `st.foe.team[0]`** rather
   than the active. `st.foe.active` was resolved correctly a few lines earlier
   and then ignored. HP, status, confusion, PP and STAT STAGES all landed on
   their FIRST Pokemon. This is why the Baby-Doll Eyes handover never fired: the
   -1 Attack went onto Pincurchin's boost table, Pawmot always read at neutral,
   the job's `until: {foeBoost: {atk, atMost: -1}}` never became true, and
   Lilligant stood there clicking until it died. Verified by replaying archived
   turn 2752: the one-turn ranking flips from "Mega Drain +1.6" to every move at
   -62.78 with every switch ahead of them.

2. **`justEntered` was read in `policy.js` and assigned nowhere** -- one read,
   zero writes across the whole repo -- so the entry-only move rule had never
   fired, live or in the planner. Mienshao switched in and played Rock Tomb
   every time. Verified after the fix: Fake Out on entry, Rock Tomb two turns
   later.

3. **`protectChain` was zeroed on every rebuild**, so Detect was priced as a free
   turn forever. Watched live: Mienshao Detect-spamming in front of a Pawmot on
   22 HP while Drain Punch healed it back up.

4. **The target's own HP was dropped from the entry state.** `chooseAction` built
   the position for `pricePath` with a comment reading "everyone's HP" and
   recorded ours plus their dead list. So every candidate was priced against a
   FULL-HEALTH target. The matching half of the same bug was in generation:
   `cachedCandidates` was keyed on (foe, terrain) and `candidatesFor` ran every
   duel from a fresh full-health state, so the family "somebody finishes it now"
   could not exist. Live at turn 81: Mienshao had just taken Pawmot to 41/99 and
   the same Drain Punch (band 52-63) would finish it. No candidate said so. It
   switched Diggersby in, Diggersby died in one hit, Pawmot drained back to 97 --
   and that exact sequence repeated in five separate runs.

**Losses had never been recorded at all.** A whiteout heals the party before the
post-battle read, so every loss came back "neither side is wiped" and was
dropped. The "11 wins, 0 losses" record was never true; the archive contains
full wipes with no row. Now latched from the last in-battle read.

### The open problem: the collapse is late-fight, not general

James, from watching: "The problems I am talking about never happen early game,
they are all late game... The baby doll eyes plan was great... something happens
when the game goes too long."

Fight of 18:50, turns 592-613. Sixteen consecutive switches (592-607) with no
attack landed and a free hit taken every turn; Diggersby died inside the loop.
Then from 608 it played Fake Out and five Rock Tombs and was winning. The log:

    592  Mienshao out   PLAN "spe -1, psn, then Mienshao KILLS"     -> switch to Diggersby
         [switch margin 9.93 vs staying in ("...then Mienshao SOFTENS + Breloom closes")]
    593  Diggersby out  PLAN "spe -1, psn, then Mienshao SOFTENS"   -> switch to Mienshao
         [switch margin 9.85 vs staying in ("...then Mienshao KILLS")]
    594  identical to 592, 595 identical to 593, ...

The same two plans swap prices depending on which Pokemon is standing, so the
plan needing whoever is NOT out wins every turn. The margin is ~10, close to
`illegal death 6 + 4 * deathRisk`, which suggests every "stay" line is priced as
the active dying -- both are individually right to flee, and the fleeing is what
kills them. `STICK` (0.75) is nowhere near enough to hold it.

PP was tested and RULED OUT: Mienshao held 3,10,4,15 throughout.

### Negative result: crits are not predictable from the decision-time seed

The generator is solved (`v * 0x41C64E6D + 12345`) and `obs.rng` is read every
turn, but nothing consumes it for planning. Fitting a fixed draw index for the
crit over 131 labelled rows gives 85% against an 82% "always guess no-crit"
baseline -- noise.

The per-move model (one draw per luck event: accuracy, crit, damage, secondary)
is the right one and the DAMAGE roll is locatable within a single move plus
context: for Sludge with the opponent dealing no damage, draw index 3 is
consistent across all 16 rows, against a measured null of 25% (bands repeat
values), so p is about 1e-10.

The blocker is contaminated history, not method: Scald shows a 67% "crit" rate,
which is impossible and is really the old Bellibolt 133-vs-125 max-HP error
inflating observed damage. Refitting needs rows recorded after today's band
fixes.
