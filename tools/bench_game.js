/**
 * How does the planner do on the fights that come LATER?
 * Run: node tools/bench_game.js [teams] [opts-json]
 *
 * WHY. Every quality number in this repo comes from nine battles up to the Lt.
 * Surge cap, because those were the fights with fixed levels and a benchmark
 * around them. The run does not stop at Surge. There are 36 fixed-level singles
 * battles in the dataset and the benchmark has only ever used nine of them; the
 * other 27 include the entire Indigo League at level 85 with six a side, which
 * had never been measured once.
 *
 * That matters beyond curiosity. A level 85 six-on-six is not a bigger version
 * of a level 20 gym: the fights are longer, so they press against the turn
 * horizon; the teams are fully evolved, so nothing is outclassed and every
 * matchup is close; and the movesets are complete, so the abilities and effects
 * the early game never exercises all appear at once. Any one of those could be
 * where the engine stops working, and until this ran, none of them had been
 * tried.
 *
 * Teams are generated at the trainer's level, as in tools/bench_early.js, so
 * this measures the SEARCH rather than a particular squad.
 */
'use strict';

const H = require('./lib/harness.js');

const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B, X = loaded.X;

const teamCount = parseInt(process.argv[2], 10) || 3;
const opts = JSON.parse(process.argv[3] || '{}');
const levelOffset = opts.levelOffset === undefined ? 2 : opts.levelOffset;
delete opts.levelOffset;

const planOpts = Object.assign({
	lookahead: 2, budget: 20000, exactBudget: 200000,
	timeLimitMs: 20000, maxTurns: 24, risks: {roll: 'median'}
}, opts);

const battles = H.earlyBattles(loaded, {maxLevel: 100});
const bySegment = new Map();

console.log('The whole game, not just the early gyms: ' + battles.length +
	' fixed-level singles battles x ' + teamCount + ' teams');
console.log('budget ' + planOpts.exactBudget + ' nodes, ' +
	(planOpts.timeLimitMs / 1000) + 's per fight, +' + levelOffset + ' levels\n');

let clean = 0, won = 0, runs = 0, deaths = 0, ms = 0, undecided = 0;

for (let t = 0; t < teamCount; t++) {
	for (const battle of battles) {
		const level = battle.team[0].level.value + levelOffset;
		const party = gen.team(level, 6);
		if (party.length < 6) continue;

		B.clearCache();
		const started = Date.now();
		let route;
		try {
			route = X.planRoute(B.createState(party, H.foeSets(battle), {}), planOpts);
		} catch (e) {
			console.log('  ERROR ' + H.label(battle) + ': ' + e.message);
			continue;
		}
		const took = Date.now() - started;
		ms += took;
		runs++;

		const seg = battle.__segment || 'unknown';
		const row = bySegment.get(seg) ||
			{n: 0, clean: 0, won: 0, deaths: 0, ms: 0, undecided: 0, level: 0};
		row.n++;
		row.ms += took;
		row.level = battle.team[0].level.value;
		if (route.won) { won++; row.won++; }
		if (route.won && route.losses === 0) { clean++; row.clean++; }
		deaths += route.losses;
		row.deaths += route.losses;
		if (route.exactness === 'undecided') { undecided++; row.undecided++; }
		bySegment.set(seg, row);
	}
}

console.log('  won at all           ' + won + '/' + runs +
	'  (' + Math.round(100 * won / runs) + '%)');
console.log('  won losing NOTHING   ' + clean + '/' + runs +
	'  (' + Math.round(100 * clean / runs) + '%)   <- the Nuzlocke number');
console.log('  Pokemon lost         ' + deaths + '  (' + (deaths / runs).toFixed(2) + ' per fight)');
console.log('  search undecided     ' + undecided + '/' + runs +
	'  (budget ran out, so nothing was proved either way)');
console.log('  ' + (ms / runs / 1000).toFixed(2) + 's per fight\n');

console.log('By segment, roughly in the order you play them:');
console.log('  segment            lvl   clean      won   undecided   s/fight');
for (const [seg, row] of bySegment) {
	console.log('  ' + seg.slice(0, 17).padEnd(18) +
		String(row.level).padStart(4) + '   ' +
		(row.clean + '/' + row.n).padStart(6) + '   ' +
		(row.won + '/' + row.n).padStart(6) + '   ' +
		String(row.undecided).padStart(6) + '      ' +
		(row.ms / row.n / 1000).toFixed(1));
}
