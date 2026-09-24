import { Manager } from "../core/manager.js";
import { rememberWindowPosition } from "../core/window-positions.js";
import { RangerHubTool } from "./ranger-hub.js";
import { ActionTrackerTool } from "./action-tracker.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_APPLY = "rangerFlurryApply";
const SOCKET_ACTION_RESULT = "rangerFlurryApplyResult";
const GM_TIMEOUT_MS = 20000;
const MODULE_ROOT = "modules/pf2e-vibemodulerp";

const HUNTED_SHOT_SLUG = "hunted-shot";
const HUNT_PREY_EFFECT_SLUG = "effect-hunt-prey";
const GRAVITY_EFFECT_SLUG = "spell-effect-gravity-weapon";
const EXPERTISE_SLUG = "ranger-weapon-expertise";
const MARK_SLUG = "hunted-prey";
const IMMOBILIZED_SLUG = "immobilized";
const GRAVITY_DOMAIN = "damage";
const GRAVITY_OPTION = "gravity-weapon";
const FLAG_KEY = "rangerFlurry";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ranger Flurry (Hunted Shot automation).
 *
 * Window (opened from the Ranger Hub button) holds two ammo dropdowns side
 * by side plus a Shoot button. Shoot validates (ranger gate, exactly one
 * non-self target, Hunted Shot feat, Effect: Hunt Prey present, target is
 * the marked prey via the system's own `synthetics.tokenMarks` map, flourish
 * once per turn, bow + ammo available) and then fires two Strikes with the
 * auto-picked equipped reload-0 bow using the native strike variants (MAP
 * handled by the system, dialogs hidden, ammo consumed natively per shot).
 * Each shot's damage rolls with that shot's ammo re-selected (fresh strike,
 * attack-linked checkContext), so special-ammo damage applies per shot.
 * Both hits on the single target merge into one combined damage card
 * (Hunted Shot combines for resistances/weaknesses).
 *
 * Gravity Weapon (house rule: bonus goes on the FIRST LANDED hit, whichever
 * shot): only when the ranger carries Spell Effect: Gravity Weapon. The
 * effect's damage rule hangs off the toggleable `gravity-weapon` roll
 * option, so the macro flips it via `actor.toggleRollOption("damage",
 * "gravity-weapon", bool)` around exactly one damage roll and restores the
 * prior state afterwards (never left on).
 *
 * Weapon Expertise: on any crit vs the marked prey while the ranger has the
 * feat, the target gains Immobilized (owner-direct `increaseCondition`,
 * else GM-routed over the module socket — the system never auto-applies
 * crit specs, so there is no double-apply).
 *
 * No GM socket routing for rolls: the gate guarantees OWNER (owners roll
 * their own Ranger; the GM rolls anything). Only the Immobilized write is
 * GM-routed, mirroring MonkFlurryTool.
 */
export class RangerFlurryTool {
	static id = "ranger-flurry";
	static category = "ranger-hub";
	static enabledDefault = true;

	static _window = null;
	static _busy = false;
	static _pending = new Map();
	static _flourish = new Map(); // actorId -> { combatId, round, turn }

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static init() {
		try {
			const api = game.modules.get(Manager.id).api ?? {};
			game.modules.get(Manager.id).api = api;
			api.rangerFlurry = () => this.openWindow();
			globalThis.rangerFlurry = () => this.openWindow();
		} catch {}
	}

	static ready() {
		Hooks.on("combatTurnChange", () => this._pruneFlourish());
		Hooks.on("deleteCombat", (combat) => {
			for (const [actorId, v] of this._flourish.entries()) {
				if (v.combatId === combat?.id) this._flourish.delete(actorId);
			}
		});
		game.socket.on(SOCKET_EVENT, this._onSocket.bind(this));
		Hooks.on("renderChatMessageHTML", this._onRenderChatMessage.bind(this));
		console.debug(`${Manager.id} | ranger-flurry ready`);
	}

	/* -------------------------------------------- */
	/*  Window                                      */
	/* -------------------------------------------- */

	static openWindow() {
		if (!Manager.isEnabled(this.id)) {
			ui.notifications?.warn?.(Manager.localize("rangerFlurry.notify.disabled"));
			return;
		}
		if (!this._window) this._window = new RangerFlurryWindow();
		this._window.render({ force: true }).catch((error) =>
			console.warn(`${Manager.id} | could not open ranger flurry`, error)
		);
	}

	static closeWindow() {
		if (this._window) {
			this._window.close().catch(() => null);
			this._window = null;
		}
	}

	static _render() {
		try {
			this._window?.render?.({ focus: false })?.catch?.(() => null);
		} catch {}
	}

	static async _onShootClick() {
		try {
			const root = this._window?.element;
			const ammo1 = root?.querySelector?.('select[name="ammo1"]')?.value ?? "";
			const ammo2 = root?.querySelector?.('select[name="ammo2"]')?.value ?? "";
			this.closeWindow();
			await this.execute(ammo1, ammo2);
		} catch (error) {
			console.error(`${Manager.id} | ranger flurry shoot failed`, error);
		}
	}

	/** Ammo stacks the window can offer (type ammo, quantity > 0, by name). */
	static _ammoList(actor) {
		return (actor?.items ?? [])
			.filter((i) => i?.type === "ammo" && Number(i.system?.quantity ?? 0) > 0)
			.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
			.map((i) => ({ id: i.id, label: `${i.name} (${i.system.quantity})` }));
	}

	static _windowContext() {
		const i18n = (key, data) => Manager.localize(`rangerFlurry.${key}`, data);
		const resolved = RangerHubTool._resolveRanger();
		if (!resolved.ok) {
			const reasonKey =
				resolved.reason === "notCharacter"
					? "gateNotCharacter"
					: resolved.reason === "notRanger"
						? "gateNotRanger"
						: resolved.reason === "noOwner"
							? "gateNoOwner"
							: "gateNone";
			return {
				gated: false,
				gateMessage: Manager.localize(`rangerHub.${reasonKey}`, { name: resolved.actorName ?? "" }),
				i18n
			};
		}
		const actor = resolved.actor;
		const ammo = this._ammoList(actor);
		let memory = {};
		try {
			memory = actor.getFlag?.(Manager.id, FLAG_KEY) ?? {};
		} catch {}
		const valid = new Set(ammo.map((a) => a.id));
		const sel1 = valid.has(memory.ammo1) ? memory.ammo1 : (ammo[0]?.id ?? "");
		const sel2 = valid.has(memory.ammo2) ? memory.ammo2 : (ammo[0]?.id ?? "");
		const bow = this._resolveBow(actor);
		const target = [...(game.user?.targets ?? [])][0] ?? null;
		return {
			gated: true,
			rangerName: actor.name,
			bowName: bow?.item?.name ?? null,
			targetName: target?.actor?.name ?? target?.name ?? null,
			ammo: ammo.map((a) => ({ ...a, selected1: a.id === sel1, selected2: a.id === sel2 })),
			i18n
		};
	}

	/* -------------------------------------------- */
	/*  Resolution helpers                          */
	/* -------------------------------------------- */

	/** First equipped (else first) reload-0 ranged weapon strike action. */
	static _resolveBow(actor) {
		const actions = actor?.system?.actions ?? [];
		const cands = actions.filter((a) => {
			const item = a?.item;
			if (!item || item.type !== "weapon") return false;
			if (String(item.system?.reload?.value ?? "") !== "0") return false;
			const traits = item.system?.traits?.value ?? [];
			if (traits.includes("ranged")) return true;
			if ((item.group ?? "") === "bow") return true;
			return false;
		});
		if (!cands.length) return null;
		return cands.find((a) => a.item?.isEquipped) ?? cands[0];
	}

	/**
	 * Fresh strike action for the weapon, re-read from the actor's prepared
	 * actions. Every `selectedAmmoId` swap re-prepares the actor, so a strike
	 * resolved before the swap carries stale ammo roll options/modifiers.
	 * Falls back to null (caller keeps its previous reference).
	 */
	static _resolveStrikeFor(attacker, weaponItem) {
		try {
			const actions = attacker?.system?.actions ?? [];
			return actions.find((a) => a?.item?.id === weaponItem?.id && a?.type === "strike") ?? null;
		} catch {
			return null;
		}
	}

	static _isMarkedPrey(attacker, targetToken) {
		try {
			const marks = attacker?.synthetics?.tokenMarks?.get?.(targetToken?.document?.uuid) ?? [];
			return [...marks].includes(MARK_SLUG);
		} catch {
			return false;
		}
	}

	static _hasUsedFlourish(actor) {
		try {
			if (!game.combat?.started) return false;
			const v = this._flourish.get(actor?.id);
			if (!v) return false;
			return v.combatId === game.combat.id && v.round === game.combat.round && v.turn === game.combat.turn;
		} catch {
			return false;
		}
	}

	static _markUsedFlourish(actor) {
		try {
			if (!game.combat?.started || !actor?.id) return;
			this._flourish.set(actor.id, {
				combatId: game.combat.id,
				round: game.combat.round,
				turn: game.combat.turn
			});
		} catch {}
	}

	static _pruneFlourish() {
		try {
			const cid = game.combat?.id ?? null;
			for (const [actorId, v] of this._flourish.entries()) {
				if (v.combatId !== cid) this._flourish.delete(actorId);
			}
		} catch {}
	}

	/* -------------------------------------------- */
	/*  Execute                                     */
	/* -------------------------------------------- */

	static async execute(ammoId1, ammoId2) {
		if (this._busy) return;
		const t = (key, data) => Manager.localize(`rangerFlurry.notify.${key}`, data);
		if (!Manager.isEnabled(this.id)) {
			ui.notifications?.warn?.(t("disabled"));
			return;
		}
		// Gate: ranger selected + owned.
		const resolved = RangerHubTool._resolveRanger();
		if (!resolved.ok) {
			const reasonKey =
				resolved.reason === "notCharacter"
					? "gateNotCharacter"
					: resolved.reason === "notRanger"
						? "gateNotRanger"
						: resolved.reason === "noOwner"
							? "gateNoOwner"
							: "gateNone";
			ui.notifications?.warn?.(Manager.localize(`rangerHub.${reasonKey}`, { name: resolved.actorName ?? "" }));
			return;
		}
		const attacker = resolved.actor;
		const attackerToken = resolved.token;
		// Exactly one target, not self.
		const targets = [...(game.user?.targets ?? [])];
		if (targets.length !== 1 || !targets[0]?.actor) {
			ui.notifications?.warn?.(t("noTarget"));
			return;
		}
		const targetToken = targets[0];
		const targetActor = targetToken.actor;
		if (targetActor.uuid === attacker.uuid) {
			ui.notifications?.warn?.(t("selfTarget"));
			return;
		}
		try {
			targetToken.setTarget(true, { releaseOthers: false });
		} catch {}
		// Strict Hunted Shot requirements: feat + effect + marked prey.
		if (!attacker.items.some((i) => i.slug === HUNTED_SHOT_SLUG)) {
			ui.notifications?.warn?.(t("noFeat"));
			return;
		}
		if (!attacker.items.some((i) => i.type === "effect" && i.slug === HUNT_PREY_EFFECT_SLUG)) {
			ui.notifications?.warn?.(t("noHuntPrey"));
			return;
		}
		if (!this._isMarkedPrey(attacker, targetToken)) {
			ui.notifications?.warn?.(t("notMarked", { name: targetActor.name }));
			return;
		}
		if (this._hasUsedFlourish(attacker)) {
			ui.notifications?.warn?.(t("flourish"));
			return;
		}
		const strike = this._resolveBow(attacker);
		if (!strike || strike.variants?.length < 2) {
			ui.notifications?.warn?.(t("noBow"));
			return;
		}
		const weaponItem = strike.item;
		const a1 = attacker.items.get(ammoId1);
		const a2 = attacker.items.get(ammoId2);
		if (!a1 || !a2 || a1.type !== "ammo" || a2.type !== "ammo") {
			ui.notifications?.warn?.(t("noAmmo"));
			return;
		}
		const need = new Map();
		for (const a of [a1, a2]) need.set(a.id, (need.get(a.id) ?? 0) + 1);
		for (const [id, n] of need) {
			if (Number(attacker.items.get(id)?.system?.quantity ?? 0) < n) {
				ui.notifications?.warn?.(t("noAmmo"));
				return;
			}
		}
		// Remember ammo choice (UI memory only).
		try {
			await attacker.setFlag(Manager.id, FLAG_KEY, { ammo1: a1.id, ammo2: a2.id });
		} catch {}

		this._busy = true;
		// Flourish is consumed once validations pass (a failed macro still
		// counts, mirroring the monk's Flurry).
		this._markUsedFlourish(attacker);
		// Action Tracker: 1 action + both attack-rolls shown free.
		try {
			await ActionTrackerTool.logAndSuppress(attacker, {
				name: "Flurry",
				cost: 1,
				icon: weaponItem.img ? { img: weaponItem.img } : { fa: "fa-bow-arrow" },
				suppress: { free: { count: 2, types: ["attack-roll"] } }
			});
		} catch (e) {
			console.warn(`${Manager.id} | ranger flurry action-tracker failed`, e);
		}
		// Fully automatic: hide all roll dialogs in-memory for the macro.
		let prevCheckDialogs;
		let prevDamageDialogs;
		try {
			prevCheckDialogs = game.user.flags.pf2e.settings.showCheckDialogs;
			prevDamageDialogs = game.user.flags.pf2e.settings.showDamageDialogs;
			game.user.flags.pf2e.settings.showCheckDialogs = false;
			game.user.flags.pf2e.settings.showDamageDialogs = false;
		} catch {}
		const hasGravity = attacker.items.some((i) => i.slug === GRAVITY_EFFECT_SLUG);
		const gravityRule = () =>
			(attacker.rules ?? []).find((r) => r.key === "RollOption" && r.domain === GRAVITY_DOMAIN && r.option === GRAVITY_OPTION) ?? null;
		let initialGravity = false;
		try {
			initialGravity = gravityRule()?.active === true;
		} catch {}
		const setGravity = async (on) => {
			try {
				await attacker.toggleRollOption(GRAVITY_DOMAIN, GRAVITY_OPTION, Boolean(on));
			} catch (e) {
				console.warn(`${Manager.id} | ranger flurry gravity toggle failed`, e);
			}
		};
		const hasExpertise = attacker.items.some((i) => i.slug === EXPERTISE_SLUG);
		const lines = [];
		try {
			// Shot 1 (MAP 0). The strike is re-resolved after the swap: the
			// selectedAmmoId update re-prepares the actor, and the pre-swap
			// strike snapshot would carry stale ammo roll options/modifiers.
			await weaponItem.update({ "system.selectedAmmoId": a1.id });
			const strike1 = this._resolveStrikeFor(attacker, weaponItem) ?? strike;
			const s1 = await this._rollAttack(strike1.variants[0]);
			if (!s1.msg) {
				ui.notifications?.warn?.(t("shotFailed", { n: 1 }));
				return;
			}
			const f1 = await this._autoFlatCheck(s1.msg);
			const hit1 = s1.hit && f1.ok;
			const crit1 = s1.crit && f1.ok;
			const fumble1 = s1.fumble && f1.ok;
			lines.push(`Shot 1 (${a1.name}): ${crit1 ? "critical hit" : fumble1 ? "critical miss" : hit1 ? "hit" : "miss"}${f1.miss ? " — flat check failed" : ""}`);
			await sleep(250);
			// Shot 2 (MAP -5 or agile -4, system-native).
			await weaponItem.update({ "system.selectedAmmoId": a2.id });
			const strike2 = this._resolveStrikeFor(attacker, weaponItem) ?? strike;
			const s2 = await this._rollAttack(strike2.variants[1]);
			if (!s2.msg) {
				ui.notifications?.warn?.(t("shotFailed", { n: 2 }));
				return;
			}
			const f2 = await this._autoFlatCheck(s2.msg);
			const hit2 = s2.hit && f2.ok;
			const crit2 = s2.crit && f2.ok;
			const fumble2 = s2.fumble && f2.ok;
			lines.push(`Shot 2 (${a2.name}): ${crit2 ? "critical hit" : fumble2 ? "critical miss" : hit2 ? "hit" : "miss"}${f2.miss ? " — flat check failed" : ""}`);
			// Damage, one shot at a time with that shot's ammo re-selected.
			// Both damages previously rolled while ammo2 was still selected,
			// so shot 1 never saw special-ammo damage (e.g. Gravebane
			// vitality). Ruled ammo survives its attack's consumption at
			// quantity 0 instead of being deleted, so re-selecting it still
			// resolves for the damage roll.
			// Gravity bonus rides the FIRST LANDED hit (house rule).
			const gravityShot = hasGravity ? (hit1 ? 1 : hit2 ? 2 : 0) : 0;
			let d1 = null;
			let d2 = null;
			if (hit1) {
				await weaponItem.update({ "system.selectedAmmoId": a1.id });
				const ds1 = this._resolveStrikeFor(attacker, weaponItem) ?? strike1;
				if (gravityShot === 1) await setGravity(true);
				try {
					d1 = await this._rollDamage(ds1, crit1, s1.msg, targetToken);
				} finally {
					if (gravityShot === 1) await setGravity(false);
				}
			}
			if (hit2) {
				await weaponItem.update({ "system.selectedAmmoId": a2.id });
				const ds2 = this._resolveStrikeFor(attacker, weaponItem) ?? strike2;
				if (gravityShot === 2) await setGravity(true);
				try {
					d2 = await this._rollDamage(ds2, crit2, s2.msg, targetToken);
				} finally {
					if (gravityShot === 2) await setGravity(false);
				}
			}
			if (gravityShot === 1) lines.push(`Gravity Weapon bonus applied to shot 1.`);
			else if (gravityShot === 2) lines.push(`Shot 1 missed — Gravity Weapon bonus applied to shot 2.`);
			else if (hasGravity) lines.push(`No landed hit — Gravity Weapon bonus unused.`);
			// Combined damage card whenever at least one shot landed (Flurry of
			// Blows always shows it — players read this card, not the natives).
			if (d1?.roll || d2?.roll) {
				await this._postCombinedDamage(attacker, attackerToken, targetActor, targetToken, d1?.roll ?? null, d2?.roll ?? null, weaponItem);
			}
			// Weapon Expertise: crit vs marked prey immobilizes (once).
			let immobilized = false;
			if (hasExpertise && (crit1 || crit2)) {
				immobilized = await this._applyImmobilized(targetActor);
			}
			if (crit1 || crit2) {
				if (!hasExpertise) lines.push(`No Ranger Weapon Expertise — no immobilization.`);
				else if (immobilized) lines.push(`${targetActor.name} is immobilized (Weapon Expertise crit).`);
				else lines.push(`${targetActor.name} already immobilized.`);
			}
			await this._postSummary(attacker, attackerToken, lines);
		} catch (error) {
			console.error(`${Manager.id} | ranger flurry failed`, error);
			ui.notifications?.warn?.(t("failed", { name: attacker.name }));
		} finally {
			try {
				await attacker.toggleRollOption(GRAVITY_DOMAIN, GRAVITY_OPTION, initialGravity);
			} catch {}
			try {
				if (prevCheckDialogs !== undefined) game.user.flags.pf2e.settings.showCheckDialogs = prevCheckDialogs;
				if (prevDamageDialogs !== undefined) game.user.flags.pf2e.settings.showDamageDialogs = prevDamageDialogs;
			} catch {}
			this._busy = false;
			this._render();
		}
	}

	/* -------------------------------------------- */
	/*  Rolls                                       */
	/* -------------------------------------------- */

	/** Run fn, return { result, msg } with the new attack/damage message. */
	static async _capture(fn, type) {
		const known = new Set(game.messages.contents.map((m) => m.id));
		const result = await fn();
		let msg = null;
		for (let i = 0; i < 40 && !msg; i++) {
			await sleep(50);
			msg =
				game.messages.contents
					.filter((m) => !known.has(m.id) && m.flags?.pf2e?.context?.type === type)
					.pop() ?? null;
		}
		return { result, msg };
	}

	static async _rollAttack(variant) {
		const { result, msg } = await this._capture(
			() => variant.roll({ skipDialog: true, consumeAmmo: true }),
			"attack-roll"
		);
		if (!msg) return { roll: result, msg: null, hit: false, crit: false, fumble: false };
		const outcome = msg.flags?.pf2e?.context?.outcome ?? null;
		return {
			roll: result,
			msg,
			hit: outcome === "success" || outcome === "criticalSuccess",
			crit: outcome === "criticalSuccess",
			fumble: outcome === "criticalFailure"
		};
	}

	static async _rollDamage(strike, isCrit, attackMsg = null, targetToken = null) {
		// Mirror the chat-card Damage/Critical buttons (system strike-damage
		// handler): link the damage to its attack, resolve target-dependent
		// options on the real target instead of whoever is targeted now, and
		// carry MAP increases through. Without an explicit checkContext the
		// system falls back to matching a recent attack message, which can
		// cross-link when two shots land seconds apart.
		const ctx = attackMsg?.flags?.pf2e?.context ?? null;
		const opts = { skipDialog: true };
		if (ctx) opts.checkContext = ctx;
		if (targetToken) opts.target = targetToken;
		if (typeof ctx?.mapIncreases === "number") opts.mapIncreases = ctx.mapIncreases;
		const { result, msg } = await this._capture(
			() => (isCrit ? strike.critical(opts) : strike.damage(opts)),
			"damage-roll"
		);
		if (msg) await this._waitDice(msg);
		return { roll: result, msg };
	}

	static async _waitDice(msg) {
		try {
			const p = game.dice3d?.waitFor3DAnimationByMessageID?.(msg.id);
			if (!p) return;
			await Promise.race([p, sleep(4000)]);
			await sleep(250);
		} catch {}
	}

	/**
	 * Native concealed/hidden flat check: auto-click the system's own
	 * button on the rendered attack card and read the filled result.
	 * The card re-renders after the click, so the element is re-queried
	 * on every poll — a stale reference would never see the result and
	 * silently count a miss as a hit (mirrors MonkFlurryTool).
	 */
	static _getMessageElement(message) {
		try {
			const id = message?.id ?? message;
			return document.querySelector(`li.chat-message[data-message-id="${id}"]`) ?? null;
		} catch {
			return null;
		}
	}

	static async _autoFlatCheck(msg) {
		try {
			let el = this._getMessageElement(msg);
			if (!el) {
				await sleep(120);
				el = this._getMessageElement(msg);
			}
			const btn = el?.querySelector?.('button[data-action="roll-flatcheck"]');
			if (!btn) return { ok: true, miss: false };
			const dc = Number(btn.dataset?.dc ?? 5) || 5;
			// If already rolled (user clicked mid-macro), parse it instead of re-rolling.
			const before = el.querySelector(".fc-rolls");
			if (before && before.textContent.trim() && before.children.length) {
				const num = parseInt(before.textContent) || 0;
				const success = before.querySelector(".success, .criticalSuccess")
					? true
					: before.querySelector(".failure, .criticalFailure")
						? false
						: num >= dc;
				return success ? { ok: true, miss: false } : { ok: false, miss: true };
			}
			btn.click();
			for (let i = 0; i < 30; i++) {
				await sleep(80);
				el = this._getMessageElement(msg);
				const box = el?.querySelector?.(".fc-rolls");
				const text = box?.textContent?.trim() ?? "";
				if (!text) continue;
				const rollEl = box.querySelector(".fc-roll, .dice-total, span");
				let total = 0;
				let success = false;
				if (rollEl) {
					total = parseInt(rollEl.textContent) || parseInt(text) || 0;
					success = rollEl.classList.contains("success") || rollEl.classList.contains("criticalSuccess") || box.querySelector(".success") !== null;
					const hasFail = rollEl.classList.contains("failure") || rollEl.classList.contains("criticalFailure") || box.querySelector(".failure") !== null;
					if (hasFail) success = false;
					if (!rollEl.classList.contains("success") && !rollEl.classList.contains("failure")) success = total >= dc;
				} else {
					total = parseInt(text) || 0;
					success = total >= dc;
				}
				return success ? { ok: true, miss: false } : { ok: false, miss: true };
			}
			return { ok: true, miss: false };
		} catch {
			return { ok: true, miss: false };
		}
	}

	/* -------------------------------------------- */
	/*  Chat cards                                  */
	/* -------------------------------------------- */

	static async _postCombinedDamage(attacker, attackerToken, targetActor, targetToken, roll1, roll2, weaponItem) {
		try {
			const byType = new Map();
			for (const roll of [roll1, roll2]) {
				for (const inst of roll?.instances ?? []) {
					if (inst?.persistent) continue;
					const type = String(inst.type ?? "untyped");
					const cur = byType.get(type) ?? { total: 0, materials: [] };
					cur.total += Number(inst.total ?? 0);
					for (const m of inst.materials ?? []) {
						if (m && !cur.materials.includes(m)) cur.materials.push(m);
					}
					byType.set(type, cur);
				}
			}
			const entries = [...byType.entries()].map(([type, v]) => ({ type, total: v.total, materials: v.materials }));
			const combinedTotal = entries.reduce((sum, e) => sum + e.total, 0);
			const rawType = String(
				weaponItem?.system?.damage?.damageType ?? weaponItem?.system?.damage?.base?.damageType ?? "piercing"
			).toLowerCase();
			const titleCase = (s) => {
				s = String(s ?? "");
				return s.charAt(0).toUpperCase() + s.slice(1);
			};
			const breakdown = entries.length
				? entries.map((e) => `${e.total} ${titleCase(e.type)}`).join(" + ")
				: `${combinedTotal} ${titleCase(rawType)}`;
			let formula = `{${combinedTotal}[${rawType}]}`;
			if (entries.length) {
				const candidate = `{${entries
					.map((e) => `${e.total}[${e.type}${e.materials?.length ? `,${e.materials.join(",")}` : ""}]`)
					.join(",")}}`;
				try {
					const Cls = foundry.dice?.rolls?.DamageRoll ?? CONFIG?.Dice?.rolls?.find?.((c) => c.name === "DamageRoll") ?? null;
					if (Cls?.validate?.(candidate)) formula = candidate;
				} catch {}
			}
			let roll = null;
			try {
				const DamageRollCls = foundry.dice?.rolls?.DamageRoll ?? CONFIG?.Dice?.rolls?.find?.((c) => c.name === "DamageRoll") ?? null;
				roll = DamageRollCls ? await new DamageRollCls(formula).evaluate() : await new Roll(formula).evaluate();
			} catch {
				roll = await new Roll(`${combinedTotal}`).evaluate();
			}
			const flavor =
				`<h4 class="action"><strong>Damage Roll: Flurry (Combined)</strong> <span class="subtitle degree-of-success">(<span class="success">Hit</span>)</span></h4>` +
				`<div class="tags" data-tooltip-class="pf2e"><span class="tag" data-tooltip="PF2E.TraitDescriptionAttack" data-trait="attack">Attack</span>` +
				`<hr class="vr"><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionRanged">Ranged</span></div><hr>` +
				`<div class="tags modifiers"><span class="tag tag_transparent" data-visibility="gm">${breakdown}</span>` +
				`<span class="tag tag_transparent" data-visibility="gm">${weaponItem?.name ?? "Bow"}</span></div>`;
			await ChatMessage.create({
				speaker: ChatMessage.getSpeaker({ actor: attacker, token: attackerToken?.document ?? null }),
				flavor,
				content: `${combinedTotal}`,
				rolls: [roll],
				flags: {
					pf2e: {
						context: {
							type: "damage-roll",
							sourceType: "attack",
							actor: attacker.id,
							token: attackerToken.id ?? null,
							target: { actor: targetActor.id, token: targetToken.id },
							domains: ["ranger-flurry-damage", "strike-damage", "damage"],
							options: ["attack", "damage", "hunted-shot"],
							outcome: "success",
							notes: [],
							secret: false
						},
						origin: { actor: attacker.uuid, type: "weapon" }
					},
					[Manager.id]: { rangerFlurryCombined: true }
				}
			});
		} catch (error) {
			console.warn(`${Manager.id} | ranger flurry combined card failed (native cards remain)`, error);
		}
	}

	static async _postSummary(attacker, attackerToken, lines) {
		try {
			const items = lines.map((l) => `<li>${l}</li>`).join("");
			await ChatMessage.create({
				speaker: ChatMessage.getSpeaker({ actor: attacker, token: attackerToken?.document ?? null }),
				flavor: Manager.localize("rangerFlurry.summaryTitle"),
				content: `<div class="rf-summary"><ul>${items}</ul></div>`
			});
		} catch (error) {
			console.warn(`${Manager.id} | ranger flurry summary failed`, error);
		}
	}

	/**
	 * Card highlight: reuse the Flurry of Blows class verbatim
	 * (`monk-flurry-combined` from monk-flurry.css) — no custom card CSS.
	 * Only the combined damage card is styled, exactly like the monk macro
	 * (its summary stays unstyled text). Cards are identified by our own
	 * flag, styled by the monk class.
	 */
	static _onRenderChatMessage(message, html) {
		try {
			const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
			if (!root) return;
			if (message?.getFlag?.(Manager.id, "rangerFlurryCombined")) {
				root.classList?.add("monk-flurry-combined");
			}
		} catch {}
	}

	/* -------------------------------------------- */
	/*  Immobilized (owner direct, else GM socket)  */
	/* -------------------------------------------- */

	static async _applyImmobilized(targetActor) {
		try {
			if (targetActor.testUserPermission(game.user, "OWNER")) {
				if (targetActor.hasCondition?.(IMMOBILIZED_SLUG)) return false;
				await targetActor.increaseCondition(IMMOBILIZED_SLUG);
				return true;
			}
			const result = await this._requestGmApply(targetActor.uuid);
			return Boolean(result.applied);
		} catch (error) {
			console.error(`${Manager.id} | ranger flurry immobilized failed`, error);
			return false;
		}
	}

	static _requestGmApply(actorUuid) {
		return new Promise((resolve) => {
			const gm = game.users.find((u) => u.isGM && u.active);
			if (!gm) {
				ui.notifications?.warn?.(Manager.localize("rangerFlurry.notify.noGm", { name: "" }));
				resolve({ applied: false, noGm: true });
				return;
			}
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => {
				this._pending.delete(requestId);
				resolve({ applied: false, timeout: true });
			}, GM_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, timer });
			game.socket.emit(
				SOCKET_EVENT,
				{ action: SOCKET_ACTION_APPLY, requestId, actorUuid },
				{ recipients: [gm.id] }
			);
		});
	}

	static _onSocket(data, senderId) {
		try {
			if (!data?.action) return;
			if (data.action === SOCKET_ACTION_APPLY) {
				if (!game.user.isGM) return;
				this._handleGmApply(data, senderId).catch((error) =>
					console.error(`${Manager.id} | ranger flurry GM apply failed`, error)
				);
			} else if (data.action === SOCKET_ACTION_RESULT) {
				const pending = this._pending.get(data?.requestId);
				if (!pending) return;
				clearTimeout(pending.timer);
				this._pending.delete(data.requestId);
				pending.resolve({ applied: Boolean(data.applied) });
			}
		} catch (error) {
			console.error(`${Manager.id} | ranger flurry socket failed`, error);
		}
	}

	static async _handleGmApply(data, senderId) {
		let applied = false;
		try {
			const actor = await fromUuid(data.actorUuid);
			if (actor && !actor.hasCondition?.(IMMOBILIZED_SLUG)) {
				await actor.increaseCondition(IMMOBILIZED_SLUG);
				applied = true;
			}
		} catch (error) {
			console.warn(`${Manager.id} | ranger flurry GM could not immobilize`, error);
		}
		game.socket.emit(
			SOCKET_EVENT,
			{ action: SOCKET_ACTION_RESULT, requestId: data.requestId, applied },
			{ recipients: [senderId] }
		);
	}
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

class RangerFlurryWindow extends rememberWindowPosition(
	foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2)
) {
	static DEFAULT_OPTIONS = {
		id: "ranger-flurry",
		classes: ["vibe-ranger-flurry"],
		position: { width: 440 },
		window: {
			icon: "fa-solid fa-bow-arrow",
			resizable: true,
			minimizable: true
		},
		actions: {
			shoot: (event, target) => RangerFlurryTool._onShootClick()
		}
	};

	static PARTS = {
		body: { template: `${MODULE_ROOT}/templates/ranger-flurry.hbs`, root: true }
	};

	get title() {
		return Manager.localize("rangerFlurry.title");
	}

	_prepareContext(options) {
		return RangerFlurryTool._windowContext();
	}
}
