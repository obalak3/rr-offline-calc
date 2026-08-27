/**
 * Every complete path to killing each of their Pokemon, priced end to end.
 * Run: node tools/show_paths.js [FIGHT]
 *
 * "finding paths and then comparing those paths for each enemy pokemon and
 *  checking which combination is possible" -- this is the first half. Each row
 * is a whole simulated sequence: the switch in and the hit it costs, the
 * enabler's turns, the handover, and the kill. The spend column is per Pokemon,
 * so the rows can be compared and, in the second half, added up.
 */
'use strict';
const H = require('./lib/harness.js');
const T = require('./lib/teams.js');
const C = require('./lib/candidates.js');
const {pricePath} = require('./lib/paths.js');
const engine = H.loadEngine();

const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const party = T.variant(H.realTeam(), process.env.TEAM);
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);
const ctx = {engine, party, foeSets};
const pct = x => (x * 100).toFixed(0) + '%';

console.log(H.label(battle));
console.log('us:   ' + party.map(p => p.species).join(', '));
console.log('them: ' + foeSets.map(f => f.species).join(', '));
console.log('\nEach path is simulated whole, from a full-health team with the'
	+ '\nfirst job\'s Pokemon having to switch in. spend is per Pokemon.\n');

foeSets.forEach((f, fi) => {
	console.log('================= ' + f.species);
	const cands = C.candidatesFor(ctx, fi);
	const priced = cands.map(c => ({c, r: pricePath(ctx, fi, c.jobs, {})}))
		.filter(x => x.r.kills)
		.sort((a, b) => totalSpend(a.r) - totalSpend(b.r));
	if (!priced.length) {
		console.log('  no path kills it. ' + cands.length + ' were tried.\n');
		return;
	}
	priced.slice(0, 6).forEach(({c, r}) => {
		const spent = Object.keys(r.spend).filter(k => Math.abs(r.spend[k]) > 0.005)
			.map(k => k + ' ' + pct(r.spend[k])).join(', ');
		console.log('  ' + r.turns + 't  ' + (r.dead.length
			? 'DIES: ' + r.dead.join(',') : 'no deaths').padEnd(22)
			+ 'risk ' + pct(r.deathRisk).padStart(4) + '   ' + (spent || 'nothing'));
		console.log('      ' + c.jobs.map(j => j.mon + ' '
			+ ((j.moves || []).join('>') || '(switch in)')).join(' then '));
		r.log.forEach(s => console.log('        T' + s.turn + ' '
			+ s.we.padEnd(30) + s.they.padEnd(22) + s.us + '  them ' + s.them + '%'));
	});
	console.log('');
});

function totalSpend(r) {
	let t = 0;
	for (const k in r.spend) t += Math.max(0, r.spend[k]);
	return t + r.dead.length * 2;
}
