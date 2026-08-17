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
		applyEffects: true};
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

	function analyseAgainst(defender) {
		if (typeof createPokemon !== "function" || !defender) return null;
		var attacker;
		try {
			attacker = createPokemon($("#p1"));
		} catch (e) {
			return null;
		}
		var field;
		try {
			field = createField();
		} catch (e) {
			field = new calc.Field();
		}
		var generation = calc.Generations.get(gen);
		var bonus = prefs.focusEnergy ? 2 : 0;
		var rows = [];
		for (var i = 0; i < attacker.moves.length; i++) {
			var move = attacker.moves[i];
			if (!move || move.name === "(No Move)") continue;
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

	/** "OHKO 7.8% / 2HKO 63.2%" -- the cumulative ladder, crit included. */
	function ladder(result) {
		if (!result) return "&mdash;";
		var parts = [];
		for (var n = 0; n < result.chances.length && parts.length < 3; n++) {
			var p = result.chances[n];
			if (p <= 0) continue;
			var label = n === 0 ? "OHKO" : (n + 1) + "HKO";
			parts.push(label + " " + (p >= 0.9995 ? "100" : (p * 100).toFixed(1)) + "%");
			if (p > 0.9995) break;
		}
		return parts.length ? parts.join(" / ") : "not a KO";
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
		var html = '<div class="rr-detail-head"><b>' + esc(battle.trainer) + '</b>';
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
		html += '</div><div id="rr-matrix"></div>';
		return html;
	}

	/** Your attacker's moves against every Pokemon on the enemy team. */
	function matrixTable(battle) {
		if (typeof createPokemon !== "function") return "";
		var defenders = [];
		for (var i = 0; i < battle.team.length; i++) {
			var poke = enemyPokemon(battle, battle.team[i]);
			if (poke) defenders.push({mon: battle.team[i], poke: poke});
		}
		if (!defenders.length) return "";

		var first = analyseAgainst(defenders[0].poke);
		if (!first || !first.rows.length) {
			return '<div class="rr-empty">Give your Pokemon some moves to see the matrix.</div>';
		}

		var html = '<div class="rr-matrix-wrap"><table class="rr-matrix"><thead><tr><th>' +
			esc(first.attacker.name) + '</th>';
		for (var d = 0; d < defenders.length; d++) {
			html += '<th>' + esc(defenders[d].mon.species) +
				'<span class="rr-mh">Lv ' + resolveLevel(defenders[d].mon) + '</span></th>';
		}
		html += '</tr></thead><tbody>';

		var analyses = [first];
		for (var k = 1; k < defenders.length; k++) {
			analyses.push(analyseAgainst(defenders[k].poke));
		}

		for (var r = 0; r < first.rows.length; r++) {
			html += '<tr><th>' + esc(first.rows[r].move) + '</th>';
			for (var c = 0; c < defenders.length; c++) {
				var analysis = analyses[c];
				var row = analysis && analysis.rows[r];
				var res = row && row.result;
				if (!res) {
					html += '<td class="rr-nil">&mdash;</td>';
					continue;
				}
				var lo = pct(res.minTurnDamage, res.maxHP);
				var hi = pct(res.maxTurnDamage, res.maxHP);
				var kills = res.chances[0] > 0;
				html += '<td class="' + (kills ? "rr-kill" : "") + '">' +
					'<span class="rr-dmg">' + lo + " - " + hi + '%</span>' +
					'<span class="rr-ko">' + ladder(res) + '</span></td>';
			}
			html += '</tr>';
		}
		html += '</tbody></table></div>' +
			'<div class="rr-note">KO chances include critical hits at the real ' +
			'crit rate. Damage range spans a non-crit low roll to a crit high roll. ' +
			'End-of-turn damage and hazards are not folded in.</div>';
		return html;
	}

	function critBox() {
		var defender;
		try {
			defender = createPokemon($("#p2"));
		} catch (e) {
			return "";
		}
		var analysis = analyseAgainst(defender);
		if (!analysis || !analysis.rows.length) return "";
		var html = '<table class="rr-matrix rr-critbox"><thead><tr>' +
			'<th>' + esc(analysis.attacker.name) + ' vs ' + esc(defender.name) + '</th>' +
			'<th>Damage</th><th>Crit rate</th><th>KO chance (crits included)</th>' +
			'<th>KO chance (no crits)</th></tr></thead><tbody>';
		for (var i = 0; i < analysis.rows.length; i++) {
			var row = analysis.rows[i];
			var res = row.result;
			if (!res) {
				html += '<tr><th>' + esc(row.move) + '</th>' +
					'<td colspan="4" class="rr-nil">no damage</td></tr>';
				continue;
			}
			html += '<tr><th>' + esc(row.move) + '</th>' +
				'<td>' + pct(res.minTurnDamage, res.maxHP) + ' - ' +
				pct(res.maxTurnDamage, res.maxHP) + '%</td>' +
				'<td>' + (res.critChance * 100).toFixed(1) + '%</td>' +
				'<td class="rr-kill">' + ladder(res) + '</td>' +
				'<td class="rr-plain">' + esc(res.textWithoutCrits) + '</td></tr>';
		}
		html += '</tbody></table>';
		return html;
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
		} finally {
			rendering = false;
		}
	}

	/** The matrix too: needed when the attacker, battle, or prefs change. */
	function renderResults() {
		if (!data || rendering) return;
		rendering = true;
		try {
			if (currentBattle) $("#rr-matrix").html(matrixTable(currentBattle));
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
			$("#rr-matrix").html(currentBattle ? matrixTable(currentBattle) : "");
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

		$("#rr-mylevel").on("change input", function () {
			prefs.myLevel = Math.max(1, Math.min(250, ~~$(this).val() || 100));
			save(STORE_PREFS, prefs);
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

		// Keep the crit box in step with the calculator's own recalculation.
		if (typeof window.performCalculations === "function") {
			var original = window.performCalculations;
			window.performCalculations = function () {
				var out = original.apply(this, arguments);
				try {
					if (!rendering) $("#rr-crit").html(critBox());
				} catch (e) { /* never let our panel break the calculator */ }
				return out;
			};
		}
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
		},
		markChips: markChips
	};

	$(function () {
		if (typeof RR_TRAINER_DATA === "undefined") return;
		data = RR_TRAINER_DATA;
		prefs = $.extend(prefs, load(STORE_PREFS, {}));
		team = load(STORE_TEAM, []) || [];

		$(".wrapper").first().prepend(panelHtml());
		$("#rr-mgm").prop("checked", !!prefs.mgm);
		$("#rr-focus").prop("checked", !!prefs.focusEnergy);
		$("#rr-effects").prop("checked", prefs.applyEffects !== false);
		$("#rr-mylevel").val(prefs.myLevel);
		bind();
		render();
	});
})();
