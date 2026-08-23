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

	var PARTY_KEY = "rrAdvParty";
	var PARTY_MAX = 6;

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

	/**
	 * Which of the saved Pokemon are actually in the party.
	 *
	 * Importing a save brings in your PC boxes as well, so the saved list is
	 * routinely twenty-odd Pokemon. Treating all of them as the party is not a
	 * cosmetic problem: the search offers switches to Pokemon sitting in a box,
	 * which invents options you do not have, and the advice is only worth
	 * anything if every option it lists is one you could actually take.
	 */
	function loadParty() {
		try {
			var raw = JSON.parse(window.localStorage.getItem(PARTY_KEY) || "null");
			return Array.isArray(raw) ? raw : null;
		} catch (e) {
			return null;
		}
	}

	function saveParty(indices) {
		try {
			window.localStorage.setItem(PARTY_KEY, JSON.stringify(indices));
		} catch (e) { /* private browsing, quota */ }
	}

	/** Indices into the saved team, defaulting to the first six. */
	function partyIndices() {
		var all = savedTeam();
		var chosen = loadParty();
		if (!chosen) {
			chosen = [];
			for (var i = 0; i < Math.min(PARTY_MAX, all.length); i++) chosen.push(i);
			return chosen;
		}
		// Drop anything that no longer exists, so removing a Pokemon from the
		// saved team cannot leave a dangling party slot.
		return chosen.filter(function (index) { return index < all.length; })
			.slice(0, PARTY_MAX);
	}

	function savedTeam() {
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
		return team;
	}

	function toSet(member) {
		return {
			species: member.species,
			level: member.level,
			nature: member.nature || "Serious",
			ability: member.ability || undefined,
			item: member.item || "",
			moves: (member.moves || []).slice(0, 4),
			evs: member.evs,
			ivs: member.ivs,
			nickname: member.nickname || null
		};
	}

	/** The battle party: the chosen Pokemon, in the order you chose them. */
	function myTeamSets() {
		var all = savedTeam();
		return partyIndices().map(function (index) { return toSet(all[index]); })
			.filter(function (set) { return !!set; });
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

		var state = RRBattle.createState(mine, theirs, {
			nuzlocke: $("#rr-adv-nuzlocke").is(":checked")
		});

		[["mine", state.me], ["theirs", state.foe]].forEach(function (pair) {
			var side = pair[0], sideState = pair[1];
			rowsFor(side).each(function () {
				var index = ~~$(this).attr("data-index");
				var mon = sideState.team[index];
				if (!mon) return;
				if (!$(this).find(".rr-adv-alive").is(":checked")) {
					mon.fainted = true;
					mon.curHP = 0;
					return;
				}
				var hp = ~~$(this).find(".rr-adv-hp").val();
				if (hp > 0) mon.curHP = Math.min(hp, mon.maxHP);
				var status = $(this).find(".rr-adv-status").val();
				if (status) mon.status = status;
			});
			var active = activeIndexOf(side);
			// A fainted Pokemon cannot be the one that is out.
			if (sideState.team[active] && sideState.team[active].fainted) {
				for (var i = 0; i < sideState.team.length; i++) {
					if (!sideState.team[i].fainted) { active = i; break; }
				}
			}
			sideState.active = active;
		});
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

	function rungRow(rung) {
		var label = rung.verdict === "safe" ? "safe"
			: (rung.verdict === "budget" ? "undecided" : "no route found");
		return '<tr class="rr-adv-' + rung.verdict + '"><td>' + esc(label) +
			"</td><td><b>" + esc(rung.name) + "</b></td><td>" + esc(rung.blurb) +
			'</td><td class="rr-adv-cost">' + rung.nodes + " nodes, " +
			(rung.elapsedMs / 1000).toFixed(1) + "s</td></tr>";
	}

	/**
	 * Walk the ladder a rung at a time, painting between them.
	 *
	 * The whole ladder in one call froze the page for half a minute on an
	 * in-level fight and then reported "undecided", which is the worst of both.
	 * Each rung gets a short budget and its own tick, so you see the answer
	 * build up and can stop reading as soon as you have what you need. A rung
	 * that runs out of budget offers to keep going rather than pretending.
	 */
	function runLadder(state, index, rows, budgetMs) {
		var rung = RRSolver.nuzlockeRung(state, index, {
			maxDepth: 10, budget: 400000, timeLimitMs: budgetMs
		});
		if (!rung) return;
		rows.push(rung);
		paintLadder(state, rows, rung, budgetMs);
		if (rung.safe && !rung.last) {
			window.setTimeout(function () {
				runLadder(state, index + 1, rows, budgetMs);
			}, 30);
		}
	}

	function paintLadder(state, rows, latest, budgetMs) {
		var deepest = null;
		rows.forEach(function (rung) { if (rung.safe) deepest = rung; });
		var summary = deepest
			? "A clean sweep exists that holds <b>" + esc(deepest.name) + "</b>."
			: "No clean sweep found yet.";
		if (latest.verdict === "budget") {
			summary += " The <b>" + esc(latest.name) + "</b> rung ran out of search " +
				"budget, so it is undecided rather than lost.";
		} else if (latest.verdict === "none") {
			summary += " No route survives <b>" + esc(latest.name) + "</b> within 10 turns.";
		} else if (latest.safe && !latest.last) {
			summary += " Still checking...";
		}

		$("#rr-adv-out").html(
			'<table class="rr-adv-table"><tbody>' +
			rows.map(rungRow).join("") + "</tbody></table>" +
			'<div class="rr-adv-note">' + summary + "</div>" +
			(latest.verdict === "budget"
				? '<div class="rr-adv-note"><button type="button" id="rr-adv-harder" ' +
					'class="btn">Search that rung harder</button></div>'
				: "") +
			'<div class="rr-adv-note rr-adv-caveat">A route that is not found may ' +
			"still exist further ahead: this never claims your Pokemon dies, only " +
			"that it could not find a way through." +
			(state.unmodelled.length
				? "<br><b>Not simulated:</b> " + esc(state.unmodelled.join("; "))
				: "") + "</div>");

		$("#rr-adv-harder").off("click").on("click", function () {
			$(this).prop("disabled", true).text("Searching...");
			window.setTimeout(function () {
				rows.pop();
				runLadder(state, latest.index, rows, budgetMs * 6);
			}, 30);
		});
	}

	/**
	 * One editable row per Pokemon: alive, current HP, and which one is out.
	 *
	 * A picker alone was not enough to describe a real position. Half way
	 * through a fight some of their team is already down and yours is not at
	 * full, and a check that silently assumes four healthy opponents answers a
	 * question you did not ask. In a Nuzlocke it matters more in the other
	 * direction too: a Pokemon you have lost is gone, and must not be offered
	 * as somewhere to switch.
	 */
	function teamRows(side, sets, activeIndex) {
		return sets.map(function (set, index) {
			var id = "rr-adv-" + side + "-" + index;
			return '<div class="rr-adv-mon" data-side="' + side + '" data-index="' + index + '">' +
				'<input type="radio" name="rr-adv-active-' + side + '" class="rr-adv-active"' +
				(index === activeIndex ? " checked" : "") + ' title="which one is out" />' +
				'<input type="checkbox" class="rr-adv-alive" id="' + id + '-alive" checked' +
				' title="uncheck if it has fainted" />' +
				'<label for="' + id + '-alive" class="rr-adv-name">' + esc(set.species) +
				" <span class=\"rr-adv-lv\">Lv" + set.level + "</span></label>" +
				'<input type="number" class="rr-adv-hp" min="0" title="current HP" />' +
				'<span class="rr-adv-max"></span>' +
				(side === "mine"
					? '<select class="rr-adv-status">' + STATUSES.map(function (pair) {
						return '<option value="' + pair[0] + '">' + pair[1] + "</option>";
					}).join("") + "</select>"
					: "") +
				"</div>";
		}).join("");
	}

	/**
	 * The party picker: every saved Pokemon, six of which are fighting.
	 *
	 * Collapsed to a summary line, because after a save import the list is long
	 * and you change it once a session at most.
	 */
	function partyPicker() {
		var all = savedTeam();
		var chosen = partyIndices();
		if (!all.length) return "";

		var names = chosen.map(function (index) {
			var member = all[index];
			return esc(member.nickname || member.species);
		}).join(", ");

		var list = all.map(function (member, index) {
			var on = chosen.indexOf(index) >= 0;
			return '<label class="rr-adv-pick' + (on ? " rr-adv-picked" : "") + '">' +
				'<input type="checkbox" class="rr-adv-partybox" data-index="' + index + '"' +
				(on ? " checked" : "") + " />" +
				esc(member.nickname || member.species) +
				' <span class="rr-adv-lv">Lv' + member.level + "</span></label>";
		}).join("");

		return '<div class="rr-adv-party">' +
			'<div class="rr-adv-sidehead">Party ' +
			'<span class="rr-adv-hint">' + chosen.length + " of " + PARTY_MAX +
			(all.length > chosen.length
				? " chosen from " + all.length + " saved" : "") + "</span>" +
			'<button type="button" id="rr-adv-editparty" class="rr-adv-link">change</button>' +
			"</div>" +
			'<div class="rr-adv-partynames">' + (names || "none chosen") + "</div>" +
			'<div id="rr-adv-partylist" class="rr-adv-partylist" style="display:none">' +
			list + "</div></div>";
	}

	function rowsFor(side) {
		return $("#rr-adv-" + side + " .rr-adv-mon");
	}

	function activeIndexOf(side) {
		var found = 0;
		rowsFor(side).each(function () {
			if ($(this).find(".rr-adv-active").is(":checked")) {
				found = ~~$(this).attr("data-index");
			}
		});
		return found;
	}

	function refreshPickers() {
		var mine = myTeamSets();
		var theirs = enemySets();
		$("#rr-adv-partywrap").html(partyPicker());
		$("#rr-adv-mine").html(teamRows("mine", mine, activeIndexOf("mine")));
		$("#rr-adv-theirs").html(teamRows("theirs", theirs, activeIndexOf("theirs")));

		var battle = window.RRTrainers.getBattle();
		$("#rr-adv-who").text(battle
			? (battle.title ? battle.title + " " : "") + battle.trainer +
				(battle.variant ? " (" + battle.variant + ")" : "")
			: "pick a battle above");
		syncHP();
		if (!mine.length) {
			$("#rr-adv-out").html('<div class="rr-adv-note">Save a Pokemon to ' +
				"<b>My Team</b> first, or import one from your save.</div>");
		} else if (!theirs.length) {
			$("#rr-adv-out").html('<div class="rr-adv-note">Pick a battle above.</div>');
		}
	}

	/** Fill each blank HP box with that Pokemon's maximum. */
	function syncHP() {
		var state = buildState();
		if (!state) return;
		[["mine", state.me], ["theirs", state.foe]].forEach(function (pair) {
			rowsFor(pair[0]).each(function () {
				var mon = pair[1].team[~~$(this).attr("data-index")];
				if (!mon) return;
				$(this).find(".rr-adv-hp").attr("max", mon.maxHP);
				$(this).find(".rr-adv-max").text("/" + mon.maxHP);
				if (!$(this).find(".rr-adv-hp").val()) {
					$(this).find(".rr-adv-hp").val(mon.maxHP);
				}
			});
		});
	}

	function panelHtml() {
		return '<div id="rr-advisor" class="rr-panel">' +
			'<div class="rr-head"><span class="rr-title">Battle advisor</span>' +
			'<button type="button" id="rr-adv-collapse" class="rr-collapse">&minus;</button></div>' +
			'<div class="rr-body">' +
			'<div id="rr-adv-partywrap"></div>' +
			'<div class="rr-adv-side"><div class="rr-adv-sidehead">Your team ' +
			'<span class="rr-adv-hint">dot = out, tick = alive</span></div>' +
			'<div id="rr-adv-mine"></div></div>' +
			'<div class="rr-adv-side"><div class="rr-adv-sidehead">Facing ' +
			'<span id="rr-adv-who" class="rr-adv-hint"></span></div>' +
			'<div id="rr-adv-theirs"></div></div>' +
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
		// Changing which Pokemon is out re-fills only the blank HP boxes, so a
		// value already typed for another Pokemon is not thrown away.
		$(document).on("change", "#rr-adv-mine .rr-adv-active, #rr-adv-theirs .rr-adv-active," +
			" #rr-adv-mine .rr-adv-alive, #rr-adv-theirs .rr-adv-alive", function () {
			syncHP();
		});
		$(document).on("click", "#rr-adv-editparty", function () {
			$("#rr-adv-partylist").toggle();
		});
		$(document).on("change", ".rr-adv-partybox", function () {
			var chosen = [];
			$(".rr-adv-partybox:checked").each(function () {
				chosen.push(~~$(this).attr("data-index"));
			});
			if (chosen.length > PARTY_MAX) {
				// Refuse the sixth-and-first rather than silently dropping one,
				// so it is clear which Pokemon is not coming.
				$(this).prop("checked", false);
				return;
			}
			saveParty(chosen);
			// Their side is untouched, so keep its typed HP.
			$("#rr-adv-mine").empty();
			refreshPickers();
			$("#rr-adv-partylist").show();
		});

		$("#rr-adv-run").click(function () {
			run(renderAdvice, "Working out this turn...");
		});
		$("#rr-adv-check").click(function () {
			var state = buildState();
			if (!state) {
				$("#rr-adv-out").html('<div class="rr-adv-note">Need both a saved ' +
					"team and a selected battle.</div>");
				return;
			}
			$("#rr-adv-out").html('<div class="rr-adv-note">Searching for a route ' +
				"where nothing dies...</div>");
			window.setTimeout(function () { runLadder(state, 0, [], 2500); }, 20);
		});
		// The trainer panel owns both the battle and the team and publishes
		// changes, so subscribe rather than watching for clicks on its markup.
		if (window.RRTrainers.onBattleChange) {
			window.RRTrainers.onBattleChange(function () {
				// A different battle means a different enemy team, so their
				// typed HP is meaningless; yours is still yours.
				$("#rr-adv-theirs").empty();
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
		party: partyIndices,
		setParty: function (indices) { saveParty(indices); refreshPickers(); },
		buildState: buildState,
		advice: function () { return renderAdvice(buildState()); },
		ladder: function (budgetMs) {
			var state = buildState();
			var rows = [];
			runLadder(state, 0, rows, budgetMs || 1500);
			return rows;
		}
	};
})();
