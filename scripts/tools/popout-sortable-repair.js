import { Manager } from "../core/manager.js";

const KEY = "popout-sortable-repair";
const ITEM_LIST_SELECTOR = "ul[data-item-list]";
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10000;

export class PopoutSortableRepairTool {
	static id = KEY;
	static category = "popout";
	static enabledDefault = true;

	/** @type {Map<string, {app: object, timer: number}>} appId -> app being watched */
	static _armed = new Map();

	/** The real drop-point element of the most recent popout drag, if any. */
	static _lastDropTarget = null;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		if (!game.modules.get("popout")?.active) {
			console.debug(`[${Manager.id}] ${KEY}: popout module not active; repair disabled`);
			return;
		}
		Hooks.on("PopOut:loading", (app) => this._arm(app));
		Hooks.on("PopOut:popin", (app) => this._disarm(app));
		Hooks.on("PopOut:close", (app) => this._disarm(app));
		// Any re-render of a popped-out sheet (e.g. after an item move updates the
		// actor) creates FRESH SortableJS instances that lose the drop-target
		// patch — re-apply it on every render of a sheet living in a popout.
		Hooks.on("renderActorSheetPF2e", (app) => this._onSheetRender(app));
		console.debug(`[${Manager.id}] ${KEY}: hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Watch + trigger                             */
	/* -------------------------------------------- */

	/**
	 * Start watching a popped-out app. We arm on PopOut:loading (fires before the
	 * sheet's DOM node is adopted into the popout window's document) and poll until
	 * the node actually leaves the main document — that removal is what makes the
	 * pf2e system's DestroyableManager destroy the sheet's SortableJS instances.
	 * Once the node lands in the popout document, the repair re-renders the app so
	 * the sortables are recreated there, where the main document's body observer
	 * can never destroy them again.
	 */
	static _arm(app) {
		const appId = app?.appId ?? app?.id;
		if (!appId || this._armed.has(appId)) return;
		const node = app.element?.[0] ?? app._element?.[0] ?? null;
		if (!node || !node.querySelector(ITEM_LIST_SELECTOR)) return;
		const started = Date.now();
		const timer = setInterval(() => {
			try {
				this._poll(appId, started);
			} catch (error) {
				console.error(`[${Manager.id}] ${KEY} poll failed`, error);
			}
		}, POLL_INTERVAL_MS);
		this._armed.set(appId, { app, timer });
	}

	static _poll(appId, started) {
		const entry = this._armed.get(appId);
		if (!entry) return;
		const node = entry.app.element?.[0] ?? entry.app._element?.[0] ?? null;
		if (!node) {
			clearInterval(entry.timer);
			this._armed.delete(appId);
			return;
		}
		if (node.ownerDocument === document) {
			// Still in the main window — the popout may not have finished opening.
			if (Date.now() - started > POLL_TIMEOUT_MS) {
				clearInterval(entry.timer);
				this._armed.delete(appId);
			}
			return;
		}
		clearInterval(entry.timer);
		this._armed.delete(appId);
		this._repair(entry.app, node);
	}

	static _disarm(app) {
		const appId = app?.appId ?? app?.id;
		const entry = this._armed.get(appId);
		if (!entry) return;
		clearInterval(entry.timer);
		this._armed.delete(appId);
	}

	/**
	 * A pf2e actor sheet just rendered. If it lives in a popout window (its DOM
	 * node is in a different document), its freshly created sortables need the
	 * drop-target patch — an actor update re-renders the sheet and drops it.
	 */
	static _onSheetRender(app) {
		try {
			const node = app.element?.[0] ?? app._element?.[0] ?? null;
			if (!node || node.ownerDocument === document) return;
			this._patchPopoutSortables(node);
		} catch (error) {
			console.error(`[${Manager.id}] ${KEY} render patch failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Repair                                      */
	/* -------------------------------------------- */

	/**
	 * Re-render the app inside the popout document. This re-runs the sheet's
	 * activateListeners -> #activateInventoryDragDrop, recreating SortableJS
	 * instances on the popout-document elements, where the main document's body
	 * observer can never destroy them again. For popOut apps Foundry's
	 * _replaceHTML only swaps .window-content, so the header (pop-in button)
	 * survives and scroll positions are saved/restored by the sheet.
	 */
	static _repair(app, node) {
		try {
			if (!node.querySelector(ITEM_LIST_SELECTOR)) return;
			if (typeof app.render !== "function") return;
			// Defer to a macrotask: the DestroyableManager's MutationObserver
			// callback runs as a microtask right after the current task, so
			// rendering immediately would race it (it could destroy the freshly
			// created sortables). setTimeout guarantees the destruction runs
			// first, then the re-render recreates them in the popout document.
			setTimeout(async () => {
				try {
					if (node.ownerDocument?.defaultView?.closed) return;
					// focus: false keeps Foundry from chaining maximize() ->
					// bringToTop(), whose popout.focus() without user activation
					// logs "Opening multiple popups was blocked due to lack of
					// user activation". app._render is the async core of render;
					// app.render() returns before the DOM is updated, so we must
					// await _render to reach the freshly rendered lists.
					await app._render(true, { focus: false });
					this._patchPopoutSortables(node);
				} catch (error) {
					console.error(`[${Manager.id}] ${KEY} re-render failed`, error);
				}
			}, 0);
		} catch (error) {
			console.error(`[${Manager.id}] ${KEY} repair failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Popout sortable patches                     */
	/* -------------------------------------------- */

	/**
	 * Two patches are needed for SortableJS instances whose lists live in a
	 * popout window's document:
	 *
	 * 1. Drop-target override. SortableJS's native `drop` listener is bound to
	 *    the MAIN document (module scope of the system's vendor.mjs), so in the
	 *    popout the drag always ends via `dragend` (bound on the dragged
	 *    element). The SortableJS `end` event then carries `originalEvent` = the
	 *    dragend event, whose `.target` is the dragged item — NOT the element
	 *    under the cursor. pf2e's onEnd handler reads that target to find the
	 *    backpack row, so we override `evt.originalEvent.target` with the real
	 *    drop point, captured from the popout's own native `drop` event (which
	 *    does fire on the item lists).
	 *
	 * 2. Disable revertOnSpill. The revertOnSpill plugin's drop handler checks
	 *    `document.elementFromPoint(clientX, clientY)` — always the MAIN
	 *    document — to decide whether the drop landed on a valid list. In the
	 *    popout that check is always wrong (the coordinates are the popout
	 *    window's), so it ALWAYS fires `spill` and moves the dragged item back
	 *    into the source list. For dragging INTO a backpack the source list is
	 *    the root inventory and pf2e's handler happens to undo the revert, but
	 *    for dragging OUT of a backpack the item ends back in the backpack and
	 *    the move silently fails. SortableJS gates every plugin handler on
	 *    `options.revertOnSpill` being truthy, so simply setting it to false on
	 *    popout sortables disables the broken spill detection; the natural
	 *    dragover move + drop-target override then complete the drag exactly
	 *    like the main window.
	 */
	static _patchPopoutSortables(node) {
		const lists = node.querySelectorAll(ITEM_LIST_SELECTOR);
		let patched = 0;
		for (const list of lists) {
			// SortableJS stores the instance on the container at an expando key
			// named `Sortable<timestamp>` (module-scoped, so we find it by prefix).
			const key = Object.getOwnPropertyNames(list).find((name) => name.startsWith("Sortable"));
			const sortable = key ? list[key] : null;
			if (!sortable?.options || typeof sortable.options.onEnd !== "function") continue;
			if (sortable.options.__popoutRepairPatched) continue;
			sortable.options.__popoutRepairPatched = true;
			sortable.options.revertOnSpill = false;

			const originalOnEnd = sortable.options.onEnd;
			sortable.options.onEnd = (evt, originalEvent) => {
				const dropTarget = this._lastDropTarget;
				this._lastDropTarget = null;
				if (evt?.originalEvent && dropTarget) {
					// Keep the original event (prototype chain) but override its
					// target with the real drop-point element.
					const copy = Object.create(evt.originalEvent);
					Object.defineProperty(copy, "target", { value: dropTarget, configurable: true });
					evt.originalEvent = copy;
				}
				return originalOnEnd.call(sortable, evt, originalEvent);
			};
			patched++;

			// Track the drag: reset on dragstart, record the real drop point on
			// the native drop (fires in the popout document, under the cursor).
			list.addEventListener("dragstart", () => {
				this._lastDropTarget = null;
			}, { capture: true });
			list.addEventListener("drop", (event) => {
				this._lastDropTarget = event.target ?? null;
			}, { capture: true });
		}
		console.debug(`[${Manager.id}] ${KEY}: patched ${patched} sortable(s) in popout`);
	}
}
