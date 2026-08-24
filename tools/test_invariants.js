/**
 * Properties that must hold across the whole engine. Run: node tools/test_invariants.js
 *
 * WHY A SEPARATE FILE. The other tests check that a mechanic behaves correctly
 * in a position built to exercise it. These check things that must be true of
 * EVERY position, and they are the properties whose violation would not look
 * like a bug -- it would look like a slightly different answer, and would be
 * believed.
 *
 * Each one is here because it guards a mistake this project has actually made
 * or nearly made:
 *
 *   a found line replays clean   the search asserts it; nothing checked it
 *   beams never conclude         a beam that could set `decided` would let the
 *                                app say a winnable fight is impossible
 *   caches do not leak           positionKey does NOT encode species, so a
 *                                cache surviving between fights could answer
 *                                one with another's reply
 *   determinism                  every A/B measurement in TUNING.md assumes it
 *   monotonicity                 more budget must never lose a line or reverse
 *                                a verdict
 *   step() is pure               the search branches thousands of states; a
 *                                step that mutated its input would corrupt
 *                                every sibling branch silently
 *
 * Deliberately run on REAL battles and generated teams rather than fixtures,
 * because a fixture only proves the property where somebody already looked.
 */
'use strict';

const H = require('./lib/harness.js');

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const loaded = H.loadEngine();
const dexParts = H.loadDex();
const B = loaded.B, X = loaded.X;
const battles = H.earlyBattles(loaded);

function freshGen() { return H.makeGenerator(H.loadEngine(), dexParts); }
function partyFor(gen, battle) {
	return gen.team(battle.team[0].level.value + 2, 6);
}

// ------------------------------------------------ a found line really is clean
{
	const gen = freshGen();
	let checked = 0, broken = 0;
	for (let t = 0; t < 2; t++) {
		for (const battle of battles) {
			const party = partyFor(gen, battle);
			if (party.length < 6) continue;
			B.clearCache();
			const r = X.cleanWin(B.createState(party, H.foeSets(battle), {}),
				{exactBudget: 30000, maxTurns: 20});
			if (!r.found) continue;
			checked++;
			// Replayed from the line's own states, not from the search's word.
			for (const step of r.line) {
				if (step.next.me.team.some(m => m.fainted)) broken++;
			}
			const end = r.line[r.line.length - 1].next;
			if (!end.foe.team.every(m => m.fainted)) broken++;
		}
	}
	check('every found line loses nobody and finishes the opponent (' +
		checked + ' lines)', broken === 0, broken + ' violation(s)');
	check('  and the sample was not empty', checked > 0, checked + ' lines found');
}

// ------------------------------------------------------ a beam never concludes
{
	const gen = freshGen();
	let runs = 0, unsound = 0;
	for (const battle of battles) {
		const party = partyFor(gen, battle);
		if (party.length < 6) continue;
		B.clearCache();
		const r = X.cleanWin(B.createState(party, H.foeSets(battle), {}), {
			exactBudget: 20000, maxTurns: 20, hpBuckets: 8,
			passes: [{beam: 3, turns: 20, share: 1, matchup: false}]
		});
		runs++;
		if (r.decided && !r.found) unsound++;
	}
	check('a beamed, bucketed search never claims a fight is impossible (' +
		runs + ' runs)', unsound === 0, unsound + ' false verdict(s)');
}

// ------------------------------------------------------------ caches are clean
{
	const gen = freshGen();
	let differed = 0, checked = 0;
	function solve(battle, party) {
		const r = X.cleanWin(B.createState(party, H.foeSets(battle), {}),
			{exactBudget: 25000, maxTurns: 18});
		return r.found ? 'found' : (r.decided ? 'decided' : 'undecided');
	}
	for (let i = 0; i < battles.length; i++) {
		const party = partyFor(gen, battles[i]);
		if (party.length < 6) continue;
		B.clearCache();
		const cold = solve(battles[i], party);
		// Solve a DIFFERENT fight first and deliberately do not clear.
		B.clearCache();
		const other = battles[(i + 1) % battles.length];
		const otherParty = partyFor(gen, other);
		if (otherParty.length === 6) solve(other, otherParty);
		const warm = solve(battles[i], party);
		checked++;
		if (cold !== warm) differed++;
	}
	check('a fight answers the same on warm caches from another fight (' +
		checked + ' fights)', differed === 0, differed + ' differed');
}

// -------------------------------------------------------------- determinism
{
	function fingerprint() {
		const gen = freshGen();
		let out = '';
		for (let i = 0; i < 6; i++) {
			out += gen.team(36, 6)
				.map(m => m.species + ':' + m.moves.join(',') + ':' + m.ability).join('|');
		}
		return out;
	}
	check('the generator is reproducible', fingerprint() === fingerprint());

	const gen = freshGen();
	let drifted = 0, checked = 0;
	for (const battle of battles) {
		const party = partyFor(gen, battle);
		if (party.length < 6) continue;
		const opts = {exactBudget: 15000, maxTurns: 18};
		B.clearCache();
		const a = X.cleanWin(B.createState(party, H.foeSets(battle), {}), opts);
		B.clearCache();
		const b = X.cleanWin(B.createState(party, H.foeSets(battle), {}), opts);
		checked++;
		if (a.found !== b.found || a.decided !== b.decided || a.nodes !== b.nodes) drifted++;
	}
	check('  and the search is, node for node (' + checked + ' fights)',
		drifted === 0, drifted + ' drifted');
}

// -------------------------------------------------------------- monotonicity
{
	const gen = freshGen();
	let lost = 0, contradicted = 0, checked = 0;
	for (const battle of battles) {
		const party = partyFor(gen, battle);
		if (party.length < 6) continue;
		const results = [];
		for (const budget of [6000, 30000, 120000]) {
			B.clearCache();
			results.push(X.cleanWin(B.createState(party, H.foeSets(battle), {}),
				{exactBudget: budget, maxTurns: 18}));
		}
		checked++;
		for (let i = 1; i < results.length; i++) {
			if (results[i - 1].found && !results[i].found) lost++;
			if (results[i - 1].decided && !results[i - 1].found && results[i].found) {
				contradicted++;
			}
		}
	}
	check('more budget never loses a line (' + checked + ' fights)', lost === 0);
	check('  and never reverses an "impossible"', contradicted === 0);
}

// ------------------------------------------------------------- step() is pure
{
	const gen = freshGen();
	let steps = 0, mutated = 0;
	for (const battle of battles) {
		const party = partyFor(gen, battle);
		if (party.length < 6) continue;
		let state = B.createState(party, H.foeSets(battle), {});
		for (let turn = 0; turn < 6; turn++) {
			const before = B.positionKey(state);
			const mine = B.legalActions(state, 'me');
			const theirs = B.legalActions(state, 'foe');
			if (!mine.length || !theirs.length) break;
			let next;
			try {
				next = B.step(state, mine[0], theirs[0],
					{mode: 'maxroll', risks: {roll: 'median'}})[0].state;
			} catch (e) { break; }
			steps++;
			if (B.positionKey(state) !== before) mutated++;
			state = next;
		}
	}
	check('step() never mutates the state it was given (' + steps + ' steps)',
		mutated === 0, mutated + ' mutation(s)');
}

console.log('\n' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
