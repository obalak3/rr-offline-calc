'use strict';
/**
 * WHAT CAN THE SCORE ACTUALLY SEE? The audit the value model never had.
 *
 * James, 2026-09-15: "this is happening again and again and again. Why haven't
 * you still planned for every possible move condition terrain etc". He is
 * right, and the reason is structural rather than careless.
 *
 * `audit_mechanics.js` already asks the equivalent question of the ENGINE --
 * does it ACT on every effect the data declares -- and reports zero gaps. So
 * the engine has known for a month that Tailwind doubles Speed. Nothing ever
 * asked the same question of the thing that JUDGES a position, so the score
 * reads health, status and stat stages and is silent about everything else.
 * Growl on a special attacker, a Honchkrow that crits half the time, Dark Void,
 * and Talonflame's Tailwind were all the same hole, found one at a time because
 * fights were being tested and INPUTS were not.
 *
 * This enumerates every condition the game can produce, from the move data and
 * the engine's own state, and reports for each whether the observation carries
 * it and whether the score reads it. A row that can happen and is never read is
 * a FAILURE, not a note, so the list closes as a set instead of one bug at a
 * time.
 *
 * Run: node tools/audit_score_inputs.js
 */
const H = require('./lib/harness.js');

const engine = H.loadEngine();
const MOVES = engine.sandbox.RR_MOVE_EFFECTS.moves;

// ---------------------------------------------------------------------------
// 1. What can the game produce? Counted from the move data, so the list cannot
//    drift from what is actually in the ROM.
// ---------------------------------------------------------------------------
const produced = {screens: {}, statuses: {}, weather: {}, terrain: {}, hazards: {}, kinds: {}};
for (const name in MOVES) {
	const f = MOVES[name].effect;
	if (!f) continue;
	produced.kinds[f.kind] = (produced.kinds[f.kind] || 0) + 1;
	if (f.screen) (produced.screens[f.screen] = produced.screens[f.screen] || []).push(name);
	if (f.status) (produced.statuses[f.status] = produced.statuses[f.status] || []).push(name);
	if (f.weather) (produced.weather[f.weather] = produced.weather[f.weather] || []).push(name);
	if (f.terrain) (produced.terrain[f.terrain] = produced.terrain[f.terrain] || []).push(name);
	if (f.kind === 'hazard') (produced.hazards[f.hazard || 'hazard'] = produced.hazards[f.hazard || 'hazard'] || []).push(name);
}

// ---------------------------------------------------------------------------
// 2. What does the DOUBLES pipeline carry and read? Stated here as data rather
//    than inferred, and checked against the source below so it cannot rot.
// ---------------------------------------------------------------------------
// SINGLES reads the same live game through agent.js buildState. Checked in the
// source rather than assumed: `grep -n "screens\|hazards\|volatiles\|weather"
// tools/agent.js`. It reads terrainTurns (and clears the terrain when it hits
// zero), and decodes exactly three bits of the volatile word -- the confusion
// counter -- plus justEntered, protectChain and usedMoves which it derives
// itself. Everything else below is missing from BOTH pipelines.
const SINGLES = {
	reads: ['HP', 'status', 'stat stages', 'ability', 'item', 'moves and PP', 'real stats',
		'terrain: BOTH the turns and WHICH ONE (field word 0x030020D0, Electric and Grassy measured)',
		'turnsOut', 'protect chain',
		'GENERATION now starts from the real position too (candidates.js liveCond, 2026-09-15):',
		'  the opponent\'s stat stages, status, sleep length and volatiles, and the weather,',
		'  where before it was told only the terrain and how chipped the opponent was',
		'THE VOLATILE WORD, decoded 2026-09-15: confusion (the name bug is fixed), Substitute,',
		'  trapped, locked in, Focus Energy, recharge, Destiny Bond, Curse, Torment',
		'  -- Substitute verified against the recorded Orthworm position of 2026-09-10'],
	missing: ['side conditions (Reflect, Light Screen, Aurora Veil, Safeguard, Tailwind)',
		'weather',
		'Misty and Psychic terrain (other bits of the field word, not yet identified)',
		'trick room (another bit of the same word, not yet identified)',
		'hazards',
		'Leech Seed (gStatuses3, a different structure)',
		'Taunt, Encore, Disable (gDisableStructs, a different structure)']
};

const SHIPPED = {
	'HP': 'battler hp/maxhp, both parties',
	'status (slp/psn/brn/frz/par/tox)': 'battler status word',
	'sleep counter': 'battler status word, low three bits',
	'stat stages': 'battler stages array',
	'ability': 'battler ability byte',
	'item': 'battler item',
	'moves and PP': 'battler moves/pp',
	'real stats': 'battler stats array',
	'volatiles word': 'battler status2 -- SHIPPED BUT NEVER DECODED',
	'terrain turns': 'obs terrainTurns -- SHIPPED BUT NEVER READ'
};
const READ_BY_SCORE = [
	'HP', 'status (slp/psn/brn/frz/par/tox)', 'sleep counter', 'stat stages', 'ability', 'item', 'moves and PP', 'real stats'
];

// Everything the engine can track that the doubles observation does NOT carry.
const NOT_SHIPPED = {
	'side conditions': {
		what: 'Reflect, Light Screen, Aurora Veil, Safeguard, Tailwind',
		why: 'a side condition is not on any Pokemon, so nothing in the battler struct shows it',
		found: 'Tailwind timer measured at 0x020179C8 (docs/SCREEN-MAP.md); the other four unmapped',
		cost: 'Talonflame set a Tailwind on turn 1 of the right guard fight and the turn scored as costing nothing'
	},
	'weather': {what: 'Rain, Sun, Sand, Hail, Snow', why: 'field state, not battler state', found: 'unmapped', cost: 'damage and speed change and the score cannot tell'},
	'terrain': {what: 'Electric, Grassy, Misty, Psychic', why: 'field state', found: 'the TURN COUNTER is shipped as terrainTurns but which terrain is unmapped, and nothing reads either', cost: 'Grassy Terrain heals them each turn; Psychic Terrain blocks priority'},
	'trick room': {what: 'reversed turn order for five turns', why: 'field state', found: 'unmapped', cost: 'every speed judgement inverts'},
	'hazards': {what: 'Stealth Rock, Spikes, Toxic Spikes, Sticky Web', why: 'side state', found: 'unmapped', cost: 'a switch costs HP the score does not charge for'},
	'volatiles': {what: 'Substitute, confusion, Leech Seed, trapped, Taunt, Encore, Disable, Destiny Bond and 23 more', why: 'the word IS shipped as status2 and nothing decodes it', found: 'shipped, undecoded', cost: 'a Substitute in front of them absorbs a hit the score counts as damage dealt'}
};

let failures = 0;
function fail(msg) { failures++; console.log('  GAP   ' + msg); }
function ok(msg) { console.log('  ok    ' + msg); }

console.log('\nWHAT THE DOUBLES SCORE CAN SEE');
console.log('='.repeat(78));
console.log('\nCarried by the observation and read by the score:');
READ_BY_SCORE.forEach(k => ok(k + '  (' + SHIPPED[k] + ')'));

console.log('\nCarried by the observation and NEVER READ:');
Object.keys(SHIPPED).filter(k => !READ_BY_SCORE.includes(k)).forEach(k => fail(k + '  (' + SHIPPED[k] + ')'));

console.log('\nNOT carried at all, though the game produces them:');
Object.keys(NOT_SHIPPED).forEach(k => {
	const g = NOT_SHIPPED[k];
	fail(k + ': ' + g.what);
	console.log('          why not: ' + g.why);
	console.log('          status:  ' + g.found);
	console.log('          cost:    ' + g.cost);
});

console.log('\n' + '='.repeat(78));
console.log('What the move data can actually produce, so the list above is complete:');
const line = (label, obj) => {
	const keys = Object.keys(obj);
	if (!keys.length) return;
	console.log('  ' + label.padEnd(18) + keys.map(k => k + ' (' + obj[k].length + ' move' + (obj[k].length > 1 ? 's' : '') + ')').join(', '));
};
line('side conditions', produced.screens);
line('statuses', produced.statuses);
line('weather', produced.weather);
line('terrain', produced.terrain);
line('hazards', produced.hazards);
console.log('  effect kinds      ' + Object.keys(produced.kinds).length + ' distinct, ' +
	Object.values(produced.kinds).reduce((a, b) => a + b, 0) + ' moves carrying one');

console.log('\n' + '='.repeat(78));
console.log('SINGLES, the same question of tools/agent.js buildState:');
console.log('\n  reads:');
SINGLES.reads.forEach(r => console.log('    ok    ' + r));
console.log('\n  does NOT read, though the live game produces them:');
SINGLES.missing.forEach(r => { failures++; console.log('    GAP   ' + r); });
console.log('\n  So these are NOT doubles bugs. Singles has been played live for weeks');
console.log('  with the same blind spots: a Reflect halves our damage and the planner');
console.log('  does not know, a Substitute absorbs a hit it counts as damage dealt,');
console.log('  and hazards make a switch cost HP it never charges for. James raised');
console.log('  the Substitute one himself on 2026-09-10 after Orthworm\'s Shed Tail');
console.log('  and it is still open.');

console.log('\n' + failures + ' input(s) the score cannot see.');
console.log('Each is a turn it can misjudge without ever being told. Close them as a');
console.log('set: read it in doracle, decode it in doubles-position, price it by');
console.log('measurement the way position.js prices a stat drop.\n');
process.exit(failures ? 1 : 0);
