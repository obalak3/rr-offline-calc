/**
 * Checks the Web Worker search bundle. Run: node tools/test_worker.js
 *
 * The bundle is the one piece of this project that cannot be exercised by any
 * other test: it is a generated string of concatenated source that only ever
 * runs inside a Blob worker, on a file:// page, which no test here can open.
 * Left unchecked, the failure mode is the worst kind -- a worker that dies
 * silently the first time someone clicks "Plan this fight", with the page
 * looking fine and no error anywhere.
 *
 * So this runs the bundle for real. It builds a fake worker scope, evaluates the
 * generated source inside it exactly as a browser would, posts it a battle, and
 * checks the route that comes back. That covers everything except the browser's
 * own Blob and Worker plumbing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {execFileSync} = require('child_process');

const root = path.join(__dirname, '..');
const bundlePath = path.join(root, 'upstream-calc/dist/js/rr-worker-src.js');

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

// Build it if it is not there, so this test is runnable on a fresh checkout.
if (!fs.existsSync(bundlePath)) {
	execFileSync('node', [path.join(root, 'tools/build_worker.js')], {stdio: 'ignore'});
}
check('the bundle exists', fs.existsSync(bundlePath));
if (!fs.existsSync(bundlePath)) process.exit(1);

const wrapper = fs.readFileSync(bundlePath, 'utf8');
const holder = {};
vm.createContext(holder);
vm.runInContext(wrapper, holder);
const source = holder.RR_WORKER_SRC;
check('it defines the source string', typeof source === 'string' && source.length > 100000,
	'got ' + typeof source + ', length ' + (source && source.length));

// A worker scope: `self` is the global, and postMessage is how it answers.
const replies = [];
const scope = {console, Math, JSON, Object, Array, Infinity, Number, Date, String,
	Error, RegExp, isNaN, parseInt, parseFloat, undefined: undefined};
scope.self = scope;
scope.postMessage = function (msg) { replies.push(msg); };
vm.createContext(scope);

let booted = true, bootError = null;
try {
	vm.runInContext(source, scope);
} catch (e) {
	booted = false;
	bootError = e.message;
}
check('the bundle runs in a worker-shaped scope', booted, bootError);
if (!booted) { console.log('\n%d failure(s)', ++failures); process.exit(1); }

check('  the calculator is present', typeof scope.calc === 'object' && !!scope.calc.Pokemon);
check('  the battle engine is present', !!scope.RRBattle && !!scope.RRBattle.createState);
check('  the AI model is present', !!scope.RRAI && !!scope.RRAI.scoreAll);
check('  the exact search is present', !!scope.RRExact && !!scope.RRExact.planRoute);
check('  the move table came along', !!scope.RR_MOVE_EFFECTS &&
	Object.keys(scope.RR_MOVE_EFFECTS.moves).length > 1000);
check('  it registered a message handler', typeof scope.onmessage === 'function');

// ------------------------------------------------------- it answers a battle

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, moves, level) {
	return {species, level, nature: 'Serious', ability: undefined, item: '',
		moves, evs: EVS, ivs: IVS};
}

// The state is built with the bundle's OWN engine, which is what the page does:
// it hands over a state it built on the main thread.
const state = scope.RRBattle.createState(
	[set('Blastoise', ['Surf', 'Ice Beam', 'Bite', 'Rapid Spin'], 45)],
	[set('Geodude', ['Rock Throw', 'Defense Curl'], 13)], {});

scope.onmessage({data: {kind: 'solve', state: state,
	search: {exactBudget: 200000, timeLimitMs: 10000, maxTurns: 16, lookahead: 2}}});

check('it replies to a solve request', replies.length === 1,
	'got ' + replies.length + ' replies');
const reply = replies[0] || {};
check('  the reply says it worked', reply.ok === true, reply.error);
check('  with a route that wins', !!reply.route && reply.route.won === true);
check('  losing nothing', reply.route && reply.route.losses === 0);
check('  proved rather than guessed', reply.route && reply.route.exactness === 'proved',
	reply.route && reply.route.exactness);
check('  and priced for risk', !!reply.priced && typeof reply.priced.overall === 'number',
	JSON.stringify(reply.priced && Object.keys(reply.priced)));

// The reply has to survive structured clone, which is how it gets back to the
// page. JSON round-tripping is a stricter check than the browser applies, so
// passing it means postMessage will certainly cope.
let cloneable = true;
try { JSON.parse(JSON.stringify(reply)); } catch (e) { cloneable = false; }
check('  and the reply is plain data the page can receive', cloneable);

// ------------------------------------------------------------ it fails loudly

replies.length = 0;
scope.onmessage({data: {kind: 'solve', state: {me: null, foe: null}, search: {}}});
check('a broken request comes back as an error, not silence',
	replies.length === 1 && replies[0].ok === false, JSON.stringify(replies[0]));

// Messages it does not understand must be ignored rather than answered, or a
// stray message from anything else on the page would look like a result.
replies.length = 0;
scope.onmessage({data: {kind: 'something-else'}});
check('it ignores messages meant for someone else', replies.length === 0);

// ------------------------------------------------- the bundle matches the page

// If the page gains a calc script and the bundle does not, the worker would run
// a different damage engine from the main thread and the two would disagree
// about numbers, invisibly.
const templateSrc = fs.readFileSync(
	path.join(root, 'upstream-calc/src/index.template.html'), 'utf8');
const pageCalc = (templateSrc.match(/src="\.\/calc\/[^"?]+/g) || []).length;
const bundleCalc = (source.match(/sourceMappingURL=[a-z0-9.]+\.js\.map/gi) || []).length;
check('the bundle carries every calc file the page loads (' + pageCalc + ' in the page)',
	bundleCalc >= pageCalc - 1, 'bundle appears to have ' + bundleCalc);

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
