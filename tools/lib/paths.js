/**
 * A PATH is one complete, simulated way to kill one of their Pokemon.
 *
 * James's design, in his words:
 *
 *   "the whole idea I presented to you was finding paths and then comparing
 *    those paths for each enemy pokemon and checking which combination is
 *    possible"
 *
 * The thing that makes a path comparable is that it is priced END TO END. The
 * version this replaces priced only the KILLER's duel, under a condition it
 * assumed into existence -- "suppose their Attack is at -2, now who kills it" --
 * and never simulated the Pokemon that had to produce the -2. Run properly, the
 * very first plan it produced had Lilligant dying on her second Baby-Doll Eyes,
 * and the kill only worked because that move happens to have priority. James
 * caught it by asking the obvious question the code never asked: "did you think
 * about whether lilligant dies while doing two baby doll eyes?"
 *
 * So a path is simulated as one continuous sequence: whoever is out when their
 * Pokemon arrives, the switch that brings the enabler in and the hit it takes on
 * the way, the enabler's turns, the switch to the killer, and the kill. What
 * comes back is a SPEND VECTOR -- how much HP each of ours actually lost -- plus
 * who died and whether it worked at all. Those are the numbers that can be
 * compared across paths and added up across a fight, which is the whole point:
 * "compare the damages for each line for different pokemon kills, and see
 * whether the 20 damage gyarados took while killing x and the 40 damage it took
 * to kill y kills it."
 */
'use strict';
const P = require('./policy.js');
const {committedChoice} = require('./duels.js');
const FLAGS = {checkBadMove: true, checkGoodMove: true};

/**
 * Simulate one path.
 *
 * ctx: {engine, party, foeSets}
 * fi:  index of THEIR Pokemon this path is aimed at
 * jobs: the path, in policy.js job form
 * entry: {active: species-or-index of ours that is out when they arrive,
 *         hp: {species -> fraction}, dead: [species], foeChip: fraction}
 *
 * `mode` decides the dice. "median" reads both sides at the median roll and
 * gives the reading of what normally happens, which is what a plan should be
 * built on; "odds" samples the real distribution and is what verification uses.
 */
function pricePath(ctx, fi, jobs, entry, opts) {
	const engine = ctx.engine, B = engine.B, RRAI = engine.sandbox.RRAI;
	const options = opts || {};
	let cap = options.turnCap || 16;
	const en = entry || {};
	const expendable = options.expendable || [];

	// THEIR TEAM STAYS IN ITS REAL ORDER. It used to be rotated so the target
	// led, which made the target's entry ability fire -- but it also meant
	// every leg was priced in a fight whose Pokemon are in a different order
	// from the real one, and the combination search then walked that fictional
	// order. Their replacement is chosen by MATCHUP, not by roster position:
	// measured 40/40, Surge sends Pawmot second where the roster says Vikavolt.
	//
	// So the real order is kept and the target's entry ability is applied by
	// hand. That also makes the lead's ability fire, which is correct -- in the
	// real fight Pincurchin did lead and its terrain is up.
	let st = B.createState(ctx.party, ctx.foeSets, options.stateOpts || {});
	st.foe.active = fi;
	if (fi !== 0) B.applyEntryAbility(st, 'foe');

	// THE FIELD IS CARRIED, not re-derived. Rotating their team so the target
	// leads means the LEAD's entry ability fires, so a leg against their fourth
	// Pokemon was being simulated with whatever terrain that Pokemon happens to
	// set -- usually none. Meanwhile candidate generation was rejecting sleep
	// outright whenever anyone on their team had a terrain ability, with no
	// accounting for how long it lasts. Two opposite errors, and James supplied
	// the counterexample to both: "there is the sleep powder path, I did it on
	// file once." Electric Terrain runs eight turns with Terrain Extender, and
	// their fourth Pokemon does not arrive until well past that.
	if (en.field) {
		st.field.terrain = en.field.terrain || null;
		st.field.terrainTurns = en.field.terrainTurns || 0;
		st.field.weather = en.field.weather || null;
		st.field.weatherTurns = en.field.weatherTurns || 0;
	}
	if (en.turn) st.turn = en.turn;

	const idxOf = name => st.me.team.findIndex(m => m.set.species === name);
	if (en.hp) {
		for (const name in en.hp) {
			const i = idxOf(name);
			if (i >= 0) st.me.team[i].curHP = Math.max(1,
				Math.round(st.me.team[i].maxHP * en.hp[name]));
		}
	}
	(en.dead || []).forEach(name => {
		const i = idxOf(name);
		if (i >= 0) { st.me.team[i].fainted = true; st.me.team[i].curHP = 0; }
	});
	if (en.status) {
		for (const name in en.status) {
			const i = idxOf(name);
			if (i >= 0) st.me.team[i].status = en.status[name];
		}
	}
	// THEIR DEAD STAY DEAD. Each leg is built from a fresh state, so their
	// whole team came back to life every time -- and since the replacement is
	// now simulated rather than assumed, the simulation happily handed back a
	// Pokemon we had already killed. One branch reached round five "facing"
	// Manectric-Mega with Manectric-Mega in its own kill list.
	(en.foeDead || []).forEach(i => {
		if (st.foe.team[i]) { st.foe.team[i].fainted = true; st.foe.team[i].curHP = 0; }
	});
	if (en.foeChip) {
		st.foe.team[fi].curHP = Math.max(1, Math.round(st.foe.team[fi].maxHP * (1 - en.foeChip)));
	}
	// The foe's condition, with real lifetimes: status persists on the whole
	// party, boosts belong only to the Pokemon on the field and the engine
	// zeroes them on exit -- carrying them further would make Baby-Doll Eyes
	// permanent, which James explicitly warned against.
	if (en.foeStatus) {
		for (const i in en.foeStatus) {
			if (st.foe.team[i]) st.foe.team[i].status = en.foeStatus[i];
		}
	}
	if (en.foeBoosts && st.foe.team[fi]) {
		Object.assign(st.foe.team[fi].boosts, en.foeBoosts);
	}
	if (en.active !== undefined) {
		const i = typeof en.active === 'number' ? en.active : idxOf(en.active);
		if (i >= 0 && !st.me.team[i].fainted) st.me.active = i;
	}
	// Our own active's boosts too -- Victreebel after one Leaf Storm is at
	// -2 Sp. Atk and was being priced at full power. Same lifetime rule: the
	// active only; a switch clears them in the engine as in the game.
	if (en.myBoosts && st.me.team[st.me.active]) {
		Object.assign(st.me.team[st.me.active].boosts, en.myBoosts);
	}
	// AND ITS PP. createState deals full PP, so a Mienshao that had spent both
	// Fake Outs was still simulated flinching Pawmot on every priced entry --
	// lines the actuator then could not play. (Benched Pokemon's PP is not in
	// the party read at all yet; that needs the Lua and is logged in HANDOFF.)
	// A PROTECT ALREADY SPENT IS SPENT. createState zeroes volatiles, so every
	// priced line simulated Detect as fresh -- free damage prevention, every
	// turn, forever -- while the engine itself correctly fails a repeated
	// protect. The live state has carried protectChain since the Detect-spam
	// fix, but the PRICER never saw it, because pricing rebuilds from `entry`.
	if (en.protectChain && st.me.team[st.me.active]) {
		st.me.team[st.me.active].volatiles.protectChain = en.protectChain;
	}
	if (en.myPP && st.me.team[st.me.active]) {
		en.myPP.forEach((v, i) => {
			if (v !== undefined && v !== null) st.me.team[st.me.active].pp[i] = v;
		});
	}
	// AND HOW LONG THEY HAVE BEEN OUT. pricePath builds a fresh state, and a
	// fresh state has turnsOut 0 for everyone, so the Pokemon on the field
	// always looked like it had just arrived -- which made Fake Out legal on
	// every turn of every priced line. The agent then played it four times in a
	// row, each time expecting a flinch, which James watched it do. The entry
	// descriptor has to carry this or the simulation is answering a different
	// question than the one being asked.
	if (en.turnsOut !== undefined) {
		const a = st.me.team[st.me.active];
		if (a) a.turnsOut = en.turnsOut;
	}
	if (en.foeTurnsOut !== undefined) {
		const f = st.foe.team[st.foe.active];
		if (f) f.turnsOut = en.foeTurnsOut;
	}
	// Whoever is out has already been out; entry abilities do not re-fire.
	const startHP = {};
	st.me.team.forEach(m => { startHP[m.set.species] = m.curHP; });

	const plan = {};
	plan[ctx.foeSets[fi].species] = jobs;
	const prog = P.newProgress();
	const chooser = state => {
		for (const job of jobs) {
			const i = state.me.team.findIndex(m => m.set.species === job.mon && !m.fainted);
			if (i >= 0) return i;
		}
		return -1;
	};

	const median = options.mode !== 'odds';
	const log = [];
	let outcome = 'stall', turns = 0, survive = 1, blocked = 0;

	for (let t = 0; t < cap; t++) {
		// Same rule as the duels: a line still standing at the cap runs on.
		if (t === cap - 1 && cap < 28) {
			const a = st.me.team[st.me.active];
			if (a && !a.fainted && a.curHP >= 0.5 * a.maxHP) cap = 28;
		}
		const target = st.foe.team[fi];
		if (target.fainted) { outcome = 'kill'; break; }
		if (st.foe.active !== fi) { outcome = 'left'; break; }
		if (st.me.team.every(m => m.fainted)) { outcome = 'wiped'; break; }

		// Their best COMMITTED action, never a voluntary exit from the duel --
		// see committedChoice in duels.js for the live turn-592 evidence.
		const scored = RRAI.scoreAll(st, 'foe', FLAGS, {});
		if (!scored.length) { outcome = 'error'; break; }
		let theirs = committedChoice(B, scored, st);

		// The same entry signal the live agent supplies, so a priced line and a
		// played line agree about when an entry-only move is available. The
		// engine keeps turnsOut at 0 for the whole of a Pokemon's first turn
		// out and refuses the move afterwards, so this matches what will
		// actually be legal.
		{
			const a = st.me.team[st.me.active];
			if (a) a.volatiles.justEntered = (a.turnsOut || 0) === 0;
		}
		st.replacementChooser = chooser;
		let mine = P.planAction(engine, st, plan, prog);
		// EVERY ENTRY IS PRICED AGAINST WHAT MIGHT ACTUALLY ARRIVE. A switch
		// turn is where our 56% model of their choice hurts most, and it
		// hurts the same at turn one and at turn four: "Mienshao chips, then
		// Lanturn finishes" walked a 15 HP Lanturn into Vikavolt on the
		// strength of "the committed move is Electric and Lanturn absorbs it"
		// -- live, Bug Buzz killed it on arrival. So on ANY simulated switch,
		// the foe plays the most damaging move in its plausible set (passed
		// down from chooseAction; the duel target is fixed for the whole
		// line, so the decision-time set stays valid), and the simulation
		// continues from the damaged position. James's framing, which is the
		// spec: the question is not "does the predicted move kill the
		// incoming Pokemon", it is "is the predicted move going to stop me
		// from doing this plan". A death on entry becomes a PRICED death,
		// never a veto -- a first version vetoed deep entries instead and
		// promptly threw away good lines over survivable hits. The committed
		// -move veto below remains only for callers that supply no threat set.
		if (mine && mine.type === 'switch'
			&& options.entryThreats && options.entryThreats.length
			&& process.env.RR_ENTRY_MODEL !== 'committed'
			&& process.env.RR_ENTRY_MODEL !== 'confident') {
			let worst = null, worstDmg = -1;
			const probe = B.clone(st);
			probe.me.active = mine.index;
			for (const threat of options.entryThreats) {
				let r;
				try { r = B.damageRolls(probe, 'foe', threat.move); } catch (e) { continue; }
				const dmg = (r && !r.immune && r.noCrit && r.noCrit.length)
					? r.noCrit[r.noCrit.length - 1] /* whole multi-hit lump */ : 0;
				if (dmg > worstDmg) { worstDmg = dmg; worst = threat; }
			}
			if (worst) theirs = worst;
		} else if (mine && mine.type === 'switch'
			&& process.env.RR_ENTRY_MODEL === 'confident') {
			// JAMES'S ENTRY MODEL, replacing the blanket worst-plausible hedge.
			//
			// His ruling, verbatim: "We can get NOWHERE by assuming the enemy
			// will do the worst move... We need to assume that we can guess what
			// the opponent does, unless the move is up to a dice roll... then it
			// should decide depending on the position if that chance can be
			// taken (if we are wrong does our pokemon die? or is it some extra
			// damage)."
			//
			// The evidence behind the ruling, both directions: Q3 measured that
			// worst-plausible hedging does not even buy death prediction (70.0%
			// priced risk under the committed move vs 71.7% under the worst
			// one), and the hedge priced James's zero-death Bellibolt stall --
			// which the sim itself plays cleanly, 9T kill, deathRisk 0.00 --
			// as a 100%-risk double death, because a lure works precisely by
			// having the incoming absorb a move the AI committed while looking
			// at the OUTGOING Pokemon. A blanket worst-case entry assumes the
			// opponent is never baitable, which deletes lure play from the plan
			// space entirely.
			//
			// So: trust the committed prediction (`theirs` above, computed from
			// this very simulated position, which is fresher than the
			// decision-time entryThreats set), UNLESS the AI's own score sheet
			// says the choice is genuinely uncertain -- several moves within
			// RRAI.plausible's existing margin -- AND being wrong about it is
			// FATAL to the incoming Pokemon. Only then price the killer, because
			// that is the one chance that cannot be taken. A survivable surprise
			// is extra damage, and extra damage is what the rest of the pricing
			// already accounts for.
			//
			// No new constants: the uncertainty band is RRAI.plausible's
			// existing margin, and "fatal" is the incoming's current HP.
			try {
				const inc = st.me.team[mine.index];
				const set = RRAI.plausible(st, 'foe').actions
					.filter(a => a.type === 'move');
				if (set.length > 1 && inc) {
					const probe = B.clone(st);
					probe.me.active = mine.index;
					let killer = null, killerDmg = -1;
					for (const a of set) {
						let r;
						try { r = B.damageRolls(probe, 'foe', a.move); } catch (e) { continue; }
						const dmg = (r && !r.immune && r.noCrit && r.noCrit.length)
							? r.noCrit[r.noCrit.length - 1] /* whole multi-hit lump */ : 0;
						if (dmg >= inc.curHP && dmg > killerDmg) { killerDmg = dmg; killer = a; }
					}
					if (killer) theirs = killer;
				}
			} catch (e) { /* keep the committed choice */ }
		} else if (mine && mine.type === 'switch' && !survivesEntry(B, st, mine.index, theirs)) {
			// The path wants a Pokemon in that would die on the way in. That is
			// the transition cost, and it is the question James asks out loud:
			// "how do I bring in Diggersby without bringing it into death
			// range." Hold it back rather than walking it into the hit.
			blocked++;
			mine = null;
		}
		if (!mine) { outcome = 'stuck'; break; }

		// The exact chance this turn kills one of ours, from the real roll and
		// crit distribution. Reported, never folded into the trajectory.
		try {
			const odds = B.step(st, mine, theirs, {mode: 'odds', forkBudget: 3});
			const before = st.me.team.filter(m => m.fainted).map(m => m.set.species);
			let died = 0;
			odds.forEach(b => {
				const p = b.probability === undefined ? 0 : b.probability;
				// Only deaths the cap FORBIDS count as risk. A plan that spends
				// the one Pokemon it is allowed to spend is not risky, it is
				// working, and folding that into the same number made every
				// combination read "something dies 100% of the time".
				const newly = b.state.me.team.filter(m => m.fainted)
					.map(m => m.set.species).filter(n => !before.includes(n));
				if (newly.some(n => !expendable.includes(n))) died += p;
			});
			survive *= (1 - died);
		} catch (e) { /* odds are a report, not a requirement */ }

		let out;
		try {
			// OUR damage at the median, THEIRS at the high roll. Planning both
			// at the median produces lines with no margin at all -- the
			// order-aware plan ended legs with Pokemon on 5% and 6%, and any
			// adverse roll killed them: 30 episodes, 1 win, six deaths a game.
			// A plan should assume its own damage is typical and that the
			// damage it takes is the worst of the band, which is the half of
			// the honest-dice fix that was identified hours ago and never done.
			// AND A PARALYSED POKEMON LOSES A TURN. The engine budgets full
			// paralysis for our side -- a fixed number of skips across a line,
			// rather than every turn, because paralysed-forever is a state
			// nothing escapes -- and the planner was the one caller that never
			// asked for it, so every plan built on a paralysed Pokemon assumed
			// it acted on schedule. 1 is the solver's existing budget
			// (rr-solver.js), not a new number.
			out = B.step(st, mine, theirs, median
				? {mode: 'maxroll', risks: {roll: 'median', paralysis: 1,
					// RR_FOE_ROLL=median reads THEIR damage at the middle of the
					// band instead of the top, for A/B only; default unchanged.
					// The max reading is the last untested member of the same
					// pessimism family as the worst-plausible entry hedge: added
					// when the pricer had the full-HP fictions, kept after every
					// one of those bugs was fixed, and never re-measured. It is
					// why a stall line reads as losing a race it wins live --
					// every incoming hit priced at its ceiling, forever, with
					// zero variance.
					foeRoll: (options.pessimism === false
						|| process.env.RR_FOE_ROLL === 'median') ? 'median' : 'max'}}
				: {mode: 'odds', forkBudget: 3});
		} catch (e) { outcome = 'error'; break; }
		if (!out || !out.length) { outcome = 'error'; break; }
		const before = st;
		st = median ? out[0].state : sample(out);
		turns = t + 1;
		log.push({
			turn: t + 1,
			we: before.me.team[before.me.active].set.species + ' '
				+ (mine.type === 'switch' ? '-> ' + before.me.team[mine.index].set.species : mine.move),
			they: theirs.type === 'switch'
				? '-> ' + before.foe.team[theirs.index].set.species : theirs.move,
			us: st.me.team.map(m => m.fainted ? 'X' : Math.round(100 * m.curHP / m.maxHP)).join('/'),
			them: Math.round(100 * st.foe.team[fi].curHP / st.foe.team[fi].maxHP),
			fs: (st.foe.team[fi].status || '-')
				+ (st.foe.team[fi].status === 'slp' ? st.foe.team[fi].sleepTurns : ''),
			fa: st.foe.team[st.foe.active].set.species + '@' + st.foe.team[st.foe.active].curHP,
			nu: (st.unmodelled || []).slice((before.unmodelled || []).length)
		});
	}
	if (outcome === 'stall' && st.foe.team[fi].fainted) outcome = 'kill';

	// The spend vector: what this path actually cost, per Pokemon. Negative
	// entries are real and are not a bug -- absorb abilities, drain moves and
	// Leftovers all mean a path can END somebody higher than it found them.
	const spend = {}, endHP = {}, dead = [];
	st.me.team.forEach(m => {
		const name = m.set.species;
		spend[name] = (startHP[name] - m.curHP) / m.maxHP;
		endHP[name] = m.fainted ? 0 : m.curHP / m.maxHP;
		if (m.fainted && !(en.dead || []).includes(name)) dead.push(name);
	});

	return {
		foe: ctx.foeSets[fi].species,
		jobs: jobs,
		outcome: outcome,
		kills: outcome === 'kill',
		turns: turns,
		spend: spend,
		endHP: endHP,
		dead: dead,
		active: st.me.team[st.me.active].set.species,
		field: {terrain: st.field.terrain, terrainTurns: st.field.terrainTurns,
			weather: st.field.weather, weatherTurns: st.field.weatherTurns},
		foeLeft: st.foe.team[fi].curHP / st.foe.team[fi].maxHP,
		// Who they send next, simulated rather than assumed from the roster.
		nextFoe: st.foe.team[st.foe.active] && !st.foe.team[st.foe.active].fainted
			? st.foe.active : -1,
		deathRisk: 1 - survive,
		blockedEntries: blocked,
		state: st,
		log: log
	};
}

function survivesEntry(B, state, index, foeAction) {
	if (!foeAction || foeAction.type === 'switch') return true;
	const probe = B.clone(state);
	probe.me.active = index;
	const r = B.damageRolls(probe, 'foe', foeAction.move);
	if (!r || r.immune) return true;
	const worst = r.noCrit[r.noCrit.length - 1] /* whole multi-hit lump */;
	return worst < probe.me.team[index].curHP;
}

function sample(branches) {
	let r = Math.random(), acc = 0;
	for (const b of branches) {
		acc += b.probability === undefined ? 1 / branches.length : b.probability;
		if (r <= acc) return b.state;
	}
	return branches[branches.length - 1].state;
}

module.exports = {pricePath, survivesEntry};
