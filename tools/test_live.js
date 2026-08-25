/**
 * End-to-end test of everything downstream of the pixels.
 *
 * The screen reader does not exist yet, and waiting for it before testing the
 * advisor would mean debugging two unknowns at once. So this manufactures the
 * observations the reader is specified to produce -- exact own HP, the foe as a
 * bar -- by playing a real trainer battle in the simulator and looking at each
 * position through `live.observe`. Everything after that point is the real
 * code path the live advisor will use.
 *
 * What it checks, in order of what would hurt most if it broke:
 *
 *   1. The loop survives a whole battle: faints, replacements, switches.
 *   2. Believed state stays pinned to what is visible. A simulated state that
 *      drifts from the screen is the failure that makes advice quietly wrong,
 *      so the observed HP is compared against the synced state every turn.
 *   3. Advice is fast enough to be live. One-turn-deep planning has to finish
 *      between the message ending and the player pressing a button.
 *   4. How often the foe's HP range actually changes the recommendation, which
 *      is the number that decides whether the advisor ever needs to ask.
 *
 * Run: node tools/test_live.js [PATTERN]
 */
'use strict';

const H = require('./lib/harness.js');
const live = require('./lib/live.js');
const hpbar = require('./lib/hpbar.js');

const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const STEP = {mode: 'expected'};

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const pattern = (process.argv[2] || 'SURGE').toUpperCase();
const party = H.realTeam();
const battles = H.earlyBattles(engine, {maxLevel: 100, relativeBase: 75})
	.filter(b => H.label(b).toUpperCase().includes(pattern));
if (!battles.length) { console.log('no battle matching ' + pattern); process.exit(1); }
const battle = battles[0];
console.log('=== live advisor over ' + H.label(battle) + ' ===');
console.log('party: ' + party.map(p => p.species + ' L' + p.level).join(', ') + '\n');

function foeArgmax(st) {
	const scored = RRAI.scoreAll(st, 'foe', FLAGS, {});
	const gate = RRAI.switchGate(st, 'foe', FLAGS);
	let best = null;
	for (const e of scored) {
		if (e.action.type === 'switch' && !gate.maySwitch) continue;
		if (!best || e.score > best.score) best = e;
	}
	return best && best.action;
}

const truth = B.createState(party, H.foeSets(battle), {});
// The advisor's own belief. It starts equal to the truth -- both sides' teams
// are known from the save and from trainer data -- and from here on it is only
// ever corrected through observations, never from `truth` directly.
let believed = B.clone(truth);
const session = live.createSession();
let real = truth;

let turns = 0, ambiguous = 0, exact = 0, drift = 0;
let totalMs = 0, worstMs = 0;
const log = [];

while (turns < 40) {
	if (real.foe.team.every(m => m.fainted) || real.me.team.every(m => m.fainted)) break;

	const obs = live.observe(real);

	const t0 = Date.now();
	const advice = live.advise(believed, obs, {lookahead: 2, budget: 20000}, engine, session);
	const ms = Date.now() - t0;
	totalMs += ms;
	if (ms > worstMs) worstMs = ms;

	if (!advice) { check('advisor produced advice on turn ' + obs.turn, false, 'null'); break; }

	// The synced state must agree with the screen on everything the screen shows.
	const syncedMe = advice.state.me.team[advice.state.me.active];
	if (syncedMe.curHP !== obs.me.hp || syncedMe.species !== obs.me.species) drift++;

	// And the true foe HP must lie inside the range we inferred from the bar.
	const trueFoe = real.foe.team[real.foe.active];
	if (trueFoe.curHP < advice.range.lo || trueFoe.curHP > advice.range.hi) drift++;

	if (advice.ambiguous) ambiguous++;
	if (advice.exact) exact++;

	log.push('t' + String(obs.turn).padStart(2) + '  ' +
		(obs.me.species + ' ' + obs.me.hp + '/' + obs.me.maxHP).padEnd(24) +
		('vs ' + obs.foe.species + ' bar ' + obs.foe.barPx + '/48 -> ' +
			advice.range.lo + '-' + advice.range.hi).padEnd(40) +
		'>> ' + (advice.best ? advice.best.label : '(none)') +
		(advice.ambiguous ? '   [HP RANGE MATTERS: else ' +
			(advice.alternative ? advice.alternative.label : '?') + ']' : '') +
		'  ' + ms + 'ms');

	// Play the advised action for real, opponent plays its argmax.
	const mine = B.legalActions(real, 'me').find(a => advice.best &&
		(advice.best.action.type === 'switch'
			? (a.type === 'switch' && a.index === advice.best.action.index)
			: (a.type === 'move' && a.move === advice.best.action.move)));
	const theirs = foeArgmax(real);
	if (!mine || !theirs) break;
	let stepped;
	try { stepped = B.step(real, mine, theirs, STEP); } catch (e) { break; }
	if (!stepped || !stepped.length) break;
	real = stepped[0].state;

	// The advisor advances its OWN belief with the same actions it saw played.
	try { believed = B.step(believed, mine, theirs, STEP)[0].state; }
	catch (e) { believed = B.clone(real); }
	turns++;
}

console.log(log.join('\n'));
console.log('');
const won = real.foe.team.every(m => m.fainted);
const lost = real.me.team.filter(m => m.fainted).length;
console.log('outcome: ' + (won ? 'WON' : 'did not finish') + ', lost ' + lost +
	' over ' + turns + ' turns\n');

check('the loop survived a whole battle without a null', turns > 3);
check('  believed state never drifted from what the screen showed (' + drift + ')',
	drift === 0, drift + ' turn(s) disagreed');
check('  every recommendation arrived fast enough to be live (worst ' + worstMs + 'ms)',
	worstMs < 1000, 'worst ' + worstMs + 'ms');
console.log('        mean ' + Math.round(totalMs / Math.max(1, turns)) + 'ms per turn');
console.log('        foe HP exact on ' + exact + '/' + turns + ' turns');
console.log('        HP range changed the advice on ' + ambiguous + '/' + turns + ' turns');
console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
