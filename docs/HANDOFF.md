# Handoff -- 2026-09-01 (final for this session)

## UPDATE 2026-09-05 (away-work loop, latest): s5 runs analysed, seven fixes

Retrievable version before this work: tag `pre-planner-2026-09-05` (commit
6394334). Work so far: commit 8d52c2f. Test protocol James set: change, then
play s5 (Surge) LIVE, then `node tools/analyze_fight.js ~/rr-agent/turns/<dir>`
and read WHY each move happened, not the death count.

Run 1 (old code, EXPENDABLE nobody, 20 s panel timeout): WIN losing Lanturn.
Lanturn was thrown away at turn 535: an 18 HP Lanturn "absorb pivot" into a
fresh Pawmot, priced as a certain loss and 0.6 cheaper than staying, because
the rest-of-fight estimate charged a PROJECTED later death the same 6 as a
certain one now (die now == maybe die later). Nobody answered the panel, and
the timeout played the plan's own sacrifice. The Baby-Doll Eyes line that
followed killed Pawmot losing nobody.
  Also found: Bellibolt's Hidden Power priced as a neutral 60-power hit (16%)
  and it did Hidden Power Grass for 32%. The RAM roster ships the move as bare
  "Hidden Power"; the IVs are in the same record.

Run 2 (escalation + timeout fix + projected-death discount, before the other
fixes): WHITEOUT, all six lost. Mienshao died to a crit Thunder Punch from 84
HP (Pawmot at -1 Attack; crits ignore the drop; James has said to ignore crits)
and with it the only Vikavolt answer. Then: Bulldoze twice into a Levitate
Vikavolt for "their spe -1" (the lever gate only asked about status immunity);
"slp, then Victreebel kills" shipped as a bare Mega Drain because the killer's
own Sleep Powder job was filtered out of the plan; a sleeping opponent was given
exactly ONE lost turn in every engine mode, so no sleep line ever priced as
worth anything; the timeout/standing-choice chain accepted a sacrifice every
turn once every option on the table lost somebody.

Fixes (all in 8d52c2f):
  - replan.js: zero-death escalation -- when the cheapest line buries a
    non-expendable, generate wider (escalate:true, maxStack 4, perKiller 8),
    price, re-sort; log line `[zero-death search: ...]`.
  - gameplan.js: projected deaths charged AHEAD_DEATH = 3 (RR_AHEAD_DEATH).
  - agent.js: panel timeout takes the cheapest option that loses nobody, the
    plan only when every option loses somebody.
  - agent.js: foeRosterFromRAM types Hidden Power from IVs (hiddenPowerType);
    verified against the known Surge sets (Pincurchin Ice, Bellibolt Grass,
    Manectric Grass).
  - candidates.js: leversUsable -- a lever move that the engine reads as
    immune against this foe kills the condition (Bulldoze vs Levitate);
    RR_DEBUG_LEVERS=1 prints every lever duel; the killer's own lever jobs are
    kept in the plan.
  - rr-battle.js + duels.js: sleep is 1-3 lost turns. `sleepTurns` now counts
    turns already lost, `sleepMax` is set when the length is exact (Rest 2).
    maxroll: foe loses 2 (ctx.risks.sleep overrides), ours 3; odds forks on
    1/3 then 1/2; worst: foe 1, ours 3; sample draws.

Run 3 (all seven fixes): WHITEOUT again, and it replayed run 2 move for move
up to Mienshao's death -- same crit, same turn, same HP. From a save state the
game RNG is deterministic under identical input frames, so a rehearsal run
replays one unlucky roll unless the timing varies. Fix: agent.js sleeps a
random 0-900 ms before writing cmd.json (RR_JITTER_MS=0 disables). After the
crit the post-Mienshao position (Vikavolt with no answer) produced the known
switch churn (7 switches in 10 turns) and a death-veto fallback that sent a 15
HP Lilligant into Vikavolt.

Run 4 (jitter on, ability byte): WIN losing Lilligant and Mienshao. No crit
replay. Both deaths were the death veto's DODGE: it took the first one-turn
option that did not die this turn, which was a 14 HP Lilligant (turn 627) and
a 29 HP Mienshao (turn 632) sent in as dodges. Turn 634: the veto chose Detect
and the timeout-accepted "standing choice" put the losing Rock Tomb back.
Fixed after the run: the dodge prefers a switch-in at >=35% HP; a timeout's
acceptance never overrides the veto (only a hand choice does); family 2 now
emits both orders of a two-lever setup (sleep first, then Baby-Doll Eyes).
Run 5 = those three.

Run 5 (veto floor, timeout/veto order, both lever orders): WIN losing Breloom
and Lilligant, 42 turns. Pawmot handled cleanly again (Fake Out breaks the
sash, three Drain Punches, nobody lost). Vikavolt phase (turns 662-672) was
churn: Mienshao switched in THREE times to Fake Out as a "chip leg" (98 -> 31
HP), an absorb pivot handed Vikavolt a free Roost (turn 669), Sleep Powder
missed once. Breloom died on a median-roll bet (fight read HARD) against
Pincurchin; Lilligant died as a forced dodge when Lanturn sat at 2 HP after
using Confuse Ray into a Bug Buzz. Fixed after: chip legs may not consist of
Fake Out alone (candidates.js family 4).

Scoreboard on s5, all live: run 1 (old code) WIN -1 | run 2 WHITEOUT | run 3
WHITEOUT (same crit replayed) | run 4 (jitter) WIN -2 | run 5 WIN -2. The
crit-free runs win; nobody has reached James's cap (nobody but Lilligant), and
zero deaths has not happened. The Pawmot sequence is now stable; Vikavolt is
where the deaths and the churn come from.

NEXT PLAN (in order):
  1. Run 6 on the current code; read the Vikavolt phase turn by turn.
  2. Absorb pivots against a Pokemon with Roost/recovery: a free turn is a
     free heal, so the pivot must be priced with the Roost (it is: the AI port
     re-decides in the sim -- check whether the committed Volt Switch is what
     the sim assumed at turn 668/669 and why).
  3. A dying Pokemon's last move should serve the successor (Sleep Powder
     over Sludge at turn 593 of run 2): let the veto's "all options die"
     branch prefer a status move that lands before the hit.
  4. The damage-vs-live gap around Pawmot (open measurement above).
  5. Churn: count switches per fight in analyze_fight and add the incumbent
     STICK only if the count stays high after 1-3.

Run 6 (absorb gate not yet in): WIN but FOUR lost. Cascade from turn 695:
the market ranked a line losing nobody (here 6.35, rest-of-fight 18.0) below
one that buried Lilligant (here 12.56, rest 9.5) -- a certain death now bought
with the flat no-answer penalties of a fight not yet played -- then the veto
dodge sent Lanturn into Hidden Power Grass, Victreebel into Flame Burst, and
the bodies followed. FIX: RR_DEATH_LAST (default on, replan.js): lines that
bury a non-expendable rank below every line that buries nobody, in the
finalist pick, the final sort, and the switch-margin rule. Verified offline at
695: the no-death line is chosen. Also: absorb pivots (family 3) now ask the
AI port what it throws at OUR ACTIVE and are dropped when it is not the
absorbed type (Vikavolt Roost); generator calls carry `active`.

Run 7 (all of the above): WIN losing only Mienshao -- the best run yet, and
zero deaths was ONE HP away: Lanturn Scald 34 + Fake Out 18 + Rock Tomb 51
left Vikavolt at 1/104 and Bug Buzz took the 23 HP Mienshao. Pawmot and
Manectric-Mega were both handled losing nobody (Diggersby Bulldoze, Breloom
Bullet Seed + Mach Punch).

Scoreboard s5 live: 1 old WIN-1 | 2 WIPE | 3 WIPE | 4 WIN-2 | 5 WIN-2 |
6 WIN-4 | 7 WIN-1.

NEXT PLAN:
  1. Kill legs that hinge on a coin-flip roll (turn 742: Rock Tomb 47-55 vs
     52) should carry their miss branch; check what deathRisk/killOdds said
     for that leg and whether a safer finisher existed (Breloom was full).
  2. Run 8 unchanged to see variance now that the RNG is jittered; two more
     runs before believing any single result.
  3. Items 3-5 of the previous plan (dying Pokemon's last move, damage-vs-live
     gap, churn count).

Run 8 (same code as run 7, jittered RNG): WIN, NOBODY LOST -- the first
zero-death Surge live. Sequence: Lanturn handles Pincurchin/Bellibolt; Lilligant
Baby-Doll Eyes into Pawmot then out at 14 HP; Mienshao Fake Out (sash) + three
Drain Punches; Manectric-Mega: Lanturn pivot, Diggersby Bulldoze x3 (61 -> 12);
Vikavolt: Victreebel Sleep Powder, then Mienshao/Breloom alternating Fake Out,
Headbutt and Rock Tomb while it Volt Switched and Roosted; Breloom Bullet Seed
took Pincurchin; Rock Tomb finished Vikavolt from 33. Still visible: Mienshao
entered three times for Fake Out (turns 768/772/776) via dodges and "(no plan)"
quick answers, not via chip legs -- it worked here because Vikavolt kept
pivoting, but it is the same cycle James dislikes.
Between runs 7 and 8 one more rule went in (agent.js, untested live): when
every option dies, the last move is a Sleep Powder/Thunder Wave that lands
first, for the successor.

Scoreboard s5 live: 1 old WIN-1 | 2 WIPE | 3 WIPE | 4 WIN-2 | 5 WIN-2 |
6 WIN-4 | 7 WIN-1 | 8 WIN-0. Runs 7 and 8 are the current code; variance
between them is one Rock Tomb roll.

PROCEDURE NOTE: agent-node.log is overwritten on every restart, and the logs
of runs 7 and 8 were lost that way. At the end of a run copy it into the run's
turns dir (`cp ~/rr-agent/agent-node.log ~/rr-agent/turns/<dir>/`);
analyze_fight.js now reads it from there first. It also prints a CHURN line:
runs 1/5/7/8 = 29/32/30/33% voluntary switches, plan text changing on most
turns (the why-strings carry HP percentages, so that count over-reads).
Run 8's three Mienshao entries were all death-veto dodges after the plan had
put Breloom or Victreebel in front of a Bug Buzz; whether plan and veto judged
that hit with different dice could not be checked without the log.

Run 9 (unchanged): zero deaths again, and the Vikavolt phase replayed run 8
roll for roll (Headbutt 30, Fake Out 17/18/23, Rock Tomb finish) despite the
0-900 ms brain-side jitter. Conclusion: this ROM's battle RNG is consumed per
call, not per frame, so from a save state the fight is deterministic GIVEN OUR
ACTIONS. Runs 2/3 (same crit) and 8/9 (same win) are the evidence. So s5 is a
reproducible puzzle: a different outcome needs a different decision, and two
identical runs prove nothing about variance. Jitter stays (harmless).
Scoreboard s5 live: 1 old WIN-1 | 2 WIPE | 3 WIPE | 4 WIN-2 | 5 WIN-2 |
6 WIN-4 | 7 WIN-1 | 8 WIN-0 | 9 WIN-0.

NEXT PLAN (after run 9):
  1. s5 is solved and deterministic; keep it as the REGRESSION test (a change
     that breaks the zero-death line shows up as a different sequence). For
     new findings a second save is needed -- James's s3 position or an earlier
     rehearsal save. Ask him which fight; do not pick one for him.
  2. The Vikavolt loop (run 9 turns 797-806): the market prices every line as
     losing somebody because Bug Buzz is read at its top roll, the timeout
     accepts, the veto rescues, Mienshao dodges in and Fake Outs. Make the
     tactic deliberate: a "Fake Out on the turn they pivot" opener that the AI
     port's Volt Switch prediction can price, so the plan says it instead of
     the veto stumbling into it.
  3. Unattended asks: when every option loses somebody the timeout takes the
     plan; consider taking the option with the fewest/least valuable deaths and
     logging it as a decision James should review.
  4. Coin-flip finishers (run 7 turn 742) and the Pawmot damage gap remain.

Tick after run 9 (James active at the machine, no live run): Mienshao has
REGENERATOR, so its Fake Out cycle heals 32 per switch-out -- the classic Fake
Out pivot, and the reason its HP kept rising between entries. The chip-leg ban
now exempts Regenerator users (candidates.js). Across turns the cycle still
comes from re-planning + the veto, since a chip chain cannot use one Pokemon
twice. Unattended asks where every option loses somebody now take the option
losing the FEWEST (agent.js). Both untested live: s5 is the regression test
for the next idle window (a changed sequence = a change to read).

DAMAGE AUDIT (new tool `node tools/audit_damage.js <turns-dir>...`, runs 7+9):
every hit of ours is inside the engine's 16-roll range EXCEPT
  Mienshao Drain Punch -> Pawmot: 40 and 32 vs 52-63 (77% / 62%), both runs;
  Lanturn Scald -> Bellibolt: 45 and 41 vs 33-40 (over by 3-12%), both runs.
Fake Out -> Pawmot 22 (19-23), Bulldoze -> Manectric-Mega 40 (36-44), Rock
Tomb -> Vikavolt 51 (46-56), Headbutt/Bullet Seed/Scald elsewhere all exact.
So it is not stats, level or a global formula; it is something about Fighting
damage into Pawmot (and a little extra special damage into Bellibolt). For
James: check Mienshao Drain Punch vs Surge's Pawmot on the RR calc site / in
game; if the site also says 52-63, the ROM's Pawmot differs from the data
(typing, ability or item). Until then every "Mienshao kills Pawmot in N"
line is one hit optimistic. Verified: the foe records' calculator stats equal the
live battle stats exactly (Pawmot 91/61/92/54/54 Jolly, Bellibolt 51/82/44/82/70 Bold),
so both sides' inputs are right and the gap is in the ROM's damage mechanics.

Audit over ALL of today's runs (deterministic, so each row repeats): the only
systematic shortfall is Mienshao Drain Punch -> Pawmot, 32/39/40/42 vs 52-63
(62-81%), the second hit of each fight always the lowest (32). Scald ->
Bellibolt is 45/41 vs 33-40 in every run (a fixed +12%, not six crits). Bullet
Seed rows read UNDER because the range is the full multi-hit lump (2-5 hits
vary). Shock Wave -> Pincurchin reads OVER because the record decodes its
ability as Lightning Rod (PID slot) while the ROM's is Electric Surge (Terrain
Extender confirms) -- the live agent uses the battle byte, the audit uses
records. Not explained by STAB, typing, Iron Fist, stats or level; parked for
James's in-game check.

INCIDENT 2026-09-06 ~02:00-02:25 (night, James away, display asleep): the Lua
heartbeat had stopped at 23:14 (unexplained; James was active then -- likely
the scripting console/window was closed), so F5 via System Events did nothing.
While chasing it I triggered the Lua's restart path (restart marker +
load.txt + touch ~/rr-agent/reload) and mGBA quit at 02:17 (config rewritten =
clean quit); cause not pinned. The display was asleep/locked, so no window
could be driven. Relaunched headlessly with `mGBA -t RadicalRed.ss3 <rom>`
(the -t/--savestate flag loads a state at start; there is NO --script flag),
so James's game is on s3 but the agent script is NOT loaded: he must do
Tools > Scripting > File > Load recent script (bootstrap.lua) before the
agent can play. Rules learned: check the heartbeat mtime before any live run;
the bootstrap reloads on `touch ~/rr-agent/reload`, not on the script's
mtime; the Lua's restart path reseeds the game RNG (real variance), the F5
route does not.
No run 10 happened; the Regenerator/fewest-deaths changes remain untested live.

Instruments added: `RR_PROBE_DMG=1 RR_PROBE_DIFFICULTY=gen` prints every move
of ours vs their active and their moves vs each of ours (16-roll ranges, no
items/berries); the pricing log (RR_PROBE_LINES_MATCH) now carries `fs` (foe
status + sleep turns taken), `fa` (real foe active @HP) and `nu` (new engine
notes) per simulated turn. Verified with them: the engine's "Bulldoze did
nothing" was Diggersby's Sitrus Berry masking hit sizes plus Pawmot's top-roll
Drain Punch healing 45 vs Bulldoze's 44 -- correct, not a bug.

OPEN, measured not fixed: live hits around Pawmot ran 10-30% under the
engine's ranges in both directions (our Drain Punch 42 live vs 52-63; Pawmot's
Ice Punch into Lilligant 50 live vs 56-66 with Natural Cure) while Fake Out
matched exactly. Also: the RAM party record decodes Pawmot's ability as Natural
Cure (PID bit rule; hidden abilities cannot come from it) while the gBattleMons
ability byte says 93 = Iron Fist. The active's true ability should come from
that byte (foeTeamFor does not override it yet). Manectric-Mega Flame Burst vs
Victreebel: engine 64-75, one live hit 45. Do a controlled live comparison
before touching the calculator. Instrument check done: the calculator's stats
for all six of ours (from the RAM records) equal the live battle stats exactly,
so the gap is not an input problem. Live Drain Punch (both sides) equals the
engine's no-STAB figure; Scald, Bug Buzz, Hidden Power Grass and Fake Out match.
The active foe's ability now comes from the battle struct byte (Iron Fist).

Known and left: at turn 565 of run 2 (post-crit) no zero-death line exists in
the planner's eyes; Breloom's Spore is the human answer but Breloom cannot
switch into Bug Buzz, so it is only reachable off a free switch. Manectric-Mega
Flame Burst vs Victreebel: engine 64-75 with RAM stats, the one live hit seen
was 45 (turn 561, possibly pre-mega stats that turn) -- unverified.

## UPDATE 2026-09-01 (latest): Sucker Punch fixed, team v4, 57/60

James's two corrections after the v3 run: Alakazam cannot have Focus Blast by
the Rocket Hideout (TM availability is NOT in the dex; treat every TM pick as
an assumption to list for him), and Sucker Punch must fail against a switch.
Done: `rr-battle.js` now fails Sucker Punch/Thunderclap when the target
switched, used a status move, or already moved (runTurn exposes both actions
as `ctx.actions`); `TRACE=1` prints a "dice:" line after any turn with a miss,
a crit, or a failed Sucker Punch (`opts.events` sink on step). Team v4:
Alakazam Psychic/Shadow Ball/Psyshock/Energy Ball, Gyarados
Waterfall/Crunch/Ice Fang/Aqua Tail, rest as v3. Result, same flags:
**57/60, 32 zero-faint, 3 wipes** (seeds 220813, 236651, 395031). Clean win
with zero dice events: seed 125785, 16 turns. Loss 395031: a Pyro Ball crit
removes Annihilape, then five switch turns into a full-HP Infernape bleed
Gyarados and Greninja, then Veluza cleans up. Parental Bond still missing
(unfixed, flagged twice). Also unmodelled: multi-hit moves always land the
calculator's default 3 hits (Water Shuriken never rolls 2 or 4-5) and Battle
Bond's +1 after a KO never happens; in seed 125785's last turn the two errors
cancel (real game: 2 boosted hits still remove a -1 SpD Infernape).

## UPDATE 2026-09-01 (late): the legal Giovanni team, measured

Team file rebuilt from the dex learnsets (level-up <=47 or TM only, nothing on
harness.js RESTRICTED_MOVES): Annihilape Bulk Up -> Stomping Tantrum and
Defiant -> Vital Spirit, Alakazam Recover -> Energy Ball, Gyarados Dragon
Dance -> Earthquake. Same flags as gio60b (VETO=1, SEED=7000, 60 episodes):
**56/60 wins, 35 zero-faint, 4 full wipes** (seeds 94109, 157461, 434626,
450464; per-episode CSV in the session scratchpad, gio60c.csv). Between the
invalid v1 (60/60) and invalid v2 (49/60).

Two instrument gaps surfaced by tracing seed 450464, both UNFIXED and both on
this fight's roster:

1. **Sucker Punch never fails.** `rr-move-effects` has `effect: null` for it,
   so it is a plain +1 priority 70 BP hit. It struck Lanturn for 55% and
   Gyarados for 21% on SWITCH turns, which in the game are free switches. This
   flatters Honchkrow (Scope Lens + Super Luck), who took four of ours in that
   seed.
2. **No Parental Bond.** Kangaskhan-Mega's sheet set carries "Inner Focus" and
   the engine has no mega-ability swap; its Fake Out on Alakazam matched a
   plain single-hit 63 exactly. Kanga is under-stated by roughly a quarter.

Fix both before reading the four wipes as planner failures. The switch-loop
pattern (49% switch rate, Gyarados -> Greninja -> Gyarados -> Mienshao into
Drill Peck) is real regardless and is the same "no answer to the wall" class
as the Orthworm finding below. Trace HP columns show the state at the START
of each turn.

## READ THIS FIRST: corrections from the last hours of the session

1. **RESTRICTED MODE.** James plays Radical Red's restricted mode and both
   Giovanni test runs used ILLEGAL team builds: v1 gave Annihilape Drain Punch
   (unobtainable), v2 replaced it with Bulk Up and kept Dragon Dance / Recover
   -- and James: "we are in restricted mode... I get no status moves" for picks
   like these. The dex snapshot carries NO restriction flags (verified: move
   records have only ID/name/power/type/acc/pp/chance/target/priority/split),
   so the mode's rules are not in our data. The real save's own sets are the
   ground truth for what is legal (Mienshao's Detect, Lilligant's Sleep Powder
   and Baby-Doll Eyes are in daily live use, so the rule is NOT a blanket
   status ban on everything -- it constrains what could be ACQUIRED for new
   team members). DO NOT guess the rule and do not re-litigate it: ask James to
   approve the exact six movesets before any Giovanni re-run, then run
   tools/sim_episodes.js with RR_TEAM_FILE + FIGHT="ROCKET".
2. **Giovanni results so far are therefore provisional**: v1 60/60 zero-faint
   (invalid team), v2 49/60 with 11 full wipes (also invalid). The one finding
   that likely survives, and the anchor for the next build: in a wiped v2 seed
   the planner clicked Bulk Up into Earth Eater Orthworm THIRTEEN turns in a
   row -- a derived lever pulled with no removal behind it, against a wall it
   had no answer to. Whatever the legal team is, "recognise an unanswerable
   wall and do something on purpose about it" is the failure class to fix.
3. **The tie rule reverted** (47858b8): measured n=120, slot-order 28 vs median
   rule 21, inconclusive-leaning-against; default is old behaviour again,
   RR_TIE_MODEL=median keeps it available.
4. **Fable safeguard protocol**: this session's context repeatedly tripped it.
   In the new chat, keep the game's own vocabulary (faint/KO/removed/survivors),
   never paste raw memory or RNG dumps (summaries only), and the accumulated
   trigger mass resets with the fresh context.

## Fast orientation for the new chat

Memory auto-loads; `project-rr-singles-state` points here. The one-paragraph
state: harness fixed and paired-seeded; port at 79/90 with a per-matchup
instrument; two levers proven (confident entries p=0.0225 zero-faint, the
agent.js stop-loss p=0.0008 pooled -- the live trial needs only
RR_ENTRY_MODEL=confident); arm D refuted; register audit in ASSUMPTIONS.md with
eight suspicions dissolved by measurement; next build = opponent-side levers +
denial-line generation, with the Orthworm wall and a legal Giovanni team as its
acceptance tests; open gameplay decisions #2 (status pricing), #5 (progress
default), #7 (foe switching in pricing).

---

# Handoff -- 2026-09-01 (body as of mid-session)

Read this, then `docs/ASSUMPTIONS.md` (the audit of background decisions and
what measurement did to each), then memory `project-rr-singles-state` and
`feedback-rr-working-agreement`. Domain facts live in memory
`reference-rr-surge-domain` -- including the 2026-09-01 correction: speed
control DOES work on Pawmot; the constraint is delivering the dropper safely.

**A superseded version of this file claimed a graded lookahead arm "was tried
live and nearly wiped the team." That is false** -- see ASSUMPTIONS.md. Several
other long-standing "known defects" also dissolved under measurement this week.
When this project tells you something is broken, check the instrument first;
that has been the correct call eight times now.

## The mode

James restarted the playthrough and drives the overworld; the agent plays the
fights he hands it. `~/rr-agent/load.txt` empty, `restart` absent,
`EXPENDABLE=""`. Historical per-fight rates are not comparable across builds or
across the AI-port fixes below. Column 4 of results.tsv is SURVIVORS.

## What is established (all paired-seed, referee: tools/compare_arms.py)

- **The AI port**: 61%->79% exact, 77%->90% argmax against the game's own
  score sheet, after five rule fixes and a stale-row filter. `--score-live`
  prints a per-matchup accuracy table that separates a genuine gap from the
  game's own coin flips (in-argmax-set column).
- **`RR_ENTRY_MODEL=confident`** (James's ruling: price entries against the
  predicted move; hedge only when an uncertain choice would be fatal to the
  incoming mon): wins level, **zero-faint episodes 11 vs 2, p=0.0225** pooled
  over two independent runs. Earned a live trial; live needs only this flag.
- **The last-resort override in agent.js ("veto")**: measured for the first
  time via harness emulation (VETO=1) -- **keep it**. Pooled 120 paired
  episodes: p=0.0008 on wins, the strongest single lever measured. Plan-level
  expected value plus an execution-level stop-loss beats either alone.
- **Arm D (whole-fight gameplan): refuted**, 12/100 vs 29/100, p=0.0076, and it
  got WORSE as the value model improved. Fifth independent instance of the same
  law: more search/commitment over the value estimator loses. Do not retry
  without changing the estimator.
- **Their top-roll damage reading is load-bearing** (median-roll arm lost).
  Hedging what the opponent CHOOSES was waste; hedging how hard they HIT is
  protection.
- **The Giovanni stress test** (RR_TEAM_FILE, James's hand-built team at cap 47
  vs ROCKET HIDE. GIOVANNI): first pass 60/60 wins with zero faints, but it
  leaned on an Annihilape Drain Punch James says is unobtainable by then; the
  legal re-run (Bulk Up instead) was in flight at handoff -- read
  ~/.claude/jobs/*/tmp/night/gio60b.txt or re-run.

## The harness (tools/sim_episodes.js)

Paired seeded dice (game's own LCG; SEED + ep*7919), per-episode CSV via
EPISODES=, arms via env flags, TRACE=1 for turn-by-turn. `mode:'sample'` in
rr-battle.js is the honest dice. tools/test_replan.js is history, not evidence.
Referee: tools/compare_arms.py (seed-paired McNemar; self-tested).
Pre-registration discipline: docs/BATTERY-PREREG.md. Instrument variance:
identical controls at n=60 spread over 5 wins, so pair everything.

## Open decisions (James's, gameplay)

1. **Status moves price as sacrifices** (#2 in ASSUMPTIONS.md): an
   `until:{foeStatus}` on a sub-100% move is unsatisfiable in the deterministic
   pricer, so "Scald until burn lands, then close" grinds the user down and
   prices as a concession. Recommended: report status probability like
   deathRisk; interim guard: unsatisfiable `until` fails the leg.
2. **RR_CARRY_PROGRESS default** (#5): off, so multi-move legs replay move 0
   live and multi-leg panel lines only run their first leg. Correct fix,
   unproven benefit.
3. **#7**: the priced opponent never voluntarily switches.

## The next build (agreed direction, not started)

Opponent-side levers + denial-line generation: run `leversFor` on THEIR team,
price plans against their levers ripening (the sim already presses setup moves
-- verified: Roaring Moon's Dragon Dance scores 107 "+7 safe to set up"), and
let generation aim our levers at their threats, not only at their HP.
Acceptance test: the generator must propose a sensible answer to a setup
sweeper on a fight with no recorded history, must propose James's known-good
Surge lines unprompted (they currently verdict "never proposed"), and the
sacred-position gate stays green. No named strategies; everything derived from
data, per James: there are no general rules in this game, and a rule fitted to
one fight is the 19th move of one chess line.

## Still flagged-off and unmeasured

RR_NO_DOUBLE_BOOK, RR_LOOKAHEAD_SEES_US, RR_RISK_WEIGHT. RR_TIE_MODEL shipped
default-ON unmeasured (a mistake); its arm may still be running -- read
night/t120.txt, and revert to slot if it did not earn its place.

## Practical

- Long runs: one arm at a time under caffeinate; wide batches kept getting
  killed. macOS has no `timeout`.
- The agent and Lua are a long-running pair; edits do nothing until restart;
  version.txt gets -STALE on source change.
- Fable's safeguard trips on this project's accumulated wording; keep to the
  game's own terms (faint, KO, removed, survivors) and never paste raw memory
  or RNG dumps into the transcript -- summaries only.
