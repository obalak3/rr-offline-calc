/**
 * rr-plan.js -- rank this turn's options.
 *
 * The calculator answers "if I click this, how much damage". The question you
 * actually have in front of a gym leader is "which of these should I click",
 * and that depends on what comes back at you. So every one of your actions is
 * evaluated against what the opponent can do in reply, and scored on the worst
 * of those replies rather than the average: advice that only holds when the
 * opponent cooperates is not advice.
 *
 * Depth one. It does not search ahead; rr-solver does that, and it is built on
 * this, because a deep line is only worth as much as the per-turn evaluation
 * underneath it.
 *
 * The opponent model is a *plausible set*, the actions the AI might actually
 * take. Until the CFRU scoring rules are ported, that set is every legal action,
 * which is the conservative reading: it can only ever make the advice more
 * pessimistic, never falsely confident. See docs/RR-AI.md.
 *
 * No DOM, so it runs in Node for the tests and in the worker for the search.
 */
/* global RRBattle, RRCritKO, RRAI */
var RRPlan = (function () {
	"use strict";

	var MAX_TURNS = 6;

	/**
	 * What the opponent might do. Every legal action for now; once the AI
	 * scoring is ported this narrows to everything within margin M of the best
	 * score, and narrowing is the only direction that can make us wrong.
	 */
	function plausibleFoeActions(state, options) {
		var opts = options || {};
		if (opts.foeMovesOnly) {
			var moves = RRBattle.legalActions(state, "foe")
				.filter(function (a) { return a.type === "move"; });
			if (moves.length) return moves;
		}
		// Use the AI model when it is loaded, unless the caller explicitly wants
		// the fully conservative reading. Narrowing is the direction that can be
		// wrong, so rr-ai only ever drops an action it can show the AI will not
		// take -- most usefully a switch the ShouldSwitch gate rules out.
		if (opts.useAI !== false && typeof RRAI !== "undefined") {
			// THE TRUE DISTRIBUTION, when asked for: argmax plus exact ties,
			// which is what CFRU actually does. It is 2.24x narrower than the
			// margin set over 240 positions.
			//
			// MEASURED TO PLAY WORSE, AND LEFT OFF BY DEFAULT BECAUSE OF IT.
			// On nine level-appropriate fights, margin wins 9/9 losing 4
			// Pokemon; this wins 8/9 losing 6, and the fight it loses is Lt.
			// Surge, the only one that is close. The reason is exactly what the
			// scoreboard says: our argmax is right 75.5% of the time and the
			// margin catches 100%. Branching only on our argmax means that a
			// quarter of the time the advisor prepares for a move the AI will
			// not make and fails to prepare for the one it will.
			//
			// So the third pass's "the margin is our ignorance priced as the
			// game's randomness" is a correct DESCRIPTION and the wrong
			// PRESCRIPTION at our current port accuracy. The extra width is
			// buying real coverage of a real error, and the honest order is to
			// make the argmax better first and narrow afterwards -- not to
			// narrow now and lose fights for it.
			if (opts.trueDistribution && typeof RRAI.trueTies === "function") {
				var ties = RRAI.trueTies(state, "foe", opts).actions;
				if (ties.length) return ties;
			}
			var narrowed = RRAI.plausible(state, "foe", opts).actions;
			if (narrowed.length) return narrowed;
		}
		return RRBattle.legalActions(state, "foe");
	}

	function fraction(mon) {
		return mon.maxHP ? mon.curHP / mon.maxHP : 0;
	}

	/**
	 * How much of a side is left, counting the whole team.
	 *
	 * Ranking on the ACTIVE Pokemon's HP looks reasonable until the opponent
	 * switches. Then a strong move is punished for provoking the switch: Surf
	 * for 116 into a 141 HP Nidoking ranked below Rapid Spin for 17, because
	 * after the switch the damage sat on a different Pokemon and the active one
	 * was untouched. Damage to their team is damage to their team, wherever it
	 * lands, so that is what gets counted.
	 */
	function teamFraction(side) {
		var current = 0, total = 0;
		side.team.forEach(function (mon) {
			current += mon.curHP;
			total += mon.maxHP;
		});
		return total ? current / total : 0;
	}

	/** Turns to KO with this move, and the phrasing the calculator already uses. */
	function koProfile(state, attackerKey, moveName) {
		var rolls = RRBattle.damageRolls(state, attackerKey, moveName);
		if (!rolls || rolls.immune) return {immune: !!(rolls && rolls.immune), text: "no damage"};
		var defender = RRBattle.active(state[RRBattle.other(attackerKey)]);
		var chances = RRCritKO.koChances(rolls.noCrit, rolls.crit, rolls.critChance,
			defender.curHP, rolls.hits, MAX_TURNS);
		var turns = null;
		for (var i = 0; i < chances.length; i++) {
			if (chances[i] > 0.9999999) { turns = i + 1; break; }
		}
		return {
			min: rolls.noCrit[0],
			max: rolls.noCrit[rolls.noCrit.length - 1],
			critMax: rolls.crit[rolls.crit.length - 1],
			guaranteedIn: turns,
			chances: chances,
			text: RRCritKO.describe(chances, "")
		};
	}

	/**
	 * One exchange, read at its worst for the player. Returns what the board
	 * looks like afterwards plus the facts the ranking needs.
	 */
	function exchange(state, myAction, foeAction, opts) {
		// Max roll, no crit, by default. Reading a crit into every exchange
		// makes every option come back "loses this Pokemon", which ranks nothing
		// and is the same over-pessimism that made proofs unreachable. Crits are
		// a risk you switch on to ask a different question.
		var results = RRBattle.step(state, myAction, foeAction, {
			mode: (opts && opts.mode) || "maxroll",
			risks: (opts && opts.risks) || {}
		});
		var after = results[0].state;
		var mine = RRBattle.active(after.me);
		var theirs = RRBattle.active(after.foe);

		// A replacement arrives the moment something faints, so the fainted
		// Pokemon is no longer the active one. Losing something has to be
		// counted, not read off whoever happens to be standing there.
		function lost(before, later) {
			var was = 0, now = 0;
			before.team.forEach(function (m) { if (m.fainted) was++; });
			later.team.forEach(function (m) { if (m.fainted) now++; });
			return now > was;
		}
		var iLostOne = lost(state.me, after.me);
		var theyLostOne = lost(state.foe, after.foe);
		// WHICH of ours died, not merely that one did. James: "losing the wrong
		// pokemon ends the run for me. I am fine with losing a Golem, but I am
		// not fine losing a Kingambit." A count cannot express that, and every
		// objective in this repo has been a count.
		var iLostWho = null;
		if (iLostOne) {
			for (var li = 0; li < state.me.team.length; li++) {
				if (!state.me.team[li].fainted && after.me.team[li].fainted) {
					iLostWho = after.me.team[li].set.species;
					break;
				}
			}
		}
		return {
			state: after,
			foeAction: foeAction,
			myHP: fraction(mine),
			foeHP: fraction(theirs),
			myTeamHP: teamFraction(after.me),
			foeTeamHP: teamFraction(after.foe),
			iFainted: iLostOne,
			iFaintedWho: iLostWho,
			foeFainted: theyLostOne,
			over: RRBattle.isOver(after)
		};
	}

	/**
	 * Fastest guaranteed kill either side has from this position, and who gets
	 * there first.
	 *
	 * This is what stops the advice being technically true and practically
	 * useless. Depth one on its own says "you did not faint this turn", so a
	 * move that needs five turns against a foe that needs two reads as "safe".
	 * Reading the race from the position AFTER the exchange also prices setup
	 * properly: Swords Dance does nothing this turn, and either it buys enough
	 * to overtake the threat or it does not.
	 */
	function raceFrom(state) {
		var mine = RRBattle.active(state.me);
		var theirs = RRBattle.active(state.foe);
		// A knocked-out opponent is the race already won, not a race that
		// cannot be measured. Returning "unknown" here ranked a move that KOs
		// below one that chips, which is the opposite of the truth.
		if (theirs.fainted && !mine.fainted) {
			return {mine: 0, foe: null, movesFirst: "me", knockedOut: true};
		}
		if (mine.fainted) return {mine: null, foe: 0, lost: true};

		function fastest(key) {
			var best = null, bestMove = null;
			var actions = RRBattle.legalActions(state, key);
			for (var i = 0; i < actions.length; i++) {
				if (actions[i].type !== "move") continue;
				var profile = koProfile(state, key, actions[i].move);
				if (profile.guaranteedIn !== null && profile.guaranteedIn !== undefined &&
					(best === null || profile.guaranteedIn < best)) {
					best = profile.guaranteedIn;
					bestMove = actions[i];
				}
			}
			return {turns: best, move: bestMove};
		}
		var me = fastest("me");
		var foe = fastest("foe");
		// A level race goes to whoever moves first, so it has to be resolved
		// rather than called a draw.
		var first = null;
		if (me.move && foe.move) {
			var order = RRBattle.turnOrder(state, me.move, foe.move);
			first = order ? order[0] : null;   // null means a genuine speed tie
		}
		return {mine: me.turns, foe: foe.turns, movesFirst: first};
	}

	/**
	 * Rank on the worst reply, lexicographically:
	 *   1. do not lose the Pokemon
	 *   2. take the opposing one down
	 *   3. take more of its HP
	 *   4. keep more of yours
	 * Kept as ordered components rather than a weighted sum so the panel can
	 * say WHY one option beat another, instead of showing an opaque number.
	 */
	/**
	 * Survival is judged on the worst reply, damage on what is actually in
	 * front of you.
	 *
	 * Both have to be, and for different reasons. You can genuinely die to the
	 * worst reply, so survival cannot be optimistic. But damage measured after
	 * their pivot is not comparable between your own options: the opponent
	 * picks a different switch to blunt each one, so a super effective move is
	 * scored against whatever resists it. That ranked Bite above Water Gun into
	 * a Rock/Ground lead, which is not advice.
	 */
	/**
	 * The cost of losing a particular Pokemon, in [0, 1].
	 *
	 * DEFAULT IS 1 FOR EVERYTHING, which makes the survival criterion below
	 * reduce to exactly the boolean it replaces (1 when nothing died, 0 when
	 * something did). So this change is opt-in and cannot silently alter any
	 * existing measurement -- which matters, because the null test showed this
	 * project cannot detect a small behavioural change at the sample sizes it
	 * has.
	 *
	 * Below 1 marks a Pokemon as spendable, so a line that trades it outranks
	 * one that trades a costlier team-mate. A cost of exactly 1 is the
	 * "protected" case: losing it is as bad as the worst outcome the criterion
	 * can express.
	 *
	 * The twelfth pass argues these are really marginal contributions to the
	 * REST OF THE RUN, which is why they cannot be constants in the source and
	 * change between gyms. They are an input.
	 */
	function costOf(species, costs) {
		if (!costs || species === null || species === undefined) return 1;
		var c = costs[species];
		return (typeof c === "number") ? Math.max(0, Math.min(1, c)) : 1;
	}

	function survivalScore(worst, costs) {
		if (!worst.iFainted) return 1;
		return 1 - costOf(worst.iFaintedWho, costs);
	}

	function rankKey(worst, race, stable, isSwitch, chargeTempo, costs) {
		var damage = stable || worst;
		if (race && race.knockedOut) return [
			survivalScore(worst, costs),
			1,                       // it kills what is out; that is the point
			99,
			1 - damage.foeTeamHP,
			1,
			worst.myTeamHP
		];

		// How many turns ahead you are on the clock. Six stands in for "it
		// cannot get there", which is as good as a large lead.
		var mineTurns = (race && race.mine !== null) ? race.mine : 6;
		var foeTurns = (race && race.foe !== null) ? race.foe : 6;
		// A switch spends this turn without advancing our own clock, so the
		// incoming Pokemon needs one MORE turn than the race says it does.
		// Without this charge, switching always looks like it wins the race:
		// arriving fresh resets how long the opponent needs to kill us, while
		// nothing resets how long we need to kill it. Measured on Lt. Surge, the
		// advisor took that deal 21 times in one fight and refusing to switch at
		// all beat it by two knockouts.
		if (isSwitch && chargeTempo) mineTurns += 1;
		var turnLead = foeTurns - mineTurns;

		// The SIGN of the lead, not its size. Magnitude rewarded stalling:
		// Withdraw beat Water Gun into an Onix because raising Defence stretched
		// the opponent's clock further than attacking shortened yours, and a
		// move that never wins should not outrank one that does.
		var clock = turnLead > 0 ? 2 : (turnLead === 0 ? 1 : 0);

		return [
			survivalScore(worst, costs),                   // survival, priced
			damage.foeFainted ? 1 : 0,                     // a kill on what is out
			clock,                                         // ahead, level, behind
			1 - damage.foeTeamHP,                          // then: actual damage
			// Moving first only breaks a tie. It used to sit above damage, which
			// ranked Bite over Water Gun into a Rock/Ground lead: both needed one
			// more turn, but Water Gun triggered Sturdy, which put Geodude under
			// a quarter and switched on its Custap Berry, so it moved first. A
			// speed tiebreak should not outweigh five times the damage.
			(race && race.movesFirst === "me") ? 1 : 0,
			worst.myTeamHP
		];
	}

	function compareKeys(a, b) {
		for (var i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return b[i] - a[i];
		}
		return 0;
	}

	function labelFor(state, action) {
		if (action.type === "switch") {
			return "Switch to " + state.me.team[action.index].species;
		}
		return action.move;
	}

	function verdictFor(worst, race, stable) {
		if (worst.over === "win") return "wins the battle";
		if ((stable || worst).foeFainted && !worst.iFainted) return "KOs it and survives";
		if (worst.foeFainted && worst.iFainted) return "trades, both faint";
		if (worst.iFainted) return "loses this Pokemon";
		if (race && race.knockedOut) {
			return "KOs what is in front of you" +
				(worst.foeAction && worst.foeAction.type === "switch"
					? ", unless they pivot" : "");
		}
		if (!race || race.mine === null) {
			return "survives, " + Math.round((1 - worst.foeHP) * 100) + "% off it";
		}
		// A race that only gets worse because they pivoted is not a reason to
		// avoid the move, so say what actually happened.
		var pivoted = worst.foeAction && worst.foeAction.type === "switch";
		var pivotNote = pivoted ? " (they may pivot)" : "";
		// Counted from AFTER this turn resolves, so these are turns remaining,
		// not turns from now.
		var clock = "you need " + race.mine + " more" +
			(race.foe === null ? ", it cannot KO you" : ", it needs " + race.foe) +
			pivotNote;
		if (race.foe === null || race.mine < race.foe) return "wins the race: " + clock;
		if (race.mine === race.foe) {
			if (race.movesFirst === "me") return "wins on speed: " + clock;
			if (race.movesFirst === null) return "speed tie decides it: " + clock;
			return "LOSES on speed: " + clock;
		}
		return "LOSES the race: " + clock;
	}

	/**
	 * EXPECTED value of a position, under the per-Pokemon cost objective.
	 *
	 * Deliberately simple and dominated by the thing James cares about. Losing
	 * a Pokemon outweighs any amount of chip damage, so its weight is an order
	 * larger; progress against the foe comes next, because a cost-to-go alone
	 * is FLAT along a winning path (measured: Detect and Fake Out tied for
	 * first at exactly the do-nothing value); keeping our own HP is a
	 * tiebreak.
	 */
	function positionValue(state, costs) {
		var lost = 0;
		state.me.team.forEach(function (m) {
			if (m.fainted) lost += costOf(m.set.species, costs);
		});
		return -10 * lost
			+ 2 * (1 - teamFraction(state.foe))
			+ 1 * teamFraction(state.me);
	}

	/**
	 * THE EXACT ROOT: rank this turn over the TRUE outcome distribution.
	 *
	 * Measured, and this is why it exists. Every quality figure this project
	 * quotes was taken with median damage, no crits and no secondaries, and
	 * tools/measure_variance.js shows what that hides: eight of nine fights
	 * are identical under real dice, but Lt. Surge goes from WON to lost
	 * 15 times out of 15 with a full wipe. The advisor plans a two-turn kill
	 * as though it were certain when it is closer to a coin flip, and has no
	 * answer when the roll comes in low.
	 *
	 * The fix is not a better heuristic, it is a correct question: score each
	 * action by its EXPECTED value over the outcomes that can actually happen,
	 * weighted by how likely they are. Crits, misses, damage rolls, secondary
	 * effects and AI ties are then all handled by one mechanism, which is the
	 * unification METHOD.md argues for -- there is no separate crit design and
	 * roll design, only one distribution and one expectation over it.
	 *
	 * Affordable because it is one turn deep: measured at about 20 successors
	 * against the true opponent distribution, so it is free at the root and
	 * needs no sampling. Sampling the CURRENT turn would be the one place not
	 * to sample -- it is where the risk we most need calibrated lives, and the
	 * cheapest place to be exact.
	 */
	function exactRootRank(state, myActions, foeActions, opts) {
		var costs = opts && opts.costs;
		return myActions.map(function (action) {
			var total = 0, weight = 0;
			foeActions.forEach(function (foeAction) {
				var branches;
				try {
					branches = RRBattle.step(state, action, foeAction, {mode: "odds"});
				} catch (e) { return; }
				if (!branches || !branches.length) return;
				// Each foe action is equally likely within the model; each of
				// its outcomes carries its own probability.
				var share = 1 / foeActions.length;
				branches.forEach(function (br) {
					var p = (br.probability === undefined ? 1 / branches.length : br.probability);
					total += share * p * positionValue(br.state, costs);
					weight += share * p;
				});
			});
			return {action: action, value: weight ? total / weight : -Infinity};
		}).sort(function (a, b) { return b.value - a.value; });
	}

	/**
	 * Evaluate one of your actions against every plausible reply.
	 * The reported outcome is the worst of them.
	 */
	function evaluateAction(state, myAction, foeActions, opts) {
		var worst = null;
		var worstKey = null;
		var foeActions = foeActions || [];
		for (var i = 0; i < foeActions.length; i++) {
			var result = exchange(state, myAction, foeActions[i], opts);
			var key = rankKey(result, null, null, false, false, opts && opts.costs);
			if (worst === null || compareKeys(key, worstKey) > 0) {
				worst = result;
				worstKey = key;
			}
		}
		var myKO = myAction.type === "move" ?
			koProfile(state, "me", myAction.move) : null;

		// The race is measured against the Pokemon in front of you, NOT against
		// whoever they pivot to. Measuring it after their switch made it
		// incomparable between your options: a strong move provokes a switch
		// into something that walls it, so Surf for 116 into a 141 HP Nidoking
		// "lost the race" while Rapid Spin for 17 "won on speed". Their pivot is
		// already priced in the damage and survival terms; the race is there to
		// answer "can I out-trade what is actually out".
		var stable = null;
		for (var f = 0; f < foeActions.length; f++) {
			if (foeActions[f].type !== "move") continue;
			var attempt = exchange(state, myAction, foeActions[f], opts);
			if (!stable || attempt.myTeamHP < stable.myTeamHP) stable = attempt;
		}
		var race = raceFrom((stable || worst).state);
		var damageAgainst = stable || worst;
		return {
			action: myAction,
			label: labelFor(state, myAction),
			worst: worst,
			worstReply: worst.foeAction,
			key: rankKey(worst, race, damageAgainst,
				myAction.type === "switch", opts.chargeSwitchTempo !== false, opts && opts.costs),
			ko: myKO,
			race: race,
			verdict: verdictFor(worst, race, damageAgainst),
			unmodelled: worst.state.unmodelled.slice()
		};
	}

	/**
	 * Rank every action you have. `entries` comes back best first.
	 */
	function advise(state, options) {
		var opts = options || {};
		var myActions = RRBattle.legalActions(state, "me");
		var foeActions = plausibleFoeActions(state, opts);

		var entries = myActions.map(function (action) {
			return evaluateAction(state, action, foeActions, opts);
		});
		entries.sort(function (a, b) { return compareKeys(a.key, b.key); });

		// The exact root replaces the lexicographic ordering when asked for.
		// The entries are still built, because everything downstream -- the
		// verdict text, the threats, the KO profiles -- reads them; only the
		// ORDER changes, which is the whole claim being tested.
		if (opts.exactRoot) {
			var ranked = exactRootRank(state, myActions, foeActions, opts);
			var order = {};
			ranked.forEach(function (r, i) {
				order[r.action.type === "switch" ? "s" + r.action.index : r.action.move] = i;
			});
			entries.sort(function (a, b) {
				var ka = a.action.type === "switch" ? "s" + a.action.index : a.action.move;
				var kb = b.action.type === "switch" ? "s" + b.action.index : b.action.move;
				var ia = order[ka] === undefined ? 999 : order[ka];
				var ib = order[kb] === undefined ? 999 : order[kb];
				return ia - ib;
			});
			entries.forEach(function (entry) {
				var k = entry.action.type === "switch"
					? "s" + entry.action.index : entry.action.move;
				var r = ranked[order[k]];
				if (r) entry.expectedValue = r.value;
			});
		}

		var unmodelled = [];
		entries.forEach(function (entry) {
			entry.unmodelled.forEach(function (text) {
				if (unmodelled.indexOf(text) < 0) unmodelled.push(text);
			});
		});

		// ROBUSTNESS CHECK, run ONCE on the chosen action rather than branched
		// on at every ply. This is the third pass's prescription and the
		// scoreboard is what justifies the shape of it: our argmax is right
		// 75.5% of the time and the margin set catches 100% of the rest, so
		// our error is real but BOUNDED by the margin. Branching on it costs
		// 2.24x per ply to carry that coverage everywhere; re-ranking once
		// carries it where it matters -- on the answer we are about to give.
		//
		// It reports rather than overrides. A choice that survives the AI's
		// second-best being its best is worth more confidence than one that
		// does not, and that distinction is exactly what the old single number
		// could not express.
		var robust = null;
		if (opts.trueDistribution && entries.length) {
			var wide = plausibleFoeActions(state,
				Object.assign({}, opts, {trueDistribution: false}));
			var reranked = myActions.map(function (action) {
				return evaluateAction(state, action, wide, opts);
			});
			reranked.sort(function (a, b) { return compareKeys(a.key, b.key); });
			robust = {
				stable: reranked[0].label === entries[0].label,
				underWiderModel: reranked[0].label,
				foeActionCount: wide.length
			};
		}

		// What the opponent threatens, independent of what you pick. This is the
		// number that decides whether you can afford to set up.
		var threats = foeActions.filter(function (a) { return a.type === "move"; })
			.map(function (a) {
				return {move: a.move, ko: koProfile(state, "foe", a.move)};
			})
			.filter(function (t) { return !t.ko.immune && t.ko.min !== undefined; })
			.sort(function (a, b) { return b.ko.max - a.ko.max; });

		return {
			entries: entries,
			best: entries[0] || null,
			threats: threats,
			foeActionCount: foeActions.length,
			robust: robust,
			// Stated so the caller can report the assumption rather than imply
			// a confidence the model has not earned.
			reading: (opts.risks && opts.risks.crit)
				? "they roll high AND crit"
				: "they roll high, no crits",
			assumption: opts.foeMovesOnly
				? "worst case over every enemy move (switching not considered)"
				: (opts.useAI !== false && typeof RRAI !== "undefined"
					? "worst case over what the AI model says it might do"
					: "worst case over every legal enemy action"),
			unmodelled: unmodelled
		};
	}

	/** One line per option, for a terminal or a panel. */
	function explain(plan) {
		return plan.entries.map(function (entry, index) {
			var line = (index + 1) + ". " + entry.label + " -- " + entry.verdict;
			if (entry.ko && entry.ko.min !== undefined) {
				line += " (" + entry.ko.min + "-" + entry.ko.max + ", " + entry.ko.text + ")";
			}
			if (entry.worstReply && entry.worstReply.type === "move") {
				line += "  [worst reply: " + entry.worstReply.move + "]";
			} else if (entry.worstReply) {
				line += "  [worst reply: switch]";
			}
			return line;
		});
	}

	return {
		advise: advise,
		explain: explain,
		evaluateAction: evaluateAction,
		plausibleFoeActions: plausibleFoeActions,
		koProfile: koProfile
	};
})();
