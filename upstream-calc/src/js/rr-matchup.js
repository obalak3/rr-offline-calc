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
	 * these fights live outside the two Pokemon: Lt. Surge's Electric Terrain
	 * blocks sleep for anything of his that stands on the ground, so both Sleep
	 * Powders in the party are dead weight WHILE IT IS UP. A fresh state would
	 * have quietly dropped it and the table would have promised sleep wins that
	 * do not exist.
	 *
	 * Corrected 2026-08-25: that terrain is not permanent, it runs the normal
	 * five turns from Pincurchin's Electric Surge. The engine used to model it
	 * as never expiring, which made the sleep moves look permanently dead.
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

	/**
	 * How much of my team it costs to remove what is left of theirs.
	 *
	 * WHY NOT COVERAGE. The obvious value function is "is every surviving foe
	 * beaten by something still standing", and it is useless on the fight this
	 * was built for. Measured on the real Lt. Surge team: of thirty pairings
	 * only nine are clean 1v1 wins, and NOTHING beats Bellibolt or Pawmot. A
	 * coverage test calls that position lost on turn one and returns the same
	 * verdict for every legal move, which is no gradient at all -- the exact
	 * failure the live deep search already had. James then played that fight and
	 * won it without losing anybody, so "no pairing wins" plainly does not mean
	 * "the fight is lost": several Pokemon take turns at a foe, and chip adds up.
	 *
	 * So this prices the fight as an EXCHANGE instead of a covering. For each
	 * surviving foe, find the cheapest way to remove it measured in my own HP,
	 * and compare the total against the HP I actually have. That is defined for
	 * every cell, including the ones no search could win, which is what gives it
	 * a gradient where coverage has none.
	 *
	 * The two rates it runs on, `dealFrac` and `takeFrac`, are per-hit fractions
	 * of the TARGET'S MAX HP, so they do not go stale as HP drains. Only the
	 * current HP fractions change, and those are read from the live state. That
	 * is why the table can be built once per battle rather than per turn.
	 *
	 * A switch needs no explicit tax here. This is evaluated on the position
	 * AFTER the exchange, so the free hit a switch concedes is already spent
	 * from the incoming Pokemon's HP.
	 *
	 * KNOWN AND DELIBERATE in this first version, so none of it is mistaken for
	 * an oversight later:
	 *   - Rates are MAX rolls on both sides, which reads as "everybody rolls
	 *     high" rather than as a worst case for us specifically.
	 *   - Foes are priced independently, so one Pokemon sweeping two of theirs
	 *     is not modelled; its HP gets charged twice.
	 *   - A denied turn is priced at zero rather than positive. This stops
	 *     PUNISHING Fake Out, which the race heuristic did; it does not yet
	 *     reward it.
	 *   - Status and stall wins appear only where cleanWin found them inside a
	 *     1v1, never through `dealFrac`, which is direct damage only.
	 *
	 * HOW MUCH OF THIS IS THE TABLE, MEASURED AGAINST A NULL. Ranking by this
	 * wins 9/9 level-appropriate fights including Lt. Surge, which nothing else
	 * had won. But replacing the whole table with `my health minus twice
	 * theirs`, no pairings at all, ALSO wins 9/9 and also wins Surge, losing 5
	 * where this loses 4. So the credit belongs almost entirely to charging for
	 * their remaining health, and the table is worth about one Pokemon across
	 * nine fights -- which at n=9 is not a result. The old heuristic's real
	 * defect was that it undervalued attacking; anything that rewards progress
	 * repairs it. Do not claim the pairing table earned this until it beats the
	 * null by something a sample this size can see.
	 */
	function valueOf(state, table, options) {
		var opts = options || {};
		// What a Pokemon that cannot hurt a foe at all is worth against it.
		// Not Infinity: an unanswerable foe should dominate the score without
		// making every position containing one compare equal to every other.
		var WALL = opts.wallCost === undefined ? 4 : opts.wallCost;

		var myHP = 0, i, j;
		for (i = 0; i < state.me.team.length; i++) {
			var mon = state.me.team[i];
			if (mon.fainted) continue;
			myHP += mon.curHP / Math.max(1, mon.maxHP);
		}

		// Their remaining health, counted plainly. This is the PROGRESS term and
		// the value function does not work without it.
		//
		// `needed` alone is a cost-to-go, and a cost-to-go is flat along the
		// path that wins: Breloom beats Pincurchin without dropping a point, so
		// Pincurchin costs zero whether it is untouched or nearly dead, and
		// removing it earns nothing. Measured, the whole ranking then collapsed
		// into "do not spend HP" and Detect and Fake Out tied for first at
		// exactly the value of doing nothing, with every attack scoring below
		// them. Charging for the health they still have makes damage always
		// worth something and stalling never worth anything.
		var theirHP = 0;
		for (j = 0; j < state.foe.team.length; j++) {
			if (state.foe.team[j].fainted) continue;
			theirHP += state.foe.team[j].curHP / Math.max(1, state.foe.team[j].maxHP);
		}
		// 2, and the value is MEASURED rather than reasoned. Swept on the real
		// Lt. Surge fight: at 1.5 and below the fight is lost, at 2 it is won,
		// and 2 through 50 give byte-identical play (won 9/9, 4 lost, 24 turns).
		// A plateau that wide is worth reading honestly -- at the top of it the
		// cost term is negligible, so the ranking is very nearly "reduce their
		// health", and see the note on valueOf about how little the table itself
		// turned out to be worth.
		var progress = opts.progressWeight === undefined ? 2 : opts.progressWeight;

		var needed = 0, walls = 0;
		for (j = 0; j < state.foe.team.length; j++) {
			var foe = state.foe.team[j];
			if (foe.fainted) continue;
			var left = foe.curHP / Math.max(1, foe.maxHP);
			var cheapest = null;
			for (i = 0; i < state.me.team.length; i++) {
				var me = state.me.team[i];
				if (me.fainted) continue;
				var cell = versus(table, i, j);
				if (!cell || !cell.dealFrac) continue;      // cannot scratch it
				// Hits to finish what is left of them, and what each hit costs
				// me. Charged as whole hits because a turn is not divisible.
				var hits = Math.ceil(left / cell.dealFrac);
				var cost = hits * cell.takeFrac;
				// A clean 1v1 win is priced by what the SEARCH measured rather
				// than by the rate model, because it is a real line: it accounts
				// for the healing, the immunities and the order of moves that a
				// two-number exchange rate cannot see.
				//
				// Scaled by how much of the foe is LEFT, which is not a detail.
				// Priced flat, a won pairing costs the same whether the foe is
				// untouched or on its last point of HP, so chipping it earns no
				// credit while the hit taken in return still costs. Every attack
				// then looks like a losing trade and the top of the ranking
				// fills with Detect and Fake Out: doing nothing preserved the
				// score exactly. Measured, before this line existed.
				if (cell.beats) cost = Math.min(cost, (1 - cell.endHPFrac) * left);
				if (cheapest === null || cost < cheapest) cheapest = cost;
			}
			if (cheapest === null) { walls++; needed += WALL; }
			else needed += cheapest;
		}

		return {
			// Positive means the team I have left can still pay for the team
			// they have left. This is the number to rank by.
			margin: myHP - needed - progress * theirHP,
			// The same figure without the progress term: what the position is
			// worth rather than how far along it is. Kept separate so a caller
			// can show "you can afford this fight" without the steering term
			// muddying it.
			afford: myHP - needed,
			myHP: myHP,
			theirHP: theirHP,
			needed: needed,
			// Foes nothing left of mine can damage at all. Reported separately
			// because it is a different kind of problem from being expensive,
			// and it is the one worth telling a player about.
			walls: walls
		};
	}

	/**
	 * A leaf evaluator for the odds search: this position, as a number in [0,1].
	 *
	 * `valueOf` returns a MARGIN -- how much of my team is left over after
	 * paying for theirs -- which is unbounded in both directions and therefore
	 * cannot be mixed with probabilities. The search averages chance nodes and
	 * maximises choices, so whatever comes back from a leaf has to live on the
	 * same scale as "1 means a clean win", or a single leaf would swamp every
	 * real probability in the tree.
	 *
	 * Squashed with a logistic rather than clipped, because the shape matters:
	 * it is monotone (more margin is never worth less), it saturates (being
	 * enormously ahead is not meaningfully better than being clearly ahead,
	 * which stops a hopeless branch being rescued by one lopsided leaf), and it
	 * is smooth around zero, where the positions the search actually has to
	 * choose between live.
	 *
	 * `k` sets how sharply it separates. At 1, a margin of 0 reads 0.5 and a
	 * margin of 3 reads about 0.95.
	 *
	 * THIS IS AN ESTIMATE AND NOTHING ELSE. It is not a probability of anything
	 * that was computed; it is a heuristic wearing a probability's clothes so it
	 * can be averaged. winChance records that a leaf was estimated and refuses
	 * to call the result proved, which is the only thing keeping the difference
	 * visible downstream.
	 */
	function leafValue(table, options) {
		var opts = options || {};
		var k = opts.sharpness === undefined ? 1 : opts.sharpness;
		return function (state) {
			var v = valueOf(state, table, opts);
			// A team that cannot answer something at all is not merely behind.
			if (v.walls > 0) return 0;
			// `afford`, NOT `margin`. The margin carries the progress term,
			// which subtracts their whole remaining health, so at the start of
			// a fight it reads -6.6 and squashes to 0.0014 -- every position in
			// the game scoring "hopeless" and none of them distinguishable.
			//
			// The progress term exists because a one-turn ranker has no
			// lookahead and would otherwise sit still rather than trade. A
			// SEARCH already supplies the lookahead: deeper leaves have foes
			// with less health, which lowers `needed` and raises `afford` by
			// itself. Charging for progress here as well double-counts it, on a
			// scale that has to mean something absolute.
			return 1 / (1 + Math.exp(-k * v.afford));
		};
	}

	return {build: build, versus: versus, anyCoverageGap: anyCoverageGap,
		valueOf: valueOf, leafValue: leafValue};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRMatchup;
