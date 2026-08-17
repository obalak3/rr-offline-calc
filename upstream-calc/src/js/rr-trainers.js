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

	var data = null;
	var prefs = {mgm: false, myLevel: 100, focusEnergy: false, segment: 0};
	var team = [];
	var currentBattle = null;

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

	// ------------------------------------------------- loading into a slot

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
		var $sel = $(slotId).find("input.set-selector");
		$sel.val(id);
		try {
			$sel.select2("val", id);
		} catch (e) { /* select2 rebuilds its list lazily; val + change is enough */ }
		$sel.val(id).change();
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
			render();
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
			render();
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

	function segmentTabs() {
		var html = "";
		for (var i = 0; i < data.segments.length; i++) {
			html += '<button class="rr-seg' + (i === prefs.segment ? " rr-on" : "") +
				'" data-seg="' + i + '">' + esc(data.segments[i].name) +
				' <span class="rr-count">' + data.segments[i].battles.length +
				'</span></button>';
		}
		return html;
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
		var segments = query ? data.segments : [data.segments[prefs.segment]];
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
			html += '<div class="rr-effects">' + esc(battle.effects.join(" | ")) +
				' <span class="rr-note">(set these in the Field section yourself)</span></div>';
		}

		html += '<div class="rr-chips">';
		for (var i = 0; i < battle.team.length; i++) {
			var mon = battle.team[i];
			html += '<button class="rr-chip" data-mon="' + i + '">' +
				'<span class="rr-cs">' + esc(mon.species) + '</span>' +
				'<span class="rr-cl">Lv ' + esc(levelLabel(mon)) + '</span>' +
				(mon.item ? '<span class="rr-ci">@ ' + esc(mon.item) + '</span>' : "") +
				'</button>';
		}
		html += '</div>';
		html += matrixTable(battle);
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

	function render() {
		if (!data || rendering) return;
		rendering = true;
		try {
			$("#rr-segments").html(segmentTabs());
			$("#rr-battles").html(battleList());
			$("#rr-detail").html(detailPanel());
			$("#rr-team").html(teamBar());
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
			prefs.segment = ~~$(this).data("seg");
			save(STORE_PREFS, prefs);
			render();
		});

		$("#rr-battles").on("click", ".rr-battle", function () {
			currentBattle = findBattle($(this).data("id"));
			render();
		});

		$("#rr-detail").on("click", ".rr-chip", function () {
			if (!currentBattle) return;
			loadEnemy(currentBattle, currentBattle.team[~~$(this).data("mon")]);
		});

		$("#rr-mgm").change(function () {
			prefs.mgm = $(this).prop("checked");
			save(STORE_PREFS, prefs);
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

	$(function () {
		if (typeof RR_TRAINER_DATA === "undefined") return;
		data = RR_TRAINER_DATA;
		prefs = $.extend(prefs, load(STORE_PREFS, {}));
		team = load(STORE_TEAM, []) || [];

		$(".wrapper").first().prepend(panelHtml());
		$("#rr-mgm").prop("checked", !!prefs.mgm);
		$("#rr-focus").prop("checked", !!prefs.focusEnergy);
		$("#rr-mylevel").val(prefs.myLevel);
		bind();
		render();
	});
})();
