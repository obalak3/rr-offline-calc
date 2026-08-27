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
	const cap = options.turnCap || 16;
	const en = entry || {};
	const expendable = options.expendable || [];

	// Rotate their team so the target leads, keeping the bench so they can
	// still choose to leave -- a path that they walk out of is a real outcome
	// and needs to be visible, not simulated away.
	const foeTeam = ctx.foeSets.slice(fi).concat(ctx.foeSets.slice(0, fi));
	let st = B.createState(ctx.party, foeTeam, options.stateOpts || {});

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
	if (en.foeChip) {
		st.foe.team[0].curHP = Math.max(1, Math.round(st.foe.team[0].maxHP * (1 - en.foeChip)));
	}
	if (en.active !== undefined) {
		const i = typeof en.active === 'number' ? en.active : idxOf(en.active);
		if (i >= 0 && !st.me.team[i].fainted) st.me.active = i;
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
		const target = st.foe.team[0];
		if (target.fainted) { outcome = 'kill'; break; }
		if (st.foe.active !== 0) { outcome = 'left'; break; }
		if (st.me.team.every(m => m.fainted)) { outcome = 'wiped'; break; }

		const scored = RRAI.scoreAll(st, 'foe', FLAGS, {});
		if (!scored.length) { outcome = 'error'; break; }
		let bs = -Infinity;
		scored.forEach(e => { if (e.score > bs) bs = e.score; });
		const theirs = scored.filter(e => e.score === bs)[0].action;

		st.replacementChooser = chooser;
		let mine = P.planAction(engine, st, plan, prog);
		if (mine && mine.type === 'switch' && !survivesEntry(B, st, mine.index, theirs)) {
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
			out = B.step(st, mine, theirs, median
				? {mode: 'maxroll', risks: {roll: 'median'}}
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
			them: Math.round(100 * st.foe.team[0].curHP / st.foe.team[0].maxHP)
		});
	}
	if (outcome === 'stall' && st.foe.team[0].fainted) outcome = 'kill';

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
		foeLeft: st.foe.team[0].curHP / st.foe.team[0].maxHP,
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
	const worst = r.noCrit[r.noCrit.length - 1] * (r.hits || 1);
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

module.exports = {pricePath};
