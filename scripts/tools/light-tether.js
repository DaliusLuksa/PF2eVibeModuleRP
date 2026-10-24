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
 * - Checks when either the caster or the target moves (updateToken on the
 *   active GM), plus canvas refreshes (refreshToken) so removal lands
 *   while the token is visibly moving instead of on the next commit.
 *   Position commits always arrive via updateToken; refreshToken only
 *   re-runs the same registry-scoped check.
 * - Skips if either side has no token on the same scene.
 * - GM is the single writer: deletes the effect and posts a chat message:
 *   "Light on X expired — moved beyond 120 ft from Y"
 * - Idle is cost-free: a registry of live Light effects (seeded once at
 *   ready, kept via createItem/deleteItem/deleteActor) gates everything —
 *   with zero lights tracked, move handling returns after one Map-size
 *   check and never walks scenes, actors, or items.
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

	/** Registry of live Light effects: effectUuid -> { actorId, effectId }. */
	static _tracked = new Map();

	static ready() {
		if (game.user.isGM) this._seedRegistry();
		Hooks.on("updateToken", this._onUpdateToken.bind(this));
		Hooks.on("refreshToken", this._onRefreshToken.bind(this));
		Hooks.on("createItem", this._onCreateItem.bind(this));
		Hooks.on("deleteItem", this._onDeleteItem.bind(this));
		Hooks.on("deleteActor", this._onDeleteActor.bind(this));
	}

	/* -------------------------------------------- */
	/*  Registry — what makes idle cost-free        */
	/* -------------------------------------------- */

	/** One-time seed: pick up Light effects already present at load. */
	static _seedRegistry() {
		try {
			for (const actor of game.actors ?? []) {
				try {
					for (const item of actor.items ?? []) {
						if (item?.type === "effect" && this._isLightEffect(item) && item.uuid) {
							this._tracked.set(item.uuid, { actorId: actor.id, effectId: item.id });
						}
					}
				} catch { continue; }
			}
		} catch (e) {
			console.warn(`${Manager.id} | light-tether registry seed failed`, e);
		}
	}

	static _onCreateItem(item, _options, _userId) {
		if (!game.user.isGM) return;
		try {
			if (item?.type !== "effect" || !this._isLightEffect(item)) return;
			const actor = item.parent;
			if (!actor?.id || !item.uuid) return;
			this._tracked.set(item.uuid, { actorId: actor.id, effectId: item.id });
		} catch { /* never break item creation */ }
	}

	static _onDeleteItem(item, _options, _userId) {
		if (!game.user.isGM) return;
		try {
			if (item?.uuid) this._tracked.delete(item.uuid);
			// Fallback: purge by effect id in case the uuid form differs.
			if (item?.id) {
				for (const [key, ref] of this._tracked) {
					if (ref.effectId === item.id) this._tracked.delete(key);
				}
			}
		} catch { /* never break item deletion */ }
	}

	static _onDeleteActor(actor, _options, _userId) {
		if (!game.user.isGM) return;
		try {
			if (!actor?.id) return;
			for (const [key, ref] of this._tracked) {
				if (ref.actorId === actor.id) this._tracked.delete(key);
			}
		} catch { /* never break actor deletion */ }
	}

	/**
	 * Registry-scoped candidates for a scene: resolve tracked effects
	 * directly instead of walking every scene token and world actor.
	 * Stale entries (actor/effect gone, or no longer a Light effect) are
	 * dropped on sight — the registry self-heals.
	 */
	static _candidatesForScene(scene) {
		const out = [];
		for (const [key, ref] of [...this._tracked]) {
			let actor = null;
			let effect = null;
			try {
				actor = game.actors?.get(ref.actorId) ?? null;
				effect = actor?.items?.get(ref.effectId) ?? null;
			} catch {
				actor = null;
				effect = null;
			}
			if (!actor || !effect || !this._isLightEffect(effect)) {
				this._tracked.delete(key);
				continue;
			}
			if (effect.system?.expired) continue;
			const base = actor.baseActor ?? actor;
			if (!this._tokensForActorOnScene(base, scene).length) continue;
			out.push({ effect, targetActor: base });
		}
		return out;
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
		// Idle is cost-free: no tracked Light effects, no work at all.
		if (!this._tracked.size) return;
		const scene = tokenDoc.parent;
		if (!scene) return;
		this._pendingScenes.add(scene.id);
		clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => this._flushPending(), DEBOUNCE_MS);
		// Single immediate scoped check for the moved token; the debounced
		// flush above is the backstop for multi-token races.
		queueMicrotask(() => this._checkMovedToken(tokenDoc, scene).catch((e) =>
			console.warn(`${Manager.id} | light-tether moved check failed`, e)
		));
	}

	/**
	 * Canvas-side refreshes (drag-preview frames, slide-animation frames,
	 * hover/redraws). Position commits always arrive via updateToken; this
	 * hook only re-runs the registry-scoped check so removal lands while
	 * the token is visibly moving instead of waiting for the next commit.
	 * Gated on the registry first, so idle cost is a few guard reads.
	 */
	static _onRefreshToken(token) {
		if (!game.user.isActiveGM) return;
		if (!Manager.isEnabled(this.id)) return;
		// Idle is cost-free: no tracked Light effects, no work at all.
		if (!this._tracked.size) return;
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
		if (!this._tracked.size) {
			this._pendingScenes.clear();
			return;
		}
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
		const candidates = this._candidatesForScene(scene);
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
		const candidates = this._candidatesForScene(scene).filter(({ effect, targetActor }) => {
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
