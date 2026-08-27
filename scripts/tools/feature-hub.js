import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";
import { ActionTrackerTool } from "./action-tracker.js";
import { RollCounterTool } from "./roll-counter.js";
import { AreaEffectsTool } from "./area-effects.js";
import { HideCursorTool } from "./hide-cursor.js";
import { EffectAutomatorTool } from "./effect-automator.js";

const MODULE_ROOT = "modules/pf2e-vibemodulerp";

/**
 * Module Hub ("Vibe Features").
 *
 * A single window that lists the enabled features of this module as buttons, so
 * you can see what is available and open any of them in one click. It has its own
 * scene-controls button and a keybind (Ctrl+Alt+H). The window is available to
 * everyone, but only lists features the current user is allowed to use: e.g. the
 * GM-only Persistent Area Effects button is hidden from players.
 *
 * The feature set is a registry (`_features`) of `{ id, title, icon, visible, open }`;
 * each entry points at the feature's own tool, so the hub stays a thin launcher.
 */
export class FeatureHubTool {
	static id = "feature-hub";
	static category = "feature-hub";
	static enabledDefault = true;

	static _window = null;

	/** Registry of launcher entries. `visible` is evaluated per user at render. */
	static _features = [
		{
			id: "area-effects",
			title: () => Manager.localize("areaEffects.title"),
			icon: "fa-solid fa-circle-dot",
			enabled: () => Manager.isEnabled(AreaEffectsTool.id),
			visible: () => true,
			open: () => AreaEffectsTool._toggleWindow()
		},
		{
			id: "roll-counter",
			title: () => Manager.localize("rollCounter.title"),
			icon: "fa-solid fa-dice-d20",
			enabled: () => Manager.isEnabled(RollCounterTool.id),
			visible: () => true,
			open: () => RollCounterTool._toggleWindow()
		},
		{
			id: "action-tracker",
			title: () => Manager.localize("actionTracker.title"),
			icon: "fa-solid fa-stopwatch",
			enabled: () => Manager.isEnabled(ActionTrackerTool.id),
			visible: () => true,
			open: () => ActionTrackerTool._toggleWindow()
		},
		{
			id: "hide-cursor",
			title: () => Manager.localize("featureHub.toggleInvisibility"),
			icon: "fa-solid fa-eye-slash",
			// Master switch (invisible-token) + this tool's own setting must both be on.
			enabled: () => HideCursorTool._isFeatureEnabled(),
			// Invisibility is a per-user toggle (not a window), so this entry runs
			// the toggle action rather than opening a window.
			visible: () => true,
			open: () => HideCursorTool.toggle()
		},
		{
			id: "effect-automator",
			title: () => Manager.localize("effectAutomator.title"),
			icon: "fa-solid fa-robot",
			enabled: () => Manager.isEnabled(EffectAutomatorTool.id),
			visible: () => game.user.isGM,
			open: () => EffectAutomatorTool._toggleWindow()
		}
	];

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static init() {
		game.keybindings.register(Manager.id, "openFeatureHub", {
			name: Manager.localize("featureHub.keybindName"),
			hint: Manager.localize("featureHub.keybindHint"),
			uneditable: [],
			editable: [{ key: "KeyH", modifiers: ["Control", "Alt"] }],
			onDown: () => this._toggleWindow(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
		});

		// The hub's scene-controls button must be registered at `init` (not
		// `ready`) because `SceneControls#_prepareControls` fires the
		// `getSceneControlButtons` hook only once, during world setup.
		Hooks.on("getSceneControlButtons", this._getSceneControlButtons.bind(this));
	}

	/* -------------------------------------------- */
	/*  Scene control button                        */
	/* -------------------------------------------- */

	static _getSceneControlButtons(controls) {
		controls["vibe-features"] = {
			name: "vibe-features",
			order: 9,
			title: Manager.localize("featureHub.controlTitle"),
			icon: "fa-solid fa-table-cells-large",
		tools: {
			hub: {
				name: "hub",
				title: Manager.localize("featureHub.controlTitle"),
				icon: "fa-solid fa-table-cells-large",
				button: true,
				// Only OPEN on activation. Scene controls fire this onChange again
				// with `active=false` when you switch to another control (e.g. Token
				// Controls), which would toggle the hub closed — we only open, never
				// close, so the hub stays up while you work on the map.
				onChange: (event, active) => {
					if (active) this._openWindow();
				}
			}
		},
		activeTool: "hub"
	};
	}

	/* -------------------------------------------- */
	/*  Window management                           */
	/* -------------------------------------------- */

	static _openWindow() {
		if (!this._window) this._window = new FeatureHubWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the feature hub`, error)
		);
	}

	static _closeWindow() {
		if (this._window) {
			this._window.close().catch(() => null);
			this._window = null;
		}
	}

	static _toggleWindow() {
		if (this._window?.rendered) this._closeWindow();
		else this._openWindow();
	}

	/* -------------------------------------------- */
	/*  Registry helpers                            */
	/* -------------------------------------------- */

	/** Features enabled by settings and visible to the current user. */
	static _available() {
		return this._features.filter((entry) => {
			if (!entry.enabled?.()) return false;
			return entry.visible?.() ?? true;
		});
	}

	/* -------------------------------------------- */
	/*  Context                                     */
	/* -------------------------------------------- */

	static _context() {
		return {
			features: this._available(),
			i18n: (key) => Manager.localize(`featureHub.${key}`)
		};
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class FeatureHubWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(
		foundry.applications.api.ApplicationV2
	)
) {
	static DEFAULT_OPTIONS = {
		id: "feature-hub",
		classes: ["vibe-feature-hub"],
		position: { width: 340 },
		window: {
			icon: "fa-solid fa-table-cells-large",
			resizable: true,
			minimizable: true
		},
		actions: {
			openFeature(event, target) {
				const id = target?.dataset?.id;
				const entry = FeatureHubTool._features.find((f) => f.id === id);
				entry?.open?.();
			}
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/feature-hub.hbs`, root: true }
	};

	get title() {
		return Manager.localize("featureHub.title");
	}

	_prepareContext(options) {
		return FeatureHubTool._context();
	}
}
