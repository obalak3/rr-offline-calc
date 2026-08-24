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

	/**
	 * The AI's reply: a function of the position, not a distribution.
	 *
	 * Memoised, and that only became worth doing once the visited set started
	 * keying on remaining turns as well as position. Before that every position
	 * was explored exactly once and a cache could never hit; now a position can
	 * legitimately be revisited with a larger budget, and scoring the
	 * opponent's options is about 265us -- the single biggest cost per node.
	 */
	var singleReplyCache = {};

	function reply(state, opts, key) {
		if (typeof RRAI === "undefined") return null;
		var cacheKey = key === undefined ? RRBattle.positionKey(state) : key;
		var hit = singleReplyCache[cacheKey];
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
		singleReplyCache[cacheKey] = chosen;
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
	var orderCache = {};

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

	function ordered(state, key) {
		if (key !== undefined) {
			var hit = orderCache[key];
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
					// Below zero, so a switch only outranks an attack that is
					// doing almost nothing -- but a good pivot now beats a bad
					// attack instead of losing to every one of them.
					rank = -1 + 40 * deal - 30 * Math.min(1, take) + free;
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
		if (key !== undefined) orderCache[key] = out2;
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
			truncated: false
		};
		var seen = {};
		var onProgress = opts.onProgress || null;
		singleReplyCache = {};
		orderCache = {};
		var line = [];
		var started = Date.now();
		var deadline = opts.timeLimitMs ? started + opts.timeLimitMs : null;

		function walk(current, turnsLeft) {
			// Once the search has given up, EVERY node must return immediately.
			// Without this the time limit did not work: it fired on one node in
			// 1024 and the other 1023 carried on searching, so a 12 second cap
			// ran for over three minutes and only stopped when the node budget
			// ran out. The budget check got away with the same shape by
			// accident, because every later node also exceeds the budget.
			if (limits.exhausted) return false;
			if (limits.nodes++ > limits.budget) { limits.exhausted = true; return false; }
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
			var key = RRBattle.positionKey(current);
			var triedWith = seen[key];
			if (triedWith !== undefined && triedWith >= turnsLeft) return false;
			seen[key] = turnsLeft;

			var theirs = reply(current, opts, key);
			if (!theirs) return false;

			var before = countFainted(current.me);
			var actions = ordered(current, key);
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

	/**
	 * The AI's replies as a DISTRIBUTION, not a single choice.
	 *
	 * CFRU picks uniformly at random among everything tied at the top score
	 * (ai_master.c:360), so collapsing that to one action throws away real
	 * branching. Usually the tie set has one member and this costs nothing.
	 */
	var replyCache = {};

	function replies(state, opts) {
		if (typeof RRAI === "undefined") return null;
		var cacheKey = RRBattle.positionKey(state);
		var cached = replyCache[cacheKey];
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
		replyCache[cacheKey] = out;
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
	 */
	function winChance(state, options) {
		var opts = options || {};
		var limits = {
			nodes: 0,
			budget: opts.exactBudget || opts.budget || 200000,
			maxTurns: opts.maxTurns || 20,
			forkBudget: opts.forkBudget === undefined ? 2 : opts.forkBudget,
			exhausted: false,
			collapsed: false
		};
		var memo = {};
		var started = Date.now();
		var deadline = opts.timeLimitMs ? started + opts.timeLimitMs : null;

		var rootRanking = null;

		function value(current, turnsLeft, isRoot) {
			if (allDown(current.foe)) return 1;
			if (turnsLeft <= 0) return 0;
			// Same short-circuit as walk(): giving up has to stop the whole
			// search, not just the node that noticed.
			if (limits.exhausted) return 0;
			if (limits.nodes++ > limits.budget) { limits.exhausted = true; return 0; }
			if (deadline && (limits.nodes & 1023) === 0 && Date.now() > deadline) {
				limits.exhausted = true;
				return 0;
			}

			var key = RRBattle.positionKey(current) + "@" + turnsLeft;
			var cached = memo[key];
			if (cached !== undefined) return cached;
			memo[key] = 0;   // guard against revisiting a position mid-descent

			var theirs = replies(current, opts);
			if (!theirs) return 0;

			var before = countFainted(current.me);
			var actions = ordered(current);
			var best = 0;

			// At the root every action is priced, even once a certain win is
			// found, because the point there is the ranking rather than the
			// best value. Deeper down the early exit stands: nothing beats 1.
			for (var a = 0; a < actions.length && (isRoot || best < 1); a++) {
				// `remaining` is the probability mass this action has not
				// resolved yet, so total + remaining is the most it could still
				// reach. Once that cannot beat the best action already priced,
				// the rest of its branches cannot change the answer and are
				// abandoned. This is what makes pricing the whole distribution
				// affordable: the boolean search could stop at the first line
				// that worked, and this one has no such luxury without it.
				var total = 0, remaining = 1;
				for (var t = 0; t < theirs.length && total + remaining > best; t++) {
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
						total += weight * value(next, turnsLeft - 1);
						remaining -= weight;
						if (!isRoot && total + remaining <= best) break;
					}
				}
				if (isRoot) rootRanking.push({action: actions[a], chance: total});
				if (total > best) best = total;
			}

			memo[key] = best;
			return best;
		}

		replyCache = {};
		rootRanking = [];
		var chance = value(state, limits.maxTurns, true);
		rootRanking.sort(function (x, y) { return y.chance - x.chance; });
		// Multiplying a few dozen branch probabilities together lands a certain
		// win on 0.999999999999999667 rather than 1, so "certain" needs a
		// tolerance. Without one a fight that genuinely cannot be lost reports
		// as merely likely, which is the sort of quiet wrongness that makes a
		// tool untrustworthy for the thing it was built for.
		var CERTAIN = 1 - 1e-9;
		return {
			chance: chance,
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
		return {
			proved: result.certain,
			chance: result.chance,
			why: result.certain ? "no reachable branch loses a Pokemon"
				: result.exhausted ? "the search ran out of budget"
				: result.collapsed ? "the engine merged some outcomes to stay affordable"
				: "some branch loses a Pokemon",
			nodes: result.nodes,
			elapsedMs: result.elapsedMs
		};
	}

	return {
		cleanWin: cleanWin,
		certify: certify,
		winChance: winChance,
		rank: rank,
		planRoute: planRoute,
		toSteps: toSteps
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRExact;
