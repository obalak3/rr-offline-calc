/**
 * Find the agent's mistakes without anybody watching it play.
 * Run: node tools/find_mistakes.js [howManyToShow]
 *
 * The problem this solves, in James's words: "it is making a lot of mistakes.
 * Someone needs to look at those mistakes and figure out what to improve. I
 * can't do it for hours on end, and you as claude aren't too good at pokemon."
 *
 * So neither of us judges the moves. A SLOWER, DEEPER search does.
 *
 * The live agent has under a second to decide. Offline there is no such limit,
 * so every archived position is re-examined with a much larger budget -- more
 * candidate lines, priced further out. Where the deep answer disagrees with what
 * was actually played, and disagrees by a MARGIN that matters, that turn is a
 * candidate mistake. Ranked by margin, the worst handful float to the top and
 * everything else can be ignored.
 *
 * A disagreement is not automatically a bad move: it can equally be a bad MODEL,
 * since the teacher uses the same engine and the same opponent predictor, and
 * both are known to have errors. That is not a flaw in the method. Either kind
 * is worth finding, and which one it is can be settled by replaying the turn in
 * the emulator, where save states make the counterfactual exact rather than
 * simulated.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const C = require('./lib/candidates.js');
const {pricePath} = require('./lib/paths.js');

const DIR = path.join(process.env.HOME, 'rr-agent', 'turns');
const SHOW = parseInt(process.argv[2], 10) || 8;
const engine = H.loadEngine();
const B = engine.B;
const dex = H.loadDex();
const party = H.realTeam();
const speciesName = id => (dex.byID[id] && dex.byID[id].name) || null;

const ALL = H.earlyBattles(engine, {maxLevel: 60});
function battleOf(name) {
	const base = n => String(n || '').split('-')[0];
	return ALL.find(b => (b.team || []).some(m => m.species === name))
		|| ALL.find(b => (b.team || []).some(m => base(m.species) === base(name)));
}

if (!fs.existsSync(DIR)) { console.log('no archived turns yet'); process.exit(0); }
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
console.log('reviewing ' + files.length + ' archived turns\n');

const findings = [];
for (const f of files) {
	let rec;
	try { rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { continue; }
	const obs = rec.obs;
	if (!obs || !obs.foe) continue;
	const theirName = speciesName(obs.foe.species);
	const bt = battleOf(theirName);
	if (!bt) continue;
	const foeSets = H.foeSets(bt);
	const ctx = {engine, party, foeSets,
		expendable: (process.env.EXPENDABLE || 'Lilligant').split(',').filter(Boolean)};

	const baseOf = n => String(n || '').split('-')[0];
	let fi = foeSets.findIndex(x => x.species === theirName);
	if (fi < 0) fi = foeSets.findIndex(x => baseOf(x.species) === baseOf(theirName));
	if (fi < 0) continue;

	// The position as it was.
	const hp = {}, dead = [], foeDead = [];
	(obs.party || []).forEach((row, i) => {
		const p = party[i];
		if (!p || !row.maxhp) return;
		hp[p.species] = row.hp / row.maxhp;
		if (row.hp <= 0) dead.push(p.species);
	});
	(obs.foeparty || []).forEach((row, i) => { if (row.maxhp && row.hp <= 0) foeDead.push(i); });
	const entry = {hp, dead, foeDead, active: speciesName(obs.me.species),
		field: {terrain: null, terrainTurns: 0}};

	// The deep opinion: price every idea, not the handful the live agent has
	// time for, and keep the best two so the margin can be measured.
	let ideas;
	try { ideas = C.candidatesFor(ctx, fi, {field: entry.field, perKiller: 6}); }
	catch (e) { continue; }
	const priced = [];
	for (const cand of ideas) {
		if (!cand.jobs.length) continue;
		if (cand.jobs.every(j => dead.includes(j.mon))) continue;
		let r;
		try { r = pricePath(ctx, fi, cand.jobs, entry, {expendable: ctx.expendable}); }
		catch (e) { continue; }
		if (!r.kills) continue;
		let spend = 0;
		for (const k in r.spend) spend += Math.max(0, r.spend[k]);
		const illegal = r.dead.filter(n => !ctx.expendable.includes(n));
		priced.push({cand, r, cost: spend + illegal.length * 6 + 4 * r.deathRisk});
	}
	if (!priced.length) continue;
	priced.sort((a, b) => a.cost - b.cost);
	const bestLine = priced[0];
	const bestFirst = bestLine.cand.jobs[0];
	const playedName = rec.played || '';

	// Did the deep search want a different FIRST move than the one played?
	const wantedMove = (bestFirst.moves && bestFirst.moves[0]) || null;
	const wantedMon = bestFirst.mon;
	const ourName = speciesName(obs.me.species);
	const wanted = (wantedMon !== ourName) ? ('switch to ' + wantedMon) : wantedMove;
	if (!wanted || !playedName) continue;
	// Compare like with like. A switch agrees only when it is to the SAME
	// Pokemon -- the first version treated any switch as matching any switch
	// recommendation, which is how twelve turns produced zero disagreements.
	const playedIsSwitch = playedName.startsWith('switch');
	const wantedIsSwitch = wantedMon !== ourName;
	let agreed;
	if (playedIsSwitch || wantedIsSwitch) {
		agreed = playedIsSwitch && wantedIsSwitch && rec.playedMon === wantedMon;
	} else {
		agreed = playedName === wantedMove;
	}
	if (agreed) continue;

	// How much did it cost? Price the line the agent actually committed to.
	const alt = priced.find(p => {
		const j = p.cand.jobs[0];
		const nm = (j.mon !== ourName) ? ('switch to ' + j.mon) : ((j.moves || [])[0] || '');
		return nm === playedName || (j.moves || []).includes(playedName);
	});
	const margin = alt ? (alt.cost - bestLine.cost) : null;
	findings.push({
		turn: obs.turn, us: ourName, them: theirName,
		theirHP: obs.foe.hp, ourHP: obs.me.hp,
		played: playedName, wanted: wanted,
		why: bestLine.cand.why, margin: margin,
		plan: rec.plan
	});
}

findings.sort((a, b) => (b.margin === null ? 0.5 : b.margin) - (a.margin === null ? 0.5 : a.margin));
console.log(findings.length + ' turns where a deeper search wanted something else\n');
findings.slice(0, SHOW).forEach((f, i) => {
	console.log('#' + (i + 1) + '  turn ' + f.turn + '   ' + f.us + ' (' + f.ourHP + ') vs '
		+ f.them + ' (' + f.theirHP + ')');
	console.log('     played:  ' + f.played);
	console.log('     deeper:  ' + f.wanted + '   -- ' + f.why);
	console.log('     margin:  ' + (f.margin === null
		? 'the played move has no line that kills at all' : f.margin.toFixed(2) + ' HP-equivalents'));
	console.log('');
});
