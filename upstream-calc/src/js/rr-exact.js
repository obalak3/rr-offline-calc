/**
 * Exact search for a clean win.
 *
 * This exists because of something that is true of THIS problem and not of
 * Pokemon in general: there is nothing to guess. Trainer teams are known
 * exactly, down to natures, items and EVs, and CFRU picks the top-scoring move
 * by a rule we have ported from its source. Strip the dice out -- which is what
 * planning at the median roll does -- and the whole battle is a finite graph
 * with no hidden information and no opponent to outguess. "Is there a line that
 * wins without losing anybody" stops being a judgement call and becomes a
 * question with an answer.
 *
 * So this does not score positions, weight anything, or estimate. It looks for
 * a line, and when it finds one that line is not a recommendation, it is a
 * proof: play these moves and, at median rolls against this AI, nothing dies.
 *
 * WHY IT IS AFFORDABLE. Two things, and the first is the Nuzlocke rule itself:
 *
 *   1. One faint kills the branch. The objective is winning without losses, so
 *      the instant anything of yours goes down the line is worthless and is cut
 *      rather than explored. The search only ever walks lines where everything
 *      is still alive, which is a small corner of the tree.
 *   2. The opponent does not branch. It is a known function of the position, so
 *      only YOUR choices multiply -- roughly eight or ten per turn instead of
 *      eighty.
 *
 * Positions are memoised, so a fight that loops back to somewhere already tried
 * costs nothing.
 *
 * WHAT IT DOES NOT COVER. Median rolls only. A line proved here holds when the
 * dice behave and says nothing about a critical hit landing at the wrong
 * moment, which is why a route still has to be shown with its risks. Extending
 * this to real dice means bucketing damage by whether it KILLS rather than by
 * its value, since that is nearly always the only part of a roll that changes
 * what happens next. Not done yet, and deliberately not pretended.
 */
var RRExact = (function () {
	"use strict";

	var RISKS = {roll: "median"};

	function countFainted(side) {
		var n = 0;
		for (var i = 0; i < side.team.length; i++) if (side.team[i].fainted) n++;
		return n;
	}

	function allDown(side) {
		for (var i = 0; i < side.team.length; i++) if (!side.team[i].fainted) return false;
		return true;
	}

	/** The AI's reply: a function of the position, not a distribution. */
	function reply(state, opts) {
		if (typeof RRAI === "undefined") return null;
		var flags = (opts && opts.flagSets && opts.flagSets[0]) ||
			{checkBadMove: true, checkGoodMove: true};
		var scored = RRAI.scoreAll(state, "foe", flags, {});
		var gate = RRAI.switchGate(state, "foe", flags);
		var best = null;
		for (var i = 0; i < scored.length; i++) {
			var entry = scored[i];
			if (entry.action.type === "switch" && !gate.maySwitch) continue;
			if (!best || entry.score > best.score) best = entry;
		}
		return best ? best.action : null;
	}

	/**
	 * Try the promising actions first.
	 *
	 * This searches for ONE witness: the moment a clean line is found the answer
	 * is settled and everything else would be wasted work, so the order actions
	 * are tried in is most of the cost. Kills first, then damage, then switches
	 * -- switches are numerous and rarely open a winning line, so trying them
	 * last is what keeps the branching factor honest.
	 *
	 * Ordering changes how long the answer takes and never what it is: when this
	 * reports "impossible" it has still tried everything.
	 */
	function ordered(state) {
		var defender = RRBattle.active(state.foe);
		var actions = RRBattle.legalActions(state, "me");
		var ranked = [];
		for (var i = 0; i < actions.length; i++) {
			var action = actions[i], rank;
			if (action.type === "switch") {
				rank = -1;
			} else {
				var rolls = RRBattle.damageRolls(state, "me", action.move);
				var hit = rolls ? rolls.noCrit[rolls.noCrit.length - 1] : 0;
				rank = hit >= defender.curHP ? 1000 + hit : hit;
			}
			ranked.push({action: action, rank: rank});
		}
		ranked.sort(function (a, b) { return b.rank - a.rank; });
		var out = [];
		for (var j = 0; j < ranked.length; j++) out.push(ranked[j].action);
		return out;
	}

	/**
	 * Find a clean line, or determine there is none.
	 *
	 * Three outcomes, and the difference between the last two is the whole point
	 * of reporting `decided`:
	 *   found                a line exists and is returned
	 *   decided, not found   the search finished; no line exists
	 *   not decided          the budget ran out first, so nothing is known
	 *
	 * Conflating the last two would turn "I ran out of time" into "you cannot
	 * win this", which is the one lie this module must never tell.
	 */
	function cleanWin(state, options) {
		var opts = options || {};
		var limits = {
			nodes: 0,
			budget: opts.budget || 400000,
			maxTurns: opts.maxTurns || 24,
			exhausted: false,
			truncated: false
		};
		var seen = {};
		var line = [];
		var started = Date.now();
		var deadline = opts.timeLimitMs ? started + opts.timeLimitMs : null;

		function walk(current, turnsLeft) {
			if (limits.nodes++ > limits.budget) { limits.exhausted = true; return false; }
			if (deadline && (limits.nodes & 1023) === 0 && Date.now() > deadline) {
				limits.exhausted = true;
				return false;
			}
			if (allDown(current.foe)) return true;
			if (turnsLeft <= 0) { limits.truncated = true; return false; }

			var key = RRBattle.positionKey(current);
			if (seen[key]) return false;
			seen[key] = true;

			var theirs = reply(current, opts);
			if (!theirs) return false;

			var before = countFainted(current.me);
			var actions = ordered(current);
			for (var i = 0; i < actions.length; i++) {
				var next;
				try {
					next = RRBattle.step(current, actions[i], theirs,
						{mode: "maxroll", risks: RISKS})[0].state;
				} catch (e) { continue; }
				// The cut that makes this tractable.
				if (countFainted(next.me) > before) continue;

				line.push({state: current, action: actions[i], theirAction: theirs,
					next: next});
				if (walk(next, turnsLeft - 1)) return true;
				line.pop();
			}
			return false;
		}

		var found = walk(state, limits.maxTurns);
		return {
			found: found,
			decided: found || !(limits.exhausted || limits.truncated),
			nodes: limits.nodes,
			elapsedMs: Date.now() - started,
			line: found ? line.slice() : null
		};
	}

	/** Render a found line in the same shape planRoute produces. */
	function toSteps(line) {
		var steps = [];
		for (var i = 0; i < line.length; i++) {
			var entry = line[i];
			var before = entry.state, next = entry.next, action = entry.action;
			steps.push({
				turn: i + 1,
				myMon: RRBattle.active(before.me).species,
				action: action,
				label: action.type === "switch"
					? "switch to " + before.me.team[action.index].species
					: action.move,
				theirMon: RRBattle.active(before.foe).species,
				theirAction: entry.theirAction,
				theirLabel: entry.theirAction.type === "switch"
					? "they switch"
					: "they use " + entry.theirAction.move,
				myHP: RRBattle.active(next.me).curHP,
				myMaxHP: RRBattle.active(next.me).maxHP,
				theirHP: RRBattle.active(next.foe).curHP,
				lost: countFainted(next.me),
				knockedOut: countFainted(next.foe) > countFainted(before.foe)
			});
		}
		return steps;
	}

	/**
	 * A route, exact where that is possible and heuristic where it is not.
	 *
	 * Ask for the proof first. If there is a clean line, play it -- no
	 * evaluation function can do better than a line that provably loses nobody.
	 * Only when the search cannot settle the question does this fall back to the
	 * weighted search, which always returns something.
	 *
	 * `exactness` on the result says which happened, because the two deserve
	 * different trust: "proved" means the fight is won at median rolls, while
	 * "heuristic" means this is the best guess available.
	 */
	function planRoute(state, options) {
		var opts = options || {};
		var started = Date.now();
		RRBattle.clearCache();
		var proof = cleanWin(state, opts);

		if (proof.found) {
			var steps = toSteps(proof.line);
			var end = proof.line.length ? proof.line[proof.line.length - 1].next : state;
			return {
				steps: steps,
				won: true,
				losses: countFainted(end.me),
				lostNames: [],
				turns: steps.length,
				stalled: false,
				exactness: "proved",
				nodes: proof.nodes,
				elapsedMs: Date.now() - started
			};
		}

		if (typeof RRSolver === "undefined") {
			return {
				steps: [], won: false, losses: 0, lostNames: [], turns: 0,
				stalled: true,
				exactness: proof.decided ? "proved-impossible" : "undecided",
				nodes: proof.nodes, elapsedMs: Date.now() - started
			};
		}
		RRBattle.clearCache();
		var fallback = RRSolver.planRoute(state, opts);
		fallback.exactness = proof.decided ? "no-clean-line-exists" : "undecided";
		fallback.exactNodes = proof.nodes;
		return fallback;
	}

	return {
		cleanWin: cleanWin,
		planRoute: planRoute,
		toSteps: toSteps
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRExact;
