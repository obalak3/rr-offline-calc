/**
 * JAMES'S CAP, verbatim, as the acceptance bar for Lt. Surge:
 *
 *   "Lilligant can die. No other pokemon on our side will die. I have beaten
 *    this boss like 3-4 times with one pokemon dying, and easily. Don't even
 *    try to say anything he does makes sense until we get to that point."
 *
 * Run: node tools/test_surge_cap.js [episodes]
 *
 * This test EXPECTS to fail today. It exists so the bar is executable rather
 * than remembered: an episode passes only if we WIN and every faint on our
 * side is Lilligant. Current state (2026-08-26): 0% pass; the advisor plays
 * turns honestly (prediction consumed, dice not gambled) and still loses
 * 6/6 to Pawmot, because nothing in a per-turn ranking can express roles --
 * Victreebel reserved for Pawmot, Lilligant's job being to sleep it. That
 * assignment layer is the build this test is waiting for.
 */
'use strict';
const H = require('./lib/harness.js');
const live = require('./lib/live.js');
const engine = H.loadEngine();
const B = engine.B, RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const N = parseInt(process.argv[2], 10) || 12;
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);
const CAP_COSTS = {Lilligant: 0.05, Mienshao: 1, Diggersby: 1, Lanturn: 1, Breloom: 1, Victreebel: 1};

function foeArgmax(st) {
	const sc = RRAI.scoreAll(st, 'foe', FLAGS, {});
	let bs = -Infinity; sc.forEach(x => { if (x.score > bs) bs = x.score; });
	const t = sc.filter(x => x.score === bs);
	return t[Math.floor(Math.random() * t.length)].action;
}
function sample(states) {
	let r = Math.random(), a = 0;
	for (const s of states) { a += (s.probability !== undefined ? s.probability : 1 / states.length); if (r <= a) return s.state; }
	return states[states.length - 1].state;
}
let pass = 0, wins = 0;
for (let ep = 0; ep < N; ep++) {
	let real = B.createState(party, foeSets, {});
	const session = live.createSession();
	for (let t = 0; t < 70; t++) {
		if (real.foe.team.every(m => m.fainted) || real.me.team.every(m => m.fainted)) break;
		let adv; try { adv = live.advise(B.clone(real), live.observe(real),
			{lookahead: 2, budget: 20000, chargeSwitchTempo: true,
				assumePrediction: true, costs: CAP_COSTS}, engine, session); } catch (e) { break; }
		if (!adv || !adv.best) break;
		const a = adv.best.action;
		const mine = B.legalActions(real, 'me').find(x => a.type === 'switch'
			? (x.type === 'switch' && x.index === a.index) : (x.type === 'move' && x.move === a.move));
		const theirs = foeArgmax(real);
		if (!mine || !theirs) break;
		let out; try { out = B.step(real, mine, theirs, {mode: 'odds'}); } catch (e) { break; }
		if (!out || !out.length) break;
		real = sample(out);
	}
	const won = real.foe.team.every(m => m.fainted);
	const deadNames = real.me.team.filter(m => m.fainted).map(m => m.set.species);
	const capOK = won && deadNames.every(n => n === 'Lilligant');
	if (won) wins++;
	if (capOK) pass++;
}
console.log('SURGE CAP: ' + pass + '/' + N + ' episodes won losing at most Lilligant'
	+ '   (won at all: ' + wins + '/' + N + ')');
console.log(pass > N / 2 ? 'CAP MET' : 'CAP NOT MET -- nothing the advisor does on this fight is to be called sensible');
process.exit(pass > N / 2 ? 0 : 1);
