/**
 * Per-Pokemon costs: does marking one spendable change which one is spent?
 * Run: node tools/test_costs.js
 *
 * This is the narrowest test that covers the change, and it has to construct a
 * specific regime to mean anything. In an ordinary position the best action
 * loses nobody, so the survival criterion is 1 whatever the costs are and the
 * feature is invisible. Costs can only express something when EVERY option
 * loses someone -- so the whole party is put near death and the advisor is
 * forced to choose a casualty.
 *
 * Two properties are checked, and the first matters more than the second:
 *
 *   DEFAULT UNCHANGED. With no costs supplied every Pokemon costs 1 and the
 *   survival criterion reduces to exactly the boolean it replaced. The null
 *   test showed this project cannot detect small behavioural changes at the
 *   sample sizes it has, so a change that silently moved the default would be
 *   very hard to catch later.
 *
 *   THE COST IS OBEYED. Marking a Pokemon spendable should make the advisor
 *   spend THAT one. Checked for four different Pokemon, so a single lucky
 *   coincidence cannot pass it.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, P = engine.sandbox.RRPlan;

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

function adviseDesperate(costs) {
	const st = B.createState(party, foeSets, {});
	st.me.active = party.findIndex(m => m.species === 'Victreebel');
	st.foe.active = foeSets.findIndex(m => m.species === 'Pawmot');
	st.me.team.forEach(m => { m.curHP = Math.max(1, Math.round(m.maxHP * 0.06)); });
	return P.advise(st, costs ? {costs: costs} : {});
}

const base = adviseDesperate(null);
console.log('  desperate position, no costs: ' + base.best.label
	+ '  key[0]=' + base.best.key[0]);
check('with no costs the survival criterion is still boolean',
	base.best.key[0] === 0 || base.best.key[0] === 1,
	'key[0] was ' + base.best.key[0] + ', so the default behaviour moved');

const SPENDABLE = ['Breloom', 'Lanturn', 'Diggersby', 'Mienshao'];
let obeyed = 0;
SPENDABLE.forEach(species => {
	const costs = {}; costs[species] = 0.02;
	const r = adviseDesperate(costs);
	const picked = String(r.best.label).indexOf(species) >= 0;
	if (picked) obeyed++;
	console.log('  ' + (species + ' spendable').padEnd(24) + r.best.label);
});
check('marking a Pokemon spendable makes the advisor spend it',
	obeyed === SPENDABLE.length,
	obeyed + '/' + SPENDABLE.length + ' obeyed');

// A protected Pokemon must never be the one chosen when an alternative exists.
const protectAll = {};
party.forEach(m => { protectAll[m.species] = 1; });
const prot = adviseDesperate(protectAll);
check('costs of 1 everywhere reproduce the default exactly',
	prot.best.label === base.best.label,
	'default gave ' + base.best.label + ', all-costs-1 gave ' + prot.best.label);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
