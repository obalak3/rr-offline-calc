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
	 * The sequence of per-hit outcome distributions one shot contributes to a
	 * turn. A shot that carries `perHit` (see hitArrays) gets one distribution
	 * per hit, which is what makes an escalating move like Triple Axel come out
	 * right; anything else repeats its single distribution `hits` times.
	 */
	function stepsFor(shot) {
		var steps = [];
		var i;
		if (shot.perHit && shot.perHit.length) {
			for (i = 0; i < shot.perHit.length; i++) {
				steps.push(outcomesFor(shot.perHit[i].noCrit,
					shot.perHit[i].crit, shot.critChance));
			}
			return steps;
		}
		var one = outcomesFor(shot.noCrit, shot.crit, shot.critChance);
		for (i = 0; i < (shot.hits || 1); i++) steps.push(one);
		return steps;
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
			perShot.push(stepsFor(shots[s]));
		}

		var alive = new Float64Array(hp);
		alive[0] = 1;
		var ko = 0;
		var results = [];

		for (var turn = 0; turn < maxTurns; turn++) {
			for (var i = 0; i < perShot.length; i++) {
				for (var hit = 0; hit < perShot[i].length; hit++) {
					var outcomes = perShot[i][hit];
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
	 * The damage range a move actually rolls, and separately the crit ceiling.
	 *
	 * This used to run from the non-crit low roll to the crit high roll, which
	 * is a range no move ever produces: "Extreme Speed 88.1 - 156.3%" is a
	 * 1.77x spread where a damage roll spans 1.17x. Folding two different crit
	 * states into one figure made every number on the page harder to read, and
	 * for information the crit lines already give properly.
	 *
	 * So the range is one crit state throughout -- the ordinary one, or the
	 * crit one for a move that always crits, since that move can never roll a
	 * non-crit minimum -- and the crit ceiling is reported alongside it rather
	 * than inside it.
	 *
	 * Callers pass whole-turn arrays and hits = 1: the calculator already sums
	 * a multi-hit move's hits for us, and scaling that again is exactly the bug
	 * hitArrays exists to prevent.
	 */
	function damageSpan(plain, critical, c, hits) {
		var base = (c >= 1) ? critical : plain;
		var ceiling = (c > 0) ? critical : plain;
		return {
			min: base[0] * hits,
			max: base[base.length - 1] * hits,
			critMax: ceiling[ceiling.length - 1] * hits
		};
	}

	/**
	 * Damage arrays for a move: the whole turn's total, and one array per hit.
	 *
	 * Multi-hit moves crit per hit, so the KO probability needs the damage of a
	 * SINGLE hit -- but the calculator only ever reports the turn's total, and
	 * it will not hand back one hit on request. `new calc.Move(gen, "Dual
	 * Wingbeat", {hits: 1})` is quietly ignored: when a move's hit count is
	 * fixed in the data and it is not multiaccuracy, the constructor pins hits
	 * to that number, and calculate() clones the move, so even assigning .hits
	 * afterwards is undone by the clone. This module used to assume it had a
	 * single hit and multiply by the hit count, which counted every hit twice:
	 * Crobat's Dual Wingbeat read 77.6 - 94.1% where the truth is 38.8 - 47.1%.
	 * The opposite error hit Triple Axel, whose hits are honoured but are not
	 * equal (20 / 40 / 60 base power), so three copies of the first hit came out
	 * well under the real damage.
	 *
	 * Both are fixed by never scaling anything by hand. The turn total comes
	 * straight from the calculator, so the printed range is exactly the range
	 * the calculator gives. The per-hit split is taken by whichever route the
	 * Move constructor allows:
	 *
	 *  - it honours `hits` (variable-count moves, Triple Kick, Triple Axel):
	 *    ask for 1, 2, ... n hits and difference successive totals, which is
	 *    exact even when the hits differ from each other;
	 *  - it refuses (fixed-count moves such as Dual Wingbeat): every hit of
	 *    those is identical, so divide the total by the hit count.
	 *
	 * If neither route holds up -- an uneven division, or a difference that
	 * comes out negative because some ability changed the calculation between
	 * the two calls -- the turn is left as one lump rather than split on a
	 * guess. The total is still right; only the crit modelling degrades, from
	 * per hit to per turn.
	 *
	 * Returns null when the move does nothing at all.
	 */
	function hitArrays(gen, attacker, defender, move, field) {
		var n = move.hits || 1;

		function totalFor(hits, isCrit) {
			var m = new calc.Move(gen, move.name, {
				hits: hits,
				isCrit: isCrit || undefined,
				useMax: move.useMax,
				isStellarFirstUse: move.isStellarFirstUse
			});
			if (m.hits !== hits) return null;
			return rolls(calc.calculate(gen, attacker, defender, m, field).damage);
		}

		var plain, critical;
		try {
			plain = totalFor(n, false);
			critical = totalFor(n, true);
		} catch (e) {
			return null;
		}
		if (!plain || !critical) return null;
		if (Math.max.apply(null, plain.concat(critical)) <= 0) return null;

		var lump = {
			noCrit: plain,
			crit: critical,
			hits: n,
			perHit: [{noCrit: plain, crit: critical}]
		};
		if (n === 1) return lump;

		var split = splitByDifference(totalFor, plain, critical, n);
		if (!split) split = splitByDivision(plain, critical, n);
		if (!split) return lump;
		return {noCrit: plain, crit: critical, hits: n, perHit: split};
	}

	/**
	 * Per-hit arrays from successive cumulative totals, for a move whose hit
	 * count the calculator lets us choose. Null if it does not, or if a hit
	 * comes out negative (which would mean the two calls were not comparable).
	 */
	function splitByDifference(totalFor, plain, critical, n) {
		var perHit = [];
		var prevPlain = null, prevCrit = null;
		for (var k = 1; k <= n; k++) {
			var cumPlain = k === n ? plain : totalFor(k, false);
			var cumCrit = k === n ? critical : totalFor(k, true);
			if (!cumPlain || !cumCrit) return null;
			var hitPlain = [], hitCrit = [];
			for (var i = 0; i < cumPlain.length; i++) {
				var a = prevPlain ? cumPlain[i] - prevPlain[i] : cumPlain[i];
				var b = prevCrit ? cumCrit[i] - prevCrit[i] : cumCrit[i];
				if (a < 0 || b < 0) return null;
				hitPlain.push(a);
				hitCrit.push(b);
			}
			perHit.push({noCrit: hitPlain, crit: hitCrit});
			prevPlain = cumPlain;
			prevCrit = cumCrit;
		}
		return perHit;
	}

	/**
	 * Per-hit arrays for a move whose hits are all identical: the total divides
	 * evenly by the hit count. Null if it does not divide, since that would
	 * mean the hits were not identical after all.
	 */
	function splitByDivision(plain, critical, n) {
		var one = [], oneCrit = [];
		for (var i = 0; i < plain.length; i++) {
			if (plain[i] % n !== 0 || critical[i] % n !== 0) return null;
			one.push(plain[i] / n);
			oneCrit.push(critical[i] / n);
		}
		var perHit = [];
		for (var h = 0; h < n; h++) {
			perHit.push({noCrit: one, crit: oneCrit});
		}
		return perHit;
	}

	/**
	 * Full crit-aware analysis for one attacker/defender/move.
	 *
	 * Returns null when the move deals no damage.
	 */
	function analyse(gen, attacker, defender, move, field, opts) {
		opts = opts || {};
		var bonus = opts.critStageBonus || 0;

		var arrays = hitArrays(gen, attacker, defender, move, field);
		if (!arrays) return null;
		var hits = arrays.hits;

		var c = critChance(attacker, defender, move, bonus);
		var hp = defender.curHP();
		var shot = {
			noCrit: arrays.noCrit, crit: arrays.crit,
			critChance: c, hits: hits, perHit: arrays.perHit
		};
		var chances = koChancesMulti([shot], hp, 6);
		var without = koChancesMulti(
			[{noCrit: arrays.noCrit, crit: arrays.crit, critChance: 0,
				hits: hits, perHit: arrays.perHit}], hp, 6);

		// The range is the calculator's own turn total, never a hand-scaled
		// single hit, so it is exactly what the stock calculator would print.
		var span = damageSpan(arrays.noCrit, arrays.crit, c, 1);
		return {
			critChance: c,
			critStage: critStage(attacker, move, bonus),
			chances: chances,
			chancesWithoutCrits: without,
			text: describe(chances, hits > 1 ? "approx. " : ""),
			textWithoutCrits: describe(without, hits > 1 ? "approx. " : ""),
			minTurnDamage: span.min,
			maxTurnDamage: span.max,
			critMaxDamage: span.critMax,
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
		var arrays = hitArrays(gen, attacker, defender, move, field);
		if (!arrays) return null;
		var rate = critChance(attacker, defender, move, bonus);
		var span = damageSpan(arrays.noCrit, arrays.crit, rate, 1);
		return {
			noCrit: arrays.noCrit,
			crit: arrays.crit,
			perHit: arrays.perHit,
			critChance: rate,
			hits: arrays.hits,
			attacker: attacker.name,
			move: move.name,
			min: span.min,
			max: span.max,
			critMax: span.critMax
		};
	}

	return {
		analyse: analyse,
		shotFor: shotFor,
		hitArrays: hitArrays,
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
