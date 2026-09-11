/**
 * Can the engine produce the damage numbers the real game produced?
 * Run: node tools/verify_damage.js [traceJson]
 *
 * This is the first time anything in this project has been checked against a
 * real fight rather than against itself. The screen reader recovered exact
 * damage events from James's clean Lt. Surge win -- "Lanturn took 41",
 * "Victreebel took 51" -- and every one of those is a number our damage model
 * must be able to generate. If it cannot, the model is wrong about something
 * real, and the specific event says where to look.
 *
 * KNOWN LIMITATION, and it is the whole of the one remaining "contradiction".
 * The HP difference between two readings is a NET change, and several things
 * move HP in the same turn: Drain Punch heals half of what it deals, Leftovers
 * ticks, burn and poison chip. Mienshao carries Drain Punch, and a big hit
 * partly offset by draining shows up here as a tiny net loss that no single
 * enemy move can produce. That is this tool being naive, not the engine being
 * wrong, and fixing it means simulating our own move rather than only theirs.
 *
 * Deliberately a WEAK test, because that is what the data supports. We do not
 * yet read the foe's species or its move, so this asks only: is there ANY
 * Pokemon on Surge's team, using ANY of its moves, that could deal exactly this
 * much to that Pokemon of ours? An event no combination can produce is a real
 * contradiction. An event that several can produce proves little, and is not
 * claimed to.
 */
'use strict';

const fs = require('fs');
const H = require('./lib/harness.js');

const engine = H.loadEngine();
const B = engine.B;
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

const tracePath = process.argv[2] ||
	require('os').homedir()+'/rr-agent/screen/run7_trace.json';
const data = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
// Only transitions we can be sure are ONE turn. If the foe's bar went UP
// between two readings, something fainted and was replaced, so several turns
// passed and the HP difference is a SUM rather than a hit. Comparing a sum
// against single-move ranges manufactures contradictions that are not there --
// it did, on the first run of this tool.
const rows = data.rows;
const taken = [];
for (let i = 0; i + 1 < rows.length; i++) {
	const a = rows[i], b = rows[i + 1];
	if (a.species !== b.species || b.hp >= a.hp) continue;
	if (b.foe_bar > a.foe_bar) continue;          // a replacement happened between
	taken.push({who: a.species, amount: a.hp - b.hp, from_hp: a.hp, to_hp: b.hp});
}

console.log('Damage events recovered from James\'s CLEAN WIN, checked against the engine.');
console.log('Question per event: can ANY of Surge\'s Pokemon, with ANY of its moves,');
console.log('deal exactly this much to that Pokemon?\n');
console.log('  our Pokemon    took   explained by');
console.log('  ---------------------------------------------------------------');

let unexplained = 0;
for (const e of taken) {
	const mine = party.find(p => p.species === e.who);
	if (!mine) continue;
	const hits = [];
	for (const foe of foeSets) {
		const st = B.createState([mine], [foe], {});
		// Our Pokemon at the HP it actually had, so that any HP-dependent
		// mechanic (and the KO check) behaves as it did in the real fight.
		st.me.team[0].curHP = e.from_hp;
		for (const mv of foe.moves) {
			let r;
			try { r = B.damageRolls(st, 'foe', mv); } catch (err) { continue; }
			if (!r || r.immune || !r.noCrit) continue;
			const lo = r.noCrit[0], hi = r.noCrit[r.noCrit.length - 1];
			if (e.amount >= lo && e.amount <= hi) {
				hits.push(foe.species + ' ' + mv + ' (' + lo + '-' + hi + ')');
				continue;
			}
			// Crits, which James says decided this fight. Leaving them out is
			// how the first run of this tool "found" contradictions: a critical
			// hit lands well outside the ordinary roll range and is not a model
			// error, it is the thing that happened.
			if (r.crit && r.crit.length) {
				const clo = r.crit[0], chi = r.crit[r.crit.length - 1];
				if (e.amount >= clo && e.amount <= chi) {
					hits.push(foe.species + ' ' + mv + ' CRIT (' + clo + '-' + chi + ')');
				}
			}
		}
	}
	if (!hits.length) unexplained++;
	console.log('  ' + e.who.padEnd(14) + String(e.amount).padStart(4) + '   ' +
		(hits.length ? hits.slice(0, 3).join(', ') +
			(hits.length > 3 ? ' +' + (hits.length - 3) + ' more' : '')
			: '*** NOTHING IN THE MODEL CAN DO THIS ***'));
}

console.log('\n' + (taken.length - unexplained) + '/' + taken.length +
	' damage events are reproducible by the engine.');
if (unexplained) {
	console.log(unexplained + ' are NOT, which is a real contradiction between the');
	console.log('model and a fight that actually happened. That is the bug to chase.');
} else {
	console.log('No contradictions. The damage model can account for every hit in a');
	console.log('real clean win, which is weak evidence FOR it -- several combinations');
	console.log('often fit, so this rules things out rather than confirming them.');
}
