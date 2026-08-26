/**
 * The party's max HP per species, computed through the engine.
 * Run: node tools/party_maxhp.js
 *
 * read_save.js reports species, level, nature, EVs and IVs but not max HP,
 * because max HP is derived rather than stored. The screen reader needs it for
 * two things: identifying WHICH Pokemon is out (all six of this party have
 * distinct maxima, so the number the status box already prints names the
 * Pokemon, with no sprite matching) and validating a digit reading (a max no
 * party member has is a misread, provably).
 *
 * Computed through RRBattle rather than reimplemented, so it cannot drift from
 * the numbers the damage calculation uses.
 */
'use strict';
const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B;
const party = H.realTeam();
const state = B.createState(party, party, {});
const out = {};
state.me.team.forEach(function (mon) {
	out[mon.species] = mon.maxHP;
});
const byMax = {};
Object.keys(out).forEach(function (s) {
	(byMax[out[s]] = byMax[out[s]] || []).push(s);
});
const unique = {};
Object.keys(byMax).forEach(function (mx) {
	if (byMax[mx].length === 1) unique[mx] = byMax[mx][0];
});
if (process.argv.includes('--json')) {
	console.log(JSON.stringify({byspecies: out, unique_by_max: unique}));
} else {
	Object.keys(out).forEach(function (s) {
		console.log('  ' + s.padEnd(14) + out[s]);
	});
	const dupes = Object.keys(byMax).filter(function (m) { return byMax[m].length > 1; });
	console.log(dupes.length
		? '\nAMBIGUOUS maxima (cannot identify by HP alone): ' +
			dupes.map(function (m) { return m + ' = ' + byMax[m].join('/'); }).join(', ')
		: '\nall six maxima are distinct, so max HP uniquely identifies the Pokemon');
}
