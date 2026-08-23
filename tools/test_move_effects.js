/**
 * Checks for the solver's move table. Run: node tools/test_move_effects.js
 *
 * The solver mis-simulates silently when a move is missing or mis-described,
 * and a mis-simulated move turns a "guaranteed win" into a false claim. So the
 * load-bearing check here is coverage: every move any trainer can actually use
 * must have both numbers and semantics. That is what catches drift when the dex
 * snapshot or the calc fork is next refreshed.
 *
 * Descriptions are checked too, but only as warnings. They are not ground
 * truth: Growth's ROM description says it raises Sp. Atk alone, when it raises
 * Attack and Sp. Atk both. A description mismatch is a prompt to go and look,
 * not a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const table = path.join(root, 'upstream-calc/src/js/data/rr-move-effects.js');

if (!fs.existsSync(table)) {
	console.error('Missing move table. Build it with:\n  node tools/build_move_effects.js');
	process.exit(1);
}

function loadGlobal(file, name) {
	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox);
	return sandbox[name];
}

const MOVES = loadGlobal(table, 'RR_MOVE_EFFECTS').moves;
const TRAINERS = loadGlobal(
	path.join(root, 'upstream-calc/src/js/data/rr-trainers-data.js'), 'RR_TRAINER_DATA');

let failures = 0;
let warnings = 0;

function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

function warn(message) {
	warnings++;
	console.log('WARN  ' + message);
}

// ------------------------------------------------------------------ coverage

const used = new Map();
for (const segment of TRAINERS.segments) {
	for (const battle of (segment.battles || [])) {
		for (const mon of (battle.team || [])) {
			for (const move of (mon.moves || [])) {
				if (!used.has(move)) used.set(move, []);
				used.get(move).push(battle.trainer + '/' + mon.species);
			}
		}
	}
}

const uncovered = [...used.keys()].filter(name => !MOVES[name]);
check('every trainer move has a table entry (' + used.size + ' distinct)',
	uncovered.length === 0,
	uncovered.length ? uncovered.length + ' missing: ' + uncovered.slice(0, 8).join(', ') : '');

const needSemantics = [...used.keys()].filter(function (name) {
	const move = MOVES[name];
	return move && !move.effect &&
		(move.split === 'Status' || move.secondaryChance !== 0);
});
check('every status / secondary-bearing move has semantics',
	needSemantics.length === 0,
	needSemantics.length ? needSemantics.length + ' missing: ' +
		needSemantics.slice(0, 8).join(', ') : '');

// ---------------------------------------------------------------- well-formed

const STATS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
const STATUSES = ['par', 'brn', 'psn', 'tox', 'slp', 'frz', 'frb'];
const KINDS = [
	'boost', 'boostCost', 'chargeBoost', 'stockpile', 'status', 'yawn',
	'confuseBoost', 'heal', 'wish', 'rest', 'strengthSap', 'hazard', 'screen',
	'weather', 'room', 'protect', 'substitute', 'shedTail', 'leechSeed', 'haze',
	'taunt', 'encore', 'destinyBond', 'forceSwitch', 'selfSwitch', 'swapItems',
	'curse', 'noop', 'unsupported', 'secondary', 'selfDebuff', 'removeItem',
	'breakScreens', 'trap', 'throatChop', 'glaiveRush', 'fickleBeam',
	'physicalDefence', 'multiHit', 'lockedIn',
	// player-side additions
	'focusEnergy', 'defog', 'healBell', 'rapidSpin', 'torment', 'disable', 'psychUp',
	'identify'
];

const badKind = [], badStat = [], badStatus = [], badBoost = [], badPriority = [];

for (const [name, move] of Object.entries(MOVES)) {
	if (move.priority < -7 || move.priority > 5) badPriority.push(name + '=' + move.priority);

	const effect = move.effect;
	if (!effect) continue;
	if (!KINDS.includes(effect.kind)) badKind.push(name + '=' + effect.kind);

	const boostSets = [effect.boosts, effect.boostsPerUse,
		effect.secondary && effect.secondary.boosts];
	for (const boosts of boostSets) {
		if (!boosts) continue;
		for (const [stat, stages] of Object.entries(boosts)) {
			if (!STATS.includes(stat)) badStat.push(name + '.' + stat);
			if (stages < -6 || stages > 6 || stages === 0) {
				badBoost.push(name + '.' + stat + '=' + stages);
			}
		}
	}

	const statuses = [effect.status, effect.secondary && effect.secondary.status]
		.concat((effect.secondary && effect.secondary.statusOneOf) || []);
	for (const status of statuses) {
		if (status && !STATUSES.includes(status)) badStatus.push(name + '=' + status);
	}
}

check('every effect uses a known kind', badKind.length === 0, badKind.join(', '));
check('every boost names a real stat', badStat.length === 0, badStat.join(', '));
check('every boost is a legal stage count', badBoost.length === 0, badBoost.join(', '));
check('every status is a known token', badStatus.length === 0, badStatus.join(', '));
check('every priority is in [-7, 5]', badPriority.length === 0, badPriority.join(', '));

// A secondary effect that can never trigger is a transcription error one way or
// the other, so the two sources have to agree that there is something to roll.
const deadSecondary = Object.entries(MOVES).filter(function ([, move]) {
	return move.effect && move.effect.kind === 'secondary' && move.secondaryChance === 0;
}).map(([name]) => name);
check('no secondary effect has a zero trigger chance',
	deadSecondary.length === 0, deadSecondary.join(', '));

// ------------------------------------------------------------------ warnings

for (const [name, move] of Object.entries(MOVES)) {
	if (!move.effect) continue;
	if (move.effect.verify) warn(name + ': ' + move.effect.verify);
}

const unsupported = Object.entries(MOVES)
	.filter(([, move]) => move.effect && move.effect.kind === 'unsupported')
	.map(([name]) => name + ' (' + (used.get(name) || []).length + ' mons)');
if (unsupported.length) {
	console.log('\nNot simulated, must be surfaced in solver output rather than ignored:');
	for (const entry of unsupported) console.log('    ' + entry);
}

// Cheap description cross-read: if the semantics claim a status, the ROM text
// usually mentions it. Warn only, because the text is unreliable.
const STATUS_WORDS = {
	par: 'paraly', brn: 'burn', psn: 'poison', tox: 'poison',
	slp: 'sleep', frz: 'froze', frb: 'frostbit'
};
let mismatches = 0;
for (const [name, move] of Object.entries(MOVES)) {
	const effect = move.effect;
	if (!effect || !move.description) continue;
	const status = effect.status || (effect.secondary && effect.secondary.status);
	if (!status) continue;
	const word = STATUS_WORDS[status];
	if (word && !move.description.toLowerCase().includes(word)) {
		mismatches++;
		// A curated `note` means the divergence is deliberate and reasoned, not
		// an oversight, so say which it is rather than crying wolf identically.
		warn('description does not mention ' + status + ': ' + name +
			(effect.note ? ' -- KNOWN: ' + effect.note
				: ' -- UNEXPLAINED: "' + move.description.trim() + '"'));
	}
}
console.log('\nDescription cross-read: %d status effects checked against ROM text, %d to review',
	Object.values(MOVES).filter(m => m.effect &&
		(m.effect.status || (m.effect.secondary && m.effect.secondary.status))).length,
	mismatches);

console.log('\n%d failure(s), %d warning(s)', failures, warnings);
process.exit(failures ? 1 : 0);
