/**
 * Mirror matches: bring exactly what the opponent brings.
 * Run: node tools/bench_mirror.js [pattern] [budget] [--all] [--show]
 *
 * WHY THIS IS THE SHARPEST TEST HERE. Every other benchmark confounds two
 * things -- how good the planner is, and how good the team it was handed is.
 * When a fight comes back undecided, those are indistinguishable, and a
 * generated team losing to the Elite Four tells you almost nothing.
 *
 * A mirror removes the first variable completely. Same species, same levels,
 * same moves, same items, same abilities on both sides. Neither side has a
 * type advantage, a stat advantage or a coverage advantage. **The only thing
 * left that can decide the fight is which side chooses better.**
 *
 * So the expectation is sharp and falsifiable: Radical Red's AI is a
 * one-ply scorer with no lookahead, and a search that plays the whole game out
 * should beat it with its own team. Where it cannot, that is the planner's
 * failure and nothing else's -- there is no "the team was bad" left to hide in.
 *
 * TWO THINGS THIS IS NOT. It is not a claim any of these fights is winnable
 * with a team you could actually assemble; several of these sets are Restricted
 * mode contraband for the player, and mirroring them is deliberate. And a mirror
 * is not symmetric in practice: the player moves second on speed ties in this
 * engine, so a mirror is very slightly the HARDER side to play.
 */
'use strict';

const H = require('./lib/harness.js');

const loaded = H.loadEngine();
const B = loaded.B, X = loaded.X, S = loaded.S;

const args = process.argv.slice(2).filter(a => a.charAt(0) !== '-');
const pattern = args[0] ? args[0].toUpperCase() : null;
const budget = parseInt(args[1], 10) || 200000;
const all = process.argv.indexOf('--all') >= 0;
const show = process.argv.indexOf('--show') >= 0;
// One level up on our side, by default. A true mirror leaves every speed tie a
// coin flip that this engine hands to the opponent, so a mirror is actually the
// harder side to play and small fights can be genuinely unwinnable for reasons
// that have nothing to do with the planner. A single level breaks every tie our
// way and removes the flips, at the cost of a stat edge so small it cannot
// manufacture a win on its own.
const offsetArg = args[2] !== undefined ? parseInt(args[2], 10) : 1;
const offset = isNaN(offsetArg) ? 1 : offsetArg;

// --all now means every non-doubles fight in the game, scaling ones included.
// Their level is an offset from the player's, and in a mirror the absolute
// number cancels, so any base works; 75 keeps them in a sane range.
let battles = H.earlyBattles(loaded, all
	? {maxLevel: 100, relativeBase: 75}
	: {maxLevel: 34});
if (pattern) battles = battles.filter(b => H.label(b).toUpperCase().includes(pattern));

console.log('Mirror matches: our team IS their team, +' + offset +
	' level.  budget ' + budget.toLocaleString() + ' nodes\n');
console.log('  fight                     size  verdict                 nodes      s');

let found = 0, impossible = 0, undecided = 0, wonAnyway = 0, lost = 0, stalled = 0;
for (const battle of battles) {
	// The mirror. foeSets already produces the shape createState wants, so both
	// sides are built from the identical description.
	const theirs = H.foeSets(battle);
	const ours = H.foeSets(battle).map(function (set) {
		return Object.assign({}, set, {level: set.level + offset});
	});

	B.clearCache();
	const started = Date.now();
	let result;
	try {
		result = X.cleanWin(B.createState(ours, theirs, {}),
			{exactBudget: budget, maxTurns: 24});
	} catch (e) {
		console.log('  ' + H.label(battle).slice(0, 24).padEnd(25) + '  ERROR ' + e.message);
		continue;
	}
	const verdict = result.found ? 'CLEAN WIN, ' + result.line.length + ' turns'
		: result.decided ? 'no clean line exists' : 'undecided (budget)';
	if (result.found) found++; else if (result.decided) impossible++; else undecided++;

	// The two questions are different and only one of them should be near
	// perfect. cleanWin asks "is there a line where NOBODY faints", which is the
	// Nuzlocke objective and which some fights genuinely fail on merit. Whether
	// we win AT ALL is the test of the planner against the AI, and in a mirror
	// -- same team, one level up, against a one-ply scorer with no lookahead --
	// there is no excuse for losing that one.
	let plain = '';
	if (!result.found) {
		B.clearCache();
		try {
			// 160 turns, not 40. At 40 this tool reported three fights as
			// "LOSES THE FIGHT" that it simply had not finished watching, and
			// one of them -- TREASURE BEA. / SWIMMER AMARA -- is a CLEAN WIN in
			// 66 turns, i.e. the best possible outcome printed as the worst.
			// ROUTE 13 / ALMA needs 99 turns and VICTORY ROAD / COLBY needs 135.
			// Measured: at a fixed cap the budget makes no difference to any of
			// them, so the cap alone was the artifact.
			const route = S.planRoute(B.createState(ours, theirs, {}),
				{lookahead: 2, budget: 60000, maxTurns: 160, risks: {roll: 'median'}});
			// A fight that ended with Pokemon still standing did not end. Only a
			// party that is entirely down has actually LOST, and that is the one
			// line here that is a verdict on the planner -- so it must not be
			// inflated by fights that merely ran long.
			//
			// `route.stalled` cannot make this distinction and must not be used:
			// rr-solver sets `stalled || (!wonIt && steps.length < maxTurns)`, and
			// a genuine wipe also ends early, so a wipe reads as stalled too.
			// Losses against party size is the test that separates them.
			const wiped = route.losses >= ours.length;
			plain = route.won ? 'wins, losing ' + route.losses
				: (wiped ? 'LOSES THE FIGHT'
					: 'stalled at ' + route.turns + 'T, no verdict');
			if (route.won) wonAnyway++; else if (wiped) lost++; else stalled++;
		} catch (e) { plain = 'error'; }
	} else { wonAnyway++; }

	console.log('  ' + H.label(battle).slice(0, 24).padEnd(25) +
		String(theirs.length) + 'v' + theirs.length + '  ' +
		verdict.padEnd(22) + result.nodes.toLocaleString().padStart(9) + '  ' +
		String(Math.round((Date.now() - started) / 1000)).padStart(3) + '  ' + plain);

	if (result.found && show) {
		for (const step of X.toSteps(result.line)) {
			console.log('       ' + String(step.turn).padStart(2) + '. ' +
				step.myMon.padEnd(15) + step.label.padEnd(18) +
				'(' + step.theirMon + ' ' + step.theirLabel + ')');
		}
	}
}

const total = found + impossible + undecided;
console.log('\n  clean wins   ' + found + '/' + total);
console.log('  no line      ' + impossible + '/' + total);
console.log('  undecided    ' + undecided + '/' + total);
console.log('\n  won the fight at all      ' + wonAnyway + '/' + total);
console.log('  actually LOST            ' + lost + '/' + total);
console.log('  stalled, no verdict      ' + stalled + '/' + total);
console.log('\nThe two lines mean different things. A clean win is the Nuzlocke');
console.log('objective and some fights fail it on merit. Losing outright, with the');
console.log('same team and a level in hand against a one-ply scorer, is the planner.');
