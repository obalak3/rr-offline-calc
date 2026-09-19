'use strict';
/**
 * A LINE THAT LOSES NOBODY OUTRANKS ONE THAT DOES, whatever the score.
 *
 * James, 2026-09-19, watching Skeledirge switched into a Pyro Ball at 48 HP and
 * lost while Infernape sat at 50: "why is our planner rating skeliderge dying a
 * 492, while the other lines with no losses a 508 and 515?"
 *
 * Because the arithmetic says so. Losing one of ours is charged 30 x importance,
 * about 60; removing one of THEIRS pays 1000. And a dying Pokemon's remaining HP
 * is already counted in the position term, so the death itself adds almost
 * nothing on top -- the code's own comment admitted that a 1 HP Pokemon dying is
 * "nearly free". Under that arithmetic a team is a pool of HP and trading a
 * Pokemon for a kill is usually correct. It is not correct for a Nuzlocke, where
 * a Pokemon at 1 HP is still a whole Pokemon and its loss is permanent.
 *
 * Pricing a faint properly means knowing whether a sacrifice SAVES the run, that
 * one is enough, and which Pokemon to spend. James called that a much larger
 * thing and deferred it deliberately. So the rule sits ABOVE the arithmetic
 * instead: the score still orders within each group, and decides alone when
 * every line loses someone.
 *
 * Doubles has had this since 2026-09-15, where it turned a guard fight from
 * won-losing-Accelgor into won-with-everyone. This is the same rule, in one
 * place, so the two cannot drift.
 */

/**
 * Choose between the plan and its rivals on the real game's own results.
 *
 * @param plan       {score, lost}          the action already chosen
 * @param rivals     [{score, lost, ref}]   everything else that was played
 * @param margin     how much better a rival must be to displace an EQUALLY
 *                   clean plan; never applied when the plan loses someone and
 *                   a rival does not
 * @param enabled    false restores the plain margin comparison
 * @returns {pick, why} where pick is the winning rival or null for "keep the plan"
 */
function choose(plan, rivals, margin, enabled) {
	const on = enabled !== false;
	const list = (rivals || []).filter(r => r && isFinite(r.score));
	if (!list.length) return {pick: null, why: ''};
	const byScore = list.slice().sort((a, b) => b.score - a.score);

	if (on && plan.lost) {
		// The plan spends a Pokemon. Anything that does not is better, full stop.
		const clean = byScore.find(r => !r.lost);
		if (clean) {
			return {
				pick: clean,
				why: 'it loses nobody where the plan loses one of ours, on the real game ('
					+ Math.round(clean.score) + ' against ' + Math.round(plan.score) + ', margin not applied)'
			};
		}
		// Everything on offer loses someone; the score decides alone, as before.
	}

	// The plan keeps everyone, so a rival that does not is never an upgrade.
	const eligible = on && !plan.lost ? byScore.filter(r => !r.lost) : byScore;
	if (eligible.length && eligible[0].score > plan.score + margin) {
		return {
			pick: eligible[0],
			why: 'scores ' + Math.round(eligible[0].score) + ' against the plan\'s '
				+ Math.round(plan.score) + ' in HP-equivalents on the real game'
		};
	}
	return {pick: null, why: ''};
}

module.exports = {choose};
