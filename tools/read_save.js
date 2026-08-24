/**
 * Print the party out of the emulator save. Run: node tools/read_save.js [path]
 *
 * The parser already existed in rr-save.js, but only ever ran in the browser,
 * so answering "what is actually on your team" meant asking the user to read it
 * off the screen. That is a bad way to get data that is sitting on disk, and it
 * has already caused one real error in this project: a plan built around a
 * Mienshao with U-turn, which it does not have.
 *
 * Two things are needed to run rr-save.js outside the page, and both are the
 * kind of detail that wastes an hour if undocumented:
 *
 *   1. The Pokedex has to be loaded FIRST. Without RR_DEX_DATA the parser
 *      returns {error: "The Pokedex data has not loaded yet."} rather than
 *      throwing, which looks like an empty save.
 *   2. The ArrayBuffer must be created INSIDE the vm context. A Node Buffer, or
 *      an ArrayBuffer made outside, fails the DataView constructor's instanceof
 *      check with "First argument to DataView constructor must be an
 *      ArrayBuffer" -- true, and misleading, since it plainly is one.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));

// Flags must not be mistaken for the path: `read_save.js --json` was trying to
// open a file literally called --json and exiting before it printed anything.
const args = process.argv.slice(2).filter(function (a) { return a.charAt(0) !== '-'; });
const wantsJson = process.argv.indexOf('--json') >= 0;
const savePath = args[0] || path.join(os.homedir(), 'RadicalRed.sav');
let resolved;
try {
	resolved = fs.realpathSync(savePath);
} catch (e) {
	console.error('No save at ' + savePath);
	console.error('Point this at your .sav, or run tools/link_save.js first.');
	process.exit(1);
}

const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number,
	Date, String, Uint8Array, DataView, ArrayBuffer};
sandbox.window = sandbox;
// rr-save.js is a UI module; it only needs these to finish loading.
sandbox.document = {
	getElementById: function () { return null; },
	createElement: function () { return {style: {}, appendChild: function () {}}; },
	addEventListener: function () {}
};
sandbox.$ = function () {
	return {on: function () { return this; }, html: function () { return this; },
		find: function () { return this; }, val: function () { return ''; },
		each: function () { return this; }, append: function () { return this; },
		text: function () { return this; }, attr: function () { return this; },
		is: function () { return false; }, length: 0};
};
sandbox.jQuery = sandbox.$;
vm.createContext(sandbox);

for (const file of ['dist/js/data/rr-dex-data.js', 'src/js/data/rr-move-effects.js',
	'src/js/rr-critko.js', 'src/js/rr-battle.js', 'src/js/rr-save.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'),
		sandbox);
}

const bytes = fs.readFileSync(resolved);
const buffer = vm.runInContext('new ArrayBuffer(' + bytes.length + ')', sandbox);
const view = new Uint8Array(buffer);
for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
sandbox.__saveBuffer = buffer;

const result = vm.runInContext('RRSave.parse(__saveBuffer)', sandbox);
if (result && result.error) {
	console.error('Could not read the save: ' + result.error);
	process.exit(1);
}

const slots = Array.isArray(result) ? result : (result.slots || [result]);
// A GBA save holds two slots and the emulator alternates between them, so one
// is always a generation behind. Report both rather than guessing, but say
// which is which -- they can genuinely differ, and one of these two disagreed
// with the other about Lanturn's nature.
const withParty = slots.filter(function (s) { return (s.party || s.team || []).length; });
if (!withParty.length) {
	console.error('The save parsed but holds no party.');
	process.exit(1);
}

console.log('Save: ' + resolved);
console.log(withParty.length + ' slot(s) with a party. GBA saves keep two and');
console.log('alternate, so the later one is usually current.\n');

withParty.forEach(function (slot, index) {
	const party = slot.party || slot.team || [];
	console.log('--- slot ' + index + ': ' + (slot.trainer || '?') +
		(slot.hours !== undefined ? ', ' + slot.hours + 'h' : '') +
		', ' + party.length + ' Pokemon');
	party.forEach(function (mon) {
		console.log('  Lv' + mon.level + ' ' + String(mon.species).padEnd(12) +
			String(mon.nature || '?').padEnd(9) +
			String(mon.ability || '?').padEnd(15) +
			'@' + String(mon.item || '-'));
		console.log('      ' + (mon.moves || []).filter(Boolean).join(', '));
	});
	console.log('');
});

if (wantsJson) {
	const latest = withParty[withParty.length - 1];
	console.log(JSON.stringify((latest.party || latest.team).map(function (m) {
		return {species: m.species, level: m.level, nature: m.nature,
			ability: m.ability, item: m.item, moves: (m.moves || []).filter(Boolean),
			evs: m.evs, ivs: m.ivs};
	})));
}
