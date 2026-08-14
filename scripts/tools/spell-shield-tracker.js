import { Manager } from "../core/manager.js";

const SYSTEM_ID = "pf2e";
const SHIELD_FLAG = "shield.hp";

function clamp(value, min, max) {
	return Math.max(Math.min(value, max), min);
}

export class SpellShieldTrackerTool {
	static id = "spell-shield-tracker";
	static category = "spell-shield";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		if (!globalThis.libWrapper) {
			console.warn(`${Manager.id} | libWrapper not found; spell shield tracker will not run`);
			return;
		}
		this._registerLibWrappers();
		Hooks.on("createChatMessage", this._onCreateChatMessage.bind(this));
		console.debug(`${Manager.id} | spell-shield-tracker hooks installed`);
	}

	static _registerLibWrappers() {
		libWrapper.register(
			Manager.id,
			"CONFIG.Actor.documentClass.prototype.prepareDerivedData",
			function wrappedPrepareDerivedData(wrapped, ...args) {
				const result = wrapped(...args);
				SpellShieldTrackerTool._syncShieldHp(this);
				return result;
			},
			"WRAPPER"
		);
		libWrapper.register(
			Manager.id,
			"CONFIG.Actor.documentClass.prototype.undoDamage",
			async function wrappedUndoDamage(wrapped, ...args) {
				await wrapped(...args);
				await SpellShieldTrackerTool._restoreShieldHp(this, args[0]);
			},
			"WRAPPER"
		);
	}

	/* -------------------------------------------- */
	/*  Shield gate                                 */
	/* -------------------------------------------- */

	static _findShieldEffect(actor) {
		let fallback = null;
		for (const effect of actor.itemTypes.effect) {
			for (const rule of effect.system?.rules ?? []) {
				if (rule.key !== "ActiveEffectLike" || typeof rule.path !== "string") continue;
				if (rule.path === "system.attributes.shield") return effect;
				if (rule.path.startsWith("system.attributes.shield.") && rule.path !== "system.attributes.shield.raised") {
					fallback ??= effect;
				}
			}
		}
		return fallback;
	}

	static _shieldActor(actor) {
		if (!actor?.isOfType?.("character", "npc")) return null;
		const shield = actor.system.attributes?.shield;
		if (!shield || !(shield.hp?.max > 0)) return null;
		if (this._isPhysicalShield(actor, shield)) return null;
		const effect = this._findShieldEffect(actor);
		if (!effect) return null;
		return { actor, shield, effect };
	}

	static _isPhysicalShield(actor, shield) {
		if (!shield.itemId) return false;
		const item = actor.items.get(shield.itemId);
		return item?.type === "shield";
	}

	/* -------------------------------------------- */
	/*  Prep bridge                                 */
	/* -------------------------------------------- */

	static _syncShieldHp(actor) {
		try {
			const v = this._shieldActor(actor);
			if (!v) return;
			const stored = v.effect.getFlag(Manager.id, SHIELD_FLAG);
			if (typeof stored !== "number" || Number.isNaN(stored)) return;
			const max = v.shield.hp.max;
			const hp = clamp(stored, 0, max);
			v.shield.hp.value = hp;
			v.shield.broken = hp > 0 && v.shield.brokenThreshold > 0 && hp <= v.shield.brokenThreshold;
			v.shield.destroyed = hp <= 0;
		} catch (error) {
			console.error(`${Manager.id} | spell-shield-tracker prep bridge failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Damage hook                                 */
	/* -------------------------------------------- */

	static async _onCreateChatMessage(message) {
		try {
			if (game.system.id !== SYSTEM_ID) return;
			if (message.author?.id !== game.user.id) return;

			const appliedDamage = message.flags?.pf2e?.appliedDamage;
			const shieldDamage = appliedDamage?.shield?.damage;
			if (!shieldDamage || shieldDamage <= 0) return;

			const actor = await fromUuid(appliedDamage.uuid);
			const v = this._shieldActor(actor);
			if (!v) return;

			let current = v.effect.getFlag(Manager.id, SHIELD_FLAG);
			if (typeof current !== "number" || Number.isNaN(current)) {
				current = v.shield.hp.value ?? 0;
			}

			const next = Math.max(current - shieldDamage, 0);
			if (next <= 0) {
				await v.effect.delete();
				ui.notifications.info(
					Manager.localize("spellShield.notify.destroyed", { actor: actor.name, shield: v.shield.name })
				);
			} else {
				await v.effect.setFlag(Manager.id, SHIELD_FLAG, next);
			}
		} catch (error) {
			console.error(`${Manager.id} | spell-shield-tracker damage hook failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Undo hook                                   */
	/* -------------------------------------------- */

	static async _restoreShieldHp(actor, appliedDamage) {
		try {
			const shieldDamage = appliedDamage?.shield?.damage;
			if (!shieldDamage || shieldDamage <= 0) return;
			const v = this._shieldActor(actor);
			if (!v) return;
			let current = v.effect.getFlag(Manager.id, SHIELD_FLAG);
			if (typeof current !== "number" || Number.isNaN(current)) {
				current = v.shield.hp.value ?? 0;
			}
			const next = clamp(current + shieldDamage, 0, v.shield.hp.max);
			await v.effect.setFlag(Manager.id, SHIELD_FLAG, next);
		} catch (error) {
			console.error(`${Manager.id} | spell-shield-tracker undo hook failed`, error);
		}
	}
}