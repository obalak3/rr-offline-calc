/**
 * How the live advisor behaves over many real fights, not just one.
 *
 * tools/test_live.js found the loop working and fast on Surge, and also found
 * it oscillating between two switches for twenty turns without ever attacking.
 * A single fight cannot say whether that is a quirk of one matchup or the
 * advisor's normal behaviour, and the difference decides whether the live
 * advisor needs a new objective or a small guard. So: prevalence first.
 *
 * Run: node tools/measure_live.js [maxBattles]
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

const party = H.realTeam();
const limit = parseInt(process.argv[2], 10) || 12;
// Default to fights near the party's own level. Scaling late-game leaders down
// to a level-34 team produces hopeless matchups, and a win rate over those
// measures the level gap rather than the advisor.
const MAXLEVEL = parseInt(process.env.MAXLEVEL, 10) || 40;
const battles = H.earlyBattles(engine, {maxLevel: MAXLEVEL}).slice(0, limit);

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

console.log('party: ' + party.map(p => p.species + ' L' + p.level).join(', '));
console.log('battles: ' + battles.length + '\n');
console.log('battle                              turns  result      switches  loop  forced  ms/turn');
console.log('--------------------------------------------------------------------------------------');

let stalled = 0, won = 0, looped = 0, totalTurns = 0, totalMs = 0, totalAmbig = 0;

for (const battle of battles) {
	let real = B.createState(party, H.foeSets(battle), {});
	let believed = B.clone(real);
	const session = process.env.NO_GUARD ? null : live.createSession();
	let turns = 0, switches = 0, ms = 0, ambig = 0, forced = 0;
	// A repeated (our active, foe active, our HP, foe HP) is the signature of
	// the oscillation: the fight is not advancing, only alternating.
	const seen = new Map();
	let loop = false;

	while (turns < MAX_TURNS) {
		if (real.foe.team.every(m => m.fainted) || real.me.team.every(m => m.fainted)) break;
		const obs = live.observe(real);
		const sig = obs.me.species + '|' + obs.me.hp + '|' + obs.foe.species + '|' + obs.foe.barPx;
		const n = (seen.get(sig) || 0) + 1;
		seen.set(sig, n);
		if (n >= 4) loop = true;

		const t0 = Date.now();
		const advice = live.advise(believed, obs,
			{lookahead: 2, budget: 20000,
				chargeSwitchTempo: process.env.NO_TEMPO ? false : true},
			engine, session);
		ms += Date.now() - t0;
		if (!advice || !advice.best) break;
		if (advice.ambiguous) ambig++;
		if (advice.best.action.type === 'switch') switches++;
		if (advice.forced) forced++;

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

	const finished = real.foe.team.every(m => m.fainted);
	const lostAll = real.me.team.every(m => m.fainted);
	const result = finished ? 'WON' : lostAll ? 'lost' : 'STALLED';
	if (finished) won++; else if (!lostAll) stalled++;
	if (loop) looped++;
	totalTurns += turns; totalMs += ms; totalAmbig += ambig;

	console.log(H.label(battle).slice(0, 34).padEnd(36) +
		String(turns).padStart(5) + '  ' + result.padEnd(10) +
		String(switches).padStart(8) + '  ' + (loop ? 'YES ' : '  . ').padStart(5) +
		String(forced).padStart(7) +
		String(Math.round(ms / Math.max(1, turns))).padStart(8));
}

console.log('');
console.log('won      ' + won + '/' + battles.length);
console.log('STALLED  ' + stalled + '/' + battles.length + '   (ran out of turns without finishing)');
console.log('LOOPED   ' + looped + '/' + battles.length + '   (same position seen 4+ times)');
console.log('mean     ' + Math.round(totalMs / Math.max(1, totalTurns)) + ' ms per decision');
console.log('HP range changed the advice on ' + totalAmbig + ' of ' + totalTurns + ' turns');
