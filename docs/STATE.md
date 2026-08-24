# Where this stands — 2026-08-24 (end of day)

Written as a handoff. `TUNING.md` holds the measurements and the traps;
`RR-AI.md` holds what is known about the game's AI. This file holds the current
architecture, what is actually fixed, and what is still open.

## The goal

Radical Red, singles, Nuzlocke rules: **win without losing a single Pokémon**.
A win costing one Pokémon is a failure. Everything below is judged by that and
not by win rate.

James's framing of the long game, worth keeping in view when choosing work:
**Misty and Surge are very easy compared to what is coming.** The run has many
encounters ahead and each gets harder as the opponents' teams strengthen, so the
value of any change here is measured by whether it scales to those fights, not
by whether it squeezes one more early gym. Basis first.

## The engine's own correctness was the biggest thing wrong (2026-08-24)

Read this before any search work, because a search is worthless on a fight whose
mechanics it does not understand, and a coverage bug does not announce itself:
the engine simulates what it cannot model as something simpler, finds a clean
line through the misunderstanding, and reports it with the same confidence as a
real one.

`tools/audit_coverage.js` walks all 792 trainer Pokemon in all 167 battles and
reports what the stack does not know. It found **seventeen mechanics**, and none
of them would ever have surfaced from the benchmark, which exercises exactly one:

    abilities (11)  Rock Head, Magic Guard, Serene Grace, Speed Boost,
                    Magic Bounce, Skill Link, Iron Barbs, Rough Skin,
                    Poison Heal, Protosynthesis, Quark Drive
    items (6)       Lum Berry, Life Orb, Rocky Helmet, Weakness Policy,
                    Flame Orb, Toxic Orb
    moves           421 distinct, no gaps at all

Three that mattered most, as examples of the shapes these take:

- **Rock Head.** Recoil was applied anyway, so the engine had Mega Aggron
  beating itself to death with Head Smash and a search could "win" by waiting
  for an opponent that never dies.
- **Lum Berry.** Cures the status the instant it lands, so seventeen trainer
  Pokemon shrugged off every status the search planned around. This party runs
  two Sleep Powders.
- **Protosynthesis / Quark Drive.** Applied by nobody, engine or calculator.
  They start at GYM LEADER BROCK and Lt. Surge fields two under his own
  permanent Electric Terrain.

**The method matters more than the list.** Grep found imaginary gaps and missed
real ones in both directions: it said Mystic Water and Guts were unhandled when
both work perfectly, and it could not see that Protosynthesis did nothing.
Everything that survived came from *measuring the mechanic* -- computing damage
with and without it. The audit tool now does that, and labels its item output a
triage list rather than a bug list. Re-run it before each new stretch of the
game rather than trusting the list to stay current.

Verified fine, so nobody re-checks them: Guts, burn halving, Eviolite, resist
berries, type-boost items, Choice items, Assault Vest, and mega forms (the
trainer data already names the mega SPECIES, so the stones are decoration).

## Three engines exist. Know which one produced an answer.

| Engine | File | What it does | Trust |
| --- | --- | --- | --- |
| Weighted search | `rr-solver.js` | Fixed-depth (lookahead 2) minimax over a hand-weighted evaluation. Always returns something. | A guess. |
| Exact line-finder | `rr-exact.js` `cleanWin` | Depth-first search for a line where nothing faints, at **median rolls** against the AI's **top-scoring move**. | A real line, not a proof. |
| Certifier | `rr-exact.js` `certify` / `winChance` | Branches over the **full AI tie set** and over damage bucketed by whether it kills. Result of 1 means no reachable branch loses anybody. | The only thing entitled to say "proved". |

`RRExact.planRoute` asks the line-finder first and falls back to the weighted
search, tagging the result: `certified`, `line-found`, `no-clean-line-exists`,
`undecided`. The panel says which, in those words. **Anything the weighted
search produced is a guess and the UI must keep saying so.**

**The weighted search is frozen.** It stays as the fallback and as the risk
pricer, and it is not to be tuned again. Three separate fixes to it each landed
on exactly 81/135, depth 2/3/4 measure the same, and every weight sweep tried
has come back flat or worse. The ceiling was the evaluation itself, so the work
went into making the exact search finish more often instead. That decision
retires several long-standing entries from the gap list below rather than
completing them.

**How the line-finder looks for a line: a portfolio, not one search.** Ordering
turned out to be worth more than anything else measured, and no single ordering
wins. `rr-matchup.js` solves every 1v1 up front -- can mine beat theirs without
fainting, and with what left -- and ordering switches by that is worth 35x on
Mt. Moon Archer and is a LOSS on Lt. Surge, whose line is won by setting up
Growth twice on a Pokemon the table rates a poor pairing. A narrow beam has the
opposite profile: 7,423 nodes on Surge, nothing on Mt. Moon. So `cleanWin` runs
each in turn under its own slice of the budget, and **only the full-width,
full-horizon pass may ever conclude that no clean line exists.** Reordering
cannot change which lines exist, which is the whole reason a portfolio is
allowed here.

There is also `rr-mcts.js`, which lost on singles (56% against 60%) and is kept
only because doubles has roughly 576 action-pairs per turn where exhaustive
search is hopeless and sampling is the plausible tool.

## Where it runs

The app is a static page opened from `file://` — that is the point of the
project, so it works on a plane. The search runs in a Web Worker with **no time
cap**, live progress, and a Stop button.

Workers from `file://` are blocked (verified in Chrome: *"cannot be accessed
from origin 'null'"*), so the worker is built from a Blob, and the whole engine
is baked into a string by `tools/build_worker.js` — 24 calc files plus seven of
ours, about 1.2 MB. `tools/test_worker.js` runs that bundle in a fake worker
scope, because it is the one piece no other test can reach.

**The search runs on every core.** Whatever line exists opens with one of the
legal moves and those branches are independent, so `rr-search.js` deals the
openings round robin across one worker per core (minus one, so the page stays
usable) and each searches its own share. The endings are asymmetric on purpose:
the first share to find a line has answered the question and the rest are
stopped, while "no clean line exists" needs EVERY share to have finished and
come back empty. A share that ran out of budget or crashed leaves the fight
undecided.

This matters more than it sounds. The engine manages a few thousand positions a
second, so the app's 60-million-node budget is not really a budget -- at that
rate it describes five and a half hours. The real limit is how long somebody
will watch a progress bar, which makes throughput worth as much as cleverness.

**The browser cannot be driven by tooling here.** The Chrome automation refuses
`file://` URLs, so every measurement in this repo is Node or jsdom. Serving
`dist` over `http://localhost` would allow real-Chrome UI testing, but NOT
worker questions, because `http://` permits plain workers and would give the
wrong answer. `tools/test_search.js` fakes Worker, Blob and URL to test the
split search's bookkeeping, for the same reason `tools/test_worker.js` exists.

## Numbers

    clean wins, 135 early-game fights   (tools/bench_early.js 15, engine exact)
      dumb "hit hardest" baseline      20%
      weighted search                  61%
      exact search, before 2026-08-24  71%
      exact search, now                73%      <- current

The two points that gap covers are worth separating, because they are the two
kinds of work this project does. Everything from 61% to 71% was search work:
ordering, the pairing table, the portfolio. **The 71% to 73% was correctness
work** -- roughly twenty fixes to the engine, the AI model and the team
generator, none of which made the search cleverer and several of which made the
opponent stronger.

Every number above 71% is also the first this project has measured with the
player's team actually having its abilities. See the correctness section: the
generator returned `undefined` for every ability from the commit that created
the benchmark until 2026-08-24.

On the fights that actually fail (`tools/bench_hunt.js 3`, 400,000 nodes and
60 s, single threaded):

    witnesses found      2/9  ->  3/9
    Lt. Surge witness    86,776 nodes  ->  27,585
    Mt. Moon             1 team in 3   ->  2 teams in 3
    Misty                nothing       ->  nothing

Measured against fights *proven winnable* rather than against an imagined 100%
(`tools/ceiling.js 3 300000`, re-run once the oracle stopped using its own stale
copy of the search):

    a clean win EXISTS            20  (74%)
    provably IMPOSSIBLE            0  (0%)
    undecided (budget ran out)     7  (26%)
    of the fights it COULD win  20/20  (100%)

**Judgement is no longer where anything is lost.** The planner wins every fight
anybody has shown to be winnable, and it won a Falkner fight the oracle itself
could not decide. Every remaining failure is a fight nobody has decided, and
nothing in any run recorded here has ever been proved impossible. Misty is 0 for
3 on both sides of that table: not merely unwon, undecided.

So the work left is compute and horizon, not evaluation.

Speed on Lt. Surge, generated team: **1,183,765 ms → 34,265 ms**, a 34x
improvement, from switch-matchup ordering (11x), deleting a clone-per-candidate
in `chooseReplacement` (1.8x), and caching `moveData` and `finalSpeed` (1.8x).
Every step verified by identical node counts, so behaviour never changed.

## Mirror matches, and what they exposed (2026-08-24)

`tools/bench_mirror.js` gives us **exactly the opponent's team** -- same species,
levels, moves, items, abilities -- plus one level. James's idea, and it is the
sharpest instrument here, because every other benchmark confounds two things:
how good the planner is, and how good the team it was handed is. When a fight
comes back undecided those are indistinguishable. A mirror removes the team from
the question entirely, so what remains is whether our side chooses better than a
one-ply scorer with no lookahead.

**The one level matters and not for the reason you would guess.** This engine
hands every speed tie to the opponent, so at true parity we move second forever
-- a mirror is the HARDER side to play. All three 2v2 Rival fights came back "no
clean line exists" at parity and are won in 19 to 32 nodes with one level.

It also forced a distinction that had been quietly conflated:

    "clean win"        a line where NOBODY faints. The Nuzlocke objective, and
                       some fights fail it on merit however well they are played.
    "wins at all"      the fight is won, losses allowed. Against a one-ply AI
                       with our own team, there is no excuse for failing this.

The tool now reports both, and the early game is **8 of 9 clean** -- with the
fights that fail against random teams falling cheaply: Lt. Surge in 206 nodes,
Koga's 6v6 in 85, Mt. Moon in 75.

### The finding that inverts a settled belief: Brock

    exact search      undecided at 200,000 nodes, at maxTurns 24, 32 AND 40
                      (the horizon is never even reached)
    weighted search   WINS, LOSING NOBODY, in 16 turns

Replayed independently against the AI's real replies: 16 turns, zero losses, all
four down. **A clean line exists and the exact search cannot find it.** So this
is not a hard fight, it is a search failure -- and it contradicts what this file
records below as settled, that searching exactly beats scoring positions.

Brock's team says why. Two Sturdy users, Berry Juice, Protect and a Custap Berry
Self-Destruct mean **nothing dies to one hit, so no move ever registers as a
kill** -- and `ordered()` sorts kills first, damage second, switches last. With
no kills available the ordering collapses to raw damage, while the line that
wins is patient and switch-heavy: four Gyro Balls, a pivot, four Bulldozes,
another pivot. The winning move is almost never the hardest-hitting one.

### Why it could not be found, and the beam that was not a beam

The obvious objection is that an exhaustive search must find the line given
enough time. Measured: Brock's mirror is still undecided at **4,000,000 nodes**.

Not because the winning move is buried -- Rock Tomb sits second of seven in the
ordering. Because depth-first takes the first move and explores everything
underneath it before trying the second, and that subtree is about 7^15. **The
search never gets past its first guess.** Both mechanisms that normally make
this affordable are defeated by this fight: the Nuzlocke cut needs things to
die, and with two Sturdy users and Berry Juice almost nothing does; the
transposition table needs positions to repeat, and in a long grind where HP
drifts every turn almost nothing does.

**The portfolio's beam pass exists to hedge against exactly this, and it was
inert.** The beam was an absolute 8; a 4v4 has seven legal actions, so
`Math.min(7, 8)` restricted nothing and two of the three passes explored the
same tree the same way. Beams are now a fraction of the branching factor:

    Brock mirror   undecided at 4,000,000 nodes  ->  clean win in 23,796 nodes,
                   and a 13-turn line, three shorter than the weighted search's
    early mirrors  8 of 9  ->  9 of 9

**The general lesson, worth more than the fix:** a cap expressed as an absolute
number silently stops being a cap when the thing it caps is smaller than it.

### An open question this raises, deliberately NOT yet decided

If the weighted search produces a line that loses nobody, that line **is** a
witness -- verified by replay -- and there is no reason to make the exact search
rediscover it. `planRoute` currently asks the exact search first and only falls
back to the weighted one when it gives up, and it never checks whether that
fallback line happens to be clean. On Brock it computes a perfectly good clean
line, labels it "the search ran out of time, here is a guess", and throws the
important property away.

A `cheapWitness` probe that runs the weighted search first and keeps its line
when it is clean is committed but **OFF by default** (`probe: true` to enable).
Measuring it settled the question, and against making it the default: on a fight
that genuinely certifies, the probe returns `line-found` with **no certificate**
where the real search returns `certified`. It trades a provable answer for an
unprovable one to save 200 ms, and does it silently.

The idea is still right for the case it was built for. It needs to certify the
line it borrows before it can be the default, and that is the open work.

## The switch-churn problem: partly fixed

Symptom: routes like Mienshao → Victreebel → Breloom → Lilligant, eating a
Psyshock on every hop, to reach a Pokémon it could have switched to directly.
The detour then manufactures its own risk — the Pokémon arrives low enough that
something threatens it.

Three drivers. Two fixed, one not:

1. **FIXED. `deathChance` is active-only**, so switching resets it and collected
   up to `deathRisk` points for free. Default now 0. Measured: fewer switches
   *and* clean wins up from 61% to 64%.
2. **FIXED. Nothing said a switch costs a turn.** When attacking achieves
   nothing (a Fighting move into a Psychic type) attacking and switching scored
   the same and the tie broke arbitrarily. `switchCost: 60` is a tie-breaker,
   deliberately smaller than any real gain.
3. **NOT FIXED, AND NOT GOING TO BE. `orderedMyActions` in `rr-solver.js` gives
   every switch `weight = -1`**, so among switches the order is just bench
   order. This is the direct cause of the chain above, and it is a defect of the
   weighted search, which is frozen. `rr-exact.js` ranks switches by the matchup
   they create and now also by the 1v1 table, which is where the effort went.

Combined effect of 1 and 2, over ~650 turns: back-to-back switches 78 → 32,
switch-backs 40 → 24. Better, not solved.

**A fourth driver: Regenerator stall-healing.** Mienshao ↔ Lilligant ping-pong
where each switch-out heals a third of max HP. The evaluator likes the HP and
nothing forces progress until `forcing` trips after four turns without the
opponent losing HP — and `forcing` then bans switching entirely, which is its
own blunt instrument. **This is a weighted-search problem only.** The exact
search cannot loop like this: it memoises on the position together with the
turns remaining, so returning to a position it has already tried with at least
as much budget is cut immediately. Nothing to do here.

## The central open problem: accumulating advantage

The weighted evaluator prices every turn in isolation, so anything whose payoff
accumulates is invisible to it. Named cases, all from the real team:

- **Fake Out** (Mienshao). Guaranteed flinch: free chip damage and the opponent
  loses a turn entirely.
- **Volt Absorb** (Lanturn). Switching into an Electric move converts damage
  into healing. The team gains HP.
- **Regenerator** (Mienshao). A third of max HP back for switching out, so a
  damaged pivot returns as a usable body.
- **Intimidate**. Each entry drops the opponent's Attack another stage,
  permanently reducing everything physical for the rest of the fight.

**A measurement that corrects the obvious diagnosis:** the evaluator is *not*
scoring moves in isolation — it is already state-based, and it already prefers
Fake Out. Measured at the real opening, Fake Out scores **335** against Drain
Punch's **308**, precisely because the resulting state keeps 55 HP. It loses
because two Drain Punches score a **900-point knockout inside the two-turn
horizon** and Fake Out does not. So this is a **horizon** problem, not a
representation problem, and "make the evaluation state-based" is already done.

Consequently: **do not fix this with weights.** Three separate weight and
fidelity fixes each improved the decision they targeted and each left the score
at exactly 81/135. Depth does not help either — lookahead 2, 3 and 4 all score
the same.

**This problem has been closed by retirement rather than by solution, and that
was deliberate.** Quiescence extensions were the leading candidate and are NOT
going to be built. Everything in this section is a description of the weighted
evaluator, the exact search does not share any of it — it plays to the end, so
it finds Fake Out, the double Growth setup and the pivot cycles by itself with
no notion of what they are worth. Since the weighted search is now only a
fallback and a risk pricer, effort goes into making the exact search finish more
often instead. The horizon problem is real, well diagnosed, and no longer worth
fixing.

The exact search does **not** have this problem — it plays to the end, so it
finds this play by itself. Its proved Surge line sets up Growth twice down to
17 HP before sustaining with Mega Drain, then switch-cycles. So a second
approach is simply to make the exact search finish more often.

A third, already started: use free actions as **ordering hints** in the exact
search, which is sound because ordering cannot change which lines exist.
`deniesTheirTurn` and `freeValueOfSwitch` in `rr-exact.js` rank guaranteed
flinches, absorbing switch-ins, Regenerator pivots and Intimidate entries ahead
of ordinary chip. **Effect not yet measured** — the generated benchmark teams
have none of these abilities, so the obvious test was inert.

## Open questions

1. **Which mirrors do we lose?** `tools/bench_mirror.js --all` covers all 139
   non-doubles fights and is the run that matters most: with the team removed as
   a variable, anything not won is the planner rather than the team. Early
   results have Blaine and Clair at "wins, losing 2" -- the fight is won and the
   Nuzlocke objective is not, which is the expected shape. Full results pending;
   record them here.

   **Watch for the Brock pattern, which has already recurred.** The Lt. Surge
   REMATCH mirror comes back undecided at 250,000 nodes while the weighted
   search wins losing NOBODY. That is a second fight where a clean line exists
   and the exact search cannot find it, so it is not a Brock-specific oddity.
2. **The whole game is unmeasured, and that is now the headline.** Every number
   in `TUNING.md` comes from nine battles out of the thirty-six fixed-level
   singles fights in the dataset, all of them from the first tenth of the run.
   `tools/bench_game.js` measures the rest, and the first run says the Elite
   Four is 0/9 with four of those UNDECIDED rather than lost. Whether that is
   budget or something structural is the open question that matters most: it is
   the difference between "needs more compute" and "does not work up there".
3. **Misty.** The one fight nothing has touched. Beam widths 2 through unlimited
   at horizons 10, 16 and 24, plus every ordering built, produce neither a line
   nor a verdict. A narrow beam exhausts its whole slice in 242 nodes finding
   nothing, which says the winning lines — if any exist — are nowhere near the
   moves that look best. Not yet known to be hard rather than unwinnable.
4. **Is Lt. Surge cleanly winnable with the real team?** Still open after
   **56 million nodes across seven processes** (26 minutes, 2026-08-24). Five of
   the seven shares finished their openings and found nothing; two ran out. The
   answer is not near the surface, so another doubling of cores is not obviously
   what finds it -- this is the trigger the plan set for proof-number search.
   `tools/hunt_parallel.js` checkpoints which openings are settled, so a resumed
   run only searches what is left.
5. **What is the real ceiling?** `ceiling.js` now calls the shipped engine
   instead of its own stale copy, so its recorded 67/0/33 split is void and it
   needs re-running. Expect more fights to come back decided.
6. **Does the free-action ordering help?** Still unmeasured. The generated
   benchmark teams have none of the abilities it ranks, so the obvious test is
   inert.

## The tools, and which question each answers

    tools/bench_early.js     9 early battles x N teams. THE headline number,
                             now 73% clean.
    tools/bench_mirror.js    our team IS their team, plus one level. The only
                             instrument here that measures the PLANNER rather
                             than the planner and the team together, and the one
                             that found Brock. Reports clean wins and plain wins
                             separately, because only the second should ever be
                             near perfect. --all covers all 139 non-doubles
                             fights, scaling ones included.
    tools/bench_game.js      all 36 fixed-level singles battles, by segment.
                             Says where the planner starts struggling, which
                             bench_early structurally cannot.
    tools/bench_hunt.js      only the fights that fail, reporting found /
                             decided / nodes. A win rate cannot tell "no clean
                             line exists" from "the search ran out", and that is
                             the distinction all the search work turns on.
    tools/ceiling.js         how many fights are winnable AT ALL, so the planner
                             is scored against the achievable rather than 100%.
    tools/hunt_parallel.js   one fight, one process per core, with checkpoints.
                             For the questions worth hours.
    tools/audit_coverage.js  what the engine does not understand, across the
                             whole game rather than the benchmarked corner.
    tools/counter_team.js    builds a team chosen AGAINST one boss and asks
                             whether the search finds the win. Its level sweep
                             works on the early gyms and NOT on endgame bosses:
                             Lance two-shots anything however overlevelled, so
                             more levels never make his fight trivial and the
                             sweep separates nothing.
    tools/test_invariants.js properties that must hold of every position --
                             found lines replay clean, beams never conclude,
                             caches do not leak between fights, the search is
                             deterministic, more budget never loses a line, and
                             step() never mutates its input.

`tools/lib/harness.js` holds the engine loader, the team generator and the
battle selection, shared by all of them. It exists because bench_early and
ceiling.js each had their own copy and had silently drifted apart -- ceiling was
grading the planner with a weaker search than the planner used.

**The generator scales with the level, and that is load-bearing.** Below 40 it
is Kanto lines, zero EVs, Oran Berries and level-up moves, which is what a
Nuzlocke actually has before the third gym. Above 40 it is fully evolved species,
trained spreads, Sitrus, and TM and tutor moves. Getting this wrong produced a
level 87 Pikachu against Zacian-Crowned and made the Elite Four look impossible;
`TUNING.md` records that it was the SECOND time this benchmark measured teams
nobody would field. Early-game output is verified byte-identical by fingerprint.

## The correctness bugs found on 2026-08-24, so nobody re-finds them

A three-way code review found these, all verified by running the code. Listed
because several are the kind that would have been believed rather than noticed.

**The search could conclude without looking.** A caller-supplied pass omitting
`beam` gave `Math.min(n, undefined)` = NaN, so zero actions were tried -- and
`undefined < Infinity` is false, so the pass was judged full width and allowed
to conclude. A fight Blastoise wins in one move came back "no clean line
exists" after three nodes. Separately, any branch the engine could not evaluate
returned false silently, letting a pass conclude on a subtree it never entered.

**Worst-case mode gave the OPPONENT good luck.** `against(ctx, key)` is true
only for our side, so the else branch -- every foe action in worst mode --
returned outright. An inaccurate enemy move was skipped entirely (Dynamic Punch:
0 damage in worst mode, 330 in maxroll) and a paralysed enemy never moved again,
so a plan opening with Thunder Wave read as though the fight were over. This is
the mode `RRSolver.solveProof` uses by default.

**Engine mechanics, all measured:** substitutes swallowed recoil, drain, Life
Orb, self-KO and pivoting (Explosion left the user alive); Focus Sash survived
five-hit moves; Magic Guard took hazard, weather and status damage; hazards
tested for the Flying TYPE instead of `isGrounded()`, so Levitate walked into
Spikes; toxic counters survived a switch; Leech Seed healed HP that never
existed; `positionKey` omitted yawn, charged, encore and turnsOut, so distinct
positions were folded together.

**The opponent model narrowed itself twice**, which is the one direction it must
not: every pivot destination collapsed to one entry, and the speed comparison
used whichever move sat in OUR slot zero, so rotating our own moveset changed
what the AI was predicted to do.

**The benchmark generator was wrong in four ways**, three of them invisible for
the project's whole life: no abilities at all (three layers -- `names` not
`name`, an empty slot 0 that 392 of 1343 species carry first, and a nameIndex
that picks between same-effect names); EVs on the wrong attacking stat for 188
species, because the dex array is `[hp, atk, def, spe, spa, spd]` and Speed sits
at index 3; alternate forms in the pool, because the filter read `name` where
forms keep the base name and put the suffix in `key`; and an RNG that was
deterministic but never uniform, giving three of six natures 0.1% each.

## Known gaps, in rough priority order

1. **No clean line means no answer at all.** The search is all-or-nothing: it
   grinds for millions of nodes and returns nothing rather than "here is the
   line that costs you one Pokémon, and it should be this one". The most
   user-visible defect. Deliberately parked: the current focus is not losing
   anything at all.
2. **Misty** fails across the board; see the open questions.
3. **Raw speed.** A few thousand positions a second is the ceiling on everything
   else. Parallel workers multiply it; the per-position cost has barely been
   attacked. A profile of a hard search puts 13% in string building for position
   keys and 6% in megamorphic map lookups, against 5% in the damage calculation
   the search actually exists to do.
4. **Doubles.** Untouched. 27 of 167 battles, and NOT late-game: Mt. Moon /
   Super Nerd / Miguel and three Nugget Bridge fights are level-scaling, so they
   appear before Misty. Move targeting data is in (`target` on every move:
   selected / self / allFoes / allAdjacent / special / random / foeSide / ally).
   Spread damage is unavoidable — 18 distinct spread moves across those teams.
   Recommended architecture: a **separate module** reusing the damage and effect
   layer, not a refactor of the singles engine into a general N-slot one, since
   singles is heavily tested and works.
7. **Backup plans and sacrifice ranking** — which Pokémon to spend when losing
   one is unavoidable. Raised early, never started.

## Things that are settled, so nobody re-litigates them

- **Dominance pruning is unsound here.** "More HP is at least as good" fails
  because CFRU's `ShouldSwitchToAvoidDeath` is a threshold: a foe at lower HP
  can behave differently. Fine as a heuristic-search speedup, never in the
  certifier.
- **The JSON clone is the fast clone.** A hand-written structural copy measured
  1.81x slower (26.6 µs against 14.7 µs). Clone is only ~10% of a turn. It does
  need the explicit `Infinity` restore for permanent weather and terrain.
- **`turnCost` is inert by construction** — constant across leaves at the same
  depth.
- **Depth is neutral, not harmful.** The old "depth hurts" finding was an
  artifact of a broken benchmark generator and is retracted.
- **Read the team from the save, never ask for it.** `tools/read_save.js`. Two
  traps: load the Pokédex first, and create the `ArrayBuffer` inside the vm
  context.
- **Grep does not tell you whether a mechanic is modelled.** It reported
  imaginary gaps (Mystic Water, Guts and Chople Berry all work perfectly,
  because the vendored calculator works from item DATA rather than named
  branches) and missed real ones (Protosynthesis and Quark Drive were applied by
  nobody at all). An entire priority list was built on a grep and came out
  backwards. **Measure the mechanic**: compute damage, or step a turn, with and
  without it.
- **A number that does not move after a fix you believe in is a claim to check,
  not a result to accept.** Two full 135-fight runs reported an unchanged 71%
  after the ability fix, which looked like evidence abilities did not matter. It
  was evidence the fix had not arrived: `bench_early.js` carried a private copy
  of the generator. Three tools were found holding private duplicates of shared
  logic in one day, and each silently refused a fix already made and verified.
- **A tool that prints its inputs finds bugs nothing else will.** The ability bug
  survived a benchmark, a ceiling check, a whole-game run and a
  seventeen-mechanic coverage audit, and died the moment something printed the
  ability column.

### One entry here is now contradicted, and is left standing so the argument is visible

- **"Searching exactly beats scoring positions"** is recorded in `TUNING.md` as
  the largest single improvement in the project, and it was true on the fights
  it was measured on. **Brock's mirror is a counterexample**: the weighted
  search wins losing nobody in 16 turns where the exact search finds nothing in
  200,000 nodes. The right reading is not that the exact search is worse -- it
  is 61% against 73% across 135 fights -- but that the two fail on DIFFERENT
  fights, and nothing in the architecture currently lets either rescue the
  other.

## The real team, as of this save

    Mienshao   Lv34 Adamant Regenerator  @Sitrus  Fake Out, Drain Punch, Detect, Rock Tomb
    Diggersby  Lv34 Impish  Cheek Pouch  @Sitrus  Take Down, Bulldoze, Double Kick, Odor Sleuth
    Lanturn    Lv34 Modest  Volt Absorb  @Sitrus  Scald, Confuse Ray, Signal Beam, Shock Wave
    Lilligant  Lv34 Modest  Own Tempo    @Sitrus  Recover, Baby-Doll Eyes, Sleep Powder, Mega Drain
    Breloom    Lv34 Adamant Effect Spore @Sitrus  Headbutt, Mach Punch, Force Palm, Bullet Seed
    Victreebel Lv34 Modest  Chlorophyll  @Sitrus  Mega Drain, Sludge, Sleep Powder, Leaf Storm

Every move and ability is modelled; the engine reports nothing unmodelled for
this team. Note for Surge specifically: his permanent Electric Terrain blocks
sleep on grounded targets, so both Sleep Powders only work on Vikavolt, which
has Levitate.

## A limit worth knowing about: `decided` is unreachable for long fights

`cleanWin` sets `truncated` the moment any branch runs out of turns, and a
truncated search can never report `decided`. That is correct — lines longer than
the horizon genuinely were not examined — but it has a consequence that is easy
to miss when reading results:

**For any fight where some plausible line runs past `maxTurns`, "no clean line
exists" is unreachable by construction.** The only two answers available are a
witness or "undecided". So an undecided verdict on a long fight carries less
information than it appears to: it may mean the tree is too big, or merely that
the fight is longer than 24 turns.

This is why nothing in this repo has ever been proved impossible, and why that
fact is not the reassurance it sounds like.

The horizon itself deserved suspicion, and has now been measured. The proved
Surge line for a generated team is **23 turns against a cap of 24**, which looked
like the cap might be what binds. It is not, on either hard fight: both are
budget-bound. A 10-turn search on Misty already costs as much as a 24-turn one,
because this tree is wide rather than tall.

Two things follow, and the second is the one that surprised me:

1. `cleanWin` will extend the horizon UPWARD, to `maxTurnsCeiling`, but only
   when a full-width pass finished everything inside the horizon and stopped
   because lines ran past it. The app asks for 40. It is inert on Surge and
   Misty, correctly.
2. **Starting shallow and climbing is eight times WORSE**, not better. See
   `TUNING.md`. Do not re-propose iterative deepening here without re-reading
   that measurement first.
