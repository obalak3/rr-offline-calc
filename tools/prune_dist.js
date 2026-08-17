/**
 * Strip everything the app does not use out of the built site.
 *
 * The upstream build serves several calculators (Normal, Hardcore, Randoms,
 * OMs, Honkalculate) and ships their pages, data and controls alongside ours.
 * This project uses exactly one page, so the rest is dead weight that also
 * makes the app feel like a stock site with things bolted on: broken-looking
 * pages you can reach, data that is never read, tests shipped to users.
 *
 * The rule is simple and checkable: keep index.html, everything it references,
 * and the lazily loaded Pokedex bundle. Delete the rest, then verify nothing
 * still referenced went missing.
 *
 * Run automatically by `npm run build` at the repo root.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'upstream-calc/dist');

if (!fs.existsSync(dist)) {
	console.error('Nothing to prune: ' + dist + ' does not exist.');
	process.exit(1);
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

/** Loaded on demand rather than referenced by the page, so keep it. */
const KEEP_ANYWAY = new Set(['js/data/rr-dex-data.js']);

function walk(dir, out) {
	out = out || [];
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(path.relative(dist, full));
	}
	return out;
}

const files = walk(dist);
const removed = [];
let keptBytes = 0, removedBytes = 0;

for (const rel of files) {
	const size = fs.statSync(path.join(dist, rel)).size;

	// index.html itself, and the assets it names.
	const referenced = rel === 'index.html' ||
		html.includes(rel.split(path.sep).join('/')) ||
		KEEP_ANYWAY.has(rel.split(path.sep).join('/'));

	// Images are referenced from CSS as often as from HTML; keep them.
	const isImage = /\.(png|gif|jpe?g|svg|ico)$/i.test(rel);

	if (referenced || isImage) {
		keptBytes += size;
		continue;
	}
	fs.unlinkSync(path.join(dist, rel));
	removed.push({rel, size});
	removedBytes += size;
}

// Drop directories left empty by the above.
function prune(dir) {
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		if (entry.isDirectory()) prune(path.join(dir, entry.name));
	}
	if (dir !== dist && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
prune(dist);

// Nothing the page asks for may have been taken away.
const missing = [];
for (const m of html.matchAll(/(?:src|href)="\.\/([^"?]+)/g)) {
	if (!fs.existsSync(path.join(dist, m[1]))) missing.push(m[1]);
}

const mb = n => (n / 1048576).toFixed(2) + ' MB';
removed.sort((a, b) => b.size - a.size);
console.log(`removed ${removed.length} unused files (${mb(removedBytes)})`);
for (const r of removed.slice(0, 8)) {
	console.log(`   ${mb(r.size).padStart(8)}  ${r.rel}`);
}
if (removed.length > 8) console.log(`   ... and ${removed.length - 8} more`);
console.log(`\ndist is now ${mb(keptBytes)}`);

if (missing.length) {
	console.error('\nPruned something the page still needs:');
	for (const m of missing) console.error('   ' + m);
	process.exit(1);
}
