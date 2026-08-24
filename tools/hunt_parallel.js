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

const fs = require('fs');
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

/**
 * What is already known about this fight, from a run that did not finish.
 *
 * The searches ahead are hours long and the machine they run on is a laptop
 * that gets closed, so a run that is interrupted must not be a total loss. What
 * can honestly be carried across runs is not the search frontier -- that would
 * mean serialising a depth-first stack, which is a different project -- but
 * something simpler and nearly as valuable: **which openings were finished**.
 *
 * A share that came back DECIDED has exhausted its openings and proved there is
 * no clean line beginning with any of them. That fact does not expire. A
 * resumed run deals out only the openings nobody has settled yet, so six hours
 * of finished work is six hours nobody repeats.
 *
 * Keyed on the fight AND the exact party, because a different team facing the
 * same trainer is a different question with the same name.
 */
const checkpointDir = path.join(H.root, '.checkpoints');
const fightKey = H.label(battle).replace(/[^A-Za-z0-9]+/g, '_') + '-' +
	party.map(m => m.species + m.level).join('_').replace(/[^A-Za-z0-9_]+/g, '');
const checkpointPath = path.join(checkpointDir, fightKey + '.json');

let settledKeys = {};
let priorNodes = 0;
if (fs.existsSync(checkpointPath)) {
	try {
		const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
		if (saved.verdict === 'found') {
			console.log('Already answered, from ' + checkpointPath + ':');
			console.log('  CLEAN LINE FOUND, ' + saved.steps.length + ' turns');
			saved.steps.forEach(st => console.log('  ' + st.turn + '. ' + st.myMon +
				': ' + st.label + '   (' + st.theirMon + ' ' + st.theirLabel + ')'));
			console.log('\nDelete that file to search again.');
			process.exit(0);
		}
		settledKeys = saved.settledKeys || {};
		priorNodes = saved.nodes || 0;
	} catch (e) { settledKeys = {}; }
}

// Dealt round robin rather than in blocks, so no worker is handed only the
// hopeless openings while another gets all the promising ones.
const allKeys = X.rootActionKeys(state, {});
const keys = allKeys.filter(k => !settledKeys[k]);
if (!keys.length) {
	console.log(H.label(battle));
	console.log('\nVERDICT: NO CLEAN LINE EXISTS');
	console.log('  every opening was settled across earlier runs (' +
		priorNodes.toLocaleString() + ' nodes)');
	process.exit(0);
}
const hands = [];
for (let i = 0; i < Math.min(workerCount, keys.length); i++) hands.push([]);
keys.forEach((k, i) => hands[i % hands.length].push(k));

console.log(H.label(battle));
console.log('  party  ' + party.map(m => m.species + ' L' + m.level).join(', '));
console.log('  foe    ' + battle.team.map(m => m.species + ' L' + m.level.value).join(', '));
console.log('  ' + hands.length + ' processes x ' + perCore.toLocaleString() +
	' nodes = ' + (hands.length * perCore).toLocaleString() + ' effective');
if (Object.keys(settledKeys).length) {
	console.log('  resuming: ' + Object.keys(settledKeys).length + ' of ' +
		allKeys.length + ' openings already settled by earlier runs');
}
console.log('');

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

/**
 * Write down what is known, now, rather than at the end.
 *
 * Called every time a share reports, so killing the run at any moment leaves
 * the finished openings recorded. That is the whole point: these searches take
 * hours and the laptop they run on gets closed.
 */
function saveCheckpoint(extra) {
	try {
		fs.mkdirSync(checkpointDir, {recursive: true});
		fs.writeFileSync(checkpointPath, JSON.stringify(Object.assign({
			fight: H.label(battle),
			party: party.map(m => m.species + ' L' + m.level),
			settledKeys: settledKeys,
			nodes: priorNodes + nodes.reduce((a, b) => a + b, 0),
			updated: new Date().toISOString()
		}, extra || {}), null, 1));
	} catch (e) { /* a checkpoint that cannot be written must not kill the run */ }
}

function finish(verdict, extra, saveAs) {
	if (settled) return;
	settled = true;
	killAll();
	const total = priorNodes + nodes.reduce((a, b) => a + b, 0);
	saveCheckpoint(saveAs);
	console.log('\n\nVERDICT: ' + verdict);
	console.log('  ' + total.toLocaleString() + ' nodes in ' +
		Math.round((Date.now() - started) / 1000) + 's across ' + hands.length +
		' processes' + (priorNodes ? ' (including earlier runs)' : ''));
	if (extra) console.log(extra);
	process.exit(0);
}

// Ctrl-C, or a shell closing under us, still leaves the finished work recorded.
process.on('SIGINT', function () {
	if (!settled) { saveCheckpoint(); console.log('\n\nStopped. Progress saved to ' +
		checkpointPath); }
	killAll();
	process.exit(130);
});

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
			finish('CLEAN LINE FOUND, ' + msg.steps.length + ' turns',
				'\nThe line:\n' + line, {verdict: 'found', steps: msg.steps});
			return;
		}
		// A share that FINISHED has proved there is no clean line starting with
		// any of its openings, and that is true forever. A share that ran out of
		// budget has proved nothing and its openings stay on the list.
		if (msg.decided) {
			hands[index].forEach(k => { settledKeys[k] = true; });
		} else {
			decided = false;
		}
		saveCheckpoint();
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
