'use strict';
/**
 * A POSITION SCORE, so a line can be paid for making things better and not
 * only for killing. James, 2026-09-08: "the AI is focusing too much on killing
 * opponent pokemon. It should have an understanding of improving your current
 * situation too" -- and, the same day, the trap: "just using a stat move
 * doesn't automatically mean that our position is now better. Speed dropping
 * a strong pokemon doesn't mean anything if they are already slow; lowering
 * the physical damage of a special attacker is null."
 *
 * So nothing here is scored by its label. Every term is MEASURED with the
 * engine against the Pokemon actually standing:
 *
 *   importance(ours)   1 + 0.5 per remaining opponent this Pokemon is a clean
 *                      answer to (the difficulty module's duel table). Lanturn
 *                      answering two of Surge's three is worth 2.0 per HP,
 *                      Breloom answering none is worth 1.0.
 *   hp term            sum of importance x HP fraction over our living side;
 *                      a heal raises it, so a heal is finally worth something.
 *   their conditions   an Attack/Sp.Atk drop or a burn is worth the damage it
 *                      REMOVES from that Pokemon's real moves against our
 *                      living Pokemon (zero for a special attacker's Attack);
 *                      a Speed drop or paralysis is worth the hits our Pokemon
 *                      no longer take before acting, and only where the order
 *                      actually flips; sleep is worth the turns lost; poison
 *                      and burn chip count as HP they will lose.
 *   our conditions     the mirror: our boosts are worth the damage they add,
 *                      our statuses cost what they cost.
 *
 * `delta(before, after)` is what a priced line adds to the price (negative =
 * the position improved). It is bounded: no amount of polishing is ever worth
 * more than a whole Pokemon (POS_CAP), so kills and deaths keep the last word.
 */
const DIFF = require('./difficulty.js');

const IMPORTANCE = Number(process.env.RR_POS_IMPORTANCE || 0.5);
const POS_CAP = Number(process.env.RR_POS_CAP || 1.0);
const HORIZON = 1.5;   // how many more hits a standing opponent lands, on average

function importance(engine, st) {
	const w = {};
	st.me.team.forEach(m => { w[m.set.species] = 1; });
	let read = null;
	try { read = DIFF.classify(engine, st); } catch (e) { read = null; }
	if (read && read.answers) {
		read.answers.forEach(a => {
			(a.clean || []).forEach(name => { w[name] = (w[name] || 1) + IMPORTANCE; });
		});
	}
	return w;
}

/**
 * THE MIDDLE ROLL, WEIGHED BY THE REAL CRIT RATE (James, 2026-09-10). Lanturn
 * fell to Giovanni's Honchkrow after Intimidate was priced at full value:
 * Super Luck plus Scope Lens makes half of its hits critical, Night Slash all
 * of them, and a critical hit ignores the attacker's Attack drops. Reading the
 * no-crit roll alone valued the drop as if crits never happened and read the
 * hits at half their weight. The calculator already knows the rate per
 * attacker and move; this is where the value model finally asks it. For an
 * ordinary Pokemon the rate is 1/24 and nothing measurable changes.
 */
function expectedMid(r) {
	const midN = r.noCrit[Math.floor(r.noCrit.length / 2)];
	const c = Math.min(1, Math.max(0, Number(r.critChance) || 0));
	if (!c || !r.crit || !r.crit.length) return midN;
	const midC = r.crit[Math.floor(r.crit.length / 2)];
	return (1 - c) * midN + c * midC;
}

/** Best damage fraction one side's Pokemon does to the other's, per move split. */
function bestHit(engine, st, side, attackerIdx, defenderIdx) {
	const B = engine.B;
	const probe = B.clone(st);
	const atkSide = side === 'me' ? probe.me : probe.foe;
	const defSide = side === 'me' ? probe.foe : probe.me;
	atkSide.active = attackerIdx; defSide.active = defenderIdx;
	const atk = atkSide.team[attackerIdx], def = defSide.team[defenderIdx];
	let best = 0;
	(atk.set.moves || []).forEach(mv => {
		let r = null;
		try { r = B.damageRolls(probe, side, mv); } catch (e) { r = null; }
		if (!r || r.immune || !r.noCrit || !r.noCrit.length) return;
		const mid = expectedMid(r) / Math.max(1, def.maxHP);
		if (mid > best) best = mid;
	});
	return best;
}

function neutralClone(engine, st, side, idx) {
	const c = engine.B.clone(st);
	const mon = (side === 'me' ? c.me : c.foe).team[idx];
	mon.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0};
	mon.status = null;
	return c;
}

function alive(side) { return side.team.map((m, i) => i).filter(i => !side.team[i].fainted && side.team[i].curHP > 0); }

/**
 * Value of the lasting conditions on THEIR Pokemon j, measured against our
 * living Pokemon, weighted by importance. Positive = good for us.
 */
function theirConditions(engine, st, j, w) {
	const B = engine.B;
	const foe = st.foe.team[j];
	const ours = alive(st.me);
	if (!ours.length) return 0;
	const hasBoost = Object.keys(foe.boosts || {}).some(k => foe.boosts[k] !== 0);
	if (!hasBoost && !foe.status) return 0;
	const neutral = neutralClone(engine, st, 'foe', j);
	let value = 0;
	// Damage it no longer does (Attack/Sp.Atk drops, burn), per our Pokemon.
	let removed = 0, wsum = 0;
	ours.forEach(i => {
		const now = bestHit(engine, st, 'foe', j, i);
		const was = bestHit(engine, neutral, 'foe', j, i);
		removed += (w[st.me.team[i].set.species] || 1) * Math.max(0, was - now);
		wsum += (w[st.me.team[i].set.species] || 1);
	});
	value += HORIZON * removed / Math.max(1, ours.length);
	// Hits our Pokemon no longer take first (Speed drops, paralysis), only
	// where the order actually flips.
	const spNow = B.finalSpeed(Object.assign(B.clone(st), {foe: Object.assign({}, st.foe, {active: j})}), 'foe');
	const spWas = B.finalSpeed(Object.assign(B.clone(neutral), {foe: Object.assign({}, neutral.foe, {active: j})}), 'foe');
	ours.forEach(i => {
		const mine = B.finalSpeed(Object.assign(B.clone(st), {me: Object.assign({}, st.me, {active: i})}), 'me');
		if (spWas >= mine && spNow < mine) {
			value += (w[st.me.team[i].set.species] || 1) * bestHit(engine, st, 'foe', j, i) / Math.max(1, ours.length);
		}
	});
	// Turns it loses outright.
	if (foe.status === 'slp') {
		const left = Math.max(0, 2 - (foe.sleepTurns || 0));
		const act = st.me.team[st.me.active];
		value += left * bestHit(engine, st, 'foe', j, st.me.active) * (w[act.set.species] || 1);
	} else if (foe.status === 'par') {
		value += 0.25 * HORIZON * bestHit(engine, st, 'foe', j, st.me.active) * (w[st.me.team[st.me.active].set.species] || 1);
	}
	if (foe.volatiles && foe.volatiles.confused) {
		value += 0.33 * bestHit(engine, st, 'foe', j, st.me.active);
	}
	// Chip it will take: worth HP of theirs, in their threat weight (1).
	if (foe.status === 'brn' || foe.status === 'psn') value += HORIZON / 16;
	if (foe.status === 'tox') value += HORIZON * 2 / 16;
	return value;
}

/** Value of the lasting conditions on OUR Pokemon i (positive = good for us). */
function ourConditions(engine, st, i, w) {
	const mon = st.me.team[i];
	const theirs = alive(st.foe);
	if (!theirs.length) return 0;
	const hasBoost = Object.keys(mon.boosts || {}).some(k => mon.boosts[k] !== 0);
	if (!hasBoost && !mon.status) return 0;
	const neutral = neutralClone(engine, st, 'me', i);
	let added = 0;
	theirs.forEach(j => {
		const now = bestHit(engine, st, 'me', i, j);
		const was = bestHit(engine, neutral, 'me', i, j);
		added += now - was;
	});
	let value = HORIZON * added / Math.max(1, theirs.length);
	const wi = w[mon.set.species] || 1;
	if (mon.status === 'slp') value -= 2 * wi * 0.3;
	if (mon.status === 'par') value -= 0.25 * HORIZON * wi * 0.3;
	if (mon.status === 'brn' || mon.status === 'psn') value -= wi * HORIZON / 16;
	if (mon.status === 'tox') value -= wi * HORIZON * 2 / 16;
	return value;
}

function evaluate(engine, st, opts) {
	opts = opts || {};
	const w = opts.importance || importance(engine, st);
	let hp = 0;
	st.me.team.forEach(m => { if (!m.fainted && m.curHP > 0) hp += (w[m.set.species] || 1) * m.curHP / m.maxHP; });
	let cond = 0;
	alive(st.foe).forEach(j => { try { cond += theirConditions(engine, st, j, w); } catch (e) { /* unscored */ } });
	alive(st.me).forEach(i => { try { cond += ourConditions(engine, st, i, w); } catch (e) { /* unscored */ } });
	return {hp, cond, importance: w};
}

/**
 * Price delta for a line that took the position from `before` to `after`:
 * negative when the position improved. HP is handled by the caller (weighted
 * spend); this is the conditions part, capped.
 */
function condDelta(engine, before, after, w) {
	const b = evaluate(engine, before, {importance: w}).cond;
	const a = evaluate(engine, after, {importance: w}).cond;
	const d = a - b;
	return -Math.max(-POS_CAP, Math.min(POS_CAP, d));
}

module.exports = {importance, evaluate, condDelta, bestHit, expectedMid, IMPORTANCE, POS_CAP};
