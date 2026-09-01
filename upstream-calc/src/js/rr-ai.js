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

	/**
	 * Whether the AI would consider switching at all.
	 *
	 * This is the single biggest narrowing available, and it comes from the
	 * shape of the upstream code rather than from any score: ShouldSwitch
	 * (ai_switching.c:50) is a GATE run before move selection, not an option
	 * weighed against moves. When it returns false the AI cannot switch, full
	 * stop, so every switch drops out of the plausible set.
	 *
	 * The gate is a fixed sequence of triggers. Most are not ported, but nearly
	 * all of them have a cheap precondition -- a status, a volatile, an ability,
	 * a type matchup -- and if no precondition holds, no trigger can fire. So
	 * this reports "cannot switch" only when every trigger is ruled out, and
	 * defaults to "might switch" otherwise. Wrong in the safe direction: a
	 * spurious "might" only widens the set.
	 */
	function switchGate(state, key, flags) {
		var side = state[key];
		var self = RRBattle.active(side);
		var foe = RRBattle.active(state[RRBattle.other(key)]);
		var reasons = [];

		var benched = side.team.filter(function (mon, i) {
			return i !== side.active && !mon.fainted;
		});
		if (!benched.length) return {maySwitch: false, reasons: ["nothing to switch to"]};

		// ShouldSwitch returns FALSE outright while this is set.
		if (side.switchCooldown > 0) {
			return {maySwitch: false, reasons: ["just switched in (cooldown)"]};
		}
		if (self.volatiles.trapped) {
			return {maySwitch: false, reasons: ["trapped"]};
		}

		// ShouldSwitchIfNaturalCureOrRegenerator, ShouldSwitchWhileAsleep,
		// IsTakingAnnoyingSecondaryDamage all need a status to be present.
		if (self.status) reasons.push("has a status (" + self.status + ")");
		if (self.volatiles.leechSeed) reasons.push("seeded");
		if (self.volatiles.yawn) reasons.push("yawned");
		if (self.volatiles.perish) reasons.push("perish count running");

		// ShouldSwitchToAvoidDeath is explicitly gated on smarter-than-basic AI
		// (ai_switching.c: aiFlags > AI_SCRIPT_CHECK_BAD_MOVE), so a plain route
		// trainer will stand there and die.
		if (flags[GOOD] || flags[SEMI]) {
			var incoming = worstIncomingDamage(state, key);
			if (incoming >= self.curHP) reasons.push("would be knocked out");
		}

		// ShouldSwitchWhenOffensiveStatsAreLow.
		if ((self.boosts.atk || 0) < 0 || (self.boosts.spa || 0) < 0) {
			reasons.push("offensive stats dropped");
		}

		// ShouldSwitchIfOnlyBadMovesLeft, and FindMonThatAbsorbsOpponentsMove.
		if (!hasAnyUsefulMove(state, key, flags)) reasons.push("no move does anything");
		if (foe.set.ability === "Wonder Guard") reasons.push("foe has Wonder Guard");
		if (benchAbsorbsSomething(state, key, benched)) {
			reasons.push("someone on the bench absorbs a move");
		}

		return {maySwitch: reasons.length > 0, reasons: reasons};
	}

	function worstIncomingDamage(state, key) {
		var foeKey = RRBattle.other(key);
		var worst = 0;
		RRBattle.legalActions(state, foeKey).forEach(function (action) {
			if (action.type !== "move") return;
			var rolls = RRBattle.damageRolls(state, foeKey, action.move);
			if (rolls && !rolls.immune) {
				var top = rolls.crit[rolls.crit.length - 1];
				if (top > worst) worst = top;
			}
		});
		return worst;
	}

	/**
	 * The inverse of CFRU's OnlyBadMovesLeftInMoveset (ai_util.c:4880).
	 *
	 * The first version asked only whether SOME move deals nonzero damage, and
	 * that is far too permissive. Upstream's CalcOnlyBadMovesLeftInMoveset runs
	 * AIScript_Negatives on each move with a base viability of 100 and counts a
	 * move only when it comes back at 100 or better -- that is, only when NO
	 * penalty applied. A resisted move that still chips is penalised and does
	 * not count.
	 *
	 * That distinction is what this gate turns on, and it was measured rather
	 * than inferred. Against our Lanturn (Volt Absorb), Pincurchin's two
	 * Electric moves are penalised for immunity while Scald and Hidden Power
	 * Ice are merely resisted, so the old test said "it still has moves" and
	 * switchGate returned maySwitch=FALSE. The real game switches Pincurchin
	 * out in that matchup SEVEN times across the recordings. Being unable to
	 * switch at all in the matchup where the game switches most often is a
	 * worse error than picking the wrong replacement.
	 *
	 * Also gated on AI intelligence, as upstream is: CalcOnlyBadMovesLeft
	 * returns FALSE outright when the only flag is CHECK_BAD_MOVE, so a plain
	 * route trainer never switches for this reason and will stand there
	 * swinging a resisted move.
	 */
	function hasAnyUsefulMove(state, key, flags) {
		var f = flags || {};
		if (!f[GOOD] && !f[SEMI]) return true;   // basic AI never switches for this
		var actions = RRBattle.legalActions(state, key);
		var notes = {};
		var damaging = 0;
		for (var i = 0; i < actions.length; i++) {
			if (actions[i].type !== "move") continue;
			// A penalty of any size disqualifies the move, matching the
			// viability >= 100 test upstream.
			if (scoreAction(state, key, actions[i], f, notes).score < BASE) continue;
			var data = RRBattle.moveData(actions[i].move);
			if (data && data.split === "Status") return true;   // viable status move
			var rolls = RRBattle.damageRolls(state, key, actions[i].move);
			if (rolls && !rolls.immune && rolls.noCrit[0] > 0) damaging++;
		}
		return damaging > 0;
	}

	function benchAbsorbsSomething(state, key, benched) {
		var foeKey = RRBattle.other(key);
		var types = {};
		RRBattle.legalActions(state, foeKey).forEach(function (action) {
			if (action.type !== "move") return;
			var data = RRBattle.moveData(action.move);
			if (data && data.split !== "Status") types[data.type] = true;
		});
		for (var i = 0; i < benched.length; i++) {
			var absorbs = ABSORB[benched[i].set.ability];
			if (absorbs && types[absorbs]) return true;
		}
		return false;
	}

	function typesOf(mon) {
		return RRBattle._internal.toCalcPokemon(mon).types;
	}

	// ------------------------------------------------------------ fight class
	//
	// PredictFightingStyle, ai_advanced.c:372, singles branch, transcribed.
	// The class is derived from the MOVESET (plus item), decided once per mon,
	// and it gates every status-move bonus through IncreaseStatusViability --
	// which is why the port undervalued status until now: without a class,
	// Roost and Thunder Wave scored as generic filler. With it, Vikavolt
	// (three attacks + Roost) is SWEEPER_SETUP_STATUS whose status bonus is
	// 4+boost RAW -- a justified Roost outranks Bug Buzz, exactly what the
	// live log shows 184 times.
	var CLASS = {
		NONE: 0, SWEEPER_KILL: 1, SWEEPER_SETUP_STATS: 2, SWEEPER_SETUP_STATUS: 3,
		SWEEPER_SETUP_SCREENS: 4, STALL: 5, BATON_PASS: 6, CLERIC: 7,
		SCREENS: 8, PHAZING: 9, HAZARDS: 10
	};

	function fightClass(mon) {
		var cls = CLASS.NONE;
		var attackNum = 0, statusNum = 0, reflectionNum = 0;
		var boosting = false, healing = false, leechSeed = false,
			protection = false, phazing = false, hazardNum = 0;
		var item = mon.set.item || "";
		var choicey = /^Choice |Assault Vest/.test(item);
		var moves = mon.set.moves || [];
		for (var i = 0; i < moves.length; i++) {
			var d = RRBattle.moveData(moves[i]);
			if (!d) continue;
			var k = (d.effect && d.effect.kind) || "";
			if (moves[i] === "Baton Pass") { cls = CLASS.BATON_PASS; break; }
			if (k === "forceSwitch") { phazing = true; }
			else if (k === "haze" || k === "clearBoosts") { cls = CLASS.PHAZING; break; }
			else if (k === "wish" || k === "healBell") { cls = CLASS.CLERIC; break; }
			else if (k === "trap" || moves[i] === "Mean Look") { cls = CLASS.STALL; break; }
			else if (k === "screen" || moves[i] === "Reflect" || moves[i] === "Light Screen") { reflectionNum++; }
			else if (k === "leechSeed") { leechSeed = true; }
			else if (k === "protect") { protection = true; }
			else if (k === "hazard") { hazardNum++; }
			else if (choicey) { cls = CLASS.SWEEPER_KILL; break; }
			else if (k === "heal") { healing = true; }
			if (d.split !== "Status") attackNum++;
			if (k === "boost" && d.effect.target === "self") boosting = true;
			else if (d.split === "Status") statusNum++;
		}
		if (cls !== CLASS.NONE) return cls;
		if (reflectionNum >= 2) return attackNum >= 2 ? CLASS.SWEEPER_SETUP_SCREENS : CLASS.SCREENS;
		if (hazardNum >= 1) return phazing ? CLASS.PHAZING : CLASS.HAZARDS;
		if (attackNum >= 3) {
			if (boosting) return CLASS.SWEEPER_SETUP_STATS;
			if (statusNum > 0 || phazing) return CLASS.SWEEPER_SETUP_STATUS;
			return CLASS.SWEEPER_KILL;
		}
		if (leechSeed && protection) return CLASS.STALL;
		if (attackNum >= 2 && (boosting || statusNum > 0 || phazing)) {
			if (boosting) return CLASS.SWEEPER_SETUP_STATS;
			return CLASS.SWEEPER_SETUP_STATUS;
		}
		return CLASS.STALL;   // healingMove and the default both land here
	}

	// IncreaseStatusViability, ai_advanced.c:1726. RAW viability, class-gated.
	// A kill-sweeper gets NOTHING from status moves; a status-setup sweeper
	// gets 4+boost. `can2hkoUs` feeds the SETUP_STATS case only.
	function statusViability(cls, boost, can2hkoUs) {
		switch (cls) {
		case CLASS.SWEEPER_KILL: return 0;
		case CLASS.SWEEPER_SETUP_STATS: return can2hkoUs ? 0 : 3;
		case CLASS.SWEEPER_SETUP_STATUS: return 4 + boost;
		case CLASS.STALL: return 3 + boost;
		case CLASS.BATON_PASS: return boost >= 3 ? 1 : 0;
		case CLASS.CLERIC: return 3 + boost;
		case CLASS.SCREENS: case CLASS.SWEEPER_SETUP_SCREENS: return 2 + boost;
		case CLASS.PHAZING: return 4 + boost;
		case CLASS.HAZARDS: return 3;
		default: return boost;   // classless: the plain boost, conservative
		}
	}

	// The AI's own idea of the damage it faces: CFRU's CanKnockOut/Can2HKO
	// calculate WITHOUT crits. worstIncomingDamage (crit-inclusive) fed into
	// these gates said 84 where the real AI computed ~56, so a Vikavolt at
	// 87/104 read "healing cannot save you" and the port never Roosted --
	// while the real one Roosted right there. Crit pessimism belongs to OUR
	// safety checks, never to a transcription of THEIR arithmetic.
	function maxIncomingNoCrit(state, key) {
		var foeKey = RRBattle.other(key);
		var worst = 0;
		RRBattle.legalActions(state, foeKey).forEach(function (action) {
			if (action.type !== "move") return;
			var rolls = RRBattle.damageRolls(state, foeKey, action.move);
			if (rolls && !rolls.immune) {
				// TWO CORRECTIONS, both measured against the AI's own sheet over
				// 652 gradeable Vikavolt Roost rows.
				//
				// 1. NO `* hits`. RRCritKO.hitArrays builds `noCrit` from
				//    totalFor(n) -- the calculator is handed `hits: n`, so the
				//    band is ALREADY the total across every hit. Multiplying
				//    again read Breloom's Bullet Seed (band 24..27 over three
				//    hits) as 81, which made the AI's own arithmetic say "healing
				//    cannot save you" and suppressed Roost outright. Breloom's
				//    real best against Vikavolt is Headbutt at 28..34.
				// 2. THE MIDDLE ROLL, not the top of the band. Three independent
				//    exact boundaries pin it: truth is silent at 52 and fires at
				//    53 (pinning D=52, and noCrit[8] is 52 for Rock Tomb 46..56);
				//    fires at 73 and is silent at 76 (pinning 2D=74); fires at 60
				//    and is silent at 63 (pinning 2D=62).
				//
				// The first is MECHANISM, readable in rr-critko.js:306-334. The
				// second is a MEASURED value whose attribution is unverified --
				// no CFRU source in the repo says which roll the AI uses. Worth
				// noting that the KO gate at :512 landed on the same ~93% figure
				// from the opposite direction (our damage on them rather than
				// theirs on us), which is better corroboration than either
				// measurement alone.
				var top = rolls.noCrit[Math.floor(rolls.noCrit.length / 2)];
				if (top > worst) worst = top;
			}
		});
		return worst;
	}

	// ShouldRecover, ai_advanced.c:1029, transcribed. The 50% coin on the
	// 2HKO-heal branch reads the AI's PRE-DRAWN RNG parity
	// (simulatedRNG[1] & 1); until the seed pipeline computes that draw, the
	// branch is scored TRUE and flagged in notes so callers know the move
	// may be a coin flip rather than certain.
	function shouldRecover(state, key, healAmount, notes) {
		var self = RRBattle.active(state[key]);
		var heal = Math.floor(healAmount);
		var inc = maxIncomingNoCrit(state, key);
		// Breadcrumbs for the scoreboard: the sandbox has no process/env, so
		// gate diagnostics travel in notes instead of prints.
		notes.recover = {hp: self.curHP + "/" + self.maxHP, heal: heal, inc: inc,
			faster: movesFirstStatus(state, key)};
		var koNow = inc >= self.curHP;
		var twoHKO = inc * 2 >= self.curHP;
		var healed = Math.min(self.curHP + heal, self.maxHP);
		var fasterOrItem = movesFirstStatus(state, key);
		if (fasterOrItem) {
			if (koNow && !(inc >= healed)) return true;
			if (twoHKO && heal > self.curHP) {   // literal upstream comparison
				notes.recoverCoin = true;
				return true;
			}
		} else {
			if (!koNow && twoHKO) {
				var afterHitAndHeal = Math.min(self.curHP - inc + heal, self.maxHP);
				if (!(inc >= afterHitAndHeal)) return true;
			}
		}
		return false;
	}

	// "Do I act before the foe", both sides at priority zero: a plain speed
	// comparison, which is what MoveWouldHitFirst reduces to for a status move.
	function movesFirstStatus(state, key) {
		return RRBattle.finalSpeed(state, key) > RRBattle.finalSpeed(state, RRBattle.other(key));
	}

	// GoodIdeaToLowerSpeed, ai_util.c:3368, transcribed.
	function goodIdeaToLowerSpeed(state, key) {
		var self = RRBattle.active(state[key]);
		var foe = RRBattle.active(state[RRBattle.other(key)]);
		// "Don't bother lowering stats if can kill enemy" (while slower).
		var bestOut = 0;
		RRBattle.legalActions(state, key).forEach(function (a) {
			if (a.type !== "move") return;
			var r = RRBattle.damageRolls(state, key, a.move);
			if (r && !r.immune && r.noCrit[r.noCrit.length - 1] > bestOut) {
				bestOut = r.noCrit[r.noCrit.length - 1];
			}
		});
		if (!movesFirstStatus(state, key) && bestOut >= foe.curHP) return false;
		if (RRBattle.finalSpeed(state, key) > RRBattle.finalSpeed(state, RRBattle.other(key))) return false;
		var defAbility = foe.set.ability || "";
		if (/Contrary|Clear Body|White Smoke|Full Metal Body|Clear Amulet/.test(defAbility)) return false;
		return true;
	}

	// ShouldPivot, ai_advanced.c:1468, transcribed for singles. The verdict
	// enum: DONT (score -9, and the move loses strongest-move eligibility --
	// upstream literally recalculates the strongest move ignoring it), TRY
	// (neutral: the pivot is scored as a plain damaging move), GO (the
	// class-gated pivot bonus, +3 for a kill-sweeper, +9 for everyone else).
	// Bench-quality switchFlags (WALLS_FOE, RESIST_ALL_MOVES, ...) are from
	// the unported half of ai_switching.c and are approximated as ZERO, which
	// silences some PIVOT branches -- conservative: a pivot we fail to
	// predict stays neutral, a DONT we fail to predict was already the
	// default. Hazards and Wish clauses omitted: absent from this fight.
	// The tree's own default is DONT_PIVOT -- most positions do not pivot.
	var PIVOT = {DONT: 0, TRY: 1, GO: 2};

	function theirBestDamage(state, key, excludeMove) {
		var worst = 0;
		RRBattle.legalActions(state, key).forEach(function (a) {
			if (a.type !== "move" || a.move === excludeMove) return;
			var r = RRBattle.damageRolls(state, key, a.move);
			if (r && !r.immune) {
				var top = r.noCrit[r.noCrit.length - 1] * (r.hits || 1);
				if (top > worst) worst = top;
			}
		});
		return worst;
	}

	function shouldPivot(state, key, moveName, cls) {
		var self = RRBattle.active(state[key]);
		var us = RRBattle.active(state[RRBattle.other(key)]);
		var benched = state[key].team.filter(function (m, i) {
			return i !== state[key].active && !m.fainted;
		});
		if (!benched.length) return PIVOT.TRY;
		var damager = cls === CLASS.SWEEPER_KILL || cls === CLASS.SWEEPER_SETUP_STATS
			|| cls === CLASS.SWEEPER_SETUP_STATUS || cls === CLASS.SWEEPER_SETUP_SCREENS;
		var boost = damager && ((self.boosts.atk || 0) > 0 || (self.boosts.spa || 0) > 0);
		var aiFirst = movesFirstStatus(state, key);
		var usKOsAI = maxIncomingNoCrit(state, key) >= self.curHP;
		var us2HKOsAI = maxIncomingNoCrit(state, key) * 2 >= self.curHP;
		var aiBest = theirBestDamage(state, key, null);
		var aiKOsUs = aiBest >= us.curHP;
		var ai2HKOsUs = aiBest * 2 >= us.curHP;
		var koWithoutThis = theirBestDamage(state, key, moveName) >= us.curHP;
		if (aiFirst) {
			if (koWithoutThis) return PIVOT.DONT;
			if (aiKOsUs) return PIVOT.TRY;
			if (damager && ai2HKOsUs && usKOsAI) return PIVOT.GO;
			return PIVOT.DONT;
		}
		if (usKOsAI) return PIVOT.TRY;
		if (us2HKOsAI) {
			if (aiKOsUs && !koWithoutThis) return PIVOT.TRY;
			return PIVOT.DONT;
		}
		if (aiKOsUs && !koWithoutThis && !boost) return PIVOT.TRY;
		return PIVOT.DONT;
	}

	// The DONT-verdict pivot to ignore when naming the strongest move: this
	// is upstream's RecalcStrongestMoveIgnoringMove seen from the other side.
	// Computed only when the asking move is NOT itself the pivot.
	function dontPivotMove(state, key, flags, askingMove) {
		var self = RRBattle.active(state[key]);
		var moves = self.set.moves || [];
		for (var i = 0; i < moves.length; i++) {
			if (moves[i] === askingMove) continue;
			var d = RRBattle.moveData(moves[i]);
			if (!d || !d.effect || d.effect.kind !== "selfSwitch" || d.split === "Status") continue;
			if (shouldPivot(state, key, moves[i], fightClass(self)) === PIVOT.DONT) return moves[i];
		}
		return null;
	}

	// IncreasePivotViability, ai_advanced.c:2658, singles column.
	function pivotViability(cls) {
		return cls === CLASS.SWEEPER_KILL ? 3 : 9;
	}

	// BadIdeaToParalyze, ai_util.c:2918, transcribed (frontier and doubles
	// clauses omitted: this fight is neither).
	function badIdeaToParalyze(state, key) {
		var foe = RRBattle.active(state[RRBattle.other(key)]);
		if (!RRBattle._internal.canTakeStatus(foe, "par")) return true;
		var ab = foe.set.ability || "";
		if (/Shed Skin|Quick Feet/.test(ab)) return true;
		var foeMoves = foe.set.moves || [];
		var physical = foeMoves.some(function (m) {
			var d = RRBattle.moveData(m); return d && d.split === "Physical";
		});
		if (ab === "Marvel Scale" && physical) return true;
		if (ab === "Guts" && physical) return true;
		if (foeMoves.indexOf("Facade") >= 0 || foeMoves.indexOf("Psycho Shift") >= 0
			|| foeMoves.indexOf("Rest") >= 0) return true;
		return false;
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
				// TWO DIFFERENT PENALTIES, and we were charging the bigger one
				// for both. A damaging move the target simply does not take --
				// Electric into a Ground type -- is DECREASE_VIABILITY(15) at
				// AI_STANDARD_DAMAGE in ai_negatives.c. The 20 belongs only to
				// an ABSORB ABILITY (Volt Absorb and friends), which upstream
				// also returns on immediately. Confirmed against the AI's own
				// sheet: Manectric's Charge Beam into Diggersby reads 85, which
				// is 100 minus 15, and its Volt Switch in the same position
				// reads 76, which is 100 minus 15 minus the 9 for a pivot that
				// is a bad idea -- both exact once the values are separated.
				var absorbAb = ABSORB[foe.set.ability];
				if (absorbAb && data && absorbAb === data.type) {
					bad(20, foe.set.ability + " absorbs " + data.type);
				} else {
					bad(15, "no effect on this target");
				}
				// AND THE PIVOT VERDICT STILL APPLIES. Immunity is scored by
				// the negatives pass; pivoting is scored by the positives
				// pass; they are independent, and this branch was skipping the
				// second one entirely. Manectric's Volt Switch into a Ground
				// type reads 76 on the AI's sheet -- 100 minus 15 for no
				// effect minus 9 for a pivot that is a bad idea -- and we were
				// stopping at 85.
				if (flags[GOOD] && effect.kind === "selfSwitch"
					&& shouldPivot(state, key, action.move, fightClass(self)) === PIVOT.DONT) {
					bad(9, "pivoting is a bad idea here");
				}
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
					// EFFECT_BATON_PASS pivots, ai_positives.c:1496: the
					// verdict comes first because DONT strips this move of
					// strongest-move eligibility -- upstream recalculates the
					// strongest move ignoring it, so the +3 lands on the best
					// COMMITTED move instead. Measured before this rule: our
					// Volt Switch ran +9..+12 hot against the true score
					// sheet on 86 turns while Bug Buzz ran -2..-5 cold.
					var pivotVerdict = null;
					if (flags[GOOD] && effect.kind === "selfSwitch") {
						pivotVerdict = shouldPivot(state, key, action.move, fightClass(self));
					}
					var strongestIgnoring = pivotVerdict === PIVOT.DONT ? action.move : null;
					if (pivotVerdict === PIVOT.DONT) bad(9, "pivoting is a bad idea here");
					else if (pivotVerdict === PIVOT.GO) {
						good(pivotViability(fightClass(self)), "pivots out profitably");
					}
					// Only the best-accuracy / highest-priority killing move
					// earns this, not every move that happens to kill.
					if (kills && first && accurate
						&& bestKOSet(state, key, notes, true).indexOf(action.move) >= 0) {
						good(9, "KOs and moves first (best of the killing moves)");
					}
					// The slow-KO branch is gated on the SAME best-accuracy
					// set as the fast one (checkGoingFirst FALSE upstream), so
					// again only one killing move earns it -- Pawmot's Drain
					// Punch was collecting it while the real AI gave it
					// nothing, because Mach Punch's priority owns the set.
					else if (kills
						&& bestKOSet(state, key, notes, false).indexOf(action.move) >= 0) {
						good(slowKOBonus(fightClass(self)), "KOs but is slower");
					}
					else if (pivotVerdict !== PIVOT.DONT
						&& isStrongest(state, key, action.move, dontPivotMove(state, key, flags, action.move))) {
						// Class-scaled only on the untouched-viability KO
						// branch; a plain strongest move is worth 2.
						var clsS = fightClass(self);
						good(score === BASE && kills ? strongestMoveBonus(clsS) : 2,
							"strongest move");
					}
					// EFFECT_SPEED_DOWN_HIT, ai_positives.c:838: a reliable
					// speed-dropping hit gets +3 RAW, "increase past strongest
					// move", whenever lowering speed makes sense (slower
					// attacker, no kill in hand, no Contrary/Clear Body). This
					// is why the real Vikavolt clicks Mud Shot over Bug Buzz,
					// 104 recorded misses of the old port.
					var sec = effect.kind === "secondary" && effect.secondary;
					if (flags[GOOD] && sec && sec.boosts && sec.boosts.spe < 0
						&& (data.secondaryChance || 0) >= 50
						&& goodIdeaToLowerSpeed(state, key)) {
						good(3, "speed control past strongest move");
					}
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
			// AN ABSORBED STATUS MOVE IS STILL ABSORBED. CFRU's Volt Absorb
			// branch has the status-move exclusion COMMENTED OUT, so Thunder
			// Wave into a Volt Absorb Lanturn takes the full -20 and returns
			// immediately -- the sheet reads exactly 80. Our absorb check
			// lived in the damaging branch only, so status moves walked past
			// it entirely.
			var absorbSt = ABSORB[foe.set.ability];
			if (absorbSt && data && absorbSt === data.type) {
				bad(20, foe.set.ability + " absorbs " + data.type);
				break;
			}
			// AND THE PENALTY DOES NOT SWALLOW THE BONUS. Same two-pass shape
			// as healing and immunity: the negatives pass docks a status that
			// cannot land, the positives pass still pays the class-gated
			// bonus, and both apply. Thunder Wave into a Ground type reads 96
			// on the sheet -- minus ten plus six -- and we stopped at the
			// penalty. The move's TYPE is passed now too, so canTakeStatus can
			// see that an Electric move does not reach a Ground type at all;
			// without it we thought Diggersby was paralysable.
			if (foe.status) bad(10, "target already has a status");
			else if (!RRBattle._internal.canTakeStatus(foe, effect.status, state,
				data ? data.type : undefined)) {
				bad(10, "target cannot be " + effect.status);
			}
			// EFFECT_PARALYZE, ai_positives.c:800: paralysis is worth 2 when
			// it flips the speed order (their target is faster now and will
			// not be at quarter speed) and 1 otherwise, then class-gated.
			// Bellibolt (attacks + Thunder Wave) is SWEEPER_SETUP_STATUS, so
			// the wave scores 4+2=+6 raw -- the port's second-biggest miss,
			// 153 live turns of "we said Parabolic Charge, it Thunder Waved".
			if ((flags[GOOD] || flags[SEMI]) && effect.status === "par"
				&& !badIdeaToParalyze(state, key)) {
				var defSpe = RRBattle.finalSpeed(state, RRBattle.other(key));
				var atkSpe = RRBattle.finalSpeed(state, key);
				var flips = defSpe >= atkSpe && defSpe / 2 < atkSpe;
				var boostP = (flips || foe.volatiles.confusion) ? 2 : 1;
				var clsP = fightClass(self);
				var twoP = maxIncomingNoCrit(state, key) * 2 >= self.curHP;
				var bumpP = statusViability(clsP, boostP, twoP);
				if (bumpP) good(bumpP, "paralysis is useful (class " + clsP + ")");
			}
			break;
		case "focusEnergy":
			// FOCUS ENERGY IS A SETUP MOVE and was scored as nothing at all.
			// It has its own effect kind rather than being a stat boost, so it
			// fell through every branch and any attack outranked it -- which is
			// the single largest miss in the live log: Falinks used Focus Energy
			// and the model said Headbutt, every time.
			//
			// CFRU treats raising the crit rate as viability in the same family
			// as a stat boost, so it is gated the same way: worth doing only if
			// you survive long enough to use it, and best from full health.
			if (self.volatiles && self.volatiles.focusEnergy) {
				bad(10, "already pumped up");
			} else {
				var incFE = worstIncomingDamage(state, key);
				if (incFE >= self.curHP) bad(10, "would be knocked out before it pays off");
				else if (self.curHP === self.maxHP && incFE * 3 < self.curHP) good(7, "safe to set up");
				else if (incFE * 2 < self.curHP) good(3, "room to set up");
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
			if (maxed) { bad(10, "stats already at the cap"); break; }

			// Setting up is only worth it if you survive to use it. CFRU scores
			// this through IncreaseStatViability, gated on not being about to
			// die; before this, setup moves were the single largest blind spot
			// in the model -- 175 evaluations across the game, not one of them
			// scored, so a boss holding Dragon Dance rated it exactly as
			// interesting as Growl.
			if (effect.target === "self") {
				var incoming = worstIncomingDamage(state, key);
				if (incoming >= self.curHP) {
					bad(10, "would be knocked out before it pays off");
				} else if (self.curHP === self.maxHP && incoming * 3 < self.curHP) {
					good(7, "safe to set up");
				} else if (incoming * 2 < self.curHP) {
					good(3, "room to set up");
				}
			}
			break;
		case "heal":
		case "wish":
			// THE TWO PASSES ARE INDEPENDENT. ai_negatives.c docks a healing
			// move at high HP (-10 at full, -9 from 90% up) and ai_positives.c
			// separately pays the class-gated recovery bonus if ShouldRecover
			// justifies it -- and ShouldRecover asks whether healing averts a
			// knockout, not whether there is damage to heal, so it can say yes
			// at full HP. This branch used to `break` after the penalty and
			// never reach the bonus, scoring a full-health Vikavolt's Roost at
			// 90 where the AI's own sheet reads 97: minus ten plus seven.
			if (self.curHP === self.maxHP) bad(10, "already at full HP");
			else if (self.curHP * 10 >= self.maxHP * 9) bad(9, "barely hurt");
			// EFFECT_RESTORE_HP, ai_positives.c:652: a justified recovery gets
			// the class-gated status bonus. Vikavolt is SWEEPER_SETUP_STATUS
			// (three attacks + Roost), so ShouldRecover makes Roost 4+3=+7 RAW
			// -- it outranks Bug Buzz, which the live log shows 184 times and
			// the port called wrong every one of them.
			if ((flags[GOOD] || flags[SEMI]) && effect.fraction
				&& shouldRecover(state, key, self.maxHP * effect.fraction, notes)) {
				var clsH = fightClass(self);
				var twoH = maxIncomingNoCrit(state, key) * 2 >= self.curHP;
				var bumpH = statusViability(clsH, 3, twoH);
				if (bumpH) good(bumpH, "justified recovery (class " + clsH + ")");
			}
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
		case "selfSwitch":
			// Volt Switch and U-turn are everywhere in Radical Red and the model
			// had nothing to say about 503 of the 591 times one came up. The AI
			// pivots to escape a bad matchup, so the question is whether anyone
			// on the bench does better against what is in front of it.
			// Swap the active index and put it back, rather than cloning the
			// whole state per bench member. Nothing here mutates, and cloning
			// made the benchmark three times slower for no measured gain.
			var benchFits = false;
			var wasActive = side.active;
			for (var bi = 0; bi < side.team.length; bi++) {
				if (bi === wasActive || side.team[bi].fainted) continue;
				side.active = bi;
				var takes = worstIncomingDamage(state, key);
				if (takes * 3 < side.team[bi].curHP) { benchFits = true; break; }
			}
			side.active = wasActive;
			var hurtsHere = worstIncomingDamage(state, key) * 2 >= self.curHP;
			if (benchFits && hurtsHere) good(6, "pivots out of a bad matchup");
			else if (!benchFits && hurtsHere) bad(10, "nowhere better to go");
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
		// The reference used to be whichever move happened to sit in the other
		// side's slot ZERO, so the answer depended on our own move ordering:
		// putting Roar (priority -6) first made the model believe the slower AI
		// moved first, award the "KOs and moves first" bonus instead of "KOs but
		// is slower", and drop Yawn out of the plausible set entirely. Rotating
		// our own moveset must not change what the opponent is predicted to do.
		//
		// A priority-zero move is the neutral reference: it asks "am I faster",
		// which is what this function is named for.
		var reference = null;
		for (var i = 0; i < foeActions.length; i++) {
			if (foeActions[i].type !== "move") continue;
			var data = RRBattle.moveData(foeActions[i].move);
			if (data && !data.priority) { reference = foeActions[i]; break; }
			if (!reference) reference = foeActions[i];   // fall back to any move
		}
		if (!reference) return true;
		var order = key === "me"
			? RRBattle.turnOrder(state, action, reference)
			: RRBattle.turnOrder(state, reference, action);
		return order ? order[0] === key : false;   // a speed tie is not "first"
	}

	/**
	 * MoveKnocksOutPossiblyGoesFirstWithBestAccuracy, ai_util.c -- singles
	 * subset, transcribed.
	 *
	 * The KO bonus does NOT go to every move that kills. Upstream builds a
	 * SET: the killing moves with the best accuracy, and among equal accuracy
	 * a strictly higher priority WIPES the set rather than joining it. Only
	 * members of that set are worth +9.
	 *
	 * Measured against the AI's own score sheet at live turn 1934: our
	 * Lilligant on 16 HP, every one of Pawmot's four punches kills and every
	 * one moves first, so the old port awarded +9 four times; the real AI
	 * awarded it ONCE, to Mach Punch, because its +1 priority wiped the other
	 * three out of the set. That single mistake was the largest error mass in
	 * the corrected scoreboard -- 77 rows of "+9" across Pawmot's punches and
	 * Manectric's Volt Switch.
	 *
	 * Memoised on `notes`, which lives for exactly one scoreAll pass over one
	 * unchanging position.
	 */
	function bestKOSet(state, key, notes, requireFirst) {
		var cacheKey = "_koSet" + key + (requireFirst ? "1" : "0");
		if (notes[cacheKey]) return notes[cacheKey];
		var self = RRBattle.active(state[key]);
		var foe = RRBattle.active(state[RRBattle.other(key)]);
		var bestAcc = 0, bestPriority = 0, good = [];
		(self.set.moves || []).forEach(function (mv, i) {
			var d = RRBattle.moveData(mv);
			if (!d || d.split === "Status") return;
			if (self.pp && self.pp[i] === 0) return;          // unusable
			var r;
			try { r = RRBattle.damageRolls(state, key, mv); } catch (e) { return; }
			if (!r || r.immune || !r.noCrit || !r.noCrit.length) return;
			if (r.noCrit[0] * (r.hits || 1) < foe.curHP) return;   // does not KO
			var act = {type: "move", index: i, move: mv};
			if (requireFirst && !movesFirst(state, key, act)) return;
			var acc = d.accuracy === null ? 100 : d.accuracy;
			var pri = d.priority || 0;
			if (!good.length || (acc > bestAcc && bestAcc < 100)) {
				bestAcc = acc; bestPriority = pri; good = [mv];
			} else if (acc === bestAcc || acc >= 100) {
				// A strictly higher priority replaces everything; anything
				// else joins the set -- upstream adds on the else branch even
				// when the priority is lower, and that quirk is transcribed
				// rather than tidied.
				if (pri > bestPriority) { bestAcc = acc; bestPriority = pri; good = [mv]; }
				else good.push(mv);
			}
		});
		notes[cacheKey] = good;
		return good;
	}

	/**
	 * CalcStrongestMove's selection, ai_util.c, transcribed for singles.
	 *
	 * Damage decides first. On a DAMAGE TIE upstream compares accuracy (a
	 * strictly better accuracy wins only while the incumbent is below 100),
	 * and when accuracy also ties it assigns `strongestMove = move` -- the
	 * LATER move wins. Ours kept the FIRST, which is the opposite, and on
	 * Pawmot that matters constantly: Drain Punch, Thunder Punch and Ice
	 * Punch are all 75 BP Iron Fist punches that tie against a neutral
	 * target, so the two implementations disagreed about which one carries
	 * the strongest-move bonus. Zero-power moves are skipped, as upstream
	 * skips `gBattleMoves[move].power == 0`.
	 */
	function isStrongest(state, key, moveName, excludeMove) {
		var actions = RRBattle.legalActions(state, key);
		var best = -1, bestAcc = 0, bestName = null;
		var seen = {};
		for (var i = 0; i < actions.length; i++) {
			if (actions[i].type !== "move") continue;
			if (seen[actions[i].move]) continue;   // pivots repeat per bench target
			seen[actions[i].move] = true;
			if (actions[i].move === excludeMove) continue;
			var d = RRBattle.moveData(actions[i].move);
			if (!d || !d.power) continue;          // status / zero-power
			var rolls = RRBattle.damageRolls(state, key, actions[i].move);
			var value = rolls && !rolls.immune ? rolls.noCrit[0] : 0;
			var acc = (d.accuracy === null || d.accuracy === undefined) ? 100 : d.accuracy;
			if (value > best) { best = value; bestAcc = acc; bestName = actions[i].move; }
			else if (value === best && best >= 0) {
				if (acc > bestAcc && bestAcc < 100) { bestAcc = acc; bestName = actions[i].move; }
				else if (acc === bestAcc || acc >= 100) bestName = actions[i].move;
			}
		}
		return bestName === moveName;
	}

	/**
	 * IncreaseViabilityForSlowKOMove, ai_advanced.c:2764. EIGHT for an
	 * ordinary attacker, not the three this port used to award. The
	 * BetterToKOLastFoeMon variants (which raise some classes to 9) are not
	 * ported, so the lower value of each pair is used -- understating a bonus
	 * only widens the plausible set, which is the safe direction.
	 */
	function slowKOBonus(cls) {
		switch (cls) {
		case CLASS.SWEEPER_SETUP_STATS: return 6;
		case CLASS.BATON_PASS: return 3;
		case CLASS.CLERIC: return 6;
		case CLASS.SCREENS: case CLASS.SWEEPER_SETUP_SCREENS: return 6;
		default: return 8;   // SWEEPER_KILL, SETUP_STATUS, STALL, PHAZING
		}
	}

	/**
	 * The strongest-move bonus, ai_positives.c STRONGEST_MOVE_CHECK. It is
	 * TWO for an ordinary attacker, not the three this port used to award;
	 * the class-scaled values apply only on the branch where viability is
	 * still untouched and the move would KO.
	 */
	function strongestMoveBonus(cls) {
		switch (cls) {
		case CLASS.CLERIC: return 5;
		case CLASS.SCREENS: case CLASS.SWEEPER_SETUP_SCREENS: return 6;
		case CLASS.BATON_PASS: return 6;
		case CLASS.PHAZING: return 8;
		case CLASS.STALL: return 8;
		case CLASS.HAZARDS: return 4;
		default: return 2;
		}
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
			var gate = switchGate(state, key, flags);
			if (!gate.maySwitch) notes.switchGate = gate.reasons;
			var scored = scoreAll(state, key, flags, notes).filter(function (entry) {
				// ShouldSwitch said no, so a switch is not on the table at all.
				return gate.maySwitch || entry.action.type !== "switch";
			});
			var best = -Infinity;
			scored.forEach(function (entry) { if (entry.score > best) best = entry.score; });
			scored.forEach(function (entry) {
				if (entry.score < best - margin) return;
				// U-turn, Volt Switch, Flip Turn, Baton Pass, Parting Shot and
				// Teleport come back from legalActions as one action PER BENCH
				// TARGET, and who comes in is part of the choice rather than a
				// detail. Keying on the move name alone kept the first and threw
				// the rest away, so a plan proved safe against U-turn into
				// Blastoise was asserted safe against U-turn into Gengar -- a
				// branch that was never examined. Narrowing the opponent's set
				// is the one direction this function must never err in.
				var id = entry.action.type === "switch"
					? "s" + entry.action.index
					: entry.action.move + (entry.action.switchTo === undefined
						? "" : ">" + entry.action.switchTo);
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

	/**
	 * What the AI will ACTUALLY do: the argmax, plus exact ties.
	 *
	 * This is the distribution, as opposed to RRAI.plausible's margin set,
	 * which is a confession about what WE do not know. CFRU takes the argmax
	 * and splits uniformly only among EXACT ties (ai_master.c:360). A move
	 * three points below the best is not something the AI does rarely; it is
	 * something the AI does never.
	 *
	 * The third pass argued for this on principle and the scoreboard has since
	 * priced it. Over 102 recorded decisions:
	 *
	 *     argmax + ties   77/102 (75.5%)   mean width 1.09
	 *     margin set     102/102 (100%)    mean width 3.52
	 *
	 * So branching on the margin costs ~2x per ply to buy coverage of OUR
	 * error, and it buys most where the AI is most deterministic. Branch on
	 * this instead, and spend the margin ONCE as a robustness check on the
	 * action finally chosen -- which is what the 24.5% gap actually justifies,
	 * rather than deleting the margin outright as the plan originally said.
	 *
	 * A gym leader IS a boss, so boss flags are the honest default here: the
	 * fourth pass established that per-trainer flags are a data gap that is
	 * CLOSABLE per trainer class rather than irreducible ignorance.
	 */
	function trueTies(state, key, options) {
		var opts = options || {};
		var flags = opts.flags || {checkBadMove: true, checkGoodMove: true};
		var gate = switchGate(state, key, flags);
		var scored = scoreAll(state, key, flags, {}).filter(function (entry) {
			return gate.maySwitch || entry.action.type !== "switch";
		});
		if (!scored.length) return {actions: [], scored: []};
		var best = -Infinity;
		scored.forEach(function (e) { if (e.score > best) best = e.score; });
		var top = scored.filter(function (e) { return e.score === best; });
		return {
			actions: top.map(function (e) { return e.action; }),
			scored: top,
			best: best
		};
	}

	return {
		scoreAll: scoreAll,
		trueTies: trueTies,
		switchGate: switchGate,
		scoreAction: scoreAction,
		plausible: plausible,
		BASE: BASE,
		BASIC: BASIC, SEMI: SEMI, GOOD: GOOD, BASIC_KILL: BASIC_KILL
	};
})();
