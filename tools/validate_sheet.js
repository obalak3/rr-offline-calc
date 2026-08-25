/**
 * A sheet to take to the actual game.
 *
 * Run: node tools/validate_sheet.js [FIGHT] [budget]
 *      node tools/validate_sheet.js SURGE
 *      node tools/validate_sheet.js "MT. MOON" 400000
 *
 * WHY THIS EXISTS, and why it is worth more than another benchmark.
 *
 * No line this project has produced has ever been played in Radical Red and
 * checked. Every number in TUNING.md is the engine agreeing with itself, and on
 * one day alone about twenty-five mechanics turned out to be simulated wrongly
 * -- each silently wrong for the project's whole life, each perfectly capable of
 * producing a confident line that does not survive contact with the game. "Our
 * tests pass" and "this matches Radical Red" are different claims and only the
 * first has any evidence behind it.
 *
 * The cheapest experiment that could change that is to play one fight and write
 * down what the AI actually did. This prints the sheet for it.
 *
 * WHAT IS ACTUALLY BEING TESTED. Not whether the line wins -- a line that loses
 * because of a bad roll tells us nothing. What is being tested is the OPPONENT
 * MODEL: RRAI predicts one specific move per turn, and it is a port of CFRU
 * scoring rules that has never been checked against the real thing. If the AI
 * deviates on turn four, that single fact is worth more than every benchmark in
 * this repo, because every proved line rests on those predictions being right.
 *
 * So a fight the planner wins easily is a PERFECTLY GOOD subject. The sheet
 * does not need a clean line; it needs predictions.
 *
 * HOW TO USE IT
 *   1. Save your game before the fight, so it can be replayed.
 *   2. Play the moves in the "DO" column, in order.
 *   3. After each turn, compare what the opponent did against "THEY SHOULD".
 *   4. The moment they differ, STOP and write down the turn, what was predicted
 *      and what happened. That is the result. Finishing the fight is optional.
 *   5. Also note any HP that is far off the predicted value -- that is the
 *      damage model rather than the AI model, and both matter.
 *
 * A deviation is not a disaster, it is the point. About 7% of positions have
 * the AI tied between moves, and CFRU picks uniformly at random among them
 * (ai_master.c:360), so a deviation may mean a tie rather than a modelling
 * error. Record it either way; `certify` is the mode that reasons about ties.
 */
'use strict';

const H = require('./lib/harness.js');

const loaded = H.loadEngine();
const B = loaded.B, X = loaded.X;

const args = process.argv.slice(2).filter(a => a.charAt(0) !== '-');
const pattern = (args[0] || 'SURGE').toUpperCase();
const budget = parseInt(args[1], 10) || 400000;

let party;
try {
	party = H.realTeam();
} catch (e) {
	console.log('Could not read the save: ' + e.message);
	console.log('This tool is for the REAL party -- see tools/read_save.js.');
	process.exit(1);
}

const battles = H.earlyBattles(loaded, {maxLevel: 100, relativeBase: 75})
	.filter(b => H.label(b).toUpperCase().includes(pattern));

if (!battles.length) {
	console.log('No battle matching "' + pattern + '".');
	process.exit(1);
}
if (battles.length > 1) {
	console.log('NOTE: "' + pattern + '" matches ' + battles.length +
		' battles; using the first. They are:');
	battles.forEach((b, i) => console.log('  [' + i + '] ' + H.label(b) +
		'  ' + H.foeSets(b).length + ' Pokemon'));
	console.log('');
}
const battle = battles[0];
const foe = H.foeSets(battle);

console.log('=== ' + H.label(battle) + ' ===');
console.log('you   ' + party.map(m => m.species + ' L' + m.level).join(', '));
console.log('them  ' + foe.map(m => m.species + ' L' + m.level).join(', '));
console.log('');

B.clearCache();
const started = Date.now();
const route = X.planRoute(B.createState(party, foe, {}), {
	exactBudget: budget,
	maxTurns: 24,
	maxTurnsCeiling: 40,
	lookahead: 2,
	budget: 30000,
	risks: {roll: 'median'}
});

// Say plainly which engine produced this, because the three deserve different
// trust and the whole point of the exercise is honesty about what we know.
const trust = {
	'certified': 'PROVED against every roll and every AI tie.',
	'line-found': 'A clean line at MEDIAN rolls against the AI\'s top move. ' +
		'Not proof against bad luck.',
	'no-clean-line-exists': 'No clean line exists. This is the best available.',
	'undecided': 'The search ran out. This is the weighted search\'s GUESS, ' +
		'not a guarantee -- which is fine for this purpose: we are testing the ' +
		'AI predictions, not the plan.'
}[route.exactness] || route.exactness;

console.log('plan: ' + route.exactness + ' -- ' + trust);
if (route.minLoss) {
	console.log('      costs ' + route.losses + ' Pokemon' +
		(route.minLossProved ? ', and losing fewer was ruled out.'
			: ', and losing fewer was NOT ruled out.'));
}
console.log('      ' + Math.round((Date.now() - started) / 1000) + 's, ' +
	(route.nodes || 0).toLocaleString() + ' nodes\n');

if (!route.steps || !route.steps.length) {
	console.log('No line to play. Nothing to validate.');
	process.exit(0);
}

// YOUR hp rather than theirs, deliberately: the game shows you an exact number
// for your own Pokemon and only a bar for the opponent's, so this is the column
// a player can actually check. It tests the damage model the way the "THEY
// SHOULD" column tests the AI model.
console.log('  #   YOU               DO                     THEY SHOULD' +
	'                  your HP after   ACTUAL (fill in)');
console.log('  ' + '-'.repeat(112));
for (const s of route.steps) {
	const hp = s.myHP + '/' + s.myMaxHP;
	console.log('  ' + String(s.turn).padStart(2) + '  ' +
		String(s.myMon).slice(0, 16).padEnd(18) +
		String(s.label).slice(0, 21).padEnd(23) +
		(String(s.theirMon).slice(0, 12) + ' ' +
			String(s.theirLabel).replace(/^they use /, '')).slice(0, 28).padEnd(29) +
		String(hp).padEnd(16) + '__________');
}
console.log('');
// The warning belongs where it is READ. It was in this file's header comment,
// which is exactly the place a person about to play a fight will not look.
const willLose = route.steps.some(s => s.lost > 0);
if (willLose || route.exactness === 'undecided' || route.minLoss) {
	console.log('!! SAVE FIRST. This is a PROBE, not a strategy.' +
		(willLose ? ' This line LOSES Pokemon.' : '') +
		(route.exactness === 'undecided'
			? ' The search never finished, so it is a guess.' : ''));
	console.log('   Do not play it on a Nuzlocke save you care about. It exists');
	console.log('   to test the AI predictions, and a lost Pokemon is a real');
	console.log('   cost for an experiment that does not need one.\n');
}
// Where the HP column jumps to a different maximum, something of yours fainted
// and the number is the replacement's. Say so rather than let it read as a bug.
if (willLose) {
	const lost = route.steps.filter((s, i) =>
		i > 0 && s.lost > route.steps[i - 1].lost).map(s => s.turn);
	if (lost.length) {
		console.log('NOTE: you lose a Pokemon on turn ' + lost.join(', turn ') +
			'. From there the HP column is whoever came in next, which is why');
		console.log('      the maximum changes.\n');
	}
}

console.log('STOP at the first turn where they do something else, and write down:');
console.log('  the turn number, what was predicted, what they actually did,');
console.log('  and the HP of both Pokemon at that moment.');
console.log('');
console.log('That single deviation is the result. It does not matter whether the');
console.log('fight is won -- what is being tested is whether RRAI predicts the');
console.log('real AI, and nothing in this repo has ever checked that.');
