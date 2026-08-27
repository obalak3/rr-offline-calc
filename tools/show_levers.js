/**
 * What can each side of this fight actually do? Derived from the teams alone.
 * Run: node tools/show_levers.js [FIGHT]
 */
'use strict';
const H = require('./lib/harness.js');
const E = require('./lib/enablers.js');
const engine = H.loadEngine();
const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);

[['OURS', party], ['THEIRS', foeSets]].forEach(([label, team]) => {
	console.log('\n=== ' + label + ' ===');
	const levers = E.leversFor(engine, team);
	let last = '';
	levers.forEach(l => {
		if (l.mon !== last) { console.log(' ' + l.mon); last = l.mon; }
		console.log('   ' + l.via.padEnd(16) + l.label
			+ (l.repeatable ? '   [stackable]' : ''));
	});
});
