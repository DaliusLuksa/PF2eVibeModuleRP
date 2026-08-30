import { Manager } from "../core/manager.js";

/**
 * Skip Dice So Nice 3D animation for GM-authored hidden rolls.
 *
 * Hidden = ChatMessage.whisper.length > 0 || blind === true
 * (covers gmroll / blindroll / selfroll; publicroll has whisper == []).
 * GM-authored = message.author.isGM (the User who created the message).
 *
 * DsN's official extension point is `diceSoNiceMessagePreProcess`:
 * `shouldInterceptMessage` builds `E = { willTrigger3DRoll: w }` and
 * calls `Hooks.callAll("diceSoNiceMessagePreProcess", id, E)`. Setting
 * `E.willTrigger3DRoll = false` prevents the `createChatMessage` hook from
 * ever setting `_dice3danimating` / calling `renderRolls`, so the chat
 * card is never hidden via `dsn-hide` and no 3D (and no ghost dice) is
 * shown on any client. The hook is called for both `createChatMessage`
 * and `updateChatMessage` (added rolls), so one handler covers all cases.
 *
 * This is a world-scope toggle (requires reload, consistent with other
 * tools). The "hidden from others" check uses `whisper` rather than
 * `isContentVisible` because the latter is per-viewer (GM sees their own
 * blind roll, players don't) — whisper is stable across clients.
 */
export class InstantHiddenRollsTool {
	static id = "instant-hidden-rolls";
	static category = "instant-hidden-rolls";
	static enabledDefault = true;

	static init() {
		Hooks.on("diceSoNiceMessagePreProcess", this._onPreProcess.bind(this));
	}

	static _onPreProcess(messageId, data) {
		try {
			if (!Manager.isEnabled(this.id)) return;
			// DsN not installed / disabled — nothing to suppress.
			if (!game.dice3d) return;
			if (!data || typeof data.willTrigger3DRoll !== "boolean") return;
			if (!data.willTrigger3DRoll) return;

			const msg = game.messages.get(messageId);
			if (!msg) return;

			// Only suppress GM-authored hidden rolls.
			const author = msg.author;
			if (!author?.isGM) return;

			const isHidden = (msg.whisper?.length > 0) || !!msg.blind;
			if (!isHidden) return;

			data.willTrigger3DRoll = false;
		} catch (error) {
			console.debug(`${Manager.id} | instant-hidden-rolls pre-process failed`, error);
		}
	}
}
