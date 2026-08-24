/**
 * The ceiling: how many of these fights can be won cleanly AT ALL?
 *
 * Run: node tools/ceiling.js [teams] [budget]
 *
 * Every quality number in this repo is a fraction of fights won without losing
 * a Pokemon, and that fraction has been read as though 100% were the target.
 * It is not. Some of these fights cannot be won cleanly by the team the
 * generator handed over, and no planner however good will win those. Until the
 * ceiling is known, "62%" cannot be told apart from "62% of an achievable 65%"
 * or "62% of an achievable 95%", and those call for completely different work.
 *
 * This is computable exactly, because of something specific to this problem
 * rather than to Pokemon in general. The benchmark scores routes under
 * DETERMINISTIC dynamics -- median damage rolls, and the AI's argmax reply --
 * and trainer teams are fully known. So there is no hidden information and no
 * dice: "does a clean win exist" is plain reachability in a finite graph, and a
 * depth-first search with memoisation answers it exactly rather than
 * estimating it.
 *
 * What makes it affordable is the Nuzlocke objective itself. The moment any of
 * your Pokemon faints the branch is dead and gets cut, so the search only ever
 * explores lines where nothing has died yet, which is a small corner of the
 * tree.
 *
 * Three outcomes per fight, and the difference between the last two matters:
 *   CLEAN WIN EXISTS   a line was found; if the planner misses it, that is on
 *                      the planner
 *   IMPOSSIBLE         the search finished having tried everything; no line
 *                      exists, and no planner can win this one cleanly
 *   UNKNOWN            the node budget ran out first, so this is undecided and
 *                      must not be counted as either
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
const S = sandbox.RRSolver;
const AI = sandbox.RRAI;
const TRAINERS = sandbox.RR_TRAINER_DATA;

const dex = new Function('return ' +
	fs.readFileSync(path.join(root, 'data/rr-dex-data.js'), 'utf8') + ';')();
const moveName = {};
for (const key in dex.moves) moveName[dex.moves[key].ID] = dex.moves[key].name;
const byID = {};
for (const key in dex.species) byID[dex.species[key].ID] = dex.species[key];

// Team generation, kept identical to tools/bench_early.js so the ceiling is
// measured on exactly the teams the benchmark scores.
const BY_LEVEL = {4: true, 22: true, 23: true};
const EARNED = {7: true, 1: true};
function evolve(species, level) {
	const chain = [species];
	let current = species;
	for (let hop = 0; hop < 4; hop++) {
		let next = null;
		for (const evo of (current.evolutions || [])) {
			const method = evo[0], param = evo[1], target = byID[evo[2]];
			if (!target || target.ID === current.ID) continue;
			if (BY_LEVEL[method] && param <= level) { next = target; break; }
			if (EARNED[method] && level >= 28) { next = target; break; }
		}
		if (!next) break;
		current = next;
		chain.push(current);
	}
	return {species: current, chain: chain};
}
const POOL = Object.values(dex.species).filter(function (sp) {
	return sp.dexID && sp.dexID <= 143 && (sp.levelupMoves || []).length >= 4 &&
		!(sp.name || '').includes('-');
});
let seed = 12345;
function rand(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}
const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const NATURES = ['Adamant', 'Modest', 'Jolly', 'Timid', 'Impish', 'Careful'];
function build(base, level) {
	const grown = evolve(base, level);
	const seen = {}, known = [];
	for (const stage of grown.chain) {
		for (const pair of (stage.levelupMoves || [])) {
			if (pair[1] > level) continue;
			const name = moveName[pair[0]];
			if (!name || seen[name]) continue;
			seen[name] = true;
			known.push(name);
		}
	}
	const moves = known.slice(-4);
	if (!moves.length) return null;
	const ability = (grown.species.abilities && grown.species.abilities[0] &&
		dex.abilities && dex.abilities[grown.species.abilities[0][0]]) || null;
	return {species: grown.species.name, level: level,
		nature: NATURES[rand(NATURES.length)],
		ability: ability && ability.name ? ability.name : undefined,
		item: 'Oran Berry', moves: moves, evs: EVS, ivs: IVS};
}
function team(level, size) {
	const out = [];
	let guard = 0;
	while (out.length < size && guard++ < 300) {
		const set = build(POOL[rand(POOL.length)], level);
		if (!set) continue;
		if (out.some(m => m.species === set.species)) continue;
		try { new calc.Pokemon(calc.Generations.get(9), set.species, {level: level}); }
		catch (e) { continue; }
		out.push(set);
	}
	return out;
}

const RISKS = {roll: 'median'};

/** The AI's argmax reply: the same opponent the benchmark's routes face. */
function reply(state) {
	const flags = {checkBadMove: true, checkGoodMove: true};
	const scored = AI.scoreAll(state, 'foe', flags, {});
	const gate = AI.switchGate(state, 'foe', flags);
	let best = null;
	for (const entry of scored) {
		if (entry.action.type === 'switch' && !gate.maySwitch) continue;
		if (!best || entry.score > best.score) best = entry;
	}
	return best ? best.action : null;
}

const fainted = side => side.team.filter(m => m.fainted).length;
const allDown = side => side.team.every(m => m.fainted);

/**
 * Try the promising actions first.
 *
 * This is a search for ONE witness, not for all of them: the moment a clean
 * line is found the answer is yes and everything else is wasted work. So the
 * order actions are tried in decides almost the whole cost. Attacks that
 * actually threaten the Pokemon in front go first, biggest first, and switches
 * go last because they are rarely the start of a winning line and there are a
 * lot of them.
 *
 * This changes nothing about the answer, only how long it takes to reach it --
 * the search is still exhaustive when it reports IMPOSSIBLE.
 */
function ordered(state) {
	const defender = B.active(state.foe);
	return B.legalActions(state, 'me').map(function (action) {
		let rank;
		if (action.type === 'switch') {
			rank = -1;
		} else {
			const rolls = B.damageRolls(state, 'me', action.move);
			const hit = rolls ? rolls.noCrit[rolls.noCrit.length - 1] : 0;
			// A move that kills outright beats one that merely hurts.
			rank = hit >= defender.curHP ? 1000 + hit : hit;
		}
		return {action: action, rank: rank};
	}).sort(function (a, b) { return b.rank - a.rank; })
		.map(function (entry) { return entry.action; });
}

/**
 * Is a clean win reachable from here?
 *
 * Returns true as soon as one line is found. `budget` bounds the work; when it
 * runs out the answer is UNKNOWN rather than false, which is why the caller
 * checks `exhausted` before counting anything as impossible.
 */
function cleanWinExists(state, limits) {
	const seen = new Set();

	function walk(current, turnsLeft) {
		if (limits.nodes++ > limits.budget) { limits.exhausted = true; return false; }
		if (allDown(current.foe)) return true;
		if (turnsLeft <= 0) { limits.truncated = true; return false; }

		const key = B.positionKey(current);
		if (seen.has(key)) return false;
		seen.add(key);

		const theirs = reply(current);
		if (!theirs) return false;

		const before = fainted(current.me);
		for (const mine of ordered(current)) {
			let next;
			try {
				next = B.step(current, mine, theirs, {mode: 'maxroll', risks: RISKS})[0].state;
			} catch (e) { continue; }
			// The pruning that makes this tractable: one death and the line is
			// worthless, so it is cut rather than explored.
			if (fainted(next.me) > before) continue;
			if (walk(next, turnsLeft - 1)) return true;
		}
		return false;
	}

	return walk(state, limits.maxTurns);
}

const early = [];
for (const segment of TRAINERS.segments) {
	for (const b of (segment.battles || [])) {
		if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
		if (b.team[0].level.type !== 'fixed') continue;
		if (b.team[0].level.value > 34) continue;
		early.push(b);
	}
}

const teamCount = parseInt(process.argv[2], 10) || 5;
const budget = parseInt(process.argv[3], 10) || 300000;

let possible = 0, impossible = 0, unknown = 0, plannerWon = 0, missed = 0;
const perBattle = {};

for (let t = 0; t < teamCount; t++) {
	for (const battle of early) {
		const level = battle.team[0].level.value + 2;
		const party = team(level, 6);
		if (party.length < 6) continue;
		const foe = battle.team.map(m => ({
			species: m.species, level: m.level.value, nature: m.nature,
			ability: m.ability, item: m.item || '', moves: m.moves.slice(0, 4),
			evs: m.evs, ivs: m.ivs
		}));
		const title = (battle.title ? battle.title + ' ' : '') + battle.trainer;
		perBattle[title] = perBattle[title] ||
			{possible: 0, impossible: 0, unknown: 0, won: 0, n: 0};
		const row = perBattle[title];
		row.n++;

		// What the shipped planner actually manages.
		B.clearCache();
		let route = null;
		try {
			route = S.planRoute(B.createState(party, foe, {}),
				{lookahead: 2, budget: 20000, maxTurns: 30, risks: RISKS});
		} catch (e) { /* counted as not won */ }
		const won = !!(route && route.won && route.losses === 0);
		if (won) { plannerWon++; row.won++; }

		// What was available.
		B.clearCache();
		const limits = {nodes: 0, budget: budget, exhausted: false,
			truncated: false, maxTurns: 24};
		let exists = false;
		try { exists = cleanWinExists(B.createState(party, foe, {}), limits); }
		catch (e) { limits.exhausted = true; }

		if (exists) { possible++; row.possible++; if (!won) missed++; }
		else if (limits.exhausted || limits.truncated) { unknown++; row.unknown++; }
		else { impossible++; row.impossible++; }
	}
}

const total = possible + impossible + unknown;
console.log('Ceiling check: ' + early.length + ' battles x ' + teamCount +
	' teams = ' + total + ' fights, budget ' + budget + ' nodes each\n');
console.log('  a clean win EXISTS          ' + String(possible).padStart(4) +
	'  (' + Math.round(100 * possible / total) + '%)');
console.log('  provably IMPOSSIBLE         ' + String(impossible).padStart(4) +
	'  (' + Math.round(100 * impossible / total) + '%)   no planner can win these');
console.log('  undecided (budget ran out)  ' + String(unknown).padStart(4) +
	'  (' + Math.round(100 * unknown / total) + '%)\n');
console.log('  the planner won cleanly     ' + String(plannerWon).padStart(4) +
	'  (' + Math.round(100 * plannerWon / total) + '% of all fights)');
if (possible) {
	console.log('  of the fights it COULD win  ' + plannerWon + '/' + possible +
		'  (' + Math.round(100 * plannerWon / possible) + '%)   <- the real score');
	console.log('  winnable but missed         ' + String(missed).padStart(4));
}

console.log('\nPer battle (possible / impossible / undecided | planner won):');
Object.entries(perBattle).forEach(function (entry) {
	const k = entry[0], v = entry[1];
	console.log('  ' + k.slice(0, 30).padEnd(31) +
		String(v.possible).padStart(3) + ' /' + String(v.impossible).padStart(4) +
		' /' + String(v.unknown).padStart(4) + '   | ' + v.won + '/' + v.n);
});
