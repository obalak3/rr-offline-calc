/**
 * How expensive is it to FIND a clean line in the fights that actually fail?
 *
 * Run: node tools/bench_hunt.js [teams] [opts-json]
 *      node tools/bench_hunt.js --save [opts-json]      (the real party)
 *
 * WHY A SECOND BENCHMARK. tools/bench_early.js scores clean wins across nine
 * battles, which answers "is the planner good" and is the right number to ship.
 * It is the wrong instrument for the work in front of us. Six of nine of those
 * fights are already won, so their cost is averaged in and swamps the three that
 * are not, and the failures are reported as a win-rate -- a number that cannot
 * distinguish "the search decided there is no clean line" from "the search ran
 * out of budget", which is exactly the distinction the work turns on.
 *
 * This measures the search itself on the three fights that fail across the
 * board: Misty, Lt. Surge and Mt. Moon Archer. Per fight it reports whether a
 * witness was FOUND, whether the question was DECIDED, and what it cost in nodes
 * and milliseconds. Nodes-to-witness is the number the hunt work is judged by,
 * because it is the thing being optimised and it is not noisy the way a
 * nine-fight win rate is.
 *
 * Teams are drawn in the same order as tools/bench_early.js, so fight for fight
 * these are the same teams that benchmark scores.
 */
'use strict';

const H = require('./lib/harness.js');

const HARD = /MISTY|SURGE|MT\. MOON ARCHER/;

const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B, X = loaded.X;

const wantsSave = process.argv.indexOf('--save') >= 0;
const args = process.argv.slice(2).filter(a => a.charAt(0) !== '-');
const teamCount = wantsSave ? 1 : (parseInt(args[0], 10) || 5);
const opts = JSON.parse(args[wantsSave ? 0 : 1] || '{}');

const levelOffset = opts.levelOffset === undefined ? 2 : opts.levelOffset;
delete opts.levelOffset;

const searchOpts = Object.assign({
	exactBudget: 400000,
	maxTurns: 24,
	timeLimitMs: 60000
}, opts);

// Every early battle, so the generator's seed advances exactly as it does in
// bench_early.js; only the hard ones are actually searched.
const all = H.earlyBattles(loaded);
const realParty = wantsSave ? H.realTeam() : null;

console.log('Hunting clean lines in the fights that fail.  budget ' +
	searchOpts.exactBudget + ' nodes, ' + (searchOpts.timeLimitMs / 1000) +
	's, maxTurns ' + searchOpts.maxTurns);
console.log(wantsSave
	? 'Party: the real save team (' + realParty.map(m => m.species).join(', ') + ')\n'
	: teamCount + ' generated team(s), +' + levelOffset + ' levels\n');

const tally = {};
let totalNodes = 0, totalMs = 0, runs = 0;

for (let t = 0; t < teamCount; t++) {
	for (const battle of all) {
		const level = battle.team[0].level.value + levelOffset;
		// Drawn even for fights we skip: the draw is what keeps these teams
		// aligned with bench_early's.
		const generated = gen.team(level, 6);
		if (!HARD.test(H.label(battle))) continue;
		const party = wantsSave ? realParty : generated;
		if (party.length < 6) continue;

		B.clearCache();
		let result;
		try {
			result = X.cleanWin(B.createState(party, H.foeSets(battle), {}), searchOpts);
		} catch (e) {
			console.log('  ERROR ' + H.label(battle) + ': ' + e.message);
			continue;
		}
		runs++;
		totalNodes += result.nodes;
		totalMs += result.elapsedMs;

		const key = H.label(battle);
		const row = tally[key] || (tally[key] = {found: 0, impossible: 0,
			undecided: 0, nodes: 0, ms: 0, n: 0, foundNodes: [], foundMs: []});
		row.n++;
		row.nodes += result.nodes;
		row.ms += result.elapsedMs;
		if (result.found) {
			row.found++;
			row.foundNodes.push(result.nodes);
			row.foundMs.push(result.elapsedMs);
		} else if (result.decided) {
			row.impossible++;
		} else {
			row.undecided++;
		}

		const verdict = result.found ? 'FOUND    ' + result.line.length + ' turns'
			: result.decided ? 'IMPOSSIBLE' : 'undecided';
		console.log('  ' + key.padEnd(22) + ' team ' + (t + 1) + '  ' +
			verdict.padEnd(18) + String(result.nodes).padStart(9) + ' nodes  ' +
			(result.elapsedMs / 1000).toFixed(1) + 's');
	}
}

function median(list) {
	if (!list.length) return null;
	const sorted = list.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

console.log('\nPer fight:');
for (const key of Object.keys(tally)) {
	const row = tally[key];
	const medNodes = median(row.foundNodes);
	console.log('  ' + key.padEnd(22) +
		' found ' + row.found + '/' + row.n +
		'   impossible ' + row.impossible +
		'   undecided ' + row.undecided +
		'   median nodes-to-witness ' + (medNodes === null ? '--' : medNodes));
}
const allFound = Object.values(tally).reduce((s, r) => s + r.found, 0);
console.log('\n  witnesses found      ' + allFound + '/' + runs);
console.log('  total                ' + totalNodes + ' nodes, ' +
	(totalMs / 1000).toFixed(1) + 's');
