/**
 * Ask a hard fight on every core. Run:
 *   node tools/hunt_parallel.js SURGE --save [budget-per-core] [workers]
 *   node tools/hunt_parallel.js MISTY 3                 (generated team 3)
 *
 * WHY. The exact search is not short of judgement, it is short of budget: the
 * ceiling check says the planner wins every fight anybody has shown to be
 * winnable, and every remaining failure is a fight nobody has DECIDED. The app
 * already splits a search across Web Workers, but the question that most needs
 * that -- is Lt. Surge winnable with the real team -- is asked from a script,
 * and the run that came back undecided at six million nodes was using one core
 * of eight.
 *
 * Whatever line exists opens with one of the legal moves, and those branches are
 * independent, so the openings are dealt out and searched at once.
 *
 * THE TWO ENDINGS ARE NOT SYMMETRIC, and that is the whole reason this is
 * allowed to be parallel:
 *
 *   A LINE is a line. The first share to find one has answered the question and
 *   the rest are killed where they stand -- a line found by a search that only
 *   ever looked at two openings is exactly as playable as one found by a search
 *   that looked at all ten.
 *   NO LINE is a claim about the whole tree, so it needs EVERY share to have
 *   finished and come back empty. One share running out of budget, or dying,
 *   leaves the answer undecided. Reporting that as "this fight cannot be won
 *   cleanly" is the one lie this engine must never tell, and several processes
 *   make it easier to get wrong, not harder.
 */
'use strict';

const path = require('path');
const os = require('os');
const {fork} = require('child_process');
const H = require('./lib/harness.js');

const args = process.argv.slice(2);
const wantsSave = args.indexOf('--save') >= 0;
const positional = args.filter(a => a.charAt(0) !== '-');
const pattern = (positional[0] || 'SURGE').toUpperCase();
const teamIndex = wantsSave ? 0 : parseInt(positional[1] || '1', 10);
const perCore = parseInt(positional[wantsSave ? 1 : 2] || '8000000', 10);
const workerCount = parseInt(positional[wantsSave ? 2 : 3] || '0', 10) ||
	Math.max(1, os.cpus().length - 1);

const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B, X = loaded.X;

// Draw teams in the same order as the benchmarks, so "team 3" means the same
// team here as it does there.
const all = H.earlyBattles(loaded);
let party = null, battle = null;
if (wantsSave) {
	party = H.realTeam();
	battle = all.find(b => H.label(b).includes(pattern));
} else {
	for (let t = 0; t < teamIndex; t++) {
		for (const b of all) {
			const p = gen.team(b.team[0].level.value + 2, 6);
			if (t === teamIndex - 1 && H.label(b).includes(pattern)) { party = p; battle = b; }
		}
	}
}
if (!battle) { console.error('no battle matching ' + pattern); process.exit(1); }

const state = B.createState(party, H.foeSets(battle), {});
const search = {exactBudget: perCore, maxTurns: 24};

// Dealt round robin rather than in blocks, so no worker is handed only the
// hopeless openings while another gets all the promising ones.
const keys = X.rootActionKeys(state, {});
const hands = [];
for (let i = 0; i < Math.min(workerCount, keys.length); i++) hands.push([]);
keys.forEach((k, i) => hands[i % hands.length].push(k));

console.log(H.label(battle));
console.log('  party  ' + party.map(m => m.species + ' L' + m.level).join(', '));
console.log('  foe    ' + battle.team.map(m => m.species + ' L' + m.level.value).join(', '));
console.log('  ' + hands.length + ' processes x ' + perCore.toLocaleString() +
	' nodes = ' + (hands.length * perCore).toLocaleString() + ' effective\n');

const nodes = new Array(hands.length).fill(0);
const children = [];
let done = 0, decided = true, settled = false;
const started = Date.now();

function killAll() {
	for (const c of children) { try { c.kill(); } catch (e) { /* gone */ } }
}

function report() {
	const total = nodes.reduce((a, b) => a + b, 0);
	const secs = (Date.now() - started) / 1000;
	process.stdout.write('\r  ' + total.toLocaleString() + ' nodes, ' +
		Math.round(secs) + 's, ' + Math.round(total / secs).toLocaleString() + '/s   ');
}

function finish(verdict, extra) {
	if (settled) return;
	settled = true;
	killAll();
	const total = nodes.reduce((a, b) => a + b, 0);
	console.log('\n\nVERDICT: ' + verdict);
	console.log('  ' + total.toLocaleString() + ' nodes in ' +
		Math.round((Date.now() - started) / 1000) + 's across ' + hands.length + ' processes');
	if (extra) console.log(extra);
	process.exit(0);
}

hands.forEach(function (hand, index) {
	const child = fork(path.join(__dirname, 'lib/hunt_child.js'), [], {stdio: 'inherit'});
	children.push(child);
	child.on('message', function (msg) {
		if (settled) return;
		if (msg.kind === 'progress') { nodes[index] = msg.nodes; report(); return; }
		if (msg.ok === false) {
			// A share that died searched nothing, so its silence proves nothing.
			console.log('\n  worker ' + index + ' failed: ' + msg.error);
			decided = false;
			if (++done >= hands.length) finish('UNDECIDED (a share failed)');
			return;
		}
		nodes[index] = msg.nodes;
		if (msg.found) {
			const line = msg.steps.map(s => '  ' + s.turn + '. ' + s.myMon + ': ' +
				s.label + '   (' + s.theirMon + ' ' + s.theirLabel + ')  you ' +
				s.myHP + '/' + s.myMaxHP).join('\n');
			finish('CLEAN LINE FOUND, ' + msg.steps.length + ' turns', '\nThe line:\n' + line);
			return;
		}
		if (!msg.decided) decided = false;
		if (++done >= hands.length) {
			finish(decided ? 'NO CLEAN LINE EXISTS (every share finished)'
				: 'UNDECIDED (budget ran out)');
		}
	});
	child.on('exit', function (code) {
		if (settled || code === 0) return;
		decided = false;
		if (++done >= hands.length) finish('UNDECIDED (a share died)');
	});
	child.send({kind: 'hunt', party: party, label: H.label(battle),
		pattern: pattern, rootActions: hand, search: search});
});
