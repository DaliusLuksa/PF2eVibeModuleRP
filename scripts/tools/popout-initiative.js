import { Manager } from "../core/manager.js";

const KEY = "popout-initiative";
const INITIATIVE_LINK_SELECTOR = ".sidebar a[data-action=roll-initiative]";

export class PopoutInitiativeTool {
	static id = KEY;
	static category = "popout";
	static enabledDefault = true;

	/** @type {Map<string, ApplicationV1>} appId -> popped-out sheet */
	static popped = new Map();

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		console.debug(`[${Manager.id}] ${KEY}: ready. popout module active = ${game.modules.get("popout")?.active ?? "?"}`);
		if (!game.modules.get("popout")?.active) {
			console.debug(`[${Manager.id}] ${KEY}: popout module not active; sync disabled`);
			return;
		}
		// Track sheets that get popped out. The popout module's own classes are
		// not exposed as globals, so we keep our own registry of popped-out
		// applications fed by its public hooks.
		Hooks.on("PopOut:popout", (app) => this._track(app));
		Hooks.on("PopOut:loaded", (app) => this._track(app));
		Hooks.on("PopOut:close", (app) => this._untrack(app));
		Hooks.on("PopOut:popin", (app) => this._untrack(app));
		for (const hook of [
			"createCombat",
			"updateCombat",
			"deleteCombat",
			"createCombatant",
			"updateCombatant",
			"deleteCombatant"
		]) {
			Hooks.on(hook, (combat, options, userId) => this._onCombatEvent(hook, combat));
		}
		Hooks.on("renderCharacterSheetPF2e", (app) => this._sync(this._referenceCombat("renderCharacterSheetPF2e")));
		console.debug(`[${Manager.id}] ${KEY}: hooks installed`);
	}

	static _track(app) {
		const appId = app?.appId ?? app?.id;
		if (!appId) return;
		this.popped.set(appId, app);
		this._verbose(`tracked popped-out app ${app.constructor?.name} ${appId}`);
	}

	static _untrack(app) {
		const appId = app?.appId ?? app?.id;
		if (appId) this.popped.delete(appId);
	}

	/* -------------------------------------------- */
	/*  Combat event handlers                       */
	/* -------------------------------------------- */

	static _onCombatEvent(hook, combat = null) {
		const reference = this._referenceCombat(hook, combat);
		this._verbose(`event ${hook}: reference = ${combat?.id ?? "null"}`);
		this._sync(reference, hook);
	}

	/**
	 * The encounter that should currently drive the initiative buttons.
	 * Prefers a genuinely active encounter; a freshly created combat (which has
	 * not been activated yet) qualifies so the dice enables immediately when an
	 * encounter begins. Latent or deleted combats never qualify.
	 * @returns {Combat|null}
	 */
	static _referenceCombat(hook, combat) {
		const active = game.combats.find((c) => c.isActive);
		if (active) return active;
		if (hook === "createCombat" && combat?.active === false && game.combats.has(combat.id)) {
			return combat;
		}
		return null;
	}

	/* -------------------------------------------- */
	/*  Popout sync                                 */
	/* -------------------------------------------- */

	static _sync(combat, hook = "") {
		try {
			if (!this.popped.size) {
				this._verbose(`${hook} no popped-out apps (registry size 0)`);
				return;
			}
			this._verbose(`${hook} syncing ${this.popped.size} popped-out app(s)`);
			for (const [appId, app] of this.popped) {
				if (typeof app?.toggleInitiativeLink !== "function") continue;
				// The popout module patches document.getElementById to also look
				// inside popped-out windows, so this resolves the element that is
				// actually mounted in the popout window, even after re-renders.
				const element = document.getElementById(appId) ?? app.element?.[0] ?? app._element;
				const changed = this._applyInitiativeState(app, element, combat);
				this._verbose(
					`${hook} ${app.actor?.name ?? appId}: ${changed ? "changed" : "unchanged"} (reference ${combat?.id ?? "no encounter"})`
				);
			}
		} catch (error) {
			console.error(`[${Manager.id}] ${KEY} sync failed`, error);
		}
	}

	/**
	 * Apply the same enabled/disabled/tooltip state to a popped-out sheet's
	 * initiative link that the pf2e system applies to regular sheets.
	 * @returns {boolean} true if the link's visual state was actually changed
	 */
	static _applyInitiativeState(app, element, combat) {
		const link = element?.querySelector?.(INITIATIVE_LINK_SELECTOR);
		if (!link) {
			this._verbose(`no initiative link found for ${app.actor?.name ?? app.id}`);
			return false;
		}

		const combatant = combat?.combatants.find((c) => c.actor?.uuid === app.actor?.uuid) ?? null;
		const rolled = typeof combatant?.initiative === "number";

		let enabled;
		let tooltip;
		if (app.isEditable && combat && !rolled) {
			enabled = true;
			tooltip = "COMBAT.InitiativeRoll";
		} else {
			enabled = false;
			if (app.isEditable) {
				if (combat && rolled) tooltip = game.i18n.format("PF2E.Encounter.AlreadyRolled", { actor: app.actor.name });
				else if (!combat) tooltip = game.i18n.localize("PF2E.Encounter.NoActiveEncounter");
			}
		}

		const changed = link.classList.contains("disabled") === enabled;
		if (enabled) link.classList.remove("disabled");
		else link.classList.add("disabled");
		if (tooltip !== undefined) link.dataset.tooltip = tooltip;
		return changed;
	}

	/* -------------------------------------------- */
	/*  Diagnostics                                 */
	/* -------------------------------------------- */

	static _verbose(message) {
		try {
			if (game.settings.get("popout", "verboseLogs")) {
				console.warn(`[${Manager.id}] ${KEY}: ${message}`);
			}
		} catch {
			// Settings may not be available yet; ignore.
		}
	}
}