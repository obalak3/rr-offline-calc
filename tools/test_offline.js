/**
 * The offline guarantee: the page works opened straight from disk.
 *
 * test_page.js serves over loopback, which is a friendlier environment than a
 * real file:// page. Two things differ there and both broke the page:
 *
 *   - localStorage can be denied outright. Several scripts read it while
 *     loading, and one throwing takes down every script after it.
 *   - history.replaceState throws on a file URL. The calculator guards that
 *     the method exists, not that it works, so the handler that populates
 *     every dropdown died with it.
 *
 * Neither showed up over http. This test exists so they cannot come back.
 *
 * Run: node tools/test_offline.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {JSDOM, VirtualConsole, ResourceLoader} = require('jsdom');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'upstream-calc/dist');
const indexPath = path.join(dist, 'index.html');

if (!fs.existsSync(indexPath)) {
	console.error('Built page not found. Run: cd upstream-calc && npm run build');
	process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`PASS  ${name}`);
	} else {
		failures++;
		console.log(`FAIL  ${name}`);
		if (detail !== undefined) console.log(`        ${detail}`);
	}
}

/*
 * Before anything is rendered: the built page must not be able to serve a
 * previous build. Every asset it names is hash-stamped, so a rebuild changes
 * their URLs -- but only if the browser re-reads index.html, and the Pokedex
 * bundle is fetched by a path inside a script rather than named in the HTML at
 * all. Both gaps were real: a cached index.html made an already-fixed bug look
 * like it had come back, holding the whole app on the previous build.
 */
(function checkCacheChain() {
	const crypto = require('crypto');
	const html = fs.readFileSync(indexPath, 'utf8');
	check('the page tells the browser not to cache it',
		/http-equiv="Cache-Control"[^>]*no-store/i.test(html));

	const loaderRef = html.match(/\.\/js\/rr-dex\.js\?([0-9a-f]+)/);
	check('the Pokedex loader is stamped in the page', !!loaderRef);

	const loaderPath = path.join(dist, 'js/rr-dex.js');
	if (loaderRef && fs.existsSync(loaderPath)) {
		const actual = crypto.createHash('sha1')
			.update(fs.readFileSync(loaderPath)).digest('hex').slice(0, 8);
		check('the loader stamp matches the file it points at',
			loaderRef[1] === actual, `${loaderRef[1]} vs ${actual}`);

		const src = fs.readFileSync(loaderPath, 'utf8');
		const dataRef = src.match(/DATA_SRC = "[^"?]+\?([0-9a-f]+)"/);
		check('the loader stamps the bundle it fetches', !!dataRef);
		const bundlePath = path.join(dist, 'js/data/rr-dex-data.js');
		if (dataRef && fs.existsSync(bundlePath)) {
			const bundleHash = crypto.createHash('sha1')
				.update(fs.readFileSync(bundlePath)).digest('hex').slice(0, 8);
			check('the bundle stamp matches the bundle',
				dataRef[1] === bundleHash, `${dataRef[1]} vs ${bundleHash}`);
		}
	}
})();

const scriptErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
	if (/googletagmanager|gtag/i.test(e.message || '')) return;
	scriptErrors.push(e.message);
});

// Anything fetched from off-machine would be a second way to fail on a plane.
const requested = [];
class RecordingLoader extends ResourceLoader {
	fetch(url, options) {
		requested.push(url);
		return super.fetch(url, options);
	}
}

const dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
	url: 'file://' + indexPath,
	runScripts: 'dangerously',
	resources: new RecordingLoader(),
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

dom.window.addEventListener('load', () => setTimeout(run, 800));

function run() {
	const {window} = dom;
	const $ = window.jQuery;

	check('page is genuinely running from file://',
		window.location.protocol === 'file:', window.location.protocol);
	check('jQuery booted', typeof $ === 'function');
	check('damage engine loaded', typeof window.calc === 'object');

	// jsdom denies localStorage on file://, which is the strict end of what a
	// browser might do. The fallback has to make that survivable.
	check('storage is usable one way or another',
		typeof window.localStorage === 'object' && window.localStorage !== null,
		String(typeof window.localStorage));

	check('trainer data loaded', typeof window.RR_TRAINER_DATA === 'object');
	if (window.RR_TRAINER_DATA) {
		const battles = window.RR_TRAINER_DATA.segments
			.reduce((n, s) => n + s.battles.length, 0);
		check('all 167 battles present', battles === 167, `got ${battles}`);
	}

	// The failure that started this: the panel silently never built.
	check('trainer panel built', !!window.document.getElementById('rr-panel'));
	check('battle list rendered',
		window.document.querySelectorAll('#rr-battles .rr-battle').length > 0);

	// Dropdowns are filled by the gen-change handler, which history.replaceState
	// used to kill on the way past.
	const moveOptions = window.document
		.querySelectorAll('#p1 .move1 select.move-selector option').length;
	check('move dropdowns populated', moveOptions > 100, `got ${moveOptions}`);

	if (typeof window.RRDex === 'undefined') {
		check('Pokedex module present', false);
		return finish();
	}

	// The dex pulls 3.9 MB in by injecting a script tag; fetch would be blocked
	// here, which is exactly why it does not use fetch.
	window.RRDex.open();
	setTimeout(() => {
		check('Pokedex data loaded lazily from disk',
			typeof window.RR_DEX_DATA === 'object');
		if (window.RR_DEX_DATA) {
			const species = Object.keys(window.RR_DEX_DATA.species).length;
			check('Pokedex has the full roster', species === 1343, `got ${species}`);
		}

		const offsite = requested.filter(u => !u.startsWith('file://'));
		check('nothing is requested from off-machine', offsite.length === 0,
			offsite.slice(0, 3).join(', '));

		check('no unhandled script errors', scriptErrors.length === 0,
			scriptErrors.slice(0, 3).join('\n        '));
		finish();
	}, 4000);
}

function finish() {
	console.log(failures === 0
		? '\nThe page works with no server and no network.'
		: `\n${failures} FAILURE(S)`);
	try { dom.window.close(); } catch (e) { /* already torn down */ }
	process.exit(failures === 0 ? 0 : 1);
}
