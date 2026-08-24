/**
 * What will the engine get WRONG in the fights that are still ahead?
 * Run: node tools/audit_coverage.js [--verbose]
 *
 * WHY THIS EXISTS. Every measurement in this repo is taken on the nine early
 * battles up to the Surge cap, because those are the fights with fixed levels
 * and a benchmark around them. The run does not stop there: there are 167
 * battles, the teams get stronger, and a search that is fast and sound is still
 * worthless on a fight whose moves it does not understand.
 *
 * Speed problems announce themselves -- the search sits there. A coverage
 * problem does not: the engine simulates a move it does not model as though it
 * were something simpler, finds a clean line through the misunderstanding, and
 * reports it with exactly the same confidence as a real one. That is the
 * failure mode worth spending a tool on.
 *
 * So this walks every trainer Pokemon in the dataset, asks the engine what it
 * knows about each move and ability, and reports what is missing WEIGHTED BY
 * WHERE IT APPEARS. A gap in a Route 3 team is a curiosity; the same gap on the
 * Elite Four is a wrong answer at the moment the stakes are highest.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const calcLib = require(path.join(H.root, 'upstream-calc/calc/dist/index.js'));

const loaded = H.loadEngine();
const B = loaded.B;
const TRAINERS = loaded.TRAINERS;
const verbose = process.argv.indexOf('--verbose') >= 0;

// Segments are roughly chronological, so the index is a usable stand-in for
// "how late does this appear".
const segments = TRAINERS.segments;
const moveWhere = new Map();      // move -> {count, firstSeg, segs:Set}
const abilityWhere = new Map();
let totalMons = 0, totalBattles = 0;

function record(map, name, segIndex, segName) {
	if (!name) return;
	let row = map.get(name);
	if (!row) { row = {count: 0, firstSeg: segIndex, segs: new Set()}; map.set(name, row); }
	row.count++;
	row.segs.add(segName);
	if (segIndex < row.firstSeg) row.firstSeg = segIndex;
}

segments.forEach(function (segment, segIndex) {
	const segName = segment.name || ('segment ' + segIndex);
	for (const battle of (segment.battles || [])) {
		totalBattles++;
		for (const mon of (battle.team || [])) {
			totalMons++;
			for (const move of (mon.moves || [])) record(moveWhere, move, segIndex, segName);
			record(abilityWhere, mon.ability, segIndex, segName);
		}
	}
});

/**
 * Three states, and the middle one is the dangerous one.
 *
 *   modelled    the engine knows the move and applies its effect
 *   damage only the engine can compute its damage but not its effect -- so a
 *               Swords Dance is simulated as a move that does nothing, and a
 *               Toxic never poisons anybody
 *   unknown     the engine has no record of it at all
 *
 * "Damage only" is worse than "unknown" in practice, because an unknown move is
 * noticed and reported, while a status move silently doing nothing looks to the
 * search like a wasted turn the opponent kindly took.
 */
function classifyMove(name) {
	const data = B.moveData(name);
	if (!data) return 'unknown';
	if (data.effect && data.effect.kind && data.effect.kind !== 'none') return 'modelled';
	if (data.split === 'Status') return 'status-inert';
	if (data.secondaryEffectChance > 0 && !(data.effect && data.effect.kind)) {
		return 'secondary-inert';
	}
	return 'damage-only';
}

const buckets = {unknown: [], 'status-inert': [], 'secondary-inert': []};
for (const [name, row] of moveWhere) {
	const verdict = classifyMove(name);
	if (buckets[verdict]) buckets[verdict].push([name, row]);
}

/**
 * An ability is covered if EITHER side of the stack knows it, and they divide
 * the work: the vendored calculator owns everything that changes a damage
 * number (Technician, Sheer Force, Tinted Lens), and our engine owns everything
 * that changes the flow of a turn (absorbs, recoil, secondaries, entry effects).
 *
 * Checking only our engine was the first attempt and it reported 173 gaps, the
 * overwhelming majority of them damage abilities the calculator handles
 * perfectly. A list that long is a list nobody reads, and the four real
 * problems were sitting in it undistinguished. Both sources are searched now.
 */
const ABSORBS = B._internal.ABSORBS || {};
const knownAbilities = new Set(Object.keys(ABSORBS));
const ourSource = fs.readFileSync(
	path.join(H.root, 'upstream-calc/src/js/rr-battle.js'), 'utf8');
const calcDir = path.join(H.root, 'upstream-calc/calc/dist/mechanics');
let calcSource = '';
for (const f of fs.readdirSync(calcDir)) {
	if (f.endsWith('.js')) calcSource += fs.readFileSync(path.join(calcDir, f), 'utf8');
}
const missingAbilities = [];
for (const [name, row] of abilityWhere) {
	if (!name) continue;
	if (knownAbilities.has(name)) continue;
	if (ourSource.indexOf(name) >= 0) continue;
	if (calcSource.indexOf(name) >= 0) continue;
	missingAbilities.push([name, row]);
}

/**
 * Held items, checked the same way and for the same reason.
 *
 * Added after the ability pass, because the ability pass found four real bugs
 * and there was no reason to think items were any cleaner. They were not: Lum
 * Berry, on seventeen trainer Pokemon, ate every status the search planned
 * around and nothing in the stack knew about it.
 *
 * Same split of responsibility as abilities. The calculator owns items that
 * change a damage number (Life Orb's boost, Choice Specs, Eviolite); our engine
 * owns items that change the flow of a turn (berries firing, recoil, contact
 * punishment). An item mentioned in neither is a silent gap.
 */
const itemWhere = new Map();
segments.forEach(function (segment, segIndex) {
	const segName = segment.name || ('segment ' + segIndex);
	for (const battle of (segment.battles || [])) {
		for (const mon of (battle.team || [])) record(itemWhere, mon.item, segIndex, segName);
	}
});
/**
 * Detected by MEASUREMENT rather than by grep, and the difference matters.
 *
 * Grepping the sources for an item's name said Mystic Water, Sharp Beak and
 * Chople Berry were all unhandled. They are handled perfectly: the calculator
 * works from its item data rather than from named branches, so Chople really
 * does halve a super-effective hit from 110 to 55. A grep-based audit reports
 * over a hundred gaps, nearly all imaginary, and the real ones drown.
 *
 * So each item is given to the damage calculator twice, once held and once not,
 * and anything that moves a number is handled. What remains either needs engine
 * support or does nothing in a battle -- a much shorter list, and one worth
 * reading.
 */
const gen9 = calcLib.Generations.get(9);
// One move per type that matters, because a single probe cannot see a
// type-specific item: testing Mystic Water with a Normal move says it does
// nothing, which is true and useless. The first version of this did exactly
// that and reported Mystic Water, Sharp Beak and Chople Berry as gaps.
const PROBES = ['Body Slam', 'Surf', 'Flamethrower', 'Thunderbolt', 'Ice Beam',
	'Karate Chop', 'Aerial Ace', 'Psychic', 'Earthquake', 'Rock Slide',
	'Sludge Bomb', 'Shadow Ball', 'Bug Bite', 'Dragon Claw', 'Dark Pulse',
	'Flash Cannon', 'Dazzling Gleam', 'Energy Ball'];

function changesDamage(itemName) {
	for (const moveName of PROBES) {
		try {
			const move = new calcLib.Move(gen9, moveName);
			const bare = new calcLib.Pokemon(gen9, 'Snorlax', {level: 50});
			const target = new calcLib.Pokemon(gen9, 'Blissey', {level: 50});
			const baseline = String(calcLib.calculate(gen9, bare, target, move).damage);

			const holder = new calcLib.Pokemon(gen9, 'Snorlax',
				{level: 50, item: itemName});
			if (String(calcLib.calculate(gen9, holder, target, move).damage) !== baseline) {
				return true;
			}
			// And on the DEFENDER, which is where resist berries and Assault
			// Vest and Eviolite live.
			const heldTarget = new calcLib.Pokemon(gen9, 'Blissey',
				{level: 50, item: itemName});
			if (String(calcLib.calculate(gen9, bare, heldTarget, move).damage) !== baseline) {
				return true;
			}
		} catch (e) { /* try the next probe */ }
	}
	return false;
}

const missingItems = [];
for (const [name, row] of itemWhere) {
	if (!name) continue;
	if (ourSource.indexOf(name) >= 0) continue;
	if (changesDamage(name)) continue;
	missingItems.push([name, row]);
}

function report(title, rows, note) {
	rows.sort((a, b) => b[1].count - a[1].count);
	const uses = rows.reduce((n, r) => n + r[1].count, 0);
	console.log('\n' + title + ': ' + rows.length + ' distinct, ' + uses + ' uses');
    if (note) console.log('  ' + note);
	const show = verbose ? rows : rows.slice(0, 12);
	for (const [name, row] of show) {
		console.log('   ' + String(row.count).padStart(4) + '  ' + name.padEnd(22) +
			'  first in: ' + [...row.segs][0]);
	}
	if (!verbose && rows.length > show.length) {
		console.log('   ... and ' + (rows.length - show.length) + ' more (--verbose)');
	}
}

console.log('Coverage across the WHOLE game, not just the benchmark.');
console.log(totalBattles + ' battles, ' + totalMons + ' trainer Pokemon, ' +
	moveWhere.size + ' moves, ' + abilityWhere.size + ' abilities, ' +
	itemWhere.size + ' held items');

report('MOVES THE ENGINE DOES NOT KNOW', buckets.unknown,
	'Reported at runtime as unmodelled, so at least they are visible.');
report('STATUS MOVES SIMULATED AS DOING NOTHING', buckets['status-inert'],
	'The dangerous bucket: the search sees a wasted opponent turn, silently.');
report('DAMAGING MOVES WHOSE SECONDARY IS NOT APPLIED', buckets['secondary-inert'],
	'Damage is right; the burn, drop or flinch never happens.');
report('ABILITIES WITH NO MENTION IN THE ENGINE', missingAbilities,
	'Neither the calculator nor the engine mentions these. Many are genuinely ' +
	'inert in battle;\n  the ones that are not are silently wrong.');

report('HELD ITEMS WITH NO MENTION ANYWHERE', missingItems,
	'Measured, not grepped. TRIAGE ONLY: the probe is one attacker and one\n' +
	'  defender, so items needing a particular target (Eviolite wants something\n' +
	'  unevolved, resist berries want a matching weakness) still show up here.\n' +
	'  Read it as a shortlist to check, never as a list of bugs.');

// The headline: how much of the game is affected, and how late.
const risky = buckets['status-inert'].concat(buckets['secondary-inert']);
const lateRisky = risky.filter(([, row]) => row.firstSeg >= segments.length / 2);
console.log('\n  moves carrying a silent gap        ' + risky.length);
console.log('  of those, first appearing LATE     ' + lateRisky.length +
	'  (second half of the game)');
console.log('\nSegments, in order: ' + segments.map(s => s.name).join(' | '));
