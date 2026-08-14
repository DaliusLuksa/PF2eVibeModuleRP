import { Manager } from "../core/manager.js";

const KEY = "hide-cursor";
const SETTING_ID = `${Manager.id}.${KEY}.hidden`;
const MASTER_ID = "invisible-token";

export class HideCursorTool {
	static id = KEY;
	static category = KEY;
	static enabledDefault = true;

	static settings = [
		{
			key: "hidden",
			type: Boolean,
			default: false,
			scope: "user",
			config: false
		}
	];

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static _isMasterEnabled() {
		return Manager.setting(MASTER_ID, "enabled") === true;
	}

	static _isFeatureEnabled() {
		return this._isMasterEnabled() && Manager.setting(this.id) === true;
	}

	static isHidden() {
		if ( !this._isFeatureEnabled() ) return false;
		return game.settings.get(Manager.id, `${KEY}.hidden`);
	}

	/**
	 * Invisibility is session-only: always start a fresh session visible, even
	 * if the player hid themselves before the previous reload.
	 */
	static _resetVisibleState() {
		if ( game.settings.get(Manager.id, `${KEY}.hidden`) === true ) {
			game.settings.set(Manager.id, `${KEY}.hidden`, false).catch(error => {
				console.debug(`${Manager.id} | could not reset the invisibility state`, error);
			});
		}
	}

	static isHiddenFor(userId) {
		if ( !this._isFeatureEnabled() ) return false;
		return game.settings.storage.get("world")?.getSetting(SETTING_ID, userId)?.value === true;
	}

	/**
	 * Decide whether the activity of the given user should be visible to the
	 * local viewer. Hiding is role-aware:
	 *   - the mover's own client always sees their activity;
	 *   - a hidden GM is visible to nobody (not even other GMs);
	 *   - a hidden player stays visible to GMs but is hidden from other players.
	 * @param {string} userId    The ID of the user whose activity is in question
	 * @returns {boolean}        Should this client display that user's activity?
	 */
	static canSeeActivity(userId) {
		if ( userId === game.user.id ) return true;
		if ( !this.isHiddenFor(userId) ) return true;
		const user = game.users.get(userId);
		if ( user?.isGM ) return false;
		return game.user.isGM;
	}

	static init() {
		if ( !this._isFeatureEnabled() ) return;
		game.keybindings.register(Manager.id, "toggleInvisibility", {
			name: Manager.localize(`settings.${KEY}.keybinding.name`),
			hint: Manager.localize(`settings.${KEY}.keybinding.hint`),
			editable: [{ key: "F9" }],
			onDown: () => {
				this.toggle();
			}
		});
	}

	static ready() {
		this._resetVisibleState();
		if ( !this._isFeatureEnabled() ) return;
		const { Cursor } = foundry.canvas.containers;
		this._patchBroadcast();
		this._patchCursorVisibility(Cursor);
		this._patchMovementPreview();
		this._patchMovementTrail();

		// Chat command: /toggleinvisibility [on|off|toggle]
		// The v14 chat editor serializes input as HTML (e.g. `<p>/toggleinvisibility</p>`),
		// so strip tags before matching the command.
		Hooks.on("chatMessage", (log, content, data) => {
			const template = document.createElement("template");
			template.innerHTML = content ?? "";
			template.content.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
			const text = template.content.textContent?.trim() ?? "";
			const match = /^\/toggleinvisibility\b\s*(on|off|toggle)?$/i.exec(text);
			if ( !match ) return true;
			this._toggleFromCommand(match[1]?.toLowerCase());
			return false;
		});

		game.pf2eVibeModuleRP ??= {};
		game.pf2eVibeModuleRP.toggleInvisibility = () => this.toggle();

		console.debug(`${Manager.id} | hide-cursor hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Patches                                    */
	/* -------------------------------------------- */

	/**
	 * Intercept every activity broadcast from this client. A hidden GM must
	 * never leak their live cursor position, so strip it from outgoing
	 * broadcasts. Hidden players keep broadcasting so GMs can follow them; the
	 * receiver-side guards decide who actually renders the activity. `cursor:
	 * null` is preserved (it is the "hide now" signal), and pings are left
	 * untouched.
	 */
	static _patchBroadcast() {
		const User = game.users.documentClass;
		const _broadcast = User.prototype.broadcastActivity;
		User.prototype.broadcastActivity = function (activity = {}, ...rest) {
			if ( HideCursorTool.isHidden() && this.isSelf && this.isGM ) {
				const {cursor, ...other} = activity;
				if ( (cursor !== null) && !("ping" in activity) ) {
					activity = other;
				}
			}
			return _broadcast.call(this, activity, ...rest);
		};
	}

	/**
	 * Receiver-side guard: never show a cursor whose user's activity is not
	 * visible to this client, even if a position update slips through or the
	 * scene re-draws cursors.
	 */
	static _patchCursorVisibility(Cursor) {
		const _refreshVisibility = Cursor.prototype.refreshVisibility;
		Cursor.prototype.refreshVisibility = function (user) {
			const v = _refreshVisibility.call(this, user);
			if ( !user.isSelf && !HideCursorTool.canSeeActivity(user.id) ) {
				this.visible = false;
				return v;
			}
			return v;
		};
	}

	/**
	 * Receiver-side guard for the drag preview (planned movement footprints).
	 * Planned movements are broadcast with every drag tick; when the moving
	 * user's activity is not visible to this client, drop the data so the
	 * footprint and path are never stored or drawn. GMs keep the data and so
	 * see the preview of hidden players.
	 */
	static _patchMovementPreview() {
		const TokenLayer = foundry.canvas.layers.TokenLayer;
		const _updatePlannedMovements = TokenLayer.prototype._updatePlannedMovements;
		TokenLayer.prototype._updatePlannedMovements = function (user, plannedMovements, ...rest) {
			if ( plannedMovements && user && !user.isSelf && !HideCursorTool.canSeeActivity(user.id) ) {
				plannedMovements = null;
			}
			return _updatePlannedMovements.call(this, user, plannedMovements, ...rest);
		};
	}

	/**
	 * Receiver-side guard for the *actual* movement trail. Every client that
	 * applies the movement operation draws the ruler path while the token
	 * animates unless the operation's `showRuler` flag is false. Force it off
	 * only on viewers who should not see this mover; GMs keep it on so they see
	 * hidden players move. The operation object is frozen only on the origin
	 * client (`userId === game.user.id`), which is skipped here.
	 */
	static _patchMovementTrail() {
		const TokenDocument = CONFIG.Token.documentClass;
		const _onUpdate = TokenDocument.prototype._onUpdate;
		TokenDocument.prototype._onUpdate = function (changed, options, userId) {
			const movement = options?._movement?.[this.id];
			if ( movement && userId && (userId !== game.user.id) && !HideCursorTool.canSeeActivity(userId) ) {
				movement.showRuler = false;
			}
			return _onUpdate.call(this, changed, options, userId);
		};
	}

	/* -------------------------------------------- */
	/*  Toggle                                     */
	/* -------------------------------------------- */

	static async toggle() {
		if ( !this._isFeatureEnabled() ) return false;
		const hidden = !this.isHidden();
		await game.settings.set(Manager.id, `${KEY}.hidden`, hidden);

		if ( hidden ) {
			// A hidden GM vanishes for everyone, so send the "clear cursor" signal.
			// A hidden player stays visible to GMs, so broadcast their current
			// position: GMs keep rendering it, non-GM viewers re-evaluate and hide.
			game.user.broadcastActivity({cursor: game.user.isGM ? null : (canvas?.ready ? canvas.mousePosition ?? null : null)});
			ui.notifications.info(Manager.localize(`${KEY}.notify.hidden`));
		} else {
			if ( canvas?.ready ) game.user.broadcastActivity({cursor: canvas.mousePosition ?? null});
			ui.notifications.info(Manager.localize(`${KEY}.notify.visible`));
		}
		return hidden;
	}

	static async _toggleFromCommand(command) {
		if ( !this._isFeatureEnabled() ) return false;
		const hidden = command ? (command === "on") : !this.isHidden();
		if ( hidden === this.isHidden() ) {
			ui.notifications.info(
				hidden
					? Manager.localize(`${KEY}.notify.hidden`)
					: Manager.localize(`${KEY}.notify.visible`)
			);
			return hidden;
		}
		return this.toggle();
	}
}