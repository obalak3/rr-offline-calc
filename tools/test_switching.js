/**
 * The AI's replacement choice, and the one real-game observation we have.
 * Run: node tools/test_switching.js
 *
 * This exists because the switch-in port is the only part of the opponent model
 * with a CONFIRMED miss against real play, and a miss with no test around it
 * gets quietly forgotten. The position is recorded exactly as it happened:
 * docs/VALIDATION-LOG.md turn 3, Victreebel at 90/108 with Leaf Storm's -2 Sp.
 * Atk already applied, Pincurchin fainting to that Leaf Storm.
 *
 * The observation is n=1 and the routine breaks ties with a coin flip
 * (ai_switching.c:2437), so a single sample can neither confirm nor refute a
 * scoring rule. That is why the expected-failure below is asserted as a KNOWN
 * MISS rather than as a passing test: it pins what the model currently says so
 * a future change to the port has something to move.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, AISW = engine.AISW;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

check('the switch-in port is loaded', !!AISW);
if (!AISW) process.exit(1);

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

function surgePosition() {
	const st = B.createState(party, foeSets, {});
	const vi = party.findIndex(m => m.species === 'Victreebel');
	const pin = foeSets.findIndex(m => m.species === 'Pincurchin');
	st.me.active = vi;
	st.foe.active = pin;
	st.foe.team[pin].curHP = 0;
	st.foe.team[pin].fainted = true;
	st.me.team[vi].curHP = 90;          // as played
	st.me.team[vi].boosts.spa = -2;     // Leaf Storm's own drop
	return st;
}

const r = AISW.predict(surgePosition(), 'foe');
const names = r.candidates.map(c => c.species + ':' + c.score).join('  ');
console.log('        scores: ' + names);

check('  it produces a real ranking rather than a flat score',
	r.candidates.length >= 3 && r.candidates[0].score !== r.candidates[r.candidates.length - 1].score,
	names);
check('  the fainted Pokemon is never a candidate',
	!r.candidates.some(c => c.species === 'Pincurchin'));
check('  probabilities sum to one',
	Math.abs(r.distribution.reduce((a, d) => a + d.p, 0) - 1) < 1e-9);

// The known miss, asserted so it cannot rot silently in either direction.
const predicted = r.distribution[0].species;
const spread = r.candidates[0].score - r.candidates[2].score;
console.log('        predicted "' + predicted + '", the game sent "Bellibolt"');
check('  KNOWN MISS is still exactly as recorded (predicts Vikavolt)',
	predicted === 'Vikavolt',
	'predicted ' + predicted + ' -- if this changed, re-check against the real game ' +
	'rather than assuming it improved');
check('    and the top three are still within a few points, which is why it is close',
	spread <= 4, 'spread ' + spread);

// Sanity: the engine actually uses the port for their side now.
const st = surgePosition();
const idx = B.chooseReplacement(st, 'foe');
check('  rr-battle asks the port for THEIR replacement',
	st.foe.team[idx].species === predicted,
	'engine picked ' + st.foe.team[idx].species + ', port picked ' + predicted);

// And that our own side is untouched by it.
const mine = B.chooseReplacement(surgePosition(), 'me');
check('  our own replacement still uses the Nuzlocke heuristic', mine >= 0);

console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
