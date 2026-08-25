/**
 * Checks for the exact clean-win search. Run: node tools/test_exact.js
 *
 * This module makes the strongest claim in the repo: not "this looks good" but
 * "play these moves and nothing dies". A claim like that is only worth anything
 * if it is checked against the engine rather than against the search's own
 * bookkeeping, so the central test here REPLAYS every line it returns and
 * asserts the battle really is won with nobody lost. A proof that cannot be
 * replayed is not a proof, it is a bug with good manners.
 *
 * The other thing under test is the honesty of "impossible". Running out of
 * budget and having exhausted the search are completely different answers, and
 * reporting the first as the second would tell someone a winnable fight is
 * unwinnable. `decided` is what separates them and it is asserted directly.
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
	'src/js/rr-plan.js', 'src/js/rr-solver.js', 'src/js/rr-matchup.js',
	'src/js/rr-exact.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
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

const fainted = side => side.team.filter(m => m.fainted).length;

/**
 * Replay a line through the engine, independently of the search.
 *
 * Deliberately does NOT reuse anything the search stored: it re-derives the
 * opponent's reply and re-runs every transition, so a bug in the search cannot
 * hide itself here.
 */
function replay(state, steps) {
	let current = state;
	for (const step of steps) {
		const before = fainted(current.me);
		current = B.step(current, step.action, step.theirAction,
			{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
		if (fainted(current.me) > before) {
			return {ok: false, why: 'lost a Pokemon on turn ' + step.turn};
		}
	}
	const cleared = current.foe.team.every(m => m.fainted);
	if (!cleared) return {ok: false, why: 'the opposing team is not down'};
	return {ok: true};
}

// ------------------------------------------------------- a fight it must win

{
	const state = B.createState(
		[set('Blastoise', ['Surf', 'Ice Beam', 'Bite', 'Rapid Spin'], 45)],
		[set('Geodude', ['Rock Throw', 'Defense Curl'], 13)], {});
	const result = X.cleanWin(state, {budget: 200000});
	check('it finds a line in a fight it cannot lose', result.found === true,
		JSON.stringify({decided: result.decided, nodes: result.nodes}));
	if (result.found) {
		const verdict = replay(state, X.toSteps(result.line));
		check('  and the line replays as a real clean win', verdict.ok, verdict.why);
	}
}

// A real early-game fight with a full party, replayed the same way.
{
	const TRAINERS = sandbox.RR_TRAINER_DATA;
	let brock = null;
	for (const segment of TRAINERS.segments) {
		for (const b of (segment.battles || [])) {
			if (/BROCK/.test(b.trainer || '') && !brock &&
				b.team[0].level.type === 'fixed') brock = b;
		}
	}
	const foe = brock.team.map(m => ({
		species: m.species, level: m.level.value, nature: m.nature,
		ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
		evs: m.evs, ivs: m.ivs
	}));
	const level = brock.team[0].level.value + 8;
	const party = [
		set('Squirtle', ['Water Gun', 'Bite', 'Withdraw', 'Tackle'], level, {item: 'Oran Berry'}),
		set('Bulbasaur', ['Vine Whip', 'Leech Seed', 'Tackle', 'Growl'], level, {item: 'Oran Berry'}),
		set('Mankey', ['Karate Chop', 'Low Kick', 'Scratch', 'Leer'], level, {item: 'Oran Berry'}),
		set('Pikachu', ['Thunder Shock', 'Quick Attack', 'Tail Whip'], level, {item: 'Oran Berry'})
	];
	const state = B.createState(party, foe, {});
	const result = X.cleanWin(state, {budget: 400000});
	check('it settles a real gym fight (' +
		(result.found ? 'found' : result.decided ? 'impossible' : 'undecided') +
		', ' + result.nodes + ' nodes)', result.decided === true);
	if (result.found) {
		const verdict = replay(state, X.toSteps(result.line));
		check('  and that line replays clean too', verdict.ok, verdict.why);
	}
}

// ------------------------------------------------- running out is not a proof

// This test is SELF-VALIDATING, after three wrong guesses about what counts as
// a hard position. Move ordering settles fights in tens of nodes, and a party
// weak enough to look hard instead gets proved impossible immediately, so both
// attempts to pick a "big" fight by eye failed. Rather than guess again, it
// measures how many nodes the fight actually costs and then starves it.
{
	const TRAINERS = sandbox.RR_TRAINER_DATA;
	let brock = null;
	for (const segment of TRAINERS.segments) {
		for (const b of (segment.battles || [])) {
			if (/BROCK/.test(b.trainer || '') && !brock &&
				b.team[0].level.type === 'fixed') brock = b;
		}
	}
	const foe = brock.team.map(m => ({
		species: m.species, level: m.level.value, nature: m.nature,
		ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
		evs: m.evs, ivs: m.ivs
	}));
	const level = brock.team[0].level.value + 8;
	const party = [
		set('Squirtle', ['Water Gun', 'Bite', 'Withdraw', 'Tackle'], level, {item: 'Oran Berry'}),
		set('Bulbasaur', ['Vine Whip', 'Leech Seed', 'Tackle', 'Growl'], level, {item: 'Oran Berry'}),
		set('Mankey', ['Karate Chop', 'Low Kick', 'Scratch', 'Leer'], level, {item: 'Oran Berry'}),
		set('Pikachu', ['Thunder Shock', 'Quick Attack', 'Tail Whip'], level, {item: 'Oran Berry'})
	];
	const state = B.createState(party, foe, {});

	// Both searches run as a single exhaustive pass. What is being tested is
	// that a budget too small to finish the TREE reports undecided, so the
	// budget has to be starved relative to the tree -- and with the hunt passes
	// on, `full.nodes` counts three restarts over the same tree rather than the
	// tree, so a third of it was still comfortably enough to finish and the
	// search rightly said so. Guessing a budget instead of deriving one has been
	// wrong here before; this derives it from the right measurement.
	const full = X.cleanWin(state, {budget: 400000, hunt: false, matchup: null});
	const starved = X.cleanWin(state, {budget: Math.max(1, Math.floor(full.nodes / 3)),
		hunt: false, matchup: null});

	check('the same fight is settled with budget and not without (' +
		full.nodes + ' nodes needed)', full.decided === true && starved.decided === false,
		JSON.stringify({full: full.decided, starved: starved.decided}));
	check('  a starved search never claims impossible',
		starved.found === false && starved.decided === false);
	check('  and returns no line to play', starved.line === null);

	const route = X.planRoute(state, {budget: 3, lookahead: 2, maxTurns: 20});
	check('it falls back to a heuristic route rather than giving up',
		Array.isArray(route.steps) && route.steps.length > 0,
		'exactness ' + route.exactness);
	check('  and does not call the fallback a proof',
		route.exactness !== 'proved', route.exactness);
}

// A search that finishes is allowed to say impossible: one Pokemon that cannot
// hurt what is in front of it has no clean line and the search can prove it.
{
	const state = B.createState(
		[set('Magikarp', ['Splash'], 5)],
		[set('Onix', ['Rock Tomb'], 30)], {});
	const result = X.cleanWin(state, {budget: 200000});
	check('a finished search may report impossible',
		result.found === false && result.decided === true,
		JSON.stringify({found: result.found, decided: result.decided}));
}

// ----------------------------------------------------------- the route façade

{
	const state = B.createState(
		[set('Blastoise', ['Surf', 'Ice Beam', 'Bite', 'Rapid Spin'], 45)],
		[set('Geodude', ['Rock Throw'], 13)], {});
	const route = X.planRoute(state, {budget: 200000});
	// "line-found", not "proved". The fast search runs at MEDIAN damage rolls
	// against the AI's single best move, so it cannot speak for the sixteenth
	// roll, a critical hit, or the 7% of positions where the AI has tied moves.
	// It used to claim "proved" here and that claim was false.
	check('a line at median rolls is NOT called proved',
		route.won === true && route.losses === 0 && route.exactness === 'line-found',
		JSON.stringify({won: route.won, losses: route.losses, exactness: route.exactness}));

	// Certification is the separate, expensive question, and it must survive
	// every roll and every tied AI move.
	const certified = X.planRoute(state, {budget: 200000, certify: true,
		certifyBudget: 300000, certifyTimeLimitMs: 20000});
	check('  a fight that genuinely cannot be lost certifies (' +
		certified.exactness + ')', certified.exactness === 'certified',
		certified.certificate && certified.certificate.why);

	// And the certifier must refuse when it did not get to look properly. The
	// position has to be one that genuinely cannot be settled cheaply: three
	// earlier attempts used fights that resolve in a couple of nodes, where no
	// budget worth naming is ever binding. Misty against a mediocre party is
	// measured to run past millions of nodes without deciding.
	const TRAINERS2 = sandbox.RR_TRAINER_DATA;
	let misty2 = null;
	for (const segment of TRAINERS2.segments) {
		for (const b of (segment.battles || [])) {
			if (/MISTY/.test(b.trainer || '') && !misty2 &&
				b.team[0].level.type === 'fixed') misty2 = b;
		}
	}
	const mistyFoe = misty2.team.map(m => ({
		species: m.species, level: m.level.value, nature: m.nature,
		ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
		evs: m.evs, ivs: m.ivs
	}));
	const hardState = B.createState([
		set('Poliwrath', ['Body Slam', 'Hypnosis', 'Bubble Beam', 'Double Slap'],
			misty2.team[0].level.value + 2),
		set('Weezing', ['Smog', 'Haze', 'Tackle', 'Poison Gas'],
			misty2.team[0].level.value + 2)
	], mistyFoe, {});
	const starved = X.certify(hardState, {exactBudget: 3000, maxTurns: 24});
	check('  a certifier that ran out of budget refuses to certify',
		starved.proved === false, starved.why);
		check('    and says why', typeof starved.why === 'string' && starved.why.length > 0,
		starved.why);
}

// ------------------------------------------------------ the time limit binds

// A cap that does not bind is worse than no cap, because everything downstream
// is planned around it. The first version set an "exhausted" flag and returned
// from the node that noticed, while the other 1023 nodes in the batch carried on
// searching -- so a 12 second cap ran for over three minutes and stopped only
// when the NODE budget ran out. A whole overnight benchmark run was lost to it.
{
	const TRAINERS = sandbox.RR_TRAINER_DATA;
	let misty = null;
	for (const segment of TRAINERS.segments) {
		for (const b of (segment.battles || [])) {
			if (/MISTY/.test(b.trainer || '') && !misty &&
				b.team[0].level.type === 'fixed') misty = b;
		}
	}
	const foe = misty.team.map(m => ({
		species: m.species, level: m.level.value, nature: m.nature,
		ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
		evs: m.evs, ivs: m.ivs
	}));
	const level = misty.team[0].level.value + 2;
	// Deliberately a party that neither wins quickly nor loses quickly, so the
	// search has to be stopped rather than finishing on its own.
	const party = [
		set('Poliwrath', ['Body Slam', 'Hypnosis', 'Bubble Beam', 'Double Slap'], level),
		set('Weezing', ['Smog', 'Haze', 'Tackle', 'Poison Gas'], level),
		set('Persian', ['Bite', 'Screech', 'Growl', 'Fury Swipes'], level)
	];
	const state = B.createState(party, foe, {});
	const cap = 3000;
	const started = Date.now();
	const result = X.cleanWin(state, {exactBudget: 5000000, maxTurns: 30,
		timeLimitMs: cap});
	const took = Date.now() - started;
	check('the time limit actually stops the search (' + took + 'ms for a ' +
		cap + 'ms cap)', took < cap * 2,
		'ran ' + took + 'ms, ' + result.nodes + ' nodes');
	check('  and a search stopped by the clock is UNDECIDED',
		result.decided === false && result.found === false);
}

// --------------------------------------------------- more turns cannot hurt

// A soundness invariant that the old position-only memo could break: if a clean
// line is found with N turns to work with, it must still be found with more.
// The old code keyed its visited set on the position alone, so a position that
// failed with two turns left silently suppressed the same position reached with
// eighteen -- which loses real wins and can manufacture a false "impossible".
{
	const TRAINERS = sandbox.RR_TRAINER_DATA;
	let brock = null;
	for (const segment of TRAINERS.segments) {
		for (const b of (segment.battles || [])) {
			if (/BROCK/.test(b.trainer || '') && !brock &&
				b.team[0].level.type === 'fixed') brock = b;
		}
	}
	const foe = brock.team.map(m => ({
		species: m.species, level: m.level.value, nature: m.nature,
		ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
		evs: m.evs, ivs: m.ivs
	}));
	const level = brock.team[0].level.value + 4;
	const party = [
		set('Squirtle', ['Water Gun', 'Bite', 'Withdraw', 'Tackle'], level, {item: 'Oran Berry'}),
		set('Bulbasaur', ['Vine Whip', 'Leech Seed', 'Tackle', 'Growl'], level, {item: 'Oran Berry'}),
		set('Mankey', ['Karate Chop', 'Low Kick', 'Scratch', 'Leer'], level, {item: 'Oran Berry'})
	];
	const state = B.createState(party, foe, {});

	let firstFound = null, broke = null;
	for (const turns of [10, 14, 18, 24]) {
		const r = X.cleanWin(state, {exactBudget: 300000, maxTurns: turns});
		if (r.found && firstFound === null) firstFound = turns;
		if (firstFound !== null && !r.found) broke = turns;
	}
	check('a line found at one horizon is still found at a longer one' +
		(firstFound === null ? ' (never found, invariant vacuous)'
			: ' (first found at ' + firstFound + ')'),
		broke === null, 'lost the line at maxTurns ' + broke);
}

/**
 * Blurring positions together may speed the hunt and must never reach a verdict.
 *
 * Two positions a point of HP apart really can differ -- one survives the hit
 * and the other does not -- so a search that treats them as the same can miss a
 * line. Missing a line is survivable, since the answer is then "undecided".
 * Reporting that no line EXISTS on the strength of a blurred search is the one
 * thing this module must never do, which is why bucketing is confined to passes
 * that are already forbidden from concluding.
 */
{
	const level = 20;
	const party = [
		set('Squirtle', ['Water Gun', 'Bite', 'Withdraw', 'Tackle'], level, {item: 'Oran Berry'}),
		set('Bulbasaur', ['Vine Whip', 'Leech Seed', 'Tackle', 'Growl'], level, {item: 'Oran Berry'})
	];
	const enemy = [set('Geodude', ['Tackle', 'Defense Curl'], 12)];
	const state = B.createState(party, enemy, {});

	const coarse = X.cleanWin(state, {exactBudget: 200000, maxTurns: 16, hpBuckets: 8});
	const exact = X.cleanWin(state, {exactBudget: 200000, maxTurns: 16});
	check('a bucketed search finds what the exact one finds here',
		coarse.found === exact.found,
		JSON.stringify({coarse: coarse.found, exact: exact.found}));
	if (coarse.found) {
		// The blurring is only safe because a returned line is verified by
		// construction: every step of it was simulated by the real engine.
		let lost = 0;
		for (const step of coarse.line) {
			const n = step.next.me.team.filter(m => m.fainted).length;
			if (n > lost) lost = n;
		}
		check('  and the line it returns really does lose nobody', lost === 0,
			lost + ' lost');
	}
}

// ---------------------------------------------------------------------------
// The cheapest win, when a clean one does not exist.
//
// The fight to test this on has to be one where no clean line exists AND the
// fight is still winnable, which is rare and easy to get wrong -- most fights
// are either cleanly winnable or hopeless. VIRID. FOREST / ACE TRAINER NELLE
// as a mirror is the measured case: cleanWin exhausts the tree in about a
// thousand nodes and proves there is no clean line, and the fight is won losing
// exactly one.
{
	const H = require('./lib/harness.js');
	const loaded = H.loadEngine();
	const battles = H.earlyBattles(loaded, {maxLevel: 100, relativeBase: 75});
	const battle = battles.filter(b => H.label(b).toUpperCase().includes('NELLE'))[0];
	if (!battle) {
		check('the min-loss fixture battle is still in the dataset', false,
			'NELLE not found');
	} else {
		const theirs = H.foeSets(battle);
		const ours = theirs.map(s => Object.assign({}, s, {level: s.level + 1}));
		const mk = () => loaded.B.createState(ours, theirs, {});

		loaded.B.clearCache();
		const clean = loaded.X.cleanWin(mk(), {exactBudget: 400000, maxTurns: 24});
		check('a fight with no clean line is still proved to have none',
			clean.decided && !clean.found,
			JSON.stringify({found: clean.found, decided: clean.decided}));

		loaded.B.clearCache();
		const cheap = loaded.X.cheapestWin(mk(),
			{exactBudget: 400000, maxTurns: 24, maxLosses: 2});
		check('  and the cheapest win is found anyway',
			cheap.found === true, JSON.stringify({found: cheap.found}));
		check('  losing as few as possible, not merely few',
			cheap.losses === 1, 'losses=' + cheap.losses);
		if (cheap.found) {
			// The claim is about the LINE, so read the line rather than trust
			// the number that came back with it.
			let worst = 0;
			for (const step of cheap.line) {
				const n = step.next.me.team.filter(m => m.fainted).length;
				if (n > worst) worst = n;
			}
			check('  and the line really costs exactly that many',
				worst === cheap.losses, 'line lost ' + worst);
			const beaten = cheap.line[cheap.line.length - 1].next.foe.team
				.every(m => m.fainted);
			check('  and it really does finish the opponent', beaten);
		}

		// Minimality is a separate and stronger claim than cheapness, and it
		// must be earned. Here it is: the k=0 search above came back DECIDED,
		// so "losing one is the least this can cost" is a searched fact.
		check('  and it knows whether that really is the least it can cost',
			cheap.minimal === true && clean.decided === true,
			JSON.stringify({minimal: cheap.minimal, k0decided: clean.decided}));

		// The same claim must NOT survive a search that could not finish. A
		// starved run has ruled nothing out and has to say so.
		loaded.B.clearCache();
		const starved = loaded.X.cheapestWin(mk(),
			{exactBudget: 400, maxTurns: 24, maxLosses: 2});
		check('  and a starved search claims no minimality at all',
			starved.minimal !== true,
			JSON.stringify({found: starved.found, minimal: starved.minimal}));

		// The whole point is that the PLANNER acts on it, not just that the
		// search can find it. Before this, planRoute proved no clean line
		// existed and then handed the fight to a weighted search still trying
		// to preserve everything, which loses 0-2 here.
		loaded.B.clearCache();
		const planned = loaded.X.planRoute(mk(), {exactBudget: 400000,
			maxTurns: 24, lookahead: 2, budget: 30000, risks: {roll: 'median'}});
		check('  the planner now WINS the fight it used to lose',
			planned.won === true && planned.losses === 1,
			JSON.stringify({won: planned.won, losses: planned.losses}));
		check('  and still says plainly that no clean line exists',
			planned.exactness === 'no-clean-line-exists', planned.exactness);

		// The default must be untouched: lossBudget 0 is the old cut exactly.
		loaded.B.clearCache();
		const zero = loaded.X.cleanWin(mk(),
			{exactBudget: 400000, maxTurns: 24, lossBudget: 0});
		check('  a loss budget of zero is the clean search, node for node',
			zero.nodes === clean.nodes && zero.found === clean.found,
			JSON.stringify({zero: zero.nodes, clean: clean.nodes}));
	}
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
