import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";

const MODULE_ROOT = "modules/pf2e-vibemodulerp";
const EFFECT_NAME = "Mounted (Animal Companion)";
const FLAG_KEY = "rangerMount";
// Mirrors RangerFlurryTool's FLAG_KEY ("rangerFlurry"): the hub shares the
// flurry window's ammo memory, writing ammo1 so the Flurry window opens
// with this hub selection as its first shot.
const FLURRY_FLAG_KEY = "rangerFlurry";
const ARROW_FLAG_KEY = "rangerArrows";
const DEFAULT_PCT = 100;
const DEFAULT_MOUNT_FT = 40;
const MIN_FT = 5;
const MAX_FT = 200;

/**
 * Ranger Hub.
 *
 * A per-Ranger QoL window (Feature Hub button + Ctrl+Alt+C). v1 holds a
 * single feature: the "Animal Companion mounted" checkbox with a companion
 * Speed (ft) input on the same row.
 *
 * Selection gate: every control lives behind `_resolveRanger`, which passes
 * only when exactly one token is controlled, its actor is a character with
 * a Ranger class item, and the current user can write to it (owner or GM).
 * Anything else renders a gate message with all inputs disabled (nothing
 * to click, so nothing can land on the wrong actor).
 *
 * Mounted implementation: pure system modifier, zero actor writes. Checking
 * the box creates an effect named "Mounted (Animal Companion)" carrying a
 * single rule `{key: "FlatModifier", selector: "all-speeds",
 * value: mountFt - speedAtMount}` — the same rule shape the system's own
 * Encumbered condition uses for its -10 ft penalty. Land Speed is derived
 * as `max(base, BaseSpeed bonuses...) + all-speeds modifiers`, so the
 * modifier moves the final Speed to exactly the mount's value in BOTH
 * directions (faster or slower), stacks natively with everything else, and
 * shows up in the sheet's Speed breakdown like any other buff.
 * Mounted state IS effect presence: unchecking (or hand-deleting the
 * effect) deletes it and Speed returns by itself — there is no origin to
 * remember and no restore step that can fail. The tool NEVER writes
 * `system.attributes.speed` (a past dot-path write dropped the
 * `otherSpeeds` sibling key, threw in `ActorPF2e.prepareBaseData`, and
 * bricked a character sheet). The only actor write left is an inert UI
 * flag remembering the typed ft for the input default, plus the one-time
 * ready-time repairs below.
 *
 * No GM socket routing in v1: the gate guarantees the writer already has
 * OWNER (owners write their own Ranger; the GM has universal ownership),
 * and embedded-effect creation needs OWNER on the parent actor too.
 */
export class RangerHubTool {
	static id = "ranger-hub";
	static category = "ranger-hub";
	static enabledDefault = true;

	static _window = null;
	static _busy = false;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static init() {
		game.keybindings.register(Manager.id, "openRangerHub", {
			name: Manager.localize("rangerHub.keybindName"),
			hint: Manager.localize("rangerHub.keybindHint"),
			uneditable: [],
			editable: [{ key: "KeyC", modifiers: ["Control", "Alt"] }],
			onDown: () => this._toggleWindow(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
		});
	}

	static ready() {
		Hooks.on("controlToken", () => this._render());
		Hooks.on("updateActor", (actor) => {
			try {
				const current = this._resolveRanger();
				if (current.ok && current.actor?.uuid === actor?.uuid) this._render();
				else if (!current.ok) this._render();
			} catch {
				/* never break the actor-update pipeline from a window refresh */
			}
		});
		Hooks.on("createItem", () => this._render());
		Hooks.on("updateItem", () => this._render());
		// Arrow counter: stash pre-update ammo quantities so the post-update
		// hook can count each shot (quantity delta) while in combat.
		Hooks.on("preUpdateItem", (item, change) => this._stashQty(item, change));
		Hooks.on("updateItem", (item, change, options, userId) => this._countShot(item, change, userId));
		// Combat-start reset: shot counter to 0 + Recover button re-armed.
		// updateCombat fires on EVERY turn change too, so only the round→1
		// transition counts as a fresh start (idempotent absolute writes).
		Hooks.on("createCombat", (combat) => this._onCombatStart(combat, null));
		Hooks.on("updateCombat", (combat, change) => this._onCombatStart(combat, change));
		// Hand-deleting the marker IS unmounting (mounted state is effect
		// presence, so there is nothing to restore) — just refresh.
		Hooks.on("deleteItem", () => this._render());
		// Self-heal for marker effects created malformed by ranger-hub v1.0.0
		// (minimal system data: missing traits/duration broke actor prep and
		// the sheet, and the stuck item could not even be deleted). Repair
		// runs on every client but only touches actors it may write to; the
		// GM's client therefore heals the whole world, a player heals owned.
		this._repairBrokenMarkers().catch((error) =>
			console.error(`${Manager.id} | ranger-hub marker repair failed`, error)
		);
		console.debug(`${Manager.id} | ranger-hub ready`);
	}

	/* -------------------------------------------- */
	/*  Window management                           */
	/* -------------------------------------------- */

	static _openWindow() {
		if (!this._window) this._window = new RangerHubWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the ranger hub`, error)
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
		try {
			this._window?.render?.({ focus: false })?.catch?.(() => null);
		} catch {
			/* window not open — nothing to refresh */
		}
	}

	/* -------------------------------------------- */
	/*  Selection gate                              */
	/* -------------------------------------------- */

	/**
	 * The single Ranger the window may act on right now.
	 * @returns {{ok:true, token, actor}|{ok:false, reason:string, actorName:string|null}}
	 */
	static _resolveRanger() {
		const controlled = canvas?.tokens?.controlled ?? [];
		if (controlled.length !== 1) return { ok: false, reason: "none", actorName: null };
		const token = controlled[0];
		const actor = token?.actor ?? null;
		if (!actor?.isOfType?.("character")) return { ok: false, reason: "notCharacter", actorName: actor?.name ?? null };
		const classes = actor.itemTypes?.class ?? [];
		const isRanger = classes.some((item) => {
			const slug = (item.slug ?? item.system?.slug ?? "").toLowerCase();
			const name = (item.name ?? "").toLowerCase();
			return slug === "ranger" || name === "ranger";
		});
		if (!isRanger) return { ok: false, reason: "notRanger", actorName: actor?.name ?? null };
		if (!game.user.isGM && !actor.testUserPermission(game.user, "OWNER")) {
			return { ok: false, reason: "noOwner", actorName: actor?.name ?? null };
		}
		return { ok: true, token, actor };
	}

	/* -------------------------------------------- */
	/*  Mount state                                 */
	/* -------------------------------------------- */

	static _baseSpeed(actor) {
		return (
			actor?._source?.system?.attributes?.speed?.value ??
			actor?.system?.movement?.speeds?.land?.base ??
			25
		);
	}

	static _effectiveSpeed(actor) {
		return actor?.system?.movement?.speeds?.land?.value ?? this._baseSpeed(actor);
	}

	static _mountEffect(actor) {
		return (actor?.items ?? []).find((item) => item.type === "effect" && item.name === EFFECT_NAME) ?? null;
	}

	static _readState(actor) {
		let flag = {};
		try {
			flag = actor?.getFlag?.(Manager.id, FLAG_KEY) ?? {};
		} catch {
			flag = {};
		}
		const effect = this._mountEffect(actor);
		const healthy = effect && !this._isMalformedEffect(effect);
		const effectFlag = effect?.flags?.[Manager.id]?.rangerMount ?? {};
		// Mounted state IS effect presence. The actor flag is UI memory
		// only (the typed ft for the input default when unmounted).
		const mountFt = Number(effectFlag.mountFt ?? flag.mountFt) || DEFAULT_MOUNT_FT;
		const baseRef = Number(effectFlag.baseRef);
		return {
			mounted: Boolean(healthy),
			mountFt,
			value: healthy ? (this._mountRuleValue(effect) ?? mountFt - (Number.isFinite(baseRef) ? baseRef : this._effectiveSpeed(actor))) : 0,
			baseRef: Number.isFinite(baseRef) ? baseRef : null,
			base: this._baseSpeed(actor),
			effective: this._effectiveSpeed(actor),
			effect: effect ?? null
		};
	}

	static _clampFt(value) {
		const n = Math.round(Number(value));
		if (!Number.isFinite(n)) return DEFAULT_MOUNT_FT;
		return Math.min(MAX_FT, Math.max(MIN_FT, n));
	}

	/**
	 * Canonical marker-effect data. The mount is a single FlatModifier rule
	 * on the `all-speeds` domain — the exact shape the system's own
	 * Encumbered condition uses for its -10 ft penalty — so the modifier
	 * flows through the native derivation (`max(base, bonuses...) +
	 * modifiers`) with zero actor writes. MUST stay complete otherwise: the
	 * system clones full `toObject()` shapes when it creates effects via API
	 * (see its own effect-boost / raise-a-shield precedents), and a
	 * hand-built minimal object breaks hard — missing `system.traits`
	 * throws in `prepareBaseData` before `flags.pf2e`/`description.addenda`
	 * are initialized, which bricks actor prep + the character sheet AND
	 * makes the item undeletable (`processGrantDeletions` runs before the
	 * actual delete and reads `flags.pf2e.grantedBy`). Duration mirrors the
	 * system's own unlimited shape (`value: -1, unit: "unlimited"`).
	 * @param {number} mountFt companion Speed being granted
	 * @param {number} baseRef effective Speed the modifier is measured from
	 */
	static _mountEffectData(mountFt, baseRef) {
		const value = mountFt - baseRef;
		return {
			name: EFFECT_NAME,
			type: "effect",
			system: {
				slug: "mounted-animal-companion",
				description: {
					value: `<p>Riding an animal companion. Moves at the mount's ${mountFt} ft Speed (${value >= 0 ? "+" : ""}${value} ft modifier). Removing this effect restores the natural Speed automatically.</p>`
				},
				duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
				level: { value: 1 },
				traits: { rarity: "common", value: [] },
				rules: [
					{
						key: "FlatModifier",
						selector: "all-speeds",
						slug: "mounted-animal-companion",
						value
					}
				],
				start: { initiative: null, value: 0 },
				tokenIcon: { show: true }
			},
			flags: {
				pf2e: { rulesSelections: {}, itemGrants: {} },
				[Manager.id]: { rangerMount: { mountFt, baseRef, value } }
			}
		};
	}

	/** The mount rule's value on an effect (null when the rule is absent). */
	static _mountRuleValue(effect) {
		const rule = (effect?.system?.rules ?? []).find(
			(entry) => entry?.key === "FlatModifier" && entry?.selector === "all-speeds"
		);
		const value = Number(rule?.value);
		return Number.isFinite(value) ? value : null;
	}

	/**
	 * True when a marker effect lacks the runtime shape a healthy prepared
	 * effect always has (`prepareBaseData` assigns `description.addenda`
	 * and `flags.pf2e` on every successful prep, so their absence proves
	 * prep threw partway — the v1.0.0 minimal-data breakage).
	 */
	static _isMalformedEffect(item) {
		const sys = item?.system ?? {};
		return (
			!Array.isArray(sys.traits?.value) ||
			!sys.duration ||
			!Array.isArray(sys.description?.addenda) ||
			!item?.flags?.pf2e
		);
	}

	/**
	 * Repair malformed marker effects in place via `update` (the update
	 * pipeline never touches grant cleanup, unlike delete). Stored
	 * origin/mount values are preserved, preferring the actor flag record.
	 */
	static async _repairBrokenMarkers() {
		try {
			const actors = (game.actors?.contents ?? []).filter(
				(actor) =>
					actor?.isOfType?.("character") &&
					(game.user.isGM || actor.testUserPermission(game.user, "OWNER"))
			);
			for (const actor of actors) {
				// Speed-shape self-heal: a stored speed that is present but
				// missing `otherSpeeds` throws in ActorPF2e.prepareBaseData
				// (...undefined spread) and bricks the whole sheet. Restore
				// the sibling key; actors with no speed key at all are left
				// alone (the system default covers them).
				try {
					const stored = actor?._source?.system?.attributes?.speed;
					if (stored && !Array.isArray(stored.otherSpeeds)) {
						await actor.update({ "system.attributes.speed": { ...stored, otherSpeeds: [] } });
						console.warn(`${Manager.id} | ranger-hub restored missing otherSpeeds on ${actor?.name}`);
					}
				} catch (error) {
					console.error(
						`${Manager.id} | ranger-hub could not repair speed shape on ${actor?.name}`,
						error
					);
				}
				const broken = (actor.items ?? []).filter(
					(item) => item.type === "effect" && item.name === EFFECT_NAME && this._isMalformedEffect(item)
				);
				for (const item of broken) {
					try {
						const flag = actor.getFlag?.(Manager.id, FLAG_KEY) ?? {};
						const itemFlag = item.flags?.[Manager.id]?.rangerMount ?? {};
						const mountFt = Number(flag.mountFt ?? itemFlag.mountFt);
						// A malformed marker never applied its rules (prep
						// threw first), so the live Speed is a clean
						// reference for the replacement modifier.
						await item.update(
							this._mountEffectData(
								Number.isFinite(mountFt) && mountFt > 0 ? mountFt : DEFAULT_MOUNT_FT,
								this._effectiveSpeed(actor)
							)
						);
						console.warn(`${Manager.id} | ranger-hub repaired malformed marker effect on ${actor?.name}`);
					} catch (error) {
						console.error(
							`${Manager.id} | ranger-hub could not repair marker effect on ${actor?.name}`,
							error
						);
					}
				}
				// Legacy flag cleanup: mounted-state-as-flag and origSpeed
				// belong to the retired base-overwrite design. Mounted state
				// is effect presence now; only the ft UI memory is kept.
				try {
					const flag = actor.getFlag?.(Manager.id, FLAG_KEY) ?? {};
					if (flag && (("mounted" in flag) || ("origSpeed" in flag))) {
						const mountFt = Number(flag.mountFt) || DEFAULT_MOUNT_FT;
						await actor.setFlag(Manager.id, FLAG_KEY, { mountFt });
					}
				} catch (error) {
					console.error(
						`${Manager.id} | ranger-hub could not clean legacy mount flag on ${actor?.name}`,
						error
					);
				}
			}
		} finally {
			this._render();
		}
	}

	/**
	 * Check or uncheck "mounted" for a gated Ranger actor.
	 * @param {Actor} actor gated Ranger actor (caller must have resolved it)
	 * @param {boolean} mounted target state
	 * @param {number} mountFt companion Speed in feet
	 */
	static async _setMounted(actor, mounted, mountFt) {
		if (!actor || this._busy) return;
		this._busy = true;
		try {
			mountFt = this._clampFt(mountFt);
			const state = this._readState(actor);
			if (mounted) {
				// Modifier measured from the current final Speed (no marker
				// present yet, so nothing of ours is in it). Never creates
				// a second marker — an existing one is updated in place.
				const baseRef = state.mounted && state.baseRef !== null ? state.baseRef : state.effective;
				const data = this._mountEffectData(mountFt, baseRef);
				if (!state.effect) {
					await actor.createEmbeddedDocuments("Item", [data]);
					// Sanity gate: a malformed marker must never go
					// unnoticed (a half-applied mount bricked an actor
					// once). Try an in-place repair, then abort loudly —
					// no speed was touched, so nothing is stuck.
					const created = this._mountEffect(actor);
					if (this._isMalformedEffect(created)) {
						try {
							await created?.update?.(data);
						} catch {
							/* fall through to the re-check below */
						}
						if (this._isMalformedEffect(this._mountEffect(actor))) {
							throw new Error("marker effect failed validation, mount aborted");
						}
					}
				} else if (this._isMalformedEffect(state.effect)) {
					await state.effect.update(data);
				} else {
					await state.effect.update({
						[`flags.${Manager.id}.rangerMount`]: data.flags[Manager.id].rangerMount,
						system: { rules: data.system.rules, description: data.system.description }
					});
				}
				// UI memory only (input default while unmounted). Mounted
				// state itself lives in the effect's presence, not here.
				await actor.setFlag(Manager.id, FLAG_KEY, { mountFt });
			} else {
				// Deleting the effect IS unmounting: the modifier leaves
				// with it and Speed returns by itself. Nothing to restore.
				if (state.effect) {
					// Our own delete: the shared socket/world hooks must not
					// treat it as foreign (kept for forward-compat).
					await state.effect.delete({ [`${Manager.id}-ranger-unmount`]: true });
				}
				// Keep the typed ft as the next default.
				await actor.setFlag(Manager.id, FLAG_KEY, { mountFt: state.mountFt });
			}
		} catch (error) {
			console.error(`${Manager.id} | ranger-hub mount change failed`, error);
			ui.notifications?.warn?.(Manager.localize("rangerHub.notify.failed", { name: actor?.name ?? "" }));
		} finally {
			this._busy = false;
			this._render();
		}
	}

	/** Remember a new companion Speed without (un)mounting. */
	static async _rememberFt(actor, mountFt) {
		if (!actor || this._busy) return;
		mountFt = this._clampFt(mountFt);
		this._busy = true;
		try {
			const state = this._readState(actor);
			if (state.mounted && state.effect) {
				// Live-update the active mount: same reference Speed, new
				// grant. Item update only — zero actor writes.
				const baseRef = state.baseRef ?? state.effective - state.value;
				const data = this._mountEffectData(mountFt, baseRef);
				await state.effect.update({
					[`flags.${Manager.id}.rangerMount`]: data.flags[Manager.id].rangerMount,
					system: { rules: data.system.rules, description: data.system.description }
				});
			}
			await actor.setFlag(Manager.id, FLAG_KEY, { mountFt });
		} catch (error) {
			console.error(`${Manager.id} | ranger-hub could not remember mount speed`, error);
		} finally {
			this._busy = false;
			this._render();
		}
	}

	/* -------------------------------------------- */
	/*  Arrow counter + recovery                    */
	/* -------------------------------------------- */

	/** True when the actor is a Ranger character (ownership NOT checked). */
	static _isRangerActor(actor) {
		if (!actor?.isOfType?.("character")) return false;
		return (actor.itemTypes?.class ?? []).some((item) => {
			const slug = (item.slug ?? item.system?.slug ?? "").toLowerCase();
			const name = (item.name ?? "").toLowerCase();
			return slug === "ranger" || name === "ranger";
		});
	}

	static _clampPct(value) {
		const n = Math.round(Number(value));
		if (!Number.isFinite(n)) return DEFAULT_PCT;
		return Math.min(100, Math.max(0, n));
	}

	/** Raw arrow-counter flag merged over defaults (never writes). */
	static _readArrowState(actor) {
		let flag = {};
		try {
			flag = actor?.getFlag?.(Manager.id, ARROW_FLAG_KEY) ?? {};
		} catch {
			flag = {};
		}
		const shot = Math.round(Number(flag.shot));
		const recoveredN = Math.round(Number(flag.recoveredN));
		return {
			ammoId: typeof flag.ammoId === "string" ? flag.ammoId : "",
			shot: Number.isFinite(shot) ? Math.max(0, shot) : 0,
			pct: this._clampPct(flag.pct ?? DEFAULT_PCT),
			recovered: flag.recovered === true,
			recoveredN: Number.isFinite(recoveredN) ? Math.max(0, recoveredN) : 0,
			recoveredName: typeof flag.recoveredName === "string" ? flag.recoveredName : ""
		};
	}

	/** Every ammo stack on the actor (tracked stack included at any qty). */
	static _trackableAmmo(actor) {
		return (actor?.items ?? [])
			.filter((i) => i?.type === "ammo")
			.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
			.map((i) => ({ id: i.id, label: `${i.name} (${i.system?.quantity ?? 0})` }));
	}

	/**
	 * The ammo stack being tracked right now: the remembered one while it
	 * still exists, otherwise the first stack (so a fresh Ranger counts
	 * immediately without having to pick first).
	 */
	static _trackId(actor) {
		const state = this._readArrowState(actor);
		if (state.ammoId && actor?.items?.get?.(state.ammoId)?.type === "ammo") return state.ammoId;
		return this._trackableAmmo(actor)[0]?.id ?? "";
	}

	static async _saveArrowState(actor, patch) {
		if (!actor) return;
		try {
			const prev = actor.getFlag?.(Manager.id, ARROW_FLAG_KEY) ?? {};
			await actor.setFlag(Manager.id, ARROW_FLAG_KEY, { ...prev, ...patch });
		} catch (error) {
			console.warn(`${Manager.id} | ranger hub could not save arrow state`, error);
		} finally {
			this._render();
		}
	}

	/* Pre-update stash of ammo quantities (the update hook only sees news). */
	static _qtyBefore = new Map();

	static _stashQty(item, change) {
		try {
			if (item?.type !== "ammo" || change?.system?.quantity == null) return;
			if (this._qtyBefore.size > 200) this._qtyBefore.clear();
			this._qtyBefore.set(item.uuid, Number(item.system?.quantity ?? 0));
		} catch {
			/* never break the item-update pipeline from a stash */
		}
	}

	/**
	 * Count a fired arrow: quantity drop on the tracked stack while a
	 * combat runs. Only the originating client counts (`userId` guard, the
	 * same single-writer pattern as the effect-animation tool) so a shot
	 * is never double-counted when GM and player are both online.
	 */
	static _countShot(item, change, userId) {
		try {
			if (userId !== game.user.id) return;
			if (item?.type !== "ammo") return;
			if (!game.combat?.started) return;
			const before = this._qtyBefore.get(item.uuid);
			this._qtyBefore.delete(item.uuid);
			if (!Number.isFinite(before)) return;
			const used = before - Number(item.system?.quantity ?? 0);
			if (!(used > 0)) return;
			const actor = item.parent;
			if (!actor || !this._isRangerActor(actor)) return;
			if (item.id !== this._trackId(actor)) return;
			if (!game.user.isGM && !actor.testUserPermission(game.user, "OWNER")) return;
			const state = this._readArrowState(actor);
			this._saveArrowState(actor, { shot: state.shot + used }).catch((error) =>
				console.warn(`${Manager.id} | ranger hub could not count arrows`, error)
			);
		} catch {
			/* never break the item-update pipeline from counting */
		}
	}

	/** Fresh combat → every Ranger's counter to 0, Recover re-armed. */
	static _onCombatStart(combat, change) {
		try {
			if (!combat) return;
			const fresh = change ? change.round === 1 : combat.started === true;
			if (!fresh) return;
			this._resetArrowCounters().catch((error) =>
				console.warn(`${Manager.id} | ranger hub could not reset arrow counters`, error)
			);
		} catch {
			/* never break the combat pipeline from a counter reset */
		}
	}

	static async _resetArrowCounters() {
		try {
			// Absolute writes (shot: 0), so concurrent writers converge —
			// but prefer a single writer anyway: the first active GM, else
			// each client resets the Rangers it owns.
			const gm = game.users.find((u) => u.isGM && u.active);
			let targets;
			if (gm) {
				if (gm.id !== game.user.id) return;
				targets = (game.actors?.contents ?? []).filter((a) => this._isRangerActor(a));
			} else {
				targets = (game.actors?.contents ?? []).filter(
					(a) => this._isRangerActor(a) && a.testUserPermission(game.user, "OWNER")
				);
			}
			for (const actor of targets) {
				try {
					const prev = actor.getFlag?.(Manager.id, ARROW_FLAG_KEY) ?? {};
					await actor.setFlag(Manager.id, ARROW_FLAG_KEY, {
						...prev,
						shot: 0,
						recovered: false,
						recoveredN: 0,
						recoveredName: ""
					});
				} catch (error) {
					console.warn(`${Manager.id} | ranger hub could not reset arrows on ${actor?.name}`, error);
				}
			}
		} finally {
			this._render();
		}
	}

	/**
	 * Recover a percentage of the fired arrows back into the tracked
	 * stack. One recovery per combat: afterwards the button shows
	 * "Already Recovered" (disabled) until the next combat start.
	 */
	static async _recoverArrows(actor) {
		if (!actor || this._busy) return;
		const state = this._readArrowState(actor);
		if (state.recovered) return;
		const ammo = actor.items.get(this._trackId(actor));
		if (!ammo || ammo.type !== "ammo") {
			ui.notifications?.warn?.(Manager.localize("rangerHub.notify.noTrackAmmo"));
			return;
		}
		this._busy = true;
		try {
			const n = Math.round(Number(state.shot) * this._clampPct(state.pct) / 100);
			if (n > 0) {
				await ammo.update({ "system.quantity": Number(ammo.system?.quantity ?? 0) + n });
			}
			await this._saveArrowState(actor, { recovered: true, recoveredN: n, recoveredName: ammo.name });
			if (n > 0) {
				ui.notifications?.info?.(Manager.localize("rangerHub.notify.recovered", { n, name: ammo.name }));
			}
		} catch (error) {
			console.error(`${Manager.id} | ranger hub arrow recovery failed`, error);
			ui.notifications?.warn?.(Manager.localize("rangerHub.notify.recoverFailed", { name: actor?.name ?? "" }));
		} finally {
			this._busy = false;
			this._render();
		}
	}

	/* -------------------------------------------- */
	/*  Context                                     */
	/* -------------------------------------------- */

	/** Ammo stacks the window can offer (type ammo, quantity > 0, by name). Mirrors RangerFlurryTool._ammoList. */
	static _ammoList(actor) {
		return (actor?.items ?? [])
			.filter((i) => i?.type === "ammo" && Number(i.system?.quantity ?? 0) > 0)
			.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
			.map((i) => ({ id: i.id, label: `${i.name} (${i.system.quantity})` }));
	}

	static _context() {
		const resolved = this._resolveRanger();
		const i18n = (key, data) => Manager.localize(`rangerHub.${key}`, data);
		if (!resolved.ok) {
			const reasonKey =
				resolved.reason === "notCharacter"
					? "gateNotCharacter"
					: resolved.reason === "notRanger"
						? "gateNotRanger"
						: resolved.reason === "noOwner"
							? "gateNoOwner"
							: "gateNone";
			return {
				gated: false,
				gateMessage: Manager.localize(`rangerHub.${reasonKey}`, { name: resolved.actorName ?? "" }),
				i18n
			};
		}
		const state = this._readState(resolved.actor);
		const bonus = state.effective - state.base;
		// Shared ammo memory with the Flurry window: the hub selection feeds
		// the window's first-shot dropdown (which falls back to its own
		// default when the remembered ammo is gone).
		const ammo = this._ammoList(resolved.actor);
		let flurryMem = {};
		try {
			flurryMem = resolved.actor.getFlag?.(Manager.id, FLURRY_FLAG_KEY) ?? {};
		} catch {
			flurryMem = {};
		}
		const validAmmo = new Set(ammo.map((a) => a.id));
		const hubAmmo = validAmmo.has(flurryMem.ammo1) ? flurryMem.ammo1 : (ammo[0]?.id ?? "");
		const arrowState = this._readArrowState(resolved.actor);
		const trackId = this._trackId(resolved.actor);
		const trackAmmo = this._trackableAmmo(resolved.actor);
		return {
			gated: true,
			rangerName: resolved.actor.name,
			mounted: state.mounted,
			mountFt: state.mountFt,
			base: state.base,
			effective: state.effective,
			bonus,
			bonusText:
				bonus > 0 ? `+${bonus}` : bonus < 0 ? `${bonus}` : "±0",
			ammo: ammo.map((a) => ({ ...a, selected: a.id === hubAmmo })),
			trackAmmo: trackAmmo.map((a) => ({ ...a, selected: a.id === trackId })),
			shot: arrowState.shot,
			pct: arrowState.pct,
			recovered: arrowState.recovered,
			// Record line under the arrow row (only rendered after Recover;
			// absent element = zero space taken). Name falls back to the
			// currently tracked stack for flags written before the name
			// was stored.
			recoveredLine: arrowState.recovered
				? Manager.localize("rangerHub.recoveredLine", {
					n: arrowState.recoveredN,
					name: arrowState.recoveredName || resolved.actor.items.get(trackId)?.name || ""
				})
				: "",
			i18n
		};
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class RangerHubWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2)
) {
	static DEFAULT_OPTIONS = {
		id: "ranger-hub",
		classes: ["vibe-ranger-hub"],
		position: { width: 380 },
		window: {
			icon: "fa-solid fa-horse",
			resizable: true,
			minimizable: true
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/ranger-hub.hbs`, root: true }
	};

	get title() {
		return Manager.localize("rangerHub.title");
	}

	_prepareContext(options) {
		return RangerHubTool._context();
	}

	_onRender(context, options) {
		const root = this.element;
		if (!root) return;
		root.querySelector("[data-open-flurry]")?.addEventListener("click", async () => {
			try {
				const { RangerFlurryTool } = await import("./ranger-flurry.js");
				RangerFlurryTool.openWindow();
			} catch (error) {
				console.warn(`${Manager.id} | could not open ranger flurry`, error);
			}
		});
		const checkbox = root.querySelector('input[name="mounted"]');
		const ftInput = root.querySelector('input[name="mountFt"]');
		checkbox?.addEventListener("change", async (event) => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			const ft = root.querySelector('input[name="mountFt"]')?.value;
			await RangerHubTool._setMounted(resolved.actor, event.target.checked === true, ft);
		});
		ftInput?.addEventListener("change", async (event) => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			await RangerHubTool._rememberFt(resolved.actor, event.target.value);
		});
		// Arrow counter row: tracked-stack picker + editable shot count +
		// recover % + Recover button (one recovery per combat).
		root.querySelector('select[name="trackAmmo"]')?.addEventListener("change", async (event) => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			await RangerHubTool._saveArrowState(resolved.actor, { ammoId: event.target.value });
		});
		root.querySelector('input[name="shot"]')?.addEventListener("change", async (event) => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			const n = Math.round(Number(event.target.value));
			if (!Number.isFinite(n) || n < 0) {
				RangerHubTool._render();
				return;
			}
			await RangerHubTool._saveArrowState(resolved.actor, { shot: n });
		});
		root.querySelector('input[name="pct"]')?.addEventListener("change", async (event) => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			await RangerHubTool._saveArrowState(resolved.actor, { pct: RangerHubTool._clampPct(event.target.value) });
		});
		root.querySelector("[data-recover-arrows]")?.addEventListener("click", async () => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			await RangerHubTool._recoverArrows(resolved.actor);
		});
		// Ammo selection: remembered into the shared flurry memory as the
		// first shot, so the Flurry window opens with it pre-selected.
		root.querySelector('select[name="hubAmmo"]')?.addEventListener("change", async (event) => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			try {
				const prev = resolved.actor.getFlag?.(Manager.id, FLURRY_FLAG_KEY) ?? {};
				await resolved.actor.setFlag(Manager.id, FLURRY_FLAG_KEY, {
					ammo1: event.target.value,
					ammo2: prev.ammo2 ?? event.target.value
				});
			} catch (error) {
				console.warn(`${Manager.id} | ranger hub could not remember ammo`, error);
			}
		});
		// Activate: tracker-only log that this arrow was activated (1 action,
		// nothing consumed — the shots themselves consume ammo natively).
		root.querySelector("[data-activate-ammo]")?.addEventListener("click", async () => {
			const resolved = RangerHubTool._resolveRanger();
			if (!resolved.ok) {
				RangerHubTool._render();
				return;
			}
			const ammoId = root.querySelector('select[name="hubAmmo"]')?.value ?? "";
			const ammo = resolved.actor.items.get(ammoId);
			if (!ammo || ammo.type !== "ammo") {
				ui.notifications?.warn?.(Manager.localize("rangerHub.notify.noAmmo"));
				return;
			}
			try {
				const { ActionTrackerTool } = await import("./action-tracker.js");
				await ActionTrackerTool.logExternal(resolved.actor, {
					name: Manager.localize("rangerHub.activatedEntry", { name: ammo.name }),
					cost: 1,
					icon: ammo.img ? { img: ammo.img } : { fa: "fa-bow-arrow" }
				});
			} catch (error) {
				console.warn(`${Manager.id} | ranger hub ammo activation failed`, error);
			}
		});
	}
}
