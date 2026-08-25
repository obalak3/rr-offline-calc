/**
 * How many QUESTIONS does a plan need? The printability check.
 *
 * Run: node tools/check_forks.js [FIGHT] [budget] [index]
 *
 * Walks the route the advisor would give for the REAL party against a fight,
 * and reports, per turn: whether any opponent move within 3 AI-points of the
 * predicted one breaks the script (a FORK -- the player would need to be told
 * "if it does X instead, do Y"), whether a damage roll decides a KO, and
 * whether a crit alone would KO (a contingency; the game announces crits).
 *
 * WHY 3 POINTS. One INCREASE_VIABILITY(3), the smallest adjustment CFRU makes
 * and the most common positive site in its tables. A move within 3 of the top
 * is one unported bonus away from being the real choice.
 *
 * THE CHECK IS DELIBERATELY HARSH. On a deviation it plays the ORIGINAL script
 * onward (the foe reverts to argmax); it does not try to repair the plan. So
 * "fork needed" means the unmodified script fails, not that no recovery
 * exists. First measured result, Lt. Surge with the real team: 24 turns, 24
 * forks, 6 of them exact ties, plus 3 roll-decided KOs and 6 crit-fragile
 * turns -- four of them consecutive in the Lilligant stall. That line is not a
 * plan; it is a 24-question interrogation with a coin at every table.
 */
'use strict';

const H = require('./lib/harness.js');
const l = H.loadEngine(); const B = l.B, X = l.X;
const RRAI = l.sandbox.RRAI;
const FLAGS = {checkBadMove: true, checkGoodMove: true};
const STEP = {mode: 'maxroll', risks: {roll: 'median'}};

const cliArgs = process.argv.slice(2).filter(a => a.charAt(0) !== '-');
const pattern = (cliArgs[0] || 'SURGE').toUpperCase();
const cliBudget = parseInt(cliArgs[1], 10) || 60000;
const which = parseInt(cliArgs[2], 10) || 0;   // when a pattern matches twice

const party = H.realTeam();
const matches = H.earlyBattles(l, {maxLevel: 100, relativeBase: 75})
	.filter(x => H.label(x).toUpperCase().includes(pattern));
if (!matches.length) { console.log('no battle matching ' + pattern); process.exit(1); }
const battle = matches[Math.min(which, matches.length - 1)];
console.log('=== ' + H.label(battle) + ' ===');
const mkState = () => B.createState(party, H.foeSets(battle), {});

function argmax(st) {
  const scored = RRAI.scoreAll(st, 'foe', FLAGS, {});
  const gate = RRAI.switchGate(st, 'foe', FLAGS);
  let best = null;
  for (const e of scored) {
    if (e.action.type === 'switch' && !gate.maySwitch) continue;
    if (!best || e.score > best.score) best = e;
  }
  return best && best.action;
}
function findMine(st, step) {
  return B.legalActions(st, 'me').find(a => step.action.type === 'switch'
    ? (a.type === 'switch' && a.index === step.action.index)
    : (a.type === 'move' && a.move === step.action.move));
}
const faints = s => s.me.team.filter(m => m.fainted).length;
const foeDown = s => s.foe.team.every(m => m.fainted);

// The line, from the same call the sheet makes.
B.clearCache();
const route = X.planRoute(mkState(), {exactBudget: cliBudget, maxTurns: 24,
  lookahead: 2, budget: 30000, risks: {roll: 'median'}});
const script = route.steps;
const baselineLoss = route.losses;
console.log('line: ' + script.length + ' turns, exactness=' + route.exactness +
  ', baseline losses=' + baselineLoss + '\n');

// Play the remaining script from a forked state; foe plays argmax throughout.
function playOut(st, from) {
  for (let j = from; j < script.length + 14; j++) {
    if (foeDown(st)) return {win: true, losses: faints(st)};
    if (st.me.team.every(m => m.fainted)) return {win: false, losses: faints(st)};
    const step = script[Math.min(j, script.length - 1)];
    const mine = j < script.length ? findMine(st, step) : null;
    // Off the end of the script, or scripted action now illegal: best attack.
    const act = mine || B.legalActions(st, 'me').find(a => a.type === 'move');
    if (!act) return {win: false, losses: faints(st)};
    const theirs = argmax(st);
    if (!theirs) return {win: false, losses: faints(st)};
    try { st = B.step(st, act, theirs, STEP)[0].state; }
    catch (e) { return {win: false, losses: faints(st)}; }
  }
  return {win: foeDown(st), losses: faints(st)};
}

let st = mkState();
let aiForks = 0, rollTurns = 0, critTurns = 0, tieTurns = 0;
const notes = [];
for (let i = 0; i < script.length; i++) {
  const step = script[i];
  const mine = findMine(st, step);
  if (!mine) { notes.push('turn ' + step.turn + ': script action illegal, stopping'); break; }

  // predicted foe action and the in-margin alternatives
  const scored = RRAI.scoreAll(st, 'foe', FLAGS, {}).slice().sort((a, b) => b.score - a.score);
  const gate = RRAI.switchGate(st, 'foe', FLAGS);
  const legalScored = scored.filter(e => e.action.type !== 'switch' || gate.maySwitch);
  const top = legalScored[0];
  const alts = [];
  const seen = new Set([top.action.move || ('s' + top.action.index)]);
  for (const e of legalScored.slice(1)) {
    const k = e.action.move || ('s' + e.action.index);
    if (seen.has(k)) continue;
    if (top.score - e.score <= 3) { alts.push(e); seen.add(k); }
  }
  const exactTies = alts.filter(e => e.score === top.score).length;
  if (exactTies) tieTurns++;

  // does the script HOLD against each alternative?
  const broken = [];
  for (const alt of alts) {
    let fork;
    try { fork = B.step(st, mine, alt.action, STEP)[0].state; }
    catch (e) { broken.push(alt); continue; }
    const out = playOut(fork, i + 1);
    if (!(out.win && out.losses <= baselineLoss)) {
      broken.push(alt);
    }
  }
  if (broken.length) {
    aiForks++;
    notes.push('turn ' + step.turn + ': fork needed -- script breaks if ' +
      step.theirMon + ' uses ' + broken.map(e =>
        (e.action.move || 'switch') + (e.score === top.score ? ' (TIE)' : ' (gap ' + (top.score - e.score) + ')')
      ).join(' / ') + ' instead of ' + (top.action.move || 'switch'));
  }

  // roll and crit fragility of THIS turn's predicted move, against our active
  const meAct = B.active(st.me);
  if (top.action.type === 'move') {
    let rolls = null;
    try { rolls = B.damageRolls(st, 'foe', top.action.move); } catch (e) {}
    if (rolls) {
      const nc = rolls.noCrit, cr = rolls.crit;
      if (Math.max(...nc) >= meAct.curHP && Math.min(...nc) < meAct.curHP) {
        rollTurns++;
        notes.push('turn ' + step.turn + ': ROLL decides a KO on ' + meAct.species +
          ' (' + Math.min(...nc) + '-' + Math.max(...nc) + ' into ' + meAct.curHP + ')');
      }
      if (Math.max(...cr) >= meAct.curHP && Math.max(...nc) < meAct.curHP) {
        critTurns++;
        notes.push('turn ' + step.turn + ': CRIT would KO ' + meAct.species +
          ' (crit ' + Math.min(...cr) + '-' + Math.max(...cr) + ' into ' + meAct.curHP + ')');
      }
    }
  }

  // advance along the script
  const theirs = B.legalActions(st, 'foe').find(a => step.theirAction.type === 'switch'
    ? a.type === 'switch' && a.index === step.theirAction.index
    : a.type === 'move' && a.move === step.theirAction.move);
  if (!theirs) { notes.push('turn ' + step.turn + ': scripted foe action not found, stopping'); break; }
  st = B.step(st, mine, theirs, STEP)[0].state;
}

console.log('turns analysed        ' + script.length);
console.log('AI forks (questions)  ' + aiForks + '   <- turns where an in-margin move breaks the script');
console.log('  of which exact-tie turns on the line: ' + tieTurns);
console.log('roll-threshold turns  ' + rollTurns + '   <- a damage roll decides a KO');
console.log('crit-fragile turns    ' + critTurns + '   <- only a crit kills (contingency, not question)');
console.log('');
for (const n of notes) console.log('  ' + n);
