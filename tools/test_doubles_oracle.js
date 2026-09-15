'use strict';
/**
 * ACCEPTANCE TEST for stage 3 of docs/PLAN-DOUBLES.md: the doubles oracle.
 *
 * Runs against James's own save state `RadicalRed.ss7`, taken at the GAME
 * CORNER GUARD's doubles action menu (Hypno and Aerodactyl, against Accelgor
 * and Greninja). The numbers below were measured by `tools/headless/dscan`
 * while mapping the screens, so this test checks the oracle against an
 * independent reading of the same game rather than against itself.
 *
 * Skips cleanly when the core, the ROM or the state is not on this machine.
 *
 * Run: node tools/test_doubles_oracle.js
 */
const fs = require('fs');
const path = require('path');
const D = require('./lib/doubles-oracle.js');

const STATE = process.env.RR_DOUBLES_STATE
	|| path.join(process.env.HOME, 'RadicalRed-mGBA', 'RadicalRed.ss7');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('PASS  ' + name);
	else { failures++; console.log('FAIL  ' + name); if (detail !== undefined) console.log('        ' + detail); }
}

// Party of ss7, by slot: species and max HP. Accelgor and Greninja are out.
const PARTY = [
	{slot: 0, species: 670, max: 146, name: 'Accelgor'},
	{slot: 1, species: 766, max: 139, name: 'Greninja'},
	{slot: 2, species: 1141, max: 142, name: 'Toxtricity'},
	{slot: 3, species: 130, max: 160, name: 'Gyarados'},
	{slot: 4, species: 210, max: 165, name: 'Granbull'},
	{slot: 5, species: 926, max: 169, name: 'Skeledirge'}
];
const MAX_BY_SLOT = {}; PARTY.forEach(p => { MAX_BY_SLOT[p.slot] = p.max; });

async function main() {
	if (!D.available()) { console.log('SKIP: doracle or the ROM is not on this machine'); return; }
	if (!fs.existsSync(STATE)) { console.log('SKIP: ' + STATE + ' not found'); return; }

	const peek = await D.probe(STATE, {a0: null, a2: null});
	if (peek.error && /not in a battle/.test(peek.error)) { console.log('SKIP: that state is not a battle'); return; }

	// 1. The position reads as a double battle with four battlers and our first
	//    Pokemon being asked.
	const before = peek.before;
	check('the state is a doubles action menu, battler 0 asked',
		before && before.screen === 'action' && before.asking === 0,
		before && (before.screen + ' asking=' + before.asking));
	check('four battlers are on the field',
		before && before.battlers.length === 4 && before.battlers.every(b => b.maxhp > 0),
		before && JSON.stringify(before.battlers.map(b => b.species + ':' + b.hp + '/' + b.maxhp)));

	// 2. Targets. Measured with dscan, one full turn each, Accelgor attacking:
	//    default -> Hypno 142->65, target 3 -> Aerodactyl 138->118,
	//    target 2 -> our own Greninja 139->66.
	const shots = await D.probeAll(STATE, [
		{a0: {type: 'move', index: 0}, a2: {type: 'move', index: 0}},
		{a0: {type: 'move', index: 0, target: 3}, a2: {type: 'move', index: 0, target: 3}},
		{a0: {type: 'move', index: 0, target: 2}, a2: {type: 'move', index: 0}}
	]);
	const hp = (r, b) => r.after && r.after.battlers[b] && r.after.battlers[b].hp;
	check('default target hits their left (Hypno 142 -> 65)', hp(shots[0], 1) === 65, 'got ' + hp(shots[0], 1));
	check('target 3 hits their right (Aerodactyl 138 -> 118)', hp(shots[1], 3) === 118, 'got ' + hp(shots[1], 3));
	check('target 2 hits OUR OWN partner (Greninja 139 -> 66)', hp(shots[2], 2) === 66, 'got ' + hp(shots[2], 2));

	// 3. A spread move needs no target step and reaches both opponents.
	const spread = await D.probe(STATE, {a0: {type: 'move', index: 1}, a2: {type: 'move', index: 1}});
	const s = D.summarize(spread);
	check('a spread move resolves without a target step', s.ok && !spread.error, spread.error);
	check('both opponents took damage from it',
		spread.after && spread.after.battlers[1].hp < 142 && spread.after.battlers[3].hp < 138,
		spread.after && JSON.stringify(spread.after.battlers.map(b => b.hp)));

	// 4. Switches: the Pokemon that arrives is the one asked for, by max HP,
	//    and one already on the field is refused rather than guessed at.
	const sw = await D.probeAll(STATE, PARTY.filter(p => p.slot >= 2)
		.map(p => ({a0: {type: 'switch', index: p.slot}, a2: {type: 'move', index: 0}})));
	sw.forEach((r, i) => {
		const want = PARTY[i + 2];
		const got = r.after && r.after.battlers[0];
		check('switch to slot ' + want.slot + ' brings in ' + want.name,
			!!got && got.species === want.species && got.maxhp === want.max,
			got ? (got.species + ' max ' + got.maxhp) : (r.error || 'no after'));
		check('  and the arrival guard accepts it', D.arrivalOk(r, MAX_BY_SLOT));
	});
	const busy = await D.probe(STATE, {a0: {type: 'switch', index: 1}, a2: {type: 'move', index: 0}});
	check('switching to a Pokemon already on the field is refused',
		!!busy.error && /not in the party as displayed|already/.test(busy.error), busy.error);

	// 5. Both of ours can act independently, including both switching.
	const both = await D.probe(STATE, {a0: {type: 'switch', index: 3}, a2: {type: 'switch', index: 4}});
	check('both sides can switch in one turn (Gyarados and Granbull)',
		both.after && both.after.battlers[0].species === 130 && both.after.battlers[2].species === 210,
		both.after && JSON.stringify(both.after.battlers.map(b => b.species)) + ' ' + (both.error || ''));

	// 6. Determinism. Repeating identical calls has to give identical answers,
	//    or nothing built on this measures anything.
	const rep = await D.probeAll(STATE, [0, 1, 2].map(() =>
		({a0: {type: 'move', index: 1, target: 3}, a2: {type: 'switch', index: 5}})));
	const sigs = rep.map(r => r.after && (r.after.frame + '|' + r.after.battlers.map(b => b.species + ':' + b.hp).join(' ')));
	check('three identical calls agree exactly', sigs[0] && sigs.every(x => x === sigs[0]), JSON.stringify(sigs));

	console.log('\n' + failures + ' failure(s)');
	process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
