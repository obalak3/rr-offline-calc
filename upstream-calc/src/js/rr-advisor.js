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

	/**
	 * Doubles is not supported, and that has to be said rather than guessed at.
	 *
	 * 27 of the 167 battles are doubles, Sabrina and the last Giovanni among
	 * them. Nothing in the engine models a second active Pokemon: no spread
	 * damage, no redirection, no partner. Handed one of those fights it would
	 * have answered the 1v1 question instead and looked equally confident doing
	 * it, which in a Nuzlocke is how you lose something.
	 */
	function isDoubles() {
		var battle = window.RRTrainers.getBattle();
		return !!(battle && window.RRTrainers.isDoubles &&
			window.RRTrainers.isDoubles(battle));
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

	/**
	 * A route, always.
	 *
	 * The ladder answered "is there a clean route" and, when it could not tell
	 * in the time available, returned nothing you could act on. You are going to
	 * fight the trainer either way, so the question is which line is least bad,
	 * not whether a perfect one exists. This plays the fight out and shows the
	 * line it likes best, then reports how much bad luck that line survives.
	 */
	function routeTable(route) {
		var rows = route.steps.map(function (step) {
			return '<tr' + (step.knockedOut ? ' class="rr-adv-ko"' : "") + ">" +
				"<td>" + step.turn + "</td>" +
				"<td>" + esc(step.myMon) + "</td>" +
				"<td><b>" + esc(step.label) + "</b></td>" +
				"<td>" + esc(step.theirMon) + "</td>" +
				"<td>" + esc(step.theirLabel) + "</td>" +
				"<td>" + step.myHP + "/" + step.myMaxHP +
				(step.knockedOut ? " <b>KO</b>" : "") + "</td></tr>";
		}).join("");
		return '<table class="rr-adv-table"><thead><tr><th>#</th><th>You</th>' +
			"<th>Click</th><th>Them</th><th>They do</th><th>Your HP</th></tr></thead>" +
			"<tbody>" + rows + "</tbody></table>";
	}

	function routeHeadline(route) {
		if (!route.steps.length) return "No route found at all.";
		if (route.won && route.losses === 0) {
			return "<b>Wins in " + route.turns + " turns, losing nothing.</b>";
		}
		if (route.won) {
			return "<b>Wins in " + route.turns + " turns, losing " + route.losses +
				" (" + esc(route.lostNames.join(", ")) + ").</b> " +
				"This is the best line it found, not a promise that nothing better exists.";
		}
		return "<b>No winning line found.</b> The best it managed was " +
			route.turns + " turns" +
			(route.losses ? ", losing " + route.losses : "") +
			". Shown anyway, because it is still the best it saw.";
	}

	/**
	 * Re-run the same search under harder assumptions to see where it breaks.
	 * Reported after the route, because the route is what you came for.
	 */
	function checkRisk(state, index, found, budgetMs) {
		var ladder = RRSolver.RISK_LADDER;
		var rung = ladder[index];
		if (!rung) { paintRoute(state, found, null, true); return; }
		var route = RRSolver.planRoute(state, {
			lookahead: 3, budget: 30000, risks: rung.risks
		});
		var holds = route.won && route.losses === 0;
		found.risk.push({name: rung.name, blurb: rung.blurb, holds: holds, route: route});
		paintRoute(state, found, rung, false);
		if (holds && index + 1 < ladder.length) {
			window.setTimeout(function () {
				checkRisk(state, index + 1, found, budgetMs);
			}, 30);
		}
	}

	/**
	 * A proved line and a heuristic guess must never look the same on screen.
	 *
	 * "Proved" means: play these moves and, at median rolls against this AI,
	 * nothing of yours faints. "The search ran out of time" is a different claim
	 * from "this fight cannot be won cleanly", and saying the second when only
	 * the first is true would be the worst thing this panel could do.
	 */
	function proofNote(route) {
		if (route.exactness === "certified") {
			return '<div class="rr-adv-note"><b>This line is proved.</b> ' +
				"Every damage roll, every critical hit and every move the AI " +
				"could pick were checked: no branch loses a Pokemon.</div>";
		}
		if (route.exactness === "line-found") {
			// The honest description of what the fast search actually did. It
			// used to say "proved" here, which was wrong twice over: the search
			// runs at MEDIAN damage rolls, and against the AI's single
			// top-scoring move when 7% of positions have ties it might pick
			// from instead. Over a twenty-turn line that is about a four-in-five
			// chance of passing through a position it never considered.
			var why = route.certificate && route.certificate.why;
			return '<div class="rr-adv-note"><b>A clean line exists at normal ' +
				"rolls.</b> Every move was checked against the AI's best reply " +
				"at median damage. It is NOT proof against bad luck: unlucky " +
				"rolls, a critical hit, or the AI picking a different move it " +
				"rates equally can all break it." +
				(why ? " Could not be fully certified: " + esc(why) + "." : "") +
				" The risks below are where it is most fragile.</div>";
		}
		if (route.exactness === "no-clean-line-exists") {
			var head = '<div class="rr-adv-note"><b>No clean line exists.</b> ' +
				"The search finished having tried every option at median rolls: " +
				"there is no way through without losing something. ";
			// Two very different things can sit below this heading, and saying
			// which is the point. A searched cheapest win is a real result; the
			// weighted search's guess is not, and it used to be described the
			// same way.
			if (route.minLoss) {
				var cost = route.losses === 1 ? "one Pokemon" : route.losses + " Pokemon";
				return head + "Below is the cheapest win the search could find, " +
					"costing <b>" + cost + "</b>" +
					(route.minLossProved
						? ", and losing fewer was searched and ruled out."
						: ". Losing fewer was not ruled out -- that search ran " +
						  "out of budget, so a cheaper win may exist.") +
					"</div>";
			}
			return head + "Below is the best available anyway, and it is the " +
				"weighted search's guess rather than a searched result.</div>";
		}
		if (route.exactness === "undecided") {
			return '<div class="rr-adv-note">The search ran out of time on this ' +
				"one, so this route is the weighted search's best guess rather " +
				"than a guarantee. That is not the same as saying the fight " +
				"cannot be won cleanly.</div>";
		}
		return "";
	}

	function paintRoute(state, found, latest, done) {
		var survived = found.risk.filter(function (r) { return r.holds; });
		var broke = found.risk.filter(function (r) { return !r.holds; })[0];
		// Where a proved line leans on the dice, worst step first. This is the
		// question actually asked of it: I use Drain Punch, and if it does not
		// kill (5% of the time) then the plan does not work.
		if (found.stepRisks) {
			var priced = found.stepRisks;
			var worst = priced.risks.slice(0, 4);
			var provedLine = "<b>Goes exactly as written " +
				Math.round(priced.overall * 100) + "% of the time.</b>";
			if (worst.length) {
				provedLine += " It leans on:<ul style=\'margin:4px 0 0 18px\'>" +
					worst.map(function (r) {
						return "<li>Turn " + r.turn + ": " + esc(r.what) +
							" &mdash; " + esc(r.detail) + "</li>";
					}).join("") + "</ul>";
			} else {
				provedLine += " No step in it depends on a roll going your way.";
			}
			$("#rr-adv-out").html(
				proofNote(found.route) +
				'<div class="rr-adv-note">' + routeHeadline(found.route) + "</div>" +
				routeTable(found.route) +
				'<div class="rr-adv-note">' + provedLine + "</div>" +
				'<div class="rr-adv-note rr-adv-caveat">' +
				"The line is checked at median damage rolls against every reply " +
				"the AI can give. The percentage is how often the dice " +
				"cooperate; a step going wrong does not always lose the fight, " +
				"but it does mean this exact line stops applying. Found in " +
				(found.route.elapsedMs / 1000).toFixed(1) + "s." +
				(state.unmodelled.length
					? "<br><b>Not simulated:</b> " + esc(state.unmodelled.join("; "))
					: "") + "</div>");
			return;
		}

		var riskLine = found.risk.length
			? ("<b>Survives:</b> " +
				(survived.length
					? survived.map(function (r) { return esc(r.name); }).join(", ")
					: "nothing beyond the plain reading") +
				(broke
					? ". <b>Breaks at:</b> " + esc(broke.name) + " (" + esc(broke.blurb) + ")" +
						(broke.route.won
							? ", where it still wins but loses " + broke.route.losses
							: ", where it stops winning")
					: (done ? ". It survives the whole ladder." : ", still checking..."))) 
			: "Checking how much bad luck it survives...";

		$("#rr-adv-out").html(
			proofNote(found.route) +
			'<div class="rr-adv-note">' + routeHeadline(found.route) + "</div>" +
			routeTable(found.route) +
			'<div class="rr-adv-note">' + riskLine + "</div>" +
			'<div class="rr-adv-note rr-adv-caveat">Their damage is read high and ' +
			"yours low. The opponent is assumed to answer with whatever is worst " +
			"for you, so a real fight usually goes better than this. Found in " +
			(found.route.elapsedMs / 1000).toFixed(1) + "s." +
			(state.unmodelled.length
				? "<br><b>Not simulated:</b> " + esc(state.unmodelled.join("; "))
				: "") + "</div>");
	}

	/**
	 * Plan the fight.
	 *
	 * RRExact first: it looks for a line that provably loses nobody and only
	 * falls back to the weighted search when it cannot settle the question.
	 * Measured over 135 early-game fights this wins 71% of them without losing a
	 * Pokemon against the weighted search's 61%, and it almost never wins dirty
	 * -- of 97 fights won, 96 were clean -- which is the point, since a win that
	 * costs a Pokemon is a loss in a Nuzlocke.
	 *
	 * The time cap is what makes it usable here: this runs on the main thread,
	 * so the search gets five seconds and then hands back whatever it has. The
	 * fallback always returns a playable route, so waiting longer buys a better
	 * answer rather than the difference between an answer and none.
	 */
	/**
	 * Plan the fight, off the main thread where possible.
	 *
	 * The five second cap this used to run under was never a judgement about how
	 * much thinking the fight deserved. It was the longest the page could be
	 * frozen before looking broken, because a search on the main thread blocks
	 * everything. Lt. Surge needs around thirty seconds and so never got solved
	 * in the app despite being solvable.
	 *
	 * In a worker the search gets a real budget and the page stays alive, so the
	 * cap goes to a minute and there is a button to stop it. If workers are
	 * unavailable for any reason this falls straight back to the old inline
	 * path, five second cap and all -- worse answers, never no answer.
	 */
	function runRoute(state) {
		if (typeof RRSearch !== "undefined" && RRSearch.available()) {
			$("#rr-adv-out").html(
				'<div class="rr-adv-note" id="rr-adv-progress">Looking for a line ' +
				"that loses nobody. The page stays usable while it runs, and it " +
				"keeps going until it has an answer.</div>" +
				'<div class="rr-adv-note"><button type="button" id="rr-adv-stop">' +
				"Stop and take the quick answer</button></div>");
			$("#rr-adv-stop").on("click", function () {
				RRSearch.cancel();
				runRouteInline(state);
			});
			// No time limit. The cap this used to carry existed because the
			// search froze the page, and in a worker it does not: the fight is
			// either worth solving or it is not, and that is the player's call
			// to make with the Stop button, not a number chosen here. The node
			// budget stays as a backstop against a genuinely unbounded search.
			RRSearch.solve(state, {
				lookahead: 3, budget: 30000,
				exactBudget: 60000000, maxTurns: 24,
				// The only caller with no clock and every core, so the only one
				// that can afford to ask a bigger question when the answer is
				// "no clean line inside 24 turns". It fires only when the search
				// finished that tree and stopped at the horizon; on a fight that
				// ran out of budget it does nothing.
				maxTurnsCeiling: 40,
				certify: true, certifyBudget: 800000, certifyTimeLimitMs: 30000
			}, function (result) {
				var found = {route: result.route, risk: [], stepRisks: result.priced};
				if (result.priced) { paintRoute(state, found, null, true); return; }
				paintRoute(state, found, null, false);
				if (result.route.won) {
					window.setTimeout(function () { checkRisk(state, 1, found, 2500); }, 30);
				} else {
					$("#rr-adv-out").find(".rr-adv-note").eq(1).html(
						"<b>Risk not priced:</b> there is no winning line to price.");
				}
			}, function () {
				// Whatever went wrong with the worker, the fight still needs an
				// answer.
				runRouteInline(state);
			}, function (nodes, elapsedMs) {
				// Proof of life. Without it a long search and a hung one look
				// exactly the same, which is most of why a time cap felt
				// necessary in the first place.
				$("#rr-adv-progress").html("Looking for a line that loses nobody: " +
					(nodes / 1000).toFixed(0) + "k positions checked in " +
					(elapsedMs / 1000).toFixed(0) + "s. The page stays usable, and " +
					"it keeps going until it has an answer.");
			});
			return;
		}
		runRouteInline(state);
	}

	function runRouteInline(state) {
		var route = RRExact.planRoute(state, {
			lookahead: 3, budget: 30000,
			exactBudget: 3000000, timeLimitMs: 5000, maxTurns: 24
		});
		var found = {route: route, risk: []};

		// A proved line gets its risk priced directly rather than by re-running
		// the whole search under harsher assumptions. The proof already says
		// nothing dies at median rolls, so the useful question is no longer
		// whether it holds but which steps it is leaning on: the Drain Punch
		// that needs to KO, the move that can miss. One replay answers that,
		// where the ladder would run the exact search several more times.
		if (route.exactness === "proved") {
			try {
				found.stepRisks = RRSolver.routeRisks(state, route,
					{risks: {roll: "median"}});
			} catch (e) { found.stepRisks = null; }
			paintRoute(state, found, null, true);
			return;
		}

		paintRoute(state, found, null, false);
		// Only worth pricing the risk of a line that actually wins.
		if (route.won) {
			window.setTimeout(function () { checkRisk(state, 1, found, 2500); }, 30);
		} else {
			$("#rr-adv-out").find(".rr-adv-note").eq(1).html(
				"<b>Risk not priced:</b> there is no winning line to price.");
		}
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

		var doubles = isDoubles();
		$("#rr-advisor").toggleClass("rr-adv-blocked", doubles);
		$("#rr-adv-run, #rr-adv-check").prop("disabled", doubles);
		if (doubles) {
			$("#rr-adv-out").html('<div class="rr-adv-note rr-adv-warn">' +
				"<b>This is a double battle, and the advisor only understands singles.</b>" +
				"<br>Nothing here models a second Pokemon on each side: no spread " +
				"damage, no redirection, no partner. Rather than answer the 1v1 " +
				"question and look confident about it, it stops. Use the calculator's " +
				"own Doubles view for this fight.</div>");
		}
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
			'<button type="button" id="rr-adv-check" class="btn">Plan this fight</button>' +
			"</div>" +
			'<div id="rr-adv-out"></div>' +
			"</div></div>";
	}

	function run(renderer, busyText) {
		if (isDoubles()) { refreshPickers(); return; }
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
			if (isDoubles()) { refreshPickers(); return; }
			var state = buildState();
			if (!state) {
				$("#rr-adv-out").html('<div class="rr-adv-note">Need both a saved ' +
					"team and a selected battle.</div>");
				return;
			}
			$("#rr-adv-out").html('<div class="rr-adv-note">Playing the fight ' +
				"out...</div>");
			window.setTimeout(function () { runRoute(state); }, 20);
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
		isDoubles: isDoubles,
		setParty: function (indices) { saveParty(indices); refreshPickers(); },
		buildState: buildState,
		advice: function () { return renderAdvice(buildState()); },
		route: function () {
			var state = buildState();
			var route = RRExact.planRoute(state, {
				lookahead: 3, budget: 30000,
				exactBudget: 3000000, timeLimitMs: 5000, maxTurns: 24
			});
			paintRoute(state, {route: route, risk: []}, null, false);
			return route;
		}
	};
})();
