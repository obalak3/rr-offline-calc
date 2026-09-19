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
const {execFileSync, execFile} = require('child_process');
const H = require('./lib/harness.js');
const P = require('./lib/doubles-position.js');

const args = process.argv.slice(2);
const STATE = args.find(a => !a.startsWith('--'));
const val = (n, d) => {
	const i = args.indexOf('--' + n);
	if (i < 0) return d;
	const raw = args[i + 1];
	const v = Number(raw);
	// A bad value used to become NaN, and NaN is falsy, so `--keep <garbage>`
	// silently ran an EXHAUSTIVE search and looked like a cheap one that agreed
	// with everything. Refuse instead.
	if (raw === undefined || raw.startsWith('--') || !Number.isFinite(v)) {
		console.error('bad value for --' + n + ': ' + raw);
		process.exit(2);
	}
	return v;
};
const DEPTH = val('depth', 3);
const KEEP = val('keep', 3);
const BUDGET = val('budget', 400);
// James's own shape, 2026-09-19: "Run the current plan for 5 turns, or until
// either infernape dies or our pokemon dies. Then if that plan now looks bad,
// run the second plan for a few more turns." Best-first rather than uniform:
// the root is opened wide, each candidate is followed NARROW until something
// actually resolves, and we only pay for the next candidate if the last one
// disappointed.
const RESOLVE = args.includes('--resolve');       // stop a branch once it resolves
const BESTFIRST = args.includes('--bestfirst');   // follow the leading line narrowly
const CWIDTH = val('cwidth', 2);          // how wide the continuation stays
const MAXTURNS = val('turns', 6);
// Every probe is an independent process and this machine has eight cores, so
// the serial searcher was leaving almost all of them idle. The tree is
// naturally parallel level by level: every child of every node on the frontier
// can be played at once.
const PAR = val('par', 8);
const BEAM = val('beam', 0);              // 0 = keep every surviving node
// NEVER PRUNE THE ROOT. The root is the decision we actually make; everything
// below it is only there to judge it. Measured 2026-09-19 on a position where
// Greninja sat at 23/139 against a fresh Kangaskhan: the pruned search offered
// a switch costing 44 HP while a switch costing NOTHING existed, because the
// switch ranker scores by the opponent's worst plausible hit and Skeledirge is
// a Ghost that Kangaskhan's Crunch hits for double -- so it ranked badly, while
// in the real game Kangaskhan used a Normal move Skeledirge is immune to.
// Predicting their move is exactly what this whole approach exists to avoid;
// at the root we can simply play them all.
const ROOTKEEP = val('rootkeep', 0);      // 0 = every legal action at the root

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

/** The same probe, asynchronously, so a whole level can run at once. */
function playAsync(state, action, saveTo) {
	probes++;
	const a = [ROM, state, action.type === 'switch' ? 'switch' : 'move', String(action.index)];
	if (saveTo) a.push('--save', saveTo);
	return new Promise(resolve => {
		execFile(BIN, a, {encoding: 'utf8', maxBuffer: 1 << 22, timeout: 25000}, (err, stdout) => {
			const r = {error: null};
			String(stdout || '').split('\n').forEach(l => {
				l = l.trim(); if (!l) return;
				let j; try { j = JSON.parse(l); } catch (e) { return; }
				if (j.error) r.error = j.error; else if (j.at) r[j.at] = j;
			});
			resolve(r);
		});
	});
}

/** Run jobs with a fixed number in flight. */
async function pool(jobs, width, fn) {
	const out = new Array(jobs.length);
	let next = 0;
	await Promise.all(new Array(Math.min(width, jobs.length)).fill(0).map(async () => {
		for (;;) {
			const i = next++;
			if (i >= jobs.length) return;
			out[i] = await fn(jobs[i], i);
		}
	}));
	return out;
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
	// SWITCHES ARE RANKED BY WHAT THEY TAKE, NOT BY WHAT THEY DEAL, and they get
	// their own budget rather than competing with moves.
	//
	// MEASURED 2026-09-19, and it refutes what this file said yesterday. At depth
	// 2 pruning to the top three by damage matched the exhaustive answer on every
	// position tried, so "prune hard in singles, it is free" looked safe. At
	// depth 3 the exhaustive search found Scald, switch to Victreebel, Leaf
	// Storm: the same kill for 5 HP instead of 45. The pruned search never found
	// it, because a switch deals no damage, so ranking everything together by
	// damage means switches are only ever tried when there are fewer than `keep`
	// moves -- which is never. The pruner was structurally blind to an entire
	// kind of action.
	//
	// Same lesson as doubles, arrived at from the other direction: prune by
	// SHAPE, never by a single score across shapes.
	const switches = [];
	(obs.party || []).forEach((p, slot) => {
		if (!p || !p.maxhp || p.hp <= 0) return;
		const raw = Buffer.from(p.raw, 'hex');
		const sp = raw.readUInt16LE(0x20);
		if (sp === me.species && p.hp === me.hp) return;    // already out
		// What the opponent's best move would do to this one on arrival. Cheap,
		// and it is the question a switch is actually about.
		let takes = Infinity;
		try {
			const inc = P.setFromRecord(engine, dex, p);
			const theirs = P.setFromBattler(dex, foe);
			if (inc && theirs) {
				const probe = engine.B.createState([inc], [theirs], {});
				probe.foe.team[0].curHP = foe.hp;
				takes = 0;
				(foe.moves || []).forEach(mid => {
					if (!mid) return;
					try {
						const r = engine.B.damageRolls(probe, 'foe', mv(mid));
						if (r && !r.immune && r.noCrit && r.noCrit.length) {
							takes = Math.max(takes, r.noCrit[Math.floor(r.noCrit.length / 2)]);
						}
					} catch (e) { /* unknown move */ }
				});
				takes = takes / Math.max(1, p.hp);          // as a fraction of what it has
			}
		} catch (e) { takes = Infinity; }
		switches.push({type: 'switch', index: slot, label: '-> ' + nm(sp), dmg: -1, kills: false, takes});
	});

	if (!keep) return acts.concat(switches);                 // exhaustive reference
	const killers = acts.filter(a => a.kills);
	const rest = acts.filter(a => !a.kills).sort((x, y) => y.dmg - x.dmg);
	const out = killers.slice();
	for (const a of rest) { if (out.length >= keep) break; out.push(a); }
	// A separate budget for switches, cheapest arrival first, so an entire kind
	// of action can never be ranked out of existence.
	const swKeep = Math.max(1, Math.round(keep * (Number(process.env.RR_SWITCH_SHARE || 0.66))));
	switches.sort((x, y) => x.takes - y.takes).slice(0, swKeep).forEach(a => out.push(a));
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
			// RESOLVE-STOPPING, James's rule applied to every branch rather than
			// only the leading one: once their Pokemon is removed and none of ours
			// is spent, that branch has answered the question and nothing under it
			// is worth a probe.
			if (RESOLVE && o.theirDead > 0 && o.theirStanding > 0) {
				const c = {line, total, turns: line.length};
				if (!best || total.theirDead > best.total.theirDead
					|| (total.theirDead === best.total.theirDead && total.ourLost < best.total.ourLost)) best = c;
				try { fs.unlinkSync(child); } catch (e) {}
				continue;
			}
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
				// ZERO FAINTS IS THE TARGET, so once the same number of theirs is
				// removed, the CHEAPER line wins. Ordering damage dealt above damage
				// taken made a depth-5 search prefer a line costing 79 HP over one
				// costing 5 for the same removal, purely because it also chipped a
				// second Pokemon on the way.
				if (x.total.ourLost !== y.total.ourLost) return x.total.ourLost < y.total.ourLost;
				return x.total.theirLost > y.total.theirLost;
			};
			const cand = {line, total, turns: line.length};
			if (better(cand, best)) best = cand;
			if (depthLeft > 1 && r.obs && r.after.screen === 'action') {
				walk(child, r.obs, r.after, depthLeft - 1, line, total);
			}
			try { fs.unlinkSync(child); } catch (e) {}
		}
	};

	// LEVEL BY LEVEL, IN PARALLEL. Same tree, same pruning, same objective; the
	// only change is that every child of every node on the frontier is played at
	// once instead of one after another. Nothing about the search changes, so if
	// this finds a different answer than the serial version, something is wrong.
	const levelSearch = async () => {
		let frontier = [{state: STATE, obs: root.obs, before: root.before,
			line: [], acc: {ourLost: 0, theirLost: 0, ourDead: 0, theirDead: 0}, own: false}];
		for (let d = 0; d < DEPTH && frontier.length && probes < BUDGET; d++) {
			const jobs = [];
			frontier.forEach(node => keepSet(node.obs, d === 0 ? ROOTKEEP : KEEP).forEach(a => jobs.push({node, a})));
			if (!jobs.length) break;
			const results = await pool(jobs, PAR, async (job, i) => {
				if (probes >= BUDGET) return null;
				const child = path.join(tmp, 'L' + d + '_' + i + '.ss');
				const r = await playAsync(job.node.state, job.a, child);
				return {job, r, child};
			});
			const nextFrontier = [];
			for (const res of results) {
				if (!res) continue;
				const {job, r, child} = res;
				if (r.error || !r.after) { try { fs.unlinkSync(child); } catch (e) {} continue; }
				const o = outcome(job.node.before, r.after);
				if (!o) { try { fs.unlinkSync(child); } catch (e) {} continue; }
				const line = job.node.line.concat([job.a.label]);
				const total = {
					ourLost: job.node.acc.ourLost + o.ourLost, theirLost: job.node.acc.theirLost + o.theirLost,
					ourDead: job.node.acc.ourDead + o.ourDead, theirDead: job.node.acc.theirDead + o.theirDead
				};
				const keepBest = c => {
					if (!best || c.total.theirDead > best.total.theirDead
						|| (c.total.theirDead === best.total.theirDead && c.total.ourLost < best.total.ourLost)
						|| (c.total.theirDead === best.total.theirDead && c.total.ourLost === best.total.ourLost
							&& c.total.theirLost > best.total.theirLost)) best = c;
				};
				if (total.ourDead > 0) { dead++; try { fs.unlinkSync(child); } catch (e) {} continue; }
				if (o.theirStanding === 0) { wins++; keepBest({line, total, turns: line.length, won: true}); try { fs.unlinkSync(child); } catch (e) {} continue; }
				keepBest({line, total, turns: line.length});
				if (RESOLVE && o.theirDead > 0) { try { fs.unlinkSync(child); } catch (e) {} continue; }
				if (d + 1 < DEPTH && r.obs && r.after.screen === 'action') {
					nextFrontier.push({state: child, obs: r.obs, before: r.after, line, acc: total, own: true});
				} else { try { fs.unlinkSync(child); } catch (e) {} }
			}
			// A beam keeps only the most promising nodes alive, which is the other
			// obvious lever on cost; 0 keeps everything.
			let survivors = nextFrontier;
			if (BEAM && survivors.length > BEAM) {
				// THE BEAM RANKS BY PROGRESS, NOT BY NET HP.
				//
				// It used to score a node as (damage dealt minus damage taken), and
				// that systematically preferred doing nothing: a switch that deals 0
				// and takes 0 scores zero, which beats an attack that deals 35 and
				// takes 40. So the aggressive branches -- the only ones that ever
				// reach a removal -- were cut first, and the search would report
				// "nothing removed, nothing lost" as its best while an exhaustive
				// search on the same position removed one. That was 3 of the 5
				// disagreements in the 16-position battery, and widening the beam did
				// not help because width was never the problem.
				//
				// The objective is to remove theirs without losing ours, and the
				// faint-cut has already deleted every branch that loses one. So
				// progress toward a removal comes first and cost is the tiebreak.
				survivors.sort((x, y) => (y.acc.theirLost - x.acc.theirLost) || (x.acc.ourLost - y.acc.ourLost));
				survivors.slice(BEAM).forEach(n => { try { fs.unlinkSync(n.state); } catch (e) {} });
				survivors = survivors.slice(0, BEAM);
			}
			frontier.forEach(n => { if (n.own) { try { fs.unlinkSync(n.state); } catch (e) {} } });
			frontier = survivors;
		}
		frontier.forEach(n => { if (n.own) { try { fs.unlinkSync(n.state); } catch (e) {} } });
	};

	if (BESTFIRST) {
		// Open the root wide, then follow each candidate narrowly until it
		// resolves. Stop early the moment a line removes their Pokemon without
		// costing us one -- that is the objective met, and nothing cheaper is
		// going to beat it.
		const roots = keepSet(root.obs, KEEP);
		let tried = 0;
		for (const a of roots) {
			if (probes >= BUDGET) break;
			tried++;
			let stateFile = STATE, obs = root.obs, before = root.before;
			const line = [], acc = {ourLost: 0, theirLost: 0, ourDead: 0, theirDead: 0};
			let act = a, resolved = null;
			for (let t = 0; t < MAXTURNS && probes < BUDGET; t++) {
				const child = path.join(tmp, 'r' + probes + '.ss');
				const r = play(stateFile, act, child);
				if (r.error || !r.after) { resolved = 'the core could not play it'; break; }
				const o = outcome(before, r.after);
				line.push(act.label);
				acc.ourLost += o.ourLost; acc.theirLost += o.theirLost;
				acc.ourDead += o.ourDead; acc.theirDead += o.theirDead;
				if (stateFile !== STATE) { try { fs.unlinkSync(stateFile); } catch (e) {} }
				stateFile = child; obs = r.obs; before = r.after;
				if (acc.ourDead > 0) { resolved = 'we lose one'; dead++; break; }
				if (o.theirStanding === 0) { resolved = 'the fight is won'; wins++; break; }
				if (o.theirDead > 0) { resolved = 'their Pokemon is removed'; break; }
				if (r.after.screen !== 'action' || !r.obs) { resolved = 'no further decision'; break; }
				// Narrow continuation, still shape-aware so a switch can appear
				// mid-line -- which is exactly the line depth 3 found.
				const next = keepSet(r.obs, CWIDTH);
				if (!next.length) { resolved = 'nothing legal'; break; }
				act = next[0];
			}
			try { fs.unlinkSync(stateFile); } catch (e) {}
			const cand = {line, total: acc, turns: line.length, why: resolved};
			const good = acc.ourDead === 0 && acc.theirDead > 0;
			const better = !best || (good && !(best.total.ourDead === 0 && best.total.theirDead > 0))
				|| (acc.theirDead > best.total.theirDead)
				|| (acc.theirDead === best.total.theirDead && acc.ourDead === best.total.ourDead && acc.ourLost < best.total.ourLost);
			if (better) best = cand;
			console.log('  ' + String(a.label).padEnd(18) + line.join(' -> ').padEnd(46)
				+ '  ' + resolved + '  [they -' + acc.theirLost + ', we -' + acc.ourLost + ']');
			// Good enough: their Pokemon gone and nobody of ours spent.
			if (good && acc.ourLost === 0) { console.log('  (stopping: the objective is met and nothing cheaper can beat it)'); break; }
		}
		console.log('\n  root candidates opened: ' + tried + ' of ' + roots.length);
	} else if (PAR > 1) {
		return levelSearch().then(report);
	} else {
		walk(STATE, root.obs, root.before, DEPTH, [], {ourLost: 0, theirLost: 0, ourDead: 0, theirDead: 0});
	}

	report();
	function report() {
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
}

run();
