/**
 * Loads every trainer Pokemon in the dataset through the real page and checks
 * that what lands in the defender slot matches the spreadsheet.
 *
 * This is the broad correctness check: 792 Pokemon, each one driven through the
 * calculator's own set-selector exactly as a click would, then read back out of
 * the DOM. It catches species the calculator cannot represent, abilities or
 * items that silently fall back to a default, and moves that fail to apply.
 *
 * Run: node tools/test_load_all.js [--limit N]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const {JSDOM, VirtualConsole, ResourceLoader} = require('jsdom');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'upstream-calc/dist');
const indexPath = path.join(dist, 'index.html');

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

if (!fs.existsSync(indexPath)) {
	console.error('Built page not found. Run: cd upstream-calc && npm run build');
	process.exit(1);
}

const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'};
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

const virtualConsole = new VirtualConsole();

server.listen(0, '127.0.0.1', () => {
	const base = `http://127.0.0.1:${server.address().port}/`;
	const dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
		url: base + 'index.html',
		runScripts: 'dangerously',
		resources: new ResourceLoader(),
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
	dom.window.addEventListener('load', () => setTimeout(() => sweep(dom), 600));
});

function sweep(dom) {
	const {window} = dom;
	const $ = window.jQuery;
	const data = window.RR_TRAINER_DATA;

	const problems = {species: [], ability: [], item: [], level: [], moves: []};
	let checked = 0;
	const started = Date.now();

	outer:
	for (const segment of data.segments) {
		for (const battle of segment.battles) {
			// Select the battle so the panel's own handler wires up the chips.
			const target = findBattleButton($, window, battle.id);
			if (!target) continue;
			$(target).trigger('click');

			for (let i = 0; i < battle.team.length; i++) {
				if (checked >= LIMIT) break outer;
				const mon = battle.team[i];
				const where = `${segment.name} / ${battle.trainer}${battle.variant ? ' (' + battle.variant + ')' : ''} / ${mon.species}`;
				// Re-query: the panel may re-render between clicks.
				const chips = window.document.querySelectorAll('#rr-detail .rr-chip');
				if (!chips[i]) continue;
				$(chips[i]).trigger('click');
				checked++;

				const chosen = String($('#p2 input.set-selector').val() || '');
				if (chosen.indexOf(mon.species + ' (') !== 0) {
					problems.species.push(`${where}: slot shows "${chosen}"`);
					continue;
				}
				if (mon.ability) {
					const got = $('#p2 select.ability').val();
					if (got !== mon.ability) {
						problems.ability.push(`${where}: expected "${mon.ability}", got "${got}"`);
					}
				}
				if (mon.item) {
					const got = $('#p2 select.item').val();
					if (got !== mon.item) {
						problems.item.push(`${where}: expected "${mon.item}", got "${got}"`);
					}
				}
				if (mon.level && mon.level.type === 'fixed') {
					const got = ~~$('#p2 .level').val();
					if (got !== mon.level.value) {
						problems.level.push(`${where}: expected Lv${mon.level.value}, got Lv${got}`);
					}
				}
				const applied = [1, 2, 3, 4]
					.map(n => $('#p2 .move' + n + ' select.move-selector').val())
					.filter(m => m && m !== '(No Move)');
				for (const move of mon.moves) {
					if (applied.indexOf(move) === -1) {
						problems.moves.push(`${where}: move "${move}" not applied (got ${applied.join(', ') || 'none'})`);
					}
				}
			}
		}
	}

	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log(`Loaded ${checked} Pokemon through the real page in ${secs}s\n`);

	let failures = 0;
	for (const kind of Object.keys(problems)) {
		const list = problems[kind];
		if (list.length === 0) {
			console.log(`PASS  ${kind}: all ${checked} match the sheet`);
		} else {
			failures += list.length;
			console.log(`FAIL  ${kind}: ${list.length} mismatch(es)`);
			for (const line of list.slice(0, 12)) console.log(`        ${line}`);
			if (list.length > 12) console.log(`        ... and ${list.length - 12} more`);
		}
	}

	console.log(failures === 0
		? `\nAll ${checked} trainer Pokemon load correctly.`
		: `\n${failures} mismatch(es) across ${checked} Pokemon.`);
	dom.window.close();
	server.close();
	process.exit(failures === 0 ? 0 : 1);
}

function currentButton(window, id) {
	const buttons = window.document.querySelectorAll('#rr-battles .rr-battle');
	for (const b of buttons) {
		if (b.getAttribute('data-id') === id) return b;
	}
	return null;
}

function findBattleButton($, window, id) {
	const here = currentButton(window, id);
	if (here) return here;

	// Not in the current segment, so switch. Selecting a segment re-renders the
	// tab strip, which detaches any node list captured beforehand -- so index by
	// position and re-query on every iteration rather than holding references.
	const count = window.document.querySelectorAll('#rr-segments .rr-seg').length;
	for (let i = 0; i < count; i++) {
		const tab = window.document.querySelectorAll('#rr-segments .rr-seg')[i];
		if (!tab) continue;
		$(tab).trigger('click');
		const found = currentButton(window, id);
		if (found) return found;
	}
	return null;
}
