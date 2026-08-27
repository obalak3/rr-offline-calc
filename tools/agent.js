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

const DIR = path.join(process.env.HOME, 'rr-agent');
const STATE = path.join(DIR, 'state.json');
const CMD = path.join(DIR, 'cmd.json');
const RESULT = path.join(DIR, 'result.json');
const PRED = path.join(DIR, 'predictions.tsv');

const engine = H.loadEngine();
const B = engine.B;
const dex = H.loadDex();
const party = H.realTeam();

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
	const out = Object.assign({}, base, {moves: moves.length ? moves : base.moves});
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
	const mySets = party.map(p => p.species === mineName
		? setFromBattler(obs.me, p) : p);
	const activeIndex = Math.max(0, mySets.findIndex(p => p.species === mineName));
	const st = B.createState(mySets, [foeSet], {});
	st.me.active = activeIndex;

	// Apply everything observed, so the simulation starts from the real
	// position rather than a fresh one.
	const me = st.me.team[activeIndex], foe = st.foe.team[0];
	me.curHP = obs.me.hp; foe.curHP = obs.foe.hp;
	me.status = statusOf(obs.me.status); foe.status = statusOf(obs.foe.status);
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

/** What the opponent has already committed to, read rather than predicted. */
function foeAction(st, obs) {
	if (obs.ai_action === 1) return {type: 'switch', index: obs.ai_target};
	const mv = moveName(obs.foe.moves[obs.ai_target]);
	if (!mv) return null;
	return {type: 'move', index: obs.ai_target, move: mv};
}

// The battle generator, solved: mul 0x41C64E6D, add 12345.
function advance(v) { return (Math.imul(v, 0x41C64E6D) + 12345) >>> 0; }
function draws(seed, n) {
	const out = [];
	let v = seed >>> 0;
	for (let i = 0; i < n; i++) { v = advance(v); out.push(v); }
	return out;
}

function decide(st, obs) {
	const theirs = foeAction(st, obs);
	const legal = B.legalActions(st, 'me');
	const rows = [];
	for (const a of legal) {
		if (!theirs) break;
		let out;
		try {
			out = B.step(st, a, theirs, {mode: 'maxroll', risks: {roll: 'median'}});
		} catch (e) { continue; }
		if (!out || !out.length) continue;
		const after = out[0].state;
		const myIdx = st.me.active;
		const foeDead = after.foe.team[0].fainted;
		const mineDead = after.me.team[myIdx].fainted;
		const theirLoss = (st.foe.team[0].curHP - after.foe.team[0].curHP)
			/ st.foe.team[0].maxHP;
		const myLoss = (st.me.team[myIdx].curHP - after.me.team[myIdx].curHP)
			/ st.me.team[myIdx].maxHP;
		rows.push({
			action: a,
			score: (foeDead ? 100 : 0) - (mineDead ? 200 : 0) + theirLoss * 10 - myLoss * 8,
			foeDead, mineDead, theirLoss, myLoss
		});
	}
	rows.sort((x, y) => y.score - x.score);
	return {best: rows[0], all: rows, theirs};
}

// ------------------------------------------------------------------- the loop
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, {recursive: true});
if (!fs.existsSync(PRED)) {
	fs.writeFileSync(PRED, 'turn\tus\tthem\tour_action\ttheir_action\t'
		+ 'pred_our_dmg\tpred_their_dmg\tactual_our_dmg\tactual_their_dmg\t'
		+ 'rng_before\tdraws\n');
}

let lastTurn = 0, awaiting = null;
console.log('agent: watching ' + DIR + '. Load tools/lua/agent.lua in mGBA.');

function readJSON(p) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

setInterval(() => {
	const obs = readJSON(STATE);
	if (!obs || obs.turn === lastTurn) {
		if (awaiting) {
			const res = readJSON(RESULT);
			if (res && res.turn === awaiting.turn) {
				const ourDmg = awaiting.foeHP - res.foe.hp;
				const theirDmg = awaiting.myHP - res.me.hp;
				fs.appendFileSync(PRED, [awaiting.turn, awaiting.us, awaiting.them,
					awaiting.ourAction, awaiting.theirAction,
					awaiting.predOur, awaiting.predTheir, ourDmg, theirDmg,
					awaiting.rng, awaiting.draws.join(',')].join('\t') + '\n');
				const ok = (d, p) => (d === p ? 'exact' : 'off by ' + (d - p));
				console.log('  turn ' + awaiting.turn + ' resolved: our damage '
					+ ourDmg + ' (' + ok(ourDmg, awaiting.predOur) + '), theirs '
					+ theirDmg + ' (' + ok(theirDmg, awaiting.predTheir) + ')');
				awaiting = null;
			}
		}
		return;
	}
	lastTurn = obs.turn;

	const st = buildState(obs);
	if (!st) { console.log('turn ' + obs.turn + ': could not identify the position'); return; }
	const d = decide(st, obs);
	if (!d.best) { console.log('turn ' + obs.turn + ': no legal action found'); return; }

	const us = speciesName(obs.me.species), them = speciesName(obs.foe.species);
	const ourAction = d.best.action.type === 'switch'
		? 'switch ' + d.best.action.index : d.best.action.move;
	const theirAction = d.theirs.type === 'switch'
		? 'switch ' + d.theirs.index : d.theirs.move;
	const predOur = Math.round(d.best.theirLoss * st.foe.team[0].maxHP);
	const predTheir = Math.round(d.best.myLoss * st.me.team[st.me.active].maxHP);

	console.log('\nturn ' + obs.turn + '  ' + us + ' (' + obs.me.hp + ') vs '
		+ them + ' (' + obs.foe.hp + ')');
	console.log('  they have committed to: ' + theirAction);
	console.log('  we play: ' + ourAction
		+ '   expecting to deal ' + predOur + ' and take ' + predTheir);
	d.all.slice(0, 4).forEach(r => console.log('     ' + String(r.score.toFixed(1)).padStart(7)
		+ '  ' + (r.action.type === 'switch' ? 'switch ' + r.action.index : r.action.move)));

	awaiting = {
		turn: obs.turn, us, them, ourAction, theirAction, predOur, predTheir,
		myHP: obs.me.hp, foeHP: obs.foe.hp, rng: obs.rng,
		draws: draws(obs.rng, 8).map(v => (v >>> 16))
	};

	const slot = d.best.action.type === 'switch'
		? d.best.action.index
		: st.me.team[st.me.active].set.moves.indexOf(d.best.action.move);
	fs.writeFileSync(CMD, JSON.stringify({
		turn: obs.turn,
		action: d.best.action.type === 'switch' ? 'switch' : 'move',
		slot: Math.max(0, slot)
	}) + '\n');
}, 250);
