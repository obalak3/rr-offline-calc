// Compare the damage OUR moves actually did in an archived run with the
// engine's 16-roll range for the same position. Usage:
//   node tools/audit_damage.js <turns-dir> [<turns-dir> ...]
// A hit outside its range is a mechanics gap (or a crit); a whole move that
// sits consistently below its range is the thing to chase.
const fs = require('fs'), path = require('path');
const H = require('./lib/harness.js');
const eng = H.loadEngine(); const B = eng.B; const RRSave = eng.sandbox.RRSave;
const dex = H.loadDex();
const nm = id => { const s = dex.byID[id]; return s ? (s.key || s.name) : String(id); };
const dec = rows => rows.filter(r => r && r.maxhp).map(r => {
	const b = Buffer.from(r.raw, 'hex');
	const m = RRSave.readRecord(new DataView(b.buffer, b.byteOffset, b.byteLength), 0, true);
	return {species: m.species, level: m.level, nature: m.nature, ability: m.ability,
		item: m.item || '', moves: m.moves, evs: m.evs, ivs: m.ivs, maxhp: r.maxhp};
});
const HEALS = /Drain|Roost|Recover|Rest|Synthesis|Giga Drain|Mega Drain|Leech/;
let rows = [];
for (const dir of process.argv.slice(2)) {
	const files = fs.readdirSync(dir).filter(f => /^turn\d+\.json$/.test(f)).sort();
	let prev = null;
	for (const f of files) {
		let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
		const o = r.obs || r; if (!o || !o.me || !o.foe) continue;
		if (prev && typeof prev.r.played === 'string' && !/^switch/.test(prev.r.played)
			&& prev.o.foe.species === o.foe.species && prev.o.foe.maxhp === o.foe.maxhp
			&& o.foe.hp < prev.o.foe.hp && prev.o.kind !== 'forced') {
			const actual = prev.o.foe.hp - o.foe.hp;
			try {
				const team = dec(prev.o.party), foes = dec(prev.o.foeparty);
				const mi = team.findIndex(s => s.maxhp === prev.o.me.maxhp);
				const fi = foes.findIndex(s => s.maxhp === prev.o.foe.maxhp);
				if (mi < 0 || fi < 0) continue;
				const rot = (a, i) => a.slice(i).concat(a.slice(0, i));
				const st = B.createState(rot(team, mi), rot(foes, fi), {});
				st.me.team[0].curHP = prev.o.me.hp; st.foe.team[0].curHP = prev.o.foe.hp;
				// live stat stages of both actives
				const stg = prev.o.me.stages || [], fst = prev.o.foe.stages || [];
				const keys = ['atk', 'def', 'spe', 'spa', 'spd'];
				keys.forEach((k, i) => { if (stg[i + 1] !== undefined) st.me.team[0].boosts[k] = stg[i + 1] - 6; if (fst[i + 1] !== undefined) st.foe.team[0].boosts[k] = fst[i + 1] - 6; });
				const rr = B.damageRolls(st, 'me', prev.r.played);
				const lo = rr && rr.noCrit ? rr.noCrit[0] : null, hi = rr && rr.noCrit ? rr.noCrit[rr.noCrit.length - 1] : null;
				const crit = rr && rr.crit ? rr.crit[rr.crit.length - 1] : null;
				const foeHeals = HEALS.test(String(nm(prev.o.foe.moves[prev.o.ai_target])));
				rows.push({turn: prev.o.turn, me: nm(prev.o.me.species), move: prev.r.played, foe: nm(prev.o.foe.species),
					actual, lo, hi, crit, cappedAt: prev.o.foe.hp, note: foeHeals ? 'foe may have healed' : ''});
			} catch (e) { /* skip */ }
		}
		prev = {r, o};
	}
}
for (const x of rows) {
	const capped = x.actual >= x.cappedAt;
	const verdict = x.lo === null ? '?' : capped ? 'KO' : (x.actual < x.lo ? 'UNDER ' + Math.round(100 * x.actual / x.lo) + '%' : x.actual > x.hi ? (x.crit && x.actual <= x.crit ? 'crit?' : 'OVER') : 'ok');
	console.log('t' + x.turn + ' ' + x.me + ' ' + x.move + ' -> ' + x.foe + ': ' + x.actual + ' vs ' + x.lo + '-' + x.hi + '  ' + verdict + (x.note ? ' (' + x.note + ')' : ''));
}
