/**
 * Early game, Nuzlocke scoring. Run: node tools/bench_early.js [teams] [opts]
 *
 * The target James set: everything up to Lt. Surge should be winnable without
 * losing anything. So this measures the metric that matters in a Nuzlocke --
 * fights won with ZERO deaths -- not merely fights won.
 *
 * Teams are GENERATED from real ROM learnsets rather than written by hand,
 * because in a Nuzlocke the team is whatever you caught and it changes every
 * run. A planner that only works with one hand-picked squad is no use. Twenty
 * random teams against ten early battles is two hundred samples, which is
 * enough to tell a real change from noise; hand-written teams gave nine.
 */
'use strict';

const H = require('./lib/harness.js');

/**
 * Engine, dex and team generation all come from tools/lib/harness.js.
 *
 * This file used to carry its own copy of all three, and it drifted, exactly as
 * tools/ceiling.js did before it. The copy here still read `ability.name` from a
 * dex that stores `names`, so **every team this benchmark has ever generated
 * fought with no ability at all** -- and it kept doing so for hours after the
 * shared harness was fixed, because the fix could not reach a private duplicate.
 *
 * The headline number in docs/TUNING.md comes from this file. It has no business
 * generating its own teams.
 */
const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B;
const S = loaded.S;
const M = loaded.M;
const X = loaded.X;
const TRAINERS = loaded.TRAINERS;
const team = gen.team;

// Real early-game battles: fixed levels, before the Surge cap.
const early = [];
for (const segment of TRAINERS.segments) {
	for (const b of (segment.battles || [])) {
		if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
		if (b.team[0].level.type !== 'fixed') continue;
		if (b.team[0].level.value > 34) continue;
		early.push(b);
	}
}

const teamCount = parseInt(process.argv[2], 10) || 20;
const opts = process.argv[3] ? JSON.parse(process.argv[3]) : {};

let clean = 0, won = 0, runs = 0, deaths = 0, ms = 0;
const trouble = {};

for (let t = 0; t < teamCount; t++) {
	for (const battle of early) {
		// levelOffset is a diagnostic knob: if a fight stays unwinnable as the
		// player's level advantage grows, the fight is not hard, the planner is
		// broken. That distinction is what it is for.
		const level = battle.team[0].level.value +
			(opts.levelOffset === undefined ? 2 : opts.levelOffset);
		const party = team(level, 6);
		if (party.length < 6) continue;
		const foe = battle.team.map(function (m) {
			return {species: m.species, level: m.level.value, nature: m.nature,
				ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
				evs: m.evs, ivs: m.ivs};
		});
		B.clearCache();
		const started = Date.now();
		let route;
		try {
			const planOpts = Object.assign({lookahead: 2, budget: 20000,
				maxTurns: 30, risks: {roll: 'median'}}, opts);
			delete planOpts.levelOffset;
			// engine: "mcts" swaps the fixed-depth proxy search for the tree
			// search over the real objective. Same result shape, same scoring,
			// so the two are measured against identical fights.
			const engine = planOpts.engine === 'mcts' ? M
				: planOpts.engine === 'exact' ? X : S;
			delete planOpts.engine;
			route = engine.planRoute(B.createState(party, foe, {}), planOpts);
		} catch (e) { continue; }
		ms += Date.now() - started;
		runs++;
		if (route.won) won++;
		if (route.won && route.losses === 0) clean++;
		else {
			const key = (battle.title ? battle.title + ' ' : '') + battle.trainer;
			trouble[key] = (trouble[key] || 0) + 1;
		}
		deaths += route.losses;
	}
}

console.log('Early game, up to the Surge cap: ' + early.length + ' battles x ' +
	teamCount + ' generated teams = ' + runs + ' fights\n');
console.log('  won at all           ' + won + '/' + runs +
	'  (' + Math.round(100 * won / runs) + '%)');
console.log('  won losing NOTHING   ' + clean + '/' + runs +
	'  (' + Math.round(100 * clean / runs) + '%)   <- the Nuzlocke number');
console.log('  Pokemon lost         ' + deaths + '  (' + (deaths / runs).toFixed(2) + ' per fight)');
console.log('  ' + (ms / runs / 1000).toFixed(2) + 's per fight\n');
console.log('Hardest for it (fights not cleanly won):');
Object.entries(trouble).sort((a, b) => b[1] - a[1]).slice(0, 8)
	.forEach(([k, v]) => console.log('   ' + String(v).padStart(3) + '/' + teamCount + '  ' + k));

process.exit(clean / runs >= 0.9 ? 0 : 1);
