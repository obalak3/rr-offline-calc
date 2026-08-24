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
	'src/js/rr-plan.js', 'src/js/rr-solver.js', 'src/js/rr-matchup.js',
	'src/js/rr-exact.js']) {
	vm.runInContext(fs.readFileSync(path.join(root, 'upstream-calc', file), 'utf8'), sandbox);
}
const B = sandbox.RRBattle;
const S = sandbox.RRSolver;
const X = sandbox.RRExact;
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

const fainted = side => side.team.filter(m => m.fainted).length;

/**
 * Is a clean win reachable from here?
 *
 * This used to be a private copy of the exact search, living in this file. It
 * had drifted: it ranked every switch at -1, which is the exact rule rr-exact.js
 * abandoned once the proved line through Lt. Surge turned out to attack on turn
 * one and switch on turn two. So the oracle was answering with a weaker search
 * than the planner it was grading, and every fight it called "undecided" was a
 * fight a better search might have settled -- which is precisely the number this
 * whole tool exists to report.
 *
 * It now calls the shipped engine. A ceiling measured with anything else is not
 * a ceiling.
 */
function cleanWinExists(state, limits) {
	const result = X.cleanWin(state, {
		exactBudget: limits.budget,
		maxTurns: limits.maxTurns
	});
	limits.nodes = result.nodes;
	// `decided` already carries the distinction this tool turns on: a search
	// that finished knowing there is no line, versus one that simply ran out.
	limits.exhausted = !result.found && !result.decided;
	limits.truncated = false;
	return result.found;
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
const only = process.argv[4] || '';   // substring filter on the battle name
// What the planner is allowed, as against what the ORACLE is allowed above.
// The two differing is the whole point now that both are the same search: the
// oracle answers "was this winnable at all", the planner answers "was it
// winnable in the time the app actually spends".
const plannerBudget = parseInt(process.env.PLANNER_BUDGET, 10) || 200000;
const plannerMs = parseInt(process.env.PLANNER_MS, 10) || 5000;

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
		if (only && !title.includes(only)) continue;
		perBattle[title] = perBattle[title] ||
			{possible: 0, impossible: 0, unknown: 0, won: 0, n: 0};
		const row = perBattle[title];
		row.n++;

		// What the shipped planner actually manages.
		B.clearCache();
		// The planner as the app runs it -- the exact search, with the budget
		// the inline path gives it. Grading RRSolver here measured an engine
		// the app stopped asking two commits before this comment was written.
		let route = null;
		try {
			route = X.planRoute(B.createState(party, foe, {}),
				{lookahead: 2, budget: 20000, exactBudget: plannerBudget,
					timeLimitMs: plannerMs, maxTurns: 24, risks: RISKS});
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
