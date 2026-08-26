/**
 * Did the switch-in port break the Surge lossBudget-2 line, or correct it?
 * Run: node tools/probe_port_regression.js [budgetMillions] [seconds]
 *
 * Two measurements point the same way and neither is explained. The Surge
 * lossBudget-2 line used to be found at 4.51M nodes and is now unfound at 21M,
 * and bench_mirror dropped from 125 clean to 121 -- the latter at a fixed NODE
 * budget, which rules out the port merely being slower.
 *
 * The hypothesis: the port changes which positions exist, because both sides'
 * replacements now come from the game's real routine instead of our Nuzlocke
 * heuristic. If so these are CORRECTED results, and the older, better-looking
 * numbers were measured against an opponent that does not exist.
 *
 * This is the discriminating test. Same fight, same rung, same budget, once
 * with the port and once without. If the line comes back with the port off, the
 * hypothesis holds and nothing is broken. If it stays missing either way, the
 * port is innocent and the cause is still unknown.
 */
'use strict';

const H = require('./lib/harness.js');

const budget = Math.round((parseFloat(process.argv[2]) || 12) * 1e6);
const seconds = parseInt(process.argv[3], 10) || 600;

function run(disablePort) {
	const engine = H.loadEngine();
	if (disablePort) engine.sandbox.RR_DISABLE_SWITCH_PORT = true;
	const B = engine.B, X = engine.X;
	const party = H.realTeam();
	const battle = H.earlyBattles(engine, {maxLevel: 40})
		.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
	B.clearCache();
	const t0 = Date.now();
	const r = X.cleanWin(B.createState(party, H.foeSets(battle), {}),
		{exactBudget: budget, timeLimitMs: seconds * 1000, maxTurns: 24, lossBudget: 2});
	return {
		found: r.found, decided: r.decided, nodes: r.nodes,
		turns: r.found && r.line ? r.line.length : null,
		secs: Math.round((Date.now() - t0) / 1000)
	};
}

console.log('Lt. Surge, lossBudget 2. Historically FOUND at 4,514,755 nodes.');
console.log('budget ' + (budget / 1e6) + 'M nodes, ' + seconds + 's each\n');
console.log('switch port   result                turns    nodes        time');
console.log('---------------------------------------------------------------');
for (const [label, off] of [['OFF (old model)', true], ['ON  (real AI)', false]]) {
	const r = run(off);
	const verdict = r.found ? 'FOUND' : (r.decided ? 'no line exists' : 'undecided (budget)');
	console.log(label.padEnd(14) + verdict.padEnd(22) +
		String(r.turns === null ? '-' : r.turns).padStart(5) +
		String(r.nodes).padStart(11) + (r.secs + 's').padStart(9));
}
console.log('\nIf OFF finds it and ON does not, the old line depended on an');
console.log('opponent that does not exist, and nothing is broken.');
