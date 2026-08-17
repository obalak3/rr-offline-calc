/**
 * rr-doubles.js -- double battle mode for the calculator itself.
 *
 * Switching this on turns the page into a 2v2: a second Pokemon panel appears
 * under each of the originals, so you configure all four the same way you
 * configure one, with every control the calculator normally gives you. Each
 * panel gets a target picker, and a summary reports what the chosen moves do
 * together.
 *
 * The extra panels are stamped from the pristine markup of the originals,
 * captured at parse time. That timing matters: the calculator wires select2 on
 * to those panels inside $(document).ready, and this file's top-level code runs
 * before any ready handler, so the capture is clean. Cloning the live panels
 * instead drags along broken widget state and loses form values.
 *
 * The combined result is the reason this exists. Two attacks on one Pokemon are
 * not a sum of averages: each rolls damage and crits independently, so the
 * chance the total is lethal is a convolution (RRCritKO.koChancesMulti). Empty
 * slots give 2v1, where spread moves that now reach a single target deal full
 * damage (RRCritKO.targetsHit).
 */
/* global $, calc, gen, createPokemon, createField, loadDefaultLists,
          pokedex, setdex, moves, calcHP, calcStats, showFormes,
          RRCritKO, RRTrainers */
var RRDoubles = (function () {
	"use strict";

	// Captured before the calculator has touched these panels. See file header.
	var PRISTINE = {
		p1: document.getElementById("p1") ? document.getElementById("p1").outerHTML : null,
		p2: document.getElementById("p2") ? document.getElementById("p2").outerHTML : null
	};

	var active = false;
	var built = false;
	// Which opposing slot each panel is aiming at, and which move it uses.
	var aim = {
		p1: {target: "p2", move: null},
		p3: {target: "p4", move: null},
		p2: {target: "p1", move: null},
		p4: {target: "p3", move: null}
	};

	var MINE = ["p1", "p3"], THEIRS = ["p2", "p4"];

	function g() {
		return calc.Generations.get(typeof gen === "number" ? gen : 9);
	}

	function esc(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function pct(value, max) {
		return max ? (100 * value / max).toFixed(1) : "0.0";
	}

	// ------------------------------------------------------------- building

	/**
	 * Stamp a new panel out of the captured markup, giving every id inside it a
	 * suffix so nothing collides with the original.
	 */
	function makePanel(sourceId, newId, legend) {
		var html = PRISTINE[sourceId];
		if (!html) return null;
		var holder = document.createElement("div");
		holder.innerHTML = html;
		var panel = holder.firstChild;
		panel.id = newId;

		var suffix = "_" + newId;
		$(panel).find("[id]").each(function () {
			this.id += suffix;
		});
		$(panel).find("label[for]").each(function () {
			$(this).attr("for", $(this).attr("for") + suffix);
		});
		// Radio groups must stay separate per panel or the panels fight.
		$(panel).find("input[type=radio][name]").each(function () {
			this.name += suffix;
		});
		$(panel).find("legend").text(legend);

		// The calculator fills the move, ability, item, type and nature lists
		// once, in its gen-change handler at startup. A panel stamped later has
		// empty dropdowns, so copy the options across from the live original.
		var src = $("#" + sourceId).find("select").get();
		var dst = $(panel).find("select").get();
		for (var i = 0; i < dst.length && i < src.length; i++) {
			if (dst[i].options.length === 0 && src[i].options.length > 0) {
				dst[i].innerHTML = src[i].innerHTML;
			}
		}
		return panel;
	}

	// The calculator binds its set-selector handler directly at load, so panels
	// created afterwards never receive it. Rather than reach into jQuery's
	// internals to copy handlers onto elements select2 has since rearranged,
	// the new panels get their own filling logic, driven by the same globals.
	var LEGACY = ["hp", "at", "df", "sa", "sd", "sp"];
	var FULL = {hp: "hp", at: "atk", df: "def", sa: "spa", sd: "spd", sp: "spe"};

	/**
	 * Fill in a move's power, type and category.
	 *
	 * Not cosmetic: createPokemon reads .move-bp and .move-type back out as
	 * overrides, so a panel whose move row still says "???" calculates the
	 * wrong damage. The calculator's own handler does this, but only for the
	 * panels that existed when it was bound.
	 */
	function applyMove(element) {
		var sel = $(element);
		var name = sel.val();
		if (typeof moves === "undefined") return;
		var move = moves[name] || moves["(No Move)"];
		if (!move) return;
		var group = sel.parent();
		group.children(".move-bp").val(name === "Present" ? 40 : move.bp);
		group.children(".move-type").val(move.type);
		group.children(".move-cat").val(move.category);
		group.children(".move-crit").prop("checked", move.willCrit === true);

		var hits = group.children(".move-hits");
		if (!hits.length) return;
		var multi = Array.isArray(move.multihit) ||
			(!isNaN(move.multihit) && move.multiaccuracy);
		if (!multi) { hits.empty().hide(); return; }
		var low = Array.isArray(move.multihit) ? move.multihit[0] : 1;
		var high = Array.isArray(move.multihit) ? move.multihit[1] : move.multihit;
		hits.empty();
		for (var i = low; i <= high; i++) {
			hits.append('<option value="' + i + '">' + i + " hits</option>");
		}
		hits.val(high).show();
	}

	/** Only assign a select value the select actually offers. */
	function setIfValid(select, value, fallback) {
		select.val(!value ? fallback
			: (select.children("option[value='" + value + "']").length ? value : fallback));
	}

	/**
	 * Fill a panel from "Species (Set Name)", the value its selector holds.
	 */
	function applySet(panelId) {
		var panel = $("#" + panelId);
		var full = panel.find("input.set-selector").val() || "";
		var cut = full.indexOf(" (");
		var species = cut > 0 ? full.substring(0, cut) : full;
		if (typeof pokedex === "undefined" || !pokedex[species]) return false;
		var dex = pokedex[species];
		var setName = cut > 0
			? full.substring(full.indexOf("(") + 1, full.lastIndexOf(")")) : "";
		var set = (typeof setdex !== "undefined" && setdex[species])
			? setdex[species][setName] : null;

		panel.find(".analysis").removeAttr("href");
		panel.find(".type1").val(dex.types[0]);
		panel.find(".type2").val(dex.types[1] || "");
		panel.find(".teraType").val(dex.types[0]);
		panel.find(".boost").val(0);
		panel.find(".percent-hp").val(100);
		panel.find(".status").val("Healthy");

		panel.find(".hp .base").val(dex.bs.hp);
		for (var i = 0; i < LEGACY.length; i++) {
			panel.find("." + LEGACY[i] + " .base").val(dex.bs[LEGACY[i]]);
			panel.find("." + LEGACY[i] + " .evs").val(
				(set && set.evs && set.evs[LEGACY[i]] !== undefined) ? set.evs[LEGACY[i]] : 0);
			panel.find("." + LEGACY[i] + " .ivs").val(
				(set && set.ivs && set.ivs[LEGACY[i]] !== undefined) ? set.ivs[LEGACY[i]] : 31);
		}
		panel.find(".hp .evs").val((set && set.evs && set.evs.hp !== undefined) ? set.evs.hp : 0);
		panel.find(".hp .ivs").val((set && set.ivs && set.ivs.hp !== undefined) ? set.ivs.hp : 31);
		panel.find(".level").val(set && set.level !== undefined ? set.level : 100);
		panel.find(".nature").val(set && set.nature ? set.nature : "Hardy");
		setIfValid(panel.find(".ability"),
			set && set.ability ? set.ability : (dex.abilities ? dex.abilities[0] : ""),
			dex.abilities ? dex.abilities[0] : "");
		setIfValid(panel.find(".item"), set && set.item ? set.item : "", "");

		// createPokemon reads the species from the forme dropdown whenever one
		// exists, so a panel with an unpopulated forme list reports a null name.
		var formeObj = panel.find(".forme").parent();
		var baseForme = (dex.baseSpecies && dex.baseSpecies !== species)
			? pokedex[dex.baseSpecies] : null;
		try {
			if (dex.otherFormes) {
				showFormes(formeObj, species, dex, species);
			} else if (baseForme && baseForme.otherFormes) {
				showFormes(formeObj, species, baseForme, dex.baseSpecies);
			} else {
				formeObj.hide();
			}
		} catch (e) { /* no formes is a fine outcome */ }

		var setMoves = (set && set.moves) ? set.moves : [];
		for (var m = 0; m < 4; m++) {
			var sel = panel.find(".move" + (m + 1) + " select.move-selector");
			sel.val(setMoves[m] || "(No Move)");
			applyMove(sel[0]);
		}
		try {
			if (typeof calcHP === "function") calcHP(panel);
			if (typeof calcStats === "function") calcStats(panel);
		} catch (e) { /* stats redraw is cosmetic */ }
		return true;
	}

	/** Point one panel at the same set as another, and fill it in. */
	function copySelection(fromId, toId) {
		var value = $("#" + fromId + " input.set-selector").val();
		if (!value) return;
		var to = $("#" + toId);
		to.find("input.set-selector").val(value);
		to.find(".select2-chosen").first().text(value);
		applySet(toId);
	}

	function build() {
		if (built || !PRISTINE.p1 || !PRISTINE.p2) return built;

		var p3 = makePanel("p1", "p3", "Pokémon 3");
		var p4 = makePanel("p2", "p4", "Pokémon 4");
		if (!p3 || !p4) return false;

		$("#p1").closest(".panel").append(p3);
		$("#p2").closest(".panel").append(p4);

		// Give the new panels the same widgets the originals have.
		try {
			if (typeof loadDefaultLists === "function") loadDefaultLists();
		} catch (e) { /* widgets still usable without it */ }
		try {
			$("#p3 .move-selector, #p4 .move-selector").select2({
				dropdownAutoWidth: true,
				matcher: function (term, text) {
					return text.toUpperCase().indexOf(term.toUpperCase()) === 0 ||
						text.toUpperCase().indexOf(" " + term.toUpperCase()) >= 0;
				}
			});
		} catch (e) { /* plain selects are fine too */ }

		// Import / Export belongs below the Pokemon, not between them.
		$(".poke-import").closest("div[role='region']").appendTo(".wrapper");

		$("#p1, #p2, #p3, #p4").each(function () {
			$(this).append('<div class="rr-aimrow" data-panel="' + this.id + '"></div>');
		});
		$(".wrapper").append('<div id="rr-dbl-sums" class="rr-sums"></div>');

		// Start the new panels on the same Pokemon as the ones above them, so
		// the mode is usable the moment it is switched on. loadDefaultLists
		// clears the selectors, so this has to happen after it.
		copySelection("p1", "p3");
		copySelection("p2", "p4");

		built = true;
		return true;
	}

	// ------------------------------------------------------------- reading

	function panelPokemon(id) {
		if (!$("#" + id).length) return null;
		if (id !== "p1" && id !== "p2" && !active) return null;
		try {
			var p = createPokemon($("#" + id));
			return (p && p.name) ? p : null;
		} catch (e) {
			return null;
		}
	}

	function field() {
		var f;
		try {
			f = typeof createField === "function" ? createField() : new calc.Field();
		} catch (e) {
			f = new calc.Field();
		}
		f.gameType = "Doubles";
		return f;
	}

	function asMove(move) {
		if (!move) return null;
		if (typeof move !== "string") return move;
		if (move === "(No Move)") return null;
		try {
			return new calc.Move(g(), move);
		} catch (e) {
			return null;
		}
	}

	function shots(attacker, defender, foes, allies) {
		if (!attacker || !defender) return [];
		var base = field();
		var bonus = (typeof RRTrainers !== "undefined" &&
			RRTrainers.getPrefs().focusEnergy) ? 2 : 0;
		var out = [];
		for (var i = 0; i < attacker.moves.length; i++) {
			var move = asMove(attacker.moves[i]);
			if (!move) { out.push(null); continue; }
			var spread = RRCritKO.targetsHit(move, foes, allies) >= 2;
			var shot = RRCritKO.shotFor(g(), attacker, defender, move,
				RRCritKO.fieldForMove(base, move, foes, allies), bonus);
			if (shot) shot.spread = spread;
			out.push(shot || {move: move.name, dead: true, spread: spread});
		}
		return out;
	}

	function koText(chances) {
		if (!chances || !chances.length) return "";
		for (var n = 0; n < chances.length; n++) {
			if (chances[n] <= 0) continue;
			var label = n === 0 ? "OHKO" : (n + 1) + "HKO";
			if (chances[n] > 0.9995) return label;
			return (chances[n] * 100).toFixed(0) + "% " + label;
		}
		return "";
	}

	// -------------------------------------------------------------- render

	function board() {
		var state = {mon: {}, living: {mine: 0, theirs: 0}};
		var i;
		for (i = 0; i < MINE.length; i++) {
			state.mon[MINE[i]] = panelPokemon(MINE[i]);
			if (state.mon[MINE[i]]) state.living.mine++;
		}
		for (i = 0; i < THEIRS.length; i++) {
			state.mon[THEIRS[i]] = panelPokemon(THEIRS[i]);
			if (state.mon[THEIRS[i]]) state.living.theirs++;
		}
		return state;
	}

	function opposing(id) {
		return MINE.indexOf(id) >= 0 ? THEIRS : MINE;
	}

	function renderAim(state) {
		var all = MINE.concat(THEIRS);
		for (var i = 0; i < all.length; i++) {
			var id = all[i];
			var row = $(".rr-aimrow[data-panel='" + id + "']");
			if (!row.length) continue;
			if (!state.mon[id]) { row.empty(); continue; }

			var foes = opposing(id);
			// Never leave a Pokemon aiming at an empty slot.
			if (!state.mon[aim[id].target]) {
				aim[id].target = state.mon[foes[0]] ? foes[0] : foes[1];
			}
			var html = '<span class="rr-aiml">Target</span>';
			for (var f = 0; f < foes.length; f++) {
				if (!state.mon[foes[f]]) continue;
				html += '<button class="rr-tgt' +
					(aim[id].target === foes[f] ? " rr-on" : "") +
					'" data-panel="' + id + '" data-target="' + foes[f] + '">' +
					esc(state.mon[foes[f]].name) + '</button>';
			}
			row.html(html);
		}
	}

	/**
	 * One line per Pokemon under attack: what the chosen moves do together.
	 */
	function renderSummary(state) {
		var sums = $("#rr-dbl-sums");
		if (!sums.length) return;
		var lines = "";
		var all = MINE.concat(THEIRS);

		for (var d = 0; d < all.length; d++) {
			var defId = all[d];
			var defender = state.mon[defId];
			if (!defender) continue;

			var attackers = opposing(defId);
			var isMine = MINE.indexOf(defId) >= 0;
			var foes = isMine ? state.living.mine : state.living.theirs;
			var allies = (isMine ? state.living.theirs : state.living.mine) - 1;

			var incoming = [], labels = [];
			for (var a = 0; a < attackers.length; a++) {
				var attacker = state.mon[attackers[a]];
				if (!attacker || aim[attackers[a]].target !== defId) continue;
				var list = shots(attacker, defender, foes, allies);
				var pick = aim[attackers[a]].move;
				if (pick === null || !list[pick] || list[pick].dead) {
					pick = -1;
					var bestMax = 0;
					for (var b = 0; b < list.length; b++) {
						if (list[b] && !list[b].dead && list[b].max > bestMax) {
							bestMax = list[b].max; pick = b;
						}
					}
				}
				if (pick < 0 || !list[pick] || list[pick].dead) continue;
				incoming.push(list[pick]);
				labels.push(attacker.name + " " + list[pick].move +
					(list[pick].spread ? " (spread)" : ""));
			}
			if (!incoming.length) continue;

			var min = 0, max = 0;
			for (var k = 0; k < incoming.length; k++) {
				min += incoming[k].min; max += incoming[k].max;
			}
			var chances = RRCritKO.koChancesMulti(incoming, defender.curHP(), 4);
			lines += '<div class="rr-sum' + (chances[0] > 0 ? " rr-danger" : "") + '">' +
				'<span class="rr-st">' + esc(defender.name) + '</span>' +
				'<span class="rr-sd">' + pct(min, defender.maxHP()) + ' - ' +
				pct(max, defender.maxHP()) + '%</span>' +
				'<span class="rr-sk">' + esc(koText(chances) || "no KO") + '</span>' +
				'<span class="rr-sf">' + esc(labels.join(" + ")) + '</span></div>';
		}

		var counts = state.living.mine + "v" + state.living.theirs;
		var note = (state.living.mine < 2 || state.living.theirs < 2)
			? ' <i>spread moves at full damage</i>' : "";
		sums.html('<span class="rr-fmt">' + counts + note + '</span>' +
			(lines || '<span class="rr-note">Give your Pokemon some moves.</span>'));
	}

	function refresh() {
		if (!active) return;
		var state;
		try {
			state = board();
		} catch (e) {
			return;
		}
		renderAim(state);
		renderSummary(state);
	}

	/** Load one of the sheet's Pokemon into a panel. */
	function loadEnemyInto(battle, mon, panelId) {
		if (!mon || typeof RRTrainers === "undefined" || !RRTrainers.enemySetId) return;
		var id = RRTrainers.enemySetId(battle, mon);
		if (!id) return;
		var panel = $("#" + panelId);
		panel.find("input.set-selector").val(id);
		panel.find(".select2-chosen").first().text(id);
		if (panelId === "p2" || panelId === "p1") {
			// These carry the calculator's own handler; let it do the work.
			panel.find("input.set-selector").change();
		} else {
			applySet(panelId);
		}
	}

	// --------------------------------------------------------------- mode

	function setActive(on) {
		if (on === active) return;
		if (on && !build()) return;
		active = on;
		$("#p3, #p4").toggle(on);
		$(".rr-aimrow").toggle(on);
		$("#rr-dbl-sums").toggle(on);
		$("body").toggleClass("rr-doubles-on", on);
		$("#rr-mode-doubles").toggleClass("rr-on", on)
			.text(on ? "Doubles: on" : "Doubles: off");
		refresh();
	}

	function bind() {
		$(document).on("click", "#rr-mode-doubles", function () {
			setActive(!active);
		});
		$(document).on("change", "#p3 select.move-selector, #p4 select.move-selector",
			function () {
				applyMove(this);
				refresh();
			});
		$(document).on("change", "#p3 input.set-selector, #p4 input.set-selector",
			function () {
				applySet($(this).closest(".poke-info").attr("id"));
				refresh();
			});
		$(document).on("click", ".rr-tgt", function () {
			var panel = $(this).data("panel");
			aim[panel].target = $(this).data("target");
			aim[panel].move = null;
			refresh();
		});
		// Any edit anywhere in the calculator changes the answer.
		$(document).on("change keyup", ".poke-info input, .poke-info select, " +
			".field-info input, .field-info select", function () {
			if (active) refresh();
		});

		if (typeof RRTrainers !== "undefined" && RRTrainers.onBattleChange) {
			RRTrainers.onBattleChange(function (battle) {
				var doubles = !!(battle && RRTrainers.isDoubles(battle));
				setActive(doubles);
				if (!doubles) return;
				// Put the first two of the enemy team on the board.
				loadEnemyInto(battle, battle.team[0], "p2");
				loadEnemyInto(battle, battle.team[1], "p4");
				refresh();
			});
		}
	}

	$(function () {
		if (typeof RRCritKO === "undefined") return;
		$(".modeSelection").append(
			'<button id="rr-mode-doubles" class="btn" type="button">Doubles: off</button>');
		bind();
	});

	return {
		enable: function () { setActive(true); },
		disable: function () { setActive(false); },
		isActive: function () { return active; },
		refresh: refresh
	};
})();
