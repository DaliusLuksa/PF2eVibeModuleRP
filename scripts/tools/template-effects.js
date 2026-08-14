import { Manager } from "../core/manager.js";

const SYSTEM_ID = "pf2e";
const TOOLBELT_ID = "pf2e-toolbelt";
const MODULE_ROOT = "modules/pf2e-vibemodulerp";
const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_REQUEST = "applyEffectsRequest";
const SOCKET_ACTION_RESULT = "applyEffectsResult";
const GM_RESPONSE_TIMEOUT_MS = 20000;

export class TemplateEffectsTool {
	static id = "template-effects";
	static category = "template-effects";
	static enabledDefault = true;

	static settings = [
		{ key: "apply", type: Boolean, default: false, scope: "user" },
		{ key: "replaceToolbelt", type: Boolean, default: true, scope: "world", requiresReload: true }
	];

	/** Pending GM effect-apply requests, keyed by request id. */
	static _pendingGmRequests = new Map();

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		this._disableToolbeltHelper();
		Hooks.on("createRegion", this._onCreateRegion.bind(this));
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		console.debug(`${Manager.id} | hooks installed`);
	}

	static _disableToolbeltHelper() {
		if (!Manager.setting(this.id, "replaceToolbelt")) return;
		if (!game.modules.get(TOOLBELT_ID)?.active) return;
		try {
			if (game.settings.get(TOOLBELT_ID, "targetHelper.template") === true) {
				game.settings
					.set(TOOLBELT_ID, "targetHelper.template", false)
					.then(() => ui.notifications.warn(Manager.localize("notify.toolbeltDisabled")));
			}
		} catch (error) {
			console.warn(`${Manager.id} | could not inspect the pf2e-toolbelt template setting`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Region hook                                 */
	/* -------------------------------------------- */

	static async _onCreateRegion(region, data, userId) {
		const user = game.user;
		if (!user || user.id !== userId || !canvas.scene || !region.isEffectArea) return;
		const origin = region.flags[SYSTEM_ID]?.origin;
		const shapeCount = region.shapes?.length ?? region.shapes?.size ?? 0;
		if (!origin || shapeCount === 0) return;
		console.debug(`${Manager.id} | region created`, region.id, origin);

		const caster = origin.actor ? await fromUuid(origin.actor) : null;
		const casterToken = this._activeToken(caster);

		const result = await this._prompt(origin, casterToken);
		if (result === false) {
			try {
				if (region.rendered) await region.delete();
			} catch (error) {
				console.warn(`${Manager.id} | could not remove the template after cancel`, error);
			}
			return;
		}
		if (!result || result.targets === undefined) return;

		const targets = this._filterTargets(region, result, caster, casterToken);
		canvas.tokens.setTargets(targets.map((token) => token.id));

		if (typeof result.applyEffects === "boolean") {
			this._saveLastApplyEffects(result.applyEffects);
		}

		if (result.applyEffects && targets.length) {
			try {
				await this._applyEffects(origin, caster, targets);
			} catch (error) {
				console.error(`${Manager.id} | auto-apply failed`, error);
				ui.notifications.error(Manager.localize("notify.applyFailed"));
			}
		}

		try {
			const message = this._spellMessage(region);
			if (message) {
				await message.update({
					[`flags.${TOOLBELT_ID}.targetHelper.targets`]: targets.map((token) => token.uuid)
				});
			}
		} catch (error) {
			console.warn(`${Manager.id} | could not attach targets to the spell message`, error);
		}

		if (result.dismiss && region.rendered) {
			try {
				await region.delete();
			} catch (error) {
				console.warn(`${Manager.id} | could not remove the template`, error);
			}
		}
	}

	static async _prompt(origin, casterToken) {
		const noSelf = !casterToken;
		const content = await renderTemplate(`${MODULE_ROOT}/templates/template-effects/dialog.hbs`, {
			noSelf,
			applyEffects: this._lastApplyEffects(),
			i18n: (key) => Manager.localize(`dialog.${key}`)
		});
		return foundry.applications.api.DialogV2.wait({
			modal: true,
			classes: ["pf2e-vibemodulerp-template-helper"],
			buttons: [
				{
					action: "ok",
					label: Manager.localize("dialog.ok"),
					default: true,
					callback: (event, button, dialog) => this._readForm(dialog)
				},
				{
					action: "cancel",
					label: Manager.localize("dialog.cancel"),
					callback: () => false
				}
			],
			content,
			render: (event, dialog) => {
				const element = dialog.element;
				if (!element) return;
				element.querySelector("input[name='applyEffects']")?.addEventListener("change", (changeEvent) => {
					const checked = !!changeEvent.currentTarget.checked;
					this._saveLastApplyEffects(checked);
					console.debug(`${Manager.id} | Apply Effects preference -> ${checked}`);
				});
				requestAnimationFrame(() => element.querySelector("input")?.focus());
			},
			window: { title: origin.name ?? Manager.localize("dialog.title") }
		});
	}

	static _readForm(dialog) {
		const element = dialog?.element;
		if (!element) return null;
		const form = element instanceof HTMLFormElement ? element : element.querySelector("form");
		if (!form) return null;
		const extended = new foundry.applications.ux.FormDataExtended(form, {
			disabled: true,
			readonly: true
		});
		const data = {};
		for (const [key, value] of Object.entries(extended.object)) {
			data[key] = typeof value === "string" ? value.trim() : value;
		}
		return data;
	}

	static _filterTargets(region, result, caster, casterToken) {
		const party = caster?.alliance ?? (game.user.isGM ? "opposition" : "party");
		const enemies = party === "opposition" ? "party" : "opposition";
		return [...(region.tokens ?? [])].filter((token) => {
			if (!result.self && casterToken && token.id === casterToken.id) return false;
			if (!token.object || token.hidden) return false;
			const actor = token.actor;
			if (!actor?.isOfType("creature", "hazard", "vehicle") || actor.isDead) return false;
			const alliance = actor.alliance;
			if (alliance === null && !result.neutral) return false;
			if (result.targets === "allies" && alliance !== party) return false;
			if (result.targets === "enemies" && alliance !== enemies) return false;
			return true;
		});
	}

	/* -------------------------------------------- */
	/*  Helpers                                     */
	/* -------------------------------------------- */

	static _activeToken(caster) {
		if (!caster) return null;
		const placeable = canvas.tokens?.placeables?.find(
			(token) => token.document.actor?.id === caster.id
		);
		return placeable?.document ?? caster.token ?? null;
	}

	static _lastApplyEffects() {
		const stored = game.user?.getFlag(Manager.id, "template-effects.lastApplyEffects");
		if (typeof stored === "boolean") return stored;
		return Manager.setting(this.id, "apply") ?? false;
	}

	static _saveLastApplyEffects(value) {
		game.user
			?.setFlag(Manager.id, "template-effects.lastApplyEffects", !!value)
			.catch((error) => console.error(`${Manager.id} | could not save the apply preference`, error));
	}

	static _spellMessage(region) {
		const messageId = region.flags[SYSTEM_ID]?.messageId;
		return messageId ? game.messages.get(messageId) : null;
	}

	static _packScore(pack) {
		const id = `${pack.metadata?.package ?? ""}.${pack.metadata?.name ?? ""}`;
		return id.includes("spell-effect") ? 1 : 0;
	}

	static async _findEffectItem(effectName) {
		const packs = game.packs.filter((pack) => pack.documentName === "Item");
		packs.sort((a, b) => this._packScore(b) - this._packScore(a));
		for (const pack of packs) {
			let index;
			try {
				index = await pack.getIndex();
			} catch {
				continue;
			}
			const entry = index.find((document) => document.name === effectName);
			if (!entry) continue;
			try {
				const found = await pack.getDocument(entry._id);
				if (found) return found;
			} catch {
				continue;
			}
		}
		return null;
	}

	static async _applyEffects(origin, caster, targets) {
		const itemUuid = origin.uuid ?? origin.item;
		if (!itemUuid) return;
		let item;
		try {
			item = await fromUuid(itemUuid);
		} catch {
			return;
		}
		if (!item) return;

		const effectName = `Spell Effect: ${item.name}`;
		const found = await this._findEffectItem(effectName);
		if (!found) {
			ui.notifications.warn(Manager.localize("autoApply.notFound", { name: effectName }));
			return;
		}

		// Creating an item inside an actor requires OWNER permission on that actor
		// (core item #canCreate: embedded items test OWNER on the parent). A player
		// may own some targets but not others, so split them: actors we own are
		// created directly, the rest are created by a connected GM over the module
		// socket (GMs have universal ownership).
		const originData = item.getOriginData?.() ?? {};
		const owned = [];
		const unowned = [];
		for (const token of targets) {
			const actor = token.actor;
			if (!actor?.isOfType("creature") || actor.items.some((entry) => entry.name === effectName)) {
				continue;
			}
			const source = foundry.utils.mergeObject(found.toObject(), {
				_id: null,
				system: {
					context: {
						origin: {
							actor: caster?.uuid ?? origin.actor ?? null,
							token: null,
							item: item.uuid,
							spellcasting: originData.spellcasting ?? null,
							rollOptions: origin.rollOptions ?? originData.rollOptions ?? []
						},
						target: { actor: actor.uuid, token: token.uuid ?? null },
						roll: null
					}
				}
			});
			if (actor.testUserPermission(game.user, "OWNER")) {
				owned.push({ actor, source });
			} else {
				unowned.push({ actor, source });
			}
		}

		// Apply directly to actors we own.
		let directApplied = 0;
		let directFailed = 0;
		if (owned.length) {
			const results = await Promise.allSettled(
				owned.map(({ actor, source }) => actor.createEmbeddedDocuments("Item", [source]))
			);
			directApplied = results.filter((result) => result.status === "fulfilled").length;
			directFailed = owned.length - directApplied;
			for (const result of results) {
				if (result.status === "rejected") {
					console.warn(`${Manager.id} | could not apply "${effectName}" directly`, result.reason);
				}
			}
		}

		// Ask a connected GM to apply to actors we don't own.
		let gmApplied = 0;
		let gmFailed = 0;
		let noGm = false;
		if (unowned.length) {
			const gmResult = await this._requestGmEffects(unowned);
			noGm = !!gmResult.noGm;
			gmApplied = gmResult.applied ?? 0;
			gmFailed = noGm ? unowned.length : (gmResult.failed ?? 0);
		}

		const applied = directApplied + gmApplied;
		const failed = directFailed + gmFailed;

		if (noGm) {
			ui.notifications.error(Manager.localize("autoApply.noGm", { name: found.name, count: unowned.length }));
		} else if (failed > 0) {
			ui.notifications.error(Manager.localize("autoApply.failed", { name: found.name, count: failed }));
		}
		if (applied > 0) {
			if (gmApplied > 0) {
				ui.notifications.info(
					Manager.localize("autoApply.gmApplied", { name: found.name, count: applied, gm: gmApplied })
				);
			} else {
				ui.notifications.info(
					Manager.localize("autoApply.applied", { name: found.name, count: applied })
				);
			}
		}
		console.debug(
			`${Manager.id} | applied "${found.name}" to ${applied} target(s) (${gmApplied} via GM, ${failed} failed)`
		);
	}

	/* -------------------------------------------- */
	/*  GM routing via module socket                */
	/* -------------------------------------------- */

	static _onSocketMessage(data, userId) {
		try {
			if (!data?.action) return;
			if (data.action === SOCKET_ACTION_REQUEST) {
				if (!game.user.isGM) return;
				this._handleGmEffectsRequest(data, userId).catch((error) =>
					console.error(`${Manager.id} | GM effect request failed`, error)
				);
			} else if (data.action === SOCKET_ACTION_RESULT) {
				this._handleGmEffectsResult(data);
			}
		} catch (error) {
			console.error(`${Manager.id} | template-effects socket handler failed`, error);
		}
	}

	/**
	 * Ask the first connected GM to create the given effect sources on actors the
	 * requesting user does not own. Resolves once the GM replies or times out.
	 */
	static _requestGmEffects(items) {
		return new Promise((resolve) => {
			const gm = game.users.find((user) => user.isGM && user.active);
			if (!gm) {
				resolve({ applied: 0, failed: items.length, noGm: true });
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve({ applied: 0, failed: items.length, timeout: true });
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer });
			// Send only plain serializable data (Document objects do not survive the socket).
			const payload = items.map(({ actor, source }) => ({ actorUuid: actor.uuid, source }));
			game.socket.emit(
				SOCKET_EVENT,
				{ action: SOCKET_ACTION_REQUEST, requestId, items: payload },
				{ recipients: [gm.id] }
			);
		});
	}

	/**
	 * GM-only: create the requested effect items (GMs have universal ownership,
	 * so the server accepts these) and report the outcome back to the requester.
	 */
	static async _handleGmEffectsRequest(data, userId) {
		const { requestId, items } = data;
		if (!requestId || !Array.isArray(items) || !items.length) return;
		let applied = 0;
		let failed = 0;
		for (const entry of items) {
			try {
				const actor = entry?.actorUuid ? await fromUuid(entry.actorUuid) : null;
				if (!actor || !entry?.source) {
					failed++;
					continue;
				}
				await actor.createEmbeddedDocuments("Item", [entry.source]);
				applied++;
			} catch (error) {
				failed++;
				console.warn(`${Manager.id} | GM could not apply the effect to ${entry?.actorUuid}`, error);
			}
		}
		game.socket.emit(
			SOCKET_EVENT,
			{ action: SOCKET_ACTION_RESULT, requestId, applied, failed },
			{ recipients: [userId] }
		);
	}

	/**
	 * Resolve a pending request when the GM reports back.
	 */
	static _handleGmEffectsResult(data) {
		const pending = this._pendingGmRequests.get(data?.requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this._pendingGmRequests.delete(data.requestId);
		pending.resolve({ applied: data.applied ?? 0, failed: data.failed ?? 0 });
	}
}