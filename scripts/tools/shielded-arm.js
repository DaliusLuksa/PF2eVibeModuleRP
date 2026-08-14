import { Manager } from "../core/manager.js";

const SYSTEM_ID = "pf2e";
const EFFECT_UUID = "Compendium.pf2e-vibemodulerp.shielded-arm-effect.Item.uQx4ShlddArm0001";
const EFFECT_LINK = `<p>@UUID[${EFFECT_UUID}]{Spell Effect: Shielded Arm}</p>`;
const SPELL_NAME = "Shielded Arm";

/* Canonical effect data. Mirrors the compendium entry in packs/shielded-arm-effect.db and is injected
   at apply-time so the applied effect is correct even if the pack copy is stale. */
const SHIELD_PREDICATE = [{ or: ["self:type:character", "self:type:npc"] }];
const PACK_RULES = [
	{
		key: "ActiveEffectLike",
		mode: "override",
		path: "system.attributes.shield",
		predicate: SHIELD_PREDICATE,
		value: {
			ac: 2,
			broken: false,
			brokenThreshold: 0,
			destroyed: false,
			hardness: 4,
			hp: { max: 15, value: 15 },
			icon: "systems/pf2e/icons/spells/shielded-arm.webp",
			itemId: "{item|_id}",
			name: "PF2E.ShieldLabel",
			raised: true
		}
	},
	{
		key: "ActiveEffectLike",
		mode: "override",
		path: "system.attributes.shield.hardness",
		predicate: SHIELD_PREDICATE,
		value: "4 + 4*floor((@item.level - 1)/2)"
	},
	{
		key: "ActiveEffectLike",
		mode: "override",
		path: "system.attributes.shield.hp.max",
		predicate: SHIELD_PREDICATE,
		value: "15 + 15*floor((@item.level - 1)/2)"
	},
	{
		key: "ActiveEffectLike",
		mode: "override",
		path: "system.attributes.shield.hp.value",
		predicate: SHIELD_PREDICATE,
		value: "15 + 15*floor((@item.level - 1)/2)"
	},
	{
		key: "RollOption",
		option: "self:shield:equipped",
		predicate: SHIELD_PREDICATE
	}
];
const PACK_DESCRIPTION =
	`<p>The effect of the <em>Shielded Arm</em> spell. Reinforcing veins of ore run through the target's arm, letting it ward off blows with its bare skin.</p>` +
	`<p>While the spell is active, the arm counts as a raised shield, granting a <strong>+2 circumstance bonus to AC</strong>. The target can Shield Block with it, reducing damage as if it had a shield with <strong>Hardness 4</strong> and <strong>15 Hit Points</strong>. This shield has no Broken Threshold, and the spell ends if the shield's Hit Points are expended.</p>` +
	`<p><strong>Heightened (+2)</strong> The Hardness increases by 4, and the Hit Points increase by 15.</p>`;

export class ShieldedArmTool {
	static id = "shielded-arm";
	static category = "shielded-arm";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		this._patchExistingSpells();
		Hooks.on("preCreateItem", this._onPreCreateItem.bind(this));
		Hooks.on("createChatMessage", this._onCreateChatMessage.bind(this));
		console.debug(`${Manager.id} | shielded-arm hooks installed`);
	}

	static _stripExistingLink(description) {
		return description.replace(
			/<p>[^<]*@UUID\[[^\]]*\][^<]*Shielded Arm[^<]*<\/p>/g,
			""
		);
	}

	static _heightenedIndex(description) {
		const hr = description.search(/<hr\s*\/?>/i);
		if (hr !== -1) return hr;
		return description.search(/<p>\s*<strong>\s*Heightened/i);
	}

	static _descriptionWithLink(description) {
		const stripped = this._stripExistingLink(description);
		const index = this._heightenedIndex(stripped);
		if (index === -1) {
			return stripped.trimEnd() + "\n" + EFFECT_LINK;
		}
		const before = stripped.slice(0, index).trimEnd();
		const after = stripped.slice(index).trimStart();
		return `${before}\n${EFFECT_LINK}\n${after}`;
	}

	/* -------------------------------------------- */
	/*  Description link                            */
	/* -------------------------------------------- */

	static async _patchExistingSpells() {
		if (!game.user.isGM) return;
		try {
			for (const actor of game.actors) {
				const updates = [];
				for (const item of actor.items) {
					if (item.type !== "spell" || item.name !== SPELL_NAME) continue;
					const description = item.system?.description?.value ?? "";
					const next = this._descriptionWithLink(description);
					if (next === description) continue;
					updates.push({ _id: item.id, "system.description.value": next });
				}
				if (updates.length > 0) {
					await actor.updateEmbeddedDocuments("Item", updates);
				}
			}
		} catch (error) {
			console.error(`${Manager.id} | shielded-arm description patch failed`, error);
		}
	}

	static _onPreCreateItem(item, data, options, userId) {
		if (game.system.id !== SYSTEM_ID || userId !== game.user.id) return true;
		if (item.type !== "spell" || item.name !== SPELL_NAME) return true;
		const description = item.system?.description?.value ?? "";
		const next = this._descriptionWithLink(description);
		if (next !== description) {
			item.updateSource({ "system.description.value": next });
		}
		return true;
	}

	/* -------------------------------------------- */
	/*  Auto-apply on cast                          */
	/* -------------------------------------------- */

	static async _findCastSpell(message) {
		const flags = message.flags?.pf2e;
		let spell = flags?.casting?.embeddedSpell;
		if (spell) return spell;
		const origin = flags?.origin?.uuid;
		if (origin) {
			const document = await fromUuid(origin);
			if (document && document.type === "spell") return document;
		}
		return null;
	}

	static async _onCreateChatMessage(message) {
		try {
			if (game.system.id !== SYSTEM_ID) return;
			if (!message.isAuthor) return;

			const spell = await this._findCastSpell(message);
			if (!spell || spell.name !== SPELL_NAME) return;

			const effect = await fromUuid(EFFECT_UUID);
			if (!effect) {
				ui.notifications.warn(Manager.localize("shieldedArm.notify.sourceMissing"));
				return;
			}

			const data = effect.toObject();
			data.flags ??= {};
			data.flags.core ??= {};
			data.flags.core.sourceId = EFFECT_UUID;
			data.system.start.value = game.time.worldTime;
			data.system.start.initiative = game.combat?.combatant?.initiative ?? null;

			// Heightened scaling: the effect's level must match the rank the spell was cast at, and the
			// shield rules/description are injected from the canonical data so the applied effect is
			// correct regardless of the pack entry's state.
			const castRank = Math.min(
				10,
				Math.max(1, Math.trunc(Number(message.flags?.pf2e?.origin?.castRank ?? spell.level ?? spell.system?.level?.value) || 1))
			);
			data.system.level.value = castRank;
			data.system.rules = PACK_RULES;
			data.system.description.value = PACK_DESCRIPTION;

			let targetActor = null;
			if (game.user.targets.size === 1) {
				targetActor = [...game.user.targets][0].actor;
			}
			if (!targetActor) {
				const token = canvas?.tokens?.get(message.speaker.token);
				targetActor = token?.actor ?? null;
			}
			if (!targetActor && message.speaker.actor) {
				targetActor = game.actors.get(message.speaker.actor);
			}
			if (!targetActor) {
				console.debug(`${Manager.id} | shielded-arm: no target actor found`, message.id);
				return;
			}

			const [created] = await targetActor.createEmbeddedDocuments("Item", [data]);
			ui.notifications.info(
				Manager.localize("shieldedArm.notify.applied", { name: targetActor.name })
			);
			console.debug(
				`${Manager.id} | applied Spell Effect: Shielded Arm to ${targetActor.name}`,
				{ target: targetActor.id, effect: created?.id, message: message.id }
			);
		} catch (error) {
			console.error(`${Manager.id} | shielded-arm auto-apply failed`, error);
		}
	}
}