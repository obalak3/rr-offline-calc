/**
 * rr-dex.js -- the Radical Red Pokedex, offline.
 *
 * A Pokedex button beside the mode buttons swaps the page from the calculator
 * to a dex: search on the left, the selected Pokemon on the right, with types,
 * base stats, abilities and their descriptions, evolutions, and the full
 * movepool split into level-up, TM, tutor and egg moves. Clicking a Pokemon's
 * name in an evolution chain jumps to it; a "Load into Pokemon 1" button hands
 * it back to the calculator.
 *
 * The data is bundled by tools/build_dex.js and loaded lazily, on the first
 * time the dex is opened, by appending a script tag. Nothing is fetched: a
 * script tag works from file:// exactly as the rest of the page does, and the
 * calculator does not pay the bundle's parse cost unless the dex is used.
 */
/* global $, RR_DEX_DATA, pokedex, RRTrainers */
var RRDex = (function () {
	"use strict";

	var DATA_SRC = "./js/data/rr-dex-data.js";

	var active = false;
	var built = false;
	var loading = false;
	var current = null;
	var order = [];          // species ids, in dex order

	function data() {
		return (typeof RR_DEX_DATA !== "undefined") ? RR_DEX_DATA : null;
	}

	function esc(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	// --------------------------------------------------------- loading data

	/**
	 * Pull in the bundle the first time the dex is opened.
	 *
	 * A script tag rather than fetch: fetch is blocked on file:// pages, which
	 * is exactly where this needs to work.
	 */
	function ensureData(then) {
		if (data()) { then(true); return; }
		if (loading) return;
		loading = true;
		$("#rr-dex-detail").html('<div class="rr-dex-msg">Loading Pokédex…</div>');
		var script = document.createElement("script");
		script.src = DATA_SRC;
		script.onload = function () {
			loading = false;
			then(!!data());
		};
		script.onerror = function () {
			loading = false;
			$("#rr-dex-detail").html('<div class="rr-dex-msg">Could not load ' +
				esc(DATA_SRC) + '. Run <code>node tools/build_dex.js</code> and rebuild.</div>');
		};
		document.body.appendChild(script);
	}

	function prepare() {
		var d = data();
		if (!d || order.length) return;
		order = Object.keys(d.species);
		order.sort(function (a, b) {
			var sa = d.species[a], sb = d.species[b];
			var da = sa.dexID || 9999, db = sb.dexID || 9999;
			if (da !== db) return da - db;
			return sa.name < sb.name ? -1 : 1;
		});
	}

	// -------------------------------------------------------------- helpers

	// The snapshot stores stats in the games' internal order.
	var STAT_ORDER = ["HP", "Atk", "Def", "Spe", "SpA", "SpD"];
	var STAT_MAX = 200;   // bar scale; anything past this simply fills the bar

	function typeChip(name) {
		var d = data();
		var colour = "#777";
		for (var key in d.types) {
			if (d.types[key].name === name) { colour = d.types[key].color; break; }
		}
		return '<span class="rr-dex-type" style="background:' + esc(colour) + '">' +
			esc(name) + "</span>";
	}

	function sprite(id) {
		var d = data();
		var src = d.sprites && d.sprites[id];
		return src ? '<img class="rr-dex-sprite" alt="" src="' + src + '">' : "";
	}

	function moveRow(moveId, level) {
		var d = data();
		var m = d.moves[moveId];
		if (!m) return "";
		return "<tr>" +
			(level === undefined ? "" : "<td class='rr-dex-lv'>" +
				(level === 0 ? "&mdash;" : level) + "</td>") +
			"<td>" + esc(m.name) + "</td>" +
			"<td>" + typeChip(m.type) + "</td>" +
			"<td>" + esc(m.split) + "</td>" +
			"<td class='rr-dex-num'>" + (m.power || "&mdash;") + "</td>" +
			"<td class='rr-dex-num'>" + (m.accuracy || "&mdash;") + "</td>" +
			"<td class='rr-dex-num'>" + (m.pp || "&mdash;") + "</td>" +
			"<td class='rr-dex-txt'>" + esc(m.text) + "</td></tr>";
	}

	function moveTable(ids, withLevel) {
		if (!ids || !ids.length) return "";
		var html = '<div class="rr-dex-table-wrap"><table class="rr-dex-moves"><thead><tr>' +
			(withLevel ? "<th>Lv</th>" : "") +
			"<th>Move</th><th>Type</th><th>Kind</th><th>Pow</th><th>Acc</th><th>PP</th>" +
			"<th>Effect</th></tr></thead><tbody>";
		for (var i = 0; i < ids.length; i++) {
			html += withLevel ? moveRow(ids[i][0], ids[i][1]) : moveRow(ids[i]);
		}
		return html + "</tbody></table></div>";
	}

	// --------------------------------------------------------------- render

	function renderList(query) {
		var d = data();
		prepare();
		var terms = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
		var html = "";
		var shown = 0;
		for (var i = 0; i < order.length; i++) {
			var s = d.species[order[i]];
			if (terms.length) {
				var hay = (s.name + " " + s.types.join(" ") + " " +
					(s.formNote || "")).toLowerCase();
				var ok = true;
				for (var t = 0; t < terms.length; t++) {
					if (hay.indexOf(terms[t]) === -1) { ok = false; break; }
				}
				if (!ok) continue;
			}
			shown++;
			if (shown > 400) break;   // keep the DOM sane; refine the search
			html += '<button class="rr-dex-item' +
				(current === s.id ? " rr-on" : "") + '" data-id="' + s.id + '">' +
				sprite(s.id) + '<span class="rr-dex-iname">' + esc(s.name) +
				(s.formNote ? '<i class="rr-dex-form">' + esc(s.formNote) + "</i>" : "") +
				"</span>" +
				'<span class="rr-dex-itypes">' + s.types.map(typeChip).join("") +
				"</span></button>";
		}
		$("#rr-dex-list").html(html ||
			'<div class="rr-dex-msg">Nothing matches.</div>');
	}

	function renderDetail() {
		var d = data();
		var s = current !== null ? d.species[current] : null;
		if (!s) {
			$("#rr-dex-detail").html(
				'<div class="rr-dex-msg">Pick a Pokémon.</div>');
			return;
		}

		var total = 0;
		for (var i = 0; i < 6; i++) total += s.stats[i] || 0;

		var html = '<div class="rr-dex-head">' + sprite(s.id) +
			'<div><h2>' + esc(s.name) +
			(s.formNote ? ' <span class="rr-dex-formbig">' + esc(s.formNote) +
				"</span>" : "") + "</h2>" +
			'<div class="rr-dex-sub">#' + (s.dexID || "?") + " " +
			s.types.map(typeChip).join("") + "</div>" +
			'<button id="rr-dex-load" class="rr-dex-btn">Load into Pokémon 1</button>' +
			"</div></div>";

		html += '<div class="rr-dex-stats">';
		for (i = 0; i < 6; i++) {
			var value = s.stats[i] || 0;
			var width = Math.min(100, Math.round(100 * value / STAT_MAX));
			html += '<div class="rr-dex-stat"><span class="rr-dex-sname">' +
				STAT_ORDER[i] + '</span><span class="rr-dex-sval">' + value +
				'</span><span class="rr-dex-bar"><i style="width:' + width + '%"></i>' +
				"</span></div>";
		}
		html += '<div class="rr-dex-stat rr-dex-total"><span class="rr-dex-sname">' +
			'Total</span><span class="rr-dex-sval">' + total + "</span></div></div>";

		if (s.abilities.length) {
			html += '<h3>Abilities</h3><ul class="rr-dex-abilities">';
			for (i = 0; i < s.abilities.length; i++) {
				var a = s.abilities[i];
				html += "<li><b>" + esc(a.name) + "</b>" +
					(a.hidden ? ' <span class="rr-dex-hidden">hidden</span>' : "") +
					(a.text ? '<span class="rr-dex-txt">' + esc(a.text) + "</span>" : "") +
					"</li>";
			}
			html += "</ul>";
		}

		if (s.eggGroups.length) {
			html += '<div class="rr-dex-line"><b>Egg groups</b> ' +
				esc(s.eggGroups.join(", ")) + "</div>";
		}

		if (s.evolutions.length) {
			html += "<h3>Evolves into</h3><ul class='rr-dex-evos'>";
			for (i = 0; i < s.evolutions.length; i++) {
				var e = s.evolutions[i];
				html += "<li>" + (e.into
					? '<button class="rr-dex-link" data-id="' + e.intoId + '">' +
						esc(e.into) + "</button>"
					: "<i>unknown</i>") +
					(e.how ? ' <span class="rr-dex-txt">' + esc(e.how) + "</span>" : "") +
					"</li>";
			}
			html += "</ul>";
		}

		if (s.levelup.length) {
			html += "<h3>Level-up moves</h3>" + moveTable(s.levelup, true);
		}
		if (s.tms.length) html += "<h3>TM moves</h3>" + moveTable(s.tms, false);
		if (s.tutors.length) html += "<h3>Tutor moves</h3>" + moveTable(s.tutors, false);
		if (s.eggMoves.length) html += "<h3>Egg moves</h3>" + moveTable(s.eggMoves, false);

		$("#rr-dex-detail").html(html);
	}

	function render() {
		if (!data()) return;
		renderList($("#rr-dex-search").val());
		renderDetail();
	}

	// ----------------------------------------------------------- the panel

	function build() {
		if (built) return;
		$(".wrapper").first().append(
			'<div id="rr-dex">' +
				'<div class="rr-dex-bar">' +
					'<h2 class="rr-dex-title">Pokédex</h2>' +
					'<button id="rr-dex-back" class="btn btn-wide" type="button">' +
						'&larr; Back to calculator</button>' +
				'</div>' +
				'<div id="rr-dex-body">' +
					'<div class="rr-dex-side">' +
						'<input id="rr-dex-search" type="text" ' +
							'placeholder="Search name or type…" />' +
						'<div id="rr-dex-list" class="rr-dex-list"></div>' +
					"</div>" +
					'<div id="rr-dex-detail" class="rr-dex-detail"></div>' +
				"</div>" +
			"</div>");
		built = true;
	}

	/** Hand a Pokemon back to the calculator. */
	function loadIntoCalculator(name) {
		if (typeof pokedex === "undefined" || !pokedex[name]) {
			window.alert("The calculator has no entry for " + name + ".");
			return;
		}
		var id = name + " (Blank Set)";
		var slot = $("#p1");
		slot.find("input.set-selector").val(id);
		slot.find(".select2-container.set-selector .select2-chosen").first().text(id);
		slot.find("input.set-selector").change();
		slot.find(".select2-container.set-selector .select2-chosen").first().text(id);
		setActive(false);
	}

	function setActive(on) {
		if (on === active) return;
		active = on;
		$("body").toggleClass("rr-dex-on", on);
		$("#rr-view-dex").prop("checked", on);
		if (!on) return;
		build();
		$("#rr-dex").show();
		ensureData(function (ok) {
			if (!ok) return;
			if (current === null) {
				prepare();
				current = order.length ? data().species[order[0]].id : null;
			}
			render();
		});
	}

	function bind() {
		$(document).on("change", "#rr-view-dex", function () {
			setActive($(this).prop("checked"));
		});
		$(document).on("click", "#rr-dex-back", function () {
			setActive(false);
		});
		$(document).on("input", "#rr-dex-search", function () {
			renderList($(this).val());
			// Show the first match rather than leaving whatever was open before,
			// which otherwise reads as the search having done nothing.
			var first = $("#rr-dex-list .rr-dex-item").first();
			if (!first.length) return;
			if (!$("#rr-dex-list .rr-dex-item.rr-on").length) {
				current = ~~first.data("id");
				renderList($(this).val());
				renderDetail();
			}
		});
		$(document).on("click", ".rr-dex-item, .rr-dex-link", function () {
			current = ~~$(this).data("id");
			render();
			var detail = document.getElementById("rr-dex-detail");
			if (detail) detail.scrollTop = 0;
		});
		$(document).on("click", "#rr-dex-load", function () {
			var s = data().species[current];
			if (s) loadIntoCalculator(s.name);
		});
	}

	$(function () {
		bind();
	});

	return {
		open: function () { setActive(true); },
		close: function () { setActive(false); },
		isActive: function () { return active; },
		show: function (name) {
			setActive(true);
			ensureData(function (ok) {
				if (!ok) return;
				prepare();
				var d = data();
				for (var i = 0; i < order.length; i++) {
					if (d.species[order[i]].name === name) {
						current = d.species[order[i]].id;
						break;
					}
				}
				render();
			});
		}
	};
})();
