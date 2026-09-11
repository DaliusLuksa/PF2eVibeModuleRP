import { Manager } from "../core/manager.js";

const DYING_SLUG = "dying";
const WOUNDED_SLUG = "wounded";
const DEAD_SLUG = "dead";
const DOOMED_SLUG = "doomed";
/** How long a captured damage outcome stays valid for matching against an HP-to-zero update. */
const OUTCOME_WINDOW_MS = 10_000;
/** Dying 4 means death per the rules; used as the fallback max when the actor's derived max is unavailable. */
const DYING_DEATH_VALUE = 4;

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_REQUEST = "dyingAutomationRequest";
const SOCKET_ACTION_RESULT = "dyingAutomationResult";
const GM_RESPONSE_TIMEOUT_MS = 20_000;

/**
 * Dying & Wounded Automation.
 *
 * The installed pf2e system has no automation for the Dying condition
 * (its Automation settings only cover dead-at-zero marking, encumbrance,
 * flanking, IWR, lootable NPCs, reach, expired effects and vision), so
 * dropping a PC to 0 HP leaves the GM to add everything by hand. This tool
 * closes the gap for player characters only (NPCs are untouched):
 *
 * - When a PC's HP goes from above 0 to exactly 0 from any damage, they
 *   gain Dying 1 - or Dying 2 if the dropping damage came from a critical
 *   hit - plus their current Wounded value, per PF2e rules.
 * - When a PC's HP goes back above 0 (healing), any Dying condition still
 *   present is removed entirely. Manual stabilization (recovery checks
 *   bringing Dying to 0 first) is left alone by the heal path.
 * - Any time the Dying condition is lost on a PC (healing, recovery checks,
 *   manual removal), Wounded 1 is granted or increased by 1, so the next
 *   knockdown starts Dying at the correct higher value.
 * - A PC at 0 HP whose Dying value reaches their max (the system's prepared
 *   `attributes.dying.max` - 4 by default, reduced by Doomed, raised by any
 *   max-increasing effects) fully dies: the Dead status effect (a core
 *   status effect, not a pf2e condition item) is applied and nothing else
 *   is touched. Death is detected on Dying/Doomed condition changes and
 *   after every HP change, so knockdowns landing at max, manual Dying bumps
 *   (damage while dying, failed recovery checks) and Doomed cutting the max
 *   below the current Dying value all kill the PC. The system removes Dead
 *   itself when HP rises above 0, so revival needs no module code. The whole
 *   death step is a module setting (`dying-automation.automateDeath`, world
 *   scope, default on): when disabled, no Dead is ever applied automatically
 *   and a knockdown that would land at max Dying just applies Dying capped
 *   at the PC's max.
 *
 * Detection rides the system's own plumbing: `applyDamage()` passes the
 * signed HP delta as the `damageTaken` update option (and `_preUpdate`
 * injects it for every HP change on player-owned actors), and the strike's
 * degree of success arrives as the `outcome` argument - which the system
 * never persists, so `applyDamage` is wrapped here to capture outcomes for
 * actors it just dropped to 0 HP.
 *
 * Only the client whose action caused each document change acts (the
 * `userId` guard on the hooks). Condition writes need OWNER permission on
 * the actor, so when the causer doesn't own the target PC (another player's
 * heal or AoE dropping an ally), the write is routed through a connected GM
 * over the shared module socket - the same pattern as ShieldedArmTool.
 * Locked conditions (copies managed by effect rule elements) are never
 * touched, mirroring FrightenedDecayTool.
 */
export class DyingAutomationTool {
	static id = "dying-automation";
	static category = "dying-automation";
	static enabledDefault = true;

	/**
	 * World-scoped: when a PC at 0 HP reaches their max Dying value, apply the
	 * Dead status effect automatically. Read live at each death check, so
	 * toggling it takes effect without a reload.
	 */
	static settings = [
		{
			key: "automateDeath",
			type: Boolean,
			default: true,
			scope: "world",
			config: true
		}
	];

	/** actor.uuid -> {outcome, timestamp} captured by the applyDamage wrapper */
	static _droppedOutcomes = new Map();
	/** actor.uuid -> last observed HP value, fallback when damageTaken is absent */
	static _lastKnownHp = new Map();
	/** Pending GM condition-write requests, keyed by request id. */
	static _pendingGmRequests = new Map();
	static _originalApplyDamage = null;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		this.#patchApplyDamage();
		Hooks.on("updateActor", this._onUpdateActor.bind(this));
		Hooks.on("createItem", this._onItemChange.bind(this));
		Hooks.on("updateItem", this._onItemChange.bind(this));
		Hooks.on("deleteItem", this._onDeleteItem.bind(this));
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		console.debug(`${Manager.id} | dying-automation hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Crit capture                                */
	/* -------------------------------------------- */

	/**
	 * Wraps `applyDamage` so the call's `outcome` ("criticalSuccess" for a
	 * crit) is remembered for the knockdown handler. The record MUST be
	 * written before awaiting the original: the knockdown handler runs from
	 * the updateActor hook, which fires inside the awaited `update()` within
	 * `applyDamage` - writing only afterwards would always be too late.
	 */
	static #patchApplyDamage() {
		const actorClass = CONFIG.Actor?.documentClass;
		if (!actorClass?.prototype?.applyDamage) {
			console.warn(`${Manager.id} | dying-automation: Actor.applyDamage not found, crit detection disabled`);
			return;
		}
		this._originalApplyDamage = actorClass.prototype.applyDamage;
		const tool = this;
		actorClass.prototype.applyDamage = async function (...args) {
			try {
				const outcome = args[0]?.outcome ?? null;
				tool._droppedOutcomes.set(this.uuid, { outcome: String(outcome ?? ""), timestamp: Date.now() });
				return await tool._originalApplyDamage.apply(this, args);
			} finally {
				// Not a knockdown after all -> drop the provisional record.
				try {
					const hp = Number(this.system?.attributes?.hp?.value);
					if (Number.isFinite(hp) && hp > 0) tool._droppedOutcomes.delete(this.uuid);
				} catch (error) {
					console.error(`${Manager.id} | dying-automation: outcome capture failed`, error);
				}
			}
		};
	}

	/** Returns whether the most recent damage application dropped this actor via a critical, consuming the record. */
	static _consumeCritOutcome(actor) {
		const entry = this._droppedOutcomes.get(actor.uuid);
		this._droppedOutcomes.delete(actor.uuid);
		if (!entry || Date.now() - entry.timestamp > OUTCOME_WINDOW_MS) return false;
		return entry.outcome === "criticalSuccess";
	}

	/* -------------------------------------------- */
	/*  HP transitions                              */
	/* -------------------------------------------- */

	static async _onUpdateActor(actor, update, options, userId) {
		try {
			if (userId !== game.user.id) return;
			// No ownership gate here: a causer who doesn't own the PC (another
			// player's heal or AoE) is precisely the case routed to the GM.
			if (!actor?.isOfType?.("character")) return;
			const newHp = Number(actor.system?.attributes?.hp?.value);
			if (!Number.isFinite(newHp)) return;

			let previousHp = this._lastKnownHp.get(actor.uuid);
			const damageTaken = Number(options?.damageTaken);
			if (Number.isFinite(damageTaken) && damageTaken !== 0) {
				// Positive = damage taken, negative = healing received (system convention).
				previousHp = newHp + damageTaken;
			}

			if (previousHp === undefined || !Number.isFinite(previousHp)) {
				this._lastKnownHp.set(actor.uuid, newHp);
				await this._checkForDeath(actor);
				return;
			}
			this._lastKnownHp.set(actor.uuid, newHp);

			if (newHp === 0 && previousHp > 0) {
				await this._onKnockdown(actor);
			} else if (newHp > 0 && previousHp === 0) {
				await this._onHealedAboveZero(actor);
			}
			await this._checkForDeath(actor);
		} catch (error) {
			console.error(`${Manager.id} | dying-automation failed`, error);
		}
	}

	/** HP crossed from above zero to zero: apply the rules-correct starting Dying value, capped at this PC's max. */
	static async _onKnockdown(actor) {
		if (actor.getCondition?.(DYING_SLUG)) return;
		const maxDying = this._maxDying(actor);
		if (maxDying <= 0) return; // Doomed cut the max to 0: the death check applies Dead.
		const wasCritical = this._consumeCritOutcome(actor);
		const woundedValue = Number(actor.getCondition?.(WOUNDED_SLUG)?.value) || 0;
		const startValue = Math.min((wasCritical ? 2 : 1) + woundedValue, maxDying);
		if (startValue >= maxDying && this._deathAutomationEnabled()) {
			// The knockdown itself lands the PC at max Dying: die outright.
			await this._writeCondition(actor, "applyDead");
			return;
		}
		// With death automation off (or a non-fatal start value), just apply
		// Dying capped at the actor's max — the PC stays at max Dying, Dead is manual.
		await this._writeCondition(actor, "applyDying", startValue);
	}

	/** HP climbed back above zero: remove Dying only if it is still present (manual stabilization stays respected). */
	static async _onHealedAboveZero(actor) {
		const dying = actor.getCondition?.(DYING_SLUG);
		if (!dying || dying.isLocked) return;
		await this._writeCondition(actor, "removeDying");
	}

	/* -------------------------------------------- */
	/*  Death at max Dying                          */
	/* -------------------------------------------- */

	/** The Dying value at which this PC dies: the system's derived max (4 minus Doomed, plus max-raising effects). */
	static _maxDying(actor) {
		const max = Number(actor?.system?.attributes?.dying?.max);
		return Number.isFinite(max) ? Math.max(max, 0) : DYING_DEATH_VALUE;
	}

	/** Whether the death-at-max-Dying automation is enabled (module setting, world scope). */
	static _deathAutomationEnabled() {
		try {
			return Manager.setting(this.id, "automateDeath") !== false;
		} catch (error) {
			return true; // Setting not registered yet (pre-migration world): keep the prior behavior.
		}
	}

	/**
	 * Applies the Dead status effect to a PC at 0 HP whose Dying value has
	 * reached their max (or whose max was cut to 0 by Doomed). Only Dead is
	 * written - Dying and Wounded are left exactly as they are, and the
	 * system removes Dead on its own when HP climbs back above 0. Dead is a
	 * CORE status effect (not a pf2e condition item), so it is toggled via
	 * `Actor#toggleStatusEffect` like the system's own heal path.
	 */
	static async _checkForDeath(actor) {
		if (!this._deathAutomationEnabled()) return;
		if (!actor?.isOfType?.("character")) return;
		if (actor.isDead) return;
		const hp = Number(actor.system?.attributes?.hp?.value);
		if (!Number.isFinite(hp) || hp !== 0) return;
		const maxDying = this._maxDying(actor);
		const dyingValue = Number(actor.getCondition?.(DYING_SLUG)?.value) || 0;
		if (maxDying > 0 && dyingValue < maxDying) return;
		await this._writeCondition(actor, "applyDead");
	}

	/**
	 * Watches Dying/Doomed condition writes (our knockdowns, manual bumps,
	 * macros, other automation - any source) and kills the PC when Dying
	 * reaches max. v14 hook signature quirk: `createItem` fires as
	 * (doc, options, userId) while `updateItem` fires as
	 * (doc, change, options, userId), so the acting user id is normalized.
	 */
	static _onItemChange(item, data, options, userId) {
		try {
			if (item.type !== "condition") return;
			const slug = item.slug ?? item.system?.slug;
			if (slug !== DYING_SLUG && slug !== DOOMED_SLUG) return;
			const actingUserId = typeof options === "string" ? options : userId;
			if (actingUserId !== game.user.id) return;
			const actor = item.actor;
			if (!actor?.isOfType?.("character")) return;
			this._checkForDeath(actor).catch((error) =>
				console.error(`${Manager.id} | dying-automation death check failed`, error)
			);
		} catch (error) {
			console.error(`${Manager.id} | dying-automation condition-change handler failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Condition writes (owner direct, else GM)    */
	/* -------------------------------------------- */

	/**
	 * Writes a condition change on a PC. Condition items are embedded items,
	 * so the server requires OWNER on the parent actor; the causer applies
	 * directly when permitted, otherwise the first connected GM does it via
	 * the module socket. Degrades to a warning when no GM is available -
	 * everything stays manually fixable.
	 */
	static async _writeCondition(actor, op, value) {
		if (actor.testUserPermission(game.user, "OWNER")) {
			await this._applyConditionOp(actor, op, value);
			return;
		}
		const result = await this.#requestGmWrite(actor.uuid, op, value);
		if (result.noGm) {
			console.warn(`${Manager.id} | dying-automation: no GM connected to ${op} on ${actor.name}`);
			ui.notifications.warn(
				Manager.localize("dyingAutomation.notify.noGm", { name: actor.name })
			);
		} else if (!result.applied) {
			console.warn(`${Manager.id} | dying-automation: GM could not ${op} on ${actor.name}`);
		}
	}

	/**
	 * Executes one condition operation with defensive re-validation. Runs
	 * either locally or on the GM's client; both paths end here.
	 */
	static async _applyConditionOp(actor, op, value) {
		if (!actor?.isOfType?.("character")) return false;
		if (op === "applyDying") {
			if ((Number(actor.system?.attributes?.hp?.value) || 0) > 0) return false;
			if (actor.getCondition?.(DYING_SLUG)) return false;
			await actor.increaseCondition(DYING_SLUG, { value: Math.min(Number(value) || 1, this._maxDying(actor)) });
			return true;
		}
		if (op === "applyDead") {
			if ((Number(actor.system?.attributes?.hp?.value) || 0) !== 0) return false;
			if (actor.isDead) return false;
			// Overlay = the status replaces the token's icon (big red X), exactly like
			// the system's own dead toggle (pf2e.mjs uses { overlay: true } too).
			await actor.toggleStatusEffect(DEAD_SLUG, { active: true, overlay: true });
			return true;
		}
		if (op === "removeDying") {
			const dying = actor.getCondition?.(DYING_SLUG);
			if (!dying || dying.isLocked) return false;
			await actor.decreaseCondition(DYING_SLUG, { forceRemove: true });
			return true;
		}
		return false;
	}

	/* -------------------------------------------- */
	/*  GM routing via module socket                */
	/* -------------------------------------------- */

	static _onSocketMessage(data, userId) {
		try {
			if (!data?.action) return;
			if (data.action === SOCKET_ACTION_REQUEST) {
				if (!game.user.isGM) return;
				this.#handleGmRequest(data, userId).catch((error) =>
					console.error(`${Manager.id} | dying-automation GM request failed`, error)
				);
			} else if (data.action === SOCKET_ACTION_RESULT) {
				this.#handleGmResult(data);
			}
		} catch (error) {
			console.error(`${Manager.id} | dying-automation socket handler failed`, error);
		}
	}

	/** Ask the first connected GM to write the condition on an actor this user doesn't own. */
	static #requestGmWrite(actorUuid, op, value) {
		return new Promise((resolve) => {
			const gm = game.users.find((user) => user.isGM && user.active);
			if (!gm) {
				resolve({ applied: false, noGm: true });
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve({ applied: false, timeout: true });
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer });
			// Plain serializable payload only - uuids and numbers survive the socket.
			game.socket.emit(
				SOCKET_EVENT,
				{ action: SOCKET_ACTION_REQUEST, requestId, actorUuid, op, value },
				{ recipients: [gm.id] }
			);
		});
	}

	/** GM-only: re-validate and execute the requested condition write. */
	static async #handleGmRequest(data, userId) {
		const { requestId, actorUuid, op } = data;
		if (!requestId || !actorUuid || !op) return;
		let applied = false;
		try {
			const actor = await fromUuid(actorUuid);
			applied = await this._applyConditionOp(actor, op, data.value);
		} catch (error) {
			console.warn(`${Manager.id} | dying-automation: GM could not ${op} on ${actorUuid}`, error);
		}
		game.socket.emit(
			SOCKET_EVENT,
			{ action: SOCKET_ACTION_RESULT, requestId, applied },
			{ recipients: [userId] }
		);
	}

	/** Resolve a pending request when the GM reports back. */
	static #handleGmResult(data) {
		const pending = this._pendingGmRequests.get(data?.requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this._pendingGmRequests.delete(data.requestId);
		pending.resolve({ applied: Boolean(data.applied) });
	}

	/* -------------------------------------------- */
	/*  Wounded follow-up                           */
	/* -------------------------------------------- */

	/**
	 * Any loss of the Dying condition on a PC (our heal removal, recovery
	 * checks reaching 0, manual deletion) grants Wounded 1 or increases the
	 * existing Wounded value, per the rules.
	 */
	static async _onDeleteItem(item, options, userId) {
		try {
			if (userId !== game.user.id) return;
			if (item.type !== "condition" || (item.slug ?? item.system?.slug) !== DYING_SLUG) return;
			const actor = item.actor;
			if (!actor?.isOfType?.("character")) return;
			if (!actor.testUserPermission(game.user, "OWNER")) return;
			const existingWounded = actor.getCondition?.(WOUNDED_SLUG);
			if (existingWounded?.isLocked) return;
			if (actor.getCondition?.(DYING_SLUG)) return;
			await actor.increaseCondition(WOUNDED_SLUG);
		} catch (error) {
			console.error(`${Manager.id} | dying-automation wounded follow-up failed`, error);
		}
	}
}
