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

	let best = null;
	const ideas = C.candidatesFor(ctx, fi, {field});
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
		const score = spend + illegal.length * 6 + 4 * r.deathRisk;
		if (!best || score < best.score) best = {score, cand, r, illegal};
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
