# How the Radical Red AI picks a move

Research notes for the battle solver. Every claim below is either cited to a
source file and line, or explicitly marked unconfirmed. Nothing here is written
from memory.

## Which engine

**Radical Red runs on Complete FireRed Upgrade (CFRU), not pokeemerald-expansion.**
CFRU and RR share an author (Skeli789), and RR is documented as using "the
Complete FireRed Upgrade engine and Dynamic Pokemon Expansion built by Skeli789,
Ghoulslash, and others."

This matters because the two engines have unrelated AI code. pokeemerald-expansion
has 34 `AI_FLAG_*` constants and a completely different scoring layout. If you go
looking for `AI_FLAG_TRY_TO_FAINT` or `AI_FLAG_OMNISCIENT`, you are in the wrong
codebase. CFRU has **three** trainer AI bits.

Source: <https://github.com/Skeli789/Complete-Fire-Red-Upgrade>, `src/Battle_AI/`.
Snapshot analysed: `master`, last pushed 2025-01-24.

## The selection rule (verified, and simpler than expected)

`ChooseMoveOrAction_Singles`, `src/Battle_AI/ai_master.c:360`.

1. Every move starts at score **100** (`BattleAI_SetupAIData`, `ai_master.c:112`).
   Moves that are currently unusable are set to **0** instead.
2. Each set AI bit runs one scoring pass over all four moves, adjusting scores.
3. Find the maximum score. Collect **every** move tied at that maximum.
4. Return `consideredMoveArray[AIRandom() % numOfBestMoves]`.

```c
return consideredMoveArray[AIRandom() % numOfBestMoves];
```

Two consequences that the solver depends on:

- **The AI's action is a uniform distribution over the argmax set.** Not
  approximately, literally. If three moves tie at the top, each has probability
  exactly 1/3.
- **There is no override path.** Nothing bypasses the score, including a
  guaranteed KO. Every KO check in `ai_positives.c` feeds `INCREASE_VIABILITY`
  like everything else. "The AI always takes the kill" is emergent behaviour
  from the kill scoring highest, not a rule, and it can therefore lose to a
  competing bonus.

So modelling the score *is* modelling the AI, exactly. Our margin `M` is a hedge
against error in our score model, not against engine randomness.

## The three scoring passes

`sBattleAIScriptTable`, `ai_master.c:44`:

| Bit | Flag | Pass | File |
| --- | --- | --- | --- |
| 0 | `AI_SCRIPT_CHECK_BAD_MOVE` | `AIScript_Negatives` | `ai_negatives.c` (103 KB) |
| 1 | `AI_SCRIPT_SEMI_SMART` | `AIScript_SemiSmart` | `ai_advanced.c` (94 KB) |
| 2 | `AI_SCRIPT_CHECK_GOOD_MOVE` | `AIScript_Positives` | `ai_positives.c` (99 KB) |

Bits 29 to 31 are Roaming, Safari and FirstBattle, none of which apply to trainer
battles. The driving loop is `while (flags != 0) { if (flags & 1) DoAIProcessing(); flags >>= 1; }`.

## Score magnitudes (verified by counting call sites)

Macros are `INCREASE_VIABILITY(x)` / `DECREASE_VIABILITY(x)`, `ai_util.h:217-218`.
Roughly 880 adjustment sites across the three passes. Argument distribution:

| Adjustment | Sites |
| --- | --- |
| `DECREASE_VIABILITY(10)` | 304 |
| `INCREASE_VIABILITY(3)` | 34 |
| `INCREASE_VIABILITY(8)` | 32 |
| `INCREASE_VIABILITY(9)` | 23 |
| `INCREASE_VIABILITY(7)` | 16 |
| `INCREASE_VIABILITY(17)` | 16 |
| `DECREASE_VIABILITY(20)` | 16 |

So: base 100, a "this move is bad here" penalty of 10 applied at the overwhelming
majority of sites, and positive bonuses clustered between 3 and 17. **A margin `M`
of 10 in the solver means "include moves one bad-move-penalty below the best."**
That gives `M` a real unit rather than an arbitrary scale.

## Difficulty changes the AI (this is a solver input)

`GetAIFlags`, `ai_master.c:165`. Trainer flags come from ROM data
(`gTrainers[id].aiFlags`) and are then **modified by the game's difficulty setting**
(`VAR_GAME_DIFFICULTY`):

- **Easy**: trainers with `CHECK_GOOD_MOVE` are downgraded to `SEMI_SMART`.
  Everyone else is reduced to `CHECK_BAD_MOVE` only.
- **Normal**: per-trainer ROM flags used as-is.
- **Hard**: any trainer not already carrying `CHECK_GOOD_MOVE` gains `SEMI_SMART`.
- **Expert**: same as Hard for trainers, and even wild Pokemon become smart.

The solver therefore needs the player's difficulty mode as an input. A move that
is predictable on Normal may not be on Hard, because an extra scoring pass runs.

## Randomness inside scoring

`simulatedRNG[i] = AIRandom() % 100`, one per move slot, `ai_master.c:155`.

Used at only about 10 sites, all narrow and situational: healing 50% of the time
(`ai_advanced.c:1044`), a 50% chance of chaining a second Protect
(`ai_negatives.c:1956`), a 75% chance of caring about Wide Guard, powder and Ion
Deluge checks, and a couple of desperate-move and hazard cases.

This is good news. For the large majority of turns the score is deterministic
given the battle state. Where a `simulatedRNG` site is live, the solver should
branch on both outcomes rather than pick one.

## What is NOT confirmed

Listed explicitly so the solver defaults conservatively (wider plausible set)
wherever these matter.

1. **Per-trainer `aiFlags` are ROM data we do not have.** Our trainer dataset comes
   from the community spreadsheet and carries no AI flags. We cannot currently
   tell whether a given trainer has `CHECK_GOOD_MOVE`.
   *Mitigation:* compute the plausible set as the **union** over the possible flag
   sets for that trainer class. That is conservative and stays sound.
2. **RR 4.1 versus CFRU master.** RR is a specific build. How far its AI has
   diverged from the CFRU snapshot analysed here is unknown, and RR may carry
   local modifications.
3. **The ~880 scoring sites have not been transcribed.** The architecture above is
   verified. The individual rules are not yet ported, and that is the actual work
   of the AI model.
4. The RR wiki's "AI Guide" page (radicalred.miraheze.org) is a 292-byte stub with
   no mechanics in it. Web summaries claiming to describe RR's AI switch-function
   order appear to be blended from other games' documentation. Do not trust them;
   they are not a source.

## FIRST REAL-GAME CHECK (2026-08-25) — one confirmed AI-model gap

The first time any line from this project was played in Radical Red. James ran
the Lt. Surge sheet from `tools/validate_sheet.js` on the real save.

**Turns 1-2 matched.** Pincurchin used Discharge as predicted, and Leaf Storm
one-shot it exactly as the engine says it should (our rolls: 134-158 against
95 HP, a guaranteed OHKO). The sheet LOOKED wrong here because it printed
"Pincurchin Hidden Power Ice" for turn 2 -- the AI's selected move, which it
never got to use because it fainted first. That was a display bug in the sheet,
now fixed with a `*` marker; the prediction itself was right.

**Turn 3 is a real deviation.** Vikavolt, facing Victreebel at 85/108:

    our AI scores      Bug Buzz 103   Volt Switch 100   Mud Shot 100
    the game chose     Mud Shot

**It is not a damage-model error, checked.** Both moves are NEUTRAL into
Grass/Poison -- Ground is 0.5x on Grass and 2x on Poison, Bug is 2x on Grass and
0.5x on Poison -- so Bug Buzz wins on STAB alone, 90 x 1.5 = 135 against Mud
Shot's 55. That predicts a 2.45x damage ratio and the engine computes 2.46x
(64 against 26). The damage layer agrees with itself and with the type chart.

So the real AI preferred a move that does **a quarter of the damage** of the one
we predicted. The most likely explanation is a scoring rule we have not ported
that rewards Mud Shot's guaranteed Speed drop; `ai_advanced.c` (SEMI_SMART) is
where stat-lowering secondaries are scored and none of those ~880 sites have
been transcribed. Whatever it is, it must be worth at least +4 to Mud Shot or
-4 to Bug Buzz.

**Do not over-read one observation.** The gap is 3 points, and this file records
that bonuses cluster between 3 and 17 with the dominant penalty being 10, so a
3-point error is the smallest kind there is. It is also possible the real scores
were tied and CFRU picked randomly (`AIRandom() % numOfBestMoves`). Repeating
the same turn a few times from a save would separate those two: a tie re-rolls,
a scoring gap does not.

**The method worked.** One fight, three turns, and it produced a specific
falsifiable defect in the layer every "proved" line in this project depends on.
That is a better return than any benchmark run here.

## How fragile a predicted line really is (2026-08-25, measured)

Prompted by James re-playing the Vikavolt turn and getting Bug Buzz twice after
one Mud Shot. That is what a COIN FLIP looks like, not a missing rule, so the
question changed from "which scoring site did we fail to port" to "how much of a
line rests on decisions this close".

Measured on the real team's Lt. Surge route, scoring the AI at each of the 24
positions and taking the gap between its top move and the runner-up:

    positions on the line   24
    exact ties (gap 0)       7   (29%)
    runner-up within 3      24   (100%)
    runner-up within 10     24   (100%)

**Every decision on the line is within three points of another one.** And three
points is the smallest adjustment this AI makes -- a single
`INCREASE_VIABILITY(3)`, the most common positive site in the whole table.

This file previously recorded ties at about 7% of positions. On this fight exact
ties alone are 29%, so that figure is optimistic at least here.

### What follows, and what does NOT

**Do not port scoring rules off a single observed deviation.** With every
position this close, one mismatch is the expected outcome of correct code, not
evidence of a defect. The bar for a rule being wrong is a REPEATABLE deviation:
the same position, replayed several times from a save, giving the same move we
did not predict. A move that varies between replays is a tie, and the fix for a
tie is not a rule.

**A wide margin is not the answer either, tempting as it looks.** The design
note above suggests branching over every move within `M` of the top. With 100%
of positions within 3, an M of 3 branches at every single turn -- 2^24 lines on
this fight. The margin is a sound idea and it is unaffordable here.

**The affordable answer is to stop needing a 24-turn prediction.** Re-plan from
the ACTUAL position after every turn. Then no plan ever depends on more than one
prediction, a deviation costs a re-plan rather than the line, and the search gets
cheaper as the fight shrinks. This is also the honest reading of what these
numbers mean: a 24-turn script through 24 near-ties is not a plan, it is a
guess repeated 24 times.

**And prefer short lines.** Between two clean lines, the shorter one passes
through fewer of these. That is a real selection criterion and nothing currently
uses it.

## Measured port gaps, 2026-08-27 (from live play)

The live agent now yields exact ground truth for the opponent's action on every
turn (the decision byte read 45 frames after we commit), so the port can be
scored continuously instead of against a curated fixture. Over 159 move-turns:

    model correct, by turn            114/159  (72%)
    model correct, distinct positions  20/36   (56%)

The turn-weighted figure is inflated by save-state replays repeating the same
position; the position-weighted one is the honest measure of the port.

**Only ten distinct miss patterns**, and two of them reproduce misses recorded in
the original 102-decision scoreboard months earlier — Vikavolt's Mud Shot over
Bug Buzz, and Manectric's Charge Beam over Volt Switch. Those are persistent
bugs in the port, not noise.

    x28  Falinks    did Focus Energy   we said Headbutt
    x4   Lokix      did Leech Life     we said Knock Off
    x3   Scyther    did Swords Dance   we said Aerial Ace
    x2   Scizor     did Rock Smash     we said U-turn
    x2   Vikavolt   did Mud Shot       we said Bug Buzz
    x2   Manectric  did Hidden Power   we said Flame Burst
    x1   Manectric  did Charge Beam    we said Volt Switch

The theme is that the real AI values SETUP and STATUS moves more than the port
does.

### focusEnergy was scored as nothing at all — UNRESOLVED

`Focus Energy` carries its own effect kind, `focusEnergy`, which was not among
the kinds the scorer handles. It therefore received no viability adjustment and
any attack outranked it automatically. That is the single largest miss.

A branch was added scoring it like a self-boost, gated on surviving long enough
to use it. **It does not reproduce the observed behaviour**: Falinks used Focus
Energy at 77 HP, where that gate only awards +3 and an attack still wins. So the
real rule is more permissive than a stat boost's, and the branch as written is a
guess rather than a port.

Tuning it until it matches one position would be overfitting. The CFRU source is
not in this repo -- only these notes citing it -- so the correct next step is to
read `src/Battle_AI/ai_script.c` for how Focus Energy and the other setup moves
are actually scored, and port that, rather than pattern-matching from the
neighbouring branch.
