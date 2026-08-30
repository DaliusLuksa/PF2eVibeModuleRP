import { Manager } from "../core/manager.js";

const OFF_GUARD_UUID = "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg";
const FLAG_KEY = "flankOffGuard";

/**
 * Flanking Off-Guard.
 *
 * When a combatant in the active encounter becomes flanked (at least two
 * enemies on opposite sides, using the system's own TokenPF2e flanking
 * geometry), the GM's client automatically adds the Off-Guard condition;
 * when not flanked it is removed instantly. Only combatants in the active
 * combat are considered. The condition is tagged with
 * flags.pf2e-vibemodulerp.flankOffGuard so manual Off-Guard is never
 * removed.
 *
 * Trigger: uses the TokenDocument destination coords (change.x/y) directly,
 * so the check reflects where the token WILL be after the drag, without
 * waiting for the Token placeable to refresh or the slide animation to
 * finish. No timeouts — the math is done on the destination immediately.
 */
export class FlankingOffGuardTool {
	static id = "flanking-offguard";
	static category = "flanking-offguard";
	static enabledDefault = true;

	static settings = [
		{
			key: "allow90Degree",
			type: Boolean,
			default: true,
			scope: "world",
			config: true
		}
	];

	static _scheduled = false;
	static _pending = false;

	/* -------------------------------------------- */
	/*  Lifecycle                                   */
	/* -------------------------------------------- */

	static ready() {
		if (!game.user.isGM) {
			console.debug(`${Manager.id} | flanking-offguard: non-GM, no hooks`);
			return;
		}
		Hooks.on("updateToken", this._onUpdateToken.bind(this));
		Hooks.on("createToken", this._schedule.bind(this));
		Hooks.on("deleteToken", this._schedule.bind(this));
		Hooks.on("createCombatant", this._schedule.bind(this));
		Hooks.on("deleteCombatant", this._schedule.bind(this));
		Hooks.on("updateCombatant", this._schedule.bind(this));
		Hooks.on("deleteCombat", this._schedule.bind(this));
		console.debug(`${Manager.id} | flanking-offguard hooks installed`);
		this._schedule();
	}

	/* -------------------------------------------- */
	/*  Hooks                                       */
	/* -------------------------------------------- */

	static _onUpdateToken(tokenDoc, change) {
		if (!("x" in change) && !("y" in change)) return;
		// Destination is known synchronously in `change` — use it directly,
		// no waiting for the placeable's bounds to catch up.
		const dest = { x: change.x ?? tokenDoc.x, y: change.y ?? tokenDoc.y };
		const posMap = new Map();
		posMap.set(tokenDoc.id, dest);
		// Run immediately on the destination, no timeout
		this._recalcWithPositions(posMap).catch((e) => console.error(`${Manager.id} | flanking-offguard recalc failed`, e));
	}

	static _schedule() {
		if (!game.user.isGM) return;
		if (!Manager.isEnabled(this.id)) return;
		if (this._scheduled) {
			this._pending = true;
			return;
		}
		this._scheduled = true;
		queueMicrotask(async () => {
			this._scheduled = false;
			if (this._pending) {
				this._pending = false;
				this._schedule();
			}
			try {
				await this._recalcWithPositions(null);
			} catch (error) {
				console.error(`${Manager.id} | flanking-offguard recalc failed`, error);
			}
			if (this._pending) {
				this._pending = false;
				this._schedule();
			}
		});
	}

	/* -------------------------------------------- */
	/*  Core — position-aware flanking              */
	/* -------------------------------------------- */

	static async _recalc() {
		return this._recalcWithPositions(null);
	}

	/** posMap: Map<tokenDoc.id, {x,y}> overrides for tokens that are mid-move */
	static async _recalcWithPositions(posMap) {
		if (!canvas?.ready) return;
		const combat = game.combat;
		if (!combat?.started) return;
		const combatTokens = [];
		for (const c of combat.combatants) {
			const tok = c.token?.object;
			if (!tok) continue;
			if (tok.document.parent !== canvas.scene) continue;
			if (!tok.actor) continue;
			combatTokens.push(tok);
		}
		if (!combatTokens.length) return;

		for (const target of combatTokens) {
			const actor = target.actor;
			if (!actor) continue;
			if (actor.isDead) continue;
			if (actor.hasCondition?.("unconscious")) continue;

			const targetPos = posMap?.get(target.document.id) ?? { x: target.document.x, y: target.document.y };
			const flanked = this._isFlankedAt(target, targetPos, combatTokens, posMap);
			const hasAuto = this._hasAutoOffGuard(actor);
			const hasAnyOffGuard = actor.hasCondition?.("off-guard");

			if (flanked) {
				const attacker = this._findFlankingAttackerAt(target, targetPos, combatTokens, posMap);
				if (!attacker) continue;
				if (!this._isOffGuardable(target.actor, attacker.actor)) continue;
				if (hasAuto) continue;
				if (hasAnyOffGuard) continue;
				await this._applyOffGuard(actor);
			} else {
				if (!hasAuto) continue;
				await this._removeAutoOffGuard(actor);
			}
		}
	}

	static _isFlankedAt(target, targetPos, allTokens, posMap) {
		return !!this._findFlankingAttackerAt(target, targetPos, allTokens, posMap);
	}

	static _findFlankingAttackerAt(target, targetPos, allTokens, posMap) {
		for (const attacker of allTokens) {
			if (attacker === target) continue;
			if (!attacker.actor) continue;
			const attackerPos = posMap?.get(attacker.document.id) ?? { x: attacker.document.x, y: attacker.document.y };
			try {
				if (this._isFlankingAt(attacker, attackerPos, target, targetPos, allTokens, posMap)) return attacker;
			} catch { continue; }
		}
		return null;
	}

	/* -------------------------------------------- */
	/*  Geometry — mirrors TokenPF2e verbatim       */
	/* -------------------------------------------- */

	static _mechanicalBoundsAt(tok, pos) {
		const size = canvas.grid.size;
		const w = tok.document.width * size;
		const h = tok.document.height * size;
		const rect = new PIXI.Rectangle(pos.x, pos.y, w, h);
		if (tok.document.isTiny) {
			const tl = canvas.grid.getTopLeftPoint(rect);
			return new PIXI.Rectangle(tl.x, tl.y, Math.max(size, w), Math.max(size, h));
		}
		return rect;
	}

	static _distanceAt(attacker, attackerPos, target, targetPos, reach) {
		if (attacker === target) return 0;
		const aBounds = this._mechanicalBoundsAt(attacker, attackerPos);
		const tBounds = this._mechanicalBoundsAt(target, targetPos);
		// Reuse pf2e's cuboid distance (handles grid snap + elevation)
		return this._measureDistanceCuboid(aBounds, tBounds, { reach, token: attacker, target });
	}

	static _isAdjacentAt(a, aPos, b, bPos) {
		return this._distanceAt(a, aPos, b, bPos, null) === canvas.grid.distance;
	}

	static _canFlankAt(attacker, attackerPos, target, targetPos) {
		if (!game.pf2e.settings.automation.flanking) return false;
		if (attacker.document.hidden || target.document.hidden) return false;
		if (attacker === target) return false;
		const aActor = attacker.actor;
		const tActor = target.actor;
		if (!aActor || !tActor) return false;
		const flankable = tActor.attributes?.flanking?.flankable;
		if (!(aActor.attributes.flanking.canFlank && flankable)) return false;
		if (!(aActor.isOfType("creature") && tActor.isOfType("creature"))) return false;
		if (aActor.isAllyOf(tActor)) return false;
		const reach = aActor.getReach({ action: "attack" });
		const dist = this._distanceAt(attacker, attackerPos, target, targetPos, reach);
		return aActor.canAttack && reach >= dist;
	}

	static _onOppositeSidesAt(attacker, attackerPos, ally, allyPos, target, targetPos) {
		const rA = this._mechanicalBoundsAt(attacker, attackerPos);
		const rB = this._mechanicalBoundsAt(ally, allyPos);
		const rT = this._mechanicalBoundsAt(target, targetPos);
		const cA = { x: attackerPos.x + rA.width / 2, y: attackerPos.y + rA.height / 2 };
		const cB = { x: allyPos.x + rB.width / 2, y: allyPos.y + rB.height / 2 };
		const sideTop = new foundry.canvas.geometry.Ray({ x: rT.left, y: rT.top }, { x: rT.left, y: rT.bottom });
		const sideRight = new foundry.canvas.geometry.Ray({ x: rT.right, y: rT.top }, { x: rT.right, y: rT.bottom });
		const sideLeft = new foundry.canvas.geometry.Ray({ x: rT.left, y: rT.top }, { x: rT.right, y: rT.top });
		const sideBottom = new foundry.canvas.geometry.Ray({ x: rT.left, y: rT.bottom }, { x: rT.right, y: rT.bottom });
		const segA = { A: cA, B: cB };
		const hit = (ray) => foundry.utils.lineSegmentIntersects(segA.A, segA.B, ray.A, ray.B);
		return (hit(sideTop) && hit(sideRight)) || (hit(sideLeft) && hit(sideBottom));
	}

	static _isFlankingAt(attacker, attackerPos, target, targetPos, allTokens, posMap) {
		if (!this._canFlankAt(attacker, attackerPos, target, targetPos)) return false;
		const aActor = attacker.actor;
		const r = aActor.attributes.flanking;
		// allies that can flank target (at their current or overridden positions)
		const allies = allTokens.filter((tok) => {
			if (tok === attacker) return false;
			if (!tok.actor) return false;
			const isAlly = tok.actor.isAllyOf(aActor) || (attacker.document.isLinked && tok.actor === aActor && tok.id !== attacker.id);
			if (!isAlly) return false;
			const allyPos = posMap?.get(tok.document.id) ?? { x: tok.document.x, y: tok.document.y };
			return this._canFlankAt(tok, allyPos, target, targetPos);
		});
		if (!allies.length) return false;
		// Gang Up
		if (r.canGangUp.some((e) => (typeof e === "number" ? e <= allies.length : e === true && allies.length >= 1))) return true;
		if (allies.some((tok) => tok.actor?.attributes.flanking.canGangUp.some((e) => e === true))) return true;
		// Animal companion
		if (this._isAdjacentAt(attacker, attackerPos, target, targetPos) && r.canGangUp.includes("animal-companion")) {
			const ok = allies.some((tok) => {
				if (!tok.actor?.isOfType("character")) return false;
				const traits = tok.actor.system.traits.value;
				if (!(traits.includes("minion") && !traits.includes("construct"))) return false;
				const allyPos = posMap?.get(tok.document.id) ?? { x: tok.document.x, y: tok.document.y };
				return this._isAdjacentAt(tok, allyPos, target, targetPos);
			});
			if (ok) return true;
		}
		// Eidolon
		if (this._isAdjacentAt(attacker, attackerPos, target, targetPos) && r.canGangUp.includes("eidolon")) {
			const ok = allies.some((tok) => {
				const allyPos = posMap?.get(tok.document.id) ?? { x: tok.document.x, y: tok.document.y };
				if (!this._isAdjacentAt(tok, allyPos, target, targetPos)) return false;
				if (tok.actor?.isOfType("character")) return tok.actor.system.traits.value.includes("eidolon");
				return false;
			});
			if (ok) return true;
		}
		// Opposite sides (RAW)
		const opposite = allies.some((tok) => {
			const allyPos = posMap?.get(tok.document.id) ?? { x: tok.document.x, y: tok.document.y };
			return this._onOppositeSidesAt(attacker, attackerPos, tok, allyPos, target, targetPos);
		});
		if (opposite) return true;
		// 90-degree house rule — optional, checked after RAW
		if (Manager.isEnabled(this.id) && game.settings.get(Manager.id, `${this.id}.allow90Degree`)) {
			return allies.some((tok) => {
				const allyPos = posMap?.get(tok.document.id) ?? { x: tok.document.x, y: tok.document.y };
				return this._is90DegreeFlankAt(attacker, attackerPos, tok, allyPos, target, targetPos);
			});
		}
		return false;
	}

	static _is90DegreeFlankAt(attacker, attackerPos, ally, allyPos, target, targetPos) {
		// House rule: 90° means straight cardinal sides only (N/S/E/W).
		// If target is in the middle, one attacker must be straight N and the
		// other straight E/W/S (etc.) — diagonals (NE/NW/SE/SW) do NOT count.
		// We quantize each attacker to its cardinal side via overlap with the
		// target's bounds; a diagonal attacker gets no side (null) and never
		// completes a 90° flank.
		const sideA = this._cardinalSideAt(attacker, attackerPos, target, targetPos);
		const sideB = this._cardinalSideAt(ally, allyPos, target, targetPos);
		if (!sideA || !sideB) return false;
		return sideA !== sideB;
	}

	static _cardinalSideAt(attacker, attackerPos, target, targetPos) {
		const rT = this._mechanicalBoundsAt(target, targetPos);
		const rA = this._mechanicalBoundsAt(attacker, attackerPos);
		const cA = { x: attackerPos.x + rA.width / 2, y: attackerPos.y + rA.height / 2 };
		// Straight N/S requires x-overlap; straight E/W requires y-overlap.
		const xOverlaps = cA.x >= rT.left && cA.x <= rT.right;
		const yOverlaps = cA.y >= rT.top && cA.y <= rT.bottom;
		if (cA.y < rT.top && xOverlaps) return "n";
		if (cA.y > rT.bottom && xOverlaps) return "s";
		if (cA.x < rT.left && yOverlaps) return "w";
		if (cA.x > rT.right && yOverlaps) return "e";
		return null;
	}

	/** Copied from pf2e.mjs measureDistanceCuboid / measureDistanceOnGrid (square grid) */
	static _measureDistanceCuboid(e, t, { reach = null, token = null, target = null } = {}) {
		if (canvas.grid.type !== CONST.GRID_TYPES.SQUARE) return canvas.grid.measurePath([e, t]).distance;
		const a = canvas.grid.sizeX;
		const o = { dx: 0, dy: 0, dz: 0 };
		const overlap = t.right > e.left && t.left < e.right && t.bottom > e.top && t.top < e.bottom;
		const overlapRev = e.right > t.left && e.left < t.right && e.bottom > t.top && e.top < t.bottom;
		if (overlap || overlapRev) { o.dx = 0; o.dy = 0; }
		else {
			const snapBounds = (rect, { toward }) => {
				const n = rect.left < toward.left ? Math.ceil : Math.floor;
				const r = rect.top < toward.top ? Math.ceil : Math.floor;
				const i = n(rect.left / a) * a;
				const oy = r(rect.top / a) * a;
				const s = Math.ceil(rect.width / a) * a;
				const c = Math.ceil(rect.height / a) * a;
				return new PIXI.Rectangle(i, oy, s, c);
			};
			const n = snapBounds(e, { toward: t });
			const r = snapBounds(t, { toward: e });
			o.dx = Math.max(n.left - r.right, r.left - n.right, 0) + a;
			o.dy = Math.max(n.top - r.bottom, r.top - n.bottom, 0) + a;
		}
		// Elevation — ignore if same or missing actor, else replicate pf2e's vertical calc
		if (token && target && token.document.elevation !== target.document.elevation && token.actor && target.actor) {
			const nElev = token.document.elevation;
			const sElev = target.document.elevation;
			const [cDim, lDim] = [token.actor.dimensions, target.actor.dimensions];
			const u = canvas.dimensions.size;
			const d = canvas.dimensions.distance;
			const f = Math.floor(nElev / d * u);
			const p = Math.floor((cDim?.height ?? 6) / d * u);
			const gSelf = { top: f, bottom: f + p };
			const f2 = Math.floor(sElev / d * u);
			const p2 = Math.floor((lDim?.height ?? 6) / d * u);
			const gTarget = { top: f2, bottom: f2 + p2 };
			if (gTarget.bottom > gSelf.top && gTarget.top < gSelf.bottom) o.dz = 0;
			else {
				const snapV = (g, { toward }) => {
					const nn = g.top < toward.top ? Math.ceil : Math.floor;
					const rr = g.top < toward.top ? Math.ceil : Math.floor;
					// vertical snap not grid-aligned; reuse same logic as horizontal but simplified
					const ii = nn(g.top / a) * a;
					const oo = rr(g.top / a) * a;
					// height snap
					return { top: ii, bottom: ii + Math.ceil((g.bottom - g.top) / a) * a };
				};
				// Fallback: if vertical snap fails, use simple diff
				const eTop = snapV(gSelf, { toward: gTarget });
				const tTop = snapV(gTarget, { toward: gSelf });
				o.dz = Math.max(eTop.top - tTop.bottom, tTop.top - eTop.bottom, 0) + a;
			}
		} else o.dz = 0;
		return this._measureDistanceOnGrid(o, { reach });
	}

	static _measureDistanceOnGrid(e, { reach = null } = {}) {
		if (!canvas.dimensions) return NaN;
		const n = canvas.dimensions.size;
		const r = canvas.dimensions.distance;
		const i = [Math.ceil(Math.abs(e.dx / n)), Math.ceil(Math.abs(e.dy / n)), Math.ceil(Math.abs((e.dz || 0) / n))].sort((a, b) => a - b);
		const a = { doubleDiagonal: i[0], diagonal: i[1] - i[0], straight: i[2] - i[1] };
		const o = +(a.diagonal + a.doubleDiagonal > 1 && reach === 10);
		return (Math.floor(a.doubleDiagonal * 1.75 + a.diagonal * 1.5 + a.straight) - o) * r;
	}

	static _isOffGuardable(targetActor, attackerActor) {
		try {
			if (!targetActor?.isOfType?.("creature")) return false;
			const flank = targetActor.attributes?.flanking;
			if (!flank?.flankable) return false;
			const offGuardable = flank.offGuardable;
			const canOffGuard = typeof offGuardable === "number" ? (attackerActor?.level ?? 0) > offGuardable : !!offGuardable;
			if (!canOffGuard) return false;
			const rollOpts = attackerActor?.getSelfRollOptions?.("origin") ?? [];
			const test = ["item:type:condition", "item:slug:off-guard", ...rollOpts];
			const immunities = targetActor.attributes?.immunities ?? [];
			if (immunities.some((imm) => { try { return imm.test?.(test); } catch { return false; } })) return false;
			return true;
		} catch { return true; }
	}

	static _hasAutoOffGuard(actor) {
		return actor.items.some((i) => i.slug === "off-guard" && i.getFlag?.(Manager.id, FLAG_KEY));
	}

	static async _applyOffGuard(actor) {
		try {
			const source = await foundry.utils.fromUuid(OFF_GUARD_UUID);
			if (!source) { console.warn(`${Manager.id} | flanking-offguard: Off-Guard source not found`); return; }
			const data = source.toObject();
			data.flags ??= {};
			data.flags[Manager.id] ??= {};
			data.flags[Manager.id][FLAG_KEY] = true;
			delete data._id;
			await actor.createEmbeddedDocuments("Item", [data]);
			console.debug(`${Manager.id} | flanking-offguard: applied Off-Guard to ${actor.name}`);
		} catch (error) { console.warn(`${Manager.id} | could not apply Off-Guard to ${actor.name}`, error); }
	}

	static async _removeAutoOffGuard(actor) {
		try {
			const item = actor.items.find((i) => i.slug === "off-guard" && i.getFlag?.(Manager.id, FLAG_KEY));
			if (!item) return;
			await actor.deleteEmbeddedDocuments("Item", [item.id]);
			console.debug(`${Manager.id} | flanking-offguard: removed Off-Guard from ${actor.name}`);
		} catch (error) { console.warn(`${Manager.id} | could not remove Off-Guard from ${actor.name}`, error); }
	}
}
