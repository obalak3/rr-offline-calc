/**
 * How hard is this fight, judged from THEIR TEAM rather than from a body count.
 *
 * James, 2026-09-02, rejecting the first version of the risk rule: "'while we
 * are ahead by two or more healthy bodies' shouldn't be a rule. You should
 * classify match difficulty according to the level of difficulty of the
 * opponent team."
 *
 * The unit is the duel, which this project already has: `duelLines` reports,
 * for one of ours against one of theirs, whether it kills, what fraction of our
 * HP it costs, and the exact probability our Pokemon faints. So difficulty is
 * read off the answer table -- for each Pokemon still on their side, how many of
 * ours can remove it cleanly:
 *
 *   easy    every remaining Pokemon of theirs has 2+ clean answers
 *   normal  at least one has exactly 1
 *   hard    at least one has none: a wall, and beating it will cost something
 *
 * ONLY LIVING POKEMON COUNT, on both sides, which is why no separate rule about
 * our own numbers is needed. Down to one Pokemon, no opponent can have two
 * answers, so the fight cannot classify as easy however weak they are -- the
 * measure collapses on its own exactly when risk has to be taken.
 *
 * A clean answer is a duel that KILLS at no more than CLEAN_RISK probability of
 * our Pokemon fainting. HP COST IS DELIBERATELY NOT PART OF IT. The first
 * version required cost <= 60% as well, and it misread the Lass Anne fight --
 * one James called among the easiest possible -- as `normal`, because Fluffy
 * makes Stufful expensive for a level 15 team: Froakie kills it for 63% of its
 * HP and Sandshrew for 61%, both at ZERO death risk, and both were thrown away
 * by the cost bar, leaving Stufful looking like it had a single answer. Cost is
 * what a plan pays; risk is what a plan risks, and only the second one belongs
 * in a decision about how much risk to accept. CLEAN_RISK is chosen, not
 * measured -- see docs/ASSUMPTIONS.md.
 *
 * Duels are fought from full HP deliberately: this is a statement about how
 * dangerous their team is, not about how the current turn is going. The caller
 * decides what to do with it.
 */
const D = require('./duels.js');

const CLEAN_RISK = Number(process.env.RR_CLEAN_RISK || 0.10);

// Keyed by who is still standing on both sides, so the table is rebuilt when a
// Pokemon faints and not on every turn -- a full 6x6 costs about three seconds.
const cache = new Map();

function aliveKey(st) {
	const live = side => side.team
		.map((m, i) => (m.fainted ? null : i + ':' + m.set.species))
		.filter(Boolean).join(',');
	return live(st.me) + ' | ' + live(st.foe);
}

/**
 * @returns {{tier: string, worst: number, answers: Array, key: string}}
 *   `worst` is the fewest clean answers any of their living Pokemon has.
 */
function classify(engine, st) {
	const key = aliveKey(st);
	if (cache.has(key)) return cache.get(key);

	const party = st.me.team.map(m => m.set);
	const foeSets = st.foe.team.map(m => m.set);
	const mine = st.me.team.map((m, i) => i).filter(i => !st.me.team[i].fainted);
	const theirs = st.foe.team.map((m, i) => i).filter(i => !st.foe.team[i].fainted);

	const answers = [];
	let worst = Infinity;
	for (const fi of theirs) {
		const clean = [];
		for (const mi of mine) {
			let best = null;
			try { best = (D.duelLines(engine, party, foeSets, mi, fi, {}, {}) || [])[0]; }
			catch (e) { best = null; }
			if (!best || best.outcome !== 'kill') continue;
			if ((best.deathRisk || 0) > CLEAN_RISK) continue;
			clean.push(party[mi].species);
		}
		answers.push({foe: foeSets[fi].species, clean: clean});
		if (clean.length < worst) worst = clean.length;
	}
	if (!isFinite(worst)) worst = 0;

	const tier = worst >= 2 ? 'easy' : (worst === 1 ? 'normal' : 'hard');
	const out = {tier: tier, worst: worst, answers: answers, key: key};
	cache.set(key, out);
	return out;
}

/**
 * How pessimistically to read a death, given the fight.
 *
 * CRITS ARE OUT. They were the original point of this -- a 15 HP Froakie in
 * one-crit range read as safe -- but pricing a crit into every death turned a
 * level 10 Clefairy into an unanswerable threat, and the planner accepted
 * losing two Pokemon to it in a fight it had itself classified EASY. James,
 * 2026-09-02: "fuck it ignore crits for now. This is going to take a lot of
 * energy to calibrate and I don't have the energy for it."
 *
 * So the ladder is now only about which damage ROLL to fear, which needs no
 * calibration: an easy or ordinary fight is read against their top roll, a hard
 * one against the median so it does not refuse every risky line. RR_CRIT_RISK=1
 * puts crits back for whoever picks this up again.
 */
function deathRisksFor(tier) {
	var crit = !!process.env.RR_CRIT_RISK;
	if (tier === 'easy') {
		return crit ? {roll: 'median', foeRoll: 'max', crit: true}
			: {roll: 'median', foeRoll: 'max'};
	}
	if (tier === 'normal') return {roll: 'median', foeRoll: 'max'};
	return {roll: 'median'};
}

module.exports = {classify, deathRisksFor, CLEAN_RISK};
