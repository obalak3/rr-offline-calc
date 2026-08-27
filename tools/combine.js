/**
 * Which combination of paths is actually possible?
 *
 * Run: node tools/combine.js [FIGHT]
 *
 * The second half of James's design. tools/show_paths.js finds and prices the
 * ways to kill each of their Pokemon on its own; this asks the question that
 * makes those prices mean something -- can we afford all of them at once?
 *
 *   "we basically compare the damages for each line for different pokemon
 *    kills, and see whether the 20 damage gyarados took while killing x and the
 *    40 damage it took to kill y kills it. This has to take into account switch
 *    in damages too somehow."
 *
 * It is a beam search over their team in order. Each node carries the REAL
 * state -- everyone's HP, who is dead, who is standing on the field -- and each
 * candidate path is re-simulated from that state, so the switch-in damage and
 * the enabler's own losses are priced in the position they actually happen in
 * rather than from a clean slate. A path that is free at full health and lethal
 * at 40% is two different paths, and this is where that shows up.
 *
 * The cap is a hard constraint, not a score: a branch that kills somebody it is
 * not allowed to kill is dropped, never traded off. If nothing survives to the
 * end, the fight is flagged unwinnable under these constraints BEFORE turn one,
 * which is also the honest answer to "should I be bringing this team".
 */
'use strict';
const H = require('./lib/harness.js');
const T = require('./lib/teams.js');
const C = require('./lib/candidates.js');
const {pricePath} = require('./lib/paths.js');
const engine = H.loadEngine();

const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const BEAM = parseInt(process.env.BEAM, 10) || 12;
const PER_NODE = parseInt(process.env.PER_NODE, 10) || 6;
const EXPENDABLE = (process.env.EXPENDABLE || 'Lilligant').split(',').filter(Boolean);

const party = T.variant(H.realTeam(), process.env.TEAM);
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);
const ctx = {engine, party, foeSets};
const pct = x => (x * 100).toFixed(0) + '%';

console.log(H.label(battle));
console.log('us:   ' + party.map(p => p.species).join(', '));
console.log('them: ' + foeSets.map(f => f.species).join(', '));
console.log('cap:  nobody may die except ' + (EXPENDABLE.join(', ') || 'nobody') + '\n');

// Candidates are generated once, from a clean position. Their PRICES are not
// reused: every one is re-simulated at every node, because the price is a
// property of the position and not of the idea.
const candidates = foeSets.map((f, fi) => {
	const c = C.candidatesFor(ctx, fi);
	console.log('  ' + f.species + ': ' + c.length + ' ideas to try');
	return c;
});

let beam = [{
	hp: Object.fromEntries(party.map(p => [p.species, 1])),
	dead: [], active: party[0].species, steps: [], spent: 0, risk: 0
}];

foeSets.forEach((foe, fi) => {
	const next = [];
	beam.forEach(node => {
		const priced = [];
		for (const cand of candidates[fi]) {
			if (!cand.jobs.length) continue;
			// A path whose Pokemon are all dead is not a path from here.
			if (cand.jobs.every(j => node.dead.includes(j.mon))) continue;
			const r = pricePath(ctx, fi, cand.jobs, {
				hp: node.hp, dead: node.dead, active: node.active
			}, {expendable: EXPENDABLE});
			if (!r.kills) continue;
			const illegal = r.dead.filter(n => !EXPENDABLE.includes(n));
			if (illegal.length) continue;          // the cap is a constraint
			priced.push({cand, r});
		}
		priced.sort((a, b) => cost(a.r) - cost(b.r));
		priced.slice(0, PER_NODE).forEach(({cand, r}) => {
			next.push({
				hp: r.endHP,
				dead: node.dead.concat(r.dead),
				active: r.active,
				steps: node.steps.concat([{foe: foe.species, cand, r}]),
				spent: node.spent + cost(r),
				risk: 1 - (1 - node.risk) * (1 - r.deathRisk)
			});
		});
	});
	next.sort((a, b) => (a.spent + 4 * a.risk) - (b.spent + 4 * b.risk));
	beam = next.slice(0, BEAM);
	console.log('  after ' + foe.species + ': ' + next.length
		+ ' surviving combinations, keeping ' + beam.length);
	if (!beam.length) {
		console.log('\nNO FEASIBLE COMBINATION. Nothing that kills ' + foe.species
			+ ' from any reachable position stays inside the cap.');
		process.exit(1);
	}
});

console.log('\n' + beam.length + ' complete combinations survive the cap.\n');
beam.slice(0, 3).forEach((node, i) => {
	console.log('=========== COMBINATION #' + (i + 1)
		+ '   total HP spent ' + pct(node.spent)
		+ '   loses somebody it may not ' + pct(node.risk) + ' of the time');
	node.steps.forEach(s => {
		console.log('\n  ' + s.foe + '   (' + s.r.turns + ' turns, '
			+ (s.r.dead.length ? 'LOSES ' + s.r.dead.join(', ') : 'no losses') + ')');
		console.log('    plan: ' + s.cand.jobs.map(j => j.mon + ' '
			+ ((j.moves || []).join(' > ') || '(switch in)')).join('   then   '));
		s.r.log.forEach(l => console.log('      T' + String(l.turn).padStart(2)
			+ '  ' + l.we.padEnd(32) + l.they.padEnd(22)
			+ l.us + '   them ' + l.them + '%'));
		const bill = Object.keys(s.r.spend).filter(k => Math.abs(s.r.spend[k]) > 0.005)
			.map(k => k + ' ' + pct(s.r.spend[k])).join(', ');
		console.log('    cost: ' + (bill || 'nothing'));
	});
	console.log('\n  ending HP: ' + Object.keys(node.hp)
		.map(k => k + ' ' + pct(node.hp[k])).join(', '));
	console.log('  dead: ' + (node.dead.join(', ') || 'nobody') + '\n');
});

function cost(r) {
	let t = 0;
	for (const k in r.spend) t += Math.max(0, r.spend[k]);
	return t;
}
