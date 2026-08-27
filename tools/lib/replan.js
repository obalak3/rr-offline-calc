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
const {pricePath, survivesEntry} = require('./paths.js');

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
		active: state.me.team[state.me.active].set.species,
		turnsOut: state.me.team[state.me.active].turnsOut,
		foeTurnsOut: state.foe.team[fi] && state.foe.team[fi].turnsOut};

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
	// HOW DEEP THE LOOKAHEAD LOOKS. It priced each future opponent's top 5
	// candidates, which is enough from full health -- every opponent's first
	// killing line ranks 0 or 4 there -- but the lookahead runs from a DAMAGED
	// position, where those early lines no longer kill and the ones that still
	// do sit at rank 9, 15, 34, even 51. Below the cut the lookahead concluded
	// "nothing handles this from here" whatever we did, and a constant penalty
	// carries no information: it could not steer the plan toward keeping the
	// Pokemon that would have done the job. That is why every remaining
	// "no plan found" was a Pawmot position.
	//
	// So it scans deeper but stops early: once a few killing lines are found
	// the cheapest is almost certainly among them, and there is no reason to
	// price the rest.
	// MEASURED AT 5, not reasoned to. Scanning deeper finds more killing lines
	// for future opponents and plays STRICTLY WORSE: swept across depths 5, 8,
	// 12 and 30 at three tempo values, every run at 12 and 30 ended in a wipe
	// while depth 5 won at all three. The reason is that the continuation
	// prices each remaining opponent INDEPENDENTLY, so the same healthy
	// Pokemon is assumed to handle all of them; looking deeper mostly finds
	// more lines that quietly reuse a Pokemon already committed elsewhere, and
	// confidence built on that is worse than admitting ignorance.
	//
	// Fixing that properly means pricing the remaining opponents as one
	// combination rather than as separate problems. Until then, 5.
	const LOOKAHEAD = options.lookahead === false ? 0 : (options.lookahead || 5);
	const ENOUGH = options.enough || 3;

	// Candidate generation depends only on WHO we are facing and the field, not
	// on the HP of the position, so it is the same answer every turn of a fight
	// and was being recomputed from scratch for every candidate of every turn.
	// That alone was most of a 41-second decision.
	// THE TARGET'S HP IS PART OF THE QUESTION, so it is part of the key. The
	// note here used to say generation "depends only on WHO we are facing and
	// the field, not on the HP of the position". That is false: whether a line
	// KILLS is entirely a question of how much HP is left, so a table built once
	// against a full-health target can never contain "somebody finishes it now".
	//
	// Watched live at turn 81: Mienshao's Drain Punch had just taken Pawmot to
	// 41 of 99 and the very same move would finish it, but every candidate had
	// been generated against a 99 HP Pawmot, where it is not a kill. No plan
	// said "kill it", so the agent switched instead and Pawmot drained back to
	// 97.
	//
	// Bucketed to a tenth: the cache was most of a 41-second decision and still
	// does its job, while a target that has dropped meaningfully gets a fresh
	// table.
	function cachedCandidates(idx, fld, foeHp) {
		const bucket = foeHp === undefined ? 10 : Math.max(1, Math.ceil(foeHp * 10));
		const key = idx + '|' + (fld && fld.terrainTurns > 0 ? fld.terrain : '-') + '|' + bucket;
		if (!ctx._candCache) ctx._candCache = {};
		if (!ctx._candCache[key]) {
			ctx._candCache[key] = C.candidatesFor(ctx, idx, {field: fld, foeHp: bucket / 10});
		}
		return ctx._candCache[key];
	}

	// killedIdx is -1 when the line did not finish the job -- see the note on
	// pivoting below -- and then nothing extra is marked dead.
	function continuationCost(after, killedIdx) {
		const hpAfter = {}, deadAfter = [];
		after.me.team.forEach(m => {
			hpAfter[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
			if (m.fainted) deadAfter.push(m.set.species);
		});
		const foeDeadAfter = [];
		after.foe.team.forEach((m, i) => { if (m.fainted) foeDeadAfter.push(i); });
		if (killedIdx >= 0 && !foeDeadAfter.includes(killedIdx)) foeDeadAfter.push(killedIdx);
		const entryAfter = {
			hp: hpAfter, dead: deadAfter, foeDead: foeDeadAfter,
			field: {terrain: after.field.terrain, terrainTurns: after.field.terrainTurns},
			active: after.me.team[after.me.active].set.species,
			turnsOut: after.me.team[after.me.active].turnsOut
		};
		let total = 0;
		for (let gi = 0; gi < ctx.foeSets.length; gi++) {
			if (foeDeadAfter.includes(gi)) continue;
			let cheapest = null;
			let ahead;
			try {
				const fm = after.foe.team[gi];
				ahead = cachedCandidates(gi, entryAfter.field,
					fm && fm.maxHP ? fm.curHP / fm.maxHP : undefined);
			}
			catch (e) { continue; }
			let found = 0;
			for (const cand of ahead.slice(0, LOOKAHEAD)) {
				if (found >= ENOUGH) break;
				if (!cand.jobs.length) continue;
				if (cand.jobs.every(j => deadAfter.includes(j.mon))) continue;
				let rr;
				try { rr = pricePath(ctx, gi, cand.jobs, entryAfter, {expendable}); }
				catch (e) { continue; }
				if (!rr.kills) continue;
				found++;
				let sp = 0;
				for (const k in rr.spend) sp += Math.max(0, rr.spend[k]);
				const bad = rr.dead.filter(n => !expendable.includes(n)).length;
				const c = sp + bad * 6 + 2 * rr.deathRisk
					+ (options.tempo === undefined ? 0.4 : options.tempo) * (rr.turns || 0);
				if (cheapest === null || c < cheapest) cheapest = c;
			}
			// Nothing kills it from here. That is the expensive outcome and the
			// whole reason for looking ahead at all.
			total += (cheapest === null) ? 8 : cheapest;
		}
		return total;
	}

	// STICK TO A PLAN UNLESS BEATEN PROPERLY. Re-planning from scratch every
	// turn let a different line win each time, and since almost every line
	// opens by bringing in the Pokemon that does the work, the agent switched,
	// re-planned, switched again and never arrived: 69 of 120 decisions were
	// switches and one run went 41 deep. The lines were individually sensible
	// and the sequence was worthless, which is what makes this a planning bug
	// rather than a scoring one -- nothing was ever wrong enough to notice on a
	// single turn.
	//
	// The incumbent therefore carries a margin. A challenger has to be better
	// by more than the cost of the switch it is proposing, not merely better,
	// which is the same standard a person applies when they have already
	// committed to a line.
	const incumbent = options.incumbent ? JSON.stringify(options.incumbent) : null;
	const STICK = options.stick === undefined ? 0.75 : options.stick;
	// Function-scoped: the no-kill fallback below uses these too, and when they
	// lived inside the loop every fallback turn threw "SPEND is not defined"
	// and the agent silently fell through to one-turn greedy scoring -- 24
	// times in the live log, all on the hardest positions.
	const TEMPO = options.tempo === undefined ? 0.4 : options.tempo;
	const SPEND = options.spend === undefined ? 2 : options.spend;

	let best = null;
	const shortlist = [];
	const foeMon = state.foe.team[fi];
	const ideas = cachedCandidates(fi, field,
		foeMon && foeMon.maxHP ? foeMon.curHP / foeMon.maxHP : undefined);
	for (const cand of ideas) {
		if (!cand.jobs.length) continue;
		if (cand.jobs.every(j => dead.includes(j.mon))) continue;
		let r;
		try { r = pricePath(ctx, fi, cand.jobs, entry, {expendable}); }
		catch (e) { continue; }
		// A POKEMON THAT PIVOTS OUT HAS NOT BEATEN US. Requiring every line to
		// end in a kill threw away every line against Vikavolt, whose set is
		// Volt Switch / Bug Buzz / Roost / Mud Shot: it leaves on its own, so
		// 39 of its 48 candidate lines ended 'left' and only 2 ended 'kill'.
		// With the survivors gone the planner reported no plan at all and the
		// turn fell through to one-turn scoring -- greedy play, on one of the
		// two hardest members of the team, which is exactly the situation the
		// planner exists for.
		//
		// Leaving the field alive is a real outcome, not a failure: the line
		// still did its damage and still left us somewhere. It costs nothing
		// invented to price it, because the lookahead below already charges for
		// killing everyone still standing -- and a pivoting Vikavolt IS still
		// standing, so the cost of finishing it later is counted there. A line
		// that kills outright removes that charge and wins on its own merits.
		const finished = r.kills;
		if (!finished && r.outcome !== 'left') continue;
		// ALLOWED TO DIE IS NOT FREE TO DIE. An expendable death cost exactly
		// zero, so the planner spent Lilligant the moment it was convenient --
		// and Lilligant is the answer to Pawmot, whose killing lines nearly all
		// want Baby-Doll Eyes or Sleep Powder. Spend it early and there is no
		// answer left, which is why Mienshao then dies too: the live record is
		// Mienshao AND Lilligant in 7 of 11 fights.
		//
		// James put the standard plainly: neither of them has to die. The cap
		// says Lilligant MAY be lost, not that losing it is costless, so it
		// carries a real price that is simply far below a forbidden death.
		const spent = r.dead.filter(n => expendable.includes(n));
		const illegal = r.dead.filter(n => !expendable.includes(n));
		let spend = 0;
		for (const k in r.spend) spend += Math.max(0, r.spend[k]);
		// A path that kills somebody it may not is not ranked below the others,
		// it is ranked out -- unless nothing else kills at all, in which case
		// something has to be done and the cheapest disaster is still a choice.
		// A TURN IS NOT FREE. The only currency here was HP, so a switch that
		// costs no HP costs nothing at all -- and Lanturn has Volt Absorb, so
		// switching it into an Electric move is literally free by that measure.
		// Followed offline, the planner ping-ponged Lanturn and Lilligant for
		// twelve consecutive turns while Pincurchin stood untouched at 95 HP,
		// each individual switch defensible and the sequence worthless.
		//
		// Every turn spent hands the opponent a free action, which is the cost
		// that was missing, so a line pays for its own length. This is what
		// stops a plan from admiring its position instead of executing it.
		// 0.4, chosen by sweeping it and playing the whole fight out at each
		// value rather than by taste. At 0 the team is WIPED (six deaths, three
		// of theirs still standing); at 0.12 and 0.25 the fight is won but
		// Diggersby and Breloom are spent; at 0.4 it is won losing Lanturn and
		// Lilligant, which is one forbidden death instead of two; at 1.3 it
		// collapses again into a wipe. The metric was the cap James set --
		// win, losing nobody but Lilligant -- not the score.
		let here = spend + illegal.length * 6 + spent.length * SPEND
			+ 4 * r.deathRisk + TEMPO * (r.turns || 0);
		if (incumbent && JSON.stringify(cand.jobs) === incumbent) here -= STICK;
		shortlist.push({here, cand, r, illegal, finished});
	}
	// Looking ahead is the expensive part, so it is spent only on the handful of
	// lines that could plausibly win. Pricing the immediate kill is cheap;
	// pricing the rest of the fight is not.
	shortlist.sort((a, b) => a.here - b.here);
	const FINALISTS = options.finalists || 4;
	shortlist.slice(0, FINALISTS).forEach(item => {
		let ahead = 0;
		if (LOOKAHEAD && item.r.state) {
			try { ahead = continuationCost(item.r.state, item.finished ? fi : -1); }
			catch (e) { ahead = 0; }
		}
		const score = item.here + ahead;
		if (!best || score < best.score) {
			best = {score, here: item.here, ahead, cand: item.cand, r: item.r,
				illegal: item.illegal};
		}
	});
	// NOTHING KILLS IT? THEN DO THE BEST YOU CAN, still inside the planner.
	// Requiring a kill (or a pivot) is what produced "no plan found", and every
	// one of those turns fell through to one-turn scoring, which has no notion
	// of a turn costing anything. That is where the switch spam lived: against
	// Pawmot the agent rotated Lanturn, Victreebel, Mienshao, Diggersby and
	// Breloom through it while Pawmot healed with Drain Punch -- 58, 65, 43,
	// 56, 71 -- because each individual switch looked free.
	//
	// The fix is not another penalty in the fallback, it is to stop needing the
	// fallback. A line that only chips is still a line, and pricing it here
	// means it is charged for its turns like everything else.
	if (!shortlist.length) {
		for (const cand of ideas) {
			if (!cand.jobs.length) continue;
			if (cand.jobs.every(j => dead.includes(j.mon))) continue;
			let r;
			try { r = pricePath(ctx, fi, cand.jobs, entry, {expendable}); }
			catch (e) { continue; }
			const spent2 = r.dead.filter(n => expendable.includes(n));
			const illegal2 = r.dead.filter(n => !expendable.includes(n));
			let spend2 = 0;
			for (const k in r.spend) spend2 += Math.max(0, r.spend[k]);
			// How much of it is still standing at the end -- the progress this
			// line actually made, in the same units as everything else.
			const left = r.state && r.state.foe.team[fi]
				? r.state.foe.team[fi].curHP / r.state.foe.team[fi].maxHP : 1;
			const here2 = spend2 + illegal2.length * 6 + spent2.length * SPEND
				+ 4 * r.deathRisk + TEMPO * (r.turns || 0) + 6 * left;
			shortlist.push({here: here2, cand, r, illegal: illegal2, finished: false});
		}
		shortlist.sort((a, b) => a.here - b.here);
		if (shortlist.length) {
			const it = shortlist[0];
			best = {score: it.here, here: it.here, ahead: 0, cand: it.cand, r: it.r,
				illegal: it.illegal};
		}
	}
	if (!best && shortlist.length) {
		const it = shortlist[0];
		best = {score: it.here, here: it.here, ahead: 0, cand: it.cand, r: it.r,
			illegal: it.illegal};
	}
	if (!best) return null;

	// The first action of the winning path, taken from the same policy code
	// that would have executed it, so the choice and the pricing cannot drift.
	//
	// AND IT MUST SURVIVE ITS OWN FIRST TURN. pricePath refuses lethal-entry
	// switches INSIDE a path, but the action returned here is derived fresh
	// from the current state, so a switch that walks the incoming Pokemon into
	// the predicted hit could still be played -- which is how Lilligant, the
	// answer to Pawmot, was fed to Pawmot's Drain Punch as an "enabler". This
	// check used to live in agent.js as an external veto; James's standard is
	// that this stuff is internal to the AI, and internal means here: the
	// planner walks its shortlist in score order and returns the best line
	// whose first action is not a death on arrival.
	const theirsNow = predictFoe(engine, state);
	const firstAction = item => {
		const plan = {};
		plan[state.foe.team[fi].set.species] = item.cand.jobs;
		return P.planAction(engine, state, plan, P.newProgress());
	};
	const ranked = shortlist.slice().sort((a, b) => a.here - b.here);
	if (best && !ranked.some(x => x.cand === best.cand)) ranked.unshift(best);
	else if (best) ranked.splice(ranked.findIndex(x => x.cand === best.cand), 1),
		ranked.unshift(best);
	// WHAT WOULD STAYING HAVE COST? A switch hands the opponent a free move, so
	// one taken for a hair's advantage is a needless switch -- and needless
	// switches, not the deliberate absorb pivot, are what make the agent look
	// like it is dithering. This does not change the choice; it records the
	// margin so the next one can be judged from the log instead of guessed at.
	let stay = null;
	for (const item of ranked) {
		const a = firstAction(item);
		if (a && a.type !== 'switch') { stay = {score: item.here, why: item.cand.why}; break; }
	}
	for (const item of ranked) {
		const action = firstAction(item);
		if (!action) continue;
		if (action.type === 'switch'
			&& !survivesEntry(engine.B, state, action.index, theirsNow)) continue;
		const path = item === best ? best
			: {score: item.here, here: item.here, ahead: 0, cand: item.cand,
				r: item.r, illegal: item.illegal};
		return {action, path, stay,
			margin: (stay && action.type === 'switch') ? (stay.score - item.here) : null};
	}
	return null;
}

/** Their argmax action from this position, for the entry-survival check. */
function predictFoe(engine, state) {
	try {
		const sc = engine.sandbox.RRAI.scoreAll(state, 'foe',
			{checkBadMove: true, checkGoodMove: true}, {});
		if (!sc.length) return null;
		let bs = -Infinity;
		sc.forEach(e => { if (e.score > bs) bs = e.score; });
		return sc.find(e => e.score === bs).action;
	} catch (e) { return null; }
}

module.exports = {chooseAction};
