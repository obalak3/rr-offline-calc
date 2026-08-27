/**
 * Team variants, for asking "what if I brought this instead".
 *
 * The party normally comes off the save (harness.realTeam). A variant swaps one
 * or more members so a plan can be tested against a team the player is
 * considering rather than only the one they are carrying. James specified this
 * one himself, and attached a claim to it that is worth treating as a test:
 *
 *   "Replace lilligant with gyarados, level 34, adamant, intimidate, aqua fang
 *    ice fang leer bite sitrus berry. I can win that encounter 100% of the time
 *    0 losses."
 *
 * If the planner cannot find a zero-loss line for that team, the planner is
 * wrong, not James.
 */
'use strict';

const VARIANTS = {
	gyarados: {
		replaces: 'Lilligant',
		set: {
			species: 'Gyarados', level: 34, nature: 'Adamant',
			ability: 'Intimidate', item: 'Sitrus Berry',
			moves: ['Aqua Tail', 'Ice Fang', 'Leer', 'Bite'],
			evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
		}
	}
};

/** Apply a named variant, or return the party untouched. */
function variant(party, name) {
	if (!name) return party;
	const v = VARIANTS[name.toLowerCase()];
	if (!v) throw new Error('unknown team variant: ' + name
		+ ' (have: ' + Object.keys(VARIANTS).join(', ') + ')');
	const out = party.map(p => p.species === v.replaces
		? Object.assign({}, v.set) : p);
	if (!out.some(p => p.species === v.set.species)) {
		throw new Error('variant ' + name + ' expected ' + v.replaces + ' on the team');
	}
	return out;
}

module.exports = {variant, VARIANTS};
