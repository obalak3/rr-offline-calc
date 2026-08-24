/**
 * Who beats who, one on one.
 *
 * WHY THIS EXISTS. The exact search is the right engine -- it optimises the
 * actual Nuzlocke objective instead of a proxy for it -- and its one real
 * problem is that on the hard fights it cannot FIND a line before the budget
 * runs out. That is a search-order problem, not a judgement problem, and the
 * thing it is missing is the first thing a human works out before a gym: which
 * of mine handles which of theirs. A player does not discover that Lanturn
 * answers the Volt Switchers by trying eleven thousand move sequences. They
 * check the six pairings and then plan around the answer.
 *
 * So this precomputes exactly that. For each (mine, theirs) pair it solves the
 * little 1v1 -- can mine win it without fainting, from full HP, and how much HP
 * does it have left afterwards. Six of yours against up to six of theirs is at
 * most thirty-six sub-battles with no switching in them at all, which is
 * negligible next to the search it informs.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT FOR. Two uses, and they carry very
 * different soundness burdens:
 *
 *   ORDERING.  Ranking switches by the matchup they create cannot change which
 *              lines exist, only how fast one is found. Always safe.
 *   PRUNING.   Skipping branches whose remaining pairings look hopeless is NOT
 *              sound in general -- a foe that no single Pokemon beats one on one
 *              can still be worn down by several taking turns at it, and the
 *              search would be entitled to find that. So a prune built on this
 *              table belongs only in a hunt pass that is allowed to miss lines,
 *              never in the exhaustive pass that is entitled to say a fight
 *              cannot be won.
 *
 * The 1v1s are solved by RRExact.cleanWin, not by a private copy of it, so this
 * cannot drift away from the engine it advises. That does mean the table has to
 * be built BEFORE a top-level search starts, since cleanWin resets its own
 * caches on entry and a nested call would wipe the caller's. Building it is the
 * first thing cleanWin does, and nothing inside the walk ever builds one.
 */
var RRMatchup = (function () {
	"use strict";

	/**
	 * A 1v1 position, taken from the real one so the field comes with it.
	 *
	 * Built by cloning rather than by createState because the things that decide
	 * these fights live outside the two Pokemon: Lt. Surge's permanent Electric
	 * Terrain is the reason both Sleep Powders in the party are dead weight
	 * against everything of his that stands on the ground. A fresh state would
	 * have quietly dropped it and the table would have promised sleep wins that
	 * do not exist.
	 *
	 * Both sides start clean -- full HP, no boosts, no status -- because this is
	 * a prior about pairings, not a snapshot of the fight in progress. Entry
	 * abilities are then applied, so an Intimidate body really does arrive with
	 * the opponent's Attack already lowered.
	 */
	function onePosition(state, mine, theirs) {
		var s = RRBattle.clone(state);
		s.me.team = [s.me.team[mine]];
		s.foe.team = [s.foe.team[theirs]];
		s.me.active = 0;
		s.foe.active = 0;
		reset(s.me.team[0]);
		reset(s.foe.team[0]);
		s.me.hazards = {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0};
		s.foe.hazards = {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0};
		s.me.switchCooldown = 0;
		s.foe.switchCooldown = 0;
		s.turn = 1;
		RRBattle.applyEntryAbility(s, "foe");
		RRBattle.applyEntryAbility(s, "me");
		return s;
	}

	function reset(mon) {
		mon.curHP = mon.maxHP;
		mon.fainted = false;
		mon.status = null;
		mon.sleepTurns = 0;
		mon.toxicCounter = 0;
		mon.turnsOut = 0;
		mon.itemGone = false;
		mon.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0};
		mon.volatiles = {};
	}

	/** The hardest single hit either way, as a fraction of the target's health. */
	function hitFraction(state, attacker, defender) {
		var mon = RRBattle.active(state[attacker]);
		var target = RRBattle.active(state[defender]);
		var moves = (mon.set && mon.set.moves) || [];
		var worst = 0;
		for (var i = 0; i < moves.length; i++) {
			var rolls = RRBattle.damageRolls(state, attacker, moves[i]);
			var hit = rolls ? rolls.noCrit[rolls.noCrit.length - 1] : 0;
			if (hit > worst) worst = hit;
		}
		return worst / Math.max(1, target.maxHP);
	}

	/**
	 * Solve every pairing.
	 *
	 * The per-pair budget is deliberately small. A 1v1 has no switches in it, so
	 * the branching factor is four rather than ten, and a pairing that cannot be
	 * settled in a couple of thousand nodes is one where the answer depends on a
	 * long grind -- which is a fine thing to be unsure about in a hint.
	 */
	function build(state, options) {
		var opts = options || {};
		var perPair = opts.perPairBudget || 2500;
		var maxTurns = opts.pairMaxTurns || 14;
		var mineCount = state.me.team.length;
		var theirCount = state.foe.team.length;
		var pairs = [];
		var nodes = 0;
		var started = Date.now();

		for (var i = 0; i < mineCount; i++) {
			pairs[i] = [];
			for (var j = 0; j < theirCount; j++) {
				var one = onePosition(state, i, j);
				var deal = hitFraction(one, "me", "foe");
				var take = hitFraction(one, "foe", "me");
				var result;
				try {
					result = RRExact.cleanWin(one, {
						exactBudget: perPair,
						maxTurns: maxTurns,
						// No matchup table while building the matchup table.
						matchup: null,
						hunt: false
					});
				} catch (e) {
					result = {found: false, decided: false, nodes: 0, line: null};
				}
				nodes += result.nodes;
				var endHP = 1;
				if (result.found && result.line && result.line.length) {
					var last = result.line[result.line.length - 1].next;
					var me = RRBattle.active(last.me);
					endHP = me.curHP / Math.max(1, me.maxHP);
				}
				pairs[i][j] = {
					beats: !!result.found,
					// Only a FINISHED search may say a pairing is unwinnable.
					// "the budget ran out" and "mine cannot beat this" are
					// different claims, and a prune that confuses them would
					// throw away branches on the strength of a timeout.
					hopeless: !result.found && result.decided,
					decided: !!result.decided,
					turns: result.found && result.line ? result.line.length : null,
					endHPFrac: endHP,
					dealFrac: deal,
					takeFrac: take
				};
			}
		}

		return {
			pairs: pairs,
			nodes: nodes,
			elapsedMs: Date.now() - started,
			mine: mineCount,
			theirs: theirCount
		};
	}

	/** What mine at index `i` does to whatever is standing in front. */
	function versus(table, mine, theirs) {
		if (!table || !table.pairs[mine]) return null;
		return table.pairs[mine][theirs] || null;
	}

	/**
	 * Is every remaining foe beaten by SOMETHING still standing?
	 *
	 * A foe counts as covered unless every surviving Pokemon of yours either
	 * lost the pairing in a search that FINISHED, or cannot put a scratch on it
	 * at all. The second half is doing most of the work, and deliberately so.
	 * The first was tried alone and turned out to fire almost never: a pairing
	 * you cannot win usually is not searched to exhaustion, it simply runs out
	 * of turns while the two of you fail to kill each other, which is
	 * `decided: false` and rightly not a conclusion. Immunity is different --
	 * "every move I have does nothing to that type" comes from the damage
	 * calculation, not from a search, so it is available for free and it is
	 * exactly the wall that makes a Nuzlocke fight unwinnable.
	 *
	 * HUNT ONLY, for two separate reasons, and both are why nothing here may
	 * inform the exhaustive pass:
	 *
	 *   A foe nothing beats one on one can still be ground down by several of
	 *   yours taking turns at it and healing between visits.
	 *
	 *   Dealing no direct damage is not the same as being unable to win. Toxic,
	 *   Leech Seed and a long enough fuse beat plenty of things that shrug off
	 *   every attack you have.
	 */
	function anyCoverageGap(table, state) {
		if (!table) return false;
		for (var j = 0; j < state.foe.team.length; j++) {
			if (state.foe.team[j].fainted) continue;
			var covered = false;
			for (var i = 0; i < state.me.team.length && !covered; i++) {
				if (state.me.team[i].fainted) continue;
				var cell = versus(table, i, j);
				if (!cell) { covered = true; break; }
				if (cell.beats) { covered = true; break; }
				if (!cell.hopeless && cell.dealFrac > 0) covered = true;
			}
			if (!covered) return true;
		}
		return false;
	}

	return {build: build, versus: versus, anyCoverageGap: anyCoverageGap};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRMatchup;
