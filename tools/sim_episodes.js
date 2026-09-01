/**
 * Play whole episodes offline, with honest dice and the live calling convention.
 *
 * Run: node tools/sim_episodes.js [episodes]
 *      EXPENDABLE="" FIGHT=SURGE node tools/sim_episodes.js 20
 *
 * ## Why this exists next to tools/test_replan.js instead of replacing it
 *
 * `test_replan.js` won 0/20 with all six dead every episode, while the same
 * planner won live essentially every time. That contradiction blocked every
 * tuning question on the project for months, because the only cheap way to run
 * thousands of trials disagreed with the only trustworthy one.
 *
 * It was not the planner. It was two things about the HARNESS, and they only
 * matter together:
 *
 *   1. IT NEVER CARRIED A PLAN. `test_replan.js:56` calls `chooseAction(ctx, st)`
 *      with no options, so the incumbent is never re-offered. The live agent has
 *      passed `{incumbent: lastPlan.jobs}` since eb2369c. Without it the market
 *      re-derives from scratch every turn, and since nearly every line opens by
 *      bringing in the Pokemon that does the work, a different winner IS a
 *      switch: 38% of offline actions were switches against 24% in live winning
 *      play, including switch-out-and-straight-back on consecutive turns.
 *
 *   2. IT PLAYED THE FIGHT IN THE SOLVER'S FLOOR MODE. `mode:'odds'` splits each
 *      hit into faint/survive and reads the survivor at the extreme against the
 *      player (rr-battle.js `damageOutcomes`), which is correct for a proof and
 *      wrong for an episode. Measured over the real Lt. Surge sets: THEIR damage
 *      x1.524, OURS x0.911, every turn. A single Volt Switch into Mienshao
 *      returned 78 on 100% of draws where the true expectation is 48.5.
 *
 * Measured, 20 episodes per cell, everything else identical:
 *
 *     dice      incumbent   wins    kills/ep
 *     odds      no          0/20    1.60      <- test_replan.js today
 *     odds      yes         0/20    2.35
 *     maxroll   no          0/20    2.30
 *     maxroll   yes         0/20    2.85
 *     fair      no          1/20    2.35
 *     fair      yes         9/20    3.85      <- four of them zero-death
 *
 * Neither fix does anything alone. Under floor-mode dice no plan survives its
 * first exchange, so the position drifts past what the plan assumed and there is
 * nothing left for the incumbent to hold. Sticking to a line only pays once the
 * dice are honest.
 *
 * `test_replan.js` is left exactly as it was. Its 0/20 is a real historical
 * number about a real historical harness and quietly changing it would erase the
 * evidence for all of the above.
 *
 * ## Still not the real game
 *
 * Offline remains weaker evidence than live, and this does not change that. Its
 * opponent is our port of the ROM AI (77% argmax on faithful positions), and its
 * replacement choices come from `RRAISwitching`, which does not reproduce the
 * one confirmed real-game miss. Use it to compare TWO ARMS against each other,
 * which is what it is good for; do not quote a single arm's win rate as a
 * prediction of live play.
 */
'use strict';
const H = require('./lib/harness.js');
const R = require('./lib/replan.js');
const P = require('./lib/policy.js');
const G = require('./lib/gameplan.js');
const engine = H.loadEngine();
const B = engine.B, RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const N = parseInt(process.argv[2], 10) || 20;

// The arms. Defaults reproduce the live agent as closely as offline can.
//   DICE=fair|odds|maxroll   how a turn is resolved
//   NO_INCUMBENT=1           drop the plan re-offer (reproduces test_replan.js)
//   RR_CARRY_PROGRESS=1      hold the plan's own progress across turns
// RR_CARRY_PROGRESS is read by replan.js itself, so it needs no wiring here;
// it is named in this comment because this file is where it gets measured.
// ARM selects the planning architecture. See docs/BATTERY-PREREG.md.
//   A  control, current live behaviour: chooseAction every turn
//   C  commitment: the same single-foe planner, but its plan is FOLLOWED until
//      a divergence test fires instead of being re-derived every turn
//   D  whole-fight gameplan, plan-and-repair (tools/lib/gameplan.js)
//   E  D, hedging their replacement (reserved; not implemented yet)
// B is not an ARM: it is A with RR_NOANSWER_FLOOR and RR_CARRY_PROGRESS set.
const ARM = (process.env.ARM || 'A').toUpperCase();
const DICE = process.env.DICE || 'fair';
const INCUMBENT = !process.env.NO_INCUMBENT;
const EXPENDABLE = (process.env.EXPENDABLE === undefined
	? 'Lilligant' : process.env.EXPENDABLE).split(',').filter(Boolean);

// LEVEL=<n> scales our side to a fight's level. Only ONE trainer in the game
// sits in this team's native band (Lt. Surge, L32-34), so without scaling the
// battery cannot ask whether an architecture generalises beyond the five Pokemon
// every constant was fitted against -- it would just be Surge three times.
// Scaled runs are labelled as such and must never be pooled with native ones.
const LEVEL = Number(process.env.LEVEL || 0);
const party = LEVEL
	? H.realTeam().map(s => Object.assign({}, s, {level: LEVEL}))
	: H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 60})
	.filter(b => H.label(b).toUpperCase().includes(process.env.FIGHT || 'SURGE'))[0];
if (!battle) { console.log('no battle matching FIGHT=' + (process.env.FIGHT || 'SURGE')); process.exit(1); }
const foeSets = H.foeSets(battle);
const ctx = {engine, party, foeSets, expendable: EXPENDABLE};

/**
 * Their move, by the same model the live agent falls back to.
 *
 * MOVES ONLY, matching `modelAction` in agent.js. Ties break uniformly, which
 * is what ai_master.c:360 does.
 */
function foeChoice(st, rand) {
	const sc = RRAI.scoreAll(st, 'foe', FLAGS, {});
	if (!sc.length) return null;
	const moves = sc.filter(e => e.action.type === 'move');
	const pool = moves.length ? moves : sc;
	let best = -Infinity;
	pool.forEach(e => { if (e.score > best) best = e.score; });
	const ties = pool.filter(e => e.score === best);
	return ties[Math.floor(rand() * ties.length)].action;
}

function bestDamage(st) {
	const legal = B.legalActions(st, 'me').filter(a => a.type === 'move');
	let best = null, bv = -1;
	legal.forEach(a => {
		const r = B.damageRolls(st, 'me', a.move);
		const d = r && !r.immune ? r.noCrit[8] * (r.hits || 1) : 0;
		if (d > bv) { bv = d; best = a; }
	});
	return best || B.legalActions(st, 'me')[0];
}

function stepOpts(rand) {
	if (DICE === 'odds') return {mode: 'odds', forkBudget: 3};
	if (DICE === 'maxroll') return {mode: 'maxroll', risks: {roll: 'median', foeRoll: 'max'}};
	return {mode: 'sample', rand: rand};
}
function sample(br, rand) {
	if (br.length === 1) return br[0].state;
	let r = rand(), a = 0;
	for (const b of br) { a += b.probability === undefined ? 1 / br.length : b.probability; if (r <= a) return b.state; }
	return br[br.length - 1].state;
}

/**
 * COMMON RANDOM NUMBERS, which is what makes two arms comparable at this n.
 *
 * Three identical control runs of this harness came out 27/60, 25/60 and 22/60.
 * That is ordinary binomial spread (sigma is about 3.8 wins), and it means an
 * unpaired comparison at n=60 can only see very large effects -- it was enough
 * for RR_DEEP_SCAN's 27->8 collapse and nowhere near enough for the no-answer
 * floor's 22 vs 24, which was reported as "a wash" when the truth is that the
 * instrument could not tell.
 *
 * So every source of chance in an episode is driven by ONE seeded generator,
 * seeded per episode from SEED + episode index. Episode 17 of arm A then faces
 * the same opening rolls as episode 17 of arm B, and the comparison is made
 * pairwise rather than between two independent totals. The arms still diverge
 * once they choose differently -- that is the effect being measured, not noise --
 * but everything up to the first divergence is shared, and that is where most of
 * the variance lives.
 *
 * The generator is the game's own: multiplier 0x41C64E6D, addend 12345, the
 * battle LCG solved earlier in this project (see `advance` in tools/agent.js).
 * Using it rather than a library PRNG keeps one fewer arbitrary choice in the
 * measurement path.
 *
 * There are exactly three consumers, verified by grep: the foe's tie-break, the
 * branch sample above, and rr-battle's `sample` mode via opts.rand. pricePath is
 * deterministic in the mode chooseAction uses (paths.js:183 `median` is true
 * whenever no mode is passed, and nothing passes one), and RRAI.scoreAll carries
 * no randomness of its own, so nothing else needs seeding.
 */
function makeRng(seed) {
	let s = seed >>> 0;
	return function () {
		s = (Math.imul(s, 0x41C64E6D) + 12345) >>> 0;
		return s / 4294967296;
	};
}

let won = 0, cap = 0, priced = 0, fell = 0, totTurns = 0, totKills = 0;
let persisted = 0, changedByProgress = 0;
let followed = 0, replans = 0, gameplans = 0, gameplanLegs = 0, gameplanFail = 0, vetoed = 0;
// DIAG=1 answers "why is D doing badly", which the summary counters cannot:
// where builds fail, how long a plan survives, how many deaths it signs up for.
const DIAG = !!process.env.DIAG;
const DRIFT = Number(process.env.RR_GP_DRIFT || 0);
const VETO = !!process.env.VETO;
const diag = {buildFail: {}, abandon: {}, lifetimes: [], legs: {},
	concededPerPlan: [], complete: {}, drift: [], failSeen: {}, failDistinct: 0,
	stop: {}, rejected: {}, legTurns: {}};
const deaths = {}, survivorHist = {}, actionTally = {};
const SEED = Number(process.env.SEED || 1);
const AHEADLOG = process.env.AHEADLOG || '';
const aheadRows = [];
const perEpisode = [];      // one line per episode, for the pairwise comparison
for (let ep = 0; ep < N; ep++) {
	const rand = makeRng(SEED + ep * 7919);
	let st = B.createState(party, foeSets, {});
	// The live agent's `lastPlan`, with the same shape and the same lifetime:
	// a plan is about an OPPONENT, so it expires when that opponent leaves.
	let lastPlan = {foe: null, jobs: null, progress: null};
	let held = null;
	// THE FREE RIDER (docs/BATTERY-PREREG.md): the lookahead's own bias.
	//
	// `ahead` claims what removing the REST of their team will cost from the
	// position a line leaves behind, and nothing has ever checked that claim
	// against what the remainder then actually cost. Bias is the quantity behind
	// every failed experiment so far: RR_DEEP_SCAN lost precisely because
	// believing more of an optimistic estimate spends Pokemon on futures that are
	// not real, so the size and SIGN of that optimism per opponent is worth more
	// than another win-rate arm.
	//
	// CAVEAT, kept next to the code rather than left for a reader to trip over:
	// `ahead` excludes the opponent currently being killed, while the realised
	// suffix includes everything that happened after the turn. The realised
	// figure therefore runs slightly high even for a perfectly calibrated
	// lookahead. Read this as a bias MAP across opponents, not a calibration
	// certificate.
	const aheadTrace = [];
	let prevHpFrac = st.me.team.reduce((a, m) => a + (m.fainted ? 0 : m.curHP / m.maxHP), 0);
	let prevDead = st.me.team.filter(m => m.fainted).length;
	let t = 0;
	for (t = 0; t < 80; t++) {
		if (B.isOver(st)) break;
		if (st.me.team.every(m => m.fainted) || st.foe.team.every(m => m.fainted)) break;
		const foeNow = st.foe.team[st.foe.active].set.species;
		const prevJobs = (lastPlan.foe === foeNow && lastPlan.jobs)
			? JSON.stringify(lastPlan.jobs) : null;

		// ---- ARMS C AND D: follow a held plan until reality leaves it ----
		//
		// The divergence test is deliberately STRICT, because its failure mode
		// matters: replanning too often degrades to arm A, which is the control
		// and is known to work, while replanning too rarely is the static plan
		// that lost 0/30. It fails safe by construction.
		//
		// A plan is abandoned when a Pokemon it did not concede has died, when
		// the executor can no longer answer, or (arm C only, whose plan covers
		// one opponent) when the opponent changes. Arm D expects the opponent to
		// change; that is what a whole-fight plan is for.
		if (ARM === 'C' || ARM === 'D') {
			if (held) {
				// DEATHS SINCE THE PLAN WAS MADE, not deaths in total.
				//
				// This compared every fainted Pokemon against the plan's conceded
				// list, so the moment anyone was dead -- including someone who
				// died long before this plan existed -- every freshly built plan
				// was abandoned on the very next iteration. Measured: 129
				// gameplans built to play 30 turns, a rebuild loop that made the
				// arm three minutes an episode and would have been recorded as
				// "the gameplan is too slow to measure".
				const deadList = st.me.team.filter(m => m.fainted).map(m => m.set.species);
				const fresh = deadList.filter(n => !held.deadAtList.includes(n));
				const unplanned = fresh.some(n => !held.conceded.includes(n));
				// RR_GP_DRIFT=<slack>: abandon when reality has fallen more than
				// `slack` Pokemon-equivalents of total team health below what the
				// plan expected by this turn. Death is a LATE signal -- by the
				// time one lands the position is usually already lost -- and it
				// was the only trigger there was.
				//
				// This is a detector, not a scoring term, and its failure
				// direction is safe: too sensitive and the arm degrades toward
				// the control, which is known to work.
				let drifted = false;
				if (held.trace && held.trace.length) {
					const k = Math.min(t - held.bornAt, held.trace.length - 1);
					const nowHp = st.me.team.reduce((a, m) =>
						a + (m.fainted ? 0 : m.curHP / m.maxHP), 0);
					if (k >= 0) {
						const gap = held.trace[k] - nowHp;
						// Recorded on every held turn whether or not it triggers,
						// so a threshold can be READ off the distribution instead
						// of guessed at. Positive means reality is worse than the
						// plan expected.
						if (DIAG) diag.drift.push(gap);
						if (DRIFT && gap > DRIFT) drifted = true;
					}
				}
				if (drifted && DIAG) diag.abandon['hp drift'] = (diag.abandon['hp drift'] || 0) + 1;
				if (unplanned || drifted || (ARM === 'C' && held.foe !== foeNow)) {
					if (DIAG && !drifted) diag.abandon[unplanned ? 'unplanned death' : 'foe changed'] =
						(diag.abandon[unplanned ? 'unplanned death' : 'foe changed'] || 0) + 1;
					if (DIAG) diag.lifetimes.push(t - held.bornAt);
					held = null; replans++;
				}
			}
			if (held) {
				let act = null;
				try { act = P.planAction(engine, st, held.plan, held.progress); }
				catch (e) { act = null; }
				if (act) {
					followed++;
					if (DIAG) diag.legTurns[held.nLegs] = (diag.legTurns[held.nLegs] || 0) + 1;
					const key2 = act.type === 'switch' ? 'switch' : act.move;
					actionTally[key2] = (actionTally[key2] || 0) + 1;
					const theirs2 = foeChoice(st, rand);
					if (!theirs2) break;
					let out2;
					try { out2 = B.step(st, act, theirs2, stepOpts(rand)); } catch (e) { break; }
					if (!out2 || !out2.length) break;
					st = sample(out2, rand);
					continue;
				}
				held = null; replans++;   // the plan ran out of things to say
			}
		}
		const pick = R.chooseAction(ctx, st, {
			incumbent: (INCUMBENT && lastPlan.foe === foeNow) ? lastPlan.jobs : null,
			progress: (lastPlan.foe === foeNow) ? lastPlan.progress : null
		});
		let mine;
		// ARM D builds the whole-fight plan here; if it cannot, it falls through
		// to the incumbent planner for this turn rather than inventing one.
		if (ARM === 'D' && !held) {
			let gp = null;
			try { gp = G.buildGameplan(ctx, st, {}); } catch (e) { gp = null; }
			if (gp) {
				const conceded = [];
				gp.legs.forEach(l => (l.dead || []).forEach(n => {
					if (!conceded.includes(n)) conceded.push(n);
				}));
				held = {plan: gp.plan, progress: P.newProgress(), foe: foeNow,
					conceded: conceded, cost: gp.cost,
					deadAtList: st.me.team.filter(m => m.fainted).map(m => m.set.species),
					trace: gp.trace || null,
					nLegs: gp.legs.length,
					bornAt: t};
				gameplans++;
				if (DIAG) {
					if (gp.probe) {
						diag.stop[gp.probe.stop + ' @depth' + gp.probe.depth] =
							(diag.stop[gp.probe.stop + ' @depth' + gp.probe.depth] || 0) + 1;
						for (const k in gp.probe.rejected) diag.rejected[k] =
							(diag.rejected[k] || 0) + gp.probe.rejected[k];
					}
					diag.legs[gp.legs.length] = (diag.legs[gp.legs.length] || 0) + 1;
					diag.concededPerPlan.push(conceded.length);
					diag.complete[gp.complete ? 'complete' : 'partial'] =
						(diag.complete[gp.complete ? 'complete' : 'partial'] || 0) + 1;
				}
				gameplanLegs += gp.legs.length;
				continue;   // execute it on the next pass through the loop
			}
			gameplanFail++;
			// DISTINCT positions, not attempts. A failed build falls back for the
			// turn and is retried next turn, so one genuinely dead position logs a
			// failure on every turn it persists. Counting attempts made 1676 look
			// like 1676 separate problems when it is far fewer, seen repeatedly.
			if (DIAG) {
				const sig = ep + '|' + st.me.team.map(m => m.fainted ? 'X'
					: Math.round(m.curHP / m.maxHP * 4)).join('')
					+ '|' + st.foe.team.map(m => m.fainted ? 'X' : 'o').join('');
				if (!diag.failSeen[sig]) { diag.failSeen[sig] = 1; diag.failDistinct++; }
			}
			if (DIAG) {
				const alive = st.me.team.filter(m => !m.fainted).length;
				const foesAlive = st.foe.team.filter(m => !m.fainted).length;
				const hp = Math.round(100 * st.me.team.reduce((a, m) =>
					a + (m.fainted ? 0 : m.curHP / m.maxHP), 0) / 6);
				const k = 'ours=' + alive + ' theirs=' + foesAlive
					+ ' teamHP=' + (hp < 25 ? '<25%' : hp < 50 ? '25-50%' : hp < 75 ? '50-75%' : '>75%');
				diag.buildFail[k] = (diag.buildFail[k] || 0) + 1;
			}
		}
		const samePlanAsLast = !!(pick && pick.path && pick.path.cand && prevJobs
			&& JSON.stringify(pick.path.cand.jobs) === prevJobs);
		if (pick) {
			mine = pick.action; priced++;
			if (pick.path && pick.path.cand) {
				lastPlan = {foe: foeNow, jobs: pick.path.cand.jobs,
					progress: pick.progress || null};
				if (ARM === 'C') {
					const pl = {};
					pl[foeNow] = pick.path.cand.jobs;
					held = {plan: pl, progress: P.newProgress(), foe: foeNow,
						conceded: (pick.path.r && pick.path.r.dead) || [], nLegs: 1,
						deadAtList: st.me.team.filter(m => m.fainted).map(m => m.set.species)};
				}
			}
		} else { mine = bestDamage(st); fell++; }
		const theirs = foeChoice(st, rand);
		if (!mine || !theirs) break;
		// THE DEATH VETO, EMULATED (VETO=1), so register item #4 is measurable.
		//
		// It lives in agent.js and the harness has never had it, which means
		// every offline arm so far has compared planners in a world without the
		// reflex that overrides them live. That is not a small omission: it
		// fires on about 10% of live decisions.
		//
		// Emulated in spirit rather than transcribed: if the planned action
		// would lose our active this turn against the predicted foe move, and
		// would not take the foe with it, substitute the first legal action that
		// survives. The live one uses agent.js's one-turn scorer for the same
		// judgement; both condition on the SINGLE predicted move, which is the
		// property being measured.
		if (VETO && mine) {
			const idx = st.me.active;
			const dies = act => {
				try {
					const o = B.step(st, act, theirs, {mode: 'maxroll', risks: {roll: 'median', foeRoll: 'max'}});
					const s2 = o && o[0] && o[0].state;
					if (!s2) return false;
					return s2.me.team[idx].fainted && !s2.foe.team[st.foe.active].fainted;
				} catch (e) { return false; }
			};
			if (dies(mine)) {
				const alt = B.legalActions(st, 'me').find(a => !dies(a));
				if (alt) { mine = alt; vetoed++; }
			}
		}
		const key = mine.type === 'switch' ? 'switch' : mine.move;
		actionTally[key] = (actionTally[key] || 0) + 1;
		// DID CARRYING PROGRESS ACTUALLY CHANGE THIS TURN? Answered by replaying
		// the winning candidate against a FRESH progress, which is exactly what
		// the old code did, and comparing. Without this a null result cannot be
		// told apart from a fix that never got the chance to fire: progress only
		// accumulates while a plan survives, and a market that re-derives a
		// different winner every turn never lets it.
		if (pick && pick.path && pick.path.cand) {
			if (samePlanAsLast) persisted++;
			const pl = {};
			pl[foeNow] = pick.path.cand.jobs;
			let fresh = null;
			try { fresh = P.planAction(engine, st, pl, P.newProgress()); } catch (e) { fresh = null; }
			const same = (a, b) => (!a && !b) || (a && b && a.type === b.type
				&& (a.type === 'switch' ? a.index === b.index : a.move === b.move));
			if (!same(fresh, mine)) changedByProgress++;
		}
		let out;
		const aheadNow = (pick && pick.path && pick.path.ahead !== undefined
			&& pick.path.ahead !== null) ? pick.path.ahead : null;
		const foesLeftNow = st.foe.team.filter(m => !m.fainted).length;
		try { out = B.step(st, mine, theirs, stepOpts(rand)); } catch (e) { break; }
		if (!out || !out.length) break;
		st = sample(out, rand);
		if (AHEADLOG) {
			const hpNow = st.me.team.reduce((a, m) => a + (m.fainted ? 0 : m.curHP / m.maxHP), 0);
			const deadNow2 = st.me.team.filter(m => m.fainted).length;
			// The planner's own units: HP lost as a fraction of max, 6 per
			// forbidden death, TEMPO for the turn itself.
			aheadTrace.push({turn: t, foe: foeNow, ahead: aheadNow, foesLeft: foesLeftNow,
				realised: Math.max(0, prevHpFrac - hpNow)
					+ 6 * Math.max(0, deadNow2 - prevDead) + 0.4});
			prevHpFrac = hpNow; prevDead = deadNow2;
		}
	}
	if (AHEADLOG && aheadTrace.length) {
		let suffix = 0;
		for (let i = aheadTrace.length - 1; i >= 0; i--) {
			suffix += aheadTrace[i].realised;
			aheadTrace[i].remaining = suffix;
		}
		aheadTrace.forEach(rec => aheadRows.push([ep, rec.turn, rec.foe,
			rec.ahead === null ? '' : rec.ahead.toFixed(3),
			rec.remaining.toFixed(3), rec.foesLeft].join(',')));
	}
	totTurns += t;
	const w = st.foe.team.every(m => m.fainted);
	const d = st.me.team.filter(m => m.fainted).map(m => m.set.species);
	totKills += st.foe.team.filter(m => m.fainted).length;
	const surv = st.me.team.filter(m => !m.fainted).length;
	survivorHist[surv] = (survivorHist[surv] || 0) + 1;
	if (w) won++;
	if (w && d.every(x => EXPENDABLE.includes(x))) cap++;
	d.forEach(x => { deaths[x] = (deaths[x] || 0) + 1; });
	// PER-EPISODE, so arms can be differenced episode by episode instead of
	// total by total. This line is the unit of the paired comparison.
	perEpisode.push([SEED + ep * 7919, w ? 1 : 0, surv, t,
		st.foe.team.filter(m => m.fainted).length].join(','));
}

const totalActions = Object.keys(actionTally).reduce((a, k) => a + actionTally[k], 0) || 1;
console.log('ARM=' + ARM + (LEVEL ? '  ourLevel=' + LEVEL + ' (SCALED)' : '') + '  dice=' + DICE + (INCUMBENT ? ' +incumbent' : ' NO-incumbent')
	+ (process.env.RR_CARRY_PROGRESS ? ' +progress' : '')
	+ (process.env.RR_DEEP_SCAN ? ' +deepscan' + process.env.RR_DEEP_SCAN : '')
	+ (process.env.RR_NOANSWER_FLOOR ? ' +floor' : '')
	+ (DRIFT ? ' +drift' + DRIFT : '')
	+ (VETO ? ' +deathveto' : '')
	+ '  expendable=[' + EXPENDABLE.join(',') + ']  ' + N + ' episodes of ' + H.label(battle));
console.log('  won:          ' + won + '/' + N);
console.log('  met the cap:  ' + cap + '/' + N + '   (win, losing nobody but ' + (EXPENDABLE.join('/') || 'nobody') + ')');
console.log('  their kills:  ' + (totKills / N).toFixed(2) + ' of ' + foeSets.length + ' per episode');
console.log('  turns/ep:     ' + (totTurns / N).toFixed(1));
console.log('  survivors:    ' + Object.keys(survivorHist).sort((a, b) => b - a)
	.map(k => k + ':' + survivorHist[k]).join('  '));
console.log('  deaths:       ' + (Object.keys(deaths).sort((a, b) => deaths[b] - deaths[a])
	.map(k => k + ' ' + deaths[k]).join(', ') || 'none'));
console.log('  switch rate:  ' + (100 * (actionTally.switch || 0) / totalActions).toFixed(0)
	+ '%   (live winning play measured at 24%)');
console.log('  plan survived the turn: ' + persisted + '/' + priced + '  ('
	+ (priced ? (100 * persisted / priced).toFixed(0) : 0) + '%)'
	+ '   -- progress can only accumulate on these');
console.log('  turns where carrying progress CHANGED the action: ' + changedByProgress
	+ '  (' + (priced ? (100 * changedByProgress / priced).toFixed(1) : 0) + '%)');
if (VETO) console.log('  death veto fired: ' + vetoed + ' times ('
	+ (priced ? (100 * vetoed / priced).toFixed(1) : 0) + '% of decisions; live measures ~10%)');
console.log('  priced turns: ' + priced + ', fell back to greedy: ' + fell);
if (ARM === 'C' || ARM === 'D') {
	console.log('  turns played FROM a held plan: ' + followed
		+ '  (' + (followed + priced ? (100 * followed / (followed + priced)).toFixed(0) : 0) + '%)');
	console.log('  plans abandoned on divergence:  ' + replans);
}
if (ARM === 'D') {
	console.log('  gameplans built: ' + gameplans
		+ ', mean legs ' + (gameplans ? (gameplanLegs / gameplans).toFixed(1) : '-')
		+ ', build failed (fell back to the incumbent planner): ' + gameplanFail);
}
if (DIAG) {
	const med = a => { if (!a.length) return '-'; const b = a.slice().sort((x, y) => x - y);
		return b[Math.floor(b.length / 2)]; };
	console.log('  --- DIAG ---');
	console.log('  plan lifetime (turns before abandoned): median ' + med(diag.lifetimes)
		+ '  max ' + (diag.lifetimes.length ? Math.max.apply(null, diag.lifetimes) : '-'));
	console.log('  deaths a plan SIGNS UP FOR at build time: median '
		+ med(diag.concededPerPlan) + '  (mean '
		+ (diag.concededPerPlan.length
			? (diag.concededPerPlan.reduce((a, b) => a + b, 0) / diag.concededPerPlan.length).toFixed(2)
			: '-') + ')');
	console.log('  plans by leg count: ' + JSON.stringify(diag.legs));
	console.log('  complete vs partial: ' + JSON.stringify(diag.complete));
	console.log('  why abandoned: ' + JSON.stringify(diag.abandon));
	if (diag.drift.length) {
		const d = diag.drift.slice().sort((a, b) => a - b);
		const q = f => d[Math.floor(d.length * f)].toFixed(2);
		console.log('  DRIFT (plan expectation minus reality, in Pokemon of team HP), '
			+ d.length + ' held turns:');
		console.log('    p10 ' + q(0.1) + '  p25 ' + q(0.25) + '  median ' + q(0.5)
			+ '  p75 ' + q(0.75) + '  p90 ' + q(0.9) + '  max ' + d[d.length - 1].toFixed(2));
		console.log('    share of held turns already MORE than 0.5 behind plan: '
			+ (100 * d.filter(x => x > 0.5).length / d.length).toFixed(0) + '%'
			+ ', more than 1.0: ' + (100 * d.filter(x => x > 1).length / d.length).toFixed(0) + '%');
	}
	console.log('  build failures: ' + gameplanFail + ' attempts, but only '
		+ diag.failDistinct + ' DISTINCT positions (a dead position is retried every turn)');
	console.log('  WHY THE SEARCH STOPPED: ' + JSON.stringify(diag.stop));
	console.log('  WHY CANDIDATES WERE REJECTED: ' + JSON.stringify(diag.rejected));
	console.log('  HELD TURNS BY PLAN SIZE (legs -> turns): ' + JSON.stringify(diag.legTurns));
	console.log('  WHERE THE BUILD FAILS:');
	Object.keys(diag.buildFail).sort((a, b) => diag.buildFail[b] - diag.buildFail[a])
		.slice(0, 10).forEach(k => console.log('    ' + String(diag.buildFail[k]).padStart(5) + '  ' + k));
}
console.log('  seed base:    ' + SEED);
// EPISODES= writes the per-episode rows for pairing. Deliberately last and
// machine-readable: the summary above is for a human, this is for the compare.
if (AHEADLOG && aheadRows.length) {
	require('fs').writeFileSync(AHEADLOG,
		'episode,turn,foe,ahead,realisedRemaining,foesLeft\n' + aheadRows.join('\n') + '\n');
	console.log('  ahead-vs-realised: ' + AHEADLOG + '  (' + aheadRows.length + ' turns)');
}
if (process.env.EPISODES) {
	const fs = require('fs');
	fs.writeFileSync(process.env.EPISODES,
		'seed,won,survivors,turns,theirKills\n' + perEpisode.join('\n') + '\n');
	console.log('  per-episode:  ' + process.env.EPISODES);
}
