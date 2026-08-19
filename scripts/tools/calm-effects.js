const MODULE_ID = "pf2e-vibemodulerp";
const SYSTEM_ID = "pf2e";
const SPELL_NAME = "Calm";

/* Quick links to the tiered Calm spell effects. The original system effect link is
   moved below the Failure paragraph; the two module effects sit below the paragraphs
   of the save results that grant them (Success -> Minor, Critical Failure -> Absolute). */
/* The system effect UUID uses the CURRENT pack name (`spell-effects`). The old
   `spells-srd` pack was renamed, so links pointing there are dead (render as
   "Unknown"). Display text is always included so links never show "Unknown". */
const LINKS = {
	minor: `<p>@UUID[Compendium.pf2e-vibemodulerp.calm-effects.Item.QalmMinor0000000]{Spell Effect: Calm (Minor)}</p>`,
	normal: `<p>@UUID[Compendium.pf2e.spell-effects.Item.Qr5rgoZvI4KmFY0N]{Spell Effect: Calm}</p>`,
	absolute: `<p>@UUID[Compendium.pf2e-vibemodulerp.calm-effects.Item.QalmAbsol0000000]{Spell Effect: Calm (Absolute)}</p>`,
};

export class CalmEffectsTool {
	static id = "calm-effects";
	static category = "calm-effects";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		this._patchExistingSpells();
		Hooks.on("preCreateItem", this._onPreCreateItem.bind(this));
		console.debug(`${MODULE_ID} | calm-effects hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Description transformation                  */
	/* -------------------------------------------- */

	/** Remove every Calm effect link paragraph (module tiers + the system's original),
	 *  so a re-run is idempotent and never stacks duplicates. The `\n?` on each side
	 *  also absorbs the newline the inserter adds, keeping the output byte-stable.
	 *  The system link is stripped with OR without display text, in either pack-name
	 *  form (`spell-effects` current, `spells-srd` legacy). */
	static _stripExistingLinks(description) {
		return description
			.replace(
				/\n?<p>@UUID\[Compendium\.pf2e-vibemodulerp\.calm-effects\.Item\.[^\]]*\]\{[^}]*\}<\/p>\n?/g,
				""
			)
			.replace(
				/\n?<p>@UUID\[Compendium\.pf2e\.spell-effects\.Item\.[^\]]*\]\{[^}]*\}<\/p>\n?/g,
				""
			)
			.replace(/\n?<p>@UUID\[Compendium\.pf2e\.spells-srd\.Item\.Spell Effect: Calm\](?:\{[^}]*\})?<\/p>\n?/g, "");
	}

	/** Insert a link paragraph right after the <p><strong>label</strong>...</p> paragraph. */
	static _insertAfterLabel(description, label, linkHtml) {
		const re = new RegExp(`<p><strong>${label}</strong>[\\s\\S]*?</p>`);
		const match = description.match(re);
		if (!match) return description;
		return description.replace(match[0], () => `${match[0]}\n${linkHtml}`);
	}

	/** Apply the full link layout: Minor below Success, the original below Failure,
	 *  Absolute below Critical Failure. Returns the input unchanged when nothing applies. */
	static _transformDescription(description) {
		let next = this._stripExistingLinks(description);
		next = this._insertAfterLabel(next, "Success", LINKS.minor);
		next = this._insertAfterLabel(next, "Failure", LINKS.normal);
		next = this._insertAfterLabel(next, "Critical Failure", LINKS.absolute);
		return next;
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
			console.error(`${MODULE_ID} | calm-effects description patch failed`, error);
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
