/**
 * Duel lines: every way one of ours kills one of theirs, priced in HP%.
 *
 * This is step 1 of docs/PLAN-LINE-PLANNER.md, and it is the unit the whole
 * planner is built out of. James's framing:
 *
 *   "determining how we can defeat each pokemon individually. And you have a
 *    whole bunch of ways to beat it, prioritizing killing it while losing the
 *    least amount of hp %."
 *
 * WHY SIMULATE RATHER THAN COUNT HITS. The prototype in tools/plan_fight.js
 * priced a duel by dividing HP by median damage and comparing hit counts. That
 * is wrong in both directions on this exact team: it cannot see Drain Punch
 * healing Pawmot back out of range (which is the entire reason Pawmot beats
 * six Pokemon), Lanturn's Volt Absorb turning an attack into a HEAL, Sitrus
 * Berry, Intimidate, recoil, or a secondary that lands. Every one of those is
 * already implemented in the battle engine, so the honest thing is to run the
 * turns.
 *
 * THE DICE. First attempt here read our damage at the median and theirs at the
 * MAXIMUM, on the theory that a plan should fear its own deaths at the worst
 * roll. Measured, that theory is unusable: Pawmot's Drain Punch rolls 96-114
 * into a 112 HP Diggersby, so max-roll accounting calls Diggersby DEAD, and
 * every single line against Pawmot came back DIED at 100% cost. That is the
 * old `worst` mode's failure returning in a new costume -- a bar nothing can
 * clear tells you nothing. It also contradicts what James saw with his own
 * eyes: "Pawmot killing diggersby in one shot means that it crit."
 *
 * So the price and the risk are separated, which is the only honest version:
 * the LINE is simulated at the median roll for both sides, the reading of what
 * normally happens; and alongside it the exact probability that our Pokemon
 * faints is computed from the real 16-roll distribution and crit rate, turn by
 * turn, using the engine's own odds machinery. A duel therefore reports "costs
 * 34% and dies 19% of the time" rather than pretending either number is the
 * whole story. The planner downstream needs both: cost feeds the HP budget,
 * risk feeds James's cap, which is a statement about deaths and nothing else.
 *
 * Crits are never assumed into the line for the same reason. They are counted
 * into the risk, where they belong.
 *
 * THE FOE plays its real policy, argmax over the ported AI scores, because
 * that is the standing doctrine: "assume one line is true, the line that from
 * your understanding of the AI it will do... Our whole basis is that we can
 * predict the opponent." Where the AI would rather SWITCH than stay, the duel
 * does not pretend otherwise -- it ends with outcome "left" and reports what
 * we banked, since chip damage persists through their switching even though
 * stat drops do not.
 */
'use strict';

// What a plan should assume happens. Deviations are priced as risk, not
// baked into the trajectory.
const MEDIAN = {roll: 'median'};

/**
 * One duel, simulated.
 *
 * `state` must already have both actives set. `strategy` is a list of move
 * names to click in order; once it runs out the last entry repeats, which is
 * how "set up once then attack" and "just spam it" are the same object.
 */
function runDuel(engine, state, strategy, opts) {
	const B = engine.B, RRAI = engine.sandbox.RRAI;
	const options = opts || {};
	const flags = options.flags || {checkBadMove: true, checkGoodMove: true};
	const cap = options.turnCap || 12;

	let st = B.clone(state);
	const myIndex = st.me.active, foeIndex = st.foe.active;
	const myMon0 = st.me.team[myIndex], foeMon0 = st.foe.team[foeIndex];
	const startHP = myMon0.curHP, startFoeHP = foeMon0.curHP;

	const log = [];
	let outcome = 'stall', turns = 0;
	// Probability the line survives every turn it plays, and the probability
	// that each intended kill actually lands. Multiplicative, computed from the
	// engine's exact per-turn odds rather than from a roll assumption.
	let survive = 1, killOdds = 1;

	// A duel does not have to be fought to the death. `retreatAt` is how a
	// CHIP job is priced: stay in until HP drops to this fraction, then leave
	// and hand the finish to somebody else. Nothing on James's team beats
	// Bellibolt one on one -- Parabolic Charge heals it back faster than most
	// of us hit -- but Lanturn takes it to 1 HP and anyone finishes from there.
	// Without a retreat point every duel is fought to a corpse and that pairing
	// is invisible.
	const retreatAt = options.retreatAt;

	for (let t = 0; t < cap; t++) {
		const me = st.me.team[myIndex], foe = st.foe.team[foeIndex];
		if (foe.fainted) { outcome = 'kill'; break; }
		if (me.fainted) { outcome = 'died'; break; }
		if (retreatAt !== undefined && t > 0 && me.curHP / me.maxHP <= retreatAt) {
			outcome = 'retreat'; break;
		}
		if (st.me.active !== myIndex || st.foe.active !== foeIndex) {
			// Somebody left. Whoever it was, this duel is over.
			outcome = st.foe.active !== foeIndex ? 'left' : 'weLeft';
			break;
		}

		const legal = B.legalActions(st, 'me');
		const want = strategy[Math.min(t, strategy.length - 1)];
		const mine = legal.find(a => a.type === 'move' && a.move === want);
		if (!mine) { outcome = 'nomove'; break; }

		// Their best COMMITTED choice -- see committedChoice.
		const scored = RRAI.scoreAll(st, 'foe', flags, {});
		if (!scored.length) { outcome = 'nomove'; break; }
		const theirs = committedChoice(B, scored);

		// The turn's real odds, enumerated once: crit, roll, accuracy,
		// secondaries and move order all included, because they are all already
		// implemented and guessing at them by hand is how this project has
		// repeatedly produced numbers that looked like data.
		let odds = null;
		try {
			odds = B.step(st, mine, theirs, {mode: 'odds', forkBudget: 4});
		} catch (e) { odds = null; }
		if (odds) {
			let died = 0, killed = 0;
			for (const branch of odds) {
				const p = branch.probability === undefined ? 0 : branch.probability;
				if (branch.state.me.team[myIndex].fainted) died += p;
				if (branch.state.foe.team[foeIndex].fainted) killed += p;
			}
			survive *= (1 - died);
			if (killed > 0) killOdds = killed;   // the turn the kill is attempted
		}

		let out;
		try {
			out = B.step(st, mine, theirs, {mode: 'maxroll', risks: MEDIAN});
		} catch (e) { outcome = 'error'; break; }
		if (!out || !out.length) { outcome = 'error'; break; }
		const after = out[0].state;
		turns = t + 1;
		log.push({
			turn: t + 1,
			we: mine.move,
			they: theirs.type === 'switch'
				? 'switch -> ' + st.foe.team[theirs.index].set.species : theirs.move,
			ourHP: after.me.team[myIndex].curHP,
			theirHP: after.foe.team[foeIndex].curHP
		});
		st = after;
	}

	if (outcome === 'stall') {
		if (st.foe.team[foeIndex].fainted) outcome = 'kill';
		else if (st.me.team[myIndex].fainted) outcome = 'died';
	}

	const endMe = st.me.team[myIndex], endFoe = st.foe.team[foeIndex];
	return {
		mon: myMon0.set.species,
		foe: foeMon0.set.species,
		moves: strategy,
		outcome: outcome,
		turns: turns,
		// The price, as a fraction of OUR maximum HP. Negative is possible and
		// is not a bug: Volt Absorb, Drain moves and Leftovers all mean a duel
		// can end with more HP than it started with.
		cost: (startHP - endMe.curHP) / myMon0.maxHP,
		hpLeft: endMe.curHP / myMon0.maxHP,
		// What the duel banks for later even when it does not finish the job.
		chip: (startFoeHP - endFoe.curHP) / foeMon0.maxHP,
		foeStatus: endFoe.status || null,
		foeItemGone: !!endFoe.itemGone && !foeMon0.itemGone,
		// Ours survive a switch only if we do not switch; theirs are laundered
		// the moment they rotate. Kept apart so the planner can tell a durable
		// investment from a rented one.
		ourBoosts: Object.assign({}, endMe.boosts),
		theirBoosts: Object.assign({}, endFoe.boosts),
		// The two numbers the deterministic line cannot carry. deathRisk is the
		// one James's cap is written in: it says nothing about HP, only about
		// who is allowed to die.
		deathRisk: 1 - survive,
		killOdds: killOdds,
		state: st,
		log: log
	};
}

/**
 * Enumerate strategies worth trying for one matchup.
 *
 * Deliberately small. The point is not to search: it is to produce the handful
 * of distinct IDEAS a person would consider -- click this attack, or set up
 * once and then click this attack -- so the assignment step downstream has real
 * alternatives to price against each other. Forward search over move sequences
 * was tried at several budgets and failed on this fight; the winning corridor
 * looks locally bad, which is exactly why the enumeration is over intentions.
 */
function strategiesFor(engine, state, opts) {
	const B = engine.B;
	const me = state.me.team[state.me.active];
	const moves = (me.set.moves || []).filter(Boolean);
	const damaging = [], status = [];
	for (const mv of moves) {
		const r = B.damageRolls(state, 'me', mv);
		if (r && !r.immune && r.noCrit[r.noCrit.length - 1] > 0) damaging.push(mv);
		else status.push(mv);
	}
	const out = [];
	for (const d of damaging) out.push([d]);
	// One setup or status move, then the attack. Two prefixes would multiply
	// the table by four for lines nobody plays; if a duel genuinely needs a
	// double boost the plan step will find it by chaining duels.
	for (const s of status) {
		for (const d of damaging) out.push([s, d]);
		if (!damaging.length) out.push([s]);
	}
	if (!out.length) out.push([moves[0] || 'Struggle']);
	return out;
}

/**
 * Every priced way `mi` can fight `fi` from a given entry state.
 *
 * `entry` optionally mutates the position before the duel starts, which is how
 * conditions are expressed: {slowed: true} for a foe at -1 speed, {asleep: n},
 * {hpFrac: 0.6} for entering already chipped. Those are the ENABLERS the
 * backward chaining bottoms out in -- "I can kill Pawmot IF it is slowed" is
 * only useful next to "and here is who slows it and what that costs".
 */
function duelLines(engine, party, foeSets, mi, fi, entry, opts) {
	const B = engine.B;
	const cond = entry || {};
	// ROTATE both teams so the duellists lead. `createState` applies entry
	// abilities to whoever is at index 0 and there is no way to re-open a
	// position afterwards, so setting `active` after the fact silently gave the
	// duel the LEADS' abilities instead of the participants': every Surge duel
	// ran with Electric Terrain up because Pincurchin sits at index 0, which
	// quietly made Sleep Powder fail in matchups that never see Pincurchin, and
	// Manectric's Intimidate never applied at all. Rotation keeps both benches
	// intact, so the foe can still choose to leave.
	const rot = (arr, k) => arr.slice(k).concat(arr.slice(0, k));
	const myTeam = rot(party, mi), foeTeam = rot(foeSets, fi);
	const stateOpts = Object.assign({}, (opts && opts.stateOpts) || {});
	if (cond.terrain !== undefined) stateOpts.terrain = cond.terrain;
	if (cond.weather !== undefined) stateOpts.weather = cond.weather;
	const base = B.createState(myTeam, foeTeam, stateOpts);
	const foe = base.foe.team[0], me = base.me.team[0];

	// The condition vocabulary is GENERAL: any stat stage, any status, any
	// volatile, on either side. It used to be three hardcoded ideas -- asleep,
	// slowed, chipped -- and James named exactly what that costs:
	//
	//   "The whole idea for this is to be able to have the model use techniques
	//    that might be intuitive for me but aren't easily observable in
	//    numbers. If we can't detect that pawmot should get -2 intimidate ...
	//    and we should switch etc and defeat it then doing this has no point."
	//
	// He is right, and Pawmot is the proof: it attacks four different ways and
	// every one of them is PHYSICAL, so -2 Attack or a burn beats it and no
	// amount of speed control does. Neither of those could be written down
	// before this.
	if (cond.foeBoosts) {
		for (const k in cond.foeBoosts) {
			foe.boosts[k] = Math.max(-6, Math.min(6, (foe.boosts[k] || 0) + cond.foeBoosts[k]));
		}
	}
	if (cond.foeStatus) {
		foe.status = cond.foeStatus;
		if (cond.foeStatus === 'slp') foe.sleepTurns = cond.sleepTurns || 2;
	}
	if (cond.foeVolatiles) Object.assign(foe.volatiles, cond.foeVolatiles);
	// Kept as aliases because they read better in a report and in a test.
	if (cond.slowed) foe.boosts.spe = Math.max(-6, foe.boosts.spe - (cond.slowed === true ? 1 : cond.slowed));
	if (cond.asleep) { foe.status = 'slp'; foe.sleepTurns = cond.asleep === true ? 2 : cond.asleep; }
	if (cond.foeChip) foe.curHP = Math.max(1, Math.round(foe.maxHP * (1 - cond.foeChip)));
	if (cond.hpFrac !== undefined) me.curHP = Math.max(1, Math.round(me.maxHP * cond.hpFrac));
	if (cond.ourBoosts) Object.assign(me.boosts, cond.ourBoosts);

	const lines = [];
	for (const strat of strategiesFor(engine, base, opts)) {
		const r = runDuel(engine, base, strat, opts);
		r.entry = cond;
		lines.push(r);
	}
	// Kills first, cheapest kill at the top; then everything else by what it
	// banked. A line that does not kill is not worthless -- chip and status
	// survive their switching -- but it is never preferred to one that does.
	lines.sort((a, b) => {
		const ka = a.outcome === 'kill' ? 0 : 1, kb = b.outcome === 'kill' ? 0 : 1;
		if (ka !== kb) return ka - kb;
		if (ka === 0) return a.cost - b.cost;
		return (b.chip - b.cost) - (a.chip - a.cost);
	});
	return lines;
}

/**
 * Their best COMMITTED action: no voluntary exit from the duel.
 *
 * The doctrine at the top of policy.js -- their switching only reorders the
 * duels, it never invalidates one -- has to hold in the pricer too. Giving
 * the simulated foe its literal argmax meant a Manectric whose best score was
 * Volt Switch left every simulated duel on turn one: at live turn 592 all 68
 * candidates priced identically (one turn of tempo, nothing simulated), the
 * 68-way tie was broken by generation order, and the winner flipped with
 * whoever was standing -- the 16-switch loop. A real pivot only POSTPONES the
 * duel, so the duel is measured as fought: pivot moves and hard switches are
 * excluded from the sim foe's choice unless they are all it has.
 */
function committedChoice(B, scored) {
	const committed = scored.filter(e => {
		if (e.action.type !== 'move') return false;
		const d = B.moveData(e.action.move);
		return !(d && d.effect && d.effect.kind === 'selfSwitch');
	});
	const pool = committed.length ? committed : scored;
	let best = -Infinity;
	pool.forEach(e => { if (e.score > best) best = e.score; });
	return pool.filter(e => e.score === best)[0].action;
}

module.exports = {duelLines, runDuel, strategiesFor, MEDIAN, committedChoice};
