/**
 * The foe's actions in TIME ORDER, per recording.
 * Run: node tools/timeline.js [Species]
 *
 * Built because James noticed something no per-event scoring could see:
 * "Pincurchin seemed a bit random at times. Sometimes it used Scald, sometimes
 * it switched." Every tool here scored events INDEPENDENTLY -- one row per
 * decision, one row per replacement -- so a pattern that only exists in the
 * sequence was invisible by construction.
 *
 * Merging moves and switches into one ordered stream shows it immediately.
 * Pincurchin against a FULL-HEALTH Lanturn, with Pincurchin itself at 39/48
 * every time:
 *
 *     run5   Scald, then switch
 *     run8   Scald, then switch
 *     run6   switch immediately
 *     run7   switch immediately
 *
 * Same position, four times, two different behaviours. Unlike the earlier
 * at-faint HP case -- where apparent randomness turned out to be our own
 * measurement reading the wrong moment -- this one survives: the position is
 * identical in every field we read.
 *
 * IT IS RANDOM BY DESIGN, and the source says so. ai_switching.c has TWELVE
 * AIRandom sites, and the one that governs this path is line 356:
 *
 *     u8 noSwitchChance = (switchingCooldown) ? 75 : 25;
 *     if (AIRandom() % 100 < noSwitchChance)
 *         return FALSE;
 *
 * so a switch the AI has decided on happens only 75% of the time, or 25% if it
 * just switched in. Line 1757 is blunter still: "Only perform this switch 50%
 * of the time to throw off the player."
 *
 * WHAT THIS MEANS FOR THE PORT, and it is a bigger correction than the rule I
 * was about to write. Our switchGate returns a BOOLEAN -- rr-ai.js contains no
 * randomness at all -- so we model as deterministic a process the ROM
 * deliberately randomises at twelve sites. That is not a missing scoring rule.
 * It is the third pass's category error in a new place: this is CHANCE, with
 * known probabilities printed in the source, and chance wants a DISTRIBUTION.
 *
 * It also puts a ceiling on the replacement scoreboard. If a switch is a coin
 * flip, no deterministic predictor can score above the flip, and our 39% is
 * being measured against a target that is partly unpredictable in principle.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const want = process.argv[2] || null;
const fnum = s => parseInt(String(s).replace(/\D/g, ''), 10);

function load(name) {
	return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
		.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
}

const events = [];
load('surge-decisions.jsonl').forEach(d => events.push({
	run: d.run, f: fnum(d.frame), kind: 'move', actor: d.foe, what: d.foe_move,
	us: d.us, hp: d.our_hp, max: d.our_maxhp, bar: d.foe_bar,
}));
load('surge-replacements.jsonl').forEach(r => events.push({
	run: r.run, f: fnum(r.frame), kind: r.cause, actor: r.out, what: '-> ' + r['in'],
	us: r.us, hp: r.our_hp, max: r.our_maxhp, bar: r.out_bar,
}));
events.sort((a, b) => a.run.localeCompare(b.run) || a.f - b.f);

const shown = events.filter(e => !want || e.actor === want);
console.log('');
console.log('  FOE TIMELINE' + (want ? ' -- ' + want : '') + '  (' + shown.length + ' events)');
let run = null;
shown.forEach(e => {
	if (e.run !== run) { run = e.run; console.log('\n  --- ' + run); }
	console.log('    f' + String(e.f).padStart(4) + '  ' + e.kind.padEnd(8)
		+ String(e.what).padEnd(18) + ' vs ' + String(e.us).padEnd(11)
		+ e.hp + '/' + e.max + '   its bar ' + e.bar);
});

// Group by the position as we read it, and report where the same position
// produced different behaviour. That is the only direct evidence we can get
// for a random gate without instrumenting the ROM.
const byPos = {};
shown.forEach(e => {
	const key = e.actor + ' (bar ' + e.bar + ') vs ' + e.us + ' ' + e.hp + '/' + e.max;
	(byPos[key] = byPos[key] || []).push(e.kind === 'move' ? e.what : 'SWITCH');
});
const split = Object.keys(byPos).filter(k => new Set(byPos[k]).size > 1);
console.log('');
console.log('  POSITIONS WHERE THE SAME READING PRODUCED DIFFERENT BEHAVIOUR');
if (!split.length) console.log('    none');
split.forEach(k => console.log('    ' + k + '  ->  ' + byPos[k].join(', ')));
console.log('');
