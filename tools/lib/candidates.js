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

/** The field, in the vocabulary a duel entry condition speaks. */
function fieldCond(field) {
	if (!field || !field.terrainTurns) return {};
	return {terrain: field.terrain};
}


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
function achievable(ctx, cond, foe, field) {
	const engine = ctx.engine, party = ctx.party;
	if (!cond.foeStatus) return true;
	const probe = engine.B.createState(party, [foe], {});
	// The FIELD AS IT WILL BE, passed in by the caller, not guessed from the
	// roster. The first version rejected sleep any time their team contained a
	// terrain setter, forever. Terrain expires; by the time their fourth
	// Pokemon is on the field it usually has.
	if (field) {
		probe.field.terrain = field.terrainTurns > 0 ? field.terrain : null;
		probe.field.terrainTurns = field.terrainTurns || 0;
	} else {
		probe.field.terrain = null;
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


/**
 * Who closes out a Pokemon that survives on a sliver and outspeeds us?
 *
 * A priority attacker, if we have one. This is the shape of James's own Pawmot
 * line: sleep it, hit it with the biggest thing available, and when it wakes at
 * 6 HP faster than everything we own, finish it with Mach Punch rather than let
 * it move again. Two-job plans cannot express that -- there has to be somewhere
 * to hand the last hit to -- and the closer is derived from whoever actually
 * carries a priority damaging move.
 */
function closersFor(ctx, exclude) {
	const ME = ctx.engine.sandbox.RR_MOVE_EFFECTS.moves;
	const out = [];
	ctx.party.forEach(p => {
		if ((exclude || []).includes(p.species)) return;
		const has = (p.moves || []).some(m => {
			const d = ME[m];
			return d && d.split !== 'Status' && (d.priority || 0) > 0;
		});
		if (has) out.push(p.species);
	});
	return out;
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
		const line = D.duelLines(engine, party, foeSets, mi, fi, fieldCond(opts.field), {})
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
			if (!achievable(ctx, entry.cond, foe, opts.field)) continue;
			const line = D.duelLines(engine, party, foeSets, mi, fi,
				Object.assign({}, entry.cond, fieldCond(opts.field)), {})
				.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
			if (!line) continue;
			found++;
			const prep = enablerJobs(ctx, fi, entry).filter(j => j.mon !== p.species);
			push(prep.concat([{mon: p.species, moves: line.moves}]),
				E.describeEffect(entry.cond) + ', then ' + p.species
				+ ' kills for ' + pctOf(line.cost),
				entry.effort * 0.15 + line.cost + 3 * line.deathRisk);
			// The same idea with somewhere to hand the last hit to. "*" lets the
			// attacker re-pick its best move each turn, which matters when the
			// obvious move ruins itself -- Leaf Storm drops its own Sp. Atk two
			// stages, so a job that says "Leaf Storm" clicks a dead move forever.
			closersFor(ctx, [p.species].concat(prep.map(j => j.mon))).forEach(closer => {
				push(prep.concat([
					{mon: p.species, moves: ['*'], until: {selfHp: 0.6}},
					{mon: closer, moves: ['*']}
				]), E.describeEffect(entry.cond) + ', then ' + p.species
					+ ' softens it and ' + closer + ' closes',
					entry.effort * 0.15 + line.cost + 3 * line.deathRisk + 0.05);
			});
		}
	});

	// 3. ABSORB PIVOTS. Switch a Pokemon in that is IMMUNE to what they are
	//    throwing, take the free turn, and -- if the ability heals -- come out
	//    of it better off than we went in.
	//
	//    James asked why the planner never cycles Lanturn against an Electric
	//    attacker to regain HP, and the answer was that it could not: every
	//    candidate is "who kills this and what has to happen first", so a line
	//    whose payoff is HP GAINED rather than damage dealt had no shape to be
	//    expressed in. The lever was in the catalog all along -- "Volt Absorb
	//    voids Electric and heals" -- but conditionSpace only builds candidates
	//    from levers that change THEIR state, so anything helping our own side
	//    was silently dropped. Intimidate cycling worked and absorb cycling did
	//    not, for no better reason than which side the effect lands on.
	const absorbers = LEVERS.filter(l => l.via === 'absorb-ability' && l.absorbs);
	absorbers.forEach(l => {
		const theirTypes = new Set((foe.moves || []).map(m => {
			const d = ctx.engine.sandbox.RR_MOVE_EFFECTS.moves[m];
			return d && d.split !== 'Status' ? d.type : null;
		}).filter(Boolean));
		if (!theirTypes.has(l.absorbs)) return;      // nothing here to absorb
		party.forEach((p, mi) => {
			if (p.species === l.mon) return;
			const line = D.duelLines(engine, party, foeSets, mi, fi, fieldCond(opts.field), {})
				.find(x => x.outcome === 'kill');
			if (!line) return;
			push([{mon: l.mon, moves: [], until: {entered: true}},
				{mon: p.species, moves: line.moves}],
				l.mon + ' absorbs ' + l.absorbs + (l.heals ? ' and heals' : '')
				+ ', then ' + p.species + ' kills for ' + pctOf(line.cost),
				line.cost + 3 * line.deathRisk - (l.heals ? 0.25 : 0.1));
		});
	});

	// 4. CHIP CHAINS, any length. The unit of a plan is not one of ours
	//    against one of theirs; on some fights that unit is simply wrong.
	//    James, watching himself win: "there is almost never a killing line.
	//    There is a multiple moves doing chip damage which ends up killing
	//    line." Measured on 200 live plans, 194 were two-leg and 6 solo -- the
	//    families above can only designate ONE Pokemon to duel the foe to
	//    death, so the shape James actually plays was inexpressible.
	//
	//    This is a beam search over contributors: each leg chips what it
	//    safely can and retreats; the accumulated chip persists (their
	//    switching launders boosts, not damage); the chain ends either when
	//    somebody has a genuine killing line against the REMAINING fraction,
	//    or when the accumulated chip is itself lethal. The old two-leg
	//    chipper+finisher family is the depth-1 case and falls out of this.
	//
	//    Generation offers; pricing decides. Chip legs carry the measured
	//    move list and a retreat threshold; pricePath simulates the whole
	//    relay against the real AI, so healing (Parabolic Charge, Roost,
	//    Drain Punch) undoing the chip is caught there, not guessed here.
	// RR_NO_CHIP_CHAINS disables this family for A/B measurement, the same
	// pattern as RR_DISABLE_SWITCH_PORT.
	const RETREATS = process.env.RR_NO_CHIP_CHAINS ? [] : [0.5, 0.35];
	const CHIP_MIN = 0.15;      // a leg must bank at least this to extend
	const MAX_CHIP_LEGS = 3;    // contributors before the finisher
	const BEAM = 6;
	let frontier = [{acc: 0, legs: [], used: {}, est: 0, risk: 0}];
	for (let depth = 0; depth <= MAX_CHIP_LEGS; depth++) {
		const grown = [];
		for (const node of frontier) {
			const entryCond = Object.assign({}, fieldCond(opts.field),
				node.acc > 0 ? {foeChip: node.acc} : {});
			party.forEach((p, mi) => {
				if (node.used[mi]) return;
				// Can this one FINISH the remaining fraction? Only meaningful
				// once at least one chip leg exists: depth-0 kills are family 1.
				if (node.legs.length) {
					const fin = D.duelLines(engine, party, foeSets, mi, fi, entryCond, {})
						.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
					if (fin) {
						push(node.legs.concat([{mon: p.species, moves: fin.moves}]),
							node.legs.map(j => j.mon).join(' + ') + ' chip it to '
							+ pctOf(1 - node.acc) + ', then ' + p.species
							+ ' finishes for ' + pctOf(fin.cost),
							node.est + fin.cost + 3 * (node.risk + fin.deathRisk)
							+ 0.1 * node.legs.length);
					}
				}
				// Or keep chipping. 'left' banks chip too: damage persists
				// through their switching even though stat drops do not.
				if (depth < MAX_CHIP_LEGS) {
					for (const at of RETREATS) {
						const chip = D.duelLines(engine, party, foeSets, mi, fi,
							entryCond, {retreatAt: at})
							.filter(l => l.outcome === 'retreat' || l.outcome === 'left')
							.sort((a, b) => b.chip - a.chip)[0];
						if (!chip || chip.chip < CHIP_MIN) continue;
						const legs = node.legs.concat([
							{mon: p.species, moves: chip.moves, until: {selfHp: at}}]);
						const acc = node.acc + chip.chip;
						if (acc >= 0.99) {
							// The chip alone is lethal; no finisher needed.
							push(legs, legs.map(j => j.mon).join(' + ')
								+ ' chip it to death',
								node.est + chip.cost + 3 * (node.risk + chip.deathRisk)
								+ 0.1 * node.legs.length);
							continue;
						}
						const used = Object.assign({}, node.used);
						used[mi] = true;
						grown.push({acc, legs, used,
							est: node.est + chip.cost,
							risk: node.risk + chip.deathRisk});
					}
				}
			});
		}
		// Keep the few most promising part-built chains: most chip banked for
		// least HP spent. The beam is what keeps generation from going
		// combinatorial; pricing would drown long before correctness did.
		grown.sort((a, b) => (b.acc - 3 * b.est - 3 * b.risk) - (a.acc - 3 * a.est - 3 * a.risk));
		frontier = grown.slice(0, BEAM);
		if (!frontier.length) break;
	}

	out.sort((a, b) => a.score - b.score);
	if (!out.length) {
		out.push({jobs: [], why: 'NO KILL AVAILABLE against ' + foe.species, score: 99});
	}
	return out;
}

module.exports = {candidatesFor, conditionSpace, achievable, safestPivot};
