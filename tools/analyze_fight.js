/**
 * Read a fight the way James reads it: turn by turn, what we believed, what we
 * did, what actually happened, and where the plan changed under us.
 *
 * Run: node tools/analyze_fight.js <turns-dir> [fromTurn] [toTurn]
 *
 * Sources: the archived turn JSONs (obs, plan, planJobs, played, predicted) and
 * the node log's "resolved" lines when present. Prints:
 *   - each turn: ours (hp/status) vs theirs (hp), their committed move (byte),
 *     our prediction, the plan sentence, the action played, damage resolved
 *   - PLAN CHANGED markers when the plan sentence changes without a faint
 *   - DEATH markers, PANEL ASK markers (turns with no archive between two
 *     archived turns are asks/waits)
 * Numbers alone are not the point; the sequence is.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const dex = H.loadDex();
const nm = id => (dex.byID[id] && (dex.byID[id].key || dex.byID[id].name)) || ('#' + id);
const mv = id => dex.moveName[id] || (id ? '#' + id : '-');

const dir = process.argv[2];
const from = Number(process.argv[3] || 0), to = Number(process.argv[4] || 1e9);
if (!dir) { console.log('usage: node tools/analyze_fight.js <turns-dir> [from] [to]'); process.exit(1); }

let nodeLog = '';
try { nodeLog = fs.readFileSync(path.join(process.env.HOME, 'rr-agent/agent-node.log'), 'utf8'); } catch (e) { nodeLog = ''; }
const resolved = {};
for (const m of nodeLog.matchAll(/turn (\d+) resolved: (.*)/g)) resolved[Number(m[1])] = m[2];
const asks = {};
for (const m of nodeLog.matchAll(/turn (\d+): the plan expects to lose ([^\n]*)/g)) asks[Number(m[1])] = m[2];

const files = fs.readdirSync(dir).filter(f => /^turn\d+\.json$/.test(f)).sort();
let lastPlan = null, lastTurn = null, deaths = [];
for (const f of files) {
	let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
	const o = r.obs || r; if (!o.me) continue;
	if (o.turn < from || o.turn > to) continue;
	if (lastTurn !== null && o.turn > lastTurn + 1) {
		for (let t = lastTurn + 1; t < o.turn; t++) if (asks[t]) console.log('   ~~ turn ' + t + ': PANEL ASK -- ' + asks[t]);
	}
	const their = o.ai_action === 1 ? 'SWITCH->' + o.ai_target : mv(o.foe.moves[o.ai_target]);
	const st = o.me.status ? ' [' + o.me.status + ']' : '';
	const plan = r.plan || '(no plan)';
	if (plan !== lastPlan && lastPlan !== null && !/forced/.test(o.kind)) console.log('   ** PLAN CHANGED');
	console.log('T' + String(o.turn).padStart(3) + ' ' + (o.kind === 'forced' ? 'FORCED ' : '')
		+ nm(o.me.species) + ' ' + o.me.hp + '/' + o.me.maxhp + st
		+ '  vs  ' + nm(o.foe.species) + ' ' + o.foe.hp + '/' + o.foe.maxhp
		+ '  | they: ' + their + (r.predicted && r.predicted !== their ? ' (we predicted ' + r.predicted + ')' : '')
		+ '\n      plan: ' + plan + (r.planJobs ? '   <- ' + r.planJobs.map(j => j.mon + ':' + (j.moves || []).join('>')).join(' | ') : '')
		+ '\n      played: ' + JSON.stringify(r.played) + (resolved[o.turn] ? '   resolved: ' + resolved[o.turn] : ''));
	if (o.kind === 'forced') { deaths.push('turn ' + o.turn + ': ' + nm(o.me.species) + ' fainted'); console.log('   !! DEATH: ' + nm(o.me.species)); }
	lastPlan = plan; lastTurn = o.turn;
}
console.log('\nDEATHS: ' + (deaths.length ? deaths.join('; ') : 'none'));
