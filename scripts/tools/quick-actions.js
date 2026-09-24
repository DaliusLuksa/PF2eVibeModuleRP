import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";

const MODULE_ROOT = "modules/pf2e-vibemodulerp";
const CONFIG_PATH = `${MODULE_ROOT}/data/quick-actions.json`;

/**
 * Quick Actions browser.
 *
 * A compendium-browser-style window (filters left, results right) holding
 * frequently used macros and actions. Rows are clickable (use in place)
 * and draggable (drop onto the hotbar). The entry list lives in the
 * editable `data/quick-actions.json` config, so new macros/actions can be
 * added without code changes (world reload required).
 *
 * v1 entries:
 * - "Treat Wounds and Battle Medicine" (kind: macro) — resolves by world
 *   macro id first, then the Symon/Workbench compendium by pack+name, then
 *   the recorded compendium UUID. Click executes it.
 * - "Demoralize" (kind: action) — the system's Demoralize action. Click
 *   runs exactly what the action's "Intimidation" inline link runs:
 *   `game.pf2e.actions.demoralize`, fully automatic (roll dialogs hidden
 *   in-memory). Dragging it to the hotbar uses core behavior for Item
 *   drops (a sheet-toggle macro, same as dragging from a compendium).
 */
export class QuickActionsTool {
	static id = "quick-actions";
	static category = "feature-hub";
	static enabledDefault = true;

	static _window = null;
	static _config = null;
	static _docs = new Map();
	static _search = "";
	static _showMacro = true;
	static _showAction = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static init() {
		game.keybindings.register(Manager.id, "openQuickActions", {
			name: Manager.localize("quickActions.keybindName"),
			hint: Manager.localize("quickActions.keybindHint"),
			uneditable: [],
			editable: [{ key: "KeyQ", modifiers: ["Control", "Alt"] }],
			onDown: () => this._toggleWindow(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
		});
	}

	static async ready() {
		await this._loadConfig().catch((error) =>
			console.warn(`${Manager.id} | quick-actions config load failed, using defaults`, error)
		);
	}

	/* -------------------------------------------- */
	/*  Config + resolution                         */
	/* -------------------------------------------- */

	static _defaults() {
		return [
			{
				id: "treat-wounds-battle-medicine",
				kind: "macro",
				name: "Treat Wounds and Battle Medicine",
				worldMacroId: "Dmwlp47393HlG6Ci",
				pack: "xdy-pf2e-workbench.asymonous-benefactor-macros",
				entryName: "Treat Wounds and Battle Medicine",
				uuid: "Compendium.xdy-pf2e-workbench.asymonous-benefactor-macros.Macro.uI6B58l6g0ZnlUY6",
				img: "systems/pf2e/icons/conditions/wounded.webp"
			},
			{
				id: "demoralize",
				kind: "action",
				name: "Demoralize",
				uuid: "Compendium.pf2e.actionspf2e.Item.2u915NdUyQan6uKF",
				img: "icons/skills/social/intimidation-impressing.webp"
			}
		];
	}

	static async _loadConfig() {
		try {
			const response = await fetch(CONFIG_PATH);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const json = await response.json();
			const entries = Array.isArray(json?.entries) ? json.entries : null;
			this._config = entries?.length ? entries : this._defaults();
		} catch {
			this._config = this._defaults();
		}
	}

	static entries() {
		return this._config ?? this._defaults();
	}

	/** Resolve every entry to a live Document (world macro → compendium name → UUID). */
	static async _resolveAll() {
		const resolved = new Map();
		for (const entry of this.entries()) {
			resolved.set(entry.id, await this._resolveEntry(entry).catch(() => null));
		}
		this._docs = resolved;
	}

	static async _resolveEntry(entry) {
		if (entry?.kind === "macro") {
			if (entry.worldMacroId) {
				const worldMacro = game.macros?.get(entry.worldMacroId) ?? null;
				if (worldMacro) return worldMacro;
			}
			if (entry.pack && entry.entryName) {
				try {
					const pack = game.packs.get(entry.pack);
					const found = pack ? (await pack.getDocuments({ name: entry.entryName }))?.[0] : null;
					if (found) return found;
				} catch {
					/* fall through to the UUID */
				}
			}
		}
		if (entry?.uuid) {
			try {
				const doc = await fromUuid(entry.uuid);
				if (doc) return doc;
			} catch {
				/* unresolved */
			}
		}
		return null;
	}

	/* -------------------------------------------- */
	/*  Window management                           */
	/* -------------------------------------------- */

	static async _openWindow() {
		await this._resolveAll();
		if (!this._window) this._window = new QuickActionsWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open quick actions`, error)
		);
	}

	static _closeWindow() {
		if (this._window) {
			this._window.close().catch(() => null);
			this._window = null;
		}
	}

	static _toggleWindow() {
		if (this._window?.rendered) this._closeWindow();
		else this._openWindow();
	}

	static _render() {
		this._window?.render({ force: false }).catch(() => null);
	}

	/* -------------------------------------------- */
	/*  Context                                     */
	/* -------------------------------------------- */

	static _context() {
		const rows = this.entries().map((entry) => {
			const doc = this._docs.get(entry.id) ?? null;
			return {
				id: entry.id,
				kind: entry.kind,
				name: doc?.name ?? entry.name,
				img: doc?.img ?? entry.img ?? "icons/svg/dice-target.svg",
				kindLabel: Manager.localize(`quickActions.kind${entry.kind === "action" ? "Action" : "Macro"}`),
				missing: !doc,
				uuid: doc?.uuid ?? entry.uuid ?? null
			};
		});
		return {
			search: this._search,
			showMacro: this._showMacro,
			showAction: this._showAction,
			rows,
			i18n: (key) => Manager.localize(`quickActions.${key}`)
		};
	}

	/* -------------------------------------------- */
	/*  Use (click)                                 */
	/* -------------------------------------------- */

	static async _use(entryId, event) {
		const entry = this.entries().find((e) => e.id === entryId);
		if (!entry) return;
		const doc = this._docs.get(entryId) ?? (await this._resolveEntry(entry).catch(() => null));
		if (!doc) {
			ui.notifications.warn(Manager.localize("quickActions.notifyNotFound", { name: entry.name }));
			return;
		}
		this._docs.set(entryId, doc);
		if ((entry.kind ?? "macro") === "action") await this._useAction(entry, event);
		else await this._executeMacro(doc);
	}

	static async _useAction(entry, event) {
		// Demoralize runs exactly what the action's "Intimidation" inline
		// link runs: the system's demoralize action check. Fully automatic —
		// roll dialogs are hidden in-memory for the call (shift-click still
		// forces the dialog, matching the module's macro convention).
		if (entry.id === "demoralize") {
			const fn = game.pf2e?.actions?.demoralize;
			if (typeof fn !== "function") {
				ui.notifications.warn(Manager.localize("quickActions.notifyNoSystemAction"));
				return;
			}
			let prevCheck;
			let prevDamage;
			try {
				prevCheck = game.user.flags.pf2e.settings.showCheckDialogs;
				prevDamage = game.user.flags.pf2e.settings.showDamageDialogs;
				game.user.flags.pf2e.settings.showCheckDialogs = false;
				game.user.flags.pf2e.settings.showDamageDialogs = false;
			} catch {}
			try {
				await fn({ event });
			} catch (error) {
				console.error(`${Manager.id} | quick-actions demoralize failed`, error);
				ui.notifications.error(Manager.localize("quickActions.notifyFailed", { name: entry.name }));
			} finally {
				try {
					if (prevCheck !== undefined) game.user.flags.pf2e.settings.showCheckDialogs = prevCheck;
					if (prevDamage !== undefined) game.user.flags.pf2e.settings.showDamageDialogs = prevDamage;
				} catch {}
			}
			return;
		}
		// Generic action entries: open the underlying Item sheet.
		try {
			const doc = this._docs.get(entry.id);
			if (doc?.sheet) await doc.sheet.render(true);
		} catch (error) {
			console.error(`${Manager.id} | quick-actions use failed`, error);
		}
	}

	static async _executeMacro(doc) {
		try {
			// Compendium macros may not be executable as-is; run them via an
			// ephemeral owned copy (the same dance the Symon link-macros use).
			let exec = doc;
			if (!doc.canExecute) {
				const cls = getDocumentClass("Macro");
				exec = new cls(
					foundry.utils.mergeObject(
						doc.toObject(),
						{ "-=_id": null, ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } },
						{ performDeletions: true, inplace: false }
					)
				);
			}
			await exec.execute();
		} catch (error) {
			console.error(`${Manager.id} | quick-actions macro failed`, error);
			ui.notifications.error(Manager.localize("quickActions.notifyFailed", { name: doc?.name ?? "macro" }));
		}
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class QuickActionsWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2)
) {
	static DEFAULT_OPTIONS = {
		id: "quick-actions",
		classes: ["vibe-quick-actions"],
		position: { width: 720, height: 500 },
		window: {
			icon: "fa-solid fa-bolt",
			resizable: true,
			minimizable: true
		},
		actions: {
			async useEntry(event, target) {
				const id = target?.dataset?.id ?? target?.closest?.("[data-id]")?.dataset?.id;
				if (id) await QuickActionsTool._use(id, event);
			},
			clearFilters() {
				QuickActionsTool._search = "";
				QuickActionsTool._showMacro = true;
				QuickActionsTool._showAction = true;
				QuickActionsTool._render();
			}
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/quick-actions.hbs`, root: true }
	};

	get title() {
		return Manager.localize("quickActions.title");
	}

	_prepareContext(options) {
		return QuickActionsTool._context();
	}

	_onRender(context, options) {
		super._onRender?.(context, options);
		const root = this.element;
		if (!root) return;

		// Delivery probe: new stylesheets have silently failed to land
		// client-side before (see ranger-flurry post-mortem), which renders
		// as unstyled single-column content with full-size images. Log the
		// live state so a broken layout is diagnosable from the console.
		try {
			const ours = [...document.styleSheets].filter((s) => (s.href ?? "").includes("quick-actions.css"));
			let rules = "n/a";
			try {
				rules = ours.map((s) => s.cssRules.length).join(",");
			} catch {
				rules = "blocked";
			}
			const grid = (() => {
				try {
					return getComputedStyle(root.querySelector(".qa-browser-tab"))?.display ?? "n/a";
				} catch {
					return "n/a";
				}
			})();
			console.log(
				`${Manager.id} | quick-actions stylesheet sheets=${ours.length} rules=[${rules}] layout=${grid}`
			);
		} catch {
			/* diagnostics must never break the window */
		}

		const applyFilter = () => {
			const query = (QuickActionsTool._search ?? "").trim().toLowerCase();
			for (const row of root.querySelectorAll(".qa-row")) {
				const kind = row.dataset.kind;
				if (kind === "macro" && !QuickActionsTool._showMacro) {
					row.hidden = true;
					continue;
				}
				if (kind === "action" && !QuickActionsTool._showAction) {
					row.hidden = true;
					continue;
				}
				if (query && !(row.dataset.name ?? "").toLowerCase().includes(query)) {
					row.hidden = true;
					continue;
				}
				row.hidden = false;
			}
			const anyVisible = [...root.querySelectorAll(".qa-row")].some((row) => !row.hidden);
			const empty = root.querySelector(".qa-empty");
			if (empty) empty.hidden = anyVisible;
		};

		const search = root.querySelector("input[name='search']");
		if (search) {
			if (search.value !== QuickActionsTool._search) search.value = QuickActionsTool._search;
			search.addEventListener("input", () => {
				QuickActionsTool._search = search.value;
				applyFilter();
			});
		}
		for (const name of ["showMacro", "showAction"]) {
			const box = root.querySelector(`input[name='${name}']`);
			if (box) {
				box.addEventListener("change", () => {
					QuickActionsTool[name === "showMacro" ? "_showMacro" : "_showAction"] = box.checked;
					applyFilter();
				});
			}
		}

		// Draggable rows: publish canonical drag data so drops onto the
		// hotbar behave exactly like dragging from the sidebar/compendium
		// (macros are copied into the world on drop by core).
		for (const row of root.querySelectorAll(".qa-row[data-uuid]")) {
			row.addEventListener("dragstart", (event) => {
				try {
					const doc = QuickActionsTool._docs.get(row.dataset.id);
					const data = doc?.toDragData?.() ?? { type: row.dataset.kind === "action" ? "Item" : "Macro", uuid: row.dataset.uuid };
					event.dataTransfer.setData("text/plain", JSON.stringify(data));
				} catch {
					/* leave the drag without payload rather than breaking it */
				}
			});
		}

		applyFilter();
	}
}
