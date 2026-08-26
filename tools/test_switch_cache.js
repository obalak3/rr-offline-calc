/**
 * Does the AI's CACHED replacement explain the replacements we observe?
 * Run: node tools/test_switch_cache.js
 *
 * The sixth pass of METHOD.md proposed that CalcMostSuitableMonToSwitchInto is
 * computed once and reused (ai_switching.c:1967, guarded by
 * calculatedAISwitchings), so the AI's replacement can be older than the
 * position it is applied to. The evidence offered was four hand-picked moments
 * against one observation, and the SEVENTH pass retracted the confidence: with
 * four draws against a field that size, one match arises by chance about two
 * times in three. The mechanism survived; the explanation did not.
 *
 * The stated test was "the ~40 replacement events in the recordings, once the
 * foe's species can be read". It can now, so this is that test.
 *
 * TWO HYPOTHESES, FIXED BEFORE LOOKING, because the seventh pass's error was
 * counting only the predictions that matched:
 *
 *   AT-FAINT    the AI scores the position as it stands when the replacement
 *               happens. This is what our engine currently assumes.
 *   CACHED      the AI scores the position one decision EARLIER and remembers
 *               the answer. This is what the source implies and what the sixth
 *               pass proposed.
 *
 * Each is scored two ways: did it name the right Pokemon outright, and did the
 * right Pokemon appear in its top-scoring tie set. The second matters because
 * ai_switching.c:2437 breaks equal scores with a coin flip, so a tie that
 * contains the answer is the best any model can do.
 *
 * This test ASSERTS almost nothing. It reports. A 23-event sample against a
 * routine with a coin flip in it can move the odds between two hypotheses; it
 * cannot settle a scoring rule, and the standing rule in this repo is not to
 * port rules off small samples.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, AISW = engine.AISW;

if (!AISW) { console.log('switch-in port not loaded'); process.exit(1); }

const SPECIES_ALIAS = {'Manectric': 'Manectric-Mega'};
const unalias = s => Object.keys(SPECIES_ALIAS).find(k => SPECIES_ALIAS[k] === s) || s;

const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'surge-decisions.jsonl'), 'utf8')
	.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

function build(row, deadSpecies) {
	const foeSpecies = SPECIES_ALIAS[row.foe] || row.foe;
	const mine = party.findIndex(m => m.species === row.us);
	const theirs = foeSets.findIndex(m => m.species === foeSpecies);
	if (mine < 0 || theirs < 0) return null;
	const st = B.createState(party, foeSets, {});
	st.me.active = mine;
	st.foe.active = theirs;
	st.me.team[mine].curHP = row.our_hp;
	const max = st.foe.team[theirs].maxHP;
	st.foe.team[theirs].curHP = Math.max(1, Math.round(row.foe_bar / 48 * max));
	if (deadSpecies) {
		// The Pokemon being replaced is gone by the time the choice is applied.
		const d = foeSets.findIndex(m => m.species === (SPECIES_ALIAS[deadSpecies] || deadSpecies));
		if (d >= 0) { st.foe.team[d].curHP = 0; st.foe.team[d].fainted = true; }
	}
	return st;
}

const byRun = {};
rows.forEach(r => { (byRun[r.run] = byRun[r.run] || []).push(r); });

const events = [];
Object.keys(byRun).forEach(run => {
	const a = byRun[run];
	for (let i = 1; i < a.length; i++) {
		if (a[i].foe !== a[i - 1].foe) {
			events.push({at: a[i - 1], prev: a[i - 2] || null, out: a[i - 1].foe, in: a[i].foe});
		}
	}
});

function predict(st, deadSpecies) {
	if (!st) return null;
	const r = AISW.predict(st, 'foe');
	if (!r || !r.candidates || !r.candidates.length) return null;
	const cands = r.candidates.filter(c => c.species !== (SPECIES_ALIAS[deadSpecies] || deadSpecies));
	if (!cands.length) return null;
	const best = Math.max.apply(null, cands.map(c => c.score));
	return {
		top: unalias(cands[0].species),
		ties: cands.filter(c => c.score === best).map(c => unalias(c.species)),
	};
}

const score = {
	atFaint: {top: 0, tie: 0, n: 0},
	cached: {top: 0, tie: 0, n: 0},
};
// Without a chance baseline neither percentage means anything. The AI picks
// among the Pokemon still alive, so a coin-flip model scores 1/(alive) per
// event, and that is the bar any scoring rule has to clear to be doing work.
let chance = 0, chanceN = 0;

console.log('');
console.log('  ' + events.length + ' observed foe replacements');
console.log('');
console.log('  out          in            AT-FAINT says      CACHED says');
events.forEach(e => {
	const a = predict(build(e.at, e.out), e.out);
	const c = e.prev ? predict(build(e.prev, null), e.out) : null;
	if (a) {
		score.atFaint.n++;
		if (a.top === e.in) score.atFaint.top++;
		if (a.ties.indexOf(e.in) >= 0) score.atFaint.tie++;
	}
	if (c) {
		score.cached.n++;
		if (c.top === e.in) score.cached.top++;
		if (c.ties.indexOf(e.in) >= 0) score.cached.tie++;
	}
	const alive = predict(build(e.at, e.out), e.out);
	if (alive) {
		const st = build(e.at, e.out);
		const n = st.foe.team.filter(m => m.curHP > 0 && m.species !== (SPECIES_ALIAS[e.out] || e.out)).length;
		if (n > 0) { chance += 1 / n; chanceN++; }
	}
	const mark = x => !x ? '-' : (x.top === e.in ? '* ' : '  ') + x.top;
	console.log('  ' + e.out.padEnd(12) + ' ' + e.in.padEnd(13)
		+ (mark(a) + '').padEnd(19) + mark(c));
});

console.log('');
console.log('  hypothesis   named it outright   right Pokemon in the tie set');
[['AT-FAINT', score.atFaint], ['CACHED', score.cached]].forEach(([name, s]) => {
	if (!s.n) { console.log('  ' + name.padEnd(12) + ' no scorable events'); return; }
	console.log('  ' + name.padEnd(12) + ' '
		+ (s.top + '/' + s.n + ' ' + (100 * s.top / s.n).toFixed(0) + '%').padEnd(19)
		+ s.tie + '/' + s.n + ' ' + (100 * s.tie / s.n).toFixed(0) + '%');
});

if (chanceN) {
	console.log('  ' + 'CHANCE'.padEnd(12) + ' '
		+ (chance.toFixed(1) + '/' + chanceN + ' ' + (100 * chance / chanceN).toFixed(0) + '%').padEnd(19)
		+ '(picking uniformly among the living)');
}

console.log('');
const gap = score.cached.n && score.atFaint.n
	? (score.cached.top / score.cached.n) - (score.atFaint.top / score.atFaint.n) : 0;
if (Math.abs(gap) < 0.15) {
	console.log('  VERDICT: the two hypotheses are not separated by this sample.');
	console.log('  The cache mechanism is real in the source either way; this says');
	console.log('  only that 23 events cannot tell which position the AI scored.');
} else if (gap > 0) {
	console.log('  VERDICT: CACHED fits better by ' + (100 * gap).toFixed(0) + ' points.');
	console.log('  Suggestive, not settled: the routine has a coin flip in it and');
	console.log('  the standing rule here is not to port off a sample this size.');
} else {
	console.log('  VERDICT: AT-FAINT fits better by ' + (100 * -gap).toFixed(0) + ' points,');
	console.log('  which is what our engine already assumes. The sixth pass\'s');
	console.log('  proposal is not supported by the events, and the seventh pass was');
	console.log('  right to retract it.');
}
