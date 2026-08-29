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

/**
 * The price of a turn, DERIVED FROM THE POSITION instead of tuned.
 *
 * TEMPO=0.4 was fitted by sweeping whole episodes and James called it out:
 * "this stuff should be internal to the ai not external rules for surge."
 * The internal quantity it was approximating is what a turn actually hands
 * the opponent -- one free action. So the rate is measured, per position:
 * the median damage of the standing foe's best committed damaging move
 * against our current active, as a fraction of that active's max HP, capped
 * at the HP it actually has left. Dawdling in front of Pincurchin (kills
 * nobody) is near-free; dawdling in front of Pawmot is not; a Volt Absorb
 * body in front of an Electric attacker prices the turn at zero, which is
 * exactly why the absorb pivot is good. 0.4, it turns out, is about what a
 * typical mid-fight hit takes -- the sweep had rediscovered the average of
 * this quantity.
 *
 * Enabled by RR_DERIVED_TEMPO=1 so the fixed-0.4 baseline and the derived
 * version can be compared on live episodes, the same A/B pattern as
 * RR_NO_CHIP_CHAINS.
 */
function turnRate(engine, state, foeIdx) {
	const B = engine.B;
	let probe = state;
	if (state.foe.active !== foeIdx) {
		probe = B.clone(state);
		probe.foe.active = foeIdx;
	}
	const foe = probe.foe.team[foeIdx];
	if (!foe || foe.fainted) return 0;
	const active = probe.me.team[probe.me.active];
	if (!active || active.fainted) return 0;
	let worst = 0;
	for (const mv of foe.set.moves || []) {
		const d = B.moveData(mv);
		if (d && d.effect && d.effect.kind === 'selfSwitch') continue;
		let r;
		try { r = B.damageRolls(probe, 'foe', mv); } catch (e) { continue; }
		if (!r || r.immune || !r.noCrit || !r.noCrit.length) continue;
		const med = r.noCrit[Math.floor(r.noCrit.length / 2)] * (r.hits || 1);
		const frac = Math.min(med, active.curHP) / active.maxHP;
		if (frac > worst) worst = frac;
	}
	return worst;
}

/**
 * THE MARKET IS NEVER EMPTY. A legal action always exists, and pricing one is
 * exactly what pricePath does, so "no plan found" should be impossible.
 *
 * Generation can now honestly return NOTHING -- once it reads the real
 * position, a 13 HP Breloom and a 3 HP Victreebel facing a full-health
 * Manectric produce no killing line, because there is none. The old full-HP
 * fiction always invented one. Returning null there dropped the turn into
 * one-turn greedy scoring, which has no notion of a turn costing anything and
 * is where the switch spam has always lived.
 *
 * So when generation is silent, every legal action becomes a one-line
 * candidate and goes through the same pricer as everything else. The position
 * may be lost; the decision is still measured rather than guessed.
 */
function bareCandidates(engine, state) {
	const B = engine.B;
	const active = state.me.team[state.me.active];
	const out = [];
	const seen = {};
	B.legalActions(state, 'me').forEach(a => {
		if (a.type === 'move') {
			if (!active || active.fainted || seen['m' + a.move]) return;
			seen['m' + a.move] = true;
			out.push({jobs: [{mon: active.set.species, moves: [a.move]}],
				why: 'nothing kills it: ' + a.move, score: 9});
		} else if (a.type === 'switch') {
			const t = state.me.team[a.index];
			if (!t || t.fainted || seen['s' + a.index]) return;
			seen['s' + a.index] = true;
			out.push({jobs: [{mon: t.set.species, moves: ['*']}],
				why: 'nothing kills it: bring in ' + t.set.species, score: 9});
		}
	});
	return out;
}

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
	// AND THE TARGET'S OWN HP. This block said "everyone's HP" and recorded
	// ours plus who was dead on theirs -- the damage already done to the
	// Pokemon we are trying to remove was simply dropped, so pricePath rebuilt
	// the board with it at FULL HEALTH and every candidate was priced against a
	// fight that was not the one in front of us.
	//
	// It is the same mistake as the candidate cache being keyed without HP, in
	// a second place: generation and pricing each kept their own idea of the
	// position and disagreed. Live at turn 81 that meant a Pawmot on 41 of 99
	// was priced as a Pawmot on 99, so "finish it now" never won.
	// AND WHAT IS WRONG WITH THEM. `pricePath` has always accepted an entry
	// status map and NOTHING EVER FILLED IT, so every plan on this project has
	// been priced against a team with no paralysis, no burn, no poison and no
	// sleep. James caught it from the log: the planner offered "Mienshao Drain
	// Punch kills it, 0% death" for a Mienshao that was paralysed at 35 of 98,
	// where paralysis halves its Speed to Vikavolt's and costs it a quarter of
	// its turns outright. Burned Breloom on 8 HP read as a healthy attacker the
	// same way.
	//
	// This is the recurring shape once more: createState builds a clean team,
	// and anything the live position carries has to be handed over explicitly
	// or it is silently dropped.
	const status = {};
	state.me.team.forEach(m => { if (m.status) status[m.set.species] = m.status; });
	// AND WHAT IS WRONG WITH THE FOE. The entry carried the target's HP and
	// nothing else about it, so a BURNED Pawmot was re-simulated unburned and
	// the -1 Attack Baby-Doll Eyes had already banked was re-simulated away --
	// every turn. That is why the atk-drop looked necessary forever: in the
	// rebuilt world the debuff never sticks and the burn never happened, so
	// the ritual (Lilligant drops, Diggersby slows, closer kills) kept
	// outpricing "it is at 40%, burned, halved Attack: just kill it". James
	// caught it live against a burned Pawmot.
	//
	// LIFETIMES MATTER, his warning verbatim: boosts are removed when the
	// holder switches out; status and HP persist. So status is carried for
	// the whole foe party, but boosts only for the Pokemon actually on the
	// field (both sides), and the engine zeroes them on exit like the real
	// game, so nothing here outlives its real lifetime.
	const foeStatus = {};
	state.foe.team.forEach((m, i) => { if (m.status && !m.fainted) foeStatus[i] = m.status; });
	const target = state.foe.team[fi];
	const entry = {hp, dead, foeDead, field, status, foeStatus,
		active: state.me.team[state.me.active].set.species,
		turnsOut: state.me.team[state.me.active].turnsOut,
		foeTurnsOut: state.foe.team[fi] && state.foe.team[fi].turnsOut};
	// RR_ENTRY_MASK: comma list to DISABLE entry ingredients for bisection
	// (diagnostic only): status,foeStatus,foeBoosts,myBoosts,myPP,threats
	const mask = (process.env.RR_ENTRY_MASK || '').split(',');
	if (mask.includes('status')) entry.status = {};
	if (mask.includes('foeStatus')) entry.foeStatus = {};
	if (target && !mask.includes('foeBoosts')) entry.foeBoosts = Object.assign({}, target.boosts);
	const myActive = state.me.team[state.me.active];
	if (myActive && !mask.includes('myBoosts')) entry.myBoosts = Object.assign({}, myActive.boosts);
	if (myActive && myActive.pp && !mask.includes('myPP')) entry.myPP = myActive.pp.slice();
	if (target && target.maxHP && target.curHP < target.maxHP) {
		entry.foeChip = 1 - (target.curHP / target.maxHP);
	}

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
	// RR_NO_LOOKAHEAD=1 answers "how many of our switches are caused by the
	// lookahead rather than by the position in front of us". The lookahead is
	// the crudest term in the score -- it prices each remaining opponent
	// INDEPENDENTLY, so one healthy Pokemon is assumed to answer all of them,
	// and returns a flat 8 when it finds nothing.
	const LOOKAHEAD = (options.lookahead === false || process.env.RR_NO_LOOKAHEAD)
		? 0 : (options.lookahead || 5);
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
		// Status carries into the rest of the fight too: a Pokemon that ends
		// this line paralysed is still paralysed when the next one arrives, and
		// the lookahead was pricing it as cured.
		const statusAfter = {};
		after.me.team.forEach(m => {
			if (m.status && !m.fainted) statusAfter[m.set.species] = m.status;
		});
		// Status persists on their bench too (a Pawmot burned in this line is
		// still burned when it comes back); boosts deliberately do NOT carry
		// into the continuation -- a future opponent enters fresh, and our own
		// active's stages will have been cleared by whatever switching the
		// next duel opens with.
		const foeStatusAfter = {};
		after.foe.team.forEach((m, i) => {
			if (m.status && !m.fainted) foeStatusAfter[i] = m.status;
		});
		const entryAfter = {
			hp: hpAfter, dead: deadAfter, foeDead: foeDeadAfter, status: statusAfter,
			foeStatus: foeStatusAfter,
			field: {terrain: after.field.terrain, terrainTurns: after.field.terrainTurns},
			active: after.me.team[after.me.active].set.species,
			turnsOut: after.me.team[after.me.active].turnsOut
		};
		// Each remaining opponent is priced from the HP it actually has left.
		const foeHpAfter = {};
		after.foe.team.forEach((m, i) => {
			if (m && m.maxHP && !m.fainted) foeHpAfter[i] = m.curHP / m.maxHP;
		});
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
				const eAfter = (foeHpAfter[gi] !== undefined && foeHpAfter[gi] < 1)
					? Object.assign({}, entryAfter, {foeChip: 1 - foeHpAfter[gi]})
					: entryAfter;
				try { rr = pricePath(ctx, gi, cand.jobs, eAfter, {expendable}); }
				catch (e) { continue; }
				if (!rr.kills) continue;
				found++;
				let sp = 0;
				for (const k in rr.spend) sp += Math.max(0, rr.spend[k]);
				const bad = rr.dead.filter(n => !expendable.includes(n)).length;
				const rate = process.env.RR_DERIVED_TEMPO
					? turnRate(engine, after, gi)
					: (options.tempo === undefined ? 0.4 : options.tempo);
				const c = sp + bad * 6 + 2 * rr.deathRisk + rate * (rr.turns || 0);
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
	const TEMPO = process.env.RR_DERIVED_TEMPO
		? turnRate(engine, state, fi)
		: (options.tempo === undefined ? 0.4 : options.tempo);
	const SPEND = options.spend === undefined ? 2 : options.spend;

	// WHAT MIGHT ACTUALLY HIT A SWITCH-IN. The entry turn is the one turn
	// where their choice is uncertain to us: the ROM AI picks its move looking
	// at the OUTGOING Pokemon, and our port of that choice is right 56% of the
	// time. Measured over the turn archive: of 602 switch-ins that took real
	// damage, 219 were hit by a move we had NOT predicted (Volt Switch
	// predicted, Bug Buzz arrived; Hidden Power predicted, Flame Burst
	// arrived). So a line that opens with a switch is priced against the most
	// damaging move in RRAI.plausible's margin set -- their real candidates,
	// not every move they own -- and the damage flows into the plan's own
	// simulation. A Breloom that arrives at 15 HP and cannot do its job any
	// more prices itself out; a genuine absorb pivot, where nothing plausible
	// hurts the incoming, stays free. Computed once; the position is the same
	// for every candidate.
	let entryThreats = null;
	if (!mask.includes('threats'))
	try {
		entryThreats = engine.sandbox.RRAI.plausible(state, 'foe').actions
			.filter(a => a.type === 'move' && !(function () {
				const d = engine.B.moveData(a.move);
				return d && d.effect && d.effect.kind === 'selfSwitch';
			})());
		if (!entryThreats.length) entryThreats = null;
	} catch (e) { entryThreats = null; }

	let best = null;
	const shortlist = [];
	const foeMon = state.foe.team[fi];
	// THE PRIMARY MARKET IS GENERATED FROM THE REAL POSITION -- exact foe HP,
	// our actual party HP and statuses -- not from the cache's fiction of a
	// full-health team and a foe rounded to tenths. Which lines EXIST was
	// being decided in that fiction: a 3 HP Lanturn still offered to chip, a
	// line present at foe-bucket 5 vanished at bucket 4 one turn later, and
	// the market's membership flickered with the rounding, which is the churn
	// James kept catching. The bucketed cache stays for the LOOKAHEAD, where
	// hundreds of speculative future positions make coarseness the right
	// trade; the one market whose winner gets PLAYED sees the world as it is.
	const ourHp = {}, ourStatus = {};
	state.me.team.forEach(m => {
		ourHp[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
		if (m.status && !m.fainted) ourStatus[m.set.species] = m.status;
	});
	let ideas = C.candidatesFor(ctx, fi, {field,
		foeHp: foeMon && foeMon.maxHP ? foeMon.curHP / foeMon.maxHP : undefined,
		ourHp, ourStatus});
	// THE PLAN WE ARE ALREADY FOLLOWING IS ALWAYS ON THE TABLE. Candidates are
	// re-derived by a heuristic search every turn, and that search is not
	// stable under small changes in HP: measured over recent play, on 43% of
	// the turns where the plan changed, last turn's plan was NOT REGENERATED
	// AT ALL. It did not lose the comparison, it ceased to exist -- so the
	// incumbent discount had nothing to apply to and no value of STICK could
	// have held the line. That is the mechanism behind switching under one
	// plan and then forming another: 85% of switches happen on a turn whose
	// plan differs from the turn before.
	//
	// This does not decide anything. The incumbent is merely re-offered so it
	// is PRICED against the alternatives from the current position; if it is
	// genuinely worse it still loses, exactly as before.
	if (options.incumbent && options.incumbent.length) {
		const inc = JSON.stringify(options.incumbent);
		if (!ideas.some(c => JSON.stringify(c.jobs) === inc)) {
			ideas = ideas.concat([{jobs: options.incumbent,
				why: 'the plan already being followed', score: 9}]);
		}
	}

	// Generation signals defeat with a SENTINEL candidate carrying zero jobs
	// ("NO KILL AVAILABLE against X"), so the list is length 1 rather than
	// empty. Test for a PLAYABLE idea, not for a non-empty list.
	if (!ideas.some(c => c.jobs && c.jobs.length)) {
		ideas = ideas.concat(bareCandidates(engine, state));
	}
	const drops = process.env.RR_EXPLAIN ? {} : null;
	const drop = (why) => { if (drops) drops[why] = (drops[why] || 0) + 1; };
	if (drops && process.env.RR_EXPLAIN_IDEAS) {
		ideas.forEach(c => console.log('[explain] idea: jobs=' + c.jobs.length
			+ ' | ' + c.why + ' | ' + JSON.stringify(c.jobs)));
	}
	for (const cand of ideas) {
		if (!cand.jobs.length) { drop('empty jobs'); continue; }
		// ANY dead leg disqualifies the candidate, not just all of them. The
		// executor skips dead legs, so "Lanturn absorbs, then Victreebel
		// kills" with Lanturn dead silently becomes "switch to Victreebel" --
		// but keeps the absorb label and the absorb story in its price, and
		// James watched exactly that plan win six straight turns. Its honest
		// twin without the dead leg is generated separately and can compete
		// under its own name.
		if (cand.jobs.some(j => dead.includes(j.mon))) { drop('dead leg'); continue; }
		let r;
		try { r = pricePath(ctx, fi, cand.jobs, entry, {expendable, entryThreats}); }
		catch (e) { drop('threw: '+e.message); continue; }
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
		if (!finished && r.outcome !== 'left') {
			// A LINE THAT DIED MID-EXECUTION IS PRICED AS WRECKAGE, not
			// discarded. Since entries eat the worst plausible move instead of
			// being vetoed, a fatal switch-in continues the simulation, the
			// follow-up legs (also nearly dead) return nothing, and the line
			// ends 'stuck' -- WITH a real body and real damage already on the
			// books. Dropping those lines silently deleted 48 of 49 candidates
			// at live turn 2035 and left a market of one: the Lanturn
			// sacrifice, played into a 3 HP Lanturn while Mienshao had the
			// kill in front of it. Wreckage is priced with the same formula
			// the no-kill fallback has always used -- spend, deaths, risk,
			// tempo, and 6 * the target's remaining fraction -- so it competes
			// honestly and loses to any line that actually works. Lines that
			// never executed a turn (entry blocked at the door) stay dropped.
			if (!r.turns || !r.log || !r.log.length) {
				drop(r.outcome + (r.blockedEntries ? ' (entry blocked)' : '')
					+ ' | ' + cand.why);
				continue;
			}
			const spentW = r.dead.filter(n => expendable.includes(n));
			const illegalW = r.dead.filter(n => !expendable.includes(n));
			let spendW = 0;
			for (const k in r.spend) spendW += Math.max(0, r.spend[k]);
			const leftW = r.state && r.state.foe.team[fi]
				? r.state.foe.team[fi].curHP / r.state.foe.team[fi].maxHP : 1;
			const hereW = spendW + illegalW.length * 6 + spentW.length * SPEND
				+ 4 * r.deathRisk + TEMPO * (r.turns || 0) + 6 * leftW;
			shortlist.push({here: hereW, cand, r, illegal: illegalW, finished: false});
			continue;
		}
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
		item.ahead = ahead;
		if (!best || score < best.score) {
			best = {score, here: item.here, ahead, cand: item.cand, r: item.r,
				illegal: item.illegal};
		}
	});
	// RR_EXPLAIN=1 prints the whole market: every finalist's price split into
	// its parts, plus the simulated line, so a bad decision can be read
	// instead of guessed at.
	if (process.env.RR_EXPLAIN) {
		if (drops) console.log('[explain] dropped: ' + JSON.stringify(drops)
			+ ' ideas=' + ideas.length + ' shortlist=' + shortlist.length
			+ ' best=' + (best ? 'yes' : 'no'));
		console.log('[explain] turn price ' + TEMPO.toFixed(2)
			+ (process.env.RR_DERIVED_TEMPO ? ' (derived from position)' : ' (fixed)'));
		// RR_EXPLAIN_N raises the printed depth; RR_EXPLAIN_GREP filters to
		// candidates whose description contains a substring, which is how you
		// ask "was this line even in the market, and what did it price at?"
		const grep = process.env.RR_EXPLAIN_GREP;
		const depth = grep ? shortlist.length
			: Math.max(FINALISTS, Number(process.env.RR_EXPLAIN_N) || 8);
		shortlist.slice(0, depth)
			.filter(it => !grep || (it.cand.why || '').includes(grep))
			.forEach((item, i) => {
			const r = item.r;
			let sp = 0;
			for (const k in r.spend) sp += Math.max(0, r.spend[k]);
			console.log('[explain] #' + i + ' here=' + item.here.toFixed(2)
				+ (item.ahead !== undefined ? ' ahead=' + item.ahead.toFixed(2) : ' ahead=?')
				+ ' | spend=' + sp.toFixed(2)
				+ ' illegalDead=' + JSON.stringify(item.illegal)
				+ ' dead=' + JSON.stringify(r.dead)
				+ ' deathRisk=' + r.deathRisk.toFixed(2)
				+ ' turns=' + r.turns + ' outcome=' + r.outcome
				+ ' | ' + item.cand.why);
			(r.log || []).forEach(l => console.log('[explain]      t' + l.turn
				+ ' we ' + l.we + ' / they ' + l.they
				+ '  us ' + l.us + '  them ' + l.them));
		});
	}
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
		// NOTHING SURVIVED THE FILTERS, which is not the same as nothing
		// having been generated -- the guard above only covers an empty
		// market. Ideas whose every leg was unusable leave the shortlist
		// empty just as surely, so the last-resort actions are appended here
		// too, before the no-kill pricing runs over them.
		if (!ideas.some(c => c.jobs && c.jobs.length
			&& !c.jobs.some(j => dead.includes(j.mon)))) {
			ideas = ideas.concat(bareCandidates(engine, state));
		}
		for (const cand of ideas) {
			if (!cand.jobs.length) continue;
			// ANY dead leg disqualifies the candidate, not just all of them. The
		// executor skips dead legs, so "Lanturn absorbs, then Victreebel
		// kills" with Lanturn dead silently becomes "switch to Victreebel" --
		// but keeps the absorb label and the absorb story in its price, and
		// James watched exactly that plan win six straight turns. Its honest
		// twin without the dead leg is generated separately and can compete
		// under its own name.
		if (cand.jobs.some(j => dead.includes(j.mon))) continue;
			let r;
			try { r = pricePath(ctx, fi, cand.jobs, entry, {expendable, entryThreats}); }
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
		// The fallback market was invisible: the explain dump covered only the
		// killing shortlist, and the Mienshao/Victreebel churn against a
		// 52-HP Pawmot turned out to live entirely down here, where nobody
		// could read the prices.
		if (process.env.RR_EXPLAIN) {
			console.log('[explain] NO-KILL FALLBACK market:');
			shortlist.slice(0, 8).forEach((item, i) => {
				const r = item.r;
				let sp = 0;
				for (const k in r.spend) sp += Math.max(0, r.spend[k]);
				console.log('[explain] #' + i + ' here=' + item.here.toFixed(2)
					+ ' | spend=' + sp.toFixed(2)
					+ ' illegalDead=' + JSON.stringify(item.illegal)
					+ ' deathRisk=' + r.deathRisk.toFixed(2)
					+ ' turns=' + r.turns + ' outcome=' + r.outcome
					+ ' foeLeft=' + (r.state && r.state.foe.team[fi]
						? Math.round(100 * r.state.foe.team[fi].curHP
							/ r.state.foe.team[fi].maxHP) + '%' : '?')
					+ ' | ' + item.cand.why);
				(r.log || []).forEach(l => console.log('[explain]      t' + l.turn
					+ ' we ' + l.we + ' / they ' + l.they
					+ '  us ' + l.us + '  them ' + l.them));
			});
		}
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
	if (!best) {
		console.log('  [no plan: NO BEST. shortlist=' + shortlist.length
			+ ' ideas=' + ideas.length
			+ ' playableIdeas=' + ideas.filter(c => c.jobs && c.jobs.length
				&& !c.jobs.some(j => dead.includes(j.mon))).length + ']');
		return null;
	}

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
	// A REPLACEMENT IS NOT A SWITCH -- kept as history because it cost a
	// whole collapse to learn. When our active has fainted the only legal
	// actions are switches and the incoming Pokemon takes NO hit: the
	// opponent already moved this turn, which is what killed the last one.
	// The death-on-arrival veto used to fire here anyway and vetoed
	// EVERYTHING, live at turn 145 throwing away five killing lines and
	// dropping the turn into greedy one-turn scoring, which fed Lilligant
	// and then Breloom in one at a time. The veto is gone entirely now, so
	// the replacement case needs no special pleading.
	const firstAction = item => {
		const plan = {};
		plan[state.foe.team[fi].set.species] = item.cand.jobs;
		return P.planAction(engine, state, plan, P.newProgress());
	};
	// THE FALLBACK ORDER IS THE SAME YARDSTICK THAT PICKED THE WINNER. This
	// list used to be sorted by `here` alone -- the immediate cost -- while
	// `best` was chosen on `here + ahead`. So the moment the winner could not
	// be played, the turn was handed to a list ranked by a criterion the
	// planner had already rejected, and the lookahead silently stopped
	// mattering. Finalists carry `ahead`; nothing else was ever judged on the
	// full criterion, so the judged lines come first, in total order, and the
	// unjudged follow by immediate cost.
	const totalOf = it => it.here + (it.ahead === undefined ? 0 : it.ahead);
	const judged = shortlist.filter(x => x.ahead !== undefined)
		.sort((a, b) => totalOf(a) - totalOf(b));
	const unjudged = shortlist.filter(x => x.ahead === undefined)
		.sort((a, b) => a.here - b.here);
	const ranked = judged.concat(unjudged);
	if (best && !ranked.some(x => x.cand === best.cand)) ranked.unshift(best);
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
	// NO SECOND VETO AT THE DOOR. This walk used to skip any line whose first
	// action was a switch the incoming Pokemon would not survive -- a reflex
	// that made sense when pricePath REFUSED lethal entries internally and so
	// never priced one. Now every entry is charged the worst plausible move
	// and a death on arrival is priced AS a death, which is strictly more
	// pessimistic than this check ever was. Keeping both meant the market
	// could weigh a deliberate sacrifice, choose it knowing the cost, and
	// then have it thrown out at the door for being what it is: live at turn
	// 2035 the winner was "sacrifice the 7 HP Lilligant, then Mienshao kills
	// Pawmot" (total 14.23, only the permitted death) and the veto skipped it
	// in favour of a line whose own simulation kills Mienshao and leaves
	// Pawmot standing (total 45.72, death risk 1.00). The market is the
	// authority; a line it cannot express an action for is the only reason to
	// move on.
	for (const item of ranked) {
		const action = firstAction(item);
		if (!action) continue;
		const path = item === best ? best
			: {score: item.here, here: item.here, ahead: 0, cand: item.cand,
				r: item.r, illegal: item.illegal};
		return {action, path, stay,
			margin: (stay && action.type === 'switch') ? (stay.score - item.here) : null};
	}
	// WHY THE PLANNER GAVE UP, said out loud. "no plan found" was reaching the
	// log with no reason attached, and offline probes of the very turns that
	// produced it kept finding a perfectly good plan -- so the cause had to be
	// something the live process carries and a fresh probe does not. Printing
	// the shape of the failure costs one line on the rare turns it happens and
	// turns a mystery into a measurement.
	console.log('  [no plan: shortlist=' + shortlist.length
		+ ' ranked=' + ranked.length
		+ ' nullActions=' + ranked.filter(it => !firstAction(it)).length
		+ ' ideas=' + ideas.length + ']');
	return null;
}

module.exports = {chooseAction};
