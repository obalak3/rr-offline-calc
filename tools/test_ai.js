/**
 * Checks for the Radical Red AI model. Run: node tools/test_ai.js
 *
 * The model exists to narrow the opponent's branching from "every legal action"
 * to "what it would actually do". Narrowing is the direction that can be WRONG:
 * drop a move the AI really plays and every result built on it is false. So the
 * checks here are mostly about the set staying honest rather than staying small.
 *
 * Scoring constants are cited to CFRU source lines in rr-ai.js. Where a rule is
 * not ported the move keeps its base 100, which leaves it in the set.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number, Date};
vm.createContext(sandbox);
for (const file of ['src/js/data/rr-move-effects.js', 'src/js/rr-critko.js',
	'src/js/rr-battle.js', 'src/js/rr-plan.js', 'src/js/rr-ai.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const AI = sandbox.RRAI;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, moves, extra) {
	return Object.assign({species, level: 50, nature: 'Serious', evs: EVS, ivs: IVS,
		moves, item: '', ability: undefined}, extra || {});
}
const BOSS = {checkBadMove: true, checkGoodMove: true};

function scoreOf(state, key, move, flags) {
	const entry = AI.scoreAll(state, key, flags || BOSS, {})
		.find(e => e.action.type === 'move' && e.action.move === move);
	return entry ? entry.score : null;
}

// ------------------------------------------------------------- base and floor

{
	const state = B.createState([set('Blissey', ['Tackle'])], [set('Blissey', ['Tackle'])], {});
	check('an unremarkable move sits at the base score of 100',
		scoreOf(state, 'foe', 'Tackle', {checkBadMove: true}) === AI.BASE);
}

// A move that cannot do anything must be scored down hard.
{
	const state = B.createState([set('Garchomp', ['Tackle'])],
		[set('Pikachu', ['Thunderbolt', 'Tackle'])], {});
	const immune = scoreOf(state, 'foe', 'Thunderbolt');
	check('an immune move is penalised (' + immune + ')', immune <= AI.BASE - 20);
	check('  and is beaten by a move that works',
		scoreOf(state, 'foe', 'Tackle') > immune);
}

// ------------------------------------------------------------- the kill bonus

{
	const state = B.createState([set('Blissey', ['Tackle'])],
		[set('Garchomp', ['Earthquake', 'Swords Dance'])], {});
	const healthy = scoreOf(state, 'foe', 'Earthquake');
	B.active(state.me).curHP = 1;
	const lethal = scoreOf(state, 'foe', 'Earthquake');
	check('a killable target raises the attacking move (' + healthy + ' -> ' + lethal + ')',
		lethal > healthy);
	check('  by the +9 from DamageMoveViabilityIncrease when it moves first',
		lethal === AI.BASE + 9, 'got ' + lethal);
}

// ------------------------------------------------------- redundant status moves

{
	const state = B.createState([set('Blissey', ['Tackle'])],
		[set('Gengar', ['Will-O-Wisp', 'Shadow Ball'])], {});
	const fresh = scoreOf(state, 'foe', 'Will-O-Wisp');
	B.active(state.me).status = 'brn';
	const wasted = scoreOf(state, 'foe', 'Will-O-Wisp');
	check('burning an already-burned target is penalised (' + fresh + ' -> ' + wasted + ')',
		wasted === fresh - 10);
}
{
	const state = B.createState([set('Blissey', ['Tackle'])],
		[set('Garchomp', ['Swords Dance', 'Earthquake'])], {});
	const fresh = scoreOf(state, 'foe', 'Swords Dance');
	B.active(state.foe).boosts.atk = 6;
	const capped = scoreOf(state, 'foe', 'Swords Dance');
	check('boosting at +6 is penalised (' + fresh + ' -> ' + capped + ')',
		capped === fresh - 10);
}

// ------------------------------------------------- the set must stay honest

// Whatever else it does, the plausible set must contain the highest-scoring
// action. Dropping the argmax is the one failure that invalidates everything.
{
	const positions = [
		[set('Blissey', ['Tackle'])], [set('Garchomp', ['Earthquake'])],
		[set('Gengar', ['Shadow Ball'])], [set('Skarmory', ['Brave Bird'])]
	];
	let missing = 0, checked = 0;
	for (const party of positions) {
		const state = B.createState(party,
			[set('Garchomp', ['Earthquake', 'Swords Dance', 'Thunder Wave', 'Roost'])], {});
		for (const hp of [1, 20, 200]) {
			B.active(state.me).curHP = Math.min(hp, B.active(state.me).maxHP);
			const scored = AI.scoreAll(state, 'foe', BOSS, {});
			const best = Math.max.apply(null, scored.map(e => e.score));
			const set0 = AI.plausible(state, 'foe', {margin: 0, flagSets: [BOSS]});
			const ids = set0.actions.map(a => a.type === 'switch' ? 's' + a.index : a.move);
			for (const entry of scored) {
				if (entry.score !== best) continue;
				checked++;
				const id = entry.action.type === 'switch' ? 's' + entry.action.index
					: entry.action.move;
				if (!ids.includes(id)) missing++;
			}
		}
	}
	check('the top-scoring action is always in the set (' + checked + ' checked)',
		missing === 0, missing + ' argmax actions dropped');
}

// A wider margin can only ever add actions, never remove them.
{
	const state = B.createState([set('Blissey', ['Tackle'])],
		[set('Garchomp', ['Earthquake', 'Swords Dance', 'Thunder Wave', 'Roost'])], {});
	const tight = AI.plausible(state, 'foe', {margin: 0, flagSets: [BOSS]}).actions.length;
	const loose = AI.plausible(state, 'foe', {margin: 30, flagSets: [BOSS]}).actions.length;
	check('a wider margin never shrinks the set (' + tight + ' -> ' + loose + ')',
		loose >= tight);
}

// ------------------------------------------------------- gaps are reported

{
	const state = B.createState([set('Blissey', ['Tackle'])],
		[set('Garchomp', ['Earthquake', 'Swords Dance']), set('Gengar', ['Shadow Ball'])], {});
	const result = AI.plausible(state, 'foe', {});
	check('switching being unported is reported rather than hidden',
		result.notes.switching === true, JSON.stringify(result.notes));
	check('  and switches stay in the set because of it',
		result.actions.some(a => a.type === 'switch'));
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
