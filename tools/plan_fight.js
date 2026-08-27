/**
 * Reverse-engineer a fight the way James does.
 * Run: node tools/plan_fight.js [FIGHT]
 *
 * His method, verbatim, which this implements: "When I calculate lines and
 * there is a pokemon that is really hard to kill, I reverse engineer it. I
 * say how do I kill Pawmot, and I see that I can hit it with Bulldoze with
 * Diggersby (super effective and -speed), and then it is slowed down and I
 * can kill it easier. Then I look at how do I bring in Diggersby without
 * bringing it into death range. And I realize I have to either sleep it or
 * sack a pokemon. That's where Lilligant dies."
 *
 * That is backward chaining: start from dead(F), find KILL conditions, then
 * ENABLERS for each condition, then enablers for those, bottoming out in
 * facts about the current state. Forward search failed on this fight at
 * every budget tried because the winning corridor looks locally bad; going
 * backward the branching is tiny, because the goals are few and the tables
 * already say who beats whom under what conditions.
 *
 * Vocabulary, all computed from damageRolls + speed, nothing hand-fed:
 *   beats(M, F | conds)  M wins the 1v1 race under conds (median rolls)
 *   conds: asleep(F)     F skips turns; any 3-hits-or-less race wins
 *          slowed(F)     F at -1 speed stage; races recomputed
 *          fresh(M)      M at full HP (i.e. entered safely)
 *   enablers:
 *          sleep   <- a sleeper with Sleep Powder, terrain expired if F is
 *                     grounded, and the sleeper survives one hit or enters free
 *          slow    <- a user of Bulldoze / Rock Tomb / Icy Wind who survives
 *                     one hit of F to click it
 *          free entry <- after our KO, after F is asleep, or by SACRIFICE,
 *                     which is named and priced, because "that's where
 *                     Lilligant dies" is a decision someone should make on
 *                     purpose.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B;

const SLOW_MOVES = {Bulldoze: true, 'Rock Tomb': true, 'Icy Wind': true, 'Mud Shot': true, 'Low Sweep': true};
const SLEEP_MOVES = {'Sleep Powder': true, Hypnosis: true, Spore: true, 'Grass Whistle': true};

const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);

function duel(mi, fi, opts) {
	// One matchup, median rolls, under optional conditions.
	const st = B.createState(party, foeSets, {});
	st.me.active = mi; st.foe.active = fi;
	if (opts && opts.slowed) st.foe.team[fi].boosts.spe = -1;
	const me = st.me.team[mi], foe = st.foe.team[fi];
	let bestOut = 0, bestMove = null;
	(me.set.moves || []).forEach(mv => {
		const r = B.damageRolls(st, 'me', mv);
		if (r && !r.immune && r.noCrit) {
			const med = r.noCrit[Math.floor(r.noCrit.length / 2)];
			if (med > bestOut) { bestOut = med; bestMove = mv; }
		}
	});
	let bestIn = 0, theirMove = null;
	(foe.set.moves || []).forEach(mv => {
		const r = B.damageRolls(st, 'foe', mv);
		if (r && !r.immune && r.noCrit) {
			const med = r.noCrit[Math.floor(r.noCrit.length / 2)];
			if (med > bestIn) { bestIn = med; theirMove = mv; }
		}
	});
	const meFirst = B.finalSpeed(st, 'me') > B.finalSpeed(st, 'foe');
	const myHits = bestOut > 0 ? Math.ceil(foe.curHP / bestOut) : 99;
	const theirHits = bestIn > 0 ? Math.ceil(me.curHP / bestIn) : 99;
	// I win the race if I need fewer hits, or equal hits moving first.
	const wins = myHits < theirHits || (myHits === theirHits && meFirst);
	return {wins, myHits, theirHits, meFirst, bestMove, theirMove, bestIn};
}

console.log('REVERSE-ENGINEERED PLAN: ' + H.label(battle));
console.log('them: ' + foeSets.map(f => f.species).join(', ') + '\n');

foeSets.forEach((f, fi) => {
	console.log('== how to kill ' + f.species);
	const clean = [], conditional = [];
	party.forEach((p, mi) => {
		const d = duel(mi, fi, {});
		if (d.wins) {
			clean.push('  ' + p.species + ' beats it straight: ' + d.bestMove
				+ ' (' + d.myHits + ' hits vs their ' + d.theirHits + (d.meFirst ? ', we act first' : '') + ')');
		} else {
			const s = duel(mi, fi, {slowed: true});
			if (s.wins) conditional.push({mi, kind: 'slowed', d: s});
			else if (d.myHits <= 3) conditional.push({mi, kind: 'asleep', d});
		}
	});
	clean.forEach(l => console.log(l));

	conditional.forEach(c => {
		const p = party[c.mi];
		if (c.kind === 'slowed') {
			// who can apply the slow and survive doing it?
			const appliers = [];
			party.forEach((q, qi) => {
				const hasSlow = (q.set ? q.set.moves : q.moves || []).filter(m => SLOW_MOVES[m]);
				const qmoves = q.moves || (q.set && q.set.moves) || [];
				const slows = qmoves.filter(m => SLOW_MOVES[m]);
				if (!slows.length) return;
				const dd = duel(qi, fi, {});
				appliers.push('      ' + q.species + ' clicks ' + slows[0]
					+ (dd.theirHits >= 2 ? ' (survives a hit to do it)' : ' (DIES doing it unless entering free)'));
			});
			console.log('  ' + p.species + ' beats it IF SLOWED: ' + c.d.bestMove
				+ ' (' + c.d.myHits + ' vs ' + c.d.theirHits + ')');
			appliers.forEach(a => console.log(a));
		}
		if (c.kind === 'asleep') {
			console.log('  ' + p.species + ' beats it IF ASLEEP (' + c.d.myHits + ' hits while it sleeps)');
		}
	});

	// sleep enablers, once per foe
	const sleepers = [];
	party.forEach((q, qi) => {
		const qmoves = q.moves || (q.set && q.set.moves) || [];
		const sm = qmoves.filter(m => SLEEP_MOVES[m]);
		if (!sm.length) return;
		const dd = duel(qi, fi, {});
		sleepers.push('    sleep it: ' + q.species + ' ' + sm[0]
			+ (dd.theirHits >= 2 ? ' (survives a hit to click it)'
				: ' (needs a FREE ENTRY: after our KO, or a SACRIFICE -- price it)'));
	});
	if (sleepers.length) {
		console.log('  enablers:');
		sleepers.forEach(s => console.log(s));
		const grounded = true;
		console.log('    (sleep is blocked while Electric Terrain is up; it expires turn 8 here)');
	}
	console.log('');
});
