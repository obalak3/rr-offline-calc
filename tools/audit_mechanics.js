/**
 * DOES THE ENGINE ACT ON WHAT THE DATA DECLARES?
 * Run: node tools/audit_mechanics.js
 *
 * `audit_coverage.js` asks whether a move has an effect in the data. That is
 * not the same question, and the difference cost a fight: Swagger declares
 * `confuseBoost` and Water Pulse declares `secondary: {confuse: true}`, so both
 * counted as modelled -- while the engine set `volatiles.confused` and then
 * never read it again. Nothing was ever confused. Swagger, a move that hands us
 * +2 Attack and a liability, read as a pure gift from the opponent.
 *
 * James, 2026-09-02: "are we gonna find problems with every single move in the
 * game... the possible moves are clear, the possible statuses are clear, the
 * possible boosts pokemon can have are clear. These should all be solved."
 *
 * The surface IS finite, so this enumerates all of it and checks three things
 * that declaration-based auditing cannot see:
 *
 *   1. every `effect.kind` in the move table has a branch in the engine
 *   2. every field used inside a `secondary` block is read by the handler
 *   3. every volatile the engine WRITES is READ somewhere other than the write
 *      and the position key -- a volatile that is only ever stored is a
 *      mechanic that does not exist
 *
 * Counts are uses across the whole trainer dataset, so a gap can be judged by
 * how often it will actually come up.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');

const loaded = H.loadEngine();
const B = loaded.B;
const src = fs.readFileSync(path.join(H.root, 'upstream-calc/src/js/rr-battle.js'), 'utf8');
const effects = JSON.parse((function () {
	const t = fs.readFileSync(path.join(H.root,
		'upstream-calc/src/js/data/rr-move-effects.js'), 'utf8');
	return t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
})()).moves;

// ---- how often each move is actually carried, across every trainer ----------
const dex = H.loadDex().dex;
const nameOf = id => (dex.moves[id] && dex.moves[id].name) || null;
const uses = new Map();
for (const k in dex.trainers) {
	const t = dex.trainers[k];
	for (const mode of ['hardcore', 'normal', 'team', 'party']) {
		for (const p of (t[mode] || [])) {
			for (const m of (p.moves || [])) {
				const n = typeof m === 'number' ? nameOf(m) : m;
				if (n) uses.set(n, (uses.get(n) || 0) + 1);
			}
		}
	}
}
const usesOf = names => names.reduce((a, n) => a + (uses.get(n) || 0), 0);

// ---- 1. effect kinds -------------------------------------------------------
const byKind = new Map();
for (const name in effects) {
	const e = effects[name].effect;
	if (!e || !e.kind) continue;
	if (!byKind.has(e.kind)) byKind.set(e.kind, []);
	byKind.get(e.kind).push(name);
}
// A kind is handled if the engine switches on it or names it in a comparison.
const handledKind = k => new RegExp('case\\s*[\'"]' + k + '[\'"]|kind\\s*===\\s*[\'"]' + k + '[\'"]')
	.test(src);
/**
 * Some kinds are not the ENGINE's job. The vendored calculator owns everything
 * that only changes a damage number, and it does it from its own move data
 * rather than from named branches -- so `physicalDefence` has no branch here and
 * Psyshock is still scored against Defense (258-304 on a Blissey where Psychic
 * does 57). Measured, not assumed: each is checked against the calculator.
 * `secondary` is handled too, through `data.effect.secondary` rather than a
 * case label. Listing these as gaps is how an audit gets ignored.
 */
const CALC_OWNED = {
	secondary: 'handled via data.effect.secondary, not a case label',
	physicalDefence: 'calculator scores Psyshock against Defense (verified)',
	multiHit: 'calculator applies the hit count (Triple Dive = 3 hits, verified)'
};

// ---- 2. secondary fields ---------------------------------------------------
const secFields = new Map();
for (const name in effects) {
	const e = effects[name].effect;
	if (!e || !e.secondary) continue;
	for (const f in e.secondary) {
		if (!secFields.has(f)) secFields.set(f, []);
		secFields.get(f).push(name);
	}
}
// Read if the handler mentions `secondary.<field>`.
const readsSecondary = f => new RegExp('secondary\\.' + f + '\\b').test(src);

// ---- 3. volatiles written but never read -----------------------------------
const written = new Set();
// `=` NOT followed by another `=`, or `volatiles.x ===` counts as a write and a
// read-once volatile looks dead. That false-flagged lastMove and disabled.
const wRe = /volatiles\.([A-Za-z0-9_]+)\s*=(?!=)/g;
let m;
while ((m = wRe.exec(src))) written.add(m[1]);
const readCount = v => {
	const all = (src.match(new RegExp('volatiles\\.' + v + '\\b', 'g')) || []).length;
	const writes = (src.match(new RegExp('volatiles\\.' + v + '\\s*=(?!=)', 'g')) || []).length;
	// positionKey lists every volatile so two states can be told apart; that is
	// bookkeeping, not a mechanic, so it does not count as a read.
	const inKey = new RegExp('volatiles\\.' + v + '\\b[^\\n]*\\n?[^\\n]*positionKey').test(src)
		? 1 : 0;
	return all - writes - inKey;
};

// ---- report ----------------------------------------------------------------
function section(title) { console.log('\n' + title + '\n' + '-'.repeat(title.length)); }

section('1. EFFECT KINDS THE ENGINE NEVER BRANCHES ON');
const badKinds = [...byKind.entries()]
	.filter(([k]) => !handledKind(k) && !CALC_OWNED[k])
	.map(([k, names]) => ({kind: k, n: names.length, uses: usesOf(names), names}))
	.sort((a, b) => b.uses - a.uses);
if (!badKinds.length) console.log('  none');
badKinds.forEach(r => console.log('  ' + String(r.uses).padStart(5) + ' uses  '
	+ r.kind.padEnd(18) + r.n + ' moves: ' + r.names.slice(0, 6).join(', ')
	+ (r.names.length > 6 ? ', ...' : '')));

section('2. SECONDARY FIELDS THE HANDLER NEVER READS');
const badFields = [...secFields.entries()]
	.filter(([f]) => !readsSecondary(f))
	.map(([f, names]) => ({field: f, n: names.length, uses: usesOf(names), names}))
	.sort((a, b) => b.uses - a.uses);
if (!badFields.length) console.log('  none');
badFields.forEach(r => console.log('  ' + String(r.uses).padStart(5) + ' uses  '
	+ ('secondary.' + r.field).padEnd(22) + r.n + ' moves: '
	+ r.names.slice(0, 8).join(', ') + (r.names.length > 8 ? ', ...' : '')));

section('3. VOLATILES WRITTEN BUT NEVER ACTED ON');
const deadVolatiles = [...written].filter(v => readCount(v) <= 0);
if (!deadVolatiles.length) console.log('  none');
deadVolatiles.forEach(v => console.log('  volatiles.' + v));

section('HANDLED BY THE CALCULATOR, NOT THE ENGINE');
Object.keys(CALC_OWNED).forEach(k => console.log('  ' + k.padEnd(18) + CALC_OWNED[k]));

section('SUMMARY');
console.log('  effect kinds in the data          ' + byKind.size);
console.log('  of those with no engine branch    ' + badKinds.length);
console.log('  secondary fields in the data      ' + secFields.size);
console.log('  of those never read               ' + badFields.length);
console.log('  volatiles written                 ' + written.size);
console.log('  of those never acted on           ' + deadVolatiles.length);
