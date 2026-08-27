import { Manager } from "../core/manager.js";
import { AreaEffectsTool } from "./area-effects.js";
import { rememberWindowPosition } from "../core/window-positions.js";

const MODULE_ROOT = "modules/pf2e-vibemodulerp";
const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_APPLY_REQUEST = "effectAutomatorApplyRequest";
const SOCKET_APPLY_RESULT = "effectAutomatorApplyResult";
const GM_RESPONSE_TIMEOUT_MS = 20000;

/** Outcome keys in display order with their label keys. */
const OUTCOME_LABELS = {
	criticalSuccess: "effectAutomator.critSuccess",
	success: "effectAutomator.success",
	failure: "effectAutomator.failure",
	criticalFailure: "effectAutomator.critFailure"
};

/**
 * Effect Automator.
 *
 * A generic, data-driven engine that watches trigger events on actors and, when
 * a configured "source" effect item is present, rolls a saving throw and applies
 * per-outcome effect items. Rules live in a real, editable JSON file at
 * `Data/files/effect-automations.json` (the tool's source of truth): the editor
 * window reads and writes it directly, and it can also be hand-edited (use the
 * window's "Reload from file" afterwards).
 *
 * The engine runs GM-side (it needs to roll for, and apply effects to, actors it
 * may not own — reusing the module's GM-routing pattern). A rule matches an actor
 * by checking which of their active items has the rule's `effectUuid`; if present
 * when a trigger fires, a save is rolled and the matching outcome list is applied.
 *
 * Triggers (v1): turnStart / turnEnd (pf2e.startTurn / pf2e.endTurn) and damage
 * (a `damage-taken` chat message naming the actor). Outcomes are keyed by the
 * degree of success: criticalSuccess / success / failure / criticalFailure.
 */
export class EffectAutomatorTool {
	static id = "effect-automator";
	static category = "effect-automator";
	static enabledDefault = true;

	/** Pending GM effect-apply requests, keyed by request id. */
	static _pendingGmRequests = new Map();

	/** The single open editor window instance. */
	static _window = null;

	/** Cached rules (read from the JSON file). */
	static _rules = [];

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		this._loadRules();
		// GMs drive the engine: turn start/end are GM-side, and damage-taken
		// messages are processed by the GM so it can roll/apply for any actor.
		if ( game.user.isGM ) {
			Hooks.on("pf2e.startTurn", this._onStartTurn.bind(this));
			Hooks.on("pf2e.endTurn", this._onEndTurn.bind(this));
			Hooks.on("createChatMessage", this._onChatMessage.bind(this));
		}
		console.debug(`${Manager.id} | hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Rules store (editable JSON file)            */
	/* -------------------------------------------- */

	static get RULES_BASENAME() {
		return "effect-automations.json";
	}

	/** The config lives beside the other editable configs in the module's data dir. */
	static get RULES_PATH() {
		return `${MODULE_ROOT}/data/${this.RULES_BASENAME}`;
	}

	/** The FilePicker upload target (directory) for the rules file. */
	static get RULES_TARGET() {
		return `${MODULE_ROOT}/data`;
	}

	/** Load rules from the JSON file in the module's data directory. */
	static async _loadRules() {
		this._resetPending();
		let parsed = null;
		try {
			const res = await fetch(this.RULES_PATH);
			if ( res.ok ) parsed = await res.json();
		} catch {
			parsed = null;
		}
		this._rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
		return this._rules;
	}

	/**
	 * Persist the current rules to the JSON file. Uploading into the module's own
	 * folder is allowed (`.json` counts as media, so overwriting is permitted);
	 * Foundry's "uploading into a module folder" notice is suppressed.
	 */
	static async _saveRules() {
		if ( !game.user.isGM ) return;
		const payload = JSON.stringify({ rules: this._rules }, null, 2);
		const file = new File([payload], this.RULES_BASENAME, { type: "application/json" });
		try {
			await foundry.applications.apps.FilePicker.upload("data", this.RULES_TARGET, file, {}, { notify: false });
		} catch (error) {
			console.warn(`${Manager.id} | could not write ${this.RULES_PATH}`, error);
			ui.notifications.error(Manager.localize("effectAutomator.saveFailed"));
		}
	}

	static _resetPending() {
		for ( const pending of this._pendingGmRequests.values() ) clearTimeout(pending.timer);
		this._pendingGmRequests.clear();
	}

	/* -------------------------------------------- */
	/*  Rule helpers                                */
	/* -------------------------------------------- */

	static _rule(id) {
		return this._rules.find((r) => r.id === id) ?? null;
	}

	static async _upsertRule(rule) {
		const index = this._rules.findIndex((r) => r.id === rule.id);
		if ( index >= 0 ) this._rules[index] = rule;
		else this._rules.push(rule);
		await this._saveRules();
		return rule;
	}

	static async _deleteRule(id) {
		this._rules = this._rules.filter((r) => r.id !== id);
		await this._saveRules();
	}

	/* -------------------------------------------- */
	/*  Trigger handlers (GM side)                  */
	/* -------------------------------------------- */

	static async _onStartTurn(combatant, encounter, userId) {
		await this._onTurnTrigger(combatant?.actor ?? null, "turnStart");
	}

	static async _onEndTurn(combatant, encounter, userId) {
		await this._onTurnTrigger(combatant?.actor ?? null, "turnEnd");
	}

	/** Damage-taken messages identify the wounded actor in the speaker/flags. */
	static async _onChatMessage(message) {
		const type = message?.flags?.pf2e?.context?.type;
		if ( type !== "damage-taken" ) return;
		const actor = message.speakerActor ?? message.token?.actor ?? null;
		await this._onTurnTrigger(actor, "damage");
	}

	/** Run every rule whose trigger matches and whose source effect is on `actor`. */
	static async _onTurnTrigger(actor, trigger) {
		if ( !actor ) return;
		if ( !this._rules.length ) return;
		for ( const rule of this._rules ) {
			if ( rule.trigger !== trigger ) continue;
			if ( !this._hasSourceEffect(actor, rule.effectUuid) ) continue;
			console.debug(`${Manager.id} | effect-automator: "${rule.trigger}" fired for ${actor.name}`);
			await this._rollFor(actor, rule);
		}
	}

	/**
	 * Does the actor carry the rule's source effect? The embedded copy on an actor
	 * never shares the source document's UUID, so also match copies by their
	 * recorded origin (drag-drop `sourceId`, `compendiumSource`, or the module's
	 * own tags left by other tools).
	 */
	static _hasSourceEffect(actor, effectUuid) {
		if ( !effectUuid ) return false;
		return actor.items.some((item) => this._matchesSource(item, effectUuid));
	}

	/**
	 * Does the actor carry any unexpired copy of the given effect item? Blocks
	 * re-application regardless of where the existing copy came from (previous
	 * trigger, an area, or a manual drag).
	 */
	static _hasEffectCopy(actor, effectUuid) {
		if ( !effectUuid ) return false;
		return actor.items.some((item) => this._matchesSource(item, effectUuid) && !item?.isExpired);
	}

	/** Identity match between an embedded item copy and its source document. */
	static _matchesSource(item, effectUuid) {
		if ( !item || !effectUuid ) return false;
		return item.uuid === effectUuid
			|| item.getFlag?.("core", "sourceId") === effectUuid
			|| item._stats?.compendiumSource === effectUuid
			|| item.getFlag?.(Manager.id, "areaSource") === effectUuid;
	}

	/* -------------------------------------------- */
	/*  Rolling                                     */
	/* -------------------------------------------- */

	static async _rollFor(actor, rule) {
		const saveType = rule.roll?.type ?? "reflex";
		const statistic = actor.saves?.[saveType] ?? actor.getStatistic?.(saveType);
		if ( !statistic ) {
			console.warn(`${Manager.id} | actor ${actor.name} has no ${saveType} save`);
			return;
		}
		const dc = Math.max(0, Number(rule.roll?.dc) || 0);
		try {
			await statistic.roll({
				dc: { value: dc },
				skipDialog: true,
				callback: (roll, outcome, message) => {
					this._applyOutcome(actor, rule, outcome).catch((error) =>
						console.warn(`${Manager.id} | could not apply outcome for ${actor.name}`, error)
					);
				}
			});
		} catch (error) {
			console.warn(`${Manager.id} | could not roll ${saveType} for ${actor.name}`, error);
		}
	}

	/** Apply the configured effect items for a degree-of-success outcome. */
	static async _applyOutcome(actor, rule, outcome) {
		const effects = rule.outcomes?.[outcome] ?? [];
		if ( !effects.length ) return;
		for ( const uuid of effects ) {
			if ( this._hasEffectCopy(actor, uuid) ) continue;
			const item = await foundry.utils.fromUuid(uuid).catch(() => null);
			if ( !item ) continue;
			await this._applyToActor(actor, item, rule.id);
		}
		if ( rule.removeOnTrigger ) {
			const marker = actor.items.find((item) => this._matchesSource(item, rule.effectUuid));
			if ( marker ) await this._removeFromActor(actor, marker);
		}
	}

	/* -------------------------------------------- */
	/*  Effect apply / remove (GM routed)           */
	/* -------------------------------------------- */

	static async _applyToActor(actor, effectItem, ruleId) {
		const source = foundry.utils.mergeObject(effectItem.toObject(), {
			_id: null,
			flags: {
				[Manager.id]: { ...(effectItem.flags?.[Manager.id] ?? {}), automatorRule: ruleId }
			}
		}, { overwrite: false });
		if ( actor.testUserPermission(game.user, "OWNER") ) {
			await actor.createEmbeddedDocuments("Item", [source]);
		} else {
			await this._requestGmApply(actor.uuid, source);
		}
	}

	static async _removeFromActor(actor, item) {
		if ( actor.testUserPermission(game.user, "OWNER") ) {
			await actor.deleteEmbeddedDocuments("Item", [item.id]);
		} else {
			await this._requestGmApply(actor.uuid, null, item.id);
		}
	}

	/** Ask a connected GM to apply/remove an effect (GMs have universal ownership). */
	static _requestGmApply(actorUuid, source, deleteId = null) {
		return new Promise((resolve) => {
			const gm = game.users.find((user) => user.isGM && user.active);
			if ( !gm ) {
				resolve({ applied: 0, failed: 1, noGm: true });
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve({ applied: 0, failed: 1, timeout: true });
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer });
			game.socket.emit(SOCKET_EVENT, {
				action: SOCKET_APPLY_REQUEST,
				requestId,
				actorUuid,
				source,
				deleteId
			}, { recipients: [gm.id] });
		});
	}

	/* -------------------------------------------- */
	/*  Socket handling                             */
	/* -------------------------------------------- */

	static _onSocketMessage(data, userId) {
		try {
			if ( !data?.action ) return;
			if ( data.action === SOCKET_APPLY_REQUEST ) {
				if ( !game.user.isGM ) return;
				this._handleGmApply(data, userId).catch((error) =>
					console.error(`${Manager.id} | GM effect-automator apply failed`, error)
				);
			} else if ( data.action === SOCKET_APPLY_RESULT ) {
				this._handleGmApplyResult(data);
			}
		} catch (error) {
			console.error(`${Manager.id} | effect-automator socket handler failed`, error);
		}
	}

	/** GM-only: create or delete the requested item on the actor and report back. */
	static async _handleGmApply(data, userId) {
		const { requestId, actorUuid, source, deleteId } = data;
		let ok = false;
		try {
			const actor = actorUuid ? await foundry.utils.fromUuid(actorUuid) : null;
			if ( actor ) {
				if ( source ) await actor.createEmbeddedDocuments("Item", [source]);
				else if ( deleteId ) await actor.deleteEmbeddedDocuments("Item", [deleteId]);
				ok = true;
			}
		} catch (error) {
			console.warn(`${Manager.id} | GM could not apply effect (${actorUuid})`, error);
		}
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_APPLY_RESULT, requestId, ok }, { recipients: [userId] });
	}

	static _handleGmApplyResult(data) {
		const pending = this._pendingGmRequests.get(data?.requestId);
		if ( !pending ) return;
		clearTimeout(pending.timer);
		this._pendingGmRequests.delete(data.requestId);
		pending.resolve({ applied: data.ok ? 1 : 0, failed: data.ok ? 0 : 1 });
	}

	/* -------------------------------------------- */
	/*  Effect search (reuse AreaEffects)           */
	/* -------------------------------------------- */

	static async _searchEffects(query) {
		return AreaEffectsTool._searchEffects(query);
	}

	static _displayName(uuid) {
		if ( !uuid ) return "";
		try {
			const doc = foundry.utils.fromUuidSync(uuid);
			return doc?.name ?? uuid;
		} catch {
			return uuid;
		}
	}

	/* -------------------------------------------- */
	/*  Window management                           */
	/* -------------------------------------------- */

	static _openWindow() {
		if ( !this._window ) this._window = new EffectAutomatorWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the effect automator`, error)
		);
	}

	static _closeWindow() {
		if ( this._window ) {
			this._window.close().catch(() => null);
			this._window = null;
		}
	}

	static _toggleWindow() {
		if ( this._window?.rendered ) this._closeWindow();
		else this._openWindow();
	}

	static _renderWindow() {
		if ( this._window?.rendered ) {
			this._window.render().catch((error) =>
				console.warn(`${Manager.id} | could not re-render the effect automator`, error)
			);
		}
	}

	/* -------------------------------------------- */
	/*  Context                                     */
	/* -------------------------------------------- */

	static _context() {
		const rules = this._rules.map((rule) => ({
			id: rule.id,
			effectName: this._displayName(rule.effectUuid),
			effectUuid: rule.effectUuid,
			trigger: rule.trigger,
			rollSummary: `${rule.roll?.type ?? "reflex"} (DC ${Number(rule.roll?.dc) || 0})`,
			removeOnTrigger: !!rule.removeOnTrigger,
			outcomes: this._outcomeSummary(rule)
		}));
		return {
			rules,
			i18n: (key) => Manager.localize(`effectAutomator.${key}`)
		};
	}

	static _outcomeSummary(rule) {
		const keys = ["criticalSuccess", "success", "failure", "criticalFailure"];
		const parts = [];
		for ( const key of keys ) {
			const list = rule.outcomes?.[key] ?? [];
			if ( list.length ) parts.push(`${this._displayName(list[0])}${list.length > 1 ? ` +${list.length - 1}` : ""}`);
		}
		return parts.join(", ") || Manager.localize("effectAutomator.none");
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class EffectAutomatorWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(
		foundry.applications.api.ApplicationV2
	)
) {
	static DEFAULT_OPTIONS = {
		id: "effect-automator",
		classes: ["vibe-effect-automator"],
		position: { width: 640 },
		window: {
			icon: "fa-solid fa-robot",
			resizable: true,
			minimizable: true
		},
		actions: {
			edit(event, target) { this._startEdit(target?.dataset?.id); },
			remove(event, target) { this._deleteRule(target?.dataset?.id); },
			pickSource() { this._pickSource(); },
			outcomeAdd(event, target) { this._pickOutcome(target?.dataset?.key); },
			outcomeRemove(event, target) { this._removeOutcome(target?.dataset?.key, target?.dataset?.index); },
			save() { this._save(); },
			resetForm() { this._resetForm(); }
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/effect-automator.hbs`, root: true }
	};

	/** Current rule being edited (persists across renders). */
	_draft = null;

	get title() {
		return Manager.localize("effectAutomator.title");
	}

	_prepareContext(options) {
		const base = EffectAutomatorTool._context();
		const draft = this._prepareDraft(this._draft);
		return {
			...base,
			draft,
			editing: !!this._draft?.id,
			triggers: [
				{ value: "turnStart", label: Manager.localize("effectAutomator.triggerTurnStart") },
				{ value: "turnEnd", label: Manager.localize("effectAutomator.triggerTurnEnd") },
				{ value: "damage", label: Manager.localize("effectAutomator.triggerDamage") }
			],
			outcomeRows: [
				{ outcomes: this._outcomeRow(["criticalSuccess", "success"], draft) },
				{ outcomes: this._outcomeRow(["failure", "criticalFailure"], draft) }
			]
		};
	}

	/** Build the renderable outcome columns for one row of the editor. */
	_outcomeRow(keys, draft) {
		return keys.map((key) => ({
			key,
			label: Manager.localize(OUTCOME_LABELS[key]),
			effects: draft?.outcomes?.[key] ?? []
		}));
	}

	/** Enrich the draft with readable outcome effect lists for the template. */
	_prepareDraft(draft) {
		if ( !draft ) return null;
		const outcomes = {};
		for ( const key of Object.keys(OUTCOME_LABELS) ) {
			outcomes[key] = (draft.outcomes?.[key] ?? []).map((uuid, index) => ({
				uuid,
				index,
				name: EffectAutomatorTool._displayName(uuid)
			}));
		}
		return {
			...foundry.utils.deepClone(draft),
			effectName: draft.effectUuid ? EffectAutomatorTool._displayName(draft.effectUuid) : "",
			outcomes
		};
	}

	/* -------------------------------------------- */
	/*  Draft lifecycle                             */
	/* -------------------------------------------- */

	_newDraft() {
		return {
			id: foundry.utils.randomID(),
			effectUuid: "",
			trigger: "turnStart",
			roll: { type: "reflex", dc: 20 },
			removeOnTrigger: false,
			outcomes: { criticalSuccess: [], success: [], failure: [], criticalFailure: [] }
		};
	}

	_startEdit(id) {
		const rule = EffectAutomatorTool._rule(id);
		if ( !rule ) return;
		this._draft = foundry.utils.deepClone(rule);
		this._draft.outcomes ??= { criticalSuccess: [], success: [], failure: [], criticalFailure: [] };
		this.render({ force: true });
	}

	/** Bind the create/edit form controls to the draft. */
	_onRender(context, options) {
		const element = this.element;
		if ( !element ) return;
		const form = element.querySelector(".ea-form");
		if ( !form || !this._draft ) return;

		form.querySelector("select[name='trigger']")?.addEventListener("change", (event) => {
			this._draft.trigger = event.currentTarget.value;
			this.render();
		});
		form.querySelector("select[name='rollType']")?.addEventListener("change", (event) => {
			this._draft.roll ??= { type: "reflex", dc: 20 };
			this._draft.roll.type = event.currentTarget.value;
			this.render();
		});
		form.querySelector("input[name='dc']")?.addEventListener("change", (event) => {
			this._draft.roll ??= { type: "reflex", dc: 20 };
			this._draft.roll.dc = event.currentTarget.value;
			this.render();
		});
		form.querySelector("input[name='removeOnTrigger']")?.addEventListener("change", (event) => {
			this._draft.removeOnTrigger = !!event.currentTarget.checked;
			this.render();
		});
	}

	_resetForm() {
		this._draft = null;
		this.render({ force: true });
	}

	async _save() {
		if ( !this._draft ) return;
		if ( !this._draft.effectUuid ) {
			ui.notifications.warn(Manager.localize("effectAutomator.needSource"));
			return;
		}
		const rule = foundry.utils.deepClone(this._draft);
		rule.effectUuid = this._draft.effectUuid;
		await EffectAutomatorTool._upsertRule(rule);
		this._draft = null;
		this.render({ force: true });
	}

	async _deleteRule(id) {
		await EffectAutomatorTool._deleteRule(id);
		if ( this._draft?.id === id ) this._draft = null;
		this.render({ force: true });
	}

	/* -------------------------------------------- */
	/*  Source / outcome effect picking             */
	/* -------------------------------------------- */

	async _pickSource() {
		const uuid = await EffectPickerDialog.pick(Manager.localize("effectAutomator.pickSource"));
		if ( !uuid ) return;
		this._draft ??= this._newDraft();
		this._draft.effectUuid = uuid;
		if ( !this._draft.id ) this._draft.id = foundry.utils.randomID();
		this.render({ force: true });
	}

	async _pickOutcome(key) {
		if ( !this._draft ) return;
		this._draft.outcomes ??= { criticalSuccess: [], success: [], failure: [], criticalFailure: [] };
		const uuid = await EffectPickerDialog.pick(Manager.localize("effectAutomator.pickOutcome"));
		if ( !uuid ) return;
		const list = this._draft.outcomes[key] ?? [];
		if ( !list.includes(uuid) ) this._draft.outcomes[key] = [...list, uuid];
		this.render({ force: true });
	}

	_removeOutcome(key, index) {
		if ( !this._draft ) return;
		this._draft.outcomes ??= { criticalSuccess: [], success: [], failure: [], criticalFailure: [] };
		this._draft.outcomes[key] = (this._draft.outcomes[key] ?? []).filter((_, i) => i !== Number(index));
		this.render({ force: true });
	}
}
/* -------------------------------------------- */
/*  Effect picker dialog                        */
/* -------------------------------------------- */

class EffectPickerDialog {
	static pick(title) {
		let chosen = null;
		const content = `<div class="vibe-effect-picker">
			<input type="text" name="search" placeholder="${Manager.localize("effectAutomator.searchPlaceholder")}" />
			<ul class="vibe-picker-results"></ul>
		</div>`;
		return foundry.applications.api.DialogV2.wait({
			modal: true,
			content,
			window: { title },
			buttons: [{
				action: "cancel",
				label: Manager.localize("areaEffects.cancel"),
				// _onSubmit resolves with `callbackResult ?? action`, so a missing/null
				// return falls back to "cancel" — return false to signal dismissal.
				callback: () => false
			}],
			render: (event, dialog) => {
				const element = dialog.element;
				const input = element.querySelector("input[name='search']");
				const list = element.querySelector(".vibe-picker-results");
				if ( !input || !list ) return;
				const search = async (value) => {
					const results = await EffectAutomatorTool._searchEffects(value);
					EffectPickerDialog.renderResults(list, results);
				};
				input.addEventListener("input", () => search(input.value));
				list.addEventListener("click", (clickEvent) => {
					const button = clickEvent.target.closest?.("button[data-uuid]");
					if ( !button ) return;
					chosen = button.dataset.uuid;
					dialog.close();
				});
				search("");
				requestAnimationFrame(() => input?.focus());
			},
			close: () => chosen
		});
	}

	static renderResults(list, results) {
		if ( !list ) return;
		if ( !results.length ) {
			list.innerHTML = `<li class="vibe-picker-empty">${Manager.localize("areaEffects.searchEmpty")}</li>`;
			return;
		}
		list.innerHTML = results.map((entry) => {
			const img = entry.img ? `<img src="${entry.img}" alt="">` : "";
			return `<li><button type="button" data-uuid="${entry.uuid}">${img}<span>${entry.name}</span></button></li>`;
		}).join("");
	}
}
