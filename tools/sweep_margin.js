/**
 * What does planning against a wider opponent model cost, in fights?
 *
 * The live advisor lost Lt. Surge while switching away from a Pokemon that is
 * IMMUNE to what the opponent was actually doing. The suspicion is that the
 * cost is not the search or the ranking but the opponent model: advice is
 * scored against the worst action in a plausible set that is deliberately kept
 * wide, so a hypothetical switch the AI never makes drives the whole plan.
 *
 * `margin` is the dial. RRAI.plausible keeps everything within `margin` points
 * of the AI's top score; 0 trusts the model exactly (the real AI takes the
 * argmax), 5 is the default, 20 keeps nearly everything. The flag-set union
 * widens it further by taking the union over three possible trainer configs.
 *
 * This measures win, loss and turns across the dial, so the pessimism has a
 * price in fights rather than in adjectives.
 *
 * Run: node tools/sweep_margin.js [PATTERN]
 */
'use strict';

const H = require('./lib/harness.js');
const live = require('./lib/live.js');

const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const STEP = {mode: 'expected'};
const MAX_TURNS = 60;

const pattern = (process.argv[2] || 'SURGE').toUpperCase();
const party = H.realTeam();
const battles = H.earlyBattles(engine, {maxLevel: 100, relativeBase: 75})
	.filter(b => H.label(b).toUpperCase().includes(pattern));
if (!battles.length) { console.log('no battle matching ' + pattern); process.exit(1); }
const battle = battles[0];

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

function run(opts, restrict) {
	let real = B.createState(party, H.foeSets(battle), {});
	let believed = B.clone(real);
	const session = live.createSession();
	let turns = 0, switches = 0;
	while (turns < MAX_TURNS) {
		if (real.foe.team.every(m => m.fainted) || real.me.team.every(m => m.fainted)) break;
		const obs = live.observe(real);
		const advice = live.advise(believed, obs, opts, engine, session);
		if (!advice || !advice.best) break;
		// `movesOnly` is a diagnostic, not a proposal: if refusing to switch at
		// all outperforms the advisor's own choices, the ranking is paying for
		// switches it should not be buying.
		if (restrict === 'movesOnly' && advice.best.action.type === 'switch') {
			const alt = (advice.plan || []).find(e => e.action.type === 'move');
			if (alt) advice.best = alt;
		}
		if (advice.best.action.type === 'switch') switches++;
		const mine = B.legalActions(real, 'me').find(a => advice.best.action.type === 'switch'
			? (a.type === 'switch' && a.index === advice.best.action.index)
			: (a.type === 'move' && a.move === advice.best.action.move));
		const theirs = foeArgmax(real);
		if (!mine || !theirs) break;
		let stepped;
		try { stepped = B.step(real, mine, theirs, STEP); } catch (e) { break; }
		if (!stepped || !stepped.length) break;
		real = stepped[0].state;
		try { believed = B.step(believed, mine, theirs, STEP)[0].state; }
		catch (e) { believed = B.clone(real); }
		turns++;
	}
	return {
		won: real.foe.team.every(m => m.fainted),
		lost: real.me.team.filter(m => m.fainted).length,
		foeLeft: real.foe.team.filter(m => !m.fainted).length,
		turns: turns, switches: switches
	};
}

console.log('=== ' + H.label(battle) + ' ===');
console.log('party: ' + party.map(p => p.species + ' L' + p.level).join(', '));
console.log('James played this and won it losing NOBODY.\n');
console.log('opponent model                          result   ours lost  theirs left  turns  switches');
console.log('----------------------------------------------------------------------------------------');

const BOSS = [{checkBadMove: true, checkGoodMove: true}];
const configs = [
	['margin 20 (keep nearly everything)', {margin: 20}],
	['margin 5  (default)', {margin: 5}],
	['margin 3  (one INCREASE_VIABILITY)', {margin: 3}],
	['margin 0  (trust the AI model)', {margin: 0}],
	['margin 0, boss flags only', {margin: 0, flagSets: BOSS}],
	['margin 3, boss flags only', {margin: 3, flagSets: BOSS}],
	['margin 5, NEVER SWITCH (diagnostic)', {margin: 5}, 'movesOnly'],
	['margin 0, NEVER SWITCH (diagnostic)', {margin: 0}, 'movesOnly']
];
for (const [name, extra, restrict] of configs) {
	const opts = Object.assign({lookahead: 2, budget: 20000}, extra);
	const r = run(opts, restrict);
	console.log(name.padEnd(40) +
		(r.won ? 'WON' : 'lost').padEnd(9) +
		String(r.lost).padStart(5) + String(r.foeLeft).padStart(13) +
		String(r.turns).padStart(8) + String(r.switches).padStart(10));
}
