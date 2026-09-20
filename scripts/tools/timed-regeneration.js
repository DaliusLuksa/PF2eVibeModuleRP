import { Manager } from "../core/manager.js";

/**
 * Timed Regeneration — generic interval system hooked to worldTime / Calendaria visualTick.
 *
 * Currently implements Aeon Stone (Pearly White Spindle): 1 HP per 60s.
 * Designed to be extensible: add entries to REGISTRY with different intervals
 * (e.g. 3600 for 1h, 86400 for 1d) and they will fire automatically.
 * Other tools can also register at runtime via TimedRegenerationTool.register()
 * or listen to Hooks.callAll("pf2e-vibemodulerp.timedTick", data).
 *
 * State: flags.pf2e-vibemodulerp.timedRegen = { [slug]: lastHealPredictedWorldTime }
 * Only the ActiveGM writes (prevents double-heal and ownership issues).
 * Anchor is the *predicted* worldTime at equip (so second-precision, not quantized to 60s ticks).
 */
export class TimedRegenerationTool {
	static id = "timed-regeneration";
	static category = "calendaria-combat-clock";
	static enabledDefault = true;

	static FLAG_KEY = "timedRegen";

	static REGISTRY = {
		"effect-aeon-stone-resonance-pearly-white-spindle": {
			interval: 60,
			handler: TimedRegenerationTool._healAeonStone.bind(TimedRegenerationTool)
		}
	};

	static register(slug, { interval, handler }) {
		if (!slug || !interval || typeof handler !== "function") {
			console.warn(`${Manager.id} | timed-regeneration register failed for ${slug}`);
			return;
		}
		this.REGISTRY[slug] = { interval, handler };
	}

	static init() {}

	/** last predictedWorldTime seen from Calendaria visualTick (for second-precise anchoring) */
	static _lastPredicted = null;

	static ready() {
		Hooks.on("updateWorldTime", this._onUpdateWorldTime.bind(this));
		Hooks.on("createItem", this._onCreateItem.bind(this));
		Hooks.on("deleteItem", this._onDeleteItem.bind(this));
		// Per-second precise tick while clock is running (gives exact equip-second alignment)
		Hooks.on("calendaria.visualTick", this._onVisualTick.bind(this));
		Hooks.on("calendaria.clockUpdate", this._onVisualTick.bind(this)); // fallback name
		if (game.user.isActiveGM) {
			// Anchors are persisted as *predicted* time (up to ~60s of uncommitted
			// seconds die with a reload), so after load an anchor can sit ahead of
			// committed worldTime and the first skip under-heals. Re-phase them now.
			this._clampAnchorsToWorldTime().catch(e =>
				console.warn(`${Manager.id} | timed-regen anchor clamp failed`, e));
		}
		try {
			const api = game.modules.get(Manager.id)?.api ?? {};
			api.timedRegeneration = {
				register: this.register.bind(this),
				registry: this.REGISTRY
			};
			if (game.modules.get(Manager.id)) game.modules.get(Manager.id).api = api;
		} catch {}
	}

	static _getPredictedWorldTime() {
		if (typeof this._lastPredicted === "number") return this._lastPredicted;
		// Fallback: game.time.worldTime (quantized) — better than nothing
		return game.time.worldTime;
	}

	static async _onVisualTick(data) {
		if (!this._enabled) return;
		if (!game.user.isActiveGM) return;
		// data may be {predictedWorldTime}, a number, or undefined
		let predicted = null;
		if (data && typeof data === "object" && typeof data.predictedWorldTime === "number") predicted = data.predictedWorldTime;
		else if (typeof data === "number") predicted = data;
		else if (data && typeof data.worldTime === "number") predicted = data.worldTime;
		if (typeof predicted !== "number") return;
		this._lastPredicted = predicted;

		// Use predicted for second-precise 60s checks; skip if we already handled this second via updateWorldTime large jump
		const actors = this._allActors();
		for (const actor of actors) {
			const effects = actor.itemTypes?.effect ?? [];
			if (!effects.length) continue;
			for (const [slug, cfg] of Object.entries(this.REGISTRY)) {
				if (!effects.some(e => e.slug === slug && !e.system?.expired)) continue;
				// Only per-second for small intervals; large intervals also work but updateWorldTime will catch up anyway
				await this._processActorInterval(actor, slug, cfg, predicted);
			}
		}
	}

	static async _onUpdateWorldTime(worldTime, dt) {
		if (!this._enabled) return;
		if (!game.user.isActiveGM) return;
		if (typeof dt !== "number" || dt === 0) return;
		if (worldTime == null) return;

		if (dt < 0) {
			const actors = this._allActors();
			for (const actor of actors) {
				const effects = actor.itemTypes?.effect ?? [];
				if (!effects.length) continue;
				for (const slug of Object.keys(this.REGISTRY)) {
					if (!effects.some(e => e.slug === slug && !e.system?.expired)) continue;
					const flags = actor.getFlag(Manager.id, this.FLAG_KEY) ?? {};
					const last = flags[slug];
					if (typeof last !== "number" || last <= worldTime) continue;
					const cfg = this.REGISTRY[slug];
					const interval = cfg?.interval ?? 60;
					// Preserve original second-phase: greatest <= worldTime with same phase as last
					const k = Math.floor((worldTime - last) / interval);
					const newLast = last + k * interval;
					await actor.setFlag(Manager.id, this.FLAG_KEY, { ...flags, [slug]: newLast });
				}
			}
			if (typeof this._lastPredicted === "number" && this._lastPredicted > worldTime) {
				// Keep predicted phase too, but visualTick will re-anchor via same logic
				this._lastPredicted = worldTime;
			}
			return;
		}

		// Keep predicted in sync after a worldTime jump (predicted == worldTime right after advance)
		this._lastPredicted = worldTime;

		const actors = this._allActors();
		for (const actor of actors) {
			if (!actor) continue;
			const effects = actor.itemTypes?.effect ?? [];
			if (!effects.length) continue;
			for (const [slug, cfg] of Object.entries(this.REGISTRY)) {
				const hasEffect = effects.some(e => e.slug === slug && !e.system?.expired);
				if (!hasEffect) continue;
				await this._processActorInterval(actor, slug, cfg, worldTime);
			}
		}
	}

	/** Per actor+effect promise chain: visualTick and updateWorldTime are
	 * concurrent async drivers (core fires updateWorldTime via Hooks.callAll,
	 * which never awaits async listeners, so back-to-back commits overlap).
	 * Runs are serialized and each re-reads the anchor fresh — no double-heal,
	 * no dropped windows, exact tick counts. */
	static _queues = new Map();

	static async _processActorInterval(actor, slug, cfg, time) {
		const interval = cfg.interval;
		if (!interval || interval <= 0) return;

		const key = `${actor?.uuid ?? actor?.id}|${slug}`;
		const prev = (this._queues.get(key) ?? Promise.resolve()).catch(() => {});
		const cur = prev.then(() => this._processActorIntervalInner(actor, slug, cfg, time));
		this._queues.set(key, cur);
		try {
			await cur;
		} catch (e) {
			console.warn(`${Manager.id} | timed tick failed for ${slug} on ${actor?.name}`, e);
		} finally {
			if (this._queues.get(key) === cur) this._queues.delete(key);
		}
	}

	static async _processActorIntervalInner(actor, slug, cfg, time) {
		const interval = cfg.interval;
		if (!interval || interval <= 0) return;

		const flags = actor.getFlag(Manager.id, this.FLAG_KEY) ?? {};
		let last = flags[slug];

		if (typeof last !== "number") {
			await actor.setFlag(Manager.id, this.FLAG_KEY, { ...flags, [slug]: time });
			return;
		}

		let elapsed = time - last;
		if (elapsed < 0) {
			const interval = cfg.interval ?? 60;
			const k = Math.floor((time - last) / interval);
			const newLast = last + k * interval;
			await actor.setFlag(Manager.id, this.FLAG_KEY, { ...flags, [slug]: newLast });
			return;
		}
		if (elapsed < interval) return;

		const ticks = Math.floor(elapsed / interval);
		if (ticks <= 0) return;

		const newLast = last + ticks * interval;
		try {
			Hooks.callAll("pf2e-vibemodulerp.timedTick", {
				actor,
				slug,
				interval,
				ticks,
				worldTime: time,
				elapsed
			});
			await cfg.handler(actor, ticks, { slug, interval, worldTime: time, elapsed });
			const currentFlags = actor.getFlag(Manager.id, this.FLAG_KEY) ?? {};
			await actor.setFlag(Manager.id, this.FLAG_KEY, { ...currentFlags, [slug]: newLast });
		} catch (e) {
			console.warn(`${Manager.id} | timed tick failed for ${slug} on ${actor.name}`, e);
		}
	}

	static async _onCreateItem(item, options, userId) {
		if (!this._enabled) return;
		if (!game.user.isActiveGM) return;
		if (item?.type !== "effect") return;
		const slug = item.slug ?? item.system?.slug;
		if (!slug || !this.REGISTRY[slug]) return;
		if (item.system?.expired) return;
		const actor = item.parent;
		if (!actor || actor.documentName !== "Actor") return;
		try {
			const flags = actor.getFlag(Manager.id, this.FLAG_KEY) ?? {};
			const anchor = this._getPredictedWorldTime();
			await actor.setFlag(Manager.id, this.FLAG_KEY, { ...flags, [slug]: anchor });
		} catch (e) {
			console.warn(`${Manager.id} | timed-regen anchor failed on create for ${slug}`, e);
		}
	}

	static async _onDeleteItem(item, options, userId) {
		if (!this._enabled) return;
		if (!game.user.isActiveGM) return;
		if (item?.type !== "effect") return;
		const slug = item.slug ?? item.system?.slug;
		if (!slug || !this.REGISTRY[slug]) return;
		const actor = item.parent;
		if (!actor || actor.documentName !== "Actor") return;
		try {
			const flags = actor.getFlag(Manager.id, this.FLAG_KEY) ?? {};
			if (!(slug in flags)) return;
			const next = { ...flags };
			delete next[slug];
			await actor.setFlag(Manager.id, this.FLAG_KEY, next);
		} catch (e) {
			console.warn(`${Manager.id} | timed-regen cleanup failed for ${slug}`, e);
		}
	}

	/** Move any persisted anchor that lies ahead of committed worldTime back to
	 * the same phase at-or-before worldTime (same math as the rewind branch). */
	static async _clampAnchorsToWorldTime() {
		if (!this._enabled) return;
		const worldTime = game.time?.worldTime;
		if (typeof worldTime !== "number") return;
		for (const actor of this._allActors()) {
			if (!actor) continue;
			let flags;
			try { flags = actor.getFlag(Manager.id, this.FLAG_KEY) ?? {}; }
			catch { continue; }
			let changed = false;
			const next = { ...flags };
			for (const [slug, cfg] of Object.entries(this.REGISTRY)) {
				const last = next[slug];
				if (typeof last !== "number" || last <= worldTime) continue;
				const interval = cfg?.interval ?? 60;
				next[slug] = last + Math.floor((worldTime - last) / interval) * interval;
				changed = true;
			}
			if (changed) {
				try { await actor.setFlag(Manager.id, this.FLAG_KEY, next); }
				catch (e) { console.warn(`${Manager.id} | anchor clamp failed on ${actor.name}`, e); }
			}
		}
	}

	static _allActors() {		const seen = new Set();
		const out = [];
		for (const scene of game.scenes ?? []) {
			for (const token of scene.tokens ?? []) {
				const actor = token.actor;
				if (actor && !seen.has(actor.id)) {
					seen.add(actor.id);
					out.push(actor);
				}
			}
		}
		for (const actor of game.actors ?? []) {
			if (!seen.has(actor.id)) {
				seen.add(actor.id);
				out.push(actor);
			}
		}
		return out;
	}

	static get _enabled() {
		return Manager.isEnabled(this.id);
	}

	static async _healAeonStone(actor, ticks) {
		const hp = actor.system?.attributes?.hp;
		if (!hp) return;
		const current = Number(hp.value ?? 0);
		const max = Number(hp.max ?? 0);
		if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return;
		if (current >= max) return;
		const amount = Math.min(ticks, max - current);
		if (amount <= 0) return;
		const newValue = current + amount;
		try {
			await actor.update({ "system.attributes.hp.value": newValue });
		} catch (e) {
			console.warn(`${Manager.id} | aeon stone heal failed for ${actor.name}`, e);
		}
	}
}
