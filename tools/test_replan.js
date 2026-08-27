/**
 * Does re-planning every turn beat a static plan?
 * Run: node tools/test_replan.js [episodes]
 *
 * The static plan lost 0-1 wins out of 30-40 with all six Pokemon dead, three
 * different ways. This runs the same fight with the same path machinery, asked
 * fresh from whatever position the dice produce.
 */
'use strict';
const H = require('./lib/harness.js');
const R = require('./lib/replan.js');
const engine = H.loadEngine();
const B = engine.B, RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const N = parseInt(process.argv[2], 10) || 20;
const EXPENDABLE = (process.env.EXPENDABLE || 'Lilligant').split(',').filter(Boolean);

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(process.env.FIGHT || 'SURGE'))[0];
const foeSets = H.foeSets(battle);
const ctx = {engine, party, foeSets, expendable: EXPENDABLE};

function foeChoice(st) {
	const sc = RRAI.scoreAll(st, 'foe', FLAGS, {});
	if (!sc.length) return null;
	let best = -Infinity;
	sc.forEach(e => { if (e.score > best) best = e.score; });
	const ties = sc.filter(e => e.score === best);
	return ties[Math.floor(Math.random() * ties.length)].action;
}
function sample(br) {
	let r = Math.random(), a = 0;
	for (const b of br) { a += b.probability === undefined ? 1 / br.length : b.probability; if (r <= a) return b.state; }
	return br[br.length - 1].state;
}
function bestDamage(st) {
	const legal = B.legalActions(st, 'me').filter(a => a.type === 'move');
	let best = null, bv = -1;
	legal.forEach(a => {
		const r = B.damageRolls(st, 'me', a.move);
		const d = r && !r.immune ? r.noCrit[8] * (r.hits || 1) : 0;
		if (d > bv) { bv = d; best = a; }
	});
	return best || B.legalActions(st, 'me')[0];
}

let won = 0, cap = 0, replans = 0, fell = 0;
const deaths = {};
for (let ep = 0; ep < N; ep++) {
	let st = B.createState(party, foeSets, {});
	for (let t = 0; t < 80; t++) {
		if (B.isOver(st)) break;
		if (st.me.team.every(m => m.fainted) || st.foe.team.every(m => m.fainted)) break;
		let mine = null;
		const pick = R.chooseAction(ctx, st);
		if (pick) { mine = pick.action; replans++; } else { mine = bestDamage(st); fell++; }
		const theirs = foeChoice(st);
		if (!mine || !theirs) break;
		let out;
		try { out = B.step(st, mine, theirs, {mode: 'odds', forkBudget: 3}); } catch (e) { break; }
		if (!out || !out.length) break;
		st = sample(out);
	}
	const w = st.foe.team.every(m => m.fainted);
	const d = st.me.team.filter(m => m.fainted).map(m => m.set.species);
	if (w) won++;
	if (w && d.every(x => EXPENDABLE.includes(x))) cap++;
	d.forEach(x => { deaths[x] = (deaths[x] || 0) + 1; });
}
console.log('RE-PLANNING EVERY TURN, ' + N + ' episodes, real dice');
console.log('  won:         ' + won + '/' + N);
console.log('  met the cap: ' + cap + '/' + N + '   (win, losing nobody but ' + EXPENDABLE.join('/') + ')');
console.log('  deaths: ' + (Object.keys(deaths).sort((a, b) => deaths[b] - deaths[a])
	.map(k => k + ' ' + deaths[k]).join(', ') || 'none'));
console.log('  turns decided by a priced path: ' + replans + ', fell back: ' + fell);
