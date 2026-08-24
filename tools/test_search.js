/**
 * Checks for the split search. Run: node tools/test_search.js
 *
 * rr-search.js is the one piece that only ever runs in a browser, against an
 * API this project cannot drive from here -- the Chrome tooling refuses
 * file:// URLs, and file:// is the whole point of the app. So the Worker, Blob
 * and URL objects are faked and the orchestration is tested directly, which is
 * the same reason tools/test_worker.js exists for the bundle.
 *
 * What is under test is not speed, it is the asymmetry the split rests on:
 *
 *   ONE share finding a line settles the whole question, because a line is a
 *   line no matter which share of the opening moves turned it up.
 *   NO share finding a line settles nothing unless EVERY share finished. A
 *   share that ran out of budget, or died, leaves the answer undecided -- and
 *   reporting it as "this fight cannot be won cleanly" is the one lie this
 *   engine must never tell, whether it comes from one worker or six.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

// Every fake worker made during a test, so a test can drive their replies.
let born = [];

function makeSandbox() {
	born = [];
	const sandbox = {
		calc, console, Math, JSON, Object, Array, Infinity, Number, Date, String,
		Boolean, setTimeout, RR_WORKER_SRC: 'fake engine source',
		navigator: {hardwareConcurrency: 4},
		Blob: function (parts, opts) { this.parts = parts; this.opts = opts; },
		URL: {
			createObjectURL: function () { return 'blob:fake/' + born.length; },
			revokeObjectURL: function () {}
		},
		Worker: function (url) {
			const self = this;
			this.url = url;
			this.sent = [];
			this.terminated = false;
			this.onmessage = null;
			this.onerror = null;
			this.postMessage = function (payload) { self.sent.push(payload); };
			this.terminate = function () { self.terminated = true; };
			// Drive a reply as if the worker had sent one.
			this.reply = function (data) {
				if (self.onmessage) self.onmessage({data: data});
			};
			born.push(this);
		}
	};
	vm.createContext(sandbox);
	for (const file of ['src/js/data/rr-move-effects.js', 'src/js/rr-critko.js',
		'src/js/rr-battle.js', 'src/js/rr-ai.js', 'src/js/rr-plan.js',
		'src/js/rr-solver.js', 'src/js/rr-matchup.js', 'src/js/rr-exact.js',
		'src/js/rr-search.js']) {
		vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
	}
	return sandbox;
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, moves, level) {
	return {species, level, nature: 'Serious', moves, item: '', evs: EVS, ivs: IVS};
}

function fixture() {
	const sandbox = makeSandbox();
	const B = sandbox.RRBattle;
	const state = B.createState(
		[set('Machamp', ['Karate Chop', 'Headbutt'], 40), set('Snorlax', ['Body Slam'], 40)],
		[set('Magikarp', ['Splash'], 20)], {});
	return {sandbox, state};
}

// --- the openings really are dealt out -------------------------------------
{
	const {sandbox, state} = fixture();
	sandbox.RRSearch.solve(state, {}, function () {}, function () {}, function () {});
	check('the search is split across several workers', born.length > 1,
		born.length + ' worker(s)');

	const hands = born.map(w => w.sent[0].search.rootActions);
	check('  every worker is given a share of the openings',
		hands.every(h => Array.isArray(h) && h.length > 0));

	const all = [].concat.apply([], hands);
	const unique = new Set(all);
	check('  no opening is searched twice', unique.size === all.length,
		JSON.stringify(hands));

	const expected = sandbox.RRBattle.legalActions(state, 'me')
		.map(sandbox.RRExact.actionKey);
	check('  and none is missed', unique.size === expected.length &&
		expected.every(k => unique.has(k)),
		JSON.stringify({dealt: [...unique], legal: expected}));
}

// --- one line ends it -------------------------------------------------------
{
	const {sandbox, state} = fixture();
	let got = null;
	sandbox.RRSearch.solve(state, {}, function (r) { got = r; },
		function () {}, function () {});
	const crew = born.slice();
	crew[1].reply({ok: true, kind: 'hunt', found: true, nodes: 40,
		route: {exactness: 'line-found', won: true, steps: [{turn: 1}]}, priced: null});

	check('a line from any one share answers the whole question',
		!!got && got.route.exactness === 'line-found');
	check('  and the other searches are stopped',
		crew.filter(w => w.terminated).length === crew.length,
		crew.map(w => w.terminated).join(','));
}

// --- an unfinished share must not become "impossible" -----------------------
{
	const {sandbox, state} = fixture();
	let got = null;
	sandbox.RRSearch.solve(state, {}, function (r) { got = r; },
		function () {}, function () {});
	const crew = born.slice();
	// Everyone comes back empty, but ONE of them ran out of budget.
	crew.forEach(function (w, i) {
		w.reply({ok: true, kind: 'hunt', found: false, decided: i !== 0, nodes: 10});
	});
	const asked = born[born.length - 1].sent.find(m => m.kind === 'fallback');
	check('every share coming back empty asks for the guess once', !!asked,
		JSON.stringify(born.map(w => w.sent.map(m => m.kind))));
	check('  and one unfinished share means the fight is NOT decided',
		asked && asked.decided === false, asked && String(asked.decided));
}

// --- all finished, all empty: that IS a decision ----------------------------
{
	const {sandbox, state} = fixture();
	sandbox.RRSearch.solve(state, {}, function () {}, function () {}, function () {});
	born.slice().forEach(function (w) {
		w.reply({ok: true, kind: 'hunt', found: false, decided: true, nodes: 10});
	});
	const asked = born[born.length - 1].sent.find(m => m.kind === 'fallback');
	check('every share finishing empty does decide the fight',
		asked && asked.decided === true, asked && String(asked.decided));
}

// --- a worker dying is not evidence of anything -----------------------------
{
	const {sandbox, state} = fixture();
	sandbox.RRSearch.solve(state, {}, function () {}, function () {}, function () {});
	const crew = born.slice();
	crew[0].onerror({message: 'worker died'});
	crew.slice(1).forEach(function (w) {
		w.reply({ok: true, kind: 'hunt', found: false, decided: true, nodes: 10});
	});
	const asked = born[born.length - 1].sent.find(m => m.kind === 'fallback');
	check('a share that crashed leaves the fight undecided',
		asked && asked.decided === false, asked && String(asked.decided));
}

// --- progress is the whole search, not one share of it ----------------------
{
	const {sandbox, state} = fixture();
	const seen = [];
	sandbox.RRSearch.solve(state, {}, function () {}, function () {},
		function (nodes, elapsedMs) { seen.push({nodes, elapsedMs}); });
	const crew = born.slice();
	crew[0].reply({kind: 'progress', nodes: 1000, elapsedMs: 50});
	crew[1].reply({kind: 'progress', nodes: 250, elapsedMs: 50});
	const last = seen[seen.length - 1];
	check('progress adds up every share rather than reporting one',
		!!last && last.nodes === 1250, JSON.stringify(seen));
	// This was wrong at first: elapsed was measured from a start time read at
	// the moment it was printed, so every search reported zero seconds.
	check('  and the clock runs from when the search started',
		!!last && typeof last.elapsedMs === 'number' && last.elapsedMs >= 0 &&
		last.elapsedMs < 60000, last && String(last.elapsedMs));

	// A later report from one worker replaces its own count, never adds to it.
	crew[0].reply({kind: 'progress', nodes: 1500, elapsedMs: 90});
	const after = seen[seen.length - 1];
	check('  and a worker\'s new count replaces its old one',
		after.nodes === 1750, String(after.nodes));
}

console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
