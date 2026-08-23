import { Manager } from "../core/manager.js";

const CONDITION_SLUG = "frightened";
/** Feats whose text reduces Frightened by 2 at the end of the turn instead of 1. */
const DOUBLE_STEP_FEATS = ["dwarven-doughtiness", "calm-and-centered"];

/**
 * Frightened Decay.
 *
 * PF2e rules: at the end of each of your turns, your Frightened value
 * decreases by 1 (ending at 0). The installed system has no automation for
 * this, so this tool does it: when a combatant's turn ends, their actor's
 * Frightened condition is decreased via the system's own
 * `actor.decreaseCondition()` API (which decrements the value and removes
 * the condition when it reaches 0).
 *
 * Uses the system's `pf2e.endTurn` hook (combatant, encounter, userId),
 * which pf2e emits from inside `Combatant#onEndTurn` - the real end-of-turn
 * lifecycle step, so timing is exact and skipped combatants don't tick.
 * Only the GM's client acts: a single writer avoids double-decreases and
 * sidesteps ownership limits on player-owned actors. Locked conditions
 * (copies managed by effect rule elements) and dead actors are skipped -
 * mirroring the system's own end-of-turn processing.
 */
export class FrightenedDecayTool {
	static id = "frightened-decay";
	static category = "frightened-decay";
	static enabledDefault = true;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		Hooks.on("pf2e.endTurn", this._onEndTurn.bind(this));
		console.debug(`${Manager.id} | frightened-decay hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Turn handling                               */
	/* -------------------------------------------- */

	/** `pf2e.endTurn` passes the combatant whose turn just ended. */
	static async _onEndTurn(combatant) {
		try {
			if (!game.user.isGM) return;
			const actor = combatant?.actor;
			if (!actor || actor.isDead) return;
			await this._decreaseFrightened(actor);
		} catch (error) {
			console.error(`${Manager.id} | frightened-decay failed`, error);
		}
	}

	/**
	 * Decrease the actor's Frightened value by one step (two for feats like
	 * Dwarven Doughtiness / Calm and Centered), stopping if the condition is
	 * gone before all steps run. `decreaseCondition` resolves the current
	 * condition per call, so removal-at-zero is handled mid-sequence.
	 */
	static async _decreaseFrightened(actor) {
		const condition = actor.getCondition?.(CONDITION_SLUG);
		const value = Number(condition?.value ?? 0);
		if (!condition || condition.isLocked || value <= 0) return;
		const steps = DOUBLE_STEP_FEATS.some((slug) => actor.items.some((item) => item.type === "feat" && item.slug === slug))
			? 2
			: 1;
		for (let i = 0; i < steps; i++) {
			if (!actor.getCondition?.(CONDITION_SLUG)) break;
			await actor.decreaseCondition(CONDITION_SLUG);
		}
	}
}
