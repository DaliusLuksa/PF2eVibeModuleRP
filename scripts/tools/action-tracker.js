import { Manager } from "../core/manager.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_STATE = "actionTrackerState";
const MODULE_ROOT = "modules/pf2e-vibemodulerp";

/**
 * Combat Action Tracker.
 *
 * Opens an in-Foundry window automatically when a combat is started and shows
 * who is acting, how many actions they have used, and what they did so far.
 * The GM's client watches chat messages: it resolves each action's cost (spell
 * casting time, action/feat `actionCost`, weapon Strike, plain skill checks),
 * picks a per-action icon (spell artwork or a category default), and broadcasts
 * the whole state to all clients over the module socket, so the same window
 * (read-only on player clients, with manual GM-only correction buttons) stays in
 * sync for everyone. State resets automatically on every combat turn change.
 *
 * Known limitation (accepted): casting the same spell twice in one turn is
 * counted once (the spell card, its attack roll and its damage roll all share
 * one origin uuid, so duplicates are suppressed to avoid triple-counting).
 */
export class ActionTrackerTool {
	static id = "action-tracker";
	static category = "action-tracker";
	static enabledDefault = true;

	static settings = [
		{ key: "actionsPerTurn", type: Number, default: 3, scope: "world" },
		{ key: "state", type: Object, default: null, scope: "world", config: false }
	];

	/** Current turn state, kept in sync on all clients (GM is the source of truth). */
	static _state = {
		active: false,
		combatantId: null,
		combatantName: "",
		combatantImg: "",
		round: 0,
		max: 3,
		used: 0,
		entries: []
	};

	/** Spell item uuids already counted this turn (dedupe; reset on turn change). */
	static _countedSpellUuids = new Set();
	static _window = null;

	/** Chat message context types that never cost actions. */
	static _skipTypes = new Set([
		"saving-throw",
		"damage-roll",
		"flat-check",
		"self-effect",
		"initiative",
		"counteract-check"
	]);

	/** Register the reopen keybind (must happen during init, not ready). */
	static init() {
		game.keybindings.register(Manager.id, "toggleActionTracker", {
			name: Manager.localize("actionTracker.keybindName"),
			hint: Manager.localize("actionTracker.keybindHint"),
			uneditable: [],
			editable: [{ key: "KeyO", modifiers: ["Control", "Alt"] }],
			onDown: () => this._open(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
		});
	}

	static ready() {
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		Hooks.on("combatTurnChange", this._onCombatTurnChange.bind(this));
		Hooks.on("updateCombat", this._onCombatUpdate.bind(this));
		Hooks.on("deleteCombat", this._onCombatDeleted.bind(this));
		Hooks.on("createChatMessage", this._onCreateChatMessage.bind(this));
		Hooks.on("renderCombatTracker", this._onRenderCombatTracker.bind(this));
		// A combat may already be running when the world loads mid-combat; a
		// late joiner/refresher restores the GM's last persisted state instead of
		// starting from an empty turn (it would otherwise only sync on the next action).
		if (game.combat?.started) {
			this._restoreState(game.combat.combatant ?? null, game.combat.round);
			this._open();
			if (game.user.isGM) this._broadcast();
		}
		console.debug(`${Manager.id} | hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Combat lifecycle                             */
	/* -------------------------------------------- */

	static _onCombatTurnChange(combat, previous, current) {
		if (!combat?.started) return;
		// v14: `current` is a CombatHistoryData state object ({ round, turn,
		// combatantId, tokenId }), NOT a Combatant document.
		const combatant = combat.combatants.get(current?.combatantId ?? "") ?? combat.combatant ?? null;
		this._resetTurn(combatant, combat.round);
		this._open();
		if (game.user.isGM) this._broadcast();
	}

	static _onCombatUpdate(combat, changed) {
		if (combat?.started) return;
		if (game.combat?.id !== combat?.id) return;
		// Combat stopped (round reset to 0): close the window and clear state.
		this._state.active = false;
		this._countedSpellUuids.clear();
		this._persistState();
		this._close();
	}

	static _onCombatDeleted(combat) {
		if (game.combat?.id === combat?.id) {
			this._state.active = false;
			this._countedSpellUuids.clear();
			this._persistState();
			this._close();
		}
	}

	/** Start a fresh turn for `combatant` on all clients (GM broadcasts after). */
	static _resetTurn(combatant, round) {
		this._countedSpellUuids.clear();
		this._state = {
			active: true,
			combatantId: combatant?.id ?? null,
			combatantName: combatant?.name ?? "",
			combatantImg: combatant?.actor?.img ?? combatant?.img ?? "",
			round,
			max: Number(Manager.setting(this.id, "actionsPerTurn")) || 3,
			used: 0,
			entries: []
		};
	}

	/**
	 * Restore the GM's last persisted state when joining/reloading mid-combat.
	 * Only adopted if it still matches the current combatant, otherwise we fall
	 * back to a fresh turn (the GM will re-broadcast authoritative state anyway).
	 */
	static _restoreState(combatant, round) {
		let saved = null;
		try {
			saved = game.settings.get(Manager.id, `${this.id}.state`) ?? null;
		} catch (error) {
			console.warn(`${Manager.id} | action-tracker could not read persisted state`, error);
		}
		if (saved?.active && saved.combatantId === combatant?.id) {
			this._state = saved;
		} else {
			this._resetTurn(combatant, round);
		}
	}

	/** GM-only: persist the authoritative state so late joiners can restore it. */
	static _persistState() {
		if (!game.user.isGM) return;
		game.settings.set(Manager.id, `${this.id}.state`, foundry.utils.deepClone(this._state)).catch((error) =>
			console.warn(`${Manager.id} | action-tracker could not persist state`, error)
		);
	}

	/* -------------------------------------------- */
	/*  Detection (GM only)                          */
	/* -------------------------------------------- */

	static _onCreateChatMessage(message) {
		if (!game.user.isGM) return;
		if (!this._state.active) return;
		const combatant = game.combat?.combatant;
		const actor = combatant?.actor;
		if (!actor) return;
		const speaker = message.speakerActor;
		if (!speaker || speaker.uuid !== actor.uuid) return;
		if (message.isReroll) return;

		const flags = message.flags?.pf2e ?? {};
		const context = flags.context ?? {};
		const type = context.type ?? "";
		if (this._skipTypes.has(type)) return;

		const origin = flags.origin ?? null;
		let item = null;
		if (origin?.uuid) {
			try {
				item = fromUuidSync(origin.uuid) ?? null;
			} catch (error) {
				console.debug(`${Manager.id} | action-tracker could not resolve origin uuid`, error);
			}
		}
		const cost = this._resolveCost(item, type);
		if (cost === null) return;

		const isSpell = !!item?.isOfType?.("spell");
		if (isSpell) {
			if (this._countedSpellUuids.has(origin.uuid)) return;
			this._countedSpellUuids.add(origin.uuid);
		}

		const name = this._resolveName(item, context, type);
		this._state.entries.push({ name, cost, icon: this._iconFor(item, type) });
		this._state.used += cost;
		this._broadcast();
	}

	/** Return the action cost (number) or null when the message is not an action. */
	static _resolveCost(item, type) {
		if (item?.isOfType?.("spell")) return this._spellCost(item.system?.time?.value);
		if (item && typeof item.actionCost === "object" && item.actionCost) {
			const ac = item.actionCost;
			return ac.type === "action" ? (ac.value ?? 1) : 0;
		}
		if (type === "attack-roll") return 1;
		if (type === "skill-check" || type === "perception-check") return 1;
		return null;
	}

	/**
	 * Pick the per-entry icon: `{ img }` (spell artwork) or `{ fa }` (Font Awesome
	 * class). Spells always show their own item image; everything else falls back
	 * to category defaults (sword/bow/fist, star, bolt, person-running, dice-d20).
	 */
	static _iconFor(item, type) {
		if (item?.isOfType?.("spell")) return { img: item.img };
		if (item?.isOfType?.("weapon", "melee")) {
			const unarmed = item.system?.category === "unarmed" || item.system?.traits?.value?.includes?.("unarmed");
			if (unarmed) return { fa: "fa-hand-fist" };
			return { fa: item.isMelee ? "fa-sword" : "fa-bow-arrow" };
		}
		if (item && typeof item.actionCost === "object" && item.actionCost) return { fa: "fa-star" };
		if (type === "attack-roll") return { fa: "fa-sword" };
		if (type === "skill-check" || type === "perception-check") return { fa: "fa-dice-d20" };
		return { fa: "fa-star" };
	}

	/** Parse a spell's casting time string into an action cost. */
	static _spellCost(value) {
		const t = String(value ?? "").trim().toLowerCase();
		if (t === "reaction" || t === "free") return 0;
		if (/^\d+$/.test(t)) return Math.min(Number(t), 3);
		if (t === "1 to 3" || t === "1 or 2") return 1;
		if (t === "2 or 3") return 2;
		return 0; // minutes, rounds, etc.
	}

	static _resolveName(item, context, type) {
		if (item?.name) return item.name;
		const title = context.title ?? "";
		if (title) {
			const localized = game.i18n.localize(title);
			return (localized && localized !== title) ? localized : title;
		}
		return type || "Action";
	}

	/* -------------------------------------------- */
	/*  Manual GM corrections                        */
	/* -------------------------------------------- */

	static spend(cost) {
		if (!game.user.isGM || !this._state.active) return;
		const n = Number(cost) || 1;
		this._state.entries.push({ name: Manager.localize("actionTracker.manual"), cost: n, icon: { fa: "fa-hand-point-up" } });
		this._state.used += n;
		this._broadcast();
	}

	static spendFree() {
		if (!game.user.isGM || !this._state.active) return;
		this._state.entries.push({ name: Manager.localize("actionTracker.free"), cost: 0, icon: { fa: "fa-bolt" } });
		this._broadcast();
	}

	static spendReaction() {
		if (!game.user.isGM || !this._state.active) return;
		this._state.entries.push({ name: Manager.localize("actionTracker.reaction"), cost: 0, icon: { fa: "fa-person-running" } });
		this._broadcast();
	}

	static undo() {
		if (!game.user.isGM || !this._state.active) return;
		const entry = this._state.entries.pop();
		if (entry) this._state.used = Math.max(0, this._state.used - entry.cost);
		this._broadcast();
	}

	static newTurn() {
		if (!game.user.isGM || !this._state.active) return;
		this._countedSpellUuids.clear();
		this._state.entries = [];
		this._state.used = 0;
		this._broadcast();
	}

	/* -------------------------------------------- */
	/*  Socket + window                              */
	/* -------------------------------------------- */

	static _broadcast() {
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_STATE, state: this._state });
		this._persistState();
		this._render();
	}

	static _onSocketMessage(data, userId) {
		try {
			if (data?.action !== SOCKET_ACTION_STATE) return;
			const sender = game.users.get(userId);
			if (!sender?.isGM) return;
			this._state = data.state;
			this._render();
		} catch (error) {
			console.error(`${Manager.id} | action-tracker socket handler failed`, error);
		}
	}

	static _open() {
		if (!this._window) this._window = new ActionTrackerWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the action tracker`, error)
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
				console.warn(`${Manager.id} | could not re-render the action tracker`, error)
			);
		}
	}

	static _toggleWindow() {
		if (this._window?.rendered) this._close();
		else this._open();
	}

	static _context() {
		const s = this._state;
		return {
			active: s.active,
			combatantName: s.combatantName,
			combatantImg: s.combatantImg,
			round: s.round,
			used: s.used,
			max: s.max,
			remaining: Math.max(0, s.max - s.used),
			entries: s.entries,
			isGM: game.user.isGM,
			i18n: (key) => Manager.localize(`actionTracker.${key}`)
		};
	}

	/* -------------------------------------------- */
	/*  Combat tracker header toggle (GM only)       */
	/* -------------------------------------------- */

	static _onRenderCombatTracker(app, html) {
		if (!game.user.isGM) return;
		const element = html?.jquery ? html[0] : html;
		const nav = element?.querySelector?.(".combat-tracker-header nav.encounters");
		if (!nav || nav.querySelector(".vibe-action-tracker-toggle")) return;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "inline-control icon fa-solid fa-stopwatch vibe-action-tracker-toggle";
		button.dataset.tooltip = Manager.localize("actionTracker.toggleTooltip");
		button.setAttribute("aria-label", Manager.localize("actionTracker.toggleTooltip"));
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this._toggleWindow();
		});
		const gear = element.querySelector(".combat-tracker-header nav [data-action='trackerSettings']");
		if (gear) nav.insertBefore(button, gear);
		else nav.append(button);
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class ActionTrackerWindow extends foundry.applications.api.HandlebarsApplicationMixin(
	foundry.applications.api.ApplicationV2
) {
	static DEFAULT_OPTIONS = {
		id: "action-tracker",
		classes: ["vibe-action-tracker"],
		position: { width: 320 },
		window: {
			icon: "fa-solid fa-stopwatch",
			resizable: true
		},
		actions: {
			spend: (event, target) => ActionTrackerTool.spend(Number(target.dataset.cost ?? 1)),
			free: () => ActionTrackerTool.spendFree(),
			reaction: () => ActionTrackerTool.spendReaction(),
			undo: () => ActionTrackerTool.undo(),
			newTurn: () => ActionTrackerTool.newTurn()
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/action-tracker.hbs`, root: true }
	};

	get title() {
		return Manager.localize("actionTracker.title");
	}

	_prepareContext(options) {
		return ActionTrackerTool._context();
	}
}
