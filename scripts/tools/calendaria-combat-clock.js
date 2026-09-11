import { Manager } from "../core/manager.js";

/**
 * Calendaria Combat Clock — tri-state combat time for the real-time clock.
 *
 * Modes:
 *  - pause    → clock stops during combat, 0s advance (native 6s is blocked)
 *  - realtime → clock keeps running during combat (Calendaria's native flag = true)
 *  - rounds   → clock PAUSED during combat but we synthesize secondsPerRound per round (6s)
 *
 * Also adds hudSeconds toggle → forces calendaria displayFormats.hudTime to time24Sec.
 * Implemented as a VibeModuleRP patch so Data/modules/calendaria is never edited.
 */
export class CalendariaCombatClockTool {
	static id = "calendaria-combat-clock";
	static category = "calendaria-combat-clock";
	static enabledDefault = true;

	static settings = [
		{
			key: "mode",
			type: String,
			default: "rounds",
			scope: "world",
			config: true,
			choices: {
				pause: "Pause during combat (no time passes)",
				realtime: "Real-time during combat (wall-clock)",
				rounds: "Per-round (6 s per round, no drift)"
			},
			requiresReload: false,
			onChange: () => CalendariaCombatClockTool._onModeChanged()
		},
		{
			key: "hudSeconds",
			type: Boolean,
			default: false,
			scope: "world",
			config: true,
			requiresReload: false,
			onChange: () => CalendariaCombatClockTool._applyHudSeconds()
		}
	];

	static _hudBackup = null;
	static _lastRound = null;

	static init() {}

	static ready() {
		if (!game.modules.get("calendaria")?.active) return;
		this._syncCalendariaFlag();
		this._applyHudSeconds();

		Hooks.on("combatStart", this._onCombatStart.bind(this));
		Hooks.on("combatRound", this._onCombatRound.bind(this));
		Hooks.on("combatTurn", this._onCombatTurn.bind(this));
		Hooks.on("updateCombat", this._onUpdateCombat.bind(this));
		Hooks.on("deleteCombat", this._onDeleteCombat.bind(this));
	}

	static get _mode() {
		try { return game.settings.get(Manager.id, `${this.id}.mode`) ?? "pause"; } catch { return "pause"; }
	}
	static get _hudSeconds() {
		try { return !!game.settings.get(Manager.id, `${this.id}.hudSeconds`); } catch { return false; }
	}
	static get _enabled() {
		return Manager.isEnabled(this.id);
	}

	static _onModeChanged() {
		this._syncCalendariaFlag();
	}

	static _syncCalendariaFlag() {
		if (!game.modules.get("calendaria")?.active) return;
		try {
			const mode = this._mode;
			const shouldRun = mode === "realtime";
			const current = game.settings.get("calendaria", "clockRunDuringCombat");
			if (current !== shouldRun && game.user.isGM) {
				game.settings.set("calendaria", "clockRunDuringCombat", shouldRun).catch(e => console.warn(`${Manager.id} | could not sync clockRunDuringCombat`, e));
			}
		} catch (e) {
			console.warn(`${Manager.id} | calendaria sync failed`, e);
		}
	}

	static async _applyHudSeconds() {
		if (!game.modules.get("calendaria")?.active) return;
		if (!game.user.isGM) return;
		try {
			const wantSeconds = this._hudSeconds;
			const formats = game.settings.get("calendaria", "displayFormats");
			if (!formats || typeof formats !== "object") return;
			if (!this._hudBackup) {
				this._hudBackup = foundry.utils.deepClone(formats.hudTime ?? { gm: "time24", player: "time24" });
			}
			const hud = formats.hudTime;
			if (!hud) return;
			const target = wantSeconds ? "time24Sec" : this._hudBackup.gm ?? "time24";
			const playerTarget = wantSeconds ? "time24Sec" : this._hudBackup.player ?? "time24";
			if (hud.gm === target && hud.player === playerTarget) return;
			const next = foundry.utils.deepClone(formats);
			next.hudTime = { gm: target, player: playerTarget };
			await game.settings.set("calendaria", "displayFormats", next);
			try { Hooks.callAll("calendaria.displayFormatsChanged"); } catch {}
		} catch (e) {
			console.warn(`${Manager.id} | hudSeconds patch failed`, e);
		}
	}

	static _secondsPerRound() {
		try {
			const cal = game.time?.calendar;
			if (cal?.secondsPerRound) return cal.secondsPerRound;
			if (cal?.days?.secondsPerRound) return cal.days.secondsPerRound;
			return CONFIG.time?.roundTime ?? 6;
		} catch { return 6; }
	}

	static _onCombatStart(combat) {
		this._lastRound = combat?.round ?? 0;
	}

	static _onCombatRound(combat, updateData, updateOptions) {
		if (!this._enabled) return;
		const mode = this._mode;
		if (mode === "realtime") return;
		if (!game.user.isActiveGM) return;
		if (updateOptions?.worldTime) updateOptions.worldTime.delta = 0;
	}

	static _onCombatTurn(combat, updateData, updateOptions) {
		if (!this._enabled) return;
		if (this._mode === "realtime") return;
		if (!game.user.isActiveGM) return;
		if (updateOptions?.worldTime?.delta) updateOptions.worldTime.delta = 0;
	}

	static async _onUpdateCombat(combat, changed, options, userId) {
		if (!this._enabled) return;
		if (this._mode !== "rounds") return;
		if (!game.user.isActiveGM) return;
		if (!("round" in changed)) return;
		const newRound = changed.round;
		if (!combat?.started) return;
		if (newRound <= 1 && this._lastRound === null) {
			this._lastRound = newRound;
			return;
		}
		if (this._lastRound !== null && newRound <= this._lastRound) {
			this._lastRound = newRound;
			return;
		}
		this._lastRound = newRound;
		if (newRound === 1) return;
		const secs = this._secondsPerRound();
		try {
			await game.time.advance(secs);
		} catch (e) {
			console.warn(`${Manager.id} | round advance failed`, e);
		}
	}

	static _onDeleteCombat(combat) {
		this._lastRound = null;
	}
}
