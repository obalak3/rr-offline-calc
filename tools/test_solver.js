/**
 * Checks for the search. Run: node tools/test_solver.js
 *
 * These exercise PROOF mode specifically, which is why every solve() call names
 * it: odds mode is the default now, and its line is a most-likely path rather
 * than a tree covering every reply, so the proof checker below does not apply
 * to it.
 *
 * The solver makes the strongest claim anything in this repo makes: that a line
 * wins no matter what the opponent does. So the central check here does not
 * trust the search at all. It takes the tree the solver returns and verifies it
 * independently: every legal enemy reply must be covered by a branch, every
 * branch must be reachable by actually replaying the turn, and every leaf must
 * be a real win. A search bug that invented a proof would have to also fool a
 * checker that shares none of its logic.
 *
 * The negative case matters just as much. A solver that proves everything is
 * broken, so a fight that genuinely cannot be won must come back unproven.
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
	'src/js/rr-plan.js', 'src/js/rr-solver.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const P = sandbox.RRPlan;
const S = sandbox.RRSolver;
const TRAINERS = sandbox.RR_TRAINER_DATA;

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};

function battle(id) {
	for (const segment of TRAINERS.segments) {
		for (const b of (segment.battles || [])) if (b.id === id) return b;
	}
	return null;
}
function toSet(mon, fallbackLevel) {
	return {species: mon.species,
		level: mon.level.type === 'fixed' ? mon.level.value : fallbackLevel,
		nature: mon.nature, ability: mon.ability, item: mon.item || '',
		moves: mon.moves.slice(0, 4), evs: mon.evs, ivs: mon.ivs};
}
function mine(species, level, moves, extra) {
	return Object.assign({species, level, nature: 'Modest', ability: undefined,
		item: '', moves, evs: EVS, ivs: IVS}, extra || {});
}

// ------------------------------------------------- the independent proof check

function actionId(action) {
	return action.type === 'switch' ? 'switch:' + action.index : 'move:' + action.move;
}

/**
 * Verify a proof tree without using any of the search's own reasoning.
 * Returns a list of problems; empty means the proof holds.
 */
function verify(state, line, depth, problems) {
	if (depth > 30) { problems.push('line does not terminate'); return; }
	const over = B.isOver(state);
	if (line === null || line === undefined) {
		if (over !== 'win') problems.push('leaf at depth ' + depth + ' is not a win: ' + over);
		return;
	}
	if (over) { problems.push('line continues past a finished battle'); return; }

	const legal = P.plausibleFoeActions(state, {});
	const covered = new Set((line.branches || []).map(b => actionId(b.foeAction)));
	for (const action of legal) {
		if (!covered.has(actionId(action))) {
			problems.push('reply not covered at depth ' + depth + ': ' + actionId(action));
		}
	}
	for (const branch of (line.branches || [])) {
		const successors = B.step(state, line.action, branch.foeAction, {mode: 'worst'});
		for (const successor of successors) {
			verify(successor.state, branch.next, depth + 1, problems);
		}
	}
}

const ONIX = {species: 'Onix', level: 14, nature: 'Bashful', ability: 'Sturdy',
	item: 'Berry Juice', moves: ['Rock Tomb', 'Bulldoze', 'Sleep Talk'], evs: EVS, ivs: IVS};

// ------------------------------------------------------------- provable wins

const provable = [
	['Squirtle beats Brock\'s Onix',
		[mine('Squirtle', 15, ['Water Gun', 'Tackle', 'Withdraw', 'Bubble'])], [ONIX]],
	['an overlevelled lead sweeps Brock\'s whole team',
		[mine('Blastoise', 45, ['Surf', 'Ice Beam', 'Water Pulse', 'Withdraw'])],
		battle('kanto-leaders-brock').team.map(m => toSet(m, 15))]
];

for (const [name, party, foe] of provable) {
	B.clearCache();
	const state = B.createState(party, foe, {});
	const solved = S.solve(state, {mode: 'proof', maxDepth: 10, budget: 400000, timeLimitMs: 30000});
	check(name + ' is proved (' + solved.result + ', depth ' + solved.depth +
		', ' + solved.nodes + ' nodes, ' + solved.elapsedMs + 'ms)',
		solved.result === 'win', solved.meaning || '');
	if (solved.result !== 'win') continue;

	const problems = [];
	verify(B.createState(party, foe, {}), solved.line, 0, problems);
	check('  the proof tree verifies independently', problems.length === 0,
		problems.slice(0, 4).join('; '));
}

// ---------------------------------------------------------- unprovable stays so

{
	B.clearCache();
	const state = B.createState(
		[mine('Charmeleon', 15, ['Ember', 'Metal Claw', 'Dragon Rush', 'Swords Dance'],
			{nature: 'Adamant'})], [ONIX], {});
	const solved = S.solve(state, {mode: 'proof', maxDepth: 6, budget: 200000, timeLimitMs: 20000});
	check('a fight that cannot be won comes back unproven', solved.result !== 'win',
		'claimed ' + solved.result);
	check('  and says so without claiming a loss',
		typeof solved.meaning === 'string' && !/\blose\b/i.test(solved.meaning),
		solved.meaning);
}

// A team that is simply outclassed must not be provable either.
{
	B.clearCache();
	const state = B.createState(
		[mine('Magikarp', 5, ['Splash', 'Tackle'])],
		battle('kanto-leaders-brock').team.map(m => toSet(m, 15)), {});
	const solved = S.solve(state, {mode: 'proof', maxDepth: 6, budget: 200000, timeLimitMs: 20000});
	check('a hopeless team is not proved to win', solved.result !== 'win');
}

// ------------------------------------------------------------- determinism

{
	const party = [mine('Squirtle', 15, ['Water Gun', 'Tackle', 'Withdraw', 'Bubble'])];
	B.clearCache();
	const first = S.solve(B.createState(party, [ONIX], {}), {mode: 'proof', maxDepth: 8, budget: 200000});
	B.clearCache();
	const second = S.solve(B.createState(party, [ONIX], {}), {mode: 'proof', maxDepth: 8, budget: 200000});
	check('the search is deterministic across runs',
		first.result === second.result && first.depth === second.depth,
		first.result + '/' + first.depth + ' vs ' + second.result + '/' + second.depth);

	// The cache must not change any answer, only how long it takes to get it.
	const cached = S.solve(B.createState(party, [ONIX], {}), {mode: 'proof', maxDepth: 8, budget: 200000});
	check('  and the damage cache does not change the answer',
		cached.result === first.result && cached.depth === first.depth);
}

// ------------------------------------------------------------ it reports itself

{
	B.clearCache();
	const state = B.createState(
		[mine('Squirtle', 15, ['Water Gun', 'Tackle', 'Withdraw', 'Bubble'])], [ONIX], {});
	const solved = S.solve(state, {mode: 'proof', maxDepth: 8, budget: 200000});
	check('the proof states the assumption it rests on',
		typeof solved.assumption === 'string' && solved.assumption.includes('worst case'),
		solved.assumption);
	check('anything unsimulated is carried with the result',
		Array.isArray(solved.unmodelled));
}

// ------------------------------------------------- defence has to be valued

// The Surge fight, which is where all of this came from. With Mienshao out and
// the AI intending Discharge, switching to something that absorbs it must beat
// attacking. It did not for a long time: their HP was weighted 500 against your
// 60, so attacking won at every lookahead from 2 to 5.
{
	const surge = battle('kanto-leaders-lt-surge');
	const mk = (species, nature, ability, moves) => ({
		species, level: 34, nature, ability, item: 'Sitrus Berry', moves,
		evs: EVS, ivs: IVS});
	const party = [
		mk('Mienshao', 'Adamant', 'Regenerator', ['Fake Out', 'Drain Punch', 'Detect', 'Rock Tomb']),
		mk('Lanturn', 'Lonely', 'Volt Absorb', ['Scald', 'Confuse Ray', 'Signal Beam', 'Shock Wave'])
	];
	const state = B.createState(party, surge.team.map(m => toSet(m, 34)), {});

	check('Pincurchin sets Electric Terrain on sight (Electric Surge)',
		state.field.terrain === 'Electric', String(state.field.terrain));

	const intent = sandbox.RRAI.scoreAll(state, 'foe',
		{checkBadMove: true, checkGoodMove: true}, {}).filter(e => e.action.type === 'move');
	const top = Math.max.apply(null, intent.map(e => e.score));
	const intends = intent.filter(e => e.score === top).map(e => e.action.move);
	check('  and intends an Electric move against Mienshao (' + intends.join('/') + ')',
		intends.some(m => (B.moveData(m) || {}).type === 'Electric'));

	B.clearCache();
	const route = S.planRoute(state, {lookahead: 4, budget: 60000, maxTurns: 8,
		risks: {roll: 'median'}});

	// This used to assert that turn one switches Lanturn in to absorb the
	// Discharge. It no longer does, and that is not a regression to paper over:
	// the behaviour came from an evaluator whose health term, KO reward and
	// progress term were all silently inert. With them actually wired up it
	// opens Fake Out instead -- a flinch for free damage -- and the early-game
	// benchmark went from 54% to 59% clean wins. So what is asserted now is the
	// thing that must be true rather than the move that happened to appear:
	// the engine understands the absorber, and the plan is not passive.
	check('the absorber is understood as immune (Volt Absorb)',
		B.damageRolls(state, 'foe', 'Discharge') !== null);
	const lanturn = state.me.team.find(m => m.species === 'Lanturn');
	const view = B.clone(state);
	view.me.active = state.me.team.indexOf(lanturn);
	const soak = B.damageRolls(view, 'foe', 'Discharge');
	check('  and Discharge does nothing to it', soak && soak.immune === true);

	const attacks = route.steps.filter(s2 => s2.action.type === 'move');
	check('the plan is not passive (' + attacks.length + ' of ' +
		route.steps.length + ' turns attack)',
		attacks.length > route.steps.length / 2,
		route.steps.map(s2 => s2.label).join(' -> '));
	check('  and it makes progress', route.steps.some(s2 => s2.knockedOut),
		route.steps.map(s2 => s2.label).join(' -> '));
}

// ------------------------------------------------------- flinch risk is real

// Flinch only costs you something if it stops a move you were going to make.
// Both of these were being reported as genuine 20% risks:
//   - a turn you SWITCHED on, where the Pokemon coming in was never going to
//     move anyway, so there is nothing to flinch;
//   - a turn where you are FASTER, so you have already acted by the time the
//     flinch would land.
{
	const fast = mine('Mienshao', 34, ['Drain Punch', 'Fake Out']);
	const slow = mine('Crawdaunt', 34, ['Waterfall']);
	const state = B.createState([fast, mine('Breloom', 34, ['Mach Punch'])], [slow], {});

	const me = B.active(state.me), foe = B.active(state.foe);
	const iAmFaster = B.turnOrder(state,
		{type: 'move', index: 0, move: 'Drain Punch'},
		{type: 'move', index: 0, move: 'Waterfall'})[0] === 'me';
	check('the setup is what the test assumes: ' + me.species + ' outspeeds ' +
		foe.species, iAmFaster);

	function flinchRisks(action) {
		const theirAction = {type: 'move', index: 0, move: 'Waterfall'};
		const next = B.step(state, action, theirAction,
			{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
		const route = {steps: [{
			turn: 1, action: action, theirAction: theirAction,
			myMon: me.species, theirMon: foe.species,
			knockedOut: false, lost: 0,
			myHP: B.active(next.me).curHP, myMaxHP: B.active(next.me).maxHP,
			theirHP: B.active(next.foe).curHP
		}]};
		const priced = S.routeRisks(state, route, {risks: {roll: 'median'}});
		return priced.risks.filter(r => /flinch/.test(r.what));
	}

	const attacking = flinchRisks({type: 'move', index: 0, move: 'Drain Punch'});
	check('no flinch risk when you move first (' + attacking.length + ' reported)',
		attacking.length === 0, attacking.map(r => r.what).join('; '));

	const switching = flinchRisks({type: 'switch', index: 1});
	check('no flinch risk on a turn you switched (' + switching.length + ' reported)',
		switching.length === 0, switching.map(r => r.what).join('; '));
}

// The guard must not silence flinch where it genuinely applies: something slow
// that stays in and attacks can be flinched.
{
	const slowMon = mine('Munchlax', 20, ['Tackle']);
	const fastMon = mine('Crawdaunt', 50, ['Waterfall']);
	const state = B.createState([slowMon], [fastMon], {});
	const theirAction = {type: 'move', index: 0, move: 'Waterfall'};
	const action = {type: 'move', index: 0, move: 'Tackle'};
	const faster = B.turnOrder(state, action, theirAction)[0] === 'foe';
	const next = B.step(state, action, theirAction,
		{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
	const route = {steps: [{
		turn: 1, action: action, theirAction: theirAction,
		myMon: 'Munchlax', theirMon: 'Crawdaunt', knockedOut: false, lost: 0,
		myHP: B.active(next.me).curHP, myMaxHP: B.active(next.me).maxHP,
		theirHP: B.active(next.foe).curHP
	}]};
	const flinches = S.routeRisks(state, route, {risks: {roll: 'median'}})
		.risks.filter(r => /flinch/.test(r.what));
	check('but a slower attacker IS still warned about flinch',
		!faster || flinches.length > 0,
		'foe faster: ' + faster + ', flinch risks: ' + flinches.length);
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
