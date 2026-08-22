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

	return {solve: solve, describe: describe, stateKey: stateKey};
})();
