import { Manager } from "../core/manager.js";

/**
 * Parlor (and similar) overwrites Foundry's variadic Handlebars helpers
 * `or`/`and` with 2-arg versions `(a,b)=>a||b` / `(a,b)=>a&&b`
 * (`parlor/scripts/main.js:registerHandlebarsHelpers`).
 * PF2e's `templates/chat/spell-card.hbs:37` uses `{{or a b c d}}` with 4 args
 * (`data.check data.hasDamage data.counteraction data.area.type`) — with a
 * 2-arg `or` only the first two are tested, so `area.type` is ignored and
 * the `owner-buttons` / `Place X-foot burst` button never renders.
 * Sheet `item-summary.hbs:50` uses 2-arg `and` so it keeps working.
 * Restore the variadic helpers after every `init` (parlor registers there).
 */
export class HandlebarsFixTool {
	static id = "handlebars-fix";
	static category = "fixes";
	static enabledDefault = true;

	static init() {
		this._fix();
		// Parlor registers on `init`; if it loads after us, the next `init`
		// hook still fires before `ready`. Also patch `registerHelper` so a
		// later 2-arg registration is immediately repaired.
		Hooks.once("ready", () => this._fix());
		this._patchRegisterHelper();
	}

	static ready() {
		this._fix();
	}

	static _fix() {
		if (!Manager.isEnabled(this.id)) return;
		try {
			const or = Handlebars.helpers?.or;
			const and = Handlebars.helpers?.and;
			const orIsBroken = typeof or === "function" && or.length === 2;
			const andIsBroken = typeof and === "function" && and.length === 2;
			if (!orIsBroken && !andIsBroken) return;
			if (orIsBroken) {
				Handlebars.registerHelper("or", function (...args) {
					args.pop(); // Handlebars options hash
					return args.some(Boolean);
				});
			}
			if (andIsBroken) {
				Handlebars.registerHelper("and", function (...args) {
					args.pop();
					return args.every(Boolean);
				});
			}
			console.debug(`${Manager.id} | restored Handlebars or/and helpers`);
		} catch (error) {
			console.warn(`${Manager.id} | could not restore Handlebars helpers`, error);
		}
	}

	static _patchRegisterHelper() {
		if (this._patched) return;
		this._patched = true;
		const original = Handlebars.registerHelper.bind(Handlebars);
		Handlebars.registerHelper = function (name, fn, ...rest) {
			const result = original(name, fn, ...rest);
			if ((name === "or" || name === "and") && typeof fn === "function" && fn.length === 2) {
				// A 2-arg or/and was just registered — repair on next tick so the
				// caller finishes, then overwrite with the variadic version.
				setTimeout(() => HandlebarsFixTool._fix(), 0);
			}
			return result;
		};
	}
}
