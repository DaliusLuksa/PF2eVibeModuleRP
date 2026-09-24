import { Manager } from "../core/manager.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_APPLY = "rangerHuntPreyApply";
const GM_TIMEOUT_MS = 20000;

const HUNT_PREY_SLUG = "effect-hunt-prey";
const MARK_RULE_SLUG = "hunted-prey";
const MARK_SLUG = "hunted-prey-mark";
const MARK_IMG = "modules/pf2e-vibemodulerp/img/hunted-prey-mark.webp";
const FLAG_KEY = "rangerHuntPrey";

/**
 * Ranger Hunt Prey prey-marker.
 *
 * The system keeps Hunt Prey ranger-side only: `Effect: Hunt Prey` sits on
 * the ranger and its `TokenMark` rule stores the prey token's document UUID
 * in `system.rules[].uuid`. Nothing visible lands on the enemy itself.
 *
 * This tool adds three behaviors around that effect (all inert w.r.t. the
 * system's own mark map in `attacker.synthetics.tokenMarks`, which
 * RangerFlurryTool keeps reading — the original effect is never modified):
 *
 * 1. Dedup on apply: when an `Effect: Hunt Prey` is created on an actor that
 *    already carries one, the older copies are deleted and only the newest
 *    is kept (matching the action's "one prey at a time" text).
 * 2. Prey marker: one inert effect (`MARK_SLUG`, grayscale Hunt Prey icon,
 *    `tokenIcon.show`, NO rules) is placed on the prey's actor, named
 *    "Hunted Prey (marked by <Ranger>)". It is deleted automatically when
 *    the ranger's Hunt Prey effect is deleted, for any reason.
 * 3. Death cleanup: when the marked prey truly dies (`actor.isDead`, i.e.
 *    the Dead status — NOT merely 0 HP/down), the GM deletes the ranger's
 *    Hunt Prey effect, which cascades into marker removal via (2).
 *
 * Single-writer rules (embedded writes need OWNER on the parent actor):
 * - Marker creation happens on the creating client (the ranger's owner);
 *   when the prey actor is not writable locally the request is GM-routed
 *   over the shared module socket (first active GM, `recipients` so only
 *   one GM acts).
 * - Marker removal on hunt-effect delete is handled by the GM when one is
 *   connected (the hook fires on every client, so the GM's client always
 *   sees it); with no GM connected the prey actor's owner handles it.
 * - Death cleanup is GM-only.
 */
export class RangerHuntPreyTool {
	static id = "ranger-hunt-prey";
	static category = "ranger-hub";
	static enabledDefault = true;

	static _pending = new Map();

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		Hooks.on("createItem", (doc, options, userId) => {
			try {
				if (!Manager.isEnabled(this.id)) return;
				// v14 createItem fires (doc, options, userId) on EVERY
				// client — only the creating client acts.
				if (userId !== game.user.id) return;
				if (doc?.type === "effect" && doc?.slug === HUNT_PREY_SLUG && doc?.actor) {
					this._onHuntCreated(doc.actor, doc).catch((error) =>
						console.error(`${Manager.id} | ranger hunt-prey create failed`, error)
					);
				}
			} catch (error) {
				console.error(`${Manager.id} | ranger hunt-prey create hook failed`, error);
			}
		});

		Hooks.on("updateItem", (doc, change, options, userId) => {
			try {
				if (!Manager.isEnabled(this.id)) return;
				if (userId !== game.user.id) return;
				// Our own flag bookkeeping (preyActorUuid) is a flag-only
				// update — only a rules change means a retarget.
				if (!change?.system?.rules) return;
				if (doc?.type === "effect" && doc?.slug === HUNT_PREY_SLUG && doc?.actor) {
					this._onHuntRetargeted(doc.actor, doc).catch((error) =>
						console.error(`${Manager.id} | ranger hunt-prey retarget failed`, error)
					);
				}
			} catch (error) {
				console.error(`${Manager.id} | ranger hunt-prey update hook failed`, error);
			}
		});

		// No userId guard here on purpose: the client that can write the
		// prey actor is elected inside (_canWrite / GM-present check), and
		// the hook fires on every connected client.
		Hooks.on("deleteItem", (doc) => {
			try {
				if (!Manager.isEnabled(this.id)) return;
				if (doc?.type === "effect" && doc?.slug === HUNT_PREY_SLUG) {
					this._onHuntDeleted(doc).catch((error) =>
						console.error(`${Manager.id} | ranger hunt-prey delete failed`, error)
					);
				}
			} catch (error) {
				console.error(`${Manager.id} | ranger hunt-prey delete hook failed`, error);
			}
		});

		// Death cleanup: GM is the single writer (universal ownership, and
		// the hook fires on all clients so exactly the GM acts).
		Hooks.on("updateActor", (actor) => {
			try {
				if (!Manager.isEnabled(this.id)) return;
				if (!game.user.isGM) return;
				if (!actor?.isDead) return;
				this._onPreyDead(actor).catch((error) =>
					console.error(`${Manager.id} | ranger hunt-prey death cleanup failed`, error)
				);
			} catch (error) {
				console.error(`${Manager.id} | ranger hunt-prey actor hook failed`, error);
			}
		});

		Hooks.on("deleteActor", (actor) => {
			try {
				if (!Manager.isEnabled(this.id)) return;
				if (!game.user.isGM) return;
				if (!actor?.uuid) return;
				this._onPreyActorDeleted(actor.uuid).catch((error) =>
					console.error(`${Manager.id} | ranger hunt-prey actor-delete cleanup failed`, error)
				);
			} catch (error) {
				console.error(`${Manager.id} | ranger hunt-prey actor-delete hook failed`, error);
			}
		});

		game.socket.on(SOCKET_EVENT, this._onSocket.bind(this));
		console.debug(`${Manager.id} | ranger-hunt-prey ready`);
	}

	/* -------------------------------------------- */
	/*  Recognition helpers                         */
	/* -------------------------------------------- */

	static _ruleTargetUuid(huntItem) {
		try {
			const rule = (huntItem?.system?.rules ?? []).find(
				(entry) => entry?.key === "TokenMark" && (!entry?.slug || entry.slug === MARK_RULE_SLUG)
			);
			return rule?.uuid ?? null;
		} catch {
			return null;
		}
	}

	static _huntFlag(huntItem) {
		try {
			return huntItem?.flags?.[Manager.id]?.[FLAG_KEY] ?? {};
		} catch {
			return {};
		}
	}

	/** Token document the hunt points at (null when untargeted/gone). */
	static async _resolveTargetToken(huntItem) {
		const uuid = this._ruleTargetUuid(huntItem);
		if (!uuid) return null;
		try {
			const doc = await fromUuid(uuid);
			// TokenMark stores a TokenDocument uuid; accept a bare token
			// placeable too, just in case.
			if (doc?.actor) return doc?.object ?? doc;
			return null;
		} catch {
			return null;
		}
	}

	static async _resolvePreyActor(huntItem) {
		try {
			const token = await this._resolveTargetToken(huntItem);
			if (token?.actor) return token.actor;
			const flagUuid = this._huntFlag(huntItem)?.preyActorUuid ?? null;
			if (flagUuid) {
				try {
					const actor = await fromUuid(flagUuid);
					if (actor?.uuid) return actor;
				} catch {}
			}
			return null;
		} catch {
			return null;
		}
	}

	static _findMark(preyActor, rangerUuid, huntItemId) {
		try {
			return (
				(preyActor?.items ?? []).find((item) => {
					if (item?.type !== "effect" || item?.slug !== MARK_SLUG) return false;
					const flag = item?.flags?.[Manager.id]?.[FLAG_KEY] ?? {};
					return flag.rangerUuid === rangerUuid && flag.huntItemId === huntItemId;
				}) ?? null
			);
		} catch {
			return null;
		}
	}

	static _canWrite(actor) {
		try {
			return game.user.isGM || actor?.testUserPermission?.(game.user, "OWNER") === true;
		} catch {
			return false;
		}
	}

	/* -------------------------------------------- */
	/*  Marker data                                 */
	/* -------------------------------------------- */

	/**
	 * Canonical marker data. Deliberately inert (rules: []) — the system's
	 * own TokenMark on the ranger carries all the mechanics; this item is
	 * only the visible token icon + sheet row on the prey. Otherwise a full
	 * shape (a minimal object bricks actor prep — see the ranger-hub hard
	 * lesson), mirroring `_mountEffectData`.
	 */
	static _markerData(ranger, huntItem) {
		return {
			name: `Hunted Prey (marked by ${ranger?.name ?? "a ranger"})`,
			type: "effect",
			img: MARK_IMG,
			system: {
				slug: MARK_SLUG,
				description: {
					value: `<p>Marked as @UUID[${ranger?.uuid ?? ""}]{${ranger?.name ?? "a ranger"}}'s hunted prey. This marker is removed automatically when the hunt ends.</p>`
				},
				duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
				level: { value: 1 },
				traits: { rarity: "common", value: [] },
				rules: [],
				start: { initiative: null, value: 0 },
				tokenIcon: { show: true }
			},
			flags: {
				pf2e: { rulesSelections: {}, itemGrants: {} },
				[Manager.id]: { [FLAG_KEY]: { rangerUuid: ranger?.uuid ?? null, huntItemId: huntItem?.id ?? null } }
			}
		};
	}

	/* -------------------------------------------- */
	/*  Apply path (create + retarget)              */
	/* -------------------------------------------- */

	static async _onHuntCreated(ranger, huntItem) {
		const targetUuid = this._ruleTargetUuid(huntItem);
		// Untargeted (mark prompt cancelled but the item survived): leave it
		// alone — deleting the ranger's only designation over a failed
		// retarget would be worse than keeping a markless effect.
		if (!targetUuid) return;
		// Dedup: the new application replaces older designations.
		try {
			const stale = (ranger?.items ?? []).filter(
				(item) => item?.type === "effect" && item?.slug === HUNT_PREY_SLUG && item?.id !== huntItem?.id
			);
			for (const old of stale) {
				try {
					await old.delete();
				} catch (error) {
					console.warn(`${Manager.id} | ranger hunt-prey could not remove previous designation`, error);
				}
			}
		} catch (error) {
			console.warn(`${Manager.id} | ranger hunt-prey dedup failed`, error);
		}
		await this._ensureMarker(ranger, huntItem);
	}

	static async _onHuntRetargeted(ranger, huntItem) {
		// Drop the marker on the previously marked prey (if we know it and
		// it differs), then ensure one on the new target.
		let oldPreyUuid = null;
		try {
			oldPreyUuid = this._huntFlag(huntItem)?.preyActorUuid ?? null;
		} catch {}
		const prey = await this._resolvePreyActor(huntItem);
		if (oldPreyUuid && prey?.uuid !== oldPreyUuid) {
			try {
				const oldPrey = await fromUuid(oldPreyUuid).catch(() => null);
				const oldMark = oldPrey ? this._findMark(oldPrey, ranger?.uuid, huntItem?.id) : null;
				if (oldMark && this._canWrite(oldPrey)) {
					await oldMark.delete();
				}
				// An in-place retarget never deletes the hunt, so the delete
				// path can't clean the old marker — route it to the GM.
				else if (oldMark) {
					await this._requestGmDelete(ranger, huntItem, oldPreyUuid).catch(() => null);
				}
			} catch (error) {
				console.warn(`${Manager.id} | ranger hunt-prey could not clear old prey marker`, error);
			}
		}
		await this._ensureMarker(ranger, huntItem);
	}

	/** Create the prey marker if missing; remember the prey on the hunt. */
	static async _ensureMarker(ranger, huntItem) {
		const prey = await this._resolvePreyActor(huntItem);
		if (!prey) return;
		if (this._findMark(prey, ranger?.uuid, huntItem?.id)) {
			await this._rememberPrey(ranger, huntItem, prey);
			return;
		}
		if (this._canWrite(prey)) {
			try {
				await prey.createEmbeddedDocuments("Item", [this._markerData(ranger, huntItem)]);
			} catch (error) {
				console.error(`${Manager.id} | ranger hunt-prey marker create failed`, error);
				ui.notifications?.warn?.(
					Manager.localize("rangerHuntPrey.notify.failed", { name: prey?.name ?? "" })
				);
				return;
			}
			await this._rememberPrey(ranger, huntItem, prey);
			return;
		}
		const gm = game.users.find((u) => u.isGM && u.active);
		if (!gm) {
			ui.notifications?.warn?.(Manager.localize("rangerHuntPrey.notify.noGm", { name: prey?.name ?? "" }));
			return;
		}
		try {
			await this._requestGmApply(ranger, huntItem, prey);
			// The GM stores the prey link (it owns both sides); our copy
			// below is best-effort for the delete path when the GM's write
			// hasn't landed yet — harmless if overwritten.
			await this._rememberPrey(ranger, huntItem, prey);
		} catch (error) {
			console.error(`${Manager.id} | ranger hunt-prey GM-routed apply failed`, error);
		}
	}

	/** Best-effort prey link on the hunt effect (flag-only: skips our update hook). */
	static async _rememberPrey(ranger, huntItem, prey) {
		try {
			const flag = this._huntFlag(huntItem);
			if (flag?.preyActorUuid === prey?.uuid || !prey?.uuid) return;
			if (!this._canWrite(ranger)) return;
			const fresh = ranger?.items?.get?.(huntItem?.id) ?? null;
			if (!fresh) return;
			await fresh.update({ [`flags.${Manager.id}.${FLAG_KEY}`]: { ...flag, preyActorUuid: prey.uuid } });
		} catch (error) {
			console.warn(`${Manager.id} | ranger hunt-prey could not remember prey`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Removal path (hunt deleted -> marker out)   */
	/* -------------------------------------------- */

	static async _onHuntDeleted(huntDoc) {
		let rangerUuid = null;
		let ranger = null;
		try {
			ranger = huntDoc?.actor ?? null;
			rangerUuid = ranger?.uuid ?? huntDoc?.parent?.uuid ?? null;
		} catch {}
		if (!rangerUuid) return;
		// Resolve the prey from the deleted doc's own data (still present
		// on the deleted document) with the stored flag as backup.
		let prey = null;
		try {
			prey = await this._resolvePreyActor(huntDoc);
		} catch {}
		if (!prey) return;
		const mark = this._findMark(prey, rangerUuid, huntDoc?.id);
		if (!mark) return;
		// Single writer: the GM when one is connected (this hook fires on
		// every client, so the GM's client always sees the delete);
		// otherwise the prey actor's owner; otherwise warn the ranger's
		// owner once.
		try {
			if (game.user.isGM) {
				await mark.delete();
				return;
			}
			if (this._canWrite(prey)) {
				if (!game.users.some((u) => u.isGM && u.active)) await mark.delete();
				return;
			}
			const ownsRanger = (() => {
				try {
					const r = ranger ?? game.actors?.contents?.find((a) => a?.uuid === rangerUuid) ?? null;
					return r?.testUserPermission?.(game.user, "OWNER") === true;
				} catch {
					return false;
				}
			})();
			if (ownsRanger && !game.users.some((u) => u.isGM && u.active)) {
				ui.notifications?.warn?.(Manager.localize("rangerHuntPrey.notify.noGm", { name: prey?.name ?? "" }));
			}
		} catch (error) {
			// Double-delete races (GM + owner both electing) land here —
			// the marker is already gone, which is the desired end state.
			console.debug(`${Manager.id} | ranger hunt-prey marker delete skipped`, error?.message ?? error);
		}
	}

	/* -------------------------------------------- */
	/*  Death path (prey dead -> hunt out)          */
	/* -------------------------------------------- */

	static async _onPreyDead(preyActor) {
		const hunts = [];
		try {
			for (const actor of game.actors?.contents ?? []) {
				for (const item of actor?.items ?? []) {
					if (item?.type !== "effect" || item?.slug !== HUNT_PREY_SLUG) continue;
					let pointsHere = false;
					try {
						const flagUuid = this._huntFlag(item)?.preyActorUuid ?? null;
						if (flagUuid && flagUuid === preyActor?.uuid) pointsHere = true;
						if (!pointsHere) {
							const target = await this._resolveTargetToken(item);
							if (target?.actor?.uuid === preyActor?.uuid) pointsHere = true;
						}
					} catch {}
					if (pointsHere) hunts.push({ ranger: actor, hunt: item });
				}
			}
		} catch (error) {
			console.warn(`${Manager.id} | ranger hunt-prey death scan failed`, error);
			return;
		}
		for (const { ranger, hunt } of hunts) {
			try {
				await hunt.delete();
				console.info(`${Manager.id} | ranger hunt-prey removed from ${ranger?.name} (prey ${preyActor?.name} died)`);
			} catch (error) {
				console.warn(`${Manager.id} | ranger hunt-prey could not remove hunt from ${ranger?.name}`, error);
			}
		}
	}

	static async _onPreyActorDeleted(preyActorUuid) {
		try {
			for (const actor of game.actors?.contents ?? []) {
				for (const item of [...(actor?.items ?? [])]) {
					if (item?.type !== "effect" || item?.slug !== HUNT_PREY_SLUG) continue;
					if (this._huntFlag(item)?.preyActorUuid === preyActorUuid) {
						try {
							await item.delete();
						} catch (error) {
							console.warn(`${Manager.id} | ranger hunt-prey could not clean hunt on deleted prey`, error);
						}
					}
				}
			}
		} catch (error) {
			console.warn(`${Manager.id} | ranger hunt-prey actor-delete scan failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  GM socket (creation routing only)           */
	/* -------------------------------------------- */

	static _requestGmApply(ranger, huntItem, prey) {
		return new Promise((resolve, reject) => {
			const gm = game.users.find((u) => u.isGM && u.active);
			if (!gm) {
				reject(new Error("no GM connected"));
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pending.delete(requestId);
				reject(new Error("GM apply timed out"));
			}, GM_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, timer });
			game.socket.emit(
				SOCKET_EVENT,
				{
					action: SOCKET_ACTION_APPLY,
					requestId,
					rangerUuid: ranger?.uuid ?? null,
					huntItemId: huntItem?.id ?? null,
					preyActorUuid: prey?.uuid ?? null
				},
				{ recipients: [gm.id] }
			);
		});
	}

	static _requestGmDelete(ranger, huntItem, preyActorUuid) {
		// Retarget-path helper: ask the GM to drop one stale marker. The
		// delete path itself needs no socket (writer election in
		// _onHuntDeleted), but an in-place retarget never deletes the hunt,
		// so the unowned old marker would otherwise linger.
		return new Promise((resolve) => {
			const gm = game.users.find((u) => u.isGM && u.active);
			if (!gm) {
				resolve(false);
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pending.delete(requestId);
				resolve(false);
			}, GM_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, timer });
			game.socket.emit(
				SOCKET_EVENT,
				{
					action: SOCKET_ACTION_APPLY,
					requestId,
					rangerUuid: ranger?.uuid ?? null,
					huntItemId: huntItem?.id ?? null,
					preyActorUuid,
					deleteOnly: true
				},
				{ recipients: [gm.id] }
			);
		});
	}

	static _onSocket(data, senderId) {
		try {
			if (!data?.action) return;
			if (data.action === `${SOCKET_ACTION_APPLY}Result`) {
				const pending = this._pending.get(data?.requestId);
				if (!pending) return;
				try {
					clearTimeout(pending.timer);
				} catch {}
				this._pending.delete(data.requestId);
				try {
					pending.resolve(Boolean(data.done));
				} catch {}
				return;
			}
			if (data.action !== SOCKET_ACTION_APPLY) return;
			if (!game.user.isGM) return;
			this._handleGmApply(data, senderId).catch((error) =>
				console.error(`${Manager.id} | ranger hunt-prey GM apply failed`, error)
			);
		} catch (error) {
			console.error(`${Manager.id} | ranger hunt-prey socket failed`, error);
		}
	}

	static async _handleGmApply(data, senderId) {
		let done = false;
		try {
			const ranger = data?.rangerUuid ? await fromUuid(data.rangerUuid).catch(() => null) : null;
			const prey = data?.preyActorUuid ? await fromUuid(data.preyActorUuid).catch(() => null) : null;
			const hunt = ranger?.items?.get?.(data?.huntItemId) ?? null;
			if (ranger && prey && (hunt || data?.deleteOnly)) {
				const mark = this._findMark(prey, ranger.uuid, data.huntItemId);
				if (data?.deleteOnly) {
					if (mark) await mark.delete();
					done = true;
				} else if (mark) {
					done = true;
				} else {
					await prey.createEmbeddedDocuments("Item", [this._markerData(ranger, hunt)]);
					done = true;
				}
				if (hunt && done && !data?.deleteOnly) {
					try {
						const flag = this._huntFlag(hunt);
						if (flag?.preyActorUuid !== prey.uuid) {
							await hunt.update({
								[`flags.${Manager.id}.${FLAG_KEY}`]: { ...flag, preyActorUuid: prey.uuid }
							});
						}
					} catch {}
				}
			}
		} catch (error) {
			console.warn(`${Manager.id} | ranger hunt-prey GM could not place marker`, error);
		}
		try {
			game.socket.emit(
				SOCKET_EVENT,
				{ action: `${SOCKET_ACTION_APPLY}Result`, requestId: data?.requestId, done },
				{ recipients: [senderId] }
			);
		} catch {}
	}
}
