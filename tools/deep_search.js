'use strict';
/**
 * SEARCHING THE REAL GAME, to find out what shape of search is worth paying for.
 *
 * James, 2026-09-19: "The reason more search always was worse was because we
 * didn't have the data. We were working on predictions... In this case we have
 * 100% data." He is right, and it is now measured: from a save state the fight
 * is a deterministic function of OUR action sequence alone, verified by playing
 * the same action at nine different delays through the oracle's press path and
 * getting the same result every time. So this is not a game tree with an
 * adversary in it -- there is exactly one continuation per sequence we choose,
 * which makes it single-agent search over a deterministic function.
 *
 * Two consequences the search is built on:
 *
 *   1. ZERO FAINTS IS THE OBJECTIVE, so any node where one of ours dies is dead
 *      and so is everything under it. That is not a heuristic, it is the goal,
 *      and it does most of the pruning for free.
 *   2. THE ONLY REMAINING SOURCE OF ERROR IS THE KEEP-SET. Nothing is predicted
 *      any more, so a line can only be missed by never being tried. That makes
 *      the pruner's recall the thing to measure, not the depth.
 *
 * Every probe goes through the oracle, never a hand-written press script: a
 * press driven by outcome registers exactly one press, a press driven by a
 * timer does not, and that difference is what made an earlier test look like
 * the game was non-deterministic when it was not.
 *
 *   node tools/deep_search.js <state.ss> [--depth N] [--keep N] [--budget N]
 *
 *   --keep 0   keep EVERY legal action at every node: the exhaustive reference
 *              any pruning has to be judged against.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const H = require('./lib/harness.js');
const P = require('./lib/doubles-position.js');

const args = process.argv.slice(2);
const STATE = args.find(a => !a.startsWith('--'));
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const DEPTH = val('depth', 3);
const KEEP = val('keep', 3);
const BUDGET = val('budget', 400);

const ROM = process.env.RR_ROM || path.join(process.env.HOME, 'RadicalRed-mGBA', 'RadicalRed.gba');
const BIN = path.join(__dirname, 'headless', 'oracle');

if (!STATE || !fs.existsSync(STATE)) { console.error('usage: node tools/deep_search.js <state.ss>'); process.exit(2); }
if (!fs.existsSync(BIN) || !fs.existsSync(ROM)) { console.error('the hidden core or the ROM is missing'); process.exit(2); }

const engine = H.loadEngine();
const dex = H.loadDex();
const nm = id => { const r = dex.byID[id]; return r ? (r.key || r.name) : ('#' + id); };
const mv = id => dex.moveName[id] || ('move ' + id);

let probes = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-deep-'));

/** One action on the real game, through the oracle's own press path. */
function play(state, action, saveTo) {
	probes++;
	const a = [ROM, state, action.type === 'switch' ? 'switch' : 'move', String(action.index)];
	if (saveTo) a.push('--save', saveTo);
	let out = '';
	try { out = execFileSync(BIN, a, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 25000}); }
	catch (e) { out = e.stdout ? String(e.stdout) : ''; }
	const r = {error: null};
	out.split('\n').forEach(l => { l = l.trim(); if (!l) return; let j; try { j = JSON.parse(l); } catch (e) { return; } if (j.error) r.error = j.error; else if (j.at) r[j.at] = j; });
	return r;
}

/** What changed, in the only terms the objective cares about. */
function outcome(before, after) {
	if (!before || !after) return null;
	const pair = (b, a) => {
		const used = new Set(), rows = [];
		(b || []).forEach((p, i) => {
			let j = (a || []).findIndex((q, k) => !used.has(k) && q[1] === p[1]);
			if (j < 0) j = i; used.add(j);
			rows.push({max: p[1], hp0: p[0], hp1: a && a[j] ? a[j][0] : p[0]});
		});
		return rows;
	};
	const ours = pair(before.party, after.party), theirs = pair(before.foeparty, after.foeparty);
	return {
		ourDead: ours.filter(x => x.hp0 > 0 && x.hp1 === 0).length,
		theirDead: theirs.filter(x => x.hp0 > 0 && x.hp1 === 0).length,
		ourLost: ours.reduce((s, x) => s + Math.max(0, x.hp0 - x.hp1), 0),
		theirLost: theirs.reduce((s, x) => s + Math.max(0, x.hp0 - x.hp1), 0),
		theirStanding: theirs.filter(x => x.hp1 > 0).length,
		ourStanding: ours.filter(x => x.hp1 > 0).length
	};
}

/**
 * The keep-set: which actions are worth playing at this node.
 *
 * Generous on purpose. Nothing is predicted any more, so the ONLY way to miss a
 * line is to never try it, and the engine's damage numbers are known to be off
 * in at least one measured case (Drain Punch into Pawmot, 62-81% of predicted).
 * So: anything the engine thinks kills, the top few by damage, and every switch
 * into a resistance -- rather than the single best number.
 */
function keepSet(obs, keep) {
	const acts = [];
	const me = obs.me, foe = obs.foe;
	let st = null;
	try {
		const mine = P.setFromBattler(dex, me), theirs = P.setFromBattler(dex, foe);
		if (mine && theirs) {
			st = engine.B.createState([mine], [theirs], {});
			st.me.team[0].curHP = me.hp; st.foe.team[0].curHP = foe.hp;
		}
	} catch (e) { st = null; }

	(me.moves || []).forEach((id, i) => {
		if (!id) return;
		if (me.pp && me.pp[i] === 0) return;
		let dmg = 0, kills = false;
		if (st) {
			try {
				const r = engine.B.damageRolls(st, 'me', mv(id));
				if (r && !r.immune && r.noCrit && r.noCrit.length) {
					dmg = r.noCrit[Math.floor(r.noCrit.length / 2)];
					kills = dmg >= foe.hp;
				}
			} catch (e) { /* unknown move: keep it, do not judge it */ dmg = 0; }
		}
		acts.push({type: 'move', index: i, label: mv(id), dmg, kills});
	});
	// Switches are kept but never ranked by damage; a switch is about what it
	// takes, not what it deals, and that is exactly what the real game reports.
	(obs.party || []).forEach((p, slot) => {
		if (!p || !p.maxhp || p.hp <= 0) return;
		const raw = Buffer.from(p.raw, 'hex');
		const sp = raw.readUInt16LE(0x20);
		if (sp === me.species && p.hp === me.hp) return;    // already out
		acts.push({type: 'switch', index: slot, label: '-> ' + nm(sp), dmg: -1, kills: false});
	});

	if (!keep) return acts;                                  // exhaustive reference
	const killers = acts.filter(a => a.kills);
	const rest = acts.filter(a => !a.kills).sort((x, y) => y.dmg - x.dmg);
	const out = killers.slice();
	for (const a of rest) { if (out.length >= keep) break; out.push(a); }
	return out;
}

function run() {
	// Read the root position once.
	let out = '';
	try { out = execFileSync(BIN, [ROM, STATE, 'peek'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}); } catch (e) { out = ''; }
	const root = {};
	out.split('\n').forEach(l => { l = l.trim(); if (!l) return; let j; try { j = JSON.parse(l); } catch (e) { return; } if (j.at) root[j.at] = j; });
	if (!root.obs) { console.error('could not read that state as a battle'); process.exit(1); }

	console.log('\n' + nm(root.obs.me.species) + ' ' + root.obs.me.hp + '/' + root.obs.me.maxhp
		+ '  vs  ' + nm(root.obs.foe.species) + ' ' + root.obs.foe.hp + '/' + root.obs.foe.maxhp);
	console.log('depth ' + DEPTH + ', keep ' + (KEEP || 'ALL (exhaustive)') + ', budget ' + BUDGET + ' probes\n');

	let best = null, dead = 0, wins = 0;
	const t0 = Date.now();

	const walk = (stateFile, obs, before, depthLeft, trail, acc) => {
		if (probes >= BUDGET) return;
		const acts = keepSet(obs, KEEP);
		for (const a of acts) {
			if (probes >= BUDGET) return;
			const child = path.join(tmp, 'n' + probes + '.ss');
			const r = play(stateFile, a, child);
			if (r.error || !r.after) continue;
			const o = outcome(before, r.after);
			if (!o) continue;
			const line = trail.concat([a.label]);
			const total = {
				ourLost: acc.ourLost + o.ourLost, theirLost: acc.theirLost + o.theirLost,
				ourDead: acc.ourDead + o.ourDead, theirDead: acc.theirDead + o.theirDead
			};
			// THE OBJECTIVE PRUNES. A branch that spends one of ours is dead and
			// nothing under it is worth a probe.
			if (total.ourDead > 0) { dead++; try { fs.unlinkSync(child); } catch (e) {} continue; }
			if (o.theirStanding === 0) {
				wins++;
				const w = {line, total, turns: line.length, won: true};
				if (!best || !best.won || total.ourLost < best.total.ourLost) best = w;
				try { fs.unlinkSync(child); } catch (e) {}
				continue;
			}
			// Their active removed and nobody lost: a good place to stop looking.
			// Better means: removes more of theirs, then takes more off them, then
			// costs us less. Nobody is lost in any surviving branch, because the
			// objective already cut those.
			const better = (x, y) => {
				if (!y) return true;
				if (x.total.theirDead !== y.total.theirDead) return x.total.theirDead > y.total.theirDead;
				if (x.total.theirLost !== y.total.theirLost) return x.total.theirLost > y.total.theirLost;
				return x.total.ourLost < y.total.ourLost;
			};
			const cand = {line, total, turns: line.length};
			if (better(cand, best)) best = cand;
			if (depthLeft > 1 && r.obs && r.after.screen === 'action') {
				walk(child, r.obs, r.after, depthLeft - 1, line, total);
			}
			try { fs.unlinkSync(child); } catch (e) {}
		}
	};

	walk(STATE, root.obs, root.before, DEPTH, [], {ourLost: 0, theirLost: 0, ourDead: 0, theirDead: 0});

	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	console.log('probes: ' + probes + '   time: ' + secs + ' s   branches cut for losing one of ours: ' + dead
		+ (wins ? '   lines that won outright: ' + wins : ''));
	if (best) {
		console.log('\nbest line found (' + best.turns + ' turn' + (best.turns > 1 ? 's' : '') + '):');
		console.log('  ' + best.line.join('  ->  '));
		console.log('  they lose ' + best.total.theirLost + ' and ' + best.total.theirDead + ' Pokemon; we lose '
			+ best.total.ourLost + ' and ' + best.total.ourDead);
	} else {
		console.log('\nno line survived the search.');
	}
	try { fs.rmSync(tmp, {recursive: true, force: true}); } catch (e) {}
}

run();
