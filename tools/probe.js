/**
 * Throwaway-free probe harness: boots the built page in JSDOM and runs whatever
 * function you pass on the command line, so checking one behaviour does not mean
 * writing a new script each time.
 *
 * Run: node tools/probe.js path/to/steps.js
 * The steps file exports function (ctx) with {window, $, doc, log, battle(id)}.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const {JSDOM, VirtualConsole, ResourceLoader} = require('jsdom');

const dist = path.join(__dirname, '..', 'upstream-calc/dist');
const steps = require(path.resolve(process.argv[2]));
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'};

const server = http.createServer((q, s) => {
	const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '');
	fs.readFile(path.join(dist, rel || 'index.html'), (e, b) => {
		if (e) { s.writeHead(404).end(); return; }
		s.writeHead(200, {'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream'});
		s.end(b);
	});
});

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', e => errors.push(e.message));

server.listen(0, '127.0.0.1', () => {
	const base = `http://127.0.0.1:${server.address().port}/`;
	const dom = new JSDOM(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), {
		url: base + 'index.html',
		runScripts: 'dangerously',
		resources: new ResourceLoader(),
		virtualConsole: vc,
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
	dom.window.addEventListener('load', () => setTimeout(() => {
		const {window} = dom;
		const $ = window.jQuery;
		const doc = window.document;
		const ctx = {
			window, $, doc, errors,
			log: (...a) => console.log(...a),
			text: sel => ($(sel).text() || '').replace(/\s+/g, ' ').trim(),
			// Select a battle by id, switching segments until it is on screen.
			battle(id) {
				const segs = doc.querySelectorAll('#rr-segments .rr-seg').length;
				for (let i = 0; i < segs; i++) {
					$(doc.querySelectorAll('#rr-segments .rr-seg')[i]).trigger('click');
					for (const b of doc.querySelectorAll('#rr-battles .rr-battle')) {
						if (b.getAttribute('data-id') === id) { $(b).trigger('click'); return b; }
					}
				}
				return null;
			},
			ids: () => [...doc.querySelectorAll('#rr-battles .rr-battle')]
				.map(b => b.getAttribute('data-id'))
		};
		try {
			steps(ctx);
		} finally {
			console.log('\njsdom errors:', errors.length ? errors.slice(0, 3) : 'none');
			window.close();
			server.close();
			process.exit(0);
		}
	}, 800));
});
