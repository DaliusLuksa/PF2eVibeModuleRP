import { Manager } from "./manager.js";

const SETTING_NAME = "windowPositions";
const POSITION_KEYS = ["left", "top", "width", "height"];
const tracked = new Set();
const dirty = new Map();

Hooks.once("init", () => {
	game.settings.register(Manager.id, SETTING_NAME, {
		scope: "user",
		config: false,
		type: Object,
		default: {}
	});
});

function storageKey(cls) {
	return cls?.DEFAULT_OPTIONS?.id ?? cls?.name ?? null;
}

function pick(position) {
	if (!position) return null;
	const out = {};
	for (const key of POSITION_KEYS) {
		if (Number.isFinite(position[key])) out[key] = position[key];
	}
	if (!Number.isFinite(out.left) || !Number.isFinite(out.top)) return null;
	return out;
}

function loadSaved(key) {
	try {
		const saved = game.settings.get(Manager.id, SETTING_NAME)?.[key];
		if (!saved) return null;
		const out = {};
		for (const field of POSITION_KEYS) {
			if (Number.isFinite(saved[field])) out[field] = saved[field];
		}
		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}

function persistNow(app) {
	const key = storageKey(app.constructor);
	const picked = pick(app.position);
	if (!key || !picked) return;
	dirty.delete(key);
	const all = { ...(game.settings.get(Manager.id, SETTING_NAME) ?? {}), [key]: picked };
	game.settings.set(Manager.id, SETTING_NAME, all);
}

const flushDirty = foundry.utils.debounce(() => {
	if (!dirty.size) return;
	const all = { ...(game.settings.get(Manager.id, SETTING_NAME) ?? {}) };
	for (const [key, picked] of dirty) all[key] = picked;
	dirty.clear();
	game.settings.set(Manager.id, SETTING_NAME, all);
}, 1000);

export function rememberWindowPosition(Base) {
	return class WindowPositionMemory extends Base {
		constructor(options) {
			const key = storageKey(new.target);
			if (key) tracked.add(key);
			const saved = key ? loadSaved(key) : null;
			super(saved ? foundry.utils.mergeObject({ position: saved }, options ?? {}) : options);
		}

		_onClose(options) {
			persistNow(this);
			return super._onClose(options);
		}

		_onPosition(position) {
			const key = storageKey(this.constructor);
			const picked = pick(position);
			if (key && picked && this.rendered) {
				dirty.set(key, picked);
				flushDirty();
			}
			return super._onPosition(position);
		}
	};
}
