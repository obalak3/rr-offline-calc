/**
 * What the "unknown is not loss" change actually bought, measured.
 *
 * Two things worth separating, because they are easy to conflate:
 *
 *   1. `chance` is UNCHANGED by the fix. It was a lower bound before and it is
 *      the same lower bound now, computed the same way. This tool checks that
 *      against the pre-fix engine rather than asserting it, because a silent
 *      change to a number the solver already proves things with would be far
 *      worse than the bug being fixed.
 *
 *   2. What is new is knowing how loose that bound is. Before, a search that
 *      ran out of budget reported a chance near zero and there was no way to
 *      tell that from a fight it had genuinely examined and found hopeless.
 *
 * Run: node tools/measure_unknown.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/harness');

const root = H.root;
const OLD_EXACT = process.env.RR_OLD_EXACT || 'rr-exact.js.bak';

/** loadEngine, but with rr-exact.js swapped for an arbitrary file. */
function loadWith(exactPath) {
	const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
	const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number,
		Date, String, Boolean, isNaN, parseInt, parseFloat};
	vm.createContext(sandbox);
	const files = ['src/js/data/rr-trainers-data.js', 'src/js/data/rr-move-effects.js',
		'src/js/rr-critko.js', 'src/js/rr-battle.js', 'src/js/rr-ai.js',
		'src/js/rr-plan.js', 'src/js/rr-solver.js', 'src/js/rr-mcts.js'];
	for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', f), 'utf8'), sandbox);
	const mu = path.join(root, 'upstream-calc/src/js/rr-matchup.js');
	if (fs.existsSync(mu)) vm.runInContext(fs.readFileSync(mu, 'utf8'), sandbox);
	vm.runInContext(fs.readFileSync(exactPath, 'utf8'), sandbox);
	return sandbox;
}

const loaded = H.loadEngine();
const B = loaded.B;
const team = H.realTeam();
const mySets = team.map(m => ({species: m.species, level: m.level, nature: m.nature,
	ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4), evs: m.evs, ivs: m.ivs}));

// The fight James played and won without losing anybody, which is the whole
// reason this number was being questioned.
const battles = H.earlyBattles(loaded, {maxLevel: 40});
const surge = battles.find(b => /SURGE/i.test(H.label(b))) || battles[battles.length - 1];
console.log('fight: ' + H.label(surge));
console.log('our party: ' + mySets.map(m => m.species + ' L' + m.level).join(', '));
console.log('James played this and lost NOBODY.\n');

const foes = H.foeSets(surge);
function freshState(sandbox) {
	return sandbox.RRBattle.createState(mySets, foes, {});
}

const newSb = loadWith(path.join(root, 'upstream-calc/src/js/rr-exact.js'));
const oldSb = fs.existsSync(OLD_EXACT) ? loadWith(OLD_EXACT) : null;

console.log('budget      chance   unknown   upper    exhausted   nodes      (old chance)');
console.log('---------------------------------------------------------------------------');
let mismatches = 0;
for (const budget of [20000, 100000, 400000]) {
	const r = newSb.RRExact.winChance(freshState(newSb), {exactBudget: budget, maxTurns: 24, timeLimitMs: 20000});
	let oldStr = 'n/a';
	if (oldSb) {
		const o = oldSb.RRExact.winChance(freshState(oldSb), {exactBudget: budget, maxTurns: 24, timeLimitMs: 20000});
		oldStr = (100 * o.chance).toFixed(1) + '%';
		if (Math.abs(o.chance - r.chance) > 1e-12) { mismatches++; oldStr += ' MISMATCH'; }
	}
	console.log(
		String(budget).padStart(9) + '  ' +
		(100 * r.chance).toFixed(1).padStart(6) + '%  ' +
		(100 * r.unknown).toFixed(1).padStart(6) + '%  ' +
		(100 * r.upper).toFixed(1).padStart(6) + '%  ' +
		String(r.exhausted).padStart(9) + '   ' +
		String(r.nodes).padStart(9) + '   ' + oldStr);
}
console.log('');
if (oldSb) {
	console.log(mismatches === 0
		? 'VERIFIED: chance is bit-identical to the pre-fix engine at every budget.'
		: 'WARNING: chance CHANGED at ' + mismatches + ' budget(s) -- the fix was not additive.');
}

// A search that FINISHES must report no unknown at all. Without this the change
// could look right on hard fights while quietly inflating easy ones, which is
// the failure mode that matters: an advisor that says "I do not know" about a
// fight it fully understands is as useless as one that says "you lose".
console.log('\nA COMPLETED search must have zero unknown:');
const easy = battles.slice(0, 6);
for (const b of easy) {
	const st = newSb.RRBattle.createState(mySets, H.foeSets(b), {});
	const r = newSb.RRExact.winChance(st, {exactBudget: 3000000, maxTurns: 24, timeLimitMs: 20000});
	const tag = r.exhausted ? 'exhausted' : 'complete';
	console.log('  ' + H.label(b).slice(0, 34).padEnd(36) +
		'chance ' + (100 * r.chance).toFixed(1).padStart(6) + '%' +
		'  unknown ' + (100 * r.unknown).toFixed(1).padStart(6) + '%' +
		'  ' + tag +
		((!r.exhausted && r.unknown > 1e-9) ? '   <-- BUG: complete but unknown' : ''));
}
