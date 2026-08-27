/**
 * Decide by re-pricing from the CURRENT position, every turn.
 *
 * Three experiments killed the static plan: median rolls in roster order won
 * 0/30, median rolls in their real order 1/30, pessimistic damage taken 0/40 --
 * all six Pokemon dead every time. The dice model was not the problem, since
 * two opposite assumptions both failed. The trace was: a leg priced with
 * Lilligant arriving healthy, played with Lilligant arriving at 32%, executed
 * anyway. A policy table cannot notice that the position has drifted.
 *
 * James said this before any of it was measured: "you are giving plans right now
 * but they will break, and you will need to recalibrate in a fight. Or you will
 * need to expertly bring in a pokemon. Or you will need to recalculate a path to
 * kill the pokemon."
 *
 * So this does not carry a plan at all. Each turn it asks the same question the
 * combination search asks, but only about the position in front of it: what are
 * the ways to kill THIS Pokemon from HERE, what do they cost, and which one's
 * first move should I make now? Next turn it asks again, from wherever the dice
 * put us. `pricePath` already takes an entry state, so the machinery exists --
 * it was only ever being called once per fight instead of once per turn.
 */
'use strict';
const C = require('./candidates.js');
const P = require('./policy.js');
const {pricePath} = require('./paths.js');

function chooseAction(ctx, state, opts) {
	const engine = ctx.engine, B = engine.B;
	const options = opts || {};
	const expendable = ctx.expendable || [];
	const fi = state.foe.active;
	const field = {terrain: state.field.terrain, terrainTurns: state.field.terrainTurns,
		weather: state.field.weather, weatherTurns: state.field.weatherTurns};

	// The position as pricePath wants it: everyone's HP, who is dead on both
	// sides, and who is standing.
	const hp = {}, dead = [], foeDead = [];
	state.me.team.forEach(m => {
		hp[m.set.species] = m.curHP / m.maxHP;
		if (m.fainted) dead.push(m.set.species);
	});
	state.foe.team.forEach((m, i) => { if (m.fainted) foeDead.push(i); });
	const entry = {hp, dead, foeDead, field,
		active: state.me.team[state.me.active].set.species};

	// LOOK PAST THE POKEMON IN FRONT OF US.
	//
	// Pricing only the current kill picks the cheapest way to remove Bellibolt
	// and will happily spend the one Pokemon that Pawmot needs. James put it
	// exactly: it is not just about killing Bellibolt, it has to think about
	// whether this path to killing Bellibolt has a consequence when trying to
	// kill Pawmot. The state a line LEAVES US IN matters as much as the kill.
	//
	// So every candidate is priced, and then the position it leaves behind is
	// priced against every opponent still alive: for each, the cheapest single
	// line from that resulting state. A line that wins this exchange and
	// strands us later now carries that cost in its own score.
	//
	// This is the combination search from docs/PLAN-LINE-PLANNER.md run from
	// the CURRENT position instead of once before the fight, and deliberately
	// cheap -- no ordering search, just "can each remaining one still be
	// handled, and for how much". Slower per turn than pricing a single kill,
	// which is the trade James asked for, and far short of the full beam.
	const LOOKAHEAD = options.lookahead === false ? 0 : 5;

	// Candidate generation depends only on WHO we are facing and the field, not
	// on the HP of the position, so it is the same answer every turn of a fight
	// and was being recomputed from scratch for every candidate of every turn.
	// That alone was most of a 41-second decision.
	function cachedCandidates(idx, fld) {
		const key = idx + '|' + (fld && fld.terrainTurns > 0 ? fld.terrain : '-');
		if (!ctx._candCache) ctx._candCache = {};
		if (!ctx._candCache[key]) ctx._candCache[key] = C.candidatesFor(ctx, idx, {field: fld});
		return ctx._candCache[key];
	}

	function continuationCost(after, killedIdx) {
		const hpAfter = {}, deadAfter = [];
		after.me.team.forEach(m => {
			hpAfter[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
			if (m.fainted) deadAfter.push(m.set.species);
		});
		const foeDeadAfter = [];
		after.foe.team.forEach((m, i) => { if (m.fainted) foeDeadAfter.push(i); });
		if (!foeDeadAfter.includes(killedIdx)) foeDeadAfter.push(killedIdx);
		const entryAfter = {
			hp: hpAfter, dead: deadAfter, foeDead: foeDeadAfter,
			field: {terrain: after.field.terrain, terrainTurns: after.field.terrainTurns},
			active: after.me.team[after.me.active].set.species
		};
		let total = 0;
		for (let gi = 0; gi < ctx.foeSets.length; gi++) {
			if (foeDeadAfter.includes(gi)) continue;
			let cheapest = null;
			let ahead;
			try { ahead = cachedCandidates(gi, entryAfter.field); }
			catch (e) { continue; }
			for (const cand of ahead.slice(0, LOOKAHEAD)) {
				if (!cand.jobs.length) continue;
				if (cand.jobs.every(j => deadAfter.includes(j.mon))) continue;
				let rr;
				try { rr = pricePath(ctx, gi, cand.jobs, entryAfter, {expendable}); }
				catch (e) { continue; }
				if (!rr.kills) continue;
				let sp = 0;
				for (const k in rr.spend) sp += Math.max(0, rr.spend[k]);
				const bad = rr.dead.filter(n => !expendable.includes(n)).length;
				const c = sp + bad * 6 + 2 * rr.deathRisk;
				if (cheapest === null || c < cheapest) cheapest = c;
			}
			// Nothing kills it from here. That is the expensive outcome and the
			// whole reason for looking ahead at all.
			total += (cheapest === null) ? 8 : cheapest;
		}
		return total;
	}

	let best = null;
	const shortlist = [];
	const ideas = cachedCandidates(fi, field);
	for (const cand of ideas) {
		if (!cand.jobs.length) continue;
		if (cand.jobs.every(j => dead.includes(j.mon))) continue;
		let r;
		try { r = pricePath(ctx, fi, cand.jobs, entry, {expendable}); }
		catch (e) { continue; }
		if (!r.kills) continue;
		const illegal = r.dead.filter(n => !expendable.includes(n));
		let spend = 0;
		for (const k in r.spend) spend += Math.max(0, r.spend[k]);
		// A path that kills somebody it may not is not ranked below the others,
		// it is ranked out -- unless nothing else kills at all, in which case
		// something has to be done and the cheapest disaster is still a choice.
		const here = spend + illegal.length * 6 + 4 * r.deathRisk;
		shortlist.push({here, cand, r, illegal});
	}
	// Looking ahead is the expensive part, so it is spent only on the handful of
	// lines that could plausibly win. Pricing the immediate kill is cheap;
	// pricing the rest of the fight is not.
	shortlist.sort((a, b) => a.here - b.here);
	const FINALISTS = options.finalists || 4;
	shortlist.slice(0, FINALISTS).forEach(item => {
		let ahead = 0;
		if (LOOKAHEAD && item.r.state) {
			try { ahead = continuationCost(item.r.state, fi); } catch (e) { ahead = 0; }
		}
		const score = item.here + ahead;
		if (!best || score < best.score) {
			best = {score, here: item.here, ahead, cand: item.cand, r: item.r,
				illegal: item.illegal};
		}
	});
	if (!best && shortlist.length) {
		const it = shortlist[0];
		best = {score: it.here, here: it.here, ahead: 0, cand: it.cand, r: it.r,
			illegal: it.illegal};
	}
	if (!best) return null;

	// The first action of the winning path, taken from the same policy code
	// that would have executed it, so the choice and the pricing cannot drift.
	const plan = {};
	plan[state.foe.team[fi].set.species] = best.cand.jobs;
	const action = P.planAction(engine, state, plan, P.newProgress());
	return action ? {action, path: best} : null;
}

module.exports = {chooseAction};
