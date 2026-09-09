'use strict';
// REGRESSION: James, 2026-09-08 -- "the growl is unacceptable". Turn 229 of the
// Erika-route fight: Toxtricity in front of Mega Venusaur, a special attacker,
// and the planner used Growl. A stat move that changes nothing measurable must
// never reach the market. This replays that exact position through the live
// planner (agent.js --probe) and fails if any Attack-drop line is offered or
// Growl is chosen.
const {execFileSync} = require('child_process');
const path = require('path');
const fx = path.join(__dirname, '..', 'tests', 'fixtures');
const env = Object.assign({}, process.env, {EXPENDABLE: '', RR_DEBUG_LEVERS: '1', RR_PROBE_LINES: '12',
	RR_PROBE_PREV: path.join(fx, 'growl_vs_mega_venusaur_prev.json')});
const out = execFileSync('node', [path.join(__dirname, 'agent.js'), '--probe', path.join(fx, 'growl_vs_mega_venusaur.json')],
	{env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000});
const chosen = (out.match(/chooseAction -> .*/) || [''])[0];
const offered = out.split('\n').filter(l => /^\s+\d+\. /.test(l));
const atkLines = offered.filter(l => /their atk -/.test(l));
const gated = (out.match(/vs Venusaur-Mega: their atk -[123]: changes nothing measurable/g) || []).length;
let fail = 0;
if (/Growl/.test(chosen)) { console.log('FAIL  Growl chosen: ' + chosen); fail++; }
if (atkLines.length) { console.log('FAIL  Attack-drop lines offered vs Mega Venusaur:\n' + atkLines.join('\n')); fail++; }
if (!gated) { console.log('FAIL  the measured gate never fired for their atk -N vs Venusaur-Mega'); fail++; }
console.log((fail ? 'FAIL ' : 'PASS ') + 'growl vs Mega Venusaur: ' + chosen.replace('chooseAction -> ', '').slice(0, 90)
	+ ' | ' + offered.length + ' lines offered, ' + atkLines.length + ' atk-drop, gate fired ' + gated + 'x');
process.exit(fail ? 1 : 0);
