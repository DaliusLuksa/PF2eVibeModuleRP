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
 * casting time, action/feat `actionCost`, "Apply Effect"/self-effect cards,
 * consumable "Use" messages, weapon Strike, plain skill checks),
 * and counts token movement from the Foundry `moveToken` hook (the terrain-aware
 * measured cost pf2e's token ruler already computes), picks a per-action icon
 * (spell artwork or a category default), and broadcasts
 * the whole state to all clients over the module socket, so the same window
 * (read-only on player clients, with manual GM-only correction buttons) stays in
 * sync for everyone. State resets automatically on every combat turn change.
 * Consecutive token moves merge into a single cumulative "Move (N ft)" entry;
 * any non-move action taken in between ends the chain, so the next move logs fresh.
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
		combatId: null,
		combatantId: null,
		combatantName: "",
		combatantImg: "",
		round: 0,
		max: 3,
		used: 0,
		entries: [],
		// Consecutive-move chain: cumulative cost/distance/actions while the
		// combatant only moves, so repeated moves merge into one entry. Reset on
		// turn change and whenever any non-move action is logged.
		movement: null,
		// Combatant affiliation/control (GM-driven per turn). Player clients only
		// render the full window for party members; `hideAll` narrows that further.
		friendly: false,
		playerControlled: false,
		// GM toggles: `hideAll` keeps only player-controlled party members visible
		// on player clients; `disabled` blanks the window for everyone ("Action
		// Tracker disabled by GM") and stops counting on the GM's client.
		hideAll: false,
		disabled: false
	};

	/** Spell item uuids already counted this turn (dedupe; reset on turn change). */
	static _countedSpellUuids = new Set();
	static _window = null;

	/** Chat message context types that never cost actions. `self-effect` is NOT
	 * here: it is handled explicitly in `_onCreateChatMessage` (Apply Effect). */
	static _skipTypes = new Set([
		"saving-throw",
		"damage-roll",
		"flat-check",
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
		Hooks.on("moveToken", this._onTokenMove.bind(this));
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
		this._resetTurn(combatant, combat.round, combat.id);
		this._open();
		if (game.user.isGM) this._broadcast();
	}

	static _onCombatUpdate(combat, changed) {
		if (combat?.started) return;
		// Track the combat we are following by its own id: at `deleteCombat` time
		// `game.combat` is usually already null (core nulls `ui.combat.viewed`
		// before the hook fires), so it cannot be used to recognize our combat.
		const tracked = this._state.combatId ?? game.combat?.id ?? null;
		if (tracked && tracked !== combat.id) return;
		// Combat stopped (round reset to 0): close the window and clear state.
		this._state.active = false;
		this._countedSpellUuids.clear();
		// GM toggles are per-combat session switches: reset for the next combat.
		this._state.hideAll = false;
		this._state.disabled = false;
		this._persistState();
		this._close();
	}

	static _onCombatDeleted(combat) {
		const tracked = this._state.combatId ?? game.combat?.id ?? null;
		if (tracked && tracked !== combat.id) return;
		this._state.active = false;
		this._countedSpellUuids.clear();
		this._state.hideAll = false;
		this._state.disabled = false;
		this._persistState();
		this._close();
	}

	/** Start a fresh turn for `combatant` on all clients (GM broadcasts after). */
	static _resetTurn(combatant, round, combatId = null) {
		this._countedSpellUuids.clear();
		const actor = this._combatantActor(combatant);
		this._state = {
			active: true,
			combatId: combatId ?? game.combat?.id ?? null,
			combatantId: combatant?.id ?? null,
			combatantName: combatant?.name ?? "",
			combatantImg: combatant?.actor?.img ?? combatant?.img ?? "",
			round,
			max: Number(Manager.setting(this.id, "actionsPerTurn")) || 3,
			used: 0,
			entries: [],
			movement: null,
			// Whether this combatant is on the players' side (pf2e alliance
			// "party") and is actually owned by a non-GM player. Non-party
			// combatants are hidden on player clients ("Enemy's turn"); when the
			// GM enables `hideAll`, only player-controlled party members stay
			// visible. GM toggles persist across turn changes.
			friendly: actor?.alliance === "party",
			playerControlled: actor?.hasPlayerOwner ?? false,
			hideAll: this._state.hideAll ?? false,
			disabled: this._state.disabled ?? false
		};
	}

	/** Resolve the combatant's underlying world actor (linked or unlinked token)
	 *  so affiliation/control come from canonical actor ownership data. */
	static _combatantActor(combatant) {
		const token = combatant?.token;
		if (token?.actorId) return game.actors.get(token.actorId) ?? null;
		return combatant?.actor ?? null;
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
			saved.movement ??= null;
			saved.combatId ??= game.combat?.id ?? null;
			saved.hideAll ??= false;
			saved.disabled ??= false;
			// Affiliation/control are re-derived from the live combatant's world
			// actor — never from the persisted value, so a stale save or an
			// alliance/ownership change can't leak (or falsely hide) a turn on
			// player clients. GM toggles are kept as persisted.
			const actor = this._combatantActor(combatant);
			saved.friendly = actor?.alliance === "party";
			saved.playerControlled = actor?.hasPlayerOwner ?? false;
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

	static async _onCreateChatMessage(message) {
		if (!game.user.isGM) return;
		if (!this._state.active) return;
		if (this._state.disabled) return;
		const combatant = game.combat?.combatant;
		const actor = combatant?.actor;
		if (!actor) return;
		const speaker = message.speakerActor;
		if (!speaker || speaker.uuid !== actor.uuid) return;
		if (message.isReroll) return;

		const flags = message.flags?.pf2e ?? {};
		const context = flags.context ?? {};
		const type = context.type ?? "";

		// "Apply Effect" cards (e.g. Raise a Shield, Channel Elements): the card
		// identifies its action/feat item via context.item and has no origin, and
		// clicking the button applies the effect without posting another message,
		// so the action is counted when its card appears.
		if (type === "self-effect") {
			this._logSelfEffect(speaker, context);
			return;
		}
		if (this._skipTypes.has(type)) return;

		// Consumable "Use" messages (healing potions etc.): the consume path
		// posts an origin of {sourceId, uuid, type}, unlike an item card dropped
		// into chat, whose origin carries {actor, uuid, type, rollOptions}.
		if (!type && this._isConsumeMessage(flags.origin)) {
			await this._logConsume(message, flags.origin);
			return;
		}

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
		this._push({ name, cost, icon: this._iconFor(item, type) });
	}

	/**
	 * Count a real token movement of the current combatant. Fires on every
	 * client; only the GM acts. The `movement` op's `passed.cost` is the
	 * terrain-aware measured cost in feet (exactly what pf2e's token ruler
	 * displays while dragging), and the action cost mirrors the ruler:
	 * `clamp(ceil(cost / speed), 1, 3)`. Consecutive moves merge into one
	 * cumulative entry (see the `movement` chain in `_state`); any other action
	 * breaks the chain. Forced/teleported moves (the `displace`/`blink`
	 * movement actions) and non-finite/zero costs are ignored.
	 */
	static _onTokenMove(token, movement) {
		if (!game.user.isGM) return;
		if (!this._state.active) return;
		if (this._state.disabled) return;
		const combatant = game.combat?.combatant;
		const actor = combatant?.actor;
		if (!actor) return;
		if (token?.actor?.uuid !== actor.uuid) return;
		if (!movement?.passed?.waypoints?.length) return;

		const action = movement.passed.waypoints.at(-1)?.action ?? "";
		const config = CONFIG.Token.movement.actions[action];
		if (!config || config.teleport) return;
		const speed = this._movementSpeed(actor, action);
		if (typeof speed !== "number" || speed <= 0) return;

		const cost = Number.isFinite(movement.passed.cost) && movement.passed.cost > 0
			? movement.passed.cost
			: movement.passed.distance;
		if (!Number.isFinite(cost) || cost <= 0) return;

		// Consecutive moves merge into a single cumulative entry: track the total
		// measured cost and distance during the chain and derive the action cost
		// from the total (same clamp as the token ruler). Any non-move action
		// resets `movement`, so a later move starts a fresh entry.
		const chain = this._state.movement ?? { totalCost: 0, totalDistance: 0, actions: 0 };
		chain.totalCost += cost;
		chain.totalDistance += movement.passed.distance ?? cost;
		const newActions = Math.clamp(Math.ceil(chain.totalCost / speed), 1, 3);
		const diff = newActions - chain.actions;
		chain.actions = newActions;
		this._state.movement = chain;

		const distance = Math.round(chain.totalDistance);
		const icon = { fa: this._movementIcon(action) };
		const last = this._state.entries.at(-1);
		if (last?.move) {
			last.name = this._moveName(distance);
			last.cost = newActions;
			this._state.used += Math.max(0, diff);
		} else {
			this._state.entries.push({ name: this._moveName(distance), cost: newActions, icon, move: true });
			this._state.used += newActions;
		}
		this._broadcast();
	}

	static _moveName(distance) {
		return Manager.localize("actionTracker.move", { distance });
	}

	/**
	 * Resolve the actor's speed for a movement action, mirroring pf2e's token
	 * ruler `#getSpeed`: walk/step/crawl read the land speeds, other movement
	 * types read their own speed.
	 */
	static _movementSpeed(actor, action) {
		const speeds = actor.system?.movement?.speeds ?? {};
		switch (action) {
			case "walk": return speeds.land?.value;
			case "step": return speeds.land?.step;
			case "crawl": return speeds.land?.crawl;
			case "fly": return speeds.fly?.value;
			case "swim": return speeds.swim?.value;
			case "burrow": return speeds.burrow?.value;
			case "climb": return speeds.climb?.value;
			default: return null;
		}
	}

	/** Pick the Font Awesome icon for a movement action (core's own icons). */
	static _movementIcon(action) {
		const icons = {
			walk: "fa-person-walking",
			step: "fa-person-walking",
			crawl: "fa-person-praying",
			fly: "fa-person-fairy",
			swim: "fa-person-swimming",
			burrow: "fa-person-digging",
			climb: "fa-person-through-window"
		};
		return icons[action] ?? "fa-person-walking";
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

	/**
	 * Log an "Apply Effect" (self-effect) action, e.g. Raise a Shield. The item
	 * lives on the speaker — context.item is its id, not a uuid — and its cost
	 * resolves like any other action/feat via `actionCost`.
	 */
	static _logSelfEffect(speaker, context) {
		const item = speaker.items.get(context.item ?? "") ?? null;
		if (!item) return;
		const cost = this._resolveCost(item, "self-effect");
		if (cost === null) return;
		this._push({ name: item.name, cost, icon: this._iconFor(item, "self-effect") });
	}

	/**
	 * Log a consumable "Use" action from a chat card's Use button (healing
	 * potions and friends): the actor Interacts to use it, 1 action. Detected
	 * via the consume message's minimal origin (see `_isConsumeMessage`).
	 */
	static async _logConsume(message, origin) {
		// Fast path: mirror pf2e's own resolution (MessagePF2e#item) — the same
		// getter the Use button relies on — which works while the item still exists.
		let item = message.item ?? null;
		// The potion is destroyed right after use (autoDestroy), so the world item
		// may already be gone when the GM's hook runs; the compendium sourceId
		// survives, so load that instead.
		if (!item && origin.sourceId) {
			try {
				item = await fromUuid(origin.sourceId) ?? null;
			} catch (error) {
				console.debug(`${Manager.id} | action-tracker could not load consumed item source`, error);
			}
		}
		if (!item) {
			// Last resort: the item name is embedded in the localized consume text
			// ("Uses X" / "Uses X, N remain" / "Exhausted X"), e.g. for homebrew
			// items with no compendium source.
			const name = (message.content ?? "").trim()
				.replace(/^Exhausted\s+/i, "")
				.replace(/^Uses\s+/i, "")
				.replace(/,\s*\d+\s*remain$/i, "")
				.trim();
			if (name) {
				this._push({ name, cost: 1, icon: { fa: "fa-flask-vial" } });
			}
			return;
		}
		this._push({ name: item.name, cost: 1, icon: { img: item.img } });
	}

	/** True for a consumable "Use" message (minimal origin), not an item card
	 * dropped into chat (whose origin carries `actor` and `rollOptions`). */
	static _isConsumeMessage(origin) {
		return !!origin?.uuid && origin?.type === "consumable" && !origin?.actor && !origin?.rollOptions;
	}

	/** Record an entry for the current combatant, break any move chain, broadcast. */
	static _push(entry) {
		this._state.entries.push(entry);
		this._state.used += entry.cost;
		this._state.movement = null;
		this._broadcast();
	}

	/* -------------------------------------------- */
	/*  Manual GM corrections                        */
	/* -------------------------------------------- */

	static spendFree() {
		if (!game.user.isGM || !this._state.active) return;
		this._state.entries.push({ name: Manager.localize("actionTracker.free"), cost: 0, icon: { fa: "fa-bolt" } });
		this._state.movement = null;
		this._broadcast();
	}

	static spendReaction() {
		if (!game.user.isGM || !this._state.active) return;
		this._state.entries.push({ name: Manager.localize("actionTracker.reaction"), cost: 0, icon: { fa: "fa-person-running" } });
		this._state.movement = null;
		this._broadcast();
	}

	static undo() {
		if (!game.user.isGM || !this._state.active) return;
		const entry = this._state.entries.pop();
		if (entry) {
			this._state.used = Math.max(0, this._state.used - entry.cost);
			if (entry.move) this._state.movement = null;
		}
		this._broadcast();
	}

	/** GM-only: toggle hiding every combatant from players except party members
	 *  controlled by non-GM players. */
	static toggleHideAll() {
		if (!game.user.isGM || !this._state.active) return;
		this._state.hideAll = !this._state.hideAll;
		this._broadcast();
	}

	/** GM-only: disable the tracker window for everyone ("Action Tracker disabled
	 *  by GM", nothing else); counting stops while disabled, and re-enabling
	 *  starts a fresh turn. */
	static toggleDisable() {
		if (!game.user.isGM) return;
		this._state.disabled = !this._state.disabled;
		if (this._state.disabled) {
			this._countedSpellUuids.clear();
			this._state.entries = [];
			this._state.used = 0;
			this._state.movement = null;
		}
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
		// Players never see non-party combatants ("Enemy's turn"); with `hideAll`
		// they additionally need the combatant to be player-controlled. The GM
		// always sees the full window. `disabled` blanks the window for everyone.
		const hidden = s.active && !s.disabled && !game.user.isGM
			&& (!s.friendly || (s.hideAll && !s.playerControlled));
		return {
			active: s.active,
			disabled: s.disabled,
			hidden,
			hideAll: s.hideAll,
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
			free: () => ActionTrackerTool.spendFree(),
			reaction: () => ActionTrackerTool.spendReaction(),
			undo: () => ActionTrackerTool.undo(),
			toggleHideAll: () => ActionTrackerTool.toggleHideAll(),
			toggleDisable: () => ActionTrackerTool.toggleDisable()
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
