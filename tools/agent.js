/**
 * The planner, playing. One turn at a time.
 *
 * Run: node tools/agent.js          (then load tools/lua/bootstrap.lua in mGBA;
 *                                    it hot-reloads tools/lua/agent_impl.lua)
 *
 * The loop James asked for: "It does a move, the model makes a quicksave to
 * look at the AI's next move and finds the best move for us, and then the next
 * move is played." The quicksave turned out to be unnecessary -- the AI's
 * chosen action is readable from live RAM at the decision point -- so the loop
 * is tighter than that: read the position, read what the opponent has already
 * committed to, decide, play it, check what happened.
 *
 * THE PREDICTION LOG IS THE POINT OF THE EARLY FIGHTS. Every turn this writes
 * down what it expected -- the crit flag, the damage roll, the damage -- before
 * pressing anything, and then what actually happened. Two things are known to
 * be unverified: the order in which a full turn consumes RNG draws when both
 * sides act, and which draw decides a secondary effect like a Scald burn.
 * Neither is worth another hand-built fixture. A hundred real turns of
 * predicted-against-actual settles both, and the same log says why a fight was
 * lost. Losing the first fights is expected and fine.
 *
 * The opponent is reconstructed EXACTLY rather than guessed: species, level,
 * moves, ability, item, current HP, status, stat stages and its real stats all
 * come out of gBattleMons, and the real stats go into the calculator as base
 * stat overrides so it computes from the numbers the game is using.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness.js');
const R = require('./lib/replan.js');
const UL = require('./lib/userline.js');

const DIR = path.join(process.env.HOME, 'rr-agent');
const STATE = path.join(DIR, 'state.json');
const CMD = path.join(DIR, 'cmd.json');
// The save state the actuator writes next to every state.json, for the
// windowless oracle core (tools/lib/oracle.js). RR_ORACLE=0 switches it off.
const SNAP = path.join(DIR, 'turn.ss');
const ORACLE = require('./lib/oracle.js');
// Names this agent session's append-only archive folder (see the archiver).
const SESSION = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const RESULT = path.join(DIR, 'result.json');
const PRED = path.join(DIR, 'predictions.tsv');
// THE HUMAN'S TWO CONTROLS (tools/control.js). Files, not a socket, so the
// agent has no dependency on the panel being up: no pause file means play, no
// panel heartbeat means nobody is watching and nothing waits on a person.
const PAUSE = path.join(DIR, 'pause');
const ASK = path.join(DIR, 'ask.json');
const CHOICE = path.join(DIR, 'choice.json');
const PANEL = path.join(DIR, 'panel.alive');
// A line typed by hand, the verdict on it, and the append-only record of every
// line ever asked about. The record is the point as much as the answer is:
// "why didn't it do that" is only worth asking if the answer survives the turn.
const LINE = path.join(DIR, 'line.json');
const LINE_RESULT = path.join(DIR, 'line_result.json');
const LINES_LOG = path.join(DIR, 'lines.jsonl');

const engine = H.loadEngine();
const B = engine.B;
const RRAI = engine.sandbox.RRAI;
const AI_FLAGS = {checkBadMove: true, checkGoodMove: true};
const dex = H.loadDex();
const party = H.realTeam();
const SPECIES_ID = (() => {
	const map = {};
	const d = engine.sandbox && engine.sandbox.RR_DEX_DATA;
	if (d && d.species) Object.keys(d.species).forEach(id => {
		const sp = d.species[id];
		if (sp && sp.name && map[sp.name] === undefined) map[sp.name] = Number(id);
	});
	return map;
})();
function speciesIdOf(name) { return SPECIES_ID[name] || SPECIES_ID[String(name).split('-')[0]] || 0; }
function liveRoster(obs) {
	const RRSave = engine.sandbox && engine.sandbox.RRSave;
	if (!RRSave || !RRSave.readRecord || !obs || !obs.party) return null;
	const out = [];
	for (const row of obs.party) {
		if (!row || typeof row.raw !== 'string' || row.raw.length < 200) return null;
		const bytes = Buffer.from(row.raw, 'hex');
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let mon = null;
		try { mon = RRSave.readRecord(view, 0, true); } catch (e) { mon = null; }
		if (!mon) return null;
		out.push({species: mon.species, level: mon.level, nature: mon.nature,
			ability: mon.ability, item: mon.item, moves: mon.moves, evs: mon.evs, ivs: mon.ivs});
	}
	return out.length ? out : null;
}

/**
 * Which trainer battle is this? Identified by the opponent's active species,
 * so the real sets (abilities, items, Hidden Power types, EV spreads) can be
 * used instead of anything inferred from RAM.
 */
/**
 * THE BATTLE LIST HAS TO INCLUDE THE SCALING FIGHTS.
 *
 * `earlyBattles` skips every trainer whose levels scale to the player unless it
 * is given a `relativeBase` to resolve them against -- 103 of the dataset's
 * fights against 36. This was built once, with no base, so the live agent could
 * only ever recognise the fixed-level fights. On 2026-09-02 that meant Lass
 * Anne in Viridian Forest was not found at all, and `foeTeamFor` fell back to
 * CLONING the active: the agent fought Stufful/Clefairy/Audino believing it
 * faced three Stuffuls, one of them showing 46 HP against a 42 maximum. It
 * could not plan for a Pokemon it did not know existed.
 *
 * The base is our own level, so it is rebuilt whenever the team levels up.
 * Resolved against Lass Anne this gives Stufful 12, Clefairy 10, Audino 12,
 * which is exactly what RAM reports.
 */
const battleLists = new Map();
function battlesFor(level) {
	const base = Math.max(1, Number(level) || 0);
	if (!battleLists.has(base)) {
		battleLists.set(base, H.earlyBattles(engine, {maxLevel: 100, relativeBase: base}));
	}
	return battleLists.get(base);
}
function ourLevel(obs) {
	const levels = (obs && obs.party || []).map(r => r && r.level).filter(Boolean);
	return levels.length ? Math.max.apply(null, levels) : (obs && obs.me && obs.me.level) || 5;
}
const battleCache = {};
/**
 * ONE SOURCE OF TRUTH FOR WHO IS FIGHTING, and a guard that shouts if anything
 * disagrees with it.
 *
 * This is the fourth bug of the same shape in one day. The roster was read from
 * the .sav in one place and from RAM in another; the battle list was built for
 * fixed-level fights in one place and matched against a scaling one elsewhere;
 * a switch target was resolved by max HP on one side and by species on the
 * other. Each time, both halves ran happily and produced a confident answer
 * about a fight that was not happening -- the planner duelling a level 3 SENTRET
 * while a level 15 Furret stood on the field, and asking which two Pokemon to
 * sacrifice to a Clefairy that Furret one-shots.
 *
 * James, 2026-09-02: "I am actually bored of this problem coming up and up and
 * up again. One thing finds something one thing finds another and then they
 * don't communicate well and then we are looking at a completely dumb error."
 *
 * So: derive the teams ONCE per observation, hand the same object to the state
 * builder and to the planner, and CHECK on every decision that the state and
 * the plan context still describe the same six Pokemon. A mismatch is printed
 * loudly rather than silently producing a plan about the wrong team.
 */
let teamsCache = {obs: null, teams: null};
function teamsFor(obs) {
	if (teamsCache.obs === obs && teamsCache.teams) return teamsCache.teams;
	const teams = {party: liveRoster(obs) || party, foeSets: foeTeamFor(obs)};
	teamsCache = {obs: obs, teams: teams};
	return teams;
}

/** Loud, not fatal: a wrong plan is worse than a slow one, but stopping is worse still. */
function assertSameTeams(st, pctx, where) {
	const namesOf = arr => arr.map(x => (x.set ? x.set.species : x.species)).join(',');
	const inState = namesOf(st.me.team), inPlan = namesOf(pctx.party);
	if (inState !== inPlan) {
		console.log('  [!! THE TWO HALVES DISAGREE ABOUT OUR TEAM (' + where + ')');
		console.log('      state:  ' + inState);
		console.log('      plan:   ' + inPlan);
		console.log('      any plan from here is about a team that is not on the field]');
		return false;
	}
	const foeState = namesOf(st.foe.team), foePlan = namesOf(pctx.foeSets);
	if (foeState !== foePlan) {
		console.log('  [!! THE TWO HALVES DISAGREE ABOUT THEIR TEAM (' + where + ')');
		console.log('      state:  ' + foeState);
		console.log('      plan:   ' + foePlan + ']');
		return false;
	}
	return true;
}

// More generation on a fight that does not read easy; cached per turn.
const deepCache = {turn: null, deep: false};
function planDeep(obs) {
	if (deepCache.turn === obs.turn) return deepCache.deep;
	let deep = false;
	try { deep = DIFFICULTY.classify(engine, buildState(obs)).tier === 'hard'; } catch (e) { deep = false; }
	deepCache.turn = obs.turn; deepCache.deep = deep;
	return deep;
}

function planCtx(obs) {
	return {
		engine,
		// THE PLANNER GETS THE LIVE TEAM, not the battery save's.
		//
		// `party` is read once at startup from the .sav, which only holds what
		// the game last WROTE. On 2026-09-02 that made the planner duel with a
		// level 3 SENTRET while a level 15 Furret stood on the field, and with
		// level 3 versions of everyone else: every solo duel came back "died,
		// cost 100%", the only survivors of generation were multi-Pokemon
		// sacrifices, and the panel asked James which two of his team to give
		// up to a Clefairy that his Furret one-shots. buildState was fixed to
		// read the roster from RAM earlier the same day; this context was not,
		// so the two halves of the agent disagreed about who was even alive.
		party: teamsFor(obs).party,
		foeSets: teamsFor(obs).foeSets,
		// EXPENDABLE="" MEANS NOBODY, not "use the default". Written with `||`,
		// an empty string is falsy and silently became the Surge cap, so there
		// was no way to say "every death is forbidden" -- which is exactly what
		// a run outside Surge needs. The death-check below already reads it
		// with `=== undefined`; the two disagreed, so the planner could price
		// Lilligant as spendable while the recorder counted her death as a
		// loss.
		deep: planDeep(obs),
		expendable: (process.env.EXPENDABLE === undefined
			? '' : process.env.EXPENDABLE).split(',').filter(Boolean)
	};
}

/**
 * THEIR TEAM AS SETS -- one answer, shared by the state builder and the
 * planner context.
 *
 * These were two separate constructions that disagreed: `buildState` padded
 * the team to one slot per occupied party slot, while `planCtx` returned a
 * SINGLE set whenever the trainer was not in the dataset. Indices from one
 * were then used against the other, so the moment their active resolved to
 * anything but slot 0 the planner threw `foeSets[fi].species` and every turn
 * printed "no plan found". Same shape as every bug on this project: two parts
 * keeping their own idea of the position.
 */
/** Their party decoded straight from RAM, or null if the Lua did not ship it. */
const HP_TYPES = ['Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
	'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
function hiddenPowerType(ivs) {
	const b = k => (ivs[k] || 0) & 1;
	const n = b('hp') + 2 * b('atk') + 4 * b('def') + 8 * b('spe') + 16 * b('spa') + 32 * b('spd');
	return HP_TYPES[Math.floor(n * 15 / 63)];
}

function foeRosterFromRAM(obs) {
	const RRSave = engine.sandbox && engine.sandbox.RRSave;
	if (!RRSave || !RRSave.readRecord || !obs || !obs.foeparty) return null;
	const out = [];
	for (const row of obs.foeparty) {
		if (!row || !row.maxhp) continue;                   // empty slot
		if (typeof row.raw !== 'string' || row.raw.length < 200) return null;
		let mon = null;
		try {
			const bytes = Buffer.from(row.raw, 'hex');
			mon = RRSave.readRecord(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, true);
		} catch (e) { mon = null; }
		if (!mon) return null;
		// Hidden Power's type is in the IVs and the record carries them, so the
		// move goes in typed. Run 1 on s5 (2026-09-05): Lanturn's duel with
		// Bellibolt was priced at a neutral 60-power hit (16%) and took Hidden
		// Power Grass for 45 (32%); the same record says Grass. Checked against
		// the known Surge sets: Pincurchin Ice, Bellibolt Grass, Manectric Grass.
		const moves = (mon.moves || []).map(m => m === 'Hidden Power' && mon.ivs
			? 'Hidden Power ' + hiddenPowerType(mon.ivs) : m);
		out.push({species: mon.species, level: mon.level, nature: mon.nature,
			ability: mon.ability, item: mon.item || '', moves: moves, evs: mon.evs, ivs: mon.ivs});
	}
	return out.length ? out : null;
}

function foeTeamFor(obs) {
	const foeSet = setFromBattler(obs.foe, null);
	// THE GAME'S OWN RECORDS FIRST. The sheet covers the bosses; everyone else
	// was matched by species and level to the nearest boss set, or cloned from
	// the active. A Rock Tunnel Flareon became Professor Oak's postgame one
	// (Sacred Fire, level 44) and the planner priced three turns of Icy Wind
	// against it instead of the one Water Shuriken that removes the real one.
	const ram = foeRosterFromRAM(obs);
	if (ram && foeSet && ram.some(r => r.species === foeSet.species)) {
		// The party record can only say which of the two ordinary ability
		// slots the PID picks; a HIDDEN ability is invisible to it, and gym
		// Pokemon carry them (Surge's Pawmot decoded as Natural Cure, the
		// battle struct's ability byte says Iron Fist). For the one on the
		// field the battle struct is the truth, so it overrides.
		const trueAb = foeSet.ability;
		if (trueAb) {
			const i = ram.findIndex(r => r.species === foeSet.species
				&& (!obs.foe.maxhp || !obs.foeparty || obs.foeparty.some(row => row && row.maxhp === obs.foe.maxhp)));
			if (i >= 0 && ram[i].ability !== trueAb) {
				ram[i] = Object.assign({}, ram[i], {ability: trueAb});
			}
		}
		return ram;
	}
	const bt = battleOf(obs);
	const known = bt ? (H.foeSets(bt) || []) : [];
	let team = null;
	if (obs.foeparty && obs.foeparty.length && known.length) {
		team = [];
		obs.foeparty.forEach((row, i) => {
			if (!row.maxhp) return;               // empty slot: they carry fewer
			team.push(known[i] || Object.assign({}, foeSet));
		});
	}
	if (!team || !team.length) {
		const n = (obs.foeparty || []).filter(r => r && r.maxhp).length || 1;
		team = [];
		for (let i = 0; i < n; i++) team.push(Object.assign({}, foeSet));
	}
	// THE ACTIVE ONE CARRIES ITS REAL STATS, AT THE SOURCE. This team feeds
	// every duel and every priced plan, and until now it was the sheet's set
	// alone: the sheet's Crawdaunt computes to Speed 70 where the game's reads
	// 50, so in every duel it outran a 61-Speed Lanturn and Knock Off killed
	// her before the second Shock Wave. No "Lanturn kills" line could exist,
	// the market had nothing but sacrifices, and the agent stopped to ask who
	// to lose while James played the two Shock Waves himself (2026-09-03).
	if (obs.foe && obs.foe.stats && obs.foe.stats.length === 5) {
		const rows = obs.foeparty || [];
		let at = rows.findIndex(r => r && r.maxhp === obs.foe.maxhp && r.hp === obs.foe.hp && r.level === obs.foe.level);
		if (at < 0) at = rows.findIndex(r => r && r.maxhp === obs.foe.maxhp && r.level === obs.foe.level);
		if (at < 0) at = team.findIndex(t => t && t.species === foeSet.species);
		if (at >= 0 && team[at]) {
			// ... and its live PP, so every duel knows how many Roosts are left.
			const ramNames = (obs.foe.moves || []).map(id => moveName(id));
			const pp = (team[at].moves || []).map(mv => {
				const i = ramNames.indexOf(mv);
				return i >= 0 && obs.foe.pp && obs.foe.pp[i] !== undefined ? obs.foe.pp[i] : undefined;
			});
			team[at] = Object.assign({}, team[at], {rawStats: {atk: obs.foe.stats[0],
				def: obs.foe.stats[1], spe: obs.foe.stats[2], spa: obs.foe.stats[3],
				spd: obs.foe.stats[4]}, pp: pp});
		}
	}
	return team;
}

/**
 * IS THIS A WILD ENCOUNTER? James, 2026-09-03: "stop it from fighting if it is
 * a regular encounter (like an actual bush pokemon). I need to catch pokemon."
 *
 * Judged from what we can see rather than from a RAM flag, because the
 * vanilla gBattleTypeFlags word reads 0 in every save state on disk and this
 * ROM moves things; its value is shipped as `btype` so the real bit can be
 * pinned from a live wild fight later. The rule: one opponent, and NO trainer
 * in the dataset fields exactly that party (same size, same levels, that
 * species). James's stops are all dataset trainers, so a lone opponent nobody
 * in the table brings at that level is a bush Pokemon. RR_WILD=off disables.
 */
function isWild(obs) {
	if (process.env.RR_WILD === 'off') return false;
	// THE FLAG IS NOW THE RULE. Three live readings pinned gBattleTypeFlags at
	// 0x02022B4C in this ROM: 0x4 in a wild fight (Snubbull), 0xc in a single
	// trainer fight, 0xd in a double trainer fight -- bit 3 is TRAINER, bit 0
	// is DOUBLE, exactly the vanilla layout. The dataset lookup below misfired
	// on turn 295 (a lone Naclstack, trainer bit SET, read as wild) and the
	// agent stood down in a real fight. The lookup remains only for a state
	// that carries no flag word at all.
	if (typeof obs.btype === 'number' && obs.btype !== 0) return !(obs.btype & 0x8);
	const alive = (obs.foeparty || []).filter(r => r && r.maxhp);
	if (alive.length !== 1) return false;
	const name = speciesName(obs.foe.species);
	if (!name) return false;
	const base = n => String(n || '').split('-')[0];
	const level = ourLevel(obs);
	for (const b of battlesFor(level)) {
		const sets = H.foeSets(b) || [];
		if (sets.length !== 1) continue;
		if (base(sets[0].species) !== base(name)) continue;
		if (sets[0].level === alive[0].level) return false;   // a real one-Pokemon trainer
	}
	return true;
}

/**
 * IS THIS A DOUBLE BATTLE? Nothing here plays doubles: the actuator reads one
 * battler a side and has no map of the target-selection screen, so left to
 * itself it would pick a move and then tap A and B at a screen it does not
 * know, against whoever is holding the controller. James, 2026-09-03: "I will
 * have to play those. It won't break if a double battle comes up right?"
 *
 * Two independent readings, either is enough:
 *   1. the dataset marks the fight DOUBLES (27 of 167 -- Mt. Moon's Miguel,
 *      Nugget Bridge, Sabrina, the Rocket guards ...), matched on the active
 *      species, party size and levels like battleOf;
 *   2. RAM: gBattleMons has four battlers, and slots 2 and 3 only hold a
 *      species in doubles. Shipped as b2sp/b3sp; a singles fight reads 0.
 */
let handsOffSaid = -1;
const fightOverride = {sig: null};
const DOUBLES_BATTLES = [];
for (const seg of (engine.TRAINERS && engine.TRAINERS.segments) || []) {
	for (const b of (seg.battles || [])) {
		if ((b.effects || []).some(x => /DOUBLES/i.test(x))) DOUBLES_BATTLES.push(b);
	}
}
function isDoubles(obs) {
	if (process.env.RR_DOUBLES === 'off') return false;
	if ((obs.b2sp || 0) > 0 && (obs.b3sp || 0) > 0) return 'RAM: four battlers';
	const name = speciesName(obs.foe.species);
	if (!name) return false;
	const base = n => String(n || '').split('-')[0];
	const alive = (obs.foeparty || []).filter(r => r && r.maxhp);
	const level = ourLevel(obs);
	for (const b of DOUBLES_BATTLES) {
		const lvl = b.team && b.team[0] && b.team[0].level;
		b.__relativeBase = lvl && lvl.type === 'fixed' ? 0 : Math.max(1, level);
		const sets = H.foeSets(b) || [];
		if (!sets.some(m => base(m.species) === base(name))) continue;
		if (alive.length && sets.length !== alive.length) continue;
		const want = alive.map(r => r.level).sort().join(','), got = sets.map(m => m.level).sort().join(',');
		if (alive.length && want !== got) continue;
		return 'dataset: ' + H.label(b);
	}
	return false;
}

function battleOf(obs) {
	const name = speciesName(obs.foe.species);
	if (!name) return null;
	const alive = (obs.foeparty || []).filter(r => r && r.maxhp);
	const level = ourLevel(obs);
	// Keyed by everything the answer depends on: who is out, how many they
	// brought, at what levels, and what our own level resolves theirs against.
	const key = name + '|' + level + '|' + alive.map(r => r.level).join(',') + '|' + (obs.foe.moves || []).join(',');
	if (battleCache[key] !== undefined) return battleCache[key];
	// Match FORMS too. RAM reports the base species -- "Manectric" -- while the
	// trainer data lists "Manectric-Mega", so an exact-name lookup returned
	// nothing the moment Surge's last Pokemon came in, and foeSets(null) threw.
	const base = n => String(n || '').split('-')[0];
	// SCORED, not first-match. With the scaling fights included the list is
	// eight times longer and a common species appears in many of them, so the
	// party we can actually see -- how many they brought and at what levels --
	// decides which trainer this is.
	let found = null, bestScore = -1;
	for (const b of battlesFor(level)) {
		const sets = H.foeSets(b) || [];
		const hasIt = sets.some(m => m.species === name)
			|| sets.some(m => base(m.species) === base(name));
		if (!hasIt) continue;
		let score = 1;
		if (alive.length && sets.length === alive.length) score += 3;
		if (alive.length) {
			const want = alive.map(r => r.level).sort().join(',');
			const got = sets.map(m => m.level).sort().join(',');
			if (want === got) score += 5;
			else {
				const pool = sets.map(m => m.level);
				for (const r of alive) {
					const at = pool.indexOf(r.level);
					if (at >= 0) { score += 1; pool.splice(at, 1); }
				}
			}
		}
		if (sets.some(m => m.species === name)) score += 1;
		// THE MOVES WE CAN SEE ARE THE STRONGEST EVIDENCE. RAM shows the active
		// Pokemon's four moves; a candidate whose set for that species shares
		// them is that trainer, and one that shares none is not, whatever the
		// levels say. On 2026-09-04 a Route Flareon (Fire Fang, Fire Spin,
		// Scary Face, Smog, Flash Fire) was matched to Professor Oak's postgame
		// Flareon (Sacred Fire, Last Resort, Wild Charge, Superpower, level
		// 44), and every line was priced against a Pokemon that was not there.
		const ramMoves = (obs.foe.moves || []).map(id => moveName(id)).filter(Boolean);
		const candSet = sets.find(m => m.species === name) || sets.find(m => base(m.species) === base(name));
		if (candSet && ramMoves.length) {
			const shared = (candSet.moves || []).filter(m => ramMoves.includes(m)).length;
			score += 3 * shared;
			if (shared === 0 && (candSet.moves || []).length) score -= 6;
		}
		if (score > bestScore) { bestScore = score; found = b; }
	}
	battleCache[key] = found;
	return found;
}

// KEY, NOT NAME: `name` strips every regional forme and mega. Same collision
// as rr-save.js readRecord, on the live side.
const speciesName = id => (dex.byID[id] && (dex.byID[id].key || dex.byID[id].name)) || null;
const moveName = id => dex.moveName[id] || null;
const abilityName = id => {
	for (const k in dex.dex.abilities) {
		if (dex.dex.abilities[k].ID === id) return dex.dex.abilities[k].names[0];
	}
	return null;
};
const itemName = id => {
	if (!id) return '';
	for (const k in dex.dex.items) {
		if (dex.dex.items[k].ID === id) return dex.dex.items[k].name;
	}
	return '';
};

// Gen 3 packs status into a bitfield. Only the parts that change a decision.
/**
 * Turn one sampled "action/target" pair into the move or switch it names.
 *
 * The pair is meaningless without the opponent's move list, which is why it is
 * resolved here against the moves recorded before the turn rather than printed
 * raw.
 */
function sampleName(res, tag) {
	const s = res.ai_samples && res.ai_samples[tag];
	if (!s || !awaiting) return '';
	const bits = s.split('/');
	const act = parseInt(bits[0], 10), tgt = parseInt(bits[1], 10);
	if (act === 1) return 'switch ' + tgt;
	const mv = awaiting.foeMoves && awaiting.foeMoves[tgt];
	return (mv && moveName(mv)) || ('slot ' + tgt);
}

/**
 * THE TOXIC COUNTER LIVES IN THE SAME WORD, bits 8-11, and it was never read.
 * `statusOf` returned 'tox' and the engine's counter stayed at the 0 that
 * createState gives it, so the end-of-turn tick was maxHP * 0 / 16: a badly
 * poisoned Pokemon took NO poison damage in the model, ever. On 2026-09-03
 * Kilowattrel sat at 9 HP with a 15-point tick coming, the planner priced its
 * death at 0%, and it died to the tick. Read the counter; never below 1.
 */
function toxicTurns(word) {
	if (!(word & 0x80)) return 0;
	return Math.max(1, (word >> 8) & 0xF);
}

function statusOf(word) {
	if (word & 0x07) return 'slp';
	if (word & 0x08) return 'psn';
	if (word & 0x10) return 'brn';
	if (word & 0x20) return 'frz';
	if (word & 0x40) return 'par';
	if (word & 0x80) return 'tox';
	return null;
}

const STAT_ORDER = ['hp', 'atk', 'def', 'spe', 'spa', 'spd', 'acc', 'eva'];

/**
 * Recover a move whose NAME is not enough, from the trainer database.
 *
 * "Hidden Power" is one move ID whose type comes from hidden IVs, so a set
 * rebuilt out of RAM says only "Hidden Power" and the calculator prices it as
 * the default type. Measured cost: Bellibolt's Hidden Power did 48 against a
 * predicted band of 20-24 -- exactly 2.00x, super effective -- and 13 on
 * another turn, about half, resisted. Both are simply the wrong type.
 *
 * The trainer data already knows: it lists Hidden Power Grass for Bellibolt and
 * Hidden Power Ice for Pincurchin. The offline planner reads that file and has
 * always been correct here; only the live reconstruction lost it. So when a
 * species and level match exactly one trainer set, its move names are used to
 * resolve the ambiguous ones.
 */
const trainerSetCache = {};
function trainerSetFor(species, level) {
	const key = species + '|' + level;
	if (trainerSetCache[key] !== undefined) return trainerSetCache[key];
	let found = null, count = 0;
	try {
		for (const seg of engine.TRAINERS.segments) {
			for (const b of (seg.battles || [])) {
				for (const m of (b.team || [])) {
					if (m.species !== species) continue;
					if (m.level && m.level.type === 'fixed' && m.level.value !== level) continue;
					count++;
					if (!found) found = m;
				}
			}
		}
	} catch (e) { /* fall through to null */ }
	trainerSetCache[key] = (count === 1 || (found && count > 1
		&& /Hidden Power/.test((found.moves || []).join(' ')))) ? found : null;
	return trainerSetCache[key];
}

function setFromBattler(b, known) {
	const name = speciesName(b.species);
	if (!name) return null;
	const moves = (b.moves || []).map(moveName).filter(Boolean);
	// Where we already know the real set -- our own Pokemon, read off the save
	// -- keep it, because it carries the nature and spread. For the opponent
	// the observed stats ARE the truth and go in directly.
	const base = known || {
		species: name, level: b.level, nature: 'Serious',
		ability: abilityName(b.ability) || undefined,
		item: itemName(b.item),
		evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
	};
	let resolved = moves;
	if (!known && moves.some(m => m === 'Hidden Power')) {
		const t = trainerSetFor(name, b.level);
		if (t && t.moves) {
			resolved = moves.map(m => m !== 'Hidden Power' ? m
				: (t.moves.find(x => /^Hidden Power/.test(x)) || m));
		}
	}
	const out = Object.assign({}, base, {moves: resolved.length ? resolved : base.moves});
	if (b.stats && b.stats.length === 5) {
		out.rawStats = {atk: b.stats[0], def: b.stats[1], spe: b.stats[2],
			spa: b.stats[3], spd: b.stats[4]};
	}
	return out;
}

/** Rebuild an engine position from what the agent saw in RAM. */
function buildState(obs) {
	const foeSet = setFromBattler(obs.foe, null);
	if (!foeSet) return null;
	const mineName = speciesName(obs.me.species);

	// THE PARTY ORDER COMES FROM RAM, NOT FROM THE SAVE FILE. They are not the
	// same: ss4's party is ordered Lilligant, Diggersby, Lanturn, Breloom,
	// Victreebel, Mienshao while the .sav has Mienshao first. Trusting the file
	// meant "switch to slot 0" named Mienshao in the model and Lilligant -- the
	// Pokemon already on the field -- in the actual game, which cannot be
	// selected, so the agent sat on the party screen until it timed out.
	//
	// Level and max HP together identify a member unambiguously here, and both
	// are outside Gen 3's party encryption, so the order can be read directly
	// rather than assumed.
	// THE ROSTER COMES FROM THE GAME WHEN IT CAN. The battery save only holds
	// what the game last wrote; on 2026-09-02 a fight loaded from a save state
	// was planned with the previous run's Lanturn and Lilligant because the
	// .sav was a run behind. The Lua now ships each party record raw, and this
	// ROM keeps them unencrypted, so they decode with the save reader's own
	// record decoder. The .sav stays as the fallback.
	const roster = teamsFor(obs).party.slice();   // the same object the planner gets
	const ordered = [];
	(obs.party || []).forEach(row => {
		let best = -1;
		for (let i = 0; i < roster.length; i++) {
			if (!roster[i]) continue;
			const probe = B.createState([roster[i]], [{species: 'Rattata', level: 5,
				evs: {}, ivs: {}, moves: ['Tackle']}], {});
			const maxHP = probe.me.team[0].maxHP;
			if (roster[i].level === row.level && maxHP === row.maxhp) { best = i; break; }
		}
		if (best >= 0) { ordered.push(roster[best]); roster[best] = null; }
		else ordered.push(null);
	});
	// Anything unmatched keeps a slot so the indices still line up with the game.
	const leftovers = roster.filter(Boolean);
	const mySets = ordered.map(x => x || leftovers.shift() || party[0]);
	// WHO IS OUT, FIXED BY FINGERPRINT INSIDE ONE SNAPSHOT. This was a species
	// name lookup, and when it missed -- a mega arrives under its base name,
	// and Math.max(0, -1) quietly answers 0 -- the model believed the active
	// was whoever sat in slot 0. The planner then proposed switching to the
	// Pokemon already on the field, which the game simply refuses, and the
	// agent burned the turn on a party screen it could not leave.
	//
	// Level and max HP identify a party member unambiguously, and reading them
	// from the SAME observation that reported the active means the two cannot
	// disagree about a party order that moves during a fight -- the active is
	// swapped into slot 0 when it comes in, seen live as the 98 and the 102
	// trading places between two consecutive reads.
	let activeIndex = (obs.party || []).findIndex(r =>
		r.maxhp === obs.me.maxhp && r.hp === obs.me.hp && r.level === obs.me.level);
	if (activeIndex < 0) {
		activeIndex = (obs.party || []).findIndex(r => r.maxhp === obs.me.maxhp);
	}
	if (activeIndex < 0) {
		activeIndex = Math.max(0, mySets.findIndex(p => p.species === mineName));
	}
	if (mySets[activeIndex]) mySets[activeIndex] = setFromBattler(obs.me, mySets[activeIndex]);
	// THEIR REAL BENCH, read from gEnemyParty at 0x0202402C.
	//
	// It used to be five placeholder clones of whatever was out, because we
	// could not see their party. That single approximation caused three
	// separate problems: the model "predicted" switches to Pokemon that do not
	// exist, every opponent damage band came back empty because the band was
	// computed for a fiction, and switch prediction could never be measured at
	// all. Their party is now visible, so each slot is matched to a real set by
	// level and max HP against the trainer data -- the same way our own side is
	// resolved.
	// THEIR PARTY IS IN TRAINER-DATA ORDER, so slot i is set i. No matching
	// needed, and matching actively broke things: it paired each slot by level
	// and max HP, and our data computes Bellibolt at 133 HP where the game says
	// 125, so Bellibolt matched NOTHING and fell back to cloning whoever was
	// active. Their team came out as Pincurchin, Vikavolt, MANECTRIC 125/102,
	// Pawmot, Manectric-Mega -- Bellibolt gone, one Pokemon holding more HP
	// than its own maximum. The active index then pointed at a clone, the
	// predictor returned nothing, and the planner re-planned the same broken
	// position forever.
	// Built by the shared helper, so the planner context and this state always
	// describe the same team. NEVER HAND createState A NULL TEAM: outside a
	// known trainer battle that used to throw and kill the whole agent process,
	// which looked exactly like the emulator being stuck.
	const foeTeam = teamsFor(obs).foeSets;   // the same object the planner gets
	const st = B.createState(mySets, foeTeam, {});
	// Put THEIR active where it really is, and apply what we can see of them.
	// THEIR ACTIVE, matched on the base name too. A mega arrives as its base
	// form, so RAM says "Manectric" while the set is "Manectric-Mega" -- the
	// exact match returned -1, the active index silently stayed at 0, and we
	// modelled a FAINTED Pincurchin as the Pokemon in front of us. The
	// predictor then returned nothing at all ("they will: none") and the
	// planner was pricing a position that did not exist.
	// MATCHED ON A FINGERPRINT, NOT A NAME. Species alone picks the FIRST slot
	// carrying that name, and a trainer may field two of the same Pokemon: the
	// ss1 fight has two Emolgas, the first one died, and every turn afterwards
	// the planner aimed at the corpse. pricePath opens with "is the target
	// already fainted? then this plan kills it" -- so every candidate priced
	// 0.00 at zero turns, the whole market tied, the tie broke by generation
	// order, and the winner flipped with whoever was standing. Mienshao and
	// Lanturn ping-ponged 98 -> 24 without attacking once and two Pokemon died
	// in a level-27 fight. Same disease as the Volt Switch tie, different door.
	//
	// Our own side has always been fingerprinted (max HP + level); their side
	// was never given the same treatment, and Surge's five distinct species
	// hid it. Rank the candidates: alive beats fainted, then exact HP, then
	// max HP. `obs.foeparty` is the RAM party read, which is what says who is
	// really still standing.
	const rawName = speciesName(obs.foe.species);
	const baseOf = n => String(n || '').split('-')[0];
	const nameHit = (f, exact) => f && (exact ? f.species === rawName
		: baseOf(f.species) === baseOf(rawName));
	const pickFoe = exact => {
		let bestI = -1, bestScore = -1;
		foeTeam.forEach((f, i) => {
			if (!nameHit(f, exact)) return;
			const row = (obs.foeparty || [])[i];
			// No party row for this slot is not evidence of death; an
			// unreadable party must not outrank a slot we can see is alive.
			const alive = !row || !row.maxhp || row.hp > 0;
			const score = (alive ? 4 : 0)
				+ (row && row.maxhp === obs.foe.maxhp && row.hp === obs.foe.hp ? 2 : 0)
				+ (row && row.maxhp === obs.foe.maxhp ? 1 : 0);
			if (score > bestScore) { bestScore = score; bestI = i; }
		});
		return bestI;
	};
	let activeFoe = pickFoe(true);
	if (activeFoe < 0) activeFoe = pickFoe(false);
	if (activeFoe >= 0) st.foe.active = activeFoe;
	(obs.foeparty || []).forEach((row, i) => {
		const m = st.foe.team[i];
		if (!m || !row.maxhp) return;
		m.curHP = row.hp;
		m.fainted = row.hp <= 0;
		m.status = statusOf(row.status); m.toxicCounter = toxicTurns(row.status);
	});
	st.me.active = activeIndex;
	// THE FIELD IS READ, NOT INHERITED. createState fires the entry ability of
	// whoever sits at roster index 0, and for Surge that is Pincurchin with
	// Electric Surge -- so every state the planner has ever built carried
	// Electric Terrain, at a full 8 turns, for the entire fight, long after
	// the real terrain expired and even after Pincurchin was dead. Two
	// consequences, both bad and both invisible: every Electric move (this
	// whole team is Electric) was priced 1.3x too strong, and Sleep Powder was
	// treated as failing against grounded targets, which is the path James
	// says he has taken on file. The timer is now read from RAM; when it is
	// zero the terrain is cleared outright.
	if (obs.terrainTurns !== undefined) {
		st.field.terrainTurns = obs.terrainTurns;
		if (!obs.terrainTurns) st.field.terrain = null;
	}

	// HOW LONG EACH SIDE HAS BEEN OUT, which nothing was telling the engine.
	// B.createState sets turnsOut to 0 for every member, and the live agent
	// rebuilds the state from scratch every turn, so the active always looked
	// like it had JUST ARRIVED. The engine gates Fake Out on turnsOut > 0, so
	// the move never failed and the agent spammed it -- James watched it happen.
	//
	// There is no RAM field for this, but it does not need one: the active
	// changing is the entry, so counting decisions since it last changed is
	// exact. Zero means "first action after coming in", which is when Fake Out
	// works and after which it must fail.
	const meKey = obs.me.maxhp + ':' + obs.me.species;
	// ONCE PER TURN, NOT ONCE PER CALL. buildState runs more than once on a
	// decision (the plan, the veto, the diagnostics), and each call was counting
	// as a turn: the first read saw 0 and the ones that mattered saw 1, so
	// `justEntered` was false by the time policy.js asked, and Fake Out was
	// never offered on a switch-in. James, 2026-09-03: "hitmonlee is still not
	// using fake out... I don't remember how many times I have mentioned the
	// importance of fake out." The Lua tracks turnsOut from the emulator's own
	// switches; where present it is the truth and wins.
	if (outCount.turn !== obs.turn) {
		outCount.turn = obs.turn;
		outCount.me = (meKey === outCount.meKey) ? outCount.me + 1 : 0;
		outCount.meKey = meKey;
	}
	if (typeof obs.turnsOut === 'number') outCount.me = obs.turnsOut;
	const foeKey = obs.foe.maxhp + ':' + obs.foe.species;
	outCount.foe = (foeKey === outCount.foeKey) ? outCount.foe + 1 : 0;
	outCount.foeKey = foeKey;
	if (st.me.team[activeIndex]) st.me.team[activeIndex].turnsOut = outCount.me;
	if (st.foe.team[st.foe.active]) st.foe.team[st.foe.active].turnsOut = outCount.foe;
	// ENTRY, STATED EXPLICITLY. policy.js gates its use-it-or-lose-it entry move
	// on `justEntered`, and nothing in the codebase ever SET it -- the flag was
	// read in one place and written in none, so Fake Out was never once offered
	// on a switch-in. outCount.me is 0 exactly on the first decision after the
	// active changed, which is the turn the move works.
	if (st.me.team[activeIndex] && outCount.me === 0) {
		st.me.team[activeIndex].volatiles.justEntered = true;
	}
	// Carry the protect chain across the rebuild, so a second Detect is priced
	// as the coin flip it really is instead of a free turn.
	if (st.me.team[activeIndex] && protectRun.key === meKey && protectRun.chain > 0) {
		st.me.team[activeIndex].volatiles.protectChain = protectRun.chain;
	}

	// Apply everything observed, so the simulation starts from the real
	// position rather than a fresh one.
	// THE ACTIVE FOE, NOT SLOT ZERO. This read `st.foe.team[0]` while
	// `st.foe.active` was being resolved correctly a few lines above, so every
	// per-turn observation of the opponent -- current HP, status, confusion,
	// PP and STAT STAGES -- was written onto their FIRST Pokemon instead of
	// the one standing in front of us.
	//
	// That is why Lilligant kept clicking Baby-Doll Eyes until it died. The
	// job says "until their attack is at most -1"; the -1 landed on
	// Pincurchin's boost table, Pawmot always read at neutral attack, the
	// handover never fired, and the enabler stood there instead of switching
	// out. James described the symptom exactly: it was supposed to switch out
	// after the Baby-Doll Eyes instead of dying to Mach Punch.
	const me = st.me.team[activeIndex], foe = st.foe.team[st.foe.active];
	me.curHP = obs.me.hp; foe.curHP = obs.foe.hp;
	// THEIR ACTIVE GETS ITS REAL STATS TOO. Ours has carried rawStats from RAM
	// since setFromBattler; theirs came from the sheet's set, and the sheet's
	// Crawdaunt computed to Speed 70 where the game's reads 50. Lanturn at 61
	// is faster, so the second Shock Wave lands before Knock Off and a 1 HP
	// Crawdaunt dies -- but the engine had Crawdaunt moving first, every
	// Lanturn move scored as a death, and the agent stopped to ask who to
	// sacrifice while James played the two Shock Waves himself (2026-09-03).
	if (obs.foe.stats && obs.foe.stats.length === 5) {
		foe.set = Object.assign({}, foe.set, {rawStats: {atk: obs.foe.stats[0],
			def: obs.foe.stats[1], spe: obs.foe.stats[2], spa: obs.foe.stats[3],
			spd: obs.foe.stats[4]}});
		if (obs.foe.maxhp) foe.maxHP = obs.foe.maxhp;
	}
	// A FORCED SWITCH: our Pokemon has fainted and the game is asking who comes
	// in. Setting HP to zero was not enough -- nothing marked it fainted, so
	// moves still looked legal, the planner answered with a move, and the
	// actuator could not play a move on a party screen. It re-asked, got the
	// same move, and cycled: seventeen turns of that in one interval.
	if (obs.me.hp <= 0 || obs.kind === 'forced') {
		me.curHP = 0;
		me.fainted = true;
	}
	me.status = statusOf(obs.me.status); foe.status = statusOf(obs.foe.status);
	me.toxicCounter = toxicTurns(obs.me.status); foe.toxicCounter = toxicTurns(obs.foe.status);
	foe.volatiles.usedMoves = foeUsedMovesFor(obs);
	// CONFUSION, from status2. Without it the model could not see confusion it
	// had itself applied, so Confuse Ray kept looking useful and got spammed
	// into an already-confused target.
	const confusionOf = w => (w || 0) & 0x7;
	if (confusionOf(obs.me.status2)) me.volatiles.confusion = confusionOf(obs.me.status2);
	if (confusionOf(obs.foe.status2)) foe.volatiles.confusion = confusionOf(obs.foe.status2);
	for (let i = 1; i < STAT_ORDER.length; i++) {
		me.boosts[STAT_ORDER[i]] = (obs.me.stages[i] || 6) - 6;
		foe.boosts[STAT_ORDER[i]] = (obs.foe.stages[i] || 6) - 6;
	}
	// BY MOVE NAME, NOT SLOT: the sheet lists a set's moves in its own order,
	// RAM in the game's, and copying by slot handed Roost's PP to Bug Buzz.
	const copyPP = (mon, b) => {
		const ramNames = (b.moves || []).map(id => moveName(id));
		(mon.set.moves || []).forEach((mv, j) => {
			const i = ramNames.indexOf(mv);
			if (i >= 0 && b.pp && b.pp[i] !== undefined) mon.pp[j] = b.pp[i];
		});
	};
	copyPP(me, obs.me); copyPP(foe, obs.foe);
	(obs.party || []).forEach(row => {
		const m = st.me.team[row.slot];
		if (!m || row.slot === activeIndex) return;
		m.curHP = row.hp;
		m.fainted = row.hp <= 0;
		m.status = statusOf(row.status); m.toxicCounter = toxicTurns(row.status);
	});
	return st;
}

/**
 * What the opponent will do -- read from RAM, or modelled, whichever is trusted.
 *
 * THE DECISION BYTE DOES NOT GENERALISE. It was validated 32/32, but every one
 * of those labels came from Surge-side states, and this is the cross-fight
 * check that never happened. On the Lokix fight it reads "SWITCH 3" on turn
 * after turn across completely different positions -- an unchanging value is
 * not a decision, it is a leftover -- and both logged rows where it predicted a
 * switch, the opponent actually used Knock Off.
 *
 * So it is no longer trusted blindly. A reading that repeats across a changed
 * position is treated as stale, and the ported AI model answers instead. Both
 * are recorded either way, so the log measures which is right rather than
 * assuming.
 */
let lastByte = null, byteRepeats = 0;
const byteHistory = [];   // was each recent reading a switch?

function modelAction(st) {
	try {
		const scored = RRAI.scoreAll(st, 'foe', AI_FLAGS, {});
		// MOVES ONLY. Their bench is five placeholder clones of whatever is
		// out, because we cannot see their real party -- so letting the model
		// "switch" is letting it choose a Pokemon that does not exist. It was
		// doing exactly that: every opponent-side damage band came back empty,
		// costing eight usable roll observations, and a fictional switch is
		// also a prediction that can never be right.
		const moves = scored.filter(e => e.action.type === 'move');
		if (!moves.length) {
			// WHY there is no prediction, not just that there is none. Against
			// Pawmot the live agent reports "they will: none" and then plans
			// while expecting to take 0, which is how Lilligant walks into Mach
			// Punch and Mienshao is fed in behind it -- while the same call
			// offline answers Thunder Punch. Silence here is what let that run
			// for hundreds of turns.
			const foe = st.foe.team[st.foe.active];
			console.log('  [no prediction for ' + (foe && foe.set.species)
				+ ': ' + scored.length + ' actions scored, types '
				+ JSON.stringify(scored.map(e => e.action.type))
				+ ', its moves ' + JSON.stringify(foe && foe.set.moves)
				+ ', pp ' + JSON.stringify(foe && foe.pp) + ']');
			return null;
		}
		let best = -Infinity;
		moves.forEach(e => { if (e.score > best) best = e.score; });
		// TIES BREAK ON DAMAGE. Our scores are coarser than the real AI's, so
		// several moves land on the same number and the first in move order was
		// taken. Against a Victreebel at 29 HP, Thunder Punch and Ice Punch
		// both score 109 because both KO, and we answered Thunder Punch every
		// time while the game used Ice Punch -- the move that does 80 rather
		// than 39 into a Grass type. Predicting the weaker of two lethal moves
		// makes us plan around the wrong damage, so among equals, take the one
		// that hits hardest.
		const tied = moves.filter(e => e.score === best);
		if (tied.length === 1) return tied[0].action;
		let pick = tied[0], pickDmg = -1;
		for (const e of tied) {
			let d = 0;
			try {
				const r = B.damageRolls(st, 'foe', e.action.move);
				if (r && !r.immune) d = r.noCrit[Math.floor(r.noCrit.length / 2)];   // lump, hits included
			} catch (err) { d = 0; }
			if (d > pickDmg) { pickDmg = d; pick = e; }
		}
		return pick.action;
	} catch (e) { return null; }
}

function byteAction(obs) {
	if (obs.ai_action === 1) return {type: 'switch', index: obs.ai_target};
	const mv = moveName(obs.foe.moves[obs.ai_target]);
	if (!mv) return null;
	return {type: 'move', index: obs.ai_target, move: mv};
}

function foeAction(st, obs) {
	const sig = obs.ai_action + ':' + obs.ai_target;
	if (sig === lastByte) byteRepeats++; else { byteRepeats = 0; lastByte = sig; }
	byteHistory.push(obs.ai_action === 1);
	if (byteHistory.length > 8) byteHistory.shift();
	const fromByte = byteAction(obs);
	const fromModel = modelAction(st);
	// Two independent staleness tests, because the first one alone missed it.
	// Identical readings across changed positions is the obvious case. The one
	// that actually caught this fight is the RATE: the byte claimed a switch on
	// every single turn -- switch 2, switch 3, switch 2, switch 2 -- and no AI
	// switches every turn. A side that is always switching is a byte that is
	// not being written, whatever numbers it happens to contain.
	const switchRate = byteHistory.filter(Boolean).length / byteHistory.length;
	const alwaysSwitching = byteHistory.length >= 4 && switchRate > 0.6;
	const stale = byteRepeats >= 3 || alwaysSwitching;
	return {
		chosen: (stale || !fromByte) ? fromModel : fromByte,
		byte: fromByte, model: fromModel, stale: stale
	};
}

// The battle generator, solved: mul 0x41C64E6D, add 12345.
function advance(v) { return (Math.imul(v, 0x41C64E6D) + 12345) >>> 0; }
function draws(seed, n) {
	const out = [];
	let v = seed >>> 0;
	for (let i = 0; i < n; i++) { v = advance(v); out.push(v); }
	return out;
}

/**
 * The same deliberately-naive policy the simulation baseline uses.
 *
 * Set GREEDY=1 to play it live. The point is a like-for-like comparison: in
 * simulation this policy kills 2 of Surge's 5 in 11 of 20 episodes, 3 in seven,
 * 4 in two, and never wins. If the REAL fight yields more kills from identical
 * play, the simulated opponent is too hard and every planner number in this
 * repo is measuring the wrong fight. If it yields the same, the environment is
 * fine and our players simply are not good enough.
 *
 * It must be the same policy, not a better one, or the comparison says nothing.
 */
function greedyAction(st) {
	const legal = B.legalActions(st, 'me').filter(a => a.type === 'move');
	let best = null, bestValue = -1;
	legal.forEach(a => {
		const r = B.damageRolls(st, 'me', a.move);
		const d = r && !r.immune ? r.noCrit[8] : 0;   // lump, hits included
		if (d > bestValue) { bestValue = d; best = a; }
	});
	return best || B.legalActions(st, 'me')[0];
}

// The plan currently being followed, kept across turns -- see the note on
// sticking to a plan in replan.js.
//
// `progress` is HOW FAR THROUGH that plan we are: which leg, and which move
// inside the leg. It lives here because this is the only place that knows a
// turn actually happened; replan.js creates it, advances it once per decision
// and hands it back. Without it every decision started the plan again from its
// first move, so a two-move leg played move 0 forever and a `until: {uses: n}`
// handover could never fire. See the long note at `progressFor` in replan.js.
let lastPlan = {foe: null, jobs: null, progress: null};

// Decisions since each active last changed -- see buildState.
const outCount = {me: 0, meKey: null, foe: 0, foeKey: null};
/**
 * WHAT EACH OF THEIRS HAS USED THIS FIGHT, for Last Resort. Rebuilt from RAM
 * every turn, the state cannot remember; this can. Two sources: the move they
 * COMMITTED to last turn (the AI byte), credited once the next observation
 * arrives, and any move whose PP is below the dex's base PP. Reset whenever the
 * opposing party's signature changes, which is a new trainer.
 */
const foeUsed = {fight: null, byKey: {}, pending: {}};
function foeUsedMovesFor(obs) {
	const fight = (obs.foeparty || []).map(r => r && r.maxhp || 0).join(',');
	if (fight !== foeUsed.fight) { foeUsed.fight = fight; foeUsed.byKey = {}; foeUsed.pending = {}; }
	const key = obs.foe.maxhp + ':' + obs.foe.species;
	const used = foeUsed.byKey[key] || (foeUsed.byKey[key] = {});
	if (foeUsed.pending[key]) { used[foeUsed.pending[key]] = true; foeUsed.pending[key] = null; }
	(obs.foe.moves || []).forEach((id, i) => {
		const name = moveName(id);
		const rec = dex.dex.moves[id];
		if (name && rec && rec.pp && obs.foe.pp && obs.foe.pp[i] < rec.pp) used[name] = true;
	});
	if (obs.ai_action === 0 && obs.foe.moves && obs.foe.moves[obs.ai_target]) {
		foeUsed.pending[key] = moveName(obs.foe.moves[obs.ai_target]);
	}
	return Object.assign({}, used);
}

// PROTECT DOES NOT WORK TWICE RUNNING, and a rebuilt state cannot remember
// that. The engine models it (`protectChain`), but createState zeroes every
// volatile and the agent rebuilds from RAM each turn, so live it always
// believed Detect was about to succeed -- and spammed it: Mienshao stood in
// front of a Pawmot on 22 HP playing Detect on repeat while Drain Punch healed
// it back up. Exactly the shape of the turnsOut bug, and fixed the same way:
// remember what we actually played, keyed to who was out.
const protectRun = {key: null, chain: 0};
const PROTECT_MOVES = {'Protect': 1, 'Detect': 1, 'Spiky Shield': 1, 'Baneful Bunker': 1,
	'King\'s Shield': 1, 'Obstruct': 1, 'Silk Trap': 1, 'Burning Bulwark': 1};

/**
 * HOW MUCH RISK THIS POSITION CAN AFFORD. James, 2026-09-02: "that type of crit
 * risk is fine in actual hard battles, but I don't want to lose my greninja
 * sometime later because every fight we are putting it at crit risk... the plan
 * should be choosing the best path that has the least risk."
 *
 * The death check has always asked "does this kill me on their MEDIAN roll",
 * with no crit at all, so a Pokemon standing in one-crit range read as perfectly
 * safe. That is why a 15 HP Froakie stayed in front of a Low Sweep that crits
 * for roughly double while five healthy Pokemon sat on the bench.
 *
 * The first version keyed this off a body count, which James rejected: "that
 * shouldn't be a rule. You should classify match difficulty according to the
 * level of difficulty of the opponent team." So it is read from their team, in
 * lib/difficulty.js, off the duel table this project already builds. Living
 * Pokemon only, on both sides, so no separate rule about our own numbers is
 * needed: down to one Pokemon nothing can have two answers and the fight can
 * never classify as easy, which is exactly when risk has to be taken.
 *
 * IF THIS BACKFIRES, THIS IS THE PLACE. The failure mode to watch for is
 * excessive switching in easy fights: every switch is a free turn for them, and
 * a pessimistic death reading makes staying in look worse than it is. Turn it
 * off with RR_CAREFUL=off. Documented in docs/ASSUMPTIONS.md.
 */
const DIFFICULTY = require('./lib/difficulty.js');
function deathReadFor(st) {
	if (process.env.RR_CAREFUL === 'off') return {risks: {roll: 'median'}, tier: null};
	let r = null;
	try { r = DIFFICULTY.classify(engine, st); } catch (e) { r = null; }
	if (!r) return {risks: {roll: 'median'}, tier: null};
	return {risks: DIFFICULTY.deathRisksFor(r.tier), tier: r.tier, worst: r.worst};
}


/**
 * THEY ARE LEAVING, SO HIT WHOEVER IS COMING IN. When the AI byte says the
 * opponent is switching, our move lands on the replacement, and a plan built
 * against the Pokemon that is walking off the field is fiction for this turn.
 * Turn 304, 2026-09-03: Floatzel on 15 HP committed to switching to Starmie;
 * every move of Granbull's kills a 15 HP Floatzel, so the plan took the first
 * in its list -- Fire Fang, into a Water/Psychic -- while the one-turn scorer
 * had Thunder Fang, super effective on both, at the top. James: "why has the
 * granbull played fire fang in a water gym". Among our moves, take the one
 * that does most to the incoming Pokemon; a planned switch is left alone.
 */
function aimAtIncoming(st, theirs, chosen) {
	if (!theirs || theirs.type !== 'switch' || !chosen || chosen.type !== 'move') return chosen;
	if (theirs.index === st.foe.active) return chosen;
	const incoming = st.foe.team[theirs.index];
	if (!incoming || incoming.fainted) return chosen;
	const probe = B.clone(st);
	probe.foe.active = theirs.index;
	let best = null, bestDmg = -1, chosenDmg = 0;
	for (const a of B.legalActions(st, 'me')) {
		if (a.type !== 'move') continue;
		let r = null;
		try { r = B.damageRolls(probe, 'me', a.move); } catch (e) { r = null; }
		const band = r && r.noCrit && r.noCrit.length ? r.noCrit : [0];
		const dmg = r && r.immune ? 0 : band[Math.floor(band.length / 2)];
		if (a.move === chosen.move) chosenDmg = dmg;
		if (dmg > bestDmg) { bestDmg = dmg; best = a; }
	}
	if (best && best.move !== chosen.move && bestDmg > chosenDmg) {
		console.log('  [they are switching to ' + incoming.set.species + '; '
			+ chosen.move + ' does ' + chosenDmg + ' to it, ' + best.move + ' does '
			+ bestDmg + ' -- playing ' + best.move + ']');
		return best;
	}
	return chosen;
}

function decide(st, obs) {
	const src = foeAction(st, obs);
	const theirs = src.chosen;
	const legal = B.legalActions(st, 'me');
	const rows = [];
	// WHEN THEY SWITCH, WE ARE NOT HITTING WHO WE CAN SEE. Only their active
	// Pokemon is modelled -- their bench is genuinely unknown to us -- so a
	// committed switch cannot be simulated properly, and simulating it as a
	// no-op is worse than not simulating it: the first live turn had them
	// switching a 25 HP Voltorb out, and all three of our attacks scored a
	// KILL on a Pokemon that was leaving. Our move will land on whatever comes
	// in instead, and nothing here knows what that is, so no kill is claimed
	// and the damage number is a proxy rather than a prediction.
	const theySwitch = theirs && theirs.type === 'switch';
	// Judged once per turn, so every action in this market is priced on the
	// same risk appetite.
	const read = deathReadFor(st);
	const deathRisks = read.risks;
	// Announced when it CHANGES, not every call: decide() runs more than once
	// on some turns and three identical lines per turn is noise.
	const stamp = read.tier + '/' + read.worst;
	if (read.tier && deathReadFor.said !== stamp) {
		deathReadFor.said = stamp;
		console.log('  [fight reads ' + read.tier.toUpperCase()
			+ ' (their weakest link has ' + read.worst + ' clean answers); death judged on '
			+ (deathRisks.crit ? 'their top roll AND a crit'
				: (deathRisks.foeRoll === 'max' ? 'their top roll' : 'their median roll')) + ']');
	}
	for (const a of legal) {
		if (!theirs) break;
		let out;
		try {
			out = B.step(st, a, theirs, {mode: 'maxroll', risks: deathRisks});
		} catch (e) {
			// Swallowing this silently is how every move on a Pokemon vanished
			// from the options while the switches stayed: the planner reported
			// four switches at 0.0 and no moves at all, and nothing said why.
			if (!decide.warned) { decide.warned = {}; }
			const key = (a.move || ('switch ' + a.index)) + ': ' + e.message;
			if (!decide.warned[key]) {
				decide.warned[key] = true;
				console.log('  [dropped ' + (a.move || ('switch ' + a.index))
					+ ' -- ' + e.message + ']');
			}
			continue;
		}
		if (!out || !out.length) continue;
		const after = out[0].state;
		const myIdx = st.me.active;
		// Measured across the WHOLE side, not against the Pokemon that was
		// standing there when the turn began. On a switch turn our move lands
		// on whoever comes in, so damage read against the departing Pokemon is
		// always zero -- which made every action score identically and the
		// choice arbitrary, Detect included. Summing the side covers both the
		// stay case and the switch case without special-casing either.
		const sideLoss = (before, now) => {
			let lost = 0, cap = 0;
			for (let i = 0; i < before.team.length; i++) {
				lost += Math.max(0, before.team[i].curHP - now.team[i].curHP);
				cap += before.team[i].maxHP;
			}
			return cap ? lost / (before.team[0].maxHP || cap) : 0;
		};
		const foeDead = after.foe.team[st.foe.active].fainted;
		// OUR loss is measured across the side too, for exactly the reason
		// theirs is. Reading it against the Pokemon that started the turn made
		// SWITCHING FREE: that Pokemon is safely on the bench afterwards and
		// perfectly healthy, while the hit lands on whoever came in and never
		// appears in the score. Every switch scored 0.00, every attack scored
		// negative, and the agent switched fourteen turns in a row.
		const mineDead = after.me.team.some((m, i) =>
			m.fainted && !st.me.team[i].fainted);
		const theirLoss = sideLoss(st.foe, after.foe);
		const myLoss = sideLoss(st.me, after.me);
		const credited = foeDead && !theySwitch;

		// WHICH Pokemon died, not merely that one did. The cap on this fight is
		// exact -- beat Surge losing nobody but Lilligant -- and a flat penalty
		// says spending Mienshao is the same as spending the one Pokemon that
		// is allowed to go. The first recorded win cost three: Mienshao,
		// Lanturn and Lilligant.
		const expendable = process.env.EXPENDABLE === undefined
			? ['Lilligant'] : process.env.EXPENDABLE.split(',').filter(Boolean);
		const diedNow = after.me.team.filter((m, i) =>
			m.fainted && !st.me.team[i].fainted);
		const lostSomeoneNeeded = diedNow.some(m => !expendable.includes(m.set.species));

		// AND WHETHER WE ARE LEFT IN RANGE. Scoring only this turn means the
		// death simply happens on the next one: an action that survives at 8 HP
		// scores as a survival. Their best answer against whatever we leave
		// standing is one more evaluation, and it is the difference between
		// trading a Pokemon and keeping it.
		let dyingNext = false;
		const mineAfter = after.me.team[after.me.active];
		if (mineAfter && !mineAfter.fainted && !expendable.includes(mineAfter.set.species)) {
			let worst = 0;
			for (const id of (obs.foe.moves || [])) {
				const nm = moveName(id);
				if (!nm) continue;
				try {
					const band = B.damageRolls(after, 'foe', nm);
					if (band && band.length) worst = Math.max(worst, band[Math.floor(band.length / 2)]);
				} catch (e) { /* a move we cannot price tells us nothing */ }
			}
			dyingNext = worst >= mineAfter.curHP;
		}

		rows.push({
			action: a,
			// A SWITCH IS NOT FREE HERE EITHER. The planner was taught this and
			// the fallback was not, so on every "no plan found" turn the agent
			// rotated Pokemon into Pawmot instead of hitting it -- Lanturn,
			// Victreebel, Mienshao, Diggersby, Breloom, back to Mienshao --
			// while Pawmot healed with Drain Punch: 58, 65, 43, 56, 71. Nothing
			// in a one-turn score charges for making no progress, so a switch
			// that leaves the opponent untouched scored as a clean zero and
			// beat every attack that cost us HP.
			//
			// Small on purpose: it must not block the switches that matter,
			// where staying is scored at -61 because the Pokemon dies.
			score: (credited ? 100 : 0)
				- (mineDead ? (lostSomeoneNeeded ? 200 : 60) : 0)
				- (dyingNext ? 45 : 0)
				- (a.type === 'switch' ? 2.5 : 0)
				+ theirLoss * (theySwitch ? 4 : 10) - myLoss * 8,
			foeDead: credited, mineDead, theirLoss, myLoss,
			lostSomeoneNeeded, dyingNext,
			unknownTarget: theySwitch
		});
	}
	rows.sort((x, y) => y.score - x.score);
	// Voluntary switching is ENABLED again. It was disabled for most of the
	// night because the Shift confirmation never took, and that turned out to
	// be three separate errors in the actuator rather than anything about the
	// decision: the party screen lists the ACTIVE Pokemon first so a party
	// index is not a screen position, SCREEN_ID 9 is not the submenu, and the
	// navigation presses were landing while the screen was still fading in.
	// All three were found by screenshotting the emulator, and switching has
	// committed twenty times since.
	//
	// This matters beyond the feature: every simulation result measured while
	// it was off was measuring a crippled agent, and should not be quoted.
	return {best: rows[0], all: rows, theirs, src};
}

// A one-shot probe, so a bad position can be reproduced offline instead of
// reasoned about from a log. `node tools/agent.js --probe` rebuilds whatever is
// in state.json and prints what the planner sees.
if (process.argv[2] === '--probe') {
	// An explicit path replays an ARCHIVED turn (~/rr-agent/turns/turnNNNNN.json,
	// whose obs field is the observation); with no path it reads the live state.
	const arg = process.argv[3];
	let obs = readJSONSync(arg || STATE);
	if (obs && obs.obs) obs = obs.obs;
	if (!obs) { console.log('no state.json'); process.exit(1); }
	console.log('WILD? ' + (isWild(obs) ? 'YES -- would stand down' : 'no -- trainer')
		+ '   DOUBLES? ' + (isDoubles(obs) ? 'YES (' + isDoubles(obs) + ') -- would stand down' : 'no'));
	const st = buildState(obs);
	if (!st) { console.log('buildState returned null'); process.exit(1); }
	// TURNSOUT COMES FROM THE ARCHIVED TURN, not from a fresh rebuild. Without
	// this the probe reported entry-only moves (Fake Out, First Impression) as
	// legal on positions where the live agent had been out for several turns
	// and they were not, which is enough to make the probe recommend a move the
	// agent could never have played.
	if (obs.turnsOut !== undefined && st.me.team[st.me.active]) {
		st.me.team[st.me.active].turnsOut = obs.turnsOut;
		// The volatile has to follow, or the probe offers Fake Out on a
		// Pokemon that has been out for eight turns -- which it did, and the
		// live agent had (correctly) played Rock Tomb, so the probe was
		// contradicting reality on the exact position it was asked to explain.
		st.me.team[st.me.active].volatiles.justEntered = (obs.turnsOut || 0) === 0;
	}
	if (obs.foeTurnsOut !== undefined && st.foe.team[st.foe.active]) {
		st.foe.team[st.foe.active].turnsOut = obs.foeTurnsOut;
	}
	// RR_PROBE_DIFFICULTY=1 prints the fight's difficulty table for this
	// position -- the duel answers their team has, which is what the risk
	// appetite is read from. Offline, on the real sets, not hand-built ones.
	if (process.env.RR_PROBE_DIFFICULTY) {
		const DF = require('./lib/difficulty.js');
		const r = DF.classify(engine, st);
		console.log('DIFFICULTY: ' + r.tier + '  (fewest clean answers: ' + r.worst + ')');
		r.answers.forEach(a => console.log('   ' + a.foe.padEnd(14)
			+ a.clean.length + '  ' + (a.clean.join(', ') || '(none)')));
		console.log('   death read: ' + JSON.stringify(DF.deathRisksFor(r.tier)));
		if (process.env.RR_PROBE_DIFFICULTY === 'gen') {
			// WHY DOES THE GENERATOR OFFER SO LITTLE? Runs the same call the
			// planner makes, in the same live position, and reports what each
			// of ours produced.
			const C = require('./lib/candidates.js');
			const D2 = require('./lib/duels.js');
			const pctx2 = planCtx(obs);
			const ourHp = {}, ourStatus = {};
			st.me.team.forEach(m => {
				ourHp[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP;
				if (m.status && !m.fainted) ourStatus[m.set.species] = m.status;
			});
			const fi2 = st.foe.active;
			const foeMon2 = st.foe.team[fi2];
			const opts2 = {field: st.field,
				foeHp: foeMon2 && foeMon2.maxHP ? foeMon2.curHP / foeMon2.maxHP : undefined,
				ourHp, ourStatus};
			console.log('GENERATOR against ' + foeMon2.set.species
				+ ' (' + foeMon2.curHP + '/' + foeMon2.maxHP + ')');
			console.log('  ourHp passed: ' + JSON.stringify(ourHp));
			const ideas2 = C.candidatesFor(pctx2, fi2, opts2) || [];
			console.log('  candidates: ' + ideas2.length);
			ideas2.filter(i => /steals a turn|takes the hit|absorbs/.test(i.why)).slice(0, 8)
				.forEach(i => console.log('    [purpose] ' + i.why + '  <- ' + i.jobs.map(j => j.mon + ':' + (j.moves || []).join('>')).join(' | ')));
			ideas2.slice(0, 12).forEach(i => console.log('    ' + i.why
				+ '  <- ' + i.jobs.map(j => j.mon + ':' + (j.moves || []).join('>')).join(' | ')));
			{
				const meA = st.me.team[st.me.active], foeA = st.foe.team[st.foe.active];
				console.log('  SPEED: ours ' + B.finalSpeed(st, 'me') + ' (rawStats ' + JSON.stringify(meA.set.rawStats || null)
					+ ') vs theirs ' + B.finalSpeed(st, 'foe') + ' (rawStats ' + JSON.stringify(foeA.set.rawStats || null) + ')');
				if (process.env.RR_PROBE_DMG) {
					console.log('  FIELD ' + JSON.stringify(st.field) + ' foe status ' + (foeA.status || '-') + ' ability ' + foeA.set.ability + ' item ' + foeA.set.item);
					// Damage table: every move of ours vs their active, and their
					// active's moves vs each of ours. Ranges are the 16 no-crit rolls.
					const rng = r => (!r || r.immune) ? 'immune' : (r.noCrit && r.noCrit.length
						? r.noCrit[0] + '-' + r.noCrit[r.noCrit.length - 1] : '?');
					st.me.team.forEach((m, mi) => {
						if (m.fainted) return;
						const pr = B.clone(st); pr.me.active = mi;
						const ours = (m.set.moves || []).map(mv => {
							let r = null; try { r = B.damageRolls(pr, 'me', mv); } catch (e) { r = null; }
							return mv + ' ' + rng(r);
						});
						const theirs = (foeA.set.moves || []).map(mv => {
							let r = null; try { r = B.damageRolls(pr, 'foe', mv); } catch (e) { r = null; }
							return mv + ' ' + rng(r);
						});
						console.log('  DMG ' + m.set.species + ' (' + m.curHP + '/' + m.maxHP + ') -> ' + foeA.set.species
							+ ': ' + ours.join(', ') + '   | takes: ' + theirs.join(', '));
					});
				}
			}
			console.log('  bestDamage inputs for the active vs theirs (median noCrit x hits):');
			for (const a of B.legalActions(st, 'me')) {
				if (a.type !== 'move') continue;
				let r2 = null; try { r2 = B.damageRolls(st, 'me', a.move); } catch (err) { r2 = 'threw ' + err.message; }
				if (typeof r2 === 'string' || !r2) { console.log('    ' + a.move.padEnd(14) + r2); continue; }
				const band = r2.noCrit || []; const med = band.length ? band[Math.floor(band.length / 2)] : 0;
				console.log('    ' + a.move.padEnd(14) + 'median ' + med + '  hits ' + (r2.hits || 1)
					+ '  immune ' + !!r2.immune + '  -> bestDamage sees ' + med + ' (band is the whole move)');
			}
			if (process.env.RR_PROBE_DUEL) {
				let miA = st.me.active; const fiA = st.foe.active;
				// RR_PROBE_DUEL_MON=<species> dumps the lines for a BENCH member.
				if (process.env.RR_PROBE_DUEL_MON) {
					const want = pctx2.party.findIndex(pp => pp.species === process.env.RR_PROBE_DUEL_MON);
					if (want >= 0) miA = want;
				}
				const foeA = st.foe.team[fiA];
				const condA = {hpFrac: ourHp[pctx2.party[miA].species],
					foeChip: foeA && foeA.maxHP ? 1 - foeA.curHP / foeA.maxHP : 0};
				let lines = [];
				try { lines = D2.duelLines(engine, pctx2.party, pctx2.foeSets, miA, fiA, condA, {}) || []; } catch (e) { console.log('  duelLines threw ' + e.message); }
				console.log('  ALL DUEL LINES for ' + pctx2.party[miA].species + ' vs ' + pctx2.foeSets[fiA].species + ' (' + lines.length + ')'
					+ '  their set moves ' + JSON.stringify(pctx2.foeSets[fiA].moves) + ' pp ' + JSON.stringify(pctx2.foeSets[fiA].pp || null) + ':');
				if (lines[0] && lines[0].log) console.log('    top line, turn by turn: ' + JSON.stringify(lines[0].log).slice(0, 700));
				lines.forEach(l => console.log('    ' + (l.moves || []).join('>').padEnd(24) + l.outcome.padEnd(6)
					+ ' cost ' + (100 * l.cost).toFixed(0) + '%  chip ' + (100 * (l.chip || 0)).toFixed(0)
					+ '%  death ' + (100 * (l.deathRisk || 0)).toFixed(0) + '%  turns ' + l.turns
					+ '  foeStatus ' + (l.foeStatus || '-') + '  theirBoosts ' + JSON.stringify(l.theirBoosts || {})));
			}
			console.log('  SOLO DUELS in this live condition:');
			pctx2.party.forEach((pmon, mi) => {
				const hp = ourHp[pmon.species];
				const cond = {hpFrac: hp};
				let l = null;
				try { l = (D2.duelLines(engine, pctx2.party, pctx2.foeSets, mi, fi2, cond, {}) || [])[0]; }
				catch (e) { l = 'threw: ' + e.message; }
				console.log('    ' + pmon.species.padEnd(11) + 'hp ' + (hp === undefined ? '?' : hp.toFixed(2))
					+ '  ' + (typeof l === 'string' ? l
						: (l ? l.outcome + ' cost ' + (l.cost * 100).toFixed(0) + '% turns ' + l.turns
							+ ' moves ' + (l.moves || []).join('>') : 'no line')));
			});
		}
		if (process.env.RR_PROBE_DIFFICULTY === 'full') {
			const D = require('./lib/duels.js');
			const pty = st.me.team.map(m => m.set), fs2 = st.foe.team.map(m => m.set);
			for (let fi = 0; fi < fs2.length; fi++) {
				if (st.foe.team[fi].fainted) continue;
				console.log('   == ' + fs2[fi].species);
				for (let mi = 0; mi < pty.length; mi++) {
					if (st.me.team[mi].fainted) continue;
					let l = null;
					try { l = (D.duelLines(engine, pty, fs2, mi, fi, {}, {}) || [])[0]; } catch (e) { l = null; }
					console.log('      ' + pty[mi].species.padEnd(11)
						+ (l ? l.outcome.padEnd(6) + ' cost ' + (l.cost * 100).toFixed(0)
							+ '%  death ' + ((l.deathRisk || 0) * 100).toFixed(0)
							+ '%  turns ' + l.turns : 'no line'));
				}
			}
		}
	}
	// RR_PROBE_PROTECT=n reproduces a live protect chain, which the archive
	// does not record: it is counted by the running agent, so a probe always
	// rebuilds the position as though Detect were fresh.
	if (process.env.RR_PROBE_PROTECT && st.me.team[st.me.active]) {
		st.me.team[st.me.active].volatiles.protectChain =
			Number(process.env.RR_PROBE_PROTECT);
	}
	const act = st.me.team[st.me.active];
	console.log('active index ' + st.me.active + ' = ' + act.set.species
		+ '  turnsOut ' + act.turnsOut
		+ '  hp ' + act.curHP + '/' + act.maxHP + '  fainted=' + act.fainted);
	console.log('its moves: ' + JSON.stringify(act.set.moves) + '  pp ' + JSON.stringify(act.pp));
	// STATUS IS PART OF THE POSITION. A paralysed Mienshao is a different
	// Pokemon from a healthy one -- half speed and a quarter of its turns lost
	// -- and a probe that hides it invites exactly the plan James caught:
	// "Mienshao kills it" priced off a Mienshao that could not move.
	console.log('team: ' + st.me.team.map((m, i) =>
		i + ':' + m.set.species + (m.fainted ? '(X)' : '') + ' ' + m.curHP
		+ (m.status ? '[' + m.status + ']' : '')).join('  '));
	console.log('THEIR team: ' + st.foe.team.map((m, i) =>
		(i === st.foe.active ? '>' : ' ') + i + ':' + m.set.species
		+ (m.fainted ? '(X)' : ' ' + m.curHP + '/' + m.maxHP)).join('  '));
	console.log('legal actions: ' + JSON.stringify(B.legalActions(st, 'me')));
	console.log('FIELD: terrain=' + (st.field.terrain || 'none')
		+ ' turns=' + (st.field.terrainTurns || 0)
		+ '  weather=' + (st.field.weather || 'none'));
	// Trip the staleness detector the way a running session does, so the probe
	// exercises the MODEL path and not just the byte path.
	let d = decide(st, obs);
	for (let i = 0; i < 6; i++) d = decide(st, obs);
	console.log('foe action used: ' + JSON.stringify(d.theirs)
		+ '  (stale=' + d.src.stale + ')');
	console.log('ranked: ' + JSON.stringify(d.all.map(r =>
		(r.action.move || ('switch ' + r.action.index)) + '=' + r.score.toFixed(2))));

	// WHY THE PLANNER SAID NOTHING. "no plan found" was the single most common
	// line in the log on the hardest positions, and the log never said which of
	// the several ways to produce it had happened.
	const C = require('./lib/candidates.js');
	const {pricePath} = require('./lib/paths.js');
	const pctx = planCtx(obs);
	assertSameTeams(st, pctx, 'plan');
	const fi = st.foe.active;
	const fld = {terrain: st.field.terrain, terrainTurns: st.field.terrainTurns};
	let ideas = [];
	// FAITHFUL TO THE LIVE CALL: the live generator sees their current HP and
	// ours; without these the probe priced kills against a full-HP opponent
	// and told a different story from the one the agent actually saw.
	const probeOurHp = {}, probeOurStatus = {};
	st.me.team.forEach(m => { probeOurHp[m.set.species] = m.fainted ? 0 : m.curHP / m.maxHP; if (m.status && !m.fainted) probeOurStatus[m.set.species] = m.status; });
	const probeFoe = st.foe.team[fi];
	try { ideas = C.candidatesFor(pctx, fi, {field: fld,
		foeHp: probeFoe && probeFoe.maxHP ? probeFoe.curHP / probeFoe.maxHP : undefined,
		ourHp: probeOurHp, ourStatus: probeOurStatus}); }
	catch (e) { console.log('candidatesFor THREW: ' + e.message); }
	console.log('\ncandidates generated: ' + ideas.length);
	const hp = {}, dead = [], foeDead = [];
	st.me.team.forEach(m => { hp[m.set.species] = m.curHP / m.maxHP; if (m.fainted) dead.push(m.set.species); });
	st.foe.team.forEach((m, i) => { if (m.fainted) foeDead.push(i); });
	const entry = {hp, dead, foeDead, field: fld,
		foeChip: probeFoe && probeFoe.maxHP ? 1 - probeFoe.curHP / probeFoe.maxHP : 0,
		active: st.me.team[st.me.active].set.species,
		turnsOut: st.me.team[st.me.active].turnsOut};
	const tally = {};
	ideas.slice(0, 25).forEach(cand => {
		if (!cand.jobs.length) { tally['empty jobs'] = (tally['empty jobs'] || 0) + 1; return; }
		if (cand.jobs.every(j => dead.includes(j.mon))) { tally['all its mons dead'] = (tally['all its mons dead'] || 0) + 1; return; }
		let r;
		try { r = pricePath(pctx, fi, cand.jobs, entry, {expendable: pctx.expendable || []}); }
		catch (e) { tally['pricePath threw: ' + e.message] = (tally['pricePath threw: ' + e.message] || 0) + 1; return; }
		const k = r.kills ? 'KILLS'
			: ('outcome=' + r.outcome + (r.outcome === 'stuck'
				? (r.blockedEntries ? ' (entry blocked: switch-in would die)'
					: ' (planAction returned nothing)') : ''));
		tally[k] = (tally[k] || 0) + 1;
	});
	if (process.env.RR_PROBE_LINES) {
		console.log('top candidates, priced from HERE:');
		const matchRe = process.env.RR_PROBE_LINES_MATCH ? new RegExp(process.env.RR_PROBE_LINES_MATCH) : null;
		(matchRe ? ideas.filter(c => matchRe.test(c.why)) : ideas).slice(0, Number(process.env.RR_PROBE_LINES) || 10).forEach((cand, i) => {
			let r = null;
			try { r = pricePath(pctx, fi, cand.jobs, entry, {expendable: pctx.expendable || []}); } catch (e) { r = {outcome: 'threw ' + e.message}; }
			console.log('   ' + String(i + 1).padStart(2) + '. ' + cand.why + '  <- '
				+ cand.jobs.map(j => j.mon + ':' + (j.moves || []).join('>')).join(' | ')
				+ (matchRe && r && r.log ? '\n       log: ' + JSON.stringify(r.log).slice(0, 900)
					+ '\n       blockedEntries: ' + JSON.stringify(r.blockedEntries || null) : '')
				+ '\n       ' + (r ? ('outcome ' + r.outcome + (r.kills ? ' KILLS' : '')
					+ ' spend ' + JSON.stringify(r.spend)
					+ ' endHP ' + JSON.stringify(r.endHP) + ' turns ' + r.turns + ' foeLeft ' + r.foeLeft
					+ ' death ' + (r.deathRisk !== undefined ? (100 * r.deathRisk).toFixed(0) + '%' : '?')
					+ ' loses ' + JSON.stringify(r.lost || r.deaths || [])) : 'null'));
		});
	}
	console.log('what the top 25 candidates do from HERE:');
	Object.keys(tally).sort((a, b) => tally[b] - tally[a])
		.forEach(k => console.log('   ' + String(tally[k]).padStart(3) + '  ' + k));
	const R2 = require('./lib/replan.js');
	let pick = null;
	// RR_PROBE_PREV=<previous turn json> reproduces the live call, which passes
	// last turn's plan as the incumbent. Without it a probe judges every
	// position as though the agent had never had a plan before -- which is
	// exactly the thing under investigation, so it has to be reproducible.
	let probeOpts = {};
	if (process.env.RR_PROBE_PREV) {
		try {
			const prev = readJSONSync(process.env.RR_PROBE_PREV);
			if (prev && prev.planJobs) probeOpts.incumbent = prev.planJobs;
		} catch (e) { /* no incumbent, as before */ }
	}
	if (process.env.RR_PROBE_STICK) probeOpts.stick = Number(process.env.RR_PROBE_STICK);
	try { pick = R2.chooseAction(pctx, st, probeOpts); } catch (e) { console.log('chooseAction THREW: ' + e.message); }
	console.log('chooseAction -> ' + (pick
		? JSON.stringify(pick.action) + '   ' + pick.path.cand.why
			+ '\n   jobs: ' + pick.path.cand.jobs.map(j => j.mon + ':' + (j.moves || []).join('>') + (j.until ? ' until ' + JSON.stringify(j.until) : '')).join(' | ')
		: 'NULL  (this is what prints "no plan found")'));
	if (pick) {
		const theirsNow = foeAction(st, obs).chosen;
		const aimed = aimAtIncoming(st, theirsNow, pick.action);
		console.log('after aimAtIncoming -> ' + JSON.stringify(aimed));
		// The probe has no byte history, so it often calls the byte stale; show
		// what the override would do if the byte is taken at face value too.
		if (obs.ai_action === 1) {
			const raw = {type: 'switch', index: obs.ai_target};
			console.log('with the raw switch byte -> ' + JSON.stringify(aimAtIncoming(st, raw, pick.action)));
		}
	}
	process.exit(0);
}

// SCORE-BY-SCORE GRADING AGAINST CORRECTLY-PAIRED TRUTH.
//
// `--score-live` joins ai_truth.tsv (the AI's real score sheet, written when
// a turn RESOLVES and therefore paired with the position the node actually
// asked about) against that turn's archived observation, recomputes our four
// scores, and reports the per-move point gaps.
//
// This exists because the dump-based corpus is MISPAIRED and its numbers
// cannot be trusted. The EWRAM dumps are taken 45 frames after we commit, so
// the position in gBattleMons is not necessarily the one the AI scored
// against; the same matchup (Bellibolt vs our Volt Absorb Lanturn at 139)
// reads 102 for Parabolic Charge in a dump and 80 -- the correct -20 absorb
// penalty, which our model already applies -- in the live log. Every gap
// table built on the dumps inherits that error.
//
// Rows are matched on turn number AND both HP values, so a turn counter that
// restarts across sessions cannot silently pair the wrong battle.
if (process.argv[2] === '--score-live') {
	const truthFile = process.argv[3] || path.join(DIR, 'ai_truth.tsv');
	const turnsRoot = process.argv[4] || path.join(DIR, 'turns');
	const flags = {checkBadMove: true, semiSmart: true, checkGoodMove: true};
	// Index every archived observation by turn number.
	const byTurn = {};
	const walk = d => {
		let ents = [];
		try { ents = fs.readdirSync(d, {withFileTypes: true}); } catch (e) { return; }
		for (const e of ents) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) { walk(full); continue; }
			const m = /^turn(\d+)\.json$/.exec(e.name);
			if (!m) continue;
			(byTurn[Number(m[1])] = byTurn[Number(m[1])] || []).push(full);
		}
	};
	walk(turnsRoot);
	const gaps = {}, perMon = {}, matchTally = {};
	let rows = 0, paired = 0, exact = 0, argmaxOK = 0, stale = 0;
	// A SCORE SHEET THE AI NEVER WROTE THIS TURN.
	//
	// The thinking struct at 0x020003A4 is only rewritten when the AI actually
	// thinks about moves. On a turn it switches, or one where it does not act at
	// all, the struct still holds the LAST turn it thought, and the join pins
	// those stale numbers to a fresh position. Grading them measures our port
	// against a sheet describing a different board.
	//
	// The give-away is self-contained and needs no join: simulatedRNG is four
	// bytes drawn fresh every time the AI thinks, so a repeated value is a
	// struct that was not rewritten. In this corpus one value, "64,5,66,22",
	// appears 110 times across turn numbers 1 to 2116 and across sessions. Four
	// random bytes do not do that.
	//
	// 282 of 3329 rows carry a repeated draw. They grade at about 27% exact
	// against about 64% for the rest, and they are concentrated on switch turns,
	// which is exactly where the biggest apparent "rule gaps" lived: the whole
	// -17 mean residual once attributed to Volt Absorb sat on them, and on rows
	// where the AI really used a move our absorb penalty is exact on 668 of 668.
	// A rule fitted to that table would have been fitted to leftovers.
	const seenRng = {};
	const truthLines = fs.readFileSync(truthFile, 'utf8').split('\n');
	for (const line of truthLines) {
		const f = line.split('\t');
		if (f.length >= 9) seenRng[f[8]] = (seenRng[f[8]] || 0) + 1;
	}
	for (const line of truthLines) {
		if (!line.trim()) continue;
		const f = line.split('\t');
		if (f.length < 9) continue;
		rows++;
		if (seenRng[f[8]] > 1 && !process.env.RR_KEEP_STALE) { stale++; continue; }
		const turn = Number(f[0]), themHP = Number(f[2]), usHP = Number(f[4]);
		const tScores = f[5].split(',').map(Number);
		let obs = null;
		for (const cand of (byTurn[turn] || [])) {
			let d;
			try { d = JSON.parse(fs.readFileSync(cand, 'utf8')); } catch (e) { continue; }
			const o = d.obs;
			if (o && o.me && o.foe && o.me.hp === usHP && o.foe.hp === themHP) { obs = o; break; }
		}
		if (!obs) continue;
		// RR_LIVE_FIELD_ONLY grades only positions we can rebuild FAITHFULLY.
		// Archives written before the terrain read carry no terrainTurns, so
		// they rebuild with the phantom Electric Terrain that createState
		// inherits from Pincurchin -- which inflates every Electric move by
		// 1.3x and can flip which move we call strongest. Scoring against them
		// measures our own stale reconstruction, not the port.
		if (process.env.RR_LIVE_FIELD_ONLY && obs.terrainTurns === undefined) continue;
		// A ROW WHOSE ACTIVE HAS ALREADY FAINTED CANNOT BE GRADED. On a forced
		// switch the AI's score sheet was written about the Pokemon coming IN,
		// and this archived observation only names the corpse going out, so
		// every score is compared against a position that was never scored.
		// 244 of 2888 rows were being counted as misses on that basis; removing
		// them moves the port from 57% exact / 73% argmax to 61% / 77% without
		// a single rule changing. Measurement, not progress.
		if (obs.me.hp <= 0 || obs.kind === 'forced') continue;
		const st = buildState(obs);
		if (!st) continue;
		const foeMon = st.foe.team[st.foe.active];
		if (!foeMon || foeMon.fainted) continue;
		if (obs.turnsOut !== undefined && st.me.team[st.me.active]) {
			st.me.team[st.me.active].turnsOut = obs.turnsOut;
			st.me.team[st.me.active].volatiles.justEntered = (obs.turnsOut || 0) === 0;
		}
		if (obs.foeTurnsOut !== undefined && foeMon) foeMon.turnsOut = obs.foeTurnsOut;
		let scored;
		try { scored = RRAI.scoreAll(st, 'foe', flags, {}); }
		catch (e) { continue; }
		paired++;
		const bySlot = {};
		scored.forEach(e2 => {
			if (e2.action.type !== 'move') return;
			if (bySlot[e2.action.index] === undefined) bySlot[e2.action.index] = e2;
		});
		const sp = foeMon.set.species;
		const row = (perMon[sp] = perMon[sp] || {n: 0, exact: 0, slots: 0, hit: 0});
		row.n++;
		let allEq = true;
		for (let i = 0; i < 4; i++) {
			if (tScores[i] === 0 || !bySlot[i]) continue;   // 0 = unusable upstream
			row.slots++;
			const gap = bySlot[i].score - tScores[i];
			if (gap === 0) { row.hit++; continue; }
			allEq = false;
			const mv = foeMon.set.moves[i] || ('slot' + i);
			const k = sp + ' ' + mv + ' ' + (gap > 0 ? '+' : '') + gap;
			gaps[k] = (gaps[k] || 0) + 1;
			if (process.env.RR_LIVE_DETAIL === mv && gaps[k] <= 2) {
				console.log('--- ' + k + '  turn ' + turn + '  truth ' + tScores.join(',')
					+ '  we ' + st.me.team[st.me.active].set.species + ' ' + usHP
					+ '  foe ' + sp + ' ' + themHP);
				console.log('    ours: ' + bySlot[i].score + ' ' + JSON.stringify(bySlot[i].reasons));
			}
		}
		if (allEq) { exact++; row.exact++; }
		// The committed-choice comparison for the matchup table: what the
		// pricing's own predictor would have played here, against what the AI
		// actually clicked (recorded in the truth row itself). Move turns only.
		{
			const parts = (f[9] || '').split('/');
			if (parts.length === 2 && parts[0] === '0') {
				const actualSlot = Number(parts[1]);
				const movesOnly = scored.filter(e2 => e2.action.type === 'move');
				if (movesOnly.length) {
					let bestS = -Infinity;
					movesOnly.forEach(e2 => { if (e2.score > bestS) bestS = e2.score; });
					const tied = movesOnly.filter(e2 => e2.score === bestS);
					let pick2 = tied[0], pd = -1;
					for (const e2 of tied) {
						let dmg = 0;
						try {
							const r2 = B.damageRolls(st, 'foe', e2.action.move);
							if (r2 && !r2.immune) dmg = r2.noCrit[Math.floor(r2.noCrit.length / 2)];   // lump, hits included
						} catch (e3) { dmg = 0; }
						if (dmg > pd) { pd = dmg; pick2 = e2; }
					}
					const key2 = sp + ' vs ' + st.me.team[st.me.active].set.species;
					const row2 = (matchTally[key2] = matchTally[key2] || {hit: 0, n: 0,
						ev: 0, inset: 0});
					row2.n++;
					if (pick2.action.index === actualSlot) row2.hit++;
					// TIE-AWARE EXPECTED ACCURACY, alongside the raw number. Some
					// matchups are irreducible coins: Pawmot's two punches into
					// Mienshao are damage twins (both STAB, both neutral, equal
					// bands), so which one the game clicks is not predictable and
					// a 51% raw score there is the CEILING, not a bug. Grading a
					// hit inside a k-way argmax tie at 1/k -- the --score-port
					// convention -- makes ceilings look like ceilings, so the
					// table separates "we are wrong" from "nobody could know".
					if (tied.some(e2 => e2.action.index === actualSlot)) {
						row2.inset++;
						row2.ev += 1 / tied.length;
					}
				}
			}
		}
		let bt = -Infinity, bo = -Infinity;
		tScores.forEach(v => { if (v > bt) bt = v; });
		Object.keys(bySlot).forEach(i => { if (bySlot[i].score > bo) bo = bySlot[i].score; });
		const tSet = tScores.map((v, i) => v === bt ? i : -1).filter(i => i >= 0);
		const oSet = Object.keys(bySlot).filter(i => bySlot[i].score === bo).map(Number);
		if (tSet.length === oSet.length && tSet.every(i => oSet.indexOf(i) >= 0)) argmaxOK++;
	}
	// THE PREDICTOR TABLE, PER MATCHUP. Aggregate argmax agreement hid a
	// committed-choice model that was flat WRONG on one specific pair: Bellibolt
	// facing a standing Mienshao clicks Parabolic Charge 36 of 37 times live,
	// and the port said Thunder Wave -- a coin called 100% the wrong way that
	// read as "one point off, in-set" in every aggregate, for days, while
	// "Bellibolt Parabolic Charge -6 x25" sat mid-table below bigger phantoms.
	// Nothing downstream consumed the prediction either (the worst-plausible
	// entry hedge made it non-load-bearing), so the error was invisible in
	// outcomes too. Under RR_ENTRY_MODEL=confident predictions ARE load-bearing,
	// so which exact matchups predict badly has to be a standing instrument
	// rather than a one-night dig.
	const mt = Object.keys(matchTally).map(k => {
		const t = matchTally[k];
		return {k, n: t.n, acc: t.hit / t.n};
	}).filter(x => x.n >= 8).sort((a, b) => a.acc - b.acc);
	if (mt.length) {
		let H2 = 0, N2 = 0;
		Object.keys(matchTally).forEach(k => { H2 += matchTally[k].hit; N2 += matchTally[k].n; });
		console.log('\ncommitted-choice accuracy per matchup (worst first, n>=8; overall '
			+ Math.round(100 * H2 / N2) + '% on ' + N2 + ' move turns):');
		mt.forEach(x => {
			const t2 = matchTally[x.k];
			console.log('  ' + String(Math.round(100 * x.acc)).padStart(3)
				+ '%  n=' + String(x.n).padStart(4)
				+ '  in-argmax-set ' + String(Math.round(100 * t2.inset / t2.n)).padStart(3)
				+ '%  ' + x.k);
		});
	}
	console.log('truth rows ' + rows + ', dropped as a stale struct (repeated simulatedRNG) '
		+ stale + ', paired to an archived position ' + paired);
	if (!paired) { console.log('nothing paired -- is the turn archive present?'); process.exit(0); }
	console.log('all-four-exact ' + exact + ' (' + Math.round(100 * exact / paired)
		+ '%)   identical-argmax-set ' + argmaxOK + ' (' + Math.round(100 * argmaxOK / paired) + '%)');
	console.log('\nper-mon (exact turns / per-slot agreement):');
	Object.keys(perMon).sort().forEach(sp => {
		const r = perMon[sp];
		console.log('  ' + sp.padEnd(16) + ' turns ' + String(r.n).padStart(4)
			+ '  exact ' + String(Math.round(100 * r.exact / r.n)).padStart(3) + '%'
			+ '  slots ' + String(Math.round(100 * r.hit / Math.max(1, r.slots))).padStart(3) + '%');
	});
	console.log('\nper-move gaps (ours minus truth):');
	Object.keys(gaps).sort((a, b) => gaps[b] - gaps[a]).slice(0, 18)
		.forEach(k => console.log('  x' + String(gaps[k]).padStart(4) + '  ' + k));
	process.exit(0);
}

// SCORE-BY-SCORE GRADING. `--score-diff <dir>` walks cases synthesized from
// the EWRAM dumps -- each carries the full position AND the AI's true four
// scores read from the thinking struct -- computes our four scores for the
// same position, and reports the per-move point gaps clustered by move and
// direction. This is the porting accelerator the RAM read buys: a miss names
// the exact rule-sized number it is missing, not just a different argmax.
if (process.argv[2] === '--score-diff') {
	const dir = process.argv[3];
	const flags = {checkBadMove: true, semiSmart: true, checkGoodMove: true};
	const gaps = {};   // "<species> <move>: ours-vs-truth" -> {count, sumGap}
	let turns = 0, exact = 0, argmaxOK = 0;
	for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
		let c;
		try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
		catch (e) { continue; }
		const st = buildState(c.obs);
		if (!st) continue;
		const foeMon = st.foe.team[st.foe.active];
		if (!foeMon || foeMon.fainted) continue;
		let scored;
		try { scored = RRAI.scoreAll(st, 'foe', flags, {}); }
		catch (e) { continue; }
		const bySlot = {};
		scored.forEach(e2 => {
			if (e2.action.type !== 'move') return;
			if (bySlot[e2.action.index] === undefined) bySlot[e2.action.index] = e2;
		});
		turns++;
		let allEq = true;
		const tScores = c.truth.scores;
		const usable = i => tScores[i] !== 0;   // 0 = move unusable upstream
		for (let i = 0; i < 4; i++) {
			if (!usable(i) || !bySlot[i]) continue;
			const gap = bySlot[i].score - tScores[i];
			if (gap !== 0) {
				allEq = false;
				const mv = foeMon.set.moves[i] || ('slot' + i);
				const k = foeMon.set.species + ' ' + mv + ' ' + (gap > 0 ? '+' : '') + gap;
				gaps[k] = (gaps[k] || 0) + 1;
				if (process.env.RR_DIFF_DETAIL === mv && gaps[k] <= 2) {
					console.log('--- ' + k + '  (' + f + ')  truth ' + tScores.join(',')
						+ '  we ' + st.me.team[st.me.active].set.species
						+ ' ' + st.me.team[st.me.active].curHP);
					console.log('    our reasons: ' + JSON.stringify(bySlot[i].reasons));
				}
			}
		}
		if (allEq) exact++;
		let bt = -Infinity, bo = -Infinity;
		tScores.forEach(v => { if (v > bt) bt = v; });
		Object.keys(bySlot).forEach(i => { if (bySlot[i].score > bo) bo = bySlot[i].score; });
		const tSet = tScores.map((v, i) => v === bt ? i : -1).filter(i => i >= 0);
		const oSet = Object.keys(bySlot).filter(i => bySlot[i].score === bo).map(Number);
		if (tSet.length === oSet.length && tSet.every(i => oSet.indexOf(i) >= 0)) argmaxOK++;
	}
	console.log('turns ' + turns + '  all-four-scores-exact ' + exact
		+ ' (' + Math.round(100 * exact / turns) + '%)  identical-argmax-set ' + argmaxOK
		+ ' (' + Math.round(100 * argmaxOK / turns) + '%)');
	console.log('\nper-move gaps (ours minus truth), by frequency:');
	Object.keys(gaps).sort((a, b) => gaps[b] - gaps[a]).slice(0, 20)
		.forEach(k => console.log('  x' + String(gaps[k]).padStart(4) + '  ' + k));
	process.exit(0);
}

// THE PORT'S SCOREBOARD. `node tools/agent.js --score-port <turns-dir>` walks
// an archive session and scores the AI model against what the opponent
// ACTUALLY did, recovered from its PP deltas between consecutive turns --
// self-contained ground truth, no joins against logs whose turn numbers
// repeat across sessions. Three properties make this the honest measure:
//
//   - "Correct" means the real move is IN THE COMPUTED ARGMAX SET. The AI
//     picks uniformly among ties (ai_master.c:360), so calling a coin flip
//     "wrong" when we named both faces would punish the port for the game's
//     own randomness.
//   - Every flag combination is scored separately. Which combination scores
//     best PER TRAINER is evidence of that trainer's real aiFlags -- ROM data
//     we otherwise do not have. Computed, not predicted.
//   - It reuses the live buildState, so it sees exactly what the agent sees.
if (process.argv[2] === '--score-port') {
	const dir = process.argv[3];
	const files = fs.readdirSync(dir).filter(f => /^turn\d+\.json$/.test(f)).sort();
	const flagSets = {
		'basic          ': {checkBadMove: true},
		'basic+semi     ': {checkBadMove: true, semiSmart: true},
		'basic+good     ': {checkBadMove: true, checkGoodMove: true},
		'basic+semi+good': {checkBadMove: true, semiSmart: true, checkGoodMove: true}
	};
	const norm = m => (m || '').startsWith('Hidden Power') ? 'Hidden Power' : m;
	const tally = {};   // flagSet -> species -> {hit, n}
	const misses = {};  // "species: actual not in [set]" -> count
	let prev = null;
	for (const f of files) {
		let cur;
		try { cur = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
		catch (e) { continue; }
		const o = cur.obs;
		if (prev) {
			const po = prev.obs;
			const sameFoe = po.foe && o.foe && po.foe.species === o.foe.species
				&& po.foe.maxhp === o.foe.maxhp && o.turn === po.turn + 1;
			if (sameFoe) {
				let actual = null;
				for (let i = 0; i < 4; i++) {
					if ((o.foe.pp[i] || 0) < (po.foe.pp[i] || 0)) {
						actual = moveName(po.foe.moves[i]); break;
					}
				}
				if (actual) {
					const st = buildState(po);
					if (st && !st.foe.team[st.foe.active].fainted) {
						if (po.turnsOut !== undefined && st.me.team[st.me.active]) {
							st.me.team[st.me.active].turnsOut = po.turnsOut;
						}
						if (po.foeTurnsOut !== undefined && st.foe.team[st.foe.active]) {
							st.foe.team[st.foe.active].turnsOut = po.foeTurnsOut;
						}
						const species = st.foe.team[st.foe.active].set.species;
						for (const fsName in flagSets) {
							let scored;
							const nts = {};
							try { scored = RRAI.scoreAll(st, 'foe', flagSets[fsName], nts); }
							catch (e) { continue; }
							const movesOnly = scored.filter(e2 => e2.action.type === 'move');
							if (!movesOnly.length) continue;
							let best = -Infinity;
							movesOnly.forEach(e2 => { if (e2.score > best) best = e2.score; });
							const set = movesOnly.filter(e2 => e2.score === best)
								.map(e2 => norm(e2.action.move));
							// EXPECTED accuracy under the AI's own uniform tie
							// break: a hit inside a k-way tie is worth 1/k.
							// Plain set-membership scored the do-nothing model
							// at 100% -- every move ties at base, the set is
							// everything, and the metric rewards knowing
							// nothing.
							const uniq = set.filter((m, i2) => set.indexOf(m) === i2);
							const t = (tally[fsName] = tally[fsName] || {});
							const row = (t[species] = t[species] || {hit: 0, ev: 0, n: 0});
							row.n++;
							if (uniq.indexOf(norm(actual)) >= 0) {
								row.hit++;
								row.ev += 1 / uniq.length;
							}
							if (set.indexOf(norm(actual)) < 0 && fsName === 'basic+semi+good') {
								const k = species + ': did ' + norm(actual) + ', argmax [' + set.join(',') + ']';
								misses[k] = (misses[k] || 0) + 1;
								// RR_SCORE_DEBUG=Roost dumps the full scored
								// market for the first few misses of that move,
								// so a gate that refuses to fire can be READ.
								if (process.env.RR_SCORE_DEBUG === norm(actual)
									&& (misses[k] === 1 || misses[k] === 2)) {
									console.log('--- miss detail ' + f + ' (foe hp '
										+ po.foe.hp + '/' + po.foe.maxhp + ', we '
										+ st.me.team[st.me.active].set.species + ' '
										+ st.me.team[st.me.active].curHP + ')');
									scored.forEach(e3 => console.log('   ',
										e3.score, e3.action.move || ('switch ' + e3.action.index),
										JSON.stringify(e3.reasons)));
									console.log('    notes:', JSON.stringify(nts));
								}
							}
						}
					}
				}
			}
		}
		prev = cur;
	}
	for (const fsName in tally) {
		const t = tally[fsName];
		let H = 0, N = 0, EV = 0;
		const per = Object.keys(t).map(sp => {
			H += t[sp].hit; N += t[sp].n; EV += t[sp].ev;
			return sp + ' ' + Math.round(100 * t[sp].ev / t[sp].n) + '%';
		}).join('  ');
		console.log(fsName + '  expected ' + (N ? Math.round(100 * EV / N) : 0)
			+ '%  (in-set ' + (N ? Math.round(100 * H / N) : 0) + '%)   ' + per);
	}
	console.log('\ntop misses under basic+semi+good:');
	Object.keys(misses).sort((a, b) => misses[b] - misses[a]).slice(0, 12)
		.forEach(k => console.log('  x' + String(misses[k]).padStart(3) + '  ' + k));
	process.exit(0);
}

// ------------------------------------------------------------------- the loop
// A THROW ON ONE TURN MUST NOT END THE RUN. The agent died mid-session on a
// position it could not build, and the emulator went on asking a planner that
// was no longer there -- which reads exactly like the game being stuck.
process.on('uncaughtException', function (e) {
	console.log('[uncaught, continuing] ' + (e && e.stack || e));
});
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, {recursive: true});
// Tag every recorded result with the code that produced it. Rows from
// different code versions were indistinguishable in results.tsv, so a change
// to the planner could not be judged against the rows it actually produced.
let VERSION = '?';
try {
	const cp = require('child_process');
	const hash = cp.execSync('git rev-parse --short HEAD', {cwd: __dirname}).toString().trim();
	const dirty = cp.execSync('git status --porcelain', {cwd: __dirname}).toString().trim() ? '+' : '';
	VERSION = hash + dirty;
	// The experiment arm rides in the version stamp, so results.tsv records
	// which behaviour produced each episode instead of it living in my head.
	fs.writeFileSync(path.join(DIR, 'version.txt'),
		VERSION + (process.env.RR_NO_DEATH_VETO ? '+noveto' : '') + '\n');
} catch (e) { /* not fatal: the row just reads "?" */ }

// THE AGENT MUST NOTICE ITS OWN CODE IS STALE.
//
// This is a long-running process: editing a file under tools/ changes nothing
// until it is restarted, and there is no way to tell from the log which code
// produced a turn. Hours went into a fix that was never running, and results
// were read as if it were. Now the source files it actually loaded are
// fingerprinted at startup, checked every turn, and a change is announced on
// every decision AND stamped into version.txt -- so the results row the Lua
// writes carries "-STALE" and cannot be quoted as evidence for the new code.
const WATCHED = ['tools/agent.js', 'tools/lib/replan.js', 'tools/lib/candidates.js',
	'tools/lib/paths.js', 'tools/lib/policy.js', 'tools/lib/duels.js',
	'tools/lib/harness.js', 'tools/lib/enablers.js',
	'upstream-calc/src/js/rr-battle.js', 'upstream-calc/src/js/rr-ai.js'];
const repoRoot = path.join(__dirname, '..');
function sourceStamp() {
	return WATCHED.map(rel => {
		try { return rel + ':' + fs.statSync(path.join(repoRoot, rel)).mtimeMs; }
		catch (e) { return rel + ':?'; }
	}).join('|');
}
const STAMP_AT_START = sourceStamp();
let staleAnnounced = false, staleShown = false;
function checkStale() {
	if (sourceStamp() === STAMP_AT_START) return false;
	if (!staleAnnounced) {
		staleAnnounced = true;
		try { fs.writeFileSync(path.join(DIR, 'version.txt'), VERSION + '-STALE\n'); }
		catch (e) { /* nothing to do */ }
	}
	return true;
}
// The header is rewritten whenever the schema changes, not only when the file
// is absent. Columns were added twice tonight and the header was not, so rows
// carried twenty fields under an eighteen-field header -- every parse silently
// dropped the last two, which is why forty-four opponent bands read as zero.
const PRED_HEADER = 'turn\tus\tthem\tour_action\ttheir_predicted\t'
	+ 'their_actual\tpredictor_ok\tbyte_said\tmodel_said\tbyte_stale\t'
	+ 'pred_our_dmg\tpred_their_dmg\tactual_our_dmg\tactual_their_dmg\t'
	+ 'rng_before\tdraws\trolls\tcrit_rolls\tfoe_rolls\tfoe_crit\t'
	+ 'foe_status_after\tme_status_after\tai_menu\tai_movelist\tai_committed\tai_resolving\tai_late\tai_t150\tai_t220\tai_t320\tresolving_raw\n';
if (fs.existsSync(PRED)) {
	const first = fs.readFileSync(PRED, 'utf8').split('\n')[0] + '\n';
	if (first !== PRED_HEADER) {
		const body = fs.readFileSync(PRED, 'utf8').split('\n').slice(1).join('\n');
		fs.writeFileSync(PRED, PRED_HEADER + body);
	}
}
if (!fs.existsSync(PRED)) {
	fs.writeFileSync(PRED, 'turn\tus\tthem\tour_action\ttheir_predicted\t'
		+ 'their_actual\tpredictor_ok\tbyte_said\tmodel_said\tbyte_stale\t'
		+ 'pred_our_dmg\tpred_their_dmg\tactual_our_dmg\tactual_their_dmg\t'
		+ 'rng_before\tdraws\trolls\tcrit_rolls\tfoe_rolls\tfoe_crit\t'
	+ 'foe_status_after\tme_status_after\tai_menu\tai_movelist\tai_committed\tai_resolving\tai_late\tai_t150\tai_t220\tai_t320\tresolving_raw\n');
}

let lastTurn = 0, awaiting = null;
console.log('agent: watching ' + DIR + '. Load tools/lua/bootstrap.lua in mGBA (it hot-reloads agent_impl.lua).');

function readJSONSync(p) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function readJSON(p) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/**
 * Is this question already answered?
 *
 * Keying on the turn number alone was wrong. A hot reload restarts the
 * counter, so a genuinely new question arrives labelled "turn 1", the planner
 * sees a number it has already answered, and both halves wait forever. What
 * actually decides it is whether an answer for THIS question is sitting on
 * disk: the agent deletes the command file whenever it asks, so a missing or
 * stale command file means the question is open, whatever it is numbered.
 */
function alreadyAnswered(obs) {
	const cmd = readJSON(CMD);
	return !!(cmd && cmd.turn === obs.turn);
}

// Is somebody actually at the panel? It stamps this file on every poll. The
// answer decides whether the agent is allowed to wait for a person: an
// unattended run must never sit on a question nobody is going to answer, and
// closing the tab is the natural way to say "just play".
function panelLive() {
	try { return Date.now() - fs.statSync(PANEL).mtimeMs < 5000; }
	catch (e) { return false; }
}

// A question is about a POSITION, not a turn number: the Lua expires an unanswered
// question after 60 seconds and re-asks the same position under a new id, so
// keying the pending choice on the turn would throw it away every minute.
function positionKey(obs) {
	return [obs.kind, obs.me.species, obs.me.hp, obs.foe.species, obs.foe.hp].join('/');
}

// The open sacrifice question, and the standing answer to it.
//
// A plan that means to spend Lilligant on Pawmot says so again on every turn
// until it happens, so asking per turn is a nag, not a check. What gets
// answered is really "against this opponent, who am I willing to lose", so the
// answer is kept as the accepted CASUALTY SET and honoured until the opponent
// changes or that outcome stops being available.
//
// Storing the outcome rather than the move matters twice over. The position
// moves every turn, so replaying a stored ACTION would replay a decision about
// a board that no longer exists. And the option list shrinks as a sacrifice is
// carried out -- three outcomes become two -- so anything keyed on the shape of
// the question would ask again halfway through the plan it just approved.
//
// It also holds the line the other way: answer "lose nobody" and every later
// turn quietly takes the no-loss line again, instead of re-proposing the
// sacrifice that was just refused.
let pendingAsk = null, standingAnswer = null, pauseShown = false;
// How long a sacrifice question waits for a person before the agent answers it
// itself. Long enough to walk back to the desk, short enough that a panel left
// open on another screen does not silently halt an episode.
const ASK_TIMEOUT = Number(process.env.RR_ASK_TIMEOUT || 300) * 1000;
const deathKey = list => list.slice().sort().join(',');

// THE LINE THE HUMAN IS CURRENTLY ASKING ABOUT, held for the duel rather than
// for the turn. A line like "sleep it, then bring Diggersby in" is a SEQUENCE;
// evaluating it only on the turn it was typed would price the first leg and
// never watch the rest happen, which is precisely the part he wants checked.
// It is dropped when the opponent changes, because a line is advice about an
// opponent and means nothing against the next one.
let userLine = null;

/** Say what the market did with his line, in the terms he asked it in. */
function verdictText(v, winner) {
	if (!v) return 'no verdict (the planner produced nothing this turn)';
	const money = n => (n === null || n === undefined) ? '?' : n.toFixed(2);
	const who = list => list && list.length ? list.join(', ') : 'nobody';
	if (!v.priced) {
		return 'YOUR LINE WAS NEVER PRICED -- ' + v.dropped
			+ (v.already ? ' (it was on the table as "' + v.already + '")'
				: ' (and the generator never proposed it)');
	}
	const lines = [];
	lines.push('your line: total ' + money(v.total) + ' (this kill ' + money(v.here)
		+ ' + rest of the fight '
		+ (v.ahead === null || v.ahead === undefined ? 'NOT JUDGED' : money(v.ahead)) + ')'
		+ ', ' + (v.kills ? 'kills it' : 'does not kill it (' + v.outcome + ')')
		+ ' in ' + v.turns + ' turns, loses ' + who(v.dead)
		+ ', death risk ' + Math.round(100 * (v.deathRisk || 0)) + '%');
	lines.push('it ranked ' + v.rank + ' of ' + v.ofPriced + ' priced lines'
		+ (v.already ? ' and was already on the table as "' + v.already + '"'
			: ' and the generator had NOT proposed it'));
	if (winner) {
		lines.push('the planner chose: total ' + money(winner.total)
			+ ' (' + money(winner.here) + ' + ' + money(winner.ahead) + '), loses '
			+ who(winner.dead) + ' -- ' + winner.why);
	}
	if (v.won) {
		lines.push('=> YOUR LINE WON. It is being played.');
	} else if (winner && v.total !== null && v.total < winner.total - 1e-9) {
		// The interesting failure. Only the cheapest few lines ever get their
		// lookahead priced, so a line can be cheaper on the full criterion and
		// still lose because it never entered the round where that criterion is
		// applied. That is a defect in the cut, not a disagreement about value.
		lines.push('=> YOUR LINE PRICES CHEAPER by ' + money(winner.total - v.total)
			+ ' AND STILL LOST'
			+ (v.judged ? '.' : ' -- it was outside the top ' + (v.ofPriced < 4 ? v.ofPriced : 4)
				+ ' on immediate cost, so its lookahead was never priced when the'
				+ ' winner was picked. The cut threw away the better line.'));
	} else if (winner && v.total !== null) {
		lines.push('=> the planner prices your line ' + money(v.total - winner.total)
			+ ' more expensive.');
	}
	return lines.join('\n     ');
}

function clearAsk() {
	pendingAsk = null;
	try { fs.unlinkSync(ASK); } catch (e) { /* already gone */ }
	try { fs.unlinkSync(CHOICE); } catch (e) { /* already gone */ }
}

setInterval(() => {
	// RESULTS ARE COLLECTED FIRST, unconditionally. This used to run only when
	// the current question was already answered, which is a window of a few
	// hundred milliseconds between a turn resolving and the next one being
	// asked -- so thirteen resolved turns produced two rows. The prediction log
	// is the entire point of these calibration runs; losing most of it to a
	// polling race makes the runs worthless.
	{
		const res = readJSON(RESULT);
		if (awaiting && res && res.turn === awaiting.turn) {
				// A different Pokemon is standing there now, so the HP
				// difference is meaningless -- it compares two Pokemon. The
				// first live turn logged our damage as MINUS SIX because
				// Voltorb died and something with more HP replaced it. What we
				// actually learn from a kill is a lower bound: at least the
				// HP it had left.
				// WHAT THEY ACTUALLY DID, not what we read they would do.
				// The decision byte at 0x02000091 was validated on Surge-side
				// states only, and this log already suggests it is wrong
				// elsewhere: every row predicting a switch shows their species
				// unchanged afterwards. Comparing their PP before and after
				// names the move they really used, which turns the whole
				// calibration run into a fidelity test of the predictor rather
				// than an assumption resting on one fight.
				const foeSwapped = res.foe.species !== awaiting.foeSpecies;
				let theirActual = 'unknown';
				if (foeSwapped) {
					// A different Pokemon is out, but that has two causes and
					// they are not the same event. If our hit was lethal they
					// FAINTED; otherwise they chose to leave. Conflating them
					// credited the predictor for switches that were really
					// deaths we caused.
					theirActual = (awaiting.predOur >= awaiting.foeHP)
						? 'fainted+replaced' : 'switched';
				} else {
					for (let i = 0; i < 4; i++) {
						if (res.foe.pp[i] < awaiting.foePP[i]) {
							theirActual = moveName(awaiting.foeMoves[i]) || ('slot ' + i);
							break;
						}
					}
					if (theirActual === 'unknown') theirActual = 'no move used';
				}
				const predictorOK = awaiting.theirAction === theirActual ? 'yes'
					: (awaiting.theirAction.startsWith('switch')
						&& theirActual === 'switched') ? 'yes'
					: (theirActual === 'fainted+replaced') ? 'n/a' : 'NO';
				const meSwapped = res.me.species !== awaiting.meSpecies;
				const ourDmg = foeSwapped ? awaiting.foeHP : awaiting.foeHP - res.foe.hp;
				const theirDmg = meSwapped ? awaiting.myHP : awaiting.myHP - res.me.hp;
				fs.appendFileSync(PRED, [awaiting.turn, awaiting.us, awaiting.them,
					awaiting.ourAction, awaiting.theirAction,
					theirActual, predictorOK,
					awaiting.byteSays, awaiting.modelSays, awaiting.stale ? 'stale' : '',
					awaiting.predOur, awaiting.predTheir,
					(foeSwapped ? '>=' : '') + ourDmg,
					(meSwapped ? '>=' : '') + theirDmg,
					awaiting.rng, awaiting.draws.join(','),
					awaiting.rolls.join(','), awaiting.critRolls,
					awaiting.foeRolls.join(';'), awaiting.foeCrit,
					statusOf(res.foe.status) || '', statusOf(res.me.status) || '',
					// The decision bytes as they read at four points in the
					// turn. One of these should match what they actually did at
					// the rate the Surge labels did; the log will say which.
					sampleName(res, 'menu'), sampleName(res, 'movelist'),
					sampleName(res, 'committed'), sampleName(res, 'resolving'),
					sampleName(res, 'late'), sampleName(res, 't150'),
					sampleName(res, 't220'), sampleName(res, 't320'),
					// The raw action/target pair, for the score-array hunt: the
					// SLOT is what an argmax has to match, not the move name.
					((res.ai_samples && res.ai_samples.resolving) || '')
					].join('\t') + '\n');
				// THE AI'S TRUE SCORE SHEET, one row per resolved turn. The
				// thinking struct at 0x020003A4 was located by signature scan
				// and verified 737/737; the Lua reads it at the same 45-frame
				// mark as the proven decision byte, and this file is what the
				// port is graded against from now on: not "did the argmax
				// match" but "is every one of the four scores equal", rule by
				// rule. srng is the AI's pre-drawn randomness -- the tie-break
				// and coin-flip bytes, the last non-computed part of its mind.
				if (res.ai_think && res.ai_think.scores) {
					try {
						fs.appendFileSync(path.join(DIR, 'ai_truth.tsv'), [
							awaiting.turn, awaiting.them, awaiting.foeHP,
							awaiting.us, awaiting.myHP,
							res.ai_think.scores.join(','),
							res.ai_think.considered, res.ai_think.flags,
							res.ai_think.srng.join(','),
							((res.ai_samples && res.ai_samples.resolving) || '')
						].join('\t') + '\n');
					} catch (e) { /* truth logging must never break play */ }
				}
				const ok = (d, p, part) => part ? 'at least ' + d
					: (d === p ? 'exact' : 'off by ' + (d - p));
				console.log('  turn ' + awaiting.turn + ' resolved: our damage '
					+ ourDmg + ' (' + ok(ourDmg, awaiting.predOur, foeSwapped)
					+ '), theirs ' + theirDmg + ' ('
					+ ok(theirDmg, awaiting.predTheir, meSwapped) + ')');
			awaiting = null;
		}
	}

	const obs = readJSON(STATE);
	if (!obs) return;
	// STOP MEANS STOP, AND IT STOPS HERE. The one place where stopping is
	// clean is before an answer is written: the emulator is sitting on the
	// move menu waiting, which is where it would sit anyway between turns.
	// Killing the process or unloading the script mid-sequence leaves it
	// halfway through a party screen. Resuming is just deleting the file, and
	// the question is still open, so nothing is lost by pausing for an hour.
	if (fs.existsSync(PAUSE)) {
		if (!pauseShown) { pauseShown = true; console.log('\n[STOPPED by the panel; the question is held open. Resume from the panel.]'); }
		if (pendingAsk) clearAsk();
		return;
	}
	if (pauseShown) { pauseShown = false; console.log('\n[resumed]'); }
	if (alreadyAnswered(obs)) return;
	// A SACRIFICE ALREADY PUT TO THE HUMAN. Nothing is planned again while the
	// question stands, or the options under the answer would be re-priced out
	// from under it -- the shortlist scores move between adjacent turns, which
	// is exactly why the choice is stored as the concrete action it opens with.
	let chosenByHand = null;
	if (pendingAsk) {
		// A LINE TYPED WHILE THE QUESTION IS OPEN REOPENS THE QUESTION. Being
		// asked "who should die" is exactly the moment for "why not this
		// instead", and holding the old options while refusing to read the
		// answer would be the least useful possible time to stop listening.
		// The line goes into the market, so it comes back as one of the
		// options on the next pass.
		if (fs.existsSync(LINE)) {
			console.log('  [new line typed; re-opening the question with it priced in]');
			clearAsk();
		} else if (pendingAsk.key !== positionKey(obs)) clearAsk();
		else {
			const ch = readJSON(CHOICE);
			if (ch && pendingAsk.options[ch.index]) {
				chosenByHand = pendingAsk.options[ch.index];
				standingAnswer = {foe: pendingAsk.foe, accept: deathKey(chosenByHand.dead)};
				clearAsk();
			} else if (!panelLive() || Date.now() - pendingAsk.asked > ASK_TIMEOUT) {
				// Nobody is answering. Either the tab was closed, or it is open
				// on a screen nobody is looking at -- which is the ordinary
				// case, since the panel gets left up while its owner does
				// something else entirely. An open tab is evidence of intent to
				// supervise, not a promise to be present, and treating it as a
				// promise turns a forgotten tab into a frozen run.
				//
				// Taking the plan's own answer is the pre-panel behaviour
				// exactly, and it stands so the run does not stall again next
				// turn. The question is recorded as unanswered either way.
				// 2026-09-05: while nobody answers, the answer James would give
				// is the one he gives every time he is here -- nobody dies. Run 1
				// on s5 sent an 18 HP Lanturn into a fresh Pawmot because the
				// timeout took the plan's own sacrifice; the option that lost
				// nobody was sitting second on the list. So the default is the
				// cheapest option that buries nobody, and the plan's line only
				// when every option on the table loses somebody.
				// ...and when every option loses somebody, the one that loses
				// the fewest (the plan on a tie), logged so James can review it.
				const fewest = pendingAsk.options.slice().sort((a, b) => a.dead.length - b.dead.length)[0];
				const safe = pendingAsk.options.find(o => !o.dead.length)
					|| (fewest && fewest.dead.length < pendingAsk.options[0].dead.length ? fewest : pendingAsk.options[0]);
				console.log('  [' + (panelLive()
					? 'no answer in ' + Math.round(ASK_TIMEOUT / 1000) + 's'
					: 'panel closed with the question open')
					+ '; taking the ' + (safe.dead.length ? 'plan, which loses ' + deathKey(safe.dead)
						: 'option that loses nobody: ' + safe.why) + ']');
				standingAnswer = {foe: pendingAsk.foe, accept: deathKey(safe.dead), auto: true};
				clearAsk();
			} else {
				// Restamp so the panel shows the live turn while it waits.
				try {
					const a = readJSON(ASK) || {};
					a.turn = obs.turn;
					fs.writeFileSync(ASK, JSON.stringify(a));
				} catch (e) { /* the panel re-reads next poll */ }
				return;
			}
		}
	}
	lastTurn = obs.turn;

	// A BUSH POKEMON IS NOT OURS TO FIGHT. Hand the controller back and say so
	// once; the Lua stands down on the marker and clears it when the battle
	// ends.
	let handsOffWhy = isDoubles(obs) ? ('DOUBLE BATTLE (' + isDoubles(obs) + ')')
		: (isWild(obs) ? 'WILD ' + speciesName(obs.foe.species) + ' L' + obs.foe.level : null);
	// "FIGHT THIS ONE ANYWAY" on the panel writes `fight`; it overrides the
	// stand-down for THIS opposing party only and is cleared when that changes.
	const FIGHT = path.join(DIR, 'fight');
	const fightSig = (obs.foeparty || []).map(r => r && r.maxhp || 0).join(',');
	if (fs.existsSync(FIGHT)) {
		if (fightOverride.sig && fightOverride.sig !== fightSig) {
			try { fs.unlinkSync(FIGHT); } catch (e) { /* gone */ }
			fightOverride.sig = null;
		} else if (handsOffWhy) {
			if (fightOverride.sig !== fightSig) {
				fightOverride.sig = fightSig;
				console.log('turn ' + obs.turn + ': fighting this one on your say-so (' + handsOffWhy + ')');
			}
			handsOffWhy = null;
		}
	}
	// A STALE MARKER MUST NOT OUTLIVE THE MISJUDGMENT THAT WROTE IT.
	if (!handsOffWhy && fs.existsSync(path.join(DIR, 'wild'))) {
		try { fs.unlinkSync(path.join(DIR, 'wild')); } catch (e) { /* the Lua clears it too */ }
		console.log('turn ' + obs.turn + ': this is a trainer fight after all; standing back up');
	}
	if (handsOffWhy) {
		const WILD = path.join(DIR, 'wild');
		if (!fs.existsSync(WILD)) fs.writeFileSync(WILD, String(obs.turn) + '\n');
		// CONSUME THE OBSERVATION. Left on disk, a wild observation kept being
		// re-read after the encounter ended: the Lua cleared the marker on the
		// overworld, this re-wrote it from the stale file, and the agent sat
		// out the start of the Brennan fight believing a Galarian Meowth was
		// still in front of it. The answering path deletes it; so does this.
		try { fs.unlinkSync(STATE); } catch (e) { /* already gone */ }
		if (handsOffSaid !== obs.turn) {
			handsOffSaid = obs.turn;
			console.log('turn ' + obs.turn + ': ' + handsOffWhy
				+ ' (btype 0x' + Number(obs.btype || 0).toString(16)
				+ ', b2sp ' + (obs.b2sp || 0) + ', b3sp ' + (obs.b3sp || 0)
				+ ') -- yours to play, not answering');
		}
		return;
	}
	const st = buildState(obs);
	if (!st) { console.log('turn ' + obs.turn + ': could not identify the position'); return; }
	// THE PLANNER DRIVES. Every turn it re-prices the ways to kill the Pokemon
	// in front of us FROM THE CURRENT POSITION -- who can do it, what it costs,
	// what has to happen first -- and plays the first move of the cheapest line
	// that stays inside the cap. Next turn it asks again from wherever the dice
	// put us, which is the whole point: a fixed script cannot notice that the
	// position has drifted, and three separate experiments showed static plans
	// dying because of exactly that.
	//
	// Until now this was scaffolding: a one-turn scorer with no lookahead and no
	// plan at all. It played reasonable-looking moves for local reasons and had
	// no notion of reserving a Pokemon for a job or of what the fight needs
	// three turns from now.
	let d = null, plannerSaid = null;
	// THE OBVIOUS TURNS ARE ANSWERED AT ONCE. James, 2026-09-04: "when
	// hitmonlee is going to use fake out we don't really need to think about
	// it that much." Two cases need no market: a clean kill in hand (the
	// one-turn scorer sees the foe fall, we do not, and nothing is coming for
	// us next turn), and a usable entry-only move on the turn we arrived.
	if (!process.env.RR_NO_QUICK && obs.kind !== 'forced') {
		try {
			const q = decide(st, obs);
			const top = q && q.best;
			const mine = st.me.team[st.me.active];
			if (top && top.action.type === 'move' && top.foeDead && !top.mineDead
				&& !top.dyingNext && !top.unknownTarget) {
				console.log('  [quick: ' + top.action.move + ' removes it and nothing comes back; no market run]');
				d = q;
			} else if (mine && mine.volatiles && mine.volatiles.justEntered) {
				const fo = q && q.all.find(r => r.action.type === 'move' && r.action.move === 'Fake Out');
				const canFlinch = !/Inner Focus|Shield Dust/i.test(st.foe.team[st.foe.active].set.ability || '');
				if (fo && canFlinch && !fo.mineDead && (fo.theirLoss > 0 || fo.score > -1)) {
					console.log('  [quick: Fake Out on entry; no market run]');
					d = Object.assign({}, q, {best: fo});
				}
			}
		} catch (e) { d = null; }
	}
	if (!d && !process.env.GREEDY && !process.env.NOPLAN) {
		try {
			// The line we were already following, so it can defend itself against
		// this turn's challengers instead of being re-derived from nothing.
		const foeNow = st.foe.team[st.foe.active].set.species;
		// A NEWLY TYPED LINE, read against the team as it actually is so the
		// error message can name the real moves rather than a guess at them.
		const typed = readJSON(LINE);
		if (typed) {
			try { fs.unlinkSync(LINE); } catch (e) { /* read once */ }
			const text = String(typed.text || '').trim();
			if (!text) {
				userLine = null;
				try { fs.unlinkSync(LINE_RESULT); } catch (e) { /* nothing to clear */ }
				console.log('  [line cleared]');
			} else {
				const parsed = UL.parseLine(st.me.team, text);
				if (parsed.error) {
					userLine = null;
					fs.writeFileSync(LINE_RESULT, JSON.stringify({text: text,
						error: parsed.error}));
					console.log('  [your line could not be read: ' + parsed.error + ']');
				} else {
					userLine = {foe: foeNow, text: text, jobs: parsed.jobs,
						reading: parsed.reading};
					console.log('  [your line: ' + text + '  ->  priced as: '
						+ parsed.reading + ']');
				}
			}
		}
		// A line is advice about an OPPONENT, so it expires with that opponent.
		if (userLine && userLine.foe !== foeNow) {
			console.log('  [your line was about ' + userLine.foe + '; ' + foeNow
				+ ' is out now, so it no longer applies]');
			userLine = null;
			try { fs.unlinkSync(LINE_RESULT); } catch (e) { /* nothing to clear */ }
		}
		assertSameTeams(st, planCtx(obs), 'decide');
		const pick = R.chooseAction(planCtx(obs), st,
			{incumbent: lastPlan.foe === foeNow ? lastPlan.jobs : null,
				// A plan is about an OPPONENT, so how far through it we are
				// expires with that opponent, exactly as the incumbent does.
				progress: lastPlan.foe === foeNow ? lastPlan.progress : null,
				alternatives: panelLive(),
				userLine: userLine ? userLine.jobs : null});
		if (userLine && pick) {
			const w = pick.path ? {
				total: pick.path.here + (pick.path.ahead || 0),
				// null ahead means the FINALISTS cut never judged this line, which
				// is a different statement from "its lookahead is zero" and is
				// exactly the distinction the line box exists to make.
				here: pick.path.here, ahead: pick.path.ahead,
				judged: pick.path.ahead !== null,
				why: pick.path.cand.why,
				dead: (pick.path.r && pick.path.r.dead) || []
			} : null;
			const text = verdictText(pick.userLine, w);
			console.log('  [YOUR LINE] ' + text);
			fs.writeFileSync(LINE_RESULT, JSON.stringify({
				text: userLine.text, reading: userLine.reading,
				foe: foeNow, turn: obs.turn, verdict: pick.userLine,
				winner: w, summary: text
			}));
			// APPEND-ONLY, with the position attached. A verdict that only
			// exists on screen cannot be re-examined later, and the whole
			// reason for asking is to be able to come back to it.
			try {
				fs.appendFileSync(LINES_LOG, JSON.stringify({
					at: new Date().toISOString(), turn: obs.turn, session: SESSION,
					text: userLine.text, reading: userLine.reading, jobs: userLine.jobs,
					us: obs.me.species, usHP: obs.me.hp, foe: foeNow, foeHP: obs.foe.hp,
					verdict: pick.userLine, winner: w
				}) + '\n');
			} catch (e) { /* recording must never break play */ }
		}
		if (pick && pick.path && pick.path.cand) {
			lastPlan = {foe: foeNow, jobs: pick.path.cand.jobs,
				progress: pick.progress || null};
		}
			if (pick && pick.action) {
				plannerSaid = pick;
				// THE PLAN STILL HAS TO SURVIVE THE TURN. This branch used to
				// build its answer with `all: []` and `theirs: null`, so on a
				// planned turn nothing was ever predicted -- which is why the
				// log read "they will: none" and "expecting to deal 0 and take
				// 0" against Pawmot, and why the plan happily walked Lilligant
				// into Mach Punch. Probing that exact position offline, the
				// one-turn scoring ranked every move at -61.39 because
				// Lilligant dies, and switching at -2.45. It knew. Nobody asked.
				const oneTurn = decide(st, obs);
				let chosen = aimAtIncoming(st, oneTurn.theirs, pick.action);
				const same = (a, b) => a && b && a.type === b.type
					&& (a.type === 'switch' ? a.index === b.index : a.move === b.move);
				const mine = oneTurn.all.find(r => same(r.action, chosen));
				// RR_NO_DEATH_VETO turns this override off for A/B measurement.
				// The veto is an EXTERNAL reflex over an internal market, which
				// is the pattern James has objected to twice, and it overrules
				// the planner's deathRisk -- computed against the whole
				// plausible move set with real crit odds -- using one-turn
				// scoring, the cruder of the two models. It also predates the
				// status, boost, terrain and pivot-damage fixes, so the pricing
				// it distrusts is not the pricing it was written against.
				if (mine && mine.mineDead && !mine.foeDead
					&& !process.env.RR_NO_DEATH_VETO) {
					// It dies this turn and does not take the opponent with it.
					// A plan is a sequence, so losing the Pokemon it depends on
					// costs the rest of the plan, not just this turn.
					// The dodge must not be a Pokemon that is nearly dead itself:
					// run 3 on s5 (turn 600) sent a 15 HP Lilligant into Vikavolt
					// because Mud Shot would not quite kill her. Prefer a switch-in
					// with real HP; take the best one-turn alternative otherwise.
					const alts = oneTurn.all.filter(r => !r.mineDead && !same(r.action, chosen));
					const hpOf = r => r.action.type === 'switch' && st.me.team[r.action.index]
						? st.me.team[r.action.index].curHP / st.me.team[r.action.index].maxHP : 1;
					const alt = alts.find(r => hpOf(r) >= 0.35) || alts[0];
					if (!alt) {
						// EVERY OPTION DIES. Then the last move is for the
						// successor, not for damage: a Sleep Powder that lands
						// before the hit leaves the next Pokemon a sleeping
						// target (run 2 on s5, turn 593: Victreebel died using
						// Sludge with Sleep Powder in hand). Needs to move first.
						try {
							const M = engine.sandbox.RR_MOVE_EFFECTS.moves;
							const faster = engine.B.finalSpeed(st, 'me') > engine.B.finalSpeed(st, 'foe');
							const foeMon = st.foe.team[st.foe.active];
							const parting = faster ? oneTurn.all.map(r => r.action)
								.filter(a => a.type === 'move')
								.find(a => {
									const d = M[a.move];
									if (!(d && d.effect && d.effect.kind === 'status' && d.effect.target === 'foe'
										&& (d.effect.status === 'slp' || d.effect.status === 'par'))) return false;
									try { return engine.B._internal.canTakeStatus(foeMon, d.effect.status, st, null); }
									catch (e) { return true; }
								}) : null;
							if (parting && !same(parting, chosen)) {
								console.log('  [every option loses ' + st.me.team[st.me.active].set.species
									+ '; its last move is ' + parting.move + ' for whoever comes next]');
								chosen = parting;
								lastPlan.progress = null;
								plannerSaid = Object.assign({}, pick, {overridden: true});
							}
						} catch (e) { /* keep the plan's move */ }
					}
					if (alt && !same(alt.action, chosen)) {
						console.log('  [plan would lose '
							+ st.me.team[st.me.active].set.species
							+ ' this turn; taking '
							+ (alt.action.move || ('switch ' + alt.action.index))
							+ ' instead]');
						chosen = alt.action;
						// THE PLAN DID NOT ADVANCE, because its move was not
						// played. chooseAction already counted this turn against
						// the plan's progress, so keeping it would skip a leg or
						// a move that never happened. Drop it and let next turn
						// re-derive; a veto is a departure from the plan and the
						// plan's own bookkeeping has to say so.
						lastPlan.progress = null;
						// THE PLAN STILL EXISTED. Nulling this made the log
						// print "no plan found", so an override by this veto
						// was indistinguishable from the planner having
						// nothing to say -- and that false signal sent hours
						// of investigation after a planner that was working
						// fine, with offline probes of the very turns
						// cheerfully producing the plan the log denied. The
						// plan is kept and the override is stated instead.
						plannerSaid = Object.assign({}, pick, {overridden: true});
					}
				}
				d = {best: {action: chosen, foeDead: false, mineDead: false,
					theirLoss: 0, myLoss: 0, unknownTarget: false},
					all: oneTurn.all, theirs: oneTurn.theirs, src: oneTurn.src};
			}
		} catch (e) {
			console.log('  [planner failed: ' + e.message + ']');
		}
	}
	if (!d && process.env.GREEDY && obs.kind !== 'forced') {
		const a = greedyAction(st);
		d = {best: {action: a, foeDead: false, mineDead: false, theirLoss: 0, myLoss: 0,
			unknownTarget: false}, all: [], theirs: null,
			src: {byte: null, model: null, stale: false}};
	} else if (!d) {
		d = decide(st, obs);
	}
	if (!d || !d.best) { console.log('turn ' + obs.turn + ': no legal action found'); return; }
	if (obs.kind === 'forced' && d.best.action.type !== 'switch') {
		// Belt and braces: on a party screen the only executable answer is a
		// switch. Anything else is unplayable and would cycle.
		const sw = d.all.find(r => r.action.type === 'switch');
		if (sw) d.best = sw;
		else { console.log('turn ' + obs.turn + ': forced switch with nobody to send'); return; }
	}

	// WHO DIES IS THE HUMAN'S CALL, when a human is there to make it.
	//
	// The planner is willing to spend a Pokemon, and it prices what that costs,
	// but it prices every non-forbidden death at the same flat rate -- which is
	// how Lilligant, the only real answer to Pawmot, gets spent on something
	// else and the fight is lost three turns before it looks lost. Rather than
	// guess a better price (that is a decision James has reserved), the agent
	// stops and asks, on the one class of turn where the mistake is
	// unrecoverable, and only while somebody is watching the panel.
	//
	// The options are lines the market itself produced, one per distinct
	// outcome, so the answer is a choice between plans and not a hand-drawn
	// move: whatever comes back is played as the planner would have played it.
	if (chosenByHand) {
		d.best.action = chosenByHand.action;
		console.log('  [YOU CHOSE: ' + chosenByHand.why
			+ (chosenByHand.dead.length
				? ' -- losing ' + chosenByHand.dead.join(', ') : ' -- losing nobody') + ']');
	} else if (panelLive() && plannerSaid && plannerSaid.path && plannerSaid.path.r
		&& (plannerSaid.path.r.dead || []).length
		&& (plannerSaid.alternatives || []).length) {
		const foeName = speciesName(obs.foe.species);
		// ONE ROW PER OUTCOME. Six lines that all bury Lilligant are one choice
		// wearing six hats; what makes this a check is seeing that the
		// alternative buries somebody else, or nobody.
		const seen = {}, options = [];
		plannerSaid.alternatives.forEach(alt => {
			const k = deathKey(alt.dead);
			if (seen[k] || options.length >= 5) return;
			seen[k] = true;
			options.push({action: alt.action, why: alt.why,
				dead: alt.dead, total: Math.round(alt.total * 100) / 100});
		});
		// The outcome already signed off on, if it is still on the table.
		const standing = standingAnswer && standingAnswer.foe === foeName
			? options.find(o => deathKey(o.dead) === standingAnswer.accept) : null;
		if (standing && standingAnswer.auto && plannerSaid && plannerSaid.overridden
			&& standing.dead.length) {
			// Nobody chose this loss; the timeout did. A timeout's acceptance
			// must not put the sacrifice back over the death veto's dodge (run 4
			// on s5, turn 634: veto said Detect, the standing choice played the
			// Rock Tomb that got Mienshao killed). A hand choice still may.
			console.log('  [standing choice was a timeout; keeping the veto\'s dodge instead of the loss of '
				+ standing.dead.join(', ') + ']');
		} else if (standing) {
			d.best.action = standing.action;
			console.log('  [standing choice: ' + (standing.dead.length
				? 'accepting the loss of ' + standing.dead.join(', ')
				: 'losing nobody') + ']');
		} else {
			if (standingAnswer && standingAnswer.foe === foeName) {
				console.log('  [the outcome you chose ('
					+ (standingAnswer.accept || 'losing nobody')
					+ ') is no longer on offer]');
			}
			// An answer left over from an earlier question would satisfy this
			// one the instant it is asked, and the human would never see it.
			try { fs.unlinkSync(CHOICE); } catch (e) { /* nothing stale */ }
			pendingAsk = {key: positionKey(obs), foe: foeName, options: options,
				asked: Date.now()};
			fs.writeFileSync(ASK, JSON.stringify({
				turn: obs.turn,
				position: speciesName(obs.me.species) + ' (' + obs.me.hp + ') vs '
					+ foeName + ' (' + obs.foe.hp + ')',
				options: options.map(o => ({
					why: o.why, dead: o.dead, total: o.total,
					action: o.action.type === 'switch'
						? 'switch to ' + (st.me.team[o.action.index]
							? st.me.team[o.action.index].set.species : 'slot ' + o.action.index)
						: o.action.move
				}))
			}));
			console.log('\nturn ' + obs.turn + ': the plan expects to lose '
				+ plannerSaid.path.r.dead.join(', ')
				+ ' -- waiting for the panel (' + options.length + ' options)');
			return;
		}
	}

	const us = speciesName(obs.me.species), them = speciesName(obs.foe.species);
	const ourAction = d.best.action.type === 'switch'
		? 'switch ' + d.best.action.index : d.best.action.move;
	const describe = a => !a ? 'none'
		: (a.type === 'switch' ? 'switch ' + a.index : a.move);
	const theirAction = describe(d.theirs);
	const byteSays = describe(d.src.byte);
	const modelSays = describe(d.src.model);
	// Against the ACTIVE foe's max HP. Slot zero's max HP turned every
	// predicted-damage number, and so every recorded damage band, into a
	// fraction of the wrong Pokemon.
	const predOur = Math.round(d.best.theirLoss * st.foe.team[st.foe.active].maxHP);
	const predTheir = Math.round(d.best.myLoss * st.me.team[st.me.active].maxHP);

	console.log('\nturn ' + obs.turn + '  ' + us + ' (' + obs.me.hp + ') vs '
		+ them + ' (' + obs.foe.hp + ')');
	// ONCE per process, not every turn. Printing it on every decision turned a
	// useful warning into a flood.
	if (checkStale() && !staleShown) {
		staleShown = true;
		console.log('  *** STALE: source changed since this process started; it is'
			+ ' running the OLD code. Restart the agent. Rows marked '
			+ VERSION + '-STALE. (said once)');
	}
	console.log('  they will: ' + theirAction
		+ '   [byte ' + byteSays + (d.src.stale ? ' STALE, ignored' : '')
		+ ' | model ' + modelSays + ']');
	console.log('  ' + (plannerSaid
		? (plannerSaid.overridden ? 'PLAN (OVERRIDDEN by the death veto): ' : 'PLAN: ')
			+ plannerSaid.path.cand.why
			+ '   [this kill ' + plannerSaid.path.here.toFixed(2)
			+ ', rest of the fight ' + (plannerSaid.path.ahead === null ? 'not judged' : plannerSaid.path.ahead.toFixed(2))
			// THE PRICED REALITY, next to the label. The label is written by
			// GENERATION, which measures a duel with both Pokemon already on
			// the field; the price is PAID in the real position, where we may
			// have to switch in and eat a hit first. They routinely disagree:
			// sampled over recent turns the label averaged 0% death while the
			// priced line averaged 21%, and one line labelled "0% death"
			// priced at 100% with Victreebel dying. Every log line, and every
			// human read of this agent, has been optimistic by that margin.
			+ (plannerSaid.path.r
				? '; priced death ' + Math.round(100 * plannerSaid.path.r.deathRisk) + '%'
					+ ((plannerSaid.path.r.dead || []).length
						? ' losing ' + plannerSaid.path.r.dead.join(',') : '')
				: '')
			+ ']'
		: 'no plan found, falling back to one-turn scoring'));
	console.log('  [turnsOut: us ' + st.me.team[st.me.active].turnsOut
		+ ', them ' + (st.foe.team[st.foe.active] || {}).turnsOut + ']');
	if (plannerSaid && plannerSaid.margin !== null && plannerSaid.margin !== undefined) {
		// A small margin means the switch bought almost nothing; a negative one
		// means it lost to staying and was taken for a later leg of the plan.
		console.log('  [switch margin ' + plannerSaid.margin.toFixed(2)
			+ ' vs staying in' + (plannerSaid.stay ? ' (' + plannerSaid.stay.why + ')' : '')
			+ (plannerSaid.margin < 0.5 ? '  <-- NEEDLESS?' : '') + ']');
	}
	console.log('  we play: ' + ourAction
		+ (d.best.unknownTarget
			? '   (they are switching, so this lands on whoever comes in)'
			: '   expecting to deal ' + predOur + ' and take ' + predTheir));
	d.all.slice(0, 4).forEach(r => console.log('     ' + String(r.score.toFixed(1)).padStart(7)
		+ '  ' + (r.action.type === 'switch' ? 'switch ' + r.action.index : r.action.move)));

	// THE WHOLE DAMAGE BAND, so the roll INDEX can be recovered from the actual
	// damage. Comparing a single median prediction against reality only ever
	// says "close" or "not close"; with all sixteen values, the actual damage
	// names which roll happened, and that number can be checked directly
	// against draw #4 % 16. That is the experiment that settles the draw
	// ordering rather than gesturing at it.
	// THEIR band too. Only two of twenty-two rows are usable for the draw
	// search, because our attacks mostly KILL and a kill gives a lower bound
	// rather than an exact roll. The damage we TAKE is almost always exact --
	// we rarely faint in these fights -- so logging the opponent's damage band
	// roughly doubles the usable observations per turn from the same play.
	// ALL FOUR of their moves, not just the one we predicted. Twenty rows of
	// opponent bands were unusable because the band recorded belonged to the
	// move we EXPECTED, and the predictor is right about half the time -- so
	// the actual damage matched nothing and every one was discarded. Which move
	// they used is known afterwards from their PP; the band has to be captured
	// beforehand, so capture them all.
	const foeBands = {};
	(obs.foe.moves || []).forEach(id => {
		const nm = moveName(id);
		if (!nm) return;
		try {
			const fr = B.damageRolls(st, 'foe', nm);
			if (fr && !fr.immune) {
				foeBands[nm] = fr.noCrit.join(',');   // whole multi-hit lump already
			}
		} catch (e) { /* status move, no band */ }
	});
	const foeRolls = Object.keys(foeBands).map(k => k + '=' + foeBands[k]);
	const foeCrit = '';

	let rolls = [], critRolls = '';
	if (d.best.action.type === 'move') {
		try {
			const r = B.damageRolls(st, 'me', d.best.action.move);
			if (r && !r.immune) {
				// The band is already the whole multi-hit move; no second multiply.
				rolls = r.noCrit.slice();
				critRolls = r.crit[r.crit.length - 1];
			}
		} catch (e) { /* a status move has no band */ }
	}

	// ARCHIVE THE POSITION. Every turn becomes a replayable case for the
	// mistake finder: what the position was, what we played, and what we
	// expected. Without this a game is watched once and gone, and finding
	// mistakes means somebody sitting there for hours.
	// Remember a protect for the next rebuild; anything else breaks the chain.
	{
		const key = obs.me.maxhp + ':' + obs.me.species;
		const move = d.best.action.type === 'move' ? d.best.action.move : null;
		if (move && PROTECT_MOVES[move] && protectRun.key === key) protectRun.chain += 1;
		else if (move && PROTECT_MOVES[move]) { protectRun.key = key; protectRun.chain = 1; }
		else { protectRun.key = key; protectRun.chain = 0; }
	}
	try {
		// ONE FOLDER PER AGENT SESSION. The Lua's turn counter restarts, so
		// the flat archive silently overwrote old positions as the counter
		// passed their numbers again -- turn00592.json stopped being the
		// Manectric flip-flop evidence and became an unrelated Bellibolt
		// turn, and an hour of regression probes compared different battles.
		// Evidence must be append-only.
		const dir = path.join(DIR, 'turns', SESSION);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
		// HOW LONG EACH SIDE HAD BEEN OUT, recorded so the position can be
		// REPRODUCED. Nothing in the RAM observation carries it -- it is
		// counted by the running agent -- so a probe rebuilt every archived
		// turn with turnsOut 0, made Fake Out legal where live it was not, and
		// answered a different question than the one being investigated. The
		// probe reads these back; HANDOFF's warning about it is now obsolete.
		obs.turnsOut = st.me.team[st.me.active] ? st.me.team[st.me.active].turnsOut : 0;
		obs.foeTurnsOut = st.foe.team[st.foe.active]
			? st.foe.team[st.foe.active].turnsOut : 0;
		fs.writeFileSync(path.join(dir, 'turn' + String(obs.turn).padStart(5, '0') + '.json'),
			JSON.stringify({obs,
				played: ourAction,
				// The switch TARGET by name, not by index. "switch 2" cannot be
				// compared against a recommendation, so the mistake finder was
				// treating every switch as agreeing with every other switch.
				playedMon: d.best.action.type === 'switch'
					? (st.me.team[d.best.action.index]
						&& st.me.team[d.best.action.index].set.species) || null
					: (st.me.team[st.me.active] && st.me.team[st.me.active].set.species) || null,
				predicted: theirAction,
				plan: plannerSaid ? plannerSaid.path.cand.why : null,
				planJobs: plannerSaid ? plannerSaid.path.cand.jobs : null}) + '\n');
	} catch (e) { /* archiving must never break play */ }

	awaiting = {
		turn: obs.turn, us, them, ourAction, theirAction, predOur, predTheir,
		rolls, critRolls, foeRolls, foeCrit,
		byteSays, modelSays, stale: d.src.stale,
		myHP: obs.me.hp, foeHP: obs.foe.hp, rng: obs.rng,
		meSpecies: obs.me.species, foeSpecies: obs.foe.species,
		foePP: obs.foe.pp.slice(), foeMoves: obs.foe.moves.slice(),
		// END-OF-TURN RESIDUAL IS INSIDE THE DAMAGE NUMBER. Damage is measured
		// as HP before minus HP after across the WHOLE turn, so a burn or
		// poison tick is counted as part of the hit. That is exactly why
		// Lanturn's Scald read 45 against a band whose maximum is 40: forty of
		// move damage plus five of burn. Recording the status on both sides
		// lets residual be separated instead of inflating the move.
		foeStatusBefore: obs.foe.status,
		// SIXTY-FOUR DRAWS, not eight. The seed is read at the action menu and
		// the game consumes an unknown number of values before our damage roll
		// -- turn order, accuracy, the opponent's own move, secondary effects.
		// With a window of eight, two of six rows had NO draw position that
		// could explain their roll, so the search had nowhere to succeed. The
		// window has to be wider than the uncertainty it is searching.
		draws: draws(obs.rng, 64).map(v => (v >>> 16))
	};

	let slot = d.best.action.type === 'switch'
		? d.best.action.index
		: st.me.team[st.me.active].set.moves.indexOf(d.best.action.move);
	// THE DISPLAY SLOT IS THE RAM SLOT. Measured, finally, the only way that
	// settles it: the six max HP values logged in the SAME TICK as the
	// screenshot, since each is a unique fingerprint. Screen read Diggersby
	// 48/112, Lanturn 0/139, Mienshao 98/98, Lilligant 0/102, Breloom 0/95,
	// Victreebel 0/108 down the two columns; RAM read 0:48/112 1:0/139 2:98/98
	// 3:0/102 4:0/95 5:0/108. Identity, with nothing swapped.
	//
	// Four different mappings were derived before this, each from a screenshot
	// held next to a RAM read taken a moment apart, and they contradicted each
	// other because the party order moves between those moments. The lesson is
	// the measurement method, not the answer: two observations of a changing
	// thing have to come from the same instant to be compared at all.
	//
	// mySets is itself aligned to RAM order above by level and max HP, so the
	// model index, the RAM slot and the display slot are all the same number.
	// A FAINTED TARGET IS NEVER PLAYABLE. The game answers "X has no energy
	// left to battle!" and sits on the party screen until the watchdog gives
	// up, costing a turn. That is worth catching here even though the mapping
	// is now right, because the cost of being wrong is silent and repeated.
	if (d.best.action.type === 'switch') {
		const tgt = st.me.team[slot];
		if (!tgt || tgt.fainted || tgt.curHP <= 0) {
			console.log('refusing to switch to slot ' + slot + ' -- '
				+ (tgt ? tgt.set.species + ' is fainted' : 'no such Pokemon'));
			return;
		}
	}
	// ANSWER THE QUESTION AS CURRENTLY NUMBERED. The Lua expires a question
	// after 60 seconds and re-asks the SAME position under a new turn id --
	// and it rejects any answer whose id does not match. When a decision runs
	// long, the answer arrives numbered for a question that no longer exists,
	// the Lua re-asks, the node answers one generation behind, forever: cmd
	// turn 615 landed while the question was 617, the fight froze at
	// 'Victreebel vs Bellibolt' for 130 asked-turns, and 'no answer in 60s'
	// filled the log while both sides worked diligently. If the live question
	// is still the same position (same kind, same actives, same HP on both
	// sides), the answer is stamped with ITS number; if the position has
	// actually moved, the stale answer is withheld and the loop decides fresh.
	let answerTurn = obs.turn;
	try {
		const nowQ = readJSONSync(STATE);
		if (nowQ && nowQ.turn !== obs.turn) {
			const same = nowQ.kind === obs.kind
				&& nowQ.me && obs.me && nowQ.me.species === obs.me.species
				&& nowQ.me.hp === obs.me.hp
				&& nowQ.foe && obs.foe && nowQ.foe.species === obs.foe.species
				&& nowQ.foe.hp === obs.foe.hp;
			if (!same) {
				console.log('withholding answer for turn ' + obs.turn
					+ ': the position moved on (question is now turn ' + nowQ.turn + ')');
				return;
			}
			answerTurn = nowQ.turn;
		}
	} catch (e) { /* an unreadable question changes nothing */ }
	// THE ORACLE CHECK (2026-09-08). Before the answer goes out, the chosen
	// action and its rivals are played for real on a windowless copy of this
	// exact position. The battle RNG is restored by the state and consumed per
	// call, so what the copy sees is what the live game will do. Two rules
	// only, both about certainties the market can only guess at:
	//   1. if the chosen action loses one of ours THIS turn and a rival does
	//      not, take the rival that comes out best (kills first, then HP swing);
	//   2. if the chosen action kills nothing and a rival kills their active
	//      while losing nobody and costing no more HP, take the kill.
	// Everything else stays the planner's. Nothing is shown on screen.
	if (process.env.RR_ORACLE !== '0' && ORACLE.available()
		&& fs.existsSync(SNAP) && Math.abs(fs.statSync(SNAP).mtimeMs - fs.statSync(STATE).mtimeMs) < 3000) {
		try {
			const {execFileSync} = require('child_process');
			const runOne = a => {
				const args = [ORACLE.ROM, SNAP, a.type === 'switch' ? 'switch' : 'move', String(a.index)];
				let out = '';
				try { out = execFileSync(ORACLE.BIN, args, {timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}); }
				catch (e) { out = e.stdout ? String(e.stdout) : ''; }
				const r = {action: a, before: null, after: null, error: null};
				out.split('\n').forEach(line => {
					line = line.trim(); if (!line) return;
					let j; try { j = JSON.parse(line); } catch (e) { return; }
					if (j.error) r.error = j.error; else if (j.at) r[j.at] = j;
				});
				return r;
			};
			const chosenA = d.best.action.type === 'switch'
				? {type: 'switch', index: slot} : {type: 'move', index: slot};
			const rivals = [];
			const me = st.me.team[st.me.active];
			(me.set.moves || []).forEach((mv, i) => {
				if (me.pp && me.pp[i] === 0) return;
				if (!(chosenA.type === 'move' && chosenA.index === i)) rivals.push({type: 'move', index: i});
			});
			if (!(st.me.team[st.me.active].volatiles && st.me.team[st.me.active].volatiles.trapped)) {
				st.me.team.forEach((m, i) => {
					if (i === st.me.active || m.fainted || m.curHP <= 0) return;
					if (!(chosenA.type === 'switch' && chosenA.index === i)) rivals.push({type: 'switch', index: i});
				});
			}
			const t0 = Date.now();
			const chosenR = runOne(chosenA);
			const cs = ORACLE.summarize(chosenR);
			const name = a => a.type === 'switch'
				? 'switch ' + (st.me.team[a.index] ? st.me.team[a.index].set.species : a.index)
				: (me.set.moves[a.index] || ('move ' + a.index));
			if (cs.ok) {
				const results = rivals.map(a => ({a, s: ORACLE.summarize(runOne(a))})).filter(x => x.s.ok);
				const value = s => s.theirDead * 1000 + (s.theirLost - s.ourLost);
				const safe = results.filter(x => x.s.ourDead === 0).sort((x, y) => value(y.s) - value(x.s));
				let pick = null, why = '';
				if (cs.ourDead > 0 && safe.length) {
					pick = safe[0]; why = 'the plan\'s ' + name(chosenA) + ' loses ' + cs.ourDead + ' of ours this turn for real';
				} else if (cs.ourDead === 0 && cs.theirDead === 0 && safe.length && safe[0].s.theirDead > 0
					&& safe[0].s.ourLost <= cs.ourLost) {
					pick = safe[0]; why = name(chosenA) + ' kills nothing while a rival kills for real';
				}
				console.log('  [oracle ' + (Date.now() - t0) + 'ms: ' + name(chosenA) + ' -> we lose ' + cs.ourLost
					+ ' HP' + (cs.ourDead ? ' and ' + cs.ourDead + ' Pokemon' : '') + ', they lose ' + cs.theirLost
					+ (cs.theirDead ? ' and ' + cs.theirDead + ' Pokemon' : '') + (cs.foeSwitched ? ', they switch' : '')
					+ (pick ? ' | TAKING ' + name(pick.a) + ' instead: ' + why + ' (they lose ' + pick.s.theirLost
						+ (pick.s.theirDead ? ' and ' + pick.s.theirDead : '') + ', we lose ' + pick.s.ourLost + ')' : '') + ']');
				if (pick) {
					d.best.action = pick.a.type === 'switch'
						? {type: 'switch', index: pick.a.index}
						: {type: 'move', index: pick.a.index, move: me.set.moves[pick.a.index]};
					slot = pick.a.index;
					if (lastPlan) lastPlan.progress = null;
				}
			} else if (chosenR.error) {
				console.log('  [oracle could not play ' + name(chosenA) + ': ' + chosenR.error + ']');
			}
		} catch (e) { console.log('  [oracle failed: ' + e.message + ']'); }
	}
	// INPUT JITTER (2026-09-05). From a save state the game's RNG advances
	// per frame, so identical decisions delivered at identical frames replay
	// identical rolls: runs 2 and 3 on s5 both saw Pawmot crit Mienshao from
	// 84 HP at the same turn. A live human never presses on the same frame
	// twice, so a random delay before the answer is what makes a rehearsal
	// run a fair sample instead of a replay. RR_JITTER_MS=0 disables.
	const JITTER = process.env.RR_JITTER_MS === undefined ? 900 : Number(process.env.RR_JITTER_MS);
	if (JITTER > 0) {
		const ms = Math.floor(Math.random() * JITTER);
		try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no sleep, no harm */ }
	}
	fs.writeFileSync(CMD, JSON.stringify({
		turn: answerTurn,
		action: d.best.action.type === 'switch' ? 'switch' : 'move',
		slot: slot,
		// THE TARGET AS A FINGERPRINT, not just an index. Every switching bug
		// in this file has been an ordering bug: the party is renumbered when
		// a Pokemon comes in, so an index computed here can name someone else
		// by the time the actuator presses A. Max HP and level identify a party
		// member uniquely, so the actuator can resolve them against the very
		// RAM the screen is drawn from and refuse to commit if the slot it is
		// sitting on is not the Pokemon that was chosen.
		// Max HP and level are NOT unique on every team: on 2026-09-02 Ledyba and
		// Froakie were both 41 HP at level 15, the actuator picked Ledyba for a
		// Froakie switch, then tried to switch to the Ledyba already out, forever.
		// The species id is in the same unencrypted record and is the real key.
		wantSpecies: st.me.team[slot] ? speciesIdOf(st.me.team[slot].set.species) : 0,
		wantMax: st.me.team[slot] ? st.me.team[slot].maxHP : 0,
		wantLevel: st.me.team[slot] ? st.me.team[slot].level : 0,
		from: 0
	}) + '\n');
}, 250);
