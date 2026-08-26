/**
 * How well do we predict the AI's REPLACEMENT, scored at the right position?
 * Run: node tools/test_replacements.js
 *
 * WHAT CHANGED, AND WHY THIS FILE WAS RENAMED (2026-08-26). It began as a test
 * of the sixth pass's cached-replacement hypothesis. That question is settled
 * and the answer is no: scored over the recorded events, CACHED (the AI scores
 * the position one decision earlier and remembers it) got 13% against
 * AT-FAINT's 30%. The mechanism is real in the source; it does not explain
 * what we observe, and the seventh pass was right to retract the confidence.
 *
 * Then James found what DOES explain it, by replaying one position from a save
 * state: one-shot Bellibolt and the AI sends Vikavolt; two-shot it with Mega
 * Drain and it sends Pawmot, "because Pawmot can now one shot my Victreebel
 * with Ice Punch". Our engine reproduces the threshold exactly -- Pawmot
 * scores 1 with Victreebel at 90/108 and 44 at 80/108, KO_FOE (+31) switching
 * on.
 *
 * So the replacement is a DETERMINISTIC function of the position at the faint,
 * and the "randomness" this file was built to characterise was OUR OWN
 * MEASUREMENT ERROR. The state was being read at the turn-start action prompt,
 * but both attacks resolve between that prompt and the faint, and it is our HP
 * at the faint that decides whether the incoming Pokemon can kill. Two
 * recordings that looked like the same position with different outcomes were
 * not the same position.
 *
 * Rescoring against the corrected state, which decisions.py --replacements now
 * extracts by reading our HP from the last frame before the nameplate changes:
 *
 *     named outright   30%  ->  39%
 *     in the tie set   35%  ->  54%
 *     chance baseline           25%
 *
 * That is a real improvement and it is still not good. The remaining gap is
 * genuine: 39% against a 25% chance baseline means replacement prediction is
 * the weakest part of the opponent model even after the fix, and the move
 * scoreboard's 75.5% at width 1.09 is the contrast that makes it stark.
 *
 * The fifth time in this project that James's play has corrected something
 * derived from sources or measurements, and the pattern in my errors holds:
 * I compared two hypotheses and never asked whether the state I was feeding
 * both of them was the state the game scores.
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
const alias = s => SPECIES_ALIAS[s] || s;

const rows = fs.readFileSync(
	path.join(__dirname, 'fixtures', 'surge-replacements.jsonl'), 'utf8')
	.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

let top = 0, tie = 0, n = 0, chance = 0;
const misses = [];

rows.forEach(r => {
	const mine = party.findIndex(m => m.species === r.us);
	const dead = foeSets.findIndex(m => m.species === alias(r.out));
	if (mine < 0 || dead < 0) return;
	const st = B.createState(party, foeSets, {});
	st.me.active = mine;
	st.foe.active = dead;
	st.me.team[mine].curHP = r.our_hp;
	st.foe.team[dead].curHP = 0;
	st.foe.team[dead].fainted = true;
	const p = AISW.predict(st, 'foe');
	if (!p || !p.candidates || !p.candidates.length) return;
	const c = p.candidates.filter(y => y.species !== alias(r.out));
	if (!c.length) return;
	n++;
	const best = Math.max.apply(null, c.map(y => y.score));
	const ties = c.filter(y => y.score === best).map(y => unalias(y.species));
	chance += 1 / c.length;
	if (unalias(c[0].species) === r['in']) top++;
	if (ties.indexOf(r['in']) >= 0) tie++;
	else misses.push('    ' + r.us + ' ' + r.our_hp + '/' + r.our_maxhp + ': '
		+ r.out + ' -> ' + r['in'] + ', we said ' + ties.join('/'));
});

console.log('');
console.log('  REPLACEMENT PREDICTION over ' + n + ' recorded events, scored at the FAINT');
console.log('    named outright     ' + top + '/' + n + '  ' + (100 * top / n).toFixed(0) + '%');
console.log('    in the tie set     ' + tie + '/' + n + '  ' + (100 * tie / n).toFixed(0) + '%');
console.log('    chance baseline    ' + chance.toFixed(1) + '/' + n + '  ' + (100 * chance / n).toFixed(0) + '%');
if (misses.length) {
	console.log('\n  misses:');
	misses.slice(0, 12).forEach(m => console.log(m));
}

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}
console.log('');
check('every recorded replacement is scorable', n === rows.length,
	'scored ' + n + ' of ' + rows.length);
// Measured 2026-08-26 after the at-faint correction: 39% / 54%. Fences below
// the measurement, so they fail on regression and not on improvement.
check('outright prediction beats chance by 10 points',
	(top / n) - (chance / n) >= 0.10,
	'outright ' + (100 * top / n).toFixed(0) + '% against chance '
	+ (100 * chance / n).toFixed(0) + '%');
check('the tie set contains the answer at least half the time', tie / n >= 0.50,
	'tie-set membership ' + (100 * tie / n).toFixed(0) + '%');
console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
