'use strict';
/**
 * THE GAME AS ITS OWN ORACLE. tools/headless/oracle is a windowless mGBA core
 * that loads a save state taken on our action menu, plays one action exactly
 * as the actuator would press it, and reports what actually happened. Because
 * this ROM's battle RNG is consumed per call and restored by the state, what
 * the oracle sees for an action is what the live game will do for the same
 * action. Nothing is ever shown on James's screen (his rule, 2026-09-08).
 *
 *   probe(state, {type:'move', index}|{type:'switch', index}, {save}) -> {before, after, error}
 *   probeAll(state, actions)                                        -> [{action, ...}]
 */
const path = require('path');
const fs = require('fs');
const {execFile} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'tools', 'headless', 'oracle');
const ROM = process.env.RR_ROM || path.join(process.env.HOME, 'RadicalRed-mGBA', 'RadicalRed.gba');

function available() {
	try { return fs.existsSync(BIN) && fs.existsSync(ROM); } catch (e) { return false; }
}

function probe(state, action, opts) {
	opts = opts || {};
	return new Promise(resolve => {
		const args = [ROM, state, action.type === 'switch' ? 'switch' : 'move', String(action.index)];
		if (opts.save) args.push('--save', opts.save);
		if (opts.frames) args.push('--frames', String(opts.frames));
		execFile(BIN, args, {timeout: opts.timeout || 20000, maxBuffer: 1 << 20}, (err, stdout, stderr) => {
			const out = {action, before: null, committed: null, after: null, error: null};
			String(stdout || '').split('\n').forEach(line => {
				line = line.trim(); if (!line) return;
				let j; try { j = JSON.parse(line); } catch (e) { return; }
				if (j.error) out.error = j.error;
				else if (j.at) out[j.at] = j;
			});
			if (err && !out.error) out.error = (stderr || String(err)).trim().split('\n')[0];
			resolve(out);
		});
	});
}

function probeAll(state, actions, opts) {
	return Promise.all(actions.map(a => probe(state, a, opts)));
}

/** What a probe result says in the planner's terms. */
function summarize(r) {
	if (!r || !r.before || !r.after) return {ok: false, error: r && r.error};
	const b = r.before, a = r.after;
	const ourDead = a.party.filter((p, i) => b.party[i][0] > 0 && p[0] === 0).length;
	const theirDead = a.foeparty.filter((p, i) => b.foeparty[i][0] > 0 && p[0] === 0).length;
	const ourHp = a.party.reduce((s, p) => s + p[0], 0), ourHpBefore = b.party.reduce((s, p) => s + p[0], 0);
	const theirHp = a.foeparty.reduce((s, p) => s + p[0], 0), theirHpBefore = b.foeparty.reduce((s, p) => s + p[0], 0);
	return {ok: true, ourDead, theirDead, ourLost: ourHpBefore - ourHp, theirLost: theirHpBefore - theirHp,
		activeDied: b.me.hp > 0 && (a.me.species !== b.me.species ? false : a.me.hp === 0),
		foeSwitched: a.foe.species !== b.foe.species, screen: a.screen, over: a.screen === 'nobattle'};
}

module.exports = {available, probe, probeAll, summarize, BIN, ROM};
