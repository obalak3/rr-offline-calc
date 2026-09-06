/**
 * WAS THE ENGINE TOLD THE TRUTH ABOUT EVERY MOVE?
 * Run: node tools/audit_moves.js [--all]
 *
 * audit_mechanics.js checks the engine ACTS on every effect the data declares.
 * This checks the DATA against the game's own move descriptions: for each
 * move, what the description claims (priority, multi-hit, recoil, drain,
 * flinch, status, stat changes, traps, charge turns, OHKO, ...) versus what is
 * encoded for it in the effects table or handled by the calculator. A claim
 * with nothing encoding it is a move the engine simulates as something simpler
 * than it is -- silently, with full confidence.
 *
 * James, 2026-09-04: "You should know every possible move in the game."
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const calc = require(path.join(H.root, 'upstream-calc/calc/dist/index.js'));
const gen = calc.Generations.get(9);

const src = fs.readFileSync(path.join(H.root, 'upstream-calc/src/js/data/rr-move-effects.js'), 'utf8');
const M = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)).moves;
const dex = H.loadDex().dex;

// usage across every trainer
const uses = new Map();
const nameOf = id => (dex.moves[id] && dex.moves[id].name) || null;
for (const k in dex.trainers) for (const mode of ['hardcore', 'normal', 'team', 'party'])
	for (const p of (dex.trainers[k][mode] || [])) for (const m of (p.moves || [])) {
		const n = typeof m === 'number' ? nameOf(m) : m; if (n) uses.set(n, (uses.get(n) || 0) + 1);
	}

function calcMove(name) { try { return new calc.Move(gen, name); } catch (e) { return null; } }
function has(obj, ...keys) { let o = obj; for (const k of keys) { if (!o || o[k] === undefined || o[k] === null || o[k] === false) return false; o = o[k]; } return true; }

/** Each rule: a description pattern, and a predicate that says the claim is encoded. */
const RULES = [
	['multi-hit', /two to five|2 to 5|2-5 times|hits twice|two times|three times|2 times|3 times|five times|ten times/i,
		(d, cm) => (d.mechanics && d.mechanics.hits > 1) || (cm && cm.hits > 1)],
	['priority', /always goes first|always strikes first|goes first|strikes first|priority/i,
		(d, cm) => (d.priority || 0) > 0 || (cm && cm.priority > 0)],
	['goes last', /goes last|moves last|always moves last/i, (d, cm) => (d.priority || 0) < 0 || (cm && cm.priority < 0)],
	['recoil', /recoil|user takes .*damage|damages the user|hurts the user|user also takes/i,
		(d, cm) => has(d, 'mechanics', 'recoil') || (cm && cm.recoil)],
	['drain', /absorbs half|drain|restores .* HP .* damage|recover.* HP .* damage|heals the user by/i,
		(d, cm) => has(d, 'mechanics', 'drain') || (cm && cm.drain) || (d.effect && /drain|heal/.test(d.effect.kind || ''))],
	['flinch', /flinch/i, (d) => has(d, 'effect', 'secondary', 'flinch') || (d.effect && d.effect.kind === 'firstTurnOnly')],
	['burn', /\bburn/i, (d) => has(d, 'effect', 'secondary', 'status') || has(d, 'effect', 'status') || (d.effect && /brn|status|statusOneOf/.test(JSON.stringify(d.effect)))],
	['paralysis', /paraly/i, (d) => /par|status/.test(JSON.stringify(d.effect || {}))],
	['poison', /poison/i, (d) => /psn|tox|status|Toxic Spikes|hazard/.test(JSON.stringify(d.effect || {})) || (d.mechanics && d.mechanics.contact && false)],
	['sleep', /\bsleep|asleep|drowsy/i, (d) => /slp|yawn|status/.test(JSON.stringify(d.effect || {}))],
	['freeze', /freez/i, (d) => /frz|status/.test(JSON.stringify(d.effect || {}))],
	['confusion', /confus/i, (d) => /confuse|confuseBoost/.test(JSON.stringify(d.effect || {}))],
	['stat change', /\b(raise|raises|lower|lowers|sharply|harshly|drastically|boost|boosts|cut|cuts|reduce|reduces)\b.*\b(attack|defense|defence|speed|accuracy|evasi|sp\. ?atk|sp\. ?def|special|stat)/i,
		(d) => /boosts|selfDebuff|boost|confuseBoost|chargeBoost|stockpile|curse|strengthSap/.test(JSON.stringify(d.effect || {}))],
	['OHKO', /one-hit KO|one hit KO|instantly faint|faints instantly|OHKO/i, (d, cm) => (d.effect && /ohko/i.test(d.effect.kind || '')) || (cm && cm.isOHKO)],
	['charge/recharge', /charges on the first turn|two-turn|must recharge|can't move on the next|rest on the next turn|next turn/i,
		(d) => /charge|recharge|twoTurn|delayed|wish|futureSight|chargeBoost/i.test(JSON.stringify(d.effect || {}))],
	['trap', /can't escape|cannot escape|traps the|prevents .* from fleeing|binds|clamp|wrap/i, (d) => /trap|trapsSelf/.test(JSON.stringify(d.effect || {}))],
	['switch', /switches out|switch out|user switches|returns to its|forced to switch|switches the target/i,
		(d) => /selfSwitch|forceSwitch|shedTail|batonPass/.test(JSON.stringify(d.effect || {}))],
	['protect', /protects the user|protect the user|evade all|blocks all|guard/i, (d) => /protect|guard|substitute/i.test(JSON.stringify(d.effect || {}))],
	['weather/terrain', /rain|sunlight|sandstorm|hail|snow|terrain/i, (d) => /weather|terrain/i.test(JSON.stringify(d.effect || {})) || (d.power > 0)],
	['heal', /restores|recovers|heals|regain/i, (d) => /heal|drain|wish|rest|strengthSap|roost/i.test(JSON.stringify(d.effect || {})) || has(d, 'mechanics', 'drain') || (d.power > 0)],
	['hazard', /spikes|rocks .* around|sets a trap on the field|entry hazard/i, (d) => /hazard|spikes|stealthRock|stickyWeb|toxicSpikes/i.test(JSON.stringify(d.effect || {}))],
	['screen', /halves damage|reduces damage .* five turns|light screen|reflect/i, (d) => /screen|reflect|veil/i.test(JSON.stringify(d.effect || {}))],
	['conditional fail', /fails if|only works if|can only be used|can't be used|works only|fails unless|fails when/i,
		(d) => /firstTurnOnly|lastResort|unsupported|suckerPunch|fakeOut|counter|sleepOnly/i.test(JSON.stringify(d.effect || {})) || /Sucker Punch|Last Resort|Fake Out|First Impression|Belch|Snore|Dream Eater/.test(d.name || '')],
	['item', /removes .* item|steals .* item|knocks off|item is|held item/i, (d) => /removeItem|swapItems|knockOff|itemGone|thief|covet/i.test(JSON.stringify(d.effect || {}))],
	['self-KO', /user faints|faints after|sacrifice|explod|self-destruct/i, (d) => /selfKO|explode|faints/i.test(JSON.stringify(d.effect || {}))],
];

const rows = [];
for (const name in M) {
	const d = M[name]; if (!d) continue;
	d.name = name;
	const desc = String(d.description || '');
	if (!desc) continue;
	const cm = calcMove(name);
	const missing = [];
	for (const [label, re, ok] of RULES) {
		if (!re.test(desc)) continue;
		let encoded = false;
		try { encoded = !!ok(d, cm); } catch (e) { encoded = false; }
		if (!encoded) missing.push(label);
	}
	if (missing.length) rows.push({name, uses: uses.get(name) || 0, missing, desc, power: d.power, split: d.split});
}
rows.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
const carried = rows.filter(r => r.uses > 0);
console.log('moves with a description: ' + Object.keys(M).length);
console.log('moves whose description claims something nothing encodes: ' + rows.length
	+ '  (' + carried.length + ' of them carried by at least one trainer, '
	+ carried.reduce((a, r) => a + r.uses, 0) + ' uses)');
const show = process.argv.includes('--all') ? rows : carried.slice(0, 60);
for (const r of show) {
	console.log(String(r.uses).padStart(5) + '  ' + r.name.padEnd(18) + (r.power || 0).toString().padStart(4) + ' ' + String(r.split || '').padEnd(8)
		+ ' MISSING ' + r.missing.join(', ').padEnd(24) + '  "' + r.desc.slice(0, 80) + '"');
}
