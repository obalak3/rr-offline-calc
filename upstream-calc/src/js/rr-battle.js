/**
 * rr-battle.js -- battle state and the turn transition, for the solver.
 *
 * The damage calculator answers one question about one exchange. A solver has
 * to ask what the board looks like afterwards, so this file adds the part the
 * calculator has no opinion about: whose move goes first, what a status move
 * did, what the end of the turn cost each side, and what the position is now.
 *
 * Deliberately NOT a battle engine. It simulates the mechanics that appear in
 * Radical Red trainer battles, dispatching on the effect table built by
 * tools/build_move_effects.js, and it reports anything it cannot model instead
 * of quietly approximating it. `state.unmodelled` accumulates those, and the
 * solver is required to surface them: a guarantee computed over a mechanic we
 * silently skipped is not a guarantee.
 *
 * Damage, crit rates and final Speed all come from code that already exists
 * (RRCritKO and the calculator itself) rather than being reimplemented here.
 *
 * No DOM. Loads in Node under vm for the tests and in the worker for the
 * search, following the same pattern as rr-critko.js.
 */
/* global calc, RRCritKO, RR_MOVE_EFFECTS, RRAISwitching */
var RRBattle = (function () {
	"use strict";

	var GEN_NUM = 9;
	var STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"];

	// Accuracy/evasion use their own stage table, not the damage one.
	var ACC_STAGES = [3 / 9, 3 / 8, 3 / 7, 3 / 6, 3 / 5, 3 / 4, 1,
		4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];

	// Types that simply cannot receive a given status.
	var STATUS_IMMUNE_TYPES = {
		brn: ["Fire"],
		frb: ["Ice"],
		par: ["Electric"],
		psn: ["Poison", "Steel"],
		tox: ["Poison", "Steel"]
	};

	function gen() { return calc.Generations.get(GEN_NUM); }

	/**
	 * Damage caching.
	 *
	 * The search re-derives the same matchup thousands of times: in "worst" mode
	 * damage is deterministic, so identical positions recur constantly and each
	 * one was costing two calc.calculate() calls plus two Pokemon constructions.
	 * That was the whole cost of the search.
	 *
	 * The key has to carry everything damage depends on. Current HP is in it
	 * because moves like Eruption and Flail scale with it, and leaving it out
	 * would be a silent wrong answer rather than a slow one.
	 */
	var damageCache = {};
	var damageCacheSize = 0;
	var CACHE_LIMIT = 300000;
	var nextSetId = 1;

	function setId(set) {
		if (!set._rrid) set._rrid = nextSetId++;
		return set._rrid;
	}

	function monKey(mon) {
		var b = mon.boosts;
		return setId(mon.set) + ":" + mon.curHP + ":" + (mon.status || "-") + ":" +
			(mon.itemGone ? 1 : 0) + ":" +
			b.atk + "," + b.def + "," + b.spa + "," + b.spd + "," + b.spe;
	}

	function screenKey(side) {
		return (side.screens.reflect ? "R" : "") + (side.screens.lightscreen ? "L" : "") +
			(side.screens.auroraveil ? "A" : "") + (side.screens.tailwind ? "T" : "");
	}

	function clearCache() {
		damageCache = {};
		damageCacheSize = 0;
		speedCache = Object.create(null);
		speedCacheSize = 0;
	}

	// Looked up constantly -- a CPU profile put 10.8% of the search in here, for
	// what is nominally a property read. The cost is the typeof guard and two
	// lookups on a 1074-key object, repeated millions of times. Hoisting the
	// table and memoising by name turns it into one hit on a null-prototype map.
	var moveTable = null;
	var moveDataCache = Object.create(null);

	function moveData(name) {
		var hit = moveDataCache[name];
		if (hit !== undefined) return hit;
		if (!moveTable) {
			moveTable = (typeof RR_MOVE_EFFECTS !== "undefined" && RR_MOVE_EFFECTS.moves) || {};
		}
		var found = moveTable[name] || null;
		moveDataCache[name] = found;
		return found;
	}

	// ------------------------------------------------------------ state setup

	function emptyBoosts() {
		return {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0};
	}

	/**
	 * A set is the plain object both the trainer dataset and the saved-team
	 * store already use: species, level, nature, ability, item, moves, evs, ivs.
	 */
	function makeMon(set) {
		var probe = new calc.Pokemon(gen(), set.species, {
			level: set.level,
			nature: set.nature || "Serious",
			evs: set.evs,
			ivs: set.ivs,
			item: set.item || undefined,
			ability: set.ability || undefined,
			moves: (set.moves || []).slice(0, 4)
		});
		var maxHP = probe.maxHP();
		var pp = [];
		for (var i = 0; i < (set.moves || []).length; i++) {
			var data = moveData(set.moves[i]);
			pp.push(data && data.pp ? data.pp : 16);
		}
		return {
			set: set,
			species: set.species,
			maxHP: maxHP,
			curHP: maxHP,
			status: null,
			sleepTurns: 0,
			toxicCounter: 0,
			boosts: emptyBoosts(),
			pp: pp,
			itemGone: false,
			fainted: false,
			turnsOut: 0,
			volatiles: {}     // substitute, leechSeed, taunt, protectChain, ...
		};
	}

	function makeSide(sets) {
		return {
			team: sets.map(makeMon),
			active: 0,
			hazards: {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0},
			switchCooldown: 0,
			screens: {}        // name -> turns remaining
		};
	}

	function createState(mySets, foeSets, options) {
		var opts = options || {};
		return openState({
			me: makeSide(mySets),
			foe: makeSide(foeSets),
			field: {
				weather: opts.weather || null,
				weatherTurns: opts.permanentWeather ? Infinity : (opts.weather ? 5 : 0),
				terrain: opts.terrain || null,
				terrainTurns: opts.permanentTerrain ? Infinity : (opts.terrain ? 5 : 0),
				trickRoom: 0
			},
			// Restricted mode: weather and terrain the AI sets never expire, and
			// terrain removal does not work. Both are rule modifiers, not
			// difficulty, and both change what counterplay exists.
			rules: opts.rules || "restricted",
			nuzlocke: !!opts.nuzlocke,
			// How many unlucky events have been spent so far. Bad luck is
			// budgeted rather than assumed: "you miss every turn forever" is
			// not unlucky, it is unreachable, and a ladder rung nothing can
			// clear tells you nothing.
			luckSpent: {miss: 0, paralysis: 0},
			turn: 1,
			// Product of every per-turn re-roll assumed to go the player's way.
			// 1 means nothing was assumed; see assume().
			reliability: 1,
			unmodelled: []
		});
	}

	/** Leads have entry abilities too, so the opening position needs them. */
	function openState(state) {
		applyEntryAbility(state, "foe");
		applyEntryAbility(state, "me");
		return state;
	}

	/**
	 * Copy a battle state.
	 *
	 * JSON round-trip, which looks lazy and is in fact the fastest thing
	 * available here: a hand-written structural copy was tried and measured 1.81
	 * times SLOWER (26.6us against 14.7us on an eleven-Pokemon state), because
	 * native stringify/parse beats walking objects in JavaScript. `set` is
	 * shared deliberately -- it is never mutated.
	 *
	 * The one thing JSON gets wrong is Infinity, which it turns into null.
	 * Permanent weather and terrain are stored as Infinity turns, which is how
	 * restricted mode represents AI-set weather, so a cloned state disagreed
	 * with an uncloned one about the same position: permanence survived only
	 * because `null > 0` happens to be false, and positionKey produced a
	 * different key for the same field, quietly costing transposition hits.
	 * Restoring those two fields afterwards costs nothing and fixes it.
	 *
	 * Worth knowing before optimising this again: clone is only about 10% of a
	 * turn. Profiling the exact search put 86% of its runtime in step(), but the
	 * bulk of that is the turn simulation itself, not the copying.
	 */
	function clone(state) {
		var sets = [];
		function stash(side) {
			side.team.forEach(function (mon) { sets.push(mon.set); mon.set = null; });
		}
		function restore(side) {
			side.team.forEach(function (mon) { mon.set = sets.shift(); });
		}
		stash(state.me); stash(state.foe);
		var copy = JSON.parse(JSON.stringify(state));
		var keep = sets.slice();
		restore(state.me); restore(state.foe);
		sets = keep;
		restore(copy.me); restore(copy.foe);

		// JSON cannot carry Infinity. These are the only two fields that hold it.
		if (state.field.weatherTurns === Infinity) copy.field.weatherTurns = Infinity;
		if (state.field.terrainTurns === Infinity) copy.field.terrainTurns = Infinity;
		return copy;
	}

	function active(side) { return side.team[side.active]; }
	function other(key) { return key === "me" ? "foe" : "me"; }

	// -------------------------------------------------------- calc bridging

	function toCalcPokemon(mon) {
		var set = mon.set;
		var options = {
			level: set.level,
			nature: set.nature || "Serious",
			evs: set.evs,
			ivs: set.ivs,
			item: mon.itemGone ? undefined : (set.item || undefined),
			ability: set.ability || undefined,
			moves: (set.moves || []).slice(0, 4),
			boosts: {
				atk: mon.boosts.atk, def: mon.boosts.def, spa: mon.boosts.spa,
				spd: mon.boosts.spd, spe: mon.boosts.spe
			},
			curHP: mon.curHP
		};
		// The calculator has no frostbite, so the status is passed only where it
		// shares mainline semantics. Frostbite's Sp. Atk cut is applied to the
		// damage array instead; see applySpecialStatusScaling.
		if (mon.status && mon.status !== "frb") options.status = mon.status;
		return new calc.Pokemon(gen(), set.species, options);
	}

	function buildField(state, attackerKey) {
		var field = new calc.Field({
			weather: state.field.weather || undefined,
			terrain: state.field.terrain || undefined
		});
		var mine = attackerKey === "me" ? state.me : state.foe;
		var theirs = attackerKey === "me" ? state.foe : state.me;
		field.attackerSide = new calc.Side({
			isReflect: !!mine.screens.reflect,
			isLightScreen: !!mine.screens.lightscreen,
			isAuroraVeil: !!mine.screens.auroraveil,
			isTailwind: !!mine.screens.tailwind
		});
		field.defenderSide = new calc.Side({
			isReflect: !!theirs.screens.reflect,
			isLightScreen: !!theirs.screens.lightscreen,
			isAuroraVeil: !!theirs.screens.auroraveil,
			isTailwind: !!theirs.screens.tailwind
		});
		return field;
	}

	/**
	 * Frostbite halves Sp. Atk. Confirmed from CFRU's own AI, which raises the
	 * score for frostbiting a foe that would otherwise KO with a special move.
	 * Applied to the damage array rather than the stat, so it rounds one step
	 * later than the game does; the difference is at most a point.
	 */
	function applySpecialStatusScaling(rolls, attacker, move) {
		if (attacker.status !== "frb") return rolls;
		var data = moveData(move);
		if (!data || data.split !== "Special") return rolls;
		return rolls.map(function (value) { return Math.floor(value * 0.5); });
	}

	function damageRolls(state, attackerKey, moveName) {
		var attackerSide = state[attackerKey];
		var defenderSide = state[other(attackerKey)];
		var attacker = active(attackerSide);
		var defender = active(defenderSide);
		var data = moveData(moveName);
		if (!data || data.split === "Status") return null;

		var cacheKey = monKey(attacker) + "|" + monKey(defender) + "|" + moveName + "|" +
			(state.field.weather || "-") + (state.field.terrain || "-") + "|" +
			screenKey(attackerSide) + "/" + screenKey(defenderSide);
		var cached = damageCache[cacheKey];
		if (cached !== undefined) return cached;

		var move;
		try {
			// Skill Link makes every multi-hit move hit the maximum number of
			// times, and nothing else in the stack applies it -- the calculator
			// has no mention of the ability at all. Left alone, Icicle Spear off
			// a Cloyster was priced at three hits instead of five, so incoming
			// damage came out **forty per cent low**. Underestimating what the
			// opponent does to you is the one direction a Nuzlocke planner must
			// never be wrong in: it turns a Pokemon that dies into one the
			// search believes survives.
			var opts = null;
			if (attacker.set.ability === "Skill Link") {
				var probe = new calc.Move(gen(), moveName);
				if (probe.hits && probe.hits > 1) opts = {hits: 5};
			}
			move = opts ? new calc.Move(gen(), moveName, opts)
				: new calc.Move(gen(), moveName);
		} catch (e) {
			state.unmodelled.push("move not in calculator: " + moveName);
			return null;
		}
		var arrays = RRCritKO.hitArrays(gen(), toCalcPokemon(attacker),
			toCalcPokemon(defender), move, buildField(state, attackerKey));
		// hitArrays returns null when the maximum roll is zero, which is an
		// immunity rather than a failure. Conflating the two would make the
		// simulator report an unmodelled mechanic every time a Ground move met
		// a Flying type, and would hide a real failure among the noise.
		if (!arrays) {
			var zeros = [];
			for (var z = 0; z < 16; z++) zeros.push(0);
			return store(cacheKey, {noCrit: zeros, crit: zeros.slice(),
				critChance: 0, hits: 1, immune: true});
		}
		return store(cacheKey, {
			noCrit: applySpecialStatusScaling(arrays.noCrit, attacker, moveName),
			crit: applySpecialStatusScaling(arrays.crit, attacker, moveName),
			critChance: RRCritKO.critChance(toCalcPokemon(attacker),
				toCalcPokemon(defender), move, 0),
			hits: arrays.hits,
			// Whether the move touches, which decides Iron Barbs and Rough Skin.
			contact: !!(move.flags && move.flags.contact)
		});
	}

	function store(key, value) {
		// Dropped wholesale rather than evicted one at a time: the search runs
		// in bursts, and a plain object of this size is cheap to throw away.
		if (damageCacheSize >= CACHE_LIMIT) clearCache();
		damageCache[key] = value;
		damageCacheSize++;
		return value;
	}

	// ------------------------------------------------------------ turn order

	/**
	 * Speed, cached on the things speed actually depends on.
	 *
	 * 19.4% of the search after the clone fix, because every turn order check
	 * rebuilt a calc.Field and a calc.Pokemon from scratch. The key deliberately
	 * does NOT reuse monKey: that includes curHP, which changes every single
	 * turn and has nothing to do with how fast anything moves, so it would have
	 * thrown the hit rate away. What matters is the set, paralysis, whether the
	 * item is gone (Unburden, Choice Scarf), the Speed stage, turns out for
	 * Slow Start, and the weather, terrain and Tailwind that abilities key off.
	 */
	var speedCache = Object.create(null);
	var speedCacheSize = 0;

	function finalSpeed(state, key) {
		var side = state[key];
		var mon = active(side);
		var f = state.field;
		var cacheKey = setId(mon.set) + "|" + (mon.status || "-") +
			(mon.itemGone ? 1 : 0) + "|" + mon.boosts.spe + "|" + (mon.turnsOut || 0) +
			"|" + (f.weather || "-") + (f.terrain || "-") +
			(side.screens.tailwind ? "T" : "");
		var hit = speedCache[cacheKey];
		if (hit !== undefined) return hit;

		var field = buildField(state, key);
		var value;
		try {
			value = calc.getFinalSpeed(gen(), toCalcPokemon(mon), field, field.attackerSide);
		} catch (e) {
			value = toCalcPokemon(mon).stats.spe;
		}
		if (speedCacheSize >= CACHE_LIMIT) {
			speedCache = Object.create(null);
			speedCacheSize = 0;
		}
		speedCache[cacheKey] = value;
		speedCacheSize++;
		return value;
	}

	function actionPriority(state, key, action) {
		if (action.type === "switch") return 6;   // switching resolves first
		var data = moveData(action.move);
		var priority = data ? (data.priority || 0) : 0;
		// Custap Berry moves the holder first from its own priority bracket.
		var mon = active(state[key]);
		if (!mon.itemGone && mon.set.item === "Custap Berry" &&
			mon.curHP <= mon.maxHP / 4) {
			priority += 0.5;
		}
		return priority;
	}

	/**
	 * Returns the order keys move in, or null when a genuine speed tie means the
	 * caller has to branch.
	 */
	function turnOrder(state, myAction, foeAction) {
		var myPriority = actionPriority(state, "me", myAction);
		var foePriority = actionPriority(state, "foe", foeAction);
		if (myPriority !== foePriority) {
			return myPriority > foePriority ? ["me", "foe"] : ["foe", "me"];
		}
		var mySpeed = finalSpeed(state, "me");
		var foeSpeed = finalSpeed(state, "foe");
		if (mySpeed === foeSpeed) return null;
		var faster = mySpeed > foeSpeed;
		if (state.field.trickRoom > 0) faster = !faster;
		return faster ? ["me", "foe"] : ["foe", "me"];
	}

	// -------------------------------------------------------------- actions

	function legalActions(state, key) {
		var side = state[key];
		var mon = active(side);
		var actions = [];
		if (!mon.fainted) {
			for (var i = 0; i < mon.set.moves.length; i++) {
				if (mon.pp[i] <= 0) continue;
				if (mon.volatiles.taunt > 0) {
					var data = moveData(mon.set.moves[i]);
					if (data && data.split === "Status") continue;
				}
				var info = moveData(mon.set.moves[i]);
				var pivots = info && info.effect && info.effect.kind === "selfSwitch" &&
					info.split !== "Status";
				if (pivots) {
					// U-turn, Volt Switch and Flip Turn hit and then switch, and
					// WHO comes in is your choice, so it is part of the action
					// rather than something to assume. Without this they were
					// simulated as ordinary attacks and the Pokemon never moved.
					var targets = 0;
					for (var t = 0; t < side.team.length; t++) {
						if (t === side.active || side.team[t].fainted) continue;
						actions.push({type: "move", index: i, move: mon.set.moves[i],
							switchTo: t});
						targets++;
					}
					if (targets) continue;
				}
				actions.push({type: "move", index: i, move: mon.set.moves[i]});
			}
			if (!actions.length) {
				actions.push({type: "move", index: -1, move: "Struggle"});
			}
		}
		for (var j = 0; j < side.team.length; j++) {
			if (j !== side.active && !side.team[j].fainted) {
				actions.push({type: "switch", index: j});
			}
		}
		return actions;
	}

	function isOver(state) {
		// Under Nuzlocke rules a faint is permanent, so losing ONE Pokemon is
		// losing, even in a battle you go on to win. The whole objective
		// changes: the search is looking for a clean sweep, not a victory.
		if (state.nuzlocke && state.me.team.some(function (m) { return m.fainted; })) {
			return "loss";
		}
		var meAlive = state.me.team.some(function (m) { return !m.fainted; });
		var foeAlive = state.foe.team.some(function (m) { return !m.fainted; });
		if (!foeAlive && meAlive) return "win";
		if (!meAlive && foeAlive) return "loss";
		if (!meAlive && !foeAlive) return "loss";   // a tie is not a win
		return null;
	}

	// -------------------------------------------------------- effect helpers

	function clampBoost(value) { return Math.max(-6, Math.min(6, value)); }

	function applyBoosts(mon, boosts) {
		for (var stat in boosts) {
			if (!Object.prototype.hasOwnProperty.call(boosts, stat)) continue;
			mon.boosts[stat] = clampBoost((mon.boosts[stat] || 0) + boosts[stat]);
		}
	}

	function typesOf(mon) {
		return toCalcPokemon(mon).types;
	}

	/** Flying types and Levitate are not standing on the terrain. */
	function isGrounded(mon) {
		if (typesOf(mon).indexOf("Flying") >= 0) return false;
		if (mon.set.ability === "Levitate") return false;
		if (!mon.itemGone && mon.set.item === "Air Balloon") return false;
		return true;
	}

	function canTakeStatus(mon, status, state, moveType) {
		if (mon.status) return false;
		if (mon.volatiles.substitute) return false;
		// Volt Absorb stops Thunder Wave, not just Thunderbolt.
		if (moveType && absorbs(mon, moveType)) return false;

		// Terrain blocks status on anything standing on it. This decides whole
		// fights: Pincurchin's Electric Surge means Sleep Powder does nothing to
		// Surge's grounded team, and a plan built on putting something to sleep
		// would simply fail in front of you.
		if (state && state.field && isGrounded(mon)) {
			if (state.field.terrain === "Electric" && status === "slp") return false;
			if (state.field.terrain === "Misty") return false;
		}
		var immune = STATUS_IMMUNE_TYPES[status];
		if (!immune) return true;
		var types = typesOf(mon);
		for (var i = 0; i < immune.length; i++) {
			if (types.indexOf(immune[i]) >= 0) return false;
		}
		return true;
	}

	function setStatus(mon, status, state, moveType) {
		if (!canTakeStatus(mon, status, state, moveType)) return false;
		// A Lum Berry eats the status the instant it lands, so the target is
		// inconvenienced for no turns at all. Seventeen trainer Pokemon carry
		// one and nothing in the stack knew about it, so the search was free to
		// build a plan around a Sleep Powder that in the real game wears off
		// before the target has missed a turn -- and this party carries two of
		// them. Optimism about the opponent is the direction that ends runs.
		//
		// Applied here rather than at end of turn because that is when it
		// really fires, and because setStatus is the one door every status
		// comes through: moves, secondaries, abilities and hazards alike.
		if (!mon.itemGone && mon.set.item === "Lum Berry") {
			mon.itemGone = true;
			return false;
		}
		mon.status = status;
		if (status === "slp") mon.sleepTurns = 2;
		if (status === "tox") mon.toxicCounter = 1;
		return true;
	}

	/**
	 * Abilities that make a whole type do nothing, and in most cases heal.
	 *
	 * The calculator already zeroes the damage, but two consequences are ours:
	 * the type's STATUS moves are blocked too (Volt Absorb stops Thunder Wave),
	 * and the absorbing kinds restore a quarter of max HP. Against an Electric
	 * gym that is the difference between a Pokemon that survives and one that
	 * gets healthier every time they attack it.
	 */
	var ABSORBS = {
		"Volt Absorb": {type: "Electric", heals: true},
		"Water Absorb": {type: "Water", heals: true},
		"Dry Skin": {type: "Water", heals: true},
		"Sap Sipper": {type: "Grass", boosts: {atk: 1}},
		"Motor Drive": {type: "Electric", boosts: {spe: 1}},
		"Lightning Rod": {type: "Electric", boosts: {spa: 1}},
		"Storm Drain": {type: "Water", boosts: {spa: 1}},
		"Flash Fire": {type: "Fire", boosts: {spa: 1}}
	};

	function absorbs(mon, moveType) {
		var rule = ABSORBS[mon.set.ability];
		return rule && rule.type === moveType ? rule : null;
	}

	function heal(mon, amount) {
		mon.curHP = Math.min(mon.maxHP, mon.curHP + Math.floor(amount));
	}

	function damage(mon, amount) {
		mon.curHP = Math.max(0, mon.curHP - Math.floor(amount));
		if (mon.curHP === 0) mon.fainted = true;
	}

	/**
	 * How hard `moveType` hits this Pokemon: 2 and 4 are super effective, 0 is
	 * an immunity. Reads the calculator's chart rather than a second copy of it.
	 */
	function typeMultiplier(mon, moveType) {
		if (!moveType) return 1;
		var effectiveness = 1;
		try {
			var chart = calc.TYPE_CHART[GEN_NUM][moveType];
			typesOf(mon).forEach(function (type) {
				if (chart && chart[type] !== undefined) effectiveness *= chart[type];
			});
		} catch (e) { effectiveness = 1; }
		return effectiveness;
	}

	// --------------------------------------------------------------- hazards

	function applyHazards(state, key) {
		var side = state[key];
		var mon = active(side);
		if (mon.fainted) return;
		var types = typesOf(mon);
		// isGrounded() already knows about Levitate and Air Balloon; this line
		// only checked for the Flying type, so a Levitate Flygon walked into
		// three layers of Spikes for 43 HP and a grounded Poison type never
		// absorbed Toxic Spikes.
		var grounded = isGrounded(mon);

		// Magic Guard takes no indirect damage at all -- hazards, weather,
		// status, Leech Seed. It was consulted only for recoil, so a Clefable
		// switching into Stealth Rock and three Spikes lost 63 HP it should
		// never lose.
		if (mon.set.ability === "Magic Guard") return;

		if (side.hazards.stealthrock) {
			var effectiveness = 1;
			try {
				var chart = calc.TYPE_CHART[GEN_NUM].Rock;
				types.forEach(function (type) {
					if (chart && chart[type] !== undefined) effectiveness *= chart[type];
				});
			} catch (e) { effectiveness = 1; }
			damage(mon, mon.maxHP * (effectiveness / 8));
		}
		if (grounded && side.hazards.spikes) {
			damage(mon, mon.maxHP / (10 - 2 * side.hazards.spikes));
		}
		if (grounded && side.hazards.toxicspikes && !mon.status) {
			setStatus(mon, side.hazards.toxicspikes >= 2 ? "tox" : "psn", state);
		}
		if (grounded && side.hazards.stickyweb) {
			applyBoosts(mon, {spe: -1});
		}
	}

	/**
	 * Abilities that fire the moment a Pokemon comes in.
	 *
	 * Not a completeness exercise: these two decide the Surge fight. Electric
	 * Surge means Pincurchin sets Electric Terrain on sight, which powers up
	 * every Electric move on their team AND blocks sleep on anything grounded --
	 * so a plan built around Spore or Sleep Powder simply does not work, and
	 * without this the search would happily build one. Intimidate cuts your
	 * Attack the turn Manectric arrives, which changes every physical number
	 * after it.
	 */
	var TERRAIN_SETTERS = {
		"Electric Surge": "Electric", "Grassy Surge": "Grassy",
		"Misty Surge": "Misty", "Psychic Surge": "Psychic"
	};
	var WEATHER_SETTERS = {
		"Drizzle": "Rain", "Drought": "Sun", "Sand Stream": "Sand", "Snow Warning": "Snow"
	};

	/**
	 * Protosynthesis and Quark Drive: a third more of the best stat.
	 *
	 * Neither the calculator nor the engine applied these -- measured, not
	 * grepped: a Great Tusk in permanent sun did exactly the same damage with
	 * the ability as without. They appear on 22 trainer Pokemon starting at
	 * GYM LEADER BROCK, and Lt. Surge fields two Quark Drive bodies under his
	 * own permanent Electric Terrain, so the engine was fighting a materially
	 * weaker opponent than the game does at both ends of the run.
	 *
	 * MODELLED AS ONE BOOST STAGE, WHICH IS AN OVERESTIMATE. The real ability is
	 * 1.3x on the best stat (1.5x if that stat is Speed) and a stage is 1.5x, so
	 * this hands the opponent slightly more than they get. That is the direction
	 * to be wrong in: a planner that exists to avoid losing a Pokemon should
	 * overestimate what it is up against, and the alternative -- inventing a
	 * multiplier the boost system does not have -- would mean teaching every
	 * damage path a new concept for one ability.
	 */
	var PARADOX = {
		"Protosynthesis": function (state) { return state.field.weather === "Sun"; },
		"Quark Drive": function (state) { return state.field.terrain === "Electric"; }
	};

	function applyParadoxBoost(state, mon) {
		var rule = PARADOX[mon.set.ability];
		if (!rule) return;
		// Booster Energy fires it with no weather or terrain at all, which is
		// exactly why trainers hold one.
		var held = !mon.itemGone && mon.set.item === "Booster Energy";
		if (!rule(state) && !held) return;
		if (mon.volatiles.paradox) return;   // it only ever fires once
		var stats;
		try { stats = toCalcPokemon(mon).stats; } catch (e) { return; }
		if (!stats) return;
		var best = null, bestValue = -1;
		["atk", "def", "spa", "spd", "spe"].forEach(function (stat) {
			if (stats[stat] > bestValue) { bestValue = stats[stat]; best = stat; }
		});
		if (!best) return;
		mon.volatiles.paradox = best;
		var boost = {};
		boost[best] = 1;
		applyBoosts(mon, boost);
		if (held) mon.itemGone = true;
	}

	// Weather-extending held items, five turns to eight.
	var WEATHER_ROCKS = {
		"Sun": "Heat Rock", "Rain": "Damp Rock",
		"Sand": "Smooth Rock", "Hail": "Icy Rock", "Snow": "Icy Rock"
	};

	function applyEntryAbility(state, key) {
		var side = state[key];
		var mon = active(side);
		if (mon.fainted) return;
		var ability = mon.set.ability;
		if (!ability) return;

		applyParadoxBoost(state, mon);

		var terrain = TERRAIN_SETTERS[ability];
		if (terrain) {
			state.field.terrain = terrain;
			// Five turns, eight with Terrain Extender. Standard mechanics.
			//
			// This used to set Infinity for anything the AI put down, on the
			// grounds that "Restricted mode makes terrain the AI sets
			// permanent". That is not a mechanic. Restricted/Minimal Grinding
			// is a rule about how the PLAYER is allowed to prepare -- items and
			// grinding -- and it has nothing to do with how long a terrain
			// lasts. James, who plays this game, corrected it: Pincurchin has
			// Electric Surge and sets the terrain on entry like anywhere else,
			// and it expires.
			//
			// The error was not harmless and it ran everywhere, because
			// `rules` defaults to "restricted" in createState. Every fight
			// whose lead sets terrain or weather was simulated with it up for
			// the whole battle, which inflates their damage for the whole
			// battle and, for Electric Terrain, made grounded sleep moves look
			// permanently dead. Both push the same way the rest of this
			// engine's old mistakes did: they make fights look worse than they
			// are.
			state.field.terrainTurns =
				(!mon.itemGone && mon.set.item === "Terrain Extender" ? 8 : 5);
		}
		var weather = WEATHER_SETTERS[ability];
		if (weather) {
			state.field.weather = weather;
			// Five turns, or eight with the matching rock, same as terrain.
			state.field.weatherTurns =
				(!mon.itemGone && WEATHER_ROCKS[weather] === mon.set.item) ? 8 : 5;
		}
		if (ability === "Intimidate") {
			var foe = active(state[other(key)]);
			if (foe && !foe.fainted) applyBoosts(foe, {atk: -1});
		}
	}

	/**
	 * Abilities that fire on the way OUT.
	 *
	 * Regenerator is the reason a switch cycle is a strategy rather than a
	 * retreat: a third of max HP back every time you pivot. Without it the
	 * search reads switching as pure damage taken, which is why it could not
	 * see the Lanturn plan -- bait an Electric move to heal Lanturn, pivot to
	 * Mienshao for anything else, and heal that on the way out too.
	 */
	function applyExitAbility(state, key, mon) {
		if (!mon || mon.fainted) return;
		if (mon.set.ability === "Regenerator") {
			heal(mon, mon.maxHP / 3);
		} else if (mon.set.ability === "Natural Cure") {
			mon.status = null;
			mon.sleepTurns = 0;
			mon.toxicCounter = 0;
		}
	}

	/**
	 * Send in a replacement for something that just fainted.
	 *
	 * This is NOT a turn. A Pokemon faints, its replacement arrives at the end
	 * of that turn, and both sides act normally on the next one. Modelling the
	 * replacement as that side's action gave the player a free turn on every
	 * knockout -- five of them against a five-Pokemon gym -- and inflated every
	 * plan built on it.
	 *
	 * Who comes in is a real decision and it is picked here rather than
	 * searched: whatever survives the most and hits back hardest. That is a
	 * simplification on the player's side and it is worth knowing about.
	 */
	function chooseReplacement(state, key) {
		var side = state[key];

		// The OPPONENT does not play a Nuzlocke, and until now this heuristic
		// was applied to both sides, which meant their replacement was invented
		// rather than modelled. That produced the one confirmed real-game miss
		// this project has: Pincurchin fainted and the game sent Bellibolt where
		// we predicted Vikavolt, voiding every turn of the plan after it.
		//
		// rr-ai-switching.js is a transcription of the real routine
		// (CalcMostSuitableMonToSwitchInto), so use it for their side. Its top
		// pick is taken here because `step` needs one concrete successor; the
		// full distribution, including the coin flips, is available to callers
		// through RRAISwitching.predict.
		//
		// Honest status: the port does NOT yet reproduce the Bellibolt
		// observation. It ranks Vikavolt 19, Manectric 18, Bellibolt 17 in that
		// position, so all three sit within two points and a small modelling
		// error moves the answer. It is still a large improvement on scoring
		// their choice by OUR objective, and tools/test_switching.js pins the
		// failure so it cannot be quietly forgotten.
		if (key === "foe" && typeof RRAISwitching !== "undefined") {
			try {
				var predicted = RRAISwitching.predict(state, "foe");
				if (predicted && predicted.distribution.length) {
					return predicted.distribution[0].index;
				}
			} catch (e) { /* fall through to the heuristic below */ }
		}

		var best = -1, bestScore = -Infinity;
		// Swap the active index and put it back rather than cloning the whole
		// state per candidate. Nothing below mutates -- damageRolls and
		// legalActions only read -- and cloning here was the single most
		// expensive thing in the entire search: a CPU profile put 52.6% of
		// runtime inside clone(), and this loop is where most of those calls
		// came from, up to six full state copies every time something faints.
		// The identical mistake was already fixed once in rr-ai.js.
		var wasActive = side.active;
		for (var i = 0; i < side.team.length; i++) {
			if (side.team[i].fainted) continue;
			side.active = i;
			var mon = side.team[i];
			var worst = 0, hit = 0;
			legalActions(state, other(key)).forEach(function (a) {
				if (a.type !== "move") return;
				var r = damageRolls(state, other(key), a.move);
				if (r && !r.immune) {
					var top = r.noCrit[r.noCrit.length - 1];
					if (top > worst) worst = top;
				}
			});
			legalActions(state, key).forEach(function (a) {
				if (a.type !== "move") return;
				var r = damageRolls(state, key, a.move);
				if (r && !r.immune && r.noCrit[0] > hit) hit = r.noCrit[0];
			});
			// Room to survive matters more than damage: this is a Nuzlocke.
			var score = (mon.curHP - worst) * 2 + hit;
			if (score > bestScore) { bestScore = score; best = i; }
		}
		side.active = wasActive;
		return best;
	}

	function sendReplacements(state) {
		["me", "foe"].forEach(function (key) {
			var side = state[key];
			if (!active(side) || !active(side).fainted) return;
			if (!side.team.some(function (m) { return !m.fainted; })) return;
			var index = chooseReplacement(state, key);
			if (index >= 0) {
				side.active = index;
				side.team[index].turnsOut = 0;
				side.switchCooldown = 1;
				applyHazards(state, key);
				applyEntryAbility(state, key);
			}
		});
	}

	function switchIn(state, key, index) {
		var side = state[key];
		var outgoing = active(side);
		applyExitAbility(state, key, outgoing);
		// Boosts and most volatiles do not survive a switch.
		outgoing.boosts = emptyBoosts();
		outgoing.volatiles = {};
		// Neither does the badly-poisoned counter: Toxic resets to 1/16 when a
		// Pokemon comes back in. Leaving it climbing meant a mon that switched
		// out at 6/16 resumed at 7/16, overstating poison damage on both sides
		// -- and on the opponent's side that flatters the plan.
		outgoing.toxicCounter = outgoing.status === "tox" ? 1 : 0;
		side.active = index;
		side.team[index].turnsOut = 0;
		// CFRU's ShouldSwitch bails immediately on switchingCooldown, so a
		// Pokemon that just came in will not be pulled straight back out.
		side.switchCooldown = 1;
		applyHazards(state, key);
		applyEntryAbility(state, key);
	}


	// ----------------------------------------------------------- chance model

	/**
	 * The solver asks for one of three readings of the dice.
	 *
	 *   "worst"    every coin lands against the player. A win under this reading
	 *              is a genuine guarantee, which is the whole point of proof
	 *              mode, and it is deliberately brutal: a move that can miss is
	 *              assumed to miss.
	 *   "expected" the middle damage roll, no crits, secondaries do not fire.
	 *              One successor, useful for ranking rather than proving.
	 *   "branch"   hit/miss and secondary/no-secondary become real branches with
	 *              real probabilities. Damage still collapses to its extremes so
	 *              the successor count stays bounded.
	 */
	function against(ctx, key) {
		// True when this side's luck should be read as bad for the player.
		return ctx.mode === "worst" && key === "me";
	}

	/**
	 * Not every coin can be flipped against you.
	 *
	 * Assumptions that hurt you (their crit, their max roll, their secondary
	 * landing) can be taken at face value: they only make a proof stronger.
	 * But some checks are re-rolled every single turn, and reading THOSE
	 * against you compounds to impossibility. Full paralysis is 25% a turn, so
	 * "paralysed every turn forever" makes any position containing paralysis
	 * permanently unprovable, which is how a level 45 Blastoise ended up unable
	 * to beat a level 13 Geodude: one Spark and it never moved again.
	 *
	 * So per-turn re-rolls that must go YOUR way to make the line work are
	 * assumed to go your way, and their probability is multiplied into
	 * state.reliability instead. A proof then reads "wins under worst-case
	 * damage and crits, and holds with probability at least R", which is a claim
	 * that can actually be earned, rather than one that can never be.
	 */
	function assume(state, probability) {
		if (probability >= 1) return;
		state.reliability *= probability;
	}
	function forr(ctx, key) {
		return ctx.mode === "worst" && key === "foe";
	}

	/**
	 * Odds mode: enumerate the turn's coin flips instead of assuming them.
	 *
	 * A decision is reached by re-running the turn along a fixed prefix of
	 * earlier choices. When the run reaches a decision the prefix does not
	 * cover, it records the options and aborts; the caller then re-runs once per
	 * option. Re-running is cheap because damage is cached, and it keeps the
	 * turn logic in one place rather than forking it per mode.
	 *
	 * `pessimistic` names the option to take once the fork budget runs out.
	 * Collapsing onto it with probability 1 understates your chances, so the
	 * result stays a lower bound rather than becoming an estimate.
	 */
	var ABORT = {abort: true};

	function flip(ctx, options, pessimistic) {
		if (ctx.cursor < ctx.path.length) {
			return options[ctx.path[ctx.cursor++]].value;
		}
		if (ctx.forks >= ctx.forkBudget) {
			ctx.collapsed = true;
			return options[pessimistic].value;
		}
		ctx.fork = options;
		throw ABORT;
	}

	/**
	 * Split a damaging hit into "it faints" and "it survives", with the faint
	 * probability computed exactly from the 16 rolls and the crit rate.
	 *
	 * The faint chance is the decision-relevant part and it is exact. The
	 * surviving HP is read pessimistically for the player in both directions:
	 * when you attack, the survivor keeps the most HP it could; when they
	 * attack, you keep the least. That is what makes the final number a floor.
	 */
	function damageOutcomes(rolls, targetHP, attackerKey) {
		var outcomes = RRCritKO.outcomesFor(rolls.noCrit, rolls.crit, rolls.critChance);
		var faintP = 0, survivors = [];
		for (var i = 0; i < outcomes.length; i++) {
			if (outcomes[i][0] >= targetHP) faintP += outcomes[i][1];
			else survivors.push(outcomes[i][0]);
		}
		var options = [];
		if (faintP > 0) options.push({p: faintP, value: targetHP});
		if (survivors.length) {
			var dealt = attackerKey === "me"
				? Math.min.apply(null, survivors)      // they keep the most HP
				: Math.max.apply(null, survivors);     // you keep the least
			options.push({p: 1 - faintP, value: dealt});
		}
		if (!options.length) options.push({p: 1, value: 0});
		// Pessimistic index: the survive branch when it exists, else the faint.
		return {options: options, pessimistic: options.length > 1 ? 1 : 0};
	}

	function pickRolls(rolls, ctx, key) {
		if (ctx.mode === "worst") {
			return key === "me" ? rolls.noCrit[0] : rolls.crit[rolls.crit.length - 1];
		}
		if (ctx.mode === "maxroll") {
			// Both sides roll high, no crits. Deterministic, so the tree has no
			// chance nodes at all.
			//
			// Reading YOUR damage at the minimum instead was too pessimistic to
			// plan with: Fake Out plus Drain Punch takes Loudred to 2 HP on the
			// low roll and kills it on nearly every other, so the route avoided
			// a line that works in practice. `cautious` restores the low reading
			// for when the question is safety rather than route-finding.
			// `roll` picks where on the range to read. Planning on the high roll
			// builds lines that need luck: a Drain Punch that KOs Pincurchin
			// only 10% of the time still looked like a kill, and the whole plan
			// downstream was built on it. "median" is what a plan should assume
			// happens; the real odds are reported separately per step.
			var pick = ctx.risks.roll || "max";
			var band = rolls.noCrit;
			if (key === "foe" && ctx.risks.crit) band = rolls.crit;
			if (key === "me" && ctx.risks.cautious) return band[0];
			if (pick === "median") return band[Math.floor(band.length / 2)];
			if (pick === "min") return band[0];
			return band[band.length - 1];
		}
		return rolls.noCrit[Math.floor(rolls.noCrit.length / 2)];
	}

	function accuracyOf(state, key, moveName) {
		var data = moveData(moveName);
		if (!data || data.accuracy === null) return 1;
		var attacker = active(state[key]);
		var defender = active(state[other(key)]);
		if (data.effect && data.effect.neverMissesFrom &&
			typesOf(attacker).indexOf(data.effect.neverMissesFrom) >= 0) {
			return 1;
		}
		var stage = Math.max(-6, Math.min(6,
			(attacker.boosts.acc || 0) - (defender.boosts.eva || 0)));
		return Math.min(1, (data.accuracy / 100) * ACC_STAGES[stage + 6]);
	}

	// ------------------------------------------------------- effect dispatch

	function targetMon(state, key, target) {
		if (target === "self") return active(state[key]);
		return active(state[other(key)]);
	}

	/** Returns true when the effect was simulated, false when it was not. */
	function applyEffect(state, key, moveName, effect, ctx) {
		var data = moveData(moveName);
		var side = state[key];
		var foeSide = state[other(key)];
		var self = active(side);
		var foe = active(foeSide);

		switch (effect.kind) {
		case "boost":
			applyBoosts(targetMon(state, key, effect.target), effect.boosts);
			return true;
		case "boostCost":
			if (effect.hpCost) damage(self, self.maxHP * effect.hpCost);
			if (!self.fainted) applyBoosts(self, effect.boosts);
			if (effect.trapsSelf) self.volatiles.trapped = true;
			return true;
		case "status":
			setStatus(targetMon(state, key, effect.target || "foe"), effect.status,
				state, data && data.type);
			return true;
		case "heal":
			var fraction = effect.fraction;
			if (effect.sunFraction && state.field.weather === "Sun") fraction = effect.sunFraction;
			else if (effect.sandFraction && state.field.weather === "Sand") fraction = effect.sandFraction;
			else if (effect.otherWeatherFraction && state.field.weather) fraction = effect.otherWeatherFraction;
			heal(self, self.maxHP * fraction);
			return true;
		case "rest":
			self.curHP = self.maxHP;
			self.status = "slp";
			self.sleepTurns = effect.sleepTurns || 2;
			return true;
		case "hazard":
			var current = foeSide.hazards[effect.hazard] || 0;
			foeSide.hazards[effect.hazard] = Math.min(effect.maxLayers || 1, current + 1);
			return true;
		case "screen":
			if (effect.requiresWeather && state.field.weather !== effect.requiresWeather) return true;
			side.screens[effect.screen] = effect.turns;
			return true;
		case "weather":
			state.field.weather = effect.weather;
			// Restricted mode: weather the AI sets never expires.
			state.field.weatherTurns =
				(key === "foe" && state.rules === "restricted") ? Infinity : effect.turns;
			return true;
		case "room":
			state.field.trickRoom = state.field.trickRoom > 0 ? 0 : effect.turns;
			return true;
		case "protect":
			// Protect and Detect fail when used twice running. Without this the
			// planner found an infinite stall: Detect every turn, which also
			// blocks the opponent's Volt Switch, so neither side could do
			// anything and five turns of a plan evaporated.
			if (self.volatiles.protectChain > 0) {
				self.volatiles.protectChain = 0;
				return true;   // the move happens, and fails
			}
			self.volatiles.protecting = true;
			self.volatiles.protectChain = 1;
			return true;
		case "substitute":
			var cost = Math.floor(self.maxHP * effect.hpCost);
			if (self.curHP > cost) {
				damage(self, cost);
				self.volatiles.substitute = cost;
			}
			return true;
		case "leechSeed":
			if (typesOf(foe).indexOf("Grass") < 0) foe.volatiles.leechSeed = true;
			return true;
		case "haze":
			self.boosts = emptyBoosts();
			foe.boosts = emptyBoosts();
			return true;
		case "taunt":
			foe.volatiles.taunt = effect.turns;
			return true;
		case "encore":
			foe.volatiles.encore = effect.turns;
			return true;
		case "confuseBoost":
			applyBoosts(foe, effect.boosts);
			foe.volatiles.confused = 3;
			return true;
		case "yawn":
			if (!foe.status && canTakeStatus(foe, "slp", state)) foe.volatiles.yawn = 2;
			return true;
		case "strengthSap":
			var stolen = toCalcPokemon(foe).stats.atk;
			heal(self, stolen);
			applyBoosts(foe, effect.boosts);
			return true;
		case "selfDebuff":
			applyBoosts(self, effect.boosts);
			return true;
		case "removeItem":
			foe.itemGone = true;
			return true;
		case "breakScreens":
			foeSide.screens = {};
			return true;
		case "focusEnergy":
			self.volatiles.focusEnergy = true;
			return true;
		case "defog":
			// Clears hazards from BOTH sides, and screens from theirs.
			side.hazards = {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0};
			foeSide.hazards = {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0};
			foeSide.screens = {};
			// Restricted mode: terrain removal does not work, so terrain is left
			// alone rather than cleared.
			if (state.rules !== "restricted") state.field.terrain = null;
			return true;
		case "healBell":
			side.team.forEach(function (mon) {
				mon.status = null; mon.sleepTurns = 0; mon.toxicCounter = 0;
			});
			return true;
		case "rapidSpin":
			side.hazards = {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0};
			self.volatiles.leechSeed = false;
			// Restricted mode removes the Speed boost, which is the ruleset in use.
			if (state.rules !== "restricted") applyBoosts(self, {spe: 1});
			return true;
		case "torment":
			foe.volatiles.torment = true;
			return true;
		case "disable":
			foe.volatiles.disabled = 4;
			return true;
		case "identify":
			// Odor Sleuth / Foresight: resets the target's evasion. The
			// type override that lets Normal hit Ghost is not modelled.
			foe.boosts.eva = 0;
			return true;
		case "psychUp":
			for (var stat in foe.boosts) {
				if (Object.prototype.hasOwnProperty.call(foe.boosts, stat)) {
					self.boosts[stat] = foe.boosts[stat];
				}
			}
			return true;
		case "noop":
			return true;
		default:
			return false;
		}
	}

	// -------------------------------------------------------- move execution

	/**
	 * Abilities that cancel recoil.
	 *
	 * Found by auditing what the trainers in the WHOLE game carry rather than
	 * the nine benchmark battles, which is how it stayed hidden: nothing before
	 * the Surge cap has one. Sixteen trainer Pokemon do, starting in the Kanto
	 * rematches, and three of them are Mega Aggron.
	 *
	 * The consequence was not a rounding error. Head Smash recoils for half the
	 * damage dealt, so the engine had Mega Aggron beating itself to death over a
	 * few turns, and the search would happily return a "clean line" whose real
	 * content was waiting for an opponent that never actually dies. Magic Guard
	 * is here for the same reason -- it blocks every source of indirect damage,
	 * of which recoil is one.
	 */
	var NO_RECOIL = {"Rock Head": true, "Magic Guard": true};

	/** Abilities that hurt whatever touches them, for an eighth of max HP. */
	var SPIKY_SKIN = {"Iron Barbs": true, "Rough Skin": true};

	function note(state, text) {
		if (state.unmodelled.indexOf(text) < 0) state.unmodelled.push(text);
	}

	function executeMove(state, key, action, ctx) {
		var attacker = active(state[key]);
		var defenderSide = state[other(key)];
		var defender = active(defenderSide);
		if (attacker.fainted || defender.fainted) return;

		// Flinching only works on someone who has not moved yet, which is why it
		// is checked here and set below rather than at the end of the turn.
		if (attacker.volatiles.flinched) {
			attacker.volatiles.flinched = false;
			attacker.volatiles.moved = true;
			return;
		}
		attacker.volatiles.moved = true;

		// Sleep. Worst case for the player is waking as late as possible.
		if (attacker.status === "slp") {
			if (attacker.sleepTurns > 0) {
				attacker.sleepTurns--;
				if (attacker.sleepTurns > 0 || against(ctx, key)) return;
				attacker.status = null;
			} else {
				attacker.status = null;
			}
		}
		if (attacker.status === "par") {
			if (ctx.mode === "maxroll") {
				// Speed is already halved through the calculator. A full
				// paralysis skip is budgeted: it costs you a fixed number of
				// turns across the fight, not every turn, because paralysed
				// forever is a state nothing escapes.
				if (ctx.risks.paralysis && key === "me" &&
					state.luckSpent.paralysis < (ctx.risks.paralysis === true
						? 1 : ctx.risks.paralysis)) {
					state.luckSpent.paralysis++;
					return;
				}
			} else if (ctx.mode === "odds") {
				if (!flip(ctx, [{p: 0.75, value: true}, {p: 0.25, value: false}],
					key === "me" ? 1 : 0)) return;
			} else if (ctx.mode === "worst") {
				if (key === "me") {
					// 25% full paralysis, re-rolled every turn. Assumed to go
					// your way at a cost; taken against you it would never
					// resolve.
					assume(state, 0.75);
				}
				// Theirs LANDS. The old code returned here, on the reasoning
				// that "their paralysis stopping them would only help you" --
				// which is true, and is exactly why a worst-case mode must not
				// assume it. It meant a paralysed opponent never moved again, so
				// a plan opening with Thunder Wave read as though the fight were
				// over. Measured: a paralysed Machamp's Close Combat did 0
				// damage in worst mode and 330 in maxroll.
			} else {
				return;
			}
		}

		var moveName = action.move;
		var data = moveData(moveName);
		if (action.index >= 0 && attacker.pp[action.index] !== undefined) {
			attacker.pp[action.index]--;
		}
		if (!data) { note(state, "unknown move: " + moveName); return; }

		if (data.effect && (data.effect.firstTurnOnly ||
			data.effect.kind === "firstTurnOnly") && attacker.turnsOut > 0) {
			return;   // Fake Out and First Impression only work on the way in
		}

		if (data.effect && data.effect.kind === "unsupported") {
			note(state, moveName + " is not simulated (" + data.effect.why + ")");
			return;
		}

		if (defender.volatiles.protecting && !(data.effect && data.effect.breaksProtect)) {
			return;
		}

		// Accuracy is also re-rolled every turn, so it is priced, not assumed
		// away. A 70% move used four times is not a 70% line.
		var accuracy = accuracyOf(state, key, moveName);
		if (accuracy < 1) {
			if (ctx.mode === "maxroll") {
				// Their moves always land; yours miss only as many times as the
				// luck budget allows.
				if (ctx.risks.miss && key === "me" &&
					state.luckSpent.miss < (ctx.risks.miss === true ? 1 : ctx.risks.miss)) {
					state.luckSpent.miss++;
					return;
				}
			} else if (ctx.mode === "odds") {
				if (!flip(ctx, [{p: accuracy, value: true},
					{p: 1 - accuracy, value: false}], key === "me" ? 1 : 0)) return;
			} else if (ctx.mode === "worst") {
				if (key === "me") assume(state, accuracy);
				// Theirs LANDS, for the same reason as paralysis above. The old
				// code skipped the foe's move entirely, so in the one mode that
				// exists to assume the worst, every inaccurate enemy move was
				// treated as harmless. Measured: Dynamic Punch did 0 damage in
				// worst mode against 330 in maxroll, so a Focus Blast or Stone
				// Edge attacker read as no threat at all and the search would
				// happily "prove" a clean sweep past it.
			} else {
				return;
			}
		}

		// Any other move breaks the Protect chain.
		if (!(data.effect && data.effect.kind === "protect")) {
			attacker.volatiles.protectChain = 0;
		}

		if (data.split === "Status") {
			var effect = data.effect;
			// Magic Bounce sends a status move straight back at whoever used it.
			// This is the gap that could make a plan actively harmful rather
			// than merely wrong: the search lines up Sleep Powder on an Alakazam
			// and the Pokemon that falls asleep is yours. Applying the effect
			// with the sides swapped is exactly that, because every effect is
			// already written in terms of "the side acting" and "the other one".
			//
			// Only moves aimed at the opponent bounce. Swords Dance and Recover
			// target the user and are untouched, which is what `effect.target`
			// distinguishes.
			// Only moves aimed at the OPPONENT bounce, and working that out from
			// `effect.target` alone was wrong in both directions: most
			// self-targeting effects (Rest, Substitute, Protect, Defog, Haze)
			// carry no `target` field at all and so defaulted to "foe", while
			// hazards carry "foeSide" and were skipped -- and hazards are the
			// thing Magic Bounce most famously reflects. Measured against an
			// Espeon: our Rest healed THEM to full, our Substitute appeared on
			// THEIR side, and our Stealth Rock landed normally.
			//
			// The move's own target field is the reliable signal, so this reads
			// that instead of the effect's.
			var aimedAtThem = data.target === undefined ||
				data.target === 0 || data.target === "selected" ||
				data.target === "foeSide" || data.target === "allFoes";
			var selfEffect = effect && (effect.target === "self" ||
				effect.kind === "heal" || effect.kind === "protect" ||
				effect.kind === "substitute" || effect.kind === "rest");
			var actingKey = key;
			if (effect && defender.set.ability === "Magic Bounce" &&
				aimedAtThem && !selfEffect && !defender.fainted) {
				actingKey = other(key);
				note(state, moveName + " was bounced back by Magic Bounce");
			}
			if (!effect || !applyEffect(state, actingKey, moveName, effect, ctx)) {
				note(state, moveName + " has an effect the simulator does not apply" +
					(effect ? " (" + effect.kind + ")" : ""));
			}
			return;
		}

		// Damage.
		var rolls = damageRolls(state, key, moveName);
		if (!rolls) { note(state, "no damage array for " + moveName); return; }

		// An absorbing ability turns the hit into a gain rather than a nothing.
		var absorbed = absorbs(defender, data.type);
		if (absorbed && rolls.immune) {
			if (absorbed.heals) heal(defender, defender.maxHP / 4);
			if (absorbed.boosts) applyBoosts(defender, absorbed.boosts);
			return;
		}
		var dealt;
		if (ctx.mode === "odds" && !rolls.immune) {
			var split = damageOutcomes(rolls, defender.curHP, key);
			dealt = flip(ctx, split.options, split.pessimistic);
		} else {
			dealt = pickRolls(rolls, ctx, key);
		}

		// Charge, which Electromorphosis hands out for free every time its
		// holder is hit. It doubles the next Electric move, and neither the
		// engine nor the calculator knew about it -- so Bellibolt, which stands
		// in the Lt. Surge fight this save is about to play, was throwing
		// Electric moves at half the power it really has. Underestimating what
		// the opponent does to you is the direction that ends runs.
		//
		// Applied to the damage rather than the move's power because the
		// calculator has no concept of being charged. Doubling damage is a
		// shade more than doubling power, the formula having constant terms, so
		// this errs very slightly toward a stronger opponent.
		if (attacker.volatiles.charged && data.type === "Electric") {
			dealt = dealt * 2;
			attacker.volatiles.charged = false;
		}

		// A substitute absorbs the DAMAGE. It does not absorb what the move did
		// to its user: recoil, drain, Life Orb, self-KO, self-debuff and pivoting
		// all still happen through one. Returning here skipped every one of
		// them, which brought back the exact bug the selfKO code was written to
		// fix -- Weezing's Explosion into a substitute left Weezing alive at 113
		// HP, and a U-turn into one did not switch.
		//
		// Contact punishment IS correctly skipped, since nothing touched the
		// Pokemon itself, so that stays inside the guard below.
		var hitSubstitute = false;
		if (defender.volatiles.substitute) {
			var sub = defender.volatiles.substitute;
			if (dealt >= sub) { delete defender.volatiles.substitute; }
			else { defender.volatiles.substitute = sub - dealt; }
			hitSubstitute = true;
		}
		if (!hitSubstitute) {

		var wouldFaint = dealt >= defender.curHP;
		var atFull = defender.curHP === defender.maxHP;
		// Survival items and Sturdy. Unmodelled, these turn a real 2HKO into a
		// false OHKO and a "guarantee" into a lie.
		if (wouldFaint && atFull) {
			if (defender.set.ability === "Sturdy" ||
				(!defender.itemGone && defender.set.item === "Focus Sash")) {
				// A multi-hit move arrives here as one summed lump, so this
				// clamp used to fire once for the whole sequence and leave the
				// target alive at 1 HP -- a Skill Link Icicle Spear "survived"
				// by a full-HP Focus Sash Ninjask. In the real game the sash
				// breaks on the first hit and the remaining hits kill.
				//
				// Rather than re-simulate each hit, the survival is granted only
				// against the FIRST hit's share and the rest is applied after.
				// Wrong in the safe direction if anything, since it never lets a
				// sash save a Pokemon it would not really save.
				var hits = (rolls && rolls.hits) || 1;
				if (hits > 1) {
					var perHit = dealt / hits;
					var survived = defender.curHP - 1;
					dealt = Math.min(dealt, Math.max(survived,
						survived + (dealt - perHit)));
				} else {
					dealt = defender.curHP - 1;
				}
				if (defender.set.item === "Focus Sash") defender.itemGone = true;
			}
		}
		damage(defender, dealt);
		}

		// Electromorphosis charges its holder whenever it is hit by a damaging
		// move, whether or not the hit did much.
		if (dealt > 0 && !hitSubstitute && !defender.fainted &&
			defender.set.ability === "Electromorphosis") {
			defender.volatiles.charged = true;
		}

		// Recoil and drain come from the calculator, not from hand-written data.
		var mech = data.mechanics || {};
		if (mech.recoil && !attacker.fainted && !NO_RECOIL[attacker.set.ability]) {
			damage(attacker, dealt * (mech.recoil[0] / mech.recoil[1]));
		}
		if (mech.drain) heal(attacker, dealt * (mech.drain[0] / mech.drain[1]));
		// Life Orb costs a tenth of maximum HP on every attack that connects.
		// The calculator already applies its damage bonus, so without this the
		// engine gave sixty-seven trainer Pokemon the upside and none of the
		// cost -- they came out tougher than they are, which loses winnable
		// fights rather than losing runs, but is wrong either way. Magic Guard
		// blocks it, as with every other indirect source.
		// Magic Guard blocks Life Orb; Rock Head does NOT -- it only stops a
		// move's own recoil. Reusing NO_RECOIL here gave Rock Head an immunity
		// it does not have.
		if (rolls && dealt > 0 && !attacker.fainted &&
			!attacker.itemGone && attacker.set.item === "Life Orb" &&
			attacker.set.ability !== "Magic Guard") {
			damage(attacker, attacker.maxHP / 10);
		}
		// Iron Barbs and Rough Skin bite back at anything that touches them, for
		// an eighth of its maximum HP. Unmodelled, this is chip damage on YOUR
		// side that the search never accounts for -- so a Pokemon it believes
		// finishes a fight at a sliver of health actually finishes it dead.
		// Magic Guard blocks it, being indirect damage like recoil.
		// Weakness Policy: two stages of both attacking stats, the moment a super
		// effective hit lands. Unmodelled, the search believed a Pokemon it had
		// just hit for double stayed as weak as before -- which is the direction
		// that flatters the opponent's victim rather than the opponent, and so
		// the direction that ends runs.
		if (rolls && dealt > 0 && !defender.fainted && !defender.itemGone &&
			defender.set.item === "Weakness Policy" &&
			typeMultiplier(defender, data.type) > 1) {
			defender.itemGone = true;
			applyBoosts(defender, {atk: 2, spa: 2});
		}
		// Same again: Magic Guard ignores contact punishment, Rock Head does not.
		if (rolls && rolls.contact && !hitSubstitute && !attacker.fainted &&
			attacker.set.ability !== "Magic Guard" &&
			(SPIKY_SKIN[defender.set.ability] ||
				(!defender.itemGone && defender.set.item === "Rocky Helmet"))) {
			damage(attacker, attacker.maxHP / 8);
		}
		// Self-Destruct and friends take the user with them. Missing this let the
		// exact search "prove" a clean run through Surge in which Weezing used
		// Self-Destruct on turn 17 and switched out on turn 18.
		if (mech.selfKO) {
			attacker.curHP = 0;
			attacker.fainted = true;
		}

		// Secondary effect.
		var secondary = data.effect && data.effect.secondary;
		if (secondary && !defender.fainted) {
			var chance = data.secondaryChance;
			// Serene Grace doubles it, which turns a 30% flinch into 60% and a
			// Togekiss or Jirachi from an annoyance into the thing that ends the
			// run. Capped at 100 so a 60% secondary does not become 120% and
			// silently start reading as guaranteed further down.
			if (attacker.set.ability === "Serene Grace" && chance > 0) {
				chance = Math.min(100, chance * 2);
			}
			var fires;
			if (data.effect.guaranteed) {
				fires = true;
			} else if (ctx.mode === "odds" && chance > 0 && chance < 100) {
				fires = flip(ctx, [{p: chance / 100, value: true},
					{p: 1 - chance / 100, value: false}], key === "me" ? 1 : 0);
			} else if (ctx.mode === "odds") {
				fires = chance >= 100;
			} else if (ctx.mode === "maxroll") {
				fires = chance >= 100 || (ctx.risks.secondary && key === "foe");
			} else {
				fires = forr(ctx, key) || (ctx.mode !== "worst" && chance >= 100);
			}
			if (fires) {
				if (secondary.status) setStatus(defender, secondary.status, state);
				if (secondary.boosts) {
					applyBoosts(secondary.target === "self" ? attacker : defender,
						secondary.boosts);
				}
				if (secondary.removeItem) defender.itemGone = true;
				// Only lands if they have not already acted this turn.
				if (secondary.flinch && !defender.volatiles.moved) {
					defender.volatiles.flinched = true;
				}
			}
		}

		checkBerries(defender);

		// Self-inflicted drops on a damaging move: Leaf Storm, Close Combat,
		// Superpower. These are not "secondary effects" in the ROM, so nothing
		// flagged them as missing, and the search happily used Leaf Storm three
		// turns running at full Sp. Atk.
		if (data.effect && data.effect.kind === "selfDebuff" && !attacker.fainted) {
			applyBoosts(attacker, data.effect.boosts);
		}
		if (data.effect && data.effect.kind === "selfSwitch" && !attacker.fainted) {
			if (action.switchTo !== undefined && !state[key].team[action.switchTo].fainted) {
				switchIn(state, key, action.switchTo);
			} else {
				note(state, moveName + " pivots, but there was nobody to switch to");
			}
		}
	}

	/** Pinch berries fire the moment HP crosses their threshold. */
	function checkBerries(mon) {
		if (mon.fainted || mon.itemGone) return;
		var item = mon.set.item;
		if (item === "Sitrus Berry" && mon.curHP <= mon.maxHP / 2) {
			heal(mon, mon.maxHP / 4);
			mon.itemGone = true;
		} else if (item === "Berry Juice" && mon.curHP <= mon.maxHP / 2) {
			heal(mon, 20);
			mon.itemGone = true;
		}
	}

	// ---------------------------------------------------------- end of turn

	var SAND_IMMUNE = ["Rock", "Ground", "Steel"];

	function endOfTurn(state, ctx) {
		["me", "foe"].forEach(function (key) {
			var side = state[key];
			var mon = active(side);
			if (mon.fainted) return;

			// Magic Guard again: sand, burn, poison and Leech Seed all skip it.
			if (mon.set.ability === "Magic Guard") {
				mon.volatiles.protecting = false;
				mon.volatiles.flinched = false;
				mon.volatiles.moved = false;
				mon.turnsOut++;
				if (mon.volatiles.taunt > 0) mon.volatiles.taunt--;
				if (mon.volatiles.encore > 0) mon.volatiles.encore--;
				return;
			}

			if (state.field.weather === "Sand") {
				var types = typesOf(mon);
				var immune = SAND_IMMUNE.some(function (t) { return types.indexOf(t) >= 0; });
				if (!immune) damage(mon, mon.maxHP / 16);
			}
			if (mon.fainted) return;

			// Poison Heal turns being poisoned into a healing engine, which is
			// the entire point of the Toxic Orb it is always paired with. Five
			// trainer Pokemon run it -- three Gliscor and two Breloom -- and
			// without it they take toxic damage instead of gaining an eighth of
			// their health every turn, which is a swing of a quarter of their HP
			// per turn in the direction that flatters us.
			var poisoned = mon.status === "psn" || mon.status === "tox";
			if (poisoned && mon.set.ability === "Poison Heal") {
				heal(mon, mon.maxHP / 8);
			} else if (mon.status === "brn" || mon.status === "frb") {
				damage(mon, mon.maxHP / 16);
			} else if (mon.status === "psn") {
				damage(mon, mon.maxHP / 8);
			} else if (mon.status === "tox") {
				damage(mon, mon.maxHP * mon.toxicCounter / 16);
				mon.toxicCounter++;
			}
			if (mon.fainted) return;

			if (mon.volatiles.leechSeed) {
				// Heal what was actually taken, not what was aimed for. A seeded
				// Pokemon with less than an eighth of its health left was
				// handing the other side the full amount, healing them for HP
				// that never existed.
				var wanted = Math.floor(mon.maxHP / 8);
				var drained = Math.min(wanted, mon.curHP);
				damage(mon, drained);
				var thief = active(state[other(key)]);
				if (!thief.fainted) heal(thief, drained);
			}
			if (!mon.itemGone && mon.set.item === "Leftovers") heal(mon, mon.maxHP / 16);
			checkBerries(mon);

			// Speed Boost, and it belongs here rather than in the damage
			// calculation because what it changes is TURN ORDER. A Sharpedo that
			// is slower than you on turn one is faster from turn two, and every
			// plan built on moving first stops working at the moment the search
			// never noticed. Long fights are exactly where this compounds, and
			// long fights are the ones that are hard.
			//
			// It fires at the end of every turn the Pokemon is still standing.
			// The real rule skips the turn a Pokemon SWITCHED IN, which this does
			// not model, so a switching Sharpedo is credited one stage early. That
			// is deliberate: the error makes the opponent faster than they are,
			// and a planner whose whole job is to not lose a Pokemon should be
			// wrong in the direction that assumes the worst. Guarding on
			// `turnsOut > 0` was tried and is wrong in the commoner case -- it
			// costs a LEAD its first boost, and leads do get one.
			if (mon.set.ability === "Speed Boost" && mon.boosts.spe < 6) {
				mon.boosts.spe++;
			}

			// Flame Orb and Toxic Orb burn or poison their own holder at the end
			// of the turn, and every single trainer carrying one pairs it with an
			// ability that wants the status: Guts, Toxic Boost, Poison Heal.
			// Unmodelled, an Ursaluna that should be hitting at 1.5x through
			// Guts hits at 1x -- the engine was making the opponent weaker than
			// they are, which is the direction that ends runs.
			//
			// Deliberately done together with Poison Heal above: adding the orb
			// alone would have had Gliscor taking toxic damage where the real one
			// heals, which is wrong the same dangerous way.
			if (!mon.itemGone && !mon.status) {
				var orb = mon.set.item === "Flame Orb" ? "brn"
					: mon.set.item === "Toxic Orb" ? "tox" : null;
				if (orb && setStatus(mon, orb, state)) mon.itemGone = true;
			}

			if (mon.volatiles.yawn) {
				mon.volatiles.yawn--;
				if (mon.volatiles.yawn === 0) setStatus(mon, "slp", state);
			}
			mon.volatiles.protecting = false;
			mon.volatiles.flinched = false;
			mon.volatiles.moved = false;
			mon.turnsOut++;
			if (mon.volatiles.taunt > 0) mon.volatiles.taunt--;
			if (mon.volatiles.encore > 0) mon.volatiles.encore--;
		});

		["me", "foe"].forEach(function (key) {
			if (state[key].switchCooldown > 0) state[key].switchCooldown--;
		});

		["me", "foe"].forEach(function (key) {
			var screens = state[key].screens;
			for (var name in screens) {
				if (!Object.prototype.hasOwnProperty.call(screens, name)) continue;
				screens[name]--;
				if (screens[name] <= 0) delete screens[name];
			}
		});

		if (state.field.weatherTurns !== Infinity && state.field.weatherTurns > 0) {
			if (--state.field.weatherTurns === 0) state.field.weather = null;
		}
		if (state.field.terrainTurns !== Infinity && state.field.terrainTurns > 0) {
			if (--state.field.terrainTurns === 0) state.field.terrain = null;
		}
		if (state.field.trickRoom > 0) state.field.trickRoom--;
		state.turn++;
	}

	// --------------------------------------------------------------- step

	/** Run one turn to completion along a fixed sequence of coin flips. */
	function runTurn(state, myAction, foeAction, ctx) {
		var next = clone(state);
		var actions = {me: myAction, foe: foeAction};

		var order = turnOrder(next, myAction, foeAction);
		if (!order) {
			// A genuine speed tie. Worst mode hands it to them, since the proof
			// has to survive losing the flip; odds mode calls it properly.
			if (ctx.mode === "odds") {
				order = flip(ctx, [{p: 0.5, value: ["me", "foe"]},
					{p: 0.5, value: ["foe", "me"]}], 1);
			} else {
				order = ["foe", "me"];
			}
		}

		order.forEach(function (key) {
			if (actions[key].type === "switch") switchIn(next, key, actions[key].index);
		});
		order.forEach(function (key) {
			if (actions[key].type === "move") executeMove(next, key, actions[key], ctx);
		});
		if (!isOver(next)) {
			endOfTurn(next, ctx);
			// The replacement arrives now, not on the next turn's action.
			if (!isOver(next)) sendReplacements(next);
		}
		return next;
	}

	/**
	 * Advance one turn. Returns successors whose probabilities sum to 1.
	 *
	 * "worst" and "expected" always give a single successor. "odds" enumerates
	 * the turn's coin flips: it re-runs the turn once per path, forking wherever
	 * a decision has not already been fixed by the prefix. Identical resulting
	 * positions are merged, which collapses a lot of the tree, since most
	 * combinations of misses and rolls land on the same board.
	 */
	function step(state, myAction, foeAction, options) {
		var opts = options || {};
		var mode = opts.mode || "worst";

		if (mode !== "odds") {
			var ctx = {
				mode: mode, cursor: 0, path: [], forks: 0, forkBudget: 0,
				risks: opts.risks || {}
			};
			return [{state: runTurn(state, myAction, foeAction, ctx), probability: 1}];
		}

		var budget = opts.forkBudget === undefined ? 6 : opts.forkBudget;
		var results = [];
		var queue = [{path: [], probability: 1}];
		var guard = 0;

		while (queue.length && guard++ < 512) {
			var item = queue.shift();
			var runCtx = {
				mode: "odds", path: item.path, cursor: 0,
				fork: null, forks: item.path.length, forkBudget: budget,
				collapsed: false
			};
			var next = null;
			try {
				next = runTurn(state, myAction, foeAction, runCtx);
			} catch (e) {
				if (e !== ABORT) throw e;
			}
			if (runCtx.fork) {
				for (var i = 0; i < runCtx.fork.length; i++) {
					if (runCtx.fork[i].p <= 0) continue;
					queue.push({
						path: item.path.concat([i]),
						probability: item.probability * runCtx.fork[i].p
					});
				}
			} else if (next) {
				if (runCtx.collapsed) next.collapsed = true;
				results.push({state: next, probability: item.probability});
			}
		}

		return mergeSuccessors(results);
	}

	/**
	 * Fold successors that reached the same position. Without this the tree
	 * carries duplicates that differ only in which coin produced them, and the
	 * search re-solves each one.
	 */
	function mergeSuccessors(results) {
		var byKey = {};
		var order = [];
		for (var i = 0; i < results.length; i++) {
			var key = positionKey(results[i].state);
			if (byKey[key]) {
				byKey[key].probability += results[i].probability;
			} else {
				byKey[key] = results[i];
				order.push(key);
			}
		}
		return order.map(function (key) { return byKey[key]; });
	}

	/** Everything that distinguishes one position from another. */
	/**
	 * A name for a position, optionally a COARSE one.
	 *
	 * `opts.hpBuckets` rounds every HP down to that many bands instead of
	 * recording it exactly, so positions that differ only by a point or two get
	 * the same name and the second one is never explored. In a twenty-turn fight
	 * HP drifts constantly and almost no position is ever revisited exactly, so
	 * the transposition table has very little to do; bucketing gives it
	 * something.
	 *
	 * IT IS NOT SOUND, and must never be used by a search entitled to conclude.
	 * Two positions in the same band really can differ -- one survives the hit
	 * and the other does not -- so a coarse search can miss a line and would be
	 * lying if it then reported that none exists. It belongs only in a hunt
	 * pass, where a found line is verified by construction (every step of it was
	 * simulated by this engine) and a failure concludes nothing.
	 */
	function positionKey(state, opts) {
		var buckets = (opts && opts.hpBuckets) || 0;
		var parts = [];
		["me", "foe"].forEach(function (sideKey) {
			var side = state[sideKey];
			parts.push(side.active);
			side.team.forEach(function (mon) {
				var hp = buckets
					? Math.floor(mon.curHP / Math.max(1, mon.maxHP) * buckets)
					: mon.curHP;
				parts.push(hp, mon.fainted ? 1 : 0, mon.status || "-",
					mon.sleepTurns, mon.toxicCounter, mon.itemGone ? 1 : 0,
					mon.boosts.atk, mon.boosts.def, mon.boosts.spa, mon.boosts.spd,
					mon.boosts.spe, mon.boosts.acc, mon.boosts.eva,
					mon.pp.join("."),
					mon.volatiles.substitute || 0,
					mon.volatiles.leechSeed ? 1 : 0,
					mon.volatiles.taunt || 0,
					mon.volatiles.confused || 0,
					// Everything below changes what happens next and was
					// missing, which is worse than it sounds: two states with
					// the same key are treated as the SAME POSITION, so
					// mergeSuccessors folds them together and discards one, and
					// the transposition table hands one's result to the other.
					// A branch where you have just been Yawned, or where the foe
					// is Charged and about to double its Electric move, silently
					// became a branch where neither happened.
					mon.volatiles.yawn || 0,
					mon.volatiles.charged ? 1 : 0,
					mon.volatiles.encore || 0,
					mon.volatiles.paradox || "-",
					// Fake Out and First Impression only work on the turn a
					// Pokemon comes in, so a position at turnsOut 0 is not the
					// same problem as the same position later.
					mon.turnsOut > 0 ? 1 : 0);
			});
			parts.push(side.hazards.stealthrock, side.hazards.spikes,
				side.hazards.toxicspikes, side.hazards.stickyweb,
				// Whether a side may switch changes its legal actions, so two
				// positions differing only in this are NOT the same problem.
				// Leaving it out let the transposition table hand a cached
				// result from a switchable position to an unswitchable one, and
				// the proof tree came back with replies it had never covered.
				side.switchCooldown || 0);
			var names = Object.keys(side.screens).sort();
			parts.push(names.map(function (n) { return n + side.screens[n]; }).join(","));
		});
		var f = state.field;
		parts.push(f.weather || "-", f.weatherTurns === Infinity ? "P" : f.weatherTurns,
			f.terrain || "-", f.terrainTurns === Infinity ? "P" : f.terrainTurns,
			f.trickRoom);
		return parts.join("|");
	}

	return {
		step: step,
		createState: createState,
		clone: clone,
		legalActions: legalActions,
		isOver: isOver,
		turnOrder: turnOrder,
		finalSpeed: finalSpeed,
		damageRolls: damageRolls,
		switchIn: switchIn,
		applyHazards: applyHazards,
		applyEntryAbility: applyEntryAbility,
		sendReplacements: sendReplacements,
		chooseReplacement: chooseReplacement,
		applyExitAbility: applyExitAbility,
		active: active,
		other: other,
		moveData: moveData,
		clearCache: clearCache,
		positionKey: positionKey,
		endOfTurn: endOfTurn,
		accuracyOf: accuracyOf,
		_internal: {
			// Exposed so the exact search can ORDER its moves by which ones are
			// free -- absorbing a hit instead of taking it, denying a turn. It
			// reads these, never redefines them: a second copy of the absorb
			// table would drift from this one and the search would order itself
			// by a rule the engine no longer follows.
			absorbs: absorbs,
			ABSORBS: ABSORBS,
			toCalcPokemon: toCalcPokemon,
			buildField: buildField,
			setStatus: setStatus,
			applyBoosts: applyBoosts,
			canTakeStatus: canTakeStatus,
			isGrounded: isGrounded,
			absorbs: absorbs,
			heal: heal,
			damage: damage,
			ACC_STAGES: ACC_STAGES
		}
	};
})();
