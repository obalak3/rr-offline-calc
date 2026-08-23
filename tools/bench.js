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

/**
 * Several teams, because one team measures that team.
 *
 * These are BENCHMARK FIXTURES, not advice: ordinary movesets chosen to be
 * unremarkable rather than to answer any particular fight. A planner change
 * that helps one archetype and hurts another is exactly what a single-team
 * benchmark hides.
 */
const TEAMS = {
	balanced: [
		mon('Mienshao', 'Adamant', 'Regenerator', ['Fake Out', 'Drain Punch', 'Detect', 'Rock Tomb']),
		mon('Lanturn', 'Lonely', 'Volt Absorb', ['Scald', 'Confuse Ray', 'Signal Beam', 'Shock Wave']),
		mon('Victreebel', 'Modest', 'Chlorophyll', ['Mega Drain', 'Sludge', 'Sleep Powder', 'Leaf Storm']),
		mon('Diggersby', 'Impish', 'Cheek Pouch', ['Take Down', 'Bulldoze', 'Double Kick', 'Odor Sleuth']),
		mon('Breloom', 'Adamant', 'Effect Spore', ['Headbutt', 'Mach Punch', 'Force Palm', 'Bullet Seed']),
		mon('Lilligant', 'Modest', 'Own Tempo', ['Recover', 'Baby-Doll Eyes', 'Sleep Powder', 'Mega Drain'])
	],
	offensive: [
		mon('Arcanine', 'Adamant', 'Intimidate', ['Flare Blitz', 'Wild Charge', 'Extreme Speed', 'Crunch']),
		mon('Gyarados', 'Adamant', 'Intimidate', ['Waterfall', 'Crunch', 'Ice Fang', 'Dragon Dance']),
		mon('Alakazam', 'Timid', 'Synchronize', ['Psychic', 'Shadow Ball', 'Focus Blast', 'Calm Mind']),
		mon('Snorlax', 'Adamant', 'Thick Fat', ['Body Slam', 'Crunch', 'Earthquake', 'Rest']),
		mon('Jolteon', 'Timid', 'Volt Absorb', ['Thunderbolt', 'Shadow Ball', 'Signal Beam', 'Agility']),
		mon('Nidoking', 'Modest', 'Sheer Force', ['Earth Power', 'Sludge Bomb', 'Ice Beam', 'Thunderbolt'])
	],
	defensive: [
		mon('Blastoise', 'Modest', 'Torrent', ['Surf', 'Ice Beam', 'Withdraw', 'Rapid Spin']),
		mon('Venusaur', 'Modest', 'Overgrow', ['Giga Drain', 'Sludge Bomb', 'Sleep Powder', 'Growth']),
		mon('Skarmory', 'Impish', 'Sturdy', ['Brave Bird', 'Iron Head', 'Roost', 'Spikes']),
		mon('Clefable', 'Bold', 'Magic Guard', ['Moonblast', 'Soft-Boiled', 'Thunder Wave', 'Calm Mind']),
		mon('Slowbro', 'Bold', 'Regenerator', ['Scald', 'Psychic', 'Slack Off', 'Toxic']),
		mon('Steelix', 'Impish', 'Sturdy', ['Earthquake', 'Iron Head', 'Rock Slide', 'Roar'])
	]
};
const IN_RANGE = 45;

/**
 * Scaled-level battles are usable and were being thrown away.
 *
 * Only 37 singles battles carry fixed levels, and just 9 sit at or below the
 * band a mid-game team belongs in -- far too few to tune against without simply
 * fitting those nine. The other 103 say "Highest Lv" or "Highest Lv -2", which
 * resolves against whatever cap you give them, so they benchmark perfectly well
 * and take the sample from 9 to over a hundred.
 */
const battles = [];
for (const segment of TRAINERS.segments) {
	for (const b of (segment.battles || [])) {
		if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
		const fixed = b.team[0].level.type === 'fixed';
		battles.push({battle: b, fixed: fixed,
			level: fixed ? b.team[0].level.value : null});
	}
}

function play(entry, level, edge, team, opts) {
	const foe = entry.battle.team.map(m => ({
		species: m.species, level: m.level.type === 'fixed' ? m.level.value : level,
		nature: m.nature, ability: m.ability, item: m.item || '',
		moves: m.moves.slice(0, 4), evs: m.evs, ivs: m.ivs}));
	B.clearCache();
	return S.planRoute(B.createState(team.map(f => f(level + edge)), foe, {}),
		Object.assign({lookahead: 2, budget: 20000, maxTurns: 30,
			risks: {roll: 'median'}}, opts || {}));
}

function group(name, keep, edge, team, opts) {
	let won = 0, lost = 0, turns = 0, count = 0, ms = 0;
	for (const entry of battles) {
		// A scaled-level battle is run at the cap it is being benchmarked at.
		const level = entry.fixed ? entry.level : keep.at;
		if (!keep.test(level, entry)) continue;
		const started = Date.now();
		const route = play(entry, level, edge, team, opts);
		ms += Date.now() - started;
		count++;
		if (route.won) won++;
		lost += route.losses;
		turns += route.turns;
	}
	if (!count) return null;
	console.log('  ' + name.padEnd(24) + 'won ' + String(won).padStart(3) + '/' +
		String(count).padEnd(4) + ' (' + String(Math.round(100 * won / count)).padStart(3) + '%)' +
		'   lost ' + String(lost).padStart(4) + ' mons' +
		'   avg ' + (turns / count).toFixed(1) + ' turns' +
		'   ' + (ms / count / 1000).toFixed(1) + 's each');
	return {won, count, lost};
}

const opts = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const inRange = {at: 35, test: lv => lv <= IN_RANGE};

let totalWon = 0, totalCount = 0, totalLost = 0;
for (const name of Object.keys(TEAMS)) {
	console.log(name + ', in range, +3 levels:');
	const r = group('  ' + name, inRange, 3, TEAMS[name], opts);
	if (r) { totalWon += r.won; totalCount += r.count; totalLost += r.lost; }
}

console.log('\nout of range (level > ' + IN_RANGE + '), balanced team:');
group('  +3 levels', {at: 70, test: lv => lv > IN_RANGE}, 3, TEAMS.balanced, opts);
group('  +15 levels', {at: 70, test: lv => lv > IN_RANGE}, 15, TEAMS.balanced, opts);

console.log('\nThe in-range rows measure the planner. The out-of-range rows are');
console.log('mostly the team: ordinary Pokemon do not beat optimised ones at any level.');
const rate = totalCount ? totalWon / totalCount : 0;
console.log('\nHEADLINE: ' + Math.round(rate * 100) + '% of ' + totalCount +
	' in-range fights won, ' + totalLost + ' Pokemon lost.');
process.exit(rate >= 0.6 ? 0 : 1);
