/**
 * The planner, playing. One turn at a time.
 *
 * Run: node tools/agent.js          (then load tools/lua/agent.lua in mGBA)
 *
 * The loop James asked for: "It does a move, the model makes a quicksave to
 * look at the AI's next move and finds the best move for us, and then the next
 * move is played." The quicksave turned out to be unnecessary -- the AI's
 * chosen action is readable from live RAM at the decision point -- so the loop
 * is tighter than that: read the position, read what the opponent has already
 * committed to, decide, play it, check what happened.
 *
 * THE PREDICTION LOG IS THE POINT OF THE EARLY FIGHTS. Every turn this writes
 * down what it expected -- the crit flag, the damage roll, the damage -- before
 * pressing anything, and then what actually happened. Two things are known to
 * be unverified: the order in which a full turn consumes RNG draws when both
 * sides act, and which draw decides a secondary effect like a Scald burn.
 * Neither is worth another hand-built fixture. A hundred real turns of
 * predicted-against-actual settles both, and the same log says why a fight was
 * lost. Losing the first fights is expected and fine.
 *
 * The opponent is reconstructed EXACTLY rather than guessed: species, level,
 * moves, ability, item, current HP, status, stat stages and its real stats all
 * come out of gBattleMons, and the real stats go into the calculator as base
 * stat overrides so it computes from the numbers the game is using.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const R = require('./lib/replan.js');
const UL = require('./lib/userline.js');

const DIR = path.join(process.env.HOME, 'rr-agent');
const STATE = path.join(DIR, 'state.json');
const CMD = path.join(DIR, 'cmd.json');
// Names this agent session's append-only archive folder (see the archiver).
const SESSION = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const RESULT = path.join(DIR, 'result.json');
const PRED = path.join(DIR, 'predictions.tsv');
// THE HUMAN'S TWO CONTROLS (tools/control.js). Files, not a socket, so the
// agent has no dependency on the panel being up: no pause file means play, no
// panel heartbeat means nobody is watching and nothing waits on a person.
const PAUSE = path.join(DIR, 'pause');
const ASK = path.join(DIR, 'ask.json');
const CHOICE = path.join(DIR, 'choice.json');
const PANEL = path.join(DIR, 'panel.alive');
// A line typed by hand, the verdict on it, and the append-only record of every
// line ever asked about. The record is the point as much as the answer is:
// "why didn't it do that" is only worth asking if the answer survives the turn.
const LINE = path.join(DIR, 'line.json');
const LINE_RESULT = path.join(DIR, 'line_result.json');
const LINES_LOG = path.join(DIR, 'lines.jsonl');

const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const AI_FLAGS = {checkBadMove: true, checkGoodMove: true};
const dex = H.loadDex();
const party = H.realTeam();

/**
 * Which trainer battle is this? Identified by the opponent's active species,
 * so the real sets (abilities, items, Hidden Power types, EV spreads) can be
 * used instead of anything inferred from RAM.
 */
const ALL_BATTLES = H.earlyBattles(engine, {maxLevel: 60});
const battleCache = {};
function planCtx(obs) {
	return {
		engine, party,
		foeSets: foeTeamFor(obs),
		// EXPENDABLE="" MEANS NOBODY, not "use the default". Written with `||`,
		// an empty string is falsy and silently became the Surge cap, so there
		// was no way to say "every death is forbidden" -- which is exactly what
		// a run outside Surge needs. The death-check below already reads it
		// with `=== undefined`; the two disagreed, so the planner could price
		// Lilligant as spendable while the recorder counted her death as a
		// loss.
		expendable: (process.env.EXPENDABLE === undefined
			? 'Lilligant' : process.env.EXPENDABLE).split(',').filter(Boolean)
	};
}

/**
 * THEIR TEAM AS SETS -- one answer, shared by the state builder and the
 * planner context.
 *
 * These were two separate constructions that disagreed: `buildState` padded
 * the team to one slot per occupied party slot, while `planCtx` returned a
 * SINGLE set whenever the trainer was not in the dataset. Indices from one
 * were then used against the other, so the moment their active resolved to
 * anything but slot 0 the planner threw `foeSets[fi].species` and every turn
 * printed "no plan found". Same shape as every bug on this project: two parts
 * keeping their own idea of the position.
 */
function foeTeamFor(obs) {
	const foeSet = setFromBattler(obs.foe, null);
	const bt = battleOf(obs);
	const known = bt ? (H.foeSets(bt) || []) : [];
	let team = null;
	if (obs.foeparty && obs.foeparty.length && known.length) {
		team = [];
		obs.foeparty.forEach((row, i) => {
			if (!row.maxhp) return;               // empty slot: they carry fewer
			team.push(known[i] || Object.assign({}, foeSet));
		});
	}
	if (!team || !team.length) {
		const n = (obs.foeparty || []).filter(r => r && r.maxhp).length || 1;
		team = [];
		for (let i = 0; i < n; i++) team.push(Object.assign({}, foeSet));
	}
	return team;
}

function battleOf(obs) {
	const name = speciesName(obs.foe.species);
	if (!name) return null;
	if (battleCache[name] !== undefined) return battleCache[name];
	// Match FORMS too. RAM reports the base species -- "Manectric" -- while the
	// trainer data lists "Manectric-Mega", so an exact-name lookup returned
	// nothing the moment Surge's last Pokemon came in, and foeSets(null) threw.
	// That killed the planner mid-fight and left the agent waiting forever on an
	// answer that was never coming.
	const base = n => String(n || '').split('-')[0];
	let found = null;
	for (const b of ALL_BATTLES) {
		if ((b.team || []).some(m => m.species === name)) { found = b; break; }
	}
	if (!found) {
		for (const b of ALL_BATTLES) {
			if ((b.team || []).some(m => base(m.species) === base(name))) { found = b; break; }
		}
	}
	battleCache[name] = found;
	return found;
}

const speciesName = id => (dex.byID[id] && dex.byID[id].name) || null;
const moveName = id => dex.moveName[id] || null;
const abilityName = id => {
	for (const k in dex.dex.abilities) {
		if (dex.dex.abilities[k].ID === id) return dex.dex.abilities[k].names[0];
	}
	return null;
};
const itemName = id => {
	if (!id) return '';
	for (const k in dex.dex.items) {
		if (dex.dex.items[k].ID === id) return dex.dex.items[k].name;
	}
	return '';
};

// Gen 3 packs status into a bitfield. Only the parts that change a decision.
/**
 * Turn one sampled "action/target" pair into the move or switch it names.
 *
 * The pair is meaningless without the opponent's move list, which is why it is
 * resolved here against the moves recorded before the turn rather than printed
 * raw.
 */
function sampleName(res, tag) {
	const s = res.ai_samples && res.ai_samples[tag];
	if (!s || !awaiting) return '';
	const bits = s.split('/');
	const act = parseInt(bits[0], 10), tgt = parseInt(bits[1], 10);
	if (act === 1) return 'switch ' + tgt;
	const mv = awaiting.foeMoves && awaiting.foeMoves[tgt];
	return (mv && moveName(mv)) || ('slot ' + tgt);
}

function statusOf(word) {
	if (word & 0x07) return 'slp';
	if (word & 0x08) return 'psn';
	if (word & 0x10) return 'brn';
	if (word & 0x20) return 'frz';
	if (word & 0x40) return 'par';
	if (word & 0x80) return 'tox';
	return null;
}

const STAT_ORDER = ['hp', 'atk', 'def', 'spe', 'spa', 'spd', 'acc', 'eva'];

/**
 * Recover a move whose NAME is not enough, from the trainer database.
 *
 * "Hidden Power" is one move ID whose type comes from hidden IVs, so a set
 * rebuilt out of RAM says only "Hidden Power" and the calculator prices it as
 * the default type. Measured cost: Bellibolt's Hidden Power did 48 against a
 * predicted band of 20-24 -- exactly 2.00x, super effective -- and 13 on
 * another turn, about half, resisted. Both are simply the wrong type.
 *
 * The trainer data already knows: it lists Hidden Power Grass for Bellibolt and
 * Hidden Power Ice for Pincurchin. The offline planner reads that file and has
 * always been correct here; only the live reconstruction lost it. So when a
 * species and level match exactly one trainer set, its move names are used to
 * resolve the ambiguous ones.
 */
const trainerSetCache = {};
function trainerSetFor(species, level) {
	const key = species + '|' + level;
	if (trainerSetCache[key] !== undefined) return trainerSetCache[key];
	let found = null, count = 0;
	try {
		for (const seg of engine.TRAINERS.segments) {
			for (const b of (seg.battles || [])) {
				for (const m of (b.team || [])) {
					if (m.species !== species) continue;
					if (m.level && m.level.type === 'fixed' && m.level.value !== level) continue;
					count++;
					if (!found) found = m;
				}
			}
		}
	} catch (e) { /* fall through to null */ }
	trainerSetCache[key] = (count === 1 || (found && count > 1
		&& /Hidden Power/.test((found.moves || []).join(' ')))) ? found : null;
	return trainerSetCache[key];
}

function setFromBattler(b, known) {
	const name = speciesName(b.species);
	if (!name) return null;
	const moves = (b.moves || []).map(moveName).filter(Boolean);
	// Where we already know the real set -- our own Pokemon, read off the save
	// -- keep it, because it carries the nature and spread. For the opponent
	// the observed stats ARE the truth and go in directly.
	const base = known || {
		species: name, level: b.level, nature: 'Serious',
		ability: abilityName(b.ability) || undefined,
		item: itemName(b.item),
		evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
	};
	let resolved = moves;
	if (!known && moves.some(m => m === 'Hidden Power')) {
		const t = trainerSetFor(name, b.level);
		if (t && t.moves) {
			resolved = moves.map(m => m !== 'Hidden Power' ? m
				: (t.moves.find(x => /^Hidden Power/.test(x)) || m));
		}
	}
	const out = Object.assign({}, base, {moves: resolved.length ? resolved : base.moves});
	if (b.stats && b.stats.length === 5) {
		out.rawStats = {atk: b.stats[0], def: b.stats[1], spe: b.stats[2],
			spa: b.stats[3], spd: b.stats[4]};
	}
	return out;
}

/** Rebuild an engine position from what the agent saw in RAM. */
function buildState(obs) {
	const foeSet = setFromBattler(obs.foe, null);
	if (!foeSet) return null;
	const mineName = speciesName(obs.me.species);

	// THE PARTY ORDER COMES FROM RAM, NOT FROM THE SAVE FILE. They are not the
	// same: ss4's party is ordered Lilligant, Diggersby, Lanturn, Breloom,
	// Victreebel, Mienshao while the .sav has Mienshao first. Trusting the file
	// meant "switch to slot 0" named Mienshao in the model and Lilligant -- the
	// Pokemon already on the field -- in the actual game, which cannot be
	// selected, so the agent sat on the party screen until it timed out.
	//
	// Level and max HP together identify a member unambiguously here, and both
	// are outside Gen 3's party encryption, so the order can be read directly
	// rather than assumed.
	const roster = party.slice();
	const ordered = [];
	(obs.party || []).forEach(row => {
		let best = -1;
		for (let i = 0; i < roster.length; i++) {
			if (!roster[i]) continue;
			const probe = B.createState([roster[i]], [{species: 'Rattata', level: 5,
				evs: {}, ivs: {}, moves: ['Tackle']}], {});
			const maxHP = probe.me.team[0].maxHP;
			if (roster[i].level === row.level && maxHP === row.maxhp) { best = i; break; }
		}
		if (best >= 0) { ordered.push(roster[best]); roster[best] = null; }
		else ordered.push(null);
	});
	// Anything unmatched keeps a slot so the indices still line up with the game.
	const leftovers = roster.filter(Boolean);
	const mySets = ordered.map(x => x || leftovers.shift() || party[0]);
	// WHO IS OUT, FIXED BY FINGERPRINT INSIDE ONE SNAPSHOT. This was a species
	// name lookup, and when it missed -- a mega arrives under its base name,
	// and Math.max(0, -1) quietly answers 0 -- the model believed the active
	// was whoever sat in slot 0. The planner then proposed switching to the
	// Pokemon already on the field, which the game simply refuses, and the
	// agent burned the turn on a party screen it could not leave.
	//
	// Level and max HP identify a party member unambiguously, and reading them
	// from the SAME observation that reported the active means the two cannot
	// disagree about a party order that moves during a fight -- the active is
	// swapped into slot 0 when it comes in, seen live as the 98 and the 102
	// trading places between two consecutive reads.
	let activeIndex = (obs.party || []).findIndex(r =>
		r.maxhp === obs.me.maxhp && r.hp === obs.me.hp && r.level === obs.me.level);
	if (activeIndex < 0) {
		activeIndex = (obs.party || []).findIndex(r => r.maxhp === obs.me.maxhp);
	}
	if (activeIndex < 0) {
		activeIndex = Math.max(0, mySets.findIndex(p => p.species === mineName));
	}
	if (mySets[activeIndex]) mySets[activeIndex] = setFromBattler(obs.me, mySets[activeIndex]);
	// THEIR REAL BENCH, read from gEnemyParty at 0x0202402C.
	//
	// It used to be five placeholder clones of whatever was out, because we
	// could not see their party. That single approximation caused three
	// separate problems: the model "predicted" switches to Pokemon that do not
	// exist, every opponent damage band came back empty because the band was
	// computed for a fiction, and switch prediction could never be measured at
	// all. Their party is now visible, so each slot is matched to a real set by
	// level and max HP against the trainer data -- the same way our own side is
	// resolved.
	// THEIR PARTY IS IN TRAINER-DATA ORDER, so slot i is set i. No matching
	// needed, and matching actively broke things: it paired each slot by level
	// and max HP, and our data computes Bellibolt at 133 HP where the game says
	// 125, so Bellibolt matched NOTHING and fell back to cloning whoever was
	// active. Their team came out as Pincurchin, Vikavolt, MANECTRIC 125/102,
	// Pawmot, Manectric-Mega -- Bellibolt gone, one Pokemon holding more HP
	// than its own maximum. The active index then pointed at a clone, the
	// predictor returned nothing, and the planner re-planned the same broken
	// position forever.
	// Built by the shared helper, so the planner context and this state always
	// describe the same team. NEVER HAND createState A NULL TEAM: outside a
	// known trainer battle that used to throw and kill the whole agent process,
	// which looked exactly like the emulator being stuck.
	const foeTeam = foeTeamFor(obs);
	const st = B.createState(mySets, foeTeam, {});
	// Put THEIR active where it really is, and apply what we can see of them.
	// THEIR ACTIVE, matched on the base name too. A mega arrives as its base
	// form, so RAM says "Manectric" while the set is "Manectric-Mega" -- the
	// exact match returned -1, the active index silently stayed at 0, and we
	// modelled a FAINTED Pincurchin as the Pokemon in front of us. The
	// predictor then returned nothing at all ("they will: none") and the
	// planner was pricing a position that did not exist.
	// MATCHED ON A FINGERPRINT, NOT A NAME. Species alone picks the FIRST slot
	// carrying that name, and a trainer may field two of the same Pokemon: the
	// ss1 fight has two Emolgas, the first one died, and every turn afterwards
	// the planner aimed at the corpse. pricePath opens with "is the target
	// already fainted? then this plan kills it" -- so every candidate priced
	// 0.00 at zero turns, the whole market tied, the tie broke by generation
	// order, and the winner flipped with whoever was standing. Mienshao and
	// Lanturn ping-ponged 98 -> 24 without attacking once and two Pokemon died
	// in a level-27 fight. Same disease as the Volt Switch tie, different door.
	//
	// Our own side has always been fingerprinted (max HP + level); their side
	// was never given the same treatment, and Surge's five distinct species
	// hid it. Rank the candidates: alive beats fainted, then exact HP, then
	// max HP. `obs.foeparty` is the RAM party read, which is what says who is
	// really still standing.
	const rawName = speciesName(obs.foe.species);
	const baseOf = n => String(n || '').split('-')[0];
	const nameHit = (f, exact) => f && (exact ? f.species === rawName
		: baseOf(f.species) === baseOf(rawName));
	const pickFoe = exact => {
		let bestI = -1, bestScore = -1;
		foeTeam.forEach((f, i) => {
			if (!nameHit(f, exact)) return;
			const row = (obs.foeparty || [])[i];
			// No party row for this slot is not evidence of death; an
			// unreadable party must not outrank a slot we can see is alive.
			const alive = !row || !row.maxhp || row.hp > 0;
			const score = (alive ? 4 : 0)
				+ (row && row.maxhp === obs.foe.maxhp && row.hp === obs.foe.hp ? 2 : 0)
				+ (row && row.maxhp === obs.foe.maxhp ? 1 : 0);
			if (score > bestScore) { bestScore = score; bestI = i; }
		});
		return bestI;
	};
	let activeFoe = pickFoe(true);
	if (activeFoe < 0) activeFoe = pickFoe(false);
	if (activeFoe >= 0) st.foe.active = activeFoe;
	(obs.foeparty || []).forEach((row, i) => {
		const m = st.foe.team[i];
		if (!m || !row.maxhp) return;
		m.curHP = row.hp;
		m.fainted = row.hp <= 0;
		m.status = statusOf(row.status);
	});
	st.me.active = activeIndex;
	// THE FIELD IS READ, NOT INHERITED. createState fires the entry ability of
	// whoever sits at roster index 0, and for Surge that is Pincurchin with
	// Electric Surge -- so every state the planner has ever built carried
	// Electric Terrain, at a full 8 turns, for the entire fight, long after
	// the real terrain expired and even after Pincurchin was dead. Two
	// consequences, both bad and both invisible: every Electric move (this
	// whole team is Electric) was priced 1.3x too strong, and Sleep Powder was
	// treated as failing against grounded targets, which is the path James
	// says he has taken on file. The timer is now read from RAM; when it is
	// zero the terrain is cleared outright.
	if (obs.terrainTurns !== undefined) {
		st.field.terrainTurns = obs.terrainTurns;
		if (!obs.terrainTurns) st.field.terrain = null;
	}

	// HOW LONG EACH SIDE HAS BEEN OUT, which nothing was telling the engine.
	// B.createState sets turnsOut to 0 for every member, and the live agent
	// rebuilds the state from scratch every turn, so the active always looked
	// like it had JUST ARRIVED. The engine gates Fake Out on turnsOut > 0, so
	// the move never failed and the agent spammed it -- James watched it happen.
	//
	// There is no RAM field for this, but it does not need one: the active
	// changing is the entry, so counting decisions since it last changed is
	// exact. Zero means "first action after coming in", which is when Fake Out
	// works and after which it must fail.
	const meKey = obs.me.maxhp + ':' + obs.me.species;
	outCount.me = (meKey === outCount.meKey) ? outCount.me + 1 : 0;
	outCount.meKey = meKey;
	const foeKey = obs.foe.maxhp + ':' + obs.foe.species;
	outCount.foe = (foeKey === outCount.foeKey) ? outCount.foe + 1 : 0;
	outCount.foeKey = foeKey;
	if (st.me.team[activeIndex]) st.me.team[activeIndex].turnsOut = outCount.me;
	if (st.foe.team[st.foe.active]) st.foe.team[st.foe.active].turnsOut = outCount.foe;
	// ENTRY, STATED EXPLICITLY. policy.js gates its use-it-or-lose-it entry move
	// on `justEntered`, and nothing in the codebase ever SET it -- the flag was
	// read in one place and written in none, so Fake Out was never once offered
	// on a switch-in. outCount.me is 0 exactly on the first decision after the
	// active changed, which is the turn the move works.
	if (st.me.team[activeIndex] && outCount.me === 0) {
		st.me.team[activeIndex].volatiles.justEntered = true;
	}
	// Carry the protect chain across the rebuild, so a second Detect is priced
	// as the coin flip it really is instead of a free turn.
	if (st.me.team[activeIndex] && protectRun.key === meKey && protectRun.chain > 0) {
		st.me.team[activeIndex].volatiles.protectChain = protectRun.chain;
	}

	// Apply everything observed, so the simulation starts from the real
	// position rather than a fresh one.
	// THE ACTIVE FOE, NOT SLOT ZERO. This read `st.foe.team[0]` while
	// `st.foe.active` was being resolved correctly a few lines above, so every
	// per-turn observation of the opponent -- current HP, status, confusion,
	// PP and STAT STAGES -- was written onto their FIRST Pokemon instead of
	// the one standing in front of us.
	//
	// That is why Lilligant kept clicking Baby-Doll Eyes until it died. The
	// job says "until their attack is at most -1"; the -1 landed on
	// Pincurchin's boost table, Pawmot always read at neutral attack, the
	// handover never fired, and the enabler stood there instead of switching
	// out. James described the symptom exactly: it was supposed to switch out
	// after the Baby-Doll Eyes instead of dying to Mach Punch.
	const me = st.me.team[activeIndex], foe = st.foe.team[st.foe.active];
	me.curHP = obs.me.hp; foe.curHP = obs.foe.hp;
	// A FORCED SWITCH: our Pokemon has fainted and the game is asking who comes
	// in. Setting HP to zero was not enough -- nothing marked it fainted, so
	// moves still looked legal, the planner answered with a move, and the
	// actuator could not play a move on a party screen. It re-asked, got the
	// same move, and cycled: seventeen turns of that in one interval.
	if (obs.me.hp <= 0 || obs.kind === 'forced') {
		me.curHP = 0;
		me.fainted = true;
	}
	me.status = statusOf(obs.me.status); foe.status = statusOf(obs.foe.status);
	// CONFUSION, from status2. Without it the model could not see confusion it
	// had itself applied, so Confuse Ray kept looking useful and got spammed
	// into an already-confused target.
	const confusionOf = w => (w || 0) & 0x7;
	if (confusionOf(obs.me.status2)) me.volatiles.confusion = confusionOf(obs.me.status2);
	if (confusionOf(obs.foe.status2)) foe.volatiles.confusion = confusionOf(obs.foe.status2);
	for (let i = 1; i < STAT_ORDER.length; i++) {
		me.boosts[STAT_ORDER[i]] = (obs.me.stages[i] || 6) - 6;
		foe.boosts[STAT_ORDER[i]] = (obs.foe.stages[i] || 6) - 6;
	}
	for (let i = 0; i < 4; i++) {
		if (obs.me.pp[i] !== undefined) me.pp[i] = obs.me.pp[i];
		if (obs.foe.pp[i] !== undefined) foe.pp[i] = obs.foe.pp[i];
	}
	(obs.party || []).forEach(row => {
		const m = st.me.team[row.slot];
		if (!m || row.slot === activeIndex) return;
		m.curHP = row.hp;
		m.fainted = row.hp <= 0;
		m.status = statusOf(row.status);
	});
	return st;
}

/**
 * What the opponent will do -- read from RAM, or modelled, whichever is trusted.
 *
 * THE DECISION BYTE DOES NOT GENERALISE. It was validated 32/32, but every one
 * of those labels came from Surge-side states, and this is the cross-fight
 * check that never happened. On the Lokix fight it reads "SWITCH 3" on turn
 * after turn across completely different positions -- an unchanging value is
 * not a decision, it is a leftover -- and both logged rows where it predicted a
 * switch, the opponent actually used Knock Off.
 *
 * So it is no longer trusted blindly. A reading that repeats across a changed
 * position is treated as stale, and the ported AI model answers instead. Both
 * are recorded either way, so the log measures which is right rather than
 * assuming.
 */
let lastByte = null, byteRepeats = 0;
const byteHistory = [];   // was each recent reading a switch?

function modelAction(st) {
	try {
		const scored = RRAI.scoreAll(st, 'foe', AI_FLAGS, {});
		// MOVES ONLY. Their bench is five placeholder clones of whatever is
		// out, because we cannot see their real party -- so letting the model
		// "switch" is letting it choose a Pokemon that does not exist. It was
		// doing exactly that: every opponent-side damage band came back empty,
		// costing eight usable roll observations, and a fictional switch is
		// also a prediction that can never be right.
		const moves = scored.filter(e => e.action.type === 'move');
		if (!moves.length) {
			// WHY there is no prediction, not just that there is none. Against
			// Pawmot the live agent reports "they will: none" and then plans
			// while expecting to take 0, which is how Lilligant walks into Mach
			// Punch and Mienshao is fed in behind it -- while the same call
			// offline answers Thunder Punch. Silence here is what let that run
			// for hundreds of turns.
			const foe = st.foe.team[st.foe.active];
			console.log('  [no prediction for ' + (foe && foe.set.species)
				+ ': ' + scored.length + ' actions scored, types '
				+ JSON.stringify(scored.map(e => e.action.type))
				+ ', its moves ' + JSON.stringify(foe && foe.set.moves)
				+ ', pp ' + JSON.stringify(foe && foe.pp) + ']');
			return null;
		}
		let best = -Infinity;
		moves.forEach(e => { if (e.score > best) best = e.score; });
		// TIES BREAK ON DAMAGE. Our scores are coarser than the real AI's, so
		// several moves land on the same number and the first in move order was
		// taken. Against a Victreebel at 29 HP, Thunder Punch and Ice Punch
		// both score 109 because both KO, and we answered Thunder Punch every
		// time while the game used Ice Punch -- the move that does 80 rather
		// than 39 into a Grass type. Predicting the weaker of two lethal moves
		// makes us plan around the wrong damage, so among equals, take the one
		// that hits hardest.
		const tied = moves.filter(e => e.score === best);
		if (tied.length === 1) return tied[0].action;
		let pick = tied[0], pickDmg = -1;
		for (const e of tied) {
			let d = 0;
			try {
				const r = B.damageRolls(st, 'foe', e.action.move);
				if (r && !r.immune) d = r.noCrit[Math.floor(r.noCrit.length / 2)] * (r.hits || 1);
			} catch (err) { d = 0; }
			if (d > pickDmg) { pickDmg = d; pick = e; }
		}
		return pick.action;
	} catch (e) { return null; }
}

function byteAction(obs) {
	if (obs.ai_action === 1) return {type: 'switch', index: obs.ai_target};
	const mv = moveName(obs.foe.moves[obs.ai_target]);
	if (!mv) return null;
	return {type: 'move', index: obs.ai_target, move: mv};
}

function foeAction(st, obs) {
	const sig = obs.ai_action + ':' + obs.ai_target;
	if (sig === lastByte) byteRepeats++; else { byteRepeats = 0; lastByte = sig; }
	byteHistory.push(obs.ai_action === 1);
	if (byteHistory.length > 8) byteHistory.shift();
	const fromByte = byteAction(obs);
	const fromModel = modelAction(st);
	// Two independent staleness tests, because the first one alone missed it.
	// Identical readings across changed positions is the obvious case. The one
	// that actually caught this fight is the RATE: the byte claimed a switch on
	// every single turn -- switch 2, switch 3, switch 2, switch 2 -- and no AI
	// switches every turn. A side that is always switching is a byte that is
	// not being written, whatever numbers it happens to contain.
	const switchRate = byteHistory.filter(Boolean).length / byteHistory.length;
	const alwaysSwitching = byteHistory.length >= 4 && switchRate > 0.6;
	const stale = byteRepeats >= 3 || alwaysSwitching;
	return {
		chosen: (stale || !fromByte) ? fromModel : fromByte,
		byte: fromByte, model: fromModel, stale: stale
	};
}

// The battle generator, solved: mul 0x41C64E6D, add 12345.
function advance(v) { return (Math.imul(v, 0x41C64E6D) + 12345) >>> 0; }
function draws(seed, n) {
	const out = [];
	let v = seed >>> 0;
	for (let i = 0; i < n; i++) { v = advance(v); out.push(v); }
	return out;
}

/**
 * The same deliberately-naive policy the simulation baseline uses.
 *
 * Set GREEDY=1 to play it live. The point is a like-for-like comparison: in
 * simulation this policy kills 2 of Surge's 5 in 11 of 20 episodes, 3 in seven,
 * 4 in two, and never wins. If the REAL fight yields more kills from identical
 * play, the simulated opponent is too hard and every planner number in this
 * repo is measuring the wrong fight. If it yields the same, the environment is
 * fine and our players simply are not good enough.
 *
 * It must be the same policy, not a better one, or the comparison says nothing.
 */
function greedyAction(st) {
	const legal = B.legalActions(st, 'me').filter(a => a.type === 'move');
	let best = null, bestValue = -1;
	legal.forEach(a => {
		const r = B.damageRolls(st, 'me', a.move);
		const d = r && !r.immune ? r.noCrit[8] * (r.hits || 1) : 0;
		if (d > bestValue) { bestValue = d; best = a; }
	});
	return best || B.legalActions(st, 'me')[0];
}

// The plan currently being followed, kept across turns -- see the note on
// sticking to a plan in replan.js.
let lastPlan = {foe: null, jobs: null};

// Decisions since each active last changed -- see buildState.
const outCount = {me: 0, meKey: null, foe: 0, foeKey: null};
// PROTECT DOES NOT WORK TWICE RUNNING, and a rebuilt state cannot remember
// that. The engine models it (`protectChain`), but createState zeroes every
// volatile and the agent rebuilds from RAM each turn, so live it always
// believed Detect was about to succeed -- and spammed it: Mienshao stood in
// front of a Pawmot on 22 HP playing Detect on repeat while Drain Punch healed
// it back up. Exactly the shape of the turnsOut bug, and fixed the same way:
// remember what we actually played, keyed to who was out.
const protectRun = {key: null, chain: 0};
const PROTECT_MOVES = {'Protect': 1, 'Detect': 1, 'Spiky Shield': 1, 'Baneful Bunker': 1,
	'King\'s Shield': 1, 'Obstruct': 1, 'Silk Trap': 1, 'Burning Bulwark': 1};

function decide(st, obs) {
	const src = foeAction(st, obs);
	const theirs = src.chosen;
	const legal = B.legalActions(st, 'me');
	const rows = [];
	// WHEN THEY SWITCH, WE ARE NOT HITTING WHO WE CAN SEE. Only their active
	// Pokemon is modelled -- their bench is genuinely unknown to us -- so a
	// committed switch cannot be simulated properly, and simulating it as a
	// no-op is worse than not simulating it: the first live turn had them
	// switching a 25 HP Voltorb out, and all three of our attacks scored a
	// KILL on a Pokemon that was leaving. Our move will land on whatever comes
	// in instead, and nothing here knows what that is, so no kill is claimed
	// and the damage number is a proxy rather than a prediction.
	const theySwitch = theirs && theirs.type === 'switch';
	for (const a of legal) {
		if (!theirs) break;
		let out;
		try {
			out = B.step(st, a, theirs, {mode: 'maxroll', risks: {roll: 'median'}});
		} catch (e) {
			// Swallowing this silently is how every move on a Pokemon vanished
			// from the options while the switches stayed: the planner reported
			// four switches at 0.0 and no moves at all, and nothing said why.
			if (!decide.warned) { decide.warned = {}; }
			const key = (a.move || ('switch ' + a.index)) + ': ' + e.message;
			if (!decide.warned[key]) {
				decide.warned[key] = true;
				console.log('  [dropped ' + (a.move || ('switch ' + a.index))
					+ ' -- ' + e.message + ']');
			}
			continue;
		}
		if (!out || !out.length) continue;
		const after = out[0].state;
		const myIdx = st.me.active;
		// Measured across the WHOLE side, not against the Pokemon that was
		// standing there when the turn began. On a switch turn our move lands
		// on whoever comes in, so damage read against the departing Pokemon is
		// always zero -- which made every action score identically and the
		// choice arbitrary, Detect included. Summing the side covers both the
		// stay case and the switch case without special-casing either.
		const sideLoss = (before, now) => {
			let lost = 0, cap = 0;
			for (let i = 0; i < before.team.length; i++) {
				lost += Math.max(0, before.team[i].curHP - now.team[i].curHP);
				cap += before.team[i].maxHP;
			}
			return cap ? lost / (before.team[0].maxHP || cap) : 0;
		};
		const foeDead = after.foe.team[st.foe.active].fainted;
		// OUR loss is measured across the side too, for exactly the reason
		// theirs is. Reading it against the Pokemon that started the turn made
		// SWITCHING FREE: that Pokemon is safely on the bench afterwards and
		// perfectly healthy, while the hit lands on whoever came in and never
		// appears in the score. Every switch scored 0.00, every attack scored
		// negative, and the agent switched fourteen turns in a row.
		const mineDead = after.me.team.some((m, i) =>
			m.fainted && !st.me.team[i].fainted);
		const theirLoss = sideLoss(st.foe, after.foe);
		const myLoss = sideLoss(st.me, after.me);
		const credited = foeDead && !theySwitch;

		// WHICH Pokemon died, not merely that one did. The cap on this fight is
		// exact -- beat Surge losing nobody but Lilligant -- and a flat penalty
		// says spending Mienshao is the same as spending the one Pokemon that
		// is allowed to go. The first recorded win cost three: Mienshao,
		// Lanturn and Lilligant.
		const expendable = process.env.EXPENDABLE === undefined
			? ['Lilligant'] : process.env.EXPENDABLE.split(',').filter(Boolean);
		const diedNow = after.me.team.filter((m, i) =>
			m.fainted && !st.me.team[i].fainted);
		const lostSomeoneNeeded = diedNow.some(m => !expendable.includes(m.set.species));

		// AND WHETHER WE ARE LEFT IN RANGE. Scoring only this turn means the
		// death simply happens on the next one: an action that survives at 8 HP
		// scores as a survival. Their best answer against whatever we leave
		// standing is one more evaluation, and it is the difference between
		// trading a Pokemon and keeping it.
		let dyingNext = false;
		const mineAfter = after.me.team[after.me.active];
		if (mineAfter && !mineAfter.fainted && !expendable.includes(mineAfter.set.species)) {
			let worst = 0;
			for (const id of (obs.foe.moves || [])) {
				const nm = moveName(id);
				if (!nm) continue;
				try {
					const band = B.damageRolls(after, 'foe', nm);
					if (band && band.length) worst = Math.max(worst, band[Math.floor(band.length / 2)]);
				} catch (e) { /* a move we cannot price tells us nothing */ }
			}
			dyingNext = worst >= mineAfter.curHP;
		}

		rows.push({
			action: a,
			// A SWITCH IS NOT FREE HERE EITHER. The planner was taught this and
			// the fallback was not, so on every "no plan found" turn the agent
			// rotated Pokemon into Pawmot instead of hitting it -- Lanturn,
			// Victreebel, Mienshao, Diggersby, Breloom, back to Mienshao --
			// while Pawmot healed with Drain Punch: 58, 65, 43, 56, 71. Nothing
			// in a one-turn score charges for making no progress, so a switch
			// that leaves the opponent untouched scored as a clean zero and
			// beat every attack that cost us HP.
			//
			// Small on purpose: it must not block the switches that matter,
			// where staying is scored at -61 because the Pokemon dies.
			score: (credited ? 100 : 0)
				- (mineDead ? (lostSomeoneNeeded ? 200 : 60) : 0)
				- (dyingNext ? 45 : 0)
				- (a.type === 'switch' ? 2.5 : 0)
				+ theirLoss * (theySwitch ? 4 : 10) - myLoss * 8,
			foeDead: credited, mineDead, theirLoss, myLoss,
			lostSomeoneNeeded, dyingNext,
			unknownTarget: theySwitch
		});
	}
	rows.sort((x, y) => y.score - x.score);
	// Voluntary switching is ENABLED again. It was disabled for most of the
	// night because the Shift confirmation never took, and that turned out to
	// be three separate errors in the actuator rather than anything about the
	// decision: the party screen lists the ACTIVE Pokemon first so a party
	// index is not a screen position, SCREEN_ID 9 is not the submenu, and the
	// navigation presses were landing while the screen was still fading in.
	// All three were found by screenshotting the emulator, and switching has
	// committed twenty times since.
	//
	// This matters beyond the feature: every simulation result measured while
	// it was off was measuring a crippled agent, and should not be quoted.
	return {best: rows[0], all: rows, theirs, src};
}

// A one-shot probe, so a bad position can be reproduced offline instead of
// reasoned about from a log. `node tools/agent.js --probe` rebuilds whatever is
// in state.json and prints what the planner sees.
if (process.argv[2] === '--probe') {
	// An explicit path replays an ARCHIVED turn (~/rr-agent/turns/turnNNNNN.json,
	// whose obs field is the observation); with no path it reads the live state.
	const arg = process.argv[3];
	let obs = readJSONSync(arg || STATE);
	if (obs && obs.obs) obs = obs.obs;
	if (!obs) { console.log('no state.json'); process.exit(1); }
	const st = buildState(obs);
	if (!st) { console.log('buildState returned null'); process.exit(1); }
	// TURNSOUT COMES FROM THE ARCHIVED TURN, not from a fresh rebuild. Without
	// this the probe reported entry-only moves (Fake Out, First Impression) as
	// legal on positions where the live agent had been out for several turns
	// and they were not, which is enough to make the probe recommend a move the
	// agent could never have played.
	if (obs.turnsOut !== undefined && st.me.team[st.me.active]) {
		st.me.team[st.me.active].turnsOut = obs.turnsOut;
		// The volatile has to follow, or the probe offers Fake Out on a
		// Pokemon that has been out for eight turns -- which it did, and the
		// live agent had (correctly) played Rock Tomb, so the probe was
		// contradicting reality on the exact position it was asked to explain.
		st.me.team[st.me.active].volatiles.justEntered = (obs.turnsOut || 0) === 0;
	}
	if (obs.foeTurnsOut !== undefined && st.foe.team[st.foe.active]) {
		st.foe.team[st.foe.active].turnsOut = obs.foeTurnsOut;
	}
	// RR_PROBE_PROTECT=n reproduces a live protect chain, which the archive
	// does not record: it is counted by the running agent, so a probe always
	// rebuilds the position as though Detect were fresh.
	if (process.env.RR_PROBE_PROTECT && st.me.team[st.me.active]) {
		st.me.team[st.me.active].volatiles.protectChain =
			Number(process.env.RR_PROBE_PROTECT);
	}
	const act = st.me.team[st.me.active];
	console.log('active index ' + st.me.active + ' = ' + act.set.species
		+ '  turnsOut ' + act.turnsOut
		+ '  hp ' + act.curHP + '/' + act.maxHP + '  fainted=' + act.fainted);
	console.log('its moves: ' + JSON.stringify(act.set.moves) + '  pp ' + JSON.stringify(act.pp));
	// STATUS IS PART OF THE POSITION. A paralysed Mienshao is a different
	// Pokemon from a healthy one -- half speed and a quarter of its turns lost
	// -- and a probe that hides it invites exactly the plan James caught:
	// "Mienshao kills it" priced off a Mienshao that could not move.
	console.log('team: ' + st.me.team.map((m, i) =>
		i + ':' + m.set.species + (m.fainted ? '(X)' : '') + ' ' + m.curHP
		+ (m.status ? '[' + m.status + ']' : '')).join('  '));
	console.log('THEIR team: ' + st.foe.team.map((m, i) =>
		(i === st.foe.active ? '>' : ' ') + i + ':' + m.set.species
		+ (m.fainted ? '(X)' : ' ' + m.curHP + '/' + m.maxHP)).join('  '));
	console.log('legal actions: ' + JSON.stringify(B.legalActions(st, 'me')));
	console.log('FIELD: terrain=' + (st.field.terrain || 'none')
		+ ' turns=' + (st.field.terrainTurns || 0)
		+ '  weather=' + (st.field.weather || 'none'));
	// Trip the staleness detector the way a running session does, so the probe
	// exercises the MODEL path and not just the byte path.
	let d = decide(st, obs);
	for (let i = 0; i < 6; i++) d = decide(st, obs);
	console.log('foe action used: ' + JSON.stringify(d.theirs)
		+ '  (stale=' + d.src.stale + ')');
	console.log('ranked: ' + JSON.stringify(d.all.map(r =>
		(r.action.move || ('switch ' + r.action.index)) + '=' + r.score.toFixed(2))));

	// WHY THE PLANNER SAID NOTHING. "no plan found" was the single most common
	// line in the log on the hardest positions, and the log never said which of
	// the several ways to produce it had happened.
	const C = require('./lib/candidates.js');
	const {pricePath} = require('./lib/paths.js');
	const pctx = planCtx(obs);
	const fi = st.foe.active;
	const fld = {terrain: st.field.terrain, terrainTurns: st.field.terrainTurns};
	let ideas = [];
	try { ideas = C.candidatesFor(pctx, fi, {field: fld}); }
	catch (e) { console.log('candidatesFor THREW: ' + e.message); }
	console.log('\ncandidates generated: ' + ideas.length);
	const hp = {}, dead = [], foeDead = [];
	st.me.team.forEach(m => { hp[m.set.species] = m.curHP / m.maxHP; if (m.fainted) dead.push(m.set.species); });
	st.foe.team.forEach((m, i) => { if (m.fainted) foeDead.push(i); });
	const entry = {hp, dead, foeDead, field: fld,
		active: st.me.team[st.me.active].set.species,
		turnsOut: st.me.team[st.me.active].turnsOut};
	const tally = {};
	ideas.slice(0, 25).forEach(cand => {
		if (!cand.jobs.length) { tally['empty jobs'] = (tally['empty jobs'] || 0) + 1; return; }
		if (cand.jobs.every(j => dead.includes(j.mon))) { tally['all its mons dead'] = (tally['all its mons dead'] || 0) + 1; return; }
		let r;
		try { r = pricePath(pctx, fi, cand.jobs, entry, {expendable: pctx.expendable || []}); }
		catch (e) { tally['pricePath threw: ' + e.message] = (tally['pricePath threw: ' + e.message] || 0) + 1; return; }
		const k = r.kills ? 'KILLS'
			: ('outcome=' + r.outcome + (r.outcome === 'stuck'
				? (r.blockedEntries ? ' (entry blocked: switch-in would die)'
					: ' (planAction returned nothing)') : ''));
		tally[k] = (tally[k] || 0) + 1;
	});
	console.log('what the top 25 candidates do from HERE:');
	Object.keys(tally).sort((a, b) => tally[b] - tally[a])
		.forEach(k => console.log('   ' + String(tally[k]).padStart(3) + '  ' + k));
	const R2 = require('./lib/replan.js');
	let pick = null;
	// RR_PROBE_PREV=<previous turn json> reproduces the live call, which passes
	// last turn's plan as the incumbent. Without it a probe judges every
	// position as though the agent had never had a plan before -- which is
	// exactly the thing under investigation, so it has to be reproducible.
	let probeOpts = {};
	if (process.env.RR_PROBE_PREV) {
		try {
			const prev = readJSONSync(process.env.RR_PROBE_PREV);
			if (prev && prev.planJobs) probeOpts.incumbent = prev.planJobs;
		} catch (e) { /* no incumbent, as before */ }
	}
	if (process.env.RR_PROBE_STICK) probeOpts.stick = Number(process.env.RR_PROBE_STICK);
	try { pick = R2.chooseAction(pctx, st, probeOpts); } catch (e) { console.log('chooseAction THREW: ' + e.message); }
	console.log('chooseAction -> ' + (pick
		? JSON.stringify(pick.action) + '   ' + pick.path.cand.why
		: 'NULL  (this is what prints "no plan found")'));
	process.exit(0);
}

// =====================================================================
// DIAGNOSTIC MODES (ULTRACODE-BRIEF questions 2, 3, 4).
//
// This file is a COPY of tools/agent.js so the live agent's watched source
// is not touched while a fight is paused. It exists to reuse `buildState`
// verbatim rather than duplicate it -- the recurring bug on this project is
// two parts keeping their own idea of the position. Delete it or fold the
// modes into agent.js; it must not outlive the investigation.
// =====================================================================

function diagTurnFiles(dir) {
	const out = [];
	const walk = d => {
		let ents = [];
		try { ents = fs.readdirSync(d, {withFileTypes: true}); } catch (e) { return; }
		for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) { walk(full); continue; }
			if (/^turn\d+\.json$/.test(e.name)) out.push(full);
		}
	};
	walk(dir);
	return out;
}
function diagLoad(f) {
	try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
// The probe's restorations, so a rebuilt position is the one the agent had.
function diagState(obs) {
	const st = buildState(obs);
	if (!st) return null;
	if (obs.turnsOut !== undefined && st.me.team[st.me.active]) {
		st.me.team[st.me.active].turnsOut = obs.turnsOut;
		st.me.team[st.me.active].volatiles.justEntered = (obs.turnsOut || 0) === 0;
	}
	if (obs.foeTurnsOut !== undefined && st.foe.team[st.foe.active]) {
		st.foe.team[st.foe.active].turnsOut = obs.foeTurnsOut;
	}
	return st;
}
const diagAct = a => !a ? 'none'
	: (a.type === 'switch' ? 'switch ' + a.index : a.move);

// ---------------------------------------------------------------- Q2
// Does FINALISTS = 4 discard the true here+ahead argmin?
//
// Only the four cheapest lines by `here` ever get `ahead` priced, but the
// winner is chosen on here+ahead. So: price the lookahead for EVERY shortlist
// entry and see whether the winner changes. It changes IF AND ONLY IF the true
// argmin sat outside the top four by `here` -- inside the top four, both runs
// judge the same set and must agree. That equivalence is what makes the plain
// disagreement count the answer to the question as asked.
if (process.argv[2] === '--q2') {
	const files = diagTurnFiles(process.argv[3]);
	const LIMIT = Number(process.env.Q2_LIMIT || 0) || files.length;
	let n = 0, differAction = 0, differCand = 0, gapSum = 0, fewerDead = 0,
		moreDead = 0, sameDead = 0;
	const gaps = [];
	let prev = null;
	for (const f of files.slice(0, LIMIT)) {
		const d = diagLoad(f);
		if (!d || !d.obs) { prev = d; continue; }
		const obs = d.obs;
		if (obs.kind !== 'choose') { prev = d; continue; }
		let st; try { st = diagState(obs); } catch (e) { prev = d; continue; }
		if (!st) { prev = d; continue; }
		const pctx = planCtx(obs);
		const inc = (prev && prev.planJobs) ? prev.planJobs : null;
		let a, b;
		try {
			a = R.chooseAction(pctx, st, {incumbent: inc, alternatives: true});
			b = R.chooseAction(pctx, st, {incumbent: inc, alternatives: true,
				finalists: 100000});
		} catch (e) { prev = d; continue; }
		if (!a || !b) { prev = d; continue; }
		n++;
		const aWhy = a.path && a.path.cand ? a.path.cand.why : '?';
		const bWhy = b.path && b.path.cand ? b.path.cand.why : '?';
		const sameA = diagAct(a.action) === diagAct(b.action);
		if (!sameA) differAction++;
		if (aWhy !== bWhy) {
			differCand++;
			// Both totals read off the FULLY judged run, so the comparison is
			// like for like: in run b every line carries a real `ahead`.
			const alt = b.alternatives || [];
			const bTot = alt.length ? alt[0].total : null;
			const aEntry = alt.find(x => x.why === aWhy);
			if (bTot !== null && aEntry) {
				const gap = aEntry.total - bTot;
				gapSum += gap; gaps.push(gap);
				const ad = (aEntry.dead || []).length;
				const bd = (alt[0].dead || []).length;
				if (bd < ad) fewerDead++; else if (bd > ad) moreDead++; else sameDead++;
			}
			if (differCand <= 12) {
				console.log('  turn ' + obs.turn + '  FINALISTS=4 -> ' + diagAct(a.action)
					+ ' | ' + aWhy);
				console.log('            all judged -> ' + diagAct(b.action) + ' | ' + bWhy);
			}
		}
		prev = d;
	}
	gaps.sort((x, y) => x - y);
	console.log('\nQ2  positions judged: ' + n);
	console.log('  winner CANDIDATE differs: ' + differCand + '  ('
		+ (n ? (100 * differCand / n).toFixed(1) : 0) + '%)');
	console.log('  winner ACTION differs:    ' + differAction + '  ('
		+ (n ? (100 * differAction / n).toFixed(1) : 0) + '%)');
	if (gaps.length) {
		console.log('  score gap on those turns (top4 winner total minus true argmin total):');
		console.log('    mean ' + (gapSum / gaps.length).toFixed(2)
			+ '  median ' + gaps[Math.floor(gaps.length / 2)].toFixed(2)
			+ '  max ' + gaps[gaps.length - 1].toFixed(2));
		console.log('  discarded line buries FEWER of ours: ' + fewerDead
			+ ', more: ' + moreDead + ', same: ' + sameDead);
	}
	process.exit(0);
}

// ---------------------------------------------------------------- Q3
// Size the committed-move tax. MEASURE ONLY.
//
// deathRisk is conditioned on the ONE move `committedChoice` picks, while an
// entry is charged the worst of RRAI.plausible's set. For every death in the
// archive: what did they actually click, was it in the plausible set, and what
// was the one-turn probability our active faints -- under the committed move
// versus under the worst plausible one.
//
// The probability is computed the way paths.js:252 computes deathRisk: odds
// mode, summing branch probability over branches where our active faints.
// Odds mode's faint probability is EXACT (it comes straight from the 16 rolls
// and the crit rate); it is the surviving-damage value that is a floor, and
// that is not used here.
if (process.argv[2] === '--q3') {
	const files = diagTurnFiles(process.argv[3]);
	const FLAGS = AI_FLAGS;
	const {committedChoice} = require('./lib/duels.js');
	// A SECOND SOURCE FOR WHAT THEY CLICKED, because the PP-delta method has a
	// systematic blind spot and it is exactly the interesting one: a move that
	// switches its own user out (Volt Switch, U-turn) leaves a different foe on
	// the next archived turn, so there is no PP to difference -- and those are
	// the surprise entries that do the killing. predictions.tsv records
	// `their_actual` per turn; joined on turn AND both species so a repeated
	// turn number from another session cannot match.
	const predActual = {};
	try {
		const lines = fs.readFileSync(path.join(DIR, 'predictions.tsv'), 'utf8').split('\n');
		for (const ln of lines) {
			const c = ln.split('\t');
			if (c.length < 6 || !/^\d+$/.test(c[0])) continue;
			predActual[c[0] + '|' + c[1] + '|' + c[2]] = c[5];
		}
	} catch (e) { /* no file: PP deltas only */ }
	const faintP = (st, mine, theirs) => {
		let died = 0;
		const before = st.me.team[st.me.active];
		const idx = st.me.active;
		let br;
		try { br = B.step(st, mine, theirs, {mode: 'odds', forkBudget: 4}); }
		catch (e) { return null; }
		if (!br || !br.length) return null;
		br.forEach(x => {
			const p = x.probability === undefined ? 0 : x.probability;
			if (x.state.me.team[idx] && x.state.me.team[idx].fainted && !before.fainted) died += p;
		});
		return died;
	};
	let deaths = 0, inSet = 0, notInSet = 0, noSet = 0;
	let sumCommitted = 0, sumWorst = 0, under5 = 0, under5worst = [];
	const rows = [];
	for (let i = 0; i + 1 < files.length; i++) {
		const cur = diagLoad(files[i]), nxt = diagLoad(files[i + 1]);
		if (!cur || !nxt || !cur.obs || !nxt.obs) continue;
		const o = cur.obs, o2 = nxt.obs;
		if (o.kind !== 'choose') continue;
		// A DEATH: our active was alive here and its party slot reads 0 next.
		const meRow = (o.party || []).find(r => r.maxhp === o.me.maxhp);
		const meNext = (o2.party || []).find(r => r.maxhp === o.me.maxhp);
		if (!meRow || !meNext) continue;
		if (!(meRow.hp > 0 && meNext.hp <= 0)) continue;
		// Their actual click, recovered from the PP delta -- self-contained,
		// no join against a log whose turn numbers repeat.
		let actual = null, actualSrc = 'pp';
		if (o2.foe && o.foe && o2.foe.species === o.foe.species && o2.foe.maxhp === o.foe.maxhp) {
			for (let k = 0; k < 4; k++) {
				if ((o2.foe.pp[k] || 0) < (o.foe.pp[k] || 0)) { actual = moveName(o.foe.moves[k]); break; }
			}
		}
		if (!actual) {
			const k2 = o.turn + '|' + (speciesName(o.me.species) || '') + '|'
				+ (speciesName(o.foe.species) || '');
			const v = predActual[k2];
			if (v && v !== 'n/a' && !/^fainted/.test(v)) { actual = v; actualSrc = 'log'; }
		}
		let st; try { st = diagState(o); } catch (e) { continue; }
		if (!st) continue;
		const mineNow = (function () {
			// What we actually played, as an action on this state.
			const p = cur.played || '';
			const m = /^switch (\d+)$/.exec(p);
			if (m) return {type: 'switch', index: Number(m[1])};
			const legal = B.legalActions(st, 'me').find(a => a.type === 'move' && a.move === p);
			return legal || null;
		})();
		if (!mineNow) continue;
		deaths++;
		let plausible = [];
		try { plausible = RRAI.plausible(st, 'foe').actions.filter(a => a.type === 'move'); }
		catch (e) { plausible = []; }
		if (!plausible.length) noSet++;
		else if (actual && plausible.some(a => a.move === actual)) inSet++;
		else if (actual) notInSet++;
		let committed = null;
		try {
			const sc = RRAI.scoreAll(st, 'foe', FLAGS, {});
			committed = sc.length ? committedChoice(B, sc) : null;
		} catch (e) { committed = null; }
		const pc = committed ? faintP(st, mineNow, committed) : null;
		let pw = null, worstMove = null;
		for (const a of plausible) {
			const p = faintP(st, mineNow, a);
			if (p !== null && (pw === null || p > pw)) { pw = p; worstMove = a.move; }
		}
		if (pc !== null) sumCommitted += pc;
		if (pw !== null) sumWorst += pw;
		if (pc !== null && pc <= 0.04) {
			under5++;
			if (pw !== null) under5worst.push(pw);
		}
		rows.push({turn: o.turn, us: st.me.team[st.me.active].set.species,
			them: st.foe.team[st.foe.active].set.species,
			played: cur.played, actual: actual,
			inSet: actual ? (plausible.some(a => a.move === actual) ? 'yes' : 'NO') : '?',
			src: actual ? actualSrc : '-',
			committed: committed ? diagAct(committed) : '?',
			pc: pc === null ? null : +(100 * pc).toFixed(1),
			worst: worstMove, pw: pw === null ? null : +(100 * pw).toFixed(1)});
	}
	console.log('Q3  deaths found in the archive: ' + deaths);
	console.log('  their actual move was IN RRAI.plausible: ' + inSet
		+ '   NOT in it: ' + notInSet + '   (no set computed: ' + noSet + ')');
	if (deaths) {
		console.log('  mean one-turn death probability at the position that killed us:');
		console.log('    under the COMMITTED move:      ' + (100 * sumCommitted / deaths).toFixed(1) + '%');
		console.log('    under the WORST PLAUSIBLE move:' + (100 * sumWorst / deaths).toFixed(1) + '%');
		console.log('  deaths that happened at a committed-move risk of <=4%: ' + under5
			+ (under5worst.length ? '   (their worst-plausible risk averaged '
				+ (100 * under5worst.reduce((a, b) => a + b, 0) / under5worst.length).toFixed(1) + '%)' : ''));
	}
	console.log('\n  turn   us            them          we played        they did         inSet src  committed        P(die)  worst-plausible   P(die)');
	rows.forEach(r => console.log('  ' + String(r.turn).padEnd(6)
		+ String(r.us).padEnd(14) + String(r.them).padEnd(14)
		+ String(r.played).padEnd(17) + String(r.actual).padEnd(17)
		+ String(r.inSet).padEnd(5) + String(r.src).padEnd(5) + String(r.committed).padEnd(17)
		+ String(r.pc === null ? '?' : r.pc + '%').padEnd(8)
		+ String(r.worst).padEnd(18) + (r.pw === null ? '?' : r.pw + '%')));
	process.exit(0);
}

// ---------------------------------------------------------------- Q4
// How optimistic is the lookahead about reusing one Pokemon?
//
// `continuationCost` prices each remaining opponent INDEPENDENTLY, so nothing
// stops the same healthy Pokemon being the killer in every one of those
// continuations. This replicates that loop verbatim (it is a closure inside
// chooseAction and cannot be reached from outside) and records WHO does the
// killing in each remaining opponent's cheapest line.
//
// The replica is SELF-CHECKED: the `ahead` it computes for the winning line is
// compared against the `ahead` chooseAction reports for that same line. A
// mismatch means the copy has drifted and the numbers below mean nothing, so
// the check is printed, not assumed.
if (process.argv[2] === '--q4') {
	const C = require('./lib/candidates.js');
	const {pricePath} = require('./lib/paths.js');
	const files = diagTurnFiles(process.argv[3]);
	// DEPTH IS A DIAL HERE FOR DIAGNOSIS ONLY. The live value is 5 and stays 5;
	// this exists to answer a question the flat-8 rate raises, which is whether
	// "nothing kills it from here" means there is no answer or means we stopped
	// looking after five candidates. Those are opposite problems: the first is
	// load-bearing fear, the second is fear of our own search depth.
	const LOOKAHEAD = Number(process.env.Q4_LOOKAHEAD || 5);
	const ENOUGH = 3, TEMPO = 0.4;
	const Q4LIMIT = Number(process.env.Q4_LIMIT || 0);
	let n = 0, reuse2 = 0, reuse3 = 0, flat8 = 0, priced = 0, checked = 0, checkOK = 0;
	const foundCosts = [], perOpponent = {};
	const reuseExamples = [];
	for (const f of files) {
		if (Q4LIMIT && n >= Q4LIMIT) break;
		const d = diagLoad(f);
		if (!d || !d.obs || d.obs.kind !== 'choose') continue;
		const obs = d.obs;
		let st; try { st = diagState(obs); } catch (e) { continue; }
		if (!st) continue;
		const ctx2 = planCtx(obs);
		const expendable = ctx2.expendable || [];
		const fi = st.foe.active;
		let pick;
		try { pick = R.chooseAction(ctx2, st, {alternatives: true}); } catch (e) { continue; }
		if (!pick || !pick.path || !pick.path.r || !pick.path.r.state) continue;
		const after = pick.path.r.state;
		const killedIdx = pick.path.r.kills ? fi : -1;

		// ---- continuationCost, transcribed from replan.js:266-341 ----
		const hpAfter = {}, deadAfter = [];
		after.me.team.forEach(m => {
			hpAfter[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
			if (m.fainted) deadAfter.push(m.set.species);
		});
		const foeDeadAfter = [];
		after.foe.team.forEach((m, i) => { if (m.fainted) foeDeadAfter.push(i); });
		if (killedIdx >= 0 && !foeDeadAfter.includes(killedIdx)) foeDeadAfter.push(killedIdx);
		const statusAfter = {};
		after.me.team.forEach(m => { if (m.status && !m.fainted) statusAfter[m.set.species] = m.status; });
		const foeStatusAfter = {};
		after.foe.team.forEach((m, i) => { if (m.status && !m.fainted) foeStatusAfter[i] = m.status; });
		const entryAfter = {
			hp: hpAfter, dead: deadAfter, foeDead: foeDeadAfter, status: statusAfter,
			foeStatus: foeStatusAfter,
			field: {terrain: after.field.terrain, terrainTurns: after.field.terrainTurns},
			active: after.me.team[after.me.active].set.species,
			turnsOut: after.me.team[after.me.active].turnsOut
		};
		const foeHpAfter = {};
		after.foe.team.forEach((m, i) => { if (m && m.maxHP && !m.fainted) foeHpAfter[i] = m.curHP / m.maxHP; });
		let total = 0;
		const killers = {};      // species -> [opponent names]
		let opponents = 0, notFound = 0;
		const candCache = {};
		for (let gi = 0; gi < ctx2.foeSets.length; gi++) {
			if (foeDeadAfter.includes(gi)) continue;
			opponents++;
			let cheapest = null, cheapKiller = null;
			let ahead;
			const fm = after.foe.team[gi];
			const foeHp = fm && fm.maxHP ? fm.curHP / fm.maxHP : undefined;
			const bucket = foeHp === undefined ? 10 : Math.max(1, Math.ceil(foeHp * 10));
			const key = gi + '|' + (entryAfter.field && entryAfter.field.terrainTurns > 0
				? entryAfter.field.terrain : '-') + '|' + bucket;
			try {
				if (!candCache[key]) candCache[key] = C.candidatesFor(ctx2, gi,
					{field: entryAfter.field, foeHp: bucket / 10});
				ahead = candCache[key];
			} catch (e) { continue; }
			let found = 0;
			for (const cand of ahead.slice(0, LOOKAHEAD)) {
				if (found >= ENOUGH) break;
				if (!cand.jobs.length) continue;
				if (cand.jobs.every(j => deadAfter.includes(j.mon))) continue;
				let rr;
				const eAfter = (foeHpAfter[gi] !== undefined && foeHpAfter[gi] < 1)
					? Object.assign({}, entryAfter, {foeChip: 1 - foeHpAfter[gi]})
					: entryAfter;
				try { rr = pricePath(ctx2, gi, cand.jobs, eAfter, {expendable}); }
				catch (e) { continue; }
				if (!rr.kills) continue;
				found++;
				let sp = 0;
				for (const k in rr.spend) sp += Math.max(0, rr.spend[k]);
				const bad = rr.dead.filter(x => !expendable.includes(x)).length;
				const c = sp + bad * 6 + 2 * rr.deathRisk + TEMPO * (rr.turns || 0);
				if (cheapest === null || c < cheapest) {
					cheapest = c;
					// WHO actually lands the kill, read off the priced
					// simulation's last turn rather than off the label.
					const lg = rr.log || [];
					cheapKiller = lg.length ? String(lg[lg.length - 1].we).split(' ')[0] : null;
				}
			}
			if (cheapest === null) { notFound++; total += 8; }
			else {
				total += cheapest;
				foundCosts.push(cheapest);
				priced++;
				const name = ctx2.foeSets[gi] ? ctx2.foeSets[gi].species : ('#' + gi);
				perOpponent[name] = perOpponent[name] || {found: 0, missing: 0, costs: []};
				perOpponent[name].found++;
				perOpponent[name].costs.push(cheapest);
				if (cheapKiller) (killers[cheapKiller] = killers[cheapKiller] || []).push(name);
			}
			if (cheapest === null) {
				const name = ctx2.foeSets[gi] ? ctx2.foeSets[gi].species : ('#' + gi);
				perOpponent[name] = perOpponent[name] || {found: 0, missing: 0, costs: []};
				perOpponent[name].missing++;
			}
		}
		if (!opponents) continue;
		n++;
		if (notFound) flat8 += notFound;
		// SELF-CHECK against the real closure.
		const reported = (pick.alternatives || []).find(x => x.why
			=== (pick.path.cand ? pick.path.cand.why : null));
		if (reported && reported.ahead !== null && reported.ahead !== undefined) {
			checked++;
			if (Math.abs(reported.ahead - total) < 1e-6) checkOK++;
		}
		const multi = Object.keys(killers).filter(k => killers[k].length >= 2);
		if (multi.length) {
			reuse2++;
			if (Object.keys(killers).some(k => killers[k].length >= 3)) reuse3++;
			if (reuseExamples.length < 10) reuseExamples.push('  turn ' + obs.turn + '  '
				+ multi.map(k => k + ' is the killer for ' + killers[k].join(' AND ')).join('; '));
		}
	}
	foundCosts.sort((a, b) => a - b);
	console.log('Q4  positions with a lookahead: ' + n + '   (scan depth ' + LOOKAHEAD + ')');
	console.log('  replica self-check vs chooseAction ahead: ' + checkOK + '/' + checked
		+ (checked && checkOK === checked ? '  (faithful)' : '  *** DRIFTED, numbers below are void ***'));
	console.log('  positions where ONE Pokemon is the killer for >=2 remaining opponents: '
		+ reuse2 + '  (' + (n ? (100 * reuse2 / n).toFixed(1) : 0) + '%)');
	console.log('  ... for >=3: ' + reuse3 + '  (' + (n ? (100 * reuse3 / n).toFixed(1) : 0) + '%)');
	console.log('  opponent-continuations priced: ' + priced
		+ ', flat 8 (nothing kills it from here): ' + flat8
		+ '  (' + (priced + flat8 ? (100 * flat8 / (priced + flat8)).toFixed(1) : 0) + '%)');
	if (foundCosts.length) {
		console.log('  cost when a killing line IS found: min ' + foundCosts[0].toFixed(2)
			+ '  median ' + foundCosts[Math.floor(foundCosts.length / 2)].toFixed(2)
			+ '  p90 ' + foundCosts[Math.floor(foundCosts.length * 0.9)].toFixed(2)
			+ '  max ' + foundCosts[foundCosts.length - 1].toFixed(2)
			+ '   -- the flat penalty is 8');
		const over8 = foundCosts.filter(x => x > 8).length;
		console.log('  found-lines already costing MORE than the flat 8: ' + over8
			+ '/' + foundCosts.length + '  ('
			+ (100 * over8 / foundCosts.length).toFixed(1) + '%)');
	}
	console.log('  per remaining opponent (killing line found / not found), and');
	console.log('  THE INVARIANT: is answering it dearer than the 8 charged for not answering?');
	console.log('    ' + 'opponent'.padEnd(18) + 'found'.padStart(6) + 'flat-8'.padStart(8)
		+ 'median cost'.padStart(13) + '  found lines dearer than 8');
	Object.keys(perOpponent).sort().forEach(k => {
		const cs = (perOpponent[k].costs || []).slice().sort((a, b) => a - b);
		const over = cs.filter(x => x > 8).length;
		console.log('    ' + k.padEnd(18)
			+ String(perOpponent[k].found).padStart(6)
			+ String(perOpponent[k].missing).padStart(8)
			+ (cs.length ? cs[Math.floor(cs.length / 2)].toFixed(2) : '-').padStart(13)
			+ '   ' + over + '/' + cs.length
			+ (cs.length ? '  (' + (100 * over / cs.length).toFixed(0) + '%)' : ''));
	});
	if (reuseExamples.length) {
		console.log('  examples:');
		reuseExamples.forEach(x => console.log(x));
	}
	process.exit(0);
}

// ---------------------------------------------------------------- Q5b
// `--score-live` again, but separating two things it currently mixes.
//
// 1. MISPAIRED ROWS. A truth row whose archived position has our active at 0 HP
//    is a forced-switch turn: the AI's score sheet was written about whoever
//    comes in NEXT, not about the corpse we rebuild. Those rows cannot be
//    graded and were being counted as misses.
// 2. RULE GAPS. For the rows that ARE pairable, group the residual by the
//    REASON our port fired, so a constant offset is attributed to the rule that
//    produced it instead of to the move that happened to carry it.
if (process.argv[2] === '--q5b') {
	const truthFile = path.join(DIR, 'ai_truth.tsv');
	const turnsRoot = path.join(DIR, 'turns');
	const flags = {checkBadMove: true, semiSmart: true, checkGoodMove: true};
	const byTurn = {};
	const walk = d => {
		let ents = [];
		try { ents = fs.readdirSync(d, {withFileTypes: true}); } catch (e) { return; }
		for (const e of ents) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) { walk(full); continue; }
			const m = /^turn(\d+)\.json$/.exec(e.name);
			if (m) (byTurn[Number(m[1])] = byTurn[Number(m[1])] || []).push(full);
		}
	};
	walk(turnsRoot);
	const stat = {all: {n: 0, exact: 0, argmax: 0}, live: {n: 0, exact: 0, argmax: 0}};
	const byReason = {};        // reason -> {n, sum, min, max}
	const noReason = {};        // move -> {n, sum} where we fired nothing
	const absorb = [];
	const dumped = {};
	for (const line of fs.readFileSync(truthFile, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		const f = line.split('\t');
		if (f.length < 9) continue;
		const turn = Number(f[0]), themHP = Number(f[2]), usHP = Number(f[4]);
		const tScores = f[5].split(',').map(Number);
		let obs = null;
		for (const cand of (byTurn[turn] || [])) {
			let d; try { d = JSON.parse(fs.readFileSync(cand, 'utf8')); } catch (e) { continue; }
			const o = d.obs;
			if (o && o.me && o.foe && o.me.hp === usHP && o.foe.hp === themHP) { obs = o; break; }
		}
		if (!obs) continue;
		if (process.env.RR_LIVE_FIELD_ONLY && obs.terrainTurns === undefined) continue;
		const st = diagState(obs);
		if (!st) continue;
		const foeMon = st.foe.team[st.foe.active];
		if (!foeMon || foeMon.fainted) continue;
		let scored;
		try { scored = RRAI.scoreAll(st, 'foe', flags, {}); } catch (e) { continue; }
		const bySlot = {};
		scored.forEach(e2 => {
			if (e2.action.type !== 'move') return;
			if (bySlot[e2.action.index] === undefined) bySlot[e2.action.index] = e2;
		});
		// THE PAIRABLE TEST: our active must still be standing. On a forced
		// switch the AI scored against the replacement, which this archive row
		// does not name.
		const pairable = !(obs.me.hp <= 0 || obs.kind === 'forced');
		let allEq = true;
		for (let i = 0; i < 4; i++) {
			if (tScores[i] === 0 || !bySlot[i]) continue;
			const gap = bySlot[i].score - tScores[i];
			if (gap !== 0) allEq = false;
			if (!pairable) continue;
			const mv = foeMon.set.moves[i] || ('slot' + i);
			const reasons = bySlot[i].reasons || [];
			if (!reasons.length) {
				if (gap !== 0) {
					const k = foeMon.set.species + ' ' + mv;
					noReason[k] = noReason[k] || {n: 0, sum: 0};
					noReason[k].n++; noReason[k].sum += gap;
				}
			} else reasons.forEach(rs => {
				// The rule, not the number it produced in this position.
				const rule = String(rs).replace(/^[-+]?\d+(\.\d+)?\s*/, '');
				const r = (byReason[rule] = byReason[rule] || {n: 0, sum: 0, zero: 0,
					min: Infinity, max: -Infinity});
				r.n++; r.sum += gap;
				if (gap === 0) r.zero++;
				if (gap < r.min) r.min = gap;
				if (gap > r.max) r.max = gap;
			});
			if (process.env.RR_Q5_MOVE && mv === process.env.RR_Q5_MOVE && gap !== 0
				&& (dumped[mv] = (dumped[mv] || 0) + 1) <= 14) {
				const me2 = st.me.team[st.me.active];
				console.log('  t' + String(turn).padEnd(6) + mv.padEnd(15)
					+ 'vs ' + (me2.set.species + ' ' + me2.curHP + '/' + me2.maxHP).padEnd(20)
					+ 'foe ' + (foeMon.set.species + ' ' + foeMon.curHP + '/' + foeMon.maxHP).padEnd(24)
					+ 'ours ' + String(bySlot[i].score).padEnd(5) + 'truth ' + String(tScores[i]).padEnd(5)
					+ 'gap ' + String(gap).padEnd(5) + JSON.stringify(reasons));
			}
			if (/Volt Absorb/.test(reasons.join(' '))) {
				const me = st.me.team[st.me.active];
				absorb.push({turn, move: mv, gap, meSp: me.set.species,
					meHP: me.curHP, meMax: me.maxHP, ours: bySlot[i].score, truth: tScores[i]});
			}
		}
		let bt = -Infinity, bo = -Infinity;
		tScores.forEach(v => { if (v > bt) bt = v; });
		Object.keys(bySlot).forEach(i => { if (bySlot[i].score > bo) bo = bySlot[i].score; });
		const tSet = tScores.map((v, i) => v === bt ? i : -1).filter(i => i >= 0);
		const oSet = Object.keys(bySlot).filter(i => bySlot[i].score === bo).map(Number);
		const amOK = tSet.length === oSet.length && tSet.every(i => oSet.indexOf(i) >= 0);
		stat.all.n++; if (allEq) stat.all.exact++; if (amOK) stat.all.argmax++;
		if (pairable) { stat.live.n++; if (allEq) stat.live.exact++; if (amOK) stat.live.argmax++; }
	}
	const pc = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
	console.log('Q5b  graded rows, ALL (what --score-live reports today): ' + stat.all.n
		+ '   exact ' + pc(stat.all.exact, stat.all.n)
		+ '   argmax ' + pc(stat.all.argmax, stat.all.n));
	console.log('     rows where our active is STILL STANDING (pairable):  ' + stat.live.n
		+ '   exact ' + pc(stat.live.exact, stat.live.n)
		+ '   argmax ' + pc(stat.live.argmax, stat.live.n));
	console.log('     unpairable forced-switch rows counted as misses: '
		+ (stat.all.n - stat.live.n));
	console.log('\n  residual by the RULE our port fired (pairable rows only):');
	console.log('    ' + 'rule'.padEnd(46) + 'fired  exact   mean gap   min   max');
	Object.keys(byReason).sort((a, b) => Math.abs(byReason[b].sum) - Math.abs(byReason[a].sum))
		.slice(0, 20).forEach(k => {
			const r = byReason[k];
			console.log('    ' + k.slice(0, 45).padEnd(46)
				+ String(r.n).padStart(5) + String(pc(r.zero, r.n)).padStart(7)
				+ (r.sum / r.n).toFixed(2).padStart(11)
				+ String(r.min).padStart(6) + String(r.max).padStart(6));
		});
	console.log('\n  moves where our port fired NO rule and still disagreed:');
	Object.keys(noReason).sort((a, b) => noReason[b].n - noReason[a].n).slice(0, 10)
		.forEach(k => console.log('    ' + k.padEnd(34) + 'x' + String(noReason[k].n).padStart(4)
			+ '   mean gap ' + (noReason[k].sum / noReason[k].n).toFixed(2)));
	if (absorb.length) {
		const byHP = {full: {n: 0, sum: 0}, hurt: {n: 0, sum: 0}};
		absorb.forEach(a => {
			const b = a.meHP >= a.meMax ? byHP.full : byHP.hurt;
			b.n++; b.sum += a.gap;
		});
		console.log('\n  every row where we fired the Volt Absorb penalty: ' + absorb.length);
		console.log('    our absorber at FULL hp: ' + byHP.full.n + ' rows, mean gap '
			+ (byHP.full.n ? (byHP.full.sum / byHP.full.n).toFixed(2) : '-'));
		console.log('    our absorber DAMAGED:    ' + byHP.hurt.n + ' rows, mean gap '
			+ (byHP.hurt.n ? (byHP.hurt.sum / byHP.hurt.n).toFixed(2) : '-'));
		const exactly20 = absorb.filter(a => a.gap === -20).length;
		const wouldFix = absorb.filter(a => a.gap + 20 === 0).length;
		console.log('    rows where dropping the -20 would make us EXACT: ' + wouldFix
			+ '/' + absorb.length);
		console.log('    first 15 rows:');
		absorb.slice(0, 15).forEach(a => console.log('      t' + String(a.turn).padEnd(6)
			+ String(a.move).padEnd(16) + 'vs ' + a.meSp + ' ' + a.meHP + '/' + a.meMax
			+ '   ours ' + a.ours + '  truth ' + a.truth + '  gap ' + a.gap));
	}
	process.exit(0);
}

// ---------------------------------------------------------------- Q4b
// IS THE FLAT 8 A FACT ABOUT THE FIGHT, OR ABOUT OUR SCAN DEPTH?
//
// `continuationCost` prices the top LOOKAHEAD=5 candidates for each remaining
// opponent and charges a flat 8 when none of them kills. Measured at depth 5,
// that 8 fires on 40.9% of continuations, and on 91% of Manectric-Mega's and
// 65% of Pawmot's -- the two that do the killing. A constant is identical for
// every candidate, so it cancels out of the comparison and steers nothing.
//
// Two completely different things produce that 8, and they want opposite fixes:
//
//   ARTIFACT  a killing line exists but sits below rank 5, so we never priced
//             it. The fear is manufactured by our own cut-off.
//   REAL      no candidate kills it from here at all. The fear is load-bearing
//             and must stay.
//
// NOTE: the repo's claim that a graded arm "was tried live and nearly wiped" is
// NOT supported. That arm is ee478e7 on the unmerged branch `lookahead-graded`,
// its own message begins "PARKED, UNVALIDATED", and exactly one of 151
// results.tsv rows carries it -- a WIN. The claim first appears in the doc
// rewrite d758f8d two days later. The INVARIANT it states is still sound, but it
// is derivable from arithmetic, not from that experiment.
//
// So scan EVERY candidate once and record the rank at which the first killing
// line appears. One pass answers the question for every possible depth, which
// three separate sweeps would not, and it also prices what the lines below the
// cut actually cost -- if they come in near the median found cost of 1.38 then
// the 8 charged in their place was pure fiction.
//
// Also decomposes the within-turn spread of `ahead`: how much of the difference
// between competing plans is a smooth difference in cost, and how much is one
// plan tipping an opponent across the found/not-found boundary. That boundary
// is a ~6.6 point step in a market whose whole spread is about 1.2.
if (process.argv[2] === '--q4b') {
	const C = require('./lib/candidates.js');
	const {pricePath} = require('./lib/paths.js');
	const files = diagTurnFiles(process.argv[3]);
	const LIVE_DEPTH = 5, ENOUGH = 3, TEMPO = 0.4;
	const CAP = Number(process.env.Q4B_CAP || 40);      // candidates scanned per opponent
	const LIMIT = Number(process.env.Q4B_LIMIT || 60);  // positions
	const per = {};      // species -> counters
	const rankHist = {}; // species -> rank of first killing line -> count
	const deepCosts = {};// species -> costs of killing lines found BELOW the cut
	const shallowCosts = {};
	let positions = 0, spreadSame = 0, spreadStep = 0;
	let sumSpreadSame = 0, sumSpreadStep = 0;
	for (const f of files) {
		if (positions >= LIMIT) break;
		const d = diagLoad(f);
		if (!d || !d.obs || d.obs.kind !== 'choose') continue;
		const obs = d.obs;
		let st; try { st = diagState(obs); } catch (e) { continue; }
		if (!st) continue;
		const ctx2 = planCtx(obs);
		const expendable = ctx2.expendable || [];
		let pick;
		try { pick = R.chooseAction(ctx2, st, {alternatives: true}); } catch (e) { continue; }
		if (!pick || !pick.path || !pick.path.r || !pick.path.r.state) continue;
		const after = pick.path.r.state;
		const killedIdx = pick.path.r.kills ? st.foe.active : -1;
		const hpAfter = {}, deadAfter = [];
		after.me.team.forEach(m => {
			hpAfter[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
			if (m.fainted) deadAfter.push(m.set.species);
		});
		const foeDeadAfter = [];
		after.foe.team.forEach((m, i) => { if (m.fainted) foeDeadAfter.push(i); });
		if (killedIdx >= 0 && !foeDeadAfter.includes(killedIdx)) foeDeadAfter.push(killedIdx);
		const statusAfter = {}, foeStatusAfter = {};
		after.me.team.forEach(m => { if (m.status && !m.fainted) statusAfter[m.set.species] = m.status; });
		after.foe.team.forEach((m, i) => { if (m.status && !m.fainted) foeStatusAfter[i] = m.status; });
		const entryAfter = {
			hp: hpAfter, dead: deadAfter, foeDead: foeDeadAfter, status: statusAfter,
			foeStatus: foeStatusAfter,
			field: {terrain: after.field.terrain, terrainTurns: after.field.terrainTurns},
			active: after.me.team[after.me.active].set.species,
			turnsOut: after.me.team[after.me.active].turnsOut
		};
		let any = false;
		for (let gi = 0; gi < ctx2.foeSets.length; gi++) {
			if (foeDeadAfter.includes(gi)) continue;
			const name = ctx2.foeSets[gi] ? ctx2.foeSets[gi].species : ('#' + gi);
			const row = (per[name] = per[name] || {shallow: 0, deep: 0, none: 0, scanned: 0});
			const fm = after.foe.team[gi];
			const foeHp = fm && fm.maxHP ? fm.curHP / fm.maxHP : undefined;
			const bucket = foeHp === undefined ? 10 : Math.max(1, Math.ceil(foeHp * 10));
			let ideas;
			try {
				ideas = C.candidatesFor(ctx2, gi, {field: entryAfter.field, foeHp: bucket / 10});
			} catch (e) { continue; }
			const eAfter = (foeHp !== undefined && foeHp < 1)
				? Object.assign({}, entryAfter, {foeChip: 1 - foeHp}) : entryAfter;
			let firstKillRank = -1, shallowBest = null, deepBest = null, found = 0;
			const scan = ideas.slice(0, CAP);
			for (let k = 0; k < scan.length; k++) {
				const cand = scan[k];
				if (!cand.jobs.length) continue;
				if (cand.jobs.every(j => deadAfter.includes(j.mon))) continue;
				let rr;
				try { rr = pricePath(ctx2, gi, cand.jobs, eAfter, {expendable}); }
				catch (e) { continue; }
				if (!rr.kills) continue;
				if (firstKillRank < 0) firstKillRank = k;
				let sp = 0;
				for (const kk in rr.spend) sp += Math.max(0, rr.spend[kk]);
				const bad = rr.dead.filter(x => !expendable.includes(x)).length;
				const c = sp + bad * 6 + 2 * rr.deathRisk + TEMPO * (rr.turns || 0);
				// Inside the live cut, with the live early-stop, exactly as
				// continuationCost would have seen it.
				if (k < LIVE_DEPTH && found < ENOUGH) {
					if (shallowBest === null || c < shallowBest) shallowBest = c;
					found++;
				}
				if (deepBest === null || c < deepBest) deepBest = c;
			}
			row.scanned++;
			any = true;
			const rh = (rankHist[name] = rankHist[name] || {});
			if (firstKillRank >= 0) rh[firstKillRank] = (rh[firstKillRank] || 0) + 1;
			if (shallowBest !== null) {
				row.shallow++;
				(shallowCosts[name] = shallowCosts[name] || []).push(shallowBest);
			} else if (deepBest !== null) {
				row.deep++;   // THE ARTIFACT: charged 8, but a killer existed
				(deepCosts[name] = deepCosts[name] || []).push(deepBest);
			} else {
				row.none++;   // genuinely nothing kills it from here
			}
		}
		if (any) positions++;
		// How much of the spread between competing plans is a STEP across the
		// found/not-found line rather than a difference in price.
		const alts = (pick.alternatives || []).filter(a => a.ahead !== null && a.ahead !== undefined);
		if (alts.length >= 2) {
			let lo = Infinity, hi = -Infinity;
			alts.forEach(a => { if (a.ahead < lo) lo = a.ahead; if (a.ahead > hi) hi = a.ahead; });
			// A gap of at least most of one flat 8 between the cheapest and
			// dearest continuation is a boundary flip, not a pricing difference.
			if (hi - lo >= 6) { spreadStep++; sumSpreadStep += (hi - lo); }
			else { spreadSame++; sumSpreadSame += (hi - lo); }
		}
	}
	const stats = arr => {
		if (!arr || !arr.length) return 'n/a';
		const s = arr.slice().sort((a, b) => a - b);
		return 'n=' + s.length + ' median ' + s[Math.floor(s.length / 2)].toFixed(2)
			+ ' p90 ' + s[Math.floor(s.length * 0.9)].toFixed(2)
			+ ' max ' + s[s.length - 1].toFixed(2);
	};
	console.log('Q4b  positions ' + positions + ', every candidate scanned up to rank ' + CAP
		+ ' (live cut is ' + LIVE_DEPTH + ')');
	console.log('');
	console.log('  per remaining opponent, why the continuation cost what it did:');
	console.log('    ' + 'opponent'.padEnd(18) + 'answered'.padStart(9)
		+ 'ARTIFACT'.padStart(10) + 'no answer'.padStart(11) + '   artifact share of the flat 8');
	let A = 0, D = 0, Z = 0;
	Object.keys(per).sort().forEach(k => {
		const r = per[k]; A += r.shallow; D += r.deep; Z += r.none;
		const flat = r.deep + r.none;
		console.log('    ' + k.padEnd(18) + String(r.shallow).padStart(9)
			+ String(r.deep).padStart(10) + String(r.none).padStart(11)
			+ '   ' + (flat ? (100 * r.deep / flat).toFixed(0) + '%' : '-'));
	});
	console.log('    ' + 'TOTAL'.padEnd(18) + String(A).padStart(9) + String(D).padStart(10)
		+ String(Z).padStart(11) + '   ' + ((D + Z) ? (100 * D / (D + Z)).toFixed(0) + '%' : '-'));
	console.log('');
	console.log('  what the lines BELOW the cut actually cost (charged 8 instead):');
	Object.keys(deepCosts).sort().forEach(k => console.log('    ' + k.padEnd(18) + stats(deepCosts[k])));
	console.log('  what the lines above the cut cost, for comparison:');
	Object.keys(shallowCosts).sort().forEach(k => console.log('    ' + k.padEnd(18) + stats(shallowCosts[k])));
	console.log('');
	console.log('  rank at which the FIRST killing line appears:');
	Object.keys(rankHist).sort().forEach(k => {
		const rh = rankHist[k];
		const ks = Object.keys(rh).map(Number).sort((a, b) => a - b);
		const tot = ks.reduce((a, b) => a + rh[b], 0);
		let cum = 0, med = null, p90 = null;
		ks.forEach(r => { cum += rh[r]; if (med === null && cum >= tot / 2) med = r;
			if (p90 === null && cum >= tot * 0.9) p90 = r; });
		console.log('    ' + k.padEnd(18) + 'n=' + String(tot).padStart(4)
			+ '  median rank ' + String(med).padStart(3)
			+ '  p90 ' + String(p90).padStart(3)
			+ '  within top 5: ' + (100 * ks.filter(r => r < 5).reduce((a, b) => a + rh[b], 0) / tot).toFixed(0) + '%');
	});
	console.log('');
	console.log('  spread of `ahead` between competing plans on the same turn:');
	console.log('    turns where it is a smooth difference (<6): ' + spreadSame
		+ ', mean spread ' + (spreadSame ? (sumSpreadSame / spreadSame).toFixed(2) : '-'));
	console.log('    turns where it STEPS across the boundary (>=6): ' + spreadStep
		+ ', mean spread ' + (spreadStep ? (sumSpreadStep / spreadStep).toFixed(2) : '-'));
	process.exit(0);
}

// ---------------------------------------------------------------- Q7
// THE LOGGED SWITCH MARGIN IS COMPUTED ON A CRITERION THE PLANNER REJECTS.
//
// replan.js records `stay = {score: item.here ...}` and reports
// `margin: stay.score - item.here` -- IMMEDIATE COST ONLY -- while the winner is
// chosen on `here + ahead`, and `ahead` is roughly three times the size of
// `here`. Commit 5656cd1's headline switch figures come from that number, so
// they measure how close the alternatives were on a yardstick the planner had
// already discarded.
//
// This recomputes it properly. `alternatives` already carries each line's
// opening action together with here, ahead and total, so the margin between
// "the best line that switches" and "the best line that does not" can be read
// on BOTH criteria from the same call, and the two compared directly.
//
// It also counts how often the best line on either side was never judged at all
// (outside FINALISTS, so it carries no `ahead`), because a margin computed
// against an unjudged line is not a margin at all.
if (process.argv[2] === '--q7') {
	const files = diagTurnFiles(process.argv[3]);
	const LIMIT = Number(process.env.Q7_LIMIT || 0);
	let n = 0, switched = 0, unjudged = 0, flipped = 0;
	const hereMargins = [], totalMargins = [];
	let prev = null;
	for (const f of files) {
		if (LIMIT && n >= LIMIT) break;
		const d = diagLoad(f);
		if (!d || !d.obs || d.obs.kind !== 'choose') { prev = d; continue; }
		const obs = d.obs;
		let st; try { st = diagState(obs); } catch (e) { prev = d; continue; }
		if (!st) { prev = d; continue; }
		let pick;
		try {
			pick = R.chooseAction(planCtx(obs), st, {
				incumbent: (prev && prev.planJobs) ? prev.planJobs : null,
				alternatives: true});
		} catch (e) { prev = d; continue; }
		prev = d;
		if (!pick || !pick.alternatives || pick.alternatives.length < 2) continue;
		const alts = pick.alternatives;
		const isSw = a => a.action && a.action.type === 'switch';
		const sw = alts.filter(isSw), stay = alts.filter(a => !isSw(a));
		if (!sw.length || !stay.length) continue;
		n++;
		const byHere = arr => arr.reduce((a, b) => a.here <= b.here ? a : b);
		const tot = a => a.here + (a.ahead === null || a.ahead === undefined ? 0 : a.ahead);
		const byTotal = arr => arr.reduce((a, b) => tot(a) <= tot(b) ? a : b);
		const swH = byHere(sw), stH = byHere(stay);
		const swT = byTotal(sw), stT = byTotal(stay);
		if (swT.ahead === null || swT.ahead === undefined
			|| stT.ahead === null || stT.ahead === undefined) unjudged++;
		// Positive = staying is dearer, i.e. the switch is justified by that much.
		const mH = stH.here - swH.here;
		const mT = tot(stT) - tot(swT);
		hereMargins.push(mH); totalMargins.push(mT);
		// The verdict that actually matters: does the criterion change WHICH
		// side wins? That is a switch the log calls justified and the planner's
		// own criterion does not, or the reverse.
		if ((mH > 0) !== (mT > 0)) flipped++;
		if (pick.action && pick.action.type === 'switch') switched++;
	}
	const stats = arr => {
		if (!arr.length) return 'n/a';
		const s = arr.slice().sort((a, b) => a - b);
		const mean = s.reduce((a, b) => a + b, 0) / s.length;
		return 'median ' + s[Math.floor(s.length / 2)].toFixed(2)
			+ '  mean ' + mean.toFixed(2)
			+ '  |margin|<1: ' + (100 * s.filter(x => Math.abs(x) < 1).length / s.length).toFixed(0) + '%'
			+ '  |margin|<0.5: ' + (100 * s.filter(x => Math.abs(x) < 0.5).length / s.length).toFixed(0) + '%';
	};
	console.log('Q7  turns with both a switching and a staying line priced: ' + n);
	console.log('    of those, the planner switched: ' + switched
		+ '  (' + (n ? (100 * switched / n).toFixed(0) : 0) + '%)');
	console.log('');
	console.log('  margin between the best staying line and the best switching line');
	console.log('  (positive = staying is dearer, so the switch is justified by that much):');
	console.log('    on `here` alone, WHICH IS WHAT THE LOG RECORDS:');
	console.log('      ' + stats(hereMargins));
	console.log('    on `here + ahead`, WHICH IS WHAT THE PLANNER DECIDES ON:');
	console.log('      ' + stats(totalMargins));
	console.log('');
	console.log('  turns where the two criteria disagree about which SIDE is better: '
		+ flipped + '  (' + (n ? (100 * flipped / n).toFixed(0) : 0) + '%)');
	console.log('  turns where the best line on one side was never judged (outside FINALISTS): '
		+ unjudged + '  (' + (n ? (100 * unjudged / n).toFixed(0) : 0) + '%)');
	process.exit(0);
}

// SCORE-BY-SCORE GRADING AGAINST CORRECTLY-PAIRED TRUTH.
//
// `--score-live` joins ai_truth.tsv (the AI's real score sheet, written when
// a turn RESOLVES and therefore paired with the position the node actually
// asked about) against that turn's archived observation, recomputes our four
// scores, and reports the per-move point gaps.
//
// This exists because the dump-based corpus is MISPAIRED and its numbers
// cannot be trusted. The EWRAM dumps are taken 45 frames after we commit, so
// the position in gBattleMons is not necessarily the one the AI scored
// against; the same matchup (Bellibolt vs our Volt Absorb Lanturn at 139)
// reads 102 for Parabolic Charge in a dump and 80 -- the correct -20 absorb
// penalty, which our model already applies -- in the live log. Every gap
// table built on the dumps inherits that error.
//
// Rows are matched on turn number AND both HP values, so a turn counter that
// restarts across sessions cannot silently pair the wrong battle.
if (process.argv[2] === '--score-live') {
	const truthFile = process.argv[3] || path.join(DIR, 'ai_truth.tsv');
	const turnsRoot = process.argv[4] || path.join(DIR, 'turns');
	const flags = {checkBadMove: true, semiSmart: true, checkGoodMove: true};
	// Index every archived observation by turn number.
	const byTurn = {};
	const walk = d => {
		let ents = [];
		try { ents = fs.readdirSync(d, {withFileTypes: true}); } catch (e) { return; }
		for (const e of ents) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) { walk(full); continue; }
			const m = /^turn(\d+)\.json$/.exec(e.name);
			if (!m) continue;
			(byTurn[Number(m[1])] = byTurn[Number(m[1])] || []).push(full);
		}
	};
	walk(turnsRoot);
	const gaps = {}, perMon = {};
	let rows = 0, paired = 0, exact = 0, argmaxOK = 0;
	for (const line of fs.readFileSync(truthFile, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		const f = line.split('\t');
		if (f.length < 9) continue;
		rows++;
		const turn = Number(f[0]), themHP = Number(f[2]), usHP = Number(f[4]);
		const tScores = f[5].split(',').map(Number);
		let obs = null;
		for (const cand of (byTurn[turn] || [])) {
			let d;
			try { d = JSON.parse(fs.readFileSync(cand, 'utf8')); } catch (e) { continue; }
			const o = d.obs;
			if (o && o.me && o.foe && o.me.hp === usHP && o.foe.hp === themHP) { obs = o; break; }
		}
		if (!obs) continue;
		// RR_LIVE_FIELD_ONLY grades only positions we can rebuild FAITHFULLY.
		// Archives written before the terrain read carry no terrainTurns, so
		// they rebuild with the phantom Electric Terrain that createState
		// inherits from Pincurchin -- which inflates every Electric move by
		// 1.3x and can flip which move we call strongest. Scoring against them
		// measures our own stale reconstruction, not the port.
		if (process.env.RR_LIVE_FIELD_ONLY && obs.terrainTurns === undefined) continue;
		const st = buildState(obs);
		if (!st) continue;
		const foeMon = st.foe.team[st.foe.active];
		if (!foeMon || foeMon.fainted) continue;
		if (obs.turnsOut !== undefined && st.me.team[st.me.active]) {
			st.me.team[st.me.active].turnsOut = obs.turnsOut;
			st.me.team[st.me.active].volatiles.justEntered = (obs.turnsOut || 0) === 0;
		}
		if (obs.foeTurnsOut !== undefined && foeMon) foeMon.turnsOut = obs.foeTurnsOut;
		let scored;
		try { scored = RRAI.scoreAll(st, 'foe', flags, {}); }
		catch (e) { continue; }
		paired++;
		const bySlot = {};
		scored.forEach(e2 => {
			if (e2.action.type !== 'move') return;
			if (bySlot[e2.action.index] === undefined) bySlot[e2.action.index] = e2;
		});
		const sp = foeMon.set.species;
		const row = (perMon[sp] = perMon[sp] || {n: 0, exact: 0, slots: 0, hit: 0});
		row.n++;
		let allEq = true;
		for (let i = 0; i < 4; i++) {
			if (tScores[i] === 0 || !bySlot[i]) continue;   // 0 = unusable upstream
			row.slots++;
			const gap = bySlot[i].score - tScores[i];
			if (gap === 0) { row.hit++; continue; }
			allEq = false;
			const mv = foeMon.set.moves[i] || ('slot' + i);
			const k = sp + ' ' + mv + ' ' + (gap > 0 ? '+' : '') + gap;
			gaps[k] = (gaps[k] || 0) + 1;
			if (process.env.RR_LIVE_DETAIL === mv && gaps[k] <= 2) {
				console.log('--- ' + k + '  turn ' + turn + '  truth ' + tScores.join(',')
					+ '  we ' + st.me.team[st.me.active].set.species + ' ' + usHP
					+ '  foe ' + sp + ' ' + themHP);
				console.log('    ours: ' + bySlot[i].score + ' ' + JSON.stringify(bySlot[i].reasons));
			}
		}
		if (allEq) { exact++; row.exact++; }
		let bt = -Infinity, bo = -Infinity;
		tScores.forEach(v => { if (v > bt) bt = v; });
		Object.keys(bySlot).forEach(i => { if (bySlot[i].score > bo) bo = bySlot[i].score; });
		const tSet = tScores.map((v, i) => v === bt ? i : -1).filter(i => i >= 0);
		const oSet = Object.keys(bySlot).filter(i => bySlot[i].score === bo).map(Number);
		if (tSet.length === oSet.length && tSet.every(i => oSet.indexOf(i) >= 0)) argmaxOK++;
	}
	console.log('truth rows ' + rows + ', paired to an archived position ' + paired);
	if (!paired) { console.log('nothing paired -- is the turn archive present?'); process.exit(0); }
	console.log('all-four-exact ' + exact + ' (' + Math.round(100 * exact / paired)
		+ '%)   identical-argmax-set ' + argmaxOK + ' (' + Math.round(100 * argmaxOK / paired) + '%)');
	console.log('\nper-mon (exact turns / per-slot agreement):');
	Object.keys(perMon).sort().forEach(sp => {
		const r = perMon[sp];
		console.log('  ' + sp.padEnd(16) + ' turns ' + String(r.n).padStart(4)
			+ '  exact ' + String(Math.round(100 * r.exact / r.n)).padStart(3) + '%'
			+ '  slots ' + String(Math.round(100 * r.hit / Math.max(1, r.slots))).padStart(3) + '%');
	});
	console.log('\nper-move gaps (ours minus truth):');
	Object.keys(gaps).sort((a, b) => gaps[b] - gaps[a]).slice(0, 18)
		.forEach(k => console.log('  x' + String(gaps[k]).padStart(4) + '  ' + k));
	process.exit(0);
}

// SCORE-BY-SCORE GRADING. `--score-diff <dir>` walks cases synthesized from
// the EWRAM dumps -- each carries the full position AND the AI's true four
// scores read from the thinking struct -- computes our four scores for the
// same position, and reports the per-move point gaps clustered by move and
// direction. This is the porting accelerator the RAM read buys: a miss names
// the exact rule-sized number it is missing, not just a different argmax.
if (process.argv[2] === '--score-diff') {
	const dir = process.argv[3];
	const flags = {checkBadMove: true, semiSmart: true, checkGoodMove: true};
	const gaps = {};   // "<species> <move>: ours-vs-truth" -> {count, sumGap}
	let turns = 0, exact = 0, argmaxOK = 0;
	for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
		let c;
		try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
		catch (e) { continue; }
		const st = buildState(c.obs);
		if (!st) continue;
		const foeMon = st.foe.team[st.foe.active];
		if (!foeMon || foeMon.fainted) continue;
		let scored;
		try { scored = RRAI.scoreAll(st, 'foe', flags, {}); }
		catch (e) { continue; }
		const bySlot = {};
		scored.forEach(e2 => {
			if (e2.action.type !== 'move') return;
			if (bySlot[e2.action.index] === undefined) bySlot[e2.action.index] = e2;
		});
		turns++;
		let allEq = true;
		const tScores = c.truth.scores;
		const usable = i => tScores[i] !== 0;   // 0 = move unusable upstream
		for (let i = 0; i < 4; i++) {
			if (!usable(i) || !bySlot[i]) continue;
			const gap = bySlot[i].score - tScores[i];
			if (gap !== 0) {
				allEq = false;
				const mv = foeMon.set.moves[i] || ('slot' + i);
				const k = foeMon.set.species + ' ' + mv + ' ' + (gap > 0 ? '+' : '') + gap;
				gaps[k] = (gaps[k] || 0) + 1;
				if (process.env.RR_DIFF_DETAIL === mv && gaps[k] <= 2) {
					console.log('--- ' + k + '  (' + f + ')  truth ' + tScores.join(',')
						+ '  we ' + st.me.team[st.me.active].set.species
						+ ' ' + st.me.team[st.me.active].curHP);
					console.log('    our reasons: ' + JSON.stringify(bySlot[i].reasons));
				}
			}
		}
		if (allEq) exact++;
		let bt = -Infinity, bo = -Infinity;
		tScores.forEach(v => { if (v > bt) bt = v; });
		Object.keys(bySlot).forEach(i => { if (bySlot[i].score > bo) bo = bySlot[i].score; });
		const tSet = tScores.map((v, i) => v === bt ? i : -1).filter(i => i >= 0);
		const oSet = Object.keys(bySlot).filter(i => bySlot[i].score === bo).map(Number);
		if (tSet.length === oSet.length && tSet.every(i => oSet.indexOf(i) >= 0)) argmaxOK++;
	}
	console.log('turns ' + turns + '  all-four-scores-exact ' + exact
		+ ' (' + Math.round(100 * exact / turns) + '%)  identical-argmax-set ' + argmaxOK
		+ ' (' + Math.round(100 * argmaxOK / turns) + '%)');
	console.log('\nper-move gaps (ours minus truth), by frequency:');
	Object.keys(gaps).sort((a, b) => gaps[b] - gaps[a]).slice(0, 20)
		.forEach(k => console.log('  x' + String(gaps[k]).padStart(4) + '  ' + k));
	process.exit(0);
}

// THE PORT'S SCOREBOARD. `node tools/agent.js --score-port <turns-dir>` walks
// an archive session and scores the AI model against what the opponent
// ACTUALLY did, recovered from its PP deltas between consecutive turns --
// self-contained ground truth, no joins against logs whose turn numbers
// repeat across sessions. Three properties make this the honest measure:
//
//   - "Correct" means the real move is IN THE COMPUTED ARGMAX SET. The AI
//     picks uniformly among ties (ai_master.c:360), so calling a coin flip
//     "wrong" when we named both faces would punish the port for the game's
//     own randomness.
//   - Every flag combination is scored separately. Which combination scores
//     best PER TRAINER is evidence of that trainer's real aiFlags -- ROM data
//     we otherwise do not have. Computed, not predicted.
//   - It reuses the live buildState, so it sees exactly what the agent sees.
if (process.argv[2] === '--score-port') {
	const dir = process.argv[3];
	const files = fs.readdirSync(dir).filter(f => /^turn\d+\.json$/.test(f)).sort();
	const flagSets = {
		'basic          ': {checkBadMove: true},
		'basic+semi     ': {checkBadMove: true, semiSmart: true},
		'basic+good     ': {checkBadMove: true, checkGoodMove: true},
		'basic+semi+good': {checkBadMove: true, semiSmart: true, checkGoodMove: true}
	};
	const norm = m => (m || '').startsWith('Hidden Power') ? 'Hidden Power' : m;
	const tally = {};   // flagSet -> species -> {hit, n}
	const misses = {};  // "species: actual not in [set]" -> count
	let prev = null;
	for (const f of files) {
		let cur;
		try { cur = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
		catch (e) { continue; }
		const o = cur.obs;
		if (prev) {
			const po = prev.obs;
			const sameFoe = po.foe && o.foe && po.foe.species === o.foe.species
				&& po.foe.maxhp === o.foe.maxhp && o.turn === po.turn + 1;
			if (sameFoe) {
				let actual = null;
				for (let i = 0; i < 4; i++) {
					if ((o.foe.pp[i] || 0) < (po.foe.pp[i] || 0)) {
						actual = moveName(po.foe.moves[i]); break;
					}
				}
				if (actual) {
					const st = buildState(po);
					if (st && !st.foe.team[st.foe.active].fainted) {
						if (po.turnsOut !== undefined && st.me.team[st.me.active]) {
							st.me.team[st.me.active].turnsOut = po.turnsOut;
						}
						if (po.foeTurnsOut !== undefined && st.foe.team[st.foe.active]) {
							st.foe.team[st.foe.active].turnsOut = po.foeTurnsOut;
						}
						const species = st.foe.team[st.foe.active].set.species;
						for (const fsName in flagSets) {
							let scored;
							const nts = {};
							try { scored = RRAI.scoreAll(st, 'foe', flagSets[fsName], nts); }
							catch (e) { continue; }
							const movesOnly = scored.filter(e2 => e2.action.type === 'move');
							if (!movesOnly.length) continue;
							let best = -Infinity;
							movesOnly.forEach(e2 => { if (e2.score > best) best = e2.score; });
							const set = movesOnly.filter(e2 => e2.score === best)
								.map(e2 => norm(e2.action.move));
							// EXPECTED accuracy under the AI's own uniform tie
							// break: a hit inside a k-way tie is worth 1/k.
							// Plain set-membership scored the do-nothing model
							// at 100% -- every move ties at base, the set is
							// everything, and the metric rewards knowing
							// nothing.
							const uniq = set.filter((m, i2) => set.indexOf(m) === i2);
							const t = (tally[fsName] = tally[fsName] || {});
							const row = (t[species] = t[species] || {hit: 0, ev: 0, n: 0});
							row.n++;
							if (uniq.indexOf(norm(actual)) >= 0) {
								row.hit++;
								row.ev += 1 / uniq.length;
							}
							if (set.indexOf(norm(actual)) < 0 && fsName === 'basic+semi+good') {
								const k = species + ': did ' + norm(actual) + ', argmax [' + set.join(',') + ']';
								misses[k] = (misses[k] || 0) + 1;
								// RR_SCORE_DEBUG=Roost dumps the full scored
								// market for the first few misses of that move,
								// so a gate that refuses to fire can be READ.
								if (process.env.RR_SCORE_DEBUG === norm(actual)
									&& (misses[k] === 1 || misses[k] === 2)) {
									console.log('--- miss detail ' + f + ' (foe hp '
										+ po.foe.hp + '/' + po.foe.maxhp + ', we '
										+ st.me.team[st.me.active].set.species + ' '
										+ st.me.team[st.me.active].curHP + ')');
									scored.forEach(e3 => console.log('   ',
										e3.score, e3.action.move || ('switch ' + e3.action.index),
										JSON.stringify(e3.reasons)));
									console.log('    notes:', JSON.stringify(nts));
								}
							}
						}
					}
				}
			}
		}
		prev = cur;
	}
	for (const fsName in tally) {
		const t = tally[fsName];
		let H = 0, N = 0, EV = 0;
		const per = Object.keys(t).map(sp => {
			H += t[sp].hit; N += t[sp].n; EV += t[sp].ev;
			return sp + ' ' + Math.round(100 * t[sp].ev / t[sp].n) + '%';
		}).join('  ');
		console.log(fsName + '  expected ' + (N ? Math.round(100 * EV / N) : 0)
			+ '%  (in-set ' + (N ? Math.round(100 * H / N) : 0) + '%)   ' + per);
	}
	console.log('\ntop misses under basic+semi+good:');
	Object.keys(misses).sort((a, b) => misses[b] - misses[a]).slice(0, 12)
		.forEach(k => console.log('  x' + String(misses[k]).padStart(3) + '  ' + k));
	process.exit(0);
}

// ------------------------------------------------------------------- the loop
// A THROW ON ONE TURN MUST NOT END THE RUN. The agent died mid-session on a
// position it could not build, and the emulator went on asking a planner that
// was no longer there -- which reads exactly like the game being stuck.
process.on('uncaughtException', function (e) {
	console.log('[uncaught, continuing] ' + (e && e.stack || e));
});
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, {recursive: true});
// Tag every recorded result with the code that produced it. Rows from
// different code versions were indistinguishable in results.tsv, so a change
// to the planner could not be judged against the rows it actually produced.
let VERSION = '?';
try {
	const cp = require('child_process');
	const hash = cp.execSync('git rev-parse --short HEAD', {cwd: __dirname}).toString().trim();
	const dirty = cp.execSync('git status --porcelain', {cwd: __dirname}).toString().trim() ? '+' : '';
	VERSION = hash + dirty;
	// The experiment arm rides in the version stamp, so results.tsv records
	// which behaviour produced each episode instead of it living in my head.
	fs.writeFileSync(path.join(DIR, 'version.txt'),
		VERSION + (process.env.RR_NO_DEATH_VETO ? '+noveto' : '') + '\n');
} catch (e) { /* not fatal: the row just reads "?" */ }

// THE AGENT MUST NOTICE ITS OWN CODE IS STALE.
//
// This is a long-running process: editing a file under tools/ changes nothing
// until it is restarted, and there is no way to tell from the log which code
// produced a turn. Hours went into a fix that was never running, and results
// were read as if it were. Now the source files it actually loaded are
// fingerprinted at startup, checked every turn, and a change is announced on
// every decision AND stamped into version.txt -- so the results row the Lua
// writes carries "-STALE" and cannot be quoted as evidence for the new code.
const WATCHED = ['tools/agent.js', 'tools/lib/replan.js', 'tools/lib/candidates.js',
	'tools/lib/paths.js', 'tools/lib/policy.js', 'tools/lib/duels.js',
	'tools/lib/harness.js', 'tools/lib/enablers.js',
	'upstream-calc/src/js/rr-battle.js', 'upstream-calc/src/js/rr-ai.js'];
const repoRoot = path.join(__dirname, '..');
function sourceStamp() {
	return WATCHED.map(rel => {
		try { return rel + ':' + fs.statSync(path.join(repoRoot, rel)).mtimeMs; }
		catch (e) { return rel + ':?'; }
	}).join('|');
}
const STAMP_AT_START = sourceStamp();
let staleAnnounced = false, staleShown = false;
function checkStale() {
	if (sourceStamp() === STAMP_AT_START) return false;
	if (!staleAnnounced) {
		staleAnnounced = true;
		try { fs.writeFileSync(path.join(DIR, 'version.txt'), VERSION + '-STALE\n'); }
		catch (e) { /* nothing to do */ }
	}
	return true;
}
// The header is rewritten whenever the schema changes, not only when the file
// is absent. Columns were added twice tonight and the header was not, so rows
// carried twenty fields under an eighteen-field header -- every parse silently
// dropped the last two, which is why forty-four opponent bands read as zero.
const PRED_HEADER = 'turn\tus\tthem\tour_action\ttheir_predicted\t'
	+ 'their_actual\tpredictor_ok\tbyte_said\tmodel_said\tbyte_stale\t'
	+ 'pred_our_dmg\tpred_their_dmg\tactual_our_dmg\tactual_their_dmg\t'
	+ 'rng_before\tdraws\trolls\tcrit_rolls\tfoe_rolls\tfoe_crit\t'
	+ 'foe_status_after\tme_status_after\tai_menu\tai_movelist\tai_committed\tai_resolving\tai_late\tai_t150\tai_t220\tai_t320\tresolving_raw\n';
if (fs.existsSync(PRED)) {
	const first = fs.readFileSync(PRED, 'utf8').split('\n')[0] + '\n';
	if (first !== PRED_HEADER) {
		const body = fs.readFileSync(PRED, 'utf8').split('\n').slice(1).join('\n');
		fs.writeFileSync(PRED, PRED_HEADER + body);
	}
}
if (!fs.existsSync(PRED)) {
	fs.writeFileSync(PRED, 'turn\tus\tthem\tour_action\ttheir_predicted\t'
		+ 'their_actual\tpredictor_ok\tbyte_said\tmodel_said\tbyte_stale\t'
		+ 'pred_our_dmg\tpred_their_dmg\tactual_our_dmg\tactual_their_dmg\t'
		+ 'rng_before\tdraws\trolls\tcrit_rolls\tfoe_rolls\tfoe_crit\t'
	+ 'foe_status_after\tme_status_after\tai_menu\tai_movelist\tai_committed\tai_resolving\tai_late\tai_t150\tai_t220\tai_t320\tresolving_raw\n');
}

let lastTurn = 0, awaiting = null;
console.log('agent: watching ' + DIR + '. Load tools/lua/agent.lua in mGBA.');

function readJSONSync(p) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function readJSON(p) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/**
 * Is this question already answered?
 *
 * Keying on the turn number alone was wrong. A hot reload restarts the
 * counter, so a genuinely new question arrives labelled "turn 1", the planner
 * sees a number it has already answered, and both halves wait forever. What
 * actually decides it is whether an answer for THIS question is sitting on
 * disk: the agent deletes the command file whenever it asks, so a missing or
 * stale command file means the question is open, whatever it is numbered.
 */
function alreadyAnswered(obs) {
	const cmd = readJSON(CMD);
	return !!(cmd && cmd.turn === obs.turn);
}

// Is somebody actually at the panel? It stamps this file on every poll. The
// answer decides whether the agent is allowed to wait for a person: an
// unattended run must never sit on a question nobody is going to answer, and
// closing the tab is the natural way to say "just play".
function panelLive() {
	try { return Date.now() - fs.statSync(PANEL).mtimeMs < 5000; }
	catch (e) { return false; }
}

// A question is about a POSITION, not a turn number: the Lua expires an unanswered
// question after 60 seconds and re-asks the same position under a new id, so
// keying the pending choice on the turn would throw it away every minute.
function positionKey(obs) {
	return [obs.kind, obs.me.species, obs.me.hp, obs.foe.species, obs.foe.hp].join('/');
}

// The open sacrifice question, and the standing answer to it.
//
// A plan that means to spend Lilligant on Pawmot says so again on every turn
// until it happens, so asking per turn is a nag, not a check. What gets
// answered is really "against this opponent, who am I willing to lose", so the
// answer is kept as the accepted CASUALTY SET and honoured until the opponent
// changes or that outcome stops being available.
//
// Storing the outcome rather than the move matters twice over. The position
// moves every turn, so replaying a stored ACTION would replay a decision about
// a board that no longer exists. And the option list shrinks as a sacrifice is
// carried out -- three outcomes become two -- so anything keyed on the shape of
// the question would ask again halfway through the plan it just approved.
//
// It also holds the line the other way: answer "lose nobody" and every later
// turn quietly takes the no-loss line again, instead of re-proposing the
// sacrifice that was just refused.
let pendingAsk = null, standingAnswer = null, pauseShown = false;
// How long a sacrifice question waits for a person before the agent answers it
// itself. Long enough to walk back to the desk, short enough that a panel left
// open on another screen does not silently halt an episode.
const ASK_TIMEOUT = Number(process.env.RR_ASK_TIMEOUT || 300) * 1000;
const deathKey = list => list.slice().sort().join(',');

// THE LINE THE HUMAN IS CURRENTLY ASKING ABOUT, held for the duel rather than
// for the turn. A line like "sleep it, then bring Diggersby in" is a SEQUENCE;
// evaluating it only on the turn it was typed would price the first leg and
// never watch the rest happen, which is precisely the part he wants checked.
// It is dropped when the opponent changes, because a line is advice about an
// opponent and means nothing against the next one.
let userLine = null;

/** Say what the market did with his line, in the terms he asked it in. */
function verdictText(v, winner) {
	if (!v) return 'no verdict (the planner produced nothing this turn)';
	const money = n => (n === null || n === undefined) ? '?' : n.toFixed(2);
	const who = list => list && list.length ? list.join(', ') : 'nobody';
	if (!v.priced) {
		return 'YOUR LINE WAS NEVER PRICED -- ' + v.dropped
			+ (v.already ? ' (it was on the table as "' + v.already + '")'
				: ' (and the generator never proposed it)');
	}
	const lines = [];
	lines.push('your line: total ' + money(v.total) + ' (this kill ' + money(v.here)
		+ ' + rest of the fight ' + money(v.ahead) + ')'
		+ ', ' + (v.kills ? 'kills it' : 'does not kill it (' + v.outcome + ')')
		+ ' in ' + v.turns + ' turns, loses ' + who(v.dead)
		+ ', death risk ' + Math.round(100 * (v.deathRisk || 0)) + '%');
	lines.push('it ranked ' + v.rank + ' of ' + v.ofPriced + ' priced lines'
		+ (v.already ? ' and was already on the table as "' + v.already + '"'
			: ' and the generator had NOT proposed it'));
	if (winner) {
		lines.push('the planner chose: total ' + money(winner.total)
			+ ' (' + money(winner.here) + ' + ' + money(winner.ahead) + '), loses '
			+ who(winner.dead) + ' -- ' + winner.why);
	}
	if (v.won) {
		lines.push('=> YOUR LINE WON. It is being played.');
	} else if (winner && v.total !== null && v.total < winner.total - 1e-9) {
		// The interesting failure. Only the cheapest few lines ever get their
		// lookahead priced, so a line can be cheaper on the full criterion and
		// still lose because it never entered the round where that criterion is
		// applied. That is a defect in the cut, not a disagreement about value.
		lines.push('=> YOUR LINE PRICES CHEAPER by ' + money(winner.total - v.total)
			+ ' AND STILL LOST'
			+ (v.judged ? '.' : ' -- it was outside the top ' + (v.ofPriced < 4 ? v.ofPriced : 4)
				+ ' on immediate cost, so its lookahead was never priced when the'
				+ ' winner was picked. The cut threw away the better line.'));
	} else if (winner && v.total !== null) {
		lines.push('=> the planner prices your line ' + money(v.total - winner.total)
			+ ' more expensive.');
	}
	return lines.join('\n     ');
}

function clearAsk() {
	pendingAsk = null;
	try { fs.unlinkSync(ASK); } catch (e) { /* already gone */ }
	try { fs.unlinkSync(CHOICE); } catch (e) { /* already gone */ }
}

setInterval(() => {
	// RESULTS ARE COLLECTED FIRST, unconditionally. This used to run only when
	// the current question was already answered, which is a window of a few
	// hundred milliseconds between a turn resolving and the next one being
	// asked -- so thirteen resolved turns produced two rows. The prediction log
	// is the entire point of these calibration runs; losing most of it to a
	// polling race makes the runs worthless.
	{
		const res = readJSON(RESULT);
		if (awaiting && res && res.turn === awaiting.turn) {
				// A different Pokemon is standing there now, so the HP
				// difference is meaningless -- it compares two Pokemon. The
				// first live turn logged our damage as MINUS SIX because
				// Voltorb died and something with more HP replaced it. What we
				// actually learn from a kill is a lower bound: at least the
				// HP it had left.
				// WHAT THEY ACTUALLY DID, not what we read they would do.
				// The decision byte at 0x02000091 was validated on Surge-side
				// states only, and this log already suggests it is wrong
				// elsewhere: every row predicting a switch shows their species
				// unchanged afterwards. Comparing their PP before and after
				// names the move they really used, which turns the whole
				// calibration run into a fidelity test of the predictor rather
				// than an assumption resting on one fight.
				const foeSwapped = res.foe.species !== awaiting.foeSpecies;
				let theirActual = 'unknown';
				if (foeSwapped) {
					// A different Pokemon is out, but that has two causes and
					// they are not the same event. If our hit was lethal they
					// FAINTED; otherwise they chose to leave. Conflating them
					// credited the predictor for switches that were really
					// deaths we caused.
					theirActual = (awaiting.predOur >= awaiting.foeHP)
						? 'fainted+replaced' : 'switched';
				} else {
					for (let i = 0; i < 4; i++) {
						if (res.foe.pp[i] < awaiting.foePP[i]) {
							theirActual = moveName(awaiting.foeMoves[i]) || ('slot ' + i);
							break;
						}
					}
					if (theirActual === 'unknown') theirActual = 'no move used';
				}
				const predictorOK = awaiting.theirAction === theirActual ? 'yes'
					: (awaiting.theirAction.startsWith('switch')
						&& theirActual === 'switched') ? 'yes'
					: (theirActual === 'fainted+replaced') ? 'n/a' : 'NO';
				const meSwapped = res.me.species !== awaiting.meSpecies;
				const ourDmg = foeSwapped ? awaiting.foeHP : awaiting.foeHP - res.foe.hp;
				const theirDmg = meSwapped ? awaiting.myHP : awaiting.myHP - res.me.hp;
				fs.appendFileSync(PRED, [awaiting.turn, awaiting.us, awaiting.them,
					awaiting.ourAction, awaiting.theirAction,
					theirActual, predictorOK,
					awaiting.byteSays, awaiting.modelSays, awaiting.stale ? 'stale' : '',
					awaiting.predOur, awaiting.predTheir,
					(foeSwapped ? '>=' : '') + ourDmg,
					(meSwapped ? '>=' : '') + theirDmg,
					awaiting.rng, awaiting.draws.join(','),
					awaiting.rolls.join(','), awaiting.critRolls,
					awaiting.foeRolls.join(';'), awaiting.foeCrit,
					statusOf(res.foe.status) || '', statusOf(res.me.status) || '',
					// The decision bytes as they read at four points in the
					// turn. One of these should match what they actually did at
					// the rate the Surge labels did; the log will say which.
					sampleName(res, 'menu'), sampleName(res, 'movelist'),
					sampleName(res, 'committed'), sampleName(res, 'resolving'),
					sampleName(res, 'late'), sampleName(res, 't150'),
					sampleName(res, 't220'), sampleName(res, 't320'),
					// The raw action/target pair, for the score-array hunt: the
					// SLOT is what an argmax has to match, not the move name.
					((res.ai_samples && res.ai_samples.resolving) || '')
					].join('\t') + '\n');
				// THE AI'S TRUE SCORE SHEET, one row per resolved turn. The
				// thinking struct at 0x020003A4 was located by signature scan
				// and verified 737/737; the Lua reads it at the same 45-frame
				// mark as the proven decision byte, and this file is what the
				// port is graded against from now on: not "did the argmax
				// match" but "is every one of the four scores equal", rule by
				// rule. srng is the AI's pre-drawn randomness -- the tie-break
				// and coin-flip bytes, the last non-computed part of its mind.
				if (res.ai_think && res.ai_think.scores) {
					try {
						fs.appendFileSync(path.join(DIR, 'ai_truth.tsv'), [
							awaiting.turn, awaiting.them, awaiting.foeHP,
							awaiting.us, awaiting.myHP,
							res.ai_think.scores.join(','),
							res.ai_think.considered, res.ai_think.flags,
							res.ai_think.srng.join(','),
							((res.ai_samples && res.ai_samples.resolving) || '')
						].join('\t') + '\n');
					} catch (e) { /* truth logging must never break play */ }
				}
				const ok = (d, p, part) => part ? 'at least ' + d
					: (d === p ? 'exact' : 'off by ' + (d - p));
				console.log('  turn ' + awaiting.turn + ' resolved: our damage '
					+ ourDmg + ' (' + ok(ourDmg, awaiting.predOur, foeSwapped)
					+ '), theirs ' + theirDmg + ' ('
					+ ok(theirDmg, awaiting.predTheir, meSwapped) + ')');
			awaiting = null;
		}
	}

	const obs = readJSON(STATE);
	if (!obs) return;
	// STOP MEANS STOP, AND IT STOPS HERE. The one place where stopping is
	// clean is before an answer is written: the emulator is sitting on the
	// move menu waiting, which is where it would sit anyway between turns.
	// Killing the process or unloading the script mid-sequence leaves it
	// halfway through a party screen. Resuming is just deleting the file, and
	// the question is still open, so nothing is lost by pausing for an hour.
	if (fs.existsSync(PAUSE)) {
		if (!pauseShown) { pauseShown = true; console.log('\n[STOPPED by the panel; the question is held open. Resume from the panel.]'); }
		if (pendingAsk) clearAsk();
		return;
	}
	if (pauseShown) { pauseShown = false; console.log('\n[resumed]'); }
	if (alreadyAnswered(obs)) return;
	// A SACRIFICE ALREADY PUT TO THE HUMAN. Nothing is planned again while the
	// question stands, or the options under the answer would be re-priced out
	// from under it -- the shortlist scores move between adjacent turns, which
	// is exactly why the choice is stored as the concrete action it opens with.
	let chosenByHand = null;
	if (pendingAsk) {
		// A LINE TYPED WHILE THE QUESTION IS OPEN REOPENS THE QUESTION. Being
		// asked "who should die" is exactly the moment for "why not this
		// instead", and holding the old options while refusing to read the
		// answer would be the least useful possible time to stop listening.
		// The line goes into the market, so it comes back as one of the
		// options on the next pass.
		if (fs.existsSync(LINE)) {
			console.log('  [new line typed; re-opening the question with it priced in]');
			clearAsk();
		} else if (pendingAsk.key !== positionKey(obs)) clearAsk();
		else {
			const ch = readJSON(CHOICE);
			if (ch && pendingAsk.options[ch.index]) {
				chosenByHand = pendingAsk.options[ch.index];
				standingAnswer = {foe: pendingAsk.foe, accept: deathKey(chosenByHand.dead)};
				clearAsk();
			} else if (!panelLive() || Date.now() - pendingAsk.asked > ASK_TIMEOUT) {
				// Nobody is answering. Either the tab was closed, or it is open
				// on a screen nobody is looking at -- which is the ordinary
				// case, since the panel gets left up while its owner does
				// something else entirely. An open tab is evidence of intent to
				// supervise, not a promise to be present, and treating it as a
				// promise turns a forgotten tab into a frozen run.
				//
				// Taking the plan's own answer is the pre-panel behaviour
				// exactly, and it stands so the run does not stall again next
				// turn. The question is recorded as unanswered either way.
				console.log('  [' + (panelLive()
					? 'no answer in ' + Math.round(ASK_TIMEOUT / 1000) + 's'
					: 'panel closed with the question open')
					+ '; playing the plan, which loses '
					+ (deathKey(pendingAsk.options[0].dead) || 'nobody') + ']');
				standingAnswer = {foe: pendingAsk.foe,
					accept: deathKey(pendingAsk.options[0].dead)};
				clearAsk();
			} else {
				// Restamp so the panel shows the live turn while it waits.
				try {
					const a = readJSON(ASK) || {};
					a.turn = obs.turn;
					fs.writeFileSync(ASK, JSON.stringify(a));
				} catch (e) { /* the panel re-reads next poll */ }
				return;
			}
		}
	}
	lastTurn = obs.turn;

	const st = buildState(obs);
	if (!st) { console.log('turn ' + obs.turn + ': could not identify the position'); return; }
	// THE PLANNER DRIVES. Every turn it re-prices the ways to kill the Pokemon
	// in front of us FROM THE CURRENT POSITION -- who can do it, what it costs,
	// what has to happen first -- and plays the first move of the cheapest line
	// that stays inside the cap. Next turn it asks again from wherever the dice
	// put us, which is the whole point: a fixed script cannot notice that the
	// position has drifted, and three separate experiments showed static plans
	// dying because of exactly that.
	//
	// Until now this was scaffolding: a one-turn scorer with no lookahead and no
	// plan at all. It played reasonable-looking moves for local reasons and had
	// no notion of reserving a Pokemon for a job or of what the fight needs
	// three turns from now.
	let d = null, plannerSaid = null;
	if (!process.env.GREEDY && !process.env.NOPLAN) {
		try {
			// The line we were already following, so it can defend itself against
		// this turn's challengers instead of being re-derived from nothing.
		const foeNow = st.foe.team[st.foe.active].set.species;
		// A NEWLY TYPED LINE, read against the team as it actually is so the
		// error message can name the real moves rather than a guess at them.
		const typed = readJSON(LINE);
		if (typed) {
			try { fs.unlinkSync(LINE); } catch (e) { /* read once */ }
			const text = String(typed.text || '').trim();
			if (!text) {
				userLine = null;
				try { fs.unlinkSync(LINE_RESULT); } catch (e) { /* nothing to clear */ }
				console.log('  [line cleared]');
			} else {
				const parsed = UL.parseLine(st.me.team, text);
				if (parsed.error) {
					userLine = null;
					fs.writeFileSync(LINE_RESULT, JSON.stringify({text: text,
						error: parsed.error}));
					console.log('  [your line could not be read: ' + parsed.error + ']');
				} else {
					userLine = {foe: foeNow, text: text, jobs: parsed.jobs,
						reading: parsed.reading};
					console.log('  [your line: ' + text + '  ->  priced as: '
						+ parsed.reading + ']');
				}
			}
		}
		// A line is advice about an OPPONENT, so it expires with that opponent.
		if (userLine && userLine.foe !== foeNow) {
			console.log('  [your line was about ' + userLine.foe + '; ' + foeNow
				+ ' is out now, so it no longer applies]');
			userLine = null;
			try { fs.unlinkSync(LINE_RESULT); } catch (e) { /* nothing to clear */ }
		}
		const pick = R.chooseAction(planCtx(obs), st,
			{incumbent: lastPlan.foe === foeNow ? lastPlan.jobs : null,
				alternatives: panelLive(),
				userLine: userLine ? userLine.jobs : null});
		if (userLine && pick) {
			const w = pick.path ? {
				total: pick.path.here + (pick.path.ahead || 0),
				here: pick.path.here, ahead: pick.path.ahead || 0,
				why: pick.path.cand.why,
				dead: (pick.path.r && pick.path.r.dead) || []
			} : null;
			const text = verdictText(pick.userLine, w);
			console.log('  [YOUR LINE] ' + text);
			fs.writeFileSync(LINE_RESULT, JSON.stringify({
				text: userLine.text, reading: userLine.reading,
				foe: foeNow, turn: obs.turn, verdict: pick.userLine,
				winner: w, summary: text
			}));
			// APPEND-ONLY, with the position attached. A verdict that only
			// exists on screen cannot be re-examined later, and the whole
			// reason for asking is to be able to come back to it.
			try {
				fs.appendFileSync(LINES_LOG, JSON.stringify({
					at: new Date().toISOString(), turn: obs.turn, session: SESSION,
					text: userLine.text, reading: userLine.reading, jobs: userLine.jobs,
					us: obs.me.species, usHP: obs.me.hp, foe: foeNow, foeHP: obs.foe.hp,
					verdict: pick.userLine, winner: w
				}) + '\n');
			} catch (e) { /* recording must never break play */ }
		}
		if (pick && pick.path && pick.path.cand) {
			lastPlan = {foe: foeNow, jobs: pick.path.cand.jobs};
		}
			if (pick && pick.action) {
				plannerSaid = pick;
				// THE PLAN STILL HAS TO SURVIVE THE TURN. This branch used to
				// build its answer with `all: []` and `theirs: null`, so on a
				// planned turn nothing was ever predicted -- which is why the
				// log read "they will: none" and "expecting to deal 0 and take
				// 0" against Pawmot, and why the plan happily walked Lilligant
				// into Mach Punch. Probing that exact position offline, the
				// one-turn scoring ranked every move at -61.39 because
				// Lilligant dies, and switching at -2.45. It knew. Nobody asked.
				const oneTurn = decide(st, obs);
				let chosen = pick.action;
				const same = (a, b) => a && b && a.type === b.type
					&& (a.type === 'switch' ? a.index === b.index : a.move === b.move);
				const mine = oneTurn.all.find(r => same(r.action, chosen));
				// RR_NO_DEATH_VETO turns this override off for A/B measurement.
				// The veto is an EXTERNAL reflex over an internal market, which
				// is the pattern James has objected to twice, and it overrules
				// the planner's deathRisk -- computed against the whole
				// plausible move set with real crit odds -- using one-turn
				// scoring, the cruder of the two models. It also predates the
				// status, boost, terrain and pivot-damage fixes, so the pricing
				// it distrusts is not the pricing it was written against.
				if (mine && mine.mineDead && !mine.foeDead
					&& !process.env.RR_NO_DEATH_VETO) {
					// It dies this turn and does not take the opponent with it.
					// A plan is a sequence, so losing the Pokemon it depends on
					// costs the rest of the plan, not just this turn.
					const alt = oneTurn.all.find(r => !r.mineDead);
					if (alt && !same(alt.action, chosen)) {
						console.log('  [plan would lose '
							+ st.me.team[st.me.active].set.species
							+ ' this turn; taking '
							+ (alt.action.move || ('switch ' + alt.action.index))
							+ ' instead]');
						chosen = alt.action;
						// THE PLAN STILL EXISTED. Nulling this made the log
						// print "no plan found", so an override by this veto
						// was indistinguishable from the planner having
						// nothing to say -- and that false signal sent hours
						// of investigation after a planner that was working
						// fine, with offline probes of the very turns
						// cheerfully producing the plan the log denied. The
						// plan is kept and the override is stated instead.
						plannerSaid = Object.assign({}, pick, {overridden: true});
					}
				}
				d = {best: {action: chosen, foeDead: false, mineDead: false,
					theirLoss: 0, myLoss: 0, unknownTarget: false},
					all: oneTurn.all, theirs: oneTurn.theirs, src: oneTurn.src};
			}
		} catch (e) {
			console.log('  [planner failed: ' + e.message + ']');
		}
	}
	if (!d && process.env.GREEDY && obs.kind !== 'forced') {
		const a = greedyAction(st);
		d = {best: {action: a, foeDead: false, mineDead: false, theirLoss: 0, myLoss: 0,
			unknownTarget: false}, all: [], theirs: null,
			src: {byte: null, model: null, stale: false}};
	} else if (!d) {
		d = decide(st, obs);
	}
	if (!d || !d.best) { console.log('turn ' + obs.turn + ': no legal action found'); return; }
	if (obs.kind === 'forced' && d.best.action.type !== 'switch') {
		// Belt and braces: on a party screen the only executable answer is a
		// switch. Anything else is unplayable and would cycle.
		const sw = d.all.find(r => r.action.type === 'switch');
		if (sw) d.best = sw;
		else { console.log('turn ' + obs.turn + ': forced switch with nobody to send'); return; }
	}

	// WHO DIES IS THE HUMAN'S CALL, when a human is there to make it.
	//
	// The planner is willing to spend a Pokemon, and it prices what that costs,
	// but it prices every non-forbidden death at the same flat rate -- which is
	// how Lilligant, the only real answer to Pawmot, gets spent on something
	// else and the fight is lost three turns before it looks lost. Rather than
	// guess a better price (that is a decision James has reserved), the agent
	// stops and asks, on the one class of turn where the mistake is
	// unrecoverable, and only while somebody is watching the panel.
	//
	// The options are lines the market itself produced, one per distinct
	// outcome, so the answer is a choice between plans and not a hand-drawn
	// move: whatever comes back is played as the planner would have played it.
	if (chosenByHand) {
		d.best.action = chosenByHand.action;
		console.log('  [YOU CHOSE: ' + chosenByHand.why
			+ (chosenByHand.dead.length
				? ' -- losing ' + chosenByHand.dead.join(', ') : ' -- losing nobody') + ']');
	} else if (panelLive() && plannerSaid && plannerSaid.path && plannerSaid.path.r
		&& (plannerSaid.path.r.dead || []).length
		&& (plannerSaid.alternatives || []).length) {
		const foeName = speciesName(obs.foe.species);
		// ONE ROW PER OUTCOME. Six lines that all bury Lilligant are one choice
		// wearing six hats; what makes this a check is seeing that the
		// alternative buries somebody else, or nobody.
		const seen = {}, options = [];
		plannerSaid.alternatives.forEach(alt => {
			const k = deathKey(alt.dead);
			if (seen[k] || options.length >= 5) return;
			seen[k] = true;
			options.push({action: alt.action, why: alt.why,
				dead: alt.dead, total: Math.round(alt.total * 100) / 100});
		});
		// The outcome already signed off on, if it is still on the table.
		const standing = standingAnswer && standingAnswer.foe === foeName
			? options.find(o => deathKey(o.dead) === standingAnswer.accept) : null;
		if (standing) {
			d.best.action = standing.action;
			console.log('  [standing choice: ' + (standing.dead.length
				? 'accepting the loss of ' + standing.dead.join(', ')
				: 'losing nobody') + ']');
		} else {
			if (standingAnswer && standingAnswer.foe === foeName) {
				console.log('  [the outcome you chose ('
					+ (standingAnswer.accept || 'losing nobody')
					+ ') is no longer on offer]');
			}
			// An answer left over from an earlier question would satisfy this
			// one the instant it is asked, and the human would never see it.
			try { fs.unlinkSync(CHOICE); } catch (e) { /* nothing stale */ }
			pendingAsk = {key: positionKey(obs), foe: foeName, options: options,
				asked: Date.now()};
			fs.writeFileSync(ASK, JSON.stringify({
				turn: obs.turn,
				position: speciesName(obs.me.species) + ' (' + obs.me.hp + ') vs '
					+ foeName + ' (' + obs.foe.hp + ')',
				options: options.map(o => ({
					why: o.why, dead: o.dead, total: o.total,
					action: o.action.type === 'switch'
						? 'switch to ' + (st.me.team[o.action.index]
							? st.me.team[o.action.index].set.species : 'slot ' + o.action.index)
						: o.action.move
				}))
			}));
			console.log('\nturn ' + obs.turn + ': the plan expects to lose '
				+ plannerSaid.path.r.dead.join(', ')
				+ ' -- waiting for the panel (' + options.length + ' options)');
			return;
		}
	}

	const us = speciesName(obs.me.species), them = speciesName(obs.foe.species);
	const ourAction = d.best.action.type === 'switch'
		? 'switch ' + d.best.action.index : d.best.action.move;
	const describe = a => !a ? 'none'
		: (a.type === 'switch' ? 'switch ' + a.index : a.move);
	const theirAction = describe(d.theirs);
	const byteSays = describe(d.src.byte);
	const modelSays = describe(d.src.model);
	// Against the ACTIVE foe's max HP. Slot zero's max HP turned every
	// predicted-damage number, and so every recorded damage band, into a
	// fraction of the wrong Pokemon.
	const predOur = Math.round(d.best.theirLoss * st.foe.team[st.foe.active].maxHP);
	const predTheir = Math.round(d.best.myLoss * st.me.team[st.me.active].maxHP);

	console.log('\nturn ' + obs.turn + '  ' + us + ' (' + obs.me.hp + ') vs '
		+ them + ' (' + obs.foe.hp + ')');
	// ONCE per process, not every turn. Printing it on every decision turned a
	// useful warning into a flood.
	if (checkStale() && !staleShown) {
		staleShown = true;
		console.log('  *** STALE: source changed since this process started; it is'
			+ ' running the OLD code. Restart the agent. Rows marked '
			+ VERSION + '-STALE. (said once)');
	}
	console.log('  they will: ' + theirAction
		+ '   [byte ' + byteSays + (d.src.stale ? ' STALE, ignored' : '')
		+ ' | model ' + modelSays + ']');
	console.log('  ' + (plannerSaid
		? (plannerSaid.overridden ? 'PLAN (OVERRIDDEN by the death veto): ' : 'PLAN: ')
			+ plannerSaid.path.cand.why
			+ '   [this kill ' + plannerSaid.path.here.toFixed(2)
			+ ', rest of the fight ' + plannerSaid.path.ahead.toFixed(2)
			// THE PRICED REALITY, next to the label. The label is written by
			// GENERATION, which measures a duel with both Pokemon already on
			// the field; the price is PAID in the real position, where we may
			// have to switch in and eat a hit first. They routinely disagree:
			// sampled over recent turns the label averaged 0% death while the
			// priced line averaged 21%, and one line labelled "0% death"
			// priced at 100% with Victreebel dying. Every log line, and every
			// human read of this agent, has been optimistic by that margin.
			+ (plannerSaid.path.r
				? '; priced death ' + Math.round(100 * plannerSaid.path.r.deathRisk) + '%'
					+ ((plannerSaid.path.r.dead || []).length
						? ' losing ' + plannerSaid.path.r.dead.join(',') : '')
				: '')
			+ ']'
		: 'no plan found, falling back to one-turn scoring'));
	console.log('  [turnsOut: us ' + st.me.team[st.me.active].turnsOut
		+ ', them ' + (st.foe.team[st.foe.active] || {}).turnsOut + ']');
	if (plannerSaid && plannerSaid.margin !== null && plannerSaid.margin !== undefined) {
		// A small margin means the switch bought almost nothing; a negative one
		// means it lost to staying and was taken for a later leg of the plan.
		console.log('  [switch margin ' + plannerSaid.margin.toFixed(2)
			+ ' vs staying in' + (plannerSaid.stay ? ' (' + plannerSaid.stay.why + ')' : '')
			+ (plannerSaid.margin < 0.5 ? '  <-- NEEDLESS?' : '') + ']');
	}
	console.log('  we play: ' + ourAction
		+ (d.best.unknownTarget
			? '   (they are switching, so this lands on whoever comes in)'
			: '   expecting to deal ' + predOur + ' and take ' + predTheir));
	d.all.slice(0, 4).forEach(r => console.log('     ' + String(r.score.toFixed(1)).padStart(7)
		+ '  ' + (r.action.type === 'switch' ? 'switch ' + r.action.index : r.action.move)));

	// THE WHOLE DAMAGE BAND, so the roll INDEX can be recovered from the actual
	// damage. Comparing a single median prediction against reality only ever
	// says "close" or "not close"; with all sixteen values, the actual damage
	// names which roll happened, and that number can be checked directly
	// against draw #4 % 16. That is the experiment that settles the draw
	// ordering rather than gesturing at it.
	// THEIR band too. Only two of twenty-two rows are usable for the draw
	// search, because our attacks mostly KILL and a kill gives a lower bound
	// rather than an exact roll. The damage we TAKE is almost always exact --
	// we rarely faint in these fights -- so logging the opponent's damage band
	// roughly doubles the usable observations per turn from the same play.
	// ALL FOUR of their moves, not just the one we predicted. Twenty rows of
	// opponent bands were unusable because the band recorded belonged to the
	// move we EXPECTED, and the predictor is right about half the time -- so
	// the actual damage matched nothing and every one was discarded. Which move
	// they used is known afterwards from their PP; the band has to be captured
	// beforehand, so capture them all.
	const foeBands = {};
	(obs.foe.moves || []).forEach(id => {
		const nm = moveName(id);
		if (!nm) return;
		try {
			const fr = B.damageRolls(st, 'foe', nm);
			if (fr && !fr.immune) {
				const h = fr.hits || 1;
				foeBands[nm] = fr.noCrit.map(v => v * h).join(',');
			}
		} catch (e) { /* status move, no band */ }
	});
	const foeRolls = Object.keys(foeBands).map(k => k + '=' + foeBands[k]);
	const foeCrit = '';

	let rolls = [], critRolls = '';
	if (d.best.action.type === 'move') {
		try {
			const r = B.damageRolls(st, 'me', d.best.action.move);
			if (r && !r.immune) {
				const hits = r.hits || 1;
				rolls = r.noCrit.map(v => v * hits);
				critRolls = r.crit[r.crit.length - 1] * hits;
			}
		} catch (e) { /* a status move has no band */ }
	}

	// ARCHIVE THE POSITION. Every turn becomes a replayable case for the
	// mistake finder: what the position was, what we played, and what we
	// expected. Without this a game is watched once and gone, and finding
	// mistakes means somebody sitting there for hours.
	// Remember a protect for the next rebuild; anything else breaks the chain.
	{
		const key = obs.me.maxhp + ':' + obs.me.species;
		const move = d.best.action.type === 'move' ? d.best.action.move : null;
		if (move && PROTECT_MOVES[move] && protectRun.key === key) protectRun.chain += 1;
		else if (move && PROTECT_MOVES[move]) { protectRun.key = key; protectRun.chain = 1; }
		else { protectRun.key = key; protectRun.chain = 0; }
	}
	try {
		// ONE FOLDER PER AGENT SESSION. The Lua's turn counter restarts, so
		// the flat archive silently overwrote old positions as the counter
		// passed their numbers again -- turn00592.json stopped being the
		// Manectric flip-flop evidence and became an unrelated Bellibolt
		// turn, and an hour of regression probes compared different battles.
		// Evidence must be append-only.
		const dir = path.join(DIR, 'turns', SESSION);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
		// HOW LONG EACH SIDE HAD BEEN OUT, recorded so the position can be
		// REPRODUCED. Nothing in the RAM observation carries it -- it is
		// counted by the running agent -- so a probe rebuilt every archived
		// turn with turnsOut 0, made Fake Out legal where live it was not, and
		// answered a different question than the one being investigated. The
		// probe reads these back; HANDOFF's warning about it is now obsolete.
		obs.turnsOut = st.me.team[st.me.active] ? st.me.team[st.me.active].turnsOut : 0;
		obs.foeTurnsOut = st.foe.team[st.foe.active]
			? st.foe.team[st.foe.active].turnsOut : 0;
		fs.writeFileSync(path.join(dir, 'turn' + String(obs.turn).padStart(5, '0') + '.json'),
			JSON.stringify({obs,
				played: ourAction,
				// The switch TARGET by name, not by index. "switch 2" cannot be
				// compared against a recommendation, so the mistake finder was
				// treating every switch as agreeing with every other switch.
				playedMon: d.best.action.type === 'switch'
					? (st.me.team[d.best.action.index]
						&& st.me.team[d.best.action.index].set.species) || null
					: (st.me.team[st.me.active] && st.me.team[st.me.active].set.species) || null,
				predicted: theirAction,
				plan: plannerSaid ? plannerSaid.path.cand.why : null,
				planJobs: plannerSaid ? plannerSaid.path.cand.jobs : null}) + '\n');
	} catch (e) { /* archiving must never break play */ }

	awaiting = {
		turn: obs.turn, us, them, ourAction, theirAction, predOur, predTheir,
		rolls, critRolls, foeRolls, foeCrit,
		byteSays, modelSays, stale: d.src.stale,
		myHP: obs.me.hp, foeHP: obs.foe.hp, rng: obs.rng,
		meSpecies: obs.me.species, foeSpecies: obs.foe.species,
		foePP: obs.foe.pp.slice(), foeMoves: obs.foe.moves.slice(),
		// END-OF-TURN RESIDUAL IS INSIDE THE DAMAGE NUMBER. Damage is measured
		// as HP before minus HP after across the WHOLE turn, so a burn or
		// poison tick is counted as part of the hit. That is exactly why
		// Lanturn's Scald read 45 against a band whose maximum is 40: forty of
		// move damage plus five of burn. Recording the status on both sides
		// lets residual be separated instead of inflating the move.
		foeStatusBefore: obs.foe.status,
		// SIXTY-FOUR DRAWS, not eight. The seed is read at the action menu and
		// the game consumes an unknown number of values before our damage roll
		// -- turn order, accuracy, the opponent's own move, secondary effects.
		// With a window of eight, two of six rows had NO draw position that
		// could explain their roll, so the search had nowhere to succeed. The
		// window has to be wider than the uncertainty it is searching.
		draws: draws(obs.rng, 64).map(v => (v >>> 16))
	};

	const slot = d.best.action.type === 'switch'
		? d.best.action.index
		: st.me.team[st.me.active].set.moves.indexOf(d.best.action.move);
	// THE DISPLAY SLOT IS THE RAM SLOT. Measured, finally, the only way that
	// settles it: the six max HP values logged in the SAME TICK as the
	// screenshot, since each is a unique fingerprint. Screen read Diggersby
	// 48/112, Lanturn 0/139, Mienshao 98/98, Lilligant 0/102, Breloom 0/95,
	// Victreebel 0/108 down the two columns; RAM read 0:48/112 1:0/139 2:98/98
	// 3:0/102 4:0/95 5:0/108. Identity, with nothing swapped.
	//
	// Four different mappings were derived before this, each from a screenshot
	// held next to a RAM read taken a moment apart, and they contradicted each
	// other because the party order moves between those moments. The lesson is
	// the measurement method, not the answer: two observations of a changing
	// thing have to come from the same instant to be compared at all.
	//
	// mySets is itself aligned to RAM order above by level and max HP, so the
	// model index, the RAM slot and the display slot are all the same number.
	// A FAINTED TARGET IS NEVER PLAYABLE. The game answers "X has no energy
	// left to battle!" and sits on the party screen until the watchdog gives
	// up, costing a turn. That is worth catching here even though the mapping
	// is now right, because the cost of being wrong is silent and repeated.
	if (d.best.action.type === 'switch') {
		const tgt = st.me.team[slot];
		if (!tgt || tgt.fainted || tgt.curHP <= 0) {
			console.log('refusing to switch to slot ' + slot + ' -- '
				+ (tgt ? tgt.set.species + ' is fainted' : 'no such Pokemon'));
			return;
		}
	}
	// ANSWER THE QUESTION AS CURRENTLY NUMBERED. The Lua expires a question
	// after 60 seconds and re-asks the SAME position under a new turn id --
	// and it rejects any answer whose id does not match. When a decision runs
	// long, the answer arrives numbered for a question that no longer exists,
	// the Lua re-asks, the node answers one generation behind, forever: cmd
	// turn 615 landed while the question was 617, the fight froze at
	// 'Victreebel vs Bellibolt' for 130 asked-turns, and 'no answer in 60s'
	// filled the log while both sides worked diligently. If the live question
	// is still the same position (same kind, same actives, same HP on both
	// sides), the answer is stamped with ITS number; if the position has
	// actually moved, the stale answer is withheld and the loop decides fresh.
	let answerTurn = obs.turn;
	try {
		const nowQ = readJSONSync(STATE);
		if (nowQ && nowQ.turn !== obs.turn) {
			const same = nowQ.kind === obs.kind
				&& nowQ.me && obs.me && nowQ.me.species === obs.me.species
				&& nowQ.me.hp === obs.me.hp
				&& nowQ.foe && obs.foe && nowQ.foe.species === obs.foe.species
				&& nowQ.foe.hp === obs.foe.hp;
			if (!same) {
				console.log('withholding answer for turn ' + obs.turn
					+ ': the position moved on (question is now turn ' + nowQ.turn + ')');
				return;
			}
			answerTurn = nowQ.turn;
		}
	} catch (e) { /* an unreadable question changes nothing */ }
	fs.writeFileSync(CMD, JSON.stringify({
		turn: answerTurn,
		action: d.best.action.type === 'switch' ? 'switch' : 'move',
		slot: slot,
		// THE TARGET AS A FINGERPRINT, not just an index. Every switching bug
		// in this file has been an ordering bug: the party is renumbered when
		// a Pokemon comes in, so an index computed here can name someone else
		// by the time the actuator presses A. Max HP and level identify a party
		// member uniquely, so the actuator can resolve them against the very
		// RAM the screen is drawn from and refuse to commit if the slot it is
		// sitting on is not the Pokemon that was chosen.
		wantMax: st.me.team[slot] ? st.me.team[slot].maxHP : 0,
		wantLevel: st.me.team[slot] ? st.me.team[slot].level : 0,
		from: 0
	}) + '\n');
}, 250);
