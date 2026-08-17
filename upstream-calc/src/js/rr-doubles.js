/**
 * rr-doubles.js -- a double battle board.
 *
 * Laid out like the calculator itself: your side on the left, theirs on the
 * right, with the second Pokemon stacked under the first. Each card lists its
 * moves with the damage they would do to that card's current target; click a
 * move to choose it, and the summary shows what the chosen moves do together.
 *
 * The point is the combined result. Two attacks on one Pokemon are not a sum
 * of averages -- each rolls damage and crits independently, so the chance the
 * total is lethal is a convolution (RRCritKO.koChancesMulti).
 *
 * Any slot can be empty, giving 2v1 and 1v1. That changes real numbers: the
 * spread penalty follows how many Pokemon a move actually hits, not the
 * format, so a Rock Slide into a lone target hits full while an Earthquake
 * still hits soft if the attacker's own partner is alive (RRCritKO.targetsHit).
 *
 * Slots come from window.RRTrainers, so level scaling, Minimal Grinding Mode
 * and the enemy dataset stay defined in the trainer panel alone.
 */
/* global $, calc, gen, RRCritKO, RRTrainers */
(function () {
	"use strict";

	var STATS = ["hp", "atk", "def", "spa", "spd", "spe"];

	// pick: index into the source list (null = empty). move: chosen move index.
	// target: which slot on the other side it is aimed at.
	// `move: null` means "nothing chosen yet", which auto-selects the hardest
	// hitting move against the current target. A click pins the choice.
	var side = {
		mine: [{pick: 0, move: null, target: 0}, {pick: 1, move: null, target: 1}],
		theirs: [{pick: 0, move: null, target: 0}, {pick: 1, move: null, target: 0}]
	};

	function g() {
		return calc.Generations.get(typeof gen === "number" ? gen : 9);
	}

	function esc(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function pct(value, max) {
		return (100 * value / max).toFixed(1);
	}

	// ------------------------------------------------------------- building

	function myPokemon(member) {
		if (!member) return null;
		var evs = {}, ivs = {}, i;
		for (i = 0; i < STATS.length; i++) {
			if (member.evs && member.evs[STATS[i]] !== undefined) {
				evs[STATS[i]] = member.evs[STATS[i]];
			}
			if (member.ivs && member.ivs[STATS[i]] !== undefined) {
				ivs[STATS[i]] = member.ivs[STATS[i]];
			}
		}
		var options = {
			level: member.level || 100,
			nature: member.nature || "Serious",
			evs: evs, ivs: ivs,
			moves: (member.moves || []).slice(0, 4)
		};
		if (member.ability) options.ability = member.ability;
		if (member.item) options.item = member.item;
		try {
			return new calc.Pokemon(g(), member.species, options);
		} catch (e) {
			return null;
		}
	}

	/**
	 * calc.Pokemon keeps whatever moves array it was handed, so a Pokemon built
	 * from names holds strings rather than Move objects. Accept either.
	 */
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

	/** Everything on the board right now. */
	function read() {
		var battle = RRTrainers.getBattle();
		var team = RRTrainers.getTeam();
		var state = {battle: battle, mine: [], theirs: [], names: {mine: [], theirs: []}};
		var i;
		for (i = 0; i < 2; i++) {
			var member = side.mine[i].pick === null ? null : team[side.mine[i].pick];
			state.mine.push(member ? myPokemon(member) : null);
			state.names.mine.push(member ? member.species : null);
		}
		for (i = 0; i < 2; i++) {
			var mon = (battle && side.theirs[i].pick !== null)
				? battle.team[side.theirs[i].pick] : null;
			state.theirs.push(mon ? RRTrainers.buildEnemy(battle, mon) : null);
			state.names.theirs.push(mon ? mon.species : null);
		}
		state.myLiving = state.mine[0] ? (state.mine[1] ? 2 : 1) : (state.mine[1] ? 1 : 0);
		state.theirLiving = state.theirs[0] ? (state.theirs[1] ? 2 : 1) : (state.theirs[1] ? 1 : 0);
		return state;
	}

	/** First living slot on a side, so targets never point at nothing. */
	function firstLiving(list) {
		return list[0] ? 0 : (list[1] ? 1 : -1);
	}

	/** Damage rolls for one attacker's moves against one defender. */
	function shots(attacker, defender, foes, allies) {
		if (!attacker || !defender) return [];
		var field = baseField();
		var bonus = RRTrainers.getPrefs().focusEnergy ? 2 : 0;
		var out = [];
		for (var i = 0; i < attacker.moves.length; i++) {
			var move = asMove(attacker.moves[i]);
			if (!move) { out.push(null); continue; }
			var spread = RRCritKO.targetsHit(move, foes, allies) >= 2;
			var moveField = RRCritKO.fieldForMove(field, move, foes, allies);
			var shot = RRCritKO.shotFor(g(), attacker, defender, move, moveField, bonus);
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

	// --------------------------------------------------------------- render

	function card(which, slot, state) {
		var isMine = which === "mine";
		var me = state[which][slot];
		var conf = side[which][slot];
		var foeList = isMine ? state.theirs : state.mine;
		var foeNames = isMine ? state.names.theirs : state.names.mine;
		var foes = isMine ? state.theirLiving : state.myLiving;
		var allies = (isMine ? state.myLiving : state.theirLiving) - 1;

		var source = isMine ? RRTrainers.getTeam()
			: (state.battle ? state.battle.team : []);
		var html = '<div class="rr-card' + (me ? "" : " rr-off") + '">';

		html += '<select class="rr-pick" data-side="' + which + '" data-slot="' + slot + '">' +
			'<option value="">(empty)</option>';
		for (var s = 0; s < source.length; s++) {
			var label = isMine
				? source[s].species + " Lv" + source[s].level
				: source[s].species + " Lv" + RRTrainers.resolveLevel(source[s]);
			html += '<option value="' + s + '"' +
				(conf.pick === s ? " selected" : "") + '>' + esc(label) + '</option>';
		}
		html += '</select>';

		if (!me) return html + '</div>';

		// Where this Pokemon is pointing.
		if (conf.target === null || !foeList[conf.target]) {
			conf.target = firstLiving(foeList);
		}
		if (conf.target >= 0 && foes > 0) {
			html += '<div class="rr-aim">';
			for (var f = 0; f < 2; f++) {
				if (!foeList[f]) continue;
				html += '<button class="rr-tgt' + (conf.target === f ? " rr-on" : "") +
					'" data-side="' + which + '" data-slot="' + slot +
					'" data-target="' + f + '">' + esc(foeNames[f]) + '</button>';
			}
			html += '</div>';
		}

		var target = foeList[conf.target];
		var list = shots(me, target, foes, allies);
		var maxHP = target ? target.maxHP() : 0;

		// Until the user picks, show the move that threatens this target most:
		// defaulting to slot 0 can land on Trick Room and say nothing.
		if (conf.move === null || !list[conf.move] || list[conf.move].dead) {
			var best = -1, bestMax = 0;
			for (var b = 0; b < list.length; b++) {
				if (list[b] && !list[b].dead && list[b].max > bestMax) {
					bestMax = list[b].max;
					best = b;
				}
			}
			conf.move = best >= 0 ? best : (conf.move === null ? -1 : conf.move);
		}
		html += '<div class="rr-moves">';
		for (var i = 0; i < list.length; i++) {
			var shot = list[i];
			if (!shot) continue;
			var chosen = conf.move === i;
			html += '<button class="rr-mv' + (chosen ? " rr-on" : "") +
				'" data-side="' + which + '" data-slot="' + slot +
				'" data-move="' + i + '">' +
				'<span class="rr-mn">' + esc(shot.move) +
				(shot.spread ? '<i>spread</i>' : "") + '</span>';
			if (shot.dead) {
				html += '<span class="rr-md">&mdash;</span>';
			} else {
				var solo = RRCritKO.koChancesMulti([shot], target.curHP(), 4);
				html += '<span class="rr-md">' + pct(shot.min, maxHP) + ' - ' +
					pct(shot.max, maxHP) + '%</span>' +
					'<span class="rr-mk">' + esc(koText(solo)) + '</span>';
			}
			html += '</button>';
		}
		html += '</div></div>';
		return html;
	}

	/** What the chosen moves do together, grouped by who they are aimed at. */
	function summary(state) {
		var lines = [];
		var sides = [
			{from: "theirs", to: "mine", label: "Yours"},
			{from: "mine", to: "theirs", label: "Theirs"}
		];
		for (var s = 0; s < sides.length; s++) {
			var from = sides[s].from, to = sides[s].to;
			var attackers = state[from], defenders = state[to];
			var foes = to === "mine" ? state.myLiving : state.theirLiving;
			var allies = (from === "mine" ? state.myLiving : state.theirLiving) - 1;

			for (var d = 0; d < 2; d++) {
				var defender = defenders[d];
				if (!defender) continue;
				var incoming = [], labels = [];
				for (var a = 0; a < 2; a++) {
					var attacker = attackers[a];
					var conf = side[from][a];
					if (!attacker || conf.target !== d) continue;
					var list = shots(attacker, defender, foes, allies);
					var shot = list[conf.move];
					if (!shot || shot.dead) continue;
					incoming.push(shot);
					labels.push(state.names[from][a] + " " + shot.move);
				}
				if (!incoming.length) continue;
				var hp = defender.curHP(), maxHP = defender.maxHP();
				var min = 0, max = 0;
				for (var k = 0; k < incoming.length; k++) {
					min += incoming[k].min;
					max += incoming[k].max;
				}
				var chances = RRCritKO.koChancesMulti(incoming, hp, 4);
				var ko = koText(chances);
				lines.push('<div class="rr-sum' + (chances[0] > 0 ? " rr-danger" : "") + '">' +
					'<span class="rr-st">' + esc(defender.name) + '</span>' +
					'<span class="rr-sd">' + pct(min, maxHP) + ' - ' + pct(max, maxHP) + '%</span>' +
					'<span class="rr-sk">' + esc(ko || "no KO") + '</span>' +
					'<span class="rr-sf">' + esc(labels.join(" + ")) + '</span></div>');
			}
		}
		return lines.join("");
	}

	function render() {
		if (!$("#rr-doubles").length) return;
		var state;
		try {
			state = read();
		} catch (e) {
			return;
		}
		var html = '<div class="rr-board">' +
			'<div class="rr-col"><div class="rr-colh">You</div>' +
				card("mine", 0, state) + card("mine", 1, state) + '</div>' +
			'<div class="rr-col"><div class="rr-colh">Opponent</div>' +
				card("theirs", 0, state) + card("theirs", 1, state) + '</div>' +
			'</div>';

		var counts = state.myLiving + "v" + state.theirLiving;
		var note = (state.myLiving < 2 || state.theirLiving < 2)
			? ' <i>spread moves at full damage</i>' : "";
		html += '<div class="rr-sums"><span class="rr-fmt">' + counts + note + '</span>' +
			summary(state) + '</div>';
		$("#rr-dbl-body").html(html);
	}

	// ----------------------------------------------------------------- init

	function bind() {
		var root = $("#rr-doubles");

		root.on("change", ".rr-pick", function () {
			var v = $(this).val();
			var conf = side[$(this).data("side")][~~$(this).data("slot")];
			conf.pick = v === "" ? null : ~~v;
			conf.move = null;
			render();
		});

		root.on("click", ".rr-tgt", function () {
			var conf = side[$(this).data("side")][~~$(this).data("slot")];
			conf.target = ~~$(this).data("target");
			conf.move = null;   // strongest move against the new target
			render();
		});

		root.on("click", ".rr-mv", function () {
			side[$(this).data("side")][~~$(this).data("slot")].move =
				~~$(this).data("move");
			render();
		});

		$("#rr-dbl-collapse").click(function () {
			var body = $("#rr-dbl-body");
			body.toggle();
			$(this).text(body.is(":visible") ? "hide" : "show");
		});

		// Doubles battles arrive ready to use.
		RRTrainers.onBattleChange(function (battle) {
			var doubles = battle && RRTrainers.isDoubles(battle);
			side.theirs[0].pick = battle && battle.team.length > 0 ? 0 : null;
			side.theirs[1].pick = doubles && battle.team.length > 1 ? 1 : null;
			side.theirs[0].move = side.theirs[1].move = null;
			if (doubles) {
				$("#rr-dbl-body").show();
				$("#rr-dbl-collapse").text("hide");
			}
			render();
		});
	}

	$(function () {
		if (typeof RRTrainers === "undefined" || typeof RRCritKO === "undefined") return;
		var host = $("#rr-panel");
		if (!host.length) return;
		host.after('<div id="rr-doubles"><div class="rr-head">' +
			'<span class="rr-title">Double Battle</span>' +
			'<button id="rr-dbl-collapse">hide</button></div>' +
			'<div id="rr-dbl-body"></div></div>');
		var team = RRTrainers.getTeam();
		side.mine[0].pick = team.length > 0 ? 0 : null;
		side.mine[1].pick = team.length > 1 ? 1 : null;
		bind();
		render();
	});
})();
