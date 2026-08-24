/**
 * One share of a split search, as a child process.
 *
 * The browser splits a search across Web Workers (rr-search.js); this is the
 * same idea for Node, and it exists because the question that most needs the
 * cores -- "is this fight winnable with the real team" -- is asked from a script
 * and never from the page. The acceptance run that came back undecided at six
 * million nodes was using one core of eight.
 *
 * Deliberately thin, for the same reason the Web Worker entry is: logic that
 * only runs in a child process is logic that only breaks in a child process,
 * where it is hardest to see. Everything here is arguments in, one result out.
 */
'use strict';

const H = require('./harness.js');

process.on('message', function (payload) {
	if (!payload || payload.kind !== 'hunt') return;
	let loaded;
	try {
		loaded = H.loadEngine();
	} catch (e) {
		process.send({ok: false, error: 'could not load the engine: ' + e.message});
		process.exit(1);
		return;
	}
	const B = loaded.B, X = loaded.X;
	try {
		const battle = H.earlyBattles(loaded, {pattern: new RegExp(payload.pattern)})
			.find(b => H.label(b) === payload.label);
		if (!battle) throw new Error('no battle matching ' + payload.label);

		const state = B.createState(payload.party, H.foeSets(battle), {});
		const opts = Object.assign({}, payload.search, {
			rootActions: payload.rootActions,
			onProgress: function (nodes, elapsedMs) {
				process.send({kind: 'progress', nodes: nodes, elapsedMs: elapsedMs});
			}
		});
		const result = X.cleanWin(state, opts);
		process.send({
			ok: true, kind: 'hunt',
			found: result.found,
			// Only meaningful for THIS share of the opening moves. The parent
			// adds them up; no child can decide a fight on its own.
			decided: result.decided,
			nodes: result.nodes,
			elapsedMs: result.elapsedMs,
			steps: result.found ? X.toSteps(result.line) : null
		});
	} catch (e) {
		process.send({ok: false, error: String((e && e.message) || e)});
	}
	process.exit(0);
});
