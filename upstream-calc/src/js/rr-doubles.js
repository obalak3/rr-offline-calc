/**
 * rr-doubles.js -- a double battle view.
 *
 * The stock calculator has two slots, which cannot answer the question a
 * doubles turn actually poses: if BOTH opponents attack the same Pokemon of
 * mine, does it die? Reading two single-target results side by side does not
 * tell you, because each attack rolls damage and crits independently -- the
 * answer is a convolution, handled by RRCritKO.analyseFocusFire.
 *
 * Four slots, any of which may be empty (fainted), so 2v2, 2v1 and 1v1 all
 * work. Emptying a slot changes real damage numbers, because the spread
 * penalty depends on how many Pokemon a move actually hits rather than on the
 * format -- see RRCritKO.targetsHit.
 *
 * Slots are filled from the trainer panel's state (window.RRTrainers) so level
 * scaling, Minimal Grinding Mode and the enemy dataset stay defined in one
 * place.
 */
/* global $, calc, gen, RRCritKO, RRTrainers */
(function () {
	"use strict";

	var STAT_MAP = {hp: "hp", atk: "at", def: "df", spa: "spa", spd: "spd", spe: "spe"};
	var EMPTY = "";

	var mine = [null, null];      // indices into the saved team, or null
	var theirs = [null, null];    // indices into the current battle's team
	var expanded = null;          // which target's full grid is open

	function generation() {
		return calc.Generations.get(typeof gen === "number" ? gen : 9);
	}

	function esc(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	// ------------------------------------------------------------ building

	/** A saved team member -> a calc.Pokemon. */
	function myPokemon(member) {
		if (!member) return null;
		var evs = {}, ivs = {};
		for (var key in STAT_MAP) {
			if (member.evs && member.evs[key] !== undefined) evs[key] = member.evs[key];
			if (member.ivs && member.ivs[key] !== undefined) ivs[key] = member.ivs[key];
		}
		var options = {
			level: member.level || 100,
			nature: member.nature || "Serious",
			evs: evs,
			ivs: ivs,
			moves: (member.moves || []).slice(0, 4)
		};
		if (member.ability) options.ability = member.ability;
		if (member.item) options.item = member.item;
		try {
			return new calc.Pokemon(generation(), member.species, options);
		} catch (e) {
			return null;
		}
	}

	/**
	 * calc.Pokemon stores `moves` exactly as handed to it, so a Pokemon built
	 * from names holds strings rather than Move objects (the calculator's own
	 * createPokemon builds the objects separately). Accept either.
	 */
	function asMove(g, move) {
		if (!move) return null;
		if (typeof move !== "string") return move;
		if (move === "(No Move)") return null;
		try {
			return new calc.Move(g, move);
		} catch (e) {
			return null;
		}
	}

	function board() {
		var battle = RRTrainers.getBattle();
		var team = RRTrainers.getTeam();
		var out = {mine: [], theirs: [], myMembers: [], theirMons: []};
		var i;
		for (i = 0; i < 2; i++) {
			var member = mine[i] === null ? null : team[mine[i]];
			out.myMembers.push(member || null);
			out.mine.push(member ? myPokemon(member) : null);
		}
		for (i = 0; i < 2; i++) {
			var mon = (battle && theirs[i] !== null) ? battle.team[theirs[i]] : null;
			out.theirMons.push(mon || null);
			out.theirs.push(mon ? RRTrainers.buildEnemy(battle, mon) : null);
		}
		return out;
	}

	function living(list) {
		var n = 0;
		for (var i = 0; i < list.length; i++) if (list[i]) n++;
		return n;
	}

	function baseField() {
		var field;
		try {
			field = typeof window.createField === "function"
				? window.createField() : new calc.Field();
		} catch (e) {
			field = new calc.Field();
		}
		field.gameType = "Doubles";
		return field;
	}

	/**
	 * Every damage roll one attacker's moves would do to one target, under the
	 * game type that matches how many Pokemon each move really hits.
	 */
	function shotsAgainst(attacker, defender, livingFoes, livingAllies) {
		if (!attacker || !defender) return [];
		var g = generation();
		var field = baseField();
		var out = [];
		for (var i = 0; i < attacker.moves.length; i++) {
			var move = asMove(g, attacker.moves[i]);
			if (!move || move.name === "(No Move)") continue;
			var moveField = RRCritKO.fieldForMove(field, move, livingFoes, livingAllies);
			var shot = RRCritKO.shotFor(g, attacker, defender, move, moveField,
				RRTrainers.getPrefs().focusEnergy ? 2 : 0);
			if (shot) {
				shot.spread = RRCritKO.targetsHit(move, livingFoes, livingAllies) >= 2;
				out.push(shot);
			} else {
				out.push({move: move.name, dead: true});
			}
		}
		return out;
	}

	function pct(value, max) {
		return (100 * value / max).toFixed(1);
	}

	function chanceText(chances) {
		if (!chances || !chances.length) return "no KO";
		for (var n = 0; n < chances.length; n++) {
			if (chances[n] <= 0) continue;
			var label = n === 0 ? "OHKO" : (n + 1) + "HKO";
			if (chances[n] > 0.9995) return "guaranteed " + label;
			return (chances[n] * 100).toFixed(1) + "% " + label;
		}
		return "no KO";
	}

	// ------------------------------------------------------- the core view

	/**
	 * For each of my Pokemon: what is the worst the opponents can do to it if
	 * they both aim at it this turn, and with which pair of moves.
	 */
	function incoming(state) {
		var foes = living(state.mine);          // targets available to them
		var theirLiving = living(state.theirs);
		if (!theirLiving || !foes) return null;

		var rows = [];
		for (var t = 0; t < 2; t++) {
			var target = state.mine[t];
			if (!target) continue;

			// Each opponent's options against this target. Their partner count
			// is their own living side minus the attacker.
			var options = [];
			for (var e = 0; e < 2; e++) {
				if (!state.theirs[e]) { options.push(null); continue; }
				options.push(shotsAgainst(state.theirs[e], target, foes,
					theirLiving - 1));
			}

			var hp = target.curHP();
			var grid = [];
			var best = null;
			var a = options[0], b = options[1];

			function consider(shots, labels) {
				var usable = [];
				for (var s = 0; s < shots.length; s++) {
					if (shots[s] && !shots[s].dead) usable.push(shots[s]);
				}
				var chances = usable.length
					? RRCritKO.koChancesMulti(usable, hp, 4) : [];
				var entry = {
					labels: labels,
					chances: chances,
					text: chanceText(chances),
					turn1: chances.length ? chances[0] : 0,
					min: 0, max: 0, spread: false
				};
				for (var u = 0; u < usable.length; u++) {
					entry.min += usable[u].min;
					entry.max += usable[u].max;
					if (usable[u].spread) entry.spread = true;
				}
				grid.push(entry);
				if (!best || entry.turn1 > best.turn1 ||
					(entry.turn1 === best.turn1 && entry.max > best.max)) {
					best = entry;
				}
			}

			if (a && b) {
				for (var i = 0; i < a.length; i++) {
					for (var j = 0; j < b.length; j++) {
						if (a[i].dead && b[j].dead) continue;
						consider([a[i], b[j]],
							[state.theirMons[0].species + " " + a[i].move,
								state.theirMons[1].species + " " + b[j].move]);
					}
				}
			} else {
				var only = a || b;
				var who = a ? 0 : 1;
				if (only) {
					for (var k = 0; k < only.length; k++) {
						if (only[k].dead) continue;
						consider([only[k]],
							[state.theirMons[who].species + " " + only[k].move]);
					}
				}
			}

			if (grid.length) {
				rows.push({
					index: t,
					name: target.name,
					hp: hp,
					maxHP: target.maxHP(),
					best: best,
					grid: grid.sort(function (x, y) { return y.turn1 - x.turn1; })
				});
			}
		}
		return rows;
	}

	/** My moves against each of their Pokemon, one attacker at a time. */
	function outgoing(state) {
		var theirLiving = living(state.theirs);
		var myLiving = living(state.mine);
		if (!theirLiving || !myLiving) return [];
		var rows = [];
		for (var m = 0; m < 2; m++) {
			if (!state.mine[m]) continue;
			for (var t = 0; t < 2; t++) {
				if (!state.theirs[t]) continue;
				var shots = shotsAgainst(state.mine[m], state.theirs[t],
					theirLiving, myLiving - 1);
				var hp = state.theirs[t].curHP();
				for (var s = 0; s < shots.length; s++) {
					if (shots[s].dead) continue;
					var chances = RRCritKO.koChancesMulti([shots[s]], hp, 4);
					rows.push({
						attacker: state.mine[m].name,
						move: shots[s].move,
						target: state.theirs[t].name,
						spread: shots[s].spread,
						min: shots[s].min,
						max: shots[s].max,
						maxHP: state.theirs[t].maxHP(),
						text: chanceText(chances)
					});
				}
			}
		}
		return rows;
	}

	// ------------------------------------------------------------- render

	function slotOptions(list, selected, labeller) {
		var html = '<option value="">(empty / fainted)</option>';
		for (var i = 0; i < list.length; i++) {
			html += '<option value="' + i + '"' +
				(selected === i ? " selected" : "") + '>' +
				esc(labeller(list[i], i)) + '</option>';
		}
		return html;
	}

	function renderSlots() {
		var battle = RRTrainers.getBattle();
		var team = RRTrainers.getTeam();
		var html = '<div class="rr-dbl-side"><b>Your side</b>';
		for (var i = 0; i < 2; i++) {
			html += '<select class="rr-dbl-mine" data-i="' + i + '">' +
				slotOptions(team, mine[i], function (m) {
					return m.species + " Lv" + m.level;
				}) + '</select>';
		}
		if (!team.length) {
			html += '<span class="rr-note">Save Pokemon to My Team first.</span>';
		}
		html += '</div><div class="rr-dbl-side"><b>Opponent</b>';
		var enemies = battle ? battle.team : [];
		for (var j = 0; j < 2; j++) {
			html += '<select class="rr-dbl-theirs" data-i="' + j + '">' +
				slotOptions(enemies, theirs[j], function (m) {
					return m.species + " Lv" + RRTrainers.resolveLevel(m);
				}) + '</select>';
		}
		if (!battle) {
			html += '<span class="rr-note">Pick a battle above.</span>';
		}
		return html + '</div>';
	}

	function renderResults() {
		var state = board();
		var myLiving = living(state.mine), theirLiving = living(state.theirs);
		if (!myLiving || !theirLiving) {
			return '<div class="rr-empty">Fill at least one slot on each side.</div>';
		}

		var html = '<div class="rr-dbl-format">' +
			myLiving + 'v' + theirLiving +
			(myLiving < 2 || theirLiving < 2
				? ' <span class="rr-note">spread moves that now hit a single ' +
					'target deal full damage</span>' : '') +
			'</div>';

		var rows = incoming(state) || [];
		html += '<div class="rr-dbl-h">If they both attack one of yours</div>';
		if (!rows.length) {
			html += '<div class="rr-empty">Nothing to compute.</div>';
		}
		for (var r = 0; r < rows.length; r++) {
			var row = rows[r];
			var lethal = row.best && row.best.turn1 > 0;
			html += '<div class="rr-dbl-target' + (lethal ? " rr-danger" : "") + '">' +
				'<div class="rr-dbl-name">' + esc(row.name) +
				' <span class="rr-note">' + row.maxHP + ' HP</span></div>' +
				'<div class="rr-dbl-best">' +
				'<span class="rr-dbl-ko">' + esc(row.best.text) + '</span> ' +
				'<span class="rr-dmg">' + pct(row.best.min, row.maxHP) + ' - ' +
				pct(row.best.max, row.maxHP) + '%</span>' +
				'<span class="rr-note">' + esc(row.best.labels.join("  +  ")) +
				(row.best.spread ? "  (spread)" : "") + '</span></div>' +
				'<button class="rr-dbl-more" data-t="' + row.index + '">' +
				(expanded === row.index ? "hide all combinations"
					: "all " + row.grid.length + " combinations") + '</button>';
			if (expanded === row.index) {
				html += '<table class="rr-matrix"><thead><tr><th>Their moves</th>' +
					'<th>Damage</th><th>KO chance</th></tr></thead><tbody>';
				for (var g = 0; g < row.grid.length; g++) {
					var e = row.grid[g];
					html += '<tr><th>' + esc(e.labels.join(" + ")) +
						(e.spread ? ' <span class="rr-note">spread</span>' : "") +
						'</th><td>' + pct(e.min, row.maxHP) + ' - ' +
						pct(e.max, row.maxHP) + '%</td><td' +
						(e.turn1 > 0 ? ' class="rr-kill"' : "") + '>' +
						esc(e.text) + '</td></tr>';
				}
				html += '</tbody></table>';
			}
			html += '</div>';
		}

		var out = outgoing(state);
		if (out.length) {
			html += '<div class="rr-dbl-h">Your moves</div>' +
				'<div class="rr-matrix-wrap"><table class="rr-matrix"><thead><tr>' +
				'<th>Attacker</th><th>Move</th><th>Target</th>' +
				'<th>Damage</th><th>KO chance</th></tr></thead><tbody>';
			for (var o = 0; o < out.length; o++) {
				var x = out[o];
				html += '<tr><th>' + esc(x.attacker) + '</th><td>' + esc(x.move) +
					(x.spread ? ' <span class="rr-note">spread</span>' : "") +
					'</td><td>' + esc(x.target) + '</td><td>' +
					pct(x.min, x.maxHP) + ' - ' + pct(x.max, x.maxHP) + '%</td>' +
					'<td class="rr-kill">' + esc(x.text) + '</td></tr>';
			}
			html += '</tbody></table></div>';
		}
		return html;
	}

	function render() {
		if (!$("#rr-doubles").length) return;
		$("#rr-dbl-slots").html(renderSlots());
		try {
			$("#rr-dbl-results").html(renderResults());
		} catch (e) {
			$("#rr-dbl-results").html('<div class="rr-empty">Could not compute: ' +
				esc(e && e.message) + '</div>');
		}
	}

	// --------------------------------------------------------------- init

	function panelHtml() {
		return '<div id="rr-doubles">' +
			'<div class="rr-head">' +
				'<span class="rr-title">Double Battle</span>' +
				'<span class="rr-note">Any slot can be empty, for 2v1 and 1v1.</span>' +
				'<button id="rr-dbl-collapse">hide</button>' +
			'</div>' +
			'<div class="rr-dbl-body">' +
				'<div id="rr-dbl-slots" class="rr-dbl-slots"></div>' +
				'<div id="rr-dbl-results"></div>' +
			'</div>' +
		'</div>';
	}

	function bind() {
		$("#rr-dbl-collapse").click(function () {
			var body = $("#rr-doubles .rr-dbl-body");
			body.toggle();
			$(this).text(body.is(":visible") ? "hide" : "show");
		});
		$("#rr-dbl-slots").on("change", ".rr-dbl-mine", function () {
			var v = $(this).val();
			mine[~~$(this).data("i")] = v === EMPTY ? null : ~~v;
			expanded = null;
			render();
		});
		$("#rr-dbl-slots").on("change", ".rr-dbl-theirs", function () {
			var v = $(this).val();
			theirs[~~$(this).data("i")] = v === EMPTY ? null : ~~v;
			expanded = null;
			render();
		});
		$("#rr-dbl-results").on("click", ".rr-dbl-more", function () {
			var t = ~~$(this).data("t");
			expanded = expanded === t ? null : t;
			render();
		});

		// A double battle should arrive already set up.
		RRTrainers.onBattleChange(function (battle) {
			theirs = [null, null];
			if (battle && RRTrainers.isDoubles(battle)) {
				theirs[0] = battle.team.length > 0 ? 0 : null;
				theirs[1] = battle.team.length > 1 ? 1 : null;
				$("#rr-doubles .rr-dbl-body").show();
				$("#rr-dbl-collapse").text("hide");
			}
			var team = RRTrainers.getTeam();
			if (mine[0] === null && team.length > 0) mine[0] = 0;
			if (mine[1] === null && team.length > 1) mine[1] = 1;
			expanded = null;
			render();
		});
	}

	$(function () {
		if (typeof RRTrainers === "undefined" || typeof RRCritKO === "undefined") return;
		var host = $("#rr-panel");
		if (!host.length) return;
		host.after(panelHtml());
		var team = RRTrainers.getTeam();
		if (team.length > 0) mine[0] = 0;
		if (team.length > 1) mine[1] = 1;
		bind();
		render();
	});
})();
