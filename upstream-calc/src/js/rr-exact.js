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

	/**
	 * Who beats who, one on one -- the ordering prior, held for one search.
	 *
	 * Set by whichever top-level search is running and read by ordered(). It is
	 * never built inside the walk: RRMatchup solves its pairings by calling
	 * cleanWin, which resets the caches below on entry, so a table built partway
	 * down a search would wipe the caches of the search that asked for it.
	 */
	var matchupTable = null;

	/**
	 * Whether the pass now running orders by the pairing table.
	 *
	 * It is a per-PASS choice rather than a per-search one because measurement
	 * said so, and said so loudly. The table is worth 35x on Mt. Moon Archer
	 * (150,000 nodes and undecided, against a witness in 4,279) and it is a
	 * LOSS on Lt. Surge, where the search that finds the 23-turn line in 86,776
	 * nodes without it cannot find that line at all with it. The reason is not
	 * mysterious: Surge is won by setting up Growth twice on something the
	 * table rates a poor pairing, and a prior that ranks "wins the 1v1" highest
	 * steers away from exactly that. Neither ordering dominates, so the search
	 * tries both rather than picking a winner it does not have evidence for.
	 */
	var passUsesMatchup = true;

	/** Whether the pass now running orders by the weighted evaluator. */
	var useValueOrdering = false;

	/**
	 * Build the pairing table for this fight, unless the caller supplied one or
	 * asked for none. `matchup: null` disables it, which is what the 1v1 solves
	 * inside RRMatchup pass so that building a table cannot recurse.
	 */
	function tableFor(state, opts) {
		if (opts.matchup !== undefined) return opts.matchup;
		if (typeof RRMatchup === "undefined") return null;
		// A table is not free: up to thirty-six little searches, which on a
		// six-a-side fight has measured around 1,700 nodes and can run higher.
		// That is nothing against the budget the app gives a hard fight and it
		// is a quarter of the budget the 135-fight benchmark gives an easy one,
		// where the plain search was going to win in a few hundred nodes
		// anyway. So a small budget skips it and searches immediately.
		var budget = opts.exactBudget || opts.budget || 400000;
		if (budget < (opts.matchupMinBudget || 50000)) return null;
		try {
			return RRMatchup.build(state, opts);
		} catch (e) {
			return null;
		}
	}

	/**
	 * A stable name for an action.
	 *
	 * Needed because a parallel search has to describe "you take these root
	 * moves and I will take those" across a postMessage boundary, where the
	 * action objects themselves are not shared. Pivot moves carry the Pokemon
	 * they bring in, and that is part of the choice rather than a detail, so it
	 * belongs in the name.
	 */
	function actionKey(action) {
		if (action.type === "switch") return "s" + action.index;
		return "m" + action.index +
			(action.switchTo === undefined ? "" : ">" + action.switchTo);
	}

	function countFainted(side) {
		var n = 0;
		for (var i = 0; i < side.team.length; i++) if (side.team[i].fainted) n++;
		return n;
	}

	function allDown(side) {
		for (var i = 0; i < side.team.length; i++) if (!side.team[i].fainted) return false;
		return true;
	}

	/**
	 * The AI's reply: a function of the position, not a distribution.
	 *
	 * Memoised, and that only became worth doing once the visited set started
	 * keying on remaining turns as well as position. Before that every position
	 * was explored exactly once and a cache could never hit; now a position can
	 * legitimately be revisited with a larger budget, and scoring the
	 * opponent's options is about 265us -- the single biggest cost per node.
	 */
	// A Map rather than an object literal. These caches are keyed by position
	// strings a couple of hundred characters long, and looking those up as object
	// properties goes through V8's megamorphic path -- the profiler put 6.4% of a
	// hard search in KeyedLoadIC_Megamorphic. A Map is built for exactly this.
	var singleReplyCache = new Map();

	function reply(state, opts, key) {
		if (typeof RRAI === "undefined") return null;
		var cacheKey = key === undefined ? RRBattle.positionKey(state) : key;
		var hit = singleReplyCache.get(cacheKey);
		if (hit !== undefined) return hit;
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
		var chosen = best ? best.action : null;
		singleReplyCache.set(cacheKey, chosen);
		return chosen;
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
	// Ordering is a pure function of the position and is not cheap: it prices
	// every bench member's best move and the opponent's worst reply, which is
	// dozens of damage lookups. Positions repeat now that the visited set keys
	// on remaining turns too, so this is worth holding on to.
	var orderCache = new Map();

	/**
	 * How free an action is, in the sense that matters here.
	 *
	 * The search looks for ONE line where nothing dies, so the order it tries
	 * actions in decides how fast it gets there -- and the actions most likely
	 * to START a clean line are the ones that cost nothing. Ordering can never
	 * change which lines exist, only how quickly one is found, so unlike an
	 * evaluation weight this cannot make the answer wrong.
	 *
	 * Four things count as free, and all four are things the weighted evaluator
	 * is structurally blind to because their payoff is not this turn's damage:
	 *
	 *   Denying a turn.   A guaranteed flinch means the opponent does not act at
	 *                     all. Fake Out has +3 priority, so it always lands
	 *                     first and the turn is simply taken away.
	 *   Absorbing a hit.  Switching Lanturn into an Electric move does not
	 *                     reduce the damage, it converts it into healing.
	 *   Recycling HP.     Regenerator gives back a third of max HP for leaving,
	 *                     so a damaged pivot returns as a usable body.
	 *   Blunting future   Intimidate drops Attack a stage on every entry, which
	 *   damage.           lowers everything physical for the rest of the fight.
	 *
	 * These are hints, not bonuses. Nothing here is added to a score that
	 * decides what is good; it only decides what to look at first.
	 */
	function deniesTheirTurn(state, action) {
		if (action.type !== "move") return false;
		var data = RRBattle.moveData(action.move);
		var effect = data && data.effect;
		if (!effect || !effect.guaranteed) return false;
		if (!effect.secondary || !effect.secondary.flinch) return false;
		// firstTurnOnly moves are wasted unless the user just came in.
		if (effect.firstTurnOnly && RRBattle.active(state.me).turnsOut > 0) return false;
		return true;
	}

	/** The foe's hardest-hitting move, and what kind of thing it is. */
	function foeThreat(state) {
		var foe = RRBattle.active(state.foe);
		var moves = (foe.set && foe.set.moves) || [];
		var best = null, worst = -1;
		for (var i = 0; i < moves.length; i++) {
			var rolls = RRBattle.damageRolls(state, "foe", moves[i]);
			var hit = rolls ? rolls.noCrit[rolls.noCrit.length - 1] : 0;
			if (hit > worst) { worst = hit; best = moves[i]; }
		}
		var data = best ? RRBattle.moveData(best) : null;
		return {move: best, damage: Math.max(0, worst), data: data};
	}

	/** What a switch gets for free, over and above the matchup it creates. */
	function freeValueOfSwitch(state, incoming, outgoing, threat) {
		var bonus = 0;
		var absorbRule = RRBattle._internal.ABSORBS[incoming.set.ability];
		if (absorbRule && threat.data && threat.data.type === absorbRule.type) {
			// The hit stops being a cost and becomes a gain. Nothing else in the
			// game swings a turn this hard.
			bonus += absorbRule.heals ? 120 : 70;
		}
		if (outgoing.set.ability === "Regenerator" &&
			outgoing.curHP < outgoing.maxHP * 0.75) {
			bonus += 50;
		}
		if (incoming.set.ability === "Intimidate" && threat.data &&
			threat.data.split === "Physical") {
			bonus += 60;
		}
		return bonus;
	}

	/**
	 * EXPERIMENTAL: order by what the weighted evaluator thinks of the position
	 * each action leads to, rather than by raw damage.
	 *
	 * James's idea, and the natural synthesis: the weighted search has judgement
	 * and no search, this search has search and crude judgement. Ordering is the
	 * one place they combine safely, because a wrong order costs time and can
	 * never change which lines exist.
	 *
	 * It is not free. Ranking this way means simulating every action to see
	 * where it leads, where the damage ordering only looks numbers up -- so a
	 * node costs roughly twice as much. The bet is that the fights this helps
	 * are ones currently burning millions of nodes for nothing, where twice the
	 * cost of failing is not a real price.
	 */
	function orderedByValue(state, key) {
		if (key !== undefined) {
			var hit = orderCache.get(key);
			if (hit !== undefined) return hit;
		}
		var actions = RRBattle.legalActions(state, "me");
		var theirs = reply(state, {}, key);
		var ranked = [];
		for (var i = 0; i < actions.length; i++) {
			var value;
			try {
				var next = RRBattle.step(state, actions[i], theirs,
					{mode: "maxroll", risks: RISKS})[0].state;
				// Anything that loses one of ours is worthless here for the same
				// reason the search cuts it: the objective is losing nobody.
				value = countFainted(next.me) > countFainted(state.me)
					? -Infinity
					: RRSolver.positionValue(next, 1, RRSolver.WEIGHTS);
			} catch (e) { value = -Infinity; }
			ranked.push({action: actions[i], rank: value});
		}
		ranked.sort(function (a, b) { return b.rank - a.rank; });
		var out = [];
		for (var j = 0; j < ranked.length; j++) out.push(ranked[j].action);
		if (key !== undefined) orderCache.set(key, out);
		return out;
	}

	function ordered(state, key) {
		if (useValueOrdering && typeof RRSolver !== "undefined" &&
			RRSolver.positionValue) {
			return orderedByValue(state, key);
		}
		if (key !== undefined) {
			var hit = orderCache.get(key);
			if (hit !== undefined) return hit;
		}
		var threat = foeThreat(state);
		var defender = RRBattle.active(state.foe);
		var actions = RRBattle.legalActions(state, "me");
		var ranked = [];
		for (var i = 0; i < actions.length; i++) {
			var action = actions[i], rank;
			if (action.type === "switch") {
				// Switches used to be dumped at the back of the queue on the
				// grounds that there are a lot of them and they rarely start a
				// winning line. That was wrong in exactly the fights that
				// matter: the proved line through Lt. Surge attacks once and
				// then switches on turn two, so every attack-first subtree had
				// to be exhausted before the search would even look at it.
				//
				// A switch is now ranked on the matchup it creates -- what the
				// incoming Pokemon can do to what is standing there, minus what
				// it takes for the privilege. Good pivots compete with attacks,
				// hopeless ones still sort to the bottom.
				var incoming = state.me.team[action.index];
				if (!incoming || incoming.fainted) { rank = -1000; }
				else {
					var was = state.me.active;
					state.me.active = action.index;
					var out = RRBattle.damageRolls(state, "me", bestMoveOf(state, incoming));
					var back = worstAgainstActive(state);
					state.me.active = was;
					var deal = out ? out.noCrit[out.noCrit.length - 1] / Math.max(1, defender.curHP) : 0;
					var take = back / Math.max(1, incoming.curHP);
					var free = freeValueOfSwitch(state, incoming,
						state.me.team[was], threat);
					// What the pairing table already knows about this switch.
					// `deal` and `take` above compare one hit against another,
					// which is a snapshot; the table has played the whole 1v1
					// out, so it knows the difference between a Pokemon that
					// trades well for a turn and one that actually wins the
					// matchup. Ordering cannot change which lines exist, so this
					// is free to be as opinionated as it is useful.
					var cell = passUsesMatchup && matchupTable &&
						typeof RRMatchup !== "undefined"
						? RRMatchup.versus(matchupTable, action.index, state.foe.active)
						: null;
					var prior = 0;
					if (cell) {
						if (cell.beats) prior = 25 + 35 * cell.endHPFrac;
						else if (cell.hopeless) prior = -40;
					}
					// Below zero, so a switch only outranks an attack that is
					// doing almost nothing -- but a good pivot now beats a bad
					// attack instead of losing to every one of them.
					rank = -1 + 40 * deal - 30 * Math.min(1, take) + free + prior;
				}
			} else {
				var rolls = RRBattle.damageRolls(state, "me", action.move);
				var hit = rolls ? rolls.noCrit[rolls.noCrit.length - 1] : 0;
				rank = hit >= defender.curHP ? 1000 + hit : 100 * hit / Math.max(1, defender.curHP);
				// A move that takes the opponent's turn away costs nothing, so
				// it belongs near the front of the queue even though its damage
				// is small. Below a kill, above ordinary chip.
				if (deniesTheirTurn(state, action)) rank += 90;
			}
			ranked.push({action: action, rank: rank});
		}
		ranked.sort(function (a, b) { return b.rank - a.rank; });
		var out2 = [];
		for (var j = 0; j < ranked.length; j++) out2.push(ranked[j].action);
		if (key !== undefined) orderCache.set(key, out2);
		return out2;
	}

	/** The hardest-hitting move a Pokemon has against what is out now. */
	function bestMoveOf(state, mon) {
		var moves = (mon.set && mon.set.moves) || [];
		var best = moves[0], bestHit = -1;
		for (var i = 0; i < moves.length; i++) {
			var r = RRBattle.damageRolls(state, "me", moves[i]);
			var hit = r ? r.noCrit[r.noCrit.length - 1] : 0;
			if (hit > bestHit) { bestHit = hit; best = moves[i]; }
		}
		return best;
	}

	/** The worst the opponent can do to whoever is standing there now. */
	function worstAgainstActive(state) {
		var foe = RRBattle.active(state.foe);
		var moves = (foe.set && foe.set.moves) || [];
		var worst = 0;
		for (var i = 0; i < moves.length; i++) {
			var r = RRBattle.damageRolls(state, "foe", moves[i]);
			var hit = r ? r.noCrit[r.noCrit.length - 1] : 0;
			if (hit > worst) worst = hit;
		}
		return worst;
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
			// exactBudget is separate from `budget` because the fallback search
			// reads `budget` too, and the two want very different numbers: this
			// one wants millions of cheap reachability nodes, that one wants
			// tens of thousands of expensive evaluated ones.
			budget: opts.exactBudget || opts.budget || 400000,
			maxTurns: opts.maxTurns || 24,
			exhausted: false,
			truncated: false,
			passOver: false,
			// Set when a branch was abandoned for a reason other than losing --
			// an AI reply that could not be scored, or a step that threw. Either
			// means the search did not see everything, so it may not conclude.
			gaveUp: false
		};
		var onProgress = opts.onProgress || null;
		var started = Date.now();
		var deadline = opts.timeLimitMs ? started + opts.timeLimitMs : null;

		// Built before the caches are cleared, because building it runs 1v1
		// searches of its own and those clear the caches too.
		matchupTable = tableFor(state, opts);
		limits.nodes += (matchupTable && matchupTable.nodes) || 0;

		singleReplyCache = new Map();
		orderCache = new Map();
		var line = [];

		// Per-pass state. `seen` is rebuilt for every pass and never shared:
		// under a beam a position fails because its good replies were never
		// tried, and carrying that failure into a wider pass would make the
		// wider pass skip exactly the positions it was widened to examine --
		// turning "I did not look" into "there is nothing there", which is the
		// one lie this module must never tell.
		var seen = new Map();
		var beam = Infinity;
		var passCap = limits.budget;
		// 0 = off. 1 = keep a position only if some single fact about it is new.
		var noveltyLevel = 0;
		var noveltySeen = null;

		/**
		 * The facts a position is made of.
		 *
		 * Deliberately COARSE and per-Pokemon rather than one string for the
		 * whole state: the point is to notice "this Pokemon has reached a new
		 * band of health" or "something is asleep that was not", not to
		 * rediscover that the exact position is unique, which it almost always
		 * is. HP goes into eighths for the same reason hpBuckets did.
		 *
		 * Costs a little per node, which is why it runs on one pass rather than
		 * everywhere.
		 */
		function atomsOf(st) {
			var out = [];
			var sides = ["me", "foe"];
			for (var s = 0; s < 2; s++) {
				var side = st[sides[s]];
				var tag = sides[s].charAt(0);
				var act = RRBattle.active(side);
				out.push(tag + "@" + (act && act.species));
				for (var i = 0; i < side.team.length; i++) {
					var m = side.team[i];
					var band = m.fainted ? "x"
						: Math.round((m.curHP / m.maxHP) * 8);
					out.push(tag + i + "h" + band);
					if (m.status) out.push(tag + i + "s" + m.status);
				}
				if (act && act.boosts) {
					// The whole boost vector as one fact: a setup line's point
					// is the combination, not any single stage.
					out.push(tag + "b" + JSON.stringify(act.boosts));
				}
				if (side.hazards) out.push(tag + "z" + JSON.stringify(side.hazards));
			}
			return out;
		}

		/** IW(1): novel if it asserts anything never asserted before. */
		function isNovel(st) {
			var atoms = atomsOf(st);
			var novel = false;
			for (var i = 0; i < atoms.length; i++) {
				if (!noveltySeen.has(atoms[i])) { noveltySeen.add(atoms[i]); novel = true; }
			}
			return novel;
		}
		// How many of ours may fall. Zero is the Nuzlocke objective and the
		// default; anything higher is cheapestWin asking a different question.
		// Measured from the state we were handed, since a fight can be planned
		// from partway through with somebody already down.
		var lossBudget = opts.lossBudget || 0;
		var startFainted = countFainted(state.me);
		// How coarsely this pass names positions. 0 means exactly.
		var hpBuckets = 0;

		/**
		 * Which opening moves this search is responsible for.
		 *
		 * Undefined means all of them, which is every ordinary call. A caller
		 * that hands out subsets is splitting the work between searches -- the
		 * root's branches are independent, so several can be explored at once.
		 *
		 * IT CHANGES WHAT `decided` MEANS, and the caller owns that: a search
		 * given half the openings and finishing them without a line has shown
		 * only that ITS half contains none. Concluding that the fight has no
		 * clean line needs every subset to have finished and come back empty.
		 * A witness needs no such care, because a line is a line.
		 */
		var rootFilter = null;
		if (opts.rootActions && opts.rootActions.length) {
			rootFilter = Object.create(null);
			for (var ra = 0; ra < opts.rootActions.length; ra++) {
				rootFilter[opts.rootActions[ra]] = true;
			}
		}

		function walk(current, turnsLeft, isRoot) {
			// Once the search has given up, EVERY node must return immediately.
			// Without this the time limit did not work: it fired on one node in
			// 1024 and the other 1023 carried on searching, so a 12 second cap
			// ran for over three minutes and only stopped when the node budget
			// ran out. The budget check got away with the same shape by
			// accident, because every later node also exceeds the budget.
			if (limits.exhausted || limits.passOver) return false;
			if (limits.nodes++ > limits.budget) { limits.exhausted = true; return false; }
			// A pass running out is not the search running out. The first stops
			// this pass and lets the next, wider one start; the second stops
			// everything. Sharing one flag would have let a cheap hunt pass
			// consume the whole budget and report the fight undecided without
			// the exhaustive pass ever running.
			if (limits.nodes > passCap) { limits.passOver = true; return false; }
			if ((limits.nodes & 1023) === 0) {
				if (deadline && Date.now() > deadline) {
					limits.exhausted = true;
					return false;
				}
				// Report progress so a long search can show it is alive. Without
				// this "still working" and "hung" look identical, which is the
				// real reason a time cap felt necessary in the first place.
				if (onProgress && (limits.nodes & 65535) === 0) {
					onProgress(limits.nodes, Date.now() - started);
				}
			}
			if (allDown(current.foe)) return true;
			if (turnsLeft <= 0) { limits.truncated = true; return false; }

			// Memoise on the position AND on how many turns were left when it
			// was tried. Keying on the position alone was unsound: depth-first
			// search can reach a position late in a long line, fail it with two
			// turns to spare, and then reach the same position early in a short
			// line with eighteen turns available -- where it skipped it and
			// reported no line existed. That is both a missed win and, worse, a
			// false "impossible", which is the one claim this module must never
			// get wrong.
			//
			// Storing the largest budget already tried keeps nearly all of the
			// pruning: failing with 18 turns does imply failing with 12.
			// The exact name is what the AI reply and the ordering are cached on,
			// since those really are functions of the precise position. The
			// VISITED set may use a coarser one, which is a different question:
			// not "is this the same position" but "is this close enough that
			// trying it again is unlikely to be worth a second search".
			var key = RRBattle.positionKey(current);
			var visitKey = hpBuckets
				? RRBattle.positionKey(current, {hpBuckets: hpBuckets})
				: key;
			// NOVELTY. The transposition table has almost nothing to do on this
			// problem -- HP drifts a point or two every turn and PP is part of a
			// position's identity, so in a twenty-turn grind essentially no
			// position is ever reached twice. hpBuckets was a first swing at
			// that, blurring HP into bands, and measured 19% on one fight.
			//
			// This is the principled version, from width-based planning: do not
			// ask "have I seen this exact position", ask "does this position
			// contain any FACT I have never seen". A position all of whose facts
			// are old is one the search has effectively already been around, and
			// is dropped. That prunes hard in a wide shallow tree, which is the
			// shape this one has.
			//
			// It can obviously miss lines -- a position can be entirely
			// unsurprising and still be the only way through -- so like the beam
			// it is allowed only on passes that may never conclude, and the
			// `narrows` test below enforces that.
			if (noveltyLevel > 0 && !isNovel(current)) return false;

			var triedWith = seen.get(visitKey);
			if (triedWith !== undefined && triedWith >= turnsLeft) return false;
			seen.set(visitKey, turnsLeft);

			var theirs = reply(current, opts, key);
			// Not "this branch does not win" -- "this branch was not examined".
			// Returning false here without saying so let a full-width pass go on
			// to report the whole fight decided on the strength of a subtree it
			// never entered.
			if (!theirs) { limits.gaveUp = true; return false; }

			var actions = ordered(current, key);
			if (isRoot && rootFilter) {
				var mine = [];
				for (var f = 0; f < actions.length; f++) {
					if (rootFilter[actionKey(actions[f])]) mine.push(actions[f]);
				}
				actions = mine;
			}
			// The beam. Only the first few ranked actions are tried, which is
			// what makes a hunt pass cheap enough to reach turn twenty. It can
			// miss lines, so a pass with a beam is never allowed to conclude
			// anything -- see the pass loop below.
			// A beam given as a FRACTION scales with the branching factor. An
			// absolute 8 was inert wherever it mattered most: a 4v4 has seven
			// legal actions, so Math.min(7, 8) restricted nothing and the
			// portfolio's narrow pass explored exactly the same tree as the
			// exhaustive one behind it. Two of three passes doing identical work
			// is not a hedge.
			var width;
			if (isRoot && rootFilter) {
				width = actions.length;
			} else if (beam > 0 && beam < 1) {
				width = Math.max(2, Math.ceil(actions.length * beam));
			} else {
				width = Math.min(actions.length, beam);
			}
			for (var i = 0; i < width; i++) {
				var next;
				try {
					next = RRBattle.step(current, actions[i], theirs,
						{mode: "maxroll", risks: RISKS})[0].state;
				} catch (e) {
					// Same again: an action the engine could not simulate is
					// unexamined, not refuted.
					limits.gaveUp = true;
					continue;
				}
				// The cut that makes this tractable. Normally `lossBudget` is 0
				// and this forbids any faint at all, which is the Nuzlocke
				// objective and also the reason this search is affordable: the
				// moment something of ours dies the branch is worth nothing and
				// is dropped rather than explored. Counting from the START of
				// the fight rather than from the parent is what lets a caller
				// raise the budget and ask the different question "win, losing
				// at most k" -- see cheapestWin.
				if (countFainted(next.me) - startFainted > lossBudget) continue;

				line.push({state: current, action: actions[i], theirAction: theirs,
					next: next});
				if (walk(next, turnsLeft - 1)) return true;
				line.pop();
			}
			return false;
		}

		/**
		 * Hunt first, then decide.
		 *
		 * The two questions this search gets asked are not the same question,
		 * and running them as one is what made the hard fights hopeless. "Is
		 * there a line?" only needs ONE witness, and a witness is real however
		 * recklessly it was found -- every step of it was simulated by the
		 * engine, so a line that turns up under a beam of three is exactly as
		 * playable as one that turns up after exhausting the tree. "Is there NO
		 * line?" is the expensive claim, and only an exhaustive pass may make it.
		 *
		 * So the cheap narrow passes run first, and if any of them produces a
		 * witness the fight is settled and the expensive pass never has to run.
		 * If they all come up empty, nothing has been concluded and the
		 * exhaustive pass runs with whatever budget is left.
		 */
		/**
		 * Luby's universal restart schedule: 1,1,2,1,1,2,4,1,1,2,4,8,...
		 *
		 * Chosen over plain doubling because it is provably within a constant
		 * factor of the best FIXED cutoff for any runtime distribution, and we
		 * do not know ours. Doubling gives every opening a slice and only comes
		 * back a whole round later, so an opening that is right but needs a
		 * little more than its slice waits a long time; Luby keeps returning
		 * with short cutoffs while occasionally granting a long one. Measured
		 * head to head it was never worse and twice as fast where they differed.
		 */
		function luby(i) {
			for (var k = 1; k < 31; k++) {
				var span = (1 << k) - 1;
				if (i === span) return 1 << (k - 1);
				if (i < span) return luby(i - ((1 << (k - 1)) - 1));
			}
			return 1;
		}

		/**
		 * Deal the budget out over the opening moves instead of spending it all
		 * under the first one.
		 *
		 * WHY THIS EXISTS. Depth-first search commits: it takes the first ranked
		 * action and explores everything beneath it before trying the second,
		 * and beneath one opening there can be 7^15 positions. So the cost of
		 * this search is wildly uneven across the openings, which is the
		 * classic heavy-tailed runtime distribution of backtracking search --
		 * most branches are cheap, a few are effectively bottomless, and the
		 * average is decided entirely by which one you happened to try first.
		 * Brock's 6v6 mirror is the measured case: 74 nodes down one opening,
		 * and still nothing after 250,000 down another.
		 *
		 * The remedy for a heavy tail is restarts, and this is the same idea the
		 * portfolio, the fractional beam and the parallel worker split were all
		 * reaching for separately. Each restart searches ONE opening under a
		 * node cutoff; when the cutoff bites we move to the next opening and
		 * come back later with a bigger one.
		 *
		 * WHY IT STAYS SOUND, which is the part to be careful about. A restart
		 * narrows by BUDGET, never by width or by blurring positions -- beam
		 * stays Infinity and hpBuckets stays 0 -- so a restart that stops
		 * because it ran out of TREE rather than out of cutoff has genuinely
		 * proved its opening holds no clean line. Every line begins with some
		 * opening, so once every opening is proved empty the fight is decided.
		 * That is the same argument rr-search.js already relies on to split the
		 * root across workers. Anything less than a finished restart proves
		 * nothing and the opening stays live.
		 *
		 * Truncation and give-ups are tracked separately from emptiness: an
		 * opening whose lines ran past the horizon is FINISHED but not EMPTY, so
		 * it leaves the rotation (re-searching it would repeat identical work)
		 * while permanently forbidding a verdict of "no clean line exists".
		 */
		function restartDriver(rootKeys, cap, turns) {
			var live = rootKeys.slice();
			// Small enough that the first sweep is cheap on every opening, so a
			// fight whose answer sits one node down a late opening pays almost
			// nothing to reach it.
			// CAPPED, and the cap is the whole point. Scaling the unit to the
			// budget looks reasonable and quietly destroys the schedule on the
			// caller that matters most: the app asks for 60,000,000 nodes, which
			// makes a proportional unit 833,000 -- so the first opening would
			// swallow most of the search before the rotation ever came round,
			// which is the behaviour restarts exist to prevent. Luby escalates
			// on its own; the unit only has to be small enough that the first
			// sweep across every opening is cheap. Measured good range on the
			// fights this was tuned against was roughly 1,400 to 3,500.
			var unit = Math.min(opts.restartUnitMax || 4000,
				Math.max(opts.restartUnit || 150,
					Math.floor(limits.budget / (Math.max(1, live.length) * 8))));
			var savedFilter = rootFilter;
			var couldNotProve = false, horizonBlocked = false;
			var hit = false, i = 1;
			while (live.length && !limits.exhausted && limits.nodes < cap) {
				var at = (i - 1) % live.length;
				var key = live[at];
				rootFilter = Object.create(null);
				rootFilter[key] = true;
				beam = Infinity;
				hpBuckets = 0;
				// Never for the driver: a restart is entitled to prove its
				// opening empty, and novelty would make that a lie.
				noveltyLevel = 0;
				passUsesMatchup = true;
				useValueOrdering = false;
				// Never shared between restarts: a position failed under a small
				// cutoff only because we stopped looking, and carrying that into
				// a longer restart would turn "I did not look" into "there is
				// nothing there".
				seen = new Map();
				orderCache = new Map();
				line.length = 0;
				limits.truncated = false;
				limits.passOver = false;
				passCap = Math.min(limits.budget, cap,
					limits.nodes + luby(i) * unit);
				if (walk(state, turns, true)) { hit = true; break; }
				// Lines ran past the horizon somewhere in this restart. Worth
				// recording even when the restart did not finish, because that
				// is the ONLY evidence available that a longer horizon might
				// help: on a fight big enough to matter no opening ever finishes
				// inside its cutoff, so waiting for a finished-and-truncated
				// restart means waiting for something that does not happen.
				if (limits.truncated) horizonBlocked = true;
				if (!limits.passOver && !limits.exhausted) {
					// This restart ran out of tree, not out of cutoff.
					live.splice(at, 1);
					// Finished, but only because lines ran off the end of the
					// horizon -- so this opening is done at THIS depth without
					// being empty, and nothing here may be called impossible.
					if (limits.truncated) couldNotProve = true;
					if (limits.gaveUp) couldNotProve = true;
					continue;   // do not advance i; the rotation just got shorter
				}
				i++;
			}
			rootFilter = savedFilter;
			return {
				found: hit,
				decided: !hit && live.length === 0 && !couldNotProve,
				blockedByHorizon: horizonBlocked
			};
		}

		/**
		 * What one pass is allowed to spend.
		 *
		 * A share of the budget, but ALSO an absolute ceiling, and the ceiling is
		 * the part that matters. The app asks for 60,000,000 nodes, so a 5% share
		 * is three million and a 20% share is twelve million -- and at a few
		 * thousand positions a second, the pass behind them starts something like
		 * two hours in. The hunt passes are lottery tickets that pay off in
		 * thousands of nodes (Mt. Moon in 4,279, Lt. Surge in 7,423, Brock's 6v6
		 * in 19,613) or not at all, so letting them scale with a huge budget
		 * starves whatever follows without ever helping them.
		 *
		 * This is the same failure the portfolio already had once, when one flag
		 * meant both "may conclude" and "gets the rest of the budget" and the
		 * beam pass never ran. A share that grows without limit is that bug with
		 * a different shape.
		 */
		function passShare(pass) {
			var byShare = Math.ceil(limits.budget * (pass.share || 1));
			return Math.min(byShare, pass.capNodes || Infinity);
		}

		var passes = [];
		// A portfolio is three restarts, so it pays for the same easy tree
		// three times: a fight the plain search settles in 10 nodes costs 73
		// through the passes. That is nothing on a fight worth hunting and it is
		// pure waste on one that is not, so the same budget test that decides
		// whether a pairing table is worth building decides whether to hunt at
		// all. Below it, this is the search exactly as it was.
		var huntWorthIt = limits.budget >= (opts.huntMinBudget || 50000);
		if (opts.hunt === false || (!huntWorthIt && !opts.passes)) {
			passes.push({beam: Infinity, turns: limits.maxTurns, share: 1,
				matchup: opts.matchup === null ? false : true});
		} else if (opts.passes) {
			passes = opts.passes;
		} else {
			// A PORTFOLIO, not a ladder. Each hunt pass is a different way of
			// looking at the same tree, and they were chosen because each one
			// finds fights the others do not:
			//
			//   the pairing table    Mt. Moon Archer, in 4,279 nodes, where
			//                        everything else was still lost at 150,000
			//   a narrow beam        Lt. Surge, in 47,487 nodes, where the
			//                        table-ordered search never arrives
			//   restarts             Brock's 6v6 mirror, undecided at 250,000
			//                        and answered in 74, plus Kindle Road at 11
			//
			// They are cheap when they work and capped when they do not, so the
			// exhaustive pass still gets the bulk of the budget. Restarting the
			// search under a different order cannot change which lines exist,
			// which is what makes a portfolio legitimate here at all.
			passes.push({beam: Infinity, turns: limits.maxTurns, share: 0.05,
				capNodes: 300000, matchup: true});
			// Two fifths of the available actions, so it narrows in a 4v4 as
			// well as a 6v6, with a floor of two so it is always a real choice.
			passes.push({beam: 0.4, turns: limits.maxTurns, share: 0.20,
				capNodes: 600000, matchup: false});
			// Restarts. ADDED to the portfolio rather than replacing anything:
			// dropping the beam for them cost Lt. Surge, whose line the beam
			// finds in 7,423 nodes and which full-width restarts do not reach.
			// The two hedge against different failures -- a beam gets DEEP fast,
			// a restart stops one opening swallowing everything -- and this
			// project has now measured twice that no single such trick
			// dominates. Unlike a beam, a finished restart may still conclude.
			if (opts.restarts !== false) {
				passes.push({driver: true, turns: limits.maxTurns, share: 0.60});
				// A DEEPER RUNG, and the reason it is here rather than left to
				// the upward extension below is that the extension cannot fire
				// on the fights that need it. That test wants a full-width pass
				// to FINISH its tree and stop only at the horizon -- but a search
				// whose horizon is too short does not finish, it thrashes the
				// budget inside a space that holds no solution and then looks
				// budget-bound. Measured on the TREASURE BEA. mirror: undecided
				// at 250,001 nodes with 24 turns, FOUND in 5,990 with 40, and
				// asking for a ceiling of 40 or 60 changed nothing because the
				// extension never ran.
				//
				// The driver can tell the difference, because it sees truncation
				// per OPENING rather than for the search as a whole, so this rung
				// runs only when some opening really did run out of turns. Note
				// an opening proved empty at 24 turns is NOT proved empty at 40:
				// the rung starts its own rotation from scratch.
				if (opts.maxTurnsCeiling > limits.maxTurns) {
					passes.push({driver: true, turns: opts.maxTurnsCeiling,
						share: 0.20, capNodes: 400000, needsHorizon: true});
				}
			}
			// The decider. Full width, full horizon, no pairing prior -- the
			// search exactly as it was before any of this, and the only pass
			// entitled to conclude anything.
			passes.push({beam: Infinity, turns: limits.maxTurns, share: 1,
				matchup: false});
		}

		var found = false;
		var decidedHere = false;
		// Did a full-width pass finish its tree and stop only because lines ran
		// past the horizon? That is the one situation where searching deeper is
		// the right response rather than a waste.
		var blockedByHorizon = false;

		// The openings this call is responsible for, named once. A restart pass
		// rotates through them; with only one there is nothing to deal out and
		// the driver has no work to do.
		//
		// Deliberately NOT `rootActionKeys()`, which looks like the same thing:
		// that one rebuilds the pairing table and clears the caches, because it
		// exists for callers outside a search (rr-search, splitting the root
		// across workers). Calling it here would wipe the caches of the search
		// it is being asked for.
		var rootKeys = null;
		for (var dp = 0; dp < passes.length; dp++) {
			if (!passes[dp].driver) continue;
			passUsesMatchup = true;
			useValueOrdering = false;
			var rootOrder = ordered(state, RRBattle.positionKey(state));
			rootKeys = [];
			for (var rk = 0; rk < rootOrder.length; rk++) {
				var rkey = actionKey(rootOrder[rk]);
				if (!rootFilter || rootFilter[rkey]) rootKeys.push(rkey);
			}
			break;
		}

		for (var p = 0; p < passes.length && !found && !decidedHere; p++) {
			var pass = passes[p];
			// A restart pass is not a walk of the tree, it is a schedule of
			// walks, so it takes its share of the budget and manages its own
			// cutoffs inside it.
			if (pass.driver) {
				if (!rootKeys || rootKeys.length < 2) continue;
				// Only pay for a deeper horizon when the horizon is what stopped
				// us. Nothing else earns it: a search that ran out of budget
				// inside 24 turns will only drown faster inside 40.
				if (pass.needsHorizon && !blockedByHorizon) continue;
				var driverCap = Math.min(limits.budget,
					limits.nodes + Math.ceil(limits.budget * pass.share));
				var driven = restartDriver(rootKeys, driverCap, pass.turns);
				if (driven.blockedByHorizon) blockedByHorizon = true;
				if (driven.found) { found = true; break; }
				if (driven.decided) { decidedHere = true; break; }
				if (limits.exhausted) break;
				continue;
			}
			// Full width and full horizon is what earns the right to conclude.
			// The ORDER does not enter into it: reordering changes which line
			// is found first and never which lines exist, so a table-ordered
			// pass that runs out of things to try has searched the same tree as
			// a plainly-ordered one. Only the beam can hide a line, and a beam
			// of Infinity hides nothing.
			// Normalise first. A caller-supplied pass that omits `beam` used to
			// give `Math.min(n, undefined)` = NaN, so the action loop ran zero
			// times -- and `undefined < Infinity` is false, so the pass was then
			// judged full width and allowed to CONCLUDE. Three nodes, no action
			// tried, and a fight Blastoise wins in one move came back
			// "no-clean-line-exists". That is the one lie this module exists not
			// to tell, and it was reachable through a documented option.
			if (typeof pass.beam !== "number") pass.beam = Infinity;
			// A fraction below 1 narrows, so it counts as a beam for the
			// entitlement test below exactly as an absolute width does.
			// Novelty hides lines exactly as a beam does, so it counts as
			// narrowing for the entitlement test: such a pass may find, and may
			// never conclude.
			var narrows = pass.beam < Infinity || (pass.novelty || 0) > 0;
			if (typeof pass.turns !== "number") pass.turns = limits.maxTurns;
			var exhaustive = !narrows && pass.turns >= limits.maxTurns;
			// Being ENTITLED TO CONCLUDE and being given the whole budget are two
			// different things, and running them off one flag was a real bug: the
			// table-ordered first pass is full width at full horizon, so it
			// counted as exhaustive, so it took the entire budget and the beam
			// pass behind it never ran at all. That made the portfolio strictly
			// worse than any single one of its passes on Lt. Surge -- undecided
			// at 300,002 nodes where the plain search finds the line at 86,776
			// and the beam finds it at 7,423. Only the LAST pass gets what is
			// left; every pass before it gets its slice and hands over.
			var isLast = p === passes.length - 1;
			seen = new Map();
			beam = pass.beam;
			passUsesMatchup = pass.matchup !== false;
			useValueOrdering = pass.valueOrder === true;
			// Only a pass already forbidden from concluding may blur positions
			// together. `exhaustive` below is computed from the same facts and
			// must stay in agreement with this.
			hpBuckets = narrows
				? (opts.hpBuckets === undefined ? 8 : opts.hpBuckets) : 0;
			noveltyLevel = pass.novelty || 0;
			noveltySeen = noveltyLevel ? new Set() : null;
			// Ordering differs per pass, so a cached order from the last one is
			// the wrong order for this one.
			orderCache = new Map();
			line.length = 0;
			limits.truncated = false;
			limits.passOver = false;
			// The last pass gets everything that is left; the hunt passes get a
			// slice each, so a hunt that finds nothing cannot starve the pass
			// that is allowed to conclude.
			passCap = isLast ? limits.budget
				: Math.min(limits.budget, limits.nodes + passShare(pass));

			found = walk(state, pass.turns, true);
			if (found) break;
			// A full-width pass that FINISHED, and never once ran out of turns,
			// has seen the whole game tree -- not merely the part of it inside
			// this rung's horizon. That is the only situation in which "no clean
			// line exists" is true, and it is why climbing the ladder cannot
			// make this claim early: a rung that finished but hit its horizon
			// leaves `truncated` set, and says nothing about longer lines.
			// `exhaustive` was computed above and then never read, while this
			// site recomputed only half of it. They must be the same test.
			if (exhaustive && !limits.exhausted && !limits.passOver && !limits.gaveUp) {
				if (limits.truncated) blockedByHorizon = true;
				else { decidedHere = true; break; }
			}
			if (limits.exhausted) break;   // out of budget or out of time
		}

		/**
		 * Look further, but only when the horizon is what stopped us.
		 *
		 * Deepening on a timer, or whenever nothing turns up, is the wrong rule:
		 * a search that never finished its 24-turn tree has not earned a deeper
		 * one, and giving it a deeper one multiplies a tree it was already
		 * drowning in. The right trigger is the search finishing everything
		 * inside the horizon and stopping only because lines ran past it. Then
		 * "no clean line in 24 turns" is a fact, and the next question is
		 * whether there is one in 32.
		 *
		 * Starting SHALLOW and climbing was tried first and measured worse:
		 * rungs at 10 and 16 turns cost 126,000 nodes on Lt. Surge and could
		 * never find its line, which is 23 turns long. Iterative deepening
		 * assumes the shallow tree is a small fraction of the deep one, and here
		 * it is not -- this tree is wide rather than deep, and a 10-turn search
		 * already exceeds 150,000 nodes on Misty. So the extension only ever
		 * goes upward, and only on demand.
		 *
		 * Off by default: a caller has to say how far it is willing to look, and
		 * only the app, which searches on every core with no clock, does.
		 */
		var ceiling = opts.maxTurnsCeiling || 0;
		if (!found && !decidedHere && !limits.exhausted && blockedByHorizon &&
			ceiling > limits.maxTurns) {
			var deeper = Object.create(null);
			for (var o in opts) deeper[o] = opts[o];
			deeper.maxTurns = Math.min(ceiling, limits.maxTurns + 8);
			deeper.maxTurnsCeiling = ceiling;
			deeper.exactBudget = Math.max(0, limits.budget - limits.nodes);
			deeper.matchup = matchupTable;   // built already; do not pay twice
			if (deeper.exactBudget > 0 && deeper.maxTurns > limits.maxTurns) {
				var further = cleanWin(state, deeper);
				further.nodes += limits.nodes;
				further.horizonReached = deeper.maxTurns;
				return further;
			}
		}

		return {
			found: found,
			decided: found || decidedHere,
			nodes: limits.nodes,
			elapsedMs: Date.now() - started,
			line: found ? line.slice() : null,
			blockedByHorizon: blockedByHorizon
		};
	}

	/**
	 * The cheapest win available, when a clean one is not.
	 *
	 * WHY THIS IS NOT JUST "THE FALLBACK". When `cleanWin` proves no clean line
	 * exists, what happens today is that a weighted search takes over -- and it
	 * is still trying to preserve everything, which is precisely the thing that
	 * has just been shown to be unavailable. It plays for a goal it cannot have
	 * and gets a worse result than aiming at the reachable one. The measured
	 * case is VIRID. FOREST / ACE TRAINER NELLE, a 2v2 where no clean line
	 * exists, the fallback loses 0-2, and the fight is winnable losing exactly
	 * one: it switches a nearly-dead Charcadet out on turn 4, concedes a free
	 * hit, and loses the Gulpin mirror by about that margin.
	 *
	 * So this asks the same question with the objective relaxed one step at a
	 * time, and stops at the first answer. k=0 is `cleanWin` exactly.
	 *
	 * WHY CLIMBING IS THE RIGHT DIRECTION HERE, when iterative deepening on the
	 * HORIZON measured eight times worse: a shallow horizon does not shrink this
	 * tree, because the tree is wide rather than tall. The loss budget is
	 * different -- it is the cut that makes the search affordable at all, since
	 * a branch dies the moment something of ours does. Raising it genuinely
	 * grows the tree, so the cheap questions must be asked first. Measured on
	 * NELLE: 1,051 nodes at k=0, 1,959 at k=1, 5,531 at k=2.
	 *
	 * A "no line exists" at k=0 says nothing about k=1, so the climb continues
	 * past it rather than stopping.
	 */
	function cheapestWin(state, options) {
		var opts = options || {};
		var maxLosses = opts.maxLosses === undefined ? 2 : opts.maxLosses;
		var total = opts.exactBudget || opts.budget || 400000;
		var spent = 0;
		var last = null;
		// Whether every CHEAPER question was actually answered, rather than
		// merely asked. It decides between two very different claims: "this
		// costs one Pokemon and one is the least it can cost" and "this costs
		// one Pokemon and we did not finish checking whether none was possible".
		// A rung that ran out of budget proves nothing, and saying otherwise
		// would be the same class of lie as calling an unfinished search
		// impossible.
		var lowerAllDecided = true;
		for (var k = 0; k <= maxLosses; k++) {
			var sub = Object.create(null);
			for (var o in opts) sub[o] = opts[o];
			sub.lossBudget = k;
			sub.exactBudget = total - spent;
			if (sub.exactBudget <= 0) break;
			var r = cleanWin(state, sub);
			spent += r.nodes;
			last = r;
			if (r.found) {
				r.losses = k;
				r.nodes = spent;
				r.searchedUpTo = k;
				r.minimal = lowerAllDecided;
				return r;
			}
			if (!r.decided) lowerAllDecided = false;
		}
		if (last) {
			last.losses = null;
			last.nodes = spent;
			last.searchedUpTo = maxLosses;
			// `decided` from the last rung means "no win losing at most
			// maxLosses", which is a narrower claim than the one cleanWin makes
			// and must not be read as "no clean line exists".
		}
		return last || {found: false, decided: false, nodes: 0, line: null,
			losses: null, searchedUpTo: maxLosses};
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
	/**
	 * Ask the cheap search for a line, and keep it if it already loses nobody.
	 *
	 * The weighted search plays ONE greedy line and reports what happened. That
	 * is not a proof and it is not a ranking -- but when the line it happens to
	 * play loses nobody, it IS a witness, and there is no reason to make the
	 * exact search rediscover something already in hand.
	 *
	 * This is not hypothetical. On a mirror of GYM LEADER BROCK the exact search
	 * burns 200,000 nodes and finds nothing, at every horizon from 24 to 40,
	 * while the weighted search wins in 16 turns losing nobody -- verified by
	 * replaying it against the AI's real replies. Before this, that line was
	 * computed, labelled "the search ran out of time, here is a guess", and its
	 * most important property thrown away.
	 *
	 * It costs a fraction of the exact search, so it runs FIRST. What it cannot
	 * do is say a fight is unwinnable, which is why a miss falls straight
	 * through to the real search.
	 */
	function cheapWitness(state, opts) {
		if (typeof RRSolver === "undefined") return null;
		try {
			RRBattle.clearCache();
			var route = RRSolver.planRoute(state, {
				lookahead: opts.lookahead || 2,
				budget: opts.probeBudget || 20000,
				maxTurns: opts.maxTurns || 24,
				risks: RISKS
			});
			if (route && route.won && route.losses === 0 &&
				route.steps && route.steps.length) {
				return route;
			}
		} catch (e) { /* the real search is next either way */ }
		return null;
	}

	function planRoute(state, options) {
		var opts = options || {};
		var started = Date.now();

		// OFF unless asked for. Taking the cheap line skips certification
		// entirely: measured on a fight that certifies, the probe returns
		// `line-found` with no certificate where the real search returns
		// `certified`. Downgrading a provable answer to an unprovable one to
		// save 200 ms is a bad trade, and it is silent, which is worse. Left
		// here because the idea is sound for the case it was built for -- Brock,
		// where the exact search finds nothing -- and needs to certify the line
		// it borrows before it can be the default.
		RRBattle.clearCache();
		var proof = cleanWin(state, opts);

		if (proof.found) {
			return routeFromProof(state, proof, opts, started);
		}

		// The exact search could not settle it. Before falling back to a guess,
		// ask the cheap search whether the line it plays happens to lose nobody
		// -- if it does, that is a real witness and a far better answer than
		// "here is our best guess".
		//
		// This runs AFTER rather than before, which matters. Run first, it
		// short-circuits fights the exact search would have solved BETTER: on
		// Brock's mirror the probe returns a 16-turn line where the exact search
		// finds a 13-turn one, and a shorter line is less exposed to bad luck.
		// Run last it costs nothing, because the alternative was a guess.
		//
		// Measured worth: of 31 mirror fights the exact search failed, 26 were
		// won by the cheap search -- so this is not one odd fight, it is most of
		// the failures.
		if (opts.probe !== false && !proof.decided) {
			var cheap = cheapWitness(state, opts);
			if (cheap) {
				var cert = null;
				if (opts.certify) {
					cert = certify(state, {
						exactBudget: opts.certifyBudget || 400000,
						timeLimitMs: opts.certifyTimeLimitMs || 15000,
						maxTurns: opts.maxTurns || 24,
						forkBudget: 4
					});
				}
				cheap.certificate = cert;
				cheap.exactness = (cert && cert.proved) ? "certified" : "line-found";
				cheap.viaProbe = true;
				cheap.nodes = proof.nodes;
				cheap.elapsedMs = Date.now() - started;
				return cheap;
			}
		}

		// Deliberately fallbackRoute() rather than a copy of it. These two were
		// the same eleven lines written twice, and the parallel caller in
		// rr-search.js used one while the page used the other -- so a change to
		// the shared behaviour reached half the app. This repo has been bitten
		// by exactly that three times in one day (ceiling.js and bench_early
		// each carrying private copies of the generator and the search).
		var route = fallbackRoute(state, opts, proof.decided, proof.nodes);
		route.elapsedMs = Date.now() - started;
		return route;
	}

	/**
	 * Turn a found line into the route the app renders.
	 *
	 * Pulled out of planRoute so that a search split across several workers can
	 * build its answer the same way a single one does. The alternative was for
	 * the worker's entry point to assemble this itself, and logic that only runs
	 * inside a worker is logic that only breaks inside a worker.
	 */
	function routeFromProof(state, proof, options, startedAt) {
		var opts = options || {};
		var started = startedAt || Date.now();
		{
			var steps = toSteps(proof.line);
			var end = proof.line.length ? proof.line[proof.line.length - 1].next : state;
			// "line-found", NOT "proved". This line holds at median damage rolls
			// against the AI's top-scoring move. It says nothing about the
			// sixteenth roll, a critical hit, or the 7% of positions where the
			// AI has tied moves it might pick instead. Certification is a
			// separate and much more expensive question, asked below only when
			// the caller has the time for it.
			var certificate = null;
			if (opts.certify) {
				certificate = certify(state, {
					exactBudget: opts.certifyBudget || 400000,
					timeLimitMs: opts.certifyTimeLimitMs || 15000,
					maxTurns: opts.maxTurns || 24,
					forkBudget: 4
				});
			}
			return {
				steps: steps,
				won: true,
				losses: countFainted(end.me),
				lostNames: [],
				turns: steps.length,
				stalled: false,
				certificate: certificate,
				exactness: (certificate && certificate.proved) ? "certified" : "line-found",
				nodes: proof.nodes,
				elapsedMs: Date.now() - started
			};
		}
	}

	/**
	 * The heuristic answer, for when no clean line was found.
	 *
	 * Separated so a parallel caller can ask for it once, after every worker has
	 * come back empty, rather than each of them producing its own guess.
	 * `decided` here means every subset of the opening moves finished, which is
	 * the caller's sum and not something any one search can know.
	 */
	function fallbackRoute(state, options, decided, nodes) {
		var opts = options || {};
		if (typeof RRSolver === "undefined") {
			return {
				steps: [], won: false, losses: 0, lostNames: [], turns: 0,
				stalled: true,
				exactness: decided ? "proved-impossible" : "undecided",
				nodes: nodes || 0, elapsedMs: 0
			};
		}
		// A PROVED "no clean line" is the one situation where we know exactly
		// what to do instead: stop trying to preserve everything and search for
		// the cheapest loss. The weighted search underneath is still optimising
		// for a goal that has just been ruled out, and on NELLE that costs the
		// whole fight -- it loses 0-2 where the fight is winnable losing 1.
		//
		// Only on `decided`. When the search merely ran out of budget a clean
		// line may still exist, and spending the remaining time conceding one of
		// yours would be answering a question nobody asked.
		if (decided && opts.minLoss !== false) {
			RRBattle.clearCache();
			var cheap = cheapestWin(state, {
				exactBudget: opts.minLossBudget || 200000,
				timeLimitMs: opts.minLossTimeLimitMs || 10000,
				maxTurns: opts.maxTurns || 24,
				maxLosses: opts.maxLosses === undefined ? 2 : opts.maxLosses,
				flagSets: opts.flagSets
			});
			if (cheap.found && cheap.losses > 0) {
				var cheapSteps = toSteps(cheap.line);
				var endState = cheap.line[cheap.line.length - 1].next;
				return {
					steps: cheapSteps,
					won: true,
					losses: countFainted(endState.me),
					lostNames: endState.me.team.filter(function (m) {
						return m.fainted;
					}).map(function (m) { return m.species; }),
					turns: cheapSteps.length,
					stalled: false,
					certificate: null,
					// The proof stands and is what the panel must keep saying:
					// there is NO clean line. What is new is that the line
					// offered alongside it is now the cheapest known win rather
					// than a guess, so the cost is a searched result too.
					exactness: "no-clean-line-exists",
					minLoss: true,
					// Whether every cheaper option was actually ruled out, or
					// merely tried. The panel must not say "the least it can
					// cost" on the strength of a rung that ran out of budget.
					minLossProved: cheap.minimal === true,
					nodes: (nodes || 0) + cheap.nodes,
					exactNodes: nodes || 0,
					elapsedMs: 0
				};
			}
		}

		RRBattle.clearCache();
		var fallback = RRSolver.planRoute(state, opts);
		fallback.exactness = decided ? "no-clean-line-exists" : "undecided";
		fallback.exactNodes = nodes || 0;
		return fallback;
	}

	/**
	 * The AI's replies as a DISTRIBUTION, not a single choice.
	 *
	 * CFRU picks uniformly at random among everything tied at the top score
	 * (ai_master.c:360), so collapsing that to one action throws away real
	 * branching. Usually the tie set has one member and this costs nothing.
	 */
	var replyCache = new Map();

	function replies(state, opts, key) {
		if (typeof RRAI === "undefined") return null;
		var cacheKey = key === undefined ? RRBattle.positionKey(state) : key;
		var cached = replyCache.get(cacheKey);
		if (cached !== undefined) return cached;
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
		if (!tied.length) return null;
		var share = 1 / tied.length;
		var out = [];
		for (var t = 0; t < tied.length; t++) out.push({action: tied[t], p: share});
		// Scoring the opponent's options costs about 265us and the same position
		// turns up at several depths, so this is memoised for the life of one
		// search. Cleared per search because it is only valid while the teams
		// and field are the ones it was built for.
		replyCache.set(cacheKey, out);
		return out;
	}

	/**
	 * The probability of winning without losing anybody, played perfectly.
	 *
	 * This replaces the boolean question with the one actually worth asking.
	 * Searching for a line that survives the WORST roll answers "is this fight a
	 * formality", and against anything real the answer is no -- so it threw away
	 * every line that wins ninety-five times in a hundred, which are exactly the
	 * lines you want to be shown. Scoring the true distribution instead keeps
	 * them, ranked honestly, and a proof is simply the case where the answer
	 * comes back 1.
	 *
	 * The Nuzlocke objective is what keeps this affordable, in the same way it
	 * did for the boolean search: a branch where anything of yours faints is
	 * worth zero, so it is cut instead of explored rather than being followed to
	 * see how the battle turns out. Damage is bucketed by CONSEQUENCE -- whether
	 * the hit kills -- so sixteen rolls become two branches, not sixteen.
	 *
	 * Chance nodes are averaged and your own choices maximised, which is exactly
	 * right here: the dice are indifferent, and you are not.
	 *
	 * UNKNOWN IS NOT LOSS
	 * -------------------
	 * This search used to return a single number, and every way of giving up
	 * returned the same value a defeat did -- zero. Running out of node budget,
	 * hitting the turn horizon, and having no opponent model for a position were
	 * all indistinguishable from losing a Pokemon. Since exhaustion also
	 * short-circuits every remaining node, a search that ran out of budget
	 * reported a chance near zero no matter what it had already found, and the
	 * root ranking it produced was zeros.
	 *
	 * That is the same defect as the reliability floor this file already
	 * removed once: a lower bound displayed as a percentage reads as a win rate.
	 * It is worth naming the direction of the error, because it is not
	 * symmetric. Every one of these collapses biases the answer DOWNWARD, so the
	 * tool systematically told the player a fight was worse than it is, which is
	 * exactly the complaint that prompted the fix -- a fight reported as needing
	 * two losses was then played and won without losing anything.
	 *
	 * So a node now answers with two numbers. `v` is mass that provably reaches
	 * a clean win. `u` is mass we never examined. A real loss contributes to
	 * neither. The truth is somewhere in [v, v+u], and a caller that shows `v`
	 * while `u` is large is reporting its own budget as the player's odds.
	 *
	 * `u` is itself a LOWER bound, because the alpha cutoff abandons branches
	 * without counting what it did not look at there.
	 */
	function winChance(state, options) {
		var opts = options || {};
		var limits = {
			nodes: 0,
			budget: opts.exactBudget || opts.budget || 200000,
			// 24, matching cleanWin. It was 20, which meant the certifier gave
			// up four turns before the search that found the line did -- and
			// the proved Surge line is 23 turns long. A line the finder can
			// produce could not be certified, and the refusal came back as
			// "some branch loses a Pokemon" when the truth was "I stopped
			// watching before the end".
			maxTurns: opts.maxTurns || 24,
			forkBudget: opts.forkBudget === undefined ? 2 : opts.forkBudget,
			exhausted: false,
			collapsed: false
		};
		var memo = new Map();
		var started = Date.now();
		var deadline = opts.timeLimitMs ? started + opts.timeLimitMs : null;

		var rootRanking = null;

		// Every node answers with two numbers, not one: `v` is probability mass
		// that provably reaches a clean win, `u` is mass we simply never looked
		// at. They are different things and collapsing them was the bug this
		// search shipped with -- see UNKNOWN IS NOT LOSS above.
		function won() { return {v: 1, u: 0}; }
		function lost() { return {v: 0, u: 0}; }
		function unknown() { return {v: 0, u: 1}; }

		function value(current, turnsLeft, isRoot) {
			if (allDown(current.foe)) return won();
			// Running past the horizon is ignorance, not defeat. The fight is
			// still going; we stopped watching. Scoring it zero is what made a
			// long stall line indistinguishable from a loss.
			if (turnsLeft <= 0) return unknown();
			// Same short-circuit as walk(): giving up has to stop the whole
			// search, not just the node that noticed.
			if (limits.exhausted) return unknown();
			if (limits.nodes++ > limits.budget) { limits.exhausted = true; return unknown(); }
			if (deadline && (limits.nodes & 1023) === 0 && Date.now() > deadline) {
				limits.exhausted = true;
				return unknown();
			}

			// One positionKey, used three ways. It used to be computed here for
			// the memo and then computed again inside replies(), while ordered()
			// was called with no key at all -- so this search re-priced every
			// bench member's best move and the opponent's worst reply at every
			// node, which is dozens of damage lookups, where cleanWin caches the
			// same work. Same answers, less of them computed twice.
			var posKey = RRBattle.positionKey(current);
			var key = posKey + "@" + turnsLeft;
			var cached = memo.get(key);
			if (cached !== undefined) return cached;
			// Guard against revisiting a position mid-descent. A cycle is scored
			// as neither won nor unknown: counting it unknown would let a
			// position inflate its own uncertainty by looping back to itself.
			memo.set(key, lost());

			var theirs = replies(current, opts, posKey);
			// No opponent model for this position is a hole in OUR model, so it
			// is unknown. It used to read as a loss, which quietly punished
			// exactly the positions we understand least.
			if (!theirs) return unknown();

			var before = countFainted(current.me);
			var actions = ordered(current, posKey);
			var best = 0, bestUpper = 0;

			// At the root every action is priced, even once a certain win is
			// found, because the point there is the ranking rather than the
			// best value. Deeper down the early exit stands: nothing beats 1.
			for (var a = 0; a < actions.length && (isRoot || best < 1); a++) {
				// `remaining` starts whole for each action, so the cut-off below
				// must not fire on the first opponent reply once some earlier
				// action has already reached certainty.
				// `remaining` is the probability mass this action has not
				// resolved yet, so total + remaining is the most it could still
				// reach. Once that cannot beat the best action already priced,
				// the rest of its branches cannot change the answer and are
				// abandoned. This is what makes pricing the whole distribution
				// affordable: the boolean search could stop at the first line
				// that worked, and this one has no such luxury without it.
				var total = 0, totalU = 0, remaining = 1;
				for (var t = 0; t < theirs.length &&
					(isRoot || total + remaining > best); t++) {
					var successors;
					try {
						successors = RRBattle.step(current, actions[a], theirs[t].action,
							{mode: "odds", forkBudget: limits.forkBudget});
					} catch (e) { successors = null; }
					if (!successors) continue;
					for (var i = 0; i < successors.length; i++) {
						var next = successors[i].state;
						// The engine collapses outcomes when its fork budget runs
						// out. That merges branches, so anything downstream is an
						// estimate and must never be certified.
						if (next.collapsed) limits.collapsed = true;
						var weight = theirs[t].p * successors[i].probability;
						if (weight <= 0) continue;
						// Anything of ours dying is worth nothing, so the branch
						// is cut here rather than followed.
						if (countFainted(next.me) > before) { remaining -= weight; continue; }
						var sub = value(next, turnsLeft - 1);
						total += weight * sub.v;
						totalU += weight * sub.u;
						remaining -= weight;
						// Pruning here abandons branches whose unknown mass is
						// therefore never counted, so `u` is a LOWER bound on
						// our ignorance. It is reported as such and never used
						// to claim a fight is safer than measured.
						if (!isRoot && total + remaining <= best) break;
					}
				}
				// Whatever mass is still in `remaining` was never examined:
				// either the alpha cutoff broke out of the loop, or the engine
				// could not produce successors. It is not a loss, so it belongs
				// in this action's unknown. Faints are already out of
				// `remaining`, having been subtracted where they were cut.
				var actionUpper = Math.min(1, total + totalU + Math.max(0, remaining));
				if (isRoot) {
					rootRanking.push({action: actions[a], chance: total,
						unknown: actionUpper - total, upper: actionUpper});
				}
				// A max node's bounds are the max of its children's bounds --
				// separately. Ranking by what is PROVED keeps an action whose
				// only appeal is that we never looked at it from winning, while
				// tracking the best UPPER bound independently is what stops the
				// node from claiming certainty it has not earned.
				//
				// These have to be two comparisons. Carrying the unknown of
				// whichever action happened to maximise `v` loses it entirely
				// when every action is at zero, which is precisely the
				// exhausted search this change exists to describe.
				if (total > best) best = total;
				if (actionUpper > bestUpper) bestUpper = actionUpper;
			}

			var out = {v: best, u: Math.max(0, bestUpper - best)};
			memo.set(key, out);
			return out;
		}

		replyCache = new Map();
		matchupTable = tableFor(state, opts);
		// RRMatchup.build solves its 36 pairings through cleanWin with
		// `matchup: null`, which leaves this false on return. cleanWin re-sets
		// it per pass and rootActionKeys re-sets it; winChance did neither, so
		// it paid for a full table build -- up to 36 sub-searches -- and then
		// never consulted it once. Measured: RRMatchup.versus called 4 times
		// during cleanWin and 0 times during winChance.
		passUsesMatchup = opts.matchup !== null;
		limits.nodes += (matchupTable && matchupTable.nodes) || 0;
		// Cleared because this search now uses it too. positionKey does NOT
		// encode species, so an entry left over from a different fight can
		// legitimately collide with a key here, and the order it returned would
		// be for somebody else's team. Ordering cannot make an answer wrong, but
		// it can make one arbitrarily slow, and a stale hit is not debuggable.
		orderCache = new Map();
		rootRanking = [];
		var root = value(state, limits.maxTurns, true);
		var chance = root.v;
		var unknownMass = root.u;
		rootRanking.sort(function (x, y) { return y.chance - x.chance; });
		// Multiplying a few dozen branch probabilities together lands a certain
		// win on 0.999999999999999667 rather than 1, so "certain" needs a
		// tolerance. Without one a fight that genuinely cannot be lost reports
		// as merely likely, which is the sort of quiet wrongness that makes a
		// tool untrustworthy for the thing it was built for.
		var CERTAIN = 1 - 1e-9;
		return {
			chance: chance,
			// What the search PROVED, what it never looked at, and the most the
			// answer could be if every unexamined branch went our way. A caller
			// showing `chance` alone when `unknown` is large is reporting its
			// own budget as the player's odds.
			unknown: unknownMass,
			upper: Math.min(1, chance + unknownMass),
			ranking: rootRanking,
			collapsed: limits.collapsed,
			certain: chance >= CERTAIN && !limits.collapsed && !limits.exhausted,
			nodes: limits.nodes,
			exhausted: limits.exhausted,
			elapsedMs: Date.now() - started
		};
	}

	/**
	 * The action to take now, with the odds it carries.
	 *
	 * Every legal action is priced by the chance it leads to a clean win, so the
	 * answer is not just what to click but what it costs to be wrong -- the
	 * difference between "use Drain Punch" and "use Drain Punch, and if it does
	 * not kill, which happens one time in twenty, the plan is off".
	 *
	 * This is one search, not one per action. The first version ran a fresh
	 * search for every action with its own memo and took nine minutes on a
	 * three-Pokemon fight; the positions overlap almost entirely, so sharing the
	 * table is most of the work.
	 */
	function rank(state, options) {
		return winChance(state, options).ranking || [];
	}

	/**
	 * Certify that a fight can be won without losing anybody -- properly.
	 *
	 * This is the only function here entitled to the word "proof", and it exists
	 * because the other search is NOT one, despite having been labelled as such.
	 * cleanWin looks for a line at MEDIAN damage rolls against the AI's single
	 * top-scoring move. Two things are wrong with calling that proved:
	 *
	 *   - Rolls. A line that survives the median roll can still lose to the
	 *     sixteenth one, or to a critical hit. Nothing about median rolls
	 *     generalises to "every roll".
	 *   - Ties. CFRU picks uniformly among all moves tied at the top
	 *     (ai_master.c:360), and 7% of positions have such a tie, up to four
	 *     moves wide. Over a 23-turn line that is roughly a four-in-five chance
	 *     of passing through at least one position where the opponent could
	 *     legally have done something the search never considered.
	 *
	 * A real certificate has to hold under every outcome with nonzero
	 * probability. That is exactly what winChance already computes: it branches
	 * over the full tie set and over damage bucketed by whether it kills, and it
	 * treats any branch where something of ours faints as worth zero. So a
	 * result of 1 means no reachable branch loses a Pokemon -- a proof, not an
	 * average.
	 *
	 * It is refused if the search ran out of budget, or if the engine collapsed
	 * any outcome to stay affordable, because both mean branches went unexamined.
	 */
	function certify(state, options) {
		var result = winChance(state, options || {});
		// `chance` is a floor, never an estimate, and the gap up to `upper` is
		// how much of the fight went unexamined. A caller that renders the floor
		// as "your odds" when the gap is wide is quoting our search budget at
		// the player, which is the failure this pair exists to prevent.
		return {
			proved: result.certain,
			chance: result.chance,
			unknown: result.unknown,
			upper: result.upper,
			// True when the search learned too little for the floor to mean
			// anything. Say "I do not know" on this, not "you will probably
			// lose" -- they look identical in a single number and they are not
			// remotely the same claim.
			uninformative: !result.certain && result.unknown > 0.05,
			why: result.certain ? "no reachable branch loses a Pokemon"
				: result.exhausted ? "the search ran out of budget"
				: result.collapsed ? "the engine merged some outcomes to stay affordable"
				: "some branch loses a Pokemon",
			nodes: result.nodes,
			elapsedMs: result.elapsedMs
		};
	}

	/**
	 * The opening moves, named, in the order the search would try them.
	 *
	 * This is what a parallel caller deals out. Ordered rather than raw so that
	 * dealing round-robin gives every worker a mix of promising and unpromising
	 * openings instead of one worker getting all the good ones.
	 */
	function rootActionKeys(state, options) {
		var opts = options || {};
		matchupTable = tableFor(state, opts);
		singleReplyCache = new Map();
		orderCache = new Map();
		passUsesMatchup = opts.matchup !== null;
		var actions = ordered(state);
		var keys = [];
		for (var i = 0; i < actions.length; i++) keys.push(actionKey(actions[i]));
		return keys;
	}

	return {
		cleanWin: cleanWin,
		cheapestWin: cheapestWin,
		actionKey: actionKey,
		rootActionKeys: rootActionKeys,
		routeFromProof: routeFromProof,
		fallbackRoute: fallbackRoute,
		certify: certify,
		winChance: winChance,
		rank: rank,
		planRoute: planRoute,
		toSteps: toSteps
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRExact;
