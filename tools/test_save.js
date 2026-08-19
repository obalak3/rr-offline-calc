/**
 * Read a real battery save through rr-save.js and check what comes back.
 *
 * This exists because of a specific bug: the first box reader accepted any
 * offset holding a valid species with valid moves, a bitfield elsewhere in the
 * save matched at nearly every second byte, and the app quietly imported
 * phantom level 100 Pokemon. So the test does two things -- confirms the real
 * Pokemon are read, and confirms nothing else is.
 *
 * Run: node tools/test_save.js [path/to/file.sav]
 * With no argument it looks for an OpenEmu battery save of a FireRed patch.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dexFile = path.join(root, 'upstream-calc/src/js/data/rr-dex-data.js');
const saveFile = path.join(root, 'upstream-calc/src/js/rr-save.js');

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.log(`FAIL  ${name}`);
		if (detail !== undefined) console.log(`        ${detail}`);
	}
}

function findSave() {
	if (process.argv[2]) return process.argv[2];
	const dir = path.join(process.env.HOME,
		'Library/Application Support/OpenEmu/mGBA/Battery Saves');
	if (!fs.existsSync(dir)) return null;
	const hit = fs.readdirSync(dir).find(f => /fire\s*red/i.test(f) && f.endsWith('.sav'));
	return hit ? path.join(dir, hit) : null;
}

// rr-save.js is browser code: give it just enough of a browser to load.
const noop = () => {};
const jq = () => ({on: noop, html: noop, empty: noop, append: noop, data: noop});
const sandbox = {window: {}, document: {}, $: jq, jQuery: jq, console};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(dexFile, 'utf8'), sandbox, {filename: 'rr-dex-data.js'});
vm.runInContext(fs.readFileSync(saveFile, 'utf8'), sandbox, {filename: 'rr-save.js'});

/*
 * The ability rule, which took an experiment to find rather than a search.
 *
 * Radical Red does not store the ability at all: it is bit 0 of the PID, gen
 * 3's own rule, carried over unchanged. Established by changing four abilities
 * in game with an ability pill and diffing the save before against after --
 * the only bytes that moved were the PID's, and only for those four Pokemon.
 */
(function checkAbilityRule() {
	const twoAbilities = {abilities: [
		{name: 'Intimidate', slot: 0, hidden: false},
		{name: 'Strong Jaw', slot: 1, hidden: false},
		{name: 'Bull Rush', slot: 2, hidden: true}
	]};
	const oneAbility = {abilities: [
		{name: 'Torrent', slot: 0, hidden: false},
		{name: 'Protean', slot: 2, hidden: true}
	]};
	const pick = sandbox.RRSave.abilityFor;

	check('an even PID gives ability 1', pick(twoAbilities, 0xa51ce024) === 'Intimidate');
	check('an odd PID gives ability 2', pick(twoAbilities, 0x2a852001) === 'Strong Jaw');
	// Seen on a Frogadier whose bit is set although the species has no second
	// ability: the game falls back rather than leaving it blank.
	check('a species with no ability 2 falls back to ability 1',
		pick(oneAbility, 0xe01a54f1) === 'Torrent');
	check('a hidden ability is never picked by the bit',
		pick(twoAbilities, 0xffffffff) !== 'Bull Rush' &&
		pick(oneAbility, 0xffffffff) !== 'Protean');
	check('a species with no abilities at all does not throw',
		pick({abilities: []}, 1) === '');
})();

/*
 * The experiment itself, when its two saves are still around: four abilities
 * changed in game, everything else left alone.
 */
(function checkExperiment() {
	const before = path.join(process.env.HOME || '', 'rr-ability-before.sav');
	const after = path.join(process.env.HOME || '', 'rr-ability-after.sav');
	if (!fs.existsSync(before) || !fs.existsSync(after)) {
		console.log('        (ability experiment saves not present; skipping)');
		return;
	}
	const expected = {
		before: {Granbull: 'Strong Jaw', Spidops: 'Insomnia', Gyarados: 'Intimidate',
			Mienshao: 'Inner Focus', Bibarel: 'Simple', Frogadier: 'Torrent'},
		after: {Granbull: 'Intimidate', Spidops: 'Stakeout', Gyarados: 'Intimidate',
			Mienshao: 'Regenerator', Bibarel: 'Unaware', Frogadier: 'Torrent'}
	};
	for (const which of ['before', 'after']) {
		const bytes = fs.readFileSync(which === 'before' ? before : after);
		const result = sandbox.RRSave.parse(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		if (result.error) { check(`${which}: the experiment save parses`, false, result.error); continue; }
		// The newest write, which alternates between the two slots.
		const slot = result.slots.reduce((a, b) => (b.counter > a.counter ? b : a));
		const wrong = slot.party.filter(p => expected[which][p.species] &&
			p.ability !== expected[which][p.species]);
		check(`${which} the pills: every ability matches the game`, wrong.length === 0,
			wrong.map(p => `${p.species} read ${p.ability}, ` +
				`game says ${expected[which][p.species]}`).join('; '));
	}
})();

const file = findSave();
if (!file || !fs.existsSync(file)) {
	console.log('No battery save available; skipping (pass one as an argument).');
	process.exit(0);
}


const bytes = fs.readFileSync(file);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const result = sandbox.RRSave.parse(buffer);

console.log(`save: ${path.basename(file)}\n`);
check('the save parses', !result.error, result.error);
if (result.error) process.exit(1);
check('at least one playthrough found', result.slots.length > 0);

for (const slot of result.slots) {
	console.log(`\nslot ${slot.index}: ${slot.trainer} — ${slot.hours}h${slot.minutes}m ` +
		`— save counter ${slot.counter}`);
	console.log(`  party (${slot.party.length}):`);
	for (const p of slot.party) {
		console.log(`    Lv${String(p.level).padEnd(3)} ${p.species.padEnd(12)}` +
			`${p.nature}${p.natureExact ? '' : '?'} ${(p.item || '-').padEnd(14)}` +
			p.moves.join('/'));
	}
	console.log(`  boxes (${slot.boxes.length}):`);
	for (const b of slot.boxes) {
		console.log(`    Lv${String(b.level).padEnd(3)} ${b.species.padEnd(12)}` +
			`${(b.nickname ? '"' + b.nickname + '" ' : '').padEnd(12)}` +
			`${(b.item || '-').padEnd(14)}${b.moves.join('/')}`);
	}

	const all = slot.party.concat(slot.boxes);
	check(`slot ${slot.index}: every level is in range`,
		all.every(m => m.level >= 1 && m.level <= 100),
		all.filter(m => m.level < 1 || m.level > 100)
			.map(m => `${m.species} Lv${m.level}`).join(', '));

	// The phantoms all landed on level 100 with nothing else to go on. A real
	// mid-game team has no business being there, and a level 100 wall of them
	// is the exact shape of the bug.
	const maxed = all.filter(m => m.level === 100);
	check(`slot ${slot.index}: no wall of level 100 imports`, maxed.length < 3,
		`${maxed.length} at level 100`);

	check(`slot ${slot.index}: every import has a move`, all.every(m => m.moves.length > 0));
	check(`slot ${slot.index}: every import has legal EVs`,
		all.every(m => Object.keys(m.evs).reduce((n, k) => n + m.evs[k], 0) <= 510));
	check(`slot ${slot.index}: every import has legal IVs`,
		all.every(m => Object.keys(m.ivs).every(k => m.ivs[k] >= 0 && m.ivs[k] <= 31)));
	check(`slot ${slot.index}: box levels came out of the growth curve`,
		slot.boxes.every(m => m.level >= 1), 'a stored Pokemon with no derivable level');
}

console.log(failures === 0
	? '\nThe save reads cleanly.'
	: `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
