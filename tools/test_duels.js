/**
 * Step-1 test from docs/PLAN-LINE-PLANNER.md: are duel prices believable?
 *
 * The two hand-checks it names, both about Pawmot, because Pawmot is the
 * Pokemon that actually beats this team:
 *   Victreebel vs Pawmot  -> a fast, cheap kill
 *   Diggersby  vs Pawmot  -> should NOT be a clean kill straight, should
 *                            become one once Pawmot is slowed, and should
 *                            cost real HP either way
 * Run: node tools/test_duels.js [FIGHT]
 */
'use strict';
const H = require('./lib/harness.js');
const D = require('./lib/duels.js');
const engine = H.loadEngine();

const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);

const pct = x => (x * 100).toFixed(0) + '%';
function show(line) {
	const tag = line.outcome === 'kill' ? 'KILL' : line.outcome.toUpperCase();
	console.log('   ' + tag.padEnd(6) + line.moves.join(' > ').padEnd(30)
		+ ' cost ' + pct(line.cost).padStart(5)
		+ '  left ' + pct(line.hpLeft).padStart(5)
		+ '  chip ' + pct(line.chip).padStart(5)
		+ '  ' + line.turns + 't'
		+ '  DEATH ' + pct(line.deathRisk).padStart(5)
		+ (line.killOdds < 0.999 ? '  kill-odds ' + pct(line.killOdds) : ''));
}

console.log(H.label(battle));
console.log('us:   ' + party.map(p => p.species).join(', '));
console.log('them: ' + foeSets.map(f => f.species).join(', ') + '\n');

const mine = name => party.findIndex(p => p.species === name);
const theirs = name => foeSets.findIndex(f => f.species === name);

[['Victreebel', 'Pawmot', {}],
 ['Diggersby', 'Pawmot', {}],
 ['Diggersby', 'Pawmot', {slowed: true}],
 ['Diggersby', 'Pawmot', {asleep: 3}]].forEach(([m, f, entry]) => {
	const mi = mine(m), fi = theirs(f);
	if (mi < 0 || fi < 0) { console.log(m + ' vs ' + f + ': not on these teams\n'); return; }
	const label = m + ' vs ' + f
		+ (Object.keys(entry).length ? '  [' + Object.keys(entry).join(', ') + ']' : '');
	console.log(label);
	const lines = D.duelLines(engine, party, foeSets, mi, fi, entry, {});
	lines.slice(0, 4).forEach(show);
	const best = lines[0];
	if (best.log.length) {
		console.log('   line: ' + best.log.map(s =>
			'T' + s.turn + ' ' + s.we + ' / ' + s.they + ' (' + s.ourHP + ' vs ' + s.theirHP + ')').join('  |  '));
	}
	console.log('');
});
