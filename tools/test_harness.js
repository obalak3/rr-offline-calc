/**
 * Checks for the benchmark harness. Run: node tools/test_harness.js
 *
 * WHY THIS FILE EXISTS, written the day it was needed. The generator handed
 * every Pokemon it ever built an `undefined` ability, from the commit that
 * created the benchmark until 2026-08-24 -- so every measurement in TUNING.md
 * was taken with the player's team missing a mechanic the opponent had. The bug
 * had three layers: the dex field is `names` not `name`, ability id 0 is an
 * empty slot that 392 species of 1343 carry first, and each entry is
 * [id, nameIndex] where the index picks between same-effect names.
 *
 * The app never had this problem, and the reason is instructive: `rr-save.js`
 * resolves abilities too, and `tools/test_save.js` asserts that it does. The bug
 * lived exactly where the test was not.
 *
 * So this tests the harness the way test_save.js tests the importer. What it
 * checks is not that the generator is clever but that its output is a team
 * somebody could actually field -- which is the thing that has now gone wrong
 * four times: level 44 Poliwags, a level 87 Pikachu, random junk movesets, and
 * no abilities at all.
 */
'use strict';

const H = require('./lib/harness.js');

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
// Base formes only, keyed by name. Without the guard the mega entry wins the
// key -- Mega Venusaur has Thick Fat and Mega Medicham has Pure Power, so a
// lookup by plain name silently returned the mega's abilities and the first
// draft of this file failed against its own correct generator.
const speciesByName = {};
for (const key in dexParts.dex.species) {
	const sp = dexParts.dex.species[key];
	if (!sp.name || sp.name.includes('-')) continue;
	if (!speciesByName[sp.name]) speciesByName[sp.name] = sp;
}

// ---------------------------------------------------------------- abilities

{
	// Hand-checkable species, one per layer of the bug that hid this.
	const cases = [
		['Gliscor', 'Poison Heal'],      // ordinary first slot
		['Mismagius', 'Levitate'],       // first slot is EMPTY, real one is second
		['Tinkaton', 'Mold Breaker'],    // same, and a multi-name id
		['Medicham', 'Telepathy'],       // nameIndex selects between two names
		['Venusaur', 'Chlorophyll']
	];
	for (const [name, expected] of cases) {
		const built = gen.build(speciesByName[name], 87);
		check(name + ' gets ' + expected,
			built && built.ability === expected,
			built ? String(built.ability) : 'not built');
	}

	// The headline property: nobody is built without one.
	let missing = 0, total = 0;
	for (const key in dexParts.dex.species) {
		const sp = dexParts.dex.species[key];
		if (!sp.dexID || !(sp.levelupMoves || []).length) continue;
		total++;
		const built = gen.build(sp, 87);
		if (built && !built.ability) missing++;
	}
	check('every species resolves an ability (' + total + ' checked)',
		missing === 0, missing + ' without one');
}

// ------------------------------------------------------- restricted mode

{
	// This save is on Restricted, where the PLAYER loses a list of moves and
	// abilities and the trainers keep everything. The generator used to ignore
	// it and hand out Electric Terrain and Quiver Dance.
	const BANNED = ['Calm Mind', 'Dragon Dance', 'Quiver Dance', 'Shell Smash',
		'Electric Terrain', 'Misty Terrain', 'Grassy Terrain', 'Psychic Terrain',
		'Toxic Spikes', 'Sticky Web', 'Sunny Day', 'Rain Dance', 'Sandstorm',
		'Hail', 'Belly Drum', 'Iron Defense', 'Amnesia', 'Stockpile', 'Bulk Up'];
	let illegal = 0, checked = 0;
	for (let i = 0; i < 25; i++) {
		for (const level of [36, 87]) {
			for (const mon of gen.team(level, 6)) {
				checked++;
				for (const move of mon.moves) {
					if (BANNED.indexOf(move) >= 0) illegal++;
				}
			}
		}
	}
	check('no banned move reaches a player team (' + checked + ' checked)',
		illegal === 0, illegal + ' illegal move(s)');

	// Growth is deliberately legal, and the proved Lt. Surge line depends on it.
	check('  and Growth is NOT treated as banned',
		BANNED.indexOf('Growth') < 0);
}

// ------------------------------------------------------- teams are plausible

{
	const late = gen.team(87, 6);
	check('a late team is six distinct Pokemon',
		new Set(late.map(m => m.species)).size === 6,
		late.map(m => m.species).join(','));
	check('  fully evolved', late.every(function (m) {
		const sp = speciesByName[m.species];
		return !(sp.evolutions || []).some(e => e[0] !== 254);
	}), late.map(m => m.species).join(','));
	check('  trained, not blank-EV', late.every(m => m.evs.hp > 0));
	check('  and carrying at least two attacking moves each',
		late.every(function (m) {
			let attacks = 0;
			for (const name of m.moves) {
				for (const k in dexParts.dex.moves) {
					const d = dexParts.dex.moves[k];
					if (d.name === name && d.power > 0) { attacks++; break; }
				}
			}
			return attacks >= 2;
		}), late.map(m => m.species + ':' + m.moves.join('/')).join(' | '));

	// Early game is a different claim: that is what a Nuzlocke really has before
	// the third gym, and every number in TUNING.md was measured against it.
	const early = gen.team(36, 6);
	check('an early team is still blank-EV and Oran-carrying',
		early.every(m => m.evs.hp === 0 && m.item === 'Oran Berry'));
}

{
	// Raw power was the entire move ranking, so Explosion and Hyper Beam
	// outranked everything and half of all generated Pokemon carried a
	// self-crippling move. The fourth slot always went to a status move, and
	// always the earliest-learned one, so 39% carried Leer, Growl or Harden.
	const CRIPPLING = /^(explosion|self-destruct|misty explosion|hyper beam|giga impact)$/i;
	const JUNK = /^(leer|growl|tail whip|harden|defense curl|scary face|foresight|odor sleuth|lucky chant|mud sport|splash)$/i;
	let crippling = 0, junk = 0, total = 0;
	for (let i = 0; i < 20; i++) {
		for (const mon of gen.team(85, 6)) {
			total++;
			for (const move of mon.moves) {
				if (CRIPPLING.test(move)) crippling++;
				if (JUNK.test(move)) junk++;
			}
		}
	}
	// A few survive on Pokemon whose pool is genuinely that thin, which is
	// honest; half of them was not.
	check('self-crippling moves are rare, not the default (' + total + ' checked)',
		crippling / total < 0.1, crippling + ' of ' + total);
	check('  and no set carries a pure junk status move', junk === 0,
		junk + ' junk move(s)');
}

console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
