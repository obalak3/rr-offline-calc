/**
 * Drives the advisor panel in the built page. Run: node tools/test_advisor.js
 *
 * The engine is tested elsewhere; what this checks is the wiring, which is
 * where this project has historically broken. The panel reads your saved team
 * and the selected battle, and every one of those hand-offs is a place where a
 * silent empty list looks like a working page.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const {JSDOM, VirtualConsole, ResourceLoader} = require('jsdom');

const dist = path.join(__dirname, '..', 'upstream-calc/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
	console.error('No build found. Run: npm run build');
	process.exit(1);
}

const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'};
const server = http.createServer((q, s) => {
	const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '');
	fs.readFile(path.join(dist, rel || 'index.html'), (e, b) => {
		if (e) { s.writeHead(404).end(); return; }
		s.writeHead(200, {'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream'});
		s.end(b);
	});
});

let failures = 0;
function check(name, ok, detail) {
	if (!ok) failures++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok && detail) console.log('        ' + detail);
}

const TEAM = [{
	species: 'Squirtle', level: 16, nature: 'Modest', ability: 'Torrent', item: '',
	moves: ['Water Gun', 'Bite', 'Withdraw', 'Rapid Spin'],
	evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
	ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
}, {
	species: 'Pidgey', level: 14, nature: 'Jolly', ability: 'Keen Eye', item: '',
	moves: ['Gust', 'Quick Attack'],
	evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
	ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}
}];

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));

server.listen(0, '127.0.0.1', () => {
	const base = `http://127.0.0.1:${server.address().port}/`;
	const dom = new JSDOM(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), {
		url: base + 'index.html', runScripts: 'dangerously',
		resources: new ResourceLoader(), virtualConsole: vc, pretendToBeVisual: true,
		beforeParse(w) {
			w.matchMedia = () => ({matches: false, media: '', onchange: null,
				addListener() {}, removeListener() {}, addEventListener() {},
				removeEventListener() {}, dispatchEvent() { return false; }});
		}
	});

	dom.window.addEventListener('load', () => setTimeout(() => {
		const {window} = dom;
		const $ = window.jQuery;
		const doc = window.document;

		check('the advisor panel is on the page', !!doc.querySelector('#rr-advisor'));
		for (const name of ['RRBattle', 'RRAI', 'RRPlan', 'RRSolver', 'RRAdvisor']) {
			check('  ' + name + ' is loaded', typeof window[name] !== 'undefined');
		}

		window.localStorage.setItem('rrTeam', JSON.stringify(TEAM));
		// Select Brock the way the trainer panel does.
		let found = null;
		const segs = doc.querySelectorAll('#rr-segments .rr-seg');
		for (let i = 0; i < segs.length && !found; i++) {
			$(segs[i]).trigger('click');
			for (const b of doc.querySelectorAll('#rr-battles .rr-battle')) {
				if (b.getAttribute('data-id') === 'kanto-leaders-brock') {
					$(b).trigger('click'); found = b; break;
				}
			}
		}
		check('Brock can be selected', !!found);
		window.RRAdvisor.refresh();

		check('your team gets a row each (' + $('#rr-adv-mine .rr-adv-mon').length + ')',
			$('#rr-adv-mine .rr-adv-mon').length === TEAM.length);
		check('their team gets a row each (' + $('#rr-adv-theirs .rr-adv-mon').length + ')',
			$('#rr-adv-theirs .rr-adv-mon').length === 4);
		check('each row offers alive, HP and which one is out',
			$('#rr-adv-mine .rr-adv-mon').first().find(
				'.rr-adv-active, .rr-adv-alive, .rr-adv-hp').length === 3);

		const state = window.RRAdvisor.buildState();
		check('a position is built from the two panels', !!state);
		check('  with your Pokemon active',
			window.RRBattle.active(state.me).species === 'Squirtle');
		check('  and theirs',
			window.RRBattle.active(state.foe).species === 'Geodude-Alola');
		check('  at full HP by default',
			window.RRBattle.active(state.me).curHP === window.RRBattle.active(state.me).maxHP);
		check('  in Nuzlocke mode, since the box is checked', state.nuzlocke === true);

		// Current HP has to reach the engine, or advice mid-battle is wrong.
		const myFull = window.RRBattle.active(state.me).maxHP;
		$('#rr-adv-mine .rr-adv-mon').first().find('.rr-adv-hp').val(9);
		check('a typed HP value reaches the position',
			window.RRBattle.active(window.RRAdvisor.buildState().me).curHP === 9);

		// Status has to reach it too.
		$('#rr-adv-mine .rr-adv-mon').first().find('.rr-adv-status').val('par');
		check('a chosen status reaches the position',
			window.RRBattle.active(window.RRAdvisor.buildState().me).status === 'par');
		$('#rr-adv-mine .rr-adv-mon').first().find('.rr-adv-status').val('');
		$('#rr-adv-mine .rr-adv-mon').first().find('.rr-adv-hp').val(myFull);

		// Half way through a fight some of their team is already down. A check
		// that assumes four healthy opponents answers a different question.
		$('#rr-adv-theirs .rr-adv-mon').first().find('.rr-adv-alive')
			.prop('checked', false);
		const partway = window.RRAdvisor.buildState();
		check('an enemy marked down is fainted in the position',
			partway.foe.team[0].fainted === true);
		check('  and something else is out instead (' +
			window.RRBattle.active(partway.foe).species + ')',
			window.RRBattle.active(partway.foe).species === 'Varoom');
		$('#rr-adv-theirs .rr-adv-mon').first().find('.rr-adv-alive').prop('checked', true);

		// A Pokemon you have lost is gone, and must not be offered as a switch.
		$('#rr-adv-mine .rr-adv-mon').last().find('.rr-adv-alive').prop('checked', false);
		const bereaved = window.RRAdvisor.buildState();
		check('a lost Pokemon of yours is fainted in the position',
			bereaved.me.team[1].fainted === true);
		const switches = window.RRBattle.legalActions(bereaved, 'me')
			.filter(a => a.type === 'switch');
		check('  and is not offered as somewhere to switch',
			switches.length === 0, switches.length + ' switches still offered');
		$('#rr-adv-mine .rr-adv-mon').last().find('.rr-adv-alive').prop('checked', true);

		const html = window.RRAdvisor.advice();
		$('#rr-adv-out').html(html);
		const rows = [...doc.querySelectorAll('#rr-adv-out .rr-adv-table tbody tr')];
		check('every option is ranked (' + rows.length + ' rows)',
			rows.length === 5);
		const first = rows[0] ? rows[0].textContent : '';
		// Water Gun is 4x on a Rock/Ground lead; if the panel cannot see that,
		// the wiring is feeding the engine the wrong Pokemon.
		check('the 4x super effective move is recommended first (' +
			first.split('|')[0].trim().slice(0, 40) + ')', /Water Gun/.test(first));
		check('  and it is not reported as losing the Pokemon',
			!/loses this Pokemon/.test(first), first);
		check('switching into a Pokemon that dies is ranked last',
			/Pidgey/.test(rows[rows.length - 1].textContent));
		check('the reading is stated on screen',
			/no crits/.test($('#rr-adv-out').text()));
		check('nothing in your own moveset is unsimulated',
			!/not simulated/i.test($('#rr-adv-out').text()),
			$('#rr-adv-out .rr-adv-caveat').text());

		// A route, always. The old ladder answered "is there a clean route" and
		// returned nothing actionable when it could not tell in time; standing
		// in front of a trainer, the useful question is which line is least bad.
		const route = window.RRAdvisor.route();
		check('a route is always produced (' + route.turns + ' turns)',
			route.steps.length > 0);
		check('  it plays to a finish rather than stopping at a depth limit',
			route.won === true || route.losses > 0 || route.stalled === true,
			JSON.stringify({won: route.won, losses: route.losses, stalled: route.stalled}));
		check('  every step says what to click and what they do',
			route.steps.every(s2 => s2.label && s2.theirLabel && s2.myMon && s2.theirMon));
		check('  and it is fast enough to be usable (' + route.elapsedMs + 'ms)',
			route.elapsedMs < 15000);

		const shown = $('#rr-adv-out').text();
		check('  the outcome is stated up front',
			/Wins in|No winning line|best line/.test(shown), shown.slice(0, 90));
		check('  the turn table is rendered',
			doc.querySelectorAll('#rr-adv-out .rr-adv-table tbody tr').length === route.steps.length);
		check('  and the reading it used is disclosed',
			/damage is read high/.test(shown));

		// 27 of the 167 battles are doubles. Answering the 1v1 question for one of
		// them, confidently, is the worst thing this panel could do.
		$('#rr-adv-mine').empty();
		let sabrina = null;
		const segs2 = doc.querySelectorAll('#rr-segments .rr-seg');
		for (let i = 0; i < segs2.length && !sabrina; i++) {
			$(segs2[i]).trigger('click');
			for (const b of doc.querySelectorAll('#rr-battles .rr-battle')) {
				if (b.getAttribute('data-id') === 'kanto-leaders-sabrina') {
					$(b).trigger('click'); sabrina = b; break;
				}
			}
		}
		check('a doubles battle can be selected', !!sabrina);
		window.RRAdvisor.refresh();
		check('  it is recognised as doubles', window.RRAdvisor.isDoubles() === true);
		check('  both buttons are disabled',
			$('#rr-adv-run').prop('disabled') === true &&
			$('#rr-adv-check').prop('disabled') === true);
		check('  and it says why rather than answering anyway',
			/only understands singles/.test($('#rr-adv-out').text()),
			$('#rr-adv-out').text().slice(0, 90));
		$('#rr-adv-run').trigger('click');
		check('  clicking anyway does not produce a ranking',
			doc.querySelectorAll('#rr-adv-out .rr-adv-table').length === 0);

		check('the page threw no errors', errors.length === 0, errors.slice(0, 2).join('; '));

		console.log('\n%d failure(s)', failures);
		window.close();
		server.close();
		process.exit(failures ? 1 : 0);
	}, 900));
});
