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

    (to fill in when the run starts: difficulty, mode toggles, starter)

## Battles

    (one entry per battle, newest last)
