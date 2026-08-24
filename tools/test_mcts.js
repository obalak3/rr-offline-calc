/**
 * Checks for the Monte Carlo search. Run: node tools/test_mcts.js
 *
 * The thing that can quietly go wrong here is the REWARD. MCTS does exactly
 * what the reward tells it to and nothing else, so an ordering mistake does not
 * announce itself as a crash, it shows up as the planner preferring to stall,
 * or trading a Pokemon for a win it did not need to. Both of those have already
 * happened once: the first version scored a wipe flat 0, which left every action
 * in a losing position tied at 0.000 and the search picking the first legal move.
 *
 * So most of these assert the ordering of outcomes rather than the search.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'upstream-calc/calc/dist/index.js'));
const sandbox = {calc, console, Math, JSON, Object, Array, Infinity, Number, Date};
vm.createContext(sandbox);
for (const file of ['src/js/data/rr-trainers-data.js', 'src/js/data/rr-move-effects.js',
	'src/js/rr-critko.js', 'src/js/rr-battle.js', 'src/js/rr-ai.js',
	'src/js/rr-plan.js', 'src/js/rr-mcts.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const M = sandbox.RRMCTS;
const TRAINERS = sandbox.RR_TRAINER_DATA;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

// ------------------------------------------------------------ reward ordering

/** A bare state shaped like the reward function's inputs. */
function outcome(mineLost, theirsLost, mineHurt) {
	const mine = [], theirs = [];
	for (let i = 0; i < 6; i++) {
		mine.push({fainted: i < mineLost, curHP: i < mineLost ? 0 : (mineHurt ? 20 : 100),
			maxHP: 100});
	}
	for (let i = 0; i < 4; i++) {
		theirs.push({fainted: i < theirsLost, curHP: i < theirsLost ? 0 : 100, maxHP: 100});
	}
	return {me: {team: mine}, foe: {team: theirs}};
}

const cleanWin = M.reward(outcome(0, 4, false), true);
const wonLostOne = M.reward(outcome(1, 4, false), true);
const wonLostThree = M.reward(outcome(3, 4, false), true);
const unresolvedFull = M.reward(outcome(0, 0, false), false);
const unresolvedClose = M.reward(outcome(0, 3, false), false);
const wiped = M.reward(outcome(6, 3, false), true);

check('a clean win is the maximum (' + cleanWin + ')', cleanWin === 1);
check('losing one Pokemon costs most of the win (' + wonLostOne.toFixed(2) + ')',
	wonLostOne < cleanWin / 2);
check('losing three is worse than losing one', wonLostThree < wonLostOne);

// The stalling guard: any win must beat any unfinished fight, or the search
// will happily play for a draw it cannot be scored on.
check('the worst win still beats the best unfinished fight (' +
	wonLostThree.toFixed(3) + ' > ' + unresolvedClose.toFixed(3) + ')',
	wonLostThree > unresolvedClose);

// The gradient guard: this is what the first version got wrong.
check('progress is visible in an unfinished fight (' + unresolvedFull.toFixed(3) +
	' -> ' + unresolvedClose.toFixed(3) + ')', unresolvedClose > unresolvedFull);
check('being wiped ranks below holding on with everyone alive (' +
	wiped.toFixed(3) + ' < ' + unresolvedFull.toFixed(3) + ')', wiped < unresolvedFull);

// ------------------------------------------------------------ the search runs

function set(species, moves, level, extra) {
	return Object.assign({species, level, nature: 'Serious', moves, item: '',
		ability: undefined,
		evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}}, extra || {});
}

{
	const state = B.createState(
		[set('Squirtle', ['Water Gun', 'Tackle'], 16), set('Bulbasaur', ['Vine Whip'], 16)],
		[set('Geodude', ['Rock Throw'], 14)], {});
	const choice = M.chooseAction(state, {iterations: 80});
	check('it returns an action it actually searched',
		choice && choice.action && choice.visits > 0, JSON.stringify(choice));
	check('  and spent its whole budget', choice.playouts >= 80,
		'playouts ' + (choice && choice.playouts));
	check('  choosing among the legal options',
		choice.considered === B.legalActions(state, 'me').length);
}

// Against something it beats comfortably it must find the win, not wander. This
// is the end-to-end check: reward, rollout, selection and route all have to be
// right together for this to pass.
{
	const state = B.createState(
		[set('Blastoise', ['Surf', 'Ice Beam', 'Bite', 'Rapid Spin'], 45)],
		[set('Geodude', ['Rock Throw', 'Defense Curl'], 13)], {});
	const route = M.planRoute(state, {iterations: 60, maxTurns: 12});
	check('it wins a fight it cannot lose', route.won === true,
		'turns ' + route.turns + ', losses ' + route.losses);
	check('  without losing anything', route.losses === 0);
	check('  and stops once the fight is over', route.turns < 12);
}

// A route has to be playable: every step names what to click and what it expects.
{
	const state = B.createState(
		[set('Blastoise', ['Surf', 'Ice Beam'], 45), set('Pikachu', ['Thunderbolt'], 45)],
		[set('Onix', ['Rock Tomb'], 14), set('Geodude', ['Rock Throw'], 13)], {});
	const route = M.planRoute(state, {iterations: 60, maxTurns: 15});
	const bad = (route.steps || []).filter(s => !s.label || !s.myMon || !s.theirMon);
	check('every step says what to do and what it expects back',
		route.steps.length > 0 && bad.length === 0,
		bad.length + ' incomplete steps of ' + route.steps.length);
	check('  and reports a confidence per step',
		route.steps.every(s => typeof s.confidence === 'number'));
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
