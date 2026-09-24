import { Manager } from "../core/manager.js";
import { FlankingOffGuardTool } from "./flanking-offguard.js";
import { ActionTrackerTool } from "./action-tracker.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_MONK_FLURRY = "monkFlurryApply";
const SOCKET_ACTION_MONK_FLURRY_RESULT = "monkFlurryApplyResult";
const SOCKET_ACTION_MONK_FLURRY_CRITSPEC = "monkFlurryCritSpec";
const GM_RESPONSE_TIMEOUT_MS = 20000;

const CONDITION_STUNNED = "Compendium.pf2e.conditionitems.Item.dfCMdR4wnpbYNTix";
const CONDITION_PRONE = "Compendium.pf2e.conditionitems.Item.j91X7x0XSomq8d60";
const MODULE_ROOT = "modules/pf2e-vibemodulerp";

export class MonkFlurryTool {
	static id = "monk-flurry";
	static category = "monk-flurry";
	static enabledDefault = true;

	static _pendingGmRequests = new Map();
	static _flurryTracker = new Map(); // actorId -> { combatId, round, turn }
	/** Crit-spec Slowed expiries: [{ combatId, attackerId, targetUuid, tokenUuid, round }] (GM-side). */
	static _critSpecTracker = [];

	static init() {
		game.keybindings.register(Manager.id, "monkFlurry", {
			name: Manager.localize("monkFlurry.keybindName") || "Monk Flurry of Blows",
			hint: Manager.localize("monkFlurry.keybindHint") || "Execute Flurry of Blows for the controlled monk",
			editable: [{ key: "KeyF", modifiers: ["Control", "Alt"] }],
			onDown: () => this.execute(),
			restricted: false,
			precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
		});
		// expose global for macro
		try {
			if (!game.modules.get(Manager.id).api) game.modules.get(Manager.id).api = {};
			game.modules.get(Manager.id).api.monkFlurry = () => this.execute();
			globalThis.monkFlurry = () => this.execute();
			globalThis.game.pf2eVibeMonkFlurry = () => this.execute();
		} catch {}
	}

	static ready() {
		Hooks.on("combatTurnChange", this._onCombatTurnChange.bind(this));
		Hooks.on("deleteCombat", this._onDeleteCombat.bind(this));
		Hooks.on("pf2e.endTurn", this._onEndTurn.bind(this));
		game.socket.on(SOCKET_EVENT, this._onSocketMessage.bind(this));
		Hooks.on("renderChatMessageHTML", this._onRenderChatMessage.bind(this));
		console.debug(`${Manager.id} | monk-flurry ready`);
	}

	static _onCombatTurnChange(combat, previous, current) {
		// clear per-turn flourish when turn advances
		try {
			const cid = combat?.id ?? null;
			if (!cid) return;
			// Remove tracker entries for previous combatant turn? Keep map but it keys by actor, check round/turn
			// Instead prune stale entries for this combat
			for (const [actorId, v] of this._flurryTracker.entries()) {
				if (v.combatId !== cid) this._flurryTracker.delete(actorId);
			}
		} catch {}
	}

	static _onDeleteCombat(combat) {
		for (const [k, v] of this._flurryTracker.entries()) if (v.combatId === combat.id) this._flurryTracker.delete(k);
		this._critSpecTracker = this._critSpecTracker.filter((r) => r.combatId !== combat?.id);
	}

	/** GM-side record for a crit-spec Slowed (deduped per combat/attacker/token). */
	static _recordCritSpec(rec) {
		try {
			if (!rec?.combatId || !rec?.attackerId || (!rec?.tokenUuid && !rec?.targetUuid)) return;
			const key = (r) => r.tokenUuid ?? r.targetUuid;
			const dup = this._critSpecTracker.some((r) => r.combatId === rec.combatId && r.attackerId === rec.attackerId && key(r) === (rec.tokenUuid ?? rec.targetUuid));
			if (!dup) this._critSpecTracker.push({ combatId: rec.combatId, attackerId: rec.attackerId, targetUuid: rec.targetUuid ?? null, tokenUuid: rec.tokenUuid ?? null, round: Number(rec.round ?? 0) || 0 });
			} catch {}
	}

	/**
	 * Called after applying crit-spec Slowed: GM records directly, others send
	 * it to a GM. Records the combat TOKEN uuid: the apply touched
	 * `token.actor` (for unlinked tokens the condition lives in the token
	 * delta, not on the base actor), so expiry must resolve the same document.
	 */
	static _trackCritSpec(targetActor, attacker, tokenDoc = null) {
		try {
			const combat = game.combat;
			if (!combat?.id) {
				return; // no combat running: manual removal
			}
			const rec = { combatId: combat.id, attackerId: attacker.id, targetUuid: targetActor.uuid, tokenUuid: tokenDoc?.uuid ?? null, round: combat.round };
			if (game.user.isGM) this._recordCritSpec(rec);
			else {
				const gm = game.users.find((u) => u.isGM && u.active);
				if (gm) game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_MONK_FLURRY_CRITSPEC, ...rec }, { recipients: [gm.id] });
			}
		} catch (e) { console.warn(`${Manager.id} | crit-spec track failed`, e); }
	}

	/**
	 * GM-only: at the end of the attacker's next turn (a later round than the
	 * application), step the tracked Slowed back down (delete at value 1).
	 * Item-direct, never via the conditions manager: Stunned declares
	 * `overrides: ["slowed"]`, hiding Slowed from hasCondition/HUD while the
	 * item itself persists. A single step is also graceful if another effect
	 * raised the value meanwhile.
	 */
	static async _onEndTurn(combatant, encounter, userId) {
		if (!game.user.isGM) return;
		try {
			const combatId = encounter?.id ?? combatant?.combat?.id ?? game.combat?.id ?? null;
			const attackerId = combatant?.actor?.id ?? null;
			const round = Number(encounter?.round ?? game.combat?.round ?? 0) || 0;
			if (!combatId || !attackerId) return;
			// Leak guard: drop records for combats that no longer exist. Never
			// wipe when the collection API is unavailable (keep records instead).
			try {
				const combats = game.combats;
				if (combats?.has) this._critSpecTracker = this._critSpecTracker.filter((r) => { try { return combats.has(r.combatId); } catch { return true; } });
			} catch {}
			const due = this._critSpecTracker.filter((r) => r.combatId === combatId && r.attackerId === attackerId && round > r.round);
			if (!due.length) return;
			for (const rec of due) {
				try {
					// Resolve via the combat token first: the apply touched
					// token.actor (token delta for unlinked tokens). The base
					// actor uuid is only a fallback for linked/legacy records.
					let target = null;
					if (rec.tokenUuid) {
						const tok = await foundry.utils.fromUuid(rec.tokenUuid).catch(() => null) ?? null;
						target = tok?.actor ?? null;
					}
					if (!target && rec.targetUuid) {
						target = await foundry.utils.fromUuid(rec.targetUuid).catch(() => null) ?? null;
					}
					// Item-direct (never hasCondition/decreaseCondition): while
					// Stunned is present the system marks Slowed overridden
					// (condition data `overrides: ["slowed"]`) and hides it from
					// the conditions manager, but the item is still there.
					const slowedItem = target?.items?.find?.((i) => i?.type === "condition" && ((i.slug ?? i.system?.slug) === "slowed")) ?? null;
					if (slowedItem) {
						const cur = Number(slowedItem.system?.value?.value ?? 1) || 1;
						if (cur <= 1) await target.deleteEmbeddedDocuments("Item", [slowedItem.id]);
						else await slowedItem.update({ "system.value.value": cur - 1 });
					}
				} catch (e) { console.warn(`${Manager.id} | crit-spec expiry failed`, e); }
			}
			this._critSpecTracker = this._critSpecTracker.filter((r) => !due.includes(r));
		} catch (e) { console.warn(`${Manager.id} | crit-spec endTurn failed`, e); }
	}

	static _hasUsedFlurry(actor) {
		if (!game.combat?.started) return false;
		const rec = this._flurryTracker.get(actor.id);
		if (!rec) return false;
		return rec.combatId === game.combat.id && rec.round === game.combat.round && rec.turn === game.combat.turn;
	}

	static _markUsedFlurry(actor) {
		if (!game.combat?.started) return;
		this._flurryTracker.set(actor.id, { combatId: game.combat.id, round: game.combat.round, turn: game.combat.turn });
	}

	/** Chat button for combined damage apply */
	static _onRenderChatMessage(message, html) {
		try {
			const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
			if (!root) return;
			// Full-card highlight for the combined + trip crit damage cards (flagged at creation).
			try {
				if (message?.getFlag?.(Manager.id, "flurryCombined")) root.classList?.add("monk-flurry-combined");
				if (message?.getFlag?.(Manager.id, "flurryTripCrit")) root.classList?.add("monk-flurry-trip-crit");
			} catch {}
			const btn = root.querySelector?.('[data-monk-flurry-apply]');
			if (!btn) return;
			btn.addEventListener('click', async (ev) => {
				ev.preventDefault();
				const targetUuid = btn.dataset.targetUuid;
				const dmg = Number(btn.dataset.damage);
				if (!targetUuid || !Number.isFinite(dmg)) return;
				const actor = await fromUuid(targetUuid);
				if (!actor) return ui.notifications.warn("Target not found");
				// apply damage via system
				try {
					if (actor.applyDamage) await actor.applyDamage({ damage: dmg, token: game.scenes.current?.tokens.get(btn.dataset.tokenId ?? "") ?? null });
					else ui.notifications.info(`Apply ${dmg} damage to ${actor.name} manually`);
				} catch (e) { console.error(`${Manager.id} | flurry apply damage failed`, e); }
			});
		} catch {}
	}

	/** Socket */
	static _onSocketMessage(data, userId) {
		try {
			if (!data?.action) return;
			if (data.action === SOCKET_ACTION_MONK_FLURRY) {
				if (!game.user.isGM) return;
				this._handleGmApply(data, userId).catch((e) => console.error(`${Manager.id} | monkFlurry GM failed`, e));
			} else if (data.action === SOCKET_ACTION_MONK_FLURRY_CRITSPEC) {
				if (!game.user.isGM) return;
				this._recordCritSpec(data);
			} else if (data.action === SOCKET_ACTION_MONK_FLURRY_RESULT) {
				this._handleGmResult(data);
			}
		} catch (e) { console.error(`${Manager.id} | monkFlurry socket`, e); }
	}

	static _requestGmApply(actorUuid, ops) {
		return new Promise((resolve) => {
			const gm = game.users.find((u) => u.isGM && u.active);
			if (!gm) { resolve({ applied: false, noGm: true }); return; }
			const requestId = foundry.utils.randomID();
			const timer = setTimeout(() => { this._pendingGmRequests.delete(requestId); resolve({ applied: false, timeout: true }); }, GM_RESPONSE_TIMEOUT_MS);
			this._pendingGmRequests.set(requestId, { resolve, timer });
			game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_MONK_FLURRY, requestId, actorUuid, ops }, { recipients: [gm.id] });
		});
	}

	static async _handleGmApply(data, userId) {
		const { requestId, actorUuid, ops } = data;
		if (!requestId || !actorUuid || !Array.isArray(ops)) return;
		let applied = false;
		try {
			const actor = await fromUuid(actorUuid);
			if (actor) {
				for (const op of ops) {
					if (op.type === "stunned") {
						const existing = actor.getCondition?.("stunned");
						if (existing) await actor.deleteEmbeddedDocuments("Item", [existing.id]);
						await actor.increaseCondition("stunned", { value: op.value });
					} else if (op.type === "prone") {
						if (!actor.hasCondition?.("prone")) await actor.increaseCondition("prone");
					} else if (op.type === "slowed") {
						// Item-direct guard: hasCondition hides Slowed while Stunned overrides it.
						const has = actor.items.some((i) => i?.type === "condition" && ((i.slug ?? i.system?.slug) === "slowed"));
						if (!has) await actor.increaseCondition("slowed", { value: op.value ?? 1 });
					}
				}
				applied = true;
			}
		} catch (e) { console.warn(`${Manager.id} | GM flurry apply failed`, e); }
		game.socket.emit(SOCKET_EVENT, { action: SOCKET_ACTION_MONK_FLURRY_RESULT, requestId, applied }, { recipients: [userId] });
	}

	static _handleGmResult(data) {
		const pending = this._pendingGmRequests.get(data?.requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this._pendingGmRequests.delete(data.requestId);
		pending.resolve({ applied: !!data.applied });
	}

	static async _applyConditions(targetActor, ops) {
		if (!ops.length) return;
		if (targetActor.testUserPermission(game.user, "OWNER")) {
			for (const op of ops) {
				try {
					if (op.type === "stunned") {
						const ex = targetActor.getCondition?.("stunned");
						if (ex) await targetActor.deleteEmbeddedDocuments("Item", [ex.id]);
						await targetActor.increaseCondition("stunned", { value: op.value });
					} else if (op.type === "prone") {
						if (!targetActor.hasCondition?.("prone")) await targetActor.increaseCondition("prone");
					} else if (op.type === "slowed") {
						// Item-direct guard: hasCondition hides Slowed while Stunned overrides it.
						const has = targetActor.items.some((i) => i?.type === "condition" && ((i.slug ?? i.system?.slug) === "slowed"));
						if (!has) await targetActor.increaseCondition("slowed", { value: op.value ?? 1 });
					}
				} catch (e) { console.warn(`${Manager.id} | apply condition failed`, e); }
			}
		} else {
			const result = await this._requestGmApply(targetActor.uuid, ops);
			if (result.noGm) ui.notifications.warn(Manager.localize("monkFlurry.notify.noGm") || `No GM connected to apply effects to ${targetActor.name}`);
		}
	}

	static _isMonk(actor) {
		if (!actor) return false;
		if (actor.class?.slug === "monk") return true;
		if (actor.itemTypes?.class?.some?.((c) => c.slug === "monk")) return true;
		if (actor.itemTypes?.feat?.some?.((f) => f.slug === "flurry-of-blows")) return true;
		return false;
	}

	static _getStrike(actor, useWolfJaws) {
		const actions = actor.system?.actions ?? [];
		if (!Array.isArray(actions) || !actions.length) return null;
		const slug = useWolfJaws ? "wolf-jaws" : "fist";
		// Try exact slug match
		let found = actions.find((a) => a.slug === slug || a.item?.slug === slug);
		if (found) return found;
		// fallback: label contains
		const needle = useWolfJaws ? "wolf" : "fist";
		found = actions.find((a) => (a.label ?? "").toLowerCase().includes(needle) || (a.item?.name ?? "").toLowerCase().includes(needle));
		if (found) return found;
		// fallback: first unarmed
		found = actions.find((a) => (a.item?.system?.traits?.value ?? []).includes("unarmed") || a.slug?.includes("unarmed"));
		return found ?? actions[0] ?? null;
	}

	static _isFlanking(attackerToken, targetToken) {
		try {
			// Use FlankingOffGuardTool geometry which already respects 90-degree house rule
			// We can call its internal check: attacker isFlanking target
			// Reuse its static methods via destination positions (current positions)
			const allCombatTokens = (game.combat?.started ? [...game.combat.combatants.map((c) => c.token?.object).filter(Boolean)] : [...canvas.tokens.placeables]);
			// If not in combat, use all tokens on scene
			const candidates = allCombatTokens.length ? allCombatTokens : [...canvas.tokens.placeables];
			const attackerPos = { x: attackerToken.document.x, y: attackerToken.document.y };
			const targetPos = { x: targetToken.document.x, y: targetToken.document.y };
			const posMap = new Map();
			// Use FlankingOffGuardTool's _isFlankingAt; it checks canFlank via actor synthetics
			return FlankingOffGuardTool._isFlankingAt(attackerToken.object ?? attackerToken, attackerPos, targetToken.object ?? targetToken, targetPos, candidates, posMap);
		} catch (e) {
			// Fallback: use system isFlanking if available
			try { return attackerToken.object?.isFlanking?.(targetToken.object) ?? false; } catch { return false; }
		}
	}

	static _getMessageElement(message) {
		try {
			const id = message?.id ?? message;
			return document.querySelector(`li.chat-message[data-message-id="${id}"]`) ?? ui.chat?.element?.[0]?.querySelector(`li.chat-message[data-message-id="${id}"]`) ?? null;
		} catch { return null; }
	}

	static async _autoRollFlatCheck(message) {
		if (!message) return null;
		// The native attack card ends with <section class="fc-flatcheck-buttons"><div class="fc-check">...<span class="fc-rolls"></span><button data-action="roll-flatcheck" data-dc="5">
		// Clicking that button rolls 1d20 and fills fc-rolls with a colored box (green success / red failure) right next to the button.
		// We mimic the click so the native UI appears, instead of patching our own div.
		try {
			let el = this._getMessageElement(message);
			if (!el) {
				// Message may not be rendered yet (popout or not in DOM) -" wait a tick and retry
				await new Promise((r) => setTimeout(r, 120));
				el = this._getMessageElement(message);
			}
			const btn = el.querySelector('button[data-action="roll-flatcheck"]');
			if (!btn) {
				return null;
			}
			const dc = parseInt(btn.dataset.dc) || parseInt(btn.getAttribute("data-dc")) || 5;
			const label = el.querySelector(".fc-label")?.textContent?.trim() ?? (dc === 11 ? "Hidden" : "Concealed");
			// If already rolled (fc-rolls has content), don't re-roll
			const rollsSpanBefore = el.querySelector(".fc-rolls");
			if (rollsSpanBefore && rollsSpanBefore.textContent.trim() && rollsSpanBefore.children.length) {
				const txt = rollsSpanBefore.textContent.trim();
				const num = parseInt(txt) || 0;
				const success = rollsSpanBefore.querySelector(".success, .criticalSuccess") ? true : rollsSpanBefore.querySelector(".failure, .criticalFailure") ? false : num >= dc;
				return { dc, label, total: num, success, degree: success ? "success" : "failure", element: rollsSpanBefore };
			}
			btn.click();
			// Wait for fc-rolls to be populated (native PF2e updates the same message, not a new one)
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 80));
				el = this._getMessageElement(message);
				const rollsSpan = el?.querySelector(".fc-rolls");
				if (rollsSpan && rollsSpan.textContent.trim()) {
					// Native PF2e fills fc-rolls with something like <span class="fc-roll success">12</span> (green) or failure (red)
					const rollEl = rollsSpan.querySelector(".fc-roll, .dice-total, span");
					let total = 0, success = false;
					if (rollEl) {
						total = parseInt(rollEl.textContent) || parseInt(rollsSpan.textContent) || 0;
						success = rollEl.classList.contains("success") || rollEl.classList.contains("criticalSuccess") || rollsSpan.querySelector(".success") !== null;
						const hasFail = rollEl.classList.contains("failure") || rollEl.classList.contains("criticalFailure") || rollsSpan.querySelector(".failure") !== null;
						if (hasFail) success = false;
						if (!rollEl.classList.contains("success") && !rollEl.classList.contains("failure")) success = total >= dc;
					} else {
						total = parseInt(rollsSpan.textContent) || 0;
						success = total >= dc;
					}
					return { dc, label, total, success, degree: success ? "success" : "failure", element: rollsSpan };
				}
			}
			console.warn(`${Manager.id} | flat auto: timed out waiting for result`, message.id);
			return null;
		} catch (e) { console.warn(`${Manager.id} | flat auto failed`, e); return null; }
	}

	/** degree helper */
	static _degree(success, dc, rollTotal) {
		// PF2e 4 degrees: crit success if total >= dc+10, success >=dc, fail <dc, crit fail <= dc-10
		// Natural 1/20 adjustments are handled by the Check system; for manual rolls we add simple version
		const diff = rollTotal - dc;
		if (diff >= 10) return "criticalSuccess";
		if (diff >= 0) return "success";
		if (diff <= -10) return "criticalFailure";
		return "failure";
	}

	/** Short consequence text for trip Athletics rolls (native notes cover the system path; manual Rolls get it in the flavor). */
	static _tripOutcomeText(degree) {
		if (degree === "criticalSuccess") return "Prone! + 1d6 bludgeoning";
		if (degree === "success") return "Prone!";
		if (degree === "criticalFailure") return "Crit fail — you fall prone";
		return "No effect";
	}

	/**
	 * Roll Trip critical-success damage (1d6 bludgeoning, system Trip text) and
	 * post it as its own native damage card with Apply buttons. Separate from
	 * the combined pool on purpose: resistances apply per damage source, so
	 * merging would under-apply them. Returns the total (0 on failure).
	 */
	static async _rollTripCritDamage(attacker, attackerToken, targetActor, targetToken) {
		try {
			// Let the athletics dice settle first so animations don't overlap.
			await this._breather();
			let roll = null;
			try {
				const DamageRollCls = foundry.dice?.rolls?.DamageRoll ?? CONFIG?.Dice?.rolls?.find?.((c) => c.name === "DamageRoll") ?? null;
				if (DamageRollCls) roll = await new DamageRollCls("{1d6[bludgeoning]}").evaluate();
				else roll = await new Roll("1d6").evaluate();
			} catch {
				roll = await new Roll("1d6").evaluate();
			}
			const total = Number(roll?.total ?? 0) || 0;
			const flavor = `<h4 class="action"><strong>Damage Roll: Trip (Critical Success)</strong> <span class="subtitle degree-of-success">(<span class="success">Critical Success</span>)</span></h4><div class="tags" data-tooltip-class="pf2e"><span class="tag" data-tooltip="PF2E.TraitDescriptionAttack" data-trait="attack">Attack</span></div><hr><div class="tags modifiers"><span class="tag tag_transparent" data-visibility="gm">${total} Bludgeoning</span><span class="tag tag_transparent" data-visibility="gm">Trip</span></div>`;
			await ChatMessage.create({
				speaker: ChatMessage.getSpeaker({ actor: attacker, token: attackerToken?.document ?? null }),
				flavor,
				content: `${total}`,
				rolls: [roll],
				flags: {
					pf2e: {
						context: {
							type: "damage-roll",
							sourceType: "attack",
							actor: attacker.id,
							token: attackerToken.id ?? null,
							target: { actor: targetActor.id, token: targetToken.id },
							domains: ["trip-damage", "damage"],
							options: ["attack", "damage", "trip"],
							outcome: "success",
							notes: [],
							secret: false,
						},
						origin: { actor: attacker.uuid, type: "weapon" },
					},
					[Manager.id]: { flurryTripCrit: true },
				},
			});
			return total;
		} catch (e) {
			console.warn(`${Manager.id} | trip crit damage failed`, e);
			return 0;
		}
	}

	static async _rollCheck(actor, statSlug, dc, options = {}) {
		// Try system statistic roll
		try {
			const stat = actor.getStatistic?.(statSlug);
			if (stat?.check?.roll) {
			// Build params that include dc and incapacitation trait handling
			const rollOptions = options.extraRollOptions ?? [];
			// pf2e's roll will handle Degree and create chat message
			const result = await stat.check.roll({
				dc: { value: dc },
				extraRollOptions: rollOptions,
				traits: options.traits ?? [],
				extraRollNotes: options.extraRollNotes ?? [],
				createMessage: true,
				skipDialog: true,
			});
				// result is a RolledCheck? Try to extract degree and total
				// For saves, system returns CheckRoll with degreeOfSuccess
				if (result) {
					const dos = result.degreeOfSuccess ?? result.dos ?? null;
					const total = result.roll?.total ?? result.total ?? 0;
					// Try to map numeric DOS to string
					let degreeStr = null;
					if (typeof dos === "number") {
						const map = ["criticalFailure", "failure", "success", "criticalSuccess"];
						degreeStr = map[dos] ?? null;
					} else if (typeof dos === "string") degreeStr = dos;
					// Fallback compute manual
					if (!degreeStr) degreeStr = this._degree(null, dc, total);
					return { roll: result.roll ?? result, total, degree: degreeStr, raw: result };
				}
			}
		} catch (e) {}
		// Fallback manual 1d20
		const mod = (() => {
			try {
				const s = actor.getStatistic?.(statSlug);
				return s?.check?.mod ?? s?.mod ?? actor.system?.saves?.[statSlug]?.mod ?? 0;
			} catch { return 0; }
		})();
		const r = await new Roll(`1d20 + @mod`, { mod }).evaluate();
		// Show manually
		await r.toMessage({ flavor: `${actor.name} ${statSlug} vs DC ${dc}`, speaker: ChatMessage.getSpeaker({ actor }) });
		const degree = this._degree(null, dc, r.total);
		return { roll: r, total: r.total, degree, raw: null };
	}

	static _parseDegree(result, dc) {
		if (!result) return "failure";
		const dos = result.degreeOfSuccess ?? result.dos ?? result.outcome ?? null;
		if (typeof dos === "number") return ["criticalFailure", "failure", "success", "criticalSuccess"][dos] ?? "failure";
		if (typeof dos === "string") {
			const s = dos.toLowerCase();
			if (s.includes("critical") && s.includes("success")) return "criticalSuccess";
			if (s.includes("critical") && s.includes("fail")) return "criticalFailure";
			if (s.includes("success")) return "success";
			if (s.includes("fail")) return "failure";
		}
		// Flags path
		const flag = result.flags?.pf2e?.context?.outcome;
		if (flag) return flag;
		// Manual fallback via total
		const total = result.roll?.total ?? result.total ?? 0;
		if (total && Number.isFinite(dc)) return this._degree(null, dc, total);
		return "failure";
	}

	static async _rollAttack(strike, variantIndex, targetActor, targetToken) {
		// Use the system's native strike attack roll so chat messages look exactly like manual strikes.
		// That creates the normal PF2e attack card (with MAP, traits, dice-so-nice, etc.) and returns a CheckRoll.
		// For the macro we never want the modifier dialog, even when the user has "Always Show Dialog" enabled.
		// Passing `skipDialog:true` without an event forces the early-return path in PF2e's eventToRollParams
		// (see pf2e.mjs `if (!('event' in e) ...) return e;`) so the dialog is always skipped.
		try {
			const variant = strike.variants?.[Number(variantIndex)] ?? strike.variants?.[0];
			if (!variant) return null;
			// Ensure correct target is active — variant reads game.user.targets when no explicit target
			const prevTargets = [...game.user.targets].map((t) => t.id);
			const hadTarget = prevTargets.includes(targetToken.id);
			// Keep target set; system expects it
			if (!hadTarget) {
				try { targetToken.setTarget(true, { releaseOthers: false }); } catch {}
			}
			// Capture the attack-roll message that variant.roll creates.
			// Hooks.once is racy with PF2e's async message creation, so we also poll game.messages.
			let attackMessage = null;
			const beforeIds = new Set([...game.messages.keys()]);
			const hook = (msg) => { if (msg?.flags?.pf2e?.context?.type === "attack-roll") attackMessage = msg; };
			Hooks.on("createChatMessage", hook);
			const result = await variant.roll({ skipDialog: true });
			// Give PF2e a tick to create the ChatMessage
			await new Promise((r) => setTimeout(r, 180));
			Hooks.off("createChatMessage", hook);
			try {
				const newMsgs = [...game.messages.values()].filter((m) => !beforeIds.has(m.id));
			} catch {}
			if (!attackMessage) {
				try {
					// Fallback: most recent attack-roll not in beforeIds, or any recent attack-roll
					for (const m of [...game.messages.values()].reverse()) {
						if (beforeIds.has(m.id)) break;
						if (m.flags?.pf2e?.context?.type === "attack-roll") { attackMessage = m; break; }
					}
					if (!attackMessage) {
						attackMessage = [...game.messages.values()].reverse().find((m) => m.flags?.pf2e?.context?.type === "attack-roll") ?? [...game.messages.values()].at(-1) ?? null;
					}
				} catch {}
			}
			// PF2e's CheckRoll carries degreeOfSuccess (0..3) and .roll; we parse degree and hit
			const ac = targetActor.getStatistic?.("ac")?.dc?.value ?? targetActor.system?.attributes?.ac?.value ?? 0;
			const total = result?.roll?.total ?? result?.total ?? 0;
			let degree = this._parseDegree(result, ac);
			// Some PF2e versions return the message instead; try to read flags
			if (!result?.degreeOfSuccess && degree === "failure" && total) {
				// still try to get from last message if available
				const last = attackMessage ?? [...game.messages.values()].at(-1);
				const outcome = last?.flags?.pf2e?.context?.outcome;
				if (outcome) degree = outcome;
			}
			const hit = degree === "success" || degree === "criticalSuccess";
			return { roll: result?.roll ?? result ?? null, total, degree, hit, raw: result, message: attackMessage, messageId: attackMessage?.id ?? null };
		} catch (e) {
			console.warn(`${Manager.id} | _rollAttack native failed, falling back`, e);
			try {
				const ac = targetActor.getStatistic?.("ac")?.dc?.value ?? 15;
				const mod = strike.statistic?.check?.mod ?? 0;
				const r = await new Roll("1d20 + @mod", { mod }).evaluate();
				const msg = await r.toMessage({ flavor: `${strike.label ?? "Strike"} vs AC ${ac}`, speaker: ChatMessage.getSpeaker({ actor: strike.actor }) });
				const degree = this._degree(null, ac, r.total);
				return { roll: r, total: r.total, degree, hit: degree === "success" || degree === "criticalSuccess", raw: null, message: msg, messageId: msg?.id ?? null };
			} catch (e2) { console.error(`${Manager.id} | fallback attack failed`, e2); return null; }
		}
	}

	static async _rollDamage(strike, isCritical) {
		// Use native PF2e damage so the message has the standard damage card + Apply buttons.
		// Macro must not show the damage modifier dialog even if the user has showDamageDialogs on.
		try {
			const fn = isCritical ? strike.critical : strike.damage;
			if (typeof fn !== "function") throw new Error("no damage fn");
			const before = game.messages.size;
			const result = await fn({ skipDialog: true });
			// result is a DamageRoll; total is sum of instances
			let total = 0;
			if (result && typeof result.total === "number") total = result.total;
			else {
				const last = [...game.messages.values()].slice(before).at(-1);
				total = last?.rolls?.reduce((s, r) => s + (r.total ?? 0), 0) ?? 0;
			}
			return { roll: result, total, raw: result };
		} catch (e) {
			console.warn(`${Manager.id} | _rollDamage native failed`, e);
			const base = strike.item?.system?.damage?.dice ? `${strike.item.system.damage.dice}${strike.item.system.damage.die ?? "d8"}` : "1d8";
			const mod = strike.actor?.system?.abilities?.str?.mod ?? 0;
			const r = await new Roll(`${base} + @mod`, { mod }).evaluate();
			await r.toMessage({ flavor: `${strike.label} Damage`, speaker: ChatMessage.getSpeaker({ actor: strike.actor }) });
			return { roll: r, total: r.total, raw: null };
		}
	}

	static async _waitForMacroDice(beforeIds, timeoutMs = 4000) {
		// Settle the 3D animations of messages created since `beforeIds` was
		// captured, by tracking the real message IDs (bard-helper pattern:
		// `game.dice3d.waitFor3DAnimationByMessageID`), NOT presumed counts.
		// DSN resolves immediately for messages that aren't animating, and the
		// overall cap means a missed animation can never stall the macro.
		const settle = (ms) => new Promise((r) => setTimeout(r, ms));
		const dsn = game.modules.get("dice-so-nice")?.active && !!game.dice3d;
		if (!dsn) {
			await settle(300);
			return;
		}
		let targets = [];
		try {
			targets = [...game.messages.values()].filter((m) => !beforeIds.has(m.id) && (m.rolls?.length ?? 0) > 0);
		} catch {}
		if (!targets.length) return;
		try {
			await Promise.race([
				Promise.all(targets.map((m) => game.dice3d.waitFor3DAnimationByMessageID(m.id).catch(() => null))),
				settle(timeoutMs)
			]);
		} catch {}
		await settle(250);
	}

	/** Small pause between macro phases so 3D animations don't stack onto one frame (peak smoothing, not a fix for one-time engine init). */
	static _breather(ms = 250) {
		return new Promise((r) => setTimeout(r, ms));
	}

	static async _createCombinedDamageMessage(attacker, attackerToken, targetActor, targetToken, combinedTotal, flavorAttack, damageType = null, strike = null, typeEntries = []) {
		// Build a native-looking PF2e damage card but with our provided totals per damage type.
		// typeEntries (merged from the original rolls' DamageRoll.instances) drives a
		// multi-instance formula in the system's own shape (`{8[bludgeoning],4[fire]}`):
		// weaknesses/immunities/resistances then apply per type through the normal buttons.
		try {
			const titleCase = (s) => { s = String(s ?? ""); return s.charAt(0).toUpperCase() + s.slice(1); };
			const rawType = String(damageType ?? strike?.item?.system?.damage?.damageType ?? strike?.item?.system?.damage?.base?.damageType ?? "bludgeoning").toLowerCase();
			const breakdown = typeEntries?.length
				? typeEntries.map((e) => `${e.total} ${titleCase(e.type)}`).join(" + ")
				: `${combinedTotal} ${titleCase(rawType)}`;
			// Prefer the multi-type formula, but validate first: if the parser ever
			// rejects it, fall back to today's single-type formula so the card survives.
			let formula = `{${combinedTotal}[${rawType}]}`;
			if (typeEntries?.length) {
				const candidate = `{${typeEntries.map((e) => `${e.total}[${e.type}${e.materials?.length ? `,${e.materials.join(",")}` : ""}]`).join(",")}}`;
				try {
					const Cls = foundry.dice?.rolls?.DamageRoll ?? CONFIG?.Dice?.rolls?.find?.((c) => c.name === "DamageRoll") ?? null;
					if (Cls?.validate?.(candidate)) formula = candidate;
					else console.debug(`${Manager.id} | multi-type formula rejected, using single type`, candidate);
				} catch {}
			}
			let roll = null;
			try {
				// PF2e registers DamageRoll as CONFIG.Dice.rolls
				const DamageRollCls = foundry.dice?.rolls?.DamageRoll ?? CONFIG?.Dice?.rolls?.find?.((c) => c.name === "DamageRoll") ?? null;
				if (DamageRollCls) {
					roll = await new DamageRollCls(formula).evaluate();
				} else {
					roll = await new Roll(formula).evaluate();
				}
			} catch {
				roll = await new Roll(`${combinedTotal}`).evaluate();
			}
			const flavor = `<h4 class="action"><strong>Damage Roll: Flurry of Blows (Combined)</strong> <span class="subtitle degree-of-success">(<span class="success">Hit</span>)</span></h4><div class="tags" data-tooltip-class="pf2e"><span class="tag" data-tooltip="PF2E.TraitDescriptionAttack" data-trait="attack">Attack</span><hr class="vr"><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionAgile">Agile</span><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionFinesse">Finesse</span><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionUnarmed">Unarmed</span></div><hr><div class="tags modifiers"><span class="tag tag_transparent" data-visibility="gm">${breakdown}</span><span class="tag tag_transparent" data-visibility="gm">${flavorAttack}</span></div>`;
			const speaker = ChatMessage.getSpeaker({ actor: attacker, token: attackerToken?.document ?? null });
			await ChatMessage.create({
				speaker,
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
							domains: ["flurry-damage", "strike-damage", "damage"],
							options: ["attack", "damage", "flurry-of-blows"],
							outcome: "success",
							notes: [],
							secret: false,
						},
						origin: { actor: attacker.uuid, type: "weapon" },
					},
					[Manager.id]: { flurryCombined: true },
				},
			});
			return;
		} catch (e) {
			console.warn(`${Manager.id} | combined damage native failed, falling back to custom card`, e);
		}
		// Fallback: simple custom card with our apply button (styled by monk-flurry.css)
		const content = `<div class="monk-flurry-card"><h3>Flurry of Blows — Combined Damage ${combinedTotal}</h3><p>${flavorAttack} total</p><button data-monk-flurry-apply data-target-uuid="${targetActor.uuid}" data-token-id="${targetToken.id}" data-damage="${combinedTotal}" class="monk-flurry-apply"><i class="fa-solid fa-heart-crack"></i> Apply ${combinedTotal} Damage to ${targetActor.name}</button></div>`;
		await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor: attacker, token: attackerToken?.document ?? null }),
			content,
			flavor: `Flurry of Blows — Combined Damage ${combinedTotal}`,
			flags: { [Manager.id]: { flurryCombined: true } },
		});
	}

	static async execute() {
		let _userFlags = null, _prevCheck = null, _prevDamage = null;
		const _restoreDialogs = () => { if (_userFlags) { _userFlags.showCheckDialogs = _prevCheck; _userFlags.showDamageDialogs = _prevDamage; } };
		try {
			if (!Manager.isEnabled(this.id)) return ui.notifications.warn(Manager.localize("monkFlurry.notify.disabled") || "Monk Flurry is disabled");
			const controlled = canvas.tokens.controlled;
			if (controlled.length !== 1) return ui.notifications.warn(Manager.localize("monkFlurry.notify.oneToken") || "Select exactly one token (your monk)");
			const attackerToken = controlled[0];
			const attacker = attackerToken.actor;
			if (!attacker) return ui.notifications.warn("No actor for selected token");
			if (!this._isMonk(attacker)) return ui.notifications.warn(Manager.localize("monkFlurry.notify.notMonk") || "Only monks can use Flurry of Blows");

			const targets = [...game.user.targets];
			if (targets.length !== 1) return ui.notifications.warn(Manager.localize("monkFlurry.notify.oneTarget") || "Target exactly one creature for Flurry of Blows");
			const targetToken = targets[0];
			const targetActor = targetToken.actor;
			if (!targetActor) return ui.notifications.warn("Target has no actor");
			if (targetActor.id === attacker.id) return ui.notifications.warn("You cannot target yourself");

			if (this._hasUsedFlurry(attacker)) return ui.notifications.warn(Manager.localize("monkFlurry.notify.flourish") || "Flurry of Blows can be used only once per turn (flourish)");

			const hasWolfStance = (() => {
				const effects = attacker.itemTypes?.effect ?? [];
				return effects.some((e) => e.slug === "stance-wolf-stance" || e.system?.slug === "stance-wolf-stance" || e.name === "Stance: Wolf Stance");
			})();
			const strike = this._getStrike(attacker, hasWolfStance);
			if (!strike) return ui.notifications.warn("No suitable strike found (wolf-jaws/fist)");

			// Mark flourish
			this._markUsedFlurry(attacker);

			// Action Tracker: 1× Flurry of Blows (1 action) + next 2 attack-rolls free (0, still visible) + next trip athletics hidden
			try {
				const flurryIcon = strike.item?.img ? { img: strike.item.img } : { fa: "fa-hand-fist" };
				await ActionTrackerTool.logAndSuppress(attacker, {
					name: "Flurry of Blows",
					cost: 1,
					icon: flurryIcon,
					suppress: {
						free: { count: 2, types: ["attack-roll"] },
						hide: { count: 2, types: ["skill-check", "perception-check"] }
					}
				});
			} catch (e) { console.warn(`${Manager.id} | flurry action-tracker suppress failed`, e); }

			const flavorAttack = hasWolfStance ? "Wolf Jaws" : "Fist";
			const attackerName = attacker.name;
			const targetName = targetActor.name;

			// --- Macro must be fully automatic: suppress ALL PF2e dialogs even when the user has
			// "Always Show Dialog" enabled. PF2e's eventToRollParams reads game.user.settings.show*Dialogs
			// and toggles with Shift, so passing skipDialog:true alone is overwritten by the event path.
			// We temporarily flip the in-memory flags (no DB write) for the duration of the macro.
			_userFlags = game.user.flags.pf2e?.settings;
			_prevCheck = _userFlags?.showCheckDialogs;
			_prevDamage = _userFlags?.showDamageDialogs;
			if (_userFlags) { _userFlags.showCheckDialogs = false; _userFlags.showDamageDialogs = false; }
			// Message IDs before the first roll: used to settle exactly our dice later.
			const macroMsgIds = new Set([...game.messages.keys()]);
			let result1 = null, result2 = null;
			// Perform two attacks: MAP 0 and MAP -4 (agile). Wolf Jaws is agile, fist is agile? Fist from Powerful Fist? Actually fist has agile.
			// Use variants if available; otherwise apply -4 manual
			const variant0 = strike.variants?.[0] ?? null;
			const variant1 = strike.variants?.[1] ?? null;
			// Roll attacks sequentially
			// Ensure target is selected for variant rolls
			result1 = await this._rollAttack(strike, 0, targetActor, targetToken);
			result2 = await this._rollAttack(strike, 1, targetActor, targetToken);

			// Flat check vs concealed/hidden: like system does - roll 1d20 vs DC 5/11 after attack, before damage;
			// on failure the attack becomes a miss even if AC would hit. Live DC per answer 1/5.
			// Flat check: mimic clicking the native <button data-action="roll-flatcheck"> that PF2e adds at the very end of the attack card
			// (section.fc-flatcheck-buttons -> div.fc-check -> span.fc-rolls + button). Native shows number inside a box near the button, green/red.
			// We auto-click that button so the result looks exactly native, without adding our own text.
			let flat1 = null, flat2 = null;
			// Flat check: purely native — auto-click the system's own
			// <button data-action="roll-flatcheck"> on the attack card (see AGENTS.md:
			// Concealed/Hidden flat checks). No button = no flat check, hit stands.
			const tryFlatViaButton = async (result) => {
				if (!result?.hit || !result.message) return null;
				return await this._autoRollFlatCheck(result.message);
			};
			flat1 = await tryFlatViaButton(result1);
			if (flat1) { result1.flat = flat1; if (!flat1.success) { result1.hit = false; result1.degree = "failure"; result1.flatMiss = true; } }
			flat2 = await tryFlatViaButton(result2);
			if (flat2) { result2.flat = flat2; if (!flat2.success) { result2.hit = false; result2.degree = "failure"; result2.flatMiss = true; } }

			// Breather: let attack/flat dice settle before damage dice spawn.
			await this._breather();

			// Evaluate hits (flat-check failures have already been turned into misses)
			const hits = [];
			const damages = [];
			if (result1?.hit) hits.push({ idx: 0, res: result1 });
			if (result2?.hit) hits.push({ idx: 1, res: result2 });

			// Roll damage for hits — each creates its own native PF2e damage card with Apply buttons
			let combinedTotal = 0;
			const damageDetails = [];
			for (const h of hits) {
				const isCrit = h.res.degree === "criticalSuccess";
				const dmg = await this._rollDamage(strike, isCrit);
				// Keep per-type instance totals for the combined card (persistent
				// excluded — ongoing damage, own application flow).
				const inst = [];
				try {
					for (const i of dmg.roll?.instances ?? []) {
						if (i.persistent) continue;
						inst.push({ type: String(i.type ?? "untyped").toLowerCase(), total: Number(i.total ?? 0) || 0, materials: [...(i.materials ?? [])] });
					}
				} catch {}
				damages.push({ idx: h.idx, isCrit, total: dmg.total, roll: dmg.roll, instances: inst });
				combinedTotal += dmg.total;
				damageDetails.push(`${flavorAttack} ${h.idx + 1}${isCrit ? " (crit)" : ""}: ${dmg.total}`);
			}

			// Native attack+damage cards are already in chat. Settle their dice
			// before the combined card so animations don't pile onto one frame,
			// then post the kept combined-damage Apply card. The single text
			// summary goes at the very end (no intermediate messages).
			const bothHit = damages.length === 2;
			if (damages.length) {
				await this._waitForMacroDice(macroMsgIds);
				const dmgType = strike.item?.system?.damage?.damageType ?? strike.item?.system?.damage?.base?.damageType ?? (hasWolfStance ? "piercing" : "bludgeoning");
				// Merge per-type totals across both hits for the combined card.
				const typeMap = new Map();
				for (const d of damages) {
					for (const inst of d.instances ?? []) {
						const rec = typeMap.get(inst.type) ?? { total: 0, materials: new Set() };
						rec.total += inst.total;
						for (const m of inst.materials ?? []) rec.materials.add(m);
						typeMap.set(inst.type, rec);
					}
				}
				const typeEntries = [...typeMap.entries()].map(([type, rec]) => ({ type, total: rec.total, materials: [...rec.materials] }));
				await this._createCombinedDamageMessage(attacker, attackerToken, targetActor, targetToken, combinedTotal, flavorAttack, dmgType, strike, typeEntries);
			}
			// Breather: let the combined damage dice settle before the Fort save die spawns.
			await this._breather();

			// Stunning Blows: if either hit and dealt damage (>0), Fort save vs class DC with incapacitation.
			// The native save card stays in chat; the result is recorded for the final summary.
			// classDC is shared with Critical Specialization below (same DC).
			let fortInfo = null;
			const didDamage = combinedTotal > 0;
			const classDC = (() => {
				try {
					const cdc = attacker.getStatistic?.("classDC");
					return cdc?.dc?.value ?? attacker.system?.proficiencies?.classDCs?.monk?.dc?.value ?? 16;
				} catch { return 16; }
			})();
			if (didDamage) {
			// Roll target Fort save with incapacitation trait so system adjusts degree if target level > 2*attacker level.
			// Outcome notes (Calm-note pattern) put the consequence on the native card itself.
			let fortResult = null;
			try {
				const fortNotes = [
					{ outcome: ["criticalSuccess"], selector: "", text: "<strong>Critical Success</strong> — no stun." },
					{ outcome: ["success"], selector: "", text: "<strong>Success</strong> — no stun." },
					{ outcome: ["failure"], selector: "", text: "<strong>Failure</strong> — Stunned 1." },
					{ outcome: ["criticalFailure"], selector: "", text: "<strong>Critical Failure</strong> — Stunned 3." }
				];
				fortResult = await this._rollCheck(targetActor, "fortitude", classDC, { extraRollOptions: ["incapacitation"], traits: ["incapacitation"], extraRollNotes: fortNotes });
			} catch (e) { console.warn(`${Manager.id} | fort save failed`, e); }
				if (fortResult) {
					let degree = fortResult.degree;
					// Degree already adjusted by system if incapacitation passed; if system didn't, adjust manually for fallback rolls
					if (!fortResult.raw?.degreeOfSuccess && !fortResult.raw?.dos) {
						// manual incapacitation adjustment: if target level > 2*attacker level, improve degree by one
						const tLevel = targetActor.level ?? 0;
						const aLevel = attacker.level ?? 1;
						if (tLevel > aLevel * 2) {
							const order = ["criticalFailure", "failure", "success", "criticalSuccess"];
							let idx = order.indexOf(degree);
							if (idx >= 0 && idx < 3) degree = order[idx + 1];
						}
					}
				const stunOps = [];
				if (degree === "failure") stunOps.push({ type: "stunned", value: 1 });
				else if (degree === "criticalFailure") stunOps.push({ type: "stunned", value: 3 });
				if (stunOps.length) await this._applyConditions(targetActor, stunOps);
				fortInfo = { total: fortResult.total, degree, classDC, stunned: stunOps.length ? (degree === "criticalFailure" ? "Stunned 3" : "Stunned 1") : null };
				}
			}

			// Critical Specialization (Expert Strikes, brawling): each critical hit
			// forces a Fort save vs class DC — no incapacitation on this save.
			// Failure means Slowed 1 until the end of the attacker's next turn
			// (auto-tracked via pf2e.endTurn). Native save cards stay in chat;
			// results join the final summary.
			let critSpecInfo = null;
			const hasExpertStrikes = attacker.items?.some?.((i) => (i.slug ?? i.system?.slug) === "expert-strikes") ?? false;
			const crits = hits.filter((h) => h.res.degree === "criticalSuccess");
			if (hasExpertStrikes && crits.length) {
				const rows = [];
				for (const crit of crits) {
					let save = null;
					try {
						const notes = [
							{ outcome: ["criticalSuccess"], selector: "", text: "<strong>Critical Success</strong> — no effect." },
							{ outcome: ["success"], selector: "", text: "<strong>Success</strong> — no effect." },
							{ outcome: ["failure"], selector: "", text: "<strong>Failure</strong> — Slowed 1 until the end of your next turn." },
							{ outcome: ["criticalFailure"], selector: "", text: "<strong>Critical Failure</strong> — Slowed 1 until the end of your next turn." }
						];
						save = await this._rollCheck(targetActor, "fortitude", classDC, { extraRollNotes: notes });
					} catch (e) { console.warn(`${Manager.id} | crit-spec save failed`, e); }
					if (!save) continue;
					let slowed = false;
					if (save.degree === "failure" || save.degree === "criticalFailure") {
						await this._applyConditions(targetActor, [{ type: "slowed", value: 1 }]);
						slowed = true;
						this._trackCritSpec(targetActor, attacker, targetToken);
					}
					rows.push({ idx: crit.idx, total: save.total, degree: save.degree, classDC, slowed });
				}
				if (rows.length) critSpecInfo = { rows };
			}

			// Trip attempts: only if Wolf Stance and flanking, only on successful hits, up to 2 (stop on success).
			// Native athletics cards stay in chat; results are recorded for the final summary.
			let tripInfo = null;
			if (hasWolfStance && damages.length) {
				// Breather: let save/damage dice settle before trip dice spawn.
				await this._breather();
				// Check flanking once (position hasn't changed between the two attacks)
				let isFlanking = false;
				try { isFlanking = this._isFlanking(attackerToken, targetToken); } catch {}
				const reflexDC = (() => {
					try { return targetActor.getStatistic?.("reflex")?.dc?.value ?? targetActor.system?.saves?.reflex?.dc?.value ?? 15; } catch { return 15; }
				})();
				if (!isFlanking) {
					tripInfo = { flanked: false, reflexDC, rows: [], proneApplied: false, attackerProne: false };
				} else {
					const proneOps = [];
					const rows = [];
					let tripped = false;
					let attackerProne = false;
					let tripCritDamage = 0;
					// Outcome notes (Calm-note pattern) put the consequence on the
					// native athletics card itself (MAP 0 path below).
					const tripNotes = [
						{ outcome: ["criticalSuccess"], selector: "", text: "<strong>Critical Success</strong> — Prone, plus 1d6 bludgeoning damage." },
						{ outcome: ["success"], selector: "", text: "<strong>Success</strong> — the target falls Prone." },
						{ outcome: ["failure"], selector: "", text: "<strong>Failure</strong> — no effect." },
						{ outcome: ["criticalFailure"], selector: "", text: "<strong>Critical Failure</strong> — you fall Prone." }
					];
					for (const dmg of damages) {
						if (tripped) break;
						const mapPenalty = dmg.idx === 0 ? 0 : -4; // second attack MAP
						// Athletics check vs Reflex DC with MAP
						// We simulate MAP by adjusting dc? Actually athletics mod gets -MAP. So we roll with penalty.
						// Use statistic with custom modifier: we can add temporary modifier via check options?
						// Simpler: manual Roll with mod+mapPenalty or use statistic's check with extra modifiers
						let athResult = null;
						try {
							const athStat = attacker.getStatistic?.("athletics");
							if (athStat?.check?.roll) {
								// PF2e check supports `modifiers`? We'll pass extra modifier via ad-hoc
								// Fallback: if mapPenalty !=0, do manual roll
								if (mapPenalty === 0) {
									athResult = await athStat.check.roll({ dc: { value: reflexDC }, createMessage: true, skipDialog: true, extraRollNotes: tripNotes });
									// Extract degree
									const dos = athResult?.degreeOfSuccess;
									let degree = typeof dos === "number" ? ["criticalFailure", "failure", "success", "criticalSuccess"][dos] : (athResult?.degree ?? dos);
									if (!degree && athResult?.roll?.total) degree = this._degree(null, reflexDC, athResult.roll.total);
									athResult = { roll: athResult.roll ?? athResult, total: athResult.roll?.total ?? athResult.total ?? 0, degree, raw: athResult };
								} else {
									// Manual with MAP (a plain Roll has no outcome notes, so the
									// consequence goes into the flavor, computed after the roll)
									const baseMod = athStat.check.mod ?? 0;
									const r = await new Roll("1d20 + @mod + @map", { mod: baseMod, map: mapPenalty }).evaluate();
									const degree = this._degree(null, reflexDC, r.total);
									await r.toMessage({ flavor: `Athletics (Trip) MAP ${mapPenalty} vs Reflex DC ${reflexDC} — ${this._tripOutcomeText(degree)}`, speaker: ChatMessage.getSpeaker({ actor: attacker }) });
									athResult = { roll: r, total: r.total, degree, raw: null };
								}
							}
						} catch {}
						if (!athResult) {
							const baseMod = attacker.system?.skills?.athletics?.mod ?? 0;
							const r = await new Roll("1d20 + @mod + @map", { mod: baseMod, map: mapPenalty }).evaluate();
							const fallbackDegree = this._degree(null, reflexDC, r.total);
							await r.toMessage({ flavor: `Athletics (Trip) MAP ${mapPenalty} vs Reflex DC ${reflexDC} — ${this._tripOutcomeText(fallbackDegree)}`, speaker: ChatMessage.getSpeaker({ actor: attacker }) });
							athResult = { roll: r, total: r.total, degree: fallbackDegree };
						}
						const degree = athResult.degree;
						const success = degree === "success" || degree === "criticalSuccess";
						const critFail = degree === "criticalFailure";
						if (degree === "criticalSuccess") {
							tripCritDamage = await this._rollTripCritDamage(attacker, attackerToken, targetActor, targetToken);
						}
						rows.push({ idx: dmg.idx, mapPenalty, total: athResult.total, degree, success, critFail });
						if (success) {
							if (!targetActor.hasCondition?.("prone")) proneOps.push({ type: "prone" });
							tripped = true;
						} else if (critFail) {
							// Attacker falls prone
							if (!attacker.hasCondition?.("prone")) {
								await this._applyConditions(attacker, [{ type: "prone" }]);
								attackerProne = true;
							}
						}
					}
				if (proneOps.length) await this._applyConditions(targetActor, proneOps);
				tripInfo = { flanked: true, reflexDC, rows, proneApplied: proneOps.length > 0, attackerProne };
				}
			}

			// One final summary card for the whole flurry (text-only: no `rolls`,
			// so Dice So Nice doesn't replay dice over the settled animations).
			try {
				const pretty = (d) => ({ criticalSuccess: "Critical Success", success: "Success", failure: "Failure", criticalFailure: "Critical Failure" })[d] ?? d;
				const atkDeg = (r) => r?.degree === "criticalSuccess" ? "Critical Hit" : r?.degree === "success" ? "Hit" : "Miss";
				const parts = [];
				parts.push(`<h3>Flurry of Blows — ${attackerName} → ${targetName}</h3>`);
				for (const [res, flat, n, map] of [[result1, flat1, 1, 0], [result2, flat2, 2, -4]]) {
					if (!res) continue;
					const line = res.flatMiss ? `<strong>Miss</strong> (flat check failed)` : `<strong>${atkDeg(res)}</strong>`;
					const flatBit = flat ? ` — flat ${flat.dc === 11 ? "Hidden" : "Concealed"} DC ${flat.dc}: ${flat.total} (${flat.success ? "Success" : "Failure"})` : "";
					parts.push(`<p>Attack ${n} (MAP ${map}): ${res.total} — ${line}${flatBit}</p>`);
				}
				if (damages.length) {
					parts.push(`<p>${flavorAttack}: ${damageDetails.join(" + ")} = <strong>Combined ${combinedTotal}</strong>${bothHit ? " — resistances/weaknesses apply once to the combined total" : ""}. Flourish — once per turn.</p>`);
				} else {
					const flatMissCount = [flat1, flat2].filter(f => f && !f.success).length;
					parts.push(`<p><em>Both attacks missed${flatMissCount ? ` (${flatMissCount} negated by flat check)` : ""} — no damage, no Stunning Blows.</em></p>`);
				}
				if (fortInfo) {
					parts.push(`<p>Stunning Blows: Fort ${fortInfo.total} vs DC ${fortInfo.classDC} — <strong>${pretty(fortInfo.degree)}</strong>${fortInfo.stunned ? ` — ${fortInfo.stunned}` : " — no stun"}.</p>`);
				}
				if (critSpecInfo) {
					for (const row of critSpecInfo.rows) {
						parts.push(`<p>Critical Specialization (attack ${row.idx + 1}): Fort ${row.total} vs DC ${row.classDC} — <strong>${pretty(row.degree)}</strong>${row.slowed ? " — Slowed 1 (until end of your next turn)" : " — no effect"}.</p>`);
					}
				}
				if (tripInfo) {
					if (!tripInfo.flanked) {
						parts.push(`<p>Trip: not flanking ${targetName} — no Wolf Stance trip attempts.</p>`);
					} else {
						for (const row of tripInfo.rows) {
							parts.push(`<p>Trip ${row.idx + 1} (MAP ${row.mapPenalty}): ${row.total} vs Reflex DC ${tripInfo.reflexDC} — <strong>${pretty(row.degree)}</strong>${row.success ? " — Prone!" : row.critFail ? " — crit fail, you fall prone" : ""}.</p>`);
						}
					}
				}
				await ChatMessage.create({
					speaker: ChatMessage.getSpeaker({ actor: attacker, token: attackerToken.document ?? null }),
					content: `<div class="monk-flurry-card">${parts.join("")}</div>`,
					flavor: "Flurry of Blows — Summary",
				});
			} catch (e) { console.warn(`${Manager.id} | flurry summary failed`, e); }

		} catch (e) {
			console.error(`${Manager.id} | monkFlurry execute failed`, e);
			ui.notifications.error("Flurry of Blows failed — see console (F12)");
		} finally {
			_restoreDialogs();
		}
	}
}
