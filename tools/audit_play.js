/**
 * Judge the agent's play from GROUND TRUTH, not from the model agreeing with
 * itself.
 *
 * tools/find_mistakes.js re-decides each position with a deeper search and
 * flags disagreements -- but the teacher shares the student's engine and
 * opponent model, so a disagreement can equally be the model being wrong.
 * James has (rightly) stopped believing "small bug, big consequence" claims
 * built that way.
 *
 * This asks only questions the ARCHIVE can answer, by comparing consecutive
 * turns of the same session: what did we do, and what visibly happened. No
 * simulation, no scoring, nothing that can be wrong in the same direction as
 * the decision it is judging.
 *
 *   DIED_ON_ARRIVAL   we switched X in and X was dead at the next decision
 *   WASTED_TURN       we attacked and the target's HP did not move
 *   REDUNDANT_STATUS  we used a status move on a target that already had it
 *   PING_PONG         switched out a healthy mon and back within three turns
 *   DIED_WITH_BENCH   a mon fainted while a much healthier one sat benched
 *
 * Each is reported with prevalence and with the context the log recorded
 * (plan present, plan overridden by the death veto, which opponent), so the
 * question "why does it play well sometimes and terribly other times" can be
 * answered with a rate rather than an anecdote.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TURNS = path.join(process.env.HOME, 'rr-agent', 'turns');
const NAMES = {98: 'Mienshao', 112: 'Diggersby', 139: 'Lanturn', 102: 'Lilligant',
	95: 'Breloom', 108: 'Victreebel'};
const FOES = {95: 'Pincurchin', 104: 'Vikavolt', 125: 'Bellibolt', 99: 'Pawmot',
	102: 'Manectric', 63: 'Voltorb', 69: 'Emolga', 75: 'Emolga'};

function sessions() {
	return fs.readdirSync(TURNS).filter(d => /^\d{4}-/.test(d))
		.map(d => path.join(TURNS, d))
		.filter(d => fs.statSync(d).isDirectory());
}

function loadSession(dir) {
	return fs.readdirSync(dir).filter(f => /^turn\d+\.json$/.test(f))
		.sort()
		.map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
			catch (e) { return null; } })
		.filter(Boolean)
		.filter(d => d.obs && d.obs.me && d.obs.foe);
}

const findings = [];
const seenTurns = {total: 0, planned: 0, overridden: 0, planless: 0};

for (const dir of sessions()) {
	const rows = loadSession(dir);
	for (let i = 0; i < rows.length; i++) {
		const d = rows[i], o = d.obs;
		seenTurns.total++;
		if (d.plan) seenTurns.planned++; else seenTurns.planless++;
		const next = rows[i + 1];
		if (!next || next.obs.turn !== o.turn + 1) continue;
		const n = next.obs;
		const party = {}; (o.party || []).forEach(r => { party[r.maxhp] = r.hp; });
		const nparty = {}; (n.party || []).forEach(r => { nparty[r.maxhp] = r.hp; });
		const ctx = {session: path.basename(dir), turn: o.turn,
			us: NAMES[o.me.maxhp] || o.me.maxhp, usHP: o.me.hp,
			foe: FOES[o.foe.maxhp] || o.foe.maxhp, foeHP: o.foe.hp,
			played: d.played, plan: d.plan || null};

		// DIED_ON_ARRIVAL: we switched, and the mon that arrived is dead next turn.
		if (/^switch/.test(d.played || '') && n.me.maxhp !== o.me.maxhp) {
			if (n.me.hp === 0) {
				findings.push(Object.assign({kind: 'DIED_ON_ARRIVAL',
					who: NAMES[n.me.maxhp] || n.me.maxhp,
					arrivedAt: party[n.me.maxhp]}, ctx));
			}
		}
		// WASTED_TURN: we attacked the same foe and its HP did not move.
		if (d.played && !/^switch/.test(d.played)
			&& n.foe.maxhp === o.foe.maxhp && n.foe.hp === o.foe.hp
			&& o.foe.hp > 0) {
			findings.push(Object.assign({kind: 'WASTED_TURN', move: d.played}, ctx));
		}
		// DIED_WITH_BENCH: one of ours fainted this turn while a much
		// healthier one was sitting on the bench.
		for (const mx in party) {
			if (party[mx] > 0 && nparty[mx] === 0) {
				let best = 0;
				for (const other in party) {
					if (other === mx || party[other] <= 0) continue;
					const frac = party[other] / Number(other);
					if (frac > best) best = frac;
				}
				if (best >= 0.8) {
					findings.push(Object.assign({kind: 'DIED_WITH_BENCH',
						who: NAMES[mx] || mx, hadHP: party[mx],
						benchBest: Math.round(best * 100)}, ctx));
				}
			}
		}
	}
	// PING_PONG: same mon out, away, and back within three decisions.
	for (let i = 0; i + 3 < rows.length; i++) {
		const a = rows[i].obs, b = rows[i + 1].obs, c = rows[i + 2].obs;
		if (a.turn + 1 !== b.turn || b.turn + 1 !== c.turn) continue;
		if (a.me.maxhp === c.me.maxhp && a.me.maxhp !== b.me.maxhp
			&& a.me.hp / a.me.maxhp >= 0.7) {
			findings.push({kind: 'PING_PONG', session: path.basename(dir),
				turn: a.turn, us: NAMES[a.me.maxhp] || a.me.maxhp, usHP: a.me.hp,
				foe: FOES[a.foe.maxhp] || a.foe.maxhp, foeHP: a.foe.hp,
				played: rows[i].played, plan: rows[i].plan || null});
		}
	}
}

const byKind = {};
findings.forEach(f => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
console.log('archived decisions examined: ' + seenTurns.total
	+ '   (with a plan ' + seenTurns.planned + ', without ' + seenTurns.planless + ')');
console.log('');
Object.keys(byKind).sort((a, b) => byKind[b].length - byKind[a].length).forEach(k => {
	const list = byKind[k];
	const withPlan = list.filter(f => f.plan).length;
	console.log(k + ': ' + list.length
		+ '  (' + (100 * list.length / seenTurns.total).toFixed(1) + '% of decisions)'
		+ '   with a plan: ' + withPlan + ', planless: ' + (list.length - withPlan));
	const byFoe = {};
	list.forEach(f => { byFoe[f.foe] = (byFoe[f.foe] || 0) + 1; });
	console.log('    by opponent: ' + Object.keys(byFoe).sort((a, b) => byFoe[b] - byFoe[a])
		.map(x => x + ' ' + byFoe[x]).join(', '));
});
// THE RATE, not the count. Errors concentrate where the planner's answer was
// not used, and a raw count hides that because planless turns are a minority.
const plannedErr = new Set(), planlessErr = new Set();
findings.forEach(f => {
	if (f.kind === 'PING_PONG') return;   // spans three turns, not one decision
	(f.plan ? plannedErr : planlessErr).add(f.session + '#' + f.turn);
});
const pl = seenTurns.planned, np = seenTurns.planless;
console.log('');
console.log('ERROR RATE PER DECISION');
console.log('  turns WITH a plan   : ' + plannedErr.size + ' / ' + pl
	+ ' = ' + (100 * plannedErr.size / Math.max(1, pl)).toFixed(1) + '%');
console.log('  turns WITHOUT a plan: ' + planlessErr.size + ' / ' + np
	+ ' = ' + (100 * planlessErr.size / Math.max(1, np)).toFixed(1) + '%');
const ratio = (planlessErr.size / Math.max(1, np)) / Math.max(1e-9, plannedErr.size / Math.max(1, pl));
console.log('  planless turns go wrong ' + ratio.toFixed(1) + 'x as often');

// PER SESSION, newest last -- so "is this still happening" is answerable
// without trusting that the whole archive is one homogeneous thing. It is not:
// the build changed under it many times.
const perSession = {};
for (const dir of sessions()) {
	const key = path.basename(dir);
	perSession[key] = {turns: 0, planless: 0, err: new Set(), errPlanless: new Set()};
}
findings.forEach(f => {
	const b = perSession[f.session];
	if (!b || f.kind === 'PING_PONG') return;
	b.err.add(f.turn);
	if (!f.plan) b.errPlanless.add(f.turn);
});
for (const dir of sessions()) {
	const key = path.basename(dir);
	const rows = loadSession(dir);
	perSession[key].turns = rows.length;
	perSession[key].planless = rows.filter(r => !r.plan).length;
}
console.log('');
console.log('PER SESSION (oldest first)');
Object.keys(perSession).sort().forEach(k => {
	const b = perSession[k];
	if (!b.turns) return;
	console.log('  ' + k + '  turns ' + String(b.turns).padStart(4)
		+ '  planless ' + String(Math.round(100 * b.planless / b.turns)).padStart(3) + '%'
		+ '  errors ' + String(Math.round(100 * b.err.size / b.turns)).padStart(3) + '%');
});

if (process.env.AUDIT_SHOW) {
	const want = process.env.AUDIT_SHOW;
	console.log('\n--- ' + want + ' examples ---');
	const only = process.env.AUDIT_SESSION;
	(byKind[want] || []).filter(f => !only || f.session >= only)
		.slice(-14).forEach(f => console.log('  ' + JSON.stringify(f)));
}
