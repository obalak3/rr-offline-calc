/**
 * Put a shortcut to the emulator's battery save somewhere you can actually
 * reach it.
 *
 * OpenEmu keeps battery saves under ~/Library/Application Support, and Finder
 * hides ~/Library. Every import therefore meant typing a path into the open
 * dialog. This drops a symlink in your home folder -- which every file dialog
 * shows in its sidebar -- pointing at the real file, so the save is two clicks
 * away and always the current one. A symlink, not a copy: the emulator writes
 * through it, so there is no stale duplicate to import by mistake.
 *
 * Run: node tools/link_save.js [path/to/file.sav]
 * With no argument it picks the most recently written battery save that looks
 * like a FireRed patch, which is what Radical Red is.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LINK = path.join(os.homedir(), 'RadicalRed.sav');
const DIRS = [
	'Library/Application Support/OpenEmu/mGBA/Battery Saves',
	'Library/Application Support/OpenEmu/VisualBoyAdvance/Battery Saves',
	'Library/Application Support/mGBA',
	'Documents/mGBA'
];

function candidates() {
	const out = [];
	for (const rel of DIRS) {
		const dir = path.join(os.homedir(), rel);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			if (!/\.(sav|srm)$/i.test(name)) continue;
			const full = path.join(dir, name);
			out.push({full, name, mtime: fs.statSync(full).mtimeMs});
		}
	}
	return out;
}

function pick() {
	if (process.argv[2]) return path.resolve(process.argv[2]);
	const all = candidates();
	if (!all.length) return null;
	// Radical Red is a FireRed patch, so prefer those; newest wins either way.
	const fireRed = all.filter(f => /fire\s*red/i.test(f.name));
	const pool = fireRed.length ? fireRed : all;
	pool.sort((a, b) => b.mtime - a.mtime);
	return pool[0].full;
}

const target = pick();
if (!target || !fs.existsSync(target)) {
	console.error('No battery save found. Pass one explicitly:');
	console.error('  node tools/link_save.js "/path/to/your.sav"');
	console.error('\nLooked in:');
	for (const rel of DIRS) console.error('  ~/' + rel);
	process.exit(1);
}

// Only ever replace a symlink of our own making; never a real file.
if (fs.existsSync(LINK) || fs.lstatSync(LINK, {throwIfNoEntry: false})) {
	const stat = fs.lstatSync(LINK);
	if (!stat.isSymbolicLink()) {
		console.error(LINK + ' exists and is a real file, not a shortcut.');
		console.error('Move it out of the way first -- refusing to overwrite it.');
		process.exit(1);
	}
	fs.unlinkSync(LINK);
}
fs.symlinkSync(target, LINK);

const size = (fs.statSync(LINK).size / 1024).toFixed(0);
console.log('~/RadicalRed.sav  ->  ' + target);
console.log(`${size} KB, last written ${new Date(fs.statSync(target).mtime).toLocaleString()}`);
console.log('\nIn the import dialog press Cmd+Shift+H for your home folder, or just');
console.log('drag ~/RadicalRed.sav onto the trainer panel.');
