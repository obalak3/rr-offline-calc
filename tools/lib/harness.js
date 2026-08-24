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

	/**
	 * The species a player could plausibly be carrying, WHICH DEPENDS ON WHEN.
	 *
	 * Before the third gym that is a Kanto line, and the pool was hard-coded to
	 * exactly that. Applied to the Elite Four it produced a level 87 Pikachu,
	 * Electrode and Kingler against Zacian-Crowned, Iron Valiant and Great Tusk,
	 * and the search correctly proved the fight unwinnable in 161 nodes -- which
	 * looked exactly like the planner failing the Elite Four 0 for 9.
	 *
	 * This is the same mistake `TUNING.md` already records under "the benchmark
	 * was measuring the wrong fights", where a base-stat filter meant to exclude
	 * legendaries sent level 44 Poliwags into Lt. Surge. It was written down, and
	 * it still happened again in a new form, so it is worth stating as a rule
	 * rather than an anecdote: **a generated team has to be the team someone
	 * would actually have at that point in the run**, and every time the
	 * benchmark reaches a new part of the game that question has to be asked
	 * again.
	 *
	 * The pool now widens with level, in the shape a real run does: early on you
	 * have whatever Kanto thing you caught, and by the Elite Four you have six
	 * fully evolved Pokemon chosen on purpose.
	 */
	function poolFor(level) {
		const all = Object.values(dex.species).filter(function (sp) {
			return sp.dexID && (sp.levelupMoves || []).length >= 4 &&
				!(sp.name || '').includes('-');
		});
		if (level <= 40) {
			return all.filter(function (sp) { return sp.dexID <= 143; });
		}
		// Past the early game: anything fully evolved and not absurd. The cap on
		// total stats keeps box legendaries out, since the player does not have
		// one, while leaving genuinely strong final forms in.
		return all.filter(function (sp) {
			if ((sp.evolutions || []).some(function (e) { return e[0] !== 254; })) {
				return false;   // still evolves, so not what you would be carrying
			}
			const total = (sp.stats || []).reduce(function (a, b) { return a + b; }, 0);
			return total >= 400 && total <= 600;
		});
	}

	const POOL = poolFor(0);

	// Deterministic pseudo-random, so a benchmark run is reproducible.
	let seed = startSeed === undefined ? 12345 : startSeed;
	function rand(n) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	}

	/**
	 * EVs, which the generator used to leave at zero everywhere.
	 *
	 * Nobody arrives at the Elite Four with a blank stat spread. Zero EVs costs
	 * roughly fifty points of a stat at level 85, which against teams built to
	 * win is the difference between trading and being swept -- and it made the
	 * late-game benchmark ask whether an untrained team can sweep a trained one,
	 * a question whose answer is no and which says nothing about the planner.
	 *
	 * Early game keeps the zero spread, because that IS what a Nuzlocke team
	 * looks like before the third gym, and because every number recorded in
	 * TUNING.md was measured against it.
	 */
	/**
	 * What Restricted mode takes away from the PLAYER.
	 *
	 * This save is on Restricted / Minimal Grinding, which is not a difficulty
	 * setting but a rules change, and it is asymmetric: the player loses these,
	 * the trainers keep everything. That asymmetry is why the AI's weather and
	 * terrain are permanent -- Pincurchin still has Electric Surge, and the
	 * engine is right to model Lt. Surge's terrain as never expiring.
	 *
	 * The generator was building teams with moves the player cannot legally
	 * have: 20 of 240 generated Pokemon carried one, including Electric Terrain,
	 * Quiver Dance and Toxic Spikes. That is the same class of error as the
	 * Poliwags and the level 87 Pikachu -- a team nobody could field -- and this
	 * time it flatters the player rather than handicapping them.
	 *
	 * Source: the community Hardcore/Restricted documentation. Growth is
	 * deliberately NOT here: it is not on the banned list, which matters because
	 * the proved Lt. Surge line sets up Growth twice and would otherwise have
	 * been an illegal line all along.
	 */
	const RESTRICTED_MOVES = {
		"Shell Smash": 1, "Quiver Dance": 1, "Dragon Dance": 1, "Calm Mind": 1,
		"Bulk Up": 1, "Curse": 1, "Rain Dance": 1, "Sandstorm": 1, "Hail": 1,
		"Sunny Day": 1, "Tailwind": 1, "Electric Terrain": 1, "Misty Terrain": 1,
		"Grassy Terrain": 1, "Psychic Terrain": 1, "Toxic Spikes": 1,
		"Sticky Web": 1, "Shift Gear": 1, "Tail Glow": 1, "Coil": 1,
		"Belly Drum": 1, "Cotton Guard": 1, "No Retreat": 1, "Amnesia": 1,
		"Acid Armor": 1, "Iron Defense": 1, "Cosmic Power": 1, "Stockpile": 1,
		"Swallow": 1, "Spit Up": 1, "Geomancy": 1, "Clangorous Soul": 1,
		"Fell Stinger": 1
	};

	/** Banned abilities are REPLACED rather than removed, so a set stays legal. */
	const RESTRICTED_ABILITIES = {
		"Drought": "Solar Power", "Sand Stream": "Sand Force",
		"Sand Spit": "Sand Force", "Snow Warning": "Slush Rush",
		"Drizzle": "Swift Swim", "Speed Boost": "Infiltrator",
		"Contrary": "Clear Body", "Defiant": "Clear Body",
		"Competitive": "Clear Body", "Electric Surge": "Telepathy",
		"Grassy Surge": "Telepathy", "Misty Surge": "Telepathy",
		"Psychic Surge": "Telepathy", "Moxie": "Unnerve",
		"Grim Neigh": "Unnerve", "Soul-Heart": "Unnerve",
		"Beast Boost": "Unnerve", "Imposter": "Limber",
		"Magic Bounce": "Magic Guard", "Storm Drain": "Water Absorb",
		"Lightning Rod": "Volt Absorb", "Motor Drive": "Volt Absorb",
		"Trace": "Synchronize", "Stamina": "Inner Focus"
	};

	const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

	/** A trained spread: bulk, plus the better attacking stat, plus speed. */
	function evsFor(level, species) {
		if (level <= 40) return EVS;
		const stats = species.stats || [];
		const physical = (stats[1] || 0) >= (stats[3] || 0);
		return {
			hp: 252,
			atk: physical ? 252 : 0,
			spa: physical ? 0 : 252,
			def: 0, spd: 0, spe: 4
		};
	}
	const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
	const NATURES = ['Adamant', 'Modest', 'Jolly', 'Timid', 'Impish', 'Careful'];

	/**
	 * The TM and tutor pools, which are the real late-game movesets.
	 *
	 * `species.tmMoves` is a list of TM NUMBERS, not move ids -- they run 0 to
	 * 125 and sort ascending, which is what gave it away. The dex carries the
	 * lookup at top level as `tmMoves` and `tutorMoves`, 128 entries each. Read
	 * straight as move ids they decode to nonsense, which is why the first pass
	 * at this concluded the format was undecipherable and parked it: Medicham
	 * came out knowing Gust and Horn Attack. Through the lookup it comes out
	 * with Close Combat, Zen Headbutt, Psychic, Brick Break and Aura Sphere,
	 * which is a Medicham somebody would actually bring.
	 */
	function taughtMoves(species) {
		const out = [];
		for (const [field, table] of [['tmMoves', dex.tmMoves],
			['tutorMoves', dex.tutorMoves]]) {
			for (const index of (species[field] || [])) {
				const id = table && table[index];
				const name = id !== undefined ? moveName[id] : null;
				if (name) out.push(name);
			}
		}
		return out;
	}

	/**
	 * Pick a moveset the way a player would, rather than at random.
	 *
	 * This is the third time this benchmark has been caught measuring teams
	 * nobody would field, and the subtlest. The species were right, the levels
	 * were right, the EVs were right -- and the moves were **two random level-up
	 * moves plus two random TMs**, which produced a Medicham carrying Recover,
	 * Counter, Pain Split and Drain Punch (one attacking move) and a Beheeyem
	 * carrying Guard Split, Power Split, Return and Toxic (effectively none).
	 *
	 * Nobody walks into the Elite Four like that. A Nuzlocke restricts WHICH
	 * Pokemon you have; it does not stop you teaching them their best moves. So
	 * a random species with a chosen moveset is the honest model of a Nuzlocke
	 * team, and a random species with a random moveset is not a model of
	 * anything.
	 *
	 * The rule: the strongest same-type attack first, since that is what any
	 * player leads with, then the strongest attacks of DIFFERENT types for
	 * coverage, then at most one piece of utility. Ties break on power, so this
	 * is deterministic and the benchmark stays reproducible.
	 */
	function chooseMoveset(pool, species) {
		const byName = {};
		for (const key in dex.moves) byName[dex.moves[key].name] = dex.moves[key];
		const speciesTypes = species.type || [];

		const scored = [];
		for (const name of pool) {
			const data = byName[name];
			if (!data) continue;
			const damaging = data.power > 0;
			const stab = speciesTypes.indexOf(data.type) >= 0;
			scored.push({
				name: name, data: data, damaging: damaging, stab: stab,
				// Accuracy matters: a 120-power move that lands 70% of the time
				// is worse than a 90-power one that always does, and a player
				// picking moves knows it.
				value: damaging ? data.power * (data.accuracy || 100) / 100 *
					(stab ? 1.5 : 1) : 0
			});
		}
		scored.sort(function (a, b) { return b.value - a.value; });

		const picked = [], typesUsed = {};
		for (const entry of scored) {
			if (picked.length >= 3 || !entry.damaging) continue;
			// One attack per type: four Fire moves is not coverage.
			if (typesUsed[entry.data.type]) continue;
			typesUsed[entry.data.type] = true;
			picked.push(entry.name);
		}
		// One utility slot, if the pool has anything worth the space.
		const utility = scored.find(function (e) {
			return !e.damaging && picked.indexOf(e.name) < 0;
		});
		if (utility && picked.length < 4) picked.push(utility.name);
		while (picked.length < 4) {
			const filler = scored.find(function (e) { return picked.indexOf(e.name) < 0; });
			if (!filler) break;
			picked.push(filler.name);
		}
		return picked;
	}

	/** A legal set: what it would actually be carrying at this point in the run. */
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
		let moves = known.slice(-4);
		// Placeholder; late-game sets are chosen properly just below.
		// Past the early game, TMs and tutors are most of what a team knows, and
		// leaving them out was the last reason late-game numbers were a floor
		// rather than a measurement. Early game keeps level-up moves only, which
		// is both what a Nuzlocke actually has before the third gym and what
		// every number in TUNING.md was measured against.
		if (level > 40) {
			const pool = known.concat(taughtMoves(grown.species))
				.filter(function (n, i, a) { return a.indexOf(n) === i; })
				.filter(function (n) { return !RESTRICTED_MOVES[n]; });
			const chosen = chooseMoveset(pool, grown.species);
			if (chosen.length) moves = chosen;
		} else {
			// Early sets come off the level-up list, which can still contain a
			// banned move.
			const legal = known.filter(function (n) { return !RESTRICTED_MOVES[n]; });
			if (legal.length) moves = legal.slice(-4);
		}
		if (!moves.length) return null;
		// The dex stores `names`, an array, not `name`. Reading `.name` here has
		// silently produced `undefined` since the benchmark was written, which
		// means **every generated team in every measurement this project has
		// ever taken has fought with no abilities at all** -- no Levitate, no
		// Intimidate, no Volt Absorb, nothing. The trainers were unaffected,
		// their sets coming from the spreadsheet, so the error handicapped the
		// player only.
		// Take the first slot that actually HOLDS something. Ability id 0 is an
		// empty slot and 392 species of 1343 have one first -- Mismagius keeps
		// Levitate in slot two, Tinkaton keeps Mold Breaker there -- so reading
		// `abilities[0]` blindly left more than a quarter of the dex with
		// nothing even after the `names` fix below.
		let ability = null;
		for (const slot of (grown.species.abilities || [])) {
			const record = slot && dex.abilities && dex.abilities[slot[0]];
			if (record) { ability = record; break; }
		}
		// The dex stores `names`, an array, not `name`.
		if (ability && !ability.name && ability.names) {
			ability = {name: ability.names[0]};
		}
		// Restricted mode swaps a banned ability for a named replacement rather
		// than leaving the Pokemon with none.
		if (ability && ability.name && RESTRICTED_ABILITIES[ability.name]) {
			ability = {name: RESTRICTED_ABILITIES[ability.name]};
		}
		return {species: grown.species.name, level: level,
			nature: NATURES[rand(NATURES.length)],
			ability: ability && ability.name ? ability.name : undefined,
			// Sitrus past the early game, matching what the real save carries on
			// every one of its six; Oran is what you actually have early.
			item: level > 40 ? 'Sitrus Berry' : 'Oran Berry',
			moves: moves, evs: evsFor(level, grown.species), ivs: IVS};
	}

	function team(level, size) {
		const out = [];
		const pool = poolFor(level);
		let guard = 0;
		while (out.length < size && guard++ < 300) {
			const set = build(pool[rand(pool.length)], level);
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
