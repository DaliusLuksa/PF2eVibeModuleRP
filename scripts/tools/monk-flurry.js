import { Manager } from "../core/manager.js";
import { FlankingOffGuardTool } from "./flanking-offguard.js";

const SOCKET_EVENT = `module.${Manager.id}`;
const SOCKET_ACTION_MONK_FLURRY = "monkFlurryApply";
const SOCKET_ACTION_MONK_FLURRY_RESULT = "monkFlurryApplyResult";
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
		} catch (e) { console.debug(`${Manager.id} | _rollCheck fallback`, e); }
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
			const fakeEvent = new MouseEvent("click", { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
			const result = await variant.roll({ event: fakeEvent });
			// PF2e's CheckRoll carries degreeOfSuccess (0..3) and .roll; we parse degree and hit
			const ac = targetActor.getStatistic?.("ac")?.dc?.value ?? targetActor.system?.attributes?.ac?.value ?? 0;
			const total = result?.roll?.total ?? result?.total ?? 0;
			let degree = this._parseDegree(result, ac);
			// Some PF2e versions return the message instead; try to read flags
			if (!result?.degreeOfSuccess && degree === "failure" && total) {
				// still try to get from last message if available
				const last = [...game.messages.values()].at(-1);
				const outcome = last?.flags?.pf2e?.context?.outcome;
				if (outcome) degree = outcome;
			}
			const hit = degree === "success" || degree === "criticalSuccess";
			return { roll: result?.roll ?? result ?? null, total, degree, hit, raw: result };
		} catch (e) {
			console.warn(`${Manager.id} | _rollAttack native failed, falling back`, e);
			try {
				const ac = targetActor.getStatistic?.("ac")?.dc?.value ?? 15;
				const mod = strike.statistic?.check?.mod ?? 0;
				const r = await new Roll("1d20 + @mod", { mod }).evaluate();
				await r.toMessage({ flavor: `${strike.label ?? "Strike"} vs AC ${ac}`, speaker: ChatMessage.getSpeaker({ actor: strike.actor }) });
				const degree = this._degree(null, ac, r.total);
				return { roll: r, total: r.total, degree, hit: degree === "success" || degree === "criticalSuccess", raw: null };
			} catch (e2) { console.error(`${Manager.id} | fallback attack failed`, e2); return null; }
		}
	}

	static async _rollDamage(strike, isCritical) {
		// Use native PF2e damage so the message has the standard damage card + Apply buttons.
		try {
			const fakeEvent = new MouseEvent("click", { shiftKey: false });
			const fn = isCritical ? strike.critical : strike.damage;
			if (typeof fn !== "function") throw new Error("no damage fn");
			const before = game.messages.size;
			const result = await fn({ event: fakeEvent });
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

	static async _waitForDice(expectedMessages = 1) {
		const dsn = game.modules.get("dice-so-nice")?.active && !!game.dice3d;
		if (!dsn) {
			await new Promise((r) => setTimeout(r, 450));
			return;
		}
		// DSN animates each Roll's dice; pf2e's ha.roll already awaits the 3D animation,
		// but our summary should still not appear until the last dice have settled.
		// Always wait for diceSoNiceRollComplete (or timeout) — don't rely on isVisible check
		// which races the animation start.
		let remaining = Math.max(1, Number(expectedMessages) || 1);
		await new Promise((resolve) => {
			let timeout = null;
			const done = () => {
				if (timeout) clearTimeout(timeout);
				Hooks.off("diceSoNiceRollComplete", onComplete);
				resolve();
			};
			const onComplete = () => {
				remaining--;
				if (remaining <= 0) done();
			};
			Hooks.on("diceSoNiceRollComplete", onComplete);
			timeout = setTimeout(done, 6000);
			// If no dice were actually shown (e.g. DSN hidden for this roll), the hook never fires — timeout above handles it
		});
		await new Promise((r) => setTimeout(r, 300));
	}

	static async _createCombinedDamageMessage(attacker, attackerToken, targetActor, targetToken, combinedTotal, flavorAttack, damageType = null, strike = null) {
		// Build a native-looking PF2e damage card but with our provided total and correct damage type.
		// damageType is resolved from the actual strike (piercing for Wolf Jaws, bludgeoning for Fist).
		try {
			const rawType = String(damageType ?? strike?.item?.system?.damage?.damageType ?? strike?.item?.system?.damage?.base?.damageType ?? "bludgeoning").toLowerCase();
			const typeLabel = rawType.charAt(0).toUpperCase() + rawType.slice(1);
			const formula = `{${combinedTotal}[${rawType}]}`;
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
			const flavor = `<h4 class="action"><strong>Damage Roll: Flurry of Blows (Combined)</strong> <span class="subtitle degree-of-success">(<span class="success">Hit</span>)</span></h4><div class="tags" data-tooltip-class="pf2e"><span class="tag" data-tooltip="PF2E.TraitDescriptionAttack" data-trait="attack">Attack</span><hr class="vr"><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionAgile">Agile</span><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionFinesse">Finesse</span><span class="tag tag_alt" data-tooltip="PF2E.TraitDescriptionUnarmed">Unarmed</span></div><hr><div class="tags modifiers"><span class="tag tag_transparent" data-visibility="gm">${combinedTotal} ${typeLabel}</span><span class="tag tag_transparent" data-visibility="gm">${flavorAttack}</span></div>`;
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
		});
	}

	static async execute() {
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

			const flavorAttack = hasWolfStance ? "Wolf Jaws" : "Fist";
			const attackerName = attacker.name;
			const targetName = targetActor.name;

			// Perform two attacks: MAP 0 and MAP -4 (agile). Wolf Jaws is agile, fist is agile? Fist from Powerful Fist? Actually fist has agile.
			// Use variants if available; otherwise apply -4 manual
			const variant0 = strike.variants?.[0] ?? null;
			const variant1 = strike.variants?.[1] ?? null;
			// Roll attacks sequentially
			let result1 = null, result2 = null;
			// Ensure target is selected for variant rolls
			result1 = await this._rollAttack(strike, 0, targetActor, targetToken);
			result2 = await this._rollAttack(strike, 1, targetActor, targetToken);

			// Evaluate hits
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
				damages.push({ idx: h.idx, isCrit, total: dmg.total, roll: dmg.roll });
				combinedTotal += dmg.total;
				damageDetails.push(`${flavorAttack} ${h.idx + 1}${isCrit ? " (crit)" : ""}: ${dmg.total}`);
			}

			// Summary: native attack+damage cards are already in chat; wait for Dice So Nice then add a combined damage card
			if (damages.length) {
				const bothHit = damages.length === 2;
				// Let Dice So Nice finish its 3D animation before the summary appears, otherwise cards overlap
				const diceCount = 2 + damages.length; // 2 attacks + each damage roll
				await this._waitForDice(diceCount);
				const dmgType = strike.item?.system?.damage?.damageType ?? strike.item?.system?.damage?.base?.damageType ?? (hasWolfStance ? "piercing" : "bludgeoning");
				await this._createCombinedDamageMessage(attacker, attackerToken, targetActor, targetToken, combinedTotal, flavorAttack, dmgType, strike);
				// Small textual summary for resistances note (no rolls, just info)
				if (bothHit) {
					await ChatMessage.create({
						speaker: ChatMessage.getSpeaker({ actor: attacker, token: attackerToken.document ?? null }),
						content: `<div class="monk-flurry-card"><p class="hint">${flavorAttack}: ${damageDetails.join(" + ")} = <strong>Combined ${combinedTotal}</strong> — resistances/weaknesses apply once to the combined total. MAP: 0 / -4 (agile). Flourish — once per turn.</p></div>`,
						flavor: `Flurry of Blows — Summary Combined ${combinedTotal}`,
					});
				}
			} else {
				await this._waitForDice(2);
				await ChatMessage.create({
					speaker: ChatMessage.getSpeaker({ actor: attacker }),
					content: `<div class="monk-flurry-card"><h3>Flurry of Blows — ${attackerName} → ${targetName}</h3><p><em>Both attacks missed — no damage, no Stunning Blows.</em></p><p class="hint">Native attack rolls are shown above.</p></div>`,
					flavor: "Flurry of Blows — No hits",
				});
				return;
			}

			// Stunning Blows: if either hit and dealt damage (>0), Fort save vs class DC with incapacitation
			const didDamage = combinedTotal > 0;
			if (didDamage) {
				const classDC = (() => {
					try {
						const cdc = attacker.getStatistic?.("classDC");
						return cdc?.dc?.value ?? attacker.system?.proficiencies?.classDCs?.monk?.dc?.value ?? 16;
					} catch { return 16; }
				})();
				// Roll target Fort save with incapacitation trait so system adjusts degree if target level > 2*attacker level
				let fortResult = null;
				try {
					fortResult = await this._rollCheck(targetActor, "fortitude", classDC, { extraRollOptions: ["incapacitation"], traits: ["incapacitation"] });
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
					const outcomeText = { criticalSuccess: "Critical Success — no stun", success: "Success — no stun", failure: "Failure — Stunned 1", criticalFailure: "Critical Failure — Stunned 3" }[degree] ?? degree;
					await ChatMessage.create({
						speaker: ChatMessage.getSpeaker({ actor: targetActor }),
						content: `<div class="monk-flurry-card"><h4>Stunning Blows — ${targetName} Fort vs DC ${classDC}</h4><p>Roll: ${fortResult.total} — <strong>${outcomeText}</strong> ${degree?.includes("critical") ? "(incapacitation adjusted if applicable)" : ""}</p></div>`,
						flavor: `Stunning Blows Fort Save — ${degree}`,
						rolls: fortResult.roll ? [fortResult.roll] : [],
					});
					if (stunOps.length) await this._applyConditions(targetActor, stunOps);
				}
			}

			// Trip attempts: only if Wolf Stance and flanking, only on successful hits, up to 2 (stop on success)
			if (hasWolfStance && damages.length) {
				// Check flanking once (position hasn't changed between the two attacks)
				let isFlanking = false;
				try { isFlanking = this._isFlanking(attackerToken, targetToken); } catch {}
				if (!isFlanking) {
					await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: attacker }), content: `<p><em>Not flanking ${targetName} — no Wolf Stance trip attempts.</em></p>`, flavor: "Wolf Stance Trip — no flank" });
				} else {
					const reflexDC = (() => {
						try { return targetActor.getStatistic?.("reflex")?.dc?.value ?? targetActor.system?.saves?.reflex?.dc?.value ?? 15; } catch { return 15; }
					})();
					const proneOps = [];
					let tripped = false;
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
									athResult = await athStat.check.roll({ dc: { value: reflexDC }, createMessage: true, skipDialog: true });
									// Extract degree
									const dos = athResult?.degreeOfSuccess;
									let degree = typeof dos === "number" ? ["criticalFailure", "failure", "success", "criticalSuccess"][dos] : (athResult?.degree ?? dos);
									if (!degree && athResult?.roll?.total) degree = this._degree(null, reflexDC, athResult.roll.total);
									athResult = { roll: athResult.roll ?? athResult, total: athResult.roll?.total ?? athResult.total ?? 0, degree, raw: athResult };
								} else {
									// Manual with MAP
									const baseMod = athStat.check.mod ?? 0;
									const r = await new Roll("1d20 + @mod + @map", { mod: baseMod, map: mapPenalty }).evaluate();
									await r.toMessage({ flavor: `Athletics (Trip) MAP ${mapPenalty} vs Reflex DC ${reflexDC}`, speaker: ChatMessage.getSpeaker({ actor: attacker }) });
									const degree = this._degree(null, reflexDC, r.total);
									athResult = { roll: r, total: r.total, degree, raw: null };
								}
							}
						} catch {}
						if (!athResult) {
							const baseMod = attacker.system?.skills?.athletics?.mod ?? 0;
							const r = await new Roll("1d20 + @mod + @map", { mod: baseMod, map: mapPenalty }).evaluate();
							await r.toMessage({ flavor: `Athletics (Trip) MAP ${mapPenalty} vs Reflex DC ${reflexDC}`, speaker: ChatMessage.getSpeaker({ actor: attacker }) });
							athResult = { roll: r, total: r.total, degree: this._degree(null, reflexDC, r.total) };
						}
						const degree = athResult.degree;
						const success = degree === "success" || degree === "criticalSuccess";
						const critFail = degree === "criticalFailure";
						await ChatMessage.create({
							speaker: ChatMessage.getSpeaker({ actor: attacker }),
							content: `<div class="monk-flurry-card"><h4>Trip Attempt ${dmg.idx + 1} — ${attackerName} vs ${targetName} Reflex DC ${reflexDC} (MAP ${mapPenalty})</h4><p>Roll ${athResult.total} — <strong>${degree}</strong> ${success ? "— Prone!" : critFail ? "— Crit Fail! You fall prone." : ""}</p></div>`,
							flavor: `Trip ${dmg.idx + 1} — ${degree}`,
							rolls: athResult.roll ? [athResult.roll] : [],
						});
						if (success) {
							if (!targetActor.hasCondition?.("prone")) proneOps.push({ type: "prone" });
							tripped = true;
						} else if (critFail) {
							// Attacker falls prone
							if (!attacker.hasCondition?.("prone")) {
								await this._applyConditions(attacker, [{ type: "prone" }]);
							}
						}
					}
					if (proneOps.length) await this._applyConditions(targetActor, proneOps);
				}
			}

		} catch (e) {
			console.error(`${Manager.id} | monkFlurry execute failed`, e);
			ui.notifications.error("Flurry of Blows failed — see console (F12)");
		}
	}
}
