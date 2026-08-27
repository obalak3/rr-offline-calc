/**
 * What can this team DO to a battle, other than damage?
 *
 * Derived, never listed. Hand a pair of teams in and this reads their moves,
 * abilities and items out of the data and returns the set of state changes they
 * can actually produce. Nothing here knows what fight it is looking at, which
 * is the point:
 *
 *   "the thing shouldn't be about these things specifically. The model should
 *    look at what tools each team has when it is inputted, and derive a
 *    strategy using those specifically"
 *
 * The version this replaces had two hardcoded arrays -- SLOW_MOVES and
 * SLEEP_MOVES -- and a condition vocabulary of three ideas. On a team whose
 * answer to a physical attacker is Baby-Doll Eyes, a Scald burn, Intimidate
 * cycling or Confuse Ray, that planner cannot express the answer, so it cannot
 * find it. James named the failure exactly: "If we can't detect that pawmot
 * should get -2 intimidate ... and we should switch etc and defeat it then
 * doing this has no point."
 *
 * A LEVER is one repeatable way to change the position:
 *
 *   {mon, label, via, move?, chance, repeatable, effect}
 *
 * where `effect` is expressed in the same vocabulary a duel entry condition
 * uses -- foeBoosts, foeStatus, foeVolatiles, ourBoosts, ourStatusCure, heal --
 * so a lever and the condition it produces are the same language.
 */
'use strict';

const movesOf = p => p.moves || (p.set && p.set.moves) || [];
const abilityOf = p => p.ability || (p.set && p.set.ability) || '';
const itemOf = p => p.item || (p.set && p.set.item) || '';
const speciesOf = p => p.species || (p.set && p.set.species) || '';

/**
 * Abilities that change the position simply by ARRIVING.
 *
 * Read off the ability's own data where the engine models it, so this list is
 * about which entry effects are worth planning AROUND rather than which exist.
 * The value is the effect in entry-condition vocabulary, and every one of them
 * is repeatable by switching out and back in -- which is the mechanic James
 * pointed at, and the reason `repeatable` exists as a field.
 */
const ENTRY_ABILITIES = {
	'Intimidate': {foeBoosts: {atk: -1}},
	'Supersweet Syrup': {foeBoosts: {eva: -1}},
	'Intrepid Sword': {ourBoosts: {atk: 1}},
	'Dauntless Shield': {ourBoosts: {def: 1}},
	'Download': {ourBoosts: {atk: 1}},
	'Competitive': {ourBoosts: {spa: 2}},
	'Defiant': {ourBoosts: {atk: 2}}
};

/** Abilities that turn one of the foe's types into nothing, or into healing. */
const ABSORB_ABILITIES = {
	'Volt Absorb': {type: 'Electric', heals: true},
	'Water Absorb': {type: 'Water', heals: true},
	'Earth Eater': {type: 'Ground', heals: true},
	'Flash Fire': {type: 'Fire', heals: false},
	'Lightning Rod': {type: 'Electric', heals: false},
	'Storm Drain': {type: 'Water', heals: false},
	'Motor Drive': {type: 'Electric', heals: false},
	'Sap Sipper': {type: 'Grass', heals: false},
	'Levitate': {type: 'Ground', heals: false},
	'Dry Skin': {type: 'Water', heals: true},
	'Well-Baked Body': {type: 'Fire', heals: false},
	'Wind Rider': {type: 'Flying', heals: false}
};

/** Abilities that fire when the foe makes contact with us. */
const CONTACT_ABILITIES = {
	'Effect Spore': {chance: 0.3, label: 'random status on contact'},
	'Static': {chance: 0.3, effect: {foeStatus: 'par'}},
	'Flame Body': {chance: 0.3, effect: {foeStatus: 'brn'}},
	'Poison Point': {chance: 0.3, effect: {foeStatus: 'psn'}},
	'Cute Charm': {chance: 0.3, label: 'infatuation on contact'},
	'Rough Skin': {chance: 1, label: 'chip on contact'},
	'Iron Barbs': {chance: 1, label: 'chip on contact'},
	'Gooey': {chance: 1, effect: {foeBoosts: {spe: -1}}},
	'Tangling Hair': {chance: 1, effect: {foeBoosts: {spe: -1}}}
};

/** Statuses and volatiles worth planning toward, with what they buy. */
const STATUS_VALUE = {
	brn: 'halves physical attack and chips',
	par: 'halves speed and skips turns',
	slp: 'skips turns entirely',
	frz: 'skips turns entirely',
	psn: 'chips',
	tox: 'chips, accelerating',
	frb: 'halves special attack and chips'
};

/**
 * Every lever this side can pull, read out of its own moves and abilities.
 */
function leversFor(engine, team) {
	const ME = engine.sandbox.RR_MOVE_EFFECTS.moves;
	const out = [];

	team.forEach(p => {
		const who = speciesOf(p);

		// --- abilities -------------------------------------------------------
		const ability = abilityOf(p);
		if (ENTRY_ABILITIES[ability]) {
			out.push({
				mon: who, via: 'entry-ability', label: ability + ' on entry',
				chance: 1, repeatable: true, cost: 'a switch',
				effect: ENTRY_ABILITIES[ability]
			});
		}
		if (ABSORB_ABILITIES[ability]) {
			const a = ABSORB_ABILITIES[ability];
			out.push({
				mon: who, via: 'absorb-ability',
				label: ability + ' voids ' + a.type + (a.heals ? ' and heals' : ''),
				chance: 1, repeatable: true, absorbs: a.type, heals: a.heals,
				effect: {}
			});
		}
		if (CONTACT_ABILITIES[ability]) {
			const c = CONTACT_ABILITIES[ability];
			out.push({
				mon: who, via: 'contact-ability',
				label: ability + ' (' + (c.label || describeEffect(c.effect)) + ')',
				chance: c.chance, repeatable: true, effect: c.effect || {}
			});
		}

		// --- moves -----------------------------------------------------------
		movesOf(p).forEach(name => {
			const d = ME[name];
			if (!d) return;
			const isStatusMove = d.split === 'Status';
			const eff = d.effect;

			// A move whose whole job is a state change.
			if (eff && eff.kind === 'boost') {
				const target = eff.target === 'self' ? 'ourBoosts' : 'foeBoosts';
				out.push(lever(who, name, target, eff.boosts, 1, isStatusMove, d));
			}
			if (eff && eff.kind === 'status') {
				out.push(lever(who, name, 'foeStatus', eff.status,
					accuracyOf(d), isStatusMove, d));
			}
			if (eff && eff.kind === 'confuseBoost') {
				if (eff.confuses) {
					out.push(lever(who, name, 'foeVolatiles', {confusion: 3},
						accuracyOf(d), isStatusMove, d));
				}
				if (eff.boosts && Object.keys(eff.boosts).length) {
					out.push(lever(who, name,
						eff.target === 'self' ? 'ourBoosts' : 'foeBoosts',
						eff.boosts, accuracyOf(d), isStatusMove, d));
				}
			}
			if (eff && eff.kind === 'heal') {
				out.push({mon: who, via: 'move', move: name,
					label: name + ' heals ' + Math.round((eff.fraction || 0.5) * 100) + '%',
					chance: 1, repeatable: true, heals: eff.fraction || 0.5, effect: {}});
			}
			if (eff && eff.kind === 'protect') {
				out.push({mon: who, via: 'move', move: name,
					label: name + ' skips a turn safely',
					chance: 1, repeatable: false, protects: true, effect: {}});
			}
			if (eff && eff.kind === 'leechSeed') {
				out.push({mon: who, via: 'move', move: name,
					label: name + ' drains every turn',
					chance: accuracyOf(d), repeatable: false,
					effect: {foeVolatiles: {leechSeed: true}}});
			}
			if (eff && eff.kind === 'removeItem') {
				out.push({mon: who, via: 'move', move: name,
					label: name + ' removes their item, permanently',
					chance: accuracyOf(d), repeatable: false, effect: {}});
			}
			if (eff && eff.kind === 'selfSwitch') {
				out.push({mon: who, via: 'move', move: name,
					label: name + ' attacks and leaves, so the next entry is free',
					chance: accuracyOf(d), repeatable: true, pivots: true, effect: {}});
			}

			// A state change riding on an attack. Chance-gated, which is not a
			// reason to exclude it: a 30% burn clicked four times is a 76% burn,
			// and "click it until it lands" is a job the plan can express.
			const sec = eff && eff.kind === 'secondary' ? eff.secondary : null;
			if (sec) {
				const chance = eff.guaranteed ? 1
					: (d.secondaryChance ? d.secondaryChance / 100 : 1) * accuracyOf(d);
				if (sec.status) {
					out.push(lever(who, name, 'foeStatus', sec.status, chance, false, d));
				}
				if (sec.boosts) {
					out.push(lever(who, name,
						sec.target === 'self' ? 'ourBoosts' : 'foeBoosts',
						sec.boosts, chance, false, d));
				}
				if (sec.confuse) {
					out.push(lever(who, name, 'foeVolatiles', {confusion: 3}, chance, false, d));
				}
				if (sec.flinch) {
					out.push({mon: who, via: 'move', move: name,
						label: name + ' flinches (' + Math.round(chance * 100) + '%)',
						chance: chance, repeatable: !eff.firstTurnOnly,
						flinches: true, effect: {}});
				}
			}
		});

		// --- items -----------------------------------------------------------
		const item = itemOf(p);
		if (item) out.push({mon: who, via: 'item', label: item, chance: 1,
			repeatable: false, item: item, effect: {}});
	});
	return out;
}

function accuracyOf(d) {
	return d.accuracy === null || d.accuracy === undefined ? 1 : d.accuracy / 100;
}

function lever(who, move, field, value, chance, isStatusMove, d) {
	const effect = {};
	effect[field] = value;
	return {
		mon: who, via: 'move', move: move,
		label: move + ' -> ' + describeEffect(effect)
			+ (chance < 1 ? ' (' + Math.round(chance * 100) + '%)' : ''),
		chance: chance,
		// A stat drop can be stacked; a status cannot be applied twice.
		repeatable: field === 'foeBoosts' || field === 'ourBoosts',
		free: isStatusMove === false,   // rode on an attack, so it cost no turn
		effect: effect
	};
}

function describeEffect(effect) {
	if (!effect) return '?';
	const bits = [];
	if (effect.foeBoosts) {
		for (const k in effect.foeBoosts) {
			bits.push('their ' + k + ' ' + signed(effect.foeBoosts[k]));
		}
	}
	if (effect.ourBoosts) {
		for (const k in effect.ourBoosts) bits.push('our ' + k + ' ' + signed(effect.ourBoosts[k]));
	}
	if (effect.foeStatus) {
		bits.push(effect.foeStatus + (STATUS_VALUE[effect.foeStatus]
			? ' (' + STATUS_VALUE[effect.foeStatus] + ')' : ''));
	}
	if (effect.foeVolatiles) for (const k in effect.foeVolatiles) bits.push('their ' + k);
	return bits.join(', ') || 'no state change';
}

function signed(n) { return n > 0 ? '+' + n : '' + n; }

/** Merge lever effects into one entry condition. */
function combine(levers) {
	const cond = {foeBoosts: {}, ourBoosts: {}};
	levers.forEach(l => {
		const e = l.effect || {};
		for (const k in (e.foeBoosts || {})) {
			cond.foeBoosts[k] = (cond.foeBoosts[k] || 0) + e.foeBoosts[k];
		}
		for (const k in (e.ourBoosts || {})) {
			cond.ourBoosts[k] = (cond.ourBoosts[k] || 0) + e.ourBoosts[k];
		}
		if (e.foeStatus) cond.foeStatus = e.foeStatus;
		if (e.foeVolatiles) cond.foeVolatiles = Object.assign(cond.foeVolatiles || {}, e.foeVolatiles);
	});
	if (!Object.keys(cond.foeBoosts).length) delete cond.foeBoosts;
	if (!Object.keys(cond.ourBoosts).length) delete cond.ourBoosts;
	return cond;
}

module.exports = {leversFor, combine, describeEffect, STATUS_VALUE,
	ABSORB_ABILITIES, ENTRY_ABILITIES, CONTACT_ABILITIES};
