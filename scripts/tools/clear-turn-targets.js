import { Manager } from "../core/manager.js";

/**
 * Clear Targets at Turn End.
 *
 * Whenever a combatant's turn ends (the moment the next turn begins), every
 * user who controlled that combatant automatically loses all of their current
 * targets. This stops leftover multi-targets from AoE spells from leaking
 * into later actions: each turn starts clean, while targets made during
 * other actors' turns (e.g. pre-targeting before your own turn) are kept.
 *
 * Targeting in Foundry v14 is per-user ephemeral client state, so no socket
 * is needed: `combatTurnChange` fires on every client, and each client
 * releases its own targets if its user controlled the finished combatant.
 */
export class ClearTurnTargetsTool {
	static id = "clear-turn-targets";
	static category = "clear-turn-targets";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		Hooks.on("combatTurnChange", this._onTurnChange.bind(this));
		console.debug(`${Manager.id} | clear-turn-targets hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Turn handling                               */
	/* -------------------------------------------- */

	/**
	 * `combatTurnChange` args are CombatHistoryData state objects
	 * (`{round, turn, combatantId, tokenId}`), NOT documents - resolve the
	 * combatant that just finished via its id, then release the local
	 * user's targets when they control it.
	 */
	static _onTurnChange(combat, previous) {
		try {
			const combatant = combat?.combatants?.get(previous?.combatantId);
			const actor = combatant?.actor;
			if (!actor) return;
			if (!actor.testUserPermission(game.user, "OWNER")) return;
			this._releaseLocalTargets();
		} catch (error) {
			console.error(`${Manager.id} | clear-turn-targets failed`, error);
		}
	}

	/**
	 * Release every target of the local user. Targets only exist while the
	 * canvas is ready; copy the Set before mutating it.
	 */
	static _releaseLocalTargets() {
		if (!canvas?.ready || !game.user?.targets?.size) return;
		for (const token of [...game.user.targets]) {
			token.setTarget(false, { releaseOthers: false });
		}
	}
}
