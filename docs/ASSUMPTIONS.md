# The register of unproven assumptions

James, 2026-09-01: *"I feel like we have stuff in the background that is actually
limiting us, and instead of just realizing them while things go wrong I'd rather
fix them now."*

This is that audit. Every entry is a decision that shapes what the planner plays
and was never measured, mostly added as a counterweight when the models beneath
it were weak, and mostly kept long after those models were fixed.

**The single most useful result of the audit is the base rate.** Of the entries
resolved so far, roughly half dissolved on contact with data: they were not
defects at all, and several had been treated as known defects in the docs for
weeks. Suspicion accumulates faster than measurement retires it. Read that as a
warning about this file's remaining entries, not as a reason to trust them.

## Retired by measurement, no code changed

| # | assumption | what the data said |
|---|---|---|
| 3 | pricing scores the foe without `semiSmart`, while live Surge runs all three flag bits | changes the committed choice on **0.0% of 173** realistic positions. May still matter off-Surge. |
| 17a | `turnsOut` is decisions-counted, not game-read, so it drifts | **1 disagreement in 4558** archived consecutive turn pairs. It is correct. |
| 17b | crits might be recoverable from the decision-time RNG seed | best of 32 draw offsets predicts the roll index **27.3%** against a **24.3%** chance baseline, over 835 turns. Not recoverable. |
| 20 | `results.tsv` has 151 rows and no LOSS, so losses are being swallowed | **zero wiped episodes in the entire turn archive.** Two independent instruments agree: there have been no live losses on Surge. |
| 8 | the replacement port "does NOT reproduce the Bellibolt observation" (docs, for weeks, on ONE observed event) | graded against **all 425** archived replacement events: **76% top-1, 89% top-2, against a ceiling of 80%**, because 26 of 106 contexts are genuinely stochastic. The pinned failure is a coin: Manectric 19 / Pawmot 16 over 35 identical contexts. Four points of headroom total. |
| - | "a graded lookahead penalty was tried live and nearly wiped the team" | the arm is `ee478e7` on an unmerged branch whose own message begins PARKED, UNVALIDATED; **one** of 151 results rows carries it and it is a **WIN**; the version stamp shows it ran for at most the last ~97s of one episode. The claim first appears in a doc rewrite two days later. |

## Fixed, measured, and earned its place

| # | change | evidence |
|---|---|---|
| — | `RR_ENTRY_MODEL=confident` (James's ruling: trust the prediction, hedge only when a genuinely uncertain choice would be **fatal** to the incoming Pokemon) | pooled over two independent paired runs, 180 episodes: wins dead level (p=1.00), **zero-death 11 vs 2, McNemar p=0.0225**, mean survivors 0.41 → 0.68. Replicates separately (6-1, then 5-1). **The one change that has earned a live trial.** |
| — | five AI-port rule fixes (stale-struct filter, incoming-damage, KO gate, drain-after-standing, Thunder Wave vs Ground) | port **61% → 79% exact, 77% → 90% argmax**; per-matchup committed-choice accuracy 81% → 84%, with a standing instrument that separates a ceiling from a defect |
| — | `path.ahead` was always 0 for every returned path | the panel's line verdict compared on immediate cost alone, the turn log printed "rest of the fight 0.00", and the bias measurement returned a perfect zero on 1608 rows. Decisions were never affected. |

## Refuted

| # | claim | result |
|---|---|---|
| — | the whole-fight gameplan (arm D) would benefit most once the value model was fixed | **12/100 against 29/100, p=0.0076.** It lost *worse* on the improved stack. Fifth independent confirmation that more commitment to the model loses even as the model improves. |
| 1 | reading THEIR damage at the top roll is "the last untested member of the pessimism family" | median-roll pricing scores 20/100 against 29/100 with zero-death 7 → 1. The top-roll reading is **load-bearing**. Hedging what the opponent *chooses* was wasteful; hedging how hard they *hit* is protective. |

## Implemented, flagged off, still unmeasured

`RR_NO_DOUBLE_BOOK` (#10), `RR_LOOKAHEAD_SEES_US` (#12), `RR_TIE_MODEL` (#13,
and note it shipped **default-on** and unmeasured, which was a mistake — it is an
arm in the queue and comes out if it does not earn its place), `RR_RISK_WEIGHT`
(#9), `RR_FOE_ROLL` (#1, refuted above), `VETO=1` (#4, the harness emulation).

**#4 CLOSED, opposite to filing — the veto is a KEEP and the strongest single
lever measured.** First measurement ever (harness emulation, both arms on
confident entries): initial block 15/60 vs 8/60; independent replication block
**29/60 vs 13/60, p=0.0037, with 15 of 60 episodes meeting the cap** (win losing
nobody). Pooled over 120 paired episodes: wins veto-only 34 vs control-only 11,
**McNemar p=0.0008**, zero-faint 20 vs 5. The referee's verdict line: BEATS
CONTROL — the only arm of the week to earn it. The "external reflex over a
priced market" framing was wrong: the market prices a lethal turn as a weighted
average and will still play it; the veto refuses the concrete lethal turn.
Expected value at plan level plus a stop-loss at execution level beats either
alone. Caveats: the emulation fires ~14% vs ~10% live and judges with maxroll
dice rather than the live one-turn scorer. Seventh register entry to flip on
contact with data.


## Deliberate risk changes, and how they would show up if wrong (2026-09-02)

Both landed after the first rehearsal fight, where a 6 HP Froakie was left in
front of a Metronome Clefairy and a 15 HP Froakie in front of a Low Sweep that
crits for roughly double, with five healthy Pokemon on the bench.

### 1. An unsupported foe move is priced as a generic attack

`rr-battle.js` used to return from `executeMove` for the five moves marked
`unsupported` (Assist, Me First, Metronome, Sleep Talk, Transform), so their
user could not act at all. Theirs is now priced as a neutral attack near the
table's mean damaging power, 65.8 over 792 damaging moves: Horn Attack (65) or
Round (60) by their better attacking stat, and Aqua Cutter/Brine when the
defender is a Ghost, since a Normal stand-in would be an immunity and put the
harmless reading straight back. OURS still does nothing, so the planner never
builds a line around a move it cannot model.

Prevalence: 83 of 3167 trainer Pokemon, across 44 of 464 trainers.

**How it would show up if wrong:** a Metronome or Sleep Talk user reading as a
serious attacker and drawing switches it does not deserve. It is an AVERAGE, so
it will still under-read the turn Metronome rolls something huge.

### 2. Risk appetite is set by how hard THEIR TEAM is

James's rule: "that type of crit risk is fine in actual hard battles, but I
don't want to lose my greninja sometime later because every fight we are putting
it at crit risk", and, rejecting a first version keyed on a body count: "that
shouldn't be a rule. You should classify match difficulty according to the level
of difficulty of the opponent team."

The death check (`decide` in agent.js, and the harness veto) asked "does this
kill me on their MEDIAN roll", with no crit, so a Pokemon in one-crit range read
as safe. Now `lib/difficulty.js` classifies the fight off the duel table this
project already builds -- for each Pokemon still on their side, how many of ours
kill it at no more than 10% chance of fainting:

    easy    every one of theirs has 2+ such answers -> their top roll AND a crit
    normal  one has exactly 1                       -> their top roll
    hard    one has none                            -> the median, as before

Living Pokemon only on both sides, so no separate rule about our own numbers is
needed: down to one Pokemon nothing can have two answers, so the fight cannot
read easy however weak they are. Cached per alive-set; a full 6x6 costs ~2.8s
and is rebuilt only when somebody faints.

**HP cost is deliberately not part of a "clean answer".** The first version also
required cost <= 60%, and it misread Lass Anne -- among the easiest fights in the
game -- as `normal`: Fluffy makes Stufful expensive for a level 15 team, so
Froakie's kill at 63% and Sandshrew's at 61%, both at ZERO death risk, were
thrown away and Stufful looked like it had one answer. Cost is what a plan pays,
risk is what it risks, and only the second belongs in this decision. Verified
after: Lass Anne reads easy (weakest link 3 answers), Giovanni reads normal
(Infernape, 1 answer).

**IT DID GO WRONG, on the first live fight, and crits are now out (2026-09-02).**
Not by the predicted switch-loop but by a worse route: Metronome, freshly priced
as a generic attack by change 1, was then read at their top roll AND a crit,
so a level 10 Clefairy became unanswerable. The planner priced beating it at
100% death, asked the panel which two to give up, got no answer in 300 seconds
and played on, losing Scraggy. Two pessimisms multiplied is not caution.
`deathRisksFor` now fears only the ROLL -- top roll for easy and normal, median
for hard -- which needs no calibration. `RR_CRIT_RISK=1` restores the crit
reading for whoever picks it up. Separately, a substituted stand-in is now read
at the FLAT middle roll (`ctx.flatRoll` in rr-battle.js): stacking maximum
pessimism on top of a guess about a random move is a fiction, not a safety
margin.

**The other way it could still show up:** excessive switching in easy fights. Every
switch is a free turn for them, and a pessimistic death reading makes staying in
look worse than it is; this project has twice had a switch-loop as its main
failure. If that appears, this is the cause. `RR_CAREFUL=off` reverts it in one
move; `RR_CLEAN_RISK=<p>` moves the answer bar. The agent prints
`[fight reads EASY|NORMAL|HARD ...]` whenever the reading changes.
Unmeasured: built from two positions, not a paired-seed run.

### 3. The live agent could only see the fixed-level fights

`earlyBattles` skips every trainer whose levels scale to the player unless given
a `relativeBase`, which is 103 fights against 36. agent.js built its list once
with no base, so `battleOf` could not find Lass Anne at all and `foeTeamFor`
fell back to CLONING the active Pokemon: the agent fought Stufful/Clefairy/Audino
believing it faced three Stuffuls, one showing 46 HP against a 42 maximum. It
planned for a team that did not exist, and could not prepare for a Pokemon it
did not know was there. The list is now built against our own level and rebuilt
when we level up; matching is scored on their party size and levels rather than
first-species-wins, because the longer list makes a common species ambiguous.
Resolved against Lass Anne this gives Stufful 12, Clefairy 10, Audino 12, which
is exactly what RAM reports.

**How it would show up if wrong:** the probe printing a THEIR team that does not
match what is on screen. Worth checking first whenever a plan looks unmotivated.


## 4. The mechanics audit, and what it found (2026-09-02)

James: "are we gonna find problems with every single move in the game... the
possible moves are clear, the possible statuses are clear, the possible boosts
pokemon can have are clear. These should all be solved." Right, so they were
enumerated instead of being found one at a time.

`tools/audit_mechanics.js` is the new acceptance test. It differs from
`audit_coverage.js` in the question it asks. That one asks whether a move has an
effect IN THE DATA; this one asks whether the ENGINE ACTS ON IT, which is not
the same and the gap between them cost a fight. Three checks:

1. every `effect.kind` in the move table has a branch in the engine
2. every field used inside a `secondary` block is read by the handler
3. every volatile the engine WRITES is READ somewhere other than the write

**What it found, all now fixed:** 15 effect kinds with no implementation at all
(Destiny Bond 25 uses, Curse 20, Throat Chop 20, Outrage's lock-in 17, Wish 16,
Roar/Whirlwind/Dragon Tail forcing a switch 15, Fire Spin's trap 14, Shed Tail
14, Trick/Switcheroo, Geomancy, Stockpile, Fickle Beam, Glaive Rush); confusion
never read from `secondary` despite 174 uses across six moves, so Swagger was a
free +2 Attack from the opponent and Water Pulse was plain damage; Dire Claw's
random status; and five volatiles written and never acted on -- `trapped` (a
trapped Pokemon could still switch out), `focusEnergy` (the crit bonus argument
was hard-wired to 0, so the move did nothing), `torment`, `disabled`,
`glaiveRush`.

**Three kinds are the CALCULATOR's job, not the engine's,** and the audit says so
rather than listing them as gaps: `secondary` (handled through
`data.effect.secondary`, not a case label), `physicalDefence` (Psyshock scores
against Defense: 258-304 on a Blissey where Psychic does 57, measured), and
`multiHit` (Triple Dive resolves as 3 hits, measured). An audit that lists
imaginary gaps is one nobody reads.

**Confusion's numbers:** 1 in 3 to hit yourself, a typeless 40 BP physical hit
using your own Attack against your own Defense at the mean roll, lasting three
turns. In maxroll mode ours is budgeted like paralysis and theirs is assumed
away, which is the pessimistic reading for us.

**A mistake worth recording.** The first version of the end-of-turn clocks was
written INSIDE the Magic Guard branch, so curse, trapping, Throat Chop, Outrage
and Wish only ticked for Magic Guard Pokemon. Nothing failed loudly: Audino's
Wish simply never healed. It was caught by a smoke test that watched an actual
HP number rather than by the audit, which is the general lesson -- the audit
proves a mechanic is REACHABLE, not that it is reached on the right path.

**Baseline:** `tools/test_battle.js` had 3 failures before this work and has the
same 3 after (immunity cases that report an `unmodelled` note the test does not
expect). They are pre-existing and unrelated.


## 5. Poison did no damage in the model (2026-09-03)

`statusOf` decoded 0x80 as `tox` correctly, but the toxic COUNTER lives in the
same status word (bits 8-11) and was never read; `createState` starts it at 0
and the tick is `maxHP * counter / 16`, so a badly poisoned Pokemon took no
poison damage in any simulation. Kilowattrel was switched back into the Toxic
user at 68/83, fell to 9 with a 15-point tick due, and the planner priced its
death at 0% while it died to the tick. `toxicTurns(word)` now reads the
counter at every status decode site (active, party rows). Verified on the
archived turn: the attacks score -99.99 and the chosen action is a switch.

Also: the hands-off marker for wild/double battles is cleared only after 600
frames of sustained "nobattle" (doubles flip the main callback between the two
action prompts; the first live doubles fight cleared it 193 times).

## 6. Last Resort had no precondition (2026-09-03)

Komala's set is Protect + Last Resort. Last Resort fails until every other move
the user knows has been used, so Komala's first turn out is always Protect and
the 140 BP hit lands a turn later. The move had no effect entry, so the engine
and the AI port both treated it as usable from turn one and the plan expected
to lose Gyarados to a hit that could not happen yet. Now: `lastResortReady` in
rr-battle.js gates legalActions (which the AI port also uses) and execution;
`volatiles.usedMoves` is written on execution; the live agent fills it for the
opponent from the committed-move byte (credited a turn later) and from PP below
the dex base, reset per opposing party (`foeUsedMovesFor`). Verified: turn one
legal = Protect only, AI scores Protect 100, Last Resort legal after Protect.

## 7. A plan against a Pokemon that is leaving (2026-09-03)

Turn 304: Floatzel on 15 HP, AI byte says SWITCH to Starmie. Every move of
Granbull's kills a 15 HP Floatzel, so the plan took the first in its list --
Fire Fang, into a Water/Psychic -- while the one-turn scorer had Thunder Fang
(super effective on both) on top. The plan's "kill" was fiction for that turn:
the move lands on the replacement. `aimAtIncoming` in agent.js now, when the
byte says switch and the plan says move, plays whichever of our moves does most
to the incoming Pokemon (middle roll, immunities respected); a planned switch is
untouched. Verified on the archived turn: Fire Fang 11 vs Thunder Fang 44 into
Starmie. Note the probe calls the byte stale without history; use "with the raw
switch byte" in its output to see the override.

## 8. Resist berries were never eaten (2026-09-03)

The calculator halves the hit that eats a Chople/Occa/... berry, and for a
multi-hit move only that first hit (Double Kick into a Chople Loudred: 72-84
against 96-112 bare). The engine never marked the berry consumed, so every
later hit of that type was priced halved forever, and the planner would not
lead with Double Kick. `eatResistBerry` in rr-battle.js now sets `itemGone` on
a super-effective hit of the berry's type (Chilan on any Normal hit); the damage
cache already keys on `itemGone`. James: "the berry being gone also has a value
too" -- it does now, because every later leg of a plan is priced bare.

## 9. Three planner faults from the Brennan fight (2026-09-03)

1. **Chip lines could only be built from moves that fail to kill.** The chip
   family filtered duel strategies to `retreat`/`left`, so when every good move
   KILLS the target, the one move that does not was the only chip line left:
   Granbull chipped a full Crawdaunt with Fire Fang, its resisted move, twice,
   while Brick Break, Play Rough and Thunder Fang each removed it. `kill` lines
   now count as chip (chip = 100%); dead lines stay excluded. Replay of turn
   326 now chooses Thunder Fang.
2. **Fake Out was never offered on a switch-in.** `outCount.me`, which sets
   `justEntered`, advanced once per buildState CALL and buildState runs several
   times per decision, so the reads that mattered saw 1. Now once per turn, and
   the emulator's own `turnsOut` wins when present.
3. **Multi-hit damage was counted twice.** `damageRolls` returns a multi-hit
   move as ONE summed lump (the Focus Sash code divides it per hit), and nine
   call sites multiplied it by `hits` again: Double Kick's 99 into a 105 HP
   Loudred became 198, a "kill" that could not happen, and the entry rule
   yielded Fake Out to it. Every site now reads the lump as the whole move
   (policy, duels, candidates, playplan, paths, replan, sim_episodes, agent).
   Replay of turn 322 chooses Fake Out.
4. **The probe lied.** It generated and priced candidates without the
   opponent's current HP or ours, so it priced kills against a full-HP target
   and told a different story from the live agent. It now passes `foeHp`,
   `ourHp` and `foeChip` like the live call. With that, turn 323 (Hitmonlee 47
   vs Loudred 58) chooses Double Kick, kills outright, 0%.

## 10. The planner's opponent had the sheet's stats, not the game's (2026-09-03)

Our active has carried its real RAM stats (`rawStats`) since setFromBattler.
Theirs never did: `foeTeamFor` built the team from the trainer sheet and every
duel and priced plan used the sheet's computed numbers. Brennan's Crawdaunt
computes to Speed 70 from the sheet and reads 50 in RAM; Lanturn is 61. So in
every duel Crawdaunt outran Lanturn, Knock Off killed her before the second
Shock Wave, no "Lanturn kills" line could exist, the market held nothing but
sacrifices, and the agent stopped to ask who to lose while James played
switch-to-Lanturn, Shock Wave, Shock Wave himself. `foeTeamFor` now attaches
the active's rawStats from the battler block (matched to its party row), and
buildState overlays them and the real max HP on the state too. Replays of turns
335/336/337 now produce exactly his line. Bench members still use sheet stats
until they come out, because RAM only exposes the active battler's stats.

## 11. Tied duel lines went to move slot (2026-09-03)

Pawmot at full HP with a Focus Sash: Play Rough leaves 1 HP, Brick Break
leaves 54, both lines "kill in 2 turns at 39%", and the sort had no tie-break
below cost, so array order -- Granbull's move slot -- chose Brick Break. Lines
now record `firstLeft` (target HP fraction after our first turn) and kill
lines tie-break on fewer turns, then lower firstLeft, then higher killOdds.
Replay of turn 389 chooses Play Rough. (This Pawmot's ability reads Iron Fist
in RAM, not Volt Absorb; Electroweb into it is a real hit.)

## 12. Purposes other than damage (2026-09-03, James's design)

James: "Your planner only cares about what our pokemon can do there, not why
it is actually sent there." A job could only be damage or a lever on their
state, so a turn stolen (Fake Out) or a hit taken cheaply so the finisher
enters free had no shape to be written in, and a plan that cannot be written
cannot be found. Added in candidates.js:

- **5. Openers**: a Pokemon with an entry-only flinching move heads a plan as
  `{move, until: {uses: 1}}`, followed by another Pokemon's kill line or by
  itself continuing. Priced by the full simulation like everything else.
- **6. Taking the hit on purpose**: a Pokemon that takes their strongest move
  for at most 25% (immunity, absorb, heavy resist -- the same damage reading
  safestPivot uses) can be sent in as `{'*', until: {uses: 1}}` and hand over.
- Softeners in a relay are chosen by net value (chip minus own cost), not raw
  chip, so a free opener beats a 56%-for-56% trade.
- Three enabling fixes: an entry-only move's duel line ends as `left` (hand
  over) instead of `nomove`; a Fake Out played by the entry interject now
  advances the job's step counter; RR_CARRY_PROGRESS is ON by default (off
  with `=0`), because "do this once, then hand over" cannot exist otherwise.
- A fight that does not read easy gets more generation (`ctx.deep`: an extra
  retreat level), and the emulator side waits 180 s for an answer, not 60.
  Measured decision time: ~12 s on the hard Vikavolt turn, ~6 s on an easy one.

**What it says about James's Vikavolt line** (switch to Hitmonlee, Fake Out,
Dugtrio Rock Blast): now generated and played through -- Hitmonlee eats a Bug
Buzz on entry, Fake Out lands (Vikavolt 84%), Dugtrio enters into a second
Bug Buzz (54%), one Rock Blast (3 hits) leaves Vikavolt at 20%, and Mud Shot
removes Dugtrio before the second. Priced as losing Dugtrio 96%, so the
planner keeps "Kilowattrel Roost/Air Slash chip, then Dugtrio finishes for
0%". Live it worked; a 4- or 5-hit Rock Blast (about 30%) or a different AI
choice would do that. Unmeasured beyond these replays.

## 13. What the Vikavolt race exposed (2026-09-04, James's rules)

James beat a Roosting Vikavolt with Kilowattrel by clicking Air Slash: "roost
will eventually run out of pp and air slash can flinch." The model could not
see that line for three reasons, all fixed:

- **Their live PP now reaches the plan.** The emulator reports PP every turn;
  the planner built the opponent from the sheet with full PP, so Roost never
  ran out. buildState copies PP BY MOVE NAME (slot order differs between the
  sheet and RAM) and foeTeamFor attaches `pp` to the active's set;
  createState honours `set.pp`. Vikavolt reads Roost x3, not x8.
- **Our secondaries fire at their real rate inside a priced line.** In maxroll
  mode ours never fired, so a faster Air Slash user got nothing for a 30%
  flinch. Now an expectation accumulates per move on the state (`secAcc`) and
  fires when it crosses 1 -- the fourth 30% click. Same idea the burn levers
  already used ("a 30% burn clicked four times is a 76% burn").
- **A stall we are not losing runs on.** Duels stopped at 12 turns and priced
  lines at 16; a grind that wins on PP or flinches read as nothing. Both now
  extend once (to 24 / 28) when our active still holds half its HP at the cap.

Also this session: **bait** (family 7: "Gyarados baits Electric, Lanturn
absorbs it and heals, then ..."; the AI port is asked what it throws at the
bait, not assumed), **quick answers** (a clean kill in hand, or Fake Out on
the turn we arrived, is played without running the market), duel simulations
shared within one generator call (45 s -> ~30 s on a gym turn), and deeper
generation only on fights that read HARD. All unmeasured beyond replays; the
live test is James watching mGBA.

## 14. Caitlin's Assist team (2026-09-04)

Picnicker Caitlin, Route 9: Smeargle @Choice Scarf (V-create, Dragon Ascent,
Trick, Close Combat) and three Pokemon that know only Assist -- Spinda
(Contrary), Sneasel-Hisui (Eviolite), Liepard (Prankster, Focus Sash). Assist
was an "unsupported" 65-BP stand-in, so three 180-BP users read as harmless.
Now in the engine: Assist calls a move from the rest of the party minus the
game's excluded list (strongest callable against the target when pricing,
random when sampling); Prankster gives status moves +1 priority and a
Prankster-boosted move, including an Assist calling an attack, fails against a
Dark type (James's rule); Contrary inverts every stat change on the holder;
Choice items lock the holder into its first move until it leaves, and the lock
follows a Tricked item. Verified: Liepard's Assist V-create at priority takes
Kilowattrel 102 -> 35; Spinda ends its V-create at +1/+1/+1; Trick leaves us
Scarf-locked; a Dark type takes nothing from Liepard. The fight reads HARD:
Spinda has no clean answer on the current team.

## 15. Was the engine told the truth about every move? (2026-09-04)

James: "You should know every possible move in the game basically."
`tools/audit_moves.js` checks each move's ROM description against what the
effects table and the calculator encode for it (priority, multi-hit, recoil,
drain, flinch, status, stat changes, traps, charge turns, OHKO, self-KO, ...),
weighted by trainer usage. First run: 108 carried moves with an unencoded
claim, 968 uses. The gaps were mostly DATA: a secondary chance in the ROM with
nothing saying what the secondary is -- Zap Cannon never paralysed, Inferno
never burned, Poison Fang never badly poisoned, Tri Attack did nothing, Hyper
Fang/Astonish never flinched, Smog/Poison Sting never poisoned, Flatter and
Feather Dance were blank, Scale Shot never boosted, Memento never dropped
stats, Thrash/Petal Dance never locked. All curated now. The engine gained
what it truly lacked: recharge turns (Hyper Beam, Giga Impact, Roar of Time),
two-turn charges with their charge boost and semi-invulnerability (Meteor Beam,
Solar Blade, Skull Bash, Phantom Force), and Focus Punch's fail-if-hit. Each
was executed turn by turn to confirm. Remaining flagged rows are mostly the
audit's own false positives (screens read as "stat change", Facade/Venoshock
handled by the calculator, Destiny Bond/Explosion self-KO handled via
mechanics); the honest residue is small and listed by `node tools/audit_moves.js`.
Not modelled and worth knowing: Battle Bond's Ash-Greninja form change (the
calculator knows the form; the engine never switches into it).

## 16. A switch needs a reason (2026-09-04)

The planner recorded a "switch margin" and never acted on it: a tie between
"kill it now" and "bring Hitmonlee in, Fake Out, bring the killer back" went to
the switch, and Hitmonlee was walked in, hit, and walked out for nothing
(Gyarados vs a 25 HP Ivysaur, turn 465). Now leaving the field must beat
staying by RR_SWITCH_MARGIN (default 0.5, the bar the log already used for
NEEDLESS) on the full criterion, or the stay line is played. The opener line's
generation-order discount is gone. Fake Out on the turn Hitmonlee ARRIVED is
still played at once (James: "almost no matter what"), yielding only to a
clean kill in hand.

## 17. Their party is read from RAM now (2026-09-04)

Opponents were identified by matching the active's species and their party's
levels against the 167-fight sheet, which only has bosses. A Rock Tunnel
Pokemaniac's Flareon (Fire Fang, Fire Spin, Scary Face, Smog, Flash Fire) was
matched to Professor Oak's postgame Flareon (Sacred Fire, Last Resort, level
44). With the wrong set the AI port had no prediction, every line priced
identically with an empty log, the quick kill could not fire, and Greninja
spent two Icy Winds and a switch on a 65 HP Flareon that one Water Shuriken
removes. The raw dex trainer table did not help either: its Cooprt Flareon
also lists Sacred Fire, so it does not describe James's ROM as played.

gEnemyParty is laid out like our party and unencrypted, so the Lua now ships
each opponent record raw and `foeRosterFromRAM` decodes species, level,
nature, ability, item, moves, EVs and IVs for all of them. The sheet is the
fallback only when the raw records are absent or do not contain the active.
Trainer identification now also scores the active's visible moves, for the
fallback path. Also: Battle Bond transforms Greninja into Ash-Greninja inside
the engine after a KO, so a plan sees the form coming; the live agent already
read the form from RAM once it had happened.
## Open, and James's to decide (gameplay)

- **#2 status moves are priced as sacrifices.** `until: {foeStatus:'brn'}` is
  unsatisfiable in the deterministic pricer, so "Scald until burned, then close"
  prices as Lanturn 139 → 63 → 2 → **dead**, outcome `kill`, deathRisk 1.00. It
  does not undervalue the burn; it converts the plan into a sacrifice and the
  market then correctly rejects it. Options: stochastic pricing (breaks the
  stability the honest-dice work bought), fire only theirs (the assume-the-worst
  family, just overturned), or report status as a probability the way `deathRisk`
  already is (recommended). Interim guard worth having either way: make an
  unsatisfiable `until` fail the leg rather than grind the Pokemon to death.
- **#5** `RR_CARRY_PROGRESS` default. Multi-move legs still replay move 0 forever
  live, and use-count handovers never fire, so typed panel lines of 2+ legs only
  ever run their first leg.
- **#7** the priced opponent never voluntarily switches.

## Known, accepted, on the record

TEMPO=0.4 is fitted on Surge and its flat-per-turn shape means a death is worth
15 turns at whole-fight horizons; `turnRate()` already implements the derived
alternative and has never been A/B'd. The flat 8 is measured load-bearing in
both directions and dissolves only when the optimism it counterweights does
(#10). STICK=0.75 cannot resist 8-point score flips and is downstream of #10/#12.
Mega evolution is unmodelled. Roughly 849 AI scoring sites are unported, so
off-Surge port accuracy is simply unknown. And the harness opponent is our own
port, which flatters `confident` by construction — live remains the only
authority.
