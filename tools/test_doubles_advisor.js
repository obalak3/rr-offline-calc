'use strict';
/**
 * REGRESSION for the doubles decision layer (stage 4 of docs/PLAN-DOUBLES.md).
 *
 * The portfolio exists to be cheaper than playing all 128 legal joint actions
 * while still finding what that search finds. Two designs failed that test
 * before the current one passed, and both failures were invisible until they
 * were measured against the exhaustive answer, so the answers are pinned here:
 *
 *   ss7, GAME CORNER GUARD (Hypno + Aerodactyl vs Accelgor + Greninja)
 *        the best line removes AERODACTYL with WATER SHURIKEN beside it --
 *        Water Shuriken has priority, so Aerodactyl dies before it moves and
 *        we take nothing. A portfolio ranked by move power picks Scald (80 BP
 *        over 15) and pays 193 HP instead.
 *
 *   ss8, ROCKET HIDE. LEFT GUARD (Weezing-Galar + Slaking vs Claydol + Hitmonlee)
 *        the best line is Extrasensory into Weezing-Galar while FAKE OUT
 *        flinches Slaking, for nothing. Ranked by power, Brick Break (75 over
 *        40) wins and costs 90.
 *
 * It also pins what the position score must keep doing: Dark Void putting one
 * of ours to sleep has to cost something measured, and an Attack drop on a
 * special attacker has to cost nothing at all.
 *
 * Skips cleanly when the core, the ROM or the states are not on this machine.
 * Run: node tools/test_doubles_advisor.js
 */
const fs = require('fs');
const path = require('path');
const D = require('./lib/doubles-oracle.js');
const {advise} = require('./doubles_advisor.js');

const HOME = process.env.HOME;
const SS7 = path.join(HOME, 'RadicalRed-mGBA', 'RadicalRed.ss7');
const SS8 = path.join(HOME, 'RadicalRed-mGBA', 'RadicalRed.ss8');
const BUDGET = 18;

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('PASS  ' + name);
	else { failures++; console.log('FAIL  ' + name); if (detail !== undefined) console.log('        ' + detail); }
}

function pick(res) { return res.ranked.length ? res.label(res.ranked[0].pair) : '(nothing)'; }

async function main() {
	if (!D.available()) { console.log('SKIP: doracle or the ROM is not on this machine'); return; }
	if (!fs.existsSync(SS7) || !fs.existsSync(SS8)) { console.log('SKIP: the doubles save states are not on this machine'); return; }

	// ---- ss7 -------------------------------------------------------------
	const a = await advise(SS7, {budget: BUDGET, quiet: true});
	check('ss7 offers the whole legal space to choose from (128 pairs)',
		a.all.length === 128, a.all.length + ' pairs');
	check('ss7 coverage: every legal action of ours is played at least once',
		a.gaps.length === 0, a.gaps.join(', '));
	const topA = pick(a);
	check('ss7 recommends removing Aerodactyl with Water Shuriken beside it',
		/Water Shuriken at Aerodactyl/.test(topA) && /at Aerodactyl/.test(topA.split('+')[0]), topA);
	check('ss7 best line costs us nothing',
		a.ranked[0].sum.ourLost === 0 && a.ranked[0].sum.ourDead === 0,
		'lost ' + a.ranked[0].sum.ourLost + ' and ' + a.ranked[0].sum.ourDead + ' Pokemon');
	check('ss7 best line removes one of theirs',
		a.ranked[0].sum.theirDead === 1, 'theirDead=' + a.ranked[0].sum.theirDead);

	// The sleep lines must exist, be measured, and rank BELOW the clean line.
	const slept = a.ranked.filter(x => x.cond && x.cond.value < -50);
	check('ss7 finds lines whose conditions cost real HP (Dark Void)',
		slept.length > 0, slept.length + ' such lines');
	if (slept.length) {
		check('  and every one of them ranks below the clean best line',
			slept.every(x => x.v < a.ranked[0].v));
		check('  and the cost is a measured number, not a label',
			slept.every(x => Number.isFinite(x.cond.value) && x.cond.value < 0),
			JSON.stringify(slept.map(x => Math.round(x.cond.value))));
	}
	// JAMES'S RULE, AS A MEASUREMENT RATHER THAN AN EXCEPTION. "A stat move is
	// not an improvement by itself": an Attack drop on a special attacker must
	// price at nothing, and the same machinery must still find a real number
	// for the drop that does matter. Both halves, or the zero proves nothing.
	const P = require('./lib/doubles-position.js');
	const H = require('./lib/harness.js');
	const engine = H.loadEngine(), dexBundle = H.loadDex();
	const peek = await D.probe(SS7, {a0: null, a2: null});
	const impose = (stat, stage) => {
		const o = JSON.parse(JSON.stringify(peek.obs));
		o.battlers[2].stages[stat] = 6 + stage;      // our Greninja, a special attacker
		const built = P.stateFrom(engine, dexBundle, o);
		return built ? P.conditions(engine, built).value : null;
	};
	const atkDrop = impose(1, -1);      // Attack -1
	const spaDrop = impose(4, -1);      // Sp.Atk -1
	check('an Attack drop on our special attacker is priced at nothing',
		atkDrop !== null && Math.abs(atkDrop) < 1, 'measured ' + atkDrop);
	check('  while a Sp.Atk drop on the same Pokemon is priced as a real loss',
		spaDrop !== null && spaDrop < -1, 'measured ' + spaDrop);

	// ---- ss8, the fight the portfolio was NOT designed against -----------
	const b = await advise(SS8, {budget: BUDGET, quiet: true});
	check('ss8 coverage: every legal action of ours is played at least once',
		b.gaps.length === 0, b.gaps.join(', '));
	const topB = pick(b);
	check('ss8 recommends Extrasensory into Weezing-Galar with Fake Out on Slaking',
		/Extrasensory at Weezing-Galar/.test(topB) && /Fake Out at Slaking/.test(topB), topB);
	check('ss8 best line costs us nothing',
		b.ranked[0].sum.ourLost === 0 && b.ranked[0].sum.ourDead === 0,
		'lost ' + b.ranked[0].sum.ourLost);

	// ---- a certain faint ranks last --------------------------------------
	// The Game Corner guard, three turns in: removing their Granbull while
	// losing Accelgor scored 973, and "Accelgor U-turns out while Water
	// Shuriken chips Granbull" scored 133 and lost nobody. Zero faints is the
	// target, so the second has to win. Played from the same chain the
	// playthrough takes, so the position is real rather than constructed.
	const os = require('os');
	const chain = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-adv-chain-'));
	const t1 = path.join(chain, 't1.ss'), t2 = path.join(chain, 't2.ss');
	await D.probe(SS7, {a0: {type: 'move', index: 2, target: 3}, a2: {type: 'move', index: 3, target: 3}}, {save: t1});
	if (fs.existsSync(t1)) {
		await D.probe(t1, {a0: {type: 'move', index: 1, target: 1}, a2: {type: 'move', index: 0, target: 1}}, {save: t2});
	}
	if (fs.existsSync(t2)) {
		const c = await advise(t2, {budget: BUDGET, quiet: true});
		const top = c.ranked[0];
		check('a line that loses one of ours never outranks one that loses nobody',
			top && top.sum.ourDead === 0, top ? ('top loses ' + top.sum.ourDead) : 'nothing ranked');
		check('  and the clean line on that turn is the U-turn out',
			top && /U-turn/.test(c.label(top.pair)), top && c.label(top.pair));
		const withFaint = c.ranked.find(x => x.sum.ourDead > 0);
		check('  even though a line that trades one of ours scores higher on the total',
			!!withFaint && withFaint.v > top.v,
			withFaint ? (Math.round(withFaint.v) + ' against ' + Math.round(top.v)) : 'no trading line was played');
		try { fs.rmSync(chain, {recursive: true, force: true}); } catch (e) { /* gone */ }
	}

	// ---- the budget ------------------------------------------------------
	check('both turns are decided inside James\'s time budget (10 s)',
		a.secs <= 10 && b.secs <= 10, 'ss7 ' + a.secs + ' s, ss8 ' + b.secs + ' s');
	check('nothing was thrown away for a wrong arrival',
		a.thrown.length === 0 && b.thrown.length === 0,
		JSON.stringify(a.thrown.concat(b.thrown).map(x => x.bad)));

	console.log('\n' + failures + ' failure(s)');
	process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
