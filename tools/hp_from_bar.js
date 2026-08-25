/**
 * Does "a bar plus known max HP plus sixteen known rolls" really give exact HP?
 *
 * PLAN-SCREEN-READER.md rests on this claim and it had never been tested:
 *
 *   "The bar's filled pixel width gives a fraction to about 1/48 resolution;
 *    intersect that interval with the sixteen candidate values and the answer
 *    is usually UNIQUE."
 *
 * If it holds, the reader never has to read a number the game does not print.
 * If it does not, the reader has to carry the foe's HP as an INTERVAL, which
 * DESIGN-UNCERTAINTY.md already knows how to do -- so this is not pass/fail, it
 * is sizing a design decision before writing any pixel code.
 *
 * The bar model is the ROM's: FireRed scales the health bar to 48 pixels with
 * integer division, and never shows an empty bar for a living Pokemon.
 *
 *     filled = floor(cur * 48 / max),  and at least 1 while cur > 0
 *
 * Measured over REAL trainer teams, with the player's REAL party read off the
 * save, because uniqueness depends on the ratio of roll spread to bar
 * resolution and both of those are level dependent. Made-up level-50 matchups
 * would answer a different question.
 *
 * Run: node tools/hp_from_bar.js [--bar 48] [--limit N]
 */
'use strict';

const H = require('./lib/harness');

const argv = process.argv.slice(2);
function flag(name, dflt) {
	const i = argv.indexOf('--' + name);
	return i === -1 ? dflt : Number(argv[i + 1]);
}
const BAR = flag('bar', 48);
const LIMIT = flag('limit', 0);
const MAXLEVEL = flag('maxLevel', 34);

/** Filled pixels the ROM would draw. */
function barPixels(cur, max, width) {
	if (cur <= 0) return 0;
	return Math.max(1, Math.floor((cur * width) / max));
}

const loaded = H.loadEngine();
const B = loaded.sandbox.RRBattle;

let team;
try {
	team = H.realTeam();
} catch (e) {
	console.error('could not read the save (' + e.message + ')');
	process.exit(1);
}
const mySets = team.map(function (m) {
	return {species: m.species, level: m.level, nature: m.nature, ability: m.ability,
		item: m.item || '', moves: m.moves.slice(0, 4), evs: m.evs, ivs: m.ivs};
});
console.log('our party: ' + mySets.map(function (m) {
	return m.species + ' L' + m.level;
}).join(', '));

const battles = H.earlyBattles(loaded, {maxLevel: MAXLEVEL});
console.log('trainer battles considered: ' + battles.length + '  (bar width ' + BAR + 'px)\n');

let cases = 0, unique = 0, kos = 0;
const sizeHist = new Map();
const spreadHist = new Map();
const barBound = [];
let worstSpread = 0;
let decisions = 0, ambiguous = 0, worstGap = 0;
const worst = [];
let done = 0;

for (const battle of battles) {
	if (LIMIT && done >= LIMIT) break;
	done++;
	const foes = H.foeSets(battle);
	for (const foe of foes) {
		for (const mine of mySets) {
			let state;
			try {
				state = B.createState([mine], [foe], {});
			} catch (e) { continue; }
			const foeMon = B.active(state.foe);
			const max = foeMon.maxHP;
			if (!max) continue;
			for (const moveName of mine.moves) {
				let rolls;
				try { rolls = B.damageRolls(state, 'me', moveName); } catch (e) { continue; }
				if (!rolls || rolls.immune || !rolls.noCrit) continue;
				const dmgs = rolls.noCrit;
				if (!dmgs.length || dmgs[dmgs.length - 1] <= 0) continue;

				// Every roll is a real outcome we might have to read back.
				for (let r = 0; r < dmgs.length; r++) {
					const trueHP = max - dmgs[r];
					if (trueHP <= 0) { kos++; continue; }   // a faint is announced; no inference needed
					const seen = barPixels(trueHP, max, BAR);
					// What a reader knows: the bar, the max, and the roll set.
					const consistent = new Set();
					for (let k = 0; k < dmgs.length; k++) {
						const cand = max - dmgs[k];
						if (cand > 0 && barPixels(cand, max, BAR) === seen) consistent.add(cand);
					}
					cases++;
					const n = consistent.size;
					const vals = Array.from(consistent);
					const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
					spreadHist.set(spread, (spreadHist.get(spread) || 0) + 1);
					if (spread > worstSpread) worstSpread = spread;
					barBound.push((max / BAR));
					sizeHist.set(n, (sizeHist.get(n) || 0) + 1);
					if (n === 1) unique++;

					// The only cost that matters: does not knowing the exact HP
					// change what we would DO next turn? Take the pessimistic
					// and optimistic ends of the interval and ask each of our
					// moves how many of its sixteen rolls kill. If both ends
					// agree, the uncertainty is invisible to the decision and
					// costs nothing at all.
					const lo = Math.min.apply(null, vals);
					const hi = Math.max.apply(null, vals);
					if (hi !== lo) {
						for (const nextMove of mine.moves) {
							let nr;
							try { nr = B.damageRolls(state, 'me', nextMove); } catch (e) { continue; }
							if (!nr || nr.immune || !nr.noCrit) continue;
							let killLo = 0, killHi = 0;
							for (let k = 0; k < nr.noCrit.length; k++) {
								if (nr.noCrit[k] >= lo) killLo++;
								if (nr.noCrit[k] >= hi) killHi++;
							}
							decisions++;
							if (killLo !== killHi) {
								ambiguous++;
								const gap = killLo - killHi;
								if (gap > worstGap) worstGap = gap;
							}
						}
					} else {
						// An exact reading can never be ambiguous; count it so
						// the denominator is every decision, not just the hard ones.
						for (const nextMove of mine.moves) {
							let nr;
							try { nr = B.damageRolls(state, 'me', nextMove); } catch (e) { continue; }
							if (!nr || nr.immune || !nr.noCrit) continue;
							decisions++;
						}
					}
					if (n >= 3 && worst.length < 6) {
						worst.push(mine.species + ' ' + moveName + ' -> ' + foe.species +
							' (max ' + max + ', rolls ' + dmgs[0] + '-' + dmgs[dmgs.length - 1] +
							'): bar ' + seen + '/' + BAR + ' leaves ' + n + ' candidates');
					}
				}
			}
		}
	}
}

console.log('post-hit readings where the foe survived: ' + cases);
console.log('KOs (exact by announcement, excluded):    ' + kos);
console.log('');
console.log('EXACT HP recovered: ' + unique + '/' + cases +
	'  (' + (100 * unique / cases).toFixed(1) + '%)');
console.log('');
console.log('candidates remaining after the bar narrows the roll set:');
const sizes = Array.from(sizeHist.keys()).sort(function (a, b) { return a - b; });
for (const s of sizes) {
	const n = sizeHist.get(s);
	console.log('  ' + String(s).padStart(2) + '  ' + String(n).padStart(7) +
		'  ' + (100 * n / cases).toFixed(1) + '%' +
		'  ' + '#'.repeat(Math.round(60 * n / cases)));
}
// The mean matters more than the max: an interval of two adjacent HP values is
// nearly free downstream, where a wide one is what forces a re-sync question.
let weighted = 0;
for (const s of sizes) weighted += s * sizeHist.get(s);
console.log('\nmean candidate set: ' + (weighted / cases).toFixed(2));
// The count of candidates is not the cost; the HP SPREAD is. Two candidates one
// point apart is free downstream, where a spread of twenty would force a
// re-sync question. The bar alone bounds the spread to about max/48 regardless
// of how many rolls survive, which is why this stays small.
console.log('\nHP SPREAD of the surviving candidates (what the advisor carries):');
const sp = Array.from(spreadHist.keys()).sort(function (a, b) { return a - b; });
let wsum = 0;
for (const v of sp) wsum += v * spreadHist.get(v);
for (const v of sp) {
	const n = spreadHist.get(v);
	console.log('  ' + String(v).padStart(2) + ' HP  ' + String(n).padStart(7) +
		'  ' + (100 * n / cases).toFixed(1) + '%');
}
console.log('mean spread ' + (wsum / cases).toFixed(2) + ' HP, worst ' + worstSpread + ' HP');
const mb = barBound.reduce(function (a, b) { return a + b; }, 0) / barBound.length;
console.log('bar resolution alone bounds it to ~' + mb.toFixed(1) +
	' HP on average (max/' + BAR + ')');

console.log('\nDOES IT CHANGE THE DECISION? (kill-count at each end of the interval)');
console.log('  kill/no-kill decisions priced: ' + decisions);
console.log('  where the interval changes the roll count that kills: ' + ambiguous +
	'  (' + (100 * ambiguous / decisions).toFixed(2) + '%)');
console.log('  worst disagreement: ' + worstGap + ' of 16 rolls');

if (worst.length) {
	console.log('\nwidest examples:');
	for (const w of worst) console.log('  ' + w);
}
