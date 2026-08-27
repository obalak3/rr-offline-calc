/**
 * What could we possibly try against this Pokemon?
 *
 * Candidate generation, kept apart from candidate SELECTION on purpose. This
 * file's job is to be generous and general; deciding which ideas are any good
 * is done by simulating them (tools/lib/paths.js), never by the scores here.
 *
 * Everything is derived from the teams handed in. That is the requirement James
 * set after the first version came back with two hardcoded move lists:
 *
 *   "the thing shouldn't be about these things specifically. The model should
 *    look at what tools each team has when it is inputted, and derive a
 *    strategy using those specifically"
 *
 * So the condition space is built by reading our own moves, abilities and items
 * for every state change they can produce, stacking them, and asking which
 * combinations turn a losing duel into a winning one. "-2 Attack on the thing
 * whose four attacks are all physical, then bring in the killer" comes out of
 * that machinery without anybody having named Pawmot, Baby-Doll Eyes, or the
 * idea that lowering Attack is worth trying.
 */
'use strict';
const D = require('./duels.js');
const E = require('./enablers.js');

const pctOf = x => (x * 100).toFixed(0) + '%';


// Every lever OUR side has, read out of our own moves, abilities and items.
// Nothing below this line knows which fight it is looking at. That is the
// requirement James set when the first version came back with two hardcoded
// move lists: "the model should look at what tools each team has when it is
// inputted, and derive a strategy using those specifically."


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
function achievable(ctx, cond, foe) {
	const engine = ctx.engine, party = ctx.party, foeSets = ctx.foeSets;
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
function conditionSpace(LEVERS, maxStack) {
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



/** Turn the levers that produce a condition into jobs that produce it. */
function enablerJobs(ctx, fi, entry) {
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
			// Stacking an entry ability means LEAVING and COMING BACK, so it is
			// an alternation, not a repetition: Gyarados in, partner in,
			// Gyarados in. Emitting the same entry job twice in a row does
			// nothing at all, because the second one is already satisfied the
			// moment the first finishes -- which is exactly the bug James
			// spotted: "what happened to the intimidate plan? Switching between
			// gyarados and lanturn is the strongest path here."
			//
			// The PARTNER is derived, never named. It is whoever on the bench
			// takes the least damage from what this foe is about to throw,
			// which is how Lanturn gets picked opposite an Electric attacker
			// without anybody mentioning Volt Absorb: an ability that voids the
			// type simply scores zero damage taken.
			const partner = safestPivot(ctx, fi, [lever.mon]);
			if (n > 1 && !partner) return;      // no safe pivot, no cycle
			for (let i = 0; i < n; i++) {
				jobs.push({mon: lever.mon, moves: [], until: {entered: true}});
				if (i < n - 1) {
					jobs.push({mon: partner, moves: [], until: {entered: true}});
				}
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


/**
 * Who can we send into this Pokemon most safely?
 *
 * Derived from damage alone, which is what makes it general: a resist scores
 * low, and an ability that voids the type entirely scores zero, so absorb
 * abilities win this comparison without being a special case. Used to pick the
 * partner in a switch cycle and, more broadly, to answer the question James
 * asks whenever he plans a fight -- "how do I bring in X without bringing it
 * into death range."
 */
function safestPivot(ctx, fi, exclude) {
	const engine = ctx.engine, B = engine.B, party = ctx.party, foeSets = ctx.foeSets;
	const rot = (a, k) => a.slice(k).concat(a.slice(0, k));
	let best = null, bestDmg = Infinity;
	party.forEach((p, mi) => {
		if ((exclude || []).includes(p.species)) return;
		const st = B.createState(rot(party, mi), rot(foeSets, fi), {});
		const me = st.me.team[0];
		let worst = 0;
		(foeSets[fi].moves || []).forEach(mv => {
			const r = B.damageRolls(st, 'foe', mv);
			if (!r || r.immune) return;
			const hit = r.noCrit[r.noCrit.length - 1] * (r.hits || 1);
			if (hit > worst) worst = hit;
		});
		const frac = worst / me.maxHP;
		if (frac < bestDmg) { bestDmg = frac; best = p.species; }
	});
	return best;
}

function candidatesFor(ctx, fi, options) {
	const engine = ctx.engine, party = ctx.party, foeSets = ctx.foeSets;
	const opts = options || {};
	const LEVERS = ctx._levers || (ctx._levers = E.leversFor(engine, party));
	const CONDITIONS = ctx._conditions
		|| (ctx._conditions = conditionSpace(LEVERS, opts.maxStack || 3));
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
		// Generously, not greedily. Stopping at the first condition that works
		// means never offering the deeper one, and whether -1 Attack is enough
		// or you want -3 is a question about the PATH's price, which only
		// simulation can answer. Generation offers; pricing decides.
		let found = 0;
		for (const entry of CONDITIONS) {
			if (found >= (opts.perKiller || 4)) break;
			if (!achievable(ctx, entry.cond, foe)) continue;
			const line = D.duelLines(engine, party, foeSets, mi, fi, entry.cond, {})
				.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
			if (!line) continue;
			found++;
			const jobs = enablerJobs(ctx, fi, entry).filter(j => j.mon !== p.species)
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

module.exports = {candidatesFor, conditionSpace, achievable, safestPivot};
