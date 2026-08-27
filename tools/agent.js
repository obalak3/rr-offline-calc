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

const DIR = path.join(process.env.HOME, 'rr-agent');
const STATE = path.join(DIR, 'state.json');
const CMD = path.join(DIR, 'cmd.json');
const RESULT = path.join(DIR, 'result.json');
const PRED = path.join(DIR, 'predictions.tsv');

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
	const b = battleOf(obs);
	const sets = b ? H.foeSets(b) : null;
	return {
		engine, party,
		foeSets: (sets && sets.length) ? sets : [setFromBattler(obs.foe, null)],
		expendable: (process.env.EXPENDABLE || 'Lilligant').split(',').filter(Boolean)
	};
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
	let foeTeam = null;
	const bt = battleOf(obs);
	const known = bt ? (H.foeSets(bt) || []) : [];
	if (obs.foeparty && obs.foeparty.length && known.length) {
		foeTeam = [];
		obs.foeparty.forEach((row, i) => {
			if (!row.maxhp) return;               // empty slot: they carry fewer
			foeTeam.push(known[i] || Object.assign({}, foeSet));
		});
	}
	// NEVER HAND createState A NULL TEAM. When the position is not a fight we
	// have trainer data for -- the boot screen, a wild battle, any fight before
	// the rotation has loaded its save -- `known` is empty, foeTeam stayed null
	// and createState threw, which killed the whole agent PROCESS rather than
	// skipping one turn. The emulator then sat asking a planner that was no
	// longer running. Fall back to what we can actually see: the Pokemon in
	// front of us, one slot per occupied slot of their party.
	if (!foeTeam || !foeTeam.length) {
		const n = (obs.foeparty || []).filter(r => r && r.maxhp).length || 1;
		foeTeam = [];
		for (let i = 0; i < n; i++) foeTeam.push(Object.assign({}, foeSet));
	}
	const st = B.createState(mySets, foeTeam, {});
	// Put THEIR active where it really is, and apply what we can see of them.
	// THEIR ACTIVE, matched on the base name too. A mega arrives as its base
	// form, so RAM says "Manectric" while the set is "Manectric-Mega" -- the
	// exact match returned -1, the active index silently stayed at 0, and we
	// modelled a FAINTED Pincurchin as the Pokemon in front of us. The
	// predictor then returned nothing at all ("they will: none") and the
	// planner was pricing a position that did not exist.
	const rawName = speciesName(obs.foe.species);
	const baseOf = n => String(n || '').split('-')[0];
	let activeFoe = foeTeam.findIndex(f => f && f.species === rawName);
	if (activeFoe < 0) {
		activeFoe = foeTeam.findIndex(f => f && baseOf(f.species) === baseOf(rawName));
	}
	if (activeFoe >= 0) st.foe.active = activeFoe;
	(obs.foeparty || []).forEach((row, i) => {
		const m = st.foe.team[i];
		if (!m || !row.maxhp) return;
		m.curHP = row.hp;
		m.fainted = row.hp <= 0;
		m.status = statusOf(row.status);
	});
	st.me.active = activeIndex;

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
	const act = st.me.team[st.me.active];
	console.log('active index ' + st.me.active + ' = ' + act.set.species
		+ '  hp ' + act.curHP + '/' + act.maxHP + '  fainted=' + act.fainted);
	console.log('its moves: ' + JSON.stringify(act.set.moves) + '  pp ' + JSON.stringify(act.pp));
	console.log('team: ' + st.me.team.map((m, i) =>
		i + ':' + m.set.species + (m.fainted ? '(X)' : '') + ' ' + m.curHP).join('  '));
	console.log('THEIR team: ' + st.foe.team.map((m, i) =>
		(i === st.foe.active ? '>' : ' ') + i + ':' + m.set.species
		+ (m.fainted ? '(X)' : ' ' + m.curHP + '/' + m.maxHP)).join('  '));
	console.log('legal actions: ' + JSON.stringify(B.legalActions(st, 'me')));
	// Trip the staleness detector the way a running session does, so the probe
	// exercises the MODEL path and not just the byte path.
	let d = decide(st, obs);
	for (let i = 0; i < 6; i++) d = decide(st, obs);
	console.log('foe action used: ' + JSON.stringify(d.theirs)
		+ '  (stale=' + d.src.stale + ')');
	console.log('ranked: ' + JSON.stringify(d.all.map(r =>
		(r.action.move || ('switch ' + r.action.index)) + '=' + r.score.toFixed(2))));
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
	fs.writeFileSync(path.join(DIR, 'version.txt'), VERSION + '\n');
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
let staleAnnounced = false;
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
	if (!obs || alreadyAnswered(obs)) return;
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
		const pick = R.chooseAction(planCtx(obs), st,
			{incumbent: lastPlan.foe === foeNow ? lastPlan.jobs : null});
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
				if (mine && mine.mineDead && !mine.foeDead) {
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
						plannerSaid = null;
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
	if (checkStale()) {
		console.log('  *** STALE: source files changed since this process started.'
			+ ' It is STILL RUNNING THE OLD CODE. Restart the agent before'
			+ ' believing anything below. Results are marked ' + VERSION + '-STALE.');
	}
	console.log('  they will: ' + theirAction
		+ '   [byte ' + byteSays + (d.src.stale ? ' STALE, ignored' : '')
		+ ' | model ' + modelSays + ']');
	console.log('  ' + (plannerSaid
		? 'PLAN: ' + plannerSaid.path.cand.why
			+ '   [this kill ' + plannerSaid.path.here.toFixed(2)
			+ ', rest of the fight ' + plannerSaid.path.ahead.toFixed(2) + ']'
		: 'no plan found, falling back to one-turn scoring'));
	console.log('  [turnsOut: us ' + st.me.team[st.me.active].turnsOut
		+ ', them ' + (st.foe.team[st.foe.active] || {}).turnsOut + ']');
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
	try {
		const dir = path.join(DIR, 'turns');
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
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
	fs.writeFileSync(CMD, JSON.stringify({
		turn: obs.turn,
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
