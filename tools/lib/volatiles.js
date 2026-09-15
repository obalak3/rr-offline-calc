'use strict';
/**
 * THE VOLATILE WORD, in ONE place.
 *
 * status2 is the game's per-battler word of lasting conditions that are not
 * statuses: a Substitute standing in front of something, confusion, a trap, a
 * Destiny Bond. Both the singles brain (agent.js buildState) and the doubles
 * one (doubles-position.js) have to read it, and James's standing rule after
 * the roster incident is that nothing gets a second reader:
 *
 *   "You keep doing things in the background and adding separate things that
 *    are connected to each other, and they mess each other up."
 *
 * He is right, and this file exists because the first version of this decoding
 * was written into agent.js alone and would have been copied into the doubles
 * path within the hour. The bug that prompted all of it was the same shape:
 * buildState wrote `volatiles.confusion` while the engine reads
 * `volatiles.confused`, so the confusion reading never worked at all.
 *
 * SUBSTITUTE IS VERIFIED AGAINST A LIVE RECORDING, not an assumed layout. In
 * James's Giovanni fight of 2026-09-10, Orthworm used Shed Tail on turn 68 and
 * Infernape arrived carrying 0x01000000, held it through turns 69-71 at an
 * untouched 140/140 while we attacked it, lost the bit on turn 72 and took real
 * damage from 73. The rest of the layout is vanilla gen 3, which that one
 * confirmed bit and the long-standing confusion mask both agree with.
 *
 * NOT IN THIS WORD: Leech Seed (gStatuses3), Taunt, Encore and Disable
 * (gDisableStructs). They are listed in tools/audit_score_inputs.js as still
 * unread rather than guessed at.
 */

const BITS = {
	confusion: 0x00000007,
	lockedIn: 0x00000C00,
	wrapped: 0x0000E000,
	focusEnergy: 0x00100000,
	recharge: 0x00400000,
	substitute: 0x01000000,
	destinyBond: 0x02000000,
	escapePrevention: 0x04000000,
	cursed: 0x10000000,
	torment: 0x80000000
};

const ON = process.env.RR_VOLATILES !== '0';

/**
 * Write what the word says onto an engine Pokemon, using the ENGINE's own
 * names for each volatile. `maxHP` is needed for the substitute, whose size
 * the bit does not carry.
 */
function applyTo(mon, word) {
	const w = Number(word) || 0;
	if (!w || !ON || !mon) return mon;
	if (!mon.volatiles) mon.volatiles = {};
	const v = mon.volatiles;
	const conf = w & BITS.confusion;
	if (conf) v.confused = conf;
	if (w & BITS.lockedIn) v.lockedIn = true;
	if ((w & BITS.wrapped) || (w & BITS.escapePrevention)) v.trapped = true;
	if (w & BITS.focusEnergy) v.focusEnergy = true;
	if (w & BITS.recharge) v.recharge = true;
	if (w & BITS.destinyBond) v.destinyBond = true;
	if (w & BITS.cursed) v.cursed = true;
	if (w & BITS.torment) v.torment = true;
	if (w & BITS.substitute) {
		// The engine carries a substitute's REMAINING HP and takes damage off
		// it; the bit only says one is standing. How much is left lives in
		// another structure that is not mapped, so this uses the game's own
		// standard size, a quarter of the holder's maximum. A Shed Tail
		// substitute is half the SETTER's maximum and is usually bigger, so
		// this can under-read one -- the direction that makes us bolder, which
		// is why the exact address is on the open list.
		v.substitute = Math.max(1, Math.floor((mon.maxHP || 4) / 4));
	}
	return mon;
}

/** What the word says, in words, for a log line or a report. */
function describe(word) {
	const w = Number(word) || 0;
	if (!w) return [];
	const out = [];
	if (w & BITS.confusion) out.push('confused');
	if (w & BITS.substitute) out.push('behind a Substitute');
	if ((w & BITS.wrapped) || (w & BITS.escapePrevention)) out.push('trapped');
	if (w & BITS.lockedIn) out.push('locked into a move');
	if (w & BITS.focusEnergy) out.push('pumped up');
	if (w & BITS.recharge) out.push('recharging');
	if (w & BITS.destinyBond) out.push('under Destiny Bond');
	if (w & BITS.cursed) out.push('cursed');
	if (w & BITS.torment) out.push('tormented');
	return out;
}

module.exports = {BITS, applyTo, describe, ON};
