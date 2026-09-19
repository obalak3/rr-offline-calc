# Searching the real game (2026-09-19)

How the agent should plan, worked out with James over one afternoon. Every rule
below was forced by a measurement that contradicted what we believed at the
time; none was chosen because it sounded right.

## Why this is allowed now, when "more search" always lost before

The project had measured five separate times that deeper search made play worse
(the depth sweep, RR_DEEP_SCAN, the gameplan beam, arm C, arm D) and concluded
the value model was the bottleneck. James, 2026-09-19:

> "The reason more search always was worse was because we didn't have the data.
>  We were working on predictions, and the percentages of the plan not working
>  combined in longer runs. In this case we have 100% data."

He is right, and the distinction is the whole basis of this work. Those five
results were measured on the offline engine, where every extra ply multiplied a
prediction error. The oracle predicts nothing: it plays the action on a real
copy of the game and reports what happened. The mechanism that made depth
harmful is simply absent.

Two things follow that make the problem much easier than it looks:

- **It is not a game tree.** From a save state the fight is a deterministic
  function of OUR action sequence alone. There is exactly one continuation per
  sequence we choose, so this is single-agent search, not minimax, and their
  side contributes no branching at all.
- **The objective does most of the pruning.** Zero faints means any node where
  one of ours dies is dead, and so is everything below it.

### The determinism is measured, and it depends on HOW we press

The same action from the same state, played at nine different start delays
through the oracle's press path, gives the identical result every time -- moves
and switches, singles and doubles. An earlier test of mine appeared to show
otherwise and was wrong: it used a hand-written script that pressed for a fixed
number of frames, which can register as one press or two depending on frame
alignment. The oracle holds A until the screen changes, so it always registers
exactly one.

**Every probe in a search must therefore go through the oracle's press path.** A
scripted press breaks the determinism the whole approach rests on.

## The shape, and the failure that forced each rule

`tools/deep_search.js`. Four rules:

1. **Never prune the root.** The root is the decision we actually make;
   everything below it exists only to judge it, and there are few enough
   actions there to play them all.
   *Forced by:* Greninja at 23/139 against a fresh Kangaskhan. The pruned search
   offered a switch costing 44 HP while one costing NOTHING existed. The switch
   ranker scores an arrival by the opponent's worst plausible hit, and
   Skeledirge is a Ghost that Crunch hits double, so it ranked badly -- but the
   real Kangaskhan used a Normal move Skeledirge is immune to. The ranker had
   quietly reintroduced predicting their move, which is the one thing this
   approach exists to avoid.
2. **Prune continuations by SHAPE, never by one score across shapes.** Moves are
   ranked by damage; switches get their own budget and are ranked by what they
   TAKE on arrival.
   *Forced by:* depth 3 on the Surge opening. Ranking everything together by
   damage means a switch is only kept when there are fewer moves than the keep
   budget, which never happens -- an entire kind of action was invisible at
   every node. Exhaustive found "Scald, switch Victreebel, Leaf Storm", removing
   Pincurchin for 5 HP; the pruned search could only reach "Scald x3" for 45.
   Doubles taught the same rule from the other direction four days earlier, when
   ranking pairs by damage lost a priority kill and a Fake Out flinch.
3. **Cut any branch that spends one of ours.** Not a heuristic: it is the target.
4. **Run the levels in parallel.** Every probe is an independent process and the
   tree is parallel level by level. This changes nothing about the search, which
   is why it returns the identical answer.

## What it costs

Same answer, on the Surge opening:

| search | probes | time |
| --- | --- | --- |
| exhaustive, serial | 819 | 307 s |
| shape-pruned, serial | 155 | 58 s |
| shape-pruned, 8 at a time | 155 | 12.7 s |
| plus a beam of 6 | 60 | 5.0 s |

Settled configuration -- root unpruned, continuations keep 3, beam 6, depth 3,
eight at a time -- on the three positions checked by hand:

| position | probes | time | answer |
| --- | --- | --- | --- |
| Surge opening | 69 | 6.1 s | Scald, Victreebel, Leaf Storm; removes one for 5 HP |
| Giovanni vs Honchkrow | 72 | 7.3 s | Water Shuriken, Scald; removes one |
| Greninja at 23 HP | 64 | 7.2 s | switch Skeledirge; costs nothing |

A probe averages 0.37 s, not the 0.7 s quoted in older notes.

## What was rejected, and why

**Follow the leading line deep, widen only if it disappoints** (James's first
shape). Five times cheaper -- 30 probes against 155 -- and it misses. The
winning line does not LEAD: switching Victreebel in takes damage and deals none,
so it looks worse at that step, and the payoff is two turns later. Following the
leading line only works when the best line is locally greedy, and a setup switch
is exactly where it is not. The widening trigger cannot be "the leader
disappointed", because by then the line that needed following was never taken.

**Ranking search configurations by what we lose.** Keeping only two actions
looks best on such a table -- 39 probes, 3.7 s, nothing lost -- and it removes
NONE of theirs. Any comparison has to show what was removed beside what it cost.

## Open

- `tools/search_battery.js` runs cheap against exhaustive over a corpus and
  reports disagreements. Three positions from one fight is not evidence, and
  every wrong turn in this work came from a case there was no evidence about.
- Doubles is not wired into this searcher; the doubles advisor is a separate
  path with its own (shape-based) pruning.
- **This is a tool, not the agent.** Nothing here plays James's game. Connecting
  it to the live path is real work and has not been discussed with him.
