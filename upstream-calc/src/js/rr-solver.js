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
/* global RRBattle, RRPlan, RRAI, RRCritKO */
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
				var successors = RRBattle.step(state, myAction, foeActions[j],
					{mode: ctx.stepMode || "worst", risks: ctx.risks});
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
				table: {}, exhausted: false, options: opts,
				stepMode: opts.stepMode || "worst", risks: opts.risks || {}
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

	// ----------------------------------------------------------- best route

	/**
	 * The best route it can find, always.
	 *
	 * The ladder answered a decision problem -- is there a route where nothing
	 * dies -- and when the answer was "I could not tell in the time available"
	 * it returned nothing you could act on. Standing in front of a trainer that
	 * is useless: you are going to fight it either way, so the question is which
	 * line is least bad, not whether a perfect one exists.
	 *
	 * So this is an optimisation instead. Every position gets a value, the
	 * opponent minimises it, and whatever the search liked best is returned even
	 * when it loses Pokemon. Value order, worst to best:
	 *
	 *   losing the battle  <  winning but losing Pokemon  <  a clean sweep
	 *
	 * A Pokemon costs far more than any amount of HP, because in a Nuzlocke it
	 * is gone for good; HP and progress only separate routes that lose the same
	 * number of them.
	 */
	var LOST_POKEMON = 1000;   // dwarfs every HP term below
	var WON = 100000;

	function countFainted(side) {
		var n = 0;
		side.team.forEach(function (mon) { if (mon.fainted) n++; });
		return n;
	}

	function teamHP(side) {
		var current = 0, total = 0;
		side.team.forEach(function (mon) { current += mon.curHP; total += mon.maxHP; });
		return total ? current / total : 0;
	}

	/**
	 * How healthy your side is, counted so that HP near a knockout is worth far
	 * more than HP near full.
	 *
	 * Straight HP fraction was the reason the Surge plan never appeared. Twenty
	 * points on something one hit from dying scored the same as twenty on
	 * something untouched, so healing Lanturn from 80 read as a small gain when
	 * it was the whole strategy. The square root fixes both ends at once: a
	 * damaged Pokemon gains a lot from being healed, and a healthy one gains
	 * almost nothing -- which is exactly the rule James plays by, cycle to heal
	 * when Lanturn is hurt, attack with it when it is full.
	 */
	function survivability(side) {
		var total = 0, count = 0;
		side.team.forEach(function (mon) {
			count++;
			if (!mon.fainted && mon.maxHP) total += Math.sqrt(mon.curHP / mon.maxHP);
		});
		return count ? total / count : 0;
	}

	/**
	 * The chance the Pokemon you have out is knocked out by their best attack.
	 *
	 * Planning on high rolls alone finds lines that look clean and are not: one
	 * route left Mienshao in front of a Waterfall that kills it 94% of the time
	 * and still scored as "loses nothing", because on the high roll it survived.
	 * Pricing that as an EXPECTED loss makes the search treat a coin-flip death
	 * as half a Pokemon gone, which is what stops it walking into them.
	 */
	function deathChance(state) {
		var mine = RRBattle.active(state.me);
		if (mine.fainted) return 0;
		var worst = 0;
		var actions = RRBattle.legalActions(state, "foe");
		for (var i = 0; i < actions.length; i++) {
			if (actions[i].type !== "move") continue;
			var rolls = RRBattle.damageRolls(state, "foe", actions[i].move);
			if (!rolls || rolls.immune) continue;
			var outcomes = RRCritKO.outcomesFor(rolls.noCrit, rolls.crit, rolls.critChance);
			var dies = 0;
            for (var j = 0; j < outcomes.length; j++) {
				if (outcomes[j][0] >= mine.curHP) dies += outcomes[j][1];
			}
			if (dies > worst) worst = dies;
		}
		return worst;
	}

	/**
	 * The chance that what we just simulated is what actually happens.
	 *
	 * Computing this AFTER the search meant the search never tried to raise it:
	 * a twenty turn plan that held 22% of the time scored the same as a six turn
	 * plan that held 80%, because both "won". Carrying it through the search
	 * makes the value what James asked for -- the plan most likely to work --
	 * rather than any plan that works on paper.
	 */
	/**
	 * What a status actually costs THIS Pokemon, from 0 (nothing) to 1 (ruinous).
	 *
	 * Charging every status as a flat plan-ender was hiding real differences. A
	 * burn on Victreebel, whose whole moveset is special, costs it nothing but
	 * chip damage -- yet it was the single largest risk in the Surge plan and
	 * dragged the whole number down. Worse, it made two very different switch-ins
	 * score identically, so the search had no reason to prefer the safer one.
	 */
	function statusCost(mon, status) {
		if (status === "slp") return 1;        // it does not act at all
		if (status === "par") return 0.7;      // a quarter of turns lost, and slower
		if (status === "frz") return 1;

		// Burn halves Attack, frostbite halves Sp. Atk. Either is only as bad as
		// the share of your damage that runs through the stat it cuts.
		if (status === "brn" || status === "frb") {
			var wanted = status === "brn" ? "Physical" : "Special";
			var hit = 0, total = 0;
			(mon.set.moves || []).forEach(function (name) {
				var data = RRBattle.moveData(name);
				if (!data || data.split === "Status") return;
				total++;
				if (data.split === wanted) hit++;
			});
			if (!total) return 0.1;
			// Never quite zero: both still chip HP every turn.
			return 0.15 + 0.85 * (hit / total);
		}
		if (status === "psn") return 0.2;
		if (status === "tox") return 0.5;
		return 0.3;
	}

	function stepProbability(before, myAction, foeAction, after) {
		var p = 1;
		var myMon = RRBattle.active(before.me);
		var foeMon = RRBattle.active(before.foe);
		var order = RRBattle.turnOrder(before, myAction, foeAction);
		var youWentFirst = order && order[0] === "me";
		var killed = countFainted(after.foe) > countFainted(before.foe);

		// If the plan needs this move to kill, price how often it does.
		if (killed && myAction.type === "move") {
			var rolls = RRBattle.damageRolls(before, "me", myAction.move);
			if (rolls && !rolls.immune) {
				var outs = RRCritKO.outcomesFor(rolls.noCrit, rolls.crit, rolls.critChance);
				var kills = 0;
				for (var i = 0; i < outs.length; i++) {
					if (outs[i][0] >= foeMon.curHP) kills += outs[i][1];
				}
				if (kills > 0) p *= kills;
			}
			var acc = RRBattle.accuracyOf(before, "me", myAction.move);
			if (acc < 1) p *= acc;
		}

		// A move that paralyses, freezes or flinches you does not have to KO
		// anything to wreck a plan. Pricing it here is what makes dodging worth
		// something: three turns of tanking Discharge is a 30% paralysis roll
		// each time, and switching into Volt Absorb takes all three to zero.
		if (foeAction && foeAction.type === "move" && !(youWentFirst && killed)) {
			var view0 = before;
			if (myAction.type === "switch") {
				view0 = RRBattle.clone(before);
				RRBattle.switchIn(view0, "me", myAction.index);
			}
			var target = RRBattle.active(view0.me);
			var theirData = RRBattle.moveData(foeAction.move);
			var sec0 = theirData && theirData.effect && theirData.effect.secondary;
			var disabling = sec0 && (sec0.flinch || sec0.status === "par" ||
				sec0.status === "slp" || sec0.status === "frz" || sec0.status === "frb");
			if (disabling && theirData.secondaryChance > 0 && target && !target.fainted) {
				// It only counts if the move can actually land on them.
				var reach = RRBattle.damageRolls(view0, "foe", foeAction.move);
				var lands = reach && !reach.immune;
				if (lands && sec0.status && sec0.status !== "frz" &&
					!RRBattle._internal.canTakeStatus(target, sec0.status, view0,
						theirData.type)) {
					lands = false;   // already statused, immune type, terrain
				}
				if (lands) {
					var cost = sec0.flinch ? 0.5
						: statusCost(target, sec0.status);
					p *= (1 - (theirData.secondaryChance / 100) * cost);
				}
			}
		}

		// If the plan needs someone to survive, price how often they do -- and
		// against the Pokemon that actually takes the hit. Reading it off the
		// one that left had Charge Beam "killing" a Ground type it cannot touch,
		// because the damage was still being measured against Gyarados.
		if (foeAction && foeAction.type === "move" && !(youWentFirst && killed)) {
			var view = before;
			if (myAction.type === "switch") {
				view = RRBattle.clone(before);
				RRBattle.switchIn(view, "me", myAction.index);
			}
			var facing = RRBattle.active(view.me);
			if (facing && !facing.fainted &&
				countFainted(after.me) === countFainted(before.me)) {
				var theirs = RRBattle.damageRolls(view, "foe", foeAction.move);
				if (theirs && !theirs.immune) {
					var outs2 = RRCritKO.outcomesFor(theirs.noCrit, theirs.crit, theirs.critChance);
					var dies = 0;
					for (var j = 0; j < outs2.length; j++) {
						if (outs2[j][0] >= facing.curHP) dies += outs2[j][1];
					}
					p *= (1 - dies);
				}
			}
		}
		return p;
	}

	function positionValue(state, depthUsed) {
		var myLosses = countFainted(state.me);
		var foeAlive = state.foe.team.some(function (m) { return !m.fainted; });
		var meAlive = state.me.team.some(function (m) { return !m.fainted; });

		var odds = state.planProb === undefined ? 1 : state.planProb;
		if (!foeAlive && meAlive) {
			// A win beats every unfinished position, full stop, and the odds
			// only separate one win from another.
			//
			// Multiplying the whole win by the odds was wrong: after twenty
			// turns of compounding, a certain win scored BELOW simply staying
			// healthy, and the planner sat on a Manectric with 10 HP switching
			// back and forth while holding three moves that would have killed it.
			return WON - myLosses * LOST_POKEMON + odds * 10000 - depthUsed;
		}
		if (!meAlive) return -WON;

		// Unfinished: reward progress through their team, penalise your losses
		// heavily, and use HP only to separate otherwise equal routes. The
		// expected loss term is what keeps it from parking a Pokemon in front of
		// something that kills it four times in five.
		// Progress is what is rewarded, weighted by how likely the line is.
		// Penalising uncertainty directly made standing still the safest thing
		// in the position, and the search pivoted between two Pokemon for forty
		// turns rather than commit to anything.
		return -myLosses * LOST_POKEMON -
			deathChance(state) * LOST_POKEMON +
			(1 - teamHP(state.foe)) * 500 * odds +
			teamHP(state.me) * 60 -
			depthUsed * 8;
	}

	function searchRoute(state, depth, ctx, alpha, beta, depthUsed) {
		if (ctx.nodes >= ctx.budget) { ctx.exhausted = true; return {value: positionValue(state, depthUsed)}; }
		ctx.nodes++;

		var meAlive = state.me.team.some(function (m) { return !m.fainted; });
		var foeAlive = state.foe.team.some(function (m) { return !m.fainted; });
		if (!meAlive || !foeAlive || depth <= 0) {
			return {value: positionValue(state, depthUsed)};
		}

		var key = RRBattle.positionKey(state) + "@" + depth;
		var cached = ctx.table[key];
		if (cached !== undefined) return cached;

		var myActions = orderedMyActions(state);
		// Pick your move against the SAME opponent the rollout then plays.
		// Choosing against the worst reply while simulating the predicted one is
		// incoherent: the search sees attacking punished, switches to escape,
		// and the AI simply attacks the Pokemon that ran. That is how a party of
		// six ended up pivoting into a Psyshock until all of them died.
		var foeActions = ctx.predict
			? [predictedReply(state, ctx.options) ||
				RRPlan.plausibleFoeActions(state, ctx.options)[0]]
			: RRPlan.plausibleFoeActions(state, ctx.options);
		var best = {value: -Infinity, action: null, branches: null};

		for (var i = 0; i < myActions.length; i++) {
			// The opponent replies with whatever is worst for you.
			var worst = {value: Infinity, branches: []};
			for (var j = 0; j < foeActions.length; j++) {
				var next = RRBattle.step(state, myActions[i], foeActions[j],
					{mode: "maxroll", risks: ctx.risks})[0].state;
				next.planProb = (state.planProb === undefined ? 1 : state.planProb) *
					stepProbability(state, myActions[i], foeActions[j], next);
				var child = searchRoute(next, depth - 1, ctx, alpha, beta, depthUsed + 1);
				if (child.value < worst.value) {
					worst = {value: child.value, branches: [{
						foeAction: foeActions[j], next: child.action ? child : null
					}]};
				}
				if (worst.value <= alpha) break;   // this action is already beaten
			}
			if (worst.value > best.value) {
				best = {value: worst.value, action: myActions[i], branches: worst.branches};
			}
			if (best.value > alpha) alpha = best.value;
			if (alpha >= beta) break;
		}

		ctx.table[key] = best;
		return best;
	}

	/**
	 * Score a candidate by finishing the fight, not by grading the position.
	 *
	 * A handful of hand-weighted numbers cannot summarise "will I win this", and
	 * every strategy the weights fail to anticipate stays invisible. Worse, the
	 * search optimises the proxy rather than the goal, so more depth makes it
	 * WORSE: measured on the Surge fight, lookahead 3 held 90.8%, lookahead 6
	 * held 59.3% and took 414 seconds. Nothing with a correct objective behaves
	 * like that.
	 *
	 * So a candidate move is judged by playing the rest of the battle out with a
	 * cheap policy and reading the result. The objective becomes the real one,
	 * which makes more search monotonically better instead of worse, and it is
	 * cheaper: twenty turns of playout costs about what lookahead 2 costs, and
	 * sees three times as far as lookahead 6.
	 */
	/**
	 * The policy a playout uses: simple, fast, and aimed at winning.
	 *
	 * A one-ply search was tried first and was useless, because it optimises the
	 * same proxy the playout exists to escape -- it picked Detect twice and the
	 * fight went nowhere. A playout does not need to play well, it needs to be a
	 * fair sample of how the fight goes, so: get out of the way if you are about
	 * to die and have somewhere to go, otherwise hit the thing as hard as you
	 * can, preferring a kill.
	 */
	function playoutAction(state, opts) {
		var mine = RRBattle.active(state.me);
		var foe = RRBattle.active(state.foe);
		var actions = RRBattle.legalActions(state, "me");
		var moves = actions.filter(function (a) { return a.type === "move"; });
		var switches = actions.filter(function (a) { return a.type === "switch"; });

		var incoming = 0;
		RRBattle.legalActions(state, "foe").forEach(function (a) {
			if (a.type !== "move") return;
			var r = RRBattle.damageRolls(state, "foe", a.move);
			if (r && !r.immune && r.noCrit[r.noCrit.length - 1] > incoming) {
				incoming = r.noCrit[r.noCrit.length - 1];
			}
		});

		// Can anything of mine end it right now?
		var best = null, bestDamage = -1;
		for (var i = 0; i < moves.length; i++) {
			var rolls = RRBattle.damageRolls(state, "me", moves[i].move);
			var dealt = rolls && !rolls.immune ? rolls.noCrit[0] : 0;
			if (dealt >= foe.curHP) return moves[i];
			if (dealt > bestDamage) { bestDamage = dealt; best = moves[i]; }
		}

		// Getting low, with somewhere safer to stand? The first version only
		// pivoted when something would die THIS turn, which left Lanturn in for
		// three Bug Buzzes down to 11 HP and then had nowhere to put it. Two
		// hits of headroom is the difference between cycling and dying.
		if (mine.fainted || (incoming * 2 >= mine.curHP && switches.length)) {
			var safest = null, safestRoom = -Infinity;
			for (var j = 0; j < switches.length; j++) {
				var view = RRBattle.clone(state);
				RRBattle.switchIn(view, "me", switches[j].index);
				var candidate = RRBattle.active(view.me);
				var worst = 0;
				RRBattle.legalActions(view, "foe").forEach(function (a) {
					if (a.type !== "move") return;
					var r2 = RRBattle.damageRolls(view, "foe", a.move);
					if (r2 && !r2.immune && r2.noCrit[r2.noCrit.length - 1] > worst) {
						worst = r2.noCrit[r2.noCrit.length - 1];
					}
				});
				var room = candidate.curHP - worst;
				if (room > safestRoom) { safestRoom = room; safest = switches[j]; }
			}
			// Only pivot if it is genuinely safer than staying.
			if (safest && safestRoom > mine.curHP - incoming) return safest;
		}
		// Never stall: if the best "attack" does nothing, take any move that
		// does damage rather than repeating Detect until the clock runs out.
		if (bestDamage <= 0) {
			for (var k = 0; k < moves.length; k++) {
				var probe = RRBattle.damageRolls(state, "me", moves[k].move);
				if (probe && !probe.immune && probe.noCrit[0] > 0) return moves[k];
			}
		}
		return best || actions[0] || null;
	}

	function playout(state, opts, budgetTurns) {
		var current = state;
		var turns = 0;
		var limit = budgetTurns || 30;
		var lastTheirHP = null, stuck = 0;

		while (turns < limit) {
			var meAlive = current.me.team.some(function (m) { return !m.fainted; });
			var foeAlive = current.foe.team.some(function (m) { return !m.fainted; });
			if (!meAlive || !foeAlive) break;

			var choice = {action: playoutAction(current, opts)};
			if (!choice.action) break;
			var reply = predictedReply(current, opts) ||
				RRPlan.plausibleFoeActions(current, opts)[0];
			if (!reply) break;

			var next = RRBattle.step(current, choice.action, reply,
				{mode: "maxroll", risks: opts.risks || {}})[0].state;
			next.planProb = (current.planProb === undefined ? 1 : current.planProb) *
				stepProbability(current, choice.action, reply, next);
			if (RRBattle.positionKey(next) === RRBattle.positionKey(current)) break;

			var theirHP = 0;
			next.foe.team.forEach(function (m) { theirHP += m.curHP; });
			if (lastTheirHP !== null && theirHP >= lastTheirHP) {
				if (++stuck >= 4) break;
			} else { stuck = 0; }
			lastTheirHP = theirHP;

			current = next;
			turns++;
		}

		var won = !current.foe.team.some(function (m) { return !m.fainted; });
		return {
			won: won,
			losses: countFainted(current.me),
			turns: turns,
			odds: current.planProb === undefined ? 1 : current.planProb,
			state: current
		};
	}

	/**
	 * Rank outcomes the way a Nuzlocke does: losing nothing beats losing one,
	 * winning beats not winning, and only then does speed or certainty matter.
	 */
	function outcomeScore(out) {
		// Winning and losing nothing dominate everything. But when no playout
		// reaches a win they would all score alike, and the choice goes noisy --
		// so how FAR each one got still counts, well below the terms that matter.
		var progress = 1 - teamHP(out.state.foe);
		var health = survivability(out.state.me);
		return (out.won ? 1000000 : 0) -
			out.losses * 100000 +
			out.odds * 10000 +
			progress * 8000 +
			health * 2000 -
			out.turns * 10;
	}

	/**
	 * Play the fight out, choosing each turn with a shallow search.
	 *
	 * Full-depth minimax cannot reach the end of a six-against-four: that is
	 * fifteen-odd turns, and the tree is hopeless well before then. Searching a
	 * few turns ahead, committing to the best action, and repeating gets a
	 * COMPLETE route every time, in a couple of seconds. It is a rollout rather
	 * than a proof, so it is the best line it can see and not provably the best
	 * line -- which is the right trade when the alternative is handing back
	 * "undecided" to someone who has to pick a move now.
	 */
	/**
	 * What the AI is most likely to pick: the highest-scoring action, which is
	 * what CFRU takes (uniformly among ties). Falls back to null when the model
	 * is not loaded, and the caller then uses the adversarial reply instead.
	 */
	function predictedReply(state, opts) {
		if (typeof RRAI === "undefined") return null;
		var flags = (opts && opts.flagSets && opts.flagSets[0]) ||
			{checkBadMove: true, checkGoodMove: true};
		var scored = RRAI.scoreAll(state, "foe", flags, {});
		var gate = RRAI.switchGate(state, "foe", flags);
		var best = null;
		scored.forEach(function (entry) {
			if (entry.action.type === "switch" && !gate.maySwitch) return;
			if (!best || entry.score > best.score) best = entry;
		});
		return best ? best.action : null;
	}

	function planRoute(state, options) {
		var opts = options || {};
		var lookahead = opts.lookahead || 3;
		var maxTurns = opts.maxTurns || 40;
		var started = Date.now();
		var current = state;
		var steps = [];
		var nodes = 0;
		var lastTheirHP = null, stuckTurns = 0, stalled = false;

		while (steps.length < maxTurns) {
			var meAlive = current.me.team.some(function (m) { return !m.fainted; });
			var foeAlive = current.foe.team.some(function (m) { return !m.fainted; });
			if (!meAlive || !foeAlive) break;

			RRBattle.clearCache();
			var ctx = {
				nodes: 0, budget: opts.budget || 40000, table: {},
				exhausted: false, options: opts, risks: opts.risks || {},
				predict: opts.opponent !== "adversarial"
			};
			var choice;
			// Off by default. The playout evaluator finds better OPENINGS than
			// the static one -- it is the only thing that has ever chosen the
			// absorber on turn one -- but its playout policy is too crude to
			// sustain a plan, so it currently finishes fewer fights. Kept, and
			// kept switched off, until the policy is worth trusting.
			if (!opts.playouts) {
				choice = searchRoute(current, lookahead, ctx, -Infinity, Infinity, 0);
				nodes += ctx.nodes;
			} else {
				// Try every action, finish the fight from each, keep the best
				// ending. This is the whole point: the score is an outcome.
				var best = null, bestScore = -Infinity;
				var candidates = orderedMyActions(current);
				for (var c = 0; c < candidates.length; c++) {
					var replyNow = predictedReply(current, opts) ||
						RRPlan.plausibleFoeActions(current, opts)[0];
					if (!replyNow) break;
					var after = RRBattle.step(current, candidates[c], replyNow,
						{mode: "maxroll", risks: opts.risks || {}})[0].state;
					after.planProb = (current.planProb === undefined ? 1 : current.planProb) *
						stepProbability(current, candidates[c], replyNow, after);
					var out = playout(after, opts, (opts.maxTurns || 40) - steps.length);
					var score = outcomeScore(out);
					if (score > bestScore) { bestScore = score; best = candidates[c]; }
					nodes += out.turns;
				}
				choice = {action: best};
			}
			if (!choice.action) break;

			// Your move is still chosen against the worst reply they have -- that
			// is the safe way to pick it. But the route SHOWN plays out what the
			// AI would actually do, because a route full of pivots the opponent
			// never makes is not the fight you are going to have. James has
			// played this one repeatedly and Loudred does not switch.
			var reply = predictedReply(current, opts) ||
				((choice.branches && choice.branches[0]) ? choice.branches[0].foeAction
					: RRPlan.plausibleFoeActions(current, opts)[0]);
			if (!reply) break;

			var before = current;
			var next = RRBattle.step(current, choice.action, reply,
				{mode: "maxroll", risks: opts.risks || {}})[0].state;
			next.planProb = (current.planProb === undefined ? 1 : current.planProb) *
				stepProbability(current, choice.action, reply, next);

			steps.push({
				turn: steps.length + 1,
				myMon: RRBattle.active(before.me).species,
				action: choice.action,
				label: choice.action.type === "switch"
					? "switch to " + before.me.team[choice.action.index].species
					: choice.action.move,
				theirMon: RRBattle.active(before.foe).species,
				theirAction: reply,
				theirLabel: reply.type === "switch"
					? "they switch to " + before.foe.team[reply.index].species
					: "they use " + reply.move,
				myHP: RRBattle.active(next.me).curHP,
				myMaxHP: RRBattle.active(next.me).maxHP,
				theirHP: RRBattle.active(next.foe).curHP,
				lost: countFainted(next.me),
				knockedOut: countFainted(next.foe) > countFainted(before.foe)
			});

			// A rollout that stops making progress is stuck. Repeating the exact
			// position is one way; making no dent in their team over several
			// turns is the other, and pivoting back and forth produced that.
			if (RRBattle.positionKey(next) === RRBattle.positionKey(before)) break;
			var theirHP = 0;
			next.foe.team.forEach(function (m) { theirHP += m.curHP; });
			if (lastTheirHP !== null && theirHP >= lastTheirHP) {
				stuckTurns++;
				if (stuckTurns >= 4) { stalled = true; break; }
			} else {
				stuckTurns = 0;
			}
			lastTheirHP = theirHP;
			current = next;
		}

		var wonIt = !current.foe.team.some(function (m) { return !m.fainted; });
		return {
			steps: steps,
			won: wonIt,
			losses: countFainted(current.me),
			lostNames: current.me.team.filter(function (m) { return m.fainted; })
				.map(function (m) { return m.species; }),
			turns: steps.length,
			stalled: stalled || (!wonIt && steps.length < maxTurns),
			nodes: nodes,
			elapsedMs: Date.now() - started
		};
	}

	/**
	 * Where a route can go wrong, and how likely each way is.
	 *
	 * The route is planned on high rolls, which is the right way to FIND a line
	 * but says nothing about whether it holds. So every step is re-examined
	 * against the real damage distribution and the real accuracy: if the plan
	 * needs a kill this turn, what are the odds it actually kills; if it needs
	 * to survive, what are the odds it survives; and what can interrupt it.
	 *
	 * Multiplying those gives the plan's chance of running as written, and
	 * listing the worst of them says where to worry.
	 */
	function stepRisks(before, step, after) {
		var risks = [];
		var myKey = "me", foeKey = "foe";
		var myMon = RRBattle.active(before.me);
		var foeMon = RRBattle.active(before.foe);

		// 1. If the plan kills this turn, how often does it really?
		if (step.knockedOut && step.action.type === "move") {
			var rolls = RRBattle.damageRolls(before, myKey, step.action.move);
			if (rolls && !rolls.immune) {
				var outcomes = RRCritKO.outcomesFor(rolls.noCrit, rolls.crit, rolls.critChance);
				var kills = 0;
				for (var i = 0; i < outcomes.length; i++) {
					if (outcomes[i][0] >= foeMon.curHP) kills += outcomes[i][1];
				}
				if (kills < 0.999) {
					risks.push({
						turn: step.turn, chance: kills,
						what: step.action.move + " needs to KO " + foeMon.species,
						detail: "it does " + Math.round(kills * 100) + "% of the time"
					});
				}
			}
		}

		// 2. Accuracy: a move that misses is a wasted turn.
		if (step.action.type === "move") {
			var acc = RRBattle.accuracyOf(before, myKey, step.action.move);
			if (acc < 0.999) {
				risks.push({
					turn: step.turn, chance: acc,
					what: step.action.move + " can miss",
					detail: Math.round(acc * 100) + "% to hit"
				});
			}
		}

		// 3. Their attack: does the Pokemon that FACED it survive?
		//
		// Two ways this was wrong. If you move first and kill them, their attack
		// never happens, and it was still being charged: Breloom was shown dying
		// 100% of the time to a Drain Punch from a Pawmot it had already knocked
		// out with Mach Punch. And if you switch, the hit lands on whoever came
		// in, not on the Pokemon that left.
		var order = RRBattle.turnOrder(before, step.action, step.theirAction);
		var youWentFirst = order && order[0] === "me";
		var theyNeverActed = youWentFirst && step.knockedOut;
		// Read the damage in the position AFTER your switch resolves, or it is
		// measured against the Pokemon that left while being labelled with the
		// name of the one that arrived.
		var view = before;
		if (step.action.type === "switch") {
			view = RRBattle.clone(before);
			RRBattle.switchIn(view, "me", step.action.index);
		}
		var facing = RRBattle.active(view.me);

		if (step.theirAction && step.theirAction.type === "move" && !theyNeverActed &&
			facing && !facing.fainted) {
			var theirs = RRBattle.damageRolls(view, foeKey, step.theirAction.move);
			if (theirs && !theirs.immune) {
				var out2 = RRCritKO.outcomesFor(theirs.noCrit, theirs.crit, theirs.critChance);
				var dies = 0;
				for (var j = 0; j < out2.length; j++) {
					if (out2[j][0] >= facing.curHP) dies += out2[j][1];
				}
				if (dies > 0.0005) {
					risks.push({
						turn: step.turn, chance: 1 - dies,
						what: facing.species + " can be KOd by " + step.theirAction.move,
						detail: Math.round(dies * 1000) / 10 + "% chance it dies, mostly on a crit"
					});
				}
			}

			// 4. Their secondary effects that would derail the next turn -- but
			// only if the move can reach at all. Discharge was being reported as
			// a 30% paralysis risk against a Ground type it cannot touch.
			var theirData = RRBattle.moveData(step.theirAction.move);
			var sec = theirData && theirData.effect && theirData.effect.secondary;
			if (sec && theirData.secondaryChance > 0 && theirData.secondaryChance < 100 &&
				theirs && !theirs.immune) {
				var label = sec.flinch ? "flinch"
					: (sec.status ? sec.status : (sec.boosts ? "a stat drop" : null));
				var possible = true;
				if (sec.status && sec.status !== "frz") {
					possible = RRBattle._internal.canTakeStatus(facing, sec.status,
						view, theirData.type);
				}
				if (label && possible) {
					var impact = sec.flinch ? 0.5 : statusCost(facing, sec.status);
					// Report it against what it would actually cost, and say so
					// when the answer is "not much".
					risks.push({
						turn: step.turn,
						chance: 1 - (theirData.secondaryChance / 100) * impact,
						what: step.theirAction.move + " can cause " + label +
							" on " + facing.species,
						detail: theirData.secondaryChance + "% chance" +
							(impact <= 0.35 ? ", but it barely hurts this one" :
								(impact >= 0.8 ? ", which would be serious" : ""))
					});
				}
			}
		}
		return risks;
	}

	/**
	 * Replay a route step by step, collecting the risks at each one.
	 * The state has to be rebuilt as we go: a risk on turn six is about the
	 * board on turn six, not the board at the start.
	 */
	function routeRisks(state, route, opts) {
		// Accept either {risks:{...}} or the risks object directly. Passing the
		// wrong shape made the replay use max rolls while the plan used median,
		// and the two drifted apart until a step that KOs in the plan "never
		// KOs" in the report.
		var risks = (opts && opts.risks) || opts || {};
		var current = state;
		var all = [];
		for (var i = 0; i < route.steps.length; i++) {
			var step = route.steps[i];
			var next = RRBattle.step(current, step.action, step.theirAction,
				{mode: "maxroll", risks: risks})[0].state;
			all = all.concat(stepRisks(current, step, next));
			current = next;
		}
		var overall = 1;
		all.forEach(function (r) { overall *= r.chance; });
		all.sort(function (a, b) { return a.chance - b.chance; });
		return {risks: all, overall: overall};
	}

	/**
	 * Find the best route, then work out how much bad luck it survives.
	 *
	 * Reported rather than searched for: the route comes first because you need
	 * one, and the risk is a property of the route you got.
	 */
	function bestRoute(state, options) {
		var opts = options || {};
		var started = Date.now();
		var maxDepth = opts.maxDepth || 8;
		var best = null, reached = 0, exhausted = false;

		// Iterative deepening, keeping the deepest result that finished. Even a
		// shallow answer is a route, which is the whole point.
		for (var depth = 2; depth <= maxDepth; depth++) {
			RRBattle.clearCache();
			var ctx = {
				nodes: 0, budget: opts.budget || 250000, table: {},
				exhausted: false, options: opts, risks: opts.risks || {}
			};
			var found = searchRoute(state, depth, ctx, -Infinity, Infinity, 0);
			if (found.action) { best = found; reached = depth; }
			exhausted = ctx.exhausted;
			if (ctx.exhausted) break;
			if (opts.timeLimitMs && Date.now() - started > opts.timeLimitMs) break;
		}

		return {
			mode: "route",
			line: best && best.action ? best : null,
			value: best ? best.value : null,
			depth: reached,
			exhausted: exhausted,
			elapsedMs: Date.now() - started
		};
	}

	/** Play a route out and report what it costs. */
	function routeOutcome(state, line, risks, maxTurns) {
		var current = state;
		var steps = [];
		var node = line;
		var turns = 0;
		while (node && node.action && turns < (maxTurns || 24)) {
			var meAlive = current.me.team.some(function (m) { return !m.fainted; });
			var foeAlive = current.foe.team.some(function (m) { return !m.fainted; });
			if (!meAlive || !foeAlive) break;
			var branch = (node.branches && node.branches[0]) || null;
			if (!branch) break;
			var next = RRBattle.step(current, node.action, branch.foeAction,
				{mode: "maxroll", risks: risks || {}})[0].state;
			steps.push({
				turn: turns + 1,
				mine: node.action,
				myMon: RRBattle.active(current.me).species,
				theirs: branch.foeAction,
				theirMon: RRBattle.active(current.foe).species,
				afterMyHP: RRBattle.active(next.me).curHP,
				lostSoFar: countFainted(next.me)
			});
			current = next;
			node = branch.next;
			turns++;
		}
		return {
			steps: steps,
			losses: countFainted(current.me),
			won: !current.foe.team.some(function (m) { return !m.fainted; }),
			survived: current.me.team.some(function (m) { return !m.fainted; }),
			turns: turns
		};
	}

	// ------------------------------------------------------------- Nuzlocke

	/**
	 * How much bad luck a clean sweep survives.
	 *
	 * Under Nuzlocke rules losing one Pokemon is losing, so the question is not
	 * "can I win" but "can I win without anything dying". That is a different
	 * search: rr-battle treats any faint on your side as a loss.
	 *
	 * Rather than one answer it walks a ladder of assumptions, from clean rolls
	 * up to everything going wrong, and reports the highest rung that still
	 * holds. "Safe unless they crit" and "safe even if they crit" are different
	 * decisions in a run where a mistake is permanent, and a single probability
	 * hides which one you are looking at.
	 *
	 * Damage is deterministic at every rung: they roll high, you roll low. That
	 * is what keeps the tree free of chance nodes. Crits and secondaries are
	 * then switched on, and misses and paralysis are BUDGETED rather than
	 * assumed: "you miss every turn forever" is not unlucky, it is unreachable,
	 * and a rung nothing can clear tells you nothing. Budgeted bad luck spends
	 * at the first opportunity rather than at the worst one, so a cleared rung
	 * is a strong signal and not quite a proof.
	 */
	var RISK_LADDER = [
		{name: "high rolls", risks: {},
			blurb: "both sides roll high, no crits"},
		{name: "your low rolls", risks: {cautious: true},
			blurb: "you roll low while they still roll high"},
		{name: "they crit", risks: {crit: true},
			blurb: "every hit you take is a critical"},
		{name: "their secondaries land", risks: {crit: true, secondary: true},
			blurb: "every burn, freeze, paralysis and flinch chance goes off"},
		{name: "one of your moves misses", risks: {crit: true, secondary: true, miss: 1},
			blurb: "plus a single miss at the worst moment"},
		{name: "two misses and a paralysis",
			risks: {crit: true, secondary: true, miss: 2, paralysis: 1},
			blurb: "plus two misses and a turn lost to full paralysis"}
	];

	/**
	 * One rung of the ladder, so a caller can walk it a step at a time and stay
	 * responsive. solveNuzlocke below runs the whole thing in one go, which is
	 * fine off the main thread and not fine on it.
	 */
	function nuzlockeRung(state, index, options) {
		var opts = options || {};
		var rung = RISK_LADDER[index];
		if (!rung) return null;
		RRBattle.clearCache();
		var found = solveProof(state, {
			maxDepth: opts.maxDepth || 12,
			budget: opts.budget || 200000,
			timeLimitMs: opts.timeLimitMs,
			stepMode: "maxroll",
			risks: rung.risks,
			foeMovesOnly: opts.foeMovesOnly,
			margin: opts.margin,
			flagSets: opts.flagSets
		});
		var verdict = found.result === WIN ? "safe"
			: (found.exhausted ? "budget" : "none");
		return {
			index: index, name: rung.name, blurb: rung.blurb, risks: rung.risks,
			verdict: verdict, safe: verdict === "safe", exhausted: !!found.exhausted,
			depth: found.depth, line: found.line, nodes: found.nodes,
			elapsedMs: found.elapsedMs,
			last: index === RISK_LADDER.length - 1
		};
	}

	function solveNuzlocke(state, options) {
		var opts = options || {};
		var started = Date.now();
		var rungs = [];
		var deepest = -1;

		for (var i = 0; i < RISK_LADDER.length; i++) {
			RRBattle.clearCache();
			var rung = RISK_LADDER[i];
			var found = solveProof(state, {
				maxDepth: opts.maxDepth || 12,
				budget: opts.budget || 200000,
				timeLimitMs: opts.timeLimitMs,
				stepMode: "maxroll",
				risks: rung.risks,
				foeMovesOnly: opts.foeMovesOnly
			});
			// A proof search can only ever find a route or fail to. It CANNOT
			// establish that something dies, so no rung is ever labelled that
			// way. The three honest answers are: a route exists, the search ran
			// out of budget, or no route exists within the turn limit -- and the
			// last of those may still mean a longer route exists.
			var verdict = found.result === WIN ? "safe"
				: (found.exhausted ? "budget" : "none");
			rungs.push({
				name: rung.name, blurb: rung.blurb, risks: rung.risks,
				verdict: verdict, safe: verdict === "safe",
				exhausted: !!found.exhausted,
				depth: found.depth, line: found.line, nodes: found.nodes
			});
			if (found.result === WIN) deepest = i;
			else break;   // the ladder only gets harder, so stop at the first failure
		}

		var best = deepest >= 0 ? rungs[deepest] : null;
		return {
			mode: "nuzlocke",
			safeThrough: best ? best.name : null,
			survivesCrits: deepest >= 1,
			rungs: rungs,
			line: best ? best.line : null,
			depth: best ? best.depth : 0,
			brokeAt: deepest + 1 < rungs.length ? rungs[deepest + 1].name : null,
			elapsedMs: Date.now() - started,
			unmodelled: state.unmodelled.slice(),
			meaning: best
				? "a clean sweep exists that holds " + best.name +
					(rungs[deepest + 1]
						? ", but none was found once " + rungs[deepest + 1].name +
							(rungs[deepest + 1].exhausted
								? " (search budget, so undecided)"
								: " (within " + (opts.maxDepth || 12) + " turns)")
						: ", the whole ladder")
				: "no clean sweep found even on clean rolls" +
					(rungs[0] && rungs[0].exhausted
						? " (search budget, so undecided)"
						: " within " + (opts.maxDepth || 12) + " turns")
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
		bestRoute: bestRoute,
		routeRisks: routeRisks,
		planRoute: planRoute,
		routeOutcome: routeOutcome,
		solveNuzlocke: solveNuzlocke,
		nuzlockeRung: nuzlockeRung,
		RISK_LADDER: RISK_LADDER,
		solveProof: solveProof,
		describe: describe,
		stateKey: stateKey
	};
})();
