# What to investigate next -- 2026-08-31

Written for a diagnostic run (ultracode or otherwise). Read `docs/HANDOFF.md`
first, and `feedback-rr-working-agreement` in memory.

## Rules of engagement, learned the expensive way

- **Measure, then present.** James's standard: findings must be measured,
  prevalence-quantified and stress-tested BEFORE they are shown, with a
  confidence level attached. Half-checked claims cost more than silence.
- **"Small bug, big consequence" is usually a FALSE ALARM.** It has been wrong
  most times it was claimed. Check the instrument before believing the finding:
  three separate times the "biggest bug" was the measurement, and twice correct
  code was nearly patched to match a broken yardstick.
- **Find and mark; do not perform big surgery.** Small, reversible changes are
  fine. The four root causes in HANDOFF are James's decisions, not yours.
- **Do not retune `TEMPO` (0.4) or `LOOKAHEAD` (5).** Both were fitted by
  playing whole episodes out at several values. Deeper lookahead played
  STRICTLY WORSE. A graded lookahead was tried live and nearly wiped the team.
- **Live evidence beats offline.** `tools/test_replan.js` never calls
  `buildState` and cannot see live bugs.
- Slice `node.log` to the last `agent: watching` before analysing. Column 4 of
  `results.tsv` is SURVIVORS, not deaths.

## The questions, in priority order

### 1. Why does offline say 0/20 where live says ~100%? (highest leverage)

The offline simulator loses essentially every episode while the same code wins
live. Until that is reconciled, the only cheap way to run thousands of trials
is worthless, and every tuning question has to be answered by watching a real
emulator for hours.

This is the top pick precisely because it unblocks everything below it.

- **Data:** `tools/test_replan.js`, the live turn archive
  `~/rr-agent/turns/<session>/`, `~/rr-agent/results.tsv`.
- **Method:** take a live episode that WON, replay its positions through the
  offline harness turn by turn, and find the first turn where offline and live
  diverge in the action chosen. Then find *why* -- almost certainly state the
  offline path never carries (the recurring shape: `createState` zeroes
  everything, so status, boosts, PP, `turnsOut`, `protectChain`, `justEntered`
  and the FIELD are lost unless handed over explicitly).
- **A good answer names the divergence turn and the specific field.** A bad
  answer says "offline is less accurate".

### 2. Is `FINALISTS = 4` throwing away better plans?

Only the four cheapest lines by immediate cost (`here`) ever get their
lookahead priced, but the winner is chosen on `here + ahead`. A line can
therefore be the true argmin on the full criterion and never enter the round
where that criterion is applied.

- **Data:** archived turns, replayed with the lookahead priced for EVERY
  shortlist entry rather than the top four.
- **Measure:** on what fraction of turns is the true `here + ahead` argmin
  outside the top four by `here`? When it is, how large is the gap, and does
  the discarded line lose fewer Pokemon?
- **Note the instrument already exists**: `chooseAction` returns `alternatives`
  and the userLine verdict already reports "cheaper on the full criterion and
  still lost". This is the same measurement, run in bulk.
- **This is bounded and concrete.** If the fraction is small, say so and close
  it; that is a useful negative result.

### 3. How much of the remaining death is the committed-move assumption?

`deathRisk` is conditioned on the SINGLE committed foe move, while entry damage
hedges the whole plausible set. Historically 9 of 34 deaths were "died staying
under a plan labelled 0-4% death".

- **Data:** `~/rr-agent/ai_truth.tsv` (the AI's real score sheet, read from
  RAM, paired by construction), the turn archive, `predictions.tsv`.
- **Measure:** for every death, what did the foe actually click, was it in
  `RRAI.plausible`'s set, and what would `deathRisk` have been priced at
  against the worst plausible move instead of the committed one?
- **Do NOT then apply worst-plausible everywhere.** That is the recorded 0/40
  trap's next-door neighbour: all-pessimism made everything read as death and
  wiped every episode. The point is to size the tax, so James can choose
  between (a) worst-plausible everywhere, (b) deathRisk-only, (c) accept it.

### 4. How often does the lookahead reuse the same Pokemon?

`continuationCost` prices each remaining opponent INDEPENDENTLY, so one healthy
Pokemon is silently assumed to answer all of them. That is the stated reason
deeper search played worse.

- **Measure:** across archived turns, in the continuation for each remaining
  opponent, count how often the same species is the load-bearing killer for two
  or more of them. That number is the size of the optimism.
- Also measure how often the flat 8 (no killing line found) fires, and what the
  score gap looks like on either side of that boundary. The discontinuity is at
  the found/not-found boundary, not within the no-answer case -- the failed
  graded arm established that.

### 5. Where is the AI port still wrong?

59% exact-score / 77% argmax. `ai_truth.tsv` gives per-move ground truth, so
the remaining gap is directly attributable rule by rule.

- **Method:** `node tools/agent.js --score-live` with `RR_LIVE_FIELD_ONLY=1`.
  Group residuals by move, by opponent, and by score delta. A cluster at a
  constant offset is one missing rule.
- **Prime suspect, found three times already:** CFRU runs negatives and
  positives over the same move independently, so a penalty and a bonus BOTH
  apply. Short-circuiting after either silently loses the other.
- Remember their arithmetic excludes crits.

### 6. Does any of this generalise beyond Surge?

James is now playing the whole game fight by fight. Every tuned number was
fitted against Surge's six Pokemon.

- **Measure:** feed candidate generation a sample of other trainers' teams and
  check it produces sensible killing lines at all -- particularly opponents
  with resistances, weather/terrain setters, or healing, which Surge lacks.
- **Cheap and worth doing early**, because a generation hole here looks
  identical to a planner bug from the outside.

## What NOT to spend the run on

- Re-mapping the repo. Memory + this doc + narrow greps are enough.
- Re-deriving our six Pokemon's stats; they match RAM exactly.
- Re-litigating `TEMPO` or `LOOKAHEAD` depth.
- Cosmetic telemetry fixes, unless a number is being used as evidence.
- Anything that requires driving James's browser. It attaches to his REAL
  Chrome and banners the tabs he is working in.
