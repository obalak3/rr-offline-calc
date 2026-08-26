/**
 * The true distribution instead of the margin set, plus a robustness check.
 * Run: node tools/test_true_distribution.js
 *
 * Step 4 of the twentieth-pass ordering, revised by what the scoreboard
 * measured. The plan said DELETE the margin set. The measurement says our
 * argmax is right 75.5% of the time and the margin catches 100% of the rest,
 * so deleting it outright would throw away real coverage of our own error.
 * Instead the branching uses the true distribution -- argmax plus exact ties,
 * which is what CFRU does -- and the margin is spent ONCE, re-ranking the
 * chosen action, which is where that coverage is actually worth paying for.
 *
 * IT IS OFF BY DEFAULT AND MUST STAY OFF. Measured on nine level-appropriate
 * fights: the margin set wins 9/9 losing 4 Pokemon, the true distribution wins
 * 8/9 losing 6, and the fight it drops is Lt. Surge -- the only close one. The
 * scoreboard explains it exactly: our argmax is right 75.5% of the time and the
 * margin catches 100%, so branching only on the argmax means a quarter of the
 * time the advisor prepares for a move the AI will not make. The width was
 * buying coverage of a real error, not paying for nothing.
 *
 * Kept, not reverted, because it is the right shape once the argmax is good
 * enough -- and because the measurement is the point. Turning it on is now a
 * decision with a known price rather than a guess.
 *
 * Three things are checked:
 *
 *   THE SAVING IS REAL. The whole justification is that branching on the
 *   margin costs about 2x per ply, so if the widths came out equal there
 *   would be nothing to gain and the added complexity would be waste.
 *
 *   THE DEFAULT DOES NOT MOVE. trueDistribution is opt-in. The null test
 *   showed this project cannot detect small behavioural changes at its sample
 *   sizes, so a change that silently altered default advice would be very hard
 *   to catch later.
 *
 *   THE CHECK ACTUALLY RUNS and reports stability rather than silently
 *   overriding. A recommendation that survives the AI's second-best being its
 *   best deserves more confidence than one that does not, and reporting that
 *   is the point.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, AI = engine.AI, P = engine.sandbox.RRPlan;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

function position(mi, fi, frac) {
	const st = B.createState(party, foeSets, {});
	st.me.active = mi;
	st.foe.active = fi;
	st.me.team[mi].curHP = Math.max(1, Math.round(st.me.team[mi].maxHP * frac));
	return st;
}

let tw = 0, mw = 0, n = 0;
[1.0, 0.7, 0.45, 0.25, 0.1].forEach(f => {
	party.forEach((pm, mi) => foeSets.forEach((fs, fi) => {
		const st = position(mi, fi, f);
		tw += AI.trueTies(st, 'foe', {}).actions.length;
		mw += AI.plausible(st, 'foe', {}).actions.length;
		n++;
	}));
});
const ratio = mw / tw;
console.log('  over ' + n + ' positions: true ties ' + (tw / n).toFixed(2)
	+ ', margin ' + (mw / n).toFixed(2) + ', saving ' + ratio.toFixed(2) + 'x per ply');
check('the true distribution is materially narrower', ratio >= 1.5,
	'saving was only ' + ratio.toFixed(2) + 'x, so this buys nothing');

const st = position(party.findIndex(m => m.species === 'Lanturn'),
	foeSets.findIndex(m => m.species === 'Pincurchin'), 1.0);
const plain = P.advise(st, {});
const trued = P.advise(st, {trueDistribution: true});

check('default advice is unchanged', plain.best.label === trued.best.label,
	'default gave ' + plain.best.label + ', trueDistribution gave ' + trued.best.label);
check('the robustness check runs only when asked',
	plain.robust === null && trued.robust !== null,
	'default robust=' + JSON.stringify(plain.robust));
if (trued.robust) {
	console.log('  robustness: ' + (trued.robust.stable ? 'STABLE' : 'CHANGES')
		+ ' under the wider model (' + trued.robust.foeActionCount
		+ ' foe actions vs ' + trued.foeActionCount + ')');
	check('the check compares against a genuinely wider model',
		trued.robust.foeActionCount >= trued.foeActionCount,
		'wide=' + trued.robust.foeActionCount + ' narrow=' + trued.foeActionCount);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
