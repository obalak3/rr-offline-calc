/**
 * rr-solver.js -- search for a line that wins no matter what.
 *
 * An AND-OR search. Your turn is an OR node: one action needs to work. The
 * opponent's is an AND node: the line has to hold against *every* reply it
 * might make. Chance is collapsed to its worst reading for you (rr-battle's
 * "worst" mode), so a line this returns wins against every combination of
 * enemy choice and dice roll it considered.
 *
 * What that guarantee is and is not:
 *
 *   It IS one-directional. A reported win is real. Finding nothing means no
 *   proof was found within the budget, NOT that the fight is unwinnable, and
 *   the caller must not render it as one.
 *
 *   It is bounded by the plausible set. The line holds against every action in
 *   that set. While the set is every legal action -- which is what ships until
 *   the CFRU scoring is ported -- that is the strongest reading available: it
 *   covers any opponent policy at all, the real AI included.
 *
 *   It is bounded by what rr-battle actually simulates. Anything it could not
 *   model lands in state.unmodelled and is reported alongside the line, because
 *   a proof over a mechanic we skipped in silence is not a proof.
 *
 * No DOM: this is what the worker runs.
 */
/* global RRBattle, RRPlan */
var RRSolver = (function () {
	"use strict";

	var WIN = "win", LOSS = "loss", UNKNOWN = "unknown";

	// ------------------------------------------------------- win probability

	/**
	 * How often you win, if they play to stop you.
	 *
	 * Expectimax with the opponent MINIMISING rather than being averaged over,
	 * so the answer reads "you win at least this often however they play". It is
	 * a floor, not an estimate, and every approximation below leans the same
	 * way so it stays one:
	 *
	 *   - running out of depth counts as a loss, never as a win
	 *   - surviving HP is read pessimistically for you in both directions
	 *   - once the fork budget is spent, the pessimistic branch takes the whole
	 *     probability mass
	 *
	 * Faint chances themselves are exact, computed from the 16 rolls and the
	 * crit rate, because that is the part the answer actually turns on.
	 *
	 * This replaces the old "reliability" figure, which measured whether one
	 * precise line ran uninterrupted rather than whether you won: it reported a
	 * level 45 sweep of level 13s as 23.7%, because a single paralysis cost 25%
	 * a turn, when failing that roll costs a turn and not the game.
	 */
	function winProbability(state, depth, ctx) {
		if (ctx.nodes >= ctx.budget) { ctx.exhausted = true; return 0; }
		ctx.nodes++;

		var over = RRBattle.isOver(state);
		if (over === "win") return 1;
		if (over === "loss") return 0;

		var position = RRBattle.positionKey(state);
		if (depth <= 0) {
			// Running out of depth used to count as a loss outright, which is
			// sound but wildly pessimistic: most of the probability mass ends up
			// on "did not finish in time" rather than on "lost", and a level 45
			// sweep came out at 63%. So spend a little worst-case search at the
			// leaf instead. A proof is a proof, so returning 1 on one is still a
			// floor, and it converts most truncated branches into real wins.
			var leafKey = "leaf:" + position;
			var leaf = ctx.table[leafKey];
			if (leaf === undefined) {
				// Bounded globally, not just per leaf. In a losing position every
				// leaf proof runs to its budget and fails, and paying that at
				// each of them is what took a two-Pokemon fight to 99 seconds.
				// Giving up returns 0, which is still a floor.
				if (ctx.leafSpend >= ctx.leafSpendCap) return 0;
				var proof = solveProof(state, {
					maxDepth: ctx.leafDepth, budget: ctx.leafBudget, options: ctx.options
				});
				ctx.leafSpend += proof.nodes;
				leaf = proof.result === WIN ? 1 : 0;
				ctx.table[leafKey] = leaf;
			}
			return leaf;
		}

		var key = position + "@" + depth;
		var cached = ctx.table[key];
		if (cached !== undefined) { ctx.hits++; return cached; }

		var myActions = orderedMyActions(state);
		var foeActions = RRPlan.plausibleFoeActions(state, ctx.options);
		var best = 0;
		var bestAction = null;

		for (var i = 0; i < myActions.length && best < 1; i++) {
			var worst = 1;
			for (var j = 0; j < foeActions.length; j++) {
				var successors = cachedStep(ctx, position, state, myActions[i],
					foeActions[j]);
				var probability = 0;
				for (var k = 0; k < successors.length; k++) {
					probability += successors[k].probability *
						winProbability(successors[k].state, depth - 1, ctx);
				}
				if (probability < worst) worst = probability;
				// They will pick this reply, so nothing better can come of the
				// rest: this action is already no better than one we have.
				if (worst <= best) break;
			}
			if (worst > best) { best = worst; bestAction = myActions[i]; }
		}

		ctx.table[key] = best;
		ctx.bestAt[position] = bestAction;
		return best;
	}

	/**
	 * Enumerating a turn re-runs it once per coin-flip path, so the same
	 * (position, your action, their action) triple was being expanded from
	 * scratch every time the search came back to it. Caching the successor list
	 * is the single biggest saving in odds mode.
	 */
	function cachedStep(ctx, position, state, myAction, foeAction) {
		var key = position + "#" +
			(myAction.type === "switch" ? "s" + myAction.index : myAction.move) + "#" +
			(foeAction.type === "switch" ? "s" + foeAction.index : foeAction.move);
		var hit = ctx.steps[key];
		if (hit) return hit;
		var successors = RRBattle.step(state, myAction, foeAction,
			{mode: "odds", forkBudget: ctx.forkBudget});
		ctx.steps[key] = successors;
		return successors;
	}

	/**
	 * The line to follow, read back off the solved position. Chance is shown at
	 * its most likely successor only: the full tree branches on every roll and
	 * is unreadable, while what you want on screen is what to click.
	 */
	function readLine(state, depth, ctx, seen) {
		if (depth <= 0 || RRBattle.isOver(state)) return null;
		var key = RRBattle.positionKey(state);
		if (seen[key]) return null;
		seen[key] = true;
		var action = ctx.bestAt[key];
		if (!action) return null;

		var branches = RRPlan.plausibleFoeActions(state, ctx.options).map(function (foeAction) {
			var successors = RRBattle.step(state, action, foeAction,
				{mode: "odds", forkBudget: ctx.forkBudget});
			var likeliest = successors[0];
			for (var i = 1; i < successors.length; i++) {
				if (successors[i].probability > likeliest.probability) likeliest = successors[i];
			}
			return {
				foeAction: foeAction,
				probability: likeliest.probability,
				next: readLine(likeliest.state, depth - 1, ctx, seen),
				outcome: RRBattle.isOver(likeliest.state)
			};
		});
		return {action: action, branches: branches};
	}

	/**
	 * Everything that distinguishes one position from another. Two positions
	 * with the same key are the same search problem, which is what makes the
	 * transposition table sound.
	 */
	function stateKey(state) {
		var parts = [];
		["me", "foe"].forEach(function (side) {
			var s = state[side];
			parts.push(s.active);
			s.team.forEach(function (mon) {
				parts.push(mon.curHP, mon.fainted ? 1 : 0, mon.status || "-",
					mon.sleepTurns, mon.toxicCounter, mon.itemGone ? 1 : 0,
					mon.boosts.atk, mon.boosts.def, mon.boosts.spa,
					mon.boosts.spd, mon.boosts.spe, mon.boosts.acc, mon.boosts.eva,
					mon.pp.join("."),
					mon.volatiles.substitute || 0,
					mon.volatiles.leechSeed ? 1 : 0,
					mon.volatiles.taunt || 0,
					mon.volatiles.protecting ? 1 : 0);
			});
			parts.push(s.hazards.stealthrock, s.hazards.spikes,
				s.hazards.toxicspikes, s.hazards.stickyweb);
			var names = Object.keys(s.screens).sort();
			parts.push(names.map(function (n) { return n + s.screens[n]; }).join(","));
		});
		var f = state.field;
		parts.push(f.weather || "-", f.weatherTurns === Infinity ? "P" : f.weatherTurns,
			f.terrain || "-", f.terrainTurns === Infinity ? "P" : f.terrainTurns,
			f.trickRoom);
		return parts.join("|");
	}

	/**
	 * Try the strongest-looking action first. Getting a win on the first branch
	 * of an OR node means the rest are never expanded, and against a losing
	 * position good ordering is what makes the difference between finishing and
	 * hitting the budget.
	 */
	function orderedMyActions(state) {
		var actions = RRBattle.legalActions(state, "me");
		var scored = actions.map(function (action) {
			var weight = -1;
			if (action.type === "move") {
				var rolls = RRBattle.damageRolls(state, "me", action.move);
				// Worst-case damage, since that is what the proof runs on.
				weight = rolls ? rolls.noCrit[0] : 0;
			}
			return {action: action, weight: weight};
		});
		// Hardest hit first, switches last. Deliberately not RRPlan.advise: that
		// runs a whole depth-one analysis, race included, and calling it at every
		// node to sort four items was most of the search's cost.
		scored.sort(function (a, b) { return b.weight - a.weight; });
		return scored.map(function (entry) { return entry.action; });
	}

	function search(state, depth, ctx) {
		if (ctx.nodes >= ctx.budget) { ctx.exhausted = true; return {result: UNKNOWN}; }
		ctx.nodes++;

		var over = RRBattle.isOver(state);
		if (over === "win") return {result: WIN, line: null, reliability: state.reliability};
		if (over === "loss") return {result: LOSS};
		if (depth <= 0) return {result: UNKNOWN};

		var key = stateKey(state) + "@" + depth;
		var cached = ctx.table[key];
		if (cached !== undefined) { ctx.hits++; return cached; }

		var myActions = orderedMyActions(state);
		var best = {result: UNKNOWN};

		for (var i = 0; i < myActions.length; i++) {
			var myAction = myActions[i];
			var foeActions = RRPlan.plausibleFoeActions(state, ctx.options);
			var branches = [];
			var holds = true;

			for (var j = 0; j < foeActions.length; j++) {
				var successors = RRBattle.step(state, myAction, foeActions[j], {mode: "worst"});
				// "worst" yields a single successor; if that ever changes, every
				// one of them has to hold, not just the first.
				var childResult = null;
				for (var k = 0; k < successors.length; k++) {
					var child = search(successors[k].state, depth - 1, ctx);
					if (child.result !== WIN) { childResult = child; break; }
					childResult = child;
				}
				if (!childResult || childResult.result !== WIN) { holds = false; break; }
				branches.push({
					foeAction: foeActions[j],
					reliability: childResult.reliability !== undefined ?
						childResult.reliability : 1,
					next: childResult.line || null
				});
			}

			if (holds) {
				// The line is only as reliable as its worst branch.
				var worst = 1;
				for (var b = 0; b < branches.length; b++) {
					if (branches[b].reliability < worst) worst = branches[b].reliability;
				}
				best = {result: WIN, reliability: worst,
					line: {action: myAction, branches: branches}};
				break;
			}
		}

		ctx.table[key] = best;
		return best;
	}

	/**
	 * Iterative deepening. Shallow wins are found first, which is what you want:
	 * a three-turn proof is more use than an eight-turn one, and the shallow
	 * passes fill the table for the deeper ones.
	 */
	function solve(state, options) {
		var opts = options || {};
		if ((opts.mode || "odds") === "odds") return solveOdds(state, opts);
		return solveProof(state, opts);
	}

	function solveOdds(state, options) {
		var opts = options || {};
		var maxDepth = opts.maxDepth || 8;
		var started = Date.now();
		var ctx = {
			nodes: 0, hits: 0, budget: opts.budget || 300000,
			table: {}, steps: {}, bestAt: {}, exhausted: false, options: opts,
			forkBudget: opts.forkBudget === undefined ? 6 : opts.forkBudget,
			leafDepth: opts.leafDepth === undefined ? 6 : opts.leafDepth,
			leafBudget: opts.leafBudget === undefined ? 1200 : opts.leafBudget,
			leafSpend: 0,
			leafSpendCap: opts.leafSpendCap === undefined ? 60000 : opts.leafSpendCap
		};

		// Deeper can only ever find more wins, so the last pass is the answer;
		// stop early once it is certain.
		var probability = 0, reachedDepth = 0;
		for (var depth = 1; depth <= maxDepth; depth++) {
			ctx.table = {};   // depth-keyed, so it cannot survive; ctx.steps can
			probability = winProbability(state, depth, ctx);
			reachedDepth = depth;
			if (probability >= 0.999999) break;
			if (ctx.exhausted) break;
			if (opts.timeLimitMs && Date.now() - started > opts.timeLimitMs) break;
		}

		return {
			mode: "odds",
			winProbability: probability,
			result: probability >= 0.999999 ? WIN
				: (probability > 0 ? "partial" : UNKNOWN),
			depth: reachedDepth,
			line: readLine(state, reachedDepth, ctx, {}),
			nodes: ctx.nodes,
			elapsedMs: Date.now() - started,
			exhausted: ctx.exhausted,
			unmodelled: state.unmodelled.slice(),
			assumption: RRPlan.advise(state, opts).assumption,
			meaning: "a floor, not an estimate: they are assumed to play the reply " +
				"that hurts you most, running out of depth counts as a loss, and " +
				"surviving HP is read against you. The true figure is higher."
		};
	}

	function solveProof(state, options) {
		var opts = options || {};
		var maxDepth = opts.maxDepth || 8;
		var started = Date.now();
		var totalNodes = 0;
		var exhausted = false;

		for (var depth = 1; depth <= maxDepth; depth++) {
			var ctx = {
				nodes: 0, hits: 0, budget: opts.budget || 200000,
				table: {}, exhausted: false, options: opts
			};
			var found = search(state, depth, ctx);
			totalNodes += ctx.nodes;
			exhausted = exhausted || ctx.exhausted;

			if (found.result === WIN) {
				return {
					result: WIN,
					depth: depth,
					// Worst-case damage and crits throughout; this is the chance
					// the per-turn re-rolls (accuracy, full paralysis) all go the
					// way the line needs.
					reliability: found.reliability === undefined ? 1 : found.reliability,
					// Said in words because the number reads badly on its own. It
					// is a floor on your win chance, not an estimate of it: every
					// branch holds at least this often, and the worst branch is
					// already one where their crits and secondaries all landed.
					// A level 45 sweep of level 13s reports 23.7% because one
					// Spark paralysis costs 25% a turn for five turns.
					reliabilityMeaning: "worst-case damage, crits and enemy choices " +
						"throughout; within the worst branch the per-turn rolls " +
						"(accuracy, full paralysis) hold this often, so treat it as " +
						"a lower bound on the win chance rather than the win chance",
					line: found.line,
					nodes: totalNodes,
					elapsedMs: Date.now() - started,
					exhausted: false,
					unmodelled: state.unmodelled.slice(),
					assumption: RRPlan.advise(state, opts).assumption
				};
			}
			if (opts.timeLimitMs && Date.now() - started > opts.timeLimitMs) {
				exhausted = true;
				break;
			}
		}

		return {
			result: UNKNOWN,
			depth: maxDepth,
			line: null,
			nodes: totalNodes,
			elapsedMs: Date.now() - started,
			exhausted: exhausted,
			unmodelled: state.unmodelled.slice(),
			// Said explicitly because the difference matters: we did not find a
			// proof, which is not the same as there not being one.
			meaning: exhausted
				? "no proof found before the search budget ran out"
				: "no proof found within " + maxDepth + " turns"
		};
	}

	/** Flatten the winning line into readable turns. */
	function describe(line, state, indent) {
		var out = [];
		if (!line) return out;
		var pad = new Array((indent || 0) + 1).join("  ");
		var label = line.action.type === "switch"
			? "switch to " + state.me.team[line.action.index].species
			: line.action.move;
		out.push(pad + "> " + label);
		(line.branches || []).forEach(function (branch) {
			var reply = branch.foeAction.type === "switch"
				? "they switch" : "they use " + branch.foeAction.move;
			out.push(pad + "  if " + reply + ":");
			if (branch.next) {
				out = out.concat(describe(branch.next, state, (indent || 0) + 2));
			} else {
				out.push(pad + "    won");
			}
		});
		return out;
	}

	return {
		solve: solve,
		solveOdds: solveOdds,
		solveProof: solveProof,
		describe: describe,
		stateKey: stateKey
	};
})();
