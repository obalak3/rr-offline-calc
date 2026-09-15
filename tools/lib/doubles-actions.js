'use strict';
/**
 * WHAT CAN WE DO THIS TURN, in a double battle.
 *
 * Kept apart from choosing, the same split candidates.js has in singles: this
 * file is generous and literal, and says nothing about whether an idea is any
 * good. A doubles turn is a JOINT action -- what our left Pokemon does and
 * what our right one does -- so the space is the product of the two, which is
 * why the caller has to prune it before playing every one on the hidden game.
 *
 * Battler indices, from docs/SCREEN-MAP.md: 0 ours left, 1 theirs left,
 * 2 ours right, 3 theirs right.
 */

const TARGETABLE_FOES = [1, 3];
const OUR_SLOTS = [0, 2];

/** Does this move ask the target picker, and if so what may it point at? */
function targetsFor(moveTarget, alive, mine) {
	switch (moveTarget) {
		case 'selected':
			// Either living opponent, or our own partner. Hitting the partner is
			// legal and occasionally right (waking it, Beat Up, a pinch berry),
			// but it is not offered by default.
			return alive.foes.slice();
		case 'allFoes':
		case 'allAdjacent':
		case 'foeSide':
		case 'self':
		case 'random':
		case 'special':
			return [null];          // no picker, or nothing to choose
		case 'ally':
			return alive.ally(mine) ? [alive.partnerOf(mine)] : [];
		default:
			return alive.foes.slice();
	}
}

/**
 * Every legal action for one of ours, as {type, index, target, label}.
 *
 * `mon` is the battler record from the oracle's obs (species, hp, moves, pp),
 * `moveInfo(id)` returns {name, target, power} for a move id, and `party` is
 * the six party rows with a `species`/`maxhp`/`hp` each.
 */
function actionsFor(battler, mon, moveInfo, party, onField, alive, opts) {
	opts = opts || {};
	const out = [];
	if (!mon || mon.hp <= 0) return out;

	(mon.moves || []).forEach((id, i) => {
		if (!id) return;
		if (mon.pp && mon.pp[i] === 0) return;
		const info = moveInfo(id) || {name: 'move ' + i, target: 'selected'};
		const targets = targetsFor(info.target, alive, battler);
		targets.forEach(t => {
			out.push({
				type: 'move', index: i, target: t === undefined ? null : t,
				label: info.name + (t === null || t === undefined ? '' : ' at ' + (opts.name ? opts.name(t) : 'battler ' + t)),
				move: info.name, moveTarget: info.target, spread: info.target === 'allFoes' || info.target === 'allAdjacent',
				// Focus fire means BOTH attacking; a status move aimed at a target is
				// still covered by rule 1, it just does not belong in that product.
				status: info.split === 'Status' || !info.power
			});
		});
	});

	if (!opts.noSwitch) {
		party.forEach((p, slot) => {
			if (!p || p.hp <= 0) return;
			if (onField.has(slot)) return;
			out.push({
				type: 'switch', index: slot, target: null,
				label: '-> ' + (opts.partyName ? opts.partyName(slot) : ('slot ' + slot)),
				species: p.species
			});
		});
	}
	return out;
}

/**
 * The joint actions. `asked` says which of ours the game is actually waiting
 * on (both, or just one in a 2v1), and the two lists are combined minus the
 * pairs the game would refuse.
 */
function jointActions(left, right, asked) {
	const out = [];
	const ls = asked.includes(0) ? left : [null];
    const rs = asked.includes(2) ? right : [null];
	ls.forEach(a0 => {
		rs.forEach(a2 => {
			// Both cannot bring in the same Pokemon.
			if (a0 && a2 && a0.type === 'switch' && a2.type === 'switch' && a0.index === a2.index) return;
			out.push({a0, a2});
		});
	});
	return out;
}

/**
 * A PORTFOLIO, not a top-N list.
 *
 * The first draft of the plan said "rank every joint action by damage and play
 * the best 16", and that is the value model in disguise. MEASURED 2026-09-14 on
 * the Game Corner guard's opening position: playing all 128 legal joint actions
 * found "Bug Buzz at Aerodactyl + Water Shuriken at Aerodactyl", which removes
 * Aerodactyl and costs us NOTHING, because Water Shuriken has priority and
 * Aerodactyl dies before it moves. A 14-pair portfolio ranked by move power
 * missed it entirely and offered a line costing 193 HP, because Scald (80 BP)
 * outranks Water Shuriken (15 BP) as the focus-fire representative.
 *
 * The lesson is not "use better damage numbers". No cheap ranking sees TURN
 * ORDER, and turn order is what decides a doubles turn. So the portfolio is
 * built on guarantees rather than on a score:
 *
 *   1. COVERAGE. Every legal action of each of ours appears in at least one
 *      pair that gets played. A priority move can then never be ranked out.
 *   2. SHAPES. Focus fire onto each opponent, one onto each, every spread
 *      move, every switch beside the partner's best attack.
 *   3. FILL, by `rank`, until the budget is spent.
 *
 * `rank(pair)` therefore decides only the fill and the representative of a
 * shape, never whether an action is seen at all.
 */
function portfolio(pairs, rank, budget) {
	const key = p => (p.a0 ? p.a0.type + p.a0.index + ':' + p.a0.target : '-') + '|'
		+ (p.a2 ? p.a2.type + p.a2.index + ':' + p.a2.target : '-');
	const akey = a => a ? a.type + a.index + ':' + a.target : '-';
	const picked = new Map();
	const take = p => { if (p && !picked.has(key(p))) picked.set(key(p), p); };
	const sorted = pairs.slice().sort((x, y) => rank(y) - rank(x));
	const best = pred => sorted.find(pred);

	const isAtk = a => a && a.type === 'move' && a.target !== null && !a.status;
	const isSwitch = a => a && a.type === 'switch';
	const isSpread = a => a && a.type === 'move' && a.spread;

	// 1. COVERAGE FIRST. Each side's actions, paired with the other side's
	//    best-ranked partner for that action, so nothing is invisible.
	['a0', 'a2'].forEach(mine => {
		const seen = new Set();
		sorted.forEach(p => {
			const a = p[mine];
			if (!a || seen.has(akey(a))) return;
			seen.add(akey(a));
			take(best(x => x[mine] && akey(x[mine]) === akey(a)) || p);
		});
	});

	// 2. SHAPES.
	const foes = new Set();
	pairs.forEach(p => { [p.a0, p.a2].forEach(a => { if (a && a.type === 'move' && a.target !== null && a.target !== undefined) foes.add(a.target); }); });
	// EVERY ATTACK AGAINST EVERY ATTACK, IN FULL. Two measurements, two fights,
	// the same lesson: sampling a shape by its damage loses the turn.
	//   ss7 (Game Corner guard): the best line was Bug Buzz and Water Shuriken
	//     onto Aerodactyl -- it dies before it moves because Water Shuriken has
	//     priority -- and a portfolio that picked the focus-fire representative
	//     by power chose Scald (80 BP over 15) and paid 193 HP for it.
	//   ss8 (Rocket Hideout left guard): the best line was Extrasensory into
	//     Weezing-Galar while Fake Out FLINCHED Slaking, costing nothing; the
	//     sampled split shape took Brick Break (75 BP over 40) and paid 90.
	// Neither priority nor a flinch is visible to any cheap ranking, and both
	// live in the PAIR rather than in either action. So the attack-against-
	// attack product is played in full: it is about half the legal space, it is
	// where the turn is decided, and it is the part no heuristic has survived.
	pairs.forEach(x => { if (isAtk(x.a0) && isAtk(x.a2)) take(x); });

	['a0', 'a2'].forEach(mine => {
		const other = mine === 'a0' ? 'a2' : 'a0';
		const seenSpread = new Set(), seenSw = new Set();
		sorted.forEach(p => {
			const a = p[mine];
			if (isSpread(a) && !seenSpread.has(a.index)) {
				seenSpread.add(a.index);
				take(best(x => x[mine] && x[mine].index === a.index && x[mine].type === 'move' && isAtk(x[other])));
				take(best(x => x[mine] && x[mine].index === a.index && x[mine].type === 'move' && isSwitch(x[other])));
			}
			if (isSwitch(a) && !seenSw.has(a.index)) {
				seenSw.add(a.index);
				take(best(x => isSwitch(x[mine]) && x[mine].index === a.index && isAtk(x[other])));
			}
		});
	});

	// 3. FILL.
	for (const p of sorted) {
		if (picked.size >= budget) break;
		take(p);
	}
	return Array.from(picked.values()).slice(0, Math.max(budget, picked.size));
}

/**
 * What the portfolio guarantees, so a caller can assert it rather than hope.
 * Returns the actions that were NOT represented in the played set.
 */
function coverageGaps(pairs, played) {
	const akey = a => a ? a.type + a.index + ':' + a.target : '-';
	const want = new Set();
	pairs.forEach(p => { if (p.a0) want.add('0/' + akey(p.a0)); if (p.a2) want.add('2/' + akey(p.a2)); });
	played.forEach(p => { if (p.a0) want.delete('0/' + akey(p.a0)); if (p.a2) want.delete('2/' + akey(p.a2)); });
	return Array.from(want);
}

module.exports = {actionsFor, jointActions, portfolio, coverageGaps, targetsFor, TARGETABLE_FOES, OUR_SLOTS};
