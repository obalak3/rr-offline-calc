'use strict';
/**
 * REGRESSION: the turn that lost Skeledirge, 2026-09-19.
 *
 * Giovanni's Infernape was at 50 HP. Granbull was out at 118. Skeledirge was on
 * the bench at 48. The hidden game played four options two turns deep and
 * reported, in its own numbers:
 *
 *     switch Skeledirge then a forced pick   492   and Skeledirge is gone
 *     switch Lanturn                         515   nobody lost
 *     switch Talonflame                      508   nobody lost
 *     switch Greninja-Ash                    478   nobody lost
 *
 * It played Skeledirge, because a rival only displaces the plan by 25 points and
 * Lanturn beat it by 23. A Pokemon was spent for two points of a margin.
 *
 * James: "there is a larger failure here though. Why is our planner rating
 * skeliderge dying a 492, while the other lines with no losses a 508 and 515?"
 * The answer is that a faint costs about 60 while a kill pays 1000, and a dying
 * Pokemon's remaining HP is already charged as damage, so the death adds almost
 * nothing. Repricing that needs sacrifice logic he deliberately deferred, so the
 * rule goes above the arithmetic instead.
 *
 * These are the real numbers off that turn's log. Run: node tools/test_deathlast.js
 */
const {choose} = require('./lib/deathlast.js');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('PASS  ' + name);
	else { failures++; console.log('FAIL  ' + name); if (detail !== undefined) console.log('        ' + detail); }
}

const MARGIN = 25;

// ---- the turn as it actually happened ------------------------------------
const plan = {score: 492, lost: true, name: 'switch Skeledirge'};
const rivals = [
	{score: 515, lost: false, name: 'switch Lanturn'},
	{score: 508, lost: false, name: 'switch Talonflame'},
	{score: 478, lost: false, name: 'switch Greninja-Ash'}
];

const withRule = choose(plan, rivals, MARGIN, true);
check('the turn that lost Skeledirge now takes a line that loses nobody',
	withRule.pick && !withRule.pick.lost, withRule.pick ? withRule.pick.name : 'kept the plan');
check('  and it takes the best of those, Lanturn at 515',
	withRule.pick && withRule.pick.name === 'switch Lanturn', withRule.pick && withRule.pick.name);
check('  and says why without hiding behind the margin',
	/loses nobody/.test(withRule.why), withRule.why);

const without = choose(plan, rivals, MARGIN, false);
check('without the rule it keeps the plan, which is what actually happened',
	without.pick === null, without.pick && without.pick.name);

// ---- the rule must not fire where it should not ---------------------------
const cleanPlan = {score: 500, lost: false};
const betterButCostly = [{score: 900, lost: true, name: 'a kill that spends someone'}];
check('a clean plan is never traded for a higher-scoring line that loses someone',
	choose(cleanPlan, betterButCostly, MARGIN, true).pick === null);

const cleanBetter = [{score: 600, lost: false, name: 'clean and better'}];
check('a clean plan still yields to a clean rival that beats the margin',
	choose(cleanPlan, cleanBetter, MARGIN, true).pick !== null);

const barely = [{score: 510, lost: false, name: 'clean but only +10'}];
check('  but not to one inside the margin',
	choose(cleanPlan, barely, MARGIN, true).pick === null);

// ---- when everything loses someone, the score decides alone ---------------
const allCostly = [{score: 600, lost: true, name: 'worse but scores more'}, {score: 400, lost: true, name: 'worse still'}];
const doomed = choose({score: 492, lost: true}, allCostly, MARGIN, true);
check('when every line loses someone the score decides alone',
	doomed.pick && doomed.pick.name === 'worse but scores more', doomed.pick && doomed.pick.name);

// ---- a losing rival never wins on score alone -----------------------------
const mixed = [{score: 1400, lost: true, name: 'trade for a kill'}, {score: 500, lost: false, name: 'clean'}];
const pick = choose({score: 492, lost: true}, mixed, MARGIN, true);
check('a 1400-point trade does not beat a 500-point clean line',
	pick.pick && pick.pick.name === 'clean', pick.pick && pick.pick.name);

console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
