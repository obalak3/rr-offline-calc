/**
 * Find a plan that clears James's cap, by building plans and MEASURING them.
 *
 * Run: node tools/plan_search.js [FIGHT] [episodes-per-plan]
 *
 * Steps 2-4 of docs/PLAN-LINE-PLANNER.md in one place. The priced duel table
 * (step 1) says who can kill what and under which condition; this assembles
 * those into whole-fight policy tables (step 2/3) and then settles which ones
 * work by simulating them with real dice against the real AI (step 4).
 *
 * WHY MEASURE RATHER THAN ARITHMETIC. The obvious version of James's idea adds
 * up HP costs and checks them against a budget. That is the right IDEA and the
 * wrong ARITHMETIC: the costs are not additive, because they depend on the
 * entry state -- Intimidate, Sitrus, terrain, whether the foe switched, whether
 * a drain move healed it back. Every one of those is already implemented in the
 * simulator, so the honest way to price a whole plan is to run it. The duel
 * table is used to GENERATE candidates, which is what it is good at, and not to
 * score them, which it is not.
 *
 * The bar is James's, unchanged: win, and lose nobody except Lilligant.
 */
'use strict';
const H = require('./lib/harness.js');
const D = require('./lib/duels.js');
const P = require('./lib/policy.js');
const engine = H.loadEngine();
const B = engine.B, RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};

const which = process.env.FIGHT || process.argv[2] || 'SURGE';
const EPISODES = parseInt(process.argv[3], 10) || 20;
const TRACE = !!process.env.TRACE;
const EXPENDABLE = (process.env.EXPENDABLE || 'Lilligant').split(',');

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(which.toUpperCase()))[0];
const foeSets = H.foeSets(battle);

const E = require('./lib/enablers.js');
const pctOf = x => (x * 100).toFixed(0) + '%';

// Every lever OUR side has, read out of our own moves, abilities and items.
// Nothing below this line knows which fight it is looking at. That is the
// requirement James set when the first version came back with two hardcoded
// move lists: "the model should look at what tools each team has when it is
// inputted, and derive a strategy using those specifically."
const LEVERS = E.leversFor(engine, party);

/**
 * Can this condition actually be produced against THIS Pokemon, in THIS fight?
 *
 * The duel table happily prices "kills it while it sleeps" for anything at all,
 * because it imposes conditions by fiat. That is the right way to ask WOULD
 * this help and the wrong way to ask CAN we do it. The engine already knows
 * every immunity that matters -- typing, ability, terrain, Safeguard -- so it
 * is asked rather than re-derived here, which is also how the fight's own
 * terrain setter gets accounted for instead of being special-cased.
 */
function achievable(cond, foe) {
	if (!cond.foeStatus) return true;
	const probe = engine.B.createState(party, [foe], {});
	const surge = foeSets.find(f => /Surge$/.test(f.ability || ''));
	if (surge) {
		probe.field.terrain = (surge.ability || '').replace(/ Surge$/, '');
		probe.field.terrainTurns = 8;
	}
	return engine.B._internal.canTakeStatus(probe.foe.team[0], cond.foeStatus, probe, null);
}

/**
 * The condition space, ordered by how hard each one is to bring about.
 *
 * Built by combining our OWN levers: each on its own at every stacking depth it
 * supports, then pairs of different ones. This is what makes "-2 Attack, then
 * switch in the killer" expressible without anyone having written down that -2
 * Attack is worth trying against this particular Pokemon -- it falls out of the
 * team having a move that lowers Attack and the duel getting better when it
 * does.
 */
function conditionSpace(maxStack) {
	const changers = LEVERS.filter(l => l.effect
		&& (l.effect.foeBoosts || l.effect.foeStatus || l.effect.foeVolatiles));
	const out = [];
	changers.forEach(l => {
		const depth = l.repeatable ? maxStack : 1;
		for (let n = 1; n <= depth; n++) {
			const set = new Array(n).fill(l);
			out.push({levers: set, cond: E.combine(set),
				effort: n / Math.max(0.05, l.chance)});
		}
	});
	for (let i = 0; i < changers.length; i++) {
		for (let j = i + 1; j < changers.length; j++) {
			const pair = [changers[i], changers[j]];
			out.push({levers: pair, cond: E.combine(pair),
				effort: 1 / Math.max(0.05, changers[i].chance)
					+ 1 / Math.max(0.05, changers[j].chance)});
		}
	}
	out.sort((a, b) => a.effort - b.effort);
	return out;
}

const CONDITIONS = conditionSpace(parseInt(process.env.MAXSTACK, 10) || 3);

/** Turn the levers that produce a condition into jobs that produce it. */
function enablerJobs(entry) {
	const grouped = {};
	entry.levers.forEach(l => {
		const k = l.mon + '|' + (l.move || l.via);
		grouped[k] = grouped[k] || {lever: l, n: 0};
		grouped[k].n++;
	});
	const jobs = [];
	Object.keys(grouped).forEach(k => {
		const lever = grouped[k].lever, n = grouped[k].n;
		if (lever.via === 'entry-ability') {
			// Arrive, fire the ability, hand straight back. Stacking it is just
			// a list of these, which is the shape of the manoeuvre rather than
			// a special case for one ability.
			for (let i = 0; i < n; i++) {
				jobs.push({mon: lever.mon, moves: [], until: {entered: true}});
			}
			return;
		}
		const until = {}, eff = lever.effect || {};
		if (eff.foeStatus) until.foeStatus = eff.foeStatus;
		else if (eff.foeVolatiles) until.foeVolatile = Object.keys(eff.foeVolatiles)[0];
		else if (eff.foeBoosts) {
			const stat = Object.keys(eff.foeBoosts)[0];
			until.foeBoost = {stat: stat, atMost: eff.foeBoosts[stat] * n};
		}
		// A cap on attempts, so a 30% burn does not become "stand here forever".
		until.uses = Math.max(n, Math.ceil(n / Math.max(0.2, lever.chance)) + 1);
		jobs.push({mon: lever.mon, moves: [lever.move], until: until});
	});
	return jobs;
}

function candidatesFor(fi) {
	const foe = foeSets[fi];
	const out = [];
	const seen = {};
	// `score` only decides which candidates are worth SIMULATING. It is never
	// the answer: costs are not additive, because they depend on the entry
	// state, which is the whole reason plans get measured rather than added up.
	const push = (jobs, why, score) => {
		if (!jobs.length) return;
		const key = jobs.map(j => j.mon + ':' + (j.moves || []).join('>')
			+ ':' + JSON.stringify(j.until || null)).join('|');
		if (seen[key]) return;
		seen[key] = true;
		out.push({jobs, why, score: score === undefined ? 9 : score});
	};

	// 1. Who kills it with no help at all.
	const solo = {};
	party.forEach((p, mi) => {
		const line = D.duelLines(engine, party, foeSets, mi, fi, {}, {})
			.find(l => l.outcome === 'kill');
		if (!line) return;
		solo[mi] = true;
		push([{mon: p.species, moves: line.moves}],
			'kills it outright, ' + pctOf(line.cost) + ' and '
			+ pctOf(line.deathRisk) + ' death',
			line.cost + 3 * line.deathRisk);
	});

	// 2. Who kills it once the position is changed, and what change is enough.
	party.forEach((p, mi) => {
		if (solo[mi]) return;
		let found = 0;
		for (const entry of CONDITIONS) {
			if (found >= 2) break;
			if (!achievable(entry.cond, foe)) continue;
			const line = D.duelLines(engine, party, foeSets, mi, fi, entry.cond, {})
				.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
			if (!line) continue;
			found++;
			const jobs = enablerJobs(entry).filter(j => j.mon !== p.species)
				.concat([{mon: p.species, moves: line.moves}]);
			push(jobs, E.describeEffect(entry.cond) + ', then ' + p.species
				+ ' kills for ' + pctOf(line.cost),
				entry.effort * 0.15 + line.cost + 3 * line.deathRisk);
		}
	});

	// 3. CHIP CHAINS. The unit of a plan is not one of ours against one of
	//    theirs; on some fights that unit is simply wrong. Nothing on this team
	//    beats Bellibolt alone, because Parabolic Charge heals it faster than
	//    most of us hit -- but one of us takes it to 1 HP and anybody finishes.
	const RETREATS = [0.5, 0.35];
	party.forEach((p, mi) => {
		for (const at of RETREATS) {
			const chip = D.duelLines(engine, party, foeSets, mi, fi, {}, {retreatAt: at})
				.filter(l => l.outcome === 'retreat')
				.sort((a, b) => b.chip - a.chip)[0];
			if (!chip || chip.chip < 0.2) continue;
			party.forEach((q, qi) => {
				if (qi === mi) return;
				const finish = D.duelLines(engine, party, foeSets, qi, fi,
					{foeChip: chip.chip}, {}).find(l => l.outcome === 'kill');
				if (!finish) return;
				push([{mon: p.species, moves: chip.moves, until: {selfHp: at}},
					{mon: q.species, moves: finish.moves}],
					p.species + ' chips it to ' + pctOf(1 - chip.chip) + ' for '
					+ pctOf(chip.cost) + ', then ' + q.species + ' finishes for '
					+ pctOf(finish.cost),
					chip.cost + finish.cost + 3 * (chip.deathRisk + finish.deathRisk));
			});
		}
	});

	out.sort((a, b) => a.score - b.score);
	if (!out.length) {
		out.push({jobs: [], why: 'NO KILL AVAILABLE against ' + foe.species, score: 99});
	}
	return out;
}

// ---------------------------------------------------------------- simulation

const {playPlan} = require('./lib/playplan.js');
const CTX = {engine, party, foeSets, expendable: EXPENDABLE};
const runPlan = plan => playPlan(CTX, plan, {trace: TRACE});

// -------------------------------------------------------------------- search

console.log(H.label(battle));
console.log('cap: win, and lose nobody except ' + EXPENDABLE.join('/') + '\n');

const perFoe = foeSets.map((f, fi) => {
	const c = candidatesFor(fi);
	console.log(f.species + ': ' + c.length + ' candidate plans');
	if (process.env.CANDIDATES) {
		c.slice(0, parseInt(process.env.CANDIDATES, 10)).forEach(x =>
			console.log('    ' + x.score.toFixed(2).padStart(6) + '  ' + x.why
				+ '\n            ' + x.jobs.map(j => j.mon + ' '
					+ ((j.moves || []).join('>') || '(switch in)')
					+ (j.until ? ' [until ' + Object.keys(j.until)
						.map(k => k + '=' + JSON.stringify(j.until[k])).join(',') + ']' : '')
					).join('  then  ')));
	}
	return c;
});

// Cartesian product, capped so this stays a search and not a night's work.
const LIMIT = parseInt(process.env.LIMIT, 10) || 6;
const trimmed = perFoe.map(c => c.slice(0, LIMIT));
let combos = [[]];
trimmed.forEach(list => {
	const next = [];
	combos.forEach(c => list.forEach(x => next.push(c.concat([x]))));
	combos = next;
});
console.log('\n' + combos.length + ' whole-fight plans to measure, '
	+ EPISODES + ' episodes each\n');

/**
 * Two passes, for the same reason a benchmark has a heat and a final: six
 * episodes cannot separate a 60% plan from a 40% one, and spending forty
 * episodes on all seven thousand costs an hour to learn mostly that bad plans
 * are bad. The coarse pass throws away everything that cannot win at all; the
 * fine pass is the only number anyone should quote.
 */
function measure(plan, episodes) {
	let pass = 0, wins = 0, fallbacks = 0;
	const deaths = {};
	for (let e = 0; e < episodes; e++) {
		const r = runPlan(plan);
		if (r.won) wins++;
		if (r.capOK) pass++;
		fallbacks += r.usedFallback;
		r.dead.forEach(d => { deaths[d] = (deaths[d] || 0) + 1; });
	}
	return {pass, wins, deaths, fallbacks, episodes};
}

const COARSE = parseInt(process.env.COARSE, 10) || 4;
const coarse = [];
combos.forEach((combo, ci) => {
	const plan = {};
	foeSets.forEach((f, i) => { plan[f.species] = combo[i].jobs; });
	const m = measure(plan, COARSE);
	coarse.push({plan, combo, m});
	if ((ci + 1) % 500 === 0) {
		process.stderr.write('  coarse ' + (ci + 1) + '/' + combos.length + '\n');
	}
});
coarse.sort((a, b) => (b.m.pass - a.m.pass) || (b.m.wins - a.m.wins));

const FINALISTS = parseInt(process.env.FINALISTS, 10) || 25;
const finals = coarse.slice(0, FINALISTS).map(c => ({
	plan: c.plan, combo: c.combo, m: measure(c.plan, EPISODES)
}));
finals.sort((a, b) => (b.m.pass - a.m.pass) || (b.m.wins - a.m.wins));

console.log('\nBEST PLANS  (' + EPISODES + ' episodes each, real dice)\n');
finals.slice(0, 5).forEach((r, i) => {
	console.log('#' + (i + 1) + '  cap ' + r.m.pass + '/' + r.m.episodes
		+ '   won ' + r.m.wins + '/' + r.m.episodes);
	console.log(P.describe(r.plan));
	r.combo.forEach((c, k) => console.log('      ' + foeSets[k].species + ': ' + c.why));
	const d = Object.keys(r.m.deaths).sort((a, b) => r.m.deaths[b] - r.m.deaths[a]);
	console.log('    deaths: ' + (d.length
		? d.map(n => n + ' ' + r.m.deaths[n] + '/' + r.m.episodes).join(', ') : 'none'));
	if (r.m.fallbacks) {
		console.log('    the plan had nothing to say on ' + r.m.fallbacks
			+ ' turns and fell back to best-damage');
	}
	console.log('');
});
const best = finals[0];
console.log(best && best.m.pass > EPISODES / 2
	? 'CAP MET by the plan above.'
	: 'CAP NOT MET by any plan searched (best '
		+ (best ? best.m.pass + '/' + best.m.episodes : '0') + ').');
