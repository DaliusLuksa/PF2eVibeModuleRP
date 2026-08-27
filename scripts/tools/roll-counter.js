import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_DELTA = "rollCounterDelta";
const SOCKET_ACTION_CLEAR = "rollCounterClear";
const MODULE_ROOT = "modules/pf2e-vibemodulerp";

/**
 * Roll Counter.
 *
 * Counts every die roll made in the world, bucketed by the face value of
 * each individual die result (1-20) and by the actual user who made the
 * roll. d20 rolls are split into three categories: all rolls, rolls that
 * happened outside combat, and rolls that happened while a combat was
 * running. Rolls that contain no d20 (e.g. weapon damage dice) go into a
 * separate Non-D20 category, bucketed on the same 1-20 axis by each die's
 * face (a d8 rolling 7 lands in bucket 7). Each die result is counted
 * separately unless it was dropped (Fortune/Misfortune `kh`/`kl` mark the
 * discarded dice inactive, so only the kept faces are counted). The GM's
 * client is the recorder: it watches every chat message (players' and its
 * own), extracts the face of every active die, appends the entries to a
 * persisted world-setting log with a timestamp, and broadcasts only the new
 * entries over the module socket so every player's window stays in sync.
 * Rerolls are counted as their own rolls.
 */
export class RollCounterTool {
	static id = "roll-counter";
	static category = "roll-counter";
	static enabledDefault = true;

	static settings = [
		{ key: "state", type: Object, default: null, scope: "world", config: false },
		{
			key: "showClear",
			type: Boolean,
			default: false,
			scope: "world",
			config: true,
			onChange: () => RollCounterTool._render()
		}
	];

	/** The full roll log (`{ entries: [...] }`), authoritative on the GM. */
	static _state = { entries: [] };

	/** Entry ids already known locally (dedupes socket deltas and reloads). */
	static _seen = new Set();

	static _window = null;

	/** Register the reopen keybind (must happen during init, not ready). */
	static init() {
		game.keybindings.register(Manager.id, "toggleRollCounter", {
			name: Manager.localize("rollCounter.keybindName"),
			hint: Manager.localize("rollCounter.keybindHint"),
			uneditable: [],
			editable: [{ key: "F8", modifiers: [] }],
			onDown: () => this._open(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
		});
	}

	static ready() {
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		this._loadState();
		if (game.user.isGM) {
			Hooks.on("createChatMessage", this._onCreateChatMessage.bind(this));
		}
		console.debug(`${Manager.id} | roll-counter hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Persistence                                  */
	/* -------------------------------------------- */

	static _loadState() {
		try {
			const saved = game.settings.get(Manager.id, `${this.id}.state`) ?? null;
			this._state = saved && Array.isArray(saved.entries) ? { entries: saved.entries } : { entries: [] };
		} catch (error) {
			console.warn(`${Manager.id} | roll-counter could not read persisted state`, error);
			this._state = { entries: [] };
		}
		this._seen = new Set(this._state.entries.map((entry) => entry?.id).filter(Boolean));
	}

	/** GM-only: persist the authoritative log so reloads/joiners can restore it. */
	static _persistState() {
		if (!game.user.isGM) return;
		game.settings.set(Manager.id, `${this.id}.state`, foundry.utils.deepClone(this._state)).catch((error) =>
			console.warn(`${Manager.id} | roll-counter could not persist state`, error)
		);
	}

	/* -------------------------------------------- */
	/*  Recording (GM only)                          */
	/* -------------------------------------------- */

	static _onCreateChatMessage(message) {
		if (!game.user.isGM) return;
		if (!message?.author) return;
		const inCombat = !!game.combat?.started;
		const actorName = message.speakerActor?.name ?? message.speaker?.alias ?? "";
		const type = message.flags?.pf2e?.context?.type ?? "";
		const ts = message.timestamp ?? Date.now();
		const newEntries = [];
		(message.rolls ?? []).forEach((roll, index) => {
			const d20Faces = this._dieFaces(roll, 20);
			const hasD20 = d20Faces.length > 0;
			const faces = hasD20 ? d20Faces : this._dieFaces(roll, null);
			faces.forEach((result, dieIndex) => {
				newEntries.push({
					id: `${message.id}:${index}:${dieIndex}`,
					userId: message.author.id,
					userName: message.author.name,
					actorName,
					type,
					result,
					nonD20: !hasD20,
					inCombat,
					ts
				});
			});
		});
		if (!newEntries.length) return;
		if (!this._appendEntries(newEntries)) return;
		this._emitDelta(newEntries);
		this._persistState();
		this._render();
	}

	/**
	 * The face values of every active die result in a Roll. With
	 * `targetFaces` set, only dice with exactly that face count are read
	 * (e.g. 20 for the d20 categories); with `null`, everything except d20
	 * and Coin/Fate dice is read. Each die result counts separately (`2d20`
	 * yields two faces), dropped Fortune/Misfortune dice (inactive results)
	 * are skipped, and every face is clamped to 1-20 so non-d20 dice bucket
	 * onto the shared chart axis.
	 */
	static _dieFaces(roll, targetFaces) {
		const faces = [];
		for (const die of roll?.dice ?? []) {
			if (die instanceof foundry.dice.terms.Coin || die instanceof foundry.dice.terms.FateDie) continue;
			const d = Number(die.faces);
			if (!Number.isInteger(d) || d < 2) continue;
			if (targetFaces !== null && d !== targetFaces) continue;
			for (const result of die.results ?? []) {
				if (!result.active || result.discarded) continue;
				const count = result.count ?? 1;
				for (let i = 0; i < count; i++) {
					faces.push(Math.min(Math.max(Math.trunc(Number(result.result)), 1), 20));
				}
			}
		}
		return faces;
	}

	/** Append entries that aren't known locally; returns how many were added. */
	static _appendEntries(entries) {
		let added = 0;
		for (const entry of entries ?? []) {
			if (!entry?.id || this._seen.has(entry.id)) continue;
			this._seen.add(entry.id);
			this._state.entries.push(entry);
			added++;
		}
		return added;
	}

	/** GM-only: wipe the log on every client. */
	static clear() {
		if (!game.user.isGM) return;
		this._state = { entries: [] };
		this._seen.clear();
		if (this._window) {
			this._window._defaulted = false;
			this._window._selectedUserId = "";
			this._window._selectedDate = "";
		}
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_CLEAR });
		this._persistState();
		this._render();
	}

	/** GM-only: ask for confirmation before wiping the log on every client. */
	static async clearWithConfirmation() {
		if (!game.user.isGM) return;
		const count = this._state.entries.length;
		let confirmed = false;
		await foundry.applications.api.DialogV2.wait({
			modal: true,
			content: `<p>${Manager.localize("rollCounter.clearConfirm", { count })}</p>`,
			buttons: [
				{
					action: "confirm",
					label: Manager.localize("rollCounter.clear"),
					default: true,
					callback: () => {
						confirmed = true;
					}
				},
				{
					action: "cancel",
					label: game.i18n.localize("Cancel")
				}
			],
			window: { title: Manager.localize("rollCounter.clearTitle") }
		}).catch(() => null);
		if (confirmed) this.clear();
	}

	/* -------------------------------------------- */
	/*  Socket + window                              */
	/* -------------------------------------------- */

	static _emitDelta(entries) {
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_DELTA, entries });
	}

	static _onSocketMessage(data, userId) {
		try {
			const sender = game.users.get(userId);
			if (!sender?.isGM) return;
			if (data?.action === SOCKET_ACTION_DELTA) {
				if (this._appendEntries(data.entries ?? [])) this._render();
			} else if (data?.action === SOCKET_ACTION_CLEAR) {
				this._state = { entries: [] };
				this._seen.clear();
				this._render();
			}
		} catch (error) {
			console.error(`${Manager.id} | roll-counter socket handler failed`, error);
		}
	}

	static _open() {
		if (!this._window) this._window = new RollCounterWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the roll counter`, error)
		);
	}

	static _close() {
		if (this._window) {
			this._window.close().catch(() => null);
			this._window = null;
		}
	}

	static _render() {
		if (this._window?.rendered) {
			this._window.render().catch((error) =>
				console.warn(`${Manager.id} | could not re-render the roll counter`, error)
			);
		}
	}

	static _toggleWindow() {
		if (this._window?.rendered) this._close();
		else this._open();
	}

	/* -------------------------------------------- */
	/*  Aggregation                                  */
	/* -------------------------------------------- */

	/**
	 * Build the window context. `selectedUserId` is per-window UI state ("" =
	 * all players); `selectedDate` is per-window state ("" = the current
	 * session day) and is preserved so re-renders keep the same day; the
	 * active tab id comes from the window's `tabGroups`.
	 */
	static _context(selectedUserId = "", activeTab = "all", selectedDate = "") {
		const entries = this._entriesForDate(selectedDate);
		const categories = this._aggregate(entries);
		const users = this._usersForSelect();
		const defs = [
			["all", "tabAll"],
			["outside", "tabOutside"],
			["combat", "tabCombat"],
			["nonD20Combat", "tabNonD20Combat"],
			["nonD20Outside", "tabNonD20Outside"]
		];
		const tabs = defs.map(([id, labelKey]) => {
			const category = categories[id];
			const players = selectedUserId ? category.players.filter((p) => p.uid === selectedUserId) : category.players;
			return {
				id,
				label: Manager.localize(`rollCounter.${labelKey}`),
				rolls: players.reduce((sum, p) => sum + p.total, 0),
				charts: players.map((p) => this._chartFor(p))
			};
		});
		const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];
		if (active) active.active = true;
		const today = this._dayKey(Date.now());
		return {
			tabs,
			users,
			sessions: this._sessionsForSelect(),
			currentSessionLabel: Manager.localize("rollCounter.currentSession", { date: today }),
			selectedUserId,
			selectedDate,
			showClear: game.user.isGM && game.settings.get(Manager.id, "roll-counter.showClear"),
			i18n: (key) => Manager.localize(`rollCounter.${key}`)
		};
	}

	/** Local date key (`YYYY-MM-DD`) for a timestamp. */
	static _dayKey(ts) {
		const d = new Date(ts ?? Date.now());
		const s = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${s(d.getMonth() + 1)}-${s(d.getDate())}`;
	}

	/** Restrict entries to one session day ("" = the current calendar day). */
	static _entriesForDate(selectedDate) {
		const key = selectedDate || this._dayKey(Date.now());
		return this._state.entries.filter((entry) => this._dayKey(entry.ts) === key);
	}

	/** Session-day options for the dropdown: past days ("" already covers today). */
	static _sessionsForSelect() {
		const today = this._dayKey(Date.now());
		const seen = new Set();
		for (const entry of this._state.entries) {
			const day = this._dayKey(entry.ts);
			if (day !== today) seen.add(day);
		}
		return [...seen]
			.sort((a, b) => b.localeCompare(a))
			.map((day) => ({ day, label: Manager.localize("rollCounter.session", { day }) }));
	}

	static _aggregate(entries) {
		return {
			all: this._countByPlayer(entries.filter((entry) => !entry.nonD20)),
			outside: this._countByPlayer(entries.filter((entry) => !entry.inCombat && !entry.nonD20)),
			combat: this._countByPlayer(entries.filter((entry) => entry.inCombat && !entry.nonD20)),
			nonD20Combat: this._countByPlayer(entries.filter((entry) => entry.inCombat && entry.nonD20)),
			nonD20Outside: this._countByPlayer(entries.filter((entry) => !entry.inCombat && entry.nonD20))
		};
	}

	/** Group a set of entries by user and bucket results 1-20. */
	static _countByPlayer(entries) {
		const byUser = new Map();
		for (const entry of entries) {
			const name = entry.userName ?? entry.userId ?? "?";
			const uid = entry.userId ?? name;
			let row = byUser.get(uid);
			if (!row) {
				row = { uid, name, total: 0, buckets: new Array(20).fill(0) };
				byUser.set(uid, row);
			}
			const r = Math.min(Math.max(Math.trunc(entry.result ?? 0), 1), 20);
			row.buckets[r - 1]++;
			row.total++;
		}
		return {
			count: [...byUser.values()].reduce((sum, p) => sum + p.total, 0),
			players: [...byUser.values()].sort((a, b) => b.total - a.total)
		};
	}

	/** Distinct users who have rolled, for the filter dropdown (sorted by name). */
	static _usersForSelect() {
		const seen = new Map();
		for (const entry of this._state.entries) {
			const uid = entry.userId ?? entry.userName ?? "?";
			const name = entry.userName ?? uid;
			if (!seen.has(uid)) seen.set(uid, name);
		}
		return [...seen.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Build the chart data for one player (bars 1-20, Y scaled to their max). */
	static _chartFor(player) {
		const height = 150; // px, must match .rc-plot height in roll-counter.css
		const max = Math.max(...player.buckets, 1);
		return {
			name: player.name,
			total: player.total,
			max,
			mid: max > 1 ? Math.round(max / 2) : 0,
			xLabels: Array.from({ length: 20 }, (_, i) => i + 1),
			bars: player.buckets.map((n, i) => {
				const v = i + 1;
				return {
					v,
					n,
					px: max ? Math.round((n / max) * height) : 0,
					left: (v - 1) * 5 + 0.25,
					highlight: v === 1 ? "rc-nat1" : v === 20 ? "rc-nat20" : ""
				};
			})
		};
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class RollCounterWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(
		foundry.applications.api.ApplicationV2
	)
) {
	static DEFAULT_OPTIONS = {
		id: "roll-counter",
		classes: ["vibe-roll-counter"],
		position: { width: 420 },
		window: {
			icon: "fa-solid fa-dice-d20",
			resizable: true
		},
		actions: {
			clear: () => RollCounterTool.clearWithConfirmation()
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/roll-counter.hbs`, root: true }
	};

	get title() {
		return Manager.localize("rollCounter.title");
	}

	constructor(args) {
		super(args);
		/** Per-window state: which user's rolls to show ("" = all players). */
		this._selectedUserId = "";
		/** Per-window state: which session day to show ("" = the current day). */
		this._selectedDate = "";
		this._defaulted = false;
	}

	_prepareContext(options) {
		if (!this._defaulted) {
			this._defaulted = true;
			const users = RollCounterTool._usersForSelect();
			this._selectedUserId = users.some((user) => user.id === game.user.id)
				? game.user.id
				: users[0]?.id ?? "";
		}
		return RollCounterTool._context(this._selectedUserId, this.tabGroups?.categories ?? "all", this._selectedDate);
	}

	_onRender(context, options) {
		const selects = this.element?.querySelectorAll("[data-roll-counter-user], [data-roll-counter-session]");
		selects?.forEach((element) => {
			element.addEventListener("change", (event) => {
				if (element.dataset.rollCounterUser !== undefined) this._selectedUserId = event.target.value ?? "";
				else this._selectedDate = event.target.value ?? "";
				this.render({ focus: false }).catch(() => null);
			});
		});
	}
}