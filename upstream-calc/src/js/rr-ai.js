/**
 * rr-ai.js -- what the Radical Red AI will actually do.
 *
 * Ported from Complete FireRed Upgrade, `src/Battle_AI/`. See docs/RR-AI.md for
 * the research this rests on; the two facts that shape this file are:
 *
 *   Every move starts at 100, each enabled AI bit runs one scoring pass, and
 *   the AI then picks UNIFORMLY AT RANDOM among all moves tied at the maximum
 *   (ai_master.c:360). So the AI's move is a set, not a choice, and modelling
 *   the score is modelling the AI exactly.
 *
 *   Nothing bypasses the score. A guaranteed KO is a bonus like any other, so
 *   "it will always take the kill" is not a rule and must not be assumed.
 *
 * COVERAGE IS PARTIAL AND DELIBERATELY LOPSIDED. There are ~880 scoring sites
 * upstream and this ports the ones that decide ordinary trainer turns. The bias
 * is chosen so that gaps stay safe:
 *
 *   A missing PENALTY leaves a move at 100, where it ties for the maximum and
 *   stays in the plausible set. That is a wider set than the truth: harmless.
 *
 *   A missing BONUS could push a move the AI really would pick out of the set.
 *   That is the direction that breaks things, so bonuses are ported sparingly
 *   and the margin exists to absorb the rest.
 *
 * Anything scored by a rule we did not port is reported in `unmodelled`.
 */
/* global RRBattle */
var RRAI = (function () {
	"use strict";

	var BASE = 100;

	// CFRU's three trainer AI bits (ai_master.c:44). Which of them a given
	// trainer has is ROM data we do not have, so callers take the union.
	var BASIC = "checkBadMove";        // bit 0, every trainer has this
	var SEMI = "semiSmart";            // bit 1, added by Hard/Expert difficulty
	var GOOD = "checkGoodMove";        // bit 2, bosses
	// Not a CFRU bit: whether AI_TRY_TO_KILL_RATE is compiled in at all.
	var BASIC_KILL = "basicKillBlock";

	// Abilities that make a whole type do nothing. ai_negatives.c gives these
	// -20 and returns immediately.
	var ABSORB = {
		"Volt Absorb": "Electric", "Motor Drive": "Electric", "Lightning Rod": "Electric",
		"Water Absorb": "Water", "Dry Skin": "Water", "Storm Drain": "Water",
		"Flash Fire": "Fire", "Sap Sipper": "Grass"
	};

	function typesOf(mon) {
		return RRBattle._internal.toCalcPokemon(mon).types;
	}

	/**
	 * Score one action the way CFRU would, and record why.
	 * `flags` is a set of the AI bits this trainer is assumed to have.
	 */
	function scoreAction(state, key, action, flags, notes) {
		var side = state[key];
		var foeSide = state[RRBattle.other(key)];
		var self = RRBattle.active(side);
		var foe = RRBattle.active(foeSide);
		var score = BASE;
		var reasons = [];

		function bad(amount, why) { score -= amount; reasons.push("-" + amount + " " + why); }
		function good(amount, why) { score += amount; reasons.push("+" + amount + " " + why); }

		if (action.type === "switch") {
			// Switching is scored by an entirely separate file upstream
			// (ai_switching.c, 100KB). Not ported: left at base so it stays in
			// the plausible set rather than being wrongly ruled out.
			notes.switching = true;
			return {score: BASE, reasons: ["switch scoring not ported"]};
		}

		var data = RRBattle.moveData(action.move);
		if (!data) return {score: BASE, reasons: ["unknown move"]};
		var effect = data.effect || {};

		// ---------------------------------------------------- damaging moves
		if (data.split !== "Status") {
			var rolls = RRBattle.damageRolls(state, key, action.move);
			if (!rolls || rolls.immune) {
				bad(20, "target is immune");
			} else {
				var absorbed = ABSORB[foe.set.ability];
				if (absorbed && absorbed === data.type) {
					bad(20, foe.set.ability + " absorbs " + data.type);
				}
				if (flags[GOOD]) {
					// DamageMoveViabilityIncrease, ai_positives.c:2741. In
					// singles the dominant signal is +9 for a kill it can land
					// first; a kill it cannot land first goes through
					// IncreaseViabilityForSlowKOMove, which is modulated by the
					// AI's fighting "class" (GetBankFightingStyle, not ported),
					// so it is given the smaller fixed bonus here.
					var kills = rolls.noCrit[0] >= foe.curHP;
					var first = movesFirst(state, key, action);
					var accurate = data.accuracy === null || data.accuracy >= 70;
					if (kills && first && accurate) good(9, "KOs and moves first");
					else if (kills) good(3, "KOs but is slower");
					else if (isStrongest(state, key, action.move)) good(3, "strongest move");
				} else if (flags[BASIC_KILL]) {
					// The basic-AI kill block (ai_negatives.c) is wrapped in
					// #ifdef AI_TRY_TO_KILL_RATE, which CFRU itself never
					// defines. Whether Radical Red switches it on is unknown, so
					// it is a flag the caller can set both ways rather than an
					// assumption baked in.
					if (rolls.noCrit[0] >= foe.curHP && movesFirst(state, key, action)) {
						good(7, "KOs (basic AI kill block, if enabled)");
					} else if (isStrongest(state, key, action.move)) {
						good(2, "strongest move (basic AI kill block, if enabled)");
					}
				}
			}
			if (data.accuracy !== null && data.accuracy < 60) bad(10, "unreliable accuracy");
			return {score: score, reasons: reasons};
		}

		// ------------------------------------------------------ status moves
		switch (effect.kind) {
		case "status":
			if (foe.status) bad(10, "target already has a status");
			else if (!RRBattle._internal.canTakeStatus(foe, effect.status)) {
				bad(10, "target cannot be " + effect.status);
			}
			break;
		case "boost":
			var target = effect.target === "self" ? self : foe;
			var maxed = true;
			for (var stat in effect.boosts) {
				if (!Object.prototype.hasOwnProperty.call(effect.boosts, stat)) continue;
				var now = target.boosts[stat] || 0;
				if (effect.boosts[stat] > 0 ? now < 6 : now > -6) maxed = false;
			}
			if (maxed) bad(10, "stats already at the cap");
			break;
		case "heal":
		case "wish":
			if (self.curHP === self.maxHP) bad(10, "already at full HP");
			break;
		case "rest":
			if (self.curHP === self.maxHP && !self.status) bad(10, "nothing to restore");
			break;
		case "hazard":
			if ((foeSide.hazards[effect.hazard] || 0) >= (effect.maxLayers || 1)) {
				bad(10, "hazard already at maximum");
			}
			break;
		case "screen":
			if (side.screens[effect.screen]) bad(10, "screen already up");
			break;
		case "weather":
			if (state.field.weather === effect.weather) bad(10, "weather already set");
			break;
		case "protect":
			if (self.volatiles.protectChain) bad(10, "Protect used last turn");
			break;
		case "substitute":
			if (self.volatiles.substitute) bad(10, "already behind a Substitute");
			else if (self.curHP <= self.maxHP / 4) bad(10, "not enough HP for a Substitute");
			break;
		case "leechSeed":
			if (foe.volatiles.leechSeed) bad(10, "already seeded");
			else if (typesOf(foe).indexOf("Grass") >= 0) bad(10, "Grass types cannot be seeded");
			break;
		case "taunt":
			if (foe.volatiles.taunt) bad(10, "already taunted");
			break;
		case "haze":
			var anyBoost = false;
			for (var s2 in foe.boosts) if (foe.boosts[s2] > 0) anyBoost = true;
			if (!anyBoost) bad(10, "nothing to reset");
			break;
		case "unsupported":
			notes.unsupported = notes.unsupported || [];
			if (notes.unsupported.indexOf(action.move) < 0) notes.unsupported.push(action.move);
			break;
		default:
			// No rule ported for this effect: left at base, which keeps it in
			// the plausible set. Recorded so the gap is visible.
			notes.unscored = notes.unscored || [];
			if (notes.unscored.indexOf(action.move) < 0) notes.unscored.push(action.move);
			break;
		}

		if (data.accuracy !== null && data.accuracy < 60) bad(10, "unreliable accuracy");
		return {score: score, reasons: reasons};
	}

	/** Whether this side would move first using this action. */
	function movesFirst(state, key, action) {
		var foeKey = RRBattle.other(key);
		var foeActions = RRBattle.legalActions(state, foeKey);
		var reference = null;
		for (var i = 0; i < foeActions.length; i++) {
			if (foeActions[i].type === "move") { reference = foeActions[i]; break; }
		}
		if (!reference) return true;
		var order = key === "me"
			? RRBattle.turnOrder(state, action, reference)
			: RRBattle.turnOrder(state, reference, action);
		return order ? order[0] === key : false;   // a speed tie is not "first"
	}

	function isStrongest(state, key, moveName) {
		var actions = RRBattle.legalActions(state, key);
		var best = -1, bestName = null;
		for (var i = 0; i < actions.length; i++) {
			if (actions[i].type !== "move") continue;
			var rolls = RRBattle.damageRolls(state, key, actions[i].move);
			var value = rolls && !rolls.immune ? rolls.noCrit[0] : 0;
			if (value > best) { best = value; bestName = actions[i].move; }
		}
		return bestName === moveName;
	}

	/** Score every legal action for one side under one assumed flag set. */
	function scoreAll(state, key, flags, notes) {
		return RRBattle.legalActions(state, key).map(function (action) {
			var scored = scoreAction(state, key, action, flags, notes);
			return {action: action, score: scored.score, reasons: scored.reasons};
		});
	}

	/**
	 * The moves the AI might actually pick.
	 *
	 * Everything within `margin` of the top score, unioned over the flag sets
	 * this trainer might have. Per-trainer flags are ROM data absent from the
	 * community spreadsheet, so the union is the honest reading: it can only
	 * make the set wider, never wrongly narrow.
	 *
	 * margin has a real unit. Of ~880 scoring sites upstream, 304 are
	 * DECREASE_VIABILITY(10) and bonuses cluster between 3 and 17, so a margin
	 * of 10 means "within one bad-move penalty of the best".
	 */
	function plausible(state, key, options) {
		var opts = options || {};
		// Margin is our error bar, not the engine's: the AI itself takes the
		// argmax exactly. 0 trusts this model completely, 20 keeps nearly
		// everything. 5 sits just under the smallest ported bonus, so a clearly
		// best move narrows the set while near-ties stay in it.
		var margin = opts.margin === undefined ? 5 : opts.margin;
		var flagSets = opts.flagSets || [
			{checkBadMove: true},                                        // route trainer
			{checkBadMove: true, basicKillBlock: true},                  // ...with the kill block on
			{checkBadMove: true, checkGoodMove: true}                    // boss
		];
		var notes = {};
		var chosen = [];
		var seen = {};

		flagSets.forEach(function (flags) {
			var scored = scoreAll(state, key, flags, notes);
			var best = -Infinity;
			scored.forEach(function (entry) { if (entry.score > best) best = entry.score; });
			scored.forEach(function (entry) {
				if (entry.score < best - margin) return;
				var id = entry.action.type === "switch"
					? "s" + entry.action.index : entry.action.move;
				if (seen[id]) return;
				seen[id] = true;
				chosen.push(entry);
			});
		});

		return {
			actions: chosen.map(function (entry) { return entry.action; }),
			scored: chosen,
			margin: margin,
			notes: notes
		};
	}

	return {
		scoreAll: scoreAll,
		scoreAction: scoreAction,
		plausible: plausible,
		BASE: BASE,
		BASIC: BASIC, SEMI: SEMI, GOOD: GOOD, BASIC_KILL: BASIC_KILL
	};
})();
