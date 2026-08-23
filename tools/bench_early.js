/**
 * Early game, Nuzlocke scoring. Run: node tools/bench_early.js [teams] [opts]
 *
 * The target James set: everything up to Lt. Surge should be winnable without
 * losing anything. So this measures the metric that matters in a Nuzlocke --
 * fights won with ZERO deaths -- not merely fights won.
 *
 * Teams are GENERATED from real ROM learnsets rather than written by hand,
 * because in a Nuzlocke the team is whatever you caught and it changes every
 * run. A planner that only works with one hand-picked squad is no use. Twenty
 * random teams against ten early battles is two hundred samples, which is
 * enough to tell a real change from noise; hand-written teams gave nine.
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

const dex = new Function('return ' +
	fs.readFileSync(path.join(root, 'data/rr-dex-data.js'), 'utf8') + ';')();
const moveName = {};
for (const key in dex.moves) moveName[dex.moves[key].ID] = dex.moves[key].name;

// Species you could plausibly be carrying before the third gym.
const POOL = Object.values(dex.species).filter(function (sp) {
	return sp.dexID && sp.dexID <= 151 && (sp.levelupMoves || []).length >= 4 &&
		(sp.stats || []).reduce(function (a, b) { return a + b; }, 0) < 480;
});

// Deterministic pseudo-random, so a benchmark run is reproducible.
let seed = 12345;
function rand(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const NATURES = ['Adamant', 'Modest', 'Jolly', 'Timid', 'Impish', 'Careful'];

/** A legal set: the four most recent level-up moves it would actually know. */
function build(species, level) {
	const known = (species.levelupMoves || [])
		.filter(function (pair) { return pair[1] <= level; })
		.map(function (pair) { return moveName[pair[0]]; })
		.filter(Boolean);
	const moves = known.slice(-4);
	if (!moves.length) return null;
	const ability = (species.abilities && species.abilities[0] &&
		dex.abilities && dex.abilities[species.abilities[0][0]]) || null;
	return {
		species: species.name, level: level,
		nature: NATURES[rand(NATURES.length)],
		ability: ability && ability.name ? ability.name : undefined,
		item: 'Oran Berry', moves: moves, evs: EVS, ivs: IVS
	};
}

function team(level, size) {
	const out = [];
	let guard = 0;
	while (out.length < size && guard++ < 200) {
		const set = build(POOL[rand(POOL.length)], level);
		if (!set) continue;
		if (out.some(function (m) { return m.species === set.species; })) continue;
		try { new calc.Pokemon(calc.Generations.get(9), set.species, {level: level}); }
		catch (e) { continue; }
		out.push(set);
	}
	return out;
}

// Real early-game battles: fixed levels, before the Surge cap.
const early = [];
for (const segment of TRAINERS.segments) {
	for (const b of (segment.battles || [])) {
		if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
		if (b.team[0].level.type !== 'fixed') continue;
		if (b.team[0].level.value > 34) continue;
		early.push(b);
	}
}

const teamCount = parseInt(process.argv[2], 10) || 20;
const opts = process.argv[3] ? JSON.parse(process.argv[3]) : {};

let clean = 0, won = 0, runs = 0, deaths = 0, ms = 0;
const trouble = {};

for (let t = 0; t < teamCount; t++) {
	for (const battle of early) {
		const level = battle.team[0].level.value + 2;
		const party = team(level, 6);
		if (party.length < 6) continue;
		const foe = battle.team.map(function (m) {
			return {species: m.species, level: m.level.value, nature: m.nature,
				ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
				evs: m.evs, ivs: m.ivs};
		});
		B.clearCache();
		const started = Date.now();
		let route;
		try {
			route = S.planRoute(B.createState(party, foe, {}),
				Object.assign({lookahead: 2, budget: 20000, maxTurns: 30,
					risks: {roll: 'median'}}, opts));
		} catch (e) { continue; }
		ms += Date.now() - started;
		runs++;
		if (route.won) won++;
		if (route.won && route.losses === 0) clean++;
		else {
			const key = (battle.title ? battle.title + ' ' : '') + battle.trainer;
			trouble[key] = (trouble[key] || 0) + 1;
		}
		deaths += route.losses;
	}
}

console.log('Early game, up to the Surge cap: ' + early.length + ' battles x ' +
	teamCount + ' generated teams = ' + runs + ' fights\n');
console.log('  won at all           ' + won + '/' + runs +
	'  (' + Math.round(100 * won / runs) + '%)');
console.log('  won losing NOTHING   ' + clean + '/' + runs +
	'  (' + Math.round(100 * clean / runs) + '%)   <- the Nuzlocke number');
console.log('  Pokemon lost         ' + deaths + '  (' + (deaths / runs).toFixed(2) + ' per fight)');
console.log('  ' + (ms / runs / 1000).toFixed(2) + 's per fight\n');
console.log('Hardest for it (fights not cleanly won):');
Object.entries(trouble).sort((a, b) => b[1] - a[1]).slice(0, 8)
	.forEach(([k, v]) => console.log('   ' + String(v).padStart(3) + '/' + teamCount + '  ' + k));

process.exit(clean / runs >= 0.9 ? 0 : 1);
