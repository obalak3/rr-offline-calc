/**
 * Every priced way to kill every one of their Pokemon. Line by line.
 *
 * Run: node tools/plan_fight.js [FIGHT]
 *
 * This replaces the hit-counting prototype that used to live here. That version
 * divided HP by median damage and compared hit counts, which cannot see Drain
 * Punch healing Pawmot back out of range, Volt Absorb turning an attack into a
 * heal, Sitrus Berry, recoil, or Focus Sash -- all of which decide this fight.
 * Duels are simulated now; see tools/lib/duels.js for how they are priced.
 *
 * The conditions are the ENABLERS backward chaining bottoms out in. Reading a
 * row as "X kills Y if Y is asleep, for 0% and no death risk" is only half an
 * answer; the other half is who puts Y to sleep and what that costs, which is
 * the assignment step (step 3 of docs/PLAN-LINE-PLANNER.md).
 */
'use strict';
const H = require('./lib/harness.js');
const D = require('./lib/duels.js');
const engine = H.loadEngine();

const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
if (!battle) { console.log('no fight matching ' + which); process.exit(1); }
const foeSets = H.foeSets(battle);

// The conditions worth asking about, cheapest first. `terrain` is passed
// explicitly rather than inherited, because Pincurchin's Electric Surge is up
// for most of this fight and it is what blocks sleep on anything grounded.
const CONDITIONS = [
	['straight', {}],
	['slowed', {slowed: true}],
	['asleep', {asleep: 3}],
	['half hp', {foeChip: 0.5}],
	['slowed+half', {slowed: true, foeChip: 0.5}]
];

const pct = x => (x * 100).toFixed(0) + '%';

console.log(H.label(battle));
console.log('us:   ' + party.map(p => p.species + ' L' + p.level).join(', '));
console.log('them: ' + foeSets.map(f => f.species + ' L' + f.level).join(', '));
console.log('\ncost = our HP spent, at the median roll. death = exact chance the'
	+ '\nduel ends with our Pokemon fainted, over the real roll and crit'
	+ '\ndistribution. A plan lives inside the cost budget and under the cap.\n');

foeSets.forEach((f, fi) => {
	console.log('=================== ' + f.species + '  (' + f.ability
		+ (f.item ? ', ' + f.item : '') + ')  ' + (f.moves || []).join(' / '));
	let anyClean = false;
	party.forEach((p, mi) => {
		const rows = [];
		for (const [name, entry] of CONDITIONS) {
			const lines = D.duelLines(engine, party, foeSets, mi, fi, entry, {});
			const kill = lines.find(l => l.outcome === 'kill');
			if (!kill) continue;
			rows.push({name, kill});
			// Once a cheaper condition already works, the harder ones are noise.
			if (name === 'straight') break;
		}
		if (!rows.length) return;
		rows.forEach(r => {
			if (r.name === 'straight' && r.kill.deathRisk < 0.05) anyClean = true;
			console.log('  ' + p.species.padEnd(11)
				+ r.name.padEnd(12)
				+ r.kill.moves.join(' > ').padEnd(28)
				+ ' cost ' + pct(r.kill.cost).padStart(5)
				+ '  death ' + pct(r.kill.deathRisk).padStart(4)
				+ '  ' + r.kill.turns + 't');
			console.log('      ' + r.kill.log.map(s =>
				'T' + s.turn + ' ' + s.we + ' / ' + s.they
				+ ' (' + s.ourHP + ' v ' + s.theirHP + ')').join('  '));
		});
	});
	if (!anyClean) console.log('  NOTHING kills it straight without risking a death.');
	console.log('');
});
