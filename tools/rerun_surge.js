/**
 * Is a clean Lt. Surge findable now that the opponent is modelled correctly?
 * Run: node tools/rerun_surge.js [budgetMillions] [timeLimitSeconds]
 *
 * WHY THIS IS WORTH A TOOL. The number this project has quoted for months --
 * "clean is undecided at 84M nodes, and only lossBudget 2 finds a win" -- was
 * measured against a fight that no longer exists. Two things were wrong with
 * the opponent in every one of those searches:
 *
 *   1. Permanent Electric Terrain. The engine gave the AI terrain that never
 *      expired, so Surge's Electric moves were boosted for the whole battle and
 *      both Sleep Powders in the party were dead the whole battle. Neither is
 *      true; Pincurchin's Electric Surge runs the normal five turns.
 *   2. Their replacements came from OUR Nuzlocke heuristic, which picks the
 *      Pokemon with the most room to survive. The real routine
 *      (CalcMostSuitableMonToSwitchInto) optimises something else entirely.
 *
 * Both made the simulated Surge stronger and better-informed than the real one,
 * so the 84M wall is partly a wall we built ourselves. James won this fight
 * losing nobody, which is the standing evidence that a clean line exists.
 *
 * This reports the loss ladder the same way the old measurement did, so the
 * numbers are directly comparable to docs/VALIDATION-LOG.md.
 */
'use strict';

const H = require('./lib/harness.js');

const engine = H.loadEngine();
const B = engine.B, X = engine.X;

const budget = Math.round((parseFloat(process.argv[2]) || 20) * 1e6);
const timeLimitMs = (parseInt(process.argv[3], 10) || 600) * 1000;

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

console.log('=== ' + H.label(battle) + ' ===');
console.log('you:  ' + party.map(p => p.species + ' L' + p.level).join(', '));
console.log('them: ' + foeSets.map(p => p.species + ' L' + p.level).join(', '));
console.log('budget ' + (budget / 1e6) + 'M nodes, ' + (timeLimitMs / 1000) + 's per rung\n');
console.log('OLD (permanent terrain + invented replacements):');
console.log('  clean          undecided at 84M nodes');
console.log('  lossBudget 1   undecided at 4M nodes');
console.log('  lossBudget 2   WON, 23 turns, 4.51M nodes, 194s (docs/VALIDATION-LOG.md:56)\n');
console.log('NOW:');
console.log('rung            result        turns   nodes        time');
console.log('------------------------------------------------------------');

const mkState = () => B.createState(party, foeSets, {});

for (const k of [0, 1, 2]) {
	B.clearCache();
	const t0 = Date.now();
	let r;
	try {
		r = X.cleanWin(mkState(), {
			exactBudget: budget,
			timeLimitMs: timeLimitMs,
			maxTurns: 24,
			lossBudget: k
		});
	} catch (e) {
		console.log(('lossBudget ' + k).padEnd(16) + 'ERROR ' + e.message);
		continue;
	}
	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	// `decided` is the load-bearing word: a search that FINISHED without a line
	// has proved there is none at this rung. One that ran out has proved nothing.
	const verdict = r.found ? 'WON'
		: r.decided ? 'no line exists'
		: 'undecided (budget)';
	console.log(('lossBudget ' + k + (k === 0 ? ' (clean)' : '')).padEnd(16) +
		verdict.padEnd(14) +
		String(r.found && r.line ? r.line.length : '-').padStart(5) +
		String(r.nodes).padStart(12) +
		(secs + 's').padStart(9));
	if (r.found && r.line) {
		console.log('    line: ' + X.toSteps(r.line).map(s =>
			(s.action.type === 'switch' ? 'switch' : s.action.move)).join(' -> '));
		break;   // the ladder stops at the cheapest rung that works
	}
}
