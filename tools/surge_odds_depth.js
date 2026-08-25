/**
 * Odds on Lt. Surge at increasing depth, to find where the search stops knowing.
 * Run: node tools/surge_odds_depth.js
 *
 * The whole-fight question ("what are the odds of clearing all five") is almost
 * certainly unaffordable: this search runs about 800 nodes a second on this
 * fight, so even minutes buy only a few hundred thousand nodes against a 6v6
 * tree. That produces "0% proved, 100% unexamined", which is honest and useless.
 *
 * The question that IS affordable is the one the screen reader will ask every
 * turn: from here, over the next few turns, what are the odds and what should I
 * do. This sweeps the horizon to find where the answer stops being informative,
 * which sets the depth the live advisor can actually run at.
 *
 * `chance` is what was PROVED and `unknown` is what was never looked at, so a
 * row where unknown is large is the search admitting it ran out, not a verdict
 * on the fight.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, X = engine.X;

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

console.log('=== ' + H.label(battle) + ' -- odds by horizon, from turn 1 ===\n');
console.log('turns   proved   unknown   ceiling   nodes      time   best opening');
console.log('---------------------------------------------------------------------------');

for (const turns of [2, 3, 4, 6, 8, 12]) {
	B.clearCache();
	const state = B.createState(party, foeSets, {});
	const t0 = Date.now();
	let r;
	try {
		r = X.winChance(state, {exactBudget: 3e6, timeLimitMs: 60000, maxTurns: turns});
	} catch (e) { console.log(String(turns).padStart(5) + '   ERROR ' + e.message); continue; }
	const secs = ((Date.now() - t0) / 1000).toFixed(0);
	let best = '-';
	if (r.ranking && r.ranking.length) {
		const top = r.ranking[0];
		best = top.action.type === 'switch'
			? 'switch to ' + state.me.team[top.action.index].species
			: top.action.move;
	}
	console.log(String(turns).padStart(5) +
		(100 * r.chance).toFixed(1).padStart(8) + '%' +
		(100 * r.unknown).toFixed(1).padStart(9) + '%' +
		(100 * r.upper).toFixed(1).padStart(9) + '%' +
		String(r.nodes).padStart(10) +
		(secs + 's').padStart(7) + '   ' + best);
}
