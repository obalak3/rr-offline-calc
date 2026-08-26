/**
 * OPPONENT FIDELITY, as a number instead of an anecdote.
 * Run: /usr/local/bin/python3 tools/screen/decisions.py | node tools/scoreboard.js
 *
 * Step 1 of the twentieth-pass ordering. Every number this project has thrown
 * away died the same death: a divergence between our simulator and the real
 * game was discovered BY ACCIDENT, after it had already poisoned whatever was
 * measured on top of it. Six of those in four days. Fixing the known ones and
 * re-measuring is what the last four days already were; it is not a mechanism
 * for the unknown ones, and with 31 of ~880 scoring sites ported there are
 * certainly more.
 *
 * So fidelity becomes a tracked measurement. For every AI decision in recorded
 * play, two numbers:
 *
 *   MEMBERSHIP    is the move the game actually chose inside the set our port
 *                 predicts? A miss localises to the decision it distorted, in
 *                 days, instead of surfacing months later as a voided baseline.
 *
 *   WIDTH         how big was that set? Membership alone rewards a lazy port
 *                 that predicts everything, so it is only meaningful against
 *                 the width it was bought with. A set of one that is right is
 *                 worth far more than a set of four that contains the answer.
 *
 * Two predictors are scored side by side, because the third pass argued they
 * are different objects and that conflating them is what made searches
 * unaffordable:
 *
 *   TIES     the argmax plus exact ties under boss flags. This is what CFRU
 *            actually does -- ai_master.c:360 breaks exact ties with
 *            AIRandom() % numOfBestMoves and nothing else. A gym leader IS a
 *            boss, so using boss flags here is a fact about the game rather
 *            than an assumption.
 *   MARGIN   RRAI.plausible, everything within 5 points, unioned over three
 *            flag sets. This is our IGNORANCE, not the game's randomness.
 *
 * If MARGIN's membership is much better than TIES', the extra width is buying
 * real coverage and the port has gaps. If they are close, the margin is paying
 * for nothing and should be demoted to the one-shot robustness check that step
 * 4 of the ordering calls for.
 *
 * WHAT THIS CANNOT SEE, stated so it is not over-read: only divergences that
 * change an AI CHOICE. Divergences in outcome mechanics are verify_damage.js's
 * job. Between them they cover what the advisor consumes.
 */
'use strict';

const H = require('./lib/harness.js');
const engine = H.loadEngine();
const B = engine.B, AI = engine.AI;

function readStdin() {
	const fs = require('fs');
	let raw = '';
	try { raw = fs.readFileSync(process.argv[2] || 0, 'utf8'); }
	catch (e) { return []; }
	return raw.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
}

const rows = readStdin();
if (!rows.length) {
	console.log('no decisions on stdin. Pipe tools/screen/decisions.py into this.');
	process.exit(1);
}

const party = H.realTeam();
const battle = H.earlyBattles(engine, {maxLevel: 40})
	.filter(b => H.label(b).toUpperCase().includes('SURGE'))[0];
const foeSets = H.foeSets(battle);

// A gym leader is a boss. The fourth pass called this a data gap that is
// CLOSABLE per trainer class rather than irreducible ignorance, and this is
// where closing it pays: the tie set is scored under the real flags.
const BOSS = [{checkBadMove: true, checkGoodMove: true}];

/**
 * TWO NORMALISATIONS, both between what the SCREEN prints and what TRAINER DATA
 * stores. Neither is a fidelity question, and leaving them in would have put 34
 * fake misses into the number -- a measurement bug of exactly the kind this
 * tool exists to catch early.
 *
 *   Hidden Power   the game prints the bare name; trainer data carries the type
 *                  ("Hidden Power Grass"). Same move.
 *   Manectric      the nameplate prints the base species even though trainer
 *                  data carries Manectric-Mega.
 *
 * The Manectric one has a real caveat that the alias does NOT settle: our data
 * carries it PRE-MEGA-EVOLVED-as-a-set, so the engine applies mega stats from
 * turn one. Whether the game had megaed yet at each decision is unread, and
 * this is the same suspicion already pinned by tools/test_switching.js as a
 * likely cause of the Bellibolt miss. Recorded rather than papered over.
 */
const SPECIES_ALIAS = {'Manectric': 'Manectric-Mega'};

function sameMove(observed, predicted) {
	if (observed === predicted) return true;
	if (observed === 'Hidden Power') return predicted.indexOf('Hidden Power') === 0;
	return false;
}

function build(row) {
	const foeSpecies = SPECIES_ALIAS[row.foe] || row.foe;
	const mine = party.findIndex(m => m.species === row.us);
	const theirs = foeSets.findIndex(m => m.species === foeSpecies);
	if (mine < 0 || theirs < 0) return null;
	const st = B.createState(party, foeSets, {});
	st.me.active = mine;
	st.foe.active = theirs;
	st.me.team[mine].curHP = row.our_hp;
	// The bar is 48ths and the foe's max HP is known from trainer data, so this
	// is the same inference hp_from_bar.js measured: exact at low levels,
	// spread <= 2 HP everywhere, and it moves a decision under 1% of the time.
	const max = st.foe.team[theirs].maxHP;
	st.foe.team[theirs].curHP = Math.max(1, Math.min(max, Math.round(row.foe_bar / 48 * max)));
	return st;
}

function tieSet(st) {
	const scored = AI.scoreAll(st, 'foe', BOSS[0], {});
	let best = -Infinity;
	scored.forEach(e => { if (e.score > best) best = e.score; });
	return scored.filter(e => e.score === best);
}

function moveNames(entries) {
	const out = [];
	entries.forEach(e => {
		const a = e.action !== undefined ? e.action : e;
		if (a.type === 'switch') { if (out.indexOf('(switch)') < 0) out.push('(switch)'); }
		else if (out.indexOf(a.move) < 0) out.push(a.move);
	});
	return out;
}

let scored = 0, tieHit = 0, marHit = 0, tieW = 0, marW = 0, skipped = 0;
const misses = [];
const byWidth = {};

rows.forEach(row => {
	const st = build(row);
	if (!st) { skipped++; return; }
	const ties = moveNames(tieSet(st));
	const margin = moveNames(AI.plausible(st, 'foe', {}).scored);
	const observed = row.foe_move;
	const inTie = ties.some(m => sameMove(observed, m));
	const inMar = margin.some(m => sameMove(observed, m));
	scored++;
	tieW += ties.length; marW += margin.length;
	if (inTie) tieHit++;
	if (inMar) marHit++;
	byWidth[ties.length] = byWidth[ties.length] || {n: 0, hit: 0};
	byWidth[ties.length].n++;
	if (inTie) byWidth[ties.length].hit++;
	if (!inTie) misses.push({row: row, ties: ties, margin: margin, inMar: inMar});
});

console.log('');
console.log('  OPPONENT SCOREBOARD  ' + scored + ' recorded AI decisions'
	+ (skipped ? '  (' + skipped + ' unbuildable, skipped)' : ''));
console.log('');
console.log('  predictor   membership        mean set width');
console.log('  ties        ' + pct(tieHit, scored) + '        ' + (tieW / scored).toFixed(2));
console.log('  margin      ' + pct(marHit, scored) + '        ' + (marW / scored).toFixed(2));
console.log('');
console.log('  CALIBRATION -- membership by predicted tie-set size');
console.log('  a set of one that is right is worth more than a set of four that contains the answer');
Object.keys(byWidth).sort((a, b) => a - b).forEach(w => {
	const e = byWidth[w];
	console.log('    width ' + w + '   ' + pct(e.hit, e.n) + '   (' + e.n + ' decisions)');
});

if (misses.length) {
	console.log('');
	console.log('  MISSES -- the game did something our argmax did not predict');
	const grouped = {};
	misses.forEach(m => {
		const k = m.row.foe + ' used ' + m.row.foe_move + ' | we said ' + m.ties.join('/');
		grouped[k] = grouped[k] || {n: 0, inMar: 0};
		grouped[k].n++;
		if (m.inMar) grouped[k].inMar++;
	});
	Object.keys(grouped).sort((a, b) => grouped[b].n - grouped[a].n).slice(0, 14).forEach(k => {
		const g = grouped[k];
		console.log('    x' + g.n + '  ' + k
			+ (g.inMar ? '   [margin catches it]' : '   [margin misses it too]'));
	});
}

function pct(a, b) {
	const s = (100 * a / b).toFixed(1) + '%';
	return (a + '/' + b + ' ' + s).padEnd(16);
}
