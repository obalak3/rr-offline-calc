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

/**
 * What a path really costs.
 *
 * HP is not the whole bill. Pricing a dead Lilligant as "100% HP spent" made
 * killing her look CHEAPER than a line that spends 155% spread across three
 * Pokemon and loses nobody, so the search kept choosing the death. In a
 * nuzlocke a faint is not a resource spent, it is a Pokemon gone for the rest
 * of the run; the cap permits one, it does not recommend it. DEATH_COST is
 * deliberately far above any HP total a single fight can produce, so a
 * surviving line always beats a fatal one and HP only breaks ties among lines
 * that lose the same number.
 */
const DEATH_COST = 6;

function cost(r) {
	let t = 0;
	for (const k in r.spend) t += Math.max(0, r.spend[k]);
	return t + r.dead.length * DEATH_COST;
}

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

// Candidates are generated per NODE, not once, because what is even possible
// depends on the position: sleep that cannot land through terrain on turn one
// lands fine on turn fourteen, when the terrain has run out. Their prices are
// re-simulated at every node too -- a path that is free at full health and
// lethal at 40% is two different paths.
const candidateCache = {};
function ideasFor(fi, field) {
	const key = fi + '|' + (field && field.terrainTurns > 0 ? field.terrain : '-');
	if (!candidateCache[key]) candidateCache[key] = C.candidatesFor(ctx, fi, {field});
	return candidateCache[key];
}

// The opening field: whatever their lead's ability sets, for as long as its
// item makes it last. Read from a real opening position rather than assumed.
const opening = engine.B.createState(party, foeSets, {});
console.log('  opening field: ' + (opening.field.terrain
	? opening.field.terrain + ' terrain, ' + opening.field.terrainTurns + ' turns'
	: 'none') + '\n');

let beam = [{
	hp: Object.fromEntries(party.map(p => [p.species, 1])),
	dead: [], active: party[0].species, steps: [], spent: 0, risk: 0,
	field: {terrain: opening.field.terrain, terrainTurns: opening.field.terrainTurns,
		weather: opening.field.weather, weatherTurns: opening.field.weatherTurns},
	turn: 1
}];

// FOLLOW THE ORDER THEY ACTUALLY CHOOSE. This used to walk their roster and
// charge each leg against the HP spent by the legs before it -- but the
// opponent picks its replacement by MATCHUP, so the sequence priced was not the
// sequence played. Measured 40/40 on this fight: after the lead faints they
// send Pawmot, where the roster says Vikavolt. The plan therefore budgeted for
// the hardest Pokemon arriving fourth when it arrives second, and the whole
// thing lost 30/30 under real dice while claiming to lose nobody.
//
// Now each branch tracks who is ACTUALLY on the field, and pricePath reports
// who arrives after a kill, so different branches can follow different orders.
beam.forEach(n => { n.activeFoe = 0; n.killed = []; });

for (let round = 0; round < foeSets.length; round++) {
	const next = [];
	beam.forEach(node => {
		if (node.killed.length >= foeSets.length) { next.push(node); return; }
		const fi = node.activeFoe;
		if (fi < 0 || node.killed.includes(fi)) return;
		const foe = foeSets[fi];
		const priced = [];
		for (const cand of ideasFor(fi, node.field)) {
			if (!cand.jobs.length) continue;
			if (cand.jobs.every(j => node.dead.includes(j.mon))) continue;
			const r = pricePath(ctx, fi, cand.jobs, {
				hp: node.hp, dead: node.dead, active: node.active,
				field: node.field, turn: node.turn
			}, {expendable: EXPENDABLE});
			if (!r.kills) continue;
			const illegal = r.dead.filter(n => !EXPENDABLE.includes(n));
			if (illegal.length) continue;
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
				risk: 1 - (1 - node.risk) * (1 - r.deathRisk),
				field: r.field,
				turn: node.turn + r.turns,
				killed: node.killed.concat([fi]),
				// Who they send next, taken from the simulation.
				activeFoe: r.nextFoe
			});
		});
	});
	next.sort((a, b) => (a.spent + 4 * a.risk) - (b.spent + 4 * b.risk));
	const byActive = {}, diverse = [];
	next.forEach(n => {
		const k = n.active + '/' + n.activeFoe;
		if (byActive[k]) return;
		byActive[k] = true;
		diverse.push(n);
	});
	beam = diverse.slice(0, Math.ceil(BEAM / 2))
		.concat(next.filter(n => !diverse.includes(n))).slice(0, BEAM);
	const done = beam.filter(n => n.killed.length >= foeSets.length).length;
	console.log('  round ' + (round + 1) + ': ' + next.length + ' branches, keeping '
		+ beam.length + (beam.length ? '   (next up: ' + beam.map(n =>
			n.activeFoe >= 0 ? foeSets[n.activeFoe].species : 'done')
			.filter((v, i, a) => a.indexOf(v) === i).join('/') : '') + ')');
	if (!beam.length) {
		console.log('\nNO FEASIBLE COMBINATION from the order they actually play.');
		process.exit(1);
	}
	if (done === beam.length) break;
}
beam = beam.filter(n => n.killed.length >= foeSets.length);
if (!beam.length) {
	console.log('\nNO COMBINATION kills their whole team in the order they play it.');
	process.exit(1);
}

console.log('\n' + beam.length + ' complete combinations survive the cap.\n');
beam.slice(0, 3).forEach((node, i) => {
	console.log('=========== COMBINATION #' + (i + 1)
		+ '   total HP spent ' + pct(node.spent)
		+ '   loses somebody it may not ' + pct(node.risk) + ' of the time');
	node.steps.forEach(s => {
		console.log('\n  ' + s.foe + '   (' + s.r.turns + ' turns, '
			+ (s.r.dead.length ? 'LOSES ' + s.r.dead.join(', ') : 'no losses')
			+ ', risk ' + pct(s.r.deathRisk) + ')');
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


