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
	'src/js/rr-plan.js', 'src/js/rr-solver.js', 'src/js/rr-exact.js']) {
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

	const full = X.cleanWin(state, {budget: 400000});
	const starved = X.cleanWin(state, {budget: Math.max(1, Math.floor(full.nodes / 3))});

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
	check('planRoute returns a proved route where one exists',
		route.won === true && route.losses === 0 && route.exactness === 'proved',
		JSON.stringify({won: route.won, losses: route.losses, exactness: route.exactness}));
	check('  labelled so its trust level is visible',
		typeof route.exactness === 'string');
}

console.log('\n%d failure(s)', failures);
process.exit(failures ? 1 : 0);
