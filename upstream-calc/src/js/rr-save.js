/**
 * rr-save.js -- import your own Pokemon from a Radical Red battery save.
 *
 * Radical Red is a FireRed patch, so the save keeps the GBA shell: 128 KB, two
 * alternating slots of 14 sections, each section ending in an id, checksum,
 * signature and save counter. What it does NOT keep is the Pokemon format.
 * Vanilla encrypts 48 bytes per Pokemon and permutes four substructures by
 * PID % 24; Radical Red stores a flat, unencrypted 100-byte record. Every
 * offset below was recovered by decoding a known Pokemon and checking it
 * against the game -- species, held item, moves, IVs, level and stats all
 * confirmed.
 *
 * Two things are worth knowing about what this can and cannot read:
 *
 *   - Nature is not stored anywhere obvious, but it does not need to be. The
 *     stored stats are a fingerprint: with base stats, IVs, EVs and level
 *     known, exactly one nature reproduces all six numbers. That is derived
 *     rather than guessed, and it is exact.
 *   - The ability slot has not been located. Radical Red has three per species
 *     where vanilla had two, so it cannot live in vanilla's single PID bit.
 *     The first non-hidden ability is used, and the panel's dropdown is right
 *     there to change it.
 *   - PC boxes use a second, tighter format: 58 bytes, no stats block and no
 *     level, with the four moves packed ten bits each. The level comes back out
 *     of the stored experience and the species' growth curve, which the dex
 *     bundle carries for exactly this reason.
 *
 * The save counter cannot be trusted to pick the current slot either: a file
 * can hold two playthroughs, and starting a new game does not continue the old
 * counter. So both slots are shown with their trainer name, playtime and team,
 * and you choose.
 */
/* global $, RR_DEX_DATA, RRTrainers, RRDex */
var RRSave = (function () {
	"use strict";

	var SECTION_SIZE = 4096;
	var SECTION_COUNT = 14;
	var SLOT_SIZE = SECTION_SIZE * SECTION_COUNT;
	var SIGNATURE = 0x08012025;

	// Offsets within Radical Red's flat 100-byte Pokemon record.
	/*
	 * A party member is 100 bytes: the same 0x20-byte identity header a stored
	 * Pokemon carries, then the battle data. The header was found by noticing
	 * that the trainer id -- one constant repeated once per Pokemon -- appears
	 * every 100 bytes starting 0x20 before the species, with the nickname right
	 * behind it. Anchoring on it beats guessing an offset: it is the one field
	 * whose value is known in advance to be the same for all six.
	 */
	var REC = {
		SIZE: 100,
		PID: 0x00, OTID: 0x04, NICK: 0x08, OT_NAME: 0x14,
		SPECIES: 0x20, ITEM: 0x22, EXP: 0x24, FRIENDSHIP: 0x29,
		MOVES: 0x2c, PP: 0x34, EVS: 0x38, IVS: 0x48,
		LEVEL: 0x54, CUR_HP: 0x56, STATS: 0x58
	};
	// A stored Pokemon is packed tighter: no level, no stats, and the four
	// moves share five bytes at ten bits each.
	var BOX = {
		SIZE: 58,
		PID: 0x00, OTID: 0x04, NICK: 0x08, OT_NAME: 0x14, SPECIES: 0x1c,
		ITEM: 0x1e, EXP: 0x20, MOVES: 0x27, EVS: 0x2c, IVS: 0x36
	};
	// PC storage runs from logical section 5 to the last section.
	var PC_FIRST = 5, PC_LAST = 13;

	// Stats are stored in the games' internal order.
	var STAT_ORDER = ["hp", "atk", "def", "spe", "spa", "spd"];

	var NATURES = [
		"Hardy", "Lonely", "Brave", "Adamant", "Naughty",
		"Bold", "Docile", "Relaxed", "Impish", "Lax",
		"Timid", "Hasty", "Serious", "Jolly", "Naive",
		"Modest", "Mild", "Quiet", "Bashful", "Rash",
		"Calm", "Gentle", "Sassy", "Careful", "Quirky"
	];
	var NATURE_UP = [null, "atk", "spe", "atk", "atk", "def", null, "def", "def",
		"def", "spe", "spe", null, "spe", "spe", "spa", "spa", "spa", null,
		"spa", "spd", "spd", "spd", "spd", null];
	var NATURE_DOWN = [null, "def", "spe", "spa", "spd", "atk", null, "spe",
		"spa", "spd", "atk", "def", null, "spa", "spd", "atk", "def", "spe",
		null, "spd", "atk", "def", "spe", "spa", null];

	// The GBA character table, enough for a trainer name.
	var LETTERS = {};
	(function () {
		var upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		var lower = "abcdefghijklmnopqrstuvwxyz";
		var i;
		for (i = 0; i < 26; i++) LETTERS[0xbb + i] = upper[i];
		for (i = 0; i < 26; i++) LETTERS[0xd5 + i] = lower[i];
		for (i = 0; i <= 9; i++) LETTERS[0xa1 + i] = String(i);
		LETTERS[0x00] = " ";
	})();

	function dex() {
		return (typeof RR_DEX_DATA !== "undefined") ? RR_DEX_DATA : null;
	}

	function esc(text) {
		return String(text === null || text === undefined ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;")
			.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	// ------------------------------------------------------------- decoding

	function readName(view, offset, length) {
		var out = "";
		for (var i = 0; i < length; i++) {
			var b = view.getUint8(offset + i);
			if (b === 0xff) break;
			out += LETTERS[b] !== undefined ? LETTERS[b] : "?";
		}
		return out.trim();
	}

	/**
	 * Exactly one nature reproduces a Pokemon's six stored stats. Finding it
	 * beats assuming, and it is what makes an imported team calculate correctly.
	 */
	function deriveNature(species, level, ivs, evs, stats) {
		var base = {
			hp: species.stats[0], atk: species.stats[1], def: species.stats[2],
			spe: species.stats[3], spa: species.stats[4], spd: species.stats[5]
		};
		var found = [];
		for (var n = 0; n < 25; n++) {
			var ok = true;
			for (var s = 0; s < STAT_ORDER.length; s++) {
				var key = STAT_ORDER[s];
				var value;
				if (key === "hp") {
					value = Math.floor((2 * base.hp + ivs.hp + Math.floor(evs.hp / 4)) *
						level / 100) + level + 10;
				} else {
					value = Math.floor((2 * base[key] + ivs[key] + Math.floor(evs[key] / 4)) *
						level / 100) + 5;
					if (NATURE_UP[n] === key) value = Math.floor(value * 1.1);
					else if (NATURE_DOWN[n] === key) value = Math.floor(value * 0.9);
				}
				if (value !== stats[key]) { ok = false; break; }
			}
			if (ok) found.push(NATURES[n]);
		}
		if (found.length === 1) return {nature: found[0], exact: true};
		if (found.length > 1) return {nature: found[0], exact: false};
		// Shiny hunting, Hyper Training or an EV field we have not located can
		// all break the fingerprint. Fall back to the offensive nature that
		// suits the Pokemon rather than leaving it neutral.
		return {
			nature: base.atk >= base.spa ? "Adamant" : "Modest",
			exact: false
		};
	}

	/**
	 * Ability 1, which is what a Pokemon has unless the game says otherwise.
	 *
	 * The dex bundle now orders abilities the way the game numbers them, so
	 * this is the first entry. It used to be "the first non-hidden one" over a
	 * list whose hidden ability came first, which quietly handed every import
	 * its species' hidden ability instead.
	 */
	function defaultAbility(species) {
		for (var i = 0; i < species.abilities.length; i++) {
			if (!species.abilities[i].hidden) return species.abilities[i].name;
		}
		return species.abilities.length ? species.abilities[0].name : "";
	}

	function readRecord(view, offset, withStats) {
		var d = dex();
		var speciesId = view.getUint16(offset + REC.SPECIES, true);
		var species = d.species[speciesId];
		if (!species) return null;

		var ivField = view.getUint32(offset + REC.IVS, true);
		var ivs = {
			hp: ivField & 31, atk: (ivField >>> 5) & 31, def: (ivField >>> 10) & 31,
			spe: (ivField >>> 15) & 31, spa: (ivField >>> 20) & 31,
			spd: (ivField >>> 25) & 31
		};
		if ((ivField >>> 30) & 1) return null;   // egg

		var evs = {};
		for (var e = 0; e < STAT_ORDER.length; e++) {
			evs[STAT_ORDER[e]] = view.getUint8(offset + REC.EVS + e);
		}

		var moves = [];
		for (var m = 0; m < 4; m++) {
			var id = view.getUint16(offset + REC.MOVES + m * 2, true);
			if (id && d.moves[id]) moves.push(d.moves[id].name);
		}
		if (!moves.length) return null;

		var itemId = view.getUint16(offset + REC.ITEM, true);
		var level = withStats ? view.getUint8(offset + REC.LEVEL) : 0;

		var nature = {nature: species.stats[1] >= species.stats[4] ? "Adamant" : "Modest",
			exact: false};
		if (withStats) {
			if (level < 1 || level > 100) return null;
			var stats = {};
			for (var s = 0; s < STAT_ORDER.length; s++) {
				stats[STAT_ORDER[s]] = view.getUint16(offset + REC.STATS + s * 2, true);
			}
			if (!stats.hp) return null;
			nature = deriveNature(species, level, ivs, evs, stats);
		}

		// The ability slot has not been located in the save, so ability 1
		// stands in. It is a dropdown in the panel.
		var ability = defaultAbility(species);

		if (!withStats) return null;   // nothing trustworthy without a stats block
		var nickname = readText(view, offset + REC.NICK, 10) || "";
		return {
			species: species.name,
			nickname: nickname === species.name ? "" : nickname,
			level: level,
			nature: nature.nature,
			natureExact: nature.exact,
			ability: ability,
			item: (itemId && d.items && d.items[itemId]) ? d.items[itemId] : "",
			moves: moves,
			evs: evs,
			ivs: ivs
		};
	}

	/** Section id -> file offset, for one slot. */
	function sectionMap(view, slot) {
		var map = {};
		for (var i = 0; i < SECTION_COUNT; i++) {
			var off = slot * SLOT_SIZE + i * SECTION_SIZE;
			if (off + SECTION_SIZE > view.byteLength) break;
			if (view.getUint32(off + 0x0ff8, true) !== SIGNATURE) continue;
			var id = view.getUint16(off + 0x0ff4, true);
			if (id < SECTION_COUNT) map[id] = off;
		}
		return map;
	}

	/**
	 * Find the party by content rather than by a fixed offset: a run of records
	 * one hundred bytes apart that all decode. A hack is free to move things,
	 * and this survives that.
	 */
	function findParty(view, sectionOffset) {
		var best = [];
		for (var base = sectionOffset; base < sectionOffset + 512; base += 2) {
			// All six share one trainer id, which is what pins the alignment.
			var otId = view.getUint32(base + REC.OTID, true);
			if (!otId) continue;
			var run = [];
			for (var k = 0; k < 6; k++) {
				var at = base + k * REC.SIZE;
				if (at + REC.SIZE > view.byteLength) break;
				if (view.getUint32(at + REC.OTID, true) !== otId) break;
				var mon = readRecord(view, at, true);
				if (!mon) break;
				run.push(mon);
			}
			if (run.length > best.length) best = run;
			if (best.length === 6) break;
		}
		return best;
	}

	// ------------------------------------------------------------ PC boxes

	/** Experience needed to reach a level, on each of the six growth curves. */
	function expAtLevel(curve, n) {
		switch (curve) {
		case 1:  // medium slow
			return Math.floor(6 * n * n * n / 5) - 15 * n * n + 100 * n - 140;
		case 2:  // fast
			return Math.floor(4 * n * n * n / 5);
		case 3:  // slow
			return Math.floor(5 * n * n * n / 4);
		case 4:  // erratic
			if (n <= 50) return Math.floor(n * n * n * (100 - n) / 50);
			if (n <= 68) return Math.floor(n * n * n * (150 - n) / 100);
			if (n <= 98) return Math.floor(n * n * n * Math.floor((1911 - 10 * n) / 3) / 500);
			return Math.floor(n * n * n * (160 - n) / 100);
		case 5:  // fluctuating
			if (n <= 15) return Math.floor(n * n * n * (Math.floor((n + 1) / 3) + 24) / 50);
			if (n <= 36) return Math.floor(n * n * n * (n + 14) / 50);
			return Math.floor(n * n * n * (Math.floor(n / 2) + 32) / 50);
		default: // medium fast
			return n * n * n;
		}
	}

	/**
	 * A stored Pokemon keeps experience, not level -- the game works the level
	 * out from the species' growth curve every time it needs one, and so do we.
	 */
	function levelFromExp(species, exp) {
		var table = dex().growth || "";
		var curve = (species.dexID > 0 && species.dexID < table.length)
			? Number(table.charAt(species.dexID)) : 0;
		if (exp > expAtLevel(curve, 100)) return 0;
		for (var n = 100; n >= 1; n--) {
			if (exp >= expAtLevel(curve, n)) return n;
		}
		return 1;
	}

	/** Decode GBA text, refusing anything that is not really text. */
	function readText(view, offset, length) {
		var out = "";
		for (var i = 0; i < length; i++) {
			var b = view.getUint8(offset + i);
			if (b === 0xff) break;
			if (LETTERS[b] === undefined) return null;
			out += LETTERS[b];
		}
		return out.replace(/\s+$/, "");
	}

	/**
	 * Read one box slot, or null.
	 *
	 * Everything here is a check as much as a read. An earlier version of this
	 * function trusted a valid species with valid moves, and that was enough to
	 * mistake a seen/caught bitfield for a boxful of Pokemon -- the app grew
	 * spurious level 100 Kangaskhan. So a slot has to survive all of it: real
	 * species, a gapless run of moves it could plausibly hold, sane EVs and
	 * IVs, an experience total inside the species' own curve, and a nickname
	 * and trainer name that decode as actual text. Junk does not clear that bar.
	 */
	function readBoxRecord(view, offset) {
		var d = dex();
		if (offset + BOX.SIZE > view.byteLength) return null;

		var empty = true, i;
		for (i = 0; i < BOX.SIZE; i++) {
			if (view.getUint8(offset + i)) { empty = false; break; }
		}
		if (empty) return null;

		var species = d.species[view.getUint16(offset + BOX.SPECIES, true)];
		if (!species) return null;

		var nickname = readText(view, offset + BOX.NICK, 10);
		var otName = readText(view, offset + BOX.OT_NAME, 7);
		if (!nickname || !otName || nickname.length < 2 || otName.length < 2) return null;

		var ivField = view.getUint32(offset + BOX.IVS, true);
		if ((ivField >>> 30) & 1) return null;   // egg
		var ivs = {
			hp: ivField & 31, atk: (ivField >>> 5) & 31, def: (ivField >>> 10) & 31,
			spe: (ivField >>> 15) & 31, spa: (ivField >>> 20) & 31,
			spd: (ivField >>> 25) & 31
		};

		var evs = {}, evTotal = 0;
		for (i = 0; i < STAT_ORDER.length; i++) {
			var ev = view.getUint8(offset + BOX.EVS + i);
			if (ev > 252) return null;
			evTotal += ev;
			evs[STAT_ORDER[i]] = ev;
		}
		if (evTotal > 510) return null;

		// Four ten-bit move ids across five bytes, low move first.
		var low = view.getUint32(offset + BOX.MOVES, true);
		var high = view.getUint8(offset + BOX.MOVES + 4);
		var ids = [
			low & 1023, (low >>> 10) & 1023, (low >>> 20) & 1023,
			((low >>> 30) & 3) | ((high & 255) << 2)
		];
		var moves = [], sawGap = false;
		for (i = 0; i < ids.length; i++) {
			if (!ids[i]) { sawGap = true; continue; }
			if (sawGap) return null;              // a hole before a real move
			if (!d.moves[ids[i]]) return null;
			moves.push(d.moves[ids[i]].name);
		}
		if (!moves.length) return null;

		var level = levelFromExp(species, view.getUint32(offset + BOX.EXP, true));
		if (level < 1) return null;

		var itemId = view.getUint16(offset + BOX.ITEM, true);
		var ability = defaultAbility(species);

		return {
			species: species.name,
			nickname: nickname === species.name ? "" : nickname,
			level: level,
			// No stats are stored, so the fingerprint that pins a party
			// member's nature is not available here. Fall back to the
			// offensive nature that suits the species.
			nature: species.stats[1] >= species.stats[4] ? "Adamant" : "Modest",
			natureExact: false,
			ability: ability,
			item: (itemId && d.items && d.items[itemId]) ? d.items[itemId] : "",
			moves: moves,
			evs: evs,
			ivs: ivs
		};
	}

	/**
	 * Read the PC.
	 *
	 * Storage is one long run of 58-byte slots that starts four bytes into
	 * logical section 5 and carries on through the sections after it. How much
	 * of each section it uses is not something this can know for certain, so
	 * rather than assume a stride and hope, each section is fitted on its own:
	 * try all 58 alignments, keep whichever yields the most slots that survive
	 * readBoxRecord. A section holding nothing yields nothing, and a section
	 * whose alignment we would have guessed wrong yields nothing either --
	 * which loses Pokemon at worst, and never invents them.
	 */
	function findBoxes(view, map) {
		var found = [];
		for (var id = PC_FIRST; id <= PC_LAST; id++) {
			if (map[id] === undefined) continue;
			var best = null;
			for (var phase = 0; phase < BOX.SIZE; phase++) {
				var run = [];
				for (var off = map[id] + phase;
					off + BOX.SIZE <= map[id] + 0x0ff4; off += BOX.SIZE) {
					var mon = readBoxRecord(view, off);
					if (mon) run.push(mon);
				}
				if (!best || run.length > best.length) best = run;
			}
			if (best) found = found.concat(best);
		}
		return found;
	}

	function parse(buffer) {
		var view = new DataView(buffer);
		if (!dex()) return {error: "The Pokedex data has not loaded yet."};
		if (view.byteLength < SLOT_SIZE) {
			return {error: "That file is too small to be a battery save."};
		}

		var slots = [];
		for (var s = 0; s < 2; s++) {
			var map = sectionMap(view, s);
			if (map[0] === undefined || map[1] === undefined) continue;
			var party = findParty(view, map[1]);
			if (!party.length) continue;
			slots.push({
				index: s,
				trainer: readName(view, map[0], 7),
				hours: view.getUint16(map[0] + 0x0e, true),
				minutes: view.getUint8(map[0] + 0x10),
				counter: view.getUint32(map[0] + 0x0ffc, true),
				party: party,
				boxes: findBoxes(view, map)
			});
		}
		if (!slots.length) {
			return {error: "No Radical Red save data found in that file. " +
				"It needs to be the battery save (.sav), not a save state."};
		}
		return {slots: slots};
	}

	// ------------------------------------------------------------------- UI

	var parsed = null;

	function describe(slot) {
		return esc(slot.trainer || "?") + " &mdash; " + slot.hours + "h" +
			slot.minutes + "m &mdash; " +
			esc(slot.party.map(function (p) { return p.species; }).join(", ")) +
			(slot.boxes.length ? " (+" + slot.boxes.length + " in boxes)" : "");
	}

	function render() {
		if (!parsed) { $("#rr-save-out").empty(); return; }
		if (parsed.error) {
			$("#rr-save-out").html('<div class="rr-save-msg">' +
				esc(parsed.error) + "</div>");
			return;
		}
		var html = "";
		for (var i = 0; i < parsed.slots.length; i++) {
			var slot = parsed.slots[i];
			html += '<div class="rr-save-slot">' +
				'<button class="rr-save-take" data-slot="' + i + '">Use this save</button>' +
				'<span class="rr-save-desc">' + describe(slot) + "</span></div>";
		}
		if (parsed.slots.length > 1) {
			html += '<div class="rr-save-msg">Two playthroughs are stored in that ' +
				"file. The save counter does not reliably say which is current, so " +
				"pick the one whose playtime matches your game.</div>";
		}
		$("#rr-save-out").html(html);
	}

	function take(index) {
		var slot = parsed && parsed.slots[index];
		if (!slot || typeof RRTrainers === "undefined" || !RRTrainers.addTeam) return;
		var all = slot.party.concat(slot.boxes);
		var added = RRTrainers.addTeam(all);

		// Be precise about which numbers are read and which are inferred, so
		// nothing here is taken for gospel that should not be.
		var guessed = 0;
		for (var i = 0; i < slot.party.length; i++) {
			if (!slot.party[i].natureExact) guessed++;
		}
		var notes = [];
		notes.push(slot.party.length + " from the team" +
			(slot.boxes.length ? ", " + slot.boxes.length + " from the PC" : ""));
		if (slot.party.length) {
			notes.push(guessed
				? guessed + " team nature(s) could not be pinned down from the stats"
				: "team natures were read exactly from the stats");
		}
		if (slot.boxes.length) {
			// A stored Pokemon keeps no stats, so there is no fingerprint to
			// solve; the level comes from its experience instead.
			notes.push("stored Pokémon keep no stats, so their levels come from " +
				"experience and their natures default to Adamant or Modest by " +
				"whichever attacking stat is higher");
		}
		$("#rr-save-out").html('<div class="rr-save-msg">Imported ' + added +
			" Pokémon into My Team &mdash; " + esc(notes.join("; ")) + ". " +
			"Abilities default to the first one each species has; change them " +
			"in the panel if needed.</div>");
	}

	/**
	 * Read one .sav, whether it was picked or dropped.
	 *
	 * Species data lives in a 3.9 MB bundle the page only pulls in on demand,
	 * so importing before ever opening the Pokedex used to fail with "the
	 * Pokedex data has not loaded yet" -- true, unhelpful, and the user's
	 * problem to solve. Load it here instead.
	 */
	function readFile(file, retried) {
		if (!file) return;
		// Once. If the bundle still is not there afterwards, parse says so --
		// asking for it again would just spin.
		if (!dex() && !retried && typeof RRDex !== "undefined" && RRDex.ensureData) {
			$("#rr-save-out").html('<div class="rr-save-msg">Loading Pok\u00e9dex ' +
				"data…</div>");
			RRDex.ensureData(function () { readFile(file, true); });
			return;
		}
		$("#rr-save-out").html('<div class="rr-save-msg">Reading ' +
			esc(file.name) + "…</div>");
		var reader = new FileReader();
		reader.onload = function () {
			try {
				parsed = parse(reader.result);
			} catch (e) {
				parsed = {error: "Could not read that file: " + e.message};
			}
			render();
		};
		reader.onerror = function () {
			parsed = {error: "Could not read that file."};
			render();
		};
		reader.readAsArrayBuffer(file);
	}

	function bind() {
		$(document).on("change", "#rr-save-file", function () {
			readFile(this.files && this.files[0]);
			// Clear it, so picking the same path again after saving the game
			// still fires a change event and re-reads the newer file.
			this.value = "";
		});
		$(document).on("click", ".rr-save-take", function () {
			take(~~$(this).data("slot"));
		});

		/*
		 * Drag and drop, because the file picker is the worst part of this.
		 * OpenEmu keeps its battery saves under ~/Library, which Finder hides,
		 * so reaching them through an open dialog means typing a path every
		 * time. Dropping the file on the panel skips all of it.
		 */
		var zone = "#rr-panel";
		var depth = 0;
		$(document).on("dragenter dragover", zone, function (e) {
			var dt = e.originalEvent && e.originalEvent.dataTransfer;
			if (!dt || !dt.types || dt.types.indexOf("Files") < 0) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.type === "dragenter" && depth++ === 0) $(zone).addClass("rr-dropping");
		});
		$(document).on("dragleave", zone, function () {
			if (--depth <= 0) { depth = 0; $(zone).removeClass("rr-dropping"); }
		});
		$(document).on("drop", zone, function (e) {
			var dt = e.originalEvent && e.originalEvent.dataTransfer;
			if (!dt || !dt.files || !dt.files.length) return;
			e.preventDefault();
			e.stopPropagation();
			depth = 0;
			$(zone).removeClass("rr-dropping");
			var file = dt.files[0];
			if (!/\.(sav|srm|sa[0-9]|fla)$/i.test(file.name)) {
				parsed = {error: "That is not a battery save. Drop the .sav file " +
					"the emulator writes, not a save state."};
				render();
				return;
			}
			readFile(file);
		});
		// Anywhere else on the page, a dropped file would navigate away from
		// the calculator and lose whatever is set up.
		$(document).on("dragover drop", function (e) {
			if ($(e.target).closest(zone).length) return;
			e.preventDefault();
		});
	}

	$(function () {
		if (typeof RRTrainers === "undefined") return;
		bind();
	});

	return {parse: parse, deriveNature: deriveNature, RECORD: REC};
})();
