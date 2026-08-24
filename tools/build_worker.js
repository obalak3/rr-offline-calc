/**
 * Bundle the search engine into a string the page can hand to a Web Worker.
 * Run: node tools/build_worker.js   (the main build runs it for you)
 *
 * WHY THIS IS NEEDED AT ALL. Chrome refuses `new Worker('./thing.js')` from a
 * `file://` page, and `file://` is the entire point of this project -- it exists
 * so the calculator opens on a plane with no server. Verified in Chrome rather
 * than assumed, because the whole bundle exists to work around it:
 *
 *     PLAIN WORKER: threw -- Failed to construct 'Worker': Script at
 *     'file:///...' cannot be accessed from origin 'null'.
 *     BLOB WORKER:  WORKS
 *
 * Worth re-checking if this ever seems like dead weight: if a future Chrome
 * allows the plain form, this entire file and its 1.3 MB of output can go, and
 * rr-search.js becomes `new Worker('./js/rr-search-worker.js')`. The way round that is to
 * build the worker from a Blob URL, but a blob worker cannot importScripts a
 * file:// path either, so every line of code it needs has to be inside the blob.
 * The page also cannot read its own script files (no fetch from file://), so the
 * source has to be handed to it as data. Hence: a generated file that assigns
 * the whole engine to a string.
 *
 * WHAT GOES IN. Only what the search needs, which is much less than the page
 * loads: the calculator, the move table, and the battle/AI/plan/solver/exact
 * modules. No jQuery, no UI, no Pokedex, no trainer dataset -- the state arrives
 * from the page already built.
 *
 * The calc file list is read out of index.template.html rather than written
 * here, so adding a calc file to the page cannot silently leave the worker
 * running a different engine from the main thread. That divergence would be
 * invisible until a damage number disagreed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'upstream-calc/src');
const dist = path.join(root, 'upstream-calc/dist');

const template = fs.readFileSync(path.join(src, 'index.template.html'), 'utf8');

// The calculator is CommonJS loaded as plain scripts, which the page makes work
// with a three-line shim: every module writes into one shared `exports` object
// that is also `calc`. The worker needs the same trick, with `self` where the
// page has `this`.
const SHIM = [
	'self.__createBinding = function (o, m, k) { o[k] = m[k]; };',
	'var calc = exports = {};',
	'function require() { return exports; }'
].join('\n');

const calcFiles = [];
const re = /src="\.\/(calc\/[^"?]+)/g;
let match;
while ((match = re.exec(template)) !== null) calcFiles.push(match[1]);
if (!calcFiles.length) {
	console.error('Found no calc scripts in index.template.html -- has the page changed?');
	process.exit(1);
}

const engineFiles = [
	'js/data/rr-move-effects.js',
	'js/rr-critko.js',
	'js/rr-battle.js',
	'js/rr-ai.js',
	'js/rr-plan.js',
	'js/rr-solver.js',
	// rr-matchup must precede rr-exact: the exact search reads the pairing
	// table through the global this file defines.
	'js/rr-matchup.js',
	'js/rr-exact.js'
];

/**
 * The worker's own entry point.
 *
 * Deliberately thin. Everything it does is already tested on the main thread,
 * and logic that only runs inside a worker is logic that only breaks inside a
 * worker, where it is hardest to see.
 */
const ENTRY = `
// Price the risks for any line we actually found, whether or not it certified.
// A line-found route is exactly the one that NEEDS its risks spelled out, since
// it is not proof against bad luck.
function priceRoute(state, route) {
	if (route.exactness !== "certified" && route.exactness !== "line-found") return null;
	try {
		return RRSolver.routeRisks(state, route, {risks: {roll: "median"}});
	} catch (e) { return null; }
}

self.onmessage = function (event) {
	var payload = event.data || {};
	var state = payload.state;
	var search = payload.search || {};
	try {
		search.onProgress = function (nodes, elapsedMs) {
			self.postMessage({kind: "progress", nodes: nodes, elapsedMs: elapsedMs});
		};
		if (payload.kind === "solve") {
			var route = RRExact.planRoute(state, search);
			self.postMessage({ok: true, route: route, priced: priceRoute(state, route)});
			return;
		}
		// One share of a search split across several workers. Only the openings
		// in search.rootActions are explored, so "decided" here means this share
		// finished -- the caller adds them up before concluding anything.
		if (payload.kind === "hunt") {
			var proof = RRExact.cleanWin(state, search);
			if (!proof.found) {
				self.postMessage({ok: true, kind: "hunt", found: false,
					decided: proof.decided, nodes: proof.nodes});
				return;
			}
			var won = RRExact.routeFromProof(state, proof, search);
			self.postMessage({ok: true, kind: "hunt", found: true, nodes: proof.nodes,
				route: won, priced: priceRoute(state, won)});
			return;
		}
		// Every share came back empty, so this is the guess.
		if (payload.kind === "fallback") {
			var guess = RRExact.fallbackRoute(state, search, payload.decided, payload.nodes);
			self.postMessage({ok: true, route: guess, priced: priceRoute(state, guess)});
			return;
		}
	} catch (err) {
		self.postMessage({ok: false, error: String((err && err.message) || err)});
	}
};
`;

function read(rel) {
	for (const base of [dist, src]) {
		const full = path.join(base, rel);
		if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
	}
	console.error('Missing file for the worker bundle: ' + rel);
	process.exit(1);
}

/**
 * Each calculator file gets its own scope, which is what separate <script> tags
 * already gave it in the page.
 *
 * Concatenating them naively does NOT reproduce the page, and the way it breaks
 * is vicious. Both calc/calc.js and calc/index.js declare a top-level
 * `function calculate`. As separate scripts, calc.js's version is the live
 * binding while calc.js runs, so `exports.calculate = calculate` stores the real
 * one, and index.js later captures that and installs a wrapper around it. Glued
 * into a single script, every function declaration hoists to the top and the
 * LAST one wins, so index.js's wrapper is already the binding when calc.js runs
 * -- the wrapper captures itself and recurses until the stack dies.
 *
 * The symptom was not a crash anywhere visible. calculate() threw
 * "Maximum call stack size exceeded", damage came back as zero, every move read
 * as an immunity, and the worker simply reported that no clean line existed.
 * Silently wrong answers, forever.
 *
 * Called with `self` so top-level `this` still means the global, as it does in a
 * classic script.
 */
function isolate(source) {
	return '(function () {\n' + source + '\n}).call(self);';
}

const parts = [SHIM];
for (const rel of calcFiles) parts.push(isolate(read(rel)));
// Our own modules are NOT isolated: each is already an IIFE that assigns a
// global (RRBattle, RRAI, ...), and wrapping them would hide exactly the names
// the worker needs.
for (const rel of engineFiles) parts.push(read(rel));
parts.push(ENTRY);

const source = parts.join('\n;\n');

// JSON.stringify does the escaping, so no amount of quoting or backslashes in
// the engine source can break out of the string.
const out = '// Generated by tools/build_worker.js -- do not edit.\n' +
	'var RR_WORKER_SRC = ' + JSON.stringify(source) + ';\n';

const dest = path.join(dist, 'js/rr-worker-src.js');
fs.mkdirSync(path.dirname(dest), {recursive: true});
fs.writeFileSync(dest, out);

console.log('Worker bundle: %d calc files + %d engine files',
	calcFiles.length, engineFiles.length);
console.log('  engine source %d KB, written as %d KB of escaped string',
	Math.round(source.length / 1024), Math.round(out.length / 1024));
console.log('  -> %s', path.relative(root, dest));

// A bundle that cannot parse is worse than no bundle: the failure would show up
// as a worker that dies silently on first use.
try {
	new Function(source);
	console.log('  bundle parses.');
} catch (e) {
	console.error('  BUNDLE DOES NOT PARSE: ' + e.message);
	process.exit(1);
}
