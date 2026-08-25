/**
 * What are the real odds on Lt. Surge, counting luck as luck?
 * Run: node tools/surge_odds.js [budgetMillions] [timeLimitSeconds]
 *
 * WHY THIS AND NOT cleanWin. The clean search steps the battle in "maxroll"
 * mode, where the secondary-effect rule is
 *
 *     fires = chance >= 100 || (ctx.risks.secondary && key === "foe")
 *
 * so a secondary fires only when it is guaranteed, or when it belongs to the
 * OPPONENT. Your Scald never burns, your Sludge never poisons, and theirs can
 * be switched on against you. That is deliberate -- a line that needs no luck
 * is a stronger claim -- but it means a clean line running through a 30% burn
 * is invisible to it by construction, however many nodes it is given.
 *
 * James won this fight without losing anybody and remembers a burn being
 * involved, which is exactly the shape of line the clean search cannot see.
 * `winChance` steps in "odds" mode, where a secondary becomes a real branch at
 * its real probability, so it can. It also carries the floor-and-ceiling fix,
 * so an exhausted search now says "I do not know" instead of reporting its own
 * budget as the player's odds.
 *
 * Read the output as: `chance` is PROVED, `unknown` was never examined, and the
 * truth is somewhere in between. A wide gap means the search ran out, not that
 * the fight is bad.
 */
'use strict';

const H = require('./lib/harness.js');

const engine = H.loadEngine();
const B = engine.B, X = engine.X;

const budget = Math.round((parseFloat(process.argv[2]) || 5) * 1e6);
const timeLimitMs = (parseInt(process.argv[3], 10) || 300) * 1000;

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

console.log('=== ' + H.label(battle) + ', odds mode ===');
console.log('you:  ' + party.map(p => p.species + ' L' + p.level).join(', '));
console.log('them: ' + foeSets.map(p => p.species + ' L' + p.level).join(', '));
console.log('James won this losing nobody.\n');

B.clearCache();
const state = B.createState(party, foeSets, {});
const t0 = Date.now();
const r = X.winChance(state, {
	exactBudget: budget,
	timeLimitMs: timeLimitMs,
	maxTurns: 24
});
const secs = ((Date.now() - t0) / 1000).toFixed(0);

console.log('proved clean   ' + (100 * r.chance).toFixed(1) + '%');
console.log('unexamined     ' + (100 * r.unknown).toFixed(1) + '%');
console.log('so the truth is between ' + (100 * r.chance).toFixed(1) +
	'% and ' + (100 * r.upper).toFixed(1) + '%');
console.log('nodes ' + r.nodes + ', ' + secs + 's, exhausted=' + r.exhausted + '\n');

if (r.ranking && r.ranking.length) {
	console.log('opening moves, best first:');
	const seen = {};
	for (const e of r.ranking) {
		const name = e.action.type === 'switch'
			? 'switch to ' + state.me.team[e.action.index].species
			: e.action.move;
		if (seen[name]) continue;
		seen[name] = 1;
		console.log('  ' + name.padEnd(24) +
			(100 * e.chance).toFixed(1).padStart(6) + '% proved' +
			(e.unknown > 0.005
				? '   (up to ' + (100 * e.upper).toFixed(1) + '% if the rest went our way)'
				: ''));
	}
}
if (r.exhausted) {
	console.log('\nEXHAUSTED: the floor above is a lower bound, not an estimate.');
}
