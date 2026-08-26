/**
 * Monte Carlo tree search over the Nuzlocke objective.
 *
 * WHY THIS EXISTS. The fixed-depth search in rr-solver.js scores positions with
 * a hand-weighted evaluation, and it has hit a hard ceiling: three separate
 * fixes -- porting more of the CFRU AI, making a lost Pokemon cost more than a
 * won battle, and releasing the forcing flag that banned switching -- each
 * improved the decision they targeted and each left the clean-win rate at
 * exactly 81/135. Depth does not help either: lookahead 2, 3 and 4 all score
 * the same. That combination is the signature of a search optimising a PROXY.
 * Better local decisions cannot pay off when the thing being maximised is not
 * the thing you want.
 *
 * This searches the real objective instead: the probability of winning without
 * losing a single Pokemon. A line is scored by playing the battle out and
 * looking at how it ended, so "progress", "health" and "death risk" stop being
 * numbers someone chose and become consequences.
 *
 * The design follows what the strongest open-source Showdown bot (Foul Play)
 * moved to after abandoning expectimax, adapted to the fact that this problem is
 * much easier than theirs in one specific way:
 *
 *   - THE OPPONENT IS NOT ADVERSARIAL AND NOT HIDDEN. Trainer teams are known
 *     exactly, and CFRU picks uniformly at random among the moves tied at the
 *     top score. So there is no set prediction to do, no minimax, and no DUCT.
 *     The opponent is a known stochastic policy, which makes this a Markov
 *     decision process rather than a game, and MCTS is the right tool for it.
 *   - VARIABLE DEPTH. The promising lines get followed to the end of the battle
 *     while hopeless ones are abandoned after a couple of turns. That matters
 *     here because the fights this fails on are long: Surge's team pivots and
 *     heals, and a plan for it is fifteen turns, not two.
 *   - DAMAGE ROLLS GROUPED BY WHETHER THEY KILL. What matters about a roll is
 *     almost never its exact value, it is whether the target faints. See
 *     sampleSuccessor.
 */
var RRMCTS = (function () {
	"use strict";

	var C = 1.4;              // UCT exploration constant
	var ROLLOUT_TURNS = 24;   // fights this long are already lost in practice

	function countFainted(side) {
		var n = 0;
		for (var i = 0; i < side.team.length; i++) if (side.team[i].fainted) n++;
		return n;
	}

	function teamHP(side) {
		var cur = 0, max = 0;
		for (var i = 0; i < side.team.length; i++) {
			cur += side.team[i].curHP;
			max += side.team[i].maxHP;
		}
		return max ? cur / max : 0;
	}

	function alive(side) {
		for (var i = 0; i < side.team.length; i++) if (!side.team[i].fainted) return true;
		return false;
	}

	/**
	 * What a Nuzlocke is actually trying to maximise.
	 *
	 * A clean win is 1 and everything else is worth strictly less, but the
	 * gradations matter: MCTS averages this over many playouts, so a flat
	 * "1 or 0" would leave the search unable to tell a fight it nearly won from
	 * one it was never in, and every action would look equally bad in a losing
	 * position. The ordering encoded here is the one James plays by -- winning
	 * while losing a Pokemon ranks below surviving, because in a Nuzlocke the
	 * Pokemon does not come back.
	 */
	function reward(state, finished) {
		var meAlive = alive(state.me), foeAlive = alive(state.foe);
		var losses = countFainted(state.me);

		if (!foeAlive && meAlive) {
			// A clean win is the objective. Winning while losing Pokemon is
			// still far better than losing the battle -- in a Nuzlocke a lost
			// battle usually ends the run -- but it is not what we are after.
			return losses === 0 ? 1 : 0.40 / (1 + losses);
		}

		// Everything below here is a fight not won, and it all has to stay under
		// the worst win above (0.40/7 for a six-Pokemon wipeout) or the search
		// would rather stall than finish.
		//
		// It also has to have a GRADIENT. The first version returned a flat 0
		// for a wipe, and against a losing position every action scored exactly
		// 0.000, leaving the search nothing to choose between: it played the
		// first legal move every turn. Credit for damage done is what lets it
		// tell "nearly took the last one down" from "never threatened anything".
		var progress = 1 - teamHP(state.foe);
		var kills = countFainted(state.foe) / Math.max(1, state.foe.team.length);
		var base = 0.06 * progress + 0.02 * kills;

		// A wipe has to rank below an unresolved fight with everyone still
		// standing, or the search would rather die making progress than hold on.
		if (!meAlive) return base * 0.2;
		return base + 0.02 * teamHP(state.me) * (losses === 0 ? 1 : 0.5);
	}

	/**
	 * The opponent's real policy: uniform over the moves tied at the top.
	 *
	 * Memoised on the position, because this is the hot path by a wide margin.
	 * Every step of every rollout asks what the AI would do, which is thousands
	 * of calls per decision, and scoring an action set is not cheap -- it prices
	 * damage for every move the opponent has. Positions repeat constantly inside
	 * a search, so the cache pays for itself immediately. It is cleared per
	 * decision in chooseAction, since it is only valid while the field is fixed.
	 */
	var tieCache = {};

	function tiedActions(state, opts) {
		if (typeof RRAI === "undefined") return null;
		var key = RRBattle.positionKey(state);
		var hit = tieCache[key];
		if (hit !== undefined) return hit;

		var flags = (opts && opts.flagSets && opts.flagSets[0]) ||
			{checkBadMove: true, checkGoodMove: true};
		var scored = RRAI.scoreAll(state, "foe", flags, {});
		var gate = RRAI.switchGate(state, "foe", flags);
		var best = -Infinity, tied = [];
		for (var i = 0; i < scored.length; i++) {
			var entry = scored[i];
			if (entry.action.type === "switch" && !gate.maySwitch) continue;
			if (entry.score > best) { best = entry.score; tied = [entry.action]; }
			else if (entry.score === best) tied.push(entry.action);
		}
		tieCache[key] = tied;
		return tied;
	}

	function foeAction(state, opts) {
		var tied = tiedActions(state, opts);
		if (!tied || !tied.length) return null;
		return tied.length === 1 ? tied[0]
			: tied[Math.floor(Math.random() * tied.length)];
	}

	/**
	 * The reply to PLAY OUT, as opposed to the one to search against.
	 *
	 * The search samples ties because that is what the engine really does. But a
	 * route that gets shown, or scored by the benchmark, has to be one fight
	 * rather than one sample of a fight: RRSolver.planRoute advances at median
	 * rolls against the AI's argmax, and if this sampled dice instead it would
	 * be charged for bad luck the other engine never experiences. Comparing the
	 * two engines is only meaningful when both play the same fight.
	 */
	function deterministicReply(state, opts) {
		var tied = tiedActions(state, opts);
		return (tied && tied.length) ? tied[0] : null;
	}

	/**
	 * Advance one turn, sampling the dice honestly.
	 *
	 * `odds` mode enumerates outcome branches with real probabilities, which is
	 * what makes the result a probability rather than a guess. The fork budget
	 * is what keeps it affordable: what matters about a damage roll is nearly
	 * always whether it knocks the target out, not its exact value, so a couple
	 * of branches per turn captures the decision-relevant part and the rest is
	 * detail the search would only average back out again.
	 */
	function sampleSuccessor(state, myAction, theirAction, forkBudget) {
		var outcomes;
		try {
			outcomes = RRBattle.step(state, myAction, theirAction,
				{mode: "odds", forkBudget: forkBudget});
		} catch (e) { return null; }
		if (!outcomes || !outcomes.length) return null;
		if (outcomes.length === 1) return outcomes[0].state;

		var total = 0, i;
		for (i = 0; i < outcomes.length; i++) total += outcomes[i].probability;
		var pick = Math.random() * total;
		for (i = 0; i < outcomes.length; i++) {
			pick -= outcomes[i].probability;
			if (pick <= 0) return outcomes[i].state;
		}
		return outcomes[outcomes.length - 1].state;
	}

	/**
	 * The rollout policy: cheap, and only has to be better than random.
	 *
	 * Deliberately NOT a one-ply search. That was tried in the solver's playout
	 * mode and it optimises the same proxy the tree is trying to escape, at a
	 * cost that buys far fewer playouts. Here the tree does the thinking and the
	 * rollout only has to avoid being actively stupid.
	 */
	// Epsilon keeps FULL SUPPORT: with probability EPS the rollout plays a
	// uniformly random legal action, so every strategy -- status lines
	// included -- has nonzero probability of being explored. METHOD.md's
	// second condition, and the one both of this repo's searches violated:
	// "a sampling method can only discover strategies its sampling
	// distribution can generate." The old policy scored status moves a flat
	// 0.05, so a rollout essentially never slept anything, and a position
	// whose value came from sleeping Pawmot was scored as if that option did
	// not exist.
	var ROLLOUT_EPS = 0.15;

	function rolloutAction(state) {
		var actions = RRBattle.legalActions(state, "me");
		if (Math.random() < ROLLOUT_EPS && actions.length) {
			return actions[Math.floor(Math.random() * actions.length)];
		}
		var best = null, bestScore = -Infinity;
		var defender = RRBattle.active(state.foe);
		for (var i = 0; i < actions.length; i++) {
			var action = actions[i], score;
			if (action.type === "switch") {
				// Only worth considering when the Pokemon standing there is
				// nearly gone; otherwise switching burns the turn.
				var me = RRBattle.active(state.me);
				score = me.curHP * 3 < me.maxHP ? 0.35 : -1;
			} else {
				var rolls = RRBattle.damageRolls(state, "me", action.move);
				// A status move is not "5% of a kill", it is a different kind
				// of good. 0.25 keeps it competitive with weak chip damage
				// without beating a real attack; epsilon covers the rest.
				if (!rolls) { score = 0.25; }
				else {
					var hit = rolls.noCrit[rolls.noCrit.length - 1];
					score = Math.min(1, hit / Math.max(1, defender.curHP));
				}
			}
			if (score > bestScore) { bestScore = score; best = action; }
		}
		return best;
	}

	/**
	 * Leaf values are memoised on the position.
	 *
	 * The rollout policy and the transition are both deterministic, so a second
	 * rollout from the same leaf retraces the first one almost exactly and
	 * returns the same number. Since scoring the opponent's options costs about
	 * 155us and dominates everything else in the search, recomputing an answer
	 * already known is where the budget was going.
	 */
	// THE CACHE IS GONE, and it has to be. It was justified by the rollouts
	// being deterministic -- which was defect 1. Once rollouts sample real
	// dice, memoising the first sample turns N samples into 1 and the
	// estimate stops converging; the two defects were load-bearing on each
	// other, which is exactly what the second pass of METHOD.md predicted:
	// "fixing the sampling requires removing the cache, and the cache is
	// there because sampling was removed for speed."
	function rollout(state, opts, turnsLeft) {
		return runRollout(state, opts, turnsLeft);
	}

	/**
	 * The opponent inside a rollout: whatever hurts most, right now.
	 *
	 * Scoring the real CFRU rules costs about 265us and a rollout asks the
	 * question every turn, which made it the entire cost of the search. The tree
	 * still uses the true model, where the decision is actually being made; down
	 * in the rollout an opponent that reliably picks a hard-hitting move is
	 * close enough to keep the outcome honest, and buys several times as many
	 * playouts for the same budget. This is the usual division of labour in
	 * MCTS: an accurate model near the root, a fast one below it.
	 */
	function cheapFoeAction(state) {
		var foe = RRBattle.active(state.foe);
		var moves = (foe.set && foe.set.moves) || [];
		var best = null, bestDamage = -1;
		for (var i = 0; i < moves.length; i++) {
			var rolls = RRBattle.damageRolls(state, "foe", moves[i]);
			var hit = rolls ? rolls.noCrit[rolls.noCrit.length - 1] : 0;
			if (hit > bestDamage) { bestDamage = hit; best = moves[i]; }
		}
		if (!best) return null;
		return {type: "move", move: best};
	}

	function runRollout(state, opts, turnsLeft) {
		var current = state, turns = 0;
		while (turns < turnsLeft) {
			if (!alive(current.me) || !alive(current.foe)) break;
			var mine = rolloutAction(current);
			var theirs = cheapFoeAction(current);
			if (!mine || !theirs) break;
			// Rollouts SAMPLE the real distribution. The old median-roll
			// stepping defended itself as washing out variance, but that is
			// right about variance and wrong about BIAS: median rolls with no
			// crits and no player secondaries is not noise around the truth,
			// it is a consistent shift away from it, and averaging more of it
			// does not help. Our own Scald never burned; the line James
			// actually wins with was invisible. forkBudget 2 keeps the
			// branches to the decision-relevant split (does it KO or not).
			var next = sampleSuccessor(current, mine, theirs, 2);
			if (!next) break;
			current = next;
			turns++;
		}
		return reward(current, turns < turnsLeft);
	}

	function makeNode(state) {
		return {
			state: state,
			visits: 0,
			expanded: false,
			actions: null,
			stats: null      // one {visits, total, kids} per action
		};
	}

	function expand(node) {
		node.actions = RRBattle.legalActions(node.state, "me");
		node.stats = [];
		for (var i = 0; i < node.actions.length; i++) {
			node.stats.push({visits: 0, total: 0, kids: {}});
		}
		node.expanded = true;
	}

	function selectAction(node) {
		var best = -1, bestValue = -Infinity;
		var logN = Math.log(node.visits + 1);
		for (var i = 0; i < node.stats.length; i++) {
			var stat = node.stats[i];
			// Anything untried is tried first: with a handful of playouts per
			// node an unvisited action is the most informative thing available.
			if (!stat.visits) return i;
			var value = stat.total / stat.visits + C * Math.sqrt(logN / stat.visits);
			if (value > bestValue) { bestValue = value; best = i; }
		}
		return best < 0 ? 0 : best;
	}

	function simulate(node, opts, depth, budget) {
		if (!alive(node.state.me) || !alive(node.state.foe)) {
			return reward(node.state, true);
		}
		if (depth >= budget.maxTurns) return reward(node.state, false);

		if (!node.expanded) {
			expand(node);
			if (!node.actions.length) return reward(node.state, false);
			var value = rollout(node.state, opts, budget.maxTurns - depth);
			node.visits++;
			return value;
		}
		if (!node.actions.length) return reward(node.state, false);

		var index = selectAction(node);
		var stat = node.stats[index];
		var theirs = foeAction(node.state, opts);
		if (!theirs) return reward(node.state, false);

		var next = sampleSuccessor(node.state, node.actions[index], theirs,
			budget.forkBudget);
		if (!next) return reward(node.state, false);

		// Successors are kept per distinct resulting position, so the tree stays
		// a tree over states rather than collapsing genuinely different dice
		// outcomes onto one node.
		var key = RRBattle.positionKey(next);
		var child = stat.kids[key];
		if (!child) { child = makeNode(next); stat.kids[key] = child; }

		var result = simulate(child, opts, depth + 1, budget);
		stat.visits++;
		stat.total += result;
		node.visits++;
		return result;
	}

	/**
	 * Choose this turn's action.
	 *
	 * Returns the most VISITED action rather than the highest mean. With few
	 * playouts a mean can be carried by one lucky rollout, while visit count is
	 * what the search actually committed its budget to, and it is the standard
	 * choice for that reason.
	 */
	function chooseAction(state, options) {
		var opts = options || {};
		var iterations = opts.iterations || 300;
		var budget = {
			maxTurns: opts.rolloutTurns || ROLLOUT_TURNS,
			forkBudget: opts.forkBudget === undefined ? 2 : opts.forkBudget
		};
		var deadline = opts.timeLimitMs ? Date.now() + opts.timeLimitMs : null;

		tieCache = {};
		var root = makeNode(state);
		for (var i = 0; i < iterations; i++) {
			simulate(root, opts, 0, budget);
			if (deadline && (i & 15) === 15 && Date.now() > deadline) break;
		}
		if (!root.expanded || !root.actions.length) return null;

		var best = 0, bestVisits = -1;
		for (var a = 0; a < root.stats.length; a++) {
			if (root.stats[a].visits > bestVisits) {
				bestVisits = root.stats[a].visits;
				best = a;
			}
		}
		var chosen = root.stats[best];
		return {
			action: root.actions[best],
			visits: chosen.visits,
			value: chosen.visits ? chosen.total / chosen.visits : 0,
			considered: root.actions.length,
			playouts: root.visits
		};
	}

	/**
	 * Play a whole battle, re-searching every turn.
	 *
	 * Shaped to match RRSolver.planRoute's result so the benchmark and the panel
	 * can run either one against the same measurement without special cases.
	 */
	function planRoute(state, options) {
		var opts = options || {};
		var maxTurns = opts.maxTurns || 30;
		var started = Date.now();
		var current = state;
		var steps = [];

		while (steps.length < maxTurns) {
			if (!alive(current.me) || !alive(current.foe)) break;
			RRBattle.clearCache();
			var choice = chooseAction(current, opts);
			if (!choice || !choice.action) break;
			var theirs = deterministicReply(current, opts);
			if (!theirs) break;

			var before = current;
			var next;
			try {
				next = RRBattle.step(current, choice.action, theirs,
					{mode: "maxroll", risks: opts.risks || {}})[0].state;
			} catch (e) { break; }
			if (!next) break;

			steps.push({
				turn: steps.length + 1,
				myMon: RRBattle.active(before.me).species,
				action: choice.action,
				label: choice.action.type === "switch"
					? "switch to " + before.me.team[choice.action.index].species
					: choice.action.move,
				theirMon: RRBattle.active(before.foe).species,
				theirAction: theirs,
				theirLabel: theirs.type === "switch" ? "they switch" : "they use " + theirs.move,
				myHP: RRBattle.active(next.me).curHP,
				myMaxHP: RRBattle.active(next.me).maxHP,
				theirHP: RRBattle.active(next.foe).curHP,
				lost: countFainted(next.me),
				knockedOut: countFainted(next.foe) > countFainted(before.foe),
				confidence: choice.value
			});
			current = next;
		}

		var wonIt = !alive(current.foe) && alive(current.me);
		return {
			steps: steps,
			won: wonIt,
			losses: countFainted(current.me),
			lostNames: current.me.team.filter(function (m) { return m.fainted; })
				.map(function (m) { return m.species; }),
			turns: steps.length,
			stalled: !wonIt && steps.length >= maxTurns,
			elapsedMs: Date.now() - started
		};
	}

	return {
		chooseAction: chooseAction,
		planRoute: planRoute,
		reward: reward,
		_foeAction: foeAction,
		_rollout: rollout
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRMCTS;
