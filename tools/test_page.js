/**
 * End-to-end check of the built page in a real DOM.
 *
 * Loads upstream-calc/dist/index.html with jsdom, lets the calculator's own
 * scripts boot, then drives the trainer panel the way a user would: pick a
 * battle, click an enemy, and confirm the defender slot actually changed.
 *
 * This is the substitute for clicking around in a browser, and it catches the
 * things that unit tests cannot -- script order, missing globals, selectors
 * that do not match the real markup.
 *
 * Run: node tools/test_page.js   (after `cd upstream-calc && npm run build`)
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
	console.error('Built page not found. Run: cd upstream-calc && npm run build');
	process.exit(1);
}

let failures = 0;
const scriptErrors = [];

function check(name, condition, detail) {
	if (condition) {
		console.log(`PASS  ${name}`);
	} else {
		failures++;
		console.log(`FAIL  ${name}`);
		if (detail !== undefined) console.log(`        ${detail}`);
	}
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
	// Google Analytics and other network fetches are expected to fail offline.
	if (/googletagmanager|gtag|ERR_|Failed to load/i.test(e.message || '')) return;
	scriptErrors.push(e.message + (e.detail ? '\n' + e.detail : ''));
});
virtualConsole.on('error', (msg) => {
	if (/googletagmanager|gtag/i.test(String(msg))) return;
	scriptErrors.push('console.error: ' + msg);
});

/**
 * Records every resource the page asks for, so we can prove it never reaches
 * off-machine. "Works offline" is otherwise an assumption, not a fact.
 */
const requested = [];
class RecordingLoader extends ResourceLoader {
	fetch(url, options) {
		requested.push(url);
		return super.fetch(url, options);
	}
}
const recorder = new RecordingLoader({strictSSL: false});

// The page is served over loopback rather than opened as file://, because
// jsdom treats file:// as an opaque origin and then localStorage -- which both
// the theme toggle and the saved team rely on -- does not exist.
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
let ran = false;

let base = null;
server.listen(0, '127.0.0.1', () => {
	base = `http://127.0.0.1:${server.address().port}/`;
	dom = new JSDOM(fs.readFileSync(indexPath, 'utf8'), {
		url: base + 'index.html',
		runScripts: 'dangerously',
		resources: recorder,
		virtualConsole,
		pretendToBeVisual: true,
		beforeParse(w) {
			// jsdom has no matchMedia; the theme toggle needs one. Environment
			// gap, not a page defect.
			w.matchMedia = () => ({
				matches: false, media: '', onchange: null,
				addListener() {}, removeListener() {},
				addEventListener() {}, removeEventListener() {},
				dispatchEvent() { return false; }
			});
		}
	});
	// jsdom fires load asynchronously; give the page a moment to boot.
	dom.window.addEventListener('load', () => setTimeout(run, 500));
	setTimeout(() => { if (!ran) run(); }, 15000);
});

function run() {
	if (ran) return;
	ran = true;
	const {window} = dom;
	const $ = window.jQuery;

	try {
		// ---------------------------------------------------- page booted
		check('jQuery is available', typeof $ === 'function');
		check('calc engine global exists', typeof window.calc === 'object');
		check('trainer data global exists', typeof window.RR_TRAINER_DATA === 'object');
		check('crit engine global exists', typeof window.RRCritKO === 'object');

		if (!window.RR_TRAINER_DATA) return finish();

		// ------------------------------------------------------- dataset
		const data = window.RR_TRAINER_DATA;
		const battles = data.segments.reduce((n, s) => n + s.battles.length, 0);
		const mons = data.segments.reduce(
			(n, s) => n + s.battles.reduce((m, b) => m + b.team.length, 0), 0);
		check('dataset has 9 segments', data.segments.length === 9,
			`got ${data.segments.length}`);
		check('dataset has 167 battles', battles === 167, `got ${battles}`);
		check('dataset has 792 Pokemon', mons === 792, `got ${mons}`);

		// Every species must exist in the calculator's own dex, or loading
		// a battle would silently fail at runtime.
		const dex = window.pokedex;
		let missing = [];
		for (const seg of data.segments) {
			for (const b of seg.battles) {
				for (const m of b.team) {
					if (dex && !dex[m.species]) missing.push(m.species);
				}
			}
		}
		missing = [...new Set(missing)];
		check('every trainer Pokemon exists in the calculator dex',
			missing.length === 0, missing.slice(0, 8).join(', '));

		// ---------------------------------------------------- panel built
		check('trainer panel was injected',
			window.document.getElementById('rr-panel') !== null);
		// Nine sheet sections plus the chronological Story Order view.
		const segButtons = window.document.querySelectorAll('#rr-segments .rr-seg');
		check('segment tabs rendered', segButtons.length === 10,
			`got ${segButtons.length}`);
		const battleButtons = window.document.querySelectorAll('#rr-battles .rr-battle');
		check('battle list rendered', battleButtons.length > 0,
			`got ${battleButtons.length}`);

		// ------------------------------------------- click through a battle
		// Kanto Leaders / Brock is the first battle of the first segment.
		$(battleButtons[0]).trigger('click');
		const chips = window.document.querySelectorAll('#rr-detail .rr-chip');
		check('clicking a battle shows its enemy team', chips.length > 0,
			`got ${chips.length} chips`);

		// Selecting a battle puts its lead on the field straight away.
		const firstSpecies = data.segments[0].battles[0].team[0].species;
		const leadSet = $('#p2').find('input.set-selector').val();
		check('selecting a battle loads its lead',
			String(leadSet).indexOf(firstSpecies + ' (') === 0,
			`got "${leadSet}"`);

		// Clicking a different chip swaps to that Pokemon.
		const secondSpecies = data.segments[0].battles[0].team[1] &&
			data.segments[0].battles[0].team[1].species;
		if (secondSpecies) {
			$(chips[1]).trigger('click');
			const afterSet = $('#p2').find('input.set-selector').val();
			check('clicking another enemy changes the defender slot',
				String(afterSet).indexOf(secondSpecies + ' (') === 0,
				`expected "${secondSpecies}" got "${afterSet}"`);
			$(chips[0]).trigger('click');
		}
		const afterSet = $('#p2').find('input.set-selector').val();

		const firstBattle = data.segments[0].battles[0];
		const expectedSpecies = firstBattle.team[0].species;
		check('defender slot holds the expected species',
			String(afterSet).indexOf(expectedSpecies) === 0,
			`expected "${expectedSpecies}" got "${afterSet}"`);

		// The level field should match the sheet, not the calculator default.
		const level = ~~$('#p2').find('.level').val();
		const expectedLevel = firstBattle.team[0].level.type === 'fixed'
			? firstBattle.team[0].level.value : null;
		if (expectedLevel !== null) {
			check('defender level came from the sheet', level === expectedLevel,
				`expected ${expectedLevel} got ${level}`);
		}

		// The ability and item should have been applied too.
		if (firstBattle.team[0].ability) {
			check('defender ability came from the sheet',
				$('#p2').find('.ability').val() === firstBattle.team[0].ability,
				`expected ${firstBattle.team[0].ability} got ${$('#p2').find('.ability').val()}`);
		}

		// -------------------------------------------------- crit-aware box
		// Crit information is lines attached to the result, not a table.
		const critLines = window.document.querySelectorAll('#rr-crit .rr-critline');
		check('crit-aware lines rendered', critLines.length > 0,
			`got ${critLines.length} lines`);
		check('crit info is not a separate table',
			window.document.querySelectorAll('#rr-crit table').length === 0);
		const incoming = window.document.querySelector('#rr-crit .rr-incoming');
		check('the opponent\'s threat is reported', !!incoming,
			incoming ? '' : 'no incoming line');

		// The damage matrix was removed once the results block and the doubles
		// view covered the same ground.
		check('no leftover damage matrix',
			window.document.querySelectorAll('#rr-detail .rr-matrix').length === 0);

		// ------------------------------------------------------ speed tiers
		{
			const rows = window.document.querySelectorAll('#rr-speed .rr-speed-row');
			check('speed order lists you and the enemy team',
				rows.length === firstBattle.team.length + 1,
				`got ${rows.length} for a team of ${firstBattle.team.length}`);
			check('your own row is marked',
				window.document.querySelectorAll('#rr-speed .rr-you').length === 1);

			// Sorted fastest first.
			const speeds = [...rows].map(r => parseInt(r.textContent, 10));
			const sorted = speeds.every((s, i) => i === 0 || speeds[i - 1] >= s);
			check('speed order is sorted', sorted, speeds.join(', '));

			// Speed must follow the field and the Pokemon, not just the battle.
			const before = window.document.querySelector('#rr-speed .rr-you').textContent;
			$('#p1 .item').val('Choice Scarf').trigger('change');
			const after = window.document.querySelector('#rr-speed .rr-you').textContent;
			check('Choice Scarf changes the reported speed', before !== after,
				`${before.trim()} -> ${after.trim()}`);
			$('#p1 .item').val('').trigger('change');
		}

		// ------------------------------------------------- Story Order view
		const orderTab = [...window.document.querySelectorAll('#rr-segments .rr-seg')]
			.find(b => b.getAttribute('data-seg') === 'order');
		check('Story Order tab exists', !!orderTab);
		if (orderTab) {
			$(orderTab).trigger('click');
			const rows = window.document.querySelectorAll('#rr-battles .rr-battle');
			const linked = [...rows].filter(r => r.getAttribute('data-id'));
			const caps = window.document.querySelectorAll('#rr-battles .rr-cap');
			check('Story Order lists every trainer',
				rows.length === data.trainerOrder.length,
				`${rows.length} of ${data.trainerOrder.length}`);
			check('every Story Order entry links to a battle',
				linked.length === rows.length,
				`${linked.length} of ${rows.length} linked`);
			check('Story Order shows level caps', caps.length > 0,
				`${caps.length} cap headers`);

			$(linked[0]).trigger('click');
			check('clicking a Story Order entry loads its team',
				window.document.querySelectorAll('#rr-detail .rr-chip').length > 0);
			// Back to the first section for the checks that follow.
			$(window.document.querySelectorAll('#rr-segments .rr-seg')[0]).trigger('click');
		}

		// ------------------------------------------ battle field effects
		// Find a battle whose notes name a weather the calculator can set.
		let effectBattle = null, wantWeather = null;
		const WEATHERS = [['PERMANENT SANDSTORM', 'Sand'], ['PERMANENT SUN', 'Sun'],
			['PERMANENT RAIN', 'Rain'], ['PERMANENT SNOW', 'Snow']];
		for (const seg of data.segments) {
			for (const b of seg.battles) {
				const text = (b.effects || []).join(' ').toUpperCase();
				const hit = WEATHERS.find(w => text.includes(w[0]));
				if (hit) { effectBattle = b; wantWeather = hit[1]; break; }
			}
			if (effectBattle) break;
		}
		if (effectBattle) {
			const btn = findBattleButton($, window, effectBattle.id);
			if (btn) {
				$(btn).trigger('click');
				const weather = $("input[name='weather']:checked").val();
				check(`battle effects set the weather (${effectBattle.trainer})`,
					weather === wantWeather, `expected ${wantWeather}, got "${weather}"`);

				// Turning auto-apply off must stop it changing the field.
				$("input[name='weather'][value='']").prop('checked', true);
				$('#rr-effects').prop('checked', false).trigger('change');
				$(findBattleButton($, window, effectBattle.id)).trigger('click');
				check('auto field effects can be turned off',
					$("input[name='weather']:checked").val() === '',
					`got "${$("input[name='weather']:checked").val()}"`);
				$('#rr-effects').prop('checked', true).trigger('change');
			}
		} else {
			check('found a battle with a weather effect', false, 'none in dataset');
		}

		// --------------------------------------------- Minimal Grinding Mode
		// Brock's team has no EVs at all, so pick a battle that actually does.
		let evBattle = null;
		for (const seg of data.segments) {
			for (const b of seg.battles) {
				if (b.team.some(m => Object.keys(m.evs).some(k => m.evs[k] > 0))) {
					evBattle = b; break;
				}
			}
			if (evBattle) break;
		}
		if (evBattle) {
			const evIndex = evBattle.team.findIndex(
				m => Object.keys(m.evs).some(k => m.evs[k] > 0));
			const btn = findBattleButton($, window, evBattle.id);
			$(btn).trigger('click');

			$('#rr-mgm').prop('checked', false).trigger('change');
			$(window.document.querySelectorAll('#rr-detail .rr-chip')[evIndex]).trigger('click');
			const normal = evTotal($);
			check(`enemy EVs are applied normally (${evBattle.trainer})`,
				normal > 0, `EV total ${normal}`);

			$('#rr-mgm').prop('checked', true).trigger('change');
			$(window.document.querySelectorAll('#rr-detail .rr-chip')[evIndex]).trigger('click');
			check('Minimal Grinding Mode zeroes enemy EVs', evTotal($) === 0,
				`EV total ${evTotal($)}`);
			$('#rr-mgm').prop('checked', false).trigger('change');
		} else {
			check('found a battle with EVs', false, 'none in dataset');
		}

		// -------------------------------------------------------- offline
		// Every request must stay on the local server. Anything else means the
		// page would break, hang or leak on a plane.
		const offsite = requested.filter(u => !u.startsWith(base));
		check('page makes no off-machine requests', offsite.length === 0,
			offsite.slice(0, 5).join('\n        '));
		console.log(`        ${requested.length} resource requests, all local`);

		// ------------------------------------------------------ no errors
		check('no unexpected script errors', scriptErrors.length === 0,
			scriptErrors.slice(0, 3).join('\n        '));
	} catch (e) {
		failures++;
		console.log('FAIL  test harness threw');
		console.log(e && e.stack ? e.stack : String(e));
	}
	finish();
}

function finish() {
	console.log(failures === 0 ? '\nAll page checks passed.' : `\n${failures} FAILURE(S)`);
	try { dom.window.close(); } catch (e) { /* already torn down */ }
	server.close();
	process.exit(failures === 0 ? 0 : 1);
}

function evTotal($) {
	let total = 0;
	for (const cls of ['hp', 'at', 'df', 'sa', 'sd', 'sp']) {
		total += ~~$('#p2').find('.' + cls + ' .evs').val();
	}
	return total;
}

function currentButton(window, id) {
	for (const b of window.document.querySelectorAll('#rr-battles .rr-battle')) {
		if (b.getAttribute('data-id') === id) return b;
	}
	return null;
}

function findBattleButton($, window, id) {
	const here = currentButton(window, id);
	if (here) return here;
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
