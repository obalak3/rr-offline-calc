/**
 * Are our quality numbers inflated by deterministic dice?
 * Run: node tools/measure_variance.js [episodesPerFight]
 *
 * Every headline figure this project quotes about the live advisor -- 8/9,
 * 9/9, "wins Lt. Surge" -- was measured with STEP mode "expected": the median
 * damage roll, no crits, no missed moves, no secondary effects. That is not
 * how the game plays.
 *
 * The fifth pass established exactly this as the flaw that undid the shelved
 * MCTS: its rollouts ran at median rolls with the player's secondaries
 * suppressed, so it could not value a position whose worth came from a burn or
 * a sleep landing. The verdict it was shelved on measured something other than
 * the method. It would be careless to repeat that mistake in the measurement
 * of the advisor itself, and a first hint has already appeared -- the same
 * Surge fight that the advisor WINS under expected mode was LOST under odds
 * mode.
 *
 * So: the same fights, the same advisor, both dice models, side by side. Odds
 * mode fires crits, misses and secondaries at their real rates, so the gap
 * between the columns is the amount by which median rolls flatter us.
 *
 * A large gap does not mean the advisor is bad. It means our numbers are not
 * measuring the game, and every comparison made with them -- including the
 * ones that shelved MCTS and the ones that justify the current heuristic --
 * needs re-reading.
 */
'use strict';

const H = require('./lib/harness.js');
const live = require('./lib/live.js');

const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const OPTS = {lookahead: 2, budget: 20000, chargeSwitchTempo: true};
const N = parseInt(process.argv[2], 10) || 20;

const party = H.realTeam();
const battles = H.earlyBattles(engine, {maxLevel: 40}).slice(0, 9);

function foeArgmax(st) {
	const sc = RRAI.scoreAll(st, 'foe', FLAGS, {});
	let best = -Infinity;
	sc.forEach(x => { if (x.score > best) best = x.score; });
	const top = sc.filter(x => x.score === best);
	return top[Math.floor(Math.random() * top.length)].action;
}

function sample(states) {
	let r = Math.random(), acc = 0;
	for (const s of states) {
		acc += (s.probability !== undefined ? s.probability : 1 / states.length);
		if (r <= acc) return s.state;
	}
	return states[states.length - 1].state;
}

function play(foeSets, mode) {
	let real = B.createState(party, foeSets, {});
	let believed = B.clone(real);
	const session = live.createSession();
	for (let t = 0; t < 60; t++) {
		if (real.foe.team.every(m => m.fainted) || real.me.team.every(m => m.fainted)) break;
		const adv = live.advise(believed, live.observe(real), OPTS, engine, session);
		if (!adv || !adv.best) break;
		const mine = B.legalActions(real, 'me').find(a => adv.best.action.type === 'switch'
			? (a.type === 'switch' && a.index === adv.best.action.index)
			: (a.type === 'move' && a.move === adv.best.action.move));
		const theirs = foeArgmax(real);
		if (!mine || !theirs) break;
		let out;
		try { out = B.step(real, mine, theirs, {mode: mode}); } catch (e) { break; }
		if (!out || !out.length) break;
		real = mode === 'odds' ? sample(out) : out[0].state;
		try { believed = B.clone(real); } catch (e) { /* re-pin */ }
	}
	return {
		won: real.foe.team.every(m => m.fainted),
		dead: real.me.team.filter(m => m.fainted).length,
	};
}

console.log('');
console.log('  ' + 'fight'.padEnd(28) + 'median rolls        real dice (' + N + ' eps)');
let eW = 0, eD = 0, oW = 0, oD = 0, fights = 0;
battles.forEach(b => {
	const fs = H.foeSets(b);
	const exp = play(fs, 'expected');            // deterministic: one run is the answer
	let w = 0, d = 0;
	for (let i = 0; i < N; i++) { const r = play(fs, 'odds'); w += r.won ? 1 : 0; d += r.dead; }
	fights++;
	eW += exp.won ? 1 : 0; eD += exp.dead; oW += w / N; oD += d / N;
	console.log('  ' + H.label(b).slice(0, 26).padEnd(28)
		+ ((exp.won ? 'WON' : 'lost') + ' ' + exp.dead + ' lost').padEnd(20)
		+ (100 * w / N).toFixed(0) + '% won, ' + (d / N).toFixed(1) + ' lost');
});
console.log('');
console.log('  median rolls   ' + eW + '/' + fights + ' won, ' + eD + ' Pokemon lost');
console.log('  real dice      ' + oW.toFixed(1) + '/' + fights + ' won, '
	+ oD.toFixed(1) + ' Pokemon lost');
console.log('');
const gap = eW - oW;
if (gap >= 1) {
	console.log('  Median rolls flatter the advisor by ' + gap.toFixed(1) + ' fights.');
	console.log('  Every number this project quotes about advisor quality was');
	console.log('  measured that way and is optimistic by roughly this much.');
} else {
	console.log('  The two agree closely, so the existing numbers survive.');
}
