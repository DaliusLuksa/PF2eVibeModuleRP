import { Manager } from "../core/manager.js";

const ABILITY_KEYS = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const ROLL_DIALOG_TEMPLATE = "systems/pf2e/templates/chat/roll-dialog.hbs";

/**
 * Direct attribute rolls for the pf2e character sheet.
 *
 * Ported from the "direct-attribute-roll-pf2e" module (now removed) and
 * improved:
 *  - The original buttons defaulted to `type="submit"`, so pressing Enter in
 *    any sheet input (e.g. editing HP) triggered the browser's implicit form
 *    submission, which "clicked" the first submit button in the form — the
 *    Strength roll. Setting `type="button"` fixes that.
 *  - Click = instant roll, ctrl/cmd-click = blind roll, shift-click = check
 *    dialog with bonus fields and fortune/misfortune.
 *  - The check dialog is NOT opened through `game.pf2e.Dice.d20Roll`: that
 *    branch is broken in the installed pf2e 8.4.0 (it renders
 *    `roll-dialog.hbs` with `messageModes`/`messageMode` but the template
 *    reads `rollModes`/`rollMode`, so `selectOptions(undefined)` throws and
 *    the dialog silently never appears). Instead the dialog is built with
 *    DialogV2 and the template is rendered with the keys it expects.
 */
export class AttributeRollTool {
	static id = "attribute-roll";
	static category = "attribute-roll";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		Hooks.on("renderActorSheet", this._onRenderActorSheet.bind(this));
		console.debug(`${Manager.id} | attribute-roll hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Sheet hook                                  */
	/* -------------------------------------------- */

	static _onRenderActorSheet(app, html) {
		if (game.system.id !== "pf2e") return;
		if (app.actor?.type !== "character") return;
		const list = html[0]?.querySelector("div.subsection.attributes ul");
		if (!list) return;
		for (const li of list.querySelectorAll("li.attribute")) {
			const ability = li.dataset?.attribute;
			if (!ABILITY_KEYS.has(ability)) continue;
			if (li.querySelector(".vibe-attribute-roll")) continue;
			const button = document.createElement("button");
			// Critical: without `type="button"` this defaults to type="submit"
			// and pressing Enter in any input on the (form) sheet would
			// implicitly "click" the first submit button — the Str roll.
			button.type = "button";
			button.className = "vibe-attribute-roll";
			button.dataset.tooltip = game.i18n.localize(`PF2E.AbilityCheck.${ability}`);
			button.innerHTML = `<i class="fa-solid fa-dice-d20"></i>`;
			button.addEventListener("click", (event) => this._onRoll(event, app.actor, ability));
			// Last element of the attribute cell: below the modifier number and
			// below the full attribute word (the user's requested spot).
			li.append(button);
		}
	}

	/* -------------------------------------------- */
	/*  Rolls                                       */
	/* -------------------------------------------- */

	static _onRoll(event, actor, ability) {
		event.preventDefault();
		event.stopPropagation();
		const modifier = actor.system.abilities?.[ability]?.mod ?? 0;
		if (event.shiftKey) return this._openCheckDialog(actor, ability, modifier);
		const blind = event.ctrlKey || event.metaKey;
		return this._instantRoll(actor, ability, modifier, blind);
	}

	/**
	 * Instant (or blind) roll through the system's own check API. The
	 * synthetic event forces d20Roll's "roll now" branch regardless of the
	 * user's "Show Check Dialogs" setting, so a plain click always rolls
	 * immediately and never opens the (broken) system dialog.
	 */
	static _instantRoll(actor, ability, modifier, blind) {
		const showDialogs = game.user.settings.showCheckDialogs;
		return game.pf2e.Dice.d20Roll({
			event: { shiftKey: showDialogs, ctrlKey: false, metaKey: false, altKey: false },
			parts: ["@modifier"],
			data: { modifier },
			title: game.i18n.localize(`PF2E.AbilityCheck.${ability}`),
			speaker: ChatMessage.getSpeaker({ actor }),
			messageMode: blind ? "blind" : undefined
		});
	}

	/* -------------------------------------------- */
	/*  Check dialog                                */
	/* -------------------------------------------- */

	static async _openCheckDialog(actor, ability, modifier) {
		const title = game.i18n.localize(`PF2E.AbilityCheck.${ability}`);
		const messageMode = game.settings.get("core", "messageMode");
		const modes = CONFIG.ChatMessage.modes;
		let content;
		try {
			// The template reads `rollModes`/`rollMode`; supply them alongside
			// the keys d20Roll passes, so the system file renders correctly.
			content = await foundry.applications.handlebars.renderTemplate(ROLL_DIALOG_TEMPLATE, {
				data: { itemBonus: null, statusBonus: null, circumstanceBonus: null },
				messageMode,
				formula: `1d20 + ${modifier}`,
				messageModes: modes,
				rollModes: modes,
				rollMode: messageMode
			});
		} catch (error) {
			console.warn(`${Manager.id} | could not render the check dialog, rolling directly`, error);
			return this._instantRoll(actor, ability, modifier, false);
		}
		const confirm = (event, button, dialog, fortune) => {
			const element = dialog?.element;
			const read = (name) => {
				const value = element?.querySelector(`input[name="${name}"]`)?.value;
				return value && !Number.isNaN(Number(value)) ? Number(value) : 0;
			};
			return this._rollFromDialog(actor, ability, modifier, fortune, {
				itemBonus: read("itemBonus"),
				statusBonus: read("statusBonus"),
				circumstanceBonus: read("circumstanceBonus")
			}, element?.querySelector(`select[name="rollMode"]`)?.value ?? messageMode);
		};
		return foundry.applications.api.DialogV2.wait({
			window: { title, icon: "fa-solid fa-dice-d20" },
			content,
			buttons: [
				{ action: "misfortune", label: game.i18n.localize("PF2E.Roll.Misfortune"), callback: (e, b, d) => confirm(e, b, d, -1) },
				{ action: "normal", label: game.i18n.localize("PF2E.Roll.Normal"), default: true, callback: (e, b, d) => confirm(e, b, d, 0) },
				{ action: "fortune", label: game.i18n.localize("PF2E.Roll.Fortune"), callback: (e, b, d) => confirm(e, b, d, 1) }
			],
			render: (event, dialog) => {
				dialog.element.querySelector("input")?.focus();
			}
		});
	}

	/**
	 * Perform the roll chosen in the check dialog. Mirrors what d20Roll's
	 * internal `_roll` helper produces, so the message matches the plain-click
	 * roll (same flavor, flags and message mode).
	 */
	static async _rollFromDialog(actor, ability, modifier, fortune, bonuses, messageMode) {
		const title = game.i18n.localize(`PF2E.AbilityCheck.${ability}`);
		const dice = fortune === 1 ? "2d20kh" : fortune === -1 ? "2d20kl" : "1d20";
		const parts = [dice, "@modifier"];
		const data = { modifier };
		for (const [key, part] of [["itemBonus", "@itemBonus"], ["statusBonus", "@statusBonus"], ["circumstanceBonus", "@circumstanceBonus"]]) {
			if (bonuses?.[key]) {
				parts.push(part);
				data[key] = bonuses[key];
			}
		}
		const flavor = fortune === 1 ? game.i18n.format("PF2E.Roll.FortuneTitle", { title })
			: fortune === -1 ? game.i18n.format("PF2E.Roll.MisfortuneTitle", { title })
			: title;
		const roll = await new Roll(parts.join("+"), data).roll();
		return roll.toMessage({
			speaker: ChatMessage.getSpeaker({ actor }),
			flavor,
			flags: { pf2e: { context: { type: "" }, origin: null } }
		}, { messageMode });
	}
}
