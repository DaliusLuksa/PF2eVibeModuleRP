import { Manager } from "../core/manager.js";

const SYSTEM_ID = "pf2e";
const CONDITION_SLUG = "invisible";
const FLAG_KEY = "invisibleToken";
const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION = "clearTargets";

export class InvisibleTokenTool {
	static id = "invisible-token";
	static category = "invisible-token";
	static enabledDefault = true;

	static settings = [
		{
			key: "autoHide",
			type: Boolean,
			default: true,
			scope: "world"
		}
	];

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		Hooks.on("createItem", this._onCreateItem.bind(this));
		Hooks.on("deleteItem", this._onDeleteItem.bind(this));
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		console.debug(`${Manager.id} | invisible-token hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Auto-hide / restore                         */
	/* -------------------------------------------- */

	/**
	 * When the Invisible condition is added to an actor, automatically hide
	 * every token that represents that actor - the same thing a GM would do
	 * manually with the token's Hide button.
	 */
	static _onCreateItem(item, options, userId) {
		try {
			if ( !this._shouldHandle(item) ) return;
			const actor = item.parent;
			if ( !actor?.id ) return;
			this._hideActorTokens(actor);
			this._clearActorTargets(actor);
		} catch ( error ) {
			console.error(`${Manager.id} | invisible-token auto-hide failed`, error);
		}
	}

	/**
	 * When the Invisible condition is removed from an actor, show the tokens
	 * that this module had hidden for it. Tokens hidden manually by the GM are
	 * left untouched.
	 */
	static _onDeleteItem(item, options, userId) {
		try {
			if ( !this._shouldHandle(item) ) return;
			const actor = item.parent;
			if ( !actor?.id ) return;
			this._showActorTokens(actor);
		} catch ( error ) {
			console.error(`${Manager.id} | invisible-token auto-show failed`, error);
		}
	}

	/* -------------------------------------------- */
	/*  Target clearing                            */
	/* -------------------------------------------- */

	/**
	 * Remove every user's targets on the now-invisible actor's tokens. The
	 * local (GM) user's own targets are released directly; every other client
	 * is asked to release theirs over the module socket, because in Foundry a
	 * user's targets can only be changed from their own client.
	 */
	static _clearActorTargets(actor) {
		this._releaseLocalTargets(actor.id);
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION, actorId: actor.id });
	}

	/**
	 * Release the local user's targets on tokens belonging to the given actor.
	 * Targets only exist while the canvas is ready.
	 */
	static _releaseLocalTargets(actorId) {
		if ( !canvas?.ready || !game.user?.targets?.size ) return;
		for ( const token of [...game.user.targets] ) {
			if ( token.actor?.id !== actorId ) continue;
			token.setTarget(false, { releaseOthers: false });
		}
	}

	/**
	 * Handle an incoming module socket message. Only GM senders are honored
	 * (the sender's user id is appended as the last listener argument).
	 */
	static _onSocketMessage(data, userId) {
		try {
			if ( data?.action !== SOCKET_ACTION || !data.actorId ) return;
			const sender = game.users.get(userId);
			if ( !sender?.isGM ) return;
			this._releaseLocalTargets(data.actorId);
		} catch ( error ) {
			console.error(`${Manager.id} | invisible-token socket handler failed`, error);
		}
	}

	/**
	 * Is this item the PF2e Invisible condition, and should the GM react to it?
	 */
	static _shouldHandle(item) {
		if ( game.system.id !== SYSTEM_ID ) return false;
		if ( !Manager.setting(this.id, "autoHide") ) return false;
		if ( item.type !== "condition" || item.slug !== CONDITION_SLUG ) return false;
		if ( !game.user.isGM ) return false;
		return true;
	}

	/**
	 * Hide all token documents of the given actor across every scene, flagging
	 * each one so it can be restored later.
	 */
	static async _hideActorTokens(actor) {
		for ( const scene of game.scenes ) {
			const updates = [];
			for ( const token of scene.tokens ) {
				if ( token.actor?.id !== actor.id ) continue;
				if ( token.hidden ) continue;
				updates.push({
					_id: token.id,
					hidden: true,
					[`flags.${Manager.id}.${FLAG_KEY}.autoHidden`]: true
				});
			}
			if ( updates.length ) {
				await scene.updateEmbeddedDocuments("Token", updates);
			}
		}
	}

	/**
	 * Restore tokens of the given actor that were auto-hidden by this module.
	 */
	static async _showActorTokens(actor) {
		for ( const scene of game.scenes ) {
			const updates = [];
			for ( const token of scene.tokens ) {
				if ( token.actor?.id !== actor.id ) continue;
				if ( !this._isAutoHidden(token) ) continue;
				updates.push({
					_id: token.id,
					hidden: false,
					[`flags.${Manager.id}.-=${FLAG_KEY}`]: null
				});
			}
			if ( updates.length ) {
				await scene.updateEmbeddedDocuments("Token", updates);
			}
		}
	}

	static _isAutoHidden(token) {
		return token.flags?.[Manager.id]?.[FLAG_KEY]?.autoHidden === true;
	}
}
