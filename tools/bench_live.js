/**
 * The LIVE ADVISOR across many teams and every fixed-level battle.
 * Run: node tools/bench_live.js [teams] [opts-json]
 *   node tools/bench_live.js 20
 *   node tools/bench_live.js 20 '{"searchRank":true,"searchTurns":6}'
 *
 * WHY THIS AND NOT bench_early / bench_game. Those drive `planRoute`: the
 * search asking "is there a clean line from the start of this fight". Nothing
 * in this repo has ever driven the TURN-BY-TURN loop, where the app re-decides
 * from the position in front of it and never sees a whole line. That loop is
 * what the screen reader will run, and every failure found on 2026-08-25 lives
 * only in it and is invisible to a planRoute benchmark: the switch oscillation,
 * the passivity at short horizons, the intransitive preferences.
 *
 * WHY IT NEEDS TO BE THIS BIG. Every live measurement so far used one real
 * party over nine battles. Nine samples cannot tell good from lucky, and it
 * showed: a horizon sweep came back non-monotone (2, 6, 2 Pokemon lost at
 * depths 3, 4, 6), which is either noise or a bug and at n=9 those are
 * indistinguishable. Generated teams are the same device bench_early uses, and
 * for the same reason -- in a Nuzlocke the team is whatever you caught -- but
 * here they buy statistical power: teams x battles instead of one x nine.
 *
 * SCORING is the Nuzlocke metric, deaths, not wins. bench_early already
 * established that as the number that matters, and today established why:
 * the advisor reached 9/9 wins while losing four Pokemon, which is not a
 * result James would accept.
 *
 * Read `clean` as the headline. And read it against ceiling.js rather than
 * against 100%: some fights cannot be won cleanly by the team the generator
 * handed over, and no advisor will win those.
 */
'use strict';

const H = require('./lib/harness.js');
const live = require('./lib/live.js');

const engine = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(engine, dexParts);
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const STEP = {mode: 'expected'};
const MAX_TURNS = 60;

const teamCount = parseInt(process.argv[2], 10) || 10;
const opts = Object.assign({lookahead: 2, budget: 20000},
	process.argv[3] ? JSON.parse(process.argv[3]) : {});

const battles = H.earlyBattles(engine, {maxLevel: 100});
console.log('live advisor: ' + teamCount + ' generated teams x ' + battles.length +
	' fixed-level battles = ' + (teamCount * battles.length) + ' fights');
console.log('opts ' + JSON.stringify(opts) + '\n');

function foeArgmax(st) {
	const scored = RRAI.scoreAll(st, 'foe', FLAGS, {});
	const gate = RRAI.switchGate(st, 'foe', FLAGS);
	let best = null;
	for (const e of scored) {
		if (e.action.type === 'switch' && !gate.maySwitch) continue;
		if (!best || e.score > best.score) best = e;
	}
	return best && best.action;
}

let fights = 0, cleanWins = 0, wins = 0, stalls = 0, loops = 0;
let deaths = 0, turnsTotal = 0, msTotal = 0, decisions = 0;
const worst = {};

for (let t = 0; t < teamCount; t++) {
	for (const battle of battles) {
		const level = battle.team[0].level.value + 2;
		const party = gen.team(level, 6);
		if (party.length < 6) continue;
		const foe = H.foeSets(battle);

		B.clearCache();
		let real = B.createState(party, foe, {});
		let believed = B.clone(real);
		const session = live.createSession();
		let turns = 0, looped = false;
		const seen = new Map();

		while (turns < MAX_TURNS) {
			if (real.foe.team.every(m => m.fainted)) break;
			if (real.me.team.every(m => m.fainted)) break;
			const obs = live.observe(real);
			const sig = obs.me.species + '|' + obs.me.hp + '|' + obs.foe.species + '|' + obs.foe.barPx;
			const n = (seen.get(sig) || 0) + 1;
			seen.set(sig, n);
			if (n >= 4) looped = true;

			const t0 = Date.now();
			let advice;
			try { advice = live.advise(believed, obs, opts, engine, session); }
			catch (e) { advice = null; }
			msTotal += Date.now() - t0;
			decisions++;
			if (!advice || !advice.best) break;

			const mine = B.legalActions(real, 'me').find(a =>
				advice.best.action.type === 'switch'
					? (a.type === 'switch' && a.index === advice.best.action.index)
					: (a.type === 'move' && a.move === advice.best.action.move));
			const theirs = foeArgmax(real);
			if (!mine || !theirs) break;
			let stepped;
			try { stepped = B.step(real, mine, theirs, STEP); } catch (e) { break; }
			if (!stepped || !stepped.length) break;
			real = stepped[0].state;
			try { believed = B.step(believed, mine, theirs, STEP)[0].state; }
			catch (e) { believed = B.clone(real); }
			turns++;
		}

		const foeDown = real.foe.team.every(m => m.fainted);
		const lost = real.me.team.filter(m => m.fainted).length;
		fights++; turnsTotal += turns; deaths += lost;
		if (foeDown) { wins++; if (lost === 0) cleanWins++; }
		else if (!real.me.team.every(m => m.fainted)) stalls++;
		if (looped) loops++;
		if (lost > 0 || !foeDown) {
			const key = H.label(battle).slice(0, 34);
			worst[key] = worst[key] || {deaths: 0, fights: 0};
			worst[key].deaths += lost;
			worst[key].fights++;
		}
	}
	process.stderr.write('  team ' + (t + 1) + '/' + teamCount + ' done\r');
}

console.log('fights            ' + fights);
console.log('CLEAN wins        ' + cleanWins + '  (' + (100 * cleanWins / fights).toFixed(1) + '%)   <-- the objective');
console.log('wins (any cost)   ' + wins + '  (' + (100 * wins / fights).toFixed(1) + '%)');
console.log('stalled           ' + stalls);
console.log('looped            ' + loops);
console.log('POKEMON LOST      ' + deaths + '  (' + (deaths / fights).toFixed(2) + ' per fight)');
console.log('mean turns        ' + (turnsTotal / fights).toFixed(1));
console.log('mean decision     ' + Math.round(msTotal / Math.max(1, decisions)) + ' ms');

const rows = Object.keys(worst).map(k => [k, worst[k]])
	.sort((a, b) => b[1].deaths - a[1].deaths).slice(0, 10);
if (rows.length) {
	console.log('\nworst fights by deaths:');
	for (const [name, w] of rows) {
		console.log('  ' + name.padEnd(36) + String(w.deaths).padStart(4) + ' deaths over ' +
			w.fights + ' bad fights');
	}
}
