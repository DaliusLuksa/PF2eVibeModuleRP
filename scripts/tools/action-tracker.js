import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_STATE = "actionTrackerState";
const SOCKET_ACTION_SUPPRESS = "actionTrackerSuppress";
const SOCKET_ACTION_SUPPRESS_RESULT = "actionTrackerSuppressResult";
const SOCKET_ACTION_LOG_EXTERNAL = "actionTrackerLogExternal";
const SOCKET_ACTION_LOG_EXTERNAL_RESULT = "actionTrackerLogExternalResult";
const MODULE_ROOT = "modules/pf2e-vibemodulerp";
const SUPPRESSION_TIMEOUT_MS = 15000;
const SUPPRESS_ACK_TIMEOUT_MS = 5000;

/**
 * Combat Action Tracker.
 *
 * Opens an in-Foundry window automatically when a combat is started and shows
 * who is acting, how many actions they have used, and what they did so far.
 * The GM's client watches chat messages: it resolves each action's cost (spell
 * casting time, action/feat `actionCost`, "Apply Effect"/self-effect cards,
 * consumable "Use" messages, weapon Strike, plain skill checks, and the system's
 * flagless auxiliary-action EMOTE cards - Draw/Retrieve/Sheathe/Grip, Reload,
 * Give/Exchange Items, Raise a Shield/Take Cover/Parry/Release),
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
		// Warp Step free-stride tracking: same merging rules as `movement` but
		// for the 2 free Strides granted by Spell Effect: Warp Step. `warpUsed`
		// counts how many free Stride actions have been consumed this turn (0-2);
		// `warpMovement` is the current consecutive free-move chain so repeated
		// free strides merge into one "Warp Step - Move (X ft)" entry. Both are
		// reset on turn change and `warpMovement` is also cleared on any non-move.
		warpMovement: null,
		warpUsed: 0,
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

	/** Suppression: actorUuid -> { free, hide, freeTypes:Set|null, hideTypes:Set|null, timer } */
	static _suppressions = new Map();
	static _pendingSuppress = new Map();
	static _pendingLogExternal = new Map();

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
		try {
			const api = (game.modules.get(Manager.id).api ??= {});
			api.actionTracker = {
				suppressNext: (...args) => this.suppressNext(...args),
				logExternal: (...args) => this.logExternal(...args),
				logAndSuppress: (...args) => this.logAndSuppress(...args)
			};
		} catch {}
	}

	static ready() {
		try {
			const api = (game.modules.get(Manager.id).api ??= {});
			api.actionTracker ??= {
				suppressNext: (...args) => this.suppressNext(...args),
				logExternal: (...args) => this.logExternal(...args),
				logAndSuppress: (...args) => this.logAndSuppress(...args)
			};
		} catch {}
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		Hooks.on("combatTurnChange", this._onCombatTurnChange.bind(this));
		Hooks.on("updateCombat", this._onCombatUpdate.bind(this));
		Hooks.on("deleteCombat", this._onCombatDeleted.bind(this));
		Hooks.on("createChatMessage", this._onCreateChatMessage.bind(this));
		Hooks.on("moveToken", this._onTokenMove.bind(this));
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
		// Suppression windows are per-turn; discard stale counters
		for (const v of this._suppressions.values()) if (v.timer) clearTimeout(v.timer);
		this._suppressions.clear();
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
			warpMovement: null,
			warpUsed: 0,
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
			saved.warpMovement ??= null;
			saved.warpUsed ??= 0;
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

		// Per-message flag from OUR macros (hide = skip entirely, free = show as 0-cost).
		// Any tool that creates its own ChatMessage can set
		// `flags.pf2e-vibemodulerp.actionTracker = { hide:true }` or `{ free:true }`.
		const trackerFlag = message.flags?.[Manager.id]?.actionTracker ?? null;
		if (trackerFlag?.hide) return;

		const flags = message.flags?.pf2e ?? {};
		const context = flags.context ?? {};
		const type = context.type ?? "";

		// GM-routed suppression window (e.g. Flurry of Blows). `free` -> show as 0-cost,
		// `hide` -> skip entirely. Checked before normal cost logic.
		const suppression = this._consumeSuppression(speaker.uuid, type);
		if (suppression === "hide") return;
		const freeViaSuppression = suppression === "free" || !!trackerFlag?.free;

		// pf2e `treatWoundsMacroCallback`Posts the healing roll as a separate
		// ChatMessage that **copies** the original `context` (so it still looks
		// like `skill-check:medicine`) but sets `origin.messageId` to the
		// parent check's id. That copy must not be counted as a second action —
		// otherwise Battle Medicine / Treat Wounds logs 2× Medicine.
		if (flags.origin?.messageId) return;

		// "Apply Effect" cards (e.g. Raise a Shield, Channel Elements): the card
		// identifies its action/feat item via context.item and has no origin, and
		// clicking the button applies the effect without posting another message,
		// so the action is counted when its card appears.
		if (type === "self-effect") {
			this._logSelfEffect(speaker, context, freeViaSuppression);
			return;
		}
		if (this._skipTypes.has(type)) return;

		// Consumable "Use" messages (healing potions etc.): the consume path
		// posts an origin of {sourceId, uuid, type}, unlike an item card dropped
		// into chat, whose origin carries {actor, uuid, type, rollOptions}.
		if (!type && this._isConsumeMessage(flags.origin)) {
			await this._logConsume(message, flags.origin, freeViaSuppression);
			return;
		}

		// pf2e auxiliary-action cards (Draw/Retrieve/Sheathe/Reload/Raise a
		// Shield/Take Cover/...) are plain EMOTE messages with NO flags.pf2e at
		// all - the cost and name must be parsed from the rendered card.
		if (!type && !flags.origin) {
			const aux = this._parseAuxiliaryCard(message);
			if (aux) {
				if (freeViaSuppression) aux.cost = 0;
				this._push(aux);
				return;
			}
		}

		const origin = flags.origin ?? null;
		let item = null;
		if (origin?.uuid) {
			try {
				item = fromUuidSync(origin.uuid) ?? null;
			} catch (error) {
				// ignore
			}
			if (!item) {
				try {
					item = await fromUuid(origin.uuid);
				} catch (error) {
					// ignore
				}
			}
		}
		// Bard Helper spell cards clone the spell via `spell.clone()` before
		// `toMessage()` — the clone's `getOriginData()` can produce `uuid: null`.
		// Fall back to resolving the live actor spell by parsing the card's
		// `<h3>` (spell name) so Courageous Anthem still counts.
		if (!item && speaker) {
			try {
				if (origin?.slug) {
					item = speaker.itemTypes?.spell?.find?.((s) => s.slug === origin.slug) ?? null;
				}
				if (!item && origin?.name) {
					item = speaker.itemTypes?.spell?.find?.((s) => s.name === origin.name) ?? null;
				}
				if (!item) {
					const div = document.createElement("div");
					div.innerHTML = message.content ?? "";
					const h3 = div.querySelector("h3")?.textContent?.trim() ?? "";
					const h3Name = h3.replace(/\s*\d+\s*$/, "").trim();
					if (h3Name) {
						item = speaker.itemTypes?.spell?.find?.((s) => s.name === h3Name) ?? speaker.itemTypes?.spell?.find?.((s) => s.name.toLowerCase() === h3Name.toLowerCase()) ?? null;
					}
				}
			} catch (error) {
				// ignore
			}
		}
		let cost = this._resolveCost(item, type, context.title, context.options);
		if (cost === null) return;
		if (freeViaSuppression) cost = 0;

		const isSpell = !!item?.isOfType?.("spell");
		let spellKey = null;
		if (isSpell) {
			spellKey = origin?.uuid ?? item?.slug ?? "unknown-spell";
			if (this._countedSpellUuids.has(spellKey)) return;
			this._countedSpellUuids.add(spellKey);
		}

		const name = this._resolveName(item, context, type);
		this._push({ name, cost, icon: this._iconFor(item, type, context.title, context.options), ...(freeViaSuppression ? { free: true } : {}), ...(spellKey ? { spellKey } : {}) });
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
	 *
	 * Warp Step: if the current combatant has `Spell Effect: Warp Step` on
	 * itself, the first two Stride (walk) actions each turn are free. Free
	 * strides use the same terrain-aware cost but are logged as separate
	 * 0-cost "Warp Step - Move (N ft)" entries that merge consecutively just
	 * like normal moves, and break on any non-move action. After the 2 free
	 * strides are spent, further walk moves cost normally.
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

		let cost = Number.isFinite(movement.passed.cost) && movement.passed.cost > 0
			? movement.passed.cost
			: movement.passed.distance;
		if (!Number.isFinite(cost) || cost <= 0) return;
		// Snap to 5-ft increments to hide floating-point drift from the ruler
		// (e.g. 6 / 17 inside/outside difficult terrain → 5 / 15).
		cost = Math.round(cost / 5) * 5;

		const distanceRaw = movement.passed.distance ?? cost;
		// Keep distanceRaw snapped as well when we split proportionally.
		const snappedDistanceRaw = Math.round((distanceRaw) / 5) * 5;

		// Warp Step free strides: only normal Stride ("walk") while the effect
		// is present and free budget remains (2 × Speed feet of cost, matching
		// two Strides). Other movement types (step, fly etc.) always cost normally.
		// Budget is measured in cost (terrain-aware), so a 10-ft incremental
		// Stride and a single 60-ft drag consume the same budget.
		if (action === "walk" && this._hasWarpStep(actor)) {
			const budget = 2 * speed;
			const warpChain = this._state.warpMovement ?? { totalCost: 0, totalDistance: 0, actions: 0 };
			const oldCost = warpChain.totalCost;
			if (oldCost < budget) {
				const newTotalCost = oldCost + cost;
				const newTotalDistance = warpChain.totalDistance + snappedDistanceRaw;

				// Entirely within the free budget (e.g. 60 ft instant or 10+10... up to 60)
				// Display is terrain-aware cost (10 per difficult square, 15 per greater),
				// so the label matches the ruler's cost, not the geometric distance.
				// Snap the label to 5 ft to hide ruler float drift (6 → 5, 17 → 15).
				if (newTotalCost <= budget) {
					warpChain.totalCost = newTotalCost;
					warpChain.totalDistance = newTotalDistance;
					warpChain.actions = Math.clamp(Math.ceil(newTotalCost / speed), 1, 3);
					this._state.warpMovement = warpChain;
					this._state.warpUsed = warpChain.actions;

					const distance = Math.round(warpChain.totalCost / 5) * 5;
					const icon = { fa: "fa-wind" };
					const last = this._state.entries.at(-1);
					if (last?.warpMove) {
						last.name = this._warpMoveName(distance);
						last.warpActions = warpChain.actions;
					} else {
						this._state.entries.push({ name: this._warpMoveName(distance), cost: 0, icon, warpMove: true, warpActions: warpChain.actions });
					}
					this._broadcast();
					return;
				}

				// Straddles the budget: part free (up to budget), remainder paid.
				// This happens when a single drag would cross the 60-ft line (e.g.
				// 50 free + 20 drag = 10 free + 10 paid).
				if (oldCost < budget && newTotalCost > budget) {
					const freeCostThisMove = budget - oldCost;
					const paidCostThisMove = cost - freeCostThisMove;
					// For the display we keep cost, so split is direct (no distance proportion needed).
					const freeDistThisMove = cost > 0 ? (freeCostThisMove / cost) * snappedDistanceRaw : 0;
					const paidDistThisMove = snappedDistanceRaw - freeDistThisMove;

					// Close the free entry at the budget
					warpChain.totalCost = budget;
					warpChain.totalDistance = warpChain.totalDistance + freeDistThisMove;
					warpChain.actions = 2;
					this._state.warpMovement = warpChain;
					this._state.warpUsed = 2;
					const freeDistance = Math.round(warpChain.totalCost / 5) * 5;
					const last = this._state.entries.at(-1);
					if (last?.warpMove) {
						last.name = this._warpMoveName(freeDistance);
						last.warpActions = 2;
					} else {
						this._state.entries.push({ name: this._warpMoveName(freeDistance), cost: 0, icon: { fa: "fa-wind" }, warpMove: true, warpActions: 2 });
					}

					// Remainder becomes a normal paid move (starts/extends the paid chain)
					const paidChain = this._state.movement ?? { totalCost: 0, totalDistance: 0, actions: 0 };
					paidChain.totalCost += paidCostThisMove;
					paidChain.totalDistance += paidDistThisMove;
					const newPaidActions = Math.clamp(Math.ceil(paidChain.totalCost / speed), 1, 3);
					paidChain.actions = newPaidActions;
					this._state.movement = paidChain;
					const paidDistance = Math.round(paidChain.totalCost / 5) * 5;
					const paidIcon = { fa: this._movementIcon(action) };
					this._state.entries.push({ name: this._moveName(paidDistance), cost: newPaidActions, icon: paidIcon, move: true });
					this._state.used += newPaidActions;
					this._broadcast();
					return;
				}
			}
			// oldCost >= budget → no free budget left, fall through to paid handling
		}

		// Normal paid movement (or warp budget exhausted / ineligible type)
		// Consecutive moves merge into a single cumulative entry: track the total
		// measured cost and distance during the chain and derive the action cost
		// from the total (same clamp as the token ruler). Any non-move action
		// resets `movement`, so a later move starts a fresh entry.
		const chain = this._state.movement ?? { totalCost: 0, totalDistance: 0, actions: 0 };
		chain.totalCost += cost;
		chain.totalDistance += snappedDistanceRaw;
		const newActions = Math.clamp(Math.ceil(chain.totalCost / speed), 1, 3);
		const diff = newActions - chain.actions;
		chain.actions = newActions;
		this._state.movement = chain;

		const distance = Math.round(chain.totalCost / 5) * 5;
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

	static _warpMoveName(distance) {
		return Manager.localize("actionTracker.warpMove", { distance });
	}

	/** True when `actor` has Spell Effect: Warp Step (the 2 free Strides). */
	static _hasWarpStep(actor) {
		if (!actor) return false;
		const effects = actor.itemTypes?.effect ?? [];
		for (const e of effects) {
			if (e.slug === "spell-effect-warp-step") return true;
			if (e.system?.slug === "spell-effect-warp-step") return true;
			if (e.name === "Spell Effect: Warp Step") return true;
			// Compendium source check covers migrated and unmigrated forms
			const src = e.flags?.pf2e?.compendiumSource ?? e._stats?.compendiumSource ?? "";
			if (typeof src === "string" && src.includes("9Tl9jGUKoj0wS73d")) return true;
			const sid = e.sourceId ?? e._source?.sourceId ?? "";
			if (typeof sid === "string" && sid.includes("9Tl9jGUKoj0wS73d")) return true;
		}
		return false;
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
	static _resolveCost(item, type, title = "", options = null) {
		if (item?.isOfType?.("spell")) return this._spellCost(item.system?.time?.value);
		if (item && typeof item.actionCost === "object" && item.actionCost) {
			const ac = item.actionCost;
			return ac.type === "action" ? (ac.value ?? 1) : 0;
		}
		if (type === "attack-roll") return 1;
		if (type === "skill-check" || type === "perception-check") {
			// pf2e-bard-helper Lingering Composition (and similar free Perform
			// checks) are `skill-check:performance` with cost 0 but ride the
			// generic skill-check path. The rendered header.hbs still carries the
			// action-glyph (F/R) — use it to return 0 instead of the default 1.
			// Also hard-match Lingering Composition by name as a safety net.
			if (typeof title === "string" && title.includes("action-glyph")) {
				const m = title.match(/action-glyph[^>]*>([^<]+)</);
				if (m) {
					const g = m[1].trim();
					if (g === "F" || g === "R") return 0;
					if (/^\d+$/.test(g)) return Math.min(Number(g), 3);
				}
			}
			if (typeof title === "string" && /Lingering Composition/i.test(title)) return 0;
			return 1;
		}
		return null;
	}

	/**
	 * Pick the per-entry icon: `{ img }` (spell artwork) or `{ fa }` (Font Awesome
	 * class). Spells always show their own item image; everything else falls back
	 * to category defaults (sword/bow/fist, star, bolt, person-running, dice-d20).
	 * For `simpleRollActionCheck` actions (Demoralize, etc.) the roll title is the
	 * rendered header.hbs HTML — those are actions, not plain skill checks, so
	 * they get `fa-star` instead of the generic `fa-dice-d20`. The same applies
	 * to Treat Wounds / Battle Medicine and Seek etc. which carry
	 * `action:<slug>` in `context.options`.
	 */
	static _iconFor(item, type, title = "", options = null) {
		if (item?.isOfType?.("spell")) return { img: item.img };
		if (item?.isOfType?.("weapon", "melee")) {
			const unarmed = item.system?.category === "unarmed" || item.system?.traits?.value?.includes?.("unarmed");
			if (unarmed) return { fa: "fa-hand-fist" };
			return { fa: item.isMelee ? "fa-sword" : "fa-bow-arrow" };
		}
		if (item && typeof item.actionCost === "object" && item.actionCost) return { fa: "fa-star" };
		if (type === "attack-roll") return { fa: "fa-sword" };
		if (type === "skill-check" || type === "perception-check") {
			if (typeof title === "string" && title.includes("<")) return { fa: "fa-star" };
			if (Array.isArray(options) || options instanceof Set) {
				for (const o of options) if (String(o).startsWith("action:")) return { fa: "fa-star" };
			}
			return { fa: "fa-dice-d20" };
		}
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
		let title = context.title ?? "";
		if (title) {
			// pf2e `simpleRollActionCheck` (Demoralize, etc.) stores the rendered
			// header.hbs HTML as the roll title, e.g.
			// `<h4 class="action"><strong>Demoralize</strong><span class="action-glyph">1</span>...`
			// which previously leaked verbatim into the tracker. Strip the markup
			// like pf2e's own CheckModifiersDialog does.
			if (typeof title === "string" && title.includes("<")) {
				try {
					const div = document.createElement("div");
					div.innerHTML = title;
					div.querySelector(".action-glyph")?.remove();
					div.querySelector(".pf2-icon")?.remove();
					const text = div.textContent?.trim().replace(/\s+/g, " ");
					if (text) title = text;
					else title = title.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
				} catch {
					title = title.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
				}
			}
			if (title) {
				const localized = game.i18n.localize(title);
				return (localized && localized !== title) ? localized : title;
			}
		}
		return type || "Action";
	}

	/**
	 * Log an "Apply Effect" (self-effect) action, e.g. Raise a Shield. The item
	 * lives on the speaker — context.item is its id, not a uuid — and its cost
	 * resolves like any other action/feat via `actionCost`.
	 */
	static _logSelfEffect(speaker, context, free = false) {
		const item = speaker.items.get(context.item ?? "") ?? null;
		if (!item) return;
		let cost = this._resolveCost(item, "self-effect");
		if (cost === null) return;
		if (free) cost = 0;
		this._push({ name: item.name, cost, icon: this._iconFor(item, "self-effect"), ...(free ? { free: true } : {}) });
	}

	/**
	 * Log a consumable "Use" action from a chat card's Use button (healing
	 * potions and friends): the actor Interacts to use it, 1 action. Detected
	 * via the consume message's minimal origin (see `_isConsumeMessage`).
	 */
	static async _logConsume(message, origin, free = false) {
		const cost = free ? 0 : 1;
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
				this._push({ name, cost, icon: { fa: "fa-flask-vial" }, ...(free ? { free: true } : {}) });
			}
			return;
		}
		this._push({ name: item.name, cost, icon: { img: item.img }, ...(free ? { free: true } : {}) });
	}

	/** True for a consumable "Use" message (minimal origin), not an item card
	 *  dropped into chat (whose origin carries `actor` and `rollOptions`). */
	static _isConsumeMessage(origin) {
		return !!origin?.uuid && origin?.type === "consumable" && !origin?.actor && !origin?.rollOptions;
	}

	/**
	 * Parse a pf2e auxiliary-action card (Draw, Reload, Raise a Shield, ...).
	 *
	 * These actions post plain EMOTE chat messages rendered from the system's
	 * `chat/action/flavor.hbs` + `content.hbs` templates and carry NO
	 * flags.pf2e. The flavor header has a stable shape:
	 * `<h4 class="action"><strong>{title}</strong><span class="action-glyph">
	 * {cost glyph}</span><span class="subtitle ...">(<span>{subtitle}</span>)</span></h4>`
	 * where the title localizes one of the known action-title keys ("Interact",
	 * "Raise a Shield", "Take Cover", ...) and the glyph encodes the cost
	 * (1/2/3/F/R). Restricting to that title set avoids double-counting any
	 * other flagless EMOTE cards.
	 */
	static _parseAuxiliaryCard(message) {
		try {
			if ((message.style ?? null) !== CONST.CHAT_MESSAGE_STYLES.EMOTE) return null;
			const flavor = String(message.flavor ?? "");
			if (!flavor.includes('<h4 class="action">')) return null;
			this._auxiliaryTitles ??= [
				"PF2E.Actions.Interact.Title",
				"PF2E.Actions.RaiseAShield.Title",
				"PF2E.Actions.TakeCover.Title",
				"PF2E.Actions.EndCover.Title",
				"PF2E.Actions.Parry.Title",
				"PF2E.Actions.Release.Title"
			].map((key) => game.i18n.localize(key));
			const doc = new DOMParser().parseFromString(flavor, "text/html");
			const header = doc.querySelector('h4.action');
			const title = header?.querySelector("strong")?.textContent?.trim() ?? "";
			if (!this._auxiliaryTitles.includes(title)) return null;
			const subtitle = header.querySelector(".subtitle > span")?.textContent?.trim() ?? "";
			const glyph = header.querySelector(".action-glyph")?.textContent?.trim() ?? "";
			const cost = { 1: 1, 2: 2, 3: 3, F: 0, R: 0 }[glyph] ?? 1;
			const name = subtitle ? `${title}: ${subtitle}` : title;
			return { name, cost, icon: { fa: this._auxiliaryIcon(title, subtitle) } };
		} catch (error) {
			console.debug(`${Manager.id} | action-tracker could not parse an auxiliary action card`, error);
			return null;
		}
	}

	/** Pick an icon for an auxiliary-action entry by its parsed title/subtitle. */
	static _auxiliaryIcon(title, subtitle) {
		const text = `${title} ${subtitle}`.toLowerCase();
		if (text.includes("reload")) return "fa-arrows-rotate";
		if (text.includes("exchange") || text.includes("give")) return "fa-right-left";
		if (text.includes("cover")) return "fa-user-shield";
		if (text.includes("shield") || text.includes("parry")) return "fa-shield-halved";
		return "fa-hand";
	}

	/** Record an entry for the current combatant, break any move chain, broadcast. */
	static _push(entry) {
		this._state.entries.push(entry);
		this._state.used += entry.cost;
		this._state.movement = null;
		this._state.warpMovement = null;
		this._broadcast();
	}

	/* -------------------------------------------- */
	/*  Suppression API (for OUR macros)             */
	/* -------------------------------------------- */

	/**
	 * Suppress / make-free the next N actions of `actor`.
	 *
	 * Both `hide` (skip entirely) and `free` (show as 0-cost) are supported so
	 * callers can choose per use-case. Filtered by `context.type` when `types`
	 * is provided; `null`/`undefined` = any type.
	 *
	 * Examples:
	 *   // Flurry: 2 Strikes become 0-cost, up to 2 Trip checks hidden
	 *   await ActionTrackerTool.suppressNext(monk, {
	 *     free: { count: 2, types: ["attack-roll"] },
	 *     hide: { count: 2, types: ["skill-check"] }
	 *   });
	 *   // Any macro: hide the next single action regardless of type
	 *   await ActionTrackerTool.suppressNext(actor, { hide: 1 });
	 *   // Via per-message flag (no socket): set on your ChatMessage.create:
	 *   // flags: { "pf2e-vibemodulerp": { actionTracker: { hide:true } } }
	 *   // or { free:true }
	 *
	 * Cross-client: if called by a non-GM, the request is GM-routed over the
	 * shared `module.pf2e-vibemodulerp` socket and the caller awaits the GM's ack
	 * before returning, so following rolls aren't counted before the window is set.
	 */
	static async suppressNext(actor, opts = {}) {
		const actorUuid = this._normalizeActorUuid(actor);
		if (!actorUuid) return;
		const parsed = this._parseSuppressOpts(opts);
		if (!parsed.hide && !parsed.free) return;
		if (game.user.isGM) {
			this._applySuppression(actorUuid, parsed);
			return;
		}
		const gm = game.users.find((u) => u.isGM && u.active);
		if (!gm) return;
		const requestId = foundry.utils.randomID();
		const payload = {
			action: SOCKET_ACTION_SUPPRESS,
			requestId,
			actorUuid,
			hide: parsed.hide,
			free: parsed.free,
			hideTypes: parsed.hideTypes ? [...parsed.hideTypes] : null,
			freeTypes: parsed.freeTypes ? [...parsed.freeTypes] : null
		};
		const ack = await new Promise((resolve) => {
			const timer = setTimeout(() => { this._pendingSuppress.delete(requestId); resolve(false); }, SUPPRESS_ACK_TIMEOUT_MS);
			this._pendingSuppress.set(requestId, { resolve, timer });
			game.socket.emit(SOCKET_EVENT, payload, { recipients: [gm.id] });
		});
		return ack;
	}

	/** GM-routed: log a single action entry for `actor` (e.g. "Flurry of Blows" 1). */
	static async logExternal(actor, entry) {
		const actorUuid = this._normalizeActorUuid(actor);
		if (!actorUuid) return;
		const name = entry?.name ?? "Action";
		const cost = Number.isFinite(entry?.cost) ? entry.cost : 1;
		const icon = entry?.icon ?? { fa: "fa-star" };
		if (game.user.isGM) {
			if (!this._state.active || this._state.disabled) return;
			const combatActor = game.combat?.combatant?.actor;
			if (combatActor && combatActor.uuid !== actorUuid) {
				// Still log for the active combatant's turn: attribute to the combatant
				// but only if the caller explicitly targets the current combatant. If
				// they don't match, push anyway - external macros are authoritative.
			}
			this._push({ name, cost, icon });
			return;
		}
		const gm = game.users.find((u) => u.isGM && u.active);
		if (!gm) return;
		const requestId = foundry.utils.randomID();
		const payload = { action: SOCKET_ACTION_LOG_EXTERNAL, requestId, actorUuid, name, cost, icon };
		await new Promise((resolve) => {
			const timer = setTimeout(() => { this._pendingLogExternal.delete(requestId); resolve(false); }, SUPPRESS_ACK_TIMEOUT_MS);
			this._pendingLogExternal.set(requestId, { resolve, timer });
			game.socket.emit(SOCKET_EVENT, payload, { recipients: [gm.id] });
		});
	}

	/**
	 * Atomic helper: log one entry (cost 1 Flurry) and suppress the following rolls.
	 * Awaits both GM acks so rolls that follow are correctly hidden/freed.
	 */
	static async logAndSuppress(actor, { name, cost = 1, icon, suppress = {} } = {}) {
		await this.logExternal(actor, { name, cost, icon });
		if (suppress && (suppress.hide || suppress.free)) await this.suppressNext(actor, suppress);
	}

	static _normalizeActorUuid(actor) {
		if (!actor) return null;
		if (typeof actor === "string") return actor;
		if (actor.uuid) return actor.uuid;
		if (actor.actor?.uuid) return actor.actor.uuid;
		return null;
	}

	static _parseSuppressOpts(opts) {
		const out = { hide: 0, free: 0, hideTypes: null, freeTypes: null };
		const parseOne = (v) => {
			if (v == null) return { count: 0, types: null };
			if (typeof v === "number") return { count: Math.max(0, v|0), types: null };
			if (typeof v === "object" && "count" in v) {
				const c = Math.max(0, Number(v.count)|0);
				const t = Array.isArray(v.types) && v.types.length ? new Set(v.types.map(String)) : null;
				return { count: c, types: t };
			}
			return { count: 0, types: null };
		};
		const h = parseOne(opts.hide);
		const f = parseOne(opts.free);
		out.hide = h.count; out.hideTypes = h.types;
		out.free = f.count; out.freeTypes = f.types;
		// Shorthand: { hide:2, free:2, types:["attack-roll"] } means both share the same types
		if (opts.types && (!h.types && !f.types)) {
			const shared = Array.isArray(opts.types) ? new Set(opts.types.map(String)) : null;
			if (h.count) out.hideTypes = shared;
			if (f.count) out.freeTypes = shared;
		}
		return out;
	}

	static _applySuppression(actorUuid, parsed) {
		if (!actorUuid) return;
		const existing = this._suppressions.get(actorUuid);
		if (existing?.timer) clearTimeout(existing.timer);
		const merged = {
			hide: (existing?.hide ?? 0) + parsed.hide,
			free: (existing?.free ?? 0) + parsed.free,
			hideTypes: parsed.hideTypes ?? existing?.hideTypes ?? null,
			freeTypes: parsed.freeTypes ?? existing?.freeTypes ?? null,
			timer: null
		};
		// If both sides had type sets, intersect is not needed - keep the newest; caller should make one atomic call
		merged.timer = setTimeout(() => this._suppressions.delete(actorUuid), SUPPRESSION_TIMEOUT_MS);
		this._suppressions.set(actorUuid, merged);
	}

	static _consumeSuppression(actorUuid, type) {
		const sup = this._suppressions.get(actorUuid);
		if (!sup) return null;
		const t = String(type ?? "");
		const match = (set) => !set || set.has(t) || set.has("all") || set.has("");
		// `free` takes priority when both match the same type (show as 0 rather than hide)
		if (sup.free > 0 && match(sup.freeTypes)) {
			sup.free--;
			if (sup.free <= 0 && sup.hide <= 0) { clearTimeout(sup.timer); this._suppressions.delete(actorUuid); }
			return "free";
		}
		if (sup.hide > 0 && match(sup.hideTypes)) {
			sup.hide--;
			if (sup.free <= 0 && sup.hide <= 0) { clearTimeout(sup.timer); this._suppressions.delete(actorUuid); }
			return "hide";
		}
		return null;
	}

	/* -------------------------------------------- */
	/*  Manual GM corrections                        */
	/* -------------------------------------------- */

	/** Log a manual adjustment entry (+N actions, cost from the button). */
	static spend(cost = 1) {
		if (!game.user.isGM || !this._state.active) return;
		this._push({ name: Manager.localize("actionTracker.manual"), cost, icon: { fa: "fa-hand-point-up" } });
	}

	static spendReaction() {
		if (!game.user.isGM || !this._state.active) return;
		this._state.entries.push({ name: Manager.localize("actionTracker.reaction"), cost: 0, icon: { fa: "fa-person-running" } });
		this._state.movement = null;
		this._state.warpMovement = null;
		this._broadcast();
	}

	static undo() {
		if (!game.user.isGM || !this._state.active) return;
		const entry = this._state.entries.pop();
		if (entry) {
			this._state.used = Math.max(0, this._state.used - entry.cost);
			if (entry.move) this._state.movement = null;
			if (entry.warpMove) {
				const warpActions = this._state.warpMovement?.actions ?? entry.warpActions ?? 1;
				this._state.warpUsed = Math.max(0, (this._state.warpUsed ?? 0) - warpActions);
				this._state.warpMovement = null;
			}
			if (entry.spellKey) this._countedSpellUuids.delete(entry.spellKey);
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
			this._state.warpMovement = null;
			this._state.warpUsed = 0;
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
			if (!data?.action) return;
			// GM -> players: authoritative state sync
			if (data.action === SOCKET_ACTION_STATE) {
				const sender = game.users.get(userId);
				if (!sender?.isGM) return;
				this._state = data.state;
				this._render();
				return;
			}
			// Player -> GM: log an external entry (e.g. "Flurry of Blows" 1)
			if (data.action === SOCKET_ACTION_LOG_EXTERNAL) {
				if (!game.user.isGM) return;
				const { requestId, actorUuid, name, cost, icon } = data;
				if (this._state.active && !this._state.disabled) this._push({ name: name ?? "Action", cost: Number.isFinite(cost) ? cost : 1, icon: icon ?? { fa: "fa-star" } });
				if (requestId) game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_LOG_EXTERNAL_RESULT, requestId, ok: true }, { recipients: [userId] });
				return;
			}
			if (data.action === SOCKET_ACTION_LOG_EXTERNAL_RESULT) {
				const p = this._pendingLogExternal.get(data.requestId);
				if (p) { clearTimeout(p.timer); this._pendingLogExternal.delete(data.requestId); p.resolve(true); }
				return;
			}
			// Player -> GM: install a suppression window
			if (data.action === SOCKET_ACTION_SUPPRESS) {
				if (!game.user.isGM) return;
				const { requestId, actorUuid, hide, free, hideTypes, freeTypes } = data;
				const parsed = { hide: Number(hide) || 0, free: Number(free) || 0, hideTypes: Array.isArray(hideTypes) ? new Set(hideTypes) : null, freeTypes: Array.isArray(freeTypes) ? new Set(freeTypes) : null };
				this._applySuppression(actorUuid, parsed);
				if (requestId) game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_SUPPRESS_RESULT, requestId, ok: true }, { recipients: [userId] });
				return;
			}
			if (data.action === SOCKET_ACTION_SUPPRESS_RESULT) {
				const p = this._pendingSuppress.get(data.requestId);
				if (p) { clearTimeout(p.timer); this._pendingSuppress.delete(data.requestId); p.resolve(true); }
				return;
			}
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
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class ActionTrackerWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(
		foundry.applications.api.ApplicationV2
	)
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
			spend: (event, target) => ActionTrackerTool.spend(Number(target?.dataset?.cost ?? 1)),
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

	async _onRender(context, options) {
		await super._onRender(context, options);
		const log = this.element?.querySelector?.(".at-log");
		if (!log) return;
		log.scrollTop = log.scrollHeight;
		requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
	}
}
