/**
 * Verify that the bundled calculator really knows every Pokemon in Radical Red.
 *
 * Cross-checks the vendored calculator's data against the community Radical Red
 * Pokedex (https://dex.radicalred.net, source: JwowSquared/Radical-Red-Pokedex),
 * which is an independent extraction of the same ROM. Two independent sources
 * agreeing is meaningful; the calculator agreeing with itself is not.
 *
 * Checks:
 *   1. every species in the dex exists in the calculator
 *   2. base stats match, stat by stat
 *   3. each species' abilities are all selectable in the calculator
 *
 * Refresh the dex snapshot with:
 *   curl -sSL https://raw.githubusercontent.com/JwowSquared/Radical-Red-Pokedex/master/data.js \
 *        -o data/rr-dex-data.js
 *
 * Run: node tools/verify_roster.js [--verbose]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

const dexPath = path.join(root, 'data/rr-dex-data.js');
const calcPath = path.join(root, 'upstream-calc/calc/dist/index.js');

for (const [label, p] of [['dex snapshot', dexPath], ['built calculator', calcPath]]) {
	if (!fs.existsSync(p)) {
		console.error(`Missing ${label}: ${p}`);
		process.exit(1);
	}
}

const dex = new Function('return ' + fs.readFileSync(dexPath, 'utf8') + ';')();
const calc = require(calcPath);
const gen = calc.Generations.get(9);

/**
 * Names must be compared under Unicode normalization: the dex writes Flabebe
 * with a combining acute accent while the calculator uses the precomposed
 * character, and the two are different byte sequences for the same name.
 * Gender symbols differ too (Nidoran-F vs the female sign).
 */
function key(name) {
	return String(name)
		.normalize('NFD')                    // split accents off their letters
		.replace(/[̀-ͯ]/g, '')     // drop the accents
		.replace(/♀/g, 'f').replace(/♂/g, 'm')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

// The dex stores stats in the games' internal order.
const DEX_STAT_ORDER = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'];

/**
 * Real differences between the two sources, confirmed by hand.
 *
 * Radical Red gives these two species gender-dependent base stats. The dex
 * carries a separate entry per gender; the vendored calculator models only one
 * of each, so the other gender's stats are unavailable:
 *
 *   Unfezant  male 115 Atk / 108 Spe, female 105 Atk / 93 Spe -> calc has female
 *   Jellicent male 80 Def / 75 SpA,   female 70 Def / 85 SpA  -> calc has male
 *
 * Neither appears in any trainer battle, so this only matters if one is on your
 * own team; edit the base stats in the calculator by hand if so. Listed here so
 * that any *new* discrepancy still fails loudly.
 */
const KNOWN_DIFFERENCES = new Set(['Unfezant', 'Jellicent']);

const calcByKey = new Map();
for (const s of gen.species) {
	calcByKey.set(key(s.name), s);
	// Nidoran-F / Nidoran-M reduce to the same key without the gender suffix.
	if (/^Nidoran/.test(s.name)) calcByKey.set(key(s.name), s);
}
// Re-map the Nidorans explicitly, since the generic key collides.
for (const s of gen.species) {
	if (s.name === 'Nidoran-F') calcByKey.set('nidoranf', s);
	if (s.name === 'Nidoran-M') calcByKey.set('nidoranm', s);
}

/**
 * The base species plus every forme the calculator files under it. A forme is
 * spelled "Base-Something", so anything whose key extends this one and whose
 * original name has a hyphen at the join qualifies.
 */
function candidatesFor(dexName) {
	const wanted = key(dexName);
	const out = [];
	const exact = calcByKey.get(wanted);
	if (exact) out.push(exact);
	for (const s of gen.species) {
		if (s === exact) continue;
		const k = key(s.name);
		if (k.length > wanted.length && k.startsWith(wanted) &&
			s.name.length > dexName.length && s.name[dexName.length] === '-') {
			out.push(s);
		}
	}
	return out;
}

const abilityNames = new Set(gen.abilities ? [...gen.abilities].map(a => key(a.name)) : []);
const dexAbilities = dex.abilities || [];

const missing = [];
const statMismatches = [];
const abilityGaps = [];
const known = [];
let compared = 0;

const seen = new Set();
for (const entry of Object.values(dex.species)) {
	if (!entry || !entry.name) continue;
	// The dex lists some species under several ids (formes sharing a name).
	const id = key(entry.name) + ':' + (entry.stats || []).join(',');
	if (seen.has(id)) continue;
	seen.add(id);

	// The dex names every forme after its base species -- Rotom's five appliance
	// formes are all just "Rotom", Kyurem-Black and Kyurem-White are both
	// "Kyurem". So a name alone cannot identify the entry: gather the base
	// species plus all its formes as candidates and let the stats pick.
	const candidates = candidatesFor(entry.name);
	if (candidates.length === 0) {
		missing.push(entry.name);
		continue;
	}
	compared++;

	if (Array.isArray(entry.stats) && entry.stats.length === 6) {
		const exact = candidates.find(c => DEX_STAT_ORDER.every(
			(stat, i) => c.baseStats[stat] === entry.stats[i]));
		if (!exact) {
			// Report against the closest candidate so the diff is readable.
			const base = candidates[0];
			const diffs = [];
			for (let i = 0; i < 6; i++) {
				const stat = DEX_STAT_ORDER[i];
				if (base.baseStats[stat] !== entry.stats[i]) {
					diffs.push(`${stat} calc ${base.baseStats[stat]} vs dex ${entry.stats[i]}`);
				}
			}
			const line = `${entry.name} [${candidates.length} forme(s)]: ${diffs.join(', ')}`;
			if (KNOWN_DIFFERENCES.has(entry.name)) known.push(line);
			else statMismatches.push(line);
		}
	}

	if (Array.isArray(entry.abilities)) {
		for (const pair of entry.abilities) {
			const abilityId = Array.isArray(pair) ? pair[0] : pair;
			if (!abilityId) continue;
			const name = dexAbilities[abilityId] &&
				(dexAbilities[abilityId].name || dexAbilities[abilityId]);
			if (!name || typeof name !== 'string') continue;
			if (!abilityNames.has(key(name))) {
				abilityGaps.push(`${entry.name}: "${name}"`);
			}
		}
	}
}

function report(label, list, note) {
	if (list.length === 0) {
		console.log(`PASS  ${label}`);
		return 0;
	}
	console.log(`FAIL  ${label}: ${list.length}`);
	const unique = [...new Set(list)];
	for (const line of unique.slice(0, VERBOSE ? 200 : 15)) console.log(`        ${line}`);
	if (!VERBOSE && unique.length > 15) {
		console.log(`        ... and ${unique.length - 15} more (--verbose for all)`);
	}
	if (note) console.log(`        ${note}`);
	return list.length;
}

console.log(`Radical Red dex: ${Object.keys(dex.species).length} entries ` +
	`(${seen.size} distinct)`);
console.log(`Calculator      : ${[...gen.species].length} species`);
console.log(`Compared        : ${compared}\n`);

let failures = 0;
failures += report('every dex species exists in the calculator', missing);
failures += report('base stats agree with the dex', statMismatches);
failures += report('every dex ability is selectable', abilityGaps);

if (known.length) {
	console.log(`\nKnown, documented differences (not failures): ${known.length}`);
	for (const line of [...new Set(known)]) console.log(`        ${line}`);
	console.log('        Radical Red gives these gender-dependent stats; the');
	console.log('        calculator models only one gender. Neither is used by');
	console.log('        any trainer in the dataset.');
}

console.log(failures === 0
	? '\nThe calculator covers the full Radical Red roster.'
	: `\n${failures} discrepancy/ies found.`);
process.exit(failures === 0 ? 0 : 1);
