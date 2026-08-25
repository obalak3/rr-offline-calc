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
/**
 * A readable name for an action, without reaching into rr-plan's private
 * labelFor. Switches name the Pokemon because that is what a player reads off
 * the party screen.
 */
function labelAction(state, action, B) {
	if (!action) return '(none)';
	if (action.type === 'switch') {
		const mon = state.me.team[action.index];
		return 'Switch to ' + (mon ? mon.species : ('#' + action.index));
	}
	return action.move;
}

/**
 * Rank this turn's actions by a SEARCH rather than by the one-turn heuristic.
 *
 * OPT-IN, AND OFF BY DEFAULT, BECAUSE IT IS MEASURABLY NOT BETTER YET.
 * Measured 2026-08-25 over level-appropriate fights:
 *
 *     heuristic   Brock  5 turns, 0 switches,   13 ms/turn
 *                 Misty  9 turns, 1 switch,     12 ms/turn
 *     search      Brock 10 turns, 4 switches,  666 ms/turn
 *                 Misty 11 turns, 2 switches, 1288 ms/turn
 *
 * Slightly worse play and roughly a hundred times the cost. It is kept because
 * the idea is right and the measurement is the useful part -- see the two
 * failure modes below, which are what any second attempt has to beat.
 *
 * The heuristic ranks on a race between the two active Pokemon, scored against
 * a worst-case reply chosen separately for each action. Those futures are not
 * commensurable, which is why its preferences came out intransitive and why
 * refusing to switch at all beat it on Lt. Surge.
 *
 * `winChance` is commensurable by construction: every action is priced by the
 * probability the same continuation reaches a clean win. It was unusable for
 * this before, because a search that ran out of budget scored everything zero
 * and the ranking came back flat -- which is exactly what separating unknown
 * from loss fixed. A shallow horizon is affordable here precisely because the
 * screen reader re-plans every turn from a true position, so nothing has to be
 * predicted far ahead.
 */
function searchRank(state, opts, engine) {
	const X = engine.X, B = engine.B;
	const entries = X.rank(state, {
		maxTurns: opts.searchTurns || 6,
		exactBudget: opts.searchBudget || 20000,
		timeLimitMs: opts.searchTimeLimitMs || 150,
		margin: opts.margin,
		flagSets: opts.flagSets
	});
	if (!entries || !entries.length) return null;

	// Only trust the search when it actually distinguished the actions.
	//
	// Measured: on Brock this search resolves the fight completely -- 100%
	// clean, nothing unknown, and the gap between the best and worst action is
	// the full 100 points. On Lt. Surge, at every depth from 4 to 10, it comes
	// back 0% with 100% unknown and a spread of EXACTLY ZERO: it could not
	// prove anything about any action, so every option scores the same and the
	// order is arbitrary. Ranking by that is worse than the heuristic, and
	// measurably was.
	//
	// This check is only possible because unknown is now separate from loss.
	// Before that, the flat ranking was a column of zeros indistinguishable
	// from "every option loses", and there was no way to tell an informative
	// search from an uninformed one.
	let best = -Infinity, worst = Infinity;
	for (const e of entries) {
		if (e.chance > best) best = e.chance;
		if (e.chance < worst) worst = e.chance;
	}
	if (best - worst < (opts.searchMinSpread === undefined ? 0.01 : opts.searchMinSpread)) {
		return null;   // uninformative: let the heuristic answer
	}
	return entries.map(function (e) {
		return {
			action: e.action,
			label: labelAction(state, e.action, B),
			chance: e.chance,
			unknown: e.unknown,
			upper: e.upper,
			// Kept so callers that expect the heuristic's shape still work.
			verdict: (100 * e.chance).toFixed(0) + '% clean' +
				(e.unknown > 0.05 ? ' (+' + (100 * e.unknown).toFixed(0) + '% unexamined)' : '')
		};
	});
}

function advise(state, obs, opts, engine, session) {
	const B = engine.B, RRPlan = engine.sandbox.RRPlan;
	const range = foeRange(obs, opts && opts.candidates);
	if (!range) return null;

	// The pessimistic end first: the foe having MORE hp is the assumption that
	// cannot get you killed by an over-optimistic "this kills" call.
	const pessimistic = sync(state, obs, range.hi, B);
	if (!pessimistic) return null;

	// Search mode replaces the ranking wholesale; everything below it -- the
	// both-ends check, the cycle guard -- is unchanged, because those are about
	// the observation rather than about how actions are scored.
	if (opts && opts.searchRank) {
		const ranked = searchRank(pessimistic, opts, engine);
		if (ranked && ranked.length) {
			let best = ranked[0], repeats = 0;
			if (session) {
				const sig = signature(obs);
				repeats = session.seen.get(sig) || 0;
				session.seen.set(sig, repeats + 1);
				if (repeats > 0) best = ranked[Math.min(repeats, ranked.length - 1)];
			}
			return {best: best, alternative: null, ambiguous: false, forced: repeats > 0,
				repeats: repeats, range: range, exact: range.lo === range.hi,
				plan: ranked, threats: null, assumption: 'search, ' +
					(opts.searchTurns || 6) + ' turns deep', state: pessimistic};
		}
		// Falls through to the heuristic when the search returned nothing, or
		// returned a ranking too flat to mean anything. The advisor is then
		// using whichever method can actually tell the actions apart, which is
		// the whole point of being able to measure ignorance.
	}

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
		// The full ranking, so a caller can apply its own constraint without
		// re-running the planner.
		plan: planHi.entries,
		threats: planHi.threats,
		assumption: planHi.assumption,
		state: pessimistic
	};
}

module.exports = {observe, foeRange, sync, advise, findBySpecies, signature, createSession};
