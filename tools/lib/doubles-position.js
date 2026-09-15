'use strict';
/**
 * WHAT A DOUBLES POSITION IS WORTH, measured rather than labelled.
 *
 * The advisor could already say what a turn COSTS (their HP removed, ours
 * lost, who fainted) but not what it CHANGED: a Dark Void that puts both of
 * ours to sleep, a Swords Dance in front of us, an Intimidate on arrival. Those
 * were printed beside the line and left out of the ranking, because James's
 * standing rule is that constants are derived and not tuned -- "a stat move is
 * not an improvement by itself" -- and inventing "sleep = 60" is exactly the
 * external fitted rule he has rejected twice.
 *
 * So this measures them the way position.js does in singles, on the real
 * after-state the hidden core reports:
 *
 *   a condition on THEIR side is worth the damage their real moves no longer
 *   do to our living Pokemon; a condition on OUR side is worth the damage our
 *   real moves no longer do to theirs. Sleep is worth the turns lost. Nothing
 *   is worth anything for having a name.
 *
 * Doubles changes two things about that sum. Each of their attackers threatens
 * BOTH of ours, so a drop on one of them is measured against both; and both of
 * ours can be hit by the same spread move, so the same drop pays twice.
 *
 * The answer is in HP, which is the same currency the rest of the score uses.
 */

const POS = require('./position.js');

// How many turns of their offence a lasting condition is measured over. This
// is position.js's own horizon, kept identical so singles and doubles agree
// about what an Attack drop is worth.
const HORIZON = Number(process.env.RR_POS_HORIZON || 3);

/** A set the engine can price, built from what the battle struct actually says. */
function setFromBattler(dex, b) {
	if (!b || !b.species || b.maxhp === 0) return null;
	const rec = dex.byID[b.species];
	const name = rec && (rec.key || rec.name);
	if (!name) return null;
	const moves = (b.moves || []).map(id => dex.moveName[id]).filter(Boolean);
	if (!moves.length) return null;
	let ability;
	for (const k in dex.dex.abilities) {
		if (dex.dex.abilities[k].ID === b.ability) { ability = dex.dex.abilities[k].names[0]; break; }
	}
	let item = '';
	if (b.item) for (const k in dex.dex.items) {
		if (dex.dex.items[k].ID === b.item) { item = dex.dex.items[k].names ? dex.dex.items[k].names[0] : dex.dex.items[k].name; break; }
	}
	return {
		species: name, level: b.level, nature: 'Serious',
		ability, item: item || '',
		moves,
		evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
		// The observed stats ARE the truth; the engine solves for the base stat
		// that reproduces each one rather than guessing a spread.
		rawStats: b.stats && b.stats.length === 5
			? {atk: b.stats[0], def: b.stats[1], spe: b.stats[2], spa: b.stats[3], spd: b.stats[4]}
			: undefined
	};
}

/** Status word bits, gen 3 layout. */
function statusOf(word) {
	if (word & 0x07) return 'slp';
	if (word & 0x08) return 'psn';
	if (word & 0x10) return 'brn';
	if (word & 0x20) return 'frz';
	if (word & 0x40) return 'par';
	if (word & 0x80) return 'tox';
	return null;
}
// The struct's sleep counter is turns REMAINING and counts down (measured: a
// freshly slept Greninja read 3). position.js uses the opposite convention --
// turns lost so far -- so the two must not be mixed, which cost this file its
// first reading, where a three-turn sleep priced at zero.
function sleepLeft(word) { return word & 0x07; }

/** Stat stages as the engine names them; the struct stores them base 6. */
const STAGE_KEYS = [null, 'atk', 'def', 'spe', 'spa', 'spd', 'accuracy', 'evasion'];
function boostsOf(stages) {
	const out = {};
	(stages || []).forEach((v, i) => {
		const k = STAGE_KEYS[i];
		if (k && v !== 6) out[k] = v - 6;
	});
	return out;
}

/**
 * Build a 2v2 engine position from an oracle observation: our two actives as
 * `me`, their two as `foe`, each carrying its real stats, status and stages.
 * Returns null when the position cannot be priced (an empty slot, an unknown
 * species), which the caller must treat as "no measurement", never as zero.
 */
function stateFrom(engine, dex, obs) {
	const B = obs.battlers;
	const mine = [0, 2].filter(b => B[b] && B[b].hp > 0);
	const theirs = [1, 3].filter(b => B[b] && B[b].hp > 0);
	if (!mine.length || !theirs.length) return null;
	const mySets = mine.map(b => setFromBattler(dex, B[b]));
	const foeSets = theirs.map(b => setFromBattler(dex, B[b]));
	if (mySets.some(s => !s) || foeSets.some(s => !s)) return null;
	let st;
	try { st = engine.B.createState(mySets, foeSets, {}); } catch (e) { return null; }
	// Carry what the struct says across: HP, status and stages are the whole
	// point of the measurement and createState starts them clean.
	mine.forEach((b, i) => {
		const m = st.me.team[i], src = B[b];
		m.curHP = src.hp; m.status = statusOf(src.status);
		m.sleepLeft = m.status === 'slp' ? sleepLeft(src.status) : 0;
		m.boosts = boostsOf(src.stages);
	});
	theirs.forEach((b, i) => {
		const m = st.foe.team[i], src = B[b];
		m.curHP = src.hp; m.status = statusOf(src.status);
		m.sleepLeft = m.status === 'slp' ? sleepLeft(src.status) : 0;
		m.boosts = boostsOf(src.stages);
	});
	return {st, mine, theirs};
}

/** One party row's raw record, decoded into a set the engine can price. */
function setFromRecord(engine, dex, row) {
	const RRSave = engine.sandbox && engine.sandbox.RRSave;
	if (!RRSave || !RRSave.readRecord || !row || !row.maxhp) return null;
	if (typeof row.raw !== 'string' || row.raw.length < 200) return null;
	try {
		const bytes = Buffer.from(row.raw, 'hex');
		const mon = RRSave.readRecord(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, true);
		if (!mon || !mon.species) return null;
		return {species: mon.species, level: mon.level, nature: mon.nature,
			ability: mon.ability, item: mon.item || '', moves: mon.moves,
			evs: mon.evs, ivs: mon.ivs};
	} catch (e) { return null; }
}

/**
 * The WHOLE fight as an engine position -- both parties, not just the four on
 * the field -- so the existing answer table can say which of ours matters.
 *
 * importance() in position.js reads "how many of their remaining Pokemon can
 * this one of ours remove cleanly", which is the difference between losing the
 * Pokemon that beats their last two and losing a spare. It needs full teams,
 * and the oracle ships both parties as raw records, so nothing new has to be
 * invented for doubles: the same table, asked the same question.
 */
function fullState(engine, dex, obs) {
	const mine = (obs.party || []).map(r => setFromRecord(engine, dex, r));
	const theirs = (obs.foeparty || []).map(r => setFromRecord(engine, dex, r));
	const myIdx = [], foeIdx = [];
	const mySets = [], foeSets = [];
	mine.forEach((s2, i) => { if (s2) { mySets.push(s2); myIdx.push(i); } });
	theirs.forEach((s2, i) => { if (s2) { foeSets.push(s2); foeIdx.push(i); } });
	if (!mySets.length || !foeSets.length) return null;
	let st;
	try { st = engine.B.createState(mySets, foeSets, {}); } catch (e) { return null; }
	myIdx.forEach((src, i) => {
		const row = obs.party[src], m = st.me.team[i];
		m.curHP = row.hp; m.fainted = row.hp === 0;
		m.status = statusOf(row.status);
	});
	foeIdx.forEach((src, i) => {
		const row = obs.foeparty[src], m = st.foe.team[i];
		m.curHP = row.hp; m.fainted = row.hp === 0;
		m.status = statusOf(row.status);
	});
	// Whoever is on the field leads, so the table is asked about the real position.
	const B = obs.battlers;
	const findIdx = (team, sp, mx) => team.findIndex(m => m.maxHP === mx && !m.fainted);
	if (B && B[0]) { const k = findIdx(st.me.team, B[0].species, B[0].maxhp); if (k >= 0) st.me.active = k; }
	if (B && B[1]) { const k = findIdx(st.foe.team, B[1].species, B[1].maxhp); if (k >= 0) st.foe.active = k; }
	return {st, myIdx, foeIdx};
}

/**
 * Importance per species, from the same duel table singles uses: 1, plus half
 * for every remaining opponent this Pokemon is a clean answer to. Computed
 * ONCE per position and reused for every probe, because the 6x6 table is the
 * expensive part. Returns null when the teams cannot be read, so the caller
 * weights everything equally rather than guessing.
 */
function importanceOf(engine, dex, obs) {
	const full = fullState(engine, dex, obs);
	if (!full) return null;
	try { return POS.importance(engine, full.st); } catch (e) { return null; }
}

/** A copy of the position with one Pokemon's conditions wiped, to measure against. */
function neutral(engine, st, side, idx) {
	const c = engine.B.clone(st);
	const m = c[side].team[idx];
	m.boosts = {}; m.status = null; m.sleepLeft = 0; m.sleepTurns = 0;
	return c;
}

/**
 * The conditions in this position, in HP.
 *
 * Positive is good for us. Their drops and status are counted as damage they
 * no longer do to us; ours are counted as damage we no longer do to them.
 * Every term is a measurement against the same position with that one
 * Pokemon's conditions removed, so a condition that changes nothing scores
 * nothing -- which is the whole point.
 */
function conditions(engine, built) {
	if (!built) return {value: 0, terms: [], measured: false};
	const {st, mine, theirs} = built;
	const B = engine.B;
	const terms = [];
	let value = 0;

	// THEIR conditions: damage their real moves no longer do to our living two.
	// Each of their attackers reaches both of ours, so both are measured.
	theirs.forEach((_, j) => {
		const foe = st.foe.team[j];
		const hasAny = foe.status || Object.keys(foe.boosts || {}).some(k => foe.boosts[k]);
		if (!hasAny) return;
		const base = neutral(engine, st, 'foe', j);
		let removed = 0;
		mine.forEach((__, i) => {
			const was = POS.bestHit(engine, base, 'foe', j, i) * st.me.team[i].maxHP;
			const now = POS.bestHit(engine, st, 'foe', j, i) * st.me.team[i].maxHP;
			removed += Math.max(0, was - now);
		});
		// Damage no longer done, over the horizon. A sleeping attacker loses
		// whole TURNS instead, which is counted once and never horizon-scaled
		// on top -- that is position.js's shape and the two must agree.
		let v = HORIZON * removed / Math.max(1, theirs.length);
		if (foe.status === 'slp') {
			const left = foe.sleepLeft || 0;
			let best = 0;
			mine.forEach((__, i) => { best = Math.max(best, POS.bestHit(engine, st, 'foe', j, i) * st.me.team[i].maxHP); });
			v += left * best;
		}
		if (Math.abs(v) > 0.5) {
			value += v;
			terms.push({side: 'theirs', who: st.foe.team[j].set.species, hp: Math.round(v)});
		}
	});

	// OUR conditions: damage our real moves no longer do to their living two.
	mine.forEach((_, i) => {
		const me = st.me.team[i];
		const hasAny = me.status || Object.keys(me.boosts || {}).some(k => me.boosts[k]);
		if (!hasAny) return;
		const base = neutral(engine, st, 'me', i);
		let removed = 0;
		theirs.forEach((__, j) => {
			const was = POS.bestHit(engine, base, 'me', i, j) * st.foe.team[j].maxHP;
			const now = POS.bestHit(engine, st, 'me', i, j) * st.foe.team[j].maxHP;
			removed += Math.max(0, was - now);
		});
		let v = HORIZON * removed / Math.max(1, mine.length);
		if (me.status === 'slp') {
			const left = me.sleepLeft || 0;
			let best = 0;
			theirs.forEach((__, j) => { best = Math.max(best, POS.bestHit(engine, st, 'me', i, j) * st.foe.team[j].maxHP); });
			v += left * best;
		}
		if (Math.abs(v) > 0.5) {
			value -= v;
			terms.push({side: 'ours', who: st.me.team[i].set.species, hp: -Math.round(v)});
		}
	});

	return {value, terms, measured: true};
}

/**
 * What the CHANGE in conditions across a turn is worth, in HP. This is what
 * the advisor adds to its score: the position after, minus the position
 * before, so a turn is credited only with what it actually changed.
 *
 * Returns null when either end could not be priced, so the caller can say
 * "not measured" rather than quietly scoring it zero.
 */
function delta(engine, dex, beforeObs, afterObs) {
	const a = stateFrom(engine, dex, beforeObs);
	const b = stateFrom(engine, dex, afterObs);
	if (!a || !b) return null;
	let ca, cb;
	try { ca = conditions(engine, a); cb = conditions(engine, b); } catch (e) { return null; }
	if (!ca.measured || !cb.measured) return null;
	return {value: cb.value - ca.value, before: ca, after: cb};
}

module.exports = {setFromBattler, setFromRecord, stateFrom, fullState, importanceOf, conditions, delta, statusOf, sleepLeft, boostsOf, HORIZON};
