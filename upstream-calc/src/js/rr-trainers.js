/**
 * rr-trainers.js -- offline trainer browser for the Radical Red calculator.
 *
 * Adds three things to the stock page, without modifying any of it:
 *   1. a browser for every trainer battle in the community sheet, which fills
 *      the defender slot in one click;
 *   2. a saved "My Team" bar for your own Pokemon;
 *   3. crit-aware KO chances (see rr-critko.js), both for the current 1v1 and
 *      as a matrix of your moves against the whole enemy team.
 *
 * Enemy Pokemon are loaded by registering them as sets in the calculator's own
 * `setdex` and driving its set-selector, so the page applies them through
 * exactly the same code path it uses for any other set. Nothing about the
 * normal calculator is disabled: the defender slot stays fully editable, which
 * is what you want for wild encounters that are not in the sheet.
 */
/* global $, calc, setdex, gen, createPokemon, createField, performCalculations,
          RRCritKO, RR_TRAINER_DATA, pokedex */
(function () {
	"use strict";

	var STORE_TEAM = "rrTeam";
	var STORE_PREFS = "rrPrefs";

	// Our stat keys -> the calculator's legacy keys.
	var STAT_MAP = {hp: "hp", atk: "at", def: "df", spa: "sa", spd: "sd", spe: "sp"};

	// The sheet documents one exception to Minimal Grinding Mode: the Ghost
	// Marowak keeps its 252 HP EVs even with EVs otherwise turned off.
	function isMgmException(battle, mon) {
		return battle.trainer === "GHOST" && mon.species.indexOf("Marowak") === 0;
	}

	/**
	 * Battle effects the sheet notes, and the field controls they correspond to.
	 * An effect cell can name several at once ("DOUBLES + PERMANENT SUN"), so
	 * every pattern is tested against the whole string rather than picking one.
	 */
	var FIELD_EFFECTS = [
		{re: /PERMANENT SUN/, weather: "sun", label: "Sun"},
		{re: /PERMANENT RAIN/, weather: "rain", label: "Rain"},
		{re: /PERMANENT SANDSTORM/, weather: "sand", label: "Sandstorm"},
		{re: /PERMANENT SNOW/, weather: "snow", label: "Snow"},
		{re: /PERMANENT HAIL/, weather: "hail", label: "Hail"},
		{re: /PERMANENT ELECTRIC TERRAIN/, terrain: "electric", label: "Electric Terrain"},
		{re: /PERMANENT GRASSY TERRAIN/, terrain: "grassy", label: "Grassy Terrain"},
		{re: /PERMANENT MISTY TERRAIN/, terrain: "misty", label: "Misty Terrain"},
		{re: /PERMANENT PSYCHIC TERRAIN/, terrain: "psychic", label: "Psychic Terrain"},
		{re: /OMNI-?BOOSTED/, statBoost: true, label: "enemy +1 all stats"},
		// Handled by the Double Battle view below, not by a field control.
		{re: /DOUBLES/, doubles: true, label: "doubles (see Double Battle)"}
	];

	var data = null;
	var prefs = {mgm: false, myLevel: 100, focusEnergy: false, segment: 0,
		applyEffects: true, followCap: true};
	var team = [];
	var currentBattle = null;
	var currentMon = -1;
	var lastEffects = {applied: [], unhandled: []};
	var battleListeners = [];
	var selectionListeners = [];
	// Which enemy Pokemon are on the field: one index in singles, two in doubles.
	var facing = [];

	// ------------------------------------------------------------- storage

	function load(key, fallback) {
		try {
			var raw = window.localStorage.getItem(key);
			return raw ? JSON.parse(raw) : fallback;
		} catch (e) {
			return fallback;
		}
	}

	function save(key, value) {
		try {
			window.localStorage.setItem(key, JSON.stringify(value));
		} catch (e) { /* private browsing, quota -- not worth interrupting for */ }
	}

	// --------------------------------------------------------------- utils

	function esc(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	/** Fixed levels are literal; rematch/postgame levels track your own. */
	function resolveLevel(mon) {
		var level = mon.level;
		if (!level) return prefs.myLevel;
		if (level.type === "fixed") return level.value;
		if (level.type === "relative") {
			return Math.max(1, Math.min(250, prefs.myLevel + (level.offset || 0)));
		}
		return prefs.myLevel;
	}

	function levelLabel(mon) {
		var level = mon.level;
		if (level && level.type === "relative") {
			var sign = level.offset ? (level.offset > 0 ? "+" : "") + level.offset : "";
			return resolveLevel(mon) + " (yours" + sign + ")";
		}
		return String(resolveLevel(mon));
	}

	function toCalcStats(stats) {
		var out = {};
		for (var key in STAT_MAP) {
			if (Object.prototype.hasOwnProperty.call(stats, key)) {
				out[STAT_MAP[key]] = stats[key];
			}
		}
		return out;
	}

	function effectiveEVs(battle, mon) {
		if (!prefs.mgm) return mon.evs;
		var zero = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
		if (isMgmException(battle, mon)) zero.hp = 252;
		return zero;
	}

	// -------------------------------------------------------- battle effects

	/**
	 * Set the Field controls to match a battle's noted effects.
	 *
	 * Returns {applied: [...], unhandled: [...]} so the panel can be honest
	 * about which notes were acted on: things like inverse battles, banned
	 * types or mid-battle transformations have no equivalent in the calculator
	 * and stay purely informational.
	 */
	function applyBattleEffects(battle) {
		var effects = (battle && battle.effects) || [];
		var result = {applied: [], unhandled: []};
		if (!prefs.applyEffects) return result;

		// Reset only what we manage, so switching battles is deterministic
		// rather than accumulating the previous battle's weather.
		$("input[name='weather'][value='']").prop("checked", true);
		$("input[name='terrain']").prop("checked", false);
		$("#StatBoostR").prop("checked", false);

		var text = effects.join(" | ").toUpperCase();
		var weather = null, terrain = null;
		for (var i = 0; i < FIELD_EFFECTS.length; i++) {
			var rule = FIELD_EFFECTS[i];
			if (!rule.re.test(text)) continue;
			if (rule.weather) weather = rule.weather;
			if (rule.terrain) terrain = rule.terrain;
			if (rule.statBoost) $("#StatBoostR").prop("checked", true);
			result.applied.push(rule.label);
		}
		if (weather) $("#" + weather).prop("checked", true);
		if (terrain) $("#" + terrain).prop("checked", true);

		// One change event at the end; each of these is a .calc-trigger.
		$("input[name='weather']").first().change();
		if (terrain) $("#" + terrain).change();

		// Anything the sheet flagged that we could not translate.
		for (var e = 0; e < effects.length; e++) {
			var remainder = effects[e].replace(/^BATTLE EFFECT:\s*/i, "").trim();
			for (var r = 0; r < FIELD_EFFECTS.length; r++) {
				remainder = remainder.replace(FIELD_EFFECTS[r].re, "");
			}
			remainder = remainder.replace(/^[\s+|]+|[\s+|]+$/g, "");
			if (remainder) result.unhandled.push(remainder);
		}
		return result;
	}

	// ------------------------------------------------- loading into a slot

	/** The visible text of a panel's set-selector. */
	function setLabel($slot, id) {
		$slot.find(".select2-container.set-selector .select2-chosen").first().text(id);
	}

	/**
	 * Register a set and select it, letting the page's own handler apply it.
	 */
	function loadIntoSlot(slotId, species, setName, set) {
		if (typeof setdex === "undefined" || !setdex) return false;
		if (!pokedex || !pokedex[species]) {
			window.alert("This build of the calculator has no data for " + species + ".");
			return false;
		}
		if (!setdex[species]) setdex[species] = {};
		set.isCustomSet = true;
		setdex[species][setName] = set;

		var id = species + " (" + setName + ")";
		var $slot = $(slotId);
		var $sel = $slot.find("input.set-selector");

		$sel.val(id);
		// Upstream's .forme change handler derives the current species from the
		// *rendered* select2 label rather than from the input value. Leaving the
		// label stale makes it read the previous species, conclude we switched
		// formes, and overwrite the ability with the new species' default. So
		// update the label before firing change.
		//
		// Do NOT ask select2 to set the value: this widget is attached to an
		// input with no initSelection, so select2 re-renders the label from
		// nothing and puts the previous text back, which is what left panels
		// reading "Chillet" while showing another Pokemon's stats.
		setLabel($slot, id);
		$sel.change();
		setLabel($slot, id);

		// Safety net: several upstream paths reset the ability while applying a
		// set (one of them via a selector typo, ".abilities"), so assert it.
		if (set.ability) {
			var $ability = $slot.find("select.ability");
			if ($ability.children("option[value='" + set.ability + "']").length &&
				$ability.val() !== set.ability) {
				$ability.val(set.ability).change();
			}
		}
		return true;
	}

	function loadEnemy(battle, mon) {
		var set = {
			level: resolveLevel(mon),
			nature: mon.nature || "Serious",
			item: mon.item || "",
			moves: mon.moves.slice(0, 4),
			evs: toCalcStats(effectiveEVs(battle, mon)),
			ivs: toCalcStats(mon.ivs)
		};
		if (mon.ability) set.ability = mon.ability;
		var setName = battle.trainer + (battle.variant ? " / " + battle.variant : "");
		if (loadIntoSlot("#p2", mon.species, setName, set)) {
			// Only the 1v1 table changes here. Re-rendering the whole panel would
			// detach the chip being clicked and discard the battle list; and the
			// matrix depends on the attacker and the enemy team, neither of which
			// this touched, so recomputing it would be pure waste.
			renderCrit();
		}
	}

	/** Build a calc.Pokemon straight from sheet data, for the matrix. */
	function enemyPokemon(battle, mon) {
		var generation = calc.Generations.get(gen);
		var options = {
			level: resolveLevel(mon),
			nature: mon.nature || "Serious",
			evs: toCalcStats(effectiveEVs(battle, mon)),
			ivs: toCalcStats(mon.ivs),
			item: mon.item || undefined,
			moves: mon.moves.slice(0, 4)
		};
		if (mon.ability) options.ability = mon.ability;
		try {
			return new calc.Pokemon(generation, mon.species, options);
		} catch (e) {
			return null;
		}
	}

	// ---------------------------------------------------------- my team

	function snapshotAttacker() {
		var $p = $("#p1");
		var full = $p.find("input.set-selector").val() || "";
		var species = full.indexOf(" (") > 0 ? full.substring(0, full.indexOf(" (")) : full;
		if (!species) return null;
		var evs = {}, ivs = {};
		for (var key in STAT_MAP) {
			var cls = "." + STAT_MAP[key] + " ";
			evs[key] = ~~$p.find(cls + ".evs").val();
			ivs[key] = ~~$p.find(cls + ".ivs").val();
		}
		var moves = [];
		for (var i = 1; i <= 4; i++) {
			var move = $p.find(".move" + i + " select.move-selector").val();
			if (move && move !== "(No Move)") moves.push(move);
		}
		return {
			species: species,
			level: ~~$p.find(".level").val() || 100,
			nature: $p.find(".nature").val() || "Serious",
			ability: $p.find(".ability").val() || "",
			item: $p.find(".item").val() || "",
			moves: moves,
			evs: evs,
			ivs: ivs
		};
	}

	function loadTeamMember(member) {
		var set = {
			level: member.level,
			nature: member.nature,
			item: member.item || "",
			moves: member.moves.slice(0, 4),
			evs: toCalcStats(member.evs),
			ivs: toCalcStats(member.ivs)
		};
		if (member.ability) set.ability = member.ability;
		if (loadIntoSlot("#p1", member.species, "My " + member.species, set)) {
			renderResults();
		}
	}

	// ------------------------------------------------------- crit analysis

	/**
	 * Every move one side would use on the other, with its real crit rate.
	 *
	 * `swap` flips the field for the returning direction, the same way the
	 * calculator does: screens, hazards and terrain are side-specific, so
	 * calculating the opponent's attacks on an unswapped field would credit
	 * your Reflect to them.
	 */
	function analysePair(attackerSel, defender, swap) {
		if (typeof createPokemon !== "function" || !defender) return null;
		var attacker;
		try {
			attacker = createPokemon($(attackerSel));
		} catch (e) {
			return null;
		}
		if (!attacker || !attacker.name) return null;
		var field;
		try {
			field = createField();
			if (swap && field.clone) field = field.clone().swap();
		} catch (e) {
			field = new calc.Field();
		}
		var generation = calc.Generations.get(gen);
		var bonus = prefs.focusEnergy ? 2 : 0;
		// One entry per move slot, including the empty ones. Skipping them would
		// shift every later move up an index, and callers address these rows by
		// slot number -- which silently dropped the line for a Pokemon whose
		// third move was empty.
		var rows = [];
		for (var i = 0; i < 4; i++) {
			var move = attacker.moves[i];
			if (!move || move.name === "(No Move)") {
				rows.push({move: "(No Move)", result: null});
				continue;
			}
			var result = null;
			try {
				result = RRCritKO.analyse(generation, attacker, defender, move,
					field, {critStageBonus: bonus});
			} catch (e) {
				result = null;
			}
			rows.push({move: move.name, result: result});
		}
		return {attacker: attacker, rows: rows};
	}

	function pct(value, max) {
		return (100 * value / max).toFixed(1);
	}

	// ---------------------------------------------------------- speed tiers

	/**
	 * Final Speed, not the raw stat: Choice Scarf, Tailwind, paralysis, weather
	 * abilities and boosts all change who actually moves first, and the engine
	 * already knows how. Falls back to the raw stat if it ever stops exporting.
	 */
	function finalSpeed(pokemon, field, side) {
		if (!pokemon) return 0;
		try {
			if (typeof calc.getFinalSpeed === "function") {
				return calc.getFinalSpeed(calc.Generations.get(gen), pokemon, field, side);
			}
		} catch (e) { /* fall through */ }
		return pokemon.stats ? pokemon.stats.spe : 0;
	}

	/** The Speed stat a Pokemon reaches with a given EV investment. */
	function speedWith(pokemon, evs, natureMod) {
		var base = pokemon.species.baseStats.spe;
		var iv = pokemon.ivs.spe === undefined ? 31 : pokemon.ivs.spe;
		var raw = Math.floor((2 * base + iv + Math.floor(evs / 4)) * pokemon.level / 100) + 5;
		return Math.floor(raw * natureMod);
	}

	/**
	 * The Speed this Pokemon would actually end up with at a given investment.
	 *
	 * Has to go through getFinalSpeed rather than the raw stat, or the advice
	 * ignores everything that matters: a paralysed Pokemon was told it needed
	 * "0 Speed EVs" to outrun something twice its speed, because the raw stat
	 * cleared the bar while the halved one did not. Cloning keeps rawStats from
	 * construction, so it is overwritten before asking.
	 */
	function speedAt(mine, evs, natureMod, field, side) {
		var probe;
		try {
			probe = mine.clone();
		} catch (e) {
			return speedWith(mine, evs, natureMod);
		}
		probe.rawStats.spe = speedWith(mine, evs, natureMod);
		return finalSpeed(probe, field, side);
	}

	/**
	 * What it would take to outspeed a target: the fewest EVs at the current
	 * nature, or the same under a Speed-boosting nature, or neither.
	 */
	function speedAdvice(mine, target, field, side) {
		if (!mine || !mine.species) return "";
		var current = mine.nature && calc.NATURES && calc.NATURES[mine.nature];
		var mod = 1;
		if (current) {
			if (current[0] === "spe") mod = 1.1;
			else if (current[1] === "spe") mod = 0.9;
		}
		var have = mine.evs.spe || 0;
		var ev;
		for (ev = 0; ev <= 252; ev += 4) {
			if (speedAt(mine, ev, mod, field, side) > target) {
				if (ev <= have) return "";   // already fast enough; something else is
				return "needs " + ev + " Speed EVs";
			}
		}
		if (mod < 1.1) {
			for (ev = 0; ev <= 252; ev += 4) {
				if (speedAt(mine, ev, 1.1, field, side) > target) {
					return "needs a +Speed nature and " + ev + " EVs";
				}
			}
		}
		return "cannot outspeed it as things stand";
	}

	/**
	 * Who moves first. The damage calculator never answers this, and it decides
	 * more fights than damage does.
	 */
	function speedPanel(battle) {
		if (typeof createPokemon !== "function" || !battle) return "";
		var mine;
		try {
			mine = createPokemon($("#p1"));
		} catch (e) {
			return "";
		}
		if (!mine || !mine.name) return "";

		var field;
		try {
			field = createField();
		} catch (e) {
			field = new calc.Field();
		}

		var rows = [{
			name: mine.name, speed: finalSpeed(mine, field, field.attackerSide), you: true
		}];
		for (var i = 0; i < battle.team.length; i++) {
			var foe = enemyPokemon(battle, battle.team[i]);
			if (!foe) continue;
			rows.push({
				name: battle.team[i].species,
				speed: finalSpeed(foe, field, field.defenderSide),
				you: false
			});
		}
		if (rows.length < 2) return "";
		rows.sort(function (a, b) { return b.speed - a.speed; });

		var faster = [];
		for (i = 0; i < rows.length; i++) {
			if (!rows[i].you && rows[i].speed > rows[0].speed) faster.push(rows[i]);
		}
		var yourSpeed = 0;
		for (i = 0; i < rows.length; i++) if (rows[i].you) yourSpeed = rows[i].speed;

		var html = '<div class="rr-speed"><div class="rr-speed-head">Speed order</div>' +
			'<div class="rr-speed-rows">';
		var threat = null;
		for (i = 0; i < rows.length; i++) {
			var beatsYou = !rows[i].you && rows[i].speed > yourSpeed;
			if (beatsYou && !threat) threat = rows[i];
			html += '<span class="rr-speed-row' + (rows[i].you ? " rr-you" : "") +
				(beatsYou ? " rr-faster" : "") + '">' +
				'<b>' + rows[i].speed + "</b> " + esc(rows[i].name) +
				(rows[i].you ? " (you)" : "") + "</span>";
		}
		html += "</div>";

		if (threat) {
			var advice = speedAdvice(mine, threat.speed, field, field.attackerSide);
			html += '<div class="rr-speed-note">' + esc(threat.name) +
				" moves first" + (advice ? " &mdash; " + esc(advice) : "") + "</div>";
		} else {
			html += '<div class="rr-speed-note rr-speed-ok">You outspeed the whole team</div>';
		}
		return html + "</div>";
	}

	// -------------------------------------------------------------- render

	/**
	 * Link a Trainer Order entry to a battle.
	 *
	 * The order tab writes a trainer's class with the name ("LASS ANNE",
	 * "SUPER NERD MIGUEL") while the battle blocks keep the class in the title
	 * and the bare name in the trainer field, so an exact match only works for
	 * gym leaders and rivals. Match on the last word, then break ties with the
	 * location and class words.
	 */
	var orderMatchCache = null;

	function matchOrderEntry(entry) {
		if (!orderMatchCache) orderMatchCache = {};
		var cacheKey = entry.name + "|" + entry.location;
		if (Object.prototype.hasOwnProperty.call(orderMatchCache, cacheKey)) {
			return orderMatchCache[cacheKey];
		}

		// "(REMATCH)" is a qualifier, not part of the name; it points at the
		// Kanto Rematch section rather than the original gym battle.
		var raw = entry.name.toUpperCase();
		var wantsRematch = /\(REMATCH\)/.test(raw);
		var cleaned = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
		var words = cleaned.split(/\s+/).filter(Boolean);
		var last = words[words.length - 1];
		// Some trainers are two words ("JOJO FAN"), so try that pairing too.
		var lastTwo = words.length > 1 ? words.slice(-2).join(" ") : null;
		var location = (entry.location || "").toUpperCase();
		var best = null, bestScore = -1;

		for (var s = 0; s < data.segments.length; s++) {
			var battles = data.segments[s].battles;
			var isRematchSegment = /REMATCH/.test(data.segments[s].name.toUpperCase());
			for (var b = 0; b < battles.length; b++) {
				var battle = battles[b];
				var trainer = battle.trainer.toUpperCase();
				if (trainer !== last && trainer !== cleaned &&
					(!lastTwo || trainer !== lastTwo)) continue;
				if (wantsRematch !== isRematchSegment) continue;

				var score = 1;
				var context = ((battle.title || "") + " " + battle.trainer).toUpperCase();
				if (lastTwo && trainer === lastTwo) score += 2;
				for (var w = 0; w < words.length - 1; w++) {
					if (context.indexOf(words[w]) !== -1) score += 2;
				}
				// Locations are abbreviated differently on the two tabs
				// ("VIRIDIAN FOREST" vs "VIRID. FOREST"), so compare on a
				// prefix of each word rather than the whole string.
				var locWords = location.split(/[\s.]+/).filter(Boolean);
				for (var l = 0; l < locWords.length; l++) {
					var stem = locWords[l].slice(0, 4);
					if (stem.length >= 3 && context.indexOf(stem) !== -1) score += 3;
				}
				if (score > bestScore) {
					bestScore = score;
					best = battle;
				}
			}
		}
		// Some entries share no word with the trainer's name at all: the order
		// tab lists the Indigo Plateau joke boss by its class, "DUMASS CREATOR",
		// while the battle block names it SOUPERCELL. Fall back to matching on
		// the block's title, but only when the location agrees too, so this
		// cannot quietly attach an entry to an unrelated battle.
		if (!best && location) {
			var locStems = location.split(/[\s.]+/).filter(function (w) {
				return w.length >= 4;
			}).map(function (w) { return w.slice(0, 4); });

			for (var s2 = 0; s2 < data.segments.length && !best; s2++) {
				var list = data.segments[s2].battles;
				for (var b2 = 0; b2 < list.length; b2++) {
					var candidate = list[b2];
					var title = (candidate.title || "").toUpperCase();
					if (!title) continue;
					var locHit = locStems.length > 0 && locStems.every(function (stem) {
						return title.indexOf(stem) !== -1;
					});
					if (!locHit) continue;
					var wordHit = false;
					for (var w2 = 0; w2 < words.length; w2++) {
						if (words[w2].length >= 4 && title.indexOf(words[w2]) !== -1) {
							wordHit = true;
						}
					}
					if (wordHit) { best = candidate; break; }
				}
			}
		}

		orderMatchCache[cacheKey] = best;
		return best;
	}

	function segmentTabs() {
		var html = "";
		for (var i = 0; i < data.segments.length; i++) {
			html += '<button class="rr-seg' + (i === prefs.segment ? " rr-on" : "") +
				'" data-seg="' + i + '">' + esc(data.segments[i].name) +
				' <span class="rr-count">' + data.segments[i].battles.length +
				'</span></button>';
		}
		html += '<button class="rr-seg rr-seg-order' +
			(prefs.segment === "order" ? " rr-on" : "") + '" data-seg="order"' +
			' title="Every trainer in the order you meet them, with level caps">' +
			'Story Order <span class="rr-count">' +
			(data.trainerOrder ? data.trainerOrder.length : 0) + '</span></button>';
		return html;
	}

	/** The chronological run through the game, grouped by level cap. */
	function orderList(query) {
		var entries = data.trainerOrder || [];
		var html = "";
		var lastCap = null;
		for (var i = 0; i < entries.length; i++) {
			var entry = entries[i];
			var battle = matchOrderEntry(entry);
			if (query) {
				var hay = (entry.name + " " + (entry.location || "")).toLowerCase();
				if (hay.indexOf(query.toLowerCase()) === -1) continue;
			}
			if (entry.levelCap !== lastCap && entry.levelCap !== null) {
				lastCap = entry.levelCap;
				html += '<div class="rr-cap">Level cap ' + entry.levelCap + '</div>';
			}
			var on = battle && currentBattle && currentBattle.id === battle.id;
			html += '<button class="rr-battle' + (on ? " rr-on" : "") +
				(battle ? "" : " rr-nolink") + '"' +
				(battle ? ' data-id="' + esc(battle.id) + '"' : " disabled") + '>' +
				'<span class="rr-bt">' + esc(entry.name) +
				(entry.optional ? ' <span class="rr-opt">optional</span>' : "") +
				'</span>' +
				(entry.location ? '<span class="rr-bs">' + esc(entry.location) + '</span>' : "") +
				(battle ? '<span class="rr-bn">' + battle.team.length + '</span>'
					: '<span class="rr-bs">no team recorded</span>') +
				'</button>';
		}
		return html || '<div class="rr-empty">No trainers match.</div>';
	}

	function matchesQuery(battle, query) {
		if (!query) return true;
		var hay = (battle.trainer + " " + (battle.title || "") + " " +
			(battle.variant || "")).toLowerCase();
		for (var i = 0; i < battle.team.length; i++) {
			hay += " " + battle.team[i].species.toLowerCase();
		}
		var terms = query.toLowerCase().split(/\s+/);
		for (var t = 0; t < terms.length; t++) {
			if (terms[t] && hay.indexOf(terms[t]) === -1) return false;
		}
		return true;
	}

	function battleList() {
		var query = $("#rr-search").val();
		var html = "";
		if (prefs.segment === "order" && !query) return orderList(null);
		if (prefs.segment === "order") return orderList(query);
		var segments = query ? data.segments
			: [data.segments[prefs.segment] || data.segments[0]];
		for (var s = 0; s < segments.length; s++) {
			var segment = segments[s];
			if (!segment) continue;
			for (var b = 0; b < segment.battles.length; b++) {
				var battle = segment.battles[b];
				if (!matchesQuery(battle, query)) continue;
				var on = currentBattle && currentBattle.id === battle.id;
				html += '<button class="rr-battle' + (on ? " rr-on" : "") +
					'" data-id="' + esc(battle.id) + '">' +
					'<span class="rr-bt">' + esc(battle.trainer) + '</span>' +
					(battle.title ? '<span class="rr-bs">' + esc(battle.title) + '</span>' : "") +
					(battle.variant ? '<span class="rr-bv">' + esc(battle.variant) + '</span>' : "") +
					'<span class="rr-bn">' + battle.team.length + '</span></button>';
			}
		}
		return html || '<div class="rr-empty">No battles match.</div>';
	}

	function findBattle(id) {
		for (var s = 0; s < data.segments.length; s++) {
			var battles = data.segments[s].battles;
			for (var b = 0; b < battles.length; b++) {
				if (battles[b].id === id) return battles[b];
			}
		}
		return null;
	}

	function detailPanel() {
		if (!currentBattle) {
			return '<div class="rr-empty">Pick a battle to load its team.</div>';
		}
		var battle = currentBattle;
		var cap = levelCapFor(battle);
		var html = '<div class="rr-detail-head"><b>' + esc(battle.trainer) + '</b>';
		if (cap !== null) {
			html += ' <span class="rr-cap-tag">Lv cap ' + cap + '</span>';
		}
		if (battle.title) html += ' <span class="rr-bs">' + esc(battle.title) + '</span>';
		if (battle.variant) html += ' <span class="rr-bv">' + esc(battle.variant) + '</span>';
		html += '</div>';

		if (battle.effects && battle.effects.length) {
			html += '<div class="rr-effects">' + esc(battle.effects.join(" | "));
			if (lastEffects.applied.length) {
				html += '<span class="rr-applied">applied: ' +
					esc(lastEffects.applied.join(", ")) + '</span>';
			}
			if (lastEffects.unhandled.length) {
				html += '<span class="rr-note">not applied automatically: ' +
					esc(lastEffects.unhandled.join("; ")) + '</span>';
			}
			if (!prefs.applyEffects) {
				html += '<span class="rr-note">auto-apply is off; set these in ' +
					'the Field section yourself</span>';
			}
			html += '</div>';
		}

		html += '<div class="rr-chips">';
		for (var i = 0; i < battle.team.length; i++) {
			var mon = battle.team[i];
			html += '<button class="rr-chip' + (i === currentMon ? " rr-on" : "") +
				'" data-mon="' + i + '">' +
				'<span class="rr-cs">' + esc(mon.species) + '</span>' +
				'<span class="rr-cl">Lv ' + esc(levelLabel(mon)) + '</span>' +
				(mon.item ? '<span class="rr-ci">@ ' + esc(mon.item) + '</span>' : "") +
				'</button>';
		}
		html += '</div><div id="rr-speed"></div>';
		return html;
	}

	/**
	 * How threatening an incoming move is: [turns to a likely kill, its chance].
	 *
	 * Ranking on the first turn with any chance at all is misleading -- a 0.02%
	 * 5HKO would outrank an 87.9% 6HKO. So the first turn where a kill is more
	 * likely than not is what counts, falling back to any chance at all.
	 */
	function threatRank(result) {
		var n;
		for (n = 0; n < result.chances.length; n++) {
			if (result.chances[n] >= 0.5) return [n, result.chances[n]];
		}
		for (n = 0; n < result.chances.length; n++) {
			if (result.chances[n] > 0) return [100 + n, result.chances[n]];
		}
		return [999, result.maxTurnDamage / Math.max(result.maxHP, 1)];
	}

	/** "always crits", "50% crit", or "" at the ordinary 1/24 rate. */
	function critNote(rate) {
		if (rate >= 0.999) return "always crits";
		if (rate > 1 / 24 + 1e-9) return (rate * 100).toFixed(0) + "% crit";
		return "";
	}

	/**
	 * One direction of the exchange, as a single sentence.
	 *
	 * Both directions use this same shape, because a bare "28.1% chance to
	 * OHKO" never said who was hitting whom. Attacker, move and target are
	 * always named, so the two lines read as a pair.
	 */
	function exchangeLine(label, attackerName, moveName, defenderName, result, extra) {
		var note = critNote(result.critChance);
		var html = '<div class="rr-critline' + (extra || "") + '">' +
			'<b class="rr-dir">' + esc(label) + "</b> " +
			esc(attackerName) + "'s " + esc(moveName) + " vs. " +
			esc(defenderName) + " &mdash; " +
			pct(result.minTurnDamage, result.maxHP) + " - " +
			pct(result.maxTurnDamage, result.maxHP) + "% &mdash; " +
			esc(result.text);
		if (note) {
			html += ' <b class="rr-crit-flag">' + esc(note) + "</b>";
		} else {
			html += ' <span class="rr-plain">(crit ' +
				(result.critChance * 100).toFixed(1) + "%)</span>";
		}
		// Only worth saying when the crits actually move the answer.
		if (result.text !== result.textWithoutCrits) {
			html += ' <span class="rr-plain">&mdash; without crits: ' +
				esc(result.textWithoutCrits) + "</span>";
		}
		return html + "</div>";
	}

	/**
	 * The exchange in both directions, under the calculator's own result.
	 *
	 * The incoming half is the one with no home anywhere else, and is where you
	 * find out that Giovanni's Honchkrow crits with every Night Slash.
	 */
	function critBox() {
		var lines = "";

		// Outgoing: whichever move the calculator is currently detailing.
		var checked = $("input.result-move:checked").attr("id") || "";
		var side = checked.indexOf("resultMoveR") === 0 ? "#p2" : "#p1";
		var other = side === "#p1" ? "#p2" : "#p1";
		var index = ~~checked.slice(-1) - 1;

		var defender = null;
		try {
			defender = createPokemon($(other));
		} catch (e) {
			defender = null;
		}
		if (defender && defender.name) {
			var out = analysePair(side, defender, side === "#p2");
			var row = out && out.rows[index];
			if (row && row.result) {
				lines += exchangeLine(side === "#p1" ? "You" : "Them",
					out.attacker.name, row.move, defender.name, row.result, "");
			}
		}

		// Incoming: the opponent's most threatening move.
		var mine = null;
		try {
			mine = createPokemon($("#p1"));
		} catch (e) {
			mine = null;
		}
		if (mine && mine.name) {
			var back = analysePair("#p2", mine, true);
			var worst = null, worstRank = null;
			if (back) {
				for (var i = 0; i < back.rows.length; i++) {
					var r = back.rows[i].result;
					if (!r) continue;
					var rank = threatRank(r);
					if (!worst || rank[0] < worstRank[0] ||
						(rank[0] === worstRank[0] && rank[1] > worstRank[1])) {
						worst = back.rows[i];
						worstRank = rank;
					}
				}
			}
			if (worst && side === "#p1") {
				lines += exchangeLine("Them", back.attacker.name, worst.move,
					mine.name, worst.result, " rr-incoming");
			}
		}
		return lines;
	}

	function teamBar() {
		var html = '<div class="rr-team-head"><b>My Team</b>' +
			'<button id="rr-save-mon" title="Save the current attacker">+ save current</button>' +
			'</div><div class="rr-team-list">';
		if (!team.length) {
			html += '<span class="rr-empty">Set up your Pokemon on the left, then ' +
				'press "save current" to keep it here.</span>';
		}
		for (var i = 0; i < team.length; i++) {
			html += '<span class="rr-member"><button class="rr-load-mon" data-i="' + i + '">' +
				esc(team[i].species) + ' <span class="rr-cl">Lv ' + team[i].level +
				'</span></button><button class="rr-drop-mon" data-i="' + i +
				'" title="Remove">x</button></span>';
		}
		return html + '</div>';
	}

	var rendering = false;

	/** Just the 1v1 crit-aware table, which depends on both current slots. */
	function renderCrit() {
		if (!data || rendering) return;
		rendering = true;
		try {
			$("#rr-crit").html(critBox());
			// Speed depends on the attacker's nature, EVs, item and the field,
			// all of which can change without the battle changing.
			if (currentBattle) $("#rr-speed").html(speedPanel(currentBattle));
		} finally {
			rendering = false;
		}
	}

	/** The matrix too: needed when the attacker, battle, or prefs change. */
	function renderResults() {
		if (!data || rendering) return;
		rendering = true;
		try {
			$("#rr-crit").html(critBox());
		} finally {
			rendering = false;
		}
	}

	function render() {
		if (!data || rendering) return;
		rendering = true;
		try {
			$("#rr-segments").html(segmentTabs());
			$("#rr-battles").html(battleList());
			$("#rr-detail").html(detailPanel());
			$("#rr-team").html(teamBar());
			markChips();
			$("#rr-speed").html(currentBattle ? speedPanel(currentBattle) : "");
			$("#rr-crit").html(critBox());
		} finally {
			rendering = false;
		}
	}

	// ---------------------------------------------------------------- init

	function panelHtml() {
		return '' +
		'<div id="rr-panel">' +
			'<div class="rr-head">' +
				'<span class="rr-title">Radical Red Trainer Battles</span>' +
				'<input id="rr-search" type="text" placeholder="Search trainer or Pokemon..." />' +
				'<label title="Radical Red\'s Minimal Grinding Mode gives opponents no EVs">' +
					'<input type="checkbox" id="rr-mgm" /> Minimal Grinding Mode</label>' +
				'<label title="Used for rematch and postgame trainers, whose levels track yours">' +
					'My highest Lv <input type="number" id="rr-mylevel" min="1" max="250" /></label>' +
				'<label title="Assume you are at the level cap for whichever battle you pick">' +
					'<input type="checkbox" id="rr-followcap" /> at cap</label>' +
				'<label title="Focus Energy or Dire Hit: +2 crit stages">' +
					'<input type="checkbox" id="rr-focus" /> Focus Energy</label>' +
				'<label title="Set weather, terrain and stat boosts from the ' +
					'sheet\'s battle notes when you pick a battle">' +
					'<input type="checkbox" id="rr-effects" /> Auto field effects</label>' +
				'<button id="rr-collapse">hide</button>' +
			'</div>' +
			'<div class="rr-body">' +
				'<div id="rr-segments" class="rr-segments"></div>' +
				'<div class="rr-cols">' +
					'<div id="rr-battles" class="rr-battles"></div>' +
					'<div id="rr-detail" class="rr-detail"></div>' +
				'</div>' +
				'<div id="rr-team" class="rr-team"></div>' +
			'</div>' +
		'</div>' +
		'<div id="rr-crit" class="rr-crit"></div>';
	}

	function bind() {
		$("#rr-collapse").click(function () {
			var $body = $("#rr-panel .rr-body");
			$body.toggle();
			$(this).text($body.is(":visible") ? "hide" : "show");
		});

		$("#rr-search").on("input", function () {
			$("#rr-battles").html(battleList());
		});

		$("#rr-segments").on("click", ".rr-seg", function () {
			var seg = $(this).data("seg");
			prefs.segment = seg === "order" ? "order" : ~~seg;
			save(STORE_PREFS, prefs);
			render();
		});

		$("#rr-battles").on("click", ".rr-battle", function () {
			currentBattle = findBattle($(this).data("id"));
			currentMon = -1;
			facing = [];
			applyLevelCap(currentBattle);
			// Put the lead on the field straight away. Doubles already did this
			// for its two slots; leaving singles empty until a chip was clicked
			// was just an inconsistency.
			if (currentBattle && currentBattle.team.length) {
				facing = [0];
				currentMon = 0;
				loadEnemy(currentBattle, currentBattle.team[0]);
			}
			lastEffects = applyBattleEffects(currentBattle);
			render();
			for (var i = 0; i < battleListeners.length; i++) {
				try { battleListeners[i](currentBattle); } catch (e) { /* isolate */ }
			}
		});

		$("#rr-detail").on("click", ".rr-chip", function () {
			if (!currentBattle) return;
			chooseEnemy(~~$(this).data("mon"));
		});

		$("#rr-mgm").change(function () {
			prefs.mgm = $(this).prop("checked");
			save(STORE_PREFS, prefs);
			reloadFacing();
			render();
		});

		$("#rr-effects").change(function () {
			prefs.applyEffects = $(this).prop("checked");
			save(STORE_PREFS, prefs);
			lastEffects = applyBattleEffects(currentBattle);
			render();
		});

		$("#rr-focus").change(function () {
			prefs.focusEnergy = $(this).prop("checked");
			save(STORE_PREFS, prefs);
			render();
		});

		$("#rr-followcap").change(function () {
			prefs.followCap = $(this).prop("checked");
			save(STORE_PREFS, prefs);
			applyLevelCap(currentBattle);
			render();
		});

		$("#rr-mylevel").on("change input", function () {
			prefs.myLevel = Math.max(1, Math.min(250, ~~$(this).val() || 100));
			save(STORE_PREFS, prefs);
			reloadFacing();
			render();
		});

		$("#rr-team").on("click", "#rr-save-mon", function () {
			var member = snapshotAttacker();
			if (!member) return;
			if (team.length >= 6) team.shift();
			team.push(member);
			save(STORE_TEAM, team);
			render();
		});

		$("#rr-team").on("click", ".rr-load-mon", function () {
			loadTeamMember(team[~~$(this).data("i")]);
		});

		$("#rr-team").on("click", ".rr-drop-mon", function () {
			team.splice(~~$(this).data("i"), 1);
			save(STORE_TEAM, team);
			render();
		});

		// Switching which move the calculator details does not go through
		// performCalculations, so the crit lines have to follow it directly or
		// they keep describing the previously selected move.
		$(document).on("change", "input.result-move", function () {
			if (!rendering) $("#rr-crit").html(critBox());
		});

		// Speed follows any edit to your Pokemon or the field.
		$(document).on("change keyup", "#p1 input, #p1 select, " +
			".field-info input, .field-info select", function () {
			if (!rendering && currentBattle) {
				$("#rr-speed").html(speedPanel(currentBattle));
			}
		});

		// Keep the crit box in step with the calculator's own recalculation.
		if (typeof window.performCalculations === "function") {
			var original = window.performCalculations;
			window.performCalculations = function () {
				var out = original.apply(this, arguments);
				try {
					if (!rendering) {
						$("#rr-crit").html(critBox());
						if (currentBattle) $("#rr-speed").html(speedPanel(currentBattle));
					}
				} catch (e) { /* never let our panel break the calculator */ }
				return out;
			};
		}
	}

	/** Re-apply whoever is on the field, after something changed how they load. */
	function reloadFacing() {
		if (!currentBattle || !facing.length) return;
		loadEnemy(currentBattle, currentBattle.team[facing[0]]);
		notifyFacing();
	}

	/** How many opponents are on the field at once. */
	function facingCapacity() {
		return (typeof window.RRDoubles !== "undefined" &&
			window.RRDoubles.isActive()) ? 2 : 1;
	}

	/**
	 * Click a Pokemon to put it on the field; click it again to take it off.
	 * In doubles two can be up at once, and the oldest gives way to a third.
	 */
	function chooseEnemy(index) {
		var capacity = facingCapacity();
		var at = facing.indexOf(index);
		if (at >= 0 && capacity > 1) {
			// In doubles a second click takes it back off the field. In singles
			// there is nothing to take it off for, so clicking just selects.
			facing.splice(at, 1);
		} else if (at < 0) {
			facing.push(index);
			while (facing.length > capacity) facing.shift();
		}
		currentMon = facing.length ? facing[0] : -1;

		if (facing.length) {
			loadEnemy(currentBattle, currentBattle.team[facing[0]]);
		}
		markChips();
		notifyFacing();
	}

	function notifyFacing() {
		for (var i = 0; i < selectionListeners.length; i++) {
			try {
				selectionListeners[i](currentBattle, facing.slice());
			} catch (e) { /* isolate */ }
		}
	}

	/** Show which chips are on the field, and in which slot. */
	function markChips() {
		$("#rr-detail .rr-chip").each(function () {
			var index = ~~$(this).data("mon");
			var slot = facing.indexOf(index);
			$(this).toggleClass("rr-on", slot >= 0);
			$(this).find(".rr-slot").remove();
			if (slot >= 0 && facingCapacity() > 1) {
				$(this).append('<span class="rr-slot">' + (slot + 1) + "</span>");
			}
		});
	}

	/**
	 * battle id -> the level cap in force when you fight it.
	 *
	 * The caps live on the Trainer Order tab, one per entry, so they reach the
	 * battles through the same matching the Story Order view uses. Built once
	 * and reused; a battle the order tab never lists simply has no cap.
	 */
	var capByBattle = null;

	function levelCapFor(battle) {
		if (!battle) return null;
		if (!capByBattle) {
			capByBattle = {};
			var order = data.trainerOrder || [];
			for (var i = 0; i < order.length; i++) {
				if (order[i].levelCap === null || order[i].levelCap === undefined) continue;
				var matched = matchOrderEntry(order[i]);
				if (matched && capByBattle[matched.id] === undefined) {
					capByBattle[matched.id] = order[i].levelCap;
				}
			}
		}
		var cap = capByBattle[battle.id];
		if (cap !== undefined) return cap;
		// The Trainer Order tab stops at the Elite Four. The sheet's own notes
		// put the postgame cap at 100, so use that rather than leaving the
		// player's level at whatever the last battle happened to set.
		for (var s = 0; s < data.segments.length; s++) {
			if (!/postgame/i.test(data.segments[s].name)) continue;
			var list = data.segments[s].battles;
			for (var b = 0; b < list.length; b++) {
				if (list[b].id === battle.id) return 100;
			}
		}
		return null;
	}

	/**
	 * Assume the player is sitting at the cap. Levels for rematch and postgame
	 * trainers are written relative to your own, so this is what makes those
	 * battles show real numbers without typing a level in first.
	 */
	function applyLevelCap(battle) {
		var cap = levelCapFor(battle);
		if (cap === null || !prefs.followCap) return;
		prefs.myLevel = cap;
		$("#rr-mylevel").val(cap);
		save(STORE_PREFS, prefs);
	}

	/** True when the sheet flags this battle as a double battle. */
	function isDoublesBattle(battle) {
		if (!battle || !battle.effects) return false;
		return /DOUBLES/i.test(battle.effects.join(" "));
	}

	// Read-only surface for rr-doubles.js. Deliberately small: the doubles view
	// reuses this panel's current battle, saved team and Pokemon construction,
	// so level scaling and Minimal Grinding Mode stay defined in one place.
	window.RRTrainers = {
		getBattle: function () { return currentBattle; },
		getTeam: function () { return team; },
		getPrefs: function () { return prefs; },
		buildEnemy: enemyPokemon,
		// Registers the set and returns the id its selector should hold, so the
		// doubles view can fill its own panels without duplicating EV/level logic.
		enemySetId: function (battle, mon) {
			if (!battle || !mon) return null;
			var set = {
				level: resolveLevel(mon),
				nature: mon.nature || "Serious",
				item: mon.item || "",
				moves: mon.moves.slice(0, 4),
				evs: toCalcStats(effectiveEVs(battle, mon)),
				ivs: toCalcStats(mon.ivs)
			};
			if (mon.ability) set.ability = mon.ability;
			set.isCustomSet = true;
			if (typeof setdex === "undefined" || !setdex) return null;
			if (!setdex[mon.species]) setdex[mon.species] = {};
			var name = battle.trainer + (battle.variant ? " / " + battle.variant : "");
			setdex[mon.species][name] = set;
			return mon.species + " (" + name + ")";
		},
		resolveLevel: resolveLevel,
		levelLabel: levelLabel,
		isDoubles: isDoublesBattle,
		onBattleChange: function (fn) { battleListeners.push(fn); },
		onFacingChange: function (fn) { selectionListeners.push(fn); },
		getFacing: function () { return facing.slice(); },
		setFacing: function (list) {
			// Slices to the current capacity, so leaving doubles drops the
			// second Pokemon instead of leaving it selected but off the board.
			facing = list.slice(0, facingCapacity());
			markChips();
			if (facing.length && currentBattle) {
				loadEnemy(currentBattle, currentBattle.team[facing[0]]);
			}
			// Must notify: the second slot lives in the doubles view, so without
			// this it keeps whatever it had -- which meant Minimal Grinding Mode
			// zeroed Pokemon 2's EVs and left Pokemon 4's alone.
			notifyFacing();
		},
		markChips: markChips
	};

	$(function () {
		if (typeof RR_TRAINER_DATA === "undefined") return;
		data = RR_TRAINER_DATA;
		prefs = $.extend(prefs, load(STORE_PREFS, {}));
		team = load(STORE_TEAM, []) || [];

		$(".wrapper").first().prepend(panelHtml());
		// Move the crit-aware table down to sit with the calculator's own
		// results, where damage figures belong, instead of above the title.
		var main = $(".main-result-group");
		if (main.length) main.after($("#rr-crit"));
		$("#rr-mgm").prop("checked", !!prefs.mgm);
		$("#rr-focus").prop("checked", !!prefs.focusEnergy);
		$("#rr-effects").prop("checked", prefs.applyEffects !== false);
		$("#rr-followcap").prop("checked", prefs.followCap !== false);
		$("#rr-mylevel").val(prefs.myLevel);
		bind();
		render();
	});
})();
