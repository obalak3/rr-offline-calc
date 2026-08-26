/**
 * How many coin flips does this fight contain, and can we choose to have fewer?
 * Run: node tools/count_ties.js [PATTERN]
 *
 * WHY. James wins Lt. Surge partly by picking a switch-in that makes the AI
 * PREDICTABLE: send in something against which one move is clearly best, and
 * the tied set collapses to one, so the opponent stops flipping a coin. See
 * docs/TIES.md. Nothing in this app models that. `check_forks.js` counts ties
 * to report how fragile a plan is; this asks the active question -- for each
 * Pokemon we could have out, how many moves would the AI have tied at the top?
 *
 * CFRU picks uniformly among everything tied at the maximum
 * (`ai_master.c:360`, AIRandom() % numOfBestMoves), and it re-rolls every turn,
 * so a tie of size N is a genuine 1/N die on that turn and watching last turn's
 * result tells you nothing about this one.
 *
 * Output is per (our active) x (their active): the size of the AI's tied set,
 * and which moves are in it.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};

const pattern = (process.argv[2] || 'SURGE').toUpperCase();
const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes(pattern))[0];
if (!battle) { console.log('no battle matching ' + pattern); process.exit(1); }
const foeSets = H.foeSets(battle);

console.log('=== ' + H.label(battle) + ': the AI\'s tied set, per matchup ===');
console.log('rows = our active, cols = their active. N = how many moves tie at the top.');
console.log('N>1 is a coin flip, re-rolled every turn.\n');

function tiedSet(state) {
	const scored = RRAI.scoreAll(state, 'foe', FLAGS, {});
	const gate = RRAI.switchGate(state, 'foe', FLAGS);
	let best = -Infinity;
	const usable = [];
	for (const e of scored) {
		if (e.action.type === 'switch' && !gate.maySwitch) continue;
		usable.push(e);
		if (e.score > best) best = e.score;
	}
	const tied = usable.filter(e => e.score === best);
	return {
		n: tied.length,
		names: tied.map(e => e.action.type === 'switch' ? 'switch' : e.action.move),
		best: best
	};
}

const header = '                ' + foeSets.map(f => f.species.slice(0, 11).padEnd(13)).join('');
console.log(header);
const tally = {};
for (let i = 0; i < party.length; i++) {
	let row = party[i].species.slice(0, 14).padEnd(16);
	for (let j = 0; j < foeSets.length; j++) {
		const st = B.createState(party, foeSets, {});
		st.me.active = i;
		st.foe.active = j;
		let t;
		try { t = tiedSet(st); } catch (e) { t = {n: 0, names: []}; }
		tally[t.n] = (tally[t.n] || 0) + 1;
		row += ((t.n === 1 ? ' ' : '*') + t.n + ' ' + (t.names[0] || '?').slice(0, 9)).padEnd(13);
	}
	console.log(row);
}

console.log('\n* marks a coin flip. distribution of tied-set sizes:');
for (const k of Object.keys(tally).sort()) {
	console.log('  ' + k + ' tied: ' + tally[k] + ' matchups');
}

// The Hatterene question, asked directly: standing in front of each foe, does
// our CHOICE of Pokemon change how predictable the AI is?
console.log('\nCan we choose predictability? Best and worst switch-in per foe:');
for (let j = 0; j < foeSets.length; j++) {
	const rows = [];
	for (let i = 0; i < party.length; i++) {
		const st = B.createState(party, foeSets, {});
		st.me.active = i; st.foe.active = j;
		try { rows.push({mon: party[i].species, t: tiedSet(st)}); } catch (e) {}
	}
	if (!rows.length) continue;
	rows.sort((a, b) => a.t.n - b.t.n);
	const lo = rows[0], hi = rows[rows.length - 1];
	console.log('  vs ' + foeSets[j].species.padEnd(16) +
		'best ' + lo.mon.padEnd(12) + '(' + lo.t.n + ' tied)   ' +
		'worst ' + hi.mon.padEnd(12) + '(' + hi.t.n + ' tied)' +
		(lo.t.n < hi.t.n ? '   <-- choice matters' : ''));
}
