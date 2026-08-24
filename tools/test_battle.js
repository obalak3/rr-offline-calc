/**
 * Checks for the battle state and turn transition. Run: node tools/test_battle.js
 *
 * The simulator is only worth trusting if its damage collapses onto the
 * calculator's, so that is the first thing asserted here -- the same discipline
 * tools/test_critko.js uses. Everything after that checks a mechanic the
 * calculator has no opinion about, which is precisely where a solver would
 * otherwise go wrong silently.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));

const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number};
vm.createContext(sandbox);
for (const file of ['src/js/data/rr-move-effects.js', 'src/js/rr-critko.js', 'src/js/rr-battle.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const gen = calc.Generations.get(9);

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}
function eq(name, actual, expected) {
	check(name + ' (' + actual + ')', actual === expected, 'expected ' + expected);
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, extra) {
	return Object.assign({species, level: 50, nature: 'Serious', evs: EVS, ivs: IVS,
		moves: ['Tackle'], item: '', ability: undefined}, extra || {});
}

// ------------------------------------------- damage agrees with the calculator

let mismatches = 0, compared = 0;
const matchups = [
	['Charizard', 'Blissey', 'Flamethrower'], ['Pikachu', 'Gyarados', 'Thunderbolt'],
	['Metagross', 'Tyranitar', 'Meteor Mash'],['Alakazam', 'Chansey', 'Psychic'],
	['Dragonite', 'Lapras', 'Ice Beam'],      ['Scizor', 'Celebi', 'Bullet Punch'],
	['Tyranitar', 'Alakazam', 'Crunch'],      ['Greninja', 'Ferrothorn', 'Flamethrower']
];
for (const [atk, def, move] of matchups) {
	const state = B.createState([set(atk, {moves: [move]})], [set(def)], {});
	const ours = B.damageRolls(state, 'me', move);
	const theirs = calc.calculate(gen,
		new calc.Pokemon(gen, atk, {level: 50, evs: EVS, ivs: IVS}),
		new calc.Pokemon(gen, def, {level: 50, evs: EVS, ivs: IVS}),
		new calc.Move(gen, move), new calc.Field());
	const expected = Array.isArray(theirs.damage) ? theirs.damage : [theirs.damage];
	compared++;
	if (ours.noCrit[0] !== expected[0] || ours.noCrit[15] !== expected[15]) {
		mismatches++;
		console.log('        ' + atk + ' ' + move + ' -> ' + def +
			': ours ' + ours.noCrit[0] + '-' + ours.noCrit[15] +
			', calc ' + expected[0] + '-' + expected[15]);
	}
}
check('damage matches upstream calculate() across ' + compared + ' matchups', mismatches === 0);

// Immunity is a zero, not a failure: the simulator must not report an
// unmodelled mechanic every time a Ground move meets a Flying type.
for (const [atk, def, move] of [['Garchomp', 'Skarmory', 'Earthquake'],
	['Snorlax', 'Gengar', 'Body Slam'], ['Pikachu', 'Garchomp', 'Thunderbolt']]) {
	const state = B.createState([set(atk, {moves: [move]})], [set(def)], {});
	const rolls = B.damageRolls(state, 'me', move);
	check(move + ' vs ' + def + ' is a clean immunity',
		rolls !== null && rolls.immune === true && rolls.noCrit[15] === 0);
	const [next] = B.step(state, {type: 'move', index: 0, move: move},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'expected'});
	check('  and reports nothing unmodelled', next.state.unmodelled.length === 0,
		next.state.unmodelled.join('; '));
}

// ------------------------------------------------------------------ mechanics

// Sturdy and Focus Sash must survive what would otherwise be a OHKO, or the
// solver reports a guaranteed kill that does not happen.
{
	const state = B.createState(
		[set('Garchomp', {moves: ['Earthquake'], level: 100})],
		[set('Shuckle', {ability: 'Sturdy', level: 5})], {});
	const [next] = B.step(state, {type: 'move', index: 0, move: 'Earthquake'},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'worst'});
	eq('Sturdy survives a lethal hit at full HP', next.state.foe.team[0].curHP, 1);
	check('Sturdy holder is not fainted', !next.state.foe.team[0].fainted);
}
{
	const state = B.createState(
		[set('Garchomp', {moves: ['Earthquake'], level: 100})],
		[set('Shuckle', {item: 'Focus Sash', level: 5})], {});
	const [next] = B.step(state, {type: 'move', index: 0, move: 'Earthquake'},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'worst'});
	eq('Focus Sash survives at 1 HP', next.state.foe.team[0].curHP, 1);
	check('Focus Sash is consumed', next.state.foe.team[0].itemGone === true);
}

// Stealth Rock is type-scaled: 4x weak loses half its HP walking in.
{
	const state = B.createState(
		[set('Charizard'), set('Blissey')], [set('Blissey')], {});
	state.me.hazards.stealthrock = 1;
	const mon = state.me.team[0];
	const before = mon.curHP;
	B.applyHazards(state, 'me');
	eq('Stealth Rock takes 4x-weak Charizard to half', mon.curHP, before - Math.floor(before / 2));
}

// Frostbite must halve special damage, and must NOT stop the turn.
{
	const plain = B.createState([set('Alakazam', {moves: ['Psychic']})], [set('Snorlax')], {});
	const cold = B.createState([set('Alakazam', {moves: ['Psychic']})], [set('Snorlax')], {});
	cold.me.team[0].status = 'frb';
	const a = B.damageRolls(plain, 'me', 'Psychic').noCrit[15];
	const b = B.damageRolls(cold, 'me', 'Psychic').noCrit[15];
	check('frostbite halves special damage (' + a + ' -> ' + b + ')',
		b === Math.floor(a * 0.5));

	const [next] = B.step(cold, {type: 'move', index: 0, move: 'Psychic'},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'expected'});
	check('frostbite does not cost the turn',
		next.state.foe.team[0].curHP < next.state.foe.team[0].maxHP);
}

// Toxic escalates rather than sitting at a flat rate.
{
	let state = B.createState([set('Blissey')], [set('Blissey')], {});
	state.me.team[0].status = 'tox';
	state.me.team[0].toxicCounter = 1;
	const max = state.me.team[0].maxHP;
	const first = state.me.team[0].curHP;
	B.endOfTurn(state, {mode: 'expected'});
	const afterOne = state.me.team[0].curHP;
	B.endOfTurn(state, {mode: 'expected'});
	const afterTwo = state.me.team[0].curHP;
	check('toxic damage escalates (' + (first - afterOne) + ' then ' +
		(afterOne - afterTwo) + ')', (afterOne - afterTwo) > (first - afterOne));
}

// Protect stops the hit outright.
{
	const state = B.createState(
		[set('Garchomp', {moves: ['Earthquake']})],
		[set('Blissey', {moves: ['Protect']})], {});
	const [next] = B.step(state, {type: 'move', index: 0, move: 'Earthquake'},
		{type: 'move', index: 0, move: 'Protect'}, {mode: 'expected'});
	eq('Protect blocks the attack entirely',
		next.state.foe.team[0].curHP, next.state.foe.team[0].maxHP);
}

// Substitute eats the damage instead of the Pokemon.
{
	const state = B.createState(
		[set('Pikachu', {moves: ['Thunderbolt']})],
		[set('Blissey', {moves: ['Substitute']})], {});
	const [afterSub] = B.step(state, {type: 'move', index: 0, move: 'Thunderbolt'},
		{type: 'move', index: 0, move: 'Substitute'}, {mode: 'expected'});
	const blissey = afterSub.state.foe.team[0];
	check('Substitute is standing or was broken by the hit',
		blissey.volatiles.substitute !== undefined || blissey.curHP < blissey.maxHP);
}

// Boosts must actually change the damage the calculator returns.
{
	const state = B.createState([set('Garchomp', {moves: ['Earthquake']})], [set('Blissey')], {});
	const base = B.damageRolls(state, 'me', 'Earthquake').noCrit[15];
	state.me.team[0].boosts.atk = 2;
	const boosted = B.damageRolls(state, 'me', 'Earthquake').noCrit[15];
	// +2 doubles the Attack STAT, not the damage: the damage formula's trailing
	// +2 and its floors mean the result lands just under twice the number.
	const ratio = boosted / base;
	check('+2 Attack roughly doubles Earthquake (' + base + ' -> ' + boosted +
		', ' + ratio.toFixed(3) + 'x)', ratio > 1.95 && ratio < 2.0);
}

// Trick Room inverts the order without touching the Speed stats.
{
	const state = B.createState(
		[set('Ninjask', {moves: ['Tackle']})], [set('Shuckle', {moves: ['Tackle']})], {});
	const fast = B.turnOrder(state, {type: 'move', move: 'Tackle'}, {type: 'move', move: 'Tackle'});
	state.field.trickRoom = 5;
	const slow = B.turnOrder(state, {type: 'move', move: 'Tackle'}, {type: 'move', move: 'Tackle'});
	check('Trick Room reverses turn order', fast[0] === 'me' && slow[0] === 'foe',
		JSON.stringify(fast) + ' then ' + JSON.stringify(slow));
}

// Priority beats raw Speed.
{
	const state = B.createState(
		[set('Shuckle', {moves: ['Quick Attack']})], [set('Ninjask', {moves: ['Tackle']})], {});
	const order = B.turnOrder(state,
		{type: 'move', move: 'Quick Attack'}, {type: 'move', move: 'Tackle'});
	check('priority outruns a much faster foe', order[0] === 'me', JSON.stringify(order));
}

// Negative priority has to be signed, or Trick Room goes first.
{
	const state = B.createState(
		[set('Ninjask', {moves: ['Trick Room']})], [set('Shuckle', {moves: ['Tackle']})], {});
	const order = B.turnOrder(state,
		{type: 'move', move: 'Trick Room'}, {type: 'move', move: 'Tackle'});
	check('Trick Room moves last despite higher Speed', order[0] === 'foe',
		JSON.stringify(order));
}

// ------------------------------------------------------ a battle terminates

{
	let state = B.createState(
		[set('Garchomp', {moves: ['Earthquake'], level: 100})],
		[set('Blissey', {moves: ['Tackle'], level: 5}), set('Chansey', {moves: ['Tackle'], level: 5})],
		{});
	let turns = 0, result = null;
	while (turns++ < 50) {
		result = B.isOver(state);
		if (result) break;
		const mine = B.legalActions(state, 'me');
		const theirs = B.legalActions(state, 'foe');
		if (!mine.length || !theirs.length) break;
		state = B.step(state, mine[0], theirs[0], {mode: 'worst'})[0].state;
	}
	check('a one-sided battle terminates in a win (' + turns + ' turns)', result === 'win',
		'got ' + result);
	check('nothing unmodelled came up in that battle',
		state.unmodelled.length === 0, state.unmodelled.join('; '));
}

// ------------------------------------------- moves that cost the user something

// Leaf Storm's Sp. Atk drop is not a "secondary effect" in the ROM, so nothing
// flagged it as missing and the search used it three turns running at full
// power. Same shape for Close Combat and Superpower.
{
	const state = B.createState([set('Victreebel', {moves: ['Leaf Storm']})],
		[set('Blissey', {moves: ['Tackle']})], {});
	const before = B.damageRolls(state, 'me', 'Leaf Storm').noCrit[15];
	const after = B.step(state, {type: 'move', index: 0, move: 'Leaf Storm'},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'maxroll', risks: {}})[0].state;
	eq('Leaf Storm drops the user two stages of Sp. Atk',
		B.active(after.me).boosts.spa, -2);
	const second = B.damageRolls(after, 'me', 'Leaf Storm').noCrit[15];
	check('  so the second one hits for less (' + before + ' -> ' + second + ')',
		second < before);
}
{
	const state = B.createState([set('Machamp', {moves: ['Close Combat']})],
		[set('Blissey', {moves: ['Tackle']})], {});
	const after = B.step(state, {type: 'move', index: 0, move: 'Close Combat'},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'maxroll', risks: {}})[0].state;
	check('Close Combat drops both defences',
		B.active(after.me).boosts.def === -1 && B.active(after.me).boosts.spd === -1);
}

// ------------------------------------------------------------- pivot moves

// U-turn is a damaging move, and only status moves were being dispatched to the
// effect table, so it hit and then stayed in.
{
	const state = B.createState(
		[set('Mienshao', {moves: ['U-turn']}), set('Gyarados', {moves: ['Waterfall']})],
		[set('Blissey', {moves: ['Tackle']})], {});
	const pivots = B.legalActions(state, 'me')
		.filter(a => a.type === 'move' && a.move === 'U-turn');
	check('U-turn offers a choice of who comes in (' + pivots.length + ')',
		pivots.length === 1 && pivots[0].switchTo === 1);
	const after = B.step(state, pivots[0],
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'maxroll', risks: {}})[0].state;
	check('  and it actually switches (' + B.active(after.me).species + ')',
		B.active(after.me).species === 'Gyarados');
	check('  after dealing its damage',
		B.active(after.foe).curHP < B.active(after.foe).maxHP);
}

// With nobody to switch to it still attacks, and says the pivot did nothing.
{
	const state = B.createState([set('Mienshao', {moves: ['U-turn']})],
		[set('Blissey', {moves: ['Tackle']})], {});
	const after = B.step(state, {type: 'move', index: 0, move: 'U-turn'},
		{type: 'move', index: 0, move: 'Tackle'}, {mode: 'maxroll', risks: {}})[0].state;
	check('a lone Pokemon still lands U-turn',
		B.active(after.foe).curHP < B.active(after.foe).maxHP);
	check('  and the failed pivot is reported',
		after.unmodelled.some(u => /pivots/.test(u)), after.unmodelled.join('; '));
}

// ------------------------------------------------------------ self-KO moves

// Self-Destruct has real power and a real type, so it simulated as an ordinary
// attack and the user walked away. That is not a cosmetic gap: the exact search
// used it to "prove" a clean run through Lt. Surge in which Weezing exploded on
// turn 17 and switched out on turn 18. A proof resting on an unimplemented
// mechanic is worse than no proof, so this is pinned.
{
	const state = B.createState(
		[set('Weezing', ['Self-Destruct', 'Sludge']), set('Persian', ['Scratch'])],
		[set('Snorlax', ['Tackle'])], {});
	const after = B.step(state, {type: 'move', index: 0, move: 'Self-Destruct'},
		{type: 'move', index: 0, move: 'Tackle'},
		{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
	const user = after.me.team[0];
	check('Self-Destruct knocks the user out', user.fainted === true &&
		user.curHP === 0, 'left at ' + user.curHP + '/' + user.maxHP);
	check('  and still damages the target',
		after.foe.team[0].curHP < after.foe.team[0].maxHP);
}

// Explosion is the same family and must not have been missed.
{
	const state = B.createState(
		[set('Electrode', ['Explosion', 'Spark']), set('Persian', ['Scratch'])],
		[set('Snorlax', ['Tackle'])], {});
	const after = B.step(state, {type: 'move', index: 0, move: 'Explosion'},
		{type: 'move', index: 0, move: 'Tackle'},
		{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
	check('Explosion knocks the user out too', after.me.team[0].fainted === true);
}

// ------------------------------------------------------- cloning keeps state

// JSON.stringify turns Infinity into null, and permanent weather and terrain
// are stored as Infinity turns -- which is how restricted mode represents
// AI-set weather. A cloned state therefore disagreed with an uncloned one about
// the same position, so positionKey produced two different keys for it.
{
	const state = B.createState([set('Snorlax', ['Tackle'])], [set('Pikachu', ['Thunderbolt'])],
		{terrain: 'Electric', permanentTerrain: true});
	check('permanent terrain starts as Infinity', state.field.terrainTurns === Infinity);
	const copy = B.clone(state);
	check('  and survives a clone', copy.field.terrainTurns === Infinity,
		'became ' + copy.field.terrainTurns);
	check('  so the same position keys the same either way',
		B.positionKey(state) === B.positionKey(copy));
}

// The clone must still be deep, and must still share the immutable set.
{
	const state = B.createState([set('Snorlax', ['Tackle'])], [set('Pikachu', ['Thunderbolt'])], {});
	const copy = B.clone(state);
	copy.me.team[0].curHP = 1;
	copy.me.team[0].boosts.atk = 2;
	copy.me.team[0].pp[0] = 0;
	check('a clone does not share mutable state with its original',
		state.me.team[0].curHP !== 1 && state.me.team[0].boosts.atk !== 2 &&
		state.me.team[0].pp[0] !== 0);
	check('  but does share the set, which is never mutated',
		copy.me.team[0].set === state.me.team[0].set);
}

/**
 * Two abilities the whole-game audit found, which no early battle carries.
 *
 * Both were invisible to every benchmark here because nothing before the Surge
 * cap has them, and both change who WINS rather than by how much -- which is
 * the kind of gap that makes a search confidently wrong rather than slow.
 */
{
	// Head Smash recoils for half of what it deals; Rock Head cancels that
	// entirely. Without this the engine had Mega Aggron beating itself to death,
	// and a search is free to "win" by waiting for an opponent that never dies.
	function afterHeadSmash(ability) {
		const state = B.createState(
			[set('Snorlax', {moves: ['Body Slam']})],
			[set('Aggron', {moves: ['Head Smash'], ability: ability})], {});
		const next = B.step(state, {type: 'move', index: 0, move: 'Body Slam'},
			{type: 'move', index: 0, move: 'Head Smash'},
			{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
		return B.active(next.foe).curHP;
	}
	const rocky = afterHeadSmash('Rock Head');
	const plain = afterHeadSmash('Sturdy');
	check('Rock Head takes no recoil', rocky > plain,
		'Rock Head left ' + rocky + ', plain left ' + plain);
}

{
	// Serene Grace doubles a secondary's chance, which turns Air Slash's 30%
	// flinch into 60% and a Togekiss from an annoyance into a run-ender.
	function flinchChance(ability) {
		const state = B.createState(
			[set('Snorlax', {moves: ['Tackle']})],
			[set('Togekiss', {moves: ['Air Slash'], ability: ability})], {});
		const outs = B.step(state, {type: 'move', index: 0, move: 'Tackle'},
			{type: 'move', index: 0, move: 'Air Slash'},
			{mode: 'odds', forkBudget: 4});
		// The branch where our Snorlax did NOT act is the flinch branch.
		let flinched = 0;
		for (const o of outs) {
			if (B.active(o.state.foe).curHP === B.active(state.foe).maxHP) {
				flinched += o.probability;
			}
		}
		return flinched;
	}
	const graced = flinchChance('Serene Grace');
	const normal = flinchChance('Hustle');
	check('Serene Grace doubles a secondary chance', graced > normal,
		'graced ' + graced.toFixed(3) + ' vs normal ' + normal.toFixed(3));
}

{
	// Speed Boost is a turn-order fact, not a damage one: the check is that the
	// stage actually climbs each turn the Pokemon stays in.
	const state = B.createState(
		[set('Snorlax', {moves: ['Tackle']})],
		[set('Sharpedo', {moves: ['Tackle'], ability: 'Speed Boost'})], {});
	let cur = state;
	for (let i = 0; i < 3; i++) {
		cur = B.step(cur, {type: 'move', index: 0, move: 'Tackle'},
			{type: 'move', index: 0, move: 'Tackle'},
			{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
	}
	const boosted = B.active(cur.foe).boosts.spe;
	check('Speed Boost climbs every turn it stays in', boosted >= 2,
		'spe stage ' + boosted + ' after 3 turns');
	check('  and our side, without it, does not', B.active(cur.me).boosts.spe === 0);
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
