/**
 * rr-critko.js -- critical-hit-aware KO probability.
 *
 * The stock damage calculator treats crits as a fixed on/off state: its KO
 * chance is computed either entirely without crits or entirely with them.
 * This module blends the two, so "92% chance to OHKO" accounts for the
 * possibility that the move crits and kills when a non-crit would not.
 *
 * Method: build the 16-roll damage array twice (crit and non-crit), give each
 * hit an independent crit probability c, then convolve the resulting per-hit
 * distribution over successive turns with a DP over cumulative damage.
 * That is exact for the damage rolls themselves.
 *
 * Deliberate limitation: end-of-turn residual damage (weather, poison,
 * Leftovers) and entry hazards are NOT folded in here -- those live inside the
 * upstream getKOChance, which is not exported piecewise. Results that would be
 * affected are labelled, and the stock KO line is always shown alongside.
 *
 * Nothing in this file is upstream code; it is additive.
 */
/* global calc */
var RRCritKO = (function () {
	"use strict";

	// Gen 7+ crit stages. Radical Red follows modern mechanics.
	var STAGE_RATE = [1 / 24, 1 / 8, 1 / 2, 1];

	// Moves with an increased crit ratio (+1 stage).
	var HIGH_CRIT_MOVES = [
		"Aeroblast", "Air Cutter", "Aqua Cutter", "Attack Order", "Blaze Kick",
		"Crabhammer", "Cross Chop", "Cross Poison", "Drill Run", "Esper Wing",
		"Ivy Cudgel", "Karate Chop", "Leaf Blade", "Night Slash", "Poison Tail",
		"Psycho Cut", "Razor Leaf", "Razor Wind", "Shadow Claw", "Sky Attack",
		"Slash", "Snipe Shot", "Spacial Rend", "Stone Edge", "Triple Arrows",
		"10,000,000 Volt Thunderbolt"
	];

	// Moves that always crit. The calc flags these with willCrit as well; the
	// list is kept here so the crit rate is right even if the flag is missing.
	var ALWAYS_CRIT_MOVES = [
		"Frost Breath", "Storm Throw", "Wicked Blow", "Surging Strikes",
		"Flower Trick", "Zippy Zap"
	];

	// Items granting a crit-stage bonus to any holder.
	var CRIT_ITEMS = {"Scope Lens": 1, "Razor Claw": 1};

	// Items granting a bonus only to specific species.
	var SPECIES_CRIT_ITEMS = [
		{item: "Leek", stage: 2, species: ["Farfetch’d", "Farfetch'd", "Farfetch’d-Galar", "Farfetch'd-Galar", "Sirfetch’d", "Sirfetch'd"]},
		{item: "Stick", stage: 2, species: ["Farfetch’d", "Farfetch'd", "Farfetch’d-Galar", "Farfetch'd-Galar", "Sirfetch’d", "Sirfetch'd"]},
		{item: "Lucky Punch", stage: 2, species: ["Chansey"]}
	];

	var NEVER_CRIT_ABILITIES = ["Battle Armor", "Shell Armor"];

	function has(list, value) {
		if (!value) return false;
		for (var i = 0; i < list.length; i++) {
			if (list[i] === value) return true;
		}
		return false;
	}

	/**
	 * Crit stage for this attacker/move, before the defender is considered.
	 * `bonus` carries UI-driven effects the calculator has no field for,
	 * chiefly Focus Energy / Dire Hit (+2).
	 */
	function critStage(attacker, move, bonus) {
		var stage = bonus || 0;
		if (has(HIGH_CRIT_MOVES, move.name)) stage += 1;
		if (attacker.ability === "Super Luck") stage += 1;
		if (CRIT_ITEMS[attacker.item]) stage += CRIT_ITEMS[attacker.item];
		for (var i = 0; i < SPECIES_CRIT_ITEMS.length; i++) {
			var entry = SPECIES_CRIT_ITEMS[i];
			if (attacker.item === entry.item &&
				has(entry.species, attacker.name)) {
				stage += entry.stage;
			}
		}
		return stage;
	}

	/**
	 * Probability that a given hit is a critical hit, in [0, 1].
	 */
	function critChance(attacker, defender, move, bonus) {
		if (has(NEVER_CRIT_ABILITIES, defender.ability)) return 0;
		if (move.isCrit || has(ALWAYS_CRIT_MOVES, move.name)) return 1;
		// Merciless always crits a poisoned target.
		if (attacker.ability === "Merciless" &&
			(defender.status === "psn" || defender.status === "tox")) return 1;
		var stage = critStage(attacker, move, bonus);
		if (stage < 0) stage = 0;
		if (stage > 3) stage = 3;
		return STAGE_RATE[stage];
	}

	/**
	 * Flatten whatever shape the calculator handed back into a roll array.
	 */
	function rolls(damage) {
		if (typeof damage === "number") return [damage];
		if (!damage.length) return [0];
		if (typeof damage[0] === "number") return damage.slice();
		// Multi-hit: array of per-hit roll arrays. Sum them position-wise so
		// the caller still gets a per-turn total if it wants one.
		var total = [];
		for (var i = 0; i < damage[0].length; i++) {
			var sum = 0;
			for (var h = 0; h < damage.length; h++) sum += damage[h][i];
			total.push(sum);
		}
		return total;
	}

	/**
	 * Cumulative KO probability after each of 1..maxTurns turns.
	 *
	 * @param noCrit  roll array for a single non-crit hit
	 * @param crit    roll array for a single crit hit
	 * @param c       per-hit crit probability
	 * @param hp      HP that must be removed
	 * @param hits    hits per turn (multi-hit moves crit independently per hit)
	 * @param maxTurns
	 * @returns array of cumulative probabilities, index 0 = after turn 1
	 */
	function koChances(noCrit, crit, c, hp, hits, maxTurns) {
		return koChancesMulti(
			[{noCrit: noCrit, crit: crit, critChance: c, hits: hits || 1}],
			hp, maxTurns || 6);
	}

	/**
	 * One shot's per-hit outcome distribution: 16 non-crit rolls at (1-c)/16
	 * and 16 crit rolls at c/16.
	 */
	function outcomesFor(noCrit, crit, c) {
		var outcomes = [];
		var i;
		for (i = 0; i < noCrit.length; i++) {
			outcomes.push([noCrit[i], (1 - c) / noCrit.length]);
		}
		for (i = 0; i < crit.length; i++) {
			outcomes.push([crit[i], c / crit.length]);
		}
		return outcomes;
	}

	/**
	 * Cumulative KO probability when SEVERAL different attacks land each turn.
	 *
	 * This is what a doubles turn actually looks like: two attackers, each with
	 * its own damage rolls and its own crit rate, focusing one target. Summing
	 * their average damage would be wrong -- the question is the probability
	 * that the *total* crosses the target's HP, and each attack crits
	 * independently. So convolve the shots in sequence over one shared
	 * distribution of cumulative damage.
	 *
	 * @param shots [{noCrit, crit, critChance, hits}] all landing in one turn
	 * @param hp    HP that must be removed
	 * @param maxTurns how many times the same set of shots repeats
	 */
	function koChancesMulti(shots, hp, maxTurns) {
		maxTurns = maxTurns || 6;
		if (hp <= 0) return [1];
		if (!shots.length) return [];

		var perShot = [];
		for (var s = 0; s < shots.length; s++) {
			perShot.push({
				outcomes: outcomesFor(shots[s].noCrit, shots[s].crit,
					shots[s].critChance),
				hits: shots[s].hits || 1
			});
		}

		var alive = new Float64Array(hp);
		alive[0] = 1;
		var ko = 0;
		var results = [];

		for (var turn = 0; turn < maxTurns; turn++) {
			for (var i = 0; i < perShot.length; i++) {
				for (var hit = 0; hit < perShot[i].hits; hit++) {
					var outcomes = perShot[i].outcomes;
					var next = new Float64Array(hp);
					for (var d = 0; d < hp; d++) {
						var p = alive[d];
						if (p === 0) continue;
						for (var o = 0; o < outcomes.length; o++) {
							var prob = p * outcomes[o][1];
							if (prob === 0) continue;
							var nd = d + outcomes[o][0];
							if (nd >= hp) ko += prob;
							else next[nd] += prob;
						}
					}
					alive = next;
				}
			}
			results.push(ko);
			if (ko > 0.9999999) break;
		}
		return results;
	}

	/**
	 * Turn the cumulative chances into the calculator's phrasing.
	 */
	function describe(chances, qualifier) {
		qualifier = qualifier || "";
		for (var n = 0; n < chances.length; n++) {
			var p = chances[n];
			if (p <= 0) continue;
			var label = n === 0 ? "OHKO" : (n + 1) + "HKO";
			if (p > 0.9999999) return qualifier + "guaranteed " + label;
			var pct = Math.max(Math.min(Math.round(p * 1000), 999), 1) / 10;
			return qualifier + pct + "% chance to " + label;
		}
		return qualifier + "not a KO";
	}

	/**
	 * The damage range actually reachable, given how often the move crits.
	 *
	 * Spanning "non-crit low roll to crit high roll" is right when a crit is
	 * merely possible, but wrong at the extremes: a move that always crits
	 * (Super Luck plus Scope Lens plus a high-ratio move, say) can never roll
	 * the non-crit minimum, and one that cannot crit can never reach the crit
	 * maximum.
	 */
	function damageSpan(plain, critical, c, hits) {
		var low = (c >= 1 ? critical : plain)[0];
		var high = (c <= 0 ? plain : critical);
		return {min: low * hits, max: high[high.length - 1] * hits};
	}

	/**
	 * Full crit-aware analysis for one attacker/defender/move.
	 *
	 * Returns null when the move deals no damage.
	 */
	function analyse(gen, attacker, defender, move, field, opts) {
		opts = opts || {};
		var bonus = opts.critStageBonus || 0;

		// Single-hit damage arrays, so multi-hit moves can crit per hit.
		var hits = move.hits || 1;
		var single = new calc.Move(gen, move.name, {
			hits: 1,
			useMax: move.useMax,
			isStellarFirstUse: move.isStellarFirstUse
		});
		var singleCrit = new calc.Move(gen, move.name, {
			hits: 1, isCrit: true,
			useMax: move.useMax,
			isStellarFirstUse: move.isStellarFirstUse
		});

		var plain, critical;
		try {
			plain = rolls(calc.calculate(gen, attacker, defender, single, field).damage);
			critical = rolls(calc.calculate(gen, attacker, defender, singleCrit, field).damage);
		} catch (e) {
			return null;
		}

		var maxRoll = Math.max.apply(null, plain.concat(critical));
		if (maxRoll <= 0) return null;

		var c = critChance(attacker, defender, move, bonus);
		var hp = defender.curHP();
		var chances = koChances(plain, critical, c, hp, hits, 6);
		var without = koChances(plain, critical, 0, hp, hits, 6);

		var span = damageSpan(plain, critical, c, hits);
		return {
			critChance: c,
			critStage: critStage(attacker, move, bonus),
			chances: chances,
			chancesWithoutCrits: without,
			text: describe(chances, hits > 1 ? "approx. " : ""),
			textWithoutCrits: describe(without, hits > 1 ? "approx. " : ""),
			minTurnDamage: span.min,
			maxTurnDamage: span.max,
			maxHP: defender.maxHP()
		};
	}

	/**
	 * How many Pokemon a move actually hits, given who is still standing.
	 *
	 * This decides the spread penalty, which is NOT a property of the format:
	 * the 0.75x applies only when a move genuinely hits two or more targets. In
	 * a 2v1 a Rock Slide aimed at the last opponent hits one Pokemon and deals
	 * full damage -- but an Earthquake still hits 0.75x if the attacker's own
	 * partner is alive, because it hits that partner too.
	 *
	 * @param livingFoes   opponents of the attacker still on the field
	 * @param livingAllies the attacker's partners still on the field (not itself)
	 */
	function targetsHit(move, livingFoes, livingAllies) {
		if (move.target === "allAdjacentFoes") return Math.max(livingFoes, 0);
		if (move.target === "allAdjacent") {
			return Math.max(livingFoes, 0) + Math.max(livingAllies, 0);
		}
		return 1;
	}

	/**
	 * The field this particular move should be calculated under.
	 *
	 * The calculator applies the spread penalty whenever gameType is Doubles, so
	 * a move that only reaches one target must be calculated as Singles to get
	 * its true damage.
	 */
	function fieldForMove(baseField, move, livingFoes, livingAllies) {
		var wanted = targetsHit(move, livingFoes, livingAllies) >= 2
			? "Doubles" : "Singles";
		if (baseField.gameType === wanted) return baseField;
		var clone = baseField.clone ? baseField.clone() : baseField;
		clone.gameType = wanted;
		return clone;
	}

	/**
	 * Build one shot's damage distributions, so several attackers can be
	 * combined without recomputing anything twice.
	 */
	function shotFor(gen, attacker, defender, move, field, bonus) {
		var hits = move.hits || 1;
		var opts = {
			hits: 1,
			useMax: move.useMax,
			isStellarFirstUse: move.isStellarFirstUse
		};
		var single = new calc.Move(gen, move.name, opts);
		var critOpts = {
			hits: 1, isCrit: true,
			useMax: move.useMax,
			isStellarFirstUse: move.isStellarFirstUse
		};
		var singleCrit = new calc.Move(gen, move.name, critOpts);
		var plain, critical;
		try {
			plain = rolls(calc.calculate(gen, attacker, defender, single, field).damage);
			critical = rolls(calc.calculate(gen, attacker, defender, singleCrit, field).damage);
		} catch (e) {
			return null;
		}
		if (Math.max.apply(null, plain.concat(critical)) <= 0) return null;
		var rate = critChance(attacker, defender, move, bonus);
		var span = damageSpan(plain, critical, rate, hits);
		return {
			noCrit: plain,
			crit: critical,
			critChance: rate,
			hits: hits,
			attacker: attacker.name,
			move: move.name,
			min: span.min,
			max: span.max
		};
	}

	/**
	 * Both attackers focusing one target: does the combined damage kill?
	 *
	 * This is the question a doubles turn actually poses, and it is not
	 * answerable by reading two single-target results side by side. Each attack
	 * rolls damage and crits independently, so what matters is the probability
	 * that the *total* crosses the target's HP -- which is a convolution, not a
	 * sum of averages. Adding the two "maximum damage" figures overstates the
	 * kill; adding the two averages understates how often a crit gets there.
	 *
	 * @param pairs [{attacker, move}] everything aimed at the defender this turn
	 */
	function analyseFocusFire(gen, pairs, defender, field, opts) {
		opts = opts || {};
		var bonus = opts.critStageBonus || 0;
		var shots = [];
		for (var i = 0; i < pairs.length; i++) {
			if (!pairs[i] || !pairs[i].move) continue;
			var shot = shotFor(gen, pairs[i].attacker, defender, pairs[i].move,
				field, bonus);
			if (shot) shots.push(shot);
		}
		if (!shots.length) return null;

		var hp = defender.curHP();
		var withCrits = koChancesMulti(shots, hp, 6);
		var flat = [];
		for (var s = 0; s < shots.length; s++) {
			flat.push({
				noCrit: shots[s].noCrit, crit: shots[s].crit,
				critChance: 0, hits: shots[s].hits
			});
		}
		var withoutCrits = koChancesMulti(flat, hp, 6);

		var min = 0, max = 0;
		for (var m = 0; m < shots.length; m++) {
			min += shots[m].min;
			max += shots[m].max;
		}
		var multi = shots.some ? shots.some(function (x) { return x.hits > 1; }) : false;
		return {
			shots: shots,
			chances: withCrits,
			chancesWithoutCrits: withoutCrits,
			text: describe(withCrits, multi ? "approx. " : ""),
			textWithoutCrits: describe(withoutCrits, multi ? "approx. " : ""),
			minTurnDamage: min,
			maxTurnDamage: max,
			maxHP: defender.maxHP()
		};
	}

	return {
		analyse: analyse,
		analyseFocusFire: analyseFocusFire,
		shotFor: shotFor,
		targetsHit: targetsHit,
		fieldForMove: fieldForMove,
		critChance: critChance,
		critStage: critStage,
		koChances: koChances,
		koChancesMulti: koChancesMulti,
		outcomesFor: outcomesFor,
		describe: describe,
		damageSpan: damageSpan,
		HIGH_CRIT_MOVES: HIGH_CRIT_MOVES,
		ALWAYS_CRIT_MOVES: ALWAYS_CRIT_MOVES,
		STAGE_RATE: STAGE_RATE
	};
})();
