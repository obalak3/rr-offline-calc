// Does the agent PLAY the plan it chose? Answerable from the archive alone:
// planJobs records the chosen line, played records the action taken.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(process.env.HOME, 'rr-agent', 'turns');
const NAMES = {98:'Mienshao',112:'Diggersby',139:'Lanturn',102:'Lilligant',95:'Breloom',108:'Victreebel'};
const IDX = {Mienshao:0, Diggersby:1, Lanturn:2, Lilligant:3, Breloom:4, Victreebel:5};
let total = 0, match = 0, mismatch = [];
for (const d of fs.readdirSync(ROOT).filter(x => /^2026-/.test(x)).sort()) {
	const dir = path.join(ROOT, d);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const f of fs.readdirSync(dir).filter(x => /^turn\d+\.json$/.test(x)).sort()) {
		let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
		const jobs = r.planJobs, played = r.played, o = r.obs;
		if (!jobs || !jobs.length || !played || !o || !o.me) continue;
		const activeName = NAMES[o.me.maxhp];
		if (!activeName) continue;
		// Skip forced replacements: the plan's leg ordering is not the question there.
		if (o.kind === 'forced') continue;
		total++;
		// which leg is live: the first whose mon is alive
		const alive = {}, hpFrac = {};
		(o.party || []).forEach(p => {
			if (p.hp > 0) alive[NAMES[p.maxhp]] = true;
			hpFrac[NAMES[p.maxhp]] = p.hp / p.maxhp;
		});
		// MODEL jobDone, or every completed leg looks like a deviation. A chip
		// leg with until.selfHp is FINISHED once its Pokemon is at or below
		// that fraction, and policy.js hands over immediately -- which is the
		// plan working, not the plan being ignored. `uses` never fires here
		// because progress is fresh each decision.
		const foeStage = (i) => ((o.foe.stages || [])[i] || 6) - 6;
		const jobDone = (j) => {
			const u = j.until; if (!u) return false;
			if (u.selfHp !== undefined && hpFrac[j.mon] !== undefined
				&& hpFrac[j.mon] <= u.selfHp) return true;
			if (u.foeHp !== undefined && o.foe.hp / o.foe.maxhp <= u.foeHp) return true;
			if (u.foeStatus !== undefined && o.foe.status) return true;
			if (u.foeBoost !== undefined) {
				const map = {atk: 1, def: 2, spe: 3, spa: 4, spd: 5};
				const cur = foeStage(map[u.foeBoost.stat] || 1);
				if (u.foeBoost.atMost <= 0 ? cur <= u.foeBoost.atMost
					: cur >= u.foeBoost.atMost) return true;
			}
			if (u.entered) return NAMES[o.me.maxhp] === j.mon;
			return false;
		};
		let li = 0;
		while (li < jobs.length && !alive[jobs[li].mon]) li++;
		while (li < jobs.length - 1 && jobDone(jobs[li])) {
			li++;
			while (li < jobs.length && !alive[jobs[li].mon]) li++;
		}
		const leg = jobs[li] || jobs[jobs.length - 1];
		let ok;
		if (leg.mon !== activeName) {
			ok = played === 'switch ' + IDX[leg.mon];
		} else {
			const moves = leg.moves || [];
			ok = moves.length === 0 || moves.indexOf('*') >= 0 || moves.indexOf(played) >= 0;
		}
		if (ok) match++;
		else mismatch.push({session: d, turn: o.turn, active: activeName,
			wants: leg.mon + ':' + JSON.stringify(leg.moves || []), played: played,
			why: (r.plan || '').slice(0, 46)});
	}
}
console.log('turns with a plan (excluding forced replacements): ' + total);
console.log('played the plan\'s live leg : ' + match + ' (' + Math.round(100*match/Math.max(1,total)) + '%)');
console.log('played something else      : ' + mismatch.length + ' (' + Math.round(100*mismatch.length/Math.max(1,total)) + '%)');
const byWhat = {};
mismatch.forEach(m => {
	let k;
	if (m.played === 'Fake Out' || m.played === 'First Impression') {
		k = 'ENTRY INTERJECT (free entry move fired instead of the plan)';
	} else if (m.played.startsWith('switch')) {
		k = 'SWITCHED AWAY from a plan that wanted the active to act';
	} else if (m.wants.split(':')[0] !== m.active) {
		k = 'plan wanted a SWITCH, a move was played';
	} else {
		k = 'plan named a move, a different move was played';
	}
	byWhat[k] = (byWhat[k] || 0) + 1;
});
console.log('\nbreakdown:');
Object.keys(byWhat).sort((a,b)=>byWhat[b]-byWhat[a]).forEach(k => console.log('  ' + byWhat[k] + '  ' + k));
console.log('\nrecent examples:');
mismatch.slice(-10).forEach(m => console.log('  ' + m.session + ' t' + m.turn
	+ '  active ' + m.active + '  plan wants ' + m.wants + '  played ' + m.played));
