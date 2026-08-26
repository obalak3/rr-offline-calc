/**
 * Step 5, the PRE-REGISTERED re-measurement: can the advisor beat James?
 * Run: node tools/measure_clean.js [episodes]
 *
 * The twentieth pass fixed this criterion in ADVANCE, before anything was
 * measured, precisely so the answer could not be argued into whatever was
 * convenient:
 *
 *   "Handcrafted V is SUFFICIENT if its P(clean) beats James's recorded rate
 *    on those fights (his rate is a FLOOR, not a target -- he says his own
 *    play contains mistakes). If it cannot beat the floor after the objective
 *    and distribution fixes, the learning machinery is justified and gets
 *    built without further debate."
 *
 * THE FLOOR IS THIN, and that has to be said before any number is quoted.
 * OUTCOMES.md records eight Lt. Surge attempts, but only THREE were played to
 * completion with the real team: two wins costing one Pokemon, and one clean
 * win. Runs 4-6 were abandoned mid-attempt, run 1 was not finished, and run 8
 * used a different team. So the recorded clean rate is 1 of 3, and a binomial
 * at n=3 has a confidence interval spanning almost the whole range. The
 * comparison is therefore only decisive if our result is EXTREME -- far above
 * or far below. A middling number means the test was underpowered, not that
 * the advisor is borderline, and this tool says which case it is rather than
 * reporting a bare percentage.
 *
 * Sampling uses odds mode, so crits, misses, secondary effects and AI ties all
 * fire at their real rates. Median rolls would answer a different question --
 * the fifth pass showed the shelved MCTS was undone by exactly that
 * substitution.
 */
'use strict';

const H = require('./lib/harness.js');
const live = require('./lib/live.js');

const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const MAX_TURNS = 60;

const EPISODES = parseInt(process.argv[2], 10) || 100;
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

// James's recorded floor, from OUTCOMES.md. Completed attempts only.
const JAMES_CLEAN = 1, JAMES_N = 3;

function foePick(st) {
	const ties = RRAI.trueTies(st, 'foe', {flags: FLAGS}).actions;
	const pool = ties.length ? ties : B.legalActions(st, 'foe');
	return pool[Math.floor(Math.random() * pool.length)];
}

function sample(states) {
	// odds mode returns weighted successors; draw one at its real probability.
	let r = Math.random(), acc = 0;
	for (const s of states) {
		acc += (s.probability !== undefined ? s.probability : 1 / states.length);
		if (r <= acc) return s.state;
	}
	return states[states.length - 1].state;
}

let clean = 0, won = 0, lost = 0, deaths = 0, stalls = 0;

for (let ep = 0; ep < EPISODES; ep++) {
	let real = B.createState(party, foeSets, {});
	let believed = B.clone(real);
	const session = live.createSession();
	let turns = 0;
	while (turns < MAX_TURNS) {
		if (real.foe.team.every(m => m.fainted) || real.me.team.every(m => m.fainted)) break;
		const obs = live.observe(real);
		const advice = live.advise(believed, obs,
			{lookahead: 2, budget: 20000, chargeSwitchTempo: true,
				trueDistribution: true}, engine, session);
		if (!advice || !advice.best) break;
		const mine = B.legalActions(real, 'me').find(a =>
			advice.best.action.type === 'switch'
				? (a.type === 'switch' && a.index === advice.best.action.index)
				: (a.type === 'move' && a.move === advice.best.action.move));
		const theirs = foePick(real);
		if (!mine || !theirs) break;
		let out;
		try { out = B.step(real, mine, theirs, {mode: 'odds'}); } catch (e) { break; }
		if (!out || !out.length) break;
		real = sample(out);
		try { believed = B.clone(real); } catch (e) { /* re-pin */ }
		turns++;
	}
	if (turns >= MAX_TURNS) stalls++;
	const dead = real.me.team.filter(m => m.fainted).length;
	const foeDown = real.foe.team.every(m => m.fainted);
	deaths += dead;
	if (foeDown) { won++; if (dead === 0) clean++; } else { lost++; }
}

function wilson(k, n) {
	if (!n) return [0, 0];
	const z = 1.96, p = k / n, d = 1 + z * z / n;
	const c = (p + z * z / (2 * n)) / d;
	const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
	return [Math.max(0, c - h), Math.min(1, c + h)];
}

const ci = wilson(clean, EPISODES);
const jci = wilson(JAMES_CLEAN, JAMES_N);
console.log('');
console.log('  ADVISOR on Lt. Surge, ' + EPISODES + ' episodes, real dice');
console.log('    clean wins    ' + clean + '/' + EPISODES
	+ '  ' + (100 * clean / EPISODES).toFixed(1) + '%'
	+ '   95% CI ' + (100 * ci[0]).toFixed(1) + '-' + (100 * ci[1]).toFixed(1) + '%');
console.log('    won at all    ' + won + '/' + EPISODES);
console.log('    lost          ' + lost + '/' + EPISODES);
console.log('    mean deaths   ' + (deaths / EPISODES).toFixed(2));
if (stalls) console.log('    stalled       ' + stalls);
console.log('');
console.log('  JAMES, completed attempts only: ' + JAMES_CLEAN + '/' + JAMES_N
	+ '  95% CI ' + (100 * jci[0]).toFixed(1) + '-' + (100 * jci[1]).toFixed(1) + '%');
console.log('');
if (ci[0] > jci[1]) {
	console.log('  VERDICT: the advisor beats the floor decisively.');
	console.log('  A handcrafted value function is SUFFICIENT. Do not build the');
	console.log('  learning machinery.');
} else if (ci[1] < jci[0]) {
	console.log('  VERDICT: the advisor is decisively BELOW the floor.');
	console.log('  The learning machinery is justified, per the pre-registered');
	console.log('  criterion, and gets built without further debate.');
} else {
	console.log('  VERDICT: UNDERPOWERED -- the intervals overlap.');
	console.log('  This is a fact about the floor (n=' + JAMES_N + '), not about the');
	console.log('  advisor. Do NOT read it as "borderline". Either collect more');
	console.log('  completed attempts from James, or accept that this criterion');
	console.log('  cannot decide the question and choose a different one.');
}
