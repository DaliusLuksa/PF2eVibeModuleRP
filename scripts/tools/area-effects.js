import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";

const BEHAVIOR_TYPE = `${Manager.id}.areaEffects`;
// Core v14 region behavior that makes the ruler cost extra movement inside the
// region (`system.difficulties.walk`: 2 = difficult terrain, 3 = greater).
const TERRAIN_BEHAVIOR_TYPE = "modifyMovementCost";
const MODULE_ROOT = "modules/pf2e-vibemodulerp";
const SPELL_EFFECTS_CONFIG = `${MODULE_ROOT}/data/spell-effects.json`;
const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_APPLY_REQUEST = "areaEffectApplyRequest";
const SOCKET_APPLY_RESULT = "areaEffectApplyResult";
const SOCKET_REMOVE_REQUEST = "areaEffectRemoveRequest";
const SOCKET_REMOVE_RESULT = "areaEffectRemoveResult";
const SOCKET_PLACE_REQUEST = "areaEffectPlaceRequest";
const SOCKET_PLACE_RESULT = "areaEffectPlaceResult";
const SOCKET_OP_REQUEST = "areaEffectOpRequest";
const SOCKET_OP_RESULT = "areaEffectOpResult";
const GM_RESPONSE_TIMEOUT_MS = 20000;

/**
 * Persistent Area Effects.
 *
 * Creates "persistent damage"-style areas: you choose a template shape and size
 * in a dedicated window, press "Place", then click the map as with any template.
 * The placed region carries a custom `vibeAreaEffect` region behavior that
 * automatically applies the configured PF2e spell-effect Items to any token that
 * enters it. A mode flag decides whether the applied effects are bound to the
 * area (applied on entry, removed on leaving — "While inside") or applied once on
 * entry and left to run their natural duration ("Once on entry").
 *
 * The engine drives all of the enter/exit bookkeeping: because v14 merged
 * MeasuredTemplates into RegionDocuments, a placed region is a Region and the
 * behavior receives `tokenEnter`/`tokenExit` events for movement, teleports,
 * spawns/deletes, boundary changes, and (critically) for every token already
 * inside the moment the behavior is created. The tool only handles the PF2e
 * effect application itself and reuses the module's GM-routing socket pattern to
 * stay within ownership limits on unowned actors.
 */
export class AreaEffectsTool {
	static id = "area-effects";
	static category = "area-effects";
	static enabledDefault = true;

	/** Pending GM effect-apply/remove requests, keyed by request id. */
	static _pendingGmRequests = new Map();

	/** The single open management window instance. */
	static _window = null;

	/** Lookup cache for the editable spells -> effects JSON config. */
	static _spellEffectsConfig = {};

	/** Shape selector options: key -> {label key, icon}. */
	static SHAPES = {
		burst: { key: "shapeBurst", icon: "fas fa-circle" },
		cone: { key: "shapeCone", icon: "fas fa-circle-quarter" },
		line: { key: "shapeLine", icon: "fas fa-horizontal-rule" },
		cube: { key: "shapeCube", icon: "fas fa-square" }
	};

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static init() {
		// Register the region behavior type on every client so region/behavior
		// documents using it validate and dispatch correctly. This must happen at
		// `init` (before world documents load), mirroring how pf2e registers its
		// own region behavior types. The behavior `type` is module-qualified
		// (`pf2e-vibemodulerp.areaEffects`), which lets a module extend a Document
		// class via its own `documentTypes` manifest field (declared in module.json
		// so `game.model.RegionBehavior` is seeded on the server); here we provide
		// the actual TypeDataModel for that type.
		const models = game.modules.get(Manager.id) ? (CONFIG.RegionBehavior.dataModels ?? {}) : null;
		if ( models ) {
			models[BEHAVIOR_TYPE] = VibeAreaEffectRegionBehaviorType;
			CONFIG.RegionBehavior.dataModels = models;
			if ( CONFIG.RegionBehavior.typeLabels ) {
				CONFIG.RegionBehavior.typeLabels[BEHAVIOR_TYPE] = `${Manager.id}.areaEffects.behaviorLabel`;
			}
			if ( CONFIG.RegionBehavior.typeHints ) {
				CONFIG.RegionBehavior.typeHints[BEHAVIOR_TYPE] = `${Manager.id}.areaEffects.behaviorHint`;
			}
			if ( CONFIG.RegionBehavior.typeIcons ) {
				CONFIG.RegionBehavior.typeIcons[BEHAVIOR_TYPE] = "fa-solid fa-circle-dot";
			}
		}

		game.keybindings.register(Manager.id, "openAreaEffects", {
			name: Manager.localize("areaEffects.keybindName"),
			hint: Manager.localize("areaEffects.keybindHint"),
			uneditable: [],
			editable: [{ key: "KeyA", modifiers: ["Control", "Alt"] }],
			onDown: () => this._toggleWindow(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
		});
	}

	static ready() {
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		// Tick down limited-duration areas on combat turn changes (GM is the
		// single writer; the region/behavior DB sync propagates state to all).
		Hooks.on("combatTurnChange", this._onCombatTurnChange.bind(this));
		// Re-render the window on any client whose open window lists a region that
		// is created/deleted/edited (so areas placed by others appear immediately).
		// `createRegion` fires before our behavior is attached, so we also listen to
		// behavior creation/deletion to catch the moment `_isOwnRegion` becomes true.
		Hooks.on("createRegion", this._onRegionChanged.bind(this));
		Hooks.on("updateRegion", this._onRegionChanged.bind(this));
		Hooks.on("deleteRegion", this._onRegionChanged.bind(this));
		Hooks.on("createRegionBehavior", (behavior) => this._onRegionChanged(behavior?.region));
		Hooks.on("updateRegionBehavior", (behavior) => this._onRegionChanged(behavior?.region));
		Hooks.on("deleteRegionBehavior", (behavior) => this._onRegionChanged(behavior?.region));
		// Re-render so the "tokens inside" count updates live when a token moves
		// in/out (or is created/deleted inside). `updateToken` fires on every client
		// after the DB sync, by which point `region.tokens` reflects the new state.
		Hooks.on("updateToken", (token, change) => {
			if (!this._window?.rendered) return;
			if (!this._positionChanged(change)) return;
			// Debounced so a long token drag coalesces into a couple of re-renders.
			this._tokenRender ??= foundry.utils.debounce(() => this._renderWindow(), 120);
			this._tokenRender();
		});
		Hooks.on("createToken", () => this._renderTokenCountIfOpen());
		Hooks.on("deleteToken", () => this._renderTokenCountIfOpen());
		this._patchSpellTemplateButton();
		this._loadSpellEffectsConfig();
		console.debug(`${Manager.id} | hooks installed`);
	}

	/**
	 * Route a spell's "Place ... template" button through the Persistent Area
	 * Effects system. The pf2e `SpellPF2e#placeTemplate` reads the spell's
	 * `system.area` ({type, value}) and places a plain region via
	 * `canvas.regions.placeRegion`. We wrap it so that, when Area Effects is
	 * enabled, the button instead opens the Area Effects window pre-filled with
	 * the spell's shape and size (you then set duration + effects and press Place).
	 */
	static _patchSpellTemplateButton() {
		const spellClass = CONFIG.PF2E?.Item?.documentClasses?.spell;
		const proto = spellClass?.prototype;
		if (!proto?.placeTemplate) return;
		const original = proto.placeTemplate;
		proto.placeTemplate = function (...args) {
			// Only intercept when the Area Effects tool is enabled; otherwise keep
			// the original plain-template behavior.
			if (!Manager.isEnabled(AreaEffectsTool.id)) {
				return original.apply(this, args);
			}
			const area = this?.system?.area;
			if (!area || !area.type) {
				return original.apply(this, args);
			}
			// Build a pf2e origin payload so Automated Animations can resolve the
			// spell Item (flags.pf2e.origin.uuid) and play its recipe (e.g. the
			// Entangling Flora vine animation) when the area is eventually placed.
			const origin = this?.getOriginData?.() ?? {};
			const pf2eFlags = {
				origin: {
					uuid: this.uuid,
					name: this.name,
					slug: this.slug,
					traits: foundry.utils.deepClone(this.system?.traits?.value ?? []),
					...origin
				},
				areaShape: area.type
			};
			// Auto-populate effects (and optional duration/mode/terrain/window)
			// from the editable JSON config when this spell has an entry.
			const preset = AreaEffectsTool._normalizeConfigEntry(AreaEffectsTool._spellEffectsConfig[this.name]);
			AreaEffectsTool.openPrefilled(AreaEffectsTool._kindFromAreaType(area.type), area.value, pf2eFlags, preset);
			return null;
		};
	}

	/** Map a pf2e area shape type to a Persistent Area Effects shape kind. */
	static _kindFromAreaType(type) {
		switch (type) {
			case "cone": return "cone";
			case "line": return "line";
			case "cube":
			case "square": return "cube";
			case "emanation": return "emanation";
			case "burst":
			case "cylinder":
			default: return "burst";
		}
	}

	/**
	 * Read the editable spells->effects JSON config from disk and cache it.
	 * Fetched once at `ready`; a plain `.json` file is served as-is (only
	 * `.db`/`.ldb` compendiums become LevelDB).
	 */
	static async _loadSpellEffectsConfig() {
		try {
			const res = await fetch(SPELL_EFFECTS_CONFIG);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			this._spellEffectsConfig = (json && typeof json === "object") ? json : {};
		} catch (error) {
			console.warn(`${Manager.id} | could not load spell-effects config`, error);
			this._spellEffectsConfig = {};
		}
		return this._spellEffectsConfig;
	}

	/** Normalize a config entry: a UUID array => {effects}, or a full object. */
	static _normalizeConfigEntry(entry) {
		if (Array.isArray(entry)) return { effects: entry };
		if (entry && typeof entry === "object") {
			return {
				effects: Array.isArray(entry.effects) ? entry.effects : [],
				mode: entry.mode === "once" ? "once" : "inside",
				duration: Math.max(0, Number(entry.duration) || 0),
				durationMode: entry.durationMode === "combat" ? "combat" : "caster",
				terrain: entry.terrain === "greater" ? "greater" : entry.terrain === "difficult" ? "difficult" : "",
				window: (entry.window === "instant" || entry.tab === "instant") ? "instant" : "persistent"
			};
		}
		return null;
	}

	/**
	 * Open the Area Effects window with the create-form shape + size pre-filled
	 * (both tabs share the spell's geometry). The JSON preset additionally fills
	 * the persistent form's fields — or, when it targets the instant tab, that
	 * tab's effect list — and selects which tab is active.
	 */
	static openPrefilled(kind, size, pf2eFlags = null, preset = null) {
		if (!this._window) this._window = new AreaEffectsWindow();
		for (const draft of [this._window._draft, this._window._instantDraft]) {
			if (!draft) continue;
			draft.kind = kind ?? "burst";
			draft.size = Math.max(5, Number(size) || 5);
			// Carry the source spell's pf2e flags so the placed region animates.
			draft._pf2eFlags = pf2eFlags;
		}
		// Carry the spell's name into the persistent form's Name field.
		this._window._draft.name = pf2eFlags?.origin?.name ?? "";
		if (preset) {
			const p = this._window._draft;
			p.effects = Array.from(preset.effects ?? []);
			p.mode = preset.mode ?? "inside";
			p.duration = preset.duration ?? 0;
			p.durationMode = preset.durationMode ?? "caster";
			p.terrain = preset.terrain ?? "";
			if (preset.window === "instant") {
				this._window._instantDraft.effects = Array.from(preset.effects ?? []);
			}
			// Select the configured tab before rendering.
			this._window.tabGroups.main = preset.window;
		}
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the area effects window`, error)
		);
	}

	/** Re-render the window if it is open and the changed region is one of ours. */
	static _onRegionChanged(region) {
		if (!this._window?.rendered) return;
		if (!region || !this._isOwnRegion(region)) return;
		this._renderWindow();
	}

	/** Whether a token update may have changed region membership. */
	static _positionChanged(change) {
		if (!change) return false;
		return ["x", "y", "elevation", "width", "height", "shape"].some((k) => k in change);
	}

	/** Re-render the window if open and there is at least one area on the scene. */
	static _renderTokenCountIfOpen() {
		if (!this._window?.rendered) return;
		this._renderWindow();
	}

	/* -------------------------------------------- */
	/*  Window management                           */
	/* -------------------------------------------- */

	static _openWindow() {
		if (!this._window) this._window = new AreaEffectsWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open the area effects window`, error)
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

	static _renderWindow() {
		if (this._window?.rendered) {
			this._window.render().catch((error) =>
				console.warn(`${Manager.id} | could not re-render the area effects window`, error)
			);
		}
	}

	/* -------------------------------------------- */
	/*  Shape helpers                               */
	/* -------------------------------------------- */

	/** Pixels per grid unit: how many pixels one foot (of distance) takes. */
	static _feetPixels(feet) {
		const grid = canvas.grid ?? foundry.documents.BaseScene.defaultGrid;
		return feet * (grid.size / grid.distance);
	}

	/**
	 * Build a region shape data object from the window config. `kind` is one of
	 * the keys in `SHAPES`; `size` is the value in feet.
	 */
	static _shapeData(kind, size, x, y) {
		const px = this._feetPixels(size);
		switch (kind) {
			case "cone":
				return { type: "cone", x, y, radius: px, angle: 90, rotation: 0, curvature: "round" };
			case "line":
				return { type: "line", x, y, length: px, width: canvas.dimensions?.size ?? 100, rotation: 0 };
		case "cube":
			return { type: "rectangle", x, y, width: px, height: px, rotation: 0 };
		case "burst":
		default:
			return { type: "circle", x, y, radius: px };
		}
	}

	/** A human-readable summary for the UI, e.g. "Burst (20 ft)". */
	static _shapeLabel(kind, size) {
		const shape = this.SHAPES[kind] ?? this.SHAPES.burst;
		return `${Manager.localize(`areaEffects.${shape.key}`)} (${size} ft)`;
	}

	/** Human-readable duration text, e.g. "2 rounds (combat)" or "Unlimited". */
	static _durationText(sys) {
		const duration = Number(sys?.duration ?? 0);
		if (duration <= 0) return Manager.localize("areaEffects.unlimited");
		const mode = sys?.durationMode ?? "combat";
		const label = mode === "caster" ? Manager.localize("areaEffects.trackCasterShort")
			: Manager.localize("areaEffects.trackCombatShort");
		const remaining = Number(sys?.roundsLeft ?? duration);
		return Manager.localize("areaEffects.durationText", {
			rounds: Math.max(0, remaining),
			mode: label
		});
	}

	/* -------------------------------------------- */
	/*  Placement                                   */
	/* -------------------------------------------- */

	/**
	 * Place a new area at the cursor using Foundry's native region placement
	 * "usual flow" (drag/click to position, mouse-wheel to rotate for cones),
	 * then attach the `vibeAreaEffect` behavior to the created region.
	 *
	 * Non-GMs cannot create a Region that carries a Behavior (core 'Region#canCreate'
	 * requires a GM, and 'RegionBehavior#canUserCreate' is GM-only), so a non-GM
	 * performs the interactive placement but asks a connected GM to build the
	 * region + behavior over the module socket (the standard GM-routing pattern).
	 */
	/** Map a terrain setting ("difficult"/"greater") to a walk movement cost. */
	static _walkDifficulty(terrain) {
		return terrain === "greater" ? 3 : terrain === "difficult" ? 2 : 1;
	}

	/**
	 * The behavior documents for a new area: the effect-applying behavior plus,
	 * when a terrain setting is chosen, a core `modifyMovementCost` behavior that
	 * makes the ruler cost extra movement inside the area (walk only, so flying
	 * creatures are unaffected; crawl/climb inherit walk and jump derives from
	 * max(walk, fly), matching the PF2e difficult-terrain rules).
	 */
	static _behaviorDocs(system, walkDifficulty) {
		const behaviors = [{
			name: Manager.localize("areaEffects.behaviorLabel"),
			type: BEHAVIOR_TYPE,
			system,
			disabled: false
		}];
		if (walkDifficulty > 1) {
			behaviors.push({
				name: Manager.localize(walkDifficulty > 2 ? "areaEffects.terrainGreater" : "areaEffects.terrainDifficult"),
				type: TERRAIN_BEHAVIOR_TYPE,
				system: { difficulties: { walk: walkDifficulty } },
				disabled: false
			});
		}
		return behaviors;
	}

	static async place(config) {
		if (!canvas.ready) return;
		const kind = config.kind ?? "burst";
		const size = Math.max(5, Number(config.size) || 5);
		const { x, y } = canvas.mousePosition;
		const gmOnly = game.user.isGM && !!config.gmOnly;
		const flags = {
			[Manager.id]: {
				areaEffects: true,
				author: game.user.id,
				private: !!config.isPrivate,
				gmOnly
			}
		};
		// If this area came from a spell's "Place template" button, carry the
		// source spell's pf2e flags (origin.uuid/name/slug/traits + areaShape) so
		// Automated Animations resolves the Item and plays its template recipe.
		if (config.pf2eFlags) foundry.utils.mergeObject(flags, { pf2e: config.pf2eFlags }, { overwrite: false });
		const data = {
			name: config.name || Manager.localize("areaEffects.defaultName"),
			shapes: [this._shapeData(kind, size, x, y)],
			color: game.user.color?.toString() ?? "#000000",
			highlightMode: "coverage",
			displayMeasurements: true,
			visibility: gmOnly ? CONST.REGION_VISIBILITY.GAMEMASTER : CONST.REGION_VISIBILITY.ALWAYS,
			flags
		};
		const system = this._behaviorSystem(config);
		const walkDifficulty = this._walkDifficulty(config.terrain);

		if (game.user.isGM) {
			// GM: create directly (placeRegion awaits the user's click).
			const region = await canvas.regions.placeRegion(data);
			if (!region) return { cancelled: true }; // right-click / dismiss — silent
			await region.createEmbeddedDocuments("RegionBehavior", this._behaviorDocs(system, walkDifficulty));
			return region;
		}

		// Non-GM: perform the interactive placement locally but defer creation to a
		// connected GM. `create:false` runs the draw-and-click flow and returns the
		// (un-persisted) RegionDocument without permission checks.
		const drawn = await canvas.regions.placeRegion(data, { create: false, allowEmpty: true });
		if (!drawn) return { cancelled: true }; // cancelled — silent
		const regionData = drawn.toObject();
		const sceneId = canvas.scene?.id ?? null;
		const gm = game.users.find((user) => user.isGM && user.active);
		if (!gm) {
			ui.notifications.error(Manager.localize("areaEffects.notifyNoGmPlace"));
			return null;
		}
		return this._requestGmPlace(gm, sceneId, regionData, system, walkDifficulty);
	}

	/** Ask a connected GM to create the region + behavior; resolve on completion. */
	static _requestGmPlace(gm, sceneId, regionData, system, walkDifficulty = 1) {
		return new Promise((resolve) => {
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve(null);
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer, place: true });
			game.socket.emit(SOCKET_EVENT, {
				action: SOCKET_PLACE_REQUEST,
				requestId,
				sceneId,
				regionData,
				system,
				walkDifficulty
			}, { recipients: [gm.id] });
		});
	}

	/* -------------------------------------------- */
	/*  Instant AoE                                 */
	/* -------------------------------------------- */

	/**
	 * Place a one-shot area: no behavior attached — instead every token inside at
	 * placement gets auto-targeted (filtered by alliance) and receives each of the
	 * configured effect Items once, then the region is deleted.
	 *
	 * Returns: {success:true, tokenIds} on success, null when the user cancelled
	 * the drawing, false on genuine failure.
	 */
	static async placeInstant(config) {
		if (!canvas.ready) return null;
		const kind = config.kind ?? "burst";
		const size = Math.max(5, Number(config.size) || 5);
		const { x, y } = canvas.mousePosition;
		const data = {
			name: config.name || Manager.localize("areaEffects.instantDefaultName"),
			shapes: [this._shapeData(kind, size, x, y)],
			color: game.user.color?.toString() ?? "#000000",
			highlightMode: "coverage",
			displayMeasurements: true,
			visibility: CONST.REGION_VISIBILITY.ALWAYS,
			flags: {
				[Manager.id]: { areaEffects: true, author: game.user.id, instant: true },
				...(config.pf2eFlags ? { pf2e: config.pf2eFlags } : {})
			}
		};
		const effectUuids = Array.from(config.effects ?? []);
		const targetFilter = ["allies", "enemies"].includes(config.targetFilter) ? config.targetFilter : "all";

		if (game.user.isGM) {
			const region = await canvas.regions.placeRegion(data);
			if (!region) return { cancelled: true }; // right-click / dismiss — silent
			const tokenIds = await this._applyInstant(region, effectUuids, {
				targetFilter,
				includeSelf: !!config.includeSelf,
				includeNeutral: !!config.includeNeutral
			});
			await region.delete();
			canvas.tokens.setTargets(tokenIds);
			return { success: true, tokenIds };
		}

		// Non-GM: draw locally, defer creation/application/deletion to a GM.
		const drawn = await canvas.regions.placeRegion(data, { create: false, allowEmpty: true });
		if (!drawn) return { cancelled: true }; // cancelled — silent
		const gm = game.users.find((user) => user.isGM && user.active);
		if (!gm) {
			ui.notifications.error(Manager.localize("areaEffects.notifyNoGmPlace"));
			return false;
		}
		return this._requestGmInstant(gm, canvas.scene?.id ?? null, drawn.toObject(), effectUuids, targetFilter, config);
	}

	/**
	 * Tokens geometrically inside `region`, filtered exactly like the old
	 * Template Effects targeting dialog (TemplateEffectsTool._filterTargets):
	 * self-token exclusion unless included, hidden/dead tokens skipped, and
	 * neutral (alliance-less) actors only when explicitly included.
	 */
	static _tokensInside(region, opts = {}) {
		const targetFilter = ["allies", "enemies"].includes(opts.targetFilter) ? opts.targetFilter : "all";
		const mine = game.user.character?.alliance ?? "party";
		const want = targetFilter === "allies" ? mine
			: targetFilter === "enemies" ? (mine === "party" ? "opposition" : "party")
			: null;
		const selfToken = opts.includeSelf ? null : this._selfToken();
		const out = [];
		for (const token of canvas.scene?.tokens ?? []) {
			try {
				if (!token.testInsideRegion(region)) continue;
			} catch {
				continue;
			}
			// Copied from TemplateEffectsTool._filterTargets semantics:
			if (selfToken && token.id === selfToken.id) continue;
			if (!token.object || token.hidden) continue;
			const actor = token.actor;
			if (!actor?.isOfType?.("creature", "hazard", "vehicle") || actor.isDead) continue;
			const alliance = actor.alliance;
			if (alliance === null && !opts.includeNeutral) continue;
			if (want && alliance !== want) continue;
			out.push(token);
		}
		return out;
	}

	/** The token representing "yourself": your character's first token, else controlled. */
	static _selfToken() {
		const docs = game.user.character?.getActiveTokens?.(false, true) ?? [];
		return docs[0] ?? canvas.tokens?.controlled?.[0]?.document ?? null;
	}

	/** Apply every effect Item once to every matching token; returns their ids. */
	static async _applyInstant(region, effectUuids, opts = {}) {
		const tokens = this._tokensInside(region, opts);
		const items = [];
		for (const uuid of effectUuids) {
			const item = await foundry.utils.fromUuid(uuid).catch(() => null);
			if (item) items.push(item);
		}
		for (const item of items) {
			for (const token of tokens) {
				await this._applyEffect(region.uuid, item, token);
			}
		}
		return tokens.map((token) => token.id);
	}

	/** Non-GM: ask a connected GM to run the one-shot instant placement. */
	static _requestGmInstant(gm, sceneId, regionData, effectUuids, targetFilter, config = {}) {
		return new Promise((resolve) => {
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve(false);
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer, place: true });
			game.socket.emit(SOCKET_EVENT, {
				action: SOCKET_PLACE_REQUEST,
				requestId,
				sceneId,
				instant: true,
				regionData,
				effectUuids,
				targetFilter,
				includeSelf: !!config.includeSelf,
				includeNeutral: !!config.includeNeutral
			}, { recipients: [gm.id] });
		});
	}

	/** Build the behavior `system` object, capturing combat/caster tracking state. */
	static _behaviorSystem(config) {
		const duration = Math.max(0, Number(config.duration) || 0);
		const durationMode = config.durationMode === "combat" ? "combat" : "caster";
		const combat = game.combat;
		const system = {
			effects: Array.from(config.effects ?? []),
			mode: config.mode ?? "inside",
			duration,
			durationMode,
			combatId: combat?.id ?? null,
			lastRound: null,
			roundsLeft: duration > 0 ? duration : null,
			casterCombatantId: null
		};
		if ( duration > 0 ) {
			if ( durationMode === "caster" ) {
				// The actor whose turn it is when placed is assumed to be the caster
				// whose later turn starts tick the duration down.
				system.casterCombatantId = combat?.combatant?.id ?? null;
			} else {
				// Follow the combat round; baseline is the current round.
				system.lastRound = combat?.round ?? null;
				// If no combat is active, fall back to a combat-less mode that
				// adopts the round of the first combat it sees (handled in tick).
			}
		}
		return system;
	}

	/* -------------------------------------------- */
	/*  Duration tracking                           */
	/* -------------------------------------------- */

	/**
	 * Tick down limited-duration areas on every combat turn change. The GM is the
	 * single writer: it reads each area's behavior state, decrements `roundsLeft`
	 * according to the selected tracking mode, and either writes the new count or
	 * deletes the region once it reaches 0. Because the region is a scene document,
	 * the DB sync propagates state to all clients.
	 */
	static async _onCombatTurnChange(combat, previous, current) {
		if (!game.user.isGM) return;
		if (!canvas.scene) return;
		// v14: `current` is a CombatHistoryData state object { round, turn,
		// combatantId, tokenId } (not a Combatant document).
		const round = Number(current?.round ?? combat?.round ?? 0);
		const combatantId = current?.combatantId ?? null;
		if (!combat?.id) return;

		for (const region of canvas.scene.regions) {
			if (!this._isOwnRegion(region)) continue;
			const behavior = region.behaviors.find((b) => b.type === BEHAVIOR_TYPE);
			if (!behavior || behavior.disabled) continue;
			const sys = behavior?.system;
			if (!sys) continue;

			// Stick to the combat the area was placed into (ignore rounding on
			// other, unrelated combat tracks).
			if (sys.combatId && sys.combatId !== combat.id) continue;

			const duration = Number(sys.duration ?? 0);
			if (duration <= 0) continue; // unlimited

			const mode = sys.durationMode ?? "caster";
			let roundsLeft = Number(sys.roundsLeft ?? duration);
			let changed = false;

			if (mode === "caster") {
				if (combatantId && combatantId === sys.casterCombatantId) {
					roundsLeft -= 1;
					changed = true;
				}
			} else {
				// Follow the combat round. On the very first observed round we set
				// the baseline without decrementing; afterwards, each advancement
				// of the round reduces the count (a "round" wraps a full turn cycle).
				const lastRound = sys.lastRound;
				if (lastRound == null) {
					// First combat seen (or placed outside a combat): adopt this
					// combat and its round as the baseline without decrementing.
					await behavior.update({ system: { lastRound: round, combatId: combat.id } });
					continue;
				}
				const advanced = round - Number(lastRound ?? round);
				if (advanced > 0) {
					roundsLeft -= advanced;
					changed = true;
				}
			}

			if (!changed) continue;
			if (roundsLeft <= 0) {
				await this._expireArea(region);
			} else {
				const update = { roundsLeft };
				if (mode === "combat") update.lastRound = round;
				await behavior.update({ system: update });
				this._renderWindow();
			}
		}
	}

	/** Remove an area once its duration has been exhausted. */
	static async _expireArea(region) {
		try {
			const message = Manager.localize("areaEffects.expired", { name: region.name });
			await region.delete();
			// Re-render only after the region is gone, so the list no longer shows
			// the expired entry ("N rounds left").
			this._renderWindow();
			ui.notifications.info(message);
		} catch (error) {
			console.warn(`${Manager.id} | could not expire area ${region.id}`, error);
		}
	}

	/** Delete an area (the region and its behavior together). */
	static async deleteRegion(region) {
		if (!region) return;
		await this._regionOp(region, "delete");
		this._renderWindow();
	}

	/** Enable/disable an area's behavior without deleting it. */
	static async toggleEnabled(region) {
		await this._regionOp(region, "toggleEnabled");
		this._renderWindow();
	}

	/** Change the bound-vs-once mode of an area. */
	static async setMode(region, mode) {
		await this._regionOp(region, "setMode", mode);
		this._renderWindow();
	}

	/** Replace the configured effect list of an area. */
	static async setEffects(region, effects) {
		await this._regionOp(region, "setEffects", Array.from(effects ?? []));
		this._renderWindow();
	}

	/** Toggle the GM-only (hidden from players) visibility of an area (GM only). */
	static async toggleGMOnly(region) {
		if (!game.user.isGM) return;
		if (!this._isOwnRegion(region)) {
			ui.notifications.warn(Manager.localize("areaEffects.notifyNotOwner"));
			return;
		}
		const current = region?.getFlag?.(Manager.id, "gmOnly") ?? false;
		const next = !current;
		// Update the visibility (canvas) and the gmOnly flag (window filtering) so
		// the change is fully reversible and reflected everywhere.
		await region.update({ visibility: next ? CONST.REGION_VISIBILITY.GAMEMASTER : CONST.REGION_VISIBILITY.ALWAYS });
		await region.setFlag(Manager.id, "gmOnly", next);
		this._renderWindow();
	}

	/**
	 * Perform a region/behavior mutation. GMs run it locally; a non-GM may only
	 * modify an area they created, and even then it is executed by a connected GM,
	 * because core only lets GMs create/update Region Behaviors.
	 */
	static async _regionOp(region, op, value) {
		if (!region) return;
		if (!this._canManage(region)) {
			ui.notifications.warn(Manager.localize("areaEffects.notifyNotOwner"));
			return;
		}
		if (game.user.isGM) {
			await this._runRegionOp(region, op, value);
			return;
		}
		const gm = game.users.find((user) => user.isGM && user.active);
		if (!gm) {
			ui.notifications.error(Manager.localize("areaEffects.notifyNoGmPlace"));
			return;
		}
		await this._requestGmRegionOp(gm, region, op, value);
	}

	/** GM/owner: apply a mutation to a region's behavior directly. */
	static async _runRegionOp(region, op, value) {
		switch (op) {
			case "delete":
				await region.delete();
				break;
			case "toggleEnabled": {
				const behavior = region.behaviors.find((b) => b.type === BEHAVIOR_TYPE);
				if (!behavior) break;
				const next = !behavior.disabled;
				// Pause/resume the effect behavior together with any paired terrain
				// behavior, so one switch controls the whole area.
				const targets = region.behaviors.filter((b) => b.type === BEHAVIOR_TYPE || b.type === TERRAIN_BEHAVIOR_TYPE);
				for (const target of targets) await target.update({ disabled: next });
				break;
			}
			case "setMode": {
				const behavior = region.behaviors.find((b) => b.type === BEHAVIOR_TYPE);
				if (behavior) await behavior.update({ system: { mode: value } });
				break;
			}
			case "setEffects": {
				const behavior = region.behaviors.find((b) => b.type === BEHAVIOR_TYPE);
				if (behavior) await behavior.update({ system: { effects: value } });
				break;
			}
		}
	}

	/** Ask a connected GM to run a region/behavior mutation; resolve on completion. */
	static _requestGmRegionOp(gm, region, op, value) {
		return new Promise((resolve) => {
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve();
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer });
			game.socket.emit(SOCKET_EVENT, {
				action: SOCKET_OP_REQUEST,
				requestId,
				sceneId: region.parent?.id ?? null,
				regionId: region.id,
				op,
				value
			}, { recipients: [gm.id] });
		});
	}

	/* -------------------------------------------- */
	/*  Effect application / removal                */
	/* -------------------------------------------- */

	/**
	 * Apply one effect Item to a target actor, tagging it so the area can be
	 * traced back and removed. Used on `tokenEnter`. Skips actors that already
	 * carry the unexpired effect from this same area.
	 */
	static async _applyEffect(originUuid, effectItem, token) {
		const actor = token.actor;
		if (!actor?.isOfType?.("creature", "hazard", "vehicle")) return;
		const effectUuid = effectItem?.uuid;
		if (!effectUuid) return;
		// Only one copy of the same source effect per area at a time.
		const has = actor.items.some((item) =>
			item.getFlag(Manager.id, "areaOrigin") === originUuid
			&& item.getFlag(Manager.id, "areaSource") === effectUuid
			&& !item?.isExpired
		);
		if (has) return;
		const source = foundry.utils.mergeObject(effectItem.toObject(), {
			_id: null,
			flags: {
				[Manager.id]: { ...(effectItem.flags?.[Manager.id] ?? {}), areaOrigin: originUuid, areaSource: effectUuid }
			}
		}, { overwrite: false });
		if (actor.testUserPermission(game.user, "OWNER")) {
			await actor.createEmbeddedDocuments("Item", [source]);
		} else {
			const result = await this._requestGmEffect(SOCKET_APPLY_REQUEST, SOCKET_APPLY_RESULT, [{
				actorUuid: actor.uuid,
				source
			}]);
			if (result?.noGm) {
				ui.notifications.warn(Manager.localize("areaEffects.notifyNoGm", { name: effectItem.name }));
			} else if (result?.failed) {
				ui.notifications.error(Manager.localize("areaEffects.notifyApplyFail", { name: effectItem.name }));
			}
		}
	}

	/**
	 * Remove the effects that this area applied to a token. Used on `tokenExit`
	 * only when the mode is "inside".
	 */
	static async _removeEffects(originUuid, token) {
		const actor = token.actor;
		if (!actor) return;
		const toDelete = actor.items.filter((item) => item.getFlag(Manager.id, "areaOrigin") === originUuid);
		if (!toDelete.length) return;
		if (actor.testUserPermission(game.user, "OWNER")) {
			await actor.deleteEmbeddedDocuments("Item", toDelete.map((item) => item.id));
		} else {
			await this._requestGmEffect(SOCKET_REMOVE_REQUEST, SOCKET_REMOVE_RESULT, [{
				actorUuid: actor.uuid,
				ids: toDelete.map((item) => item.id)
			}], { noGmName: "" });
		}
	}

	/** Ask a connected GM to apply/remove (GMs have universal ownership). */
	static _requestGmEffect(action, resultAction, items, { noGmName = "" } = {}) {
		return new Promise((resolve) => {
			const gm = game.users.find((user) => user.isGM && user.active);
			if (!gm) {
				resolve({ applied: 0, failed: items.length, noGm: true });
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pendingGmRequests.delete(requestId);
				resolve({ applied: 0, failed: items.length, timeout: true });
			}, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer, noGmName });
			game.socket.emit(SOCKET_EVENT, { action, resultAction, requestId, items }, { recipients: [gm.id] });
		});
	}

	/* -------------------------------------------- */
	/*  Socket handling                             */
	/* -------------------------------------------- */

	static _onSocketMessage(data, userId) {
		try {
			if (!data?.action) return;
			if (data.action === SOCKET_APPLY_REQUEST || data.action === SOCKET_REMOVE_REQUEST) {
				if (!game.user.isGM) return;
				this._handleGmRequest(data, userId).catch((error) =>
					console.error(`${Manager.id} | GM area-effect request failed`, error)
				);
			} else if (data.action === SOCKET_PLACE_REQUEST) {
				if (!game.user.isGM) return;
				this._handleGmPlaceRequest(data, userId).catch((error) =>
					console.error(`${Manager.id} | GM area-place request failed`, error)
				);
			} else if (data.action === SOCKET_OP_REQUEST) {
				if (!game.user.isGM) return;
				this._handleGmRegionOp(data, userId).catch((error) =>
					console.error(`${Manager.id} | GM area-op request failed`, error)
				);
			} else if (data.action === SOCKET_APPLY_RESULT || data.action === SOCKET_REMOVE_RESULT || data.action === SOCKET_PLACE_RESULT || data.action === SOCKET_OP_RESULT) {
				this._handleGmResult(data);
			}
		} catch (error) {
			console.error(`${Manager.id} | area-effects socket handler failed`, error);
		}
	}

	/** GM-only: create the region + behavior requested by a non-GM and report back. */
	static async _handleGmPlaceRequest(data, userId) {
		const { requestId, sceneId, regionData, system, walkDifficulty } = data;
		let success = false;
		let name = "";
		let tokenIds = [];
		try {
			if (regionData?.parent) delete regionData.parent;
			const scene = sceneId ? game.scenes.get(sceneId) : canvas.scene;
			if (!scene) throw new Error("No target scene");
			const region = await CONFIG.Region.documentClass.create(regionData, { parent: scene });
			if (region) {
				if (data.instant) {
					// One-shot: apply effects to tokens inside, then remove the area.
					tokenIds = await this._applyInstant(region, Array.from(data.effectUuids ?? []), {
						targetFilter: data.targetFilter,
						includeSelf: !!data.includeSelf,
						includeNeutral: !!data.includeNeutral
					});
					await region.delete();
				} else {
					await region.createEmbeddedDocuments("RegionBehavior", this._behaviorDocs(system, Number(walkDifficulty) || 1));
				}
				success = true;
				name = region.name;
			}
		} catch (error) {
			console.warn(`${Manager.id} | GM could not place the requested area`, error);
		}
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_PLACE_RESULT, requestId, success, name, tokenIds }, { recipients: [userId] });
	}

	/** GM-only: run a requested region/behavior mutation for a non-GM. */
	static async _handleGmRegionOp(data, userId) {
		const { requestId, sceneId, regionId, op, value } = data;
		let success = false;
		try {
			const scene = sceneId ? game.scenes.get(sceneId) : canvas.scene;
			const region = scene?.regions?.get(regionId) ?? null;
			if (region) {
				await this._runRegionOp(region, op, value);
				success = true;
			}
		} catch (error) {
			console.warn(`${Manager.id} | GM could not run area op "${op}"`, error);
		}
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_OP_RESULT, requestId, success }, { recipients: [userId] });
	}

	/** GM-only: apply/create or remove the requested effect items and report back. */
	static async _handleGmRequest(data, userId) {
		const { requestId, resultAction, items } = data;
		let applied = 0;
		let failed = 0;
		for (const entry of (items ?? [])) {
			try {
				const actor = entry?.actorUuid ? await foundry.utils.fromUuid(entry.actorUuid) : null;
				if (!actor) {
					failed++;
					continue;
				}
				if (data.action === SOCKET_APPLY_REQUEST && entry?.source) {
					await actor.createEmbeddedDocuments("Item", [entry.source]);
					applied++;
				} else if (data.action === SOCKET_REMOVE_REQUEST && Array.isArray(entry?.ids)) {
					await actor.deleteEmbeddedDocuments("Item", entry.ids);
					applied++;
				} else {
					failed++;
				}
			} catch (error) {
				failed++;
				console.warn(`${Manager.id} | GM could not handle an area effect (${entry?.actorUuid})`, error);
			}
		}
		game.socket.emit(SOCKET_EVENT, { action: resultAction || SOCKET_APPLY_RESULT, requestId, applied, failed }, { recipients: [userId] });
	}

	static _handleGmResult(data) {
		const pending = this._pendingGmRequests.get(data?.requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this._pendingGmRequests.delete(data.requestId);
		if (pending.place) {
			pending.resolve({ success: !!data.success, name: data.name ?? "", tokenIds: data.tokenIds ?? [] });
		} else {
			pending.resolve({ applied: data.applied ?? 0, failed: data.failed ?? 0 });
		}
	}

	/* -------------------------------------------- */
	/*  Effect search                               */
	/* -------------------------------------------- */

	/** Score a compendium pack so "spell-effect" packs come first. */
	static _packScore(pack) {
		const id = `${pack.metadata?.package ?? ""}.${pack.metadata?.name ?? ""}`.toLowerCase();
		return id.includes("spell-effect") ? 2 : id.includes("effect") ? 1 : 0;
	}

	/**
	 * Search for candidate PF2e effect Items across compendiums and world Items.
	 * Returns lightweight entries `{uuid, name, img}` (not full documents, so the
	 * list renders quickly); the full document is fetched only on selection.
	 */
	static async _searchEffects(query) {
		const q = String(query ?? "").trim().toLowerCase();
		const expected = (item) => !item?.name || !q || item.name.toLowerCase().includes(q);
		const results = [];

		// Compendium Item packs (prefer ones about spell effects).
		const packs = game.packs
			.filter((pack) => pack.documentName === "Item")
			.sort((a, b) => this._packScore(b) - this._packScore(a));
		for (const pack of packs) {
			let index;
			try {
				index = await pack.getIndex({ fields: ["_id", "name", "type", "img"] });
			} catch {
				continue;
			}
			for (const entry of index) {
				if (entry.type !== "effect" && entry.type !== "condition") continue;
				if (!expected(entry)) continue;
				results.push({
					uuid: `Compendium.${pack.collection}.Item.${entry._id}`,
					name: entry.name,
					img: entry.img,
					pack: pack.collection
				});
				if (results.length >= 200) break;
			}
			if (results.length >= 200) break;
		}

		// World Items of the same types.
		if (results.length < 200) {
			for (const item of game.items.contents) {
				if (item.type !== "effect" && item.type !== "condition") continue;
				if (!expected(item)) continue;
				results.push({ uuid: item.uuid, name: item.name, img: item.img, pack: null });
				if (results.length >= 200) break;
			}
		}
		return results;
	}

	/* -------------------------------------------- */
	/*  Window context                              */
	/* -------------------------------------------- */

	/** Whether the given region belongs to this tool (has our behavior). */
	static _isOwnRegion(region) {
		return !!region && region.behaviors?.some?.((b) => b.type === BEHAVIOR_TYPE);
	}

	/** The user id that created this area (GM when the GM placed it). */
	static _authorId(region) {
		return region?.getFlag?.(Manager.id, "author") ?? null;
	}

	/** Whether this area is marked private (visible only to its author + GMs). */
	static _isPrivate(region) {
		return region?.getFlag?.(Manager.id, "private") === true;
	}

	/** Whether this area is marked GM-only (hidden from players, but functional). */
	static _isGMOnly(region) {
		return region?.getFlag?.(Manager.id, "gmOnly") === true;
	}

	/** Whether the current user may edit/manage this area (its author, or any GM). */
	static _canManage(region) {
		const author = this._authorId(region);
		return game.user.isGM || (!!author && author === game.user.id);
	}

	/** Whether the current user may see this area's entry in the window list. */
	static _canSee(region) {
		// GM-only areas are fully secret: only GMs see them (in the window too).
		if (this._isGMOnly(region)) return game.user.isGM;
		if (!this._isPrivate(region)) return true;
		// Private areas: visible to the author and any GM.
		return game.user.isGM || this._authorId(region) === game.user.id;
	}

	/** Best-effort synchronous display name for an item uuid (index-aware). */
	static _displayName(uuid) {
		if (!uuid) return "";
		try {
			const doc = foundry.utils.fromUuidSync(uuid);
			return doc?.name ?? uuid;
		} catch {
			return uuid;
		}
	}

	/** How many tokens in the scene are currently inside the region. Computed by
	 *  geometry (core's `TokenDocument#testInsideRegion`) rather than the region's
	 *  async `tokens` set, which lags right after a region is created over tokens. */
	static _tokenCount(region) {
		let count = 0;
		for (const token of canvas.scene.tokens) {
			try {
				if (token.testInsideRegion(region)) count++;
			} catch {
				// ignore tokens that error (e.g. cross-scene guard)
			}
		}
		return count;
	}

	/** List this tool's areas on the current scene with a UI-friendly shape. */
	static _sceneAreas() {
		if (!canvas.scene) return [];
		const areas = [];
		for (const region of canvas.scene.regions) {
			if (!this._isOwnRegion(region)) continue;
			if (!this._canSee(region)) continue;
			const behavior = region.behaviors.find((b) => b.type === BEHAVIOR_TYPE);
			const shape = region.shapes?.[0];
			let kinds = new Set();
			for (const s of region.shapes ?? []) kinds.add(s.type);
			const kind = kinds.has("circle") ? "burst"
				: kinds.has("cone") ? "cone"
				: kinds.has("line") ? "line"
				: kinds.has("rectangle") ? "cube" : "burst";
			const sizeFt = shape ? Math.round((this._radiusFor(shape) / this._feetPixels(1)) || 0) : 0;
			const effects = Array.from(behavior?.system?.effects ?? []).map((uuid) => ({
				uuid,
				name: this._displayName(uuid)
			}));
			const terrainBehavior = region.behaviors.find((b) => b.type === TERRAIN_BEHAVIOR_TYPE);
			const walkDifficulty = Math.max(1, Number(terrainBehavior?.system?.difficulties?.walk ?? 1));
			const terrainText = walkDifficulty > 1
				? Manager.localize(walkDifficulty > 2 ? "areaEffects.terrainGreater" : "areaEffects.terrainDifficult")
				: "";
			areas.push({
				id: region.id,
				name: region.name,
				kind,
				sizeFt,
				shape: this._shapeLabel(kind, sizeFt),
				count: this._tokenCount(region),
				mode: behavior?.system?.mode ?? "inside",
				effects,
				effectCount: effects.length,
				disabled: !!behavior?.disabled,
				durationText: this._durationText(behavior?.system),
				terrainText,
				private: this._isPrivate(region),
				gmOnly: this._isGMOnly(region),
				canManage: this._canManage(region),
				region
			});
		}
		return areas;
	}

	static _radiusFor(shape) {
		if (!shape) return 0;
		if (shape.radius) return shape.radius;
		if (shape.length) return shape.length;
		// Rectangle (cube) shapes carry their size as width/height in pixels.
		if (shape.width) return shape.width;
		return 0;
	}
}

/* -------------------------------------------- */
/*  Region behavior type                        */
/* -------------------------------------------- */

/**
 * The region behavior that applies configured PF2e effect Items to tokens inside
 * the area and (depending on mode) removes them when they leave.
 */
class VibeAreaEffectRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
	static defineSchema() {
		return {
			effects: new foundry.data.fields.SetField(new foundry.data.fields.DocumentUUIDField({ type: "Item" })),
			mode: new foundry.data.fields.StringField({ required: true, blank: false, choices: {
				inside: `${Manager.id}.areaEffects.modeInside`,
				once: `${Manager.id}.areaEffects.modeOnce`
			}, initial: "inside" }),
			// Duration in combat rounds. 0 = unlimited (no expiry tracking).
			duration: new foundry.data.fields.NumberField({ required: false, integer: true, min: 0, nullable: true, initial: 0 }),
			// How the duration is measured: "combat" follows the combat round,
			// "caster" ticks down on each of one specific actor's turn starts.
			durationMode: new foundry.data.fields.StringField({ required: false, blank: false, nullable: true, choices: {
				combat: `${Manager.id}.areaEffects.trackCombat`,
				caster: `${Manager.id}.areaEffects.trackCaster`
			}, initial: "caster" }),
			// Dynamic tracking state (only meaningful when duration > 0).
			combatId: new foundry.data.fields.StringField({ required: false, nullable: true, initial: null }),
			lastRound: new foundry.data.fields.NumberField({ required: false, integer: true, nullable: true, initial: null }),
			roundsLeft: new foundry.data.fields.NumberField({ required: false, integer: true, min: 0, nullable: true, initial: null }),
			casterCombatantId: new foundry.data.fields.StringField({ required: false, nullable: true, initial: null })
		};
	}

	static events = {
		tokenEnter: this.#onTokenEnter,
		tokenExit: this.#onTokenExit
	};

	static async #onTokenEnter(event) {
		// Only the client whose action caused the event applies the effects.
		if (!event.user.isSelf) return;
		const { token } = event.data;
		const actor = token?.actor;
		if (!actor?.isOfType?.("creature", "hazard", "vehicle")) return;
		const origin = this.behavior.uuid;
		const effectUuids = Array.from(this.effects ?? []);
		for (const effectUuid of effectUuids) {
			const effect = await foundry.utils.fromUuid(effectUuid).catch(() => null);
			if (!effect) continue;
			await AreaEffectsTool._applyEffect(origin, effect, token);
		}
	}

	static async #onTokenExit(event) {
		if (!event.user.isSelf) return;
		if (this.mode !== "inside") return; // "once" mode leaves effects running
		const { token } = event.data;
		if (!token?.actor) return;
		await AreaEffectsTool._removeEffects(this.behavior.uuid, token);
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class AreaEffectsWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(
		foundry.applications.api.ApplicationV2
	)
) {
	static DEFAULT_OPTIONS = {
		id: "area-effects",
		classes: ["vibe-area-effects"],
		position: { width: 520 },
		window: {
			icon: "fa-solid fa-circle-dot",
			resizable: true,
			minimizable: true
		},
		actions: {
			place() { this._onPlace(); },
			addEffect() { this._onAddEffect(); },
			removeEffect(event, target) { this._onRemoveEffect(target?.dataset?.index); },
			enable(event, target) { this._onToggleEnabled(target?.dataset?.id); },
			removeRegion(event, target) { this._onDeleteRegion(target?.dataset?.id); },
			gmOnly(event, target) { this._onToggleGMOnly(target?.dataset?.id); },
			pickInstantEffect() { this._pickInstantEffect(); },
			removeInstantEffect(event, target) { this._removeInstantEffect(target?.dataset?.index); },
			placeInstant() { this._placeInstant(); }
		}
	};

	/** Core ApplicationV2 tab group driving the Persistent/Instant switch. */
	static TABS = {
		main: {
			tabs: [
				{ id: "persistent", labelKey: "tabPersistent" },
				{ id: "instant", labelKey: "tabInstant" }
			],
			initial: "persistent"
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/area-effects.hbs`, root: true }
	};

	/** Draft state for a not-yet-placed area (persists across re-renders). */
	_draft = this._newPersistentDraft();

	/** Draft for the Instant AoE tab (one-shot placement). */
	_instantDraft = this._newInstantDraft();

	/** Increments per Place click so superseded placements can be ignored. */
	_placeSeq = 0;

	static PERSISTENT_DEFAULTS = { kind: "burst", size: 20, mode: "inside", name: "", effects: [], duration: 0, durationMode: "caster", private: false, gmOnly: false, terrain: "" };
	static INSTANT_DEFAULTS = { kind: "burst", size: 20, effects: [], targetFilter: "all", includeSelf: false, includeNeutral: false };

	_newPersistentDraft() {
		return foundry.utils.deepClone(AreaEffectsWindow.PERSISTENT_DEFAULTS);
	}

	_newInstantDraft() {
		return foundry.utils.deepClone(AreaEffectsWindow.INSTANT_DEFAULTS);
	}

	get title() {
		return Manager.localize("areaEffects.title");
	}

	/* -------------------------------------------- */
	/*  Context & re-render                         */
	/* -------------------------------------------- */

	_prepareContext(options) {
		const shapes = Object.entries(AreaEffectsTool.SHAPES).map(([key, shape]) => ({
			key,
			label: Manager.localize(`areaEffects.${shape.key}`),
			icon: shape.icon
		}));
		const tabs = Object.values(this._prepareTabs("main")).map((tab) => ({
			...tab,
			label: Manager.localize(`areaEffects.${tab.labelKey ?? tab.id}`)
		}));
		return {
			shapes,
			tabs,
			currentTab: this.tabGroups?.main ?? "persistent",
			draft: {
				kind: this._draft.kind,
				size: this._draft.size,
				mode: this._draft.mode,
				name: this._draft.name,
				duration: this._draft.duration,
				durationMode: this._draft.durationMode,
				private: this._draft.private,
				gmOnly: this._draft.gmOnly,
				terrain: this._draft.terrain,
				effects: this._draft.effects.map((uuid) => ({ uuid, name: AreaEffectsTool._displayName(uuid) }))
			},
			instantDraft: {
				kind: this._instantDraft.kind,
				size: this._instantDraft.size,
				targetFilter: this._instantDraft.targetFilter,
				includeSelf: this._instantDraft.includeSelf,
				includeNeutral: this._instantDraft.includeNeutral,
				effects: this._instantDraft.effects.map((uuid) => ({ uuid, name: AreaEffectsTool._displayName(uuid) }))
			},
			areas: AreaEffectsTool._sceneAreas(),
			isGM: game.user.isGM,
			i18n: (key) => Manager.localize(`areaEffects.${key}`)
		};
	}

	/* -------------------------------------------- */
	/*  Draft editing                               */
	/* -------------------------------------------- */

	/** Bind change listeners to the create-form controls (select/radios/inputs). */
	_onRender(context, options) {
		const element = this.element;
		if (!element) return;
		// Preserve the list scroll position across re-renders (the DOM is rebuilt
		// every time an area is added/removed, which otherwise snaps to the top).
		const list = element.querySelector(".ae-list");
		if (list) {
			list.addEventListener("scroll", () => { this._aeScrollTop = list.scrollTop; });
			const saved = this._aeScrollTop;
			if (saved != null) {
				requestAnimationFrame(() => { list.scrollTop = saved; });
			}
		}
		const form = element.querySelector("form.ae-form");
		if (!form) return;

		form.querySelector("select[name='shape']")?.addEventListener("change", (event) => {
			this._draft.kind = event.currentTarget.value ?? "burst";
			this.render();
		});
		form.querySelector("input[name='size']")?.addEventListener("change", (event) => {
			this._draft.size = event.currentTarget.value;
			this.render();
		});
		form.querySelector("input[name='name']")?.addEventListener("change", (event) => {
			this._draft.name = event.currentTarget.value;
		});
		form.querySelector("input[name='duration']")?.addEventListener("change", (event) => {
			this._draft.duration = event.currentTarget.value;
			this.render();
		});
		form.querySelector("select[name='durationMode']")?.addEventListener("change", (event) => {
			this._draft.durationMode = event.currentTarget.value ?? "combat";
			this.render();
		});
		form.querySelector("select[name='terrain']")?.addEventListener("change", (event) => {
			this._draft.terrain = event.currentTarget.value ?? "";
		});
		form.querySelector("input[name='private']")?.addEventListener("change", (event) => {
			this._draft.private = !!event.currentTarget.checked;
			this.render();
		});
		form.querySelector("input[name='gmOnly']")?.addEventListener("change", (event) => {
			this._draft.gmOnly = !!event.currentTarget.checked;
			this.render();
		});
		form.querySelectorAll("input[name='mode']").forEach((radio) => {
			radio.addEventListener("change", (event) => {
				if (!event.currentTarget.checked) return;
				this._draft.mode = event.currentTarget.value;
				this.render();
			});
		});
		// Existing-area mode radios: route to the behavior update.
		element.querySelectorAll("input[data-role='area-mode']").forEach((radio) => {
			radio.addEventListener("change", (event) => {
				if (!event.currentTarget.checked) return;
				this._onAreaMode(event.currentTarget.dataset.id, event.currentTarget.value);
			});
		});

		// Instant tab controls.
		element.querySelector("select[name='instant-shape']")?.addEventListener("change", (event) => {
			this._instantDraft.kind = event.currentTarget.value ?? "burst";
			this.render();
		});
		element.querySelector("input[name='instant-size']")?.addEventListener("change", (event) => {
			this._instantDraft.size = event.currentTarget.value;
			this.render();
		});
		element.querySelector("select[name='instant-target']")?.addEventListener("change", (event) => {
			this._instantDraft.targetFilter = event.currentTarget.value ?? "all";
			this.render();
		});
		element.querySelector("input[name='instant-self']")?.addEventListener("change", (event) => {
			this._instantDraft.includeSelf = !!event.currentTarget.checked;
		});
		element.querySelector("input[name='instant-neutral']")?.addEventListener("change", (event) => {
			this._instantDraft.includeNeutral = !!event.currentTarget.checked;
		});
	}

	async _onAreaMode(id, mode) {
		const region = canvas.scene?.regions.get(id);
		if (region) await AreaEffectsTool.setMode(region, mode);
	}

	_onPlace() {
		// Supersede any in-progress placement (core cancels the old preview when a
		// new one starts; ignore the stale promise's cancellation).
		const seq = ++this._placeSeq;
		this._place(seq).catch((error) =>
			console.error(`${Manager.id} | could not place the area`, error)
		);
	}

	async _place(seq = null) {
		const size = Math.max(5, Number(this._draft.size) || 5);
		const result = await AreaEffectsTool.place({
			kind: this._draft.kind,
			size,
			mode: this._draft.mode,
			name: this._draft.name,
			effects: this._draft.effects,
			duration: this._draft.duration,
			durationMode: this._draft.durationMode,
			isPrivate: this._draft.private,
			gmOnly: this._draft.gmOnly,
			terrain: this._draft.terrain ?? "",
			pf2eFlags: this._draft._pf2eFlags ?? null
		});
		if (seq !== null && seq !== this._placeSeq) return null; // superseded by a newer Place
		this._draft._pf2eFlags = null;
		if (result?.cancelled) return result; // user cancelled the drawing — silent
		// GM -> returns the RegionDocument; non-GM -> returns {success} after the GM
		// builds it (or null on a timeout / no GM).
		if (result && typeof result === "object" && "success" in result) {
			if (!result.success) {
				ui.notifications.error(Manager.localize("areaEffects.notifyPlaceFail"));
				return null;
			}
		} else if (!result) {
			ui.notifications.error(Manager.localize("areaEffects.notifyPlaceFail"));
			return null;
		}
		// Reset every field back to its default after a successful placement.
		this._draft = this._newPersistentDraft();
		this.render();
		return result;
	}

	async _onAddEffect() {
		const uuid = await EffectPicker.pick();
		if (uuid && !this._draft.effects.includes(uuid)) {
			this._draft.effects.push(uuid);
		}
		this.render({ force: true });
	}

	_onRemoveEffect(index) {
		this._draft.effects.splice(Number(index), 1);
		this.render();
	}

	/* -------------------------------------------- */
	/*  Instant AoE                                 */
	/* -------------------------------------------- */

	_placeInstant() {
		// Supersede any in-progress placement: core cancels the old preview when a
		// new placeRegion starts; the stale promise then resolves null and must
		// be ignored rather than treated as a failure.
		const seq = ++this._placeSeq;
		this._placeInstantDraft(seq).catch((error) =>
			console.error(`${Manager.id} | could not place the instant area`, error)
		);
	}

	async _placeInstantDraft(seq = null) {
		const size = Math.max(5, Number(this._instantDraft.size) || 5);
		const result = await AreaEffectsTool.placeInstant({
			kind: this._instantDraft.kind,
			size,
			effects: this._instantDraft.effects,
			targetFilter: this._instantDraft.targetFilter,
			includeSelf: this._instantDraft.includeSelf,
			includeNeutral: this._instantDraft.includeNeutral,
			pf2eFlags: this._instantDraft._pf2eFlags ?? null
		});
		if (seq !== null && seq !== this._placeSeq) return null; // superseded by a newer Place
		if (result === false) {
			ui.notifications.error(Manager.localize("areaEffects.notifyPlaceFail"));
			return false;
		}
		this._instantDraft._pf2eFlags = null;
		if (!result) return null; // user cancelled the drawing — silent
		// Auto-target the affected tokens on this client (GM reply carries ids for
		// non-GMs; GM computed them directly).
		const tokenIds = result?.tokenIds ?? [];
		if (tokenIds.length) canvas.tokens.setTargets(tokenIds);
		// Reset every field back to its default after a successful placement.
		this._instantDraft = this._newInstantDraft();
		this.render();
		return result;
	}

	async _pickInstantEffect() {
		const uuid = await EffectPicker.pick();
		if (uuid && !this._instantDraft.effects.includes(uuid)) {
			this._instantDraft.effects.push(uuid);
		}
		this.render({ force: true });
	}

	_removeInstantEffect(index) {
		this._instantDraft.effects.splice(Number(index), 1);
		this.render();
	}

	/* -------------------------------------------- */
	/*  Existing area actions                       */
	/* -------------------------------------------- */

	async _onToggleEnabled(id) {
		const region = canvas.scene?.regions.get(id);
		if (region) await AreaEffectsTool.toggleEnabled(region);
	}

	async _onToggleGMOnly(id) {
		const region = canvas.scene?.regions.get(id);
		if (region) await AreaEffectsTool.toggleGMOnly(region);
	}

	async _onDeleteRegion(id) {
		const region = canvas.scene?.regions.get(id);
		if (!region) return;
		const confirmed = await foundry.applications.api.DialogV2.confirm({
			content: `<p>${Manager.localize("areaEffects.deleteConfirm", { name: region.name })}</p>`,
			window: { title: Manager.localize("areaEffects.deleteTitle") }
		});
		if (confirmed) await AreaEffectsTool.deleteRegion(region);
	}
}

/* -------------------------------------------- */
/*  Effect picker                               */
/* -------------------------------------------- */

class EffectPicker {
	/** Open a searchable effect picker; resolve with the chosen item uuid or null. */
	static pick() {
		let chosen = null;
		const content = `<div class="vibe-effect-picker">
			<input type="text" name="search" placeholder="${Manager.localize("areaEffects.searchPlaceholder")}" />
			<ul class="vibe-picker-results"></ul>
		</div>`;
		return foundry.applications.api.DialogV2.wait({
			modal: true,
			content,
			window: { title: Manager.localize("areaEffects.pickTitle") },
			buttons: [{
				action: "cancel",
				label: Manager.localize("areaEffects.cancel"),
				// _onSubmit resolves with `callbackResult ?? action`, so a missing/null
				// return falls back to "cancel" — return false to signal dismissal.
				callback: () => false
			}],
			render: (event, dialog) => {
				const element = dialog.element;
				const input = element.querySelector("input[name='search']");
				const list = element.querySelector(".vibe-picker-results");
				if (!input || !list) return;
				const search = async (value) => {
					const results = await AreaEffectsTool._searchEffects(value);
					this._renderResults(list, results);
				};
				input.addEventListener("input", () => search(input.value));
				list.addEventListener("click", (clickEvent) => {
					const button = clickEvent.target.closest?.("button[data-uuid]");
					if (!button) return;
					chosen = button.dataset.uuid;
					dialog.close();
				});
				search("");
				requestAnimationFrame(() => input?.focus());
			},
			close: () => chosen
		});
	}

	static _renderResults(list, results) {
		if (!list) return;
		if (!results.length) {
			list.innerHTML = `<li class="vibe-picker-empty">${Manager.localize("areaEffects.searchEmpty")}</li>`;
			return;
		}
		list.innerHTML = results.map((entry) => {
			const img = entry.img ? `<img src="${entry.img}" alt="">` : "";
			return `<li><button type="button" data-uuid="${entry.uuid}">${img}<span>${entry.name}</span></button></li>`;
		}).join("");
	}
}
