/**
 * Replay one named plan and print the fight, turn by turn.
 * Run: node tools/show_plan.js '<plan json>' [episodes]
 *
 * The plan is the same object tools/plan_search.js prints, as JSON:
 *   {"Pincurchin":[{"mon":"Breloom","moves":["Bullet Seed"]}], ...}
 */
'use strict';
const H = require('./lib/harness.js');
const P = require('./lib/policy.js');
const {playPlan} = require('./lib/playplan.js');
const engine = H.loadEngine();

const which = process.env.FIGHT || 'SURGE';
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);
const plan = JSON.parse(process.argv[2]);
const N = parseInt(process.argv[3], 10) || 1;
const ctx = {engine, party, foeSets,
	expendable: (process.env.EXPENDABLE || 'Lilligant').split(',')};

console.log(H.label(battle));
console.log(P.describe(plan) + '\n');
for (let i = 0; i < N; i++) {
	const r = playPlan(ctx, plan, {trace: true});
	console.log('--- episode ' + (i + 1) + ': '
		+ (r.won ? 'WON' : 'LOST') + ', dead: ' + (r.dead.join(', ') || 'none')
		+ (r.capOK ? '   CAP OK' : '   CAP FAILED'));
	r.trace.forEach(l => console.log('  ' + l));
	console.log('');
}
