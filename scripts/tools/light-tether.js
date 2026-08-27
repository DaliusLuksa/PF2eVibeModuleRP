import { Manager } from "../core/manager.js";

const SYSTEM_SPELLS_PACK = "pf2e.spells-srd";
const LIGHT_SPELL_NAME = "Light";
const LIGHT_EFFECT_SLUG = "spell-effect-light";
const LIGHT_EFFECT_NAME = "Spell Effect: Light";
const FALLBACK_RANGE_FEET = 120;
const DEBOUNCE_MS = 50;

/**
 * Light Tether — removes Spell Effect: Light when its bearer moves beyond the
 * spell's range from the caster.
 *
 * - Light only (not a generic tether system).
 * - Uses the spell's actual range.value ("120 feet") with a 120 ft fallback.
 * - Checks when either the caster or the target moves (updateToken on GM).
 * - Skips if either side has no token on the same scene.
 * - GM is the single writer: deletes the effect and posts a chat message:
 *   "Light on X expired — moved beyond 120 ft from Y"
 */
export class LightTetherTool {
	static id = "light-tether";
	static category = "light-tether";
	static enabledDefault = true;

	/** Cached numeric range in feet (null = not yet loaded). */
	static _rangeFeet = null;
	static _rangeLoaded = false;

	/** Debounce timer for token movement. */
	static _debounceTimer = null;
	/** Scenes that had movement since last flush. */
	static _pendingScenes = new Set();
	/** Guard against re-entrancy while deleting. */
	static _processing = false;
	/** Effect ids currently being deleted (avoid double-delete). */
	static _deleting = new Set();

	static ready() {
		this._loadRange().catch((e) => console.warn(`${Manager.id} | light-tether could not load range`, e));
		Hooks.on("updateToken", this._onUpdateToken.bind(this));
		Hooks.on("refreshToken", this._onRefreshToken.bind(this));
	}

	/* -------------------------------------------- */
	/*  Range lookup                                */
	/* -------------------------------------------- */

	static async _loadRange() {
		if (this._rangeLoaded) return this._rangeFeet;
		this._rangeLoaded = true;
		try {
			const pack = game.packs.get(SYSTEM_SPELLS_PACK);
			if (pack) {
				const index = await pack.getIndex();
				const entry = index.find((e) => e.type === "spell" && e.name === LIGHT_SPELL_NAME);
				if (entry) {
					const doc = await pack.getDocument(entry._id);
					const raw = doc?.system?.range?.value ?? "";
					const feet = this._parseFeet(raw);
					if (feet !== null) this._rangeFeet = feet;
				}
			}
			// Fallback: world spell
			if (this._rangeFeet === null) {
				const worldSpell = game.items?.find((i) => i.type === "spell" && i.name === LIGHT_SPELL_NAME);
				if (worldSpell) {
					const feet = this._parseFeet(worldSpell.system?.range?.value ?? "");
					if (feet !== null) this._rangeFeet = feet;
				}
			}
		} catch (e) {
			console.warn(`${Manager.id} | light-tether range lookup failed`, e);
		}
		if (this._rangeFeet === null) this._rangeFeet = FALLBACK_RANGE_FEET;
		return this._rangeFeet;
	}

	static _parseFeet(value) {
		if (typeof value !== "string") return null;
		// "120 feet", "120 ft", "120-foot", "120"
		const m = value.match(/(\d+)/);
		if (!m) return null;
		const n = Number(m[1]);
		return Number.isFinite(n) && n > 0 ? n : null;
	}

	static get _range() {
		return this._rangeFeet ?? FALLBACK_RANGE_FEET;
	}

	/* -------------------------------------------- */
	/*  Token movement hook                         */
	/* -------------------------------------------- */

	static _onUpdateToken(tokenDoc, changes, options, userId) {
		if (!game.user.isActiveGM) return;
		if (!Manager.isEnabled(this.id)) return;
		if (changes.x === undefined && changes.y === undefined && changes.elevation === undefined && changes.sort === undefined) return;
		const scene = tokenDoc.parent;
		if (!scene) return;
		this._pendingScenes.add(scene.id);
		clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => this._flushPending(), DEBOUNCE_MS);
		queueMicrotask(() => this._checkMovedToken(tokenDoc, scene).catch((e) =>
			console.warn(`${Manager.id} | light-tether moved check failed`, e)
		));
		if (!this._processing) queueMicrotask(() => this._flushPending());
	}

	static _onRefreshToken(token) {
		if (!game.user.isActiveGM) return;
		if (!Manager.isEnabled(this.id)) return;
		if (!canvas?.ready || !canvas?.grid) return;
		if (this._refreshThrottle) return;
		this._refreshThrottle = true;
		setTimeout(() => (this._refreshThrottle = false), 200);
		const scene = canvas.scene;
		if (!scene) return;
		this._pendingScenes.add(scene.id);
		clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => this._flushPending(), DEBOUNCE_MS);
	}

	static async _flushPending() {
		if (this._processing) {
			// Still queue a retry — don't drop the pending scenes
			if (this._pendingScenes.size) {
				clearTimeout(this._debounceTimer);
				this._debounceTimer = setTimeout(() => this._flushPending(), DEBOUNCE_MS);
			}
			return;
		}
		await this._loadRange();
		const scenes = [...this._pendingScenes];
		this._pendingScenes.clear();
		if (!scenes.length) return;
		this._processing = true;
		try {
			for (const sceneId of scenes) {
				const scene = game.scenes.get(sceneId);
				if (!scene) continue;
				await this._checkScene(scene);
			}
		} finally {
			this._processing = false;
			if (this._pendingScenes.size) {
				clearTimeout(this._debounceTimer);
				this._debounceTimer = setTimeout(() => this._flushPending(), DEBOUNCE_MS);
			}
		}
	}

	static async _checkScene(scene) {
		const range = this._range;
		const candidates = this._collectLightEffectsOnScene(scene);
		if (!candidates.length) return;
		for (const { effect, targetActor } of candidates) {
			if (this._deleting.has(effect.id)) continue;
			if (effect.system?.expired) continue;
			const originUuid = effect.system?.context?.origin?.actor;
			if (!originUuid) continue;
			let caster = null;
			try {
				const resolved = fromUuidSync(originUuid);
				caster = resolved?.actor ?? resolved;
			} catch {
				caster = null;
			}
			if (!caster) continue;

			const casterTokens = this._tokensForActorOnScene(caster, scene);
			const targetTokens = this._tokensForActorOnScene(targetActor, scene);
			if (!casterTokens.length || !targetTokens.length) continue;

			const minDist = this._minDistance(casterTokens, targetTokens);
			if (minDist === null) continue;
			if (minDist > range) {
				await this._removeEffect(effect, targetActor, caster, range, minDist);
			}
		}
	}

	static _collectLightEffectsOnScene(scene) {
		const result = [];
		const seenActors = new Set();
		const actorsOnScene = new Set();

		// Gather actors referenced by scene tokens (handles both linked and synthetic unlinked)
		for (const tokDoc of scene.tokens) {
			const actor = tokDoc.actor;
			if (!actor) continue;
			const base = actor.baseActor ?? actor;
			const key = base.uuid ?? actor.uuid;
			if (seenActors.has(key)) continue;
			seenActors.add(key);
			// Prefer the base world actor for item storage / deletion.
			actorsOnScene.add(base);
		}
		// Also include any world actors that carry the effect but whose token may have been missed
		// (covers edge where getActiveTokens lag). They will be filtered by token presence later.
		for (const actor of game.actors) {
			let hasLight = false;
			for (const item of actor.items) {
				if (this._isLightEffect(item)) { hasLight = true; break; }
			}
			if (!hasLight) continue;
			const base = actor.baseActor ?? actor;
			const key = base.uuid ?? actor.uuid;
			if (seenActors.has(key)) continue;
			// Only add if they actually have a token on this scene (otherwise _tokensForActorOnScene will skip)
			if (!this._tokensForActorOnScene(base, scene).length) continue;
			seenActors.add(key);
			actorsOnScene.add(base);
		}
		for (const actor of actorsOnScene) {
			for (const item of actor.items) {
				if (!this._isLightEffect(item)) continue;
				if (item.system?.expired) continue;
				result.push({ effect: item, targetActor: actor.baseActor ?? actor });
			}
		}
		return result;
	}

	static _isLightEffect(item) {
		if (item.type !== "effect") return false;
		if (item.slug === LIGHT_EFFECT_SLUG) return true;
		if (item.name === LIGHT_EFFECT_NAME) return true;
		// Also match slug via system.slug fallback
		if (item.system?.slug === LIGHT_EFFECT_SLUG) return true;
		return false;
	}

	static _tokensForActorOnScene(actor, scene) {
		// Use TokenDocuments directly (DB truth) — placeable .center lags behind
		// the DB during drag animations, so measuring documents gives the final
		// dropped position immediately and fixes the "removed on next move" bug.
		const docs = [];
		const targetBaseId = actor.baseActor?.id ?? actor.id;
		const targetId = actor.id;
		for (const td of scene.tokens) {
			const a = td.actor;
			if (!a) continue;
			const baseId = a.baseActor?.id ?? a.id;
			if (a.id === targetId || baseId === targetBaseId || a.baseActor?.id === targetId || td.baseActor?.id === targetId) {
				docs.push(td);
			}
		}
		return docs;
	}

	static _minDistance(casterTokenDocs, targetTokenDocs) {
		if (!canvas?.grid) return null;
		let min = Infinity;
		for (const ct of casterTokenDocs) {
			const cp = this._tokenDocCenter(ct);
			if (!cp) continue;
			for (const tt of targetTokenDocs) {
				const tp = this._tokenDocCenter(tt);
				if (!tp) continue;
				const d = this._measureDistance(cp, tp);
				if (d !== null && d < min) min = d;
			}
		}
		return min === Infinity ? null : min;
	}

	static _tokenDocCenter(tokenDoc) {
		if (typeof tokenDoc?.x === "number" && typeof tokenDoc?.y === "number") {
			const size = canvas.grid?.size ?? 100;
			const w = tokenDoc.width ?? 1;
			const h = tokenDoc.height ?? 1;
			return { x: tokenDoc.x + (w * size) / 2, y: tokenDoc.y + (h * size) / 2 };
		}
		return null;
	}

	/**
	 * Immediate check for the single token that just moved. Uses the
	 * freshly-updated TokenDocument position (DB truth) instead of scanning
	 * the scene collection, so it cannot read a stale position.
	 */
	static async _checkMovedToken(movedDoc, scene) {
		await this._loadRange();
		const range = this._range;
		const movedActor = movedDoc.actor?.baseActor ?? movedDoc.actor;
		if (!movedActor) return;
		// Collect candidates where the moved actor is either the light bearer
		// or the caster — those are the only effects whose distance can change.
		const candidates = this._collectLightEffectsOnScene(scene).filter(({ effect, targetActor }) => {
			const originUuid = effect.system?.context?.origin?.actor;
			let caster = null;
			try { const r = originUuid ? fromUuidSync(originUuid) : null; caster = r?.actor ?? r; } catch { caster = null; }
			const isTarget = (targetActor.baseActor?.id ?? targetActor.id) === (movedActor.baseActor?.id ?? movedActor.id) || targetActor.id === movedActor.id;
			const isCaster = caster && ((caster.baseActor?.id ?? caster.id) === (movedActor.baseActor?.id ?? movedActor.id) || caster.id === movedActor.id);
			return isTarget || isCaster;
		});
		if (!candidates.length) return;
		// Build a map of TokenDocument overrides: the moved document already
		// carries its new x/y; other docs are taken from scene.tokens.
		const movedCenter = this._tokenDocCenter(movedDoc);
		for (const { effect, targetActor } of candidates) {
			if (this._deleting.has(effect.id)) continue;
			const originUuid = effect.system?.context?.origin?.actor;
			let caster = null;
			try { const r = fromUuidSync(originUuid); caster = r?.actor ?? r; } catch { continue; }
			if (!caster) continue;
			// Gather docs, but substitute the moved doc's fresh center
			const casterDocs = this._tokensForActorOnScene(caster, scene);
			const targetDocs = this._tokensForActorOnScene(targetActor, scene);
			if (!casterDocs.length || !targetDocs.length) continue;
			// If the moved doc is among the caster/target docs, its scene.tokens
			// entry already IS the fresh doc, but ensure we use movedDoc's coords
			// (in case the collection hasn't updated yet).
			const minDist = this._minDistanceWithOverride(casterDocs, targetDocs, movedDoc, movedCenter);
			if (minDist !== null && minDist > range) {
				await this._removeEffect(effect, targetActor, caster, range, minDist);
			}
		}
	}

	static _minDistanceWithOverride(casterDocs, targetDocs, movedDoc, movedCenter) {
		if (!movedCenter) return this._minDistance(casterDocs, targetDocs);
		let min = Infinity;
		for (const ct of casterDocs) {
			const cp = ct.id === movedDoc.id ? movedCenter : this._tokenDocCenter(ct);
			if (!cp) continue;
			for (const tt of targetDocs) {
				const tp = tt.id === movedDoc.id ? movedCenter : this._tokenDocCenter(tt);
				if (!tp) continue;
				const d = this._measureDistance(cp, tp);
				if (d !== null && d < min) min = d;
			}
		}
		return min === Infinity ? null : min;
	}

	/** Kept for compatibility; delegates to _tokenDocCenter. */
	static _tokenCenter(token) {
		if (token?.center) return { x: token.center.x, y: token.center.y };
		if (token?.object?.center) return { x: token.object.center.x, y: token.object.center.y };
		const doc = token?.document ?? token;
		return this._tokenDocCenter(doc);
	}

	static _measureDistance(a, b) {
		try {
			// Prefer grid-accurate measurement (handles diagonals, hex, gridless)
			if (canvas.grid?.measurePath) {
				const r = canvas.grid.measurePath([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
				if (typeof r.distance === "number") return r.distance;
				if (typeof r.cost === "number") return r.cost;
			}
		} catch {}
		// Fallback: pixel Euclidean -> feet
		try {
			const dx = a.x - b.x;
			const dy = a.y - b.y;
			const px = Math.hypot(dx, dy);
			const size = canvas.grid?.size ?? 100;
			const distPerGrid = canvas.grid?.distance ?? 5;
			return (px / size) * distPerGrid;
		} catch {
			return null;
		}
	}

	static async _removeEffect(effect, targetActor, casterActor, range, actual) {
		if (this._deleting.has(effect.id)) return;
		this._deleting.add(effect.id);
		try {
			await targetActor.deleteEmbeddedDocuments("Item", [effect.id]);
			const targetName = targetActor.name ?? "unknown";
			const casterName = casterActor.name ?? "unknown";
			const content = `<p>${Manager.localize("lightTether.notify.removed", { target: targetName, range, caster: casterName })}</p>`;
			await ChatMessage.create({ content, speaker: { alias: "PF2e VibeModuleRP" } }).catch((e) =>
				console.warn(`${Manager.id} | light-tether chat failed`, e)
			);
		} catch (e) {
			console.warn(`${Manager.id} | light-tether could not remove effect ${effect.name} from ${targetActor.name}`, e);
		} finally {
			setTimeout(() => this._deleting.delete(effect.id), 2000);
		}
	}
}
