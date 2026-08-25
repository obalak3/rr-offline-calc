/**
 * The ROM's HP bar, and what a reader can conclude from looking at one.
 *
 * One copy, because two would drift. `tools/hp_from_bar.js` measures this and
 * `tools/lib/live.js` depends on it at runtime, and this repo has been bitten
 * three times by a helper existing twice.
 *
 * Gen 3 scales the health bar to a fixed pixel width with integer division and
 * never shows an empty bar for a living Pokemon:
 *
 *     filled = floor(cur * width / max),  at least 1 while cur > 0
 *
 * Which means the bar alone pins HP to an interval of about max/48, ALWAYS --
 * it is re-derived from the current frame, so unlike a running total it cannot
 * accumulate error over a long fight.
 */
'use strict';

const BAR_WIDTH = 48;

/** Filled pixels the game would draw. */
function barPixels(cur, max, width) {
	if (cur <= 0) return 0;
	return Math.max(1, Math.floor((cur * (width || BAR_WIDTH)) / max));
}

/**
 * Every HP value that would render as this bar. Returns {lo, hi} inclusive.
 *
 * Derived by scanning rather than by inverting the formula: the min-1 clamp
 * makes the inverse piecewise, and a scan over at most `max` values is trivial
 * next to a damage calculation.
 */
function hpRange(pixels, max, width) {
	let lo = null, hi = null;
	for (let h = 1; h <= max; h++) {
		if (barPixels(h, max, width) === pixels) {
			if (lo === null) lo = h;
			hi = h;
		}
	}
	return lo === null ? null : {lo: lo, hi: hi};
}

/**
 * Narrow a bar reading with what we know we did.
 *
 * `candidates` are the HP values reachable from the previous HP given our
 * move's sixteen rolls. Intersecting is what turns a bar into a number, and
 * measured over real teams it lands on a single value 57.5% of the time at
 * level 34. When it does not, the answer is still an interval a point or two
 * wide, which is why callers take a range rather than a number.
 */
function narrow(pixels, max, candidates, width) {
	const range = hpRange(pixels, max, width);
	if (!range) return null;
	if (!candidates || !candidates.length) return range;
	const kept = candidates.filter(h => h >= range.lo && h <= range.hi);
	if (!kept.length) return range;   // disagreement: trust the bar, not our model
	return {lo: Math.min.apply(null, kept), hi: Math.max.apply(null, kept)};
}

module.exports = {BAR_WIDTH, barPixels, hpRange, narrow};
