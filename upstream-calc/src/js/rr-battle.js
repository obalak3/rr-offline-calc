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
/* global calc, RRCritKO, RR_MOVE_EFFECTS */
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
	}

	function moveData(name) {
		return (typeof RR_MOVE_EFFECTS !== "undefined" && RR_MOVE_EFFECTS.moves[name]) || null;
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
			volatiles: {}     // substitute, leechSeed, taunt, protectChain, ...
		};
	}

	function makeSide(sets) {
		return {
			team: sets.map(makeMon),
			active: 0,
			hazards: {stealthrock: 0, spikes: 0, toxicspikes: 0, stickyweb: 0},
			screens: {}        // name -> turns remaining
		};
	}

	function createState(mySets, foeSets, options) {
		var opts = options || {};
		return {
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
		};
	}

	function clone(state) {
		// Structured clone is not available in every host this runs in, and the
		// state is plain data by construction, so JSON round-trip is safe and
		// fast enough. `set` is shared deliberately: it is never mutated.
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
			move = new calc.Move(gen(), moveName);
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
			hits: arrays.hits
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

	function finalSpeed(state, key) {
		var side = state[key];
		var mon = active(side);
		var field = buildField(state, key);
		try {
			return calc.getFinalSpeed(gen(), toCalcPokemon(mon), field, field.attackerSide);
		} catch (e) {
			return toCalcPokemon(mon).stats.spe;
		}
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

	function canTakeStatus(mon, status) {
		if (mon.status) return false;
		if (mon.volatiles.substitute) return false;
		var immune = STATUS_IMMUNE_TYPES[status];
		if (!immune) return true;
		var types = typesOf(mon);
		for (var i = 0; i < immune.length; i++) {
			if (types.indexOf(immune[i]) >= 0) return false;
		}
		return true;
	}

	function setStatus(mon, status) {
		if (!canTakeStatus(mon, status)) return false;
		mon.status = status;
		if (status === "slp") mon.sleepTurns = 2;
		if (status === "tox") mon.toxicCounter = 1;
		return true;
	}

	function heal(mon, amount) {
		mon.curHP = Math.min(mon.maxHP, mon.curHP + Math.floor(amount));
	}

	function damage(mon, amount) {
		mon.curHP = Math.max(0, mon.curHP - Math.floor(amount));
		if (mon.curHP === 0) mon.fainted = true;
	}

	// --------------------------------------------------------------- hazards

	function applyHazards(state, key) {
		var side = state[key];
		var mon = active(side);
		if (mon.fainted) return;
		var types = typesOf(mon);
		var grounded = types.indexOf("Flying") < 0;

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
			setStatus(mon, side.hazards.toxicspikes >= 2 ? "tox" : "psn");
		}
		if (grounded && side.hazards.stickyweb) {
			applyBoosts(mon, {spe: -1});
		}
	}

	function switchIn(state, key, index) {
		var side = state[key];
		var outgoing = active(side);
		// Boosts and most volatiles do not survive a switch.
		outgoing.boosts = emptyBoosts();
		outgoing.volatiles = {};
		side.active = index;
		applyHazards(state, key);
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
			// Deterministic, so the tree has no chance nodes at all. Each side
			// is still read against you -- they roll high, you roll low -- but
			// crits are OFF unless the caller asks for them. Assuming a crit
			// every turn on top of a max roll is what made everything look
			// unwinnable; here it is a risk you switch on, not a baseline.
			if (key === "me") return rolls.noCrit[0];
			return ctx.risks.crit
				? rolls.crit[rolls.crit.length - 1]
				: rolls.noCrit[rolls.noCrit.length - 1];
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
			setStatus(targetMon(state, key, effect.target || "foe"), effect.status);
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
			self.volatiles.protecting = true;
			self.volatiles.protectChain = (self.volatiles.protectChain || 0) + 1;
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
			if (!foe.status) foe.volatiles.yawn = 2;
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
		case "noop":
			return true;
		default:
			return false;
		}
	}

	// -------------------------------------------------------- move execution

	function note(state, text) {
		if (state.unmodelled.indexOf(text) < 0) state.unmodelled.push(text);
	}

	function executeMove(state, key, action, ctx) {
		var attacker = active(state[key]);
		var defenderSide = state[other(key)];
		var defender = active(defenderSide);
		if (attacker.fainted || defender.fainted) return;

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
			} else if (against(ctx, key)) {
				// 25% full paralysis, re-rolled every turn. Assumed to go your
				// way at a cost; taken against you it would never resolve.
				assume(state, 0.75);
			} else {
				return;   // their paralysis stopping them would only help you
			}
		}

		var moveName = action.move;
		var data = moveData(moveName);
		if (action.index >= 0 && attacker.pp[action.index] !== undefined) {
			attacker.pp[action.index]--;
		}
		if (!data) { note(state, "unknown move: " + moveName); return; }

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
			} else if (against(ctx, key)) {
				assume(state, accuracy);
			} else {
				return;   // their move missing would only help you
			}
		}

		if (data.split === "Status") {
			var effect = data.effect;
			if (!effect || !applyEffect(state, key, moveName, effect, ctx)) {
				note(state, moveName + " has an effect the simulator does not apply" +
					(effect ? " (" + effect.kind + ")" : ""));
			}
			return;
		}

		// Damage.
		var rolls = damageRolls(state, key, moveName);
		if (!rolls) { note(state, "no damage array for " + moveName); return; }
		var dealt;
		if (ctx.mode === "odds" && !rolls.immune) {
			var split = damageOutcomes(rolls, defender.curHP, key);
			dealt = flip(ctx, split.options, split.pessimistic);
		} else {
			dealt = pickRolls(rolls, ctx, key);
		}

		if (defender.volatiles.substitute) {
			var sub = defender.volatiles.substitute;
			if (dealt >= sub) { delete defender.volatiles.substitute; }
			else { defender.volatiles.substitute = sub - dealt; }
			return;
		}

		var wouldFaint = dealt >= defender.curHP;
		var atFull = defender.curHP === defender.maxHP;
		// Survival items and Sturdy. Unmodelled, these turn a real 2HKO into a
		// false OHKO and a "guarantee" into a lie.
		if (wouldFaint && atFull) {
			if (defender.set.ability === "Sturdy" ||
				(!defender.itemGone && defender.set.item === "Focus Sash")) {
				dealt = defender.curHP - 1;
				if (defender.set.item === "Focus Sash") defender.itemGone = true;
			}
		}
		damage(defender, dealt);

		// Recoil and drain come from the calculator, not from hand-written data.
		var mech = data.mechanics || {};
		if (mech.recoil && !attacker.fainted) {
			damage(attacker, dealt * (mech.recoil[0] / mech.recoil[1]));
		}
		if (mech.drain) heal(attacker, dealt * (mech.drain[0] / mech.drain[1]));

		// Secondary effect.
		var secondary = data.effect && data.effect.secondary;
		if (secondary && !defender.fainted) {
			var chance = data.secondaryChance;
			var fires;
			if (ctx.mode === "odds" && chance > 0 && chance < 100) {
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
				if (secondary.status) setStatus(defender, secondary.status);
				if (secondary.boosts) {
					applyBoosts(secondary.target === "self" ? attacker : defender,
						secondary.boosts);
				}
				if (secondary.removeItem) defender.itemGone = true;
			}
		}

		checkBerries(defender);
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

			if (state.field.weather === "Sand") {
				var types = typesOf(mon);
				var immune = SAND_IMMUNE.some(function (t) { return types.indexOf(t) >= 0; });
				if (!immune) damage(mon, mon.maxHP / 16);
			}
			if (mon.fainted) return;

			if (mon.status === "brn" || mon.status === "frb") damage(mon, mon.maxHP / 16);
			else if (mon.status === "psn") damage(mon, mon.maxHP / 8);
			else if (mon.status === "tox") {
				damage(mon, mon.maxHP * mon.toxicCounter / 16);
				mon.toxicCounter++;
			}
			if (mon.fainted) return;

			if (mon.volatiles.leechSeed) {
				var drained = Math.floor(mon.maxHP / 8);
				damage(mon, drained);
				var thief = active(state[other(key)]);
				if (!thief.fainted) heal(thief, drained);
			}
			if (!mon.itemGone && mon.set.item === "Leftovers") heal(mon, mon.maxHP / 16);
			checkBerries(mon);

			if (mon.volatiles.yawn) {
				mon.volatiles.yawn--;
				if (mon.volatiles.yawn === 0) setStatus(mon, "slp");
			}
			mon.volatiles.protecting = false;
			if (mon.volatiles.taunt > 0) mon.volatiles.taunt--;
			if (mon.volatiles.encore > 0) mon.volatiles.encore--;
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
		if (!isOver(next)) endOfTurn(next, ctx);
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
	function positionKey(state) {
		var parts = [];
		["me", "foe"].forEach(function (sideKey) {
			var side = state[sideKey];
			parts.push(side.active);
			side.team.forEach(function (mon) {
				parts.push(mon.curHP, mon.fainted ? 1 : 0, mon.status || "-",
					mon.sleepTurns, mon.toxicCounter, mon.itemGone ? 1 : 0,
					mon.boosts.atk, mon.boosts.def, mon.boosts.spa, mon.boosts.spd,
					mon.boosts.spe, mon.boosts.acc, mon.boosts.eva,
					mon.pp.join("."),
					mon.volatiles.substitute || 0,
					mon.volatiles.leechSeed ? 1 : 0,
					mon.volatiles.taunt || 0,
					mon.volatiles.confused || 0);
			});
			parts.push(side.hazards.stealthrock, side.hazards.spikes,
				side.hazards.toxicspikes, side.hazards.stickyweb);
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
		active: active,
		other: other,
		moveData: moveData,
		clearCache: clearCache,
		positionKey: positionKey,
		endOfTurn: endOfTurn,
		accuracyOf: accuracyOf,
		_internal: {
			toCalcPokemon: toCalcPokemon,
			buildField: buildField,
			setStatus: setStatus,
			applyBoosts: applyBoosts,
			canTakeStatus: canTakeStatus,
			heal: heal,
			damage: damage,
			ACC_STAGES: ACC_STAGES
		}
	};
})();
