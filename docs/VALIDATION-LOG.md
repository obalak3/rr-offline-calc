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
