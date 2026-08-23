/**
 * How well does the planner actually play? Run: node tools/bench.js [sample]
 *
 * This exists because of a number I quoted and should not have: "6 of 28",
 * reported as the state of the planner. It was measured by sending a four
 * Pokemon, level-34 team -- Mienshao holding Rock Tomb and Detect -- into
 * postgame boss fights. That measures a hopeless team, not a planner.
 *
 * So the benchmark separates the two. It runs a fixed team against battles
 * inside the level range it was built for, at several level advantages, and
 * separately against battles it has no business in. A planner problem shows up
 * as a poor result in the first group; a team problem only in the second.
 *
 * Run it before and after changing anything in the evaluation. One fight is not
 * evidence, and tuning against one fight is how the weights ended up mattering
 * not at all.
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
	'src/js/rr-critko.js', 'src/js/rr-battle.js', 'src/js/rr-ai.js',
	'src/js/rr-plan.js', 'src/js/rr-solver.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const S = sandbox.RRSolver;
const TRAINERS = sandbox.RR_TRAINER_DATA;

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const mon = (species, nature, ability, moves) => level => ({
	species, level, nature, ability, item: 'Sitrus Berry', moves, evs: EVS, ivs: IVS});

// A mid-game team, deliberately ordinary: this measures the planner, not a
// hand-picked answer to each fight.
const TEAM = [
	mon('Mienshao', 'Adamant', 'Regenerator', ['Fake Out', 'Drain Punch', 'Detect', 'Rock Tomb']),
	mon('Lanturn', 'Lonely', 'Volt Absorb', ['Scald', 'Confuse Ray', 'Signal Beam', 'Shock Wave']),
	mon('Victreebel', 'Modest', 'Chlorophyll', ['Mega Drain', 'Sludge', 'Sleep Powder', 'Leaf Storm']),
	mon('Diggersby', 'Impish', 'Cheek Pouch', ['Take Down', 'Bulldoze', 'Double Kick', 'Odor Sleuth']),
	mon('Breloom', 'Adamant', 'Effect Spore', ['Headbutt', 'Mach Punch', 'Force Palm', 'Bullet Seed']),
	mon('Lilligant', 'Modest', 'Own Tempo', ['Recover', 'Baby-Doll Eyes', 'Sleep Powder', 'Mega Drain'])
];
const IN_RANGE = 40;   // the level band this team is built for

const battles = [];
for (const segment of TRAINERS.segments) {
	for (const b of (segment.battles || [])) {
		if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
		if (b.team[0].level.type !== 'fixed') continue;   // scaled levels need a cap
		battles.push(b);
	}
}

function play(battle, edge, opts) {
	const level = battle.team[0].level.value;
	const foe = battle.team.map(m => ({
		species: m.species, level: m.level.type === 'fixed' ? m.level.value : level,
		nature: m.nature, ability: m.ability, item: m.item || '',
		moves: m.moves.slice(0, 4), evs: m.evs, ivs: m.ivs}));
	B.clearCache();
	return S.planRoute(B.createState(TEAM.map(f => f(level + edge)), foe, {}),
		Object.assign({lookahead: 2, budget: 20000, maxTurns: 30,
			risks: {roll: 'median'}}, opts || {}));
}

function group(name, keep, edge, opts) {
	let won = 0, lost = 0, turns = 0, count = 0, ms = 0;
	for (const battle of battles) {
		if (!keep(battle.team[0].level.value)) continue;
		const started = Date.now();
		const route = play(battle, edge, opts);
		ms += Date.now() - started;
		count++;
		if (route.won) won++;
		lost += route.losses;
		turns += route.turns;
	}
	if (!count) return null;
	console.log('  ' + name.padEnd(30) + 'won ' + String(won).padStart(3) + '/' +
		String(count).padEnd(4) + ' (' + String(Math.round(100 * won / count)).padStart(3) + '%)' +
		'   lost ' + String(lost).padStart(3) + ' mons' +
		'   avg ' + (turns / count).toFixed(1) + ' turns' +
		'   ' + (ms / count / 1000).toFixed(1) + 's each');
	return {won, count, lost};
}

const opts = process.argv[2] ? JSON.parse(process.argv[2]) : {};
console.log('Battles this team is built for (level <= ' + IN_RANGE + '):');
const fair = group('+3 levels', lv => lv <= IN_RANGE, 3, opts);
group('+8 levels', lv => lv <= IN_RANGE, 8, opts);

console.log('\nBattles it has no business in (level > ' + IN_RANGE + '):');
group('+3 levels', lv => lv > IN_RANGE, 3, opts);
group('+15 levels', lv => lv > IN_RANGE, 15, opts);

console.log('\nThe first group is the planner. The second is mostly the team:');
console.log('six ordinary Pokemon do not beat six optimised ones at any level.');
if (fair) {
	const rate = fair.won / fair.count;
	console.log('\nHeadline: ' + Math.round(rate * 100) + '% of in-range fights won, ' +
		fair.lost + ' Pokemon lost across ' + fair.count + '.');
	process.exit(rate >= 0.6 ? 0 : 1);
}
