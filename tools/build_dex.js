/**
 * Build the offline Pokedex bundle.
 *
 * Reads the community Radical Red Pokedex snapshot (data/rr-dex-data.js, see
 * THIRD-PARTY-NOTICES.md) and emits a trimmed version for the app.
 *
 * Two things happen here rather than in the browser:
 *
 *   - `trainers` is dropped. It is 0.43 MB and duplicates the trainer sheet we
 *     already parse, which is better annotated.
 *   - Evolution methods arrive as JavaScript template-literal *source*
 *     ("`at Level ${evo[1]}`"). Those are rendered to plain strings here, so
 *     the shipped bundle is inert data and nothing is evaluated at runtime.
 *
 * Sprites are kept: they are 2.8 MB of base64, and an offline dex without
 * pictures is a worse dex. Everything is local, so the cost is parse time on a
 * local disk, not a download.
 *
 * Run: node tools/build_dex.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'data/rr-dex-data.js');
const dest = path.join(root, 'upstream-calc/src/js/data/rr-dex-data.js');

if (!fs.existsSync(source)) {
	console.error('Missing dex snapshot: ' + source);
	console.error('Fetch it with:\n  curl -sSL https://raw.githubusercontent.com/' +
		'JwowSquared/Radical-Red-Pokedex/master/data.js -o data/rr-dex-data.js');
	process.exit(1);
}

const raw = fs.readFileSync(source, 'utf8');
const dex = new Function('return ' + raw + ';')();

/**
 * Render one evolution into a sentence.
 *
 * The snapshot stores each method as template-literal source referring to `evo`
 * and `items`. Evaluating it here keeps that code out of the browser bundle.
 */
function renderEvolution(evo, methodSource) {
	if (!methodSource) return null;
	try {
		// Some methods reference the other tables by name (mega stones, party
		// requirements, type requirements), so all four are in scope.
		return new Function('evo', 'items', 'moves', 'species', 'types',
			'return ' + methodSource)(evo, dex.items, dex.moves, dex.species, dex.types);
	} catch (e) {
		return null;
	}
}

const typeName = {};
for (const key of Object.keys(dex.types)) typeName[key] = dex.types[key].name;

const species = {};
let evolutionsRendered = 0, evolutionsFailed = 0;

for (const key of Object.keys(dex.species)) {
	const s = dex.species[key];
	if (!s || !s.name) continue;

	const abilities = [];
	(s.abilities || []).forEach((pair, index) => {
		const id = Array.isArray(pair) ? pair[0] : pair;
		if (!id || !dex.abilities[id]) return;
		const entry = dex.abilities[id];
		const name = Array.isArray(entry.names) ? entry.names[0] : entry.name;
		if (!name) return;
		abilities.push({name, hidden: index === 2, text: entry.description || ''});
	});

	const evolutions = [];
	for (const evo of s.evolutions || []) {
		const target = dex.species[evo[2]];
		const text = renderEvolution(evo, dex.evolutions[evo[0]]);
		if (text) evolutionsRendered++; else evolutionsFailed++;
		evolutions.push({
			into: target ? target.name : null,
			intoId: evo[2],
			how: text ? String(text).replace(/^`|`$/g, '') : ''
		});
	}

	// Species tmMoves hold TM numbers; resolve them to move ids once.
	const tms = [];
	for (const n of s.tmMoves || []) {
		const moveId = dex.tmMoves[n];
		if (moveId) tms.push(moveId);
	}
	const tutors = [];
	for (const n of s.tutorMoves || []) {
		const moveId = dex.tutorMoves[n];
		if (moveId) tutors.push(moveId);
	}

	species[s.ID] = {
		id: s.ID,
		dexID: s.dexID,
		name: s.name,
		// Stats arrive in the games' internal order: HP, Atk, Def, Spe, SpA, SpD.
		stats: s.stats,
		types: (s.type || []).map(t => typeName[t]).filter(Boolean),
		abilities,
		eggGroups: [...new Set((s.eggGroup || []).map(g => dex.eggGroups[g]).filter(Boolean))],
		levelup: s.levelupMoves || [],
		tms,
		tutors,
		eggMoves: s.eggMoves || [],
		evolutions,
		ancestor: s.ancestor
	};
}

/**
 * Alternate formes share their base species' name in this snapshot, so the list
 * shows three entries all called "Charizard". Where one species evolves into
 * another of the same name, note how -- "with the Charzardite X" -- so the two
 * can be told apart.
 */
for (const key of Object.keys(species)) {
	const s = species[key];
	for (const evo of s.evolutions) {
		const target = species[evo.intoId];
		if (!target || target.name !== s.name || !evo.how) continue;
		target.formNote = evo.how
			.replace(/^with (the )?/i, '')
			.replace(/^holding (the )?/i, '');
	}
}

const moves = {};
for (const key of Object.keys(dex.moves)) {
	const m = dex.moves[key];
	if (!m || !m.name) continue;
	moves[m.ID] = {
		name: m.name,
		power: m.power,
		type: typeName[m.type] || '',
		accuracy: m.accuracy,
		pp: m.pp,
		split: dex.splits[m.split] || '',
		text: m.description || ''
	};
}

/**
 * Experience-growth curve per national dex number.
 *
 * A box Pokemon in the save stores experience but not level, so importing the
 * PC has to run the curve backwards. The snapshot does not carry the curve, so
 * it comes from the six cached species lists (tools/fetch_growth.js). Alternate
 * formes share their base species' dex number and therefore its curve.
 */
const CURVE_CODE = {
	'medium': 0, 'medium-slow': 1, 'fast': 2, 'slow': 3,
	'slow-then-very-fast': 4, 'fast-then-very-slow': 5
};
const growthByDex = {};
let growthMax = 0;
for (let i = 1; i <= 6; i++) {
	const file = path.join(root, `data/gr${i}.json`);
	if (!fs.existsSync(file)) {
		console.error('Missing growth-curve cache: ' + file);
		console.error('Fetch it with:\n  node tools/fetch_growth.js');
		process.exit(1);
	}
	const list = JSON.parse(fs.readFileSync(file, 'utf8'));
	const code = CURVE_CODE[list.name];
	if (code === undefined) throw new Error('Unknown growth rate: ' + list.name);
	for (const entry of list.pokemon_species) {
		const id = Number(entry.url.match(/\/(\d+)\/$/)[1]);
		growthByDex[id] = code;
		if (id > growthMax) growthMax = id;
	}
}
// One digit per dex number, so the table costs about a kilobyte.
let growth = '';
for (let id = 0; id <= growthMax; id++) {
	growth += growthByDex[id] === undefined ? '0' : String(growthByDex[id]);
}
let growthMissing = 0;
for (const key of Object.keys(species)) {
	if (growthByDex[species[key].dexID] === undefined) growthMissing++;
}

// Held items, by the ROM's own index, so a save file's item id resolves.
const items = {};
for (const key of Object.keys(dex.items)) {
	const i = dex.items[key];
	if (i && i.name) items[i.ID] = i.name;
}

const payload = {
	note: 'Generated by tools/build_dex.js from the community Radical Red ' +
		'Pokedex (JwowSquared/Radical-Red-Pokedex). See THIRD-PARTY-NOTICES.md.',
	species,
	moves,
	items,
	growth,
	types: dex.types,
	sprites: dex.sprites
};

fs.mkdirSync(path.dirname(dest), {recursive: true});
fs.writeFileSync(dest,
	'// Generated by tools/build_dex.js -- do not edit.\n' +
	'var RR_DEX_DATA = ' + JSON.stringify(payload) + ';\n');

const mb = n => (n / 1048576).toFixed(2) + ' MB';
console.log(`species        ${Object.keys(species).length}`);
console.log(`moves          ${Object.keys(moves).length}`);
console.log(`items          ${Object.keys(items).length}`);
console.log(`growth curves  ${growthMax} dex numbers, ` +
	`${growthMissing} species fall back to medium-fast`);
console.log(`sprites        ${Object.keys(dex.sprites || {}).length}`);
console.log(`evolutions     ${evolutionsRendered} rendered, ${evolutionsFailed} unrenderable`);
console.log(`\nsource         ${mb(raw.length)}`);
console.log(`bundle         ${mb(fs.statSync(dest).size)}  -> ${path.relative(root, dest)}`);
