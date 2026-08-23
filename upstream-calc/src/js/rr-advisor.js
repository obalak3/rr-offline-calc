/**
 * rr-advisor.js -- the battle advisor, in the page.
 *
 * Everything it shows comes from rr-plan and rr-solver; this file only collects
 * the position you are actually in and renders the answer. Your team comes from
 * the saved team the trainer panel already manages, and the enemy from the
 * selected battle, so nothing has to be typed twice.
 *
 * Two questions, deliberately separate:
 *
 *   "What should I click" ranks this turn's options on the worst reply the
 *   opponent has, switches included.
 *
 *   "Check this fight" asks the Nuzlocke question instead -- is there a route
 *   where NOTHING of yours dies -- and reports how much bad luck that route
 *   survives, rung by rung.
 */
/* global $, RRBattle, RRPlan, RRSolver, RRAI */
(function () {
	"use strict";

	var STATUSES = [["", "healthy"], ["par", "paralysed"], ["brn", "burned"],
		["psn", "poisoned"], ["tox", "badly poisoned"], ["slp", "asleep"],
		["frb", "frostbitten"]];

	function esc(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function ready() {
		return typeof RRBattle !== "undefined" && typeof RRPlan !== "undefined" &&
			typeof window.RRTrainers !== "undefined";
	}

	/** A calc.Pokemon back into the plain set the engine takes. */
	function setFromCalc(pokemon) {
		if (!pokemon) return null;
		return {
			species: pokemon.name,
			level: pokemon.level,
			nature: pokemon.nature || "Serious",
			ability: pokemon.ability || undefined,
			item: pokemon.item || "",
			moves: (pokemon.moves || []).filter(function (m) { return m && m !== "(No Move)"; }),
			evs: {hp: pokemon.evs.hp, atk: pokemon.evs.atk, def: pokemon.evs.def,
				spa: pokemon.evs.spa, spd: pokemon.evs.spd, spe: pokemon.evs.spe},
			ivs: {hp: pokemon.ivs.hp, atk: pokemon.ivs.atk, def: pokemon.ivs.def,
				spa: pokemon.ivs.spa, spd: pokemon.ivs.spd, spe: pokemon.ivs.spe}
		};
	}

	function myTeamSets() {
		var team = window.RRTrainers.getTeam() || [];
		// The trainer panel caches the team at startup, so fall back to what is
		// actually stored. That covers a team saved in another tab, and it is
		// what lets the panel be driven headlessly.
		if (!team.length) {
			try {
				team = JSON.parse(window.localStorage.getItem("rrTeam") || "[]") || [];
			} catch (e) {
				team = [];
			}
		}
		return team.map(function (member) {
			return {
				species: member.species,
				level: member.level,
				nature: member.nature || "Serious",
				ability: member.ability || undefined,
				item: member.item || "",
				moves: (member.moves || []).slice(0, 4),
				evs: member.evs,
				ivs: member.ivs
			};
		});
	}

	function enemySets() {
		var battle = window.RRTrainers.getBattle();
		if (!battle) return [];
		var out = [];
		battle.team.forEach(function (mon) {
			var built = window.RRTrainers.buildEnemy(battle, mon);
			var set = setFromCalc(built);
			if (set) out.push(set);
		});
		return out;
	}

	/**
	 * Build the position. The team is rotated so the Pokemon you say is out is
	 * first, because the engine treats index 0 as active and rotating is the
	 * one thing that keeps the rest of the party available to switch to.
	 */
	function buildState() {
		var mine = myTeamSets();
		var theirs = enemySets();
		if (!mine.length || !theirs.length) return null;

		var myActive = Math.min(~~$("#rr-adv-mine").val() || 0, mine.length - 1);
		var foeActive = Math.min(~~$("#rr-adv-theirs").val() || 0, theirs.length - 1);

		var state = RRBattle.createState(mine, theirs, {
			nuzlocke: $("#rr-adv-nuzlocke").is(":checked")
		});
		state.me.active = myActive;
		state.foe.active = foeActive;

		var myHP = ~~$("#rr-adv-myhp").val();
		var foeHP = ~~$("#rr-adv-foehp").val();
		var me = RRBattle.active(state.me);
		var foe = RRBattle.active(state.foe);
		if (myHP > 0) me.curHP = Math.min(myHP, me.maxHP);
		if (foeHP > 0) foe.curHP = Math.min(foeHP, foe.maxHP);
		var status = $("#rr-adv-mystatus").val();
		if (status) me.status = status;
		return state;
	}

	function pct(mon) {
		return Math.round((mon.curHP / mon.maxHP) * 100);
	}

	function renderAdvice(state) {
		var risks = $("#rr-adv-crit").is(":checked") ? {crit: true} : {};
		var plan = RRPlan.advise(state, {risks: risks});
		var rows = plan.entries.map(function (entry, index) {
			var ko = entry.ko && entry.ko.min !== undefined
				? esc(entry.ko.min + "-" + entry.ko.max + ", " + entry.ko.text) : "";
			var reply = entry.worstReply
				? (entry.worstReply.type === "move" ? entry.worstReply.move : "a switch")
				: "";
			return '<tr class="' + (index === 0 ? "rr-adv-best" : "") + '">' +
				"<td>" + (index + 1) + "</td>" +
				"<td><b>" + esc(entry.label) + "</b></td>" +
				"<td>" + esc(entry.verdict) + "</td>" +
				"<td>" + ko + "</td>" +
				"<td>" + esc(reply) + "</td></tr>";
		}).join("");

		var threats = plan.threats.slice(0, 4).map(function (threat) {
			return esc(threat.move) + " " + threat.ko.min + "-" + threat.ko.max +
				" (" + esc(threat.ko.text) + ")";
		}).join("<br>");

		return '<table class="rr-adv-table"><thead><tr><th></th><th>Option</th>' +
			"<th>Outcome</th><th>Damage</th><th>Worst reply</th></tr></thead><tbody>" +
			rows + "</tbody></table>" +
			'<div class="rr-adv-note"><b>What it threatens:</b><br>' + threats + "</div>" +
			'<div class="rr-adv-note rr-adv-caveat">Ranked on the worst reply, not the ' +
			"likeliest. Damage read as: " + esc(plan.reading) + ". " +
			esc(plan.assumption) + "." +
			(plan.unmodelled.length
				? "<br><b>Not simulated:</b> " + esc(plan.unmodelled.join("; "))
				: "") + "</div>";
	}

	function renderCheck(state) {
		var result = RRSolver.solveNuzlocke(state, {
			maxDepth: 10, budget: 120000, timeLimitMs: 15000
		});
		var rungs = result.rungs.map(function (rung) {
			var label = rung.verdict === "safe" ? "safe"
				: (rung.verdict === "budget" ? "undecided" : "no route found");
			return '<tr class="rr-adv-' + rung.verdict + '"><td>' + esc(label) +
				"</td><td><b>" + esc(rung.name) + "</b></td><td>" +
				esc(rung.blurb) + "</td></tr>";
		}).join("");
		return '<table class="rr-adv-table"><tbody>' + rungs + "</tbody></table>" +
			'<div class="rr-adv-note">' + esc(result.meaning) + "</div>" +
			'<div class="rr-adv-note rr-adv-caveat">A route that is not found may ' +
			"still exist further ahead: this never claims your Pokemon dies, only " +
			"that it could not find a way through." +
			(result.unmodelled.length
				? "<br><b>Not simulated:</b> " + esc(result.unmodelled.join("; "))
				: "") + "</div>";
	}

	function options(sets, selectedIndex) {
		return sets.map(function (set, index) {
			return '<option value="' + index + '"' +
				(index === selectedIndex ? " selected" : "") + ">" +
				esc(set.species) + " Lv" + set.level + "</option>";
		}).join("");
	}

	function refreshPickers() {
		var mine = myTeamSets();
		var theirs = enemySets();
		$("#rr-adv-mine").html(options(mine, ~~$("#rr-adv-mine").val()));
		$("#rr-adv-theirs").html(options(theirs, ~~$("#rr-adv-theirs").val()));
		syncHP();
		if (!mine.length) {
			$("#rr-adv-out").html('<div class="rr-adv-note">Save a Pokemon to ' +
				"<b>My Team</b> first, or import one from your save.</div>");
		} else if (!theirs.length) {
			$("#rr-adv-out").html('<div class="rr-adv-note">Pick a battle above.</div>');
		}
	}

	/** Default the HP boxes to full whenever the chosen Pokemon changes. */
	function syncHP() {
		var state = buildState();
		if (!state) return;
		$("#rr-adv-myhp").attr("max", RRBattle.active(state.me).maxHP);
		$("#rr-adv-foehp").attr("max", RRBattle.active(state.foe).maxHP);
		if (!$("#rr-adv-myhp").val()) $("#rr-adv-myhp").val(RRBattle.active(state.me).maxHP);
		if (!$("#rr-adv-foehp").val()) $("#rr-adv-foehp").val(RRBattle.active(state.foe).maxHP);
	}

	function panelHtml() {
		return '<div id="rr-advisor" class="rr-panel">' +
			'<div class="rr-head"><span class="rr-title">Battle advisor</span>' +
			'<button type="button" id="rr-adv-collapse" class="rr-collapse">&minus;</button></div>' +
			'<div class="rr-body">' +
			'<div class="rr-adv-row"><label>Yours</label>' +
			'<select id="rr-adv-mine"></select>' +
			'<label>HP</label><input type="number" id="rr-adv-myhp" min="1" />' +
			'<select id="rr-adv-mystatus">' +
			STATUSES.map(function (pair) {
				return '<option value="' + pair[0] + '">' + pair[1] + "</option>";
			}).join("") + "</select></div>" +
			'<div class="rr-adv-row"><label>Theirs</label>' +
			'<select id="rr-adv-theirs"></select>' +
			'<label>HP</label><input type="number" id="rr-adv-foehp" min="1" /></div>' +
			'<div class="rr-adv-row">' +
			'<label><input type="checkbox" id="rr-adv-nuzlocke" checked /> Nuzlocke ' +
			"(losing one Pokemon is losing)</label>" +
			'<label><input type="checkbox" id="rr-adv-crit" /> assume they crit</label>' +
			"</div>" +
			'<div class="rr-adv-row">' +
			'<button type="button" id="rr-adv-run" class="btn">What should I click?</button>' +
			'<button type="button" id="rr-adv-check" class="btn">Check this fight</button>' +
			"</div>" +
			'<div id="rr-adv-out"></div>' +
			"</div></div>";
	}

	function run(renderer, busyText) {
		var state = buildState();
		if (!state) {
			$("#rr-adv-out").html('<div class="rr-adv-note">Need both a saved team ' +
				"and a selected battle.</div>");
			return;
		}
		$("#rr-adv-out").html('<div class="rr-adv-note">' + busyText + "</div>");
		// Yield first so the message paints before the search blocks the thread.
		window.setTimeout(function () {
			var html;
			try {
				html = renderer(state);
			} catch (e) {
				html = '<div class="rr-adv-note">Something went wrong: ' +
					esc(e && e.message ? e.message : e) + "</div>";
			}
			$("#rr-adv-out").html(html);
		}, 20);
	}

	function bind() {
		$("#rr-adv-collapse").click(function () {
			$("#rr-advisor").toggleClass("rr-collapsed");
			$(this).html($("#rr-advisor").hasClass("rr-collapsed") ? "+" : "&minus;");
		});
		$("#rr-adv-mine, #rr-adv-theirs").on("change", function () {
			$("#rr-adv-myhp").val(""); $("#rr-adv-foehp").val("");
			syncHP();
		});
		$("#rr-adv-run").click(function () {
			run(renderAdvice, "Working out this turn...");
		});
		$("#rr-adv-check").click(function () {
			run(renderCheck, "Searching for a route where nothing dies...");
		});
		// The trainer panel owns both the battle and the team and publishes
		// changes, so subscribe rather than watching for clicks on its markup.
		if (window.RRTrainers.onBattleChange) {
			window.RRTrainers.onBattleChange(function () {
				$("#rr-adv-myhp").val(""); $("#rr-adv-foehp").val("");
				refreshPickers();
			});
		}
		if (window.RRTrainers.onFacingChange) {
			window.RRTrainers.onFacingChange(refreshPickers);
		}
	}

	$(function () {
		if (!ready()) return;
		$("#rr-panel").after(panelHtml());
		bind();
		refreshPickers();
	});

	// Exposed so the page can be driven headlessly: the deferred render in run()
	// never resolves inside a probe, and the wiring from saved team plus
	// selected battle to a position is the part worth checking.
	window.RRAdvisor = {
		refresh: refreshPickers,
		buildState: buildState,
		advice: function () { return renderAdvice(buildState()); },
		check: function () { return renderCheck(buildState()); }
	};
})();
