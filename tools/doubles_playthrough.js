'use strict';
/**
 * PLAY A WHOLE DOUBLE BATTLE THROUGH THE ADVISOR, turn by turn.
 *
 * Opening well and playing well are different things, and every measurement so
 * far has been about one turn from a fixed save state. This takes the advisor's
 * own recommendation, plays it on the hidden game, feeds the resulting state
 * back in, and repeats until the fight ends -- so a line that only defers, or a
 * plan that falls apart on turn four, shows up as a fight that is lost rather
 * than as a turn that looked fine.
 *
 *   node tools/doubles_playthrough.js <state.ss> [--budget N] [--turns N]
 *
 * It is a rehearsal against the real game, not a simulation: every turn is
 * played by the windowless core, so the result is what the live game would do
 * given those choices. Nothing appears on James's screen.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/harness.js');
const D = require('./lib/doubles-oracle.js');
const {advise} = require('./doubles_advisor.js');

const args = process.argv.slice(2);
const START = args.find(a => !a.startsWith('--'));
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const BUDGET = val('budget', 18);
const MAX_TURNS = val('turns', 25);

if (!START) { console.error('usage: node tools/doubles_playthrough.js <state.ss> [--budget N] [--turns N]'); process.exit(2); }
if (!fs.existsSync(START)) { console.error('no such state: ' + START); process.exit(2); }
if (!D.available()) { console.error('the hidden core or the ROM is missing'); process.exit(2); }

const dex = H.loadDex();
const nm = id => { const r = dex.byID[id]; return r ? (r.key || r.name) : ('#' + id); };

function field(obs) {
	const B = obs.battlers;
	const side = idx => idx.map(b => B[b] && B[b].maxhp
		? nm(B[b].species) + ' ' + B[b].hp + '/' + B[b].maxhp : '-').join(', ');
	return {ours: side([0, 2]), theirs: side([1, 3])};
}
function standing(rows) { return rows.filter(r => r[0] > 0).length; }

async function main() {
	let state = START;
	const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-dbl-play-'));
	let ourLostTotal = 0, theirLostTotal = 0, ourFaints = 0, seconds = 0;
	const log = [];

	console.log('\nPlaying a double battle through the advisor, turn by turn.');
	console.log('Every turn is played on the hidden game, so this is what the real fight would do.\n');

	for (let turn = 1; turn <= MAX_TURNS; turn++) {
		let res;
		try { res = await advise(state, {budget: BUDGET, quiet: true}); }
		catch (e) { console.log('turn ' + turn + ': cannot read the position (' + e.message + ')'); break; }
		seconds += res.secs;
		if (!res.ranked.length) { console.log('turn ' + turn + ': nothing playable was found'); break; }

		const best = res.ranked[0];
		const f = field(res.obs);
		const kind = res.forced ? '  (forced replacement)' : '';
		console.log('TURN ' + turn + kind);
		console.log('  ours   ' + f.ours);
		console.log('  theirs ' + f.theirs);
		console.log('  plays  ' + res.label(best.pair) + '   [' + Math.round(best.v) + ', chosen from '
			+ res.all.length + ' legal, ' + res.play.length + ' played in ' + res.secs + ' s]');

		const next = path.join(tmpdir, 'turn' + turn + '.ss');
		const r = await D.probe(state, best.pair, {save: next});
		const sum = D.summarize(r);
		if (!sum.ok) { console.log('  the turn could not be played: ' + (r.error || 'no result')); break; }

		ourLostTotal += sum.ourLost; theirLostTotal += sum.theirLost; ourFaints += sum.ourDead;
		const bits = [];
		bits.push(sum.theirLost ? 'they lose ' + sum.theirLost : 'they lose nothing');
		if (sum.theirDead) bits.push('AND ' + sum.theirDead + ' of theirs is removed');
		bits.push(sum.ourLost ? 'we lose ' + sum.ourLost : 'we lose nothing');
		if (sum.ourDead) bits.push('AND WE LOSE ' + sum.ourDead);
		if (best.cond && Math.abs(best.cond.value) > 1) bits.push('conditions ' + Math.round(best.cond.value) + ' HP');
		console.log('  result ' + bits.join(', '));
		log.push({turn, play: res.label(best.pair), ...sum});

		const ourLeft = standing(r.after.party), theirLeft = standing(r.after.foeparty);
		if (r.after.screen === 'nobattle' || theirLeft === 0 || ourLeft === 0) {
			console.log('\n' + (theirLeft === 0 ? 'THE FIGHT IS WON' : ourLeft === 0 ? 'THE FIGHT IS LOST' : 'the battle ended')
				+ ' after ' + turn + ' turns.');
			console.log('  ours standing   ' + ourLeft + '/6, ' + ourFaints + ' lost');
			console.log('  theirs standing ' + theirLeft);
			console.log('  HP: we lost ' + ourLostTotal + ', they lost ' + theirLostTotal);
			console.log('  thinking time: ' + seconds.toFixed(1) + ' s over ' + turn + ' turns');
			return;
		}
		state = next;
		console.log('');
	}
	console.log('\nStopped after ' + MAX_TURNS + ' turns without an ending.');
	console.log('  we lost ' + ourFaints + ' Pokemon, ' + ourLostTotal + ' HP; they lost ' + theirLostTotal + ' HP');
	console.log('  thinking time: ' + seconds.toFixed(1) + ' s');
}

main().catch(e => { console.error(e); process.exit(1); });
