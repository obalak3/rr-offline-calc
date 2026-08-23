/**
 * Checks for the turn advisor. Run: node tools/test_plan.js
 *
 * The advisor is the foundation the search sits on, so what is asserted here is
 * mostly that it cannot be talked into optimism: its stated worst case has to be
 * a worst case that really happens, and it must not recommend something that
 * loses to a reply it already considered.
 *
 * The matchups are ones where the right answer is not a matter of taste. If the
 * advisor cannot tell that Water Gun beats a Rock/Ground Onix, nothing built on
 * top of it is worth running.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));

const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number};
vm.createContext(sandbox);
for (const file of ['src/js/data/rr-move-effects.js', 'src/js/rr-critko.js',
	'src/js/rr-battle.js', 'src/js/rr-plan.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const P = sandbox.RRPlan;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, extra) {
	return Object.assign({species, level: 50, nature: 'Serious', evs: EVS, ivs: IVS,
		moves: ['Tackle'], item: '', ability: undefined}, extra || {});
}

// Brock's actual Onix, straight out of the shipped dataset.
const ONIX = {species: 'Onix', level: 14, nature: 'Bashful', ability: 'Sturdy',
	item: 'Berry Juice', moves: ['Rock Tomb', 'Bulldoze', 'Sleep Talk'], evs: EVS, ivs: IVS};

// --------------------------------------------- it gets the obvious ones right

{
	const state = B.createState([set('Squirtle', {level: 15, nature: 'Modest',
		moves: ['Water Gun', 'Tackle', 'Withdraw', 'Bubble']})], [ONIX], {});
	const plan = P.advise(state, {});
	check('a Water move is the pick against Onix (' + plan.best.label + ')',
		plan.best.action.type === 'move' &&
		['Water Gun', 'Bubble'].includes(plan.best.action.move));
	check('  and it is reported as winning the race',
		plan.best.verdict.startsWith('wins'), plan.best.verdict);
}
{
	const state = B.createState([set('Charmeleon', {level: 15, nature: 'Adamant',
		moves: ['Ember', 'Metal Claw', 'Dragon Rush', 'Swords Dance']})], [ONIX], {});
	const plan = P.advise(state, {});
	const losing = plan.entries.every(e => e.verdict.includes('LOSES'));
	check('every Charmeleon option is reported as losing the race', losing,
		plan.entries.map(e => e.label + '=' + e.verdict).join(' | '));
}

// ------------------------------------------------------- switching is priced

{
	const party = [
		set('Charmeleon', {level: 15, nature: 'Adamant',
			moves: ['Ember', 'Metal Claw', 'Dragon Rush', 'Swords Dance']}),
		set('Squirtle', {level: 15, nature: 'Modest',
			moves: ['Water Gun', 'Tackle', 'Withdraw', 'Bubble']}),
		set('Pidgey', {level: 12, nature: 'Jolly', moves: ['Gust', 'Quick Attack']})
	];
	const plan = P.advise(B.createState(party, [ONIX], {}), {});
	check('switching to the counter beats attacking with the loser (' +
		plan.best.label + ')',
		plan.best.action.type === 'switch' && plan.best.action.index === 1);

	const pidgey = plan.entries.find(e => e.label === 'Switch to Pidgey');
	check('switching into a KO is recognised as losing the Pokemon',
		pidgey && pidgey.verdict === 'loses this Pokemon',
		pidgey ? pidgey.verdict : 'entry missing');
	check('  and it is ranked last', plan.entries[plan.entries.length - 1] === pidgey);
}

// ----------------------------------------------- the worst case is a real one

// Every claim the advisor makes has to be reproducible by replaying the
// exchange it says it is defending against. Otherwise "worst case" is a word.
{
	const party = [
		set('Charmeleon', {level: 15, nature: 'Adamant',
			moves: ['Ember', 'Metal Claw', 'Dragon Rush', 'Swords Dance']}),
		set('Squirtle', {level: 15, nature: 'Modest',
			moves: ['Water Gun', 'Tackle', 'Withdraw', 'Bubble']})
	];
	const state = B.createState(party, [ONIX], {});
	const plan = P.advise(state, {});
	let reproduced = 0, drifted = 0;
	for (const entry of plan.entries) {
		// Must replay in the SAME reading the advisor used, which is max roll
		// with no crits; replaying in worst mode compares against a different
		// exchange and every row looks like it drifted.
		const replay = B.step(state, entry.action, entry.worstReply,
			{mode: 'maxroll', risks: {}})[0].state;
		const mine = B.active(replay.me), theirs = B.active(replay.foe);
		const sameMe = Math.abs(mine.curHP / mine.maxHP - entry.worst.myHP) < 1e-9;
		const sameFoe = Math.abs(theirs.curHP / theirs.maxHP - entry.worst.foeHP) < 1e-9;
		if (sameMe && sameFoe) reproduced++; else drifted++;
	}
	check('every stated worst case replays exactly (' + reproduced + ' of ' +
		plan.entries.length + ')', drifted === 0);
}

// No reply the advisor considered may be worse than the one it reported.
{
	const state = B.createState([set('Squirtle', {level: 15, nature: 'Modest',
		moves: ['Water Gun', 'Tackle', 'Withdraw', 'Bubble']})], [ONIX], {});
	const plan = P.advise(state, {});
	const replies = P.plausibleFoeActions(state, {});
	let violations = 0;
	for (const entry of plan.entries) {
		for (const reply of replies) {
			const after = B.step(state, entry.action, reply,
				{mode: 'maxroll', risks: {}})[0].state;
			const mine = B.active(after.me);
			if (mine.fainted && !entry.worst.iFainted) violations++;
			if (mine.curHP / mine.maxHP < entry.worst.myHP - 1e-9) violations++;
		}
	}
	check('no considered reply is worse than the one reported', violations === 0,
		violations + ' replies beat the stated worst case');
}

// ------------------------------------------------------ it states its footing

{
	const state = B.createState([set('Squirtle', {level: 15})], [ONIX], {});
	const plan = P.advise(state, {});
	check('the assumption is stated rather than implied',
		typeof plan.assumption === 'string' && plan.assumption.includes('worst case'),
		plan.assumption);
	check('the opponent model is the conservative one for now',
		plan.foeActionCount === P.plausibleFoeActions(state, {}).length);
	check('threats are reported independently of what you pick',
		plan.threats.length > 0 && plan.threats[0].ko.max > 0);
	check('nothing unmodelled slipped through silently',
		Array.isArray(plan.unmodelled));
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
