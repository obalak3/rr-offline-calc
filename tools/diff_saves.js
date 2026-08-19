/**
 * Find a field by changing it in the game and diffing two saves.
 *
 * Some things in a Radical Red save cannot be found by reasoning about the
 * bytes. The ability slot is one: an exhaustive search of every bit position in
 * both record formats, constrained by Pokemon whose abilities were known, left
 * nothing that was not already accounted for as an item id, an experience
 * total, a nickname's letters or a stat. So instead of deducing where it lives,
 * change it and watch.
 *
 * Save the game, copy the .sav, change some abilities in-game, save again, and
 * run this over the two files. It pairs Pokemon across the saves by PID -- the
 * one field that never changes -- and reports every byte that moved. A field
 * that changed for exactly the Pokemon you altered, and held still for the ones
 * you did not, is the field.
 *
 * With --expect it goes further and names the encoding: give it the before and
 * after ability slots and it reports every bit field that reproduces both.
 *
 * Run:
 *   node tools/diff_saves.js before.sav after.sav
 *   node tools/diff_saves.js before.sav after.sav --expect Granbull=1:0,Mienshao=0:1
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dexFile = path.join(root, 'upstream-calc/src/js/data/rr-dex-data.js');

const SECTION_SIZE = 4096;
const SECTION_COUNT = 14;
const SLOT_SIZE = SECTION_SIZE * SECTION_COUNT;
const SIGNATURE = 0x08012025;

// Both record formats open with the same identity header.
const PARTY = {SIZE: 100, PID: 0x00, OTID: 0x04, SPECIES: 0x20};
const BOX = {SIZE: 58, PID: 0x00, OTID: 0x04, SPECIES: 0x1c};

if (process.argv.length < 4) {
	console.error('usage: node tools/diff_saves.js before.sav after.sav [--expect Name=before:after,...]');
	process.exit(1);
}
const [beforePath, afterPath] = process.argv.slice(2, 4);

const expectArg = process.argv.find(a => a.startsWith('--expect'));
const expected = {};
if (expectArg) {
	const body = expectArg.includes('=') && expectArg.startsWith('--expect=')
		? expectArg.slice('--expect='.length)
		: process.argv[process.argv.indexOf(expectArg) + 1];
	for (const part of String(body || '').split(',')) {
		const m = part.match(/^\s*([A-Za-z-]+)\s*=\s*(\d+)\s*:\s*(\d+)\s*$/);
		if (m) expected[m[1]] = {from: Number(m[2]), to: Number(m[3])};
	}
}

const dex = (() => {
	const vm = require('vm');
	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(dexFile, 'utf8'), sandbox, {filename: 'rr-dex-data.js'});
	return sandbox.RR_DEX_DATA;
})();
const speciesById = {};
for (const key of Object.keys(dex.species)) speciesById[dex.species[key].id] = dex.species[key];

function sectionMap(buf, slot) {
	const map = {};
	for (let i = 0; i < SECTION_COUNT; i++) {
		const off = slot * SLOT_SIZE + i * SECTION_SIZE;
		if (off + SECTION_SIZE > buf.length) break;
		if (buf.readUInt32LE(off + 0x0ff8) !== SIGNATURE) continue;
		const id = buf.readUInt16LE(off + 0x0ff4);
		if (id < SECTION_COUNT) map[id] = off;
	}
	return map;
}

function readSlot(buf, slot) {
	const map = sectionMap(buf, slot);
	if (map[1] === undefined) return null;
	const out = [];
	const otId = buf.readUInt32LE(map[1] + 0x38 + PARTY.OTID);
	for (let k = 0; k < 6; k++) {
		const off = map[1] + 0x38 + k * PARTY.SIZE;
		const species = speciesById[buf.readUInt16LE(off + PARTY.SPECIES)];
		if (!species || buf.readUInt32LE(off + PARTY.OTID) !== otId) break;
		out.push({kind: 'party', size: PARTY.SIZE, off, species,
			pid: buf.readUInt32LE(off + PARTY.PID)});
	}
	if (map[5] !== undefined) {
		for (let off = map[5] + 4; off + BOX.SIZE <= map[5] + 0x0ff4; off += BOX.SIZE) {
			const species = speciesById[buf.readUInt16LE(off + BOX.SPECIES)];
			let empty = true;
			for (let i = 0; i < BOX.SIZE; i++) if (buf[off + i]) { empty = false; break; }
			if (empty || !species) continue;
			out.push({kind: 'box', size: BOX.SIZE, off, species,
				pid: buf.readUInt32LE(off + BOX.PID)});
		}
	}
	return out;
}

/** The save counter of a slot: the highest one in it is the newest write. */
function counterOf(buf, slot) {
	let counter = -1;
	for (let i = 0; i < SECTION_COUNT; i++) {
		const off = slot * SLOT_SIZE + i * SECTION_SIZE;
		if (off + SECTION_SIZE > buf.length) break;
		if (buf.readUInt32LE(off + 0x0ff8) !== SIGNATURE) continue;
		counter = Math.max(counter, buf.readUInt32LE(off + 0x0ffc));
	}
	return counter;
}

/**
 * The slot the game wrote most recently.
 *
 * A GBA save alternates between two slots, so the newer write lands in
 * whichever one was not used last time. Picking by anything else -- how many
 * Pokemon a slot holds, or a fixed index -- reads a save one older than the one
 * you just made, and a diff of two files then shows nothing changing at all,
 * because the slot being compared is the same untouched copy in both.
 */
function best(buf) {
	const options = [0, 1]
		.map(slot => ({slot, counter: counterOf(buf, slot), recs: readSlot(buf, slot)}))
		.filter(o => o.recs && o.recs.length);
	if (!options.length) return {recs: [], counter: -1, slot: -1};
	options.sort((a, b) => b.counter - a.counter);
	return options[0];
}

const beforeBuf = fs.readFileSync(beforePath);
const afterBuf = fs.readFileSync(afterPath);
const beforePick = best(beforeBuf);
const afterPick = best(afterBuf);
const beforeRecs = beforePick.recs;
const afterRecs = afterPick.recs;

console.log(`before: ${path.basename(beforePath)}  slot ${beforePick.slot}, ` +
	`counter ${beforePick.counter}, ${beforeRecs.length} Pokemon`);
console.log(`after:  ${path.basename(afterPath)}  slot ${afterPick.slot}, ` +
	`counter ${afterPick.counter}, ${afterRecs.length} Pokemon`);
if (afterPick.counter <= beforePick.counter) {
	console.log('\nNote: the "after" file is not a later save than the "before" one.');
}
console.log('');

/*
 * Pair by position and species, not by PID.
 *
 * Pairing on the PID is the obvious choice -- it is the one field that never
 * changes -- and it is wrong here for exactly that reason. The first run of
 * this found nothing at all, because the ability *is* the PID: changing an
 * ability rerolls it, so every Pokemon that changed failed to pair and every
 * Pokemon that paired had, by construction, not changed. A tool that keys on
 * the field you are hunting for cannot see it move.
 */
const pairs = [];
for (let i = 0; i < beforeRecs.length && i < afterRecs.length; i++) {
	const b = beforeRecs[i], a = afterRecs[i];
	if (b.kind !== a.kind || b.species.name !== a.species.name) continue;
	pairs.push({before: b, after: a});
}
console.log(`paired by slot and species: ${pairs.length}`);
const repid = pairs.filter(p => beforeBuf.readUInt32LE(p.before.off + PARTY.PID) !==
	afterBuf.readUInt32LE(p.after.off + PARTY.PID));
if (repid.length) {
	console.log(`personality value changed for: ` +
		repid.map(p => p.before.species.name).join(', '));
}
console.log('');

// --- what moved ------------------------------------------------------------
const byOffset = {};
for (const {before: b, after: a} of pairs) {
	const diffs = [];
	for (let i = 0; i < b.size; i++) {
		const x = beforeBuf[b.off + i], y = afterBuf[a.off + i];
		if (x === y) continue;
		diffs.push({at: i, from: x, to: y});
		const key = b.kind + ':' + i;
		(byOffset[key] = byOffset[key] || []).push(b.species.name);
	}
	if (!diffs.length) continue;
	console.log(`${b.species.name} (${b.kind}) — ${diffs.length} byte(s) changed`);
	for (const d of diffs.slice(0, 24)) {
		console.log(`   +0x${d.at.toString(16).padStart(2, '0')}  ` +
			`${d.from.toString(16).padStart(2, '0')} -> ${d.to.toString(16).padStart(2, '0')}` +
			`   (${d.from} -> ${d.to})`);
	}
	if (diffs.length > 24) console.log(`   … and ${diffs.length - 24} more`);
	console.log('');
}

const changedNames = Object.keys(expected);
if (changedNames.length) {
	console.log('--- offsets that changed for exactly the Pokemon you altered ---');
	let found = 0;
	for (const key of Object.keys(byOffset)) {
		const names = byOffset[key];
		const hitAll = changedNames.every(n => names.includes(n));
		const noExtras = names.every(n => changedNames.includes(n));
		if (hitAll && noExtras) {
			const [kind, at] = key.split(':');
			console.log(`  ${kind} +0x${Number(at).toString(16)}  (${names.join(', ')})`);
			found++;
		}
	}
	if (!found) console.log('  none — no single byte tracks the change exactly');

	// --- which bit field reproduces the slots -----------------------------
	console.log('\n--- bit fields reproducing both the before and after slots ---');
	const field = (buf, off, size, bit, w) => {
		let acc = 0n;
		for (let i = size - 1; i >= 0; i--) acc = (acc << 8n) | BigInt(buf[off + i]);
		return Number((acc >> BigInt(bit)) & BigInt((1 << w) - 1));
	};
	const known = pairs.filter(p => expected[p.before.species.name]);
	const kinds = [...new Set(known.map(p => p.before.kind))];
	let matches = 0;
	for (const kind of kinds) {
		const group = known.filter(p => p.before.kind === kind);
		const size = kind === 'party' ? PARTY.SIZE : BOX.SIZE;
		for (let bit = 0; bit < size * 8; bit++) {
			for (const w of [1, 2, 3]) {
				const ok = group.every(p => {
					const e = expected[p.before.species.name];
					return field(beforeBuf, p.before.off, size, bit, w) === e.from &&
						field(afterBuf, p.after.off, size, bit, w) === e.to;
				});
				if (!ok) continue;
				// And it must hold still for everything you did not touch.
				const stable = pairs.filter(p => !expected[p.before.species.name] &&
					p.before.kind === kind).every(p =>
					field(beforeBuf, p.before.off, size, bit, w) ===
					field(afterBuf, p.after.off, size, bit, w));
				matches++;
				console.log(`  ${kind} +0x${(bit >> 3).toString(16)} bit ${bit % 8} ` +
					`width ${w}${stable ? '' : '   (but it moved for an untouched Pokemon)'}`);
				if (stable) {
					for (const p of pairs.filter(x => x.before.kind === kind)) {
						console.log(`       ${p.before.species.name.padEnd(11)} ` +
							`${field(beforeBuf, p.before.off, size, bit, w)} -> ` +
							`${field(afterBuf, p.after.off, size, bit, w)}`);
					}
				}
			}
		}
	}
	if (!matches) console.log('  none');
}
