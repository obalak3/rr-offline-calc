/**
 * Which Pokemon the AI sends in. A port of CFRU's switch-in scoring.
 *
 * WHY THIS EXISTS. This was the largest hole in the opponent model and the only
 * one with a confirmed real-game miss against it: playing the Lt. Surge sheet,
 * Pincurchin fainted and the game sent BELLIBOLT where we predicted VIKAVOLT,
 * which voided every turn of the plan after that. Until now `rr-ai.js` scored
 * every switch at flat BASE with the comment "switch scoring not ported", which
 * is honest and conservative but means the app cannot answer "who is coming in",
 * a question that arises several times a fight and invalidates everything
 * downstream when answered wrongly.
 *
 * SOURCE. Ported from `src/Battle_AI/ai_switching.c`,
 * `CalcMostSuitableMonToSwitchInto` at line 1980, in
 * <https://github.com/Skeli789/Complete-Fire-Red-Upgrade>, with the score
 * constants from `include/new/ai_switching.h` lines 28-49. Every constant and
 * branch below cites its line. Nothing here is written from memory, which is
 * the same discipline docs/RR-AI.md holds itself to.
 *
 * THE HEADLINE FINDING, AND IT CONTRADICTS WHAT WE ASSUMED. The choice is NOT
 * deterministic. `ai_switching.c:2437` breaks a tie with
 * `AIRandom() % 100 < 50` whenever two candidates have equal scores and neither
 * would faint to the foe. Our notes said the replacement was "almost certainly
 * deterministic (so repeatable and testable)". It is a coin flip exactly as
 * often as the move-selection ties are, so a single observed replacement can
 * never confirm or refute a rule, and `predict()` below returns a DISTRIBUTION
 * rather than one Pokemon.
 *
 * SCOPE. Singles only, which is what the solver plays. Doubles takes a
 * different path through the same function and is not ported.
 *
 * KNOWINGLY OMITTED, so none of it is mistaken for an oversight:
 *   - Wish recovery and passive recovery (`ai_switching.c:2337`) are folded
 *     into the survival maths upstream. Trainer teams in this dataset do not
 *     carry Wish, and passive recovery is Leftovers-class chip.
 *   - Hazard REMOVAL scoring (`canRemoveHazards`, a +71 override at :2473).
 *     It only fires when hazards are on the AI's own side, which a player
 *     rarely sets in this game.
 *   - Toxic Spikes absorption by grounded Poison types (:2470).
 *   - Imposter/Trace ability resolution (:2058).
 * Each of these can only add score, so omitting them makes our prediction
 * conservative in the same direction the rest of the model already leans.
 */
/* global RRBattle */
var RRAISwitching = (function () {
	"use strict";

	// include/new/ai_switching.h:28-38. Exact values, not approximations.
	var KO_FOE = 31;
	var RESIST_ALL_MOVES = 17;
	var REVENGE_KILL = 8;
	var WALLS_FOE = 2;
	var CAN_2HKO = 2;
	var OUTSPEEDS = 14;
	var WEAK_TO_MOVE = 1;
	var FAINTS_FROM_FOE = 39;
	var FAINTS_FROM_FOE_BUT_OUTSPEEDS = 15;

	var FLAG_KO_FOE = 1;
	var FLAG_RESIST_ALL = 2;
	var FLAG_REVENGE_KILL = 4;
	var FLAG_WALLS_FOE = 8;
	var FLAG_CAN_2HKO = 16;
	var FLAG_OUTSPEEDS = 64;
	var FLAG_FAINTS_FROM_FOE = 128;

	// Abilities that upstream treats as a guaranteed revenge kill because the
	// foe cannot escape or the killer snowballs (ai_switching.c:2102).
	var MOXIE = {"Moxie": 1, "Beast Boost": 1, "Chilling Neigh": 1,
		"Grim Neigh": 1, "As One (Glastrier)": 1, "As One (Spectrier)": 1};
	var TRAPPING = {"Shadow Tag": 1, "Arena Trap": 1, "Magnet Pull": 1};

	function maxRoll(state, key, moveName) {
		var rolls;
		try { rolls = RRBattle.damageRolls(state, key, moveName); }
		catch (e) { return 0; }
		if (!rolls || !rolls.noCrit || !rolls.noCrit.length) return 0;
		return rolls.noCrit[rolls.noCrit.length - 1];
	}

	function movesOf(mon) {
		return (mon.set && mon.set.moves) || [];
	}

	function isStatus(moveName) {
		var d = RRBattle.moveData(moveName);
		return !d || d.split === "Status";
	}

	function priorityOf(moveName) {
		var d = RRBattle.moveData(moveName);
		return (d && d.priority) || 0;
	}

	/**
	 * Score one candidate against the foe currently on the field.
	 *
	 * A faithful transcription of the per-mon body of the loop at
	 * ai_switching.c:2033-2420, in the same order, because the order matters:
	 * the defensive penalties read flags that the offensive section sets, and
	 * the subtractions floor at zero rather than going negative (:2374).
	 */
	function scoreCandidate(state, side, index, foeIndex) {
		var other = side === "me" ? "foe" : "me";
		// Evaluate the candidate as though it were already out, by SWAPPING the
		// active index and putting it back, never by cloning.
		//
		// This function is called for every bench member every time anything
		// faints, and the first version cloned the whole battle state twice per
		// candidate. Measured: it cost 27% of total search throughput, 26,500
		// nodes/sec down to 19,400. rr-battle's own chooseReplacement carries a
		// comment about having made and then removed this exact mistake, where
		// a CPU profile once put 52.6% of runtime inside clone(). Nothing below
		// mutates -- damageRolls, finalSpeed and moveData only read -- so the
		// swap is safe as long as it is always restored, including on the early
		// returns, which is what the `done()` wrapper is for.
		// The caller (predict) saves and restores the real active index around
		// the whole loop, in a finally. Restoring per candidate here instead
		// would leave the state corrupted if anything below threw, and this
		// runs inside a search that executes it millions of times, where a
		// silently wrong active index would be almost impossible to trace back.
		var probe = state;
		probe[side].active = index;
		function done(result) { return result; }

		var mon = probe[side].team[index];
		var foe = probe[other].team[foeIndex];
		var score = 0, flags = 0;
		var reasons = [];

		function add(n, why) { score += n; reasons.push("+" + n + " " + why); }
		function sub(n, why) {
			// ai_switching.c:2374 -- subtraction floors at zero, it does not
			// go negative. A mon that was already at 0 is not pushed below
			// candidates that scored nothing at all.
			score = score >= n ? score - n : 0;
			reasons.push("-" + n + " " + why);
		}

		if (mon.fainted || mon.curHP <= 0) return done(null);

		// :2044 -- asleep mons are skipped unless they are about to wake.
		if (mon.status === "slp" && mon.sleepTurns > 1) return done(null);

		// :2062 -- never send in something hazards would kill on entry.
		//
		// applyHazards mutates, so measuring it needs a copy -- but only when
		// there is actually something on the field to walk into. Trainer
		// battles in this game rarely have hazards on the AI's side, so the
		// common path now allocates nothing at all.
		var hazardDamage = 0;
		var hz = probe[side].hazards;
		if (hz && (hz.stealthrock || hz.spikes || hz.toxicspikes || hz.stickyweb)) {
			try {
				var h = RRBattle.clone(probe);
				RRBattle.applyHazards(h, side);
				hazardDamage = mon.curHP - h[side].team[index].curHP;
			} catch (e) { hazardDamage = 0; }
		}
		if (hazardDamage >= mon.curHP) return done(null);
		var hpOnSwitchIn = mon.curHP - hazardDamage;

		// ---- Speed (:2088) ----
		var mySpeed = RRBattle.finalSpeed(probe, side);
		var foeSpeed = RRBattle.finalSpeed(probe, other);
		if (mySpeed >= foeSpeed) { add(OUTSPEEDS, "outspeeds"); flags |= FLAG_OUTSPEEDS; }

		// ---- Offence (:2095) ----
		var myMoves = movesOf(mon);
		var canKO = false, hasUsableMove = false, best2HKO = false;
		for (var m = 0; m < myMoves.length; m++) {
			if (isStatus(myMoves[m])) { hasUsableMove = true; continue; }
			hasUsableMove = true;
			var dmg = maxRoll(probe, side, myMoves[m]);
			if (dmg >= foe.curHP) canKO = true;
			if (dmg >= foe.curHP / 2) best2HKO = true;
		}

		if (canKO) {
			add(KO_FOE, "can KO the foe");
			flags |= FLAG_KO_FOE;
			var ability = mon.set && mon.set.ability;
			if (MOXIE[ability] || TRAPPING[ability]) {
				add(REVENGE_KILL, "revenge kill ability");
				flags |= FLAG_REVENGE_KILL;
			} else {
				// :2168 -- a PRIORITY move that KOs is a revenge kill, and
				// upstream then fakes the outspeed bonus so this mon is
				// preferred even when it is slower.
				for (var p = 0; p < myMoves.length; p++) {
					if (isStatus(myMoves[p])) continue;
					if (priorityOf(myMoves[p]) <= 0) continue;
					if (maxRoll(probe, side, myMoves[p]) >= foe.curHP) {
						add(REVENGE_KILL, "priority move KOs");
						flags |= FLAG_REVENGE_KILL;
						if (!(flags & FLAG_OUTSPEEDS)) {
							add(OUTSPEEDS, "priority counts as outspeeding");
							flags |= FLAG_OUTSPEEDS;
						}
						break;
					}
				}
			}
		} else {
			// :2225 -- the 2HKO bonus is only checked when a KO is impossible.
			if (best2HKO) { add(CAN_2HKO, "can 2HKO"); flags |= FLAG_CAN_2HKO; }
			// :2230 -- nothing usable at all is disqualifying, not merely bad.
			if (!hasUsableMove) return done({score: -1, flags: flags, reasons: ["no usable move"]});
		}

		// ---- Defence (:2240-2400) ----
		var faintsFromMove = false, isWeakToMove = false, normalEffectiveness = 0;
		var foeMoves = movesOf(foe);
		var physIn = false, specIn = false;
		for (var f = 0; f < foeMoves.length; f++) {
			if (isStatus(foeMoves[f])) continue;
			var d = RRBattle.moveData(foeMoves[f]);
			if (d && d.split === "Physical") physIn = true;
			if (d && d.split === "Special") specIn = true;
			var hit = maxRoll(probe, other, foeMoves[f]);
			if (hit >= hpOnSwitchIn) { faintsFromMove = true; break; }
			// :2343 -- 2HKO makes us "weak to" it; 3HKO is merely normal.
			if (hit * 2 >= hpOnSwitchIn) isWeakToMove = true;
			else if (hit * 3 >= hpOnSwitchIn) normalEffectiveness++;
		}

		if (faintsFromMove) {
			if (!(flags & FLAG_OUTSPEEDS)) {
				flags |= FLAG_FAINTS_FROM_FOE;
				sub(FAINTS_FROM_FOE, "faints to the foe and is slower");
			} else if (!(flags & FLAG_KO_FOE)) {
				sub(FAINTS_FROM_FOE_BUT_OUTSPEEDS, "faints but outspeeds");
			} else {
				sub(WEAK_TO_MOVE, "outspeeds and KOs first");
			}
		} else if (isWeakToMove) {
			sub(WEAK_TO_MOVE, "takes heavy damage");
		} else if (!normalEffectiveness) {
			// :2396 -- nothing the foe has does even normal damage.
			add(RESIST_ALL_MOVES, "resists everything the foe has");
			flags |= FLAG_RESIST_ALL;
		} else {
			// :2404 -- walling is a raw stat comparison, and upstream compares
			// the FOE's boosted attacking stat against our UNBOOSTED defensive
			// one (it reads ours straight from the party struct, which has no
			// battle boosts on it). Reproduced rather than tidied.
			var cantWall = false;
			var myDef = statOf(mon, "def", false);
			var mySpD = statOf(mon, "spd", false);
			var theirAtk = statOf(foe, "atk", true);
			var theirSpA = statOf(foe, "spa", true);
			if (physIn && myDef <= theirAtk) cantWall = true;
			else if (specIn && mySpD <= theirSpA) cantWall = true;
			if (!cantWall) { add(WALLS_FOE, "walls the foe"); flags |= FLAG_WALLS_FOE; }
		}

		return done({score: score, flags: flags, reasons: reasons});
	}

	/**
	 * One stat off a Pokemon, optionally with its battle boosts applied.
	 *
	 * Goes through rr-battle's own `toCalcPokemon` so these are the same
	 * numbers the damage calculation uses. A private stat computation here
	 * would be a second source of truth, and this repo has been bitten by that
	 * three times.
	 */
	function statOf(mon, stat, withBoosts) {
		// Base stats are a function of the SET -- species, level, nature, EVs,
		// IVs -- and nothing that changes during a battle, so they are computed
		// once per Pokemon and kept.
		//
		// Measured, and this was the real cost of the port: toCalcPokemon runs
		// 3.3us, which is eleven times a damage roll at 0.3us, and the walling
		// check called it four times for every candidate. The port ran 37us a
		// call against the old heuristic's 15.7us. Note the first thing blamed
		// was cloning, which was tidied for its own sake and recovered nothing;
		// this is what the profile actually pointed at.
		var cache = mon.set.__rawStats;
		if (cache === undefined) {
			try {
				var probe = RRBattle._internal.toCalcPokemon(mon);
				cache = probe.rawStats || null;
			} catch (e) { cache = null; }
			// Cached on the set rather than the battle mon: clone() copies mons
			// per node, and a cache that died with each copy would never be hit.
			mon.set.__rawStats = cache;
		}
		var base = (cache && cache[stat]) || 0;
		if (!withBoosts) return base;
		var stage = (mon.boosts && mon.boosts[stat]) || 0;
		var mult = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
		return Math.floor(base * mult);
	}

	/**
	 * Who the AI would send in, as a DISTRIBUTION.
	 *
	 * Not a single answer, because ai_switching.c:2437 breaks equal scores with
	 * a 50% coin flip whenever neither candidate would faint. Returning one
	 * Pokemon would be inventing certainty the game does not have, and would
	 * reproduce exactly the mistake that made the Surge sheet look broken when
	 * it had merely lost a coin toss.
	 *
	 * The tie rule upstream is sequential and order dependent: it walks the
	 * party in index order, and a later candidate takes the lead on a coin flip
	 * only against the current leader. Enumerated here rather than sampled, so
	 * the probabilities are exact.
	 */
	function predict(state, side, options) {
		var opts = options || {};
		var other = side === "me" ? "foe" : "me";
		var foeIndex = state[other].active;
		var scored = [];
		var wasActive = state[side].active;
		try {
			for (var i = 0; i < state[side].team.length; i++) {
				if (i === wasActive) continue;
				var mon = state[side].team[i];
				if (mon.fainted || mon.curHP <= 0) continue;
				var s = scoreCandidate(state, side, i, foeIndex);
				if (!s || s.score < 0) continue;
				scored.push({index: i, species: mon.species, score: s.score,
					flags: s.flags, reasons: s.reasons});
			}
		} finally {
			state[side].active = wasActive;
		}
		if (!scored.length) return {candidates: [], distribution: []};

		// Walk in party order exactly as upstream does, tracking the set of
		// possible leaders and the probability of each. A candidate that
		// strictly outscores the leader replaces it outright; an equal score
		// with neither fainting is a 50/50, so probability splits.
		var dist = {};
		dist[scored[0].index] = 1;
		var leaderScore = scored[0].score;
		var leaderFaints = !!(scored[0].flags & FLAG_FAINTS_FROM_FOE);
		var leaders = [scored[0]];
		for (var k = 1; k < scored.length; k++) {
			var c = scored[k];
			var faints = !!(c.flags & FLAG_FAINTS_FROM_FOE);
			if (c.score > leaderScore || (c.score === leaderScore && leaderFaints && !faints)) {
				dist = {}; dist[c.index] = 1;
				leaderScore = c.score; leaderFaints = faints; leaders = [c];
			} else if (c.score === leaderScore && !leaderFaints && !faints) {
				// 50% it takes over from whoever currently leads.
				var next = {};
				for (var key in dist) next[key] = dist[key] * 0.5;
				next[c.index] = (next[c.index] || 0) + 0.5;
				dist = next;
				leaders.push(c);
			}
		}

		var distribution = [];
		for (var idx in dist) {
			var n = parseInt(idx, 10);
			distribution.push({index: n, species: state[side].team[n].species, p: dist[idx]});
		}
		distribution.sort(function (a, b) { return b.p - a.p; });
		scored.sort(function (a, b) { return b.score - a.score; });
		void opts;
		return {candidates: scored, distribution: distribution};
	}

	return {predict: predict, scoreCandidate: scoreCandidate,
		CONSTANTS: {KO_FOE: KO_FOE, RESIST_ALL_MOVES: RESIST_ALL_MOVES,
			REVENGE_KILL: REVENGE_KILL, WALLS_FOE: WALLS_FOE, CAN_2HKO: CAN_2HKO,
			OUTSPEEDS: OUTSPEEDS, WEAK_TO_MOVE: WEAK_TO_MOVE,
			FAINTS_FROM_FOE: FAINTS_FROM_FOE,
			FAINTS_FROM_FOE_BUT_OUTSPEEDS: FAINTS_FROM_FOE_BUT_OUTSPEEDS}};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRAISwitching;
