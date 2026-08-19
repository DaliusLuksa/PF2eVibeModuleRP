import { Manager } from "../core/manager.js";

const SYSTEM_ID = "pf2e";
const AA_MODULE_ID = "autoanimations";
const EFFECT_NAME_PREFIX = "Spell Effect: ";
const SYSTEM_SPELLS_PACK = "pf2e.spells-srd";

/**
 * Plays an Automated Animations sequence when a "Spell Effect: <spell>" item is
 * applied to an actor (dragged from the chat card or a compendium, or
 * auto-applied by the module's own tools).
 *
 * Which spells animate is deliberate:
 * - Damaging spells are skipped - AA already plays them on the damage roll.
 * - Spells with their own AA menu entry are skipped - AA already plays them on
 *   cast.
 * - Everything else (non-damaging, menu-less spells like Leaden Steps) plays
 *   by feeding the spell's description through AA's own substring matcher -
 *   the same behavior the (now disabled) AAFA module used to provide, e.g.
 *   Leaden Steps' description matching AA's "Slow" entry.
 *
 * Only the client that created the effect triggers the animation; AA/Sequencer
 * broadcast it to everyone. Effects without a caster (no
 * `system.context.origin.actor`) or with a caster that has no token on the
 * scene are skipped.
 */
export class EffectAnimationTool {
	static id = "effect-animation";
	static category = "effect-animation";
	static enabledDefault = true;

	/** spell name -> spell Item (lazily resolved, only definitive results cached). */
	static _spellCache = new Map();

	static ready() {
		if (game.modules.get(AA_MODULE_ID)?.active && !globalThis.AutomatedAnimations?.playAnimation) {
			console.warn(
				`${Manager.id} | Automated Animations is active but its playAnimation API is missing; effect animations will not play`
			);
		}
		Hooks.on("createItem", this._onCreateItem.bind(this));
		console.debug(`${Manager.id} | effect-animation hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Trigger                                     */
	/* -------------------------------------------- */

	static async _onCreateItem(item, options, userId) {
		try {
			if (game.system.id !== SYSTEM_ID) return;
			// v14 fires `createItem` as (doc, options, userId) on EVERY client;
			// only the client that requested the creation may trigger the animation
			// (AA/Sequencer then broadcast it to everyone).
			if (userId !== game.user.id) return;
			if (item.type !== "effect") return;
			const spellName = this._spellNameFromEffect(item.name);
			if (!spellName) return;
			const spell = await this._lookupSpell(spellName);
			if (!spell) return;
			if (!this._shouldPlay(spell)) return;

			const casterToken = this._casterToken(item);
			if (!casterToken) return;
			const targetTokens = this._activeTokens(item.parent);
			if (targetTokens.length === 0) return;

			const description = this._plainText(spell.system?.description?.value ?? "");
			if (!description) return;

			await globalThis.AutomatedAnimations.playAnimation(
				casterToken,
				{ name: description },
				{ targets: targetTokens }
			);
			console.debug(
				`${Manager.id} | played AA animation for "${spell.name}" via effect "${item.name}"`,
				{ target: item.parent?.uuid, tokens: targetTokens.length }
			);
		} catch (error) {
			console.warn(`${Manager.id} | effect-animation failed for "${item?.name}"`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Skip logic                                  */
	/* -------------------------------------------- */

	/** Whether AA should animate this spell at effect-apply time. */
	static _shouldPlay(spell) {
		if (!globalThis.AutomatedAnimations?.playAnimation) return false;
		if (this._hasDamage(spell)) return false;
		if (this._hasAaEntry(spell.name)) return false;
		return true;
	}

	/** Mirrors AA's `itemHasDamage` (spell damage present). */
	static _hasDamage(spell) {
		const damage = spell.system?.damage?.value ?? spell.system?.damage ?? spell.system?.damageRolls ?? {};
		return Object.keys(damage).length > 0;
	}

	/**
	 * Whether the spell name already matches an entry in AA's automatic
	 * recognition menus (in which case AA animates the cast itself). Mirrors
	 * AA's own `allMenuSearch`: exact label match first, then a substring
	 * match on the whitespace-stripped, lowercased names.
	 */
	static _hasAaEntry(spellName) {
		try {
			const menus = globalThis.AutomatedAnimations?.AutorecManager?.getAutorecEntries?.();
			if (!menus) return false;
			const rinsed = this._rinse(spellName);
			const combined = [];
			for (const key of ["melee", "range", "ontoken", "templatefx", "aura", "preset", "aefx"]) {
				if (Array.isArray(menus[key])) combined.push(...menus[key]);
			}
			combined.sort(
				(a, b) =>
					String(b.label ?? "").replace(/\s+/g, "").length -
					String(a.label ?? "").replace(/\s+/g, "").length
			);
			const exact = combined.find((entry) => entry.label && entry.label === spellName);
			if (exact) return true;
			return combined.some((entry) => {
				if (!entry.label || entry.advanced?.exactMatch) return false;
				const label = this._rinse(entry.label);
				if (!rinsed.includes(label)) return false;
				const excluded = entry.advanced?.excludedTerms ?? [];
				return !excluded.some((term) => rinsed.includes(this._rinse(term)));
			});
		} catch (error) {
			console.warn(`${Manager.id} | could not check AA menus for "${spellName}"`, error);
			return false;
		}
	}

	/* -------------------------------------------- */
	/*  Token resolution                            */
	/* -------------------------------------------- */

	/** The caster's first token on the current scene, or null. */
	static _casterToken(item) {
		const originUuid = item.system?.context?.origin?.actor;
		if (!originUuid) return null;
		const resolved = fromUuidSync(originUuid);
		const caster = resolved?.actor ?? resolved;
		if (!caster) return null;
		return this._activeTokens(caster)[0] ?? null;
	}

	/** The Token placeables for an actor that are on the current scene.
	 *  `linked=false` because most PF2e map tokens are unlinked (getActiveTokens
	 *  filters out non-actorLink tokens when `linked` is true). */
	static _activeTokens(actor) {
		if (!actor?.getActiveTokens) return [];
		try {
			return actor.getActiveTokens(false, false);
		} catch {
			return [];
		}
	}

	/* -------------------------------------------- */
	/*  Spell lookup                                */
	/* -------------------------------------------- */

	/**
	 * Resolve the spell behind an effect name, lazily per name and cached only
	 * on definitive results (a found document, or a clean miss in both the
	 * system pack and the world Items directory).
	 */
	static async _lookupSpell(spellName) {
		if (this._spellCache.has(spellName)) return this._spellCache.get(spellName);
		let spell = null;
		let definitive = false;
		try {
			const pack = game.packs.get(SYSTEM_SPELLS_PACK);
			if (pack) {
				const index = await pack.getIndex();
				const entry = index.find((e) => e.type === "spell" && e.name === spellName);
				if (entry) {
					spell = await pack.getDocument(entry._id);
					definitive = true;
				} else {
					definitive = true;
				}
			}
			if (!spell) {
				const worldSpell = game.items?.find((i) => i.type === "spell" && i.name === spellName);
				if (worldSpell) {
					spell = worldSpell;
					definitive = true;
				}
			}
		} catch (error) {
			// Do NOT cache failures - a transient error must not poison the lookup.
			console.warn(`${Manager.id} | could not look up spell "${spellName}"`, error);
			return null;
		}
		if (definitive) this._spellCache.set(spellName, spell);
		return spell;
	}

	/* -------------------------------------------- */
	/*  Helpers                                     */
	/* -------------------------------------------- */

	/** Effect name -> spell name, or null. Strips save-degree suffixes. */
	static _spellNameFromEffect(name) {
		if (typeof name !== "string" || !name.startsWith(EFFECT_NAME_PREFIX)) return null;
		let spellName = name.slice(EFFECT_NAME_PREFIX.length);
		const stripped = spellName.replace(/\s*\([^)]*\)\s*$/, "");
		if (stripped && stripped !== spellName) spellName = stripped;
		return spellName.trim() || null;
	}

	/** HTML -> plain text (tags removed, whitespace collapsed). */
	static _plainText(html) {
		return html
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	/** Mirrors AA's `rinseName`: strip all whitespace, lowercase. */
	static _rinse(name) {
		return String(name).replace(/\s+/g, "").toLowerCase();
	}
}
