/**
 * Importing a save by dropping it on the page.
 *
 * OpenEmu writes battery saves under ~/Library/Application Support, which
 * Finder hides, so reaching one through a file dialog means typing a path every
 * single time. Dropping the file on the trainer panel skips that, and this
 * checks the whole path end to end.
 *
 * It exists because of a specific bug. Species data lives in a 3.9 MB bundle
 * the page only pulls in the first time the Pokedex is opened, so importing
 * before ever opening it failed with "the Pokedex data has not loaded yet" --
 * accurate, useless, and not the user's problem to solve. The importer now
 * loads the bundle itself, and the retry is bounded, because a version that
 * asked again on failure span forever.
 *
 * Its own harness rather than a section of test_page.js: parsing that bundle in
 * jsdom is slow, and drastically slower in a document that has already had a
 * hundred battles clicked through it.
 *
 * Run: node tools/test_import.js   (needs ~/RadicalRed.sav, or pass a .sav)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {JSDOM, VirtualConsole, ResourceLoader} = require('jsdom');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'upstream-calc/dist');
const indexPath = path.join(dist, 'index.html');

const savePath = process.argv[2] || path.join(os.homedir(), 'RadicalRed.sav');
if (!fs.existsSync(savePath)) {
	console.log(`No save at ${savePath}; skipping (run: node tools/link_save.js).`);
	process.exit(0);
}
if (!fs.existsSync(indexPath)) {
	console.error('Built page not found. Run: npm run build');
	process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.log(`FAIL  ${name}`);
		if (detail !== undefined) console.log(`        ${detail}`);
	}
}

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.png': 'image/png', '.gif': 'image/gif'
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
		virtualConsole: new VirtualConsole(),
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

async function run() {
	const {window} = dom;
	const doc = window.document;
	const panel = doc.getElementById('rr-panel');
	check('the trainer panel is there to drop onto', !!panel);
	if (!panel) return finish();

	// Nothing has opened the Pokedex, so the species bundle is not loaded --
	// which is the state the bug lived in.
	check('the species bundle really is not loaded yet',
		typeof window.RR_DEX_DATA === 'undefined');

	const bytes = fs.readFileSync(savePath);
	const file = new window.File([new Uint8Array(bytes)], path.basename(savePath));
	const dataTransfer = {types: ['Files'], files: [file]};
	const fire = (type) => {
		const ev = new window.Event(type, {bubbles: true, cancelable: true});
		ev.dataTransfer = dataTransfer;
		panel.dispatchEvent(ev);
		return ev;
	};

	fire('dragenter');
	check('the panel shows it will take the drop',
		panel.className.includes('rr-dropping'));
	const dropped = fire('drop');
	check('the drop is handled rather than left to the browser',
		dropped.defaultPrevented);
	check('the highlight clears again', !panel.className.includes('rr-dropping'));

	const out = () => doc.getElementById('rr-save-out').textContent;
	const deadline = Date.now() + 60000;
	while (!/Use this save/.test(out()) && Date.now() < deadline) {
		if (/could not|not a battery/i.test(out())) break;
		await new Promise(r => setTimeout(r, 200));
	}
	const text = out().replace(/\s+/g, ' ').trim();
	check('a dropped save is read without opening the Pokedex first',
		/Use this save/.test(text), text.slice(0, 140));
	check('the importer loaded the species bundle by itself',
		typeof window.RR_DEX_DATA === 'object');
	check('it offers a playthrough, with playtime and team',
		/\d+h\d+m/.test(text), text.slice(0, 140));

	// Taking a playthrough has to actually put the Pokemon in My Team.
	const take = doc.querySelector('.rr-save-take');
	check('there is a button to accept a playthrough', !!take);
	if (take) {
		take.click();
		const team = window.RRTrainers.getTeam();
		check('the team is populated from the save', team.length > 0, `${team.length}`);
		check('imported Pokemon carry their moves',
			team.every(m => m.moves && m.moves.length > 0));
		check('imported Pokemon carry a real level',
			team.every(m => m.level >= 1 && m.level <= 100),
			team.filter(m => m.level < 1 || m.level > 100)
				.map(m => `${m.species} Lv${m.level}`).join(', '));
		console.log(`        imported ${team.length}: ` +
			team.slice(0, 6).map(m => `${m.species} Lv${m.level}`).join(', ') + '…');
	}

	// A dropped file that is not a save must be refused, not misread.
	const junk = new window.File([new Uint8Array(64)], 'notes.txt');
	const junkEvent = new window.Event('drop', {bubbles: true, cancelable: true});
	junkEvent.dataTransfer = {types: ['Files'], files: [junk]};
	panel.dispatchEvent(junkEvent);
	await new Promise(r => setTimeout(r, 200));
	check('dropping something that is not a battery save is refused',
		/not a battery save/i.test(out()), out().replace(/\s+/g, ' ').slice(0, 100));

	finish();
}

function finish() {
	console.log(failures === 0
		? '\nDropping a save in works.'
		: `\n${failures} FAILURE(S)`);
	try { dom.window.close(); } catch (e) { /* already gone */ }
	server.close();
	process.exit(failures === 0 ? 0 : 1);
}
