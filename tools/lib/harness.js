/**
 * The shared benchmark harness: engines, dex, generated teams, real teams.
 *
 * WHY THIS EXISTS. tools/bench_early.js and tools/ceiling.js each carried their
 * own copy of the team generator, with a comment in the second promising it was
 * "kept identical" to the first. They had already drifted -- ceiling.js loads a
 * different set of engine files and ranks switches with an older rule -- so the
 * two tools were measuring the same fights with different machinery while
 * reporting numbers meant to be compared against each other. A benchmark and its
 * oracle disagreeing quietly is worse than either being wrong loudly.
 *
 * Everything here is measurement scaffolding. No search logic lives in this
 * file: engines are loaded, never reimplemented.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');

/**
 * Load the engine the way the page does: plain scripts sharing one global.
 *
 * The file list matches tools/build_worker.js `engineFiles` plus the data the
 * bench needs, so a tool cannot silently measure a different engine from the one
 * that ships.
 */
function loadEngine() {
	const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
	const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number,
		Date, String, Boolean, isNaN, parseInt, parseFloat};
	vm.createContext(sandbox);
	const files = [
		'src/js/data/rr-trainers-data.js', 'src/js/data/rr-move-effects.js',
		'src/js/rr-critko.js', 'src/js/rr-battle.js', 'src/js/rr-ai.js',
		'src/js/rr-plan.js', 'src/js/rr-solver.js', 'src/js/rr-mcts.js',
		'src/js/rr-exact.js'
	];
	// rr-matchup.js is loaded when present so this harness works both before and
	// after that file exists.
	const optional = ['src/js/rr-matchup.js'];
	for (const file of files.concat(optional)) {
		const full = path.join(root, 'upstream-calc', file);
		if (!fs.existsSync(full)) {
			if (optional.includes(file)) continue;
			throw new Error('missing engine file: ' + file);
		}
		vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox);
	}
	return {
		calc: calc,
		sandbox: sandbox,
		B: sandbox.RRBattle,
		S: sandbox.RRSolver,
		M: sandbox.RRMCTS,
		X: sandbox.RRExact,
		AI: sandbox.RRAI,
		MU: sandbox.RRMatchup || null,
		TRAINERS: sandbox.RR_TRAINER_DATA
	};
}

/** The raw dex snapshot, plus the two id-to-thing maps every caller wants. */
function loadDex() {
	const dex = new Function('return ' +
		fs.readFileSync(path.join(root, 'data/rr-dex-data.js'), 'utf8') + ';')();
	const moveName = {};
	for (const key in dex.moves) moveName[dex.moves[key].ID] = dex.moves[key].name;
	const byID = {};
	for (const key in dex.species) byID[dex.species[key].ID] = dex.species[key];
	return {dex: dex, moveName: moveName, byID: byID};
}

/**
 * Generated teams, exactly as tools/bench_early.js built them.
 *
 * Evolution methods, read from the dex: 4 / 22 / 23 are level-up at a level, 7
 * is a stone, 1 is friendship, and 254 is MEGA evolution, which the player does
 * not get for free and must never be applied. Skipping this was what fed the
 * benchmark level 44 Poliwags for weeks.
 */
function makeGenerator(loaded, dexParts, startSeed) {
	const {calc} = loaded;
	const {dex, moveName, byID} = dexParts;
	const BY_LEVEL = {4: true, 22: true, 23: true};
	const EARNED = {7: true, 1: true};   // stones and friendship: assume by mid-game

	function evolve(species, level) {
		const chain = [species];
		let current = species;
		for (let hop = 0; hop < 4; hop++) {
			let next = null;
			for (const evo of (current.evolutions || [])) {
				const method = evo[0], param = evo[1], target = byID[evo[2]];
				if (!target || target.ID === current.ID) continue;
				if (BY_LEVEL[method] && param <= level) { next = target; break; }
				if (EARNED[method] && level >= 28) { next = target; break; }
			}
			if (!next) break;
			current = next;
			chain.push(current);
		}
		return {species: current, chain: chain};
	}

	const POOL = Object.values(dex.species).filter(function (sp) {
		return sp.dexID && sp.dexID <= 143 && (sp.levelupMoves || []).length >= 4 &&
			!(sp.name || '').includes('-');
	});

	// Deterministic pseudo-random, so a benchmark run is reproducible.
	let seed = startSeed === undefined ? 12345 : startSeed;
	function rand(n) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	}

	const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
	const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
	const NATURES = ['Adamant', 'Modest', 'Jolly', 'Timid', 'Impish', 'Careful'];

	/** A legal set: the four most recent level-up moves it would actually know. */
	function build(base, level) {
		const grown = evolve(base, level);
		// Moves come from the WHOLE line, not just the final form: a Poliwrath
		// still knows what it learned as a Poliwag, and several evolved forms have
		// almost no level-up list of their own.
		const seen = {}, known = [];
		for (const stage of grown.chain) {
			for (const pair of (stage.levelupMoves || [])) {
				if (pair[1] > level) continue;
				const name = moveName[pair[0]];
				if (!name || seen[name]) continue;
				seen[name] = true;
				known.push(name);
			}
		}
		const moves = known.slice(-4);
		if (!moves.length) return null;
		const ability = (grown.species.abilities && grown.species.abilities[0] &&
			dex.abilities && dex.abilities[grown.species.abilities[0][0]]) || null;
		return {species: grown.species.name, level: level,
			nature: NATURES[rand(NATURES.length)],
			ability: ability && ability.name ? ability.name : undefined,
			item: 'Oran Berry', moves: moves, evs: EVS, ivs: IVS};
	}

	function team(level, size) {
		const out = [];
		let guard = 0;
		while (out.length < size && guard++ < 300) {
			const set = build(POOL[rand(POOL.length)], level);
			if (!set) continue;
			if (out.some(m => m.species === set.species)) continue;
			try { new calc.Pokemon(calc.Generations.get(9), set.species, {level: level}); }
			catch (e) { continue; }
			out.push(set);
		}
		return out;
	}

	return {team: team, build: build, evolve: evolve, pool: POOL};
}

/**
 * Fixed-level singles battles, optionally capped by level.
 *
 * `maxLevel` defaults to 34, the Surge cap, because that is what every number
 * recorded in docs/TUNING.md was measured against. Passing a higher cap opens up
 * the rest of the game: there are 37 fixed-level singles battles in the dataset
 * and the benchmark has only ever used nine of them. The other 28 include the
 * whole Indigo League at level 85 with six a side, which is a different regime
 * from a level 20 gym and had never been measured at all.
 *
 * The remaining 103 singles battles scale their levels to the player's, so they
 * need a level assumption rather than a lookup, and 27 are doubles.
 */
function earlyBattles(loaded, opts) {
	const only = (opts && opts.pattern) || null;
	const maxLevel = (opts && opts.maxLevel) || 34;
	const segmentFilter = (opts && opts.segment) || null;
	const out = [];
	for (const segment of loaded.TRAINERS.segments) {
		if (segmentFilter && segment.name !== segmentFilter) continue;
		for (const b of (segment.battles || [])) {
			if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
			if (b.team[0].level.type !== 'fixed') continue;
			if (b.team[0].level.value > maxLevel) continue;
			if (only && !only.test(label(b))) continue;
			b.__segment = segment.name;
			out.push(b);
		}
	}
	return out;
}

function label(battle) {
	return (battle.title ? battle.title + ' ' : '') + battle.trainer;
}

/** A trainer's team in the shape RRBattle.createState wants. */
function foeSets(battle) {
	return battle.team.map(function (m) {
		return {species: m.species, level: m.level.value, nature: m.nature,
			ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
			evs: m.evs, ivs: m.ivs};
	});
}

/**
 * The real party, read off the save.
 *
 * Read it, never ask for it: it is sitting on disk. `--json` prints the party as
 * the last line, after the human-readable dump.
 */
function realTeam() {
	const {execFileSync} = require('child_process');
	const out = execFileSync('node', [path.join(root, 'tools/read_save.js'), '--json'],
		{encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
	const lines = out.trim().split('\n');
	return JSON.parse(lines[lines.length - 1]);
}

module.exports = {root, loadEngine, loadDex, makeGenerator, earlyBattles,
	label, foeSets, realTeam};
