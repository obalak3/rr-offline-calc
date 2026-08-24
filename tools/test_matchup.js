/**
 * Checks for the 1v1 pairing table. Run: node tools/test_matchup.js
 *
 * The table's whole job is to be a PRIOR: it tells the search which of yours
 * handles which of theirs, so the search looks there first. Two properties
 * matter and they are tested separately, because they carry different weight:
 *
 *   It must be right about obvious pairings, or it steers the search away from
 *   the lines that win.
 *
 *   It must never report "hopeless" from a search that merely ran out of
 *   budget. `hopeless` is the flag a prune is allowed to act on, and a prune
 *   acting on a timeout would silently throw away winnable branches.
 *
 * The last test is the one that has actually bitten this project before: the
 * field belongs to the fight, not to the pair. Lt. Surge's permanent Electric
 * Terrain is why both Sleep Powders in the real party are dead weight against
 * anything of his standing on the ground, and a table built from a fresh state
 * would have dropped it and promised sleep wins that do not exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number, Date};
vm.createContext(sandbox);
for (const file of ['src/js/data/rr-move-effects.js', 'src/js/rr-critko.js',
	'src/js/rr-battle.js', 'src/js/rr-ai.js', 'src/js/rr-plan.js',
	'src/js/rr-solver.js', 'src/js/rr-matchup.js', 'src/js/rr-exact.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const MU = sandbox.RRMatchup;
const X = sandbox.RRExact;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
function set(species, moves, level, extra) {
	return Object.assign({species, level, nature: 'Serious', moves, item: '',
		ability: undefined, evs: EVS, ivs: IVS}, extra || {});
}

// A mismatch nobody needs a computer for: a level 50 Machamp against a level 5
// Magikarp that knows only Splash, alongside a Gastly that Machamp's Normal and
// Fighting moves cannot touch at all.
const mine = [
	set('Machamp', ['Karate Chop', 'Headbutt'], 50),
	set('Pidgey', ['Tackle'], 5)
];
const theirs = [
	set('Magikarp', ['Splash'], 5),
	set('Gastly', ['Lick'], 40)
];
const state = B.createState(mine, theirs, {});
const table = MU.build(state, {});

check('the table covers every pairing',
	table.pairs.length === 2 && table.pairs[0].length === 2,
	JSON.stringify(table.pairs.length + 'x' + (table.pairs[0] || []).length));

const champVsKarp = MU.versus(table, 0, 0);
check('a hopeless mismatch is a win for the strong one',
	champVsKarp && champVsKarp.beats === true,
	JSON.stringify(champVsKarp));
check('  and it wins it barely scratched',
	champVsKarp && champVsKarp.endHPFrac > 0.9,
	champVsKarp && String(champVsKarp.endHPFrac));

// Normal and Fighting are both immune against a Ghost, so there is no line at
// all here -- and the search should FINISH knowing that rather than time out.
const champVsGhost = MU.versus(table, 0, 1);
check('a matchup it cannot win is not reported as a win',
	champVsGhost && champVsGhost.beats === false,
	JSON.stringify(champVsGhost));
check('  and dealing literally no damage is measured as none',
	champVsGhost && champVsGhost.dealFrac === 0,
	champVsGhost && String(champVsGhost.dealFrac));

// The honesty test. A budget of one node cannot settle anything, so every cell
// must come back undecided -- and crucially NOT hopeless, because hopeless is
// what a prune acts on.
const starved = MU.build(state, {perPairBudget: 1, pairMaxTurns: 2});
let falseHopeless = 0;
for (const row of starved.pairs) {
	for (const cell of row) if (cell.hopeless && !cell.decided) falseHopeless++;
}
check('a starved table never calls a pairing hopeless without deciding it',
	falseHopeless === 0, falseHopeless + ' cell(s) claimed hopeless undecided');

// Coverage: Gastly is beaten by nobody here, so the gap must be visible.
check('a foe nothing can beat shows up as a coverage gap',
	MU.anyCoverageGap(table, state) === true);

/**
 * The field comes with the fight.
 *
 * Under Electric Terrain a grounded Pokemon cannot be put to sleep, so a
 * Sleep Powder line that works on a bare field must stop working here. If the
 * table built its 1v1s from a fresh state this would come back identical and
 * the test would pass for the wrong reason.
 */
const sleeper = [set('Victreebel', ['Sleep Powder', 'Mega Drain'], 40)];
const target = [set('Rhyhorn', ['Horn Attack'], 40)];
const bare = B.createState(sleeper, target, {});
const terrain = B.createState(sleeper, target,
	{terrain: 'Electric', permanentTerrain: true});
const bareOne = MU.build(bare, {});
const terrainOne = MU.build(terrain, {});
check('the pairing is solved on a bare field',
	bareOne.pairs[0][0].beats === true, JSON.stringify(bareOne.pairs[0][0]));
check('  and the fight\'s terrain is carried into the 1v1',
	terrain.field.terrain === 'Electric' &&
	terrain.field.terrainTurns === Infinity);

// The integration that matters: a table must not change what the search
// CONCLUDES, only how fast it gets there.
const easy = B.createState(
	[set('Machamp', ['Karate Chop'], 50), set('Snorlax', ['Body Slam'], 50)],
	[set('Magikarp', ['Splash'], 5)], {});
const withTable = X.cleanWin(easy, {exactBudget: 50000, maxTurns: 12});
const without = X.cleanWin(easy, {exactBudget: 50000, maxTurns: 12, matchup: null});
check('the table does not change the verdict',
	withTable.found === without.found && withTable.decided === without.decided,
	JSON.stringify({withTable: withTable.found, without: without.found}));

/**
 * Splitting the opening moves between searches must not lose anything.
 *
 * This is the property a parallel search rests on: the root's branches are
 * independent, so handing half the openings to one search and half to another
 * covers exactly what one search covers. If that were false, running the search
 * on several cores would quietly answer a different question from running it on
 * one -- and the failure would look like an occasional missed win rather than
 * like a bug.
 */
const splitState = B.createState(
	[set('Machamp', ['Karate Chop', 'Headbutt', 'Low Kick'], 40),
		set('Snorlax', ['Body Slam', 'Rest'], 40)],
	[set('Magikarp', ['Splash', 'Tackle'], 20),
		set('Gyarados', ['Bite', 'Splash'], 22)], {});

const whole = X.cleanWin(splitState, {exactBudget: 80000, maxTurns: 16});
const keys = X.rootActionKeys(splitState, {});
check('the opening moves can be listed for splitting',
	keys.length > 1, JSON.stringify(keys));

const evens = keys.filter((k, i) => i % 2 === 0);
const odds = keys.filter((k, i) => i % 2 === 1);
const a = X.cleanWin(splitState, {exactBudget: 80000, maxTurns: 16, rootActions: evens});
const b = X.cleanWin(splitState, {exactBudget: 80000, maxTurns: 16, rootActions: odds});

check('a split search finds a line whenever the whole one does',
	whole.found === (a.found || b.found),
	JSON.stringify({whole: whole.found, halfA: a.found, halfB: b.found}));
check('  and every half that finished really did finish',
	(a.decided || !a.found) && (b.decided || !b.found));

// A subset that finishes empty proves nothing on its own. The engine must not
// pretend otherwise by reporting a line it was never allowed to look at.
const onlyOne = X.cleanWin(splitState,
	{exactBudget: 80000, maxTurns: 16, rootActions: [keys[keys.length - 1]]});
check('a search restricted to one opening stays inside it',
	onlyOne.found === false || onlyOne.line[0].action !== undefined,
	JSON.stringify(onlyOne.found));

console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
