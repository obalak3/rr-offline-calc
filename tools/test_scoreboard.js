/**
 * Pins the opponent-fidelity numbers so a change to the port has to move them.
 * Run: node tools/test_scoreboard.js
 *
 * The fixture is the real thing: 102 AI decisions read off eight recorded Lt.
 * Surge attempts by tools/screen/decisions.py. It is checked in so this test
 * runs without the 8200-frame corpus, and so the numbers below refer to a
 * fixed dataset rather than to whatever happens to be on disk.
 *
 * The bars are set BELOW what is currently measured, deliberately. This is a
 * regression fence, not a target: it should fail when the port gets worse, and
 * it should not need editing every time the port gets better. Raise a bar only
 * when a real improvement has landed and the new floor is meant to hold.
 */
'use strict';

const {execFileSync} = require('child_process');
const path = require('path');

const out = execFileSync('node', [
	path.join(__dirname, 'scoreboard.js'),
	path.join(__dirname, 'fixtures', 'surge-decisions.jsonl'),
], {encoding: 'utf8'});
console.log(out);

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

function grab(label) {
	const m = out.match(new RegExp('\\n\\s+' + label + '\\s+(\\d+)/(\\d+)\\s+([\\d.]+)%\\s+([\\d.]+)'));
	return m ? {hit: +m[1], n: +m[2], pct: +m[3], width: +m[4]} : null;
}

const ties = grab('ties'), margin = grab('margin');
check('the scoreboard reports both predictors', !!ties && !!margin);
if (!ties || !margin) process.exit(1);

check('every decision in the fixture is scorable', ties.n === 102,
	'scored ' + ties.n + ', expected 102 -- a species or move name stopped matching');

// Measured 2026-08-26: 75.5%. Our argmax alone gets three decisions in four.
check('argmax-plus-ties membership >= 70%', ties.pct >= 70,
	'ties membership fell to ' + ties.pct + '%');

// Measured 2026-08-26: 1.09. The tie set must stay essentially a point
// prediction; if it widens, membership is being bought rather than earned.
check('the tie set stays narrow (mean width < 1.5)', ties.width < 1.5,
	'tie width grew to ' + ties.width);

// Measured 2026-08-26: 100.0%, all 102. The margin set has never yet missed,
// which is the single most useful fact this tool has produced: the port's
// argmax can be wrong, but the truth is always within 5 points of it.
check('margin-set membership stays at 100%', margin.pct >= 100,
	'the margin set now MISSES real moves: ' + margin.pct + '%. '
	+ 'That breaks the assumption that our error is bounded by the margin.');

// Measured 2026-08-26: 3.52. This is the price paid for that coverage.
check('the margin set stays under 5x the tie set', margin.width < 5 * ties.width,
	'margin width ' + margin.width + ' against tie width ' + ties.width);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
