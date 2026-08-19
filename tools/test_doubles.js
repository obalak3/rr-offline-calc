/**
 * End-to-end check of doubles mode in a real DOM.
 *
 * Doubles was the largest change to the page: two more Pokemon panels built
 * after the calculator had already wired itself up, a facing picker, spread
 * damage, and four sets of results instead of one. Panels created that late do
 * not inherit upstream's own handlers, and every bug in this feature so far has
 * come from that -- empty dropdowns, a set that loads a species but no moves,
 * a "load" button that only ever filled Pokemon 1.
 *
 * So this drives the real thing: turn doubles on, load a doubles battle, choose
 * which two enemies are out, and put a saved Pokemon into each of your slots.
 *
 * Run: node tools/test_doubles.js   (after `npm run build`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const {JSDOM, VirtualConsole, ResourceLoader} = require('jsdom');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'upstream-calc/dist');
const indexPath = path.join(dist, 'index.html');

if (!fs.existsSync(indexPath)) {
	console.error('Built page not found. Run: npm run build');
	process.exit(1);
}

let failures = 0;
const scriptErrors = [];

function check(name, condition, detail) {
	if (condition) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.log(`FAIL  ${name}`);
		if (detail !== undefined) console.log(`        ${detail}`);
	}
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
	if (/googletagmanager|gtag|ERR_|Failed to load/i.test(e.message || '')) return;
	scriptErrors.push(e.message + (e.detail ? '\n' + e.detail : ''));
});

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.png': 'image/png', '.gif': 'image/gif', '.json': 'application/json'
};
const server = http.createServer((req, res) => {
	const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
	const file = path.join(dist, rel || 'index.html');
	if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
	fs.readFile(file, (err, body) => {
		if (err) { res.writeHead(404).end(); return; }
		res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'});
		res.end(body);
	});
});

let dom = null;
server.listen(0, '127.0.0.1', () => {
	const base = `http://127.0.0.1:${server.address().port}/`;
	dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
		url: base + 'index.html',
		runScripts: 'dangerously',
		resources: new ResourceLoader({strictSSL: false}),
		virtualConsole,
		pretendToBeVisual: true,
		beforeParse(w) {
			w.matchMedia = () => ({
				matches: false, media: '', onchange: null,
				addListener() {}, removeListener() {},
				addEventListener() {}, removeEventListener() {},
				dispatchEvent() { return false; }
			});
		}
	});
	dom.window.addEventListener('load', () => setTimeout(run, 600));
});

function run() {
	const {window} = dom;
	const $ = window.jQuery;
	const doc = window.document;
	const T = window.RRTrainers;
	const D = window.RRDoubles;

	check('doubles module loaded', typeof D === 'object');
	check('trainer module loaded', typeof T === 'object');
	if (!D || !T) return finish();

	// --- switching format ------------------------------------------------
	$('#rr-format-doubles').prop('checked', true).change();
	check('doubles mode turns on', D.isActive());
	check('Pokemon 3 panel exists', !!doc.getElementById('p3'));
	check('Pokemon 4 panel exists', !!doc.getElementById('p4'));
	check('the calculator itself is in doubles',
		doc.getElementById('doubles-format').checked);

	// Panels built after boot used to come up with empty dropdowns.
	const p3moves = doc.querySelectorAll('#p3 .move1 select.move-selector option').length;
	const p3species = doc.querySelectorAll('#p3 input.set-selector').length;
	check('Pokemon 3 has a populated move list', p3moves > 100, `got ${p3moves}`);
	check('Pokemon 3 has a set selector', p3species === 1);

	// --- a doubles battle picks the format on its own --------------------
	const data = window.RR_TRAINER_DATA;
	let doublesBattle = null, singlesBattle = null;
	let doublesSeg = 0, singlesSeg = 0;
	data.segments.forEach((seg, index) => {
		for (const b of seg.battles) {
			if (!doublesBattle && T.isDoubles(b)) { doublesBattle = b; doublesSeg = index; }
			if (!singlesBattle && !T.isDoubles(b)) { singlesBattle = b; singlesSeg = index; }
		}
	});
	check('the dataset contains a doubles battle', !!doublesBattle);
	check('the dataset contains a singles battle', !!singlesBattle);

	// A battle is only in the DOM while its own segment tab is showing, so
	// select the tab first. There is no API for this on purpose: clicking is
	// what a user does, and it is the path worth testing.
	function clickBattle(index, battle) {
		$(`.rr-seg[data-seg="${index}"]`).click();
		const el = doc.querySelector(`#rr-battles .rr-battle[data-id="${battle.id}"]`);
		if (!el) return false;
		$(el).click();
		return true;
	}

	if (singlesBattle) {
		$('#rr-format-doubles').prop('checked', true).change();
		check('the singles battle can be clicked',
			clickBattle(singlesSeg, singlesBattle), singlesBattle.id);
		check('a singles battle switches back to singles', !D.isActive(),
			`${singlesBattle.trainer} left the page in doubles`);
	}
	if (doublesBattle) {
		check('the doubles battle can be clicked',
			clickBattle(doublesSeg, doublesBattle), doublesBattle.id);
		check('a doubles battle switches to doubles', D.isActive(),
			`${doublesBattle.trainer} did not switch`);

		// --- choosing which two are out ----------------------------------
		const team = doublesBattle.team;
		if (team.length > 2) {
			T.setFacing([0, 2]);
			const facing = T.getFacing();
			check('the facing picker keeps both choices',
				facing[0] === 0 && facing[1] === 2, JSON.stringify(facing));
			const left = $('#p2 input.set-selector').val();
			const right = $('#p4 input.set-selector').val();
			check('Pokemon 2 holds the first chosen enemy',
				String(left).includes(team[0].species), `${left} vs ${team[0].species}`);
			check('Pokemon 4 holds the second chosen enemy',
				String(right).includes(team[2].species), `${right} vs ${team[2].species}`);
		} else {
			check('the facing picker keeps both choices', true);
			check('Pokemon 2 holds the first chosen enemy', true);
			check('Pokemon 4 holds the second chosen enemy', true);
		}
	}

	// --- your two slots share your level ---------------------------------
	// A copied set brings its own level with it, which put a level 100 partner
	// beside a level 59 lead and made half your damage figures wrong.
	const myLevel = ~~$('#rr-mylevel').val();
	if (myLevel > 0) {
		check('your lead is at your level',
			~~$('#p1 .level').val() === myLevel, `Lv${$('#p1 .level').val()}`);
		check('your partner is at your level too',
			~~$('#p3 .level').val() === myLevel, `Lv${$('#p3 .level').val()}`);
	}

	// --- dropping to one opponent ----------------------------------------
	// Spread moves stop being halved when only one target is left, so the
	// readout has to notice rather than keep quoting doubles damage.
	if (doublesBattle && doublesBattle.team.length > 1) {
		T.setFacing([0]);
		check('dropping an opponent leaves one facing you',
			T.getFacing().length === 1, JSON.stringify(T.getFacing()));
		check('the emptied slot is actually cleared',
			!$('#p4 input.set-selector').val(),
			String($('#p4 input.set-selector').val()));
		const oneOnTwo = doc.getElementById('rr-dbl-combined');
		check('the readout says spread moves are no longer halved',
			!!oneOnTwo && /2v1/.test(oneOnTwo.textContent),
			oneOnTwo && oneOnTwo.textContent.slice(0, 80));
		T.setFacing([0, 1]);
	}

	// --- Minimal Grinding Mode reaches both enemies -----------------------
	// Pokemon 4 is built late, so it was the slot that kept its EVs when the
	// rest of the page had them zeroed.
	const evTotal = (id) => ['hp', 'at', 'df', 'sa', 'sd', 'sp']
		.reduce((n, cls) => n + (~~$(`#${id}`).find('.' + cls + ' .evs').val()), 0);
	const before = [evTotal('p2'), evTotal('p4')];
	$('#rr-mgm').prop('checked', true).change();
	const after = [evTotal('p2'), evTotal('p4')];
	// Vacuous if this battle had no EVs to begin with, so say which it was.
	check('Minimal Grinding Mode zeroes both enemies',
		after[0] === 0 && after[1] === 0,
		`p2 ${before[0]}->${after[0]}, p4 ${before[1]}->${after[1]}`);
	console.log(`      (${doublesBattle ? doublesBattle.trainer : '?'} EVs before: ` +
		`p2 ${before[0]}, p4 ${before[1]})`);
	$('#rr-mgm').prop('checked', false).change();

	// --- My Team into either of your slots -------------------------------
	// The reported bug: in doubles there was no way to fill Pokemon 3.
	T.addTeam([{
		species: 'Gengar', level: 50, nature: 'Timid', ability: 'Levitate',
		item: 'Choice Specs', moves: ['Shadow Ball', 'Sludge Bomb'],
		evs: {hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252},
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
		nickname: 'Spook'
	}]);
	const buttons = doc.querySelectorAll('#rr-team .rr-load-mon');
	check('the team bar offers both of your slots in doubles', buttons.length >= 2,
		`${buttons.length} button(s)`);
	check('the nickname is what the team bar shows',
		/Spook/.test(doc.getElementById('rr-team').textContent));

	// The order that broke it: the team bar is built once, and nothing was
	// redrawing it when the format changed. Add a Pokemon in singles and switch
	// to doubles and its second button never appeared -- and switching back left
	// buttons offering a slot that no longer existed.
	const p3Buttons = () => doc.querySelectorAll('#rr-team .rr-load-mon[data-panel="p3"]').length;
	$('#rr-format-singles').prop('checked', true).change();
	check('singles offers no second slot', p3Buttons() === 0, `${p3Buttons()}`);
	T.addTeam([{
		species: 'Snorlax', level: 50, nature: 'Adamant', ability: 'Immunity',
		item: '', moves: ['Body Slam'],
		evs: {hp: 252, atk: 252, def: 4, spa: 0, spd: 0, spe: 0},
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
	}]);
	check('a Pokemon added in singles still offers no second slot',
		p3Buttons() === 0, `${p3Buttons()}`);
	$('#rr-format-doubles').prop('checked', true).change();
	check('switching to doubles gives every saved Pokemon its second slot',
		p3Buttons() === doc.querySelectorAll('#rr-team .rr-member').length,
		`${p3Buttons()} of ${doc.querySelectorAll('#rr-team .rr-member').length}`);
	$('#rr-format-singles').prop('checked', true).change();
	check('switching back to singles takes them away again',
		p3Buttons() === 0, `${p3Buttons()}`);
	$('#rr-format-doubles').prop('checked', true).change();

	// Redrawing the team bar must not take the importer's output with it.
	$('#rr-save-out').html('<div class="rr-save-msg">Use this save</div>');
	T.refreshTeam();
	check('a redraw keeps the save importer\'s output',
		/Use this save/.test(doc.getElementById('rr-save-out').textContent));

	const toP3 = doc.querySelector('#rr-team .rr-load-mon[data-panel="p3"]');
	check('there is a button targeting Pokemon 3', !!toP3);
	if (toP3) {
		$(toP3).click();
		const name = String($('#p3 input.set-selector').val() || '');
		check('Pokemon 3 receives the saved Pokemon', /Gengar/.test(name), name);
		check('Pokemon 3 receives its level',
			String($('#p3 .level').val()) === '50', String($('#p3 .level').val()));
		// The bug that made this worth testing: species arrived, moves did not.
		const move1 = String($('#p3 .move1 select.move-selector').val() || '');
		check('Pokemon 3 receives its moves too', /Shadow Ball/.test(move1), move1);
		check('Pokemon 3 receives its item',
			/Choice Specs/.test(String($('#p3 .item').val() || '')),
			String($('#p3 .item').val()));
	}

	const toP1 = doc.querySelector('#rr-team .rr-load-mon[data-panel="p1"]');
	if (toP1) {
		$(toP1).click();
		check('Pokemon 1 still receives saved Pokemon',
			/Gengar/.test(String($('#p1 input.set-selector').val() || '')));
	}

	// --- retargeting a move its current target ignores ---------------------
	// The target buttons used to be hidden whenever a move did nothing to the
	// Pokemon it was pointed at, which is backwards: that is the moment you
	// need to aim it elsewhere. Earthquake against a Flying type showed 0 - 0%
	// and no way to point it at the opponent standing next to it.
	const groundImmune = (name) => {
		const entry = window.pokedex[name];
		if (!entry) return false;
		return (entry.types || []).indexOf('Flying') >= 0;
	};
	let immuneCase = null;
	data.segments.forEach((seg, index) => {
		if (immuneCase || !T.isDoubles(seg.battles[0] || {})) { /* keep looking */ }
		for (const b of seg.battles) {
			if (immuneCase || !T.isDoubles(b) || b.team.length < 2) continue;
			for (let i = 0; i < b.team.length && !immuneCase; i++) {
				for (let j = 0; j < b.team.length; j++) {
					if (i === j) continue;
					if (groundImmune(b.team[i].species) && !groundImmune(b.team[j].species)) {
						immuneCase = {index, battle: b, i, j};
						break;
					}
				}
			}
		}
	});
	if (!immuneCase) {
		check('a battle exists with one Ground-immune opponent', false);
	} else {
		clickBattle(immuneCase.index, immuneCase.battle);
		T.setFacing([immuneCase.i, immuneCase.j]);
		T.addTeam([{
			species: 'Hippowdon', level: 50, nature: 'Adamant', ability: 'Sand Stream',
			item: '', moves: ['Earthquake', 'Stone Edge', 'Slack Off', 'Stealth Rock'],
			evs: {hp: 252, atk: 252, def: 4, spa: 0, spd: 0, spe: 0},
			ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
		}]);
		// By name: the team bar already holds the Pokemon added by earlier
		// checks, and the first button is not the one just added.
		const hippo = [...doc.querySelectorAll('#rr-team .rr-load-mon[data-panel="p1"]')]
			.find(b => b.textContent.indexOf('Hippowdon') >= 0);
		check('the Ground attacker is in the team bar', !!hippo);
		if (hippo) $(hippo).click();

		const aim = () => doc.querySelector(".rr-aim[data-panel='p1'][data-move='0']");
		const damage = () => doc.getElementById('resultDamageL1').textContent.trim();
		const buttonFor = (species) => [...(aim() ? aim().querySelectorAll('button') : [])]
			.find(b => b.textContent.indexOf(species) >= 0);

		// Aim it at the one that ignores it. Which target a row starts on is
		// chosen for you, so say it outright rather than assume.
		const immuneButton = buttonFor(immuneCase.battle.team[immuneCase.i].species);
		check('the Ground-immune opponent is offered as a target', !!immuneButton);
		if (immuneButton) $(immuneButton).click();
		check('the move does nothing to the opponent it is aimed at',
			/^0 - 0%/.test(damage()), damage());

		// The bug: at exactly this point the buttons used to disappear.
		const stillThere = aim() ? aim().querySelectorAll('button').length : 0;
		check('it still offers every opponent as a target', stillThere >= 2,
			`${stillThere} button(s)`);

		const otherButton = buttonFor(immuneCase.battle.team[immuneCase.j].species);
		check('including the opponent it would actually hit', !!otherButton);
		if (otherButton) {
			$(otherButton).click();
			check('aiming it there gives a real damage figure',
				!/^0 - 0%/.test(damage()), damage());
		}
	}

	// --- results ---------------------------------------------------------
	// All four Pokemon get their own move list, each row prefixed by its slot.
	const rows = ['L', 'R', 'M', 'N'].map(p =>
		doc.querySelectorAll(`span[id^="resultDamage${p}"]`).length);
	check('every slot has its own four result rows',
		rows.every(n => n === 4), rows.join('/'));

	// Every rendered range has to be a range a move can actually roll. The
	// reported span used to run from the non-crit low roll to the crit high
	// roll, which is 1.77x where a damage roll spans 1.175x.
	const spreads = [];
	for (const p of ['L', 'R', 'M', 'N']) {
		for (let i = 1; i <= 4; i++) {
			const el = doc.getElementById(`resultDamage${p}${i}`);
			if (!el) continue;
			const m = el.textContent.match(/([\d.]+) - ([\d.]+)%/);
			if (!m || Number(m[1]) <= 0) continue;
			spreads.push({row: p + i, min: Number(m[1]),
				ratio: Number(m[2]) / Number(m[1]),
				text: el.textContent.trim()});
		}
	}
	// Only where the numbers are big enough for the bound to mean anything.
	// The 16 rolls span 85-100%, so a range should be about 1.175x wide -- but
	// each roll is floored to a whole point of damage, and at small values that
	// rounding dominates: 8 damage rolls 6 to 8, a ratio of 1.33, and 3 rolls
	// 2 to 3, a ratio of 1.5. Those are correct. Above about a tenth of the
	// target's health the flooring is noise, and the bug this catches -- a
	// range running from the non-crit low roll to the crit high roll, at 1.77x
	// -- showed up on ranges far larger than that.
	const measurable = spreads.filter(s => s.min >= 10);
	const tooWide = measurable.filter(s => s.ratio > 1.25);
	check('every damage range is one a move can actually roll',
		measurable.length > 0 && tooWide.length === 0,
		tooWide.length ? tooWide.map(s => `${s.row} ${s.text}`).join('; ')
			: `(only ${spreads.length} ranges, none above 10%)`);
	check('the crit ceiling is reported outside the range',
		spreads.some(s => /on a crit/.test(s.text)),
		spreads.slice(0, 2).map(s => s.text).join(' | '));

	const damage = doc.getElementById('resultDamageM1');
	check('Pokemon 3 gets a damage figure of its own',
		!!damage && /\d/.test(damage.textContent), damage && damage.textContent);

	const combined = doc.getElementById('rr-dbl-combined');
	check('the combined doubles readout is rendered',
		!!combined && combined.textContent.trim().length > 0,
		combined ? '(empty)' : '(missing)');

	// --- back to singles cleans up ---------------------------------------
	$('#rr-format-singles').prop('checked', true).change();
	check('leaving doubles turns it off', !D.isActive());
	check('leaving doubles hides the extra panels',
		!doc.getElementById('p3') ||
		doc.getElementById('p3').offsetParent === null ||
		$('#p3').is(':hidden') || $('#p3').css('display') === 'none');

	check('no unexpected script errors', scriptErrors.length === 0,
		scriptErrors.slice(0, 3).join('\n        '));
	finish();
}

function finish() {
	console.log(failures === 0
		? '\nDoubles behaves.'
		: `\n${failures} FAILURE(S)`);
	try { dom.window.close(); } catch (e) { /* already gone */ }
	server.close();
	process.exit(failures === 0 ? 0 : 1);
}
