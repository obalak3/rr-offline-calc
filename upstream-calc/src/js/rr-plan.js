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
			var narrowed = RRAI.plausible(state, "foe", opts).actions;
			if (narrowed.length) return narrowed;
		}
		return RRBattle.legalActions(state, "foe");
	}

	function fraction(mon) {
		return mon.maxHP ? mon.curHP / mon.maxHP : 0;
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
	function exchange(state, myAction, foeAction) {
		var results = RRBattle.step(state, myAction, foeAction, {mode: "worst"});
		var after = results[0].state;
		var mine = RRBattle.active(after.me);
		var theirs = RRBattle.active(after.foe);
		return {
			state: after,
			foeAction: foeAction,
			myHP: fraction(mine),
			foeHP: fraction(theirs),
			iFainted: mine.fainted,
			foeFainted: theirs.fainted,
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
		if (mine.fainted || theirs.fainted) return {mine: null, foe: null};

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
	function rankKey(worst, race) {
		var winsRace = 0;
		if (race && race.mine !== null) {
			if (race.foe === null || race.mine < race.foe) winsRace = 3;
			else if (race.mine === race.foe) {
				// Level on the clock: moving first wins it, a speed tie is a
				// coin flip and is not counted as winning.
				winsRace = race.movesFirst === "me" ? 2 : 1;
			}
		}
		return [
			worst.iFainted ? 0 : 1,
			worst.foeFainted ? 1 : 0,
			winsRace,
			1 - worst.foeHP,
			worst.myHP
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

	function verdictFor(worst, race) {
		if (worst.over === "win") return "wins the battle";
		if (worst.foeFainted && !worst.iFainted) return "KOs it and survives";
		if (worst.foeFainted && worst.iFainted) return "trades, both faint";
		if (worst.iFainted) return "loses this Pokemon";
		if (!race || race.mine === null) {
			return "survives, " + Math.round((1 - worst.foeHP) * 100) + "% off it";
		}
		// Counted from AFTER this turn resolves, so these are turns remaining,
		// not turns from now.
		var clock = "you need " + race.mine + " more" +
			(race.foe === null ? ", it cannot KO you" : ", it needs " + race.foe);
		if (race.foe === null || race.mine < race.foe) return "wins the race: " + clock;
		if (race.mine === race.foe) {
			if (race.movesFirst === "me") return "wins on speed: " + clock;
			if (race.movesFirst === null) return "speed tie decides it: " + clock;
			return "LOSES on speed: " + clock;
		}
		return "LOSES the race: " + clock;
	}

	/**
	 * Evaluate one of your actions against every plausible reply.
	 * The reported outcome is the worst of them.
	 */
	function evaluateAction(state, myAction, foeActions) {
		var worst = null;
		var worstKey = null;
		for (var i = 0; i < foeActions.length; i++) {
			var result = exchange(state, myAction, foeActions[i]);
			var key = rankKey(result);
			if (worst === null || compareKeys(key, worstKey) > 0) {
				worst = result;
				worstKey = key;
			}
		}
		var myKO = myAction.type === "move" ?
			koProfile(state, "me", myAction.move) : null;
		// Priced only on the worst exchange, not on every one: the race costs a
		// damage calc per move per side, and the worst reply is the one the
		// ranking is defending against anyway.
		var race = raceFrom(worst.state);
		return {
			action: myAction,
			label: labelFor(state, myAction),
			worst: worst,
			worstReply: worst.foeAction,
			key: rankKey(worst, race),
			ko: myKO,
			race: race,
			verdict: verdictFor(worst, race),
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
			return evaluateAction(state, action, foeActions);
		});
		entries.sort(function (a, b) { return compareKeys(a.key, b.key); });

		var unmodelled = [];
		entries.forEach(function (entry) {
			entry.unmodelled.forEach(function (text) {
				if (unmodelled.indexOf(text) < 0) unmodelled.push(text);
			});
		});

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
			// Stated so the caller can report the assumption rather than imply
			// a confidence the model has not earned.
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
