import { Manager } from "../core/manager.js";

/**
 * Trait Propagation — makes spell-effect Items carry their origin Item's traits.
 *
 * Many `spell-effects` compendium entries (e.g. Courageous Anthem
 * `Compendium.pf2e.spell-effects.Item.beReeFroAx24hj83`) have
 * `system.traits.value=[]` while the spell itself carries
 * `["bard","cantrip","composition","concentrate","emotion","mental"]`.
 * The system's `Actor#createEmbeddedDocuments` immunity gate
 * (`pf2e.mjs:44706` `isImmuneTo` via `item:trait:mental`) only checks the
 * *effect* rollOptions, so a mindless target (`isImmuneTo mental`
 * via `pf2e.mjs:14012`) is not blocked. The same applies to other
 * trait-based immunities.
 *
 * This tool wraps `Actor#createEmbeddedDocuments` once at `init` and,
 * for every `effect`/`condition`/`affliction` about to be created,
 * merges `system.traits` from the origin Item (resolved from
 * `system.context.origin.item` / `flags.pf2e.origin` / origin rollOptions)
 * into the effect before delegating to the original method. The system's
 * own immunity notification then fires correctly.
 */
export class TraitPropagationTool {
	static id = "trait-propagation";
	static category = "fixes";
	static enabledDefault = true;

	static _wrapped = false;
	static _originalCreate = null;

	static init() {
		if (this._wrapped) return;
		this._wrapped = true;

		const patch = (cls, label) => {
			if (!cls || !cls.prototype || cls.prototype._vibeTraitWrapped) return false;
			const orig = cls.prototype.createEmbeddedDocuments;
			if (typeof orig !== "function") return false;
			this._originalCreate = orig;
			const tool = this;
			cls.prototype.createEmbeddedDocuments = async function (embeddedName, dataArray, ...rest) {
				if (embeddedName !== "Item" || !Array.isArray(dataArray) || !dataArray.length || !Manager.isEnabled(tool.id)) {
					return orig.call(this, embeddedName, dataArray, ...rest);
				}
				if (!this || typeof this.isOfType !== "function") {
					return orig.call(this, embeddedName, dataArray, ...rest);
				}
				const patched = [];
				for (const src of dataArray) {
					const data = src instanceof foundry.documents.BaseItem ? src.toObject() : foundry.utils.deepClone(src);
					if (!["effect", "condition", "affliction"].includes(data.type)) {
						patched.push(src);
						continue;
					}
					try {
						const before = Array.isArray(data.system?.traits?.value) ? [...data.system.traits.value] : [];
						await tool._propagateTraits(data);
						const after = data.system?.traits?.value ?? [];
						if (before.length !== after.length || before.some((v, i) => v !== after[i])) {
							console.debug(`${Manager.id} | trait-propagation ${data.name} ${before.join(",")} -> ${after.join(",")} on ${this.name}`);
						}
					} catch (e) {
						console.warn(`${Manager.id} | trait-propagation failed for ${data.name}`, e);
					}
					patched.push(data);
				}
				return orig.call(this, embeddedName, patched, ...rest);
			};
			cls.prototype._vibeTraitWrapped = true;
			console.debug(`${Manager.id} | trait-propagation patched ${label}`);
			return true;
		};

		// Patch as many entry points as possible; Foundry init order varies.
		let _didPatchCreate = false;
		const tryPatchAll = () => {
			let patched = false;
			try { patched = patch(CONFIG?.Actor?.documentClass, "CONFIG.Actor.documentClass") || patched; } catch {}
			try { patched = patch(foundry?.documents?.Actor, "foundry.documents.Actor") || patched; } catch {}
			try { patched = patch(globalThis.Actor, "globalThis.Actor") || patched; } catch {}
			try { patched = patch(game?.actors?.documentClass, "game.actors.documentClass") || patched; } catch {}
			// pf2e specific
			try { patched = patch(CONFIG?.PF2E?.Actor?.documentClasses?.character, "PF2E character") || patched; } catch {}
			try { patched = patch(CONFIG?.PF2E?.Actor?.documentClasses?.npc, "PF2E npc") || patched; } catch {}
			if (patched) _didPatchCreate = true;
			return patched;
		};
		tryPatchAll();
		Hooks.once("ready", () => {
			const ok = tryPatchAll();
			if (!_didPatchCreate && !ok) {
				console.warn(`${Manager.id} | trait-propagation could not patch any Actor class`, {
					CONFIG: !!CONFIG?.Actor?.documentClass,
					foundry: !!foundry?.documents?.Actor,
					gameActors: !!game?.actors?.documentClass,
				});
			}
			tryPatchImmunity();
		});
		// Also patch immunity check directly — this handles cases where trait propagation
		// would add invalid choices (e.g. bard, cantrip) and be stripped by validation.
		let _didPatchImmune = false;
		const tryPatchImmunity = () => {
			const patchImmunity = (cls, label) => {
				if (!cls || !cls.prototype || cls.prototype._vibeImmunePatched) return false;
				const orig = cls.prototype.isImmuneTo;
				if (typeof orig !== "function") return false;
				const tool = this;
				cls.prototype.isImmuneTo = function (e) {
					if (orig.call(this, e)) return true;
					if (!Manager.isEnabled(tool.id)) return false;
					if (typeof e === "string") return false;
					try {
						if (!e || !e.system || !["effect", "condition", "affliction"].includes(e.type)) return false;
						const originTraits = tool._getOriginTraitsForItem(e);
						if (!originTraits || !originTraits.length) return false;
						for (const trait of originTraits) {
							const testOptions = new Set([`item:trait:${trait}`, `item:slug:${e.slug ?? e.system?.slug ?? ""}`, `item:type:${e.type}`]);
							if (this.attributes?.immunities?.some((imm) => {
								try { return imm.test(testOptions); } catch { return imm.type === trait; }
							})) return true;
						}
					} catch (err) {
						console.warn(`${Manager.id} | isImmuneTo patch failed`, err);
					}
					return false;
				};
				cls.prototype._vibeImmunePatched = true;
				console.debug(`${Manager.id} | trait-propagation patched isImmuneTo on ${label}`);
				return true;
			};
			let ok = false;
			try { ok = patchImmunity(CONFIG?.Actor?.documentClass, "CONFIG.Actor.documentClass") || ok; } catch {}
			try { ok = patchImmunity(foundry?.documents?.Actor, "foundry.documents.Actor") || ok; } catch {}
			try { ok = patchImmunity(globalThis.Actor, "globalThis.Actor") || ok; } catch {}
			try { ok = patchImmunity(game?.actors?.documentClass, "game.actors.documentClass") || ok; } catch {}
			if (ok) _didPatchImmune = true;
			return ok;
		};
		tryPatchImmunity();
		Hooks.once("ready", () => {
			if (!_didPatchImmune) tryPatchImmunity();
		});

		// Fallback: also hook preCreateItem for embedded Items that bypass createEmbeddedDocuments (direct Item creation)
		Hooks.on("preCreateItem", (item, data, options, userId) => {
			if (!Manager.isEnabled(this.id)) return;
			if (item?.parent?.documentName !== "Actor") return;
			if (!["effect", "condition", "affliction"].includes(data.type)) return;
			try {
				// Sync path only - use rollOptions from data; filter to valid effect traits
				const traits = data.system?.traits;
				if (!traits || !Array.isArray(traits.value)) return;
				const ctx = data.system?.context?.origin ?? data.flags?.pf2e?.origin;
				const rollOptions = ctx?.rollOptions ?? data.system?.context?.origin?.rollOptions ?? [];
				const extra = TraitPropagationTool._traitsFromRollOptions(rollOptions);
				if (extra?.value?.length) {
					const filtered = extra.value.filter((t) => TraitPropagationTool._isValidEffectTrait(t));
					const merged = [...new Set([...traits.value, ...filtered])];
					if (merged.length !== traits.value.length) {
						console.debug(`${Manager.id} | trait-propagation preCreateItem ${data.name} ${traits.value.join(",")} -> ${merged.join(",")}`);
						traits.value = merged;
						item.updateSource({ "system.traits.value": merged });
					}
				}
			} catch (e) {
				console.warn(`${Manager.id} | preCreateItem trait propagation failed`, e);
			}
		});
	}

	/** Merge origin Item traits into the effect data object (mutates data). */
	static async _propagateTraits(effectData) {
		const traits = effectData.system?.traits;
		if (!traits) return;

		const originInfo = this._resolveOrigin(effectData);
		if (!originInfo) return;

		let originDoc = null;
		// Try sync first, then async
		try {
			if (originInfo.uuid) {
				originDoc = foundry.utils.fromUuidSync(originInfo.uuid);
				if (!originDoc) originDoc = await foundry.utils.fromUuid(originInfo.uuid).catch(() => null);
			}
		} catch {}

		let originTraits = null;
		if (originDoc?.system?.traits) {
			originTraits = originDoc.system.traits;
		} else if (originInfo.rollOptions?.length) {
			// Fallback: origin rollOptions like origin:item:trait:mental from Bard Helper
			originTraits = this._traitsFromRollOptions(originInfo.rollOptions);
		} else if (originInfo.traits) {
			originTraits = originInfo.traits;
		}
		if (!originTraits) return;

		// Merge value (dedup), filtered to valid effect traits to avoid DataModel validation failures
		const effectValue = Array.isArray(traits.value) ? traits.value : [];
		const originValue = Array.isArray(originTraits.value) ? originTraits.value.filter((t) => this._isValidEffectTrait(t)) : [];
		if (originValue.length) {
			const merged = [...new Set([...effectValue, ...originValue])];
			traits.value = merged;
		}

		// Merge rarity if effect has none / common default and origin has specific
		if (originTraits.rarity && (!traits.rarity || traits.rarity === "common")) {
			// Keep effect's rarity if it's not common, else take origin's
			if (!traits.rarity || traits.rarity === "common") traits.rarity = originTraits.rarity;
		}
		if (Array.isArray(originTraits.traditions) && originTraits.traditions.length) {
			const effTrad = Array.isArray(traits.traditions) ? traits.traditions : [];
			traits.traditions = [...new Set([...effTrad, ...originTraits.traditions])];
		}
		if (Array.isArray(originTraits.otherTags) && originTraits.otherTags.length) {
			const effOther = Array.isArray(traits.otherTags) ? traits.otherTags : [];
			traits.otherTags = [...new Set([...effOther, ...originTraits.otherTags])];
		}
		// Also copy any otherTags from origin that may be relevant
	}

	static _resolveOrigin(effectData) {
		const sys = effectData.system;
		const flags = effectData.flags ?? {};

		// 1) Bard Helper / Template Effects / PAE style: system.context.origin
		const ctxOrigin = sys?.context?.origin;
		if (ctxOrigin) {
			// May have actor/item uuids and rollOptions
			if (ctxOrigin.item) return { uuid: ctxOrigin.item, rollOptions: ctxOrigin.rollOptions ?? [] };
			if (ctxOrigin.actor && ctxOrigin.rollOptions?.length) {
				// RollOptions contain origin:item:trait:* even when item is null
				return { uuid: null, rollOptions: ctxOrigin.rollOptions, traits: this._traitsFromRollOptions(ctxOrigin.rollOptions) };
			}
			if (Array.isArray(ctxOrigin.rollOptions) && ctxOrigin.rollOptions.length) {
				return { uuid: ctxOrigin.item ?? null, rollOptions: ctxOrigin.rollOptions };
			}
		}

		// 2) flags.pf2e.origin (pf2e drag data)
		const pf2eOrigin = flags.pf2e?.origin ?? effectData.flags?.pf2e?.origin;
		if (pf2eOrigin?.uuid) return { uuid: pf2eOrigin.uuid, rollOptions: pf2eOrigin.rollOptions ?? [] };

		// 3) Check context.origin.item null but rollOptions carries traits (Bard Helper stamped effects have item:null)
		if (ctxOrigin?.rollOptions?.some((r) => r.includes("origin:item:trait:"))) {
			return { uuid: null, rollOptions: ctxOrigin.rollOptions };
		}

		return null;
	}

	static _isValidEffectTrait(trait) {
		// Effect traits that are not valid choices cause DataModelValidationFailure
		// Observed invalid: bard, cantrip, composition, concentrate, area-effect, occult, etc.
		// Keep only traits that are valid for an Item of type effect.
		const invalid = new Set(["bard", "cantrip", "composition", "concentrate", "area-effect", "occult", "arcane", "divine", "primal", "focus", "rank", "magical"]);
		if (invalid.has(trait)) return false;
		// Also try to check against the DataModel's allowed choices if available
		try {
			const choices = this._validEffectChoices ??= (() => {
				try {
					// Try to get choices from the Item system model
					const model = foundry.documents.Item?.getSystemModel?.("effect") ?? game.pf2e?.Item?.getSystemModel?.("effect");
					const field = model?.schema?.fields?.traits?.fields?.value;
					if (field?.choices) return new Set(field.choices);
					if (field?.options?.choices) return new Set(field.options.choices);
				} catch {}
				return null;
			})();
			if (choices && !choices.has(trait)) return false;
		} catch {}
		return true;
	}

	static _getOriginTraitsForItem(item) {
		const ro = item.system?.context?.origin?.rollOptions ?? item.flags?.pf2e?.origin?.rollOptions ?? [];
		if (!ro || !ro.length) return null;
		const traits = [];
		for (const o of ro) {
			const m = o.match(/^origin:item:trait:(.+)$/);
			if (m) traits.push(m[1]);
			else if (o && !o.includes(":") && /^[a-z-]+$/.test(o)) traits.push(o);
		}
		return traits.length ? [...new Set(traits)] : null;
	}

	static _traitsFromRollOptions(rollOptions) {
		const value = [];
		const bareTraitPattern = /^[a-z-]+$/;
		for (const ro of rollOptions) {
			let m = ro.match(/^origin:item:trait:(.+)$/);
			if (m) { if (this._isValidEffectTrait(m[1])) value.push(m[1]); continue; }
			if (ro && !ro.includes(":") && bareTraitPattern.test(ro)) {
				if (this._isValidEffectTrait(ro)) value.push(ro);
			}
		}
		if (!value.length) return null;
		return { value: [...new Set(value)], rarity: undefined, traditions: [], otherTags: [] };
	}
}
