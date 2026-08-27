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
const RRAI = engine.sandbox.RRAI;
const AI_FLAGS = {checkBadMove: true, checkGoodMove: true};
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
	const activeIndex = Math.max(0, mySets.findIndex(p => p.species === mineName));
	if (mySets[activeIndex]) mySets[activeIndex] = setFromBattler(obs.me, mySets[activeIndex]);
	// THEIR BENCH HAS TO EXIST FOR THEIR SWITCH TO BE LEGAL. We can only see
	// their active Pokemon, so the side used to be built with exactly one --
	// and then, the moment they committed to a switch, every action we tried
	// to simulate threw, because the destination slot did not exist. The agent
	// reported "no legal action found" and stood there. Placeholders make the
	// switch representable; they are NOT a claim about what is coming in, which
	// is why nothing credits a kill on a switch turn.
	const bench = [];
	for (let i = 0; i < 5; i++) bench.push(Object.assign({}, foeSet));
	const st = B.createState(mySets, [foeSet].concat(bench), {});
	st.me.active = activeIndex;

	// Apply everything observed, so the simulation starts from the real
	// position rather than a fresh one.
	const me = st.me.team[activeIndex], foe = st.foe.team[0];
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
		if (!moves.length) return null;
		let best = -Infinity;
		moves.forEach(e => { if (e.score > best) best = e.score; });
		return moves.filter(e => e.score === best)[0].action;
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
		rows.push({
			action: a,
			score: (credited ? 100 : 0) - (mineDead ? 200 : 0)
				+ theirLoss * (theySwitch ? 4 : 10) - myLoss * 8,
			foeDead: credited, mineDead, theirLoss, myLoss,
			unknownTarget: theySwitch
		});
	}
	rows.sort((x, y) => y.score - x.score);
	// VOLUNTARY SWITCHING IS DISABLED, deliberately and temporarily.
	//
	// The Shift confirmation does not take. Grid navigation now works -- the
	// log shows "at slot 2 after 1 presses" -- but pressing A on the submenu
	// closes it without switching, and a whole interval spent on it produced no
	// progress while the agent resolved ONE turn in fifteen minutes. Moves are
	// proven over ninety-nine resolved turns.
	//
	// So the agent plays moves, and only touches the party screen when a faint
	// FORCES it -- a path that has no Shift submenu at all, per the screenshot,
	// and so is not affected by this. That trades some decision quality for a
	// loop that actually collects data, which is what the calibration run is
	// for. It is a limitation to lift, not a fix.
	if (obs.kind !== 'forced') {
		const moves = rows.filter(r => r.action.type !== 'switch');
		if (moves.length) return {best: moves[0], all: rows, theirs, src};
	}
	return {best: rows[0], all: rows, theirs, src};
}

// A one-shot probe, so a bad position can be reproduced offline instead of
// reasoned about from a log. `node tools/agent.js --probe` rebuilds whatever is
// in state.json and prints what the planner sees.
if (process.argv[2] === '--probe') {
	const obs = readJSONSync(STATE);
	if (!obs) { console.log('no state.json'); process.exit(1); }
	const st = buildState(obs);
	if (!st) { console.log('buildState returned null'); process.exit(1); }
	const act = st.me.team[st.me.active];
	console.log('active index ' + st.me.active + ' = ' + act.set.species
		+ '  hp ' + act.curHP + '/' + act.maxHP + '  fainted=' + act.fainted);
	console.log('its moves: ' + JSON.stringify(act.set.moves) + '  pp ' + JSON.stringify(act.pp));
	console.log('team: ' + st.me.team.map((m, i) =>
		i + ':' + m.set.species + (m.fainted ? '(X)' : '') + ' ' + m.curHP).join('  '));
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
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, {recursive: true});
// The header is rewritten whenever the schema changes, not only when the file
// is absent. Columns were added twice tonight and the header was not, so rows
// carried twenty fields under an eighteen-field header -- every parse silently
// dropped the last two, which is why forty-four opponent bands read as zero.
const PRED_HEADER = 'turn\tus\tthem\tour_action\ttheir_predicted\t'
	+ 'their_actual\tpredictor_ok\tbyte_said\tmodel_said\tbyte_stale\t'
	+ 'pred_our_dmg\tpred_their_dmg\tactual_our_dmg\tactual_their_dmg\t'
	+ 'rng_before\tdraws\trolls\tcrit_rolls\tfoe_rolls\tfoe_crit\n';
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
		+ 'rng_before\tdraws\trolls\tcrit_rolls\tfoe_rolls\tfoe_crit\n');
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
					awaiting.foeRolls.join(';'), awaiting.foeCrit].join('\t') + '\n');
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
	const d = decide(st, obs);
	if (!d.best) { console.log('turn ' + obs.turn + ': no legal action found'); return; }
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
	const predOur = Math.round(d.best.theirLoss * st.foe.team[0].maxHP);
	const predTheir = Math.round(d.best.myLoss * st.me.team[st.me.active].maxHP);

	console.log('\nturn ' + obs.turn + '  ' + us + ' (' + obs.me.hp + ') vs '
		+ them + ' (' + obs.foe.hp + ')');
	console.log('  they will: ' + theirAction
		+ '   [byte ' + byteSays + (d.src.stale ? ' STALE, ignored' : '')
		+ ' | model ' + modelSays + ']');
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

	awaiting = {
		turn: obs.turn, us, them, ourAction, theirAction, predOur, predTheir,
		rolls, critRolls, foeRolls, foeCrit,
		byteSays, modelSays, stale: d.src.stale,
		myHP: obs.me.hp, foeHP: obs.foe.hp, rng: obs.rng,
		meSpecies: obs.me.species, foeSpecies: obs.foe.species,
		foePP: obs.foe.pp.slice(), foeMoves: obs.foe.moves.slice(),
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
	// `from` is where the party cursor STARTS: the battle party screen opens
	// with the active Pokemon highlighted. The cursor byte cannot be used for
	// this -- it reads 0 whenever the screen opens regardless of what is
	// actually highlighted, so the agent kept "arriving" at slot 0 without
	// moving and confirming whatever was really selected. Knowing the start and
	// the target makes the path deterministic and needs no sensor at all.
	fs.writeFileSync(CMD, JSON.stringify({
		turn: obs.turn,
		action: d.best.action.type === 'switch' ? 'switch' : 'move',
		slot: Math.max(0, slot),
		from: st.me.active
	}) + '\n');
}, 250);
