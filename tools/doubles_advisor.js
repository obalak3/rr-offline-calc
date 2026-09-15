'use strict';
/**
 * WHAT SHOULD WE DO THIS DOUBLES TURN -- read off the real game.
 *
 * Stage 4 of docs/PLAN-DOUBLES.md, in its first form: an advisor James can
 * watch while he plays. It takes a save state at a doubles action menu, builds
 * the legal joint actions, plays a portfolio of them on the hidden core, scores
 * the real after-states, and prints what it would do and why.
 *
 *   node tools/doubles_advisor.js <state.ss> [--budget N] [--all] [--depth 2]
 *
 *   --all      play EVERY legal joint action, not a portfolio. Slow, and the
 *              reference any pruning has to be judged against.
 *   --budget   how many pairs the portfolio may play (default 16).
 *   --depth 2  for the top few, play one more turn of our own best replies, so
 *              a line that only defers has to show its second turn.
 *
 * Nothing here presses anything on James's screen; the hidden core is the only
 * thing that touches the game (his rule, 2026-09-08).
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const D = require('./lib/doubles-oracle.js');
const A = require('./lib/doubles-actions.js');
const P = require('./lib/doubles-position.js');

const CLI = require.main === module;
const args = process.argv.slice(2);
const STATE = args.find(a => !a.startsWith('--'));
const flag = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };

if (CLI) {
	if (!STATE) { console.error('usage: node tools/doubles_advisor.js <state.ss> [--budget N] [--all] [--depth 2]'); process.exit(2); }
	if (!fs.existsSync(STATE)) { console.error('no such state: ' + STATE); process.exit(2); }
	if (!D.available()) { console.error('the hidden core or the ROM is missing; see docs/HANDOFF.md section 4'); process.exit(2); }
}

const engine = H.loadEngine();
const dexBundle = H.loadDex();
const dex = engine.sandbox.RR_DEX_DATA;
const MOVES = engine.sandbox.RR_MOVE_EFFECTS.moves;
const speciesName = id => { const s = dex.species[id]; return s ? (s.key || s.name) : ('#' + id); };
const moveName = id => { const m = dex.moves && dex.moves[id]; return m ? (m.name || m.key || ('#' + id)) : ('#' + id); };
const moveInfo = id => {
	const name = moveName(id);
	const rec = MOVES[name];
	return {name, target: rec ? rec.target : 'selected', power: rec ? rec.power : 0, split: rec ? rec.split : null};
};

function partyRows(obs) {
	return obs.party.map(p => {
		const raw = Buffer.from(p.raw, 'hex');
		return {slot: p.slot, hp: p.hp, maxhp: p.maxhp, level: p.level, species: raw.readUInt16LE(0x20)};
	});
}

/**
 * The score of a real after-state, in HP-equivalents, the same currency the
 * singles oracle uses: their HP removed, a large bounty per opponent removed,
 * our HP lost, and a standing charge for each of ours that faints.
 *
 * KNOWN GAP, recorded rather than papered over: position.js is singles-shaped
 * (its importance weights come from a one-against-one duel table), so nothing
 * here yet prices an opponent's Substitute, their stat boosts going up, or
 * which of ours is the answer to what. docs/PLAN-DOUBLES.md carries that as
 * the next piece of work.
 */
/**
 * What the turn did to anyone's CONDITION, reported and never scored.
 *
 * position.js measures what a condition is worth (the damage their real moves
 * no longer do to our living team) and James's standing rule is that constants
 * are derived, not tuned -- so inventing "sleep = 60" here would be exactly the
 * kind of external fitted rule he has rejected. Until the position score is
 * taught doubles, a sleep or a Swords Dance is printed beside the line instead
 * of being priced into it, so a line that "costs nothing" cannot quietly be one
 * that put both of ours to sleep.
 */
const STATUS_BITS = [[0x07, 'asleep'], [0x08, 'poisoned'], [0x10, 'burned'], [0x20, 'frozen'], [0x40, 'paralysed'], [0x80, 'badly poisoned']];
const STAGE_NAMES = [null, 'Attack', 'Defence', 'Speed', 'Sp.Atk', 'Sp.Def', 'accuracy', 'evasion'];
function statusNames(word) {
	return STATUS_BITS.filter(([bit]) => (word & bit) !== 0).map(([, n]) => n);
}
function conditionNotes(before, after, nameOf) {
	const notes = [];
	[0, 1, 2, 3].forEach(b => {
		const s0 = before.battlers[b], s1 = after.battlers[b];
		if (!s0 || !s1 || s0.species !== s1.species || s1.hp === 0) return;
		const who = (b % 2 === 0 ? 'our ' : 'their ') + nameOf(b);
		const gained = statusNames(s1.status).filter(n => !statusNames(s0.status).includes(n));
		gained.forEach(n => notes.push(who + ' ' + n));
		(s1.stages || []).forEach((v, i) => {
			if (!STAGE_NAMES[i]) return;
			const d = v - (s0.stages ? s0.stages[i] : 6);
			if (d) notes.push(who + ' ' + STAGE_NAMES[i] + ' ' + (d > 0 ? '+' : '') + d);
		});
	});
	return notes;
}

function score(sum, cond) {
	if (!sum || !sum.ok) return -Infinity;
	return sum.theirLost + 1000 * sum.theirDead
		- sum.ourLost + sum.ourHealed
		- 130 * sum.ourDead
		// The CHANGE in conditions across the turn, measured in HP against the
		// same position with those conditions removed (doubles-position.js).
		// Null means it could not be priced, and is left out rather than
		// counted as nothing.
		+ (cond && cond.value ? cond.value : 0);
}

/** A cheap ordering for the portfolio's fill: damage numbers, no simulation. */
function rankOf(pair) {
	const one = a => {
		if (!a) return 0;
		if (a.type === 'switch') return 0;
		const rec = MOVES[a.move];
		return rec && rec.power ? rec.power : 0;
	};
	return one(pair.a0) + one(pair.a2);
}

/**
 * Work out the turn. Returns everything the caller needs to judge it, so a
 * test can assert on the ranking rather than on printed text.
 */
async function advise(statePath, opts) {
	opts = opts || {};
	const BUDGET = opts.budget === undefined ? 16 : opts.budget;
	const DEPTH = opts.depth === undefined ? 1 : opts.depth;
	const playAll = !!opts.all;
	const say = opts.quiet ? () => {} : console.log;
	const STATE = statePath;
	const flag = n => (n === 'all' ? playAll : false);
	const peek = await D.probe(STATE, {a0: null, a2: null});
	if (peek.error) throw new Error('the core could not read that state: ' + peek.error);
	const obs = peek.obs, before = peek.before;
	if (!obs || !obs.doubles) throw new Error('that state is not a double battle');

	const B = obs.battlers;
	const party = partyRows(obs);
	const onField = new Set();
	[0, 2].forEach(b => {
		const m = B[b];
		if (!m || m.hp <= 0) return;
		const i = party.findIndex(p => p.species === m.species && p.maxhp === m.maxhp && !onField.has(p.slot));
		if (i >= 0) onField.add(i);
	});
	const nameOf = b => speciesName(B[b].species) + (b % 2 === 0 ? '' : '');
	const alive = {
		foes: [1, 3].filter(b => B[b] && B[b].hp > 0),
		mine: [0, 2].filter(b => B[b] && B[b].hp > 0),
		ally: b => B[b === 0 ? 2 : 0] && B[b === 0 ? 2 : 0].hp > 0,
		partnerOf: b => (b === 0 ? 2 : 0)
	};
	const asked = before.asking === 0 || before.asking === 2 ? [0, 2].filter(b => B[b] && B[b].hp > 0) : [];

	say('\n' + '='.repeat(78));
	say('OURS   ' + [0, 2].map(b => 'b' + b + ' ' + speciesName(B[b].species) + ' ' + B[b].hp + '/' + B[b].maxhp).join('    '));
	say('THEIRS ' + [1, 3].map(b => 'b' + b + ' ' + speciesName(B[b].species) + ' ' + B[b].hp + '/' + B[b].maxhp).join('    '));
	say('BENCH  ' + party.filter(p => !onField.has(p.slot) && p.hp > 0)
		.map(p => speciesName(p.species) + ' ' + p.hp + '/' + p.maxhp).join(', '));
	say('='.repeat(78));

	const naming = {
		name: b => speciesName(B[b].species),
		partyName: s => speciesName(party[s].species)
	};
	const left = A.actionsFor(0, B[0], moveInfo, party, onField, alive, naming);
	const right = A.actionsFor(2, B[2], moveInfo, party, onField, alive, naming);
	const all = A.jointActions(left, right, asked);
	say('legal joint actions: ' + all.length
		+ '  (' + left.length + ' for ' + speciesName(B[0].species) + ', ' + right.length + ' for ' + speciesName(B[2].species) + ')');

	const play = flag('all') ? all : A.portfolio(all, rankOf, BUDGET);
	const gaps = A.coverageGaps(all, play);
	say('playing ' + play.length + ' of them on the hidden game, ' + D.CONC + ' at a time'
		+ (flag('all') ? '' : ' (coverage first, then shapes, then the hardest hitters)'));
	if (!flag('all')) say('coverage: every legal action of ours is represented'
		+ (gaps.length ? ' EXCEPT ' + gaps.length + ': ' + gaps.join(', ') : ''));

	const t0 = Date.now();
	const results = await D.probeAll(STATE, play);
	const secs = ((Date.now() - t0) / 1000).toFixed(1);

	const maxBySlot = {}; party.forEach(p => { maxBySlot[p.slot] = p.maxhp; });
	const rows = [];
	results.forEach((r, i) => {
		const sum = D.summarize(r);
		if (!sum.ok) { rows.push({pair: play[i], bad: r.error || 'no result'}); return; }
		if (!D.arrivalOk(r, maxBySlot)) { rows.push({pair: play[i], bad: 'the wrong Pokemon came in; probe thrown away'}); return; }
		let cond = null;
		try { cond = r.obs ? P.delta(engine, dexBundle, obs, r.obs) : null; } catch (e) { cond = null; }
		rows.push({pair: play[i], sum, cond, v: score(sum, cond), r});
	});
	const good = rows.filter(x => !x.bad).sort((a, b) => b.v - a.v);
	const bad = rows.filter(x => x.bad);

	const label = p => [p.a0 ? speciesName(B[0].species) + ' ' + p.a0.label : null,
		p.a2 ? speciesName(B[2].species) + ' ' + p.a2.label : null].filter(Boolean).join('  +  ');

	say('\nbest ' + Math.min(8, good.length) + ' of ' + good.length + ' played, in ' + secs + ' s:\n');
	good.slice(0, 8).forEach((x, i) => {
		const s = x.sum;
		const took = s.ourLost ? 'we lose ' + s.ourLost : 'we lose nothing';
		const dealt = s.theirLost ? 'they lose ' + s.theirLost : 'they lose nothing';
		say('  ' + String(Math.round(x.v)).padStart(6) + '  ' + label(x.pair));
		say('          ' + dealt + (s.theirDead ? ' and ' + s.theirDead + ' Pokemon' : '')
			+ ', ' + took + (s.ourDead ? ' and ' + s.ourDead + ' Pokemon' : '')
			+ (s.ourHealed ? ', we heal ' + s.ourHealed : '')
			+ (s.forced ? ', then we must send someone in' : ''));
		const notes = conditionNotes(x.r.before, x.r.after, b => speciesName(B[b].species));
		if (notes.length) {
			const priced = x.cond
				? Math.round(x.cond.value) + ' HP, measured'
				: 'NOT PRICED, the position could not be read';
			say('          conditions: ' + notes.join('; ') + '  [' + priced + ']');
		}
	});
	if (bad.length) {
		say('\n' + bad.length + ' thrown away: ' + bad.slice(0, 3).map(x => label(x.pair) + ' (' + x.bad + ')').join('; '));
	}

	if (DEPTH >= 2 && good.length) {
		// A line that only defers has to show its second turn. For the top few,
		// play the after-state forward with each of our own best replies and
		// judge on the two-turn total.
		const K = Math.min(3, good.length);
		say('\nsecond turn, played for real, for the top ' + K + ':');
		const os = require('os');
		for (let i = 0; i < K; i++) {
			const x = good[i];
			const tmp = path.join(os.tmpdir(), 'rr-doubles-d2-' + process.pid + '-' + i + '.ss');
			const again = await D.probe(STATE, x.pair, {save: tmp});
			if (!again.after || again.after.screen !== 'action') {
				say('  ' + label(x.pair) + ': no second decision to make (' + (again.after ? again.after.screen : 'error') + ')');
				try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
				continue;
			}
			const nb = again.obs.battlers;
			const nparty = partyRows(again.obs);
			const nfield = new Set();
			[0, 2].forEach(b => {
				const m = nb[b]; if (!m || m.hp <= 0) return;
				const k = nparty.findIndex(p => p.species === m.species && p.maxhp === m.maxhp && !nfield.has(p.slot));
				if (k >= 0) nfield.add(k);
			});
			const nalive = {foes: [1, 3].filter(b => nb[b] && nb[b].hp > 0), mine: [0, 2].filter(b => nb[b] && nb[b].hp > 0),
				ally: b => nb[b === 0 ? 2 : 0] && nb[b === 0 ? 2 : 0].hp > 0, partnerOf: b => (b === 0 ? 2 : 0)};
			const nasked = [0, 2].filter(b => nb[b] && nb[b].hp > 0);
			const nl = A.actionsFor(0, nb[0], moveInfo, nparty, nfield, nalive, {});
			const nr = A.actionsFor(2, nb[2], moveInfo, nparty, nfield, nalive, {});
			const replies = A.portfolio(A.jointActions(nl, nr, nasked), rankOf, 6);
			const rr = await D.probeAll(tmp, replies);
			let best = -Infinity, bestLabel = '';
			rr.forEach((r2, k) => {
				const s2 = D.summarize(r2);
				if (!s2.ok) return;
				const v = x.v + score(s2);
				if (v > best) {
					best = v;
					bestLabel = [replies[k].a0 ? speciesName(nb[0].species) + ' ' + replies[k].a0.label : null,
						replies[k].a2 ? speciesName(nb[2].species) + ' ' + replies[k].a2.label : null].filter(Boolean).join(' + ');
				}
			});
			say('  ' + String(Math.round(best)).padStart(6) + '  ' + label(x.pair) + '  then  ' + bestLabel);
			try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
		}
	}

	if (good.length) {
		say('\nRECOMMENDATION: ' + label(good[0].pair));
	}
	return {obs, before, all, play, gaps, ranked: good, thrown: bad, secs: Number(secs), label, speciesName};
}

module.exports = {advise};

if (CLI) {
	advise(STATE, {budget: val('budget', 16), depth: val('depth', 1), all: flag('all')})
		.catch(e => { console.error(e.message || e); process.exit(1); });
}
