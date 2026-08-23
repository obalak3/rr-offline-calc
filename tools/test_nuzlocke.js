/**
 * Checks for Nuzlocke mode. Run: node tools/test_nuzlocke.js
 *
 * Under Nuzlocke rules a faint is permanent, so the objective is not "win the
 * battle" but "win without losing anything". That is a different search, and
 * these checks are about it staying honest under pressure: the ladder must not
 * claim safety it has not shown, and it must never report "dies" for a fight it
 * merely failed to solve.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number, Date};
vm.createContext(sandbox);
for (const file of ['src/js/data/rr-trainers-data.js', 'src/js/data/rr-move-effects.js',
	'src/js/rr-critko.js', 'src/js/rr-battle.js', 'src/js/rr-plan.js',
	'src/js/rr-ai.js', 'src/js/rr-solver.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const S = sandbox.RRSolver;
const TRAINERS = sandbox.RR_TRAINER_DATA;

function battle(id) {
	for (const segment of TRAINERS.segments) {
		for (const b of (segment.battles || [])) if (b.id === id) return b;
	}
	return null;
}
function toSet(mon, fallbackLevel) {
	return {species: mon.species,
		level: mon.level.type === 'fixed' ? mon.level.value : fallbackLevel,
		nature: mon.nature, ability: mon.ability, item: mon.item || '',
		moves: mon.moves.slice(0, 4), evs: mon.evs, ivs: mon.ivs};
}

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, level, moves, extra) {
	return Object.assign({species, level, nature: 'Serious', evs: EVS, ivs: IVS,
		moves, item: '', ability: undefined}, extra || {});
}

// ------------------------------------------------- a faint is a loss, not a cost

{
	const party = [set('Squirtle', 16, ['Water Gun']), set('Pidgey', 14, ['Gust'])];
	const foe = [set('Rattata', 5, ['Tackle'])];
	const strict = B.createState(party, foe, {nuzlocke: true});
	const normal = B.createState(party, foe, {});
	strict.me.team[1].fainted = true;
	normal.me.team[1].fainted = true;
	check('losing a BENCHED Pokemon is a loss under Nuzlocke rules',
		B.isOver(strict) === 'loss', 'got ' + B.isOver(strict));
	check('  and is not a loss without them', B.isOver(normal) === null);
}

// ------------------------------------------------------- max-roll is deterministic

{
	const state = B.createState([set('Charmander', 20, ['Ember'])],
		[set('Bulbasaur', 20, ['Sleep Powder', 'Vine Whip'])], {nuzlocke: true});
	const odds = B.step(state, {type: 'move', index: 0, move: 'Ember'},
		{type: 'move', index: 0, move: 'Sleep Powder'}, {mode: 'odds', forkBudget: 10});
	const flat = B.step(state, {type: 'move', index: 0, move: 'Ember'},
		{type: 'move', index: 0, move: 'Sleep Powder'}, {mode: 'maxroll', risks: {}});
	check('odds mode branches (' + odds.length + ' successors)', odds.length > 1);
	check('max-roll mode does not (' + flat.length + ' successor)', flat.length === 1);
	check('  and that successor is certain', flat[0].probability === 1);
}

// Their damage rolls high; crits stay off until asked for.
{
	const state = B.createState([set('Squirtle', 16, ['Water Gun'])],
		[set('Onix', 14, ['Rock Tomb'], {ability: 'Sturdy'})], {nuzlocke: true});
	const rolls = B.damageRolls(state, 'foe', 'Rock Tomb');
	const plain = B.step(state, {type: 'move', index: 0, move: 'Water Gun'},
		{type: 'move', index: 0, move: 'Rock Tomb'}, {mode: 'maxroll', risks: {}});
	const crit = B.step(state, {type: 'move', index: 0, move: 'Water Gun'},
		{type: 'move', index: 0, move: 'Rock Tomb'}, {mode: 'maxroll', risks: {crit: true}});
	const tookPlain = 45 - B.active(plain[0].state.me).curHP;
	const tookCrit = 45 - B.active(crit[0].state.me).curHP;
	check('without the crit risk they deal their top non-crit roll (' +
		tookPlain + ' vs ' + rolls.noCrit[15] + ')', tookPlain === rolls.noCrit[15]);
	check('with it, they crit (' + tookCrit + ')', tookCrit > tookPlain);
}

// ------------------------------------------------------------ bad luck is budgeted

// "You miss every turn forever" is not unlucky, it is unreachable. A budget of
// one must be spent once and not again.
{
	const state = B.createState([set('Machop', 30, ['Dynamic Punch'])],
		[set('Blissey', 30, ['Tackle'])], {nuzlocke: true});
	let current = state;
	let missed = 0, turns = 0;
	// Only count turns the target was alive for: a dead Pokemon taking no
	// damage is not a miss, which is what this test originally mistook it for.
	while (turns < 4 && !B.active(current.foe).fainted) {
		const before = B.active(current.foe).curHP;
		current = B.step(current, {type: 'move', index: 0, move: 'Dynamic Punch'},
			{type: 'move', index: 0, move: 'Tackle'},
			{mode: 'maxroll', risks: {miss: 1}})[0].state;
		if (B.active(current.foe).curHP === before) missed++;
		turns++;
	}
	check('a miss budget of 1 is spent exactly once (' + missed + ' over ' +
		turns + ' live turns)', missed === 1);
	check('  and the budget is recorded on the state',
		current.luckSpent.miss === 1, JSON.stringify(current.luckSpent));
}

// --------------------------------------------------- the ladder reports honestly

{
	const state = B.createState([set('Squirtle', 16, ['Water Gun', 'Tackle'])],
		[set('Onix', 14, ['Rock Tomb'], {ability: 'Sturdy', item: 'Berry Juice'})],
		{nuzlocke: true});
	const result = S.solveNuzlocke(state, {maxDepth: 8, budget: 60000, timeLimitMs: 20000});

	check('every rung carries a verdict', result.rungs.every(r => r.verdict));
	// A proof search cannot establish that something dies, only fail to find a
	// route, so that word must never appear as a verdict.
	check('no rung is ever labelled as a death',
		result.rungs.every(r => ['safe', 'budget', 'none'].includes(r.verdict)),
		result.rungs.map(r => r.verdict).join(','));

	// The ladder only gets harder, so safety must be a prefix of it.
	let seenUnsafe = false, outOfOrder = false;
	for (const rung of result.rungs) {
		if (!rung.safe) seenUnsafe = true;
		else if (seenUnsafe) outOfOrder = true;
	}
	check('safety is a prefix of the ladder (it only gets harder)', !outOfOrder,
		result.rungs.map(r => r.name + '=' + r.verdict).join(' | '));

	check('the summary never says something died when it only ran out of road',
		!/dies|died/i.test(result.meaning) ||
		result.rungs.some(r => r.verdict === 'none'),
		result.meaning);
}

// --------------------------------------------------- a route, not a verdict

// The ladder is a decision problem and answers "undecided" often enough to be
// useless on its own. planRoute is the optimisation: play the fight out and
// return the best line it saw, whatever it costs.
{
	const party = [
		set('Blastoise', 45, ['Surf', 'Ice Beam', 'Withdraw', 'Rapid Spin']),
		set('Raichu', 45, ['Thunderbolt', 'Quick Attack']),
		set('Victreebel', 45, ['Giga Drain', 'Sleep Powder'])
	];
	const foe = battle('kanto-leaders-brock').team.map(m => toSet(m, 15));
	const route = S.planRoute(B.createState(party, foe, {}), {lookahead: 3, budget: 30000});

	check('a route is returned (' + route.turns + ' turns, ' +
		route.elapsedMs + 'ms)', route.steps.length > 0);
	check('  it reaches a conclusion rather than a depth limit',
		route.won || route.stalled || route.losses > 0);
	check('  every step names an action for both sides',
		route.steps.every(s2 => s2.label && s2.theirLabel));
	check('  and the cost is reported honestly',
		typeof route.losses === 'number' && Array.isArray(route.lostNames));

	// A hopeless team must still get a route back, just a losing one.
	const doomed = S.planRoute(
		B.createState([set('Magikarp', 5, ['Splash', 'Tackle'])], foe, {}),
		{lookahead: 3, budget: 30000});
	check('even a hopeless fight returns a line rather than nothing',
		doomed.steps.length > 0, JSON.stringify({turns: doomed.turns}));
	check('  and does not claim to win it', doomed.won === false);
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
