/**
 * Run a plan against the real AI with real dice, and optionally narrate it.
 *
 * Split out of tools/plan_search.js so a plan the search picks can be replayed
 * and READ. James has asked for the full line more than once -- "I am asking
 * for the full line and you aren't giving it to me. Give me the full line. Line
 * by line." -- and a search that can only report a percentage is a search whose
 * answers nobody can check.
 */
'use strict';
const P = require('./policy.js');
const FLAGS = {checkBadMove: true, checkGoodMove: true};

/** ctx: {engine, party, foeSets, expendable[]} */
function playPlan(ctx, plan, opts) {
	const engine = ctx.engine, B = engine.B, RRAI = engine.sandbox.RRAI;
	const party = ctx.party, foeSets = ctx.foeSets;
	const options = opts || {};
	const TRACE = !!options.trace;
	const EXPENDABLE = ctx.expendable || ['Lilligant'];

	function foeChoice(st) {
		const scored = RRAI.scoreAll(st, 'foe', FLAGS, {});
		if (!scored.length) return null;
		let best = -Infinity;
		scored.forEach(e => { if (e.score > best) best = e.score; });
		const ties = scored.filter(e => e.score === best);
		return ties[Math.floor(Math.random() * ties.length)].action;
	}

	function sample(branches) {
		let r = Math.random(), acc = 0;
		for (const b of branches) {
			acc += b.probability === undefined ? 1 / branches.length : b.probability;
			if (r <= acc) return b.state;
		}
		return branches[branches.length - 1].state;
	}

	/** Best remaining damage, used only where the plan has nothing to say. */
	function fallback(st) {
		const legal = B.legalActions(st, 'me').filter(a => a.type === 'move');
		let best = null, bestDmg = -1;
		for (const a of legal) {
			const r = B.damageRolls(st, 'me', a.move);
			const d = r && !r.immune ? r.noCrit[Math.floor(r.noCrit.length / 2)] : 0;
			if (d > bestDmg) { bestDmg = d; best = a; }
		}
		return best || legal[0] || B.legalActions(st, 'me')[0];
	}

	let st = B.createState(party, foeSets, options.stateOpts || {});
	const prog = P.newProgress();
	// The plan picks its own replacement after a faint, which is what the game
	// actually lets you do.
	const chooser = state => {
		const foeSpecies = state.foe.team[state.foe.active].set.species;
		const jobs = plan[foeSpecies] || [];
		for (const job of jobs) {
			const i = state.me.team.findIndex(m => m.set.species === job.mon && !m.fainted);
			if (i >= 0) return i;
		}
		return -1;
	};

	let usedFallback = 0, blockedEntries = 0;
	const trace = [];
	const hp = s => s.me.team.map(m => m.fainted ? 'X' : Math.round(100 * m.curHP / m.maxHP)).join('/')
		+ ' | ' + s.foe.team.map(m => m.fainted ? 'X' : Math.round(100 * m.curHP / m.maxHP)).join('/');

	/**
	 * Would this Pokemon survive coming in against what they are about to do?
	 *
	 * The plan as first written switched to its assigned Pokemon the moment
	 * their active changed, and the first thing that happened every game was
	 * Lilligant switching into Vikavolt's Bug Buzz and dying on the spot, on
	 * turn 3, before it ever clicked the Sleep Powder that was its entire job.
	 * That is the transition cost the plan spec warns about, and it is exactly
	 * the question James asks out loud when he plans a fight: "then I look at
	 * how do I bring in Diggersby without bringing it into death range."
	 *
	 * Read at the high roll but WITHOUT a crit. Crit-proofing every entry makes
	 * every entry unsafe and no plan buildable; ignoring the high roll is how
	 * you lose a Pokemon to a 3-in-16.
	 */
	function survivesEntry(state, index, foeAction) {
		if (!foeAction || foeAction.type === 'switch') return true;   // free turn
		const probe = B.clone(state);
		probe.me.active = index;
		const r = B.damageRolls(probe, 'foe', foeAction.move);
		if (!r || r.immune) return true;
		const worst = r.noCrit[r.noCrit.length - 1];   // already the whole multi-hit lump
		return worst < probe.me.team[index].curHP;
	}

	for (let t = 0; t < 80; t++) {
		if (B.isOver(st)) break;
		if (st.me.team.every(m => m.fainted) || st.foe.team.every(m => m.fainted)) break;
		st.replacementChooser = chooser;
		// Their choice is read FIRST, because ours depends on it. That is the
		// standing doctrine and the one real advantage this project has:
		// "assume one line is true, the line that from your understanding of
		// the AI it will do."
		const theirs = foeChoice(st);
		let mine = P.planAction(engine, st, plan, prog), fell = false;
		if (mine && mine.type === 'switch' && !survivesEntry(st, mine.index, theirs)) {
			// The plan wants a Pokemon in that would die on the way in. Hold it
			// back and let whoever is already out take the turn; the entry
			// becomes free the moment they switch or something faints.
			blockedEntries++;
			mine = null;
		}
		if (!mine) { mine = fallback(st); usedFallback++; fell = true; }
		if (!mine || !theirs) break;
		let out;
		try { out = B.step(st, mine, theirs, {mode: 'odds', forkBudget: 3}); }
		catch (e) { break; }
		if (!out || !out.length) break;
		const before = st;
		st = sample(out);
		if (TRACE) {
			const name = k => before[k].team[before[k].active].set.species;
			const act = (k, a) => a.type === 'switch'
				? '-> ' + before[k].team[a.index].set.species : a.move;
			trace.push('T' + String(t + 1).padStart(2) + '  '
				+ (name('me') + ' ' + act('me', mine) + (fell ? ' (no plan)' : '')).padEnd(34)
				+ (name('foe') + ' ' + act('foe', theirs)).padEnd(30)
				+ hp(st)
				+ (st.field.terrain ? '  ' + st.field.terrain
					+ '(' + st.field.terrainTurns + ')' : ''));
		}
	}
	const won = st.foe.team.every(m => m.fainted);
	const dead = st.me.team.filter(m => m.fainted).map(m => m.set.species);
	return {won, dead, capOK: won && dead.every(n => EXPENDABLE.includes(n)),
		usedFallback, blockedEntries, state: st, trace};
}

module.exports = {playPlan};
