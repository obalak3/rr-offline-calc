/**
 * A plan for the WHOLE fight, priced as one simulated sequence.
 *
 * ## Why
 *
 * `replan.js` prices the kill in front of it exactly, and then prices the rest
 * of the fight with `continuationCost`, which asks each remaining opponent
 * "what is the cheapest single line that kills you, from here?" and adds the
 * answers up. That sum is optimistic in four measured ways:
 *
 *   - Each opponent is priced INDEPENDENTLY, so the same Pokemon can be the
 *     load-bearing killer for two of them at once. Measured on 15.5% of
 *     archived positions (never three).
 *   - A switch inside the continuation eats only the single committed enemy
 *     move, while a switch in the main market is charged the worst move in
 *     RRAI.plausible's set (`entryThreats` is passed at replan.js:600 and
 *     omitted in the continuation's pricePath calls).
 *   - Death risk is weighted 4 in the immediate term and 2 in the continuation.
 *   - The continuation prices against a rebuilt fiction: foe HP bucketed to
 *     tenths, our PP re-dealt full, weather dropped, and a candidate cache keyed
 *     without our own side's condition.
 *
 * The flat 8 charged when no line is found is the counterweight to that
 * optimism, not an estimate. Two experiments established it: RR_DEEP_SCAN
 * replaced artifact 8s with real below-cut lines and went 27/60 to 8/60 and
 * 7/60, and the historical uniform depth sweep wiped at 12 and 30. Believing
 * more of an optimistic estimate spends Pokemon on futures that are not real.
 *
 * So the constant cannot be repaired by tuning it. The shape has to change.
 *
 * ## What this does instead
 *
 * One continuous simulation from here to the end of the fight. A gameplan is a
 * sequence of legs, each a (target, jobs) pair, and each leg starts from the
 * position the previous leg actually left behind. Every leak above closes as a
 * consequence rather than as a rule:
 *
 *   - Victreebel cannot answer Pincurchin and Pawmot at once, because the Pawmot
 *     leg begins at whatever HP and PP the Pincurchin leg left it holding.
 *   - Entries are priced by the same `pricePath` with the same `entryThreats`
 *     everywhere, because there is no separate "future" pricing path.
 *   - No bucketing and no re-dealt PP, for the same reason.
 *   - Their replacement is `r.nextFoe`, simulated by the engine during the line
 *     rather than assumed from the roster (paths.js records this as measured
 *     40/40: Surge sends Pawmot second where the roster says Vikavolt).
 *
 * It is deliberately NOT an assignment of one Pokemon per opponent. James:
 * hard fights need one Pokemon to chip one enemy, drop the Attack of another
 * and kill a third. A sequence expresses that; an assignment cannot.
 *
 * ## This is not the static plan that lost 0/30
 *
 * That was plan-once-and-obey, measured in the era of the broken harness and of
 * pricing bugs since fixed (full-health entry fictions, no status carried, a
 * phantom Electric Terrain). James predicted its failure before it was measured:
 * "you are giving plans right now but they will break, and you will need to
 * recalibrate in a fight."
 *
 * The caller is expected to run this as plan-and-REPAIR: follow the gameplan
 * while reality tracks it, and rebuild from scratch the moment it does not. The
 * divergence test is the caller's, not this module's, because only the caller
 * knows a turn happened. `tools/sim_episodes.js` has the reference one.
 *
 * NOTHING HERE IS ON BY DEFAULT. This module is only reachable from an arm that
 * asks for it.
 */
'use strict';
const C = require('./candidates.js');
const {pricePath} = require('./paths.js');

/** The position as pricePath wants it, read off a live or simulated state. */
function entryFrom(state, opts) {
	const hp = {}, dead = [], foeDead = [], status = {}, foeStatus = {};
	state.me.team.forEach(m => {
		hp[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
		if (m.fainted) dead.push(m.set.species);
		if (m.status && !m.fainted) status[m.set.species] = m.status;
	});
	state.foe.team.forEach((m, i) => {
		if (m.fainted) foeDead.push(i);
		else if (m.status) foeStatus[i] = m.status;
	});
	const active = state.me.team[state.me.active];
	const target = state.foe.team[state.foe.active];
	const en = {
		hp, dead, foeDead, status, foeStatus,
		field: {terrain: state.field.terrain, terrainTurns: state.field.terrainTurns,
			weather: state.field.weather, weatherTurns: state.field.weatherTurns},
		active: active.set.species,
		turnsOut: active.turnsOut,
		foeTurnsOut: target && target.turnsOut
	};
	if (target) en.foeBoosts = Object.assign({}, target.boosts);
	if (active) {
		en.myBoosts = Object.assign({}, active.boosts);
		if (active.pp) en.myPP = active.pp.slice();
	}
	if (target && target.maxHP && target.curHP < target.maxHP) {
		en.foeChip = 1 - (target.curHP / target.maxHP);
	}
	return en;
}

/**
 * What one leg costs, in the SAME units as replan.js's immediate term, so a
 * gameplan total and a `here` are commensurable and the two architectures can be
 * compared without a conversion nobody can check.
 */
function legCost(r, expendable, tempo, spendCost) {
	const spent = r.dead.filter(n => expendable.includes(n));
	const illegal = r.dead.filter(n => !expendable.includes(n));
	let spend = 0;
	for (const k in r.spend) spend += Math.max(0, r.spend[k]);
	let c = spend + illegal.length * 6 + spent.length * spendCost
		+ 4 * r.deathRisk + tempo * (r.turns || 0);
	// A leg that neither kills nor sees the target leave has not finished its
	// job. Charged for what it left standing, the same 6-per-whole-Pokemon
	// convention replan.js already uses to price wreckage.
	if (!r.kills && r.outcome !== 'left') {
		c += 6 * (r.foeLeft === undefined ? 1 : r.foeLeft);
	}
	return c;
}

/**
 * Build a plan that removes every opponent still standing.
 *
 * Beam search over sequences. Width and per-level breadth are deliberately
 * small: this replaces a lookahead that already priced roughly FINALISTS x
 * opponents x LOOKAHEAD lines per turn, and it runs on divergence rather than
 * every turn, so it should cost less in aggregate, not more.
 *
 * Returns null when no sequence removes them all. That is a real answer, not a
 * failure: it means this position has no clean path through the rest of the
 * fight, and the caller should fall back to the incumbent planner rather than
 * pretend otherwise.
 */
function buildGameplan(ctx, state, opts) {
	const options = opts || {};
	const expendable = ctx.expendable || [];
	const TEMPO = options.tempo === undefined ? 0.4 : options.tempo;
	const SPEND = options.spend === undefined ? 2 : options.spend;
	// Beam x breadth is the whole cost: each pair is one pricePath, and pricePath
	// simulates up to 16 turns. At 4x6 a build measured 9.4s and an episode ran
	// past three minutes, which is unmeasurable at battery scale. 3x4 is 12
	// pricePaths per depth instead of 24.
	const BEAM = options.beam || Number(process.env.RR_GP_BEAM || 3);
	const BREADTH = options.breadth || Number(process.env.RR_GP_BREADTH || 4);
	const MAXLEGS = options.maxLegs || 8;

	// Candidate generation is the expensive half and depends only on the target,
	// the field and roughly how hurt it is, so it is cached per build.
	// ON THE CTX, not per build. Generation is re-run on every rebuild otherwise,
	// and a plan-and-repair arm rebuilds many times per episode. The key already
	// carries everything generation depends on.
	const cache = ctx._gpCandCache || (ctx._gpCandCache = {});
	function candidates(fi, st) {
		const fm = st.foe.team[fi];
		const frac = fm && fm.maxHP ? fm.curHP / fm.maxHP : 1;
		const bucket = Math.max(1, Math.ceil(frac * 10));
		const fld = {terrain: st.field.terrain, terrainTurns: st.field.terrainTurns};
		const key = fi + '|' + (fld.terrainTurns > 0 ? fld.terrain : '-') + '|' + bucket;
		if (cache[key]) return cache[key];
		const ourHp = {}, ourStatus = {};
		st.me.team.forEach(m => {
			ourHp[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
			if (m.status && !m.fainted) ourStatus[m.set.species] = m.status;
		});
		let out = [];
		try {
			out = C.candidatesFor(ctx, fi, {field: fld, foeHp: bucket / 10, ourHp, ourStatus});
		} catch (e) { out = []; }
		cache[key] = out;
		return out;
	}

	const allDown = st => st.foe.team.every(m => m.fainted);
	let beam = [{legs: [], state: state, cost: 0}];
	let done = null;
	// THE BEST PARTIAL PLAN, kept alongside the complete one.
	//
	// Requiring a plan to remove EVERY opponent is too strict to be useful, and
	// measurably so: from a fresh Lt. Surge position the beam removes four of the
	// five and then finds nothing that kills Bellibolt from the position four
	// legs later, so it returned null and the arm fell back to the incumbent
	// planner on 42 of 54 attempts. That is not a failure of the search, it is
	// the search correctly reporting that our fifth answer is not visible from
	// here.
	//
	// It is also not what a gameplan is for. James's framing is explicit that the
	// plan is expected to break: "knowing that at some point it will break due to
	// luck or just bad predictions from us, and then create a new plan to finish
	// the game from that point." A plan that removes four opponents will be
	// rebuilt long before the fifth arrives.
	//
	// HOW A PARTIAL PLAN IS RANKED, and the first version of this was wrong.
	//
	// It ranked lexicographically, more opponents removed first and cost only as
	// a tie-break, on the reasoning that charging for the unplanned remainder
	// would be the flat 8 again in a different hat. That reasoning does not
	// survive: with cost demoted to a tie-break, a three-leg plan costing 40 and
	// burying four of ours beats a two-leg plan costing 5 that buries nobody.
	// Depth was free. Measured consequence, 80 episodes: the arm won 23 times and
	// NEVER ONCE won without losing somebody, against 7 clean wins for the
	// control.
	//
	// It was also the wrong lesson to draw from RR_DEEP_SCAN. That experiment
	// showed the flat 8 is load-bearing PESSIMISM, not an error to be routed
	// around. And the incumbent charges exactly 8 per unanswered opponent, so
	// refusing to charge it here does not avoid an invented constant, it makes a
	// gameplan's total incommensurable with the score it is competing against.
	//
	// So: cost plus 8 for every opponent the plan does not account for, ranked on
	// that total. Depth now has to pay for itself, and a plan is comparable to
	// the incumbent's here+ahead by construction. RR_GP_LEXI=1 restores the old
	// ranking for the A/B.
	const LEXI = !!process.env.RR_GP_LEXI;
	const REMAINDER = 8;
	const foesLeftAfter = nd => nd.state.foe.team.filter(m => !m.fainted).length;
	const rank = nd => nd.cost + REMAINDER * foesLeftAfter(nd);
	let partial = null;
	const better = LEXI
		? (a, b) => !b || a.legs.length > b.legs.length
			|| (a.legs.length === b.legs.length && a.cost < b.cost)
		: (a, b) => !b || rank(a) < rank(b);

	for (let depth = 0; depth < MAXLEGS && beam.length; depth++) {
		const next = [];
		for (const node of beam) {
			const st = node.state;
			if (allDown(st)) continue;
			const fi = st.foe.active;
			if (fi < 0 || !st.foe.team[fi] || st.foe.team[fi].fainted) continue;
			const dead = [];
			st.me.team.forEach(m => { if (m.fainted) dead.push(m.set.species); });
			if (st.me.team.every(m => m.fainted)) continue;
			const en = entryFrom(st, options);
			// THE SAME THREAT SET THE MAIN MARKET USES, at every depth. The
			// continuation in replan.js omits this, which is one of the four
			// measured reasons its futures come out cheaper than its presents.
			let threats = null;
			try {
				threats = ctx.engine.sandbox.RRAI.plausible(st, 'foe').actions
					.filter(a => a.type === 'move' && !(function () {
						const d = ctx.engine.B.moveData(a.move);
						return d && d.effect && d.effect.kind === 'selfSwitch';
					})());
				if (!threats.length) threats = null;
			} catch (e) { threats = null; }
			let tried = 0, seen = 0, noKill = 0, threw = 0;
			for (const cand of candidates(fi, st)) {
				if (tried >= BREADTH) break;
				seen++;
				if (!cand.jobs || !cand.jobs.length) continue;
				if (cand.jobs.some(j => dead.includes(j.mon))) continue;
				let r;
				try { r = pricePath(ctx, fi, cand.jobs, en, {expendable, entryThreats: threats}); }
				catch (e) { threw++; continue; }
				if (!r.state) { threw++; continue; }
				// A line that neither kills nor pivots the target away has not
				// advanced the fight; taking it would let the beam spin.
				if (!r.kills && r.outcome !== 'left') { noKill++; continue; }
				tried++;
				const child = {
					legs: node.legs.concat([{fi, jobs: cand.jobs, why: cand.why,
						kills: !!r.kills, turns: r.turns, dead: r.dead, log: r.log}]),
					state: r.state,
					cost: node.cost + legCost(r, expendable, TEMPO, SPEND)
				};
				if (allDown(r.state)) {
					if (!done || child.cost < done.cost) done = child;
					if (better(child, partial)) partial = child;
				} else if (r.state.me.team.every(m => m.fainted)) {
					// Wiped finishing this leg. Not a plan at any depth.
				} else {
					next.push(child);
					if (better(child, partial)) partial = child;
				}
			}
			if (options.trace > 1) console.log('[gameplan]    foe' + fi
				+ ' cands=' + candidates(fi, st).length + ' seen=' + seen
				+ ' usable=' + tried + ' noKill=' + noKill + ' threw=' + threw);
		}
		if (options.trace) {
			console.log('[gameplan] depth ' + depth + ': beam ' + beam.length
				+ ' -> ' + next.length + ' children'
				+ (done ? ', complete plan at ' + done.cost.toFixed(2) : '')
				+ '  ' + beam.map(nd => nd.legs.length + 'L/' + nd.cost.toFixed(1)
					+ '/foe' + nd.state.foe.active).join(' '));
			if (options.trace > 1) {
				beam.forEach(nd => console.log('[gameplan]    node foe='
					+ nd.state.foe.active + ' alive=' + nd.state.foe.team.filter(m => !m.fainted).length
					+ ' ours=' + nd.state.me.team.filter(m => !m.fainted).length
					+ ' legs=' + nd.legs.map(l => l.fi + (l.kills ? 'K' : 'L')).join('>')));
			}
		}
		if (!next.length) break;
		// SORTED ON THE SAME CRITERION THE WINNER IS CHOSEN BY. Sorting the beam
		// on raw cost while accepting on cost-plus-remainder is the FINALISTS
		// mistake in miniature: prune by one yardstick, decide by another, and a
		// line can be cut before the criterion that would have picked it is ever
		// applied to it.
		next.sort((a, b) => (LEXI ? a.cost - b.cost : rank(a) - rank(b)));
		beam = next.slice(0, BEAM);
		// A complete plan already cheaper than every partial one left cannot be
		// beaten by extending them, since a leg never costs less than nothing.
		if (done && beam.length && rank(done) <= rank(beam[0])) break;
	}
	// A complete plan wins outright; otherwise take the deepest partial. Only a
	// position from which not even one opponent can be removed returns null, and
	// that is a real answer the caller should hear rather than a shrug.
	const chosen = done || partial;
	if (!chosen) return null;
	// The executor looks a plan up by the CURRENT foe's species, so a whole-fight
	// plan is exactly the map it already accepts -- one entry per opponent. This
	// is why no change to policy.js is needed to play a gameplan.
	const plan = {};
	chosen.legs.forEach(l => {
		const sp = ctx.foeSets[l.fi] && ctx.foeSets[l.fi].species;
		if (sp && !plan[sp]) plan[sp] = l.jobs;
	});
	// THE HP TRAJECTORY THE PLAN EXPECTS, turn by turn, concatenated across legs.
	//
	// A plan is followed until it is abandoned, and the only thing that could
	// abandon one was an unplanned DEATH -- measured, 118 of 118 abandonments.
	// So a plan ran a median of 10 turns and up to 30 while its premises drifted,
	// which is the static-plan failure mode with a weaker trigger. Death is a
	// late signal; the position is usually already lost by then.
	//
	// pricePath's log carries `us` as per-Pokemon percentages each turn, so the
	// expected total team health is recoverable without simulating anything
	// twice. The caller compares it against reality and rebuilds when they part.
	const trace = [];
	chosen.legs.forEach(l => (l.log || []).forEach(entry => {
		const parts = String(entry.us).split('/');
		let tot = 0;
		parts.forEach(x => { tot += (x === 'X' ? 0 : (Number(x) || 0) / 100); });
		trace.push(tot);
	}));
	return {
		plan: plan,
		legs: chosen.legs,
		cost: chosen.cost,
		trace: trace,
		// Whether every opponent is accounted for. A partial plan is expected to
		// be rebuilt before it runs out, which is what plan-and-repair means.
		complete: chosen === done,
		// The trajectory this plan expects, so a caller can tell whether reality
		// is still following it.
		expect: chosen.legs.map(l => ({fi: l.fi, turns: l.turns, dead: l.dead}))
	};
}

module.exports = {buildGameplan, entryFrom, legCost};
