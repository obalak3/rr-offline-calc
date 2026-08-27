/**
 * The Surge baselines, re-run with SWITCHING ALLOWED.
 * Run: node tools/test_baselines.js [episodes]
 *
 * Every baseline measured overnight had switching off, and they fed the
 * conclusion that the simulated fight might be unwinnable by anyone. That was
 * not a fair test: a player who cannot switch is not a player. This runs the
 * same fight with the same machinery, once with moves only and once with
 * switching allowed, so the difference is attributable.
 */
'use strict';
const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const N = parseInt(process.argv[2], 10) || 20;

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(process.env.FIGHT || 'SURGE'))[0];
const foeSets = H.foeSets(battle);

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

/** Best median damage; optionally allowed to switch when staying is fatal. */
function greedy(st, maySwitch) {
	const legal = B.legalActions(st, 'me');
	const moves = legal.filter(a => a.type === 'move');
	let best = null, bv = -1;
	moves.forEach(a => {
		const r = B.damageRolls(st, 'me', a.move);
		const d = r && !r.immune ? r.noCrit[8] * (r.hits || 1) : 0;
		if (d > bv) { bv = d; best = a; }
	});
	if (!maySwitch) return best || legal[0];

	// Switch out when what is coming would kill us and somebody survives it.
	const me = st.me.team[st.me.active];
	const theirs = foeChoice(st);
	if (theirs && theirs.type === 'move') {
		const r = B.damageRolls(st, 'foe', theirs.move);
		const worst = r && !r.immune ? r.noCrit[15] * (r.hits || 1) : 0;
		const willDie = worst >= me.curHP;
		const kills = bv >= st.foe.team[st.foe.active].curHP;
		if (willDie && !kills) {
			let safest = null, least = Infinity;
			legal.filter(a => a.type === 'switch').forEach(a => {
				const probe = B.clone(st);
				probe.me.active = a.index;
				const rr = B.damageRolls(probe, 'foe', theirs.move);
				const hit = rr && !rr.immune ? rr.noCrit[15] * (rr.hits || 1) : 0;
				const cand = probe.me.team[a.index];
				if (hit < cand.curHP && hit < least) { least = hit; safest = a; }
			});
			if (safest) return safest;
		}
	}
	return best || legal[0];
}

function run(maySwitch) {
	let won = 0, dead = 0, kills = 0;
	for (let ep = 0; ep < N; ep++) {
		let st = B.createState(party, foeSets, {});
		for (let t = 0; t < 90; t++) {
			if (st.me.team.every(m => m.fainted) || st.foe.team.every(m => m.fainted)) break;
			const mine = greedy(st, maySwitch), theirs = foeChoice(st);
			if (!mine || !theirs) break;
			let out;
			try { out = B.step(st, mine, theirs, {mode: 'odds', forkBudget: 3}); } catch (e) { break; }
			if (!out || !out.length) break;
			st = sample(out);
		}
		if (st.foe.team.every(m => m.fainted)) won++;
		dead += st.me.team.filter(m => m.fainted).length;
		kills += st.foe.team.filter(m => m.fainted).length;
	}
	return {won, dead: (dead / N).toFixed(1), kills: (kills / N).toFixed(1)};
}

console.log(H.label(battle) + ', ' + N + ' episodes, real dice\n');
[['moves only (what was measured overnight)', false],
 ['switching allowed', true]].forEach(([label, may]) => {
	const r = run(may);
	console.log('  ' + label.padEnd(42) + 'won ' + r.won + '/' + N
		+ '   killed ' + r.kills + '/5   lost ' + r.dead + '/6');
});
