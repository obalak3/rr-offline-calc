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
