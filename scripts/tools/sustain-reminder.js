import { Manager } from "../core/manager.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_BADGES = "sustainReminderBadges";
const SYSTEM_SPELLS_PACK = "pf2e.spells-srd";
const EFFECT_NAME_PREFIX = "Spell Effect: ";

/**
 * Reminds player characters to Sustain their active sustained spells.
 *
 * Detection is derived entirely from the pf2e system's own effect data, so
 * there is no manual bookkeeping: an effect with `system.duration.sustained`
 * that is not expired and carries `system.context.origin.actor` (the caster's
 * UUID - set when the effect is applied via a targeted cast or dragged from
 * the chat card) is one the caster must sustain. Because the effect's
 * presence IS the state, reminders stop automatically the moment the effect
 * is removed or expires.
 *
 * Only the GM can see other actors' embedded items, so the GM performs the
 * detection: it posts the chat message on turn changes and broadcasts the
 * badge state to all clients over the module socket (players cannot compute
 * it themselves).
 */
export class SustainReminderTool {
	static id = "sustain-reminder";
	static category = "sustain-reminder";
	static enabledDefault = true;

	static settings = [
		{ key: "chatMessage", type: Boolean, default: true, scope: "world" },
		{ key: "trackerBadge", type: Boolean, default: true, scope: "world" },
		{ key: "patchEffects", type: Boolean, default: true, scope: "world" },
		{ key: "extraSpells", type: String, default: "", scope: "world", requiresReload: true }
	];

	/** Actor UUIDs of casters that currently have active sustained effects (all clients). */
	static _badgedCasters = new Set();
	static _lastBadgeKey = null;
	static _refreshTimer = null;
	static _interval = null;

	/** spell name -> whether its effects must carry the Sustained flag (lazily resolved). */
	static _spellCache = new Map();

	static ready() {
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		Hooks.on("combatTurnChange", this._onCombatTurnChange.bind(this));
		Hooks.on("updateCombat", this._onCombatUpdate.bind(this));
		Hooks.on("renderCombatTracker", this._onRenderCombatTracker.bind(this));
		Hooks.on("createItem", this._onItemChanged.bind(this));
		Hooks.on("updateItem", this._onItemChanged.bind(this));
		Hooks.on("deleteItem", this._onItemChanged.bind(this));
		Hooks.on("deleteActor", this._onItemChanged.bind(this));
		Hooks.on("createItem", this._onCreateItem.bind(this));
		this._refreshBadgeState();
		// Self-heal badges if a tracker render was missed or a socket race lost.
		this._interval = setInterval(() => {
			if (game.combat?.started) this._applyBadges();
		}, 5000);
		console.debug(`${Manager.id} | hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Detection                                   */
	/* -------------------------------------------- */

	/** Every actor in the world, including token actors from all scenes. */
	static _allActors() {
		const seen = new Set();
		const actors = [];
		for (const scene of game.scenes) {
			for (const token of scene.tokens) {
				const actor = token.actor;
				if (actor && !seen.has(actor.uuid)) {
					seen.add(actor.uuid);
					actors.push(actor);
				}
			}
		}
		for (const actor of game.actors) {
			if (!seen.has(actor.uuid)) {
				seen.add(actor.uuid);
				actors.push(actor);
			}
		}
		return actors;
	}

	/**
	 * Map of caster actor UUID -> [{ effect, target }] for every active
	 * sustained effect in the world whose caster is a living player character.
	 */
	static _activeSustainedEffects() {
		const byCaster = new Map();
		for (const target of this._allActors()) {
			for (const effect of target.items ?? []) {
				if (effect.type !== "effect") continue;
				const system = effect.system ?? {};
				if (!system.duration?.sustained || system.expired) continue;
				const originUuid = system.context?.origin?.actor;
				if (!originUuid) continue;
				const resolved = fromUuidSync(originUuid);
				const caster = resolved?.actor ?? resolved;
				if (!caster?.isOfType?.("character") || caster.isDead) continue;
				if (!byCaster.has(originUuid)) byCaster.set(originUuid, []);
				byCaster.get(originUuid).push({ effect, target });
			}
		}
		return byCaster;
	}

	/* -------------------------------------------- */
	/*  Chat reminder                               */
	/* -------------------------------------------- */

	static _onCombatTurnChange(combat, previous, current) {
		if (!Manager.setting(this.id, "chatMessage")) return;
		if (!game.user.isActiveGM) return;
		// v14: `previous`/`current` are CombatHistoryData state objects
		// ({ round, turn, combatantId, tokenId }), NOT Combatant documents.
		const combatant = combat?.combatants?.get(current?.combatantId ?? "") ?? null;
		const actor = combatant?.actor;
		if (!actor?.isOfType("character")) return;
		const entries = this._activeSustainedEffects().get(actor.uuid);
		if (!entries?.length) return;
		this._postReminder(actor, entries);
	}

	static _postReminder(actor, entries) {
		const items = entries
			.map(({ effect, target }) => {
				const on = target
					? ` ${Manager.localize("sustain.on", { target: target.name })}`
					: "";
				return `<li>${effect.name}${on}</li>`;
			})
			.join("");
		const content = `<div class="vibe-sustain-reminder"><p><i class="fa-solid fa-hand-holding"></i> ${Manager.localize(
			"sustain.reminder",
			{ caster: actor.name }
		)}</p><ul>${items}</ul></div>`;
		ChatMessage.create({ content, speaker: { alias: "PF2e VibeModuleRP" } }).catch((error) =>
			console.warn(`${Manager.id} | could not post the sustain reminder`, error)
		);
	}

	/* -------------------------------------------- */
	/*  Patching the Sustained flag on effect copies */
	/* -------------------------------------------- */

	/**
	 * The system's spell effects (e.g. "Spell Effect: Leaden Steps") often lack
	 * the Sustained flag even though their spell has it, so origin-based
	 * detection misses them. The locked system compendium can't be edited, but
	 * the flag only matters on the copies on actors - patch every copy as it is
	 * created. Runs on the creating client (post-create update; the flag
	 * survives reloads because actor items live in the world DB). The originals
	 * stay untouched.
	 */
	static async _onCreateItem(item, data, options, userId) {
		if (!Manager.setting(this.id, "patchEffects")) return;
		if (userId && userId !== game.user.id) return;
		if (item.type !== "effect") return;
		if (item.system?.duration?.sustained) return;
		const spellName = this._spellNameFromEffect(item.name);
		if (!spellName) return;
		const sustained = this._extraSpellNames().includes(spellName)
			? true
			: await this._lookupSpellSustained(spellName);
		if (sustained) await this._setSustained(item);
	}

	/**
	 * Resolve whether the spell named `spellName` is sustained, looking it up
	 * lazily (per unique name, cached) instead of scanning the whole pack up
	 * front - no index-field or timing dependencies. Checks the system's spells
	 * pack first, then homebrew spells in the world Items directory.
	 */
	static async _lookupSpellSustained(spellName) {
		if (this._spellCache.has(spellName)) return this._spellCache.get(spellName);
		let sustained = false;
		let definitive = false;
		try {
			const pack = game.packs.get(SYSTEM_SPELLS_PACK);
			if (pack) {
				const index = await pack.getIndex();
				const entry = index.find((e) => e.type === "spell" && e.name === spellName);
				if (entry) {
					const doc = await pack.getDocument(entry._id);
					sustained = !!doc?.system?.duration?.sustained;
					definitive = true;
				} else {
					// Index loaded fine - the spell is genuinely not in the system pack.
					definitive = true;
				}
			}
			if (!sustained) {
				const worldSpell = game.items?.find((i) => i.type === "spell" && i.name === spellName);
				if (worldSpell) {
					sustained = !!worldSpell.system?.duration?.sustained;
					definitive = true;
				}
			}
		} catch (error) {
			// Do NOT cache failures - a transient error must not poison the lookup.
			console.warn(`${Manager.id} | could not look up spell "${spellName}"`, error);
			return false;
		}
		if (definitive) this._spellCache.set(spellName, sustained);
		return sustained;
	}

	static async _setSustained(item) {
		try {
			await item.update({ "system.duration.sustained": true });
		} catch (error) {
			console.warn(`${Manager.id} | could not patch the Sustained flag on "${item.name}"`, error);
		}
	}

	/** Parse the comma-separated `extraSpells` setting into a list of names. */
	static _extraSpellNames() {
		return String(Manager.setting(this.id, "extraSpells") ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
	}

	/**
	 * Effect name -> spell name, or null. Also strips save-degree suffixes so
	 * variants like "Spell Effect: Leaden Steps (Failure)" resolve to the base
	 * spell ("Leaden Steps") for the sustained lookup.
	 */
	static _spellNameFromEffect(name) {
		if (typeof name !== "string" || !name.startsWith(EFFECT_NAME_PREFIX)) return null;
		let spellName = name.slice(EFFECT_NAME_PREFIX.length);
		const stripped = spellName.replace(/\s*\([^)]*\)\s*$/, "");
		if (stripped && stripped !== spellName) spellName = stripped;
		return spellName.trim() || null;
	}

	/* -------------------------------------------- */
	/*  Tracker badge                               */
	/* -------------------------------------------- */

	static _onCombatUpdate(combat, changed, options, userId) {
		if (!game.user.isGM) return;
		this._scheduleBadgeRefresh();
	}

	static _onItemChanged(item, data, userId) {
		if (!game.user.isGM) return;
		this._scheduleBadgeRefresh();
	}

	static _scheduleBadgeRefresh() {
		clearTimeout(this._refreshTimer);
		this._refreshTimer = setTimeout(() => this._refreshBadgeState(), 300);
	}

	/** GM-only: recompute the badge set and broadcast it when it changed. */
	static _refreshBadgeState() {
		if (!game.user.isGM) return;
		const uuids = [...this._activeSustainedEffects().keys()].sort();
		const key = uuids.join(",");
		if (key === this._lastBadgeKey) return;
		this._lastBadgeKey = key;
		this._badgedCasters = new Set(uuids);
		if (Manager.setting(this.id, "trackerBadge")) {
			game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_BADGES, uuids });
		}
		this._applyBadges();
	}

	static _onSocketMessage(data, userId) {
		try {
			if (data?.action !== SOCKET_ACTION_BADGES || !Array.isArray(data.uuids)) return;
			this._badgedCasters = new Set(data.uuids);
			this._applyBadges();
		} catch (error) {
			console.error(`${Manager.id} | sustain-reminder socket handler failed`, error);
		}
	}

	static _onRenderCombatTracker(app, html) {
		this._applyBadges(html);
	}

	static _applyBadges(root) {
		if (!Manager.setting(this.id, "trackerBadge")) return;
		const element = root ?? ui.combat?.element;
		if (!element) return;
		const combatants = game.combat?.combatants;
		const state = this._badgedCasters;
		for (const li of element.querySelectorAll("li.combatant")) {
			const combatant = combatants?.get(li.dataset.combatantId);
			const actor = combatant?.actor;
			const has = !!actor && state.has(actor.uuid);
			li.classList.toggle("vibe-sustained", has);
			const nameEl = li.querySelector(".token-name .name");
			if (!nameEl) continue;
			let icon = nameEl.querySelector(".vibe-sustain-badge");
			if (has && !icon) {
				icon = document.createElement("i");
				icon.className = "vibe-sustain-badge fa-solid fa-hand-holding";
				icon.dataset.tooltip = Manager.localize("sustain.badgeTooltip");
				icon.setAttribute("aria-label", Manager.localize("sustain.badgeTooltip"));
				nameEl.append(icon);
			} else if (!has && icon) {
				icon.remove();
			}
		}
	}
}
