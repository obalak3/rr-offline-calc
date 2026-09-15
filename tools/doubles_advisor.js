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

const args = process.argv.slice(2);
const STATE = args.find(a => !a.startsWith('--'));
const flag = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const BUDGET = val('budget', 16);
const DEPTH = val('depth', 1);

if (!STATE) { console.error('usage: node tools/doubles_advisor.js <state.ss> [--budget N] [--all] [--depth 2]'); process.exit(2); }
if (!fs.existsSync(STATE)) { console.error('no such state: ' + STATE); process.exit(2); }
if (!D.available()) { console.error('the hidden core or the ROM is missing; see docs/HANDOFF.md section 4'); process.exit(2); }

const engine = H.loadEngine();
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
function score(sum) {
	if (!sum || !sum.ok) return -Infinity;
	return sum.theirLost + 1000 * sum.theirDead
		- sum.ourLost + sum.ourHealed
		- 130 * sum.ourDead;
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

async function main() {
	const peek = await D.probe(STATE, {a0: null, a2: null});
	if (peek.error) { console.error('the core could not read that state: ' + peek.error); process.exit(1); }
	const obs = peek.obs, before = peek.before;
	if (!obs || !obs.doubles) { console.error('that state is not a double battle'); process.exit(1); }

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

	console.log('\n' + '='.repeat(78));
	console.log('OURS   ' + [0, 2].map(b => 'b' + b + ' ' + speciesName(B[b].species) + ' ' + B[b].hp + '/' + B[b].maxhp).join('    '));
	console.log('THEIRS ' + [1, 3].map(b => 'b' + b + ' ' + speciesName(B[b].species) + ' ' + B[b].hp + '/' + B[b].maxhp).join('    '));
	console.log('BENCH  ' + party.filter(p => !onField.has(p.slot) && p.hp > 0)
		.map(p => speciesName(p.species) + ' ' + p.hp + '/' + p.maxhp).join(', '));
	console.log('='.repeat(78));

	const opts = {
		name: b => speciesName(B[b].species),
		partyName: s => speciesName(party[s].species)
	};
	const left = A.actionsFor(0, B[0], moveInfo, party, onField, alive, opts);
	const right = A.actionsFor(2, B[2], moveInfo, party, onField, alive, opts);
	const all = A.jointActions(left, right, asked);
	console.log('legal joint actions: ' + all.length
		+ '  (' + left.length + ' for ' + speciesName(B[0].species) + ', ' + right.length + ' for ' + speciesName(B[2].species) + ')');

	const play = flag('all') ? all : A.portfolio(all, rankOf, BUDGET);
	const gaps = A.coverageGaps(all, play);
	console.log('playing ' + play.length + ' of them on the hidden game, ' + D.CONC + ' at a time'
		+ (flag('all') ? '' : ' (coverage first, then shapes, then the hardest hitters)'));
	if (!flag('all')) console.log('coverage: every legal action of ours is represented'
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
		rows.push({pair: play[i], sum, v: score(sum), r});
	});
	const good = rows.filter(x => !x.bad).sort((a, b) => b.v - a.v);
	const bad = rows.filter(x => x.bad);

	const label = p => [p.a0 ? speciesName(B[0].species) + ' ' + p.a0.label : null,
		p.a2 ? speciesName(B[2].species) + ' ' + p.a2.label : null].filter(Boolean).join('  +  ');

	console.log('\nbest ' + Math.min(8, good.length) + ' of ' + good.length + ' played, in ' + secs + ' s:\n');
	good.slice(0, 8).forEach((x, i) => {
		const s = x.sum;
		const took = s.ourLost ? 'we lose ' + s.ourLost : 'we lose nothing';
		const dealt = s.theirLost ? 'they lose ' + s.theirLost : 'they lose nothing';
		console.log('  ' + String(Math.round(x.v)).padStart(6) + '  ' + label(x.pair));
		console.log('          ' + dealt + (s.theirDead ? ' and ' + s.theirDead + ' Pokemon' : '')
			+ ', ' + took + (s.ourDead ? ' and ' + s.ourDead + ' Pokemon' : '')
			+ (s.ourHealed ? ', we heal ' + s.ourHealed : '')
			+ (s.forced ? ', then we must send someone in' : ''));
	});
	if (bad.length) {
		console.log('\n' + bad.length + ' thrown away: ' + bad.slice(0, 3).map(x => label(x.pair) + ' (' + x.bad + ')').join('; '));
	}

	if (DEPTH >= 2 && good.length) {
		// A line that only defers has to show its second turn. For the top few,
		// play the after-state forward with each of our own best replies and
		// judge on the two-turn total.
		const K = Math.min(3, good.length);
		console.log('\nsecond turn, played for real, for the top ' + K + ':');
		const os = require('os');
		for (let i = 0; i < K; i++) {
			const x = good[i];
			const tmp = path.join(os.tmpdir(), 'rr-doubles-d2-' + process.pid + '-' + i + '.ss');
			const again = await D.probe(STATE, x.pair, {save: tmp});
			if (!again.after || again.after.screen !== 'action') {
				console.log('  ' + label(x.pair) + ': no second decision to make (' + (again.after ? again.after.screen : 'error') + ')');
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
			console.log('  ' + String(Math.round(best)).padStart(6) + '  ' + label(x.pair) + '  then  ' + bestLabel);
			try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
		}
	}

	if (good.length) {
		console.log('\nRECOMMENDATION: ' + label(good[0].pair));
	}
}

main().catch(e => { console.error(e); process.exit(1); });
