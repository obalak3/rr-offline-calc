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
const DICE = process.env.DICE || 'fair';
const INCUMBENT = !process.env.NO_INCUMBENT;
const EXPENDABLE = (process.env.EXPENDABLE === undefined
	? 'Lilligant' : process.env.EXPENDABLE).split(',').filter(Boolean);

const party = H.realTeam();
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
const deaths = {}, survivorHist = {}, actionTally = {};
const SEED = Number(process.env.SEED || 1);
const perEpisode = [];      // one line per episode, for the pairwise comparison
for (let ep = 0; ep < N; ep++) {
	const rand = makeRng(SEED + ep * 7919);
	let st = B.createState(party, foeSets, {});
	// The live agent's `lastPlan`, with the same shape and the same lifetime:
	// a plan is about an OPPONENT, so it expires when that opponent leaves.
	let lastPlan = {foe: null, jobs: null, progress: null};
	let t = 0;
	for (t = 0; t < 80; t++) {
		if (B.isOver(st)) break;
		if (st.me.team.every(m => m.fainted) || st.foe.team.every(m => m.fainted)) break;
		const foeNow = st.foe.team[st.foe.active].set.species;
		const prevJobs = (lastPlan.foe === foeNow && lastPlan.jobs)
			? JSON.stringify(lastPlan.jobs) : null;
		const pick = R.chooseAction(ctx, st, {
			incumbent: (INCUMBENT && lastPlan.foe === foeNow) ? lastPlan.jobs : null,
			progress: (lastPlan.foe === foeNow) ? lastPlan.progress : null
		});
		let mine;
		const samePlanAsLast = !!(pick && pick.path && pick.path.cand && prevJobs
			&& JSON.stringify(pick.path.cand.jobs) === prevJobs);
		if (pick) {
			mine = pick.action; priced++;
			if (pick.path && pick.path.cand) {
				lastPlan = {foe: foeNow, jobs: pick.path.cand.jobs,
					progress: pick.progress || null};
			}
		} else { mine = bestDamage(st); fell++; }
		const theirs = foeChoice(st, rand);
		if (!mine || !theirs) break;
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
		try { out = B.step(st, mine, theirs, stepOpts(rand)); } catch (e) { break; }
		if (!out || !out.length) break;
		st = sample(out, rand);
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
console.log('dice=' + DICE + (INCUMBENT ? ' +incumbent' : ' NO-incumbent')
	+ (process.env.RR_CARRY_PROGRESS ? ' +progress' : '')
	+ (process.env.RR_DEEP_SCAN ? ' +deepscan' + process.env.RR_DEEP_SCAN : '')
	+ (process.env.RR_NOANSWER_FLOOR ? ' +floor' : '')
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
console.log('  priced turns: ' + priced + ', fell back to greedy: ' + fell);
console.log('  seed base:    ' + SEED);
// EPISODES= writes the per-episode rows for pairing. Deliberately last and
// machine-readable: the summary above is for a human, this is for the compare.
if (process.env.EPISODES) {
	const fs = require('fs');
	fs.writeFileSync(process.env.EPISODES,
		'seed,won,survivors,turns,theirKills\n' + perEpisode.join('\n') + '\n');
	console.log('  per-episode:  ' + process.env.EPISODES);
}
