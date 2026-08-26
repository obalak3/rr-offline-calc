/**
 * Score our AI port against decisions the REAL AI made.
 * Run: node tools/score_oracle.js
 *
 * The opponent scoreboard (tools/scoreboard.js) scores against 102 decisions
 * scraped from eight recordings of one fight. This scores against decisions
 * the emulator produced directly, from battles played out by
 * tools/lua/battle_oracle.lua -- more of them, from more fights, and
 * generated in minutes rather than by asking James to play.
 *
 * WHAT IT CAN AND CANNOT COVER, stated up front because the gap is large.
 * Scoring needs our engine to be able to BUILD the position, which needs the
 * trainer's team in our data. Of the five fights recorded, only two are there:
 * Lt. Surge, and the fight containing Lokix (which the trainer data places in
 * Johto Leaders). The other three are route trainers absent from the
 * spreadsheet the data came from. So a low "scorable" count here is a DATA
 * coverage problem, not a fidelity result, and the two must not be confused.
 *
 * Scored as argmax under boss flags, matching scoreboard.js. That detail
 * matters: an earlier version of this comparison took a max over
 * RRAI.plausible's union of three flag sets, whose scores are not comparable
 * to one another, and it manufactured a false finding that the port ignored
 * type effectiveness. It does not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, AI = engine.AI;

const BOSS = {checkBadMove: true, checkGoodMove: true};
const idmap = JSON.parse(fs.readFileSync(
	path.join(__dirname, 'fixtures', 'rr-id-map.json'), 'utf8'));
const SPECIES = idmap.species, MOVES = idmap.moves;

const rows = fs.readFileSync(
	path.join(__dirname, 'fixtures', 'battle-oracle-59.tsv'), 'utf8')
	.split('\n').filter(l => l.trim() && !l.startsWith('episode'))
	.map(l => l.split('\t'));
const HDR = ['episode', 'state', 'pattern', 'frame', 'our_sp', 'our_hp', 'our_max',
	'foe_sp', 'foe_hp', 'foe_max', 'action', 'move_id', 'new_sp'];
const data = rows.map(r => Object.fromEntries(HDR.map((h, i) => [h, r[i]])));

const party = H.realTeam();
const all = H.earlyBattles(engine, {maxLevel: 100});

// Find a battle whose foe team contains this species, so the position can be
// built. Keyed on the species actually observed rather than on a trainer name,
// because the oracle records IDs and knows nothing about who owns them.
function battleWith(speciesName) {
	for (const b of all) {
		const sets = H.foeSets(b);
		if (sets.some(m => m.species === speciesName
			|| m.species === speciesName + '-Mega')) return sets;
	}
	return null;
}

let scorable = 0, hit = 0, unbuildable = 0;
const misses = [];
const byFight = {};

data.forEach(d => {
	const ourName = SPECIES[d.our_sp], foeName = SPECIES[d.foe_sp];
	const real = d.action === 'switch' ? 'SWITCH' : MOVES[d.move_id];
	if (!ourName || !foeName || !real) { unbuildable++; return; }
	const mine = party.findIndex(m => m.species === ourName);
	const sets = battleWith(foeName);
	if (mine < 0 || !sets) { unbuildable++; return; }
	const fi = sets.findIndex(m => m.species === foeName
		|| m.species === foeName + '-Mega');
	const st = B.createState(party, sets, {});
	st.me.active = mine;
	st.foe.active = fi;
	st.me.team[mine].curHP = Math.max(1, Math.min(st.me.team[mine].maxHP, +d.our_hp));
	const scale = st.foe.team[fi].maxHP / (+d.foe_max || 1);
	st.foe.team[fi].curHP = Math.max(1, Math.round((+d.foe_hp) * scale));

	const scored = AI.scoreAll(st, 'foe', BOSS, {});
	const best = Math.max.apply(null, scored.map(x => x.score));
	const top = scored.filter(x => x.score === best)
		.map(x => x.action.type === 'switch' ? 'SWITCH' : x.action.move);
	// Hidden Power is typed in trainer data and bare on screen; same move.
	const ok = top.some(m => m === real
		|| (real.indexOf('Hidden Power') === 0 && String(m).indexOf('Hidden Power') === 0));
	scorable++;
	if (ok) hit++;
	else misses.push(ourName + ' ' + d.our_hp + ' vs ' + foeName + ' ' + d.foe_hp
		+ ': real ' + real + ', we said ' + top.join('/'));
	const key = foeName;
	byFight[key] = byFight[key] || {n: 0, ok: 0};
	byFight[key].n++;
	if (ok) byFight[key].ok++;
});

console.log('');
console.log('  ORACLE SCOREBOARD  ' + data.length + ' recorded decisions');
console.log('    scorable          ' + scorable
	+ '   (' + unbuildable + ' unbuildable: trainer not in our data)');
if (scorable) {
	console.log('    our argmax right  ' + hit + '/' + scorable
		+ '  ' + (100 * hit / scorable).toFixed(1) + '%');
	console.log('\n  by foe:');
	Object.keys(byFight).sort().forEach(k => {
		const e = byFight[k];
		console.log('    ' + k.padEnd(14) + e.ok + '/' + e.n);
	});
}
if (misses.length) {
	console.log('\n  misses:');
	misses.slice(0, 14).forEach(m => console.log('    ' + m));
}
