/**
 * Build a team that SHOULD beat a given boss, then ask the engine to find it.
 * Run: node tools/counter_team.js "ELITE FOUR LANCE" [budget] [--show]
 *
 * WHY THIS EXISTS, and it is a different question from every other benchmark
 * here. The others ask "can a random legal team win this", and against a late
 * boss the honest answer is usually no -- which tells us nothing about the
 * search, because there may be no line to find. A result of "undecided" is then
 * unfalsifiable: the search failing and the fight being unwinnable look
 * identical.
 *
 * So this builds the team a player would bring: one chosen against THIS
 * opponent, resisting what they hit with and hitting what they are weak to.
 * If a wincon exists and the search cannot find it, that is a search failure and
 * we have learned something. If the search finds it, we have evidence the engine
 * works at a level nothing else here has tested.
 *
 * It is deliberately NOT a superteam. The picks are ordinary fully-evolved
 * Pokemon at the trainer's level, restricted-mode legal, with no setup moves --
 * the same constraints the player has. Stacking every counter into one squad
 * would answer a question nobody asked.
 */
'use strict';

const H = require('./lib/harness.js');

const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B, X = loaded.X;
const dex = dexParts.dex;

const args = process.argv.slice(2).filter(a => a.charAt(0) !== '-');
const pattern = (args[0] || 'ELITE FOUR LANCE').toUpperCase();
const budget = parseInt(args[1], 10) || 400000;
const show = process.argv.indexOf('--show') >= 0;
// A level gradient separates the two things an "undecided" could mean. If a
// team ten levels above the boss still cannot be shown to win, the fight is not
// what is hard -- the search is. TUNING.md already uses this trick on the early
// gyms; it is the only way to tell a search failure from a fair fight.
const sweep = process.argv.indexOf('--sweep') >= 0;

const battle = H.earlyBattles(loaded, {maxLevel: 100})
	.find(b => H.label(b).toUpperCase().includes(pattern));
if (!battle) { console.error('no battle matching ' + pattern); process.exit(1); }

const speciesByName = {};
for (const key in dex.species) speciesByName[dex.species[key].name] = dex.species[key];
const typeName = id => (dex.types[id] && dex.types[id].name) || ('type' + id);

/**
 * The type chart, read from the dex's own matchup rows so this cannot disagree
 * with the damage calculation. Values are tenths: 20 is double, 5 is half, 0 is
 * an immunity, and anything else is neutral.
 */
function effectiveness(attackType, defenderTypes) {
	const row = dex.types[attackType] && dex.types[attackType].matchup;
	if (!row) return 1;
	let mult = 1;
	for (const t of defenderTypes) {
		const v = row[t];
		if (v === 20) mult *= 2;
		else if (v === 5) mult *= 0.5;
		else if (v === 1) mult *= 0;
	}
	return mult;
}

/** What the boss actually attacks with, and how hard. */
const theirTypes = [];      // attacking types they carry
const theirDefences = [];   // each foe's type pair
const moveByName = {};
for (const key in dex.moves) moveByName[dex.moves[key].name] = dex.moves[key];

for (const mon of battle.team) {
	const sp = speciesByName[mon.species];
	if (sp) theirDefences.push({name: mon.species, types: sp.type || []});
	for (const name of (mon.moves || [])) {
		const data = moveByName[name];
		if (data && data.power > 0 && theirTypes.indexOf(data.type) < 0) {
			theirTypes.push(data.type);
		}
	}
}

/**
 * Score a candidate on the two things that decide a matchup: how little it takes
 * and how much it deals. Deliberately simple -- this is choosing a team, not
 * playing the fight, and the engine does the playing.
 */
function scoreCandidate(sp) {
	const mine = sp.type || [];
	let defence = 0;
	for (const t of theirTypes) {
		const mult = effectiveness(t, mine);
		if (mult === 0) defence += 3;          // an immunity is worth a lot
		else if (mult < 1) defence += 1;
		else if (mult > 1) defence -= 2;       // being weak to their STAB is fatal
	}
	// Offence: can it hit any of them for double, with a move it can learn?
	const pool = movePoolFor(sp);
	let offence = 0;
	for (const foe of theirDefences) {
		let best = 0;
		for (const name of pool) {
			const data = moveByName[name];
			if (!data || data.power <= 0) continue;
			const mult = effectiveness(data.type, foe.types);
			if (mult > best) best = mult;
		}
		if (best >= 2) offence += 2;
		else if (best >= 1) offence += 0.5;
	}
	const total = (sp.stats || []).reduce((a, b) => a + b, 0);
	return defence * 2 + offence + total / 200;
}

function movePoolFor(sp) {
	const out = [];
	for (const pair of (sp.levelupMoves || [])) {
		const n = dexParts.moveName[pair[0]];
		if (n) out.push(n);
	}
	for (const [field, table] of [['tmMoves', dex.tmMoves], ['tutorMoves', dex.tutorMoves]]) {
		for (const index of (sp[field] || [])) {
			const n = table && table[index] !== undefined ? dexParts.moveName[table[index]] : null;
			if (n) out.push(n);
		}
	}
	return out;
}

const level = battle.team[0].level.value + 2;
const candidates = Object.values(dex.species).filter(function (sp) {
	if (!sp.dexID || (sp.levelupMoves || []).length < 4) return false;
	if ((sp.name || '').includes('-')) return false;             // no megas or formes
	if ((sp.evolutions || []).some(e => e[0] !== 254)) return false;  // fully evolved
	const total = (sp.stats || []).reduce((a, b) => a + b, 0);
	// 540 rather than 600, which trims the legendaries a Nuzlocke player would
	// not have. Landorus and Magearna both scored top of the list before this
	// and are not a team anybody brings.
	return total >= 400 && total <= 540;
});

candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

// Take the best, but keep the team type-diverse: six answers to the same threat
// is one answer with five spares.
const party = [];
const typesTaken = {};
const namesTaken = {};
for (const sp of candidates) {
	if (party.length >= 6) break;
	// Six of the same Pokemon is one answer with five spares, and so is six of
	// the same type. Both were happening: the first draft picked Landorus twice
	// and Magearna twice.
	if (namesTaken[sp.name]) continue;
	const primary = (sp.type || [])[0];
	if (typesTaken[primary] >= 2) continue;
	const built = gen.build(sp, level);
	if (!built) continue;
	namesTaken[sp.name] = true;
	typesTaken[primary] = (typesTaken[primary] || 0) + 1;
	party.push(built);
}

console.log(H.label(battle) + ', level ' + battle.team[0].level.value);
console.log('  they attack with: ' + theirTypes.map(typeName).join(', '));
console.log('\n  a team chosen against them, at level ' + level + ':');
for (const m of party) {
	const sp = speciesByName[m.species];
	console.log('    ' + m.species.padEnd(14) +
		(sp.type || []).map(typeName).join('/').padEnd(15) +
		(m.ability || '-').padEnd(14) + m.moves.join(' / '));
}

function solveAt(offset) {
	const lvl = battle.team[0].level.value + offset;
	const team = party.map(function (m) {
		return Object.assign({}, m, {level: lvl});
	});
	B.clearCache();
	const t0 = Date.now();
	const r = X.cleanWin(B.createState(team, H.foeSets(battle), {}),
		{exactBudget: budget, maxTurns: 24});
	console.log('  +' + String(offset).padStart(2) + ' levels   ' +
		(r.found ? 'CLEAN LINE FOUND, ' + r.line.length + ' turns'
			: r.decided ? 'NO CLEAN LINE EXISTS' : 'UNDECIDED (budget ran out)').padEnd(30) +
		r.nodes.toLocaleString().padStart(10) + ' nodes  ' +
		Math.round((Date.now() - t0) / 1000) + 's');
	return r;
}

console.log();
let result;
if (sweep) {
	for (const offset of [2, 8, 15, 25]) {
		result = solveAt(offset);
		if (result.found) break;   // the boundary is what we came for
	}
} else {
	result = solveAt(2);
}

if (result.found && show) {
	console.log();
	for (const step of X.toSteps(result.line)) {
		console.log('   ' + String(step.turn).padStart(2) + '. ' + step.myMon.padEnd(13) +
			step.label.padEnd(18) + '(' + step.theirMon + ' ' + step.theirLabel + ')');
	}
}
