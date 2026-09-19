'use strict';
/**
 * DOES THE CHEAP SEARCH AGREE WITH THE EXPENSIVE ONE? A battery, not anecdotes.
 *
 * Every wrong turn in this work came from a case there was no evidence about:
 * pruning looked free until depth 3 showed it was blind to switches; the tuned
 * configuration looked settled until a position where a Pokemon could actually
 * die showed it offering a switch that cost 44 HP when one costing nothing
 * existed. Three positions from one fight is not evidence, so this runs both
 * searches over a corpus and reports where they disagree.
 *
 *   node tools/search_battery.js <dir-of-states> [--depth 3] [--par 8]
 *
 * The comparison is by OUTCOME, not by identical move list: two lines that both
 * remove one of theirs for the same cost are the same answer, and insisting on
 * the same text would count ties as failures.
 */
const fs = require('fs');
const path = require('path');
const {execFile} = require('child_process');

const args = process.argv.slice(2);
const DIR = args.find(a => !a.startsWith('--')) || '/tmp/corpus';
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const DEPTH = val('depth', 3);
const PAR = val('par', 8);
const BUDGET = val('budget', 1500);

const SEARCH = path.join(__dirname, 'deep_search.js');

function run(state, extra) {
	return new Promise(resolve => {
		const a = [SEARCH, state, '--depth', String(DEPTH), '--par', String(PAR), '--budget', String(BUDGET)].concat(extra);
		execFile('node', a, {encoding: 'utf8', maxBuffer: 1 << 24, timeout: 900000}, (err, stdout) => {
			const s = String(stdout || '');
			const probes = Number((s.match(/probes: (\d+)/) || [])[1] || 0);
			const secs = Number((s.match(/time: ([\d.]+) s/) || [])[1] || 0);
			const m = s.match(/best line found \([^)]*\):\n  (.+)\n  they lose (\d+) and (\d+) Pokemon; we lose (\d+) and (\d+)/);
			resolve(m ? {
				probes, secs, line: m[1].trim(),
				theirLost: +m[2], theirDead: +m[3], ourLost: +m[4], ourDead: +m[5]
			} : {probes, secs, line: null});
		});
	});
}

/** Same answer means: same Pokemon removed, and no worse for us. */
function agrees(cheap, full) {
	if (!cheap || !full || !cheap.line || !full.line) return false;
	if (cheap.theirDead !== full.theirDead) return false;
	if (cheap.ourDead !== full.ourDead) return false;
	return cheap.ourLost <= full.ourLost;
}

async function main() {
	const states = fs.readdirSync(DIR).filter(f => f.endsWith('.ss')).sort().map(f => path.join(DIR, f));
	if (!states.length) { console.error('no states in ' + DIR); process.exit(2); }
	console.log('\n' + states.length + ' positions, depth ' + DEPTH + ', ' + PAR + ' probes at a time.');
	console.log('cheap = root unpruned, continuations keep 3, beam 6.  full = every action at every level.\n');

	let agree = 0, skipped = 0, cheapProbes = 0, fullProbes = 0, cheapSecs = 0, fullSecs = 0;
	const bad = [];
	for (const st of states) {
		const name = path.basename(st);
		const cheap = await run(st, ['--keep', '3', '--beam', '6']);
		if (!cheap.line) { console.log('  ' + name.padEnd(20) + 'not a decision, skipped'); skipped++; continue; }
		const full = await run(st, ['--keep', '0']);
		cheapProbes += cheap.probes; fullProbes += full.probes;
		cheapSecs += cheap.secs; fullSecs += full.secs;
		const ok = agrees(cheap, full);
		if (ok) agree++; else bad.push({name, cheap, full});
		console.log('  ' + name.padEnd(20) + (ok ? 'agree  ' : 'DIFFER ')
			+ String(cheap.probes).padStart(4) + ' vs ' + String(full.probes).padStart(4) + ' probes   '
			+ String(cheap.secs).padStart(5) + ' vs ' + String(full.secs).padStart(6) + ' s'
			+ (ok ? '' : '\n      cheap: ' + cheap.line + '  [removed ' + cheap.theirDead + ', we lose ' + cheap.ourLost + ']'
				+ '\n      full:  ' + full.line + '  [removed ' + full.theirDead + ', we lose ' + full.ourLost + ']'));
	}

	const n = agree + bad.length;
	console.log('\n' + agree + ' of ' + n + ' positions agree' + (skipped ? ' (' + skipped + ' skipped)' : ''));
	console.log('probes: ' + cheapProbes + ' cheap vs ' + fullProbes + ' full  ('
		+ (fullProbes ? Math.round(100 * cheapProbes / fullProbes) : 0) + '%)');
	console.log('time:   ' + cheapSecs.toFixed(0) + ' s cheap vs ' + fullSecs.toFixed(0) + ' s full  ('
		+ (fullSecs ? Math.round(100 * cheapSecs / fullSecs) : 0) + '%)');
	if (bad.length) {
		console.log('\nthe disagreements are the whole point of this; each is a case the');
		console.log('keep-set could not reach, and the reason is worth finding before trusting it.');
	}
	process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
