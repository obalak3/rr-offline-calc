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
	const SEES_US = !!process.env.RR_LOOKAHEAD_SEES_US;
	// RR_NO_DOUBLE_BOOK=1: a Pokemon committed to one remaining opponent is not
	// silently available to answer the next one too.
	const NO_DOUBLE = !!process.env.RR_NO_DOUBLE_BOOK;
	// RR_DEEP_SCAN=<rank>: how far to keep looking for a future opponent AFTER
	// the LOOKAHEAD cut came back empty. 0 disables it, which is the shipped
	// behaviour. See the long note at the flat 8 below for why this is the only
	// safe direction to change that term in. LOOKAHEAD itself is untouched.
	const DEEP_SCAN = Number(process.env.RR_DEEP_SCAN || 0);

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
	// RR_LOOKAHEAD_SEES_US=1 hands the lookahead's generation OUR side's
	// condition, which the primary market has had since the full-health fiction
	// was fixed and this cache never did.
	//
	// The key carried only (opponent, terrain, their HP bucket), so the same
	// candidate table was reused whatever shape our team was in: a 3 HP Lanturn
	// still offered to chip, dead Pokemon still headlined lines, and the
	// ordering the LOOKAHEAD=5 cut acts on was computed against a healthier team
	// than the one we have. That ordering flicker is the measured churn source
	// (a line present at bucket 5 vanishes at bucket 4), and the lookahead is
	// roughly three times the immediate term, so the flicker lives in the big
	// half of the score.
	//
	// Our side is bucketed to quarters in the key. Tenths would be exact and
	// would also destroy the cache that was most of a 41-second decision;
	// quarters keep it useful while letting "we are badly hurt" regenerate.
	function cachedCandidates(idx, fld, foeHp, ourHp, ourStatus) {
		const bucket = foeHp === undefined ? 10 : Math.max(1, Math.ceil(foeHp * 10));
		let key = idx + '|' + (fld && fld.terrainTurns > 0 ? fld.terrain : '-') + '|' + bucket;
		if (SEES_US && ourHp) {
			// COARSE ON PURPOSE. A per-Pokemon quarter-bucket key is exact and
			// destroys the cache: measured, it turned a 90-second pair of
			// episodes into a timeout, because this table being reused is what
			// keeps a decision off the historical 41-second cliff. What
			// generation actually needs to know is who is UNUSABLE and roughly
			// how much team is left, so the key is the dead/near-dead set plus
			// one bucket of total remaining health.
			const gone = Object.keys(ourHp).sort()
				.map(k => (ourHp[k] || 0) <= 0.15 ? 'x' : (ourStatus && ourStatus[k] ? 's' : '.'))
				.join('');
			let tot = 0;
			Object.keys(ourHp).forEach(k => { tot += ourHp[k] || 0; });
			key += '|' + gone + Math.ceil(tot);
		}
		if (!ctx._candCache) ctx._candCache = {};
		if (!ctx._candCache[key]) {
			ctx._candCache[key] = C.candidatesFor(ctx, idx, SEES_US && ourHp
				? {field: fld, foeHp: bucket / 10, ourHp, ourStatus}
				: {field: fld, foeHp: bucket / 10});
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
		// RR_NOANSWER_FLOOR=1: collect the per-opponent answers first, so the
		// no-answer charge can be made a FLOOR rather than a constant. See the
		// note at the flat 8 below.
		const answers = [];
		// WHO IS ALREADY SPOKEN FOR. continuationCost prices each remaining
		// opponent as its own duel, so nothing stopped one healthy Pokemon being
		// the load-bearing killer for several of them at once -- measured on
		// 15.5% of archived positions, and the stated reason deeper search played
		// strictly worse (it finds more lines that quietly reuse a body already
		// committed elsewhere). Under RR_NO_DOUBLE_BOOK the killer of each
		// opponent is struck off before the next is priced, so the sum is a
		// plan the team could actually carry out rather than a set of
		// independently-optimistic promises.
		//
		// Deliberately only the KILLER, not every Pokemon a line touches: a
		// chipper that survives is genuinely still available, and striking off
		// whole lines would swing from optimism to a pessimism nobody measured.
		const spoken = [];
		const ourHpAfter = {}, ourStatusAfter = {};
		after.me.team.forEach(m => {
			ourHpAfter[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
			if (m.status && !m.fainted) ourStatusAfter[m.set.species] = m.status;
		});
		for (let gi = 0; gi < ctx.foeSets.length; gi++) {
			if (foeDeadAfter.includes(gi)) continue;
			let cheapest = null, cheapKiller = null;
			let ahead;
			try {
				const fm = after.foe.team[gi];
				ahead = cachedCandidates(gi, entryAfter.field,
					fm && fm.maxHP ? fm.curHP / fm.maxHP : undefined,
					ourHpAfter, ourStatusAfter);
			}
			catch (e) { continue; }
			let found = 0;
			for (const cand of ahead.slice(0, LOOKAHEAD)) {
				if (found >= ENOUGH) break;
				if (!cand.jobs.length) continue;
				if (cand.jobs.every(j => deadAfter.includes(j.mon))) continue;
				if (NO_DOUBLE && cand.jobs.some(j => spoken.includes(j.mon))) continue;
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
				if (cheapest === null || c < cheapest) {
					cheapest = c;
					// Who actually lands the kill, read off the priced
					// simulation's last turn rather than off the label.
					const lg = rr.log || [];
					cheapKiller = lg.length ? String(lg[lg.length - 1].we).split(' ')[0] : null;
				}
			}
			// LOOK FURTHER ONLY WHERE WE FOUND NOTHING.
			//
			// The flat 8 below is charged when the top LOOKAHEAD candidates
			// contain no killing line. Measured over the archive, scanning EVERY
			// candidate instead of five: **51% of those 8s are an artifact of the
			// cut, not a fact about the fight** (41 of 81 had a killer below rank
			// 5). The rank at which the first killing line appears is 0 for
			// Pincurchin, 1 for Vikavolt, 6 for Pawmot and 18 for
			// Manectric-Mega, which is inside the top 5 only 4% of the time. So
			// "nothing answers Manectric" has mostly meant "we stopped at five".
			//
			// That matters because the 8 is a CONSTANT: identical for every
			// candidate, so it cancels out of the comparison and steers nothing,
			// except where a line flips an opponent across the boundary. On 30 of
			// 58 archived turns the whole spread between competing plans was such
			// a flip, worth 8.21, against a mean spread of 1.02 when no flip was
			// involved. More than half of all decisions are made by which side of
			// a truncated search an opponent happens to land on.
			//
			// Deepening ASYMMETRICALLY is the one change that cannot make the
			// score prefer ignorance. It only ever replaces an 8 with a real
			// number and never creates one, it costs nothing on the continuations
			// that already answer, and it does not touch the constant -- which is
			// what the parked branch ee478e7 did, and what must not be repeated
			// until the invariant below is fixed.
			//
			// It is NOT the same as raising LOOKAHEAD. Uniform deepening also
			// deepens the continuations that already had an answer, which finds
			// more lines that quietly reuse a Pokemon already committed elsewhere
			// (15.5% of positions double-book one Pokemon across two opponents),
			// so it adds false confidence at the same time as it removes false
			// fear. That is the better explanation of "deeper played strictly
			// worse" than double-booking alone.
			//
			// The FIRST killing line found is taken rather than the cheapest of
			// the deep set: the list is ordered by the generator's own score, and
			// stopping early errs toward a DEARER answer, which is the safe
			// direction for a term whose whole job is to be afraid of what it
			// cannot handle.
			if (cheapest === null && DEEP_SCAN > LOOKAHEAD) {
				for (const cand of ahead.slice(LOOKAHEAD, DEEP_SCAN)) {
					if (!cand.jobs.length) continue;
					if (cand.jobs.every(j => deadAfter.includes(j.mon))) continue;
					let rr;
					const eAfter = (foeHpAfter[gi] !== undefined && foeHpAfter[gi] < 1)
						? Object.assign({}, entryAfter, {foeChip: 1 - foeHpAfter[gi]})
						: entryAfter;
					try { rr = pricePath(ctx, gi, cand.jobs, eAfter, {expendable}); }
					catch (e) { continue; }
					if (!rr.kills) continue;
					let sp = 0;
					for (const k in rr.spend) sp += Math.max(0, rr.spend[k]);
					const bad = rr.dead.filter(n => !expendable.includes(n)).length;
					const rate = process.env.RR_DERIVED_TEMPO
						? turnRate(engine, after, gi)
						: (options.tempo === undefined ? 0.4 : options.tempo);
					cheapest = sp + bad * 6 + 2 * rr.deathRisk + rate * (rr.turns || 0);
					break;
				}
			}
			// Nothing kills it from here. That is the expensive outcome and the
			// whole reason for looking ahead at all.
			//
			// KNOWN DEFECT, MEASURED, NOT FIXED HERE: 8 is below the cost of
			// actually answering the opponents that matter. When the lookahead
			// DOES find a way to kill Pawmot inside its cut, that line costs a
			// median of 9.44, so the planner scores "Pawmot cannot be killed from
			// here" as CHEAPER than "Pawmot can be killed from here" and is
			// rewarded for reaching positions where the hardest Pokemon is
			// unanswerable. Vikavolt's p90 is 9.52, the same inversion about a
			// tenth of the time. The repair is a floor, `max(8, dearest answer
			// priced this turn)`, which satisfies the never-cheaper-than-killing
			// invariant BY CONSTRUCTION rather than by assertion -- and it is
			// deliberately a separate change from the deep scan above, measured
			// on its own, because bundling them would make neither attributable.
			// NEVER PRICE IGNORANCE BELOW KNOWLEDGE.
			//
			// The 8 is a constant, and it is below the cost of answering the
			// opponents that matter. Measured over the archive: when the
			// lookahead DOES find a way to kill Pawmot inside its cut, that
			// answer costs more than 8 on 44% of continuations (24 of 55 at
			// n=519), so "Pawmot cannot be killed from here" scores CHEAPER than
			// "Pawmot can be killed from here" nearly half the time it matters.
			// Vikavolt 15%, Manectric-Mega 13%, Pincurchin and Bellibolt 0%. It
			// is the exact defect the parked branch ee478e7 was blamed for, in
			// the code that replaced it.
			//
			// A FLOOR fixes it by construction rather than by assertion: charge
			// at least as much for no answer as the dearest answer we actually
			// priced this turn. It can only ever raise the no-answer cost, never
			// lower it, which is the one direction the evidence supports --
			// RR_DEEP_SCAN, which lowered it by replacing 8s with real numbers,
			// went 27/60 to 8/60 and 7/60. The 8 is load-bearing pessimism, and
			// the useful change is to make it consistently pessimistic instead of
			// arbitrarily so.
			//
			// Derived from the position, not tuned: the number is whatever the
			// dearest killing line in this very continuation costs.
			if (NO_DOUBLE && cheapKiller && !spoken.includes(cheapKiller)) spoken.push(cheapKiller);
			if (process.env.RR_NOANSWER_FLOOR) { answers.push(cheapest); continue; }
			total += (cheapest === null) ? 8 : cheapest;
		}
		if (process.env.RR_NOANSWER_FLOOR) {
			let dearest = 8;
			answers.forEach(c => { if (c !== null && c > dearest) dearest = c; });
			answers.forEach(c => { total += (c === null) ? dearest : c; });
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

	// A LINE TYPED BY THE HUMAN COMPETES; IT IS NOT OBEYED.
	//
	// James: "When I give a path it doesn't mean it is the best option, it is
	// either a query or a suggestion that in most cases will be better than the
	// current options." Both halves of that are served by putting it in the
	// market rather than in front of it. As a suggestion it can simply win, on
	// the same yardstick as everything else. As a query it produces the number
	// that answers "why not this", and separates the two failures that look
	// identical from outside: a line the generator NEVER PROPOSED is a hole in
	// generation, while a line proposed and priced above the winner is a
	// disagreement about value. Those need opposite fixes, and until now
	// nothing could tell them apart.
	//
	// Membership is recorded before the injection, so "was it already on the
	// table" is answered about the market as it would have been without him.
	const userCand = options.userLine && options.userLine.length
		? {jobs: options.userLine, why: 'YOUR LINE', score: 9} : null;
	let userAlready = null;
	if (userCand) {
		const key = JSON.stringify(userCand.jobs);
		const twin = ideas.find(c => JSON.stringify(c.jobs) === key);
		userAlready = twin ? (twin.why || 'unnamed') : null;
		if (!twin) ideas = ideas.concat([userCand]);
	}

	const drops = process.env.RR_EXPLAIN ? {} : null;
	// Which candidate is being priced right now, so a drop can be attributed.
	// Every `continue` in the loop below already announces its reason; this
	// just remembers the one that belongs to the human's line.
	let current = null, userDrop = null;
	const drop = (why) => {
		if (userCand && current === userCand) userDrop = why;
		if (drops) drops[why] = (drops[why] || 0) + 1;
	};
	if (drops && process.env.RR_EXPLAIN_IDEAS) {
		ideas.forEach(c => console.log('[explain] idea: jobs=' + c.jobs.length
			+ ' | ' + c.why + ' | ' + JSON.stringify(c.jobs)));
	}
	for (const cand of ideas) {
		current = cand;
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
	// THE VERDICT ON THE HUMAN'S LINE, on the same criterion as the winner.
	//
	// A line outside the top four never had its lookahead priced, and `here`
	// alone is the criterion the planner itself rejects -- comparing his line's
	// immediate cost against the winner's total would flatter one of them for
	// free. So if it reached the shortlist and was not judged, it is judged now.
	let userLine = null;
	if (userCand) {
		const item = shortlist.find(it => it.cand === userCand
			|| JSON.stringify(it.cand.jobs) === JSON.stringify(userCand.jobs));
		if (item && item.ahead === undefined && LOOKAHEAD && item.r.state) {
			try { item.ahead = continuationCost(item.r.state, item.finished ? fi : -1); }
			catch (e) { item.ahead = 0; }
		}
		userLine = {
			// null means the generator never proposed it; a string is the name
			// it was already carrying, which makes "you DID have this line" a
			// checkable claim rather than an impression.
			already: userAlready,
			priced: !!item,
			dropped: item ? null : (userDrop || 'never reached pricing'),
			here: item ? item.here : null,
			ahead: item && item.ahead !== undefined ? item.ahead : null,
			total: item ? item.here + (item.ahead || 0) : null,
			dead: item ? (item.r.dead || []) : [],
			deathRisk: item ? item.r.deathRisk : null,
			outcome: item ? item.r.outcome : null,
			kills: item ? !!item.r.kills : null,
			turns: item ? item.r.turns : null,
			rank: item ? shortlist.indexOf(item) + 1 : null,
			ofPriced: shortlist.length,
			judged: !!(item && item.ahead !== undefined),
			won: !!(best && item && best.cand === item.cand)
		};
	}

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
	// PROGRESS BELONGS TO A PLAN, NOT TO A TURN.
	//
	// `P.newProgress()` used to be created fresh here on every decision, and
	// `planAction` writes its counters into that object -- which was then
	// thrown away. So both counters were permanently zero live, while
	// `pricePath` (paths.js:174) makes ONE progress object and carries it
	// through the whole simulated line. The plan was priced as a sequence that
	// advances and played as a sequence that cannot. Same shape as every bug on
	// this project: two parts keeping their own idea of the position.
	//
	// Two consequences, both of them things James has watched happen:
	//
	//   - `policy.js:147` reads `job.moves[Math.min(step, len - 1)]`, and step
	//     was always 0, so a two-move leg played move 0 forever. Live turns
	//     4598/4599 (a WON episode): the leg was Victreebel [Sleep Powder,
	//     Sludge], it played Sleep Powder, the target fell asleep, and it played
	//     Sleep Powder again into a sleeping Vikavolt. Victreebel died the turn
	//     after having thrown one away.
	//   - `jobDone` reads `until.uses` out of the same dead counter, so a
	//     use-count handover could never fire. `userline.js:107` puts
	//     `until: {uses: 1}` on every non-final leg of a line typed at the
	//     panel, so a typed line of two or more legs only ever ran its first.
	//
	// Measured over the real generated market for Surge (313 candidates with
	// playable jobs): 24.9% contain a multi-move leg, 31.9% carry an until.uses.
	//
	// The caller owns the object, exactly as it owns `incumbent`, because the
	// caller is the only thing that knows a turn happened. It is handed back on
	// the winning plan and passed in next turn; a plan whose jobs differ gets a
	// fresh one, since progress through a DIFFERENT sequence means nothing.
	//
	// Behind RR_CARRY_PROGRESS while it is A/B'd, because it changes what gets
	// played on a quarter of all plans.
	const CARRY = !!process.env.RR_CARRY_PROGRESS;
	const held = (CARRY && options.progress) ? options.progress : null;
	const jobsKey = jobs => JSON.stringify(jobs);
	const cloneProgress = p => ({job: Object.assign({}, p.job),
		step: Object.assign({}, p.step)});
	// `firstAction` is called several times per decision -- for `stay`, for the
	// panel's alternatives, and to walk the ranking -- and planAction ADVANCES
	// the counters it is given. So every exploratory call gets a copy and only
	// the action actually returned is committed, or a turn would count as three.
	const progressFor = (cand, commit) => {
		if (!CARRY) return P.newProgress();
		if (!held || held.key !== jobsKey(cand.jobs)) return P.newProgress();
		return commit ? held.progress : cloneProgress(held.progress);
	};
	const firstAction = item => {
		const plan = {};
		plan[state.foe.team[fi].set.species] = item.cand.jobs;
		return P.planAction(engine, state, plan, progressFor(item.cand, false));
	};
	// Replay the decision onto the progress we hand back, so the counters
	// advance exactly once and only for the line that is really being played.
	const commitProgress = item => {
		if (!CARRY) return null;
		const key = jobsKey(item.cand.jobs);
		const carried = (held && held.key === key)
			? held : {key: key, progress: P.newProgress()};
		const plan = {};
		plan[state.foe.team[fi].set.species] = item.cand.jobs;
		P.planAction(engine, state, plan, carried.progress);
		return carried;
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
	// THE RUNNERS-UP, NAMED, for the human at the panel. When a line concedes
	// one of ours, James wants to pick WHICH one, and a choice is only
	// meaningful if the things being chosen between are lines the market
	// already priced and is willing to play -- not a free-form override of the
	// planner by hand. So each entry carries the action it opens with, what it
	// costs now and later, and who it expects to bury. Built only on request:
	// it costs a planAction per line, and turns nobody is watching should not
	// pay for it.
	const alternatives = [];
	if (options.alternatives) {
		for (const item of ranked) {
			if (alternatives.length >= 6) break;
			const a = firstAction(item);
			if (!a) continue;
			alternatives.push({action: a, why: item.cand.why, here: item.here,
				ahead: item.ahead === undefined ? null : item.ahead,
				total: totalOf(item),
				dead: (item.r && item.r.dead) || [],
				deathRisk: item.r ? item.r.deathRisk : null});
		}
	}
	for (const item of ranked) {
		const action = firstAction(item);
		if (!action) continue;
		// THE RETURNED PATH MUST CARRY THE REAL LOOKAHEAD.
		//
		// This compared `item` (a shortlist entry) against `best` (a wrapper
		// object BUILT from one), which are never the same object, so the test
		// was always false and every returned path reported ahead = 0. Nothing
		// downstream could tell the immediate cost from the full criterion:
		// agent.js:1657 computes the panel's line verdict as here + (ahead||0),
		// so "cheaper on the full criterion and still lost" -- the whole reason
		// the line box exists -- has always compared on `here` alone, and
		// agent.js's turn log has printed "rest of the fight 0.00" on every
		// planned turn. It also silently zeroed the bias measurement built to
		// audit the lookahead, which came back a perfect 0.00 on 1608 rows.
		//
		// Matched on the candidate now, which is the thing that identifies a
		// line. `item.ahead` is present for finalists and undefined otherwise,
		// and undefined is reported as null rather than as zero so a caller can
		// tell "not judged" from "judged at zero" -- the distinction the
		// FINALISTS cut makes and the old code destroyed.
		const path = (best && item.cand === best.cand) ? best
			: {score: item.here + (item.ahead || 0), here: item.here,
				ahead: item.ahead === undefined ? null : item.ahead,
				cand: item.cand, r: item.r, illegal: item.illegal};
		return {action, path, stay, alternatives, userLine,
			// Hand back to the caller, which owns it across turns. Null when
			// RR_CARRY_PROGRESS is off, and then nothing has changed at all.
			progress: commitProgress(item),
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
