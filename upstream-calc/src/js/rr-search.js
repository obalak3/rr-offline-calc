/**
 * Run the search off the main thread.
 *
 * WHY. The exact search is worth far more time than it was being given. Solving
 * Lt. Surge takes around thirty seconds; the panel allowed five, not because
 * five was enough but because JavaScript is single-threaded and a longer search
 * freezes the page solid -- no scrolling, no clicking, and eventually Chrome's
 * "page unresponsive" dialog. So the cap was a UI constraint wearing a
 * performance costume, and the fights that most needed thinking time were
 * exactly the ones that never got it.
 *
 * A worker removes the constraint. The page stays live, the search gets a real
 * budget, and the work can be cancelled.
 *
 * WHY A BLOB. Chrome refuses `new Worker('./file.js')` from a `file://` page,
 * and running from `file://` is the whole point of this project. A worker built
 * from a Blob URL is allowed, but it cannot importScripts a file:// path, and
 * the page cannot fetch its own scripts either -- so the engine is baked into a
 * string at build time by tools/build_worker.js and handed over as data.
 *
 * Everything here degrades rather than breaks: if workers are unavailable for
 * any reason, `available()` reports false and the caller runs the search inline
 * exactly as before.
 */
var RRSearch = (function () {
	"use strict";

	var worker = null;
	var blobUrl = null;
	var pending = null;
	var seq = 0;
	var crew = [];          // workers sharing one split search
	var crewState = null;

	function available() {
		return typeof Worker !== "undefined" &&
			typeof URL !== "undefined" && !!URL.createObjectURL &&
			typeof RR_WORKER_SRC === "string" && RR_WORKER_SRC.length > 0;
	}

	/**
	 * How many searches to run at once.
	 *
	 * The opening moves are independent -- whatever line exists begins with one
	 * of them -- so they can be dealt out and searched simultaneously. This is
	 * the only lever here that multiplies the search rather than steering it:
	 * the engine manages a few thousand positions a second, and the fights that
	 * do not finish need hundreds of thousands.
	 *
	 * One is left for the page, so the browser it is running in stays usable.
	 */
	function crewSize() {
		var cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
		return Math.max(1, Math.min(6, cores - 1));
	}

	function newWorker(onMessage, onError) {
		var url = URL.createObjectURL(
			new Blob([RR_WORKER_SRC], {type: "text/javascript"}));
		var w = new Worker(url);
		w.__blobUrl = url;
		w.onmessage = onMessage;
		w.onerror = onError;
		return w;
	}

	function killCrew() {
		for (var i = 0; i < crew.length; i++) {
			try { crew[i].terminate(); } catch (e) { /* already gone */ }
			if (crew[i].__blobUrl && URL.revokeObjectURL) {
				URL.revokeObjectURL(crew[i].__blobUrl);
			}
		}
		crew = [];
		crewState = null;
	}

	/** Deal the openings round robin, so nobody gets only the hopeless ones. */
	function deal(keys, hands) {
		var out = [];
		for (var i = 0; i < hands; i++) out.push([]);
		for (var k = 0; k < keys.length; k++) out[k % hands].push(keys[k]);
		return out.filter(function (hand) { return hand.length > 0; });
	}

	function settle(result, error) {
		var callbacks = pending;
		pending = null;
		if (!callbacks) return;
		if (error) {
			if (callbacks.onError) callbacks.onError(error);
		} else if (callbacks.onDone) {
			callbacks.onDone(result);
		}
	}

	/**
	 * The worker is created once and kept.
	 *
	 * Spinning one up means parsing a megabyte of engine, which is not something
	 * to repeat per click. It is only torn down on cancel, where the whole point
	 * is to stop work already in flight.
	 */
	function ensure() {
		if (worker) return worker;
		blobUrl = URL.createObjectURL(
			new Blob([RR_WORKER_SRC], {type: "text/javascript"}));
		worker = new Worker(blobUrl);
		worker.onmessage = function (event) {
			var data = event.data || {};
			if (data.kind === "progress") {
				if (pending && pending.onProgress) {
					pending.onProgress(data.nodes, data.elapsedMs);
				}
				return;
			}
			if (data.ok === false) settle(null, data.error || "the search failed");
			else settle(data, null);
		};
		worker.onerror = function (event) {
			// A worker that dies takes its Blob with it; the next call rebuilds.
			stop();
			settle(null, (event && event.message) || "the search worker stopped");
		};
		return worker;
	}

	function stop() {
		if (worker) { worker.terminate(); worker = null; }
		if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
	}

	/**
	 * Ask for a route. `onDone` receives {route, priced}.
	 *
	 * The state goes across by structured clone, which unlike JSON preserves
	 * Infinity -- and permanent weather and terrain are stored as Infinity turns,
	 * so a JSON hop would have quietly turned Surge's permanent Electric Terrain
	 * into something else on the way over.
	 */
	function solve(state, search, onDone, onError, onProgress) {
		if (!available()) {
			if (onError) onError("workers are not available here");
			return null;
		}
		if (pending) cancel();
		var id = ++seq;
		pending = {id: id, onDone: onDone, onError: onError, onProgress: onProgress};
		var opts = search || {};

		var hands = null;
		if (opts.parallel !== false) {
			try {
				var keys = RRBattle.legalActions(state, "me").map(RRExact.actionKey);
				// Splitting is only worth the extra workers when there is
				// something to split. One opening means one search.
				if (keys.length > 1) hands = deal(keys, Math.min(crewSize(), keys.length));
			} catch (e) { hands = null; }
		}

		if (!hands || hands.length < 2) {
			try {
				ensure().postMessage({kind: "solve", state: state, search: opts});
			} catch (e) {
				settle(null, (e && e.message) || "could not start the search");
				return null;
			}
			return id;
		}

		startCrew(state, opts, hands, id);
		return id;
	}

	/**
	 * Run one search per share of the opening moves.
	 *
	 * Two asymmetric endings, and the asymmetry is the whole reason this is
	 * allowed to be parallel at all:
	 *
	 *   A LINE is a line. The first share to produce one has produced the
	 *   answer, and the rest are stopped where they stand.
	 *   NO LINE is a claim about the whole tree, so it needs EVERY share to have
	 *   finished and come back empty. One share running out of budget makes the
	 *   answer "undecided", exactly as it would for a single search.
	 */
	function startCrew(state, opts, hands, id) {
		crewState = {id: id, done: 0, total: hands.length, decided: true,
			nodes: [], settled: false, state: state, opts: opts,
			// Without this the panel reported every long search as taking zero
			// seconds, since elapsed was measured from a start time that was
			// read at the moment it was printed.
			started: Date.now()};
		for (var i = 0; i < hands.length; i++) crewState.nodes.push(0);

		for (var h = 0; h < hands.length; h++) {
			var share = {};
			for (var key in opts) share[key] = opts[key];
			share.rootActions = hands[h];
			var w;
			try {
				w = newWorker(makeOnMessage(h), makeOnError(h));
			} catch (e) {
				// One worker failing to start means the crew is incomplete, and
				// an incomplete crew must not be left running: the search has
				// already been settled as failed, so anything still working is
				// burning a core for an answer nobody will read. This was a
				// forEach, which kept starting workers after the failure and
				// left every earlier one alive until the next search.
				crewState = null;
				killCrew();
				settle(null, (e && e.message) || "could not start the search");
				return;
			}
			crew.push(w);
			w.postMessage({kind: "hunt", state: state, search: share});
		}
	}

	function makeOnMessage(index) {
		return function (event) { crewMessage(index, event); };
	}

	function makeOnError(index) {
		return function (event) { crewError(index, event); };
	}

	function crewProgress() {
		if (!pending || !pending.onProgress || !crewState) return;
		var total = 0;
		for (var i = 0; i < crewState.nodes.length; i++) total += crewState.nodes[i];
		pending.onProgress(total, Date.now() - crewState.started);
	}

	function crewMessage(index, event) {
		var data = event.data || {};
		if (!crewState || crewState.settled) return;
		if (data.kind === "progress") {
			crewState.nodes[index] = data.nodes;
			crewProgress();
			return;
		}
		if (data.ok === false) { crewError(index, {message: data.error}); return; }

		crewState.nodes[index] = data.nodes || crewState.nodes[index];
		if (data.found) {
			crewState.settled = true;
			var result = {route: data.route, priced: data.priced};
			killCrew();
			settle(result, null);
			return;
		}
		if (!data.decided) crewState.decided = false;
		crewState.done++;
		if (crewState.done >= crewState.total) finishCrew();
	}

	function crewError(index, event) {
		if (!crewState || crewState.settled) return;
		// A share that died searched nothing, so nothing can be concluded from
		// its silence. The others still count, and their lines are still real.
		crewState.decided = false;
		crewState.done++;
		if (crewState.done >= crewState.total) finishCrew();
	}

	/** Nobody found a line. Ask once for the guess, rather than once per share. */
	function finishCrew() {
		var total = 0;
		for (var i = 0; i < crewState.nodes.length; i++) total += crewState.nodes[i];
		var state = crewState.state, opts = crewState.opts;
		var decided = crewState.decided;
		crewState.settled = true;
		killCrew();
		try {
			ensure().postMessage({kind: "fallback", state: state, search: opts,
				decided: decided, nodes: total});
		} catch (e) {
			settle(null, (e && e.message) || "could not finish the search");
		}
	}

	/** Abandon the search in flight. The worker is killed, not asked politely. */
	function cancel() {
		if (!pending) return;
		pending = null;
		killCrew();
		stop();
	}

	function busy() { return !!pending; }

	return {
		available: available,
		solve: solve,
		cancel: cancel,
		busy: busy
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = RRSearch;
