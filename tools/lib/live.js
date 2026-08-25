/**
 * The live loop: an observation of the screen becomes advice for this turn.
 *
 * This is everything downstream of the pixels, and it is deliberately written
 * so it can be exercised WITHOUT any pixels -- `tools/test_live.js` drives it
 * from a simulated battle that emits the same observations the reader will.
 * When the reader finally exists, only the reader will be untested.
 *
 * ## Believed state, corrected by observation
 *
 * A screen shows some of a battle and not all of it. HP, species, status and
 * whose turn it is are visible; PP, hazards, stat stages after the message
 * scrolls past, and the opponent's item are not. So neither "rebuild the state
 * from the screen" nor "simulate and hope" is right on its own.
 *
 * What this does instead: keep a believed state, step it with the actions we
 * observed, and then RE-PIN every visible quantity from the frame. Simulation
 * carries the hidden parts; the screen overrules on everything it can see. A
 * simulation error in visible state is corrected next turn instead of
 * compounding, which is the property that makes one-turn-deep planning safe.
 *
 * ## The foe's HP is a range, so advice is computed at both ends
 *
 * The bar gives an interval, not a number (see tools/lib/hpbar.js). Measured
 * over real teams, which end you assume changes the kill count in under 1% of
 * decisions -- so the honest thing is to price both ends and only speak up when
 * they disagree. That turns HP uncertainty from a constant hedge into a rare,
 * specific question, which is the interaction contract DESIGN-UNCERTAINTY.md
 * asks for.
 */
'use strict';

const hpbar = require('./hpbar.js');

/** Index of the active mon on a side. */
function activeIndex(side) { return side.active; }

/**
 * What the screen reader would report about this position.
 *
 * Used by the test harness to manufacture realistic observations, and it
 * doubles as the specification of the reader's output: anything not in here is
 * something the reader does not have to produce.
 */
function observe(state, opts) {
	const width = (opts && opts.barWidth) || hpbar.BAR_WIDTH;
	const me = state.me.team[activeIndex(state.me)];
	const foe = state.foe.team[activeIndex(state.foe)];
	return {
		turn: state.turn,
		// Ours is printed as digits, so it is exact.
		me: {species: me.species, hp: me.curHP, maxHP: me.maxHP, status: me.status},
		// Theirs is a bar. maxHP is known from trainer data, not from the screen.
		foe: {species: foe.species, barPx: hpbar.barPixels(foe.curHP, foe.maxHP, width),
			maxHP: foe.maxHP, status: foe.status},
		barWidth: width
	};
}

/**
 * The foe's HP range implied by an observation, optionally narrowed by the
 * damage we know we just dealt.
 */
function foeRange(obs, candidates) {
	return hpbar.narrow(obs.foe.barPx, obs.foe.maxHP, candidates, obs.barWidth);
}

/** Find a live team member by species. */
function findBySpecies(side, species) {
	for (let i = 0; i < side.team.length; i++) {
		if (side.team[i].species === species && !side.team[i].fainted) return i;
	}
	for (let i = 0; i < side.team.length; i++) {
		if (side.team[i].species === species) return i;
	}
	return -1;
}

/**
 * Overwrite everything the screen can see, leave everything it cannot.
 *
 * `foeHP` is passed in rather than read from the observation because the caller
 * decides which end of the interval this copy represents.
 */
function sync(state, obs, foeHP, B) {
	const next = B.clone(state);
	const mi = findBySpecies(next.me, obs.me.species);
	const fi = findBySpecies(next.foe, obs.foe.species);
	if (mi < 0 || fi < 0) return null;
	next.me.active = mi;
	next.foe.active = fi;
	const me = next.me.team[mi], foe = next.foe.team[fi];
	me.curHP = Math.max(0, Math.min(obs.me.hp, me.maxHP));
	me.fainted = me.curHP <= 0;
	me.status = obs.me.status || null;
	foe.curHP = Math.max(0, Math.min(foeHP, foe.maxHP));
	foe.fainted = foe.curHP <= 0;
	foe.status = obs.foe.status || null;
	next.turn = obs.turn;
	return next;
}

function labelOf(entry) { return entry && entry.label; }

/**
 * A position as a player can identify it: who is out, at what HP, foe bar.
 *
 * Deliberately built from OBSERVABLE quantities only. A signature that used
 * hidden state would distinguish positions the advisor cannot actually tell
 * apart, and then the cycle guard below would never fire on the loop it exists
 * to break.
 */
function signature(obs) {
	return obs.me.species + '|' + obs.me.hp + '|' + obs.foe.species + '|' + obs.foe.barPx;
}

/**
 * A session remembers which positions this battle has already visited.
 *
 * Needed because one-turn-deep ranking has intransitive preferences and will
 * cycle. Measured on Lt. Surge: from Diggersby it ranks "switch to Breloom"
 * top because that wins the speed race, and from Breloom it ranks "switch to
 * Diggersby" top for the same reason. Each position genuinely prefers the
 * other, so the advisor oscillated for forty turns and lost a fight that is
 * winnable without losing anybody.
 *
 * The root cause is that the race is scored against a worst-case opponent
 * reply chosen per action, so the comparison is not between commensurable
 * futures. Fixing that properly means giving the advisor an objective that
 * spans turns. This is the cheap, honest guard in the meantime: on returning to
 * a position, do not repeat the choice that led away from it last time.
 */
function createSession() {
	return {seen: new Map()};
}

// NOTE: advise() RECORDS the visit when a session is passed, so calling it
// twice for the same turn counts that position twice and will step the ranking
// further down than intended. One call per turn. Splitting the record out of
// the query is the right shape and is not done yet.

/**
 * Advice for this turn, priced at both ends of the foe's HP range.
 *
 * Returns the recommendation plus whether the range mattered. `ambiguous` is
 * the ONLY circumstance in which the foe's exact HP is worth asking about, and
 * it is rare by measurement rather than by hope.
 */
function advise(state, obs, opts, engine, session) {
	const B = engine.B, RRPlan = engine.sandbox.RRPlan;
	const range = foeRange(obs, opts && opts.candidates);
	if (!range) return null;

	// The pessimistic end first: the foe having MORE hp is the assumption that
	// cannot get you killed by an over-optimistic "this kills" call.
	const pessimistic = sync(state, obs, range.hi, B);
	if (!pessimistic) return null;
	const planHi = RRPlan.advise(pessimistic, opts || {});
	let planLo = planHi, agreed = true;
	if (range.lo !== range.hi) {
		const optimistic = sync(state, obs, range.lo, B);
		planLo = optimistic ? RRPlan.advise(optimistic, opts || {}) : planHi;
		agreed = labelOf(planLo.best) === labelOf(planHi.best);
	}
	// On a repeat visit, step down the ranking rather than repeating a choice
	// that demonstrably brought us back here. The Nth visit takes the Nth
	// option, which terminates: the list is finite, so the advisor is forced
	// into a different line instead of a cycle.
	let best = planHi.best;
	let repeats = 0;
	if (session) {
		const sig = signature(obs);
		repeats = session.seen.get(sig) || 0;
		session.seen.set(sig, repeats + 1);
		if (repeats > 0 && planHi.entries && planHi.entries.length) {
			best = planHi.entries[Math.min(repeats, planHi.entries.length - 1)];
		}
	}

	return {
		// Always the pessimistic recommendation: when the two disagree we still
		// have to say something, and the safe end is the one to say.
		best: best,
		// True when the cycle guard, not the ranking, chose this action. Worth
		// surfacing: it means the advisor is escaping a loop rather than
		// following its own preference, which is a fact about the advice.
		forced: repeats > 0,
		repeats: repeats,
		alternative: agreed ? null : planLo.best,
		ambiguous: !agreed,
		range: range,
		exact: range.lo === range.hi,
		threats: planHi.threats,
		assumption: planHi.assumption,
		state: pessimistic
	};
}

module.exports = {observe, foeRange, sync, advise, findBySpecies, signature, createSession};
