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

	function available() {
		return typeof Worker !== "undefined" &&
			typeof URL !== "undefined" && !!URL.createObjectURL &&
			typeof RR_WORKER_SRC === "string" && RR_WORKER_SRC.length > 0;
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
	function solve(state, search, onDone, onError) {
		if (!available()) {
			if (onError) onError("workers are not available here");
			return null;
		}
		if (pending) cancel();
		var id = ++seq;
		pending = {id: id, onDone: onDone, onError: onError};
		try {
			ensure().postMessage({kind: "solve", state: state, search: search || {}});
		} catch (e) {
			settle(null, (e && e.message) || "could not start the search");
			return null;
		}
		return id;
	}

	/** Abandon the search in flight. The worker is killed, not asked politely. */
	function cancel() {
		if (!pending) return;
		pending = null;
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
