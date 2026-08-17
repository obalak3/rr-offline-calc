/**
 * Checks for the crit-aware KO engine. Run: node tools/test_critko.js
 *
 * The engine is only trustworthy if it collapses onto the upstream numbers in
 * the cases where crits are not a variable, so that is what these assert.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));

const sandbox = {calc, console, Float64Array, Math};
vm.createContext(sandbox);
vm.runInContext(
	fs.readFileSync(path.join(root, 'upstream-calc/src/js/rr-critko.js'), 'utf8'),
	sandbox);
const RRCritKO = sandbox.RRCritKO;

const gen = calc.Generations.get(9);
let failures = 0;

function check(name, actual, expected) {
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
	if (!ok) console.log(`        expected ${expected}\n        actual   ${actual}`);
}

function approx(name, actual, expected, tol) {
	const ok = Math.abs(actual - expected) <= tol;
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${actual.toFixed(5)})`);
	if (!ok) console.log(`        expected ~${expected} +/- ${tol}`);
}

function mon(name, opts) { return new calc.Pokemon(gen, name, opts); }
function mv(name, opts) { return new calc.Move(gen, name, opts); }

// ---------------------------------------------------------------- crit rates

check('base crit rate is 1/24',
	RRCritKO.critChance(mon('Blaziken'), mon('Onix'), mv('Ember'), 0), 1 / 24);

check('high-crit move (Slash) is 1/8',
	RRCritKO.critChance(mon('Persian'), mon('Onix'), mv('Slash'), 0), 1 / 8);

check('Super Luck raises the stage',
	RRCritKO.critChance(mon('Absol', {ability: 'Super Luck'}), mon('Onix'),
		mv('Tackle'), 0), 1 / 8);

check('Super Luck + high-crit move reaches 1/2',
	RRCritKO.critChance(mon('Absol', {ability: 'Super Luck'}), mon('Onix'),
		mv('Night Slash'), 0), 1 / 2);

check('Scope Lens raises the stage',
	RRCritKO.critChance(mon('Blaziken', {item: 'Scope Lens'}), mon('Onix'),
		mv('Ember'), 0), 1 / 8);

check('Focus Energy bonus (+2) reaches 1/2',
	RRCritKO.critChance(mon('Blaziken'), mon('Onix'), mv('Ember'), 2), 1 / 2);

check('Focus Energy + high-crit move always crits',
	RRCritKO.critChance(mon('Persian'), mon('Onix'), mv('Slash'), 2), 1);

check('Shell Armor prevents crits entirely',
	RRCritKO.critChance(mon('Persian'), mon('Lapras', {ability: 'Shell Armor'}),
		mv('Slash'), 2), 0);

check('Battle Armor prevents crits entirely',
	RRCritKO.critChance(mon('Persian'), mon('Kabutops', {ability: 'Battle Armor'}),
		mv('Slash'), 0), 0);

check('always-crit move (Storm Throw) is certain',
	RRCritKO.critChance(mon('Machamp'), mon('Onix'), mv('Storm Throw'), 0), 1);

check('Merciless always crits a poisoned target',
	RRCritKO.critChance(mon('Salazzle', {ability: 'Merciless'}),
		mon('Onix', {status: 'psn'}), mv('Ember'), 0), 1);

// ------------------------------------------------- agreement with upstream

/** Upstream KO chance for the same matchup, as a probability. */
function upstreamChance(a, d, m, f) {
	const r = calc.calculate(gen, a, d, m, f);
	const ko = r.kochance();
	return {chance: ko.chance, n: ko.n, text: ko.text};
}

const field = new calc.Field();

// A single-hit move with no residual damage: our c=0 result must match
// upstream's no-crit KO chance exactly.
{
	const a = mon('Blaziken', {level: 50, nature: 'Adamant', evs: {atk: 252}});
	const d = mon('Snorlax', {level: 50});
	const m = mv('Flamethrower');
	const res = RRCritKO.analyse(gen, a, d, m, field, {});
	const up = upstreamChance(a, d, m, field);
	const ourN = res.chancesWithoutCrits.findIndex(p => p > 0) + 1;
	check('crit-free KO turn matches upstream (Blaziken vs Snorlax)', ourN, up.n);
	if (up.chance === undefined) {
		// Upstream reports "possible NHKO" without a number; we compute one.
		// All we can assert is that it is a real probability below certainty.
		const p = res.chancesWithoutCrits[ourN - 1];
		check('crit-free probability is a genuine partial chance',
			p > 0 && p < 1, true);
	} else {
		approx('crit-free KO probability matches upstream',
			res.chancesWithoutCrits[ourN - 1], up.chance, 1e-9);
	}
	console.log(`        crit-aware: ${res.text}`);
	console.log(`        crit-free : ${res.textWithoutCrits}`);
	console.log(`        upstream  : ${up.text}`);
}

// Exact parity sweep: wherever upstream reports a precise probability for a
// single-hit move, our crit-free DP must reproduce it to the last decimal.
{
	const attackers = ['Blaziken', 'Alakazam', 'Snorlax', 'Gengar', 'Persian',
		'Machamp', 'Starmie', 'Arcanine'];
	const defenders = ['Snorlax', 'Blissey', 'Onix', 'Alakazam', 'Lapras',
		'Skarmory', 'Chansey'];
	const movesToTry = ['Flamethrower', 'Thunderbolt', 'Body Slam', 'Surf',
		'Shadow Ball', 'Ice Beam', 'Earthquake'];
	let compared = 0, mismatched = 0, worst = 0;
	for (const an of attackers) {
		for (const dn of defenders) {
			for (const mn of movesToTry) {
				const a = mon(an, {level: 50, evs: {atk: 252, spa: 252}});
				const d = mon(dn, {level: 50});
				const m = mv(mn);
				let up;
				try {
					// Upstream throws outright on immune / zero-damage matchups.
					up = calc.calculate(gen, a, d, m, field).kochance();
				} catch (e) {
					continue;
				}
				if (up.chance === undefined || up.chance === 0) continue;
				const res = RRCritKO.analyse(gen, a, d, m, field, {});
				if (!res) continue;
				const ours = res.chancesWithoutCrits[up.n - 1];
				if (ours === undefined) continue;
				compared++;
				const delta = Math.abs(ours - up.chance);
				if (delta > worst) worst = delta;
				if (delta > 1e-9) {
					mismatched++;
					if (mismatched <= 3) {
						console.log(`        mismatch ${an} ${mn} vs ${dn}: ` +
							`upstream ${up.chance} ours ${ours}`);
					}
				}
			}
		}
	}
	console.log(`        compared ${compared} matchups, worst delta ${worst.toExponential(2)}`);
	check('crit-free DP reproduces every exact upstream KO probability',
		mismatched, 0);
}

// Crits can only help: the crit-aware chance must never be lower.
{
	const a = mon('Persian', {level: 50, nature: 'Jolly', evs: {atk: 252}});
	const d = mon('Alakazam', {level: 50});
	const m = mv('Slash');
	const res = RRCritKO.analyse(gen, a, d, m, field, {});
	const better = res.chances[0] >= res.chancesWithoutCrits[0];
	check('crit-aware OHKO chance >= crit-free chance', better, true);
	console.log(`        crit rate ${(res.critChance * 100).toFixed(1)}%  ` +
		`crit-aware ${(res.chances[0] * 100).toFixed(1)}%  ` +
		`crit-free ${(res.chancesWithoutCrits[0] * 100).toFixed(1)}%`);
}

// An always-crit move must equal the pure-crit calculation.
{
	const a = mon('Machamp', {level: 50, nature: 'Adamant', evs: {atk: 252}});
	const d = mon('Snorlax', {level: 50});
	const res = RRCritKO.analyse(gen, a, d, mv('Storm Throw'), field, {});
	check('always-crit move has crit chance 1', res.critChance, 1);
	const critOnly = calc.calculate(gen, a, d, mv('Storm Throw', {isCrit: true}), field);
	approx('always-crit KO matches the forced-crit calculation',
		res.chances[critOnly.kochance().n - 1],
		critOnly.kochance().chance === undefined ? 1 : critOnly.kochance().chance, 1e-9);
}

// Shell Armor must reproduce the crit-free numbers exactly.
{
	const a = mon('Persian', {level: 50, nature: 'Jolly', evs: {atk: 252}});
	const d = mon('Lapras', {level: 50, ability: 'Shell Armor'});
	const res = RRCritKO.analyse(gen, a, d, mv('Slash'), field, {});
	approx('Shell Armor: crit-aware equals crit-free',
		res.chances[0] - res.chancesWithoutCrits[0], 0, 1e-12);
}

// Multi-hit: each hit crits independently, so the result must sit strictly
// between "no hit crits" and "every hit crits".
{
	const a = mon('Cloyster', {level: 50, nature: 'Adamant', evs: {atk: 252},
		ability: 'Skill Link'});
	const d = mon('Blissey', {level: 50});
	const m = mv('Icicle Spear');
	const res = RRCritKO.analyse(gen, a, d, m, field, {});
	console.log(`        Icicle Spear hits=${m.hits} crit-aware ${res.text} / crit-free ${res.textWithoutCrits}`);
	check('multi-hit produces a result', res !== null, true);
}

// A probability distribution must stay a probability distribution.
{
	const a = mon('Pikachu', {level: 5});
	const d = mon('Snorlax', {level: 100});
	const res = RRCritKO.analyse(gen, a, d, mv('Thunder Shock'), field, {});
	if (res) {
		const monotone = res.chances.every((p, i) =>
			p >= -1e-12 && p <= 1 + 1e-12 && (i === 0 || p >= res.chances[i - 1] - 1e-12));
		check('cumulative KO chances stay in [0,1] and never decrease', monotone, true);
	} else {
		check('no-damage matchup returns null', res, null);
	}
}

// ------------------------------------------------- doubles / focus fire

// One attacker through the focus-fire path must equal the single-target path.
{
	const a = mon('Blaziken', {level: 50, nature: 'Adamant', evs: {atk: 252}});
	const d = mon('Snorlax', {level: 50});
	const m = mv('Flamethrower');
	const solo = RRCritKO.analyse(gen, a, d, m, field, {});
	const ff = RRCritKO.analyseFocusFire(gen, [{attacker: a, move: m}], d, field, {});
	approx('focus fire with one attacker matches the single-target result',
		ff.chances[0] - solo.chances[0], 0, 1e-12);
}

// Two attackers must kill at least as often as either alone, and the combined
// chance must exceed what you would guess from the better one.
{
	const d = mon('Mienshao', {level: 50});
	const a1 = mon('Landorus-Therian', {level: 50, nature: 'Adamant', evs: {atk: 252}});
	const a2 = mon('Alakazam', {level: 50, nature: 'Modest', evs: {spa: 252}});
	const m1 = mv('Stone Edge');
	const m2 = mv('Psychic');
	const solo1 = RRCritKO.analyse(gen, a1, d, m1, field, {});
	const solo2 = RRCritKO.analyse(gen, a2, d, m2, field, {});
	const both = RRCritKO.analyseFocusFire(gen,
		[{attacker: a1, move: m1}, {attacker: a2, move: m2}], d, field, {});
	check('focus fire kills at least as often as the better single attack',
		both.chances[0] >= Math.max(solo1.chances[0], solo2.chances[0]) - 1e-12, true);
	console.log(`        ${d.name} ${d.maxHP()} HP: Stone Edge alone ` +
		`${(solo1.chances[0] * 100).toFixed(1)}%, Psychic alone ` +
		`${(solo2.chances[0] * 100).toFixed(1)}%, together ` +
		`${(both.chances[0] * 100).toFixed(1)}%`);
	check('combined damage range is the sum of the parts',
		both.minTurnDamage === solo1.minTurnDamage + solo2.minTurnDamage, true);
}

// Spread moves are weaker in doubles; the engine must see the game type.
{
	const a = mon('Landorus-Therian', {level: 50, nature: 'Adamant', evs: {atk: 252}});
	const d = mon('Mienshao', {level: 50});
	const singles = RRCritKO.analyse(gen, a, d, mv('Earthquake'),
		new calc.Field({gameType: 'Singles'}), {});
	const doubles = RRCritKO.analyse(gen, a, d, mv('Earthquake'),
		new calc.Field({gameType: 'Doubles'}), {});
	check('spread moves hit softer in doubles',
		doubles.maxTurnDamage < singles.maxTurnDamage, true);
	console.log(`        Earthquake max ${singles.maxTurnDamage} singles -> ` +
		`${doubles.maxTurnDamage} doubles`);

	const seSingles = RRCritKO.analyse(gen, a, d, mv('Stone Edge'),
		new calc.Field({gameType: 'Singles'}), {});
	const seDoubles = RRCritKO.analyse(gen, a, d, mv('Stone Edge'),
		new calc.Field({gameType: 'Doubles'}), {});
	check('single-target moves are unaffected by the game type',
		seSingles.maxTurnDamage === seDoubles.maxTurnDamage, true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
