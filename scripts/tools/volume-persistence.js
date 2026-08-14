import { Manager } from "../core/manager.js";

/**
 * The three core "global volume" client settings exposed by the volume
 * sliders in the Playlists sidebar tab.
 */
const VOLUME_KEYS = ["globalPlaylistVolume", "globalAmbientVolume", "globalInterfaceVolume"];
const BACKUP_KEY = "backup";

/**
 * Core Foundry stores client-scope settings (including the volume sliders) in
 * `window.localStorage`, which is scoped per browser origin. When the origin
 * changes between sessions - e.g. a Cloudflare Quick Tunnel URL that rotates
 * on every restart - that storage is empty and the volumes reset to defaults.
 *
 * This tool mirrors the three volume values into a user-scope setting in the
 * world database (which survives any browser-storage loss) and re-applies
 * them on load.
 */
export class VolumePersistenceTool {
	static id = "volume-persistence";
	static category = "volume-persistence";
	static enabledDefault = true;

	static settings = [
		{
			key: BACKUP_KEY,
			type: Object,
			default: {},
			scope: "user",
			config: false
		}
	];

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		// Mirrors every core client-setting save, including the volume sliders.
		Hooks.on("clientSettingChanged", this._onClientSettingChanged.bind(this));
		// Fallback capture in case the core save handler never fires.
		document.addEventListener("change", this._onSliderChange.bind(this));
		// Restore any volumes lost with the previous session's browser storage.
		this._restoreBackup();
		console.debug(`${Manager.id} | volume-persistence hooks installed`);
	}

	/* -------------------------------------------- */
	/*  Capture                                    */
	/* -------------------------------------------- */

	/**
	 * Core fires `clientSettingChanged` whenever a client-scope setting is
	 * saved, with the stored (post-conversion) value.
	 */
	static _onClientSettingChanged(key, value) {
		if ( !VOLUME_KEYS.includes(key) ) return;
		this._saveVolume(key, value);
	}

	/**
	 * Direct fallback: read the slider directly if its change never reaches
	 * the core save handler. The slider carries the raw input scale, so it is
	 * converted the same way core does before storing.
	 */
	static _onSliderChange(event) {
		const slider = event.target;
		if ( !slider.matches?.(".global-volume-slider") ) return;
		if ( !VOLUME_KEYS.includes(slider.name) ) return;
		this._saveVolume(slider.name, foundry.audio.AudioHelper.inputToVolume(slider.value));
	}

	static _saveVolume(key, value) {
		const backup = { ...(this._getBackup() ?? {}), [key]: value };
		Promise.resolve(game.settings.set(Manager.id, `${this.id}.${BACKUP_KEY}`, backup)).catch(error => {
			console.debug(`${Manager.id} | volume-persistence backup failed`, error);
		});
	}

	/* -------------------------------------------- */
	/*  Restore                                    */
	/* -------------------------------------------- */

	/**
	 * If a backup exists for a volume and the current (browser-stored) value
	 * differs, re-apply it. Core's own onChange handlers then update the audio
	 * contexts and re-render the sliders.
	 */
	static _restoreBackup() {
		const backup = this._getBackup() ?? {};
		for ( const key of VOLUME_KEYS ) {
			const stored = backup[key];
			if ( typeof stored !== "number" ) continue;
			if ( game.settings.get("core", key) === stored ) continue;
			game.settings.set("core", key, stored);
		}
	}

	static _getBackup() {
		return game.settings.get(Manager.id, `${this.id}.${BACKUP_KEY}`) ?? {};
	}
}
