/**
 * Turn a line typed by a human into the jobs the planner already speaks.
 *
 * James's framing, and the reason this exists: "When I give a path it doesn't
 * mean it is the best option, it is either a query or a suggestion that in most
 * cases will be better than the current options." So the point of parsing is
 * not to obey the line, it is to get it into the SAME representation the
 * planner prices its own candidates in, so the two can be compared honestly and
 * the answer to "why didn't you do that" is a number instead of an argument.
 *
 * The grammar is deliberately the way the fight gets talked about out loud:
 *
 *   lilligant sleep powder then diggersby bulldoze
 *   lanturn, mienshao
 *   switch to lanturn
 *   breloom bullet seed x3 > mienshao drain punch
 *
 * Legs split on "then", a comma, ">" or "->". In each leg the longest prefix
 * that names one of ours wins, and whatever is left over names one of its
 * moves. Both are matched loosely (case, spaces and punctuation are ignored,
 * and a unique prefix is enough) because nobody types "Baby-Doll Eyes".
 *
 * WHAT IT REFUSES TO GUESS: how long a leg lasts. `until` is the difference
 * between "sleep it once and bring in the closer" and "spam Sleep Powder until
 * somebody faints", and those price nothing alike. A non-final leg defaults to
 * one click, `xN` asks for more, and the caller is expected to SHOW the reading
 * back so a wrong guess is visible rather than silently priced.
 */
'use strict';

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Loose match: exact normalised hit first, then a unique prefix. */
function resolve(candidates, text) {
	const want = norm(text);
	if (!want) return null;
	const exact = candidates.filter(c => norm(c) === want);
	if (exact.length === 1) return exact[0];
	const pre = candidates.filter(c => norm(c).startsWith(want));
	if (pre.length === 1) return pre[0];
	const has = candidates.filter(c => norm(c).includes(want));
	if (has.length === 1) return has[0];
	return null;
}

/**
 * @param team  state.me.team -- each entry {set: {species, moves}}
 * @param text  what the human typed
 * @returns {jobs, reading, error}
 */
function parseLine(team, text) {
	const species = team.map(m => m.set.species);
	const legs = String(text || '')
		.split(/\s*(?:,|->|>|\bthen\b|\band\b)\s*/i)
		.map(s => s.trim()).filter(Boolean);
	if (!legs.length) return {error: 'nothing to read'};

	const jobs = [], reading = [];
	for (let li = 0; li < legs.length; li++) {
		// "switch to Lanturn" and "bring in Lanturn" name a Pokemon like any
		// other leg; the verb carries no extra meaning here, since arriving is
		// what a leg does when its Pokemon is not already out.
		let leg = legs[li].replace(/^\s*(?:switch(?:\s+to)?|bring\s+in|send(?:\s+in)?|go|use)\s+/i, '');
		let uses = null;
		leg = leg.replace(/\s*[x*]\s*(\d+)\s*$/i, (m, n) => { uses = Number(n); return ''; }).trim();
		if (!leg) return {error: 'leg ' + (li + 1) + ' names nobody'};

		// THE LONGEST PREFIX THAT NAMES ONE OF OURS. Taking the first word
		// instead would break on nothing in this team but breaks immediately on
		// a two-word species, and the rest of the leg is the move, so the split
		// has to be found rather than assumed.
		const words = leg.split(/\s+/);
		let mon = null, used = 0;
		for (let n = Math.min(words.length, 3); n >= 1; n--) {
			const hit = resolve(species, words.slice(0, n).join(' '));
			if (hit) { mon = hit; used = n; break; }
		}
		if (!mon) {
			return {error: '"' + leg + '" does not name one of ours (have: '
				+ species.join(', ') + ')'};
		}

		const rest = words.slice(used).join(' ').trim();
		let move = null;
		if (rest) {
			const owner = team.find(m => m.set.species === mon);
			const moves = (owner && owner.set.moves) || [];
			move = resolve(moves, rest);
			if (!move) {
				return {error: '"' + rest + '" is not a move ' + mon + ' has (has: '
					+ moves.join(', ') + ')'};
			}
		}

		// A LEG THAT NEVER HANDS OVER SWALLOWS THE REST OF THE LINE. With no
		// `until`, a job holds the field until it or the target faints, so
		// "sleep it then bring the closer in" would price as "spam Sleep Powder
		// forever" and the second leg would be unreachable. One click is the
		// reading that makes a prep-then-kill line mean what it says out loud;
		// the last leg keeps the open-ended default because finishing the job
		// IS its exit condition.
		const job = {mon: mon};
		if (move) job.moves = [move];
		else job.moves = [];
		const last = li === legs.length - 1;
		if (uses !== null) job.until = {uses: uses};
		else if (!last) job.until = {uses: 1};
		jobs.push(job);
		reading.push(mon + (move ? ' ' + move : '')
			+ (job.until ? ' x' + job.until.uses : '')
			+ (last && !job.until ? ' (until it or the target faints)' : ''));
	}
	return {jobs: jobs, reading: reading.join(', then ')};
}

module.exports = {parseLine, resolve, norm};
