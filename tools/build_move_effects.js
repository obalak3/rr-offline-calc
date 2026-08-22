/**
 * tools/build_move_effects.js -- build the solver's move table.
 *
 * The solver needs more about a move than the damage calculator does. The calc
 * answers "how much damage", so its move records carry bp/type/category and a
 * bare `secondaries: true` boolean; in `calc.MOVES[9]` Swords Dance and
 * Will-O-Wisp are indistinguishable apart from type. Simulating a turn needs
 * accuracy, PP, priority and what the move actually *does*.
 *
 * Two sources, merged in this order:
 *
 *   1. data/rr-dex-data.js -- the JwowSquared ROM snapshot. 1003 move records
 *      with power, accuracy, pp, priority, split and secondaryEffectChance,
 *      plus an English description. This is Radical Red's own table, so it wins.
 *   2. calc.MOVES[9] -- fallback only. The dex snapshot predates the calc fork,
 *      so a few moves (Supercell Slam, Draining Kiss, Disarming Voice) exist in
 *      the calc and not in the dex.
 *
 * Neither source carries effect *semantics*: the dex says Thunderbolt has a 10%
 * secondary chance but not that the secondary is paralysis. Those come from
 * data/move_effects_curated.json, hand-written and keyed by move name, and the
 * ROM description is kept alongside so a curated entry can be read against it.
 *
 * Run: node tools/build_move_effects.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dexSource = path.join(root, 'data/rr-dex-data.js');
const curatedSource = path.join(root, 'data/move_effects_curated.json');
const trainerSource = path.join(root, 'upstream-calc/src/js/data/rr-trainers-data.js');
const dest = path.join(root, 'upstream-calc/src/js/data/rr-move-effects.js');

if (!fs.existsSync(dexSource)) {
	console.error('Missing dex snapshot: ' + dexSource);
	console.error('Fetch it with:\n  curl -sSL https://raw.githubusercontent.com/' +
		'JwowSquared/Radical-Red-Pokedex/master/data.js -o data/rr-dex-data.js');
	process.exit(1);
}

// Same loader build_dex.js uses: the snapshot is a bare object literal.
const dex = new Function('return ' + fs.readFileSync(dexSource, 'utf8') + ';')();
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
const CALC_MOVES = calc.MOVES[9];

const SPLIT = ['Physical', 'Special', 'Status'];
const GEN = calc.Generations.get(9);

/**
 * Recoil, drain and multi-hit are mechanical, not semantic, and the calc
 * already carries them. Reading them here rather than hand-writing them into
 * the curated file keeps a whole class of transcription error out of the data,
 * and lets priority be cross-checked between two independent sources.
 */
function mechanicsFromCalc(lookup) {
	let move;
	try {
		move = new calc.Move(GEN, lookup);
	} catch (e) {
		return null;
	}
	const out = {};
	if (move.recoil) out.recoil = move.recoil;
	if (move.drain) out.drain = move.drain;
	if (move.hits && move.hits > 1) out.hits = move.hits;
	if (move.flags && move.flags.contact) out.contact = true;
	out.calcPriority = move.priority || 0;
	return out;
}

/** The dex stores types as indices into its own table. */
function typeName(index) {
	const entry = dex.types && dex.types[index];
	if (!entry) return null;
	return typeof entry === 'string' ? entry : (entry.name || entry.key || null);
}

// ------------------------------------------------------------- trainer census

function loadTrainerMoves() {
	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(trainerSource, 'utf8'), sandbox);
	const data = sandbox.RR_TRAINER_DATA;
	const used = new Map();
	for (const segment of data.segments) {
		for (const battle of (segment.battles || [])) {
			for (const mon of (battle.team || [])) {
				for (const move of (mon.moves || [])) {
					used.set(move, (used.get(move) || 0) + 1);
				}
			}
		}
	}
	return used;
}

// ------------------------------------------------------------------- merging

/**
 * Hidden Power's type is chosen by IVs, so trainer data names it "Hidden Power
 * Ice" while the ROM table has one generic "Hidden Power". Split the name and
 * carry the type separately rather than inventing 18 dex entries.
 */
function normalise(name) {
	const match = /^Hidden Power (.+)$/.exec(name);
	if (match) return {lookup: 'Hidden Power', typeOverride: match[1]};
	return {lookup: name, typeOverride: null};
}

const dexByName = new Map();
for (const key of Object.keys(dex.moves)) {
	const move = dex.moves[key];
	dexByName.set(move.name, move);
}

function fromDex(record, typeOverride) {
	return {
		power: record.power,
		type: typeOverride || typeName(record.type),
		// The ROM writes 0 for moves that skip the accuracy check entirely
		// (Swords Dance, Protect). Keep that distinct from a real 100.
		accuracy: record.accuracy === 0 ? null : record.accuracy,
		pp: record.pp,
		// The ROM stores priority as an unsigned byte, so negative priorities
		// wrap: Counter is 251 (-5), Trick Room 249 (-7). Without this the
		// solver would order a turn catastrophically wrongly.
		priority: record.priority > 127 ? record.priority - 256 : record.priority,
		split: SPLIT[record.split],
		secondaryChance: record.secondaryEffectChance || 0,
		description: record.description || null,
		source: 'dex'
	};
}

function fromCalc(name, record, typeOverride) {
	return {
		power: record.bp,
		type: typeOverride || record.type,
		accuracy: null,          // the calc does not record accuracy
		pp: null,                // nor PP
		priority: record.priority || 0,
		split: record.category,
		secondaryChance: record.secondaries ? -1 : 0,  // -1 = "some, amount unknown"
		description: null,
		source: 'calc'
	};
}

function buildTable(names) {
	const table = {};
	const report = {dex: 0, calc: 0, missing: [], priorityDisagreements: []};
	for (const name of names) {
		const {lookup, typeOverride} = normalise(name);
		const dexRecord = dexByName.get(lookup);
		if (dexRecord) {
			const entry = fromDex(dexRecord, typeOverride);
			const mech = mechanicsFromCalc(lookup);
			if (mech) {
				// The calc only records positive priority, so absence is not a
				// disagreement; only compare where it actually has a value.
				const calcHas = CALC_MOVES[lookup] && CALC_MOVES[lookup].priority !== undefined;
				if (calcHas && mech.calcPriority !== entry.priority) {
					report.priorityDisagreements.push(
						[name, entry.priority, mech.calcPriority]);
				}
				delete mech.calcPriority;
				if (Object.keys(mech).length) entry.mechanics = mech;
			}
			table[name] = entry;
			report.dex++;
			continue;
		}
		const calcRecord = CALC_MOVES[lookup];
		if (calcRecord) {
			table[name] = fromCalc(lookup, calcRecord, typeOverride);
			report.calc++;
			continue;
		}
		report.missing.push(name);
	}
	return {table, report};
}

// -------------------------------------------------------------------- curated

function loadCurated() {
	if (!fs.existsSync(curatedSource)) return {};
	return JSON.parse(fs.readFileSync(curatedSource, 'utf8'));
}

// ----------------------------------------------------------------------- main

const used = loadTrainerMoves();

// The table has to cover every move in the game, not just the ones trainers
// carry: the player's own team can bring anything. Trainer moves are the subset
// that MUST also have hand-written semantics, since those are the ones the
// solver has to simulate on the other side of the battle.
const names = [...new Set([
	...dexByName.keys(),
	...Object.keys(CALC_MOVES),
	...used.keys()
])].sort();
const {table, report} = buildTable(names);
const curated = loadCurated();

let curatedCount = 0;
let otherNeedingSemantics = 0;
const needsSemantics = [];
for (const name of names) {
	const entry = table[name];
	if (!entry) continue;
	if (curated[name]) {
		entry.effect = curated[name];
		curatedCount++;
	} else {
		entry.effect = null;
		// Damaging moves with no secondary are fully described by the numbers
		// above; only status moves and secondaries need hand-written semantics.
		if (entry.split === 'Status' || entry.secondaryChance !== 0) {
			if (used.has(name)) needsSemantics.push([name, used.get(name), entry.split]);
			else otherNeedingSemantics++;
		}
	}
}

const payload = {
	note: 'Generated by tools/build_move_effects.js -- do not edit.',
	sources: {
		dex: 'data/rr-dex-data.js (JwowSquared/Radical-Red-Pokedex ROM snapshot)',
		calc: 'upstream-calc/calc (fallback for moves postdating the dex snapshot)',
		curated: 'data/move_effects_curated.json'
	},
	moves: table
};

fs.writeFileSync(dest,
	'// Generated by tools/build_move_effects.js -- do not edit.\n' +
	'var RR_MOVE_EFFECTS = ' + JSON.stringify(payload) + ';\n');

// --------------------------------------------------------------------- report

console.log('Moves in table: %d  (dex %d, calc-only %d, unresolved %d)',
	names.length, report.dex, report.calc, report.missing.length);
if (report.missing.length) console.log('  UNRESOLVED: ' + report.missing.join(', '));

const trainerMissing = [...used.keys()].filter(n => !table[n]);
console.log('Trainer moves covered: %d of %d', used.size - trainerMissing.length, used.size);

if (report.priorityDisagreements.length) {
	console.log('\nPriority disagreements between the ROM dex and the calc:');
	for (const [name, dexPri, calcPri] of report.priorityDisagreements) {
		console.log('    ' + name.padEnd(26) + ' dex ' + dexPri + '  calc ' + calcPri);
	}
} else {
	console.log('\nPriority agrees between the ROM dex and the calc for all %d moves.',
		report.dex);
}

console.log('\nCurated semantics present: %d', curatedCount);
console.log('Trainer moves still needing semantics: %d', needsSemantics.length);
console.log('Other moves without semantics: %d (surfaced at runtime if the player uses one)',
	otherNeedingSemantics);

if (needsSemantics.length) {
	needsSemantics.sort((a, b) => b[1] - a[1]);
	console.log('\n  most-used first (move, trainer mons carrying it, split):');
	for (const [name, count, split] of needsSemantics.slice(0, 25)) {
		console.log('    ' + name.padEnd(26) + String(count).padStart(4) + '  ' + split);
	}
	if (needsSemantics.length > 25) {
		console.log('    ... and %d more', needsSemantics.length - 25);
	}
}

console.log('\nWrote %s (%d moves, %d KB)', path.relative(root, dest),
	names.length, Math.round(fs.statSync(dest).size / 1024));
