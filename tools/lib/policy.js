/**
 * A plan, as a POLICY TABLE keyed on their active Pokemon.
 *
 * James's insight, and the reason a plan for this fight is tractable at all:
 *
 *   "what if whenever we basically see that an enemy is switching we switch
 *    with it"
 *
 * A plan stored as a sequence of turns is invalidated the moment they rotate,
 * and Surge rotates constantly -- Pincurchin Volt Switches out, Bellibolt comes
 * in and leaves again. A plan stored as "when Pawmot is on the field, Diggersby
 * is our Pokemon and it clicks Bulldoze" is not: their switching then controls
 * only the ORDER in which the duels happen, never whether the plan is valid.
 * Double-switch turns are attack-free, so a switch of theirs we see coming is
 * free repositioning for us.
 *
 * A plan is therefore a map from their species to a list of JOBS. Each job
 * names one of ours, the moves it clicks, and when it hands over. Two jobs is
 * how a prep-then-kill line is written down:
 *
 *   Pawmot: [ {mon: "Lilligant", moves: ["Sleep Powder"], until: {uses: 1}},
 *             {mon: "Diggersby", moves: ["Bulldoze"]} ]
 *
 * which reads exactly like the way he described the fight out loud: sleep it,
 * then bring in the thing that kills it.
 *
 * `until` is what makes a CHIP CHAIN expressible, and chip chains are not
 * optional on this fight. Nothing on the team beats Bellibolt one on one --
 * Parabolic Charge heals it faster than most of us hit -- but Lanturn takes it
 * to 1 HP and anybody finishes. Written down, that is:
 *
 *   Bellibolt: [ {mon: "Lanturn",    moves: ["Scald"], until: {selfHp: 0.35}},
 *                {mon: "Victreebel", moves: ["Leaf Storm"]} ]
 *
 * and it is James's own arithmetic: "compare the damages for each line for
 * different pokemon kills, and see whether the 20 damage gyarados took while
 * killing x and the 40 damage it took to kill y kills it."
 *
 * Supported `until` keys, all checked before the job acts:
 *   uses:      hand over after this many move clicks
 *   selfHp:    hand over once our HP fraction drops to or below this
 *   foeHp:     hand over once THEIR HP fraction drops to or below this
 *   foeStatus: hand over once the foe carries this status
 * A job with no `until` stays until it or the foe faints.
 *
 * The one thing this module deliberately does NOT do is decide anything. It
 * turns a plan into actions and nothing more, so that whether a plan is good is
 * settled by simulating it rather than by an argument about it.
 */
'use strict';

/** Fresh mutable bookkeeping for one execution of one plan. */
function newProgress() { return {job: {}, step: {}}; }

/**
 * The action this plan wants, given the position.
 *
 * Returns null when the plan has nothing to say -- an unassigned foe, or every
 * assigned Pokemon fainted -- which the caller should treat as "fall back",
 * not as "pass". A plan that cannot answer is a plan with a hole in it, and
 * the hole should be visible rather than papered over.
 */
function planAction(engine, state, plan, progress) {
	const B = engine.B;
	const foeSpecies = state.foe.team[state.foe.active].set.species;
	const jobs = plan[foeSpecies];
	if (!jobs || !jobs.length) return null;

	let ji = progress.job[foeSpecies] || 0;
	// Skip past jobs whose Pokemon is dead: a plan built around Lilligant
	// sleeping something has to keep working after Lilligant dies, since the
	// cap explicitly allows that death.
	while (ji < jobs.length && !alive(state, jobs[ji].mon)) ji++;
	if (ji >= jobs.length) { progress.job[foeSpecies] = ji; return null; }
	progress.job[foeSpecies] = ji;

	// Hand over as soon as this job's exit condition is met, so the search can
	// say "chip until you are at a third and then get out" rather than only
	// "fight until something dies".
	while (ji < jobs.length - 1 && jobDone(state, jobs[ji], progress, foeSpecies, ji)) {
		ji++;
		while (ji < jobs.length && !alive(state, jobs[ji].mon)) ji++;
	}
	if (ji >= jobs.length) { progress.job[foeSpecies] = ji; return null; }
	progress.job[foeSpecies] = ji;

	const job = jobs[ji];
	const idx = state.me.team.findIndex(m => m.set.species === job.mon && !m.fainted);
	if (idx < 0) return null;

	const legal = B.legalActions(state, 'me');
	if (state.me.active !== idx) {
		const sw = legal.find(a => a.type === 'switch' && a.index === idx);
		return sw || null;
	}

	const key = foeSpecies + '/' + ji;
	const step = progress.step[key] || 0;
	if (!job.moves || !job.moves.length) {
		// Entry-only job whose mon is already in: nothing to click, hand over.
		if (ji + 1 < jobs.length) {
			progress.job[foeSpecies] = ji + 1;
			return planAction(engine, state, plan, progress);
		}
		return null;
	}
	const want = job.moves[Math.min(step, job.moves.length - 1)];
	// "*" means click whatever hits hardest right now, re-decided every turn.
	// A fixed move is the right way to write down a lever -- Sleep Powder means
	// Sleep Powder -- and the wrong way to write down a kill. Victreebel's job
	// was "Leaf Storm", which lowers its own Sp. Atk by two stages, so the
	// second click did nothing at all and it stood there repeating a move it
	// had already ruined while Pawmot finished it off, one turn from the kill.
	const move = want === '*' ? bestDamage(engine, state, legal)
		: legal.find(a => a.type === 'move' && a.move === want);
	if (!move) {
		// Out of PP, or taunted, or the move does not exist on this Pokemon.
		// Advancing rather than failing lets a two-move job degrade into its
		// second move instead of stalling on an impossible first.
		if (step < job.moves.length - 1) {
			progress.step[key] = step + 1;
			return planAction(engine, state, plan, progress);
		}
		return null;
	}
	progress.step[key] = step + 1;
	return move;
}

/**
 * Is this job finished?
 *
 * Only asked of jobs that still have a successor: the last job in a list has
 * nowhere to hand over to and stays in regardless, which is what stops a plan
 * from walking off the end of itself the moment a threshold trips.
 */
function jobDone(state, job, progress, foeSpecies, ji) {
	const until = job.until;
	if (!until) return false;
	const mine = state.me.team.find(m => m.set.species === job.mon);
	const foe = state.foe.team[state.foe.active];
	if (until.uses !== undefined) {
		if ((progress.step[foeSpecies + '/' + ji] || 0) >= until.uses) return true;
	}
	if (until.selfHp !== undefined && mine && !mine.fainted
		&& mine.curHP / mine.maxHP <= until.selfHp) return true;
	if (until.foeHp !== undefined && foe.curHP / foe.maxHP <= until.foeHp) return true;
	if (until.foeStatus !== undefined && foe.status === until.foeStatus) return true;
	if (until.foeVolatile !== undefined && foe.volatiles
		&& foe.volatiles[until.foeVolatile]) return true;
	if (until.foeBoost !== undefined) {
		// "keep clicking this until their Attack is at -2", which is how a
		// stackable drop is written down. atMost is the stage to reach.
		const cur = foe.boosts[until.foeBoost.stat] || 0;
		if (until.foeBoost.atMost <= 0 ? cur <= until.foeBoost.atMost
			: cur >= until.foeBoost.atMost) return true;
	}
	if (until.entered) {
		// An ENTRY job: its whole purpose is to arrive, fire an entry ability
		// and hand straight back. Stacking Intimidate is a list of these
		// alternating with the Pokemon it is protecting, which is the shape of
		// the manoeuvre rather than a special case for one ability.
		if (mine && state.me.team[state.me.active] === mine) return true;
	}
	return false;
}

/**
 * The move a person would actually click here.
 *
 * Not simply the biggest number. Against a Pokemon at 6 HP that outspeeds us,
 * the biggest number is Bullet Seed and the right answer is Mach Punch, because
 * one of them kills before it can act and the other lets it kill us first. That
 * distinction is invisible to raw damage and obvious at the table, which is the
 * whole class of thing this planner exists to capture.
 *
 * So: prefer a move that KILLS; among killing moves prefer priority when we are
 * slower, since a kill we do not live to land is not a kill; otherwise take the
 * damage. Reads at the median, like everything else in a plan.
 */
function bestDamage(engine, state, legal) {
	const B = engine.B;
	const foe = state.foe.team[state.foe.active];
	const slower = B.finalSpeed(state, 'me') <= B.finalSpeed(state, 'foe');
	let best = null, bestKey = null;
	legal.filter(a => a.type === 'move').forEach(a => {
		const r = B.damageRolls(state, 'me', a.move);
		if (!r || r.immune) return;
		const band = r.noCrit;
		const dmg = band[Math.floor(band.length / 2)] * (r.hits || 1);
		// Priority comes off the move data. The engine keeps actionPriority
		// internal, and its answer for a move action is exactly this.
		const info = B.moveData(a.move);
		const priority = info ? (info.priority || 0) : 0;
		const kills = dmg >= foe.curHP;
		const key = [
			kills ? 1 : 0,
			kills && slower && priority > 0 ? 1 : 0,
			dmg
		];
		if (!bestKey || compare(key, bestKey) > 0) { bestKey = key; best = a; }
	});
	return best;
}

function compare(a, b) {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

function alive(state, species) {
	return state.me.team.some(m => m.set.species === species && !m.fainted);
}

/** Human-readable, because James reads plans line by line and asks for them. */
function describe(plan) {
	return Object.keys(plan).map(foe =>
		'  vs ' + foe.padEnd(16) + (plan[foe].length ? plan[foe].map(j =>
			j.mon + ' ' + j.moves.join('>')
			+ (j.until ? ' [until ' + Object.keys(j.until)
				.map(k => k + ' ' + j.until[k]).join(', ') + ']' : '')
			).join('  then  ') : '(no plan)')).join('\n');
}

module.exports = {newProgress, planAction, describe};
