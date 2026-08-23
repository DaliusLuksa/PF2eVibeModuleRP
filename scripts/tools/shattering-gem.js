const MODULE_ID = "pf2e-vibemodulerp";
const SYSTEM_ID = "pf2e";
const SPELL_NAME = "Shattering Gem";

/* Quick link to the module's Shattering Gem spell effect. The original system
   effect link uses the CURRENT pack name (`spells-srd`); display text is always
   included so links never show "Unknown". */
const EFFECT_LINK = `<p>@UUID[Compendium.pf2e-vibemodulerp.shattering-gem-effect.Item.ShatterGemFx0001]{Spell Effect: Shattering Gem}</p>`;

export class ShatteringGemTool {
	static id = "shattering-gem";
	static category = "spell-effects";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		this._patchExistingSpells();
		Hooks.on("preCreateItem", this._onPreCreateItem.bind(this));
		console.debug(`${MODULE_ID} | shattering-gem hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Description transformation                  */
	/* -------------------------------------------- */

	/** Remove every module Shattering Gem effect link paragraph (with or without
	 *  display text), so a re-run is idempotent and never stacks duplicates. The
	 *  `\n?` on each side also absorbs the newline the inserter adds, keeping the
	 *  output byte-stable. */
	static _stripExistingLinks(description) {
		return description.replace(
			/\n?<p>@UUID\[Compendium\.pf2e-vibemodulerp\.shattering-gem-effect\.Item\.[^\]]*\](?:\{[^}]*\})?<\/p>\n?/g,
			""
		);
	}

	/** Insert the link paragraph just before the Heightened block - after the
	 *  description and before the `<hr>` divider when one separates the two
	 *  (keeping the divider glued to the Heightened section it introduces),
	 *  directly before the `<p><strong>Heightened ...` paragraph otherwise, or
	 *  appended at the end as a last resort. Matches every hr serialization
	 *  (`<hr>`, `<hr/>`, `<hr />`) because Foundry's editor normalizes HTML. */
	static _transformDescription(description) {
		const next = this._stripExistingLinks(description);
		const heightened = next.match(/<p><strong>Heightened[^<]*<\/strong>/);
		if (!heightened) return `${next}\n${EFFECT_LINK}`;
		const divider = next.slice(0, heightened.index).match(/<hr\s*\/?>/gi)?.pop();
		if (divider !== undefined) {
			const dividerIndex = next.lastIndexOf(divider, heightened.index);
			return `${next.slice(0, dividerIndex)}\n${EFFECT_LINK}\n${next.slice(dividerIndex)}`;
		}
		return `${next.slice(0, heightened.index)}\n${EFFECT_LINK}\n${next.slice(heightened.index)}`;
	}

	/* -------------------------------------------- */
	/*  Patching spell copies                       */
	/* -------------------------------------------- */

	static async _patchExistingSpells() {
		if (!game.user.isGM) return;
		try {
			for (const actor of game.actors) {
				const updates = [];
				for (const item of actor.items) {
					if (item.type !== "spell" || item.name !== SPELL_NAME) continue;
					const description = item.system?.description?.value ?? "";
					const next = this._transformDescription(description);
					if (next === description) continue;
					updates.push({ _id: item.id, "system.description.value": next });
				}
				if (updates.length > 0) {
					await actor.updateEmbeddedDocuments("Item", updates);
				}
			}
		} catch (error) {
			console.error(`${MODULE_ID} | shattering-gem description patch failed`, error);
		}
	}

	static _onPreCreateItem(item, data, options, userId) {
		if (game.system.id !== SYSTEM_ID || userId !== game.user.id) return true;
		if (item.type !== "spell" || item.name !== SPELL_NAME) return true;
		const description = item.system?.description?.value ?? "";
		const next = this._transformDescription(description);
		if (next !== description) {
			item.updateSource({ "system.description.value": next });
		}
		return true;
	}
}
