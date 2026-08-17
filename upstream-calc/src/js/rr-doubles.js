/**
 * rr-doubles.js -- double battle mode for the calculator itself.
 *
 * Switching this on turns the page into a 2v2 rather than adding anything
 * beside it:
 *
 *   - Pokemon 3 appears under Pokemon 1 and Pokemon 4 under Pokemon 2, as real
 *     panels with every control the originals have, and Import/Export moves
 *     below them.
 *   - The results block at the top grows from two move lists to four, laid out
 *     2x2 so it mirrors the panels beneath it. Every move row gains a target
 *     button per opposing Pokemon, and the damage shown is against whichever
 *     target that move is currently pointed at.
 *   - When the selected moves of two Pokemon point at the same target, a
 *     combined line reports what they do together, which is the question a
 *     doubles turn actually poses.
 *
 * That combined figure is not a sum of averages. Each attack rolls damage and
 * crits independently, so the chance the total is lethal is a convolution
 * (RRCritKO.koChancesMulti). Empty slots give 2v1, where a spread move that now
 * reaches a single target deals full damage (RRCritKO.targetsHit).
 *
 * The extra panels are stamped from the pristine markup of the originals,
 * captured at parse time: the calculator wires select2 on to them inside
 * $(document).ready, and this file's top-level code runs before any ready
 * handler. Cloning the live panels instead carries broken widget state.
 */
/* global $, calc, gen, createPokemon, createField, loadDefaultLists,
          pokedex, setdex, moves, calcHP, calcStats, showFormes,
          RRCritKO, RRTrainers */
var RRDoubles = (function () {
	"use strict";

	// Captured before the calculator has touched these. See the file header.
	var PRISTINE = {
		p1: document.getElementById("p1") ? document.getElementById("p1").outerHTML : null,
		p2: document.getElementById("p2") ? document.getElementById("p2").outerHTML : null
	};

	var MINE = ["p1", "p3"], THEIRS = ["p2", "p4"];
	var ALL = ["p1", "p2", "p3", "p4"];
	var SLOT_LABEL = {p1: "1", p2: "2", p3: "3", p4: "4"};
	// Which result rows belong to which panel. L and R already exist upstream.
	var ROW_PREFIX = {p1: "L", p2: "R", p3: "M", p4: "N"};

	var active = false;
	var built = false;
	// targets[panelId][moveIndex] = the opposing panel that move is aimed at.
	var targets = {p1: [], p2: [], p3: [], p4: []};
	// chosen[panelId] = the move index that Pokemon will actually use.
	//
	// This cannot ride on the result-move radios: they all share one name, so
	// the browser allows exactly one selected move across the whole page, while
	// a doubles turn needs one per Pokemon. Clicking a target button picks both
	// the move and who it hits, which is the same gesture either way.
	var chosen = {p1: null, p2: null, p3: null, p4: null};

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

	function opposing(id) {
		return MINE.indexOf(id) >= 0 ? THEIRS : MINE;
	}

	// ------------------------------------------------------------- building

	/**
	 * Stamp a new panel out of the captured markup, suffixing every id so
	 * nothing collides with the original.
	 */
	function makePanel(sourceId, newId, legend) {
		var html = PRISTINE[sourceId];
		if (!html) return null;
		var holder = document.createElement("div");
		holder.innerHTML = html;
		var panel = holder.firstChild;
		panel.id = newId;

		var suffix = "_" + newId;
		$(panel).find("[id]").each(function () { this.id += suffix; });
		$(panel).find("label[for]").each(function () {
			$(this).attr("for", $(this).attr("for") + suffix);
		});
		$(panel).find("input[type=radio][name]").each(function () {
			this.name += suffix;
		});
		$(panel).find("legend").text(legend);

		// The calculator fills the move, ability, item, type and nature lists
		// once, in its gen-change handler at startup, so a panel stamped later
		// has empty dropdowns. Copy the options from the live original.
		var src = $("#" + sourceId).find("select").get();
		var dst = $(panel).find("select").get();
		for (var i = 0; i < dst.length && i < src.length; i++) {
			if (dst[i].options.length === 0 && src[i].options.length > 0) {
				dst[i].innerHTML = src[i].innerHTML;
			}
		}
		return panel;
	}

	/**
	 * A third and fourth move list, built from the markup of the existing two so
	 * they match in structure and styling exactly.
	 */
	function makeResultGroup(source, panelId, title) {
		if (!source || !source.length) return null;
		var holder = document.createElement("div");
		holder.innerHTML = source[0].outerHTML;
		var group = $(holder.firstChild);
		var prefix = ROW_PREFIX[panelId];

		group.addClass("rr-extra-result");
		group.attr("aria-labelledby", "resultHeader" + prefix);
		group.find(".result-move-header span")
			.attr("id", "resultHeader" + prefix).text(title);
		group.find("input.result-move").each(function (i) {
			this.id = "resultMove" + prefix + (i + 1);
			this.checked = false;
			$(this).attr("aria-describedby", "resultDamage" + prefix + (i + 1));
		});
		group.find("label.btn").each(function (i) {
			$(this).attr("for", "resultMove" + prefix + (i + 1)).text("(No Move)");
		});
		group.find("span[id^='resultDamage']").each(function (i) {
			this.id = "resultDamage" + prefix + (i + 1);
			$(this).text("0 - 0%");
		});
		return group[0];
	}

	function build() {
		if (built || !PRISTINE.p1 || !PRISTINE.p2) return built;

		var p3 = makePanel("p1", "p3", "Pokémon 3");
		var p4 = makePanel("p2", "p4", "Pokémon 4");
		if (!p3 || !p4) return false;

		$("#p1").closest(".panel").append(p3);
		$("#p2").closest(".panel").append(p4);

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

		// Two more move lists. The subgroups float at 50% width, so appending
		// in this order wraps them into 1 | 2 over 3 | 4, matching how the
		// panels are stacked below.
		var subgroups = $(".move-result-group .move-result-subgroup");
		var g3 = makeResultGroup(subgroups.eq(0), "p3", "Pokémon 3's Moves");
		var g4 = makeResultGroup(subgroups.eq(1), "p4", "Pokémon 4's Moves");
		$(".move-result-group").append(g3).append(g4);

		// A target control on every move row, and a home for the combined
		// result directly under the move grid rather than at the page end.
		$(".move-result-group .move-result-subgroup").each(function (index) {
			var panelId = ALL[index];
			if (!panelId) return;
			$(this).find("span[id^='resultDamage']").each(function (row) {
				$(this).after('<span class="rr-aim" data-panel="' + panelId +
					'" data-move="' + row + '"></span>');
			});
		});
		$(".move-result-group").after('<div id="rr-dbl-combined"></div>');

		copySelection("p1", "p3");
		copySelection("p2", "p4");

		built = true;
		return true;
	}

	// ------------------------------------------------------ filling a panel

	var LEGACY = ["hp", "at", "df", "sa", "sd", "sp"];

	/**
	 * The visible text of a panel's set-selector. Must be written directly:
	 * this select2 sits on an input with no initSelection, so asking select2 to
	 * set the value re-renders the label from nothing and restores the old text.
	 */
	function setLabel(panel, id) {
		panel.find(".select2-container.set-selector .select2-chosen").first().text(id);
	}

	/** Only assign a select value the select actually offers. */
	function setIfValid(select, value, fallback) {
		select.val(!value ? fallback
			: (select.children("option[value='" + value + "']").length ? value : fallback));
	}

	/**
	 * Fill in a move's power, type and category.
	 *
	 * Not cosmetic: createPokemon reads .move-bp and .move-type back out as
	 * overrides, so a move row still reading "???" calculates wrong damage.
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

	/**
	 * Fill a panel from "Species (Set Name)", the value its selector holds.
	 *
	 * The calculator binds its own set-selector handler directly at load, so
	 * panels created afterwards never receive it and need their own.
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
		// exists, and returns a null name if that list was never populated.
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

	function copySelection(fromId, toId) {
		var value = $("#" + fromId + " input.set-selector").val();
		if (!value) return;
		var to = $("#" + toId);
		to.find("input.set-selector").val(value);
		setLabel(to, value);
		applySet(toId);
	}

	/** Load one of the sheet's Pokemon into a panel. */
	function loadEnemyInto(battle, mon, panelId) {
		if (!mon || typeof RRTrainers === "undefined" || !RRTrainers.enemySetId) return;
		var id = RRTrainers.enemySetId(battle, mon);
		if (!id) return;
		var panel = $("#" + panelId);
		panel.find("input.set-selector").val(id);
		setLabel(panel, id);
		if (panelId === "p1" || panelId === "p2") {
			panel.find("input.set-selector").change();
		} else {
			applySet(panelId);
		}
		setLabel(panel, id);
	}

	// ------------------------------------------------------------- reading

	function panelPokemon(id) {
		if (!$("#" + id).length) return null;
		if ((id === "p3" || id === "p4") && !active) return null;
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

	/** One attacker's four moves against one defender. */
	function shots(attacker, defender, foes, allies) {
		var out = [null, null, null, null];
		if (!attacker || !defender) return out;
		var base = field();
		var bonus = (typeof RRTrainers !== "undefined" &&
			RRTrainers.getPrefs().focusEnergy) ? 2 : 0;
		for (var i = 0; i < 4; i++) {
			var move = asMove(attacker.moves[i]);
			if (!move) continue;
			var spread = RRCritKO.targetsHit(move, foes, allies) >= 2;
			var shot = RRCritKO.shotFor(g(), attacker, defender, move,
				RRCritKO.fieldForMove(base, move, foes, allies), bonus);
			if (shot) shot.spread = spread;
			out[i] = shot || {move: move.name, dead: true, spread: spread};
		}
		return out;
	}

	function koText(chances) {
		if (!chances || !chances.length) return "";
		for (var n = 0; n < chances.length; n++) {
			if (chances[n] <= 0) continue;
			var label = n === 0 ? "OHKO" : (n + 1) + "HKO";
			if (chances[n] > 0.9995) return "guaranteed " + label;
			return (chances[n] * 100).toFixed(1) + "% chance to " + label;
		}
		return "";
	}

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

	/** Which Pokemon a move is aimed at, defaulting to the first one alive. */
	function targetOf(state, panelId, moveIndex) {
		var foes = opposing(panelId);
		var chosen = targets[panelId][moveIndex];
		if (chosen && state.mon[chosen]) return chosen;
		return state.mon[foes[0]] ? foes[0] : (state.mon[foes[1]] ? foes[1] : null);
	}

	/**
	 * The move a Pokemon will use. Falls back to its hardest hitting one, so
	 * the combined line says something before anything has been clicked.
	 */
	function selectedRow(panelId, list) {
		if (chosen[panelId] !== null && list && list[chosen[panelId]] &&
			!list[chosen[panelId]].dead) {
			return chosen[panelId];
		}
		var best = -1, bestMax = 0;
		if (list) {
			for (var row = 0; row < 4; row++) {
				if (list[row] && !list[row].dead && list[row].max > bestMax) {
					bestMax = list[row].max;
					best = row;
				}
			}
		}
		return best;
	}

	/**
	 * What to call a target on a button. Both opposing slots often hold the same
	 * species -- two Chillets give two buttons both reading "Chillet" -- so the
	 * slot number is added whenever the names would otherwise be identical.
	 */
	function targetName(state, panelId) {
		var mon = state.mon[panelId];
		if (!mon) return "";
		var others = opposing(opposing(panelId)[0]);
		for (var i = 0; i < others.length; i++) {
			if (others[i] === panelId) continue;
			var other = state.mon[others[i]];
			if (other && other.name === mon.name) {
				return mon.name + " #" + SLOT_LABEL[panelId];
			}
		}
		return mon.name;
	}

	// -------------------------------------------------------------- render

	function renderPanelRows(state, panelId) {
		var attacker = state.mon[panelId];
		var prefix = ROW_PREFIX[panelId];
		var foes = opposing(panelId);
		var isMine = MINE.indexOf(panelId) >= 0;
		var foeCount = isMine ? state.living.theirs : state.living.mine;
		var allyCount = (isMine ? state.living.mine : state.living.theirs) - 1;

		$("#resultHeader" + prefix).text(
			(attacker ? attacker.name : "Pokémon " + SLOT_LABEL[panelId]) +
			"'s Moves (select one to aim it)");

		// Damage depends on each row's own target, so rows are computed against
		// their own defender rather than one shared opponent.
		var cache = {};
		for (var row = 0; row < 4; row++) {
			var damageEl = $("#resultDamage" + prefix + (row + 1));
			var labelEl = $("label[for='resultMove" + prefix + (row + 1) + "']");
			var aimEl = $(".rr-aim[data-panel='" + panelId + "'][data-move='" + row + "']");
			if (!attacker) {
				labelEl.text("(No Move)");
				damageEl.text("0 - 0%");
				aimEl.empty();
				continue;
			}

			var targetId = targetOf(state, panelId, row);
			var defender = targetId ? state.mon[targetId] : null;
			if (targetId && !cache[targetId]) {
				cache[targetId] = shots(attacker, defender, foeCount, allyCount);
			}
			var shot = targetId ? cache[targetId][row] : null;

			labelEl.text(shot ? shot.move : "(No Move)");
			if (!shot || shot.dead || !defender) {
				damageEl.text("0 - 0%");
			} else {
				damageEl.text(pct(shot.min, defender.maxHP()) + " - " +
					pct(shot.max, defender.maxHP()) + "%" +
					(shot.spread ? " (spread)" : ""));
			}

			// One target button per living opponent, worth showing only when
			// the move can actually do something.
			var using = selectedRow(panelId, cache[targetId]) === row;
			labelEl.toggleClass("rr-using", !!(using && shot && !shot.dead));

			var html = "";
			if (shot && !shot.dead && foeCount > 0) {
				for (var f = 0; f < foes.length; f++) {
					if (!state.mon[foes[f]]) continue;
					html += '<button type="button" class="rr-tgt' +
						(targetId === foes[f] ? " rr-on" : "") +
						'" data-panel="' + panelId + '" data-move="' + row +
						'" data-target="' + foes[f] + '">' +
						esc(targetName(state, foes[f])) + "</button>";
				}
			}
			aimEl.html(html);
		}
	}

	/** What the selected moves aimed at each Pokemon do together. */
	function renderCombined(state) {
		var box = $("#rr-dbl-combined");
		if (!box.length) return;
		var lines = "";

		for (var d = 0; d < ALL.length; d++) {
			var defId = ALL[d];
			var defender = state.mon[defId];
			if (!defender) continue;

			var attackers = opposing(defId);
			var isMine = MINE.indexOf(defId) >= 0;
			var foeCount = isMine ? state.living.mine : state.living.theirs;
			var allyCount = (isMine ? state.living.theirs : state.living.mine) - 1;

			var incoming = [], labels = [];
			for (var a = 0; a < attackers.length; a++) {
				var attacker = state.mon[attackers[a]];
				if (!attacker) continue;
				var list = shots(attacker, defender, foeCount, allyCount);
				var row = selectedRow(attackers[a], list);
				if (row < 0) continue;
				if (targetOf(state, attackers[a], row) !== defId) continue;
				incoming.push(list[row]);
				labels.push(targetName(state, attackers[a]) + "'s " + list[row].move);
			}
			if (incoming.length < 2) continue;

			var min = 0, max = 0;
			for (var k = 0; k < incoming.length; k++) {
				min += incoming[k].min; max += incoming[k].max;
			}
			var chances = RRCritKO.koChancesMulti(incoming, defender.curHP(), 4);
			lines += '<div class="rr-comb' + (chances[0] > 0 ? " rr-lethal" : "") + '">' +
				esc(labels.join(" + ")) + " vs. " + esc(targetName(state, defId)) + ": " +
				min + "-" + max + " (" + pct(min, defender.maxHP()) + " - " +
				pct(max, defender.maxHP()) + "%) &mdash; " +
				esc(koText(chances) || "not a KO") + "</div>";
		}

		var counts = state.living.mine + "v" + state.living.theirs;
		var note = (state.living.mine < 2 || state.living.theirs < 2)
			? " <i>spread moves at full damage</i>" : "";
		box.html('<div class="rr-comb-head">' + counts + note + "</div>" +
			(lines || '<div class="rr-comb-none">Select a move on two Pokémon and ' +
				"aim both at the same target to see their combined result.</div>"));
	}

	function refresh() {
		if (!active) return;
		var state;
		try {
			state = board();
		} catch (e) {
			return;
		}
		for (var i = 0; i < ALL.length; i++) renderPanelRows(state, ALL[i]);
		renderCombined(state);
	}

	// ----------------------------------------------------------------- mode

	function setActive(on) {
		if (on === active) return;
		if (on && !build()) return;
		active = on;
		$("#p3, #p4").toggle(on);
		$(".rr-extra-result").toggle(on);
		$(".rr-aim").toggle(on);
		$("#rr-dbl-combined").toggle(on);
		$("body").toggleClass("rr-doubles-on", on);
		$("#rr-mode-doubles").toggleClass("rr-on", on)
			.text(on ? "Doubles: on" : "Doubles: off");
		if (typeof RRTrainers !== "undefined" && RRTrainers.setFacing) {
			// Re-apply under the new capacity: one opponent in singles, two in
			// doubles, so a leftover second pick cannot linger.
			RRTrainers.setFacing(RRTrainers.getFacing());
		}
		if (!on) {
			// Hand the result rows back to the calculator's own routine.
			try {
				if (typeof window.performCalculations === "function") {
					window.performCalculations();
				}
			} catch (e) { /* nothing to restore */ }
		}
		refresh();
	}

	function bind() {
		$(document).on("click", "#rr-mode-doubles", function () {
			setActive(!active);
		});

		$(document).on("click", ".rr-tgt", function (event) {
			event.preventDefault();
			var panel = $(this).data("panel");
			var row = ~~$(this).data("move");
			targets[panel][row] = $(this).data("target");
			chosen[panel] = row;
			refresh();
		});

		// Which move each Pokemon is set to use changes the combined result.
		$(document).on("change", "input.result-move", function () {
			if (active) refresh();
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

		// Any edit anywhere in the calculator changes the answer.
		$(document).on("change keyup", ".poke-info input, .poke-info select, " +
			".field-info input, .field-info select", function () {
			if (active) refresh();
		});

		// Upstream rewrites the result rows on every recalculation, so ours go
		// back on afterwards.
		if (typeof window.performCalculations === "function") {
			var original = window.performCalculations;
			window.performCalculations = function () {
				var out = original.apply(this, arguments);
				try { refresh(); } catch (e) { /* never break the calculator */ }
				return out;
			};
		}

		if (typeof RRTrainers !== "undefined" && RRTrainers.onFacingChange) {
			RRTrainers.onFacingChange(function (battle, facing) {
				if (!active || !battle) return;
				if (facing.length > 1) {
					loadEnemyInto(battle, battle.team[facing[1]], "p4");
				} else {
					$("#p4 input.set-selector").val("");
					setLabel($("#p4"), "(empty)");
				}
				refresh();
			});
		}

		if (typeof RRTrainers !== "undefined" && RRTrainers.onBattleChange) {
			RRTrainers.onBattleChange(function (battle) {
				setActive(!!(battle && RRTrainers.isDoubles(battle)));
				if (!active || !battle) return;
				RRTrainers.setFacing([0, 1]);
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
