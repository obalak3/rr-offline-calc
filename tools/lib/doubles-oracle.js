'use strict';
/**
 * THE HIDDEN ORACLE, DOUBLES. `tools/headless/doracle` answers BOTH of our
 * prompts on a windowless mGBA core and reports what the turn really did.
 * Because this ROM consumes its battle RNG per call and a save state restores
 * it, the answer for a pair of actions IS the live outcome for that pair --
 * the same bargain the singles oracle runs on, and the reason doubles is being
 * built on the real game rather than on a 2v2 port of the engine
 * (docs/PLAN-DOUBLES.md). Nothing is ever shown on James's screen.
 *
 *   probe(state, {a0, a2})            -> {before, after, obs, error}
 *   probeAll(state, pairs)            -> results, CONC at a time
 *   summarize(r)                      -> what the turn did, in game terms
 *
 * An action is {type:'move', index, target} or {type:'switch', index}, where
 * `target` is a BATTLER index (1 their left, 3 their right, 2 our partner) and
 * may be omitted to leave the game's own default. `null` means that battler is
 * not expected to be asked, which is how a 2v1 position is described.
 */
const path = require('path');
const fs = require('fs');
const {execFile} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'tools', 'headless', 'doracle');
const ROM = process.env.RR_ROM || path.join(process.env.HOME, 'RadicalRed-mGBA', 'RadicalRed.gba');
// Four fast cores on this machine, and the emulator James is watching wants
// some of them too. Measured 2026-09-14: one full doubles turn is about 1.1 s,
// four at once 1.4 s, so sixteen land near 6 s inside his ~10 s budget.
const CONC = Number(process.env.RR_DORACLE_CONC || 4);

function available() {
	try { return fs.existsSync(BIN) && fs.existsSync(ROM); } catch (e) { return false; }
}

/** One action as doracle's command line spells it. */
function spec(a) {
	if (!a) return '-';
	if (a.type === 'switch') return 's' + a.index;
	return 'm' + a.index + (a.target === undefined || a.target === null ? '' : '@' + a.target);
}

/** What a pair of actions reads as in the log, for a human. */
function describe(pair, names) {
	const one = (a, who) => {
		if (!a) return null;
		const mine = names && names[who] ? names[who] + ' ' : '';
		if (a.type === 'switch') return mine + '-> ' + ((names && names.party && names.party[a.index]) || ('slot ' + a.index));
		const mv = (names && names.moves && names.moves[who] && names.moves[who][a.index]) || ('move ' + a.index);
		const at = a.target === undefined || a.target === null ? '' : ' at ' + ((names && names.battlers && names.battlers[a.target]) || ('battler ' + a.target));
		return mine + mv + at;
	};
	return [one(pair.a0, 0), one(pair.a2, 2)].filter(Boolean).join(' + ');
}

function probe(state, pair, opts) {
	opts = opts || {};
	return new Promise(resolve => {
		const args = [ROM, state, spec(pair.a0), spec(pair.a2)];
		if (opts.save) args.push('--save', opts.save);
		if (opts.frames) args.push('--frames', String(opts.frames));
		execFile(BIN, args, {timeout: opts.timeout || 30000, maxBuffer: 1 << 22}, (err, stdout, stderr) => {
			const out = {pair, before: null, after: null, obs: null, error: null};
			String(stdout || '').split('\n').forEach(line => {
				line = line.trim(); if (!line) return;
				let j; try { j = JSON.parse(line); } catch (e) { return; }
				if (j.error) out.error = j.error;
				else if (j.at === 'obs') out.obs = j;
				else if (j.at) out[j.at] = j;
			});
			if (err && !out.error) out.error = (stderr || String(err)).trim().split('\n')[0];
			resolve(out);
		});
	});
}

/** Run many pairs, CONC at a time, in the order given. */
async function probeAll(state, pairs, opts) {
	const out = new Array(pairs.length);
	let next = 0;
	const workers = new Array(Math.min(CONC, pairs.length)).fill(0).map(async () => {
		for (;;) {
			const i = next++;
			if (i >= pairs.length) return;
			out[i] = await probe(state, pairs[i], opts);
		}
	});
	await Promise.all(workers);
	return out;
}

/**
 * What the turn did, paired by MAX HP rather than by index: this ROM swaps
 * party slots when a Pokemon comes in, so before[i] and after[i] are not the
 * same Pokemon (the singles oracle lost Granbull to exactly that).
 */
function summarize(r) {
	if (!r || !r.before || !r.after) return {ok: false, error: r && r.error};
	const pair = (before, after) => {
		const used = new Set(), rows = [];
		(before || []).forEach((p, i) => {
			let j = (after || []).findIndex((q, k) => !used.has(k) && q[1] === p[1]);
			if (j < 0) j = i;
			used.add(j);
			rows.push({max: p[1], hp0: p[0], hp1: after && after[j] ? after[j][0] : p[0]});
		});
		return rows;
	};
	const ours = pair(r.before.party, r.after.party);
	const theirs = pair(r.before.foeparty, r.after.foeparty);
	const ourLost = ours.reduce((s, x) => s + Math.max(0, x.hp0 - x.hp1), 0);
	const theirLost = theirs.reduce((s, x) => s + Math.max(0, x.hp0 - x.hp1), 0);
	return {
		ok: true,
		ourDead: ours.filter(x => x.hp0 > 0 && x.hp1 === 0).length,
		theirDead: theirs.filter(x => x.hp0 > 0 && x.hp1 === 0).length,
		ourLost, theirLost,
		ourHealed: ours.reduce((s, x) => s + Math.max(0, x.hp1 - x.hp0), 0),
		// Who is standing afterwards, and whether the game is asking us again.
		field: r.after.battlers.map(b => ({species: b.species, hp: b.hp, maxhp: b.maxhp})),
		arrived: [0, 2].map(b => r.after.battlers[b] && r.after.battlers[b].species),
		asking: r.after.asking,
		screen: r.after.screen,
		over: r.after.screen === 'nobattle',
		forced: r.after.screen === 'party'
	};
}

/**
 * A switch probe is only believed if the Pokemon that came in is the one that
 * was asked for -- the guard the singles oracle needed after a mismatch fed
 * Granbull to a critical hit (2026-09-10). Max HP is the fingerprint; it
 * survives form changes, species ids do not.
 */
function arrivalOk(r, wantMaxBySlot) {
	if (!r || !r.after) return true;
	for (const [b, a] of [[0, r.pair.a0], [2, r.pair.a2]]) {
		if (!a || a.type !== 'switch') continue;
		const want = wantMaxBySlot[a.index];
		const got = r.after.battlers[b];
		if (want && got && Number(got.maxhp) !== Number(want)) return false;
	}
	return true;
}

module.exports = {available, probe, probeAll, summarize, spec, describe, arrivalOk, BIN, ROM, CONC};
