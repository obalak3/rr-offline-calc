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

const H = require('./lib/harness.js');

/**
 * Engine, dex and teams from tools/lib/harness.js.
 *
 * The search in this file was unified onto the real engine earlier; the TEAM
 * GENERATOR was left as a private copy and kept the ability bug after the shared
 * one was fixed. So the tool whose entire job is to say what is ACHIEVABLE was
 * measuring it with teams that had no abilities -- which understates the ceiling
 * in exactly the direction that makes the planner look better against it.
 *
 * Everything measured by this file before 2026-08-24 should be re-run.
 */
const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B;
const S = loaded.S;
const X = loaded.X;
const AI = loaded.AI;
const TRAINERS = loaded.TRAINERS;
const team = gen.team;

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

// Level cap, overridable. It was hardcoded at 34, which is the nine early
// fights this repo has always measured on. That scope is now too narrow:
// bench_live scores the live advisor over all 36 fixed-level battles, and the
// fights doing most of the damage to that number are the Elite Four at level
// 85. A ceiling that excludes them cannot say whether those losses are the
// advisor's fault or arithmetic.
const MAX_LEVEL = parseInt(process.env.CEILING_MAX_LEVEL, 10) || 34;
const early = [];
for (const segment of TRAINERS.segments) {
	for (const b of (segment.battles || [])) {
		if ((b.effects || []).some(e => /DOUBLES/i.test(e))) continue;
		if (b.team[0].level.type !== 'fixed') continue;
		if (b.team[0].level.value > MAX_LEVEL) continue;
		early.push(b);
	}
}
console.log('battles: ' + early.length + '  (level cap ' + MAX_LEVEL + ')');
// NOTE ON WHAT THIS CEILING IS. The oracle runs cleanWin under deterministic
// dynamics -- median rolls, the AI's argmax -- and cleanWin steps in maxroll
// mode, where a secondary fires only if guaranteed or if it belongs to the
// OPPONENT (rr-battle.js:1558). So the oracle's Scald never burns either. This
// is therefore a ceiling on LUCK-FREE clean wins, and a lower bound on the real
// one. James beat Lt. Surge losing nobody and believes a burn was involved,
// which is exactly the shape of line it cannot see. Do not read a planner score
// close to this number as "close to optimal".


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
// Planner wins on fights the ORACLE could not settle. These are not a bug and
// not a rounding error: the planner and the oracle now run the same engine, but
// the planner gets a small budget and quits early where the oracle grinds, so
// the planner sometimes stumbles onto a line the oracle never reached. Counted
// separately because mixing them into the ratio below is what made it read
// 20/20 while `missed` said 1.
let wonUndecided = 0;
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
		else if (won) wonUndecided++;
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
	// The honest ratio: wins ON FIGHTS SHOWN TO BE WINNABLE, over those fights.
	// It used to divide every planner win by that same denominator, which mixed
	// in wins on fights the oracle never settled and could read 100% while
	// fights were being missed.
	const wonAmongPossible = possible - missed;
	console.log('  of the fights it COULD win  ' + wonAmongPossible + '/' + possible +
		'  (' + Math.round(100 * wonAmongPossible / possible) + '%)   <- the real score');
	console.log('  winnable but missed         ' + String(missed).padStart(4));
	// Without this the missed count is uninterpretable. The two searches are
	// NOT given the same resources -- deliberately, since the question is
	// "winnable in the time the app spends" rather than "winnable at all" -- so
	// a miss can simply be the planner being handed less than the oracle
	// needed, rather than the planner choosing worse. Say so where the number
	// is read, not only in the source.
	if (missed) {
		console.log('    (the oracle had ' + budget.toLocaleString() +
			' nodes and no clock; the planner had ' +
			plannerBudget.toLocaleString() + ' and ' + (plannerMs / 1000) +
			's, so a miss may be budget rather than judgement)');
	}
	if (wonUndecided) {
		console.log('  won where the oracle could not decide  ' +
			String(wonUndecided).padStart(4) +
			'   (found a line the oracle never reached)');
	}
}

console.log('\nPer battle (possible / impossible / undecided | planner won):');
Object.entries(perBattle).forEach(function (entry) {
	const k = entry[0], v = entry[1];
	console.log('  ' + k.slice(0, 30).padEnd(31) +
		String(v.possible).padStart(3) + ' /' + String(v.impossible).padStart(4) +
		' /' + String(v.unknown).padStart(4) + '   | ' + v.won + '/' + v.n);
});
