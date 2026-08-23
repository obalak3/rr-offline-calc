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

		check('your team fills the picker (' + $('#rr-adv-mine option').length + ')',
			$('#rr-adv-mine option').length === TEAM.length);
		check('their team fills the picker (' + $('#rr-adv-theirs option').length + ')',
			$('#rr-adv-theirs option').length === 4);

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
		$('#rr-adv-myhp').val(9);
		check('a typed HP value reaches the position',
			window.RRBattle.active(window.RRAdvisor.buildState().me).curHP === 9);
		$('#rr-adv-myhp').val(window.RRBattle.active(state.me).maxHP);

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

		check('the page threw no errors', errors.length === 0, errors.slice(0, 2).join('; '));

		console.log('\n%d failure(s)', failures);
		window.close();
		server.close();
		process.exit(failures ? 1 : 0);
	}, 900));
});
