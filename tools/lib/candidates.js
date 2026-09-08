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

/**
 * The field AND the damage already on the target, in the vocabulary a duel
 * entry condition speaks.
 *
 * THE FOE'S CURRENT HP BELONGS IN HERE. Generation used to run every duel from
 * a fresh full-health state, and whether a duel is a KILL depends entirely on
 * how much HP is left -- so the whole family "somebody just kills it now" was
 * invisible whenever the target was damaged. Watched live: Mienshao's Drain
 * Punch took Pawmot to 41 of 99, one more click would have finished it, and no
 * candidate said so. The planner switched Diggersby in instead and lost it in
 * one hit while Pawmot drained back to 97.
 */
function fieldCond(field, foeHp) {
	const out = {};
	if (field && field.terrainTurns) out.terrain = field.terrain;
	if (foeHp !== undefined && foeHp < 0.999) out.foeChip = 1 - foeHp;
	return out;
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
			const hit = r.noCrit[r.noCrit.length - 1];   // already the whole multi-hit lump
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
	// THE DUELLIST'S REAL CONDITION. Generation measured every duel with our
	// whole party at FULL HP, so whether a line EXISTS was decided in a
	// fiction: a Lanturn at 3 HP still offered to chip, a Mienshao at 70
	// offered duels only its 98 HP self survives, and market membership
	// flickered between turns as nothing but the fiction's rounding moved.
	// Pricing was made honest long ago; existence was not. opts.ourHp and
	// opts.ourStatus carry the live position; a fainted or empty mon simply
	// generates nothing.
	// ONE SIMULATION PER QUESTION. Every family asks for the same (ours,
	// theirs, condition) duels; each re-ran them, and a gym turn took 45 s.
	const duelMemo = new Map();
	const duelLinesM = (mi, fiX, cond, o) => {
		const k = mi + '|' + fiX + '|' + JSON.stringify(cond || {}) + '|' + JSON.stringify(o || {});
		if (!duelMemo.has(k)) duelMemo.set(k, D.duelLines(engine, party, foeSets, mi, fiX, cond, o));
		return duelMemo.get(k);
	};
	// CAN EACH LEVER MOVE TOUCH THIS POKEMON? Run 2 on s5 (2026-09-05) threw
	// Bulldoze into Vikavolt twice for "their spe -1": Vikavolt has Levitate,
	// so the move does nothing and the Speed drop never comes, and the plan
	// built on it lost Diggersby. `achievable` asks the engine about status
	// immunity only; this asks it about the lever move itself, which is how
	// Levitate, Volt Absorb, Ground-vs-Flying and the rest all fall out of one
	// question instead of a list. Entry abilities (Intimidate) have no move.
	const leverUsableM = {};
	const leversUsable = (entry) => (entry.levers || []).every(l => {
		if (!l.move) return true;
		const k = l.mon + '|' + l.move;
		if (leverUsableM[k] !== undefined) return leverUsableM[k];
		const mi = party.findIndex(q => q.species === l.mon);
		let ok = true;
		if (mi >= 0) {
			try {
				const probe = engine.B.createState(party.slice(mi).concat(party.slice(0, mi)),
					foeSets.slice(fi).concat(foeSets.slice(0, fi)), {});
				const r = engine.B.damageRolls(probe, 'me', l.move);
				if (r && r.immune) ok = false;
			} catch (e) { ok = true; }
		}
		leverUsableM[k] = ok;
		return ok;
	});
	const duelCond = (mi, extra) => {
		const sp = party[mi].species;
		const c = Object.assign({}, fieldCond(opts.field, opts.foeHp), extra || {});
		if (opts.ourHp && opts.ourHp[sp] !== undefined) {
			if (opts.ourHp[sp] <= 0) return null;
			c.hpFrac = opts.ourHp[sp];
		}
		if (opts.ourStatus && opts.ourStatus[sp]) c.ourStatus = opts.ourStatus[sp];
		return c;
	};
	// `score` only decides which candidates are worth SIMULATING. It is never
	// the answer: costs are not additive, because they depend on the entry
	// state, which is the whole reason plans get measured rather than added up.
	const push = (jobs, why, score) => {
		if (!jobs.length) return;
		// A PLAN MAY NOT NAME A CORPSE. duelCond keeps dead Pokemon from being
		// DUELLISTS, but the enabler legs come from the party-wide lever table
		// (leversFor, cached across the whole fight) which has no idea who is
		// still standing. Live at turn 157 that produced six candidates, every
		// one of them opening with Mienshao, Diggersby or Victreebel -- all
		// three already fainted -- so all six were dropped as dead legs, the
		// market came up empty and the turn fell through to greedy scoring
		// with a healthy Lilligant and a healthy Vikavolt on the field.
		if (opts.ourHp && jobs.some(j =>
			opts.ourHp[j.mon] !== undefined && opts.ourHp[j.mon] <= 0)) return;
		const key = jobs.map(j => j.mon + ':' + (j.moves || []).join('>')
			+ ':' + JSON.stringify(j.until || null)).join('|');
		if (seen[key]) return;
		seen[key] = true;
		out.push({jobs, why, score: score === undefined ? 9 : score});
	};

	// 1. Who kills it with no help at all.
	const solo = {};
	party.forEach((p, mi) => {
		const condS = duelCond(mi);
		if (!condS) return;
		const line = duelLinesM(mi, fi, condS, {})
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
			if (!leversUsable(entry)) {
				if (process.env.RR_DEBUG_LEVERS) console.log('[lever] vs ' + foe.species + ': ' + p.species + ' ' + E.describeEffect(entry.cond) + ': a lever move cannot touch it');
				continue;
			}
			if (!achievable(ctx, entry.cond, foe, opts.field)) {
				if (process.env.RR_DEBUG_LEVERS) console.log('[lever] vs ' + foe.species + ': ' + p.species + ' ' + E.describeEffect(entry.cond) + ': not achievable');
				continue;
			}
			const condE = duelCond(mi, entry.cond);
			if (!condE) break;
			const lines2 = duelLinesM(mi, fi, condE, {});
			const line = lines2.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
			if (process.env.RR_DEBUG_LEVERS) console.log('[lever] vs ' + foe.species + ': ' + p.species + ' ' + E.describeEffect(entry.cond) + ': '
				+ lines2.slice(0, 3).map(l => l.outcome + ' ' + (l.moves || []).join('/') + ' death ' + Math.round(100 * l.deathRisk) + '% turns ' + l.turns).join(' | '));
			if (!line) continue;
			found++;
			// The killer's OWN lever stays in: "slp, then Victreebel kills" was
			// shipping as a bare Mega Drain because Victreebel's Sleep Powder
			// job was filtered out here, so the plan promised a sleep it never
			// tried for (run 2 on s5, turn 576). Consecutive jobs for one
			// Pokemon are ordinary (Lilligant: Baby-Doll Eyes | Sleep Powder).
			const prep = enablerJobs(ctx, fi, entry);
			push(prep.concat([{mon: p.species, moves: line.moves}]),
				E.describeEffect(entry.cond) + ', then ' + p.species
				+ ' kills for ' + pctOf(line.cost),
				entry.effort * 0.15 + line.cost + 3 * line.deathRisk);
			// BOTH ORDERS of a two-lever setup. "Sleep it, then drop its Attack"
			// and "drop its Attack, then sleep it" are different plans: on s5
			// Lilligant's Baby-Doll Eyes costs her ~85 HP into an awake Pawmot
			// and nothing into a sleeping one, and only one order was ever
			// generated (run 4, turns 617-619).
			if (prep.length >= 2 && new Set(prep.map(j => j.mon)).size >= 2) {
				const rev = prep.slice().reverse();
				push(rev.concat([{mon: p.species, moves: line.moves}]),
					E.describeEffect(entry.cond) + ' (other order), then ' + p.species
					+ ' kills for ' + pctOf(line.cost),
					entry.effort * 0.15 + line.cost + 3 * line.deathRisk + 0.01);
			}
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
			return d ? d.type : null;   // status moves too: Volt Absorb eats Thunder Wave
		}).filter(Boolean));
		if (!theirTypes.has(l.absorbs)) return;      // nothing here to absorb
		// THE PIVOT HAPPENS NOW, so what matters is what the AI throws at the
		// Pokemon that is out NOW, not whether it owns an Electric move. Run 5
		// on s5, turn 669: Lanturn pivoted into a Vikavolt the port (rightly)
		// said would Roost; the "absorb" bought nothing and the Roost was
		// free. If the port's committed choice against our active is not of
		// the absorbed type, there is nothing to absorb this turn.
		if (opts.active !== undefined && ctx.engine.sandbox && ctx.engine.sandbox.RRAI) {
			let throwsIt = true;
			try {
				const ai = opts.active;
				const st = engine.B.createState(party.slice(ai).concat(party.slice(0, ai)),
					foeSets.slice(fi).concat(foeSets.slice(0, fi)), {});
				const hp = opts.ourHp && opts.ourHp[party[ai].species];
				if (hp !== undefined) st.me.team[0].curHP = Math.max(1, Math.round(st.me.team[0].maxHP * hp));
				if (opts.foeHp !== undefined) st.foe.team[0].curHP = Math.max(1, Math.round(st.foe.team[0].maxHP * opts.foeHp));
				const scored = ctx.engine.sandbox.RRAI.scoreAll(st, 'foe', {checkBadMove: true, checkGoodMove: true}, {});
				const choice = scored.length ? D.committedChoice(engine.B, scored, st) : null;
				const md = choice && choice.type === 'move' ? engine.B.moveData(choice.move) : null;
				throwsIt = !!(md && md.type === l.absorbs);
				if (process.env.RR_DEBUG_BAIT) console.log('[absorb] AI vs ' + party[ai].species + ' chooses ' + JSON.stringify(choice) + ' -> pivot ' + (throwsIt ? 'on' : 'off'));
			} catch (e) { throwsIt = true; }
			if (!throwsIt) return;
		}
		party.forEach((p, mi) => {
			if (p.species === l.mon) return;
			const condA = duelCond(mi);
			if (!condA) return;
			const line = duelLinesM(mi, fi, condA, {})
				.find(x => x.outcome === 'kill');
			if (!line) return;
			push([{mon: l.mon, moves: [], until: {entered: true}},
				{mon: p.species, moves: line.moves}],
				l.mon + ' absorbs ' + l.absorbs + (l.heals ? ' and heals' : '')
				+ ', then ' + p.species + ' kills for ' + pctOf(line.cost),
				line.cost + 3 * line.deathRisk - (l.heals ? 0.25 : 0.1));
		});
	});

	// 5. OPENERS: A TURN STOLEN IS A PURPOSE. James, 2026-09-03: "Your planner
	//    only cares about what our pokemon can do there, not why it is actually
	//    sent there." Fake Out is not 16% of damage; it is the opponent losing a
	//    turn, and the value of that shows up in whoever acts next. A Pokemon
	//    with an entry-only flinching move can head a plan whose job is exactly
	//    that, and the simulation prices what the stolen turn is worth. His
	//    line against Vikavolt -- switch to Hitmonlee, Fake Out, then Dugtrio
	//    Rock Blast -- is this family.
	const ENTRY_FLINCH = {'Fake Out': true};
	const canFlinch = !/Inner Focus|Shield Dust/i.test(foe.ability || '');
	if (process.env.RR_DEBUG_OPENER) console.log('[opener] foe ' + foe.species + ' ability ' + foe.ability + ' canFlinch ' + canFlinch);
	if (canFlinch) party.forEach((p, mi) => {
		const opener = (p.moves || []).find(m => ENTRY_FLINCH[m]);
		if (!opener) return;
		const condO = duelCond(mi);
		if (process.env.RR_DEBUG_OPENER) console.log('[opener] ' + p.species + ' has ' + opener + ' cond ' + JSON.stringify(condO));
		if (!condO) return;
		let usable = true;
		try {
			const probe = engine.B.createState(party.slice(mi).concat(party.slice(0, mi)),
				foeSets.slice(fi).concat(foeSets.slice(0, fi)), {});
			const r = engine.B.damageRolls(probe, 'me', opener);
			usable = !!(r && !r.immune);
		} catch (e) { usable = false; }
		if (process.env.RR_DEBUG_OPENER) console.log('[opener] ' + p.species + ' usable ' + usable);
		if (!usable) return;
		const steal = {mon: p.species, moves: [opener], until: {uses: 1}};
		party.forEach((q, qi) => {
			if (qi === mi) return;
			const condQ = duelCond(qi);
			if (!condQ) return;
			const line = duelLinesM(qi, fi, condQ, {})
				.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
			if (!line) return;
			push([steal, {mon: q.species, moves: line.moves}],
				p.species + ' steals a turn with ' + opener + ', then ' + q.species
				+ ' kills for ' + pctOf(line.cost),
				line.cost + 3 * line.deathRisk);   // no discount: the stolen turn earns its keep in pricing or not at all
		});
		push([steal, {mon: p.species, moves: ['*']}],
			p.species + ' steals a turn with ' + opener + ', then keeps hitting', 0.6);
	});

	// 6. TAKING THE HIT ON PURPOSE. A Pokemon that takes what they are about
	//    to throw cheaply -- immunity, an absorb, a heavy resist -- can be sent
	//    in for exactly that: eat the hit, hand over, and the finisher enters
	//    on a turn that costs it nothing. Family 3 is the absorb-and-heal case;
	//    this is the general one. "Cheaply" is the same damage reading
	//    safestPivot uses, so it stays derived from data.
	{
		const theirMoves = (foe.moves || []).filter(Boolean);
		party.forEach((w, wi) => {
			const condW = duelCond(wi);
			if (!condW) return;
			let worst = 0, maxHP = 1;
			try {
				const st = engine.B.createState(party.slice(wi).concat(party.slice(0, wi)),
					foeSets.slice(fi).concat(foeSets.slice(0, fi)), {});
				maxHP = st.me.team[0].maxHP;
				theirMoves.forEach(mv => {
					const r = engine.B.damageRolls(st, 'foe', mv);
					if (!r || r.immune) return;
					const hit = r.noCrit[r.noCrit.length - 1];
					if (hit > worst) worst = hit;
				});
			} catch (e) { return; }
			const frac = worst / maxHP;
			if (frac > 0.25) return;
			const buffer = {mon: w.species, moves: ['*'], until: {uses: 1}};
			party.forEach((q, qi) => {
				if (qi === wi) return;
				const condQ = duelCond(qi);
				if (!condQ) return;
				const line = duelLinesM(qi, fi, condQ, {})
					.find(l => l.outcome === 'kill' && l.deathRisk < 0.5);
				if (!line) return;
				push([buffer, {mon: q.species, moves: line.moves}],
					w.species + ' takes the hit for ' + pctOf(frac) + ', then '
					+ q.species + ' kills for ' + pctOf(line.cost),
					frac + line.cost + 3 * line.deathRisk + 0.05);
			});
		});
	}

	// 7. BAIT. James, 2026-09-04: "we switch to gyarados, and basically whoever
	//    sees gyarados uses an electric move because x4 and we can safely heal
	//    lanturn or kilowattrel." The absorb switch (family 3) is only free on
	//    the turn the AI has COMMITTED to the absorbed type, and the AI only
	//    commits to it when a Pokemon that type hurts is standing there. So
	//    the line is three entries: the bait goes in and hands over, the
	//    absorber enters into the move the AI chose against the bait, and
	//    then somebody kills (or the absorber, healed, fights on). Whether the
	//    AI really takes the bait is asked of the AI port with the bait on the
	//    field, not assumed from a type chart.
	{
		const RRAI = ctx.engine.sandbox && ctx.engine.sandbox.RRAI;
		const absorbers2 = LEVERS.filter(l => l.via === 'absorb-ability' && l.absorbs);
		if (RRAI && absorbers2.length) absorbers2.forEach(l => {
			const ai = party.findIndex(p => p.species === l.mon);
			if (ai < 0 || !duelCond(ai)) return;
			party.forEach((bait, bi) => {
				if (bi === ai) return;
				const condB = duelCond(bi);
				if (!condB) return;
				// What does the AI throw at the bait?
				let takes = false, dbgChoice = null;
				try {
					const st = engine.B.createState(party.slice(bi).concat(party.slice(0, bi)),
						foeSets.slice(fi).concat(foeSets.slice(0, fi)), {});
					if (condB.hpFrac !== undefined) {
						st.me.team[0].curHP = Math.max(1, Math.round(st.me.team[0].maxHP * condB.hpFrac));
					}
					const scored = RRAI.scoreAll(st, 'foe', {checkBadMove: true, checkGoodMove: true}, {});
					const choice = scored.length ? D.committedChoice(engine.B, scored, st) : null;
					const md = choice && choice.type === 'move' ? engine.B.moveData(choice.move) : null;
					dbgChoice = choice;
					takes = !!(md && md.type === l.absorbs);
					if (process.env.RR_DEBUG_BAIT) console.log('[bait]   AI vs ' + bait.species + ' chooses ' + JSON.stringify(choice));
				} catch (e) { takes = false; if (process.env.RR_DEBUG_BAIT) console.log('[bait] threw: ' + e.message); }
				if (process.env.RR_DEBUG_BAIT) console.log('[bait] ' + l.mon + ' (' + l.absorbs + ') with ' + bait.species + ' out -> takes ' + takes);
				if (!takes) return;
				const baitLeg = {mon: bait.species, moves: [], until: {entered: true}};
				const absorbLeg = {mon: l.mon, moves: [], until: {entered: true}};
				const story = bait.species + ' baits ' + l.absorbs + ', ' + l.mon + ' absorbs it'
					+ (l.heals ? ' and heals' : '');
				// ... then the absorber, healed, fights on
				push([baitLeg, {mon: l.mon, moves: ['*']}], story + ', then keeps hitting', 0.5);
				// ... or somebody else finishes
				party.forEach((q, qi) => {
					if (qi === ai || qi === bi) return;
					const condQ = duelCond(qi);
					if (!condQ) return;
					const line = duelLinesM(qi, fi, condQ, {}).find(x => x.outcome === 'kill' && x.deathRisk < 0.5);
					if (!line) return;
					push([baitLeg, absorbLeg, {mon: q.species, moves: line.moves}],
						story + ', then ' + q.species + ' kills for ' + pctOf(line.cost),
						line.cost + 3 * line.deathRisk - (l.heals ? 0.25 : 0.1));
				});
			});
		});
	}

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
	// A HARD FIGHT IS ALLOWED MORE THOUGHT (James: "it can wait for 2 minutes
	// if it wants"). ctx.deep is set by the live agent when the fight does not
	// read easy; the emulator side now waits three minutes for an answer.
	// opts.escalate is the zero-death second pass from replan.js: everything
	// wider, because the alternative on that turn is a death.
	const RETREATS = process.env.RR_NO_CHIP_CHAINS ? []
		: (opts.escalate ? [0.75, 0.65, 0.5, 0.35, 0.2] : (ctx.deep ? [0.65, 0.5, 0.35] : [0.5, 0.35]));
	const CHIP_MIN = opts.escalate ? 0.1 : 0.15;      // a leg must bank at least this to extend
	const MAX_CHIP_LEGS = opts.escalate ? 4 : 3;      // contributors before the finisher
	const BEAM = 6;
	let frontier = [{acc: 0, legs: [], used: {}, est: 0, risk: 0}];
	for (let depth = 0; depth <= MAX_CHIP_LEGS; depth++) {
		const grown = [];
		for (const node of frontier) {
			const base = fieldCond(opts.field, opts.foeHp);
			const already = base.foeChip || 0;
			const entryCond = Object.assign({}, base,
				(node.acc + already) > 0 ? {foeChip: Math.min(0.99, node.acc + already)} : {});
			party.forEach((p, mi) => {
				if (node.used[mi]) return;
				const condC = duelCond(mi, entryCond);
				if (!condC) return;
				// Can this one FINISH the remaining fraction? Only meaningful
				// once at least one chip leg exists: depth-0 kills are family 1.
				if (node.legs.length) {
					const fin = duelLinesM(mi, fi, condC, {})
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
						// A KILL IS THE BEST CHIP. Filtering to retreat/left only
						// meant that when every good move KILLS, the one move that
						// does not was the only chip line left -- Granbull chipped
						// a full Crawdaunt with Fire Fang, its resisted move, twice,
						// while Brick Break, Play Rough and Thunder Fang all removed
						// it outright (2026-09-03). Dead lines stay excluded.
						// A chip leg that is nothing but Fake Out is a Pokemon
						// cycled in to steal one turn and cycled out again,
						// paying entry damage each time (run 5 on s5: Mienshao in
						// three times against Vikavolt, 98 -> 31). James's rule:
						// Fake Out on entry when already in, never an entry FOR
						// Fake Out unless a priced plan needs the stolen turn --
						// that is the opener family's job, not this one's.
						const chip = duelLinesM(mi, fi,
							condC, {retreatAt: at})
							.filter(l => l.outcome === 'retreat' || l.outcome === 'left'
								|| l.outcome === 'kill')
							// ...unless the Pokemon REGENERATES on the way out. Runs 8/9
							// on s5: Mienshao (Regenerator) came in on Vikavolt, Fake
							// Out, took a hit, left and healed 32 each time -- that
							// is the classic Fake Out pivot and it won the fight. A
							// self-funding cycle is a chip leg the market may price.
							.filter(l => p.ability === 'Regenerator' || !(l.moves && l.moves.length
								&& l.moves.every(m => ENTRY_FLINCH[m])))
							// NET VALUE, NOT RAW CHIP. Picking the leg by chip alone
							// chose Sucker Punch (56% chip for 56% of Hitmonlee) over
							// Fake Out (16% chip for nothing, and the opponent loses
							// the turn), so the free opener never headed a plan and
							// James's "switch to Hitmonlee, Fake Out, then Dugtrio
							// Rock Blast" was unfindable (2026-09-03). Same order the
							// non-kill duel sort already uses.
							.sort((a, b) => (b.chip - b.cost) - (a.chip - a.cost))[0];
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
