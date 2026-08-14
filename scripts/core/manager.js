export const Manager = new (class {
	constructor() {
		this.tools = new Map();
		this.categories = new Set();
		this._settingsRegistered = false;
		this._booted = false;
	}

	get id() {
		return "pf2e-vibemodulerp";
	}

	register(tool) {
		this.tools.set(tool.id, tool);
		if (tool.category) this.categories.add(tool.category);
		return this;
	}

	isEnabled(toolId) {
		return game.settings.get(this.id, `${toolId}.enabled`);
	}

	setting(toolId, key = "enabled") {
		return game.settings.get(this.id, `${toolId}.${key}`);
	}

	localize(path = "", data) {
		const key = `${this.id}.${path}`;
		return data ? game.i18n.format(key, data) : game.i18n.localize(key);
	}

	registerSettings() {
		if (this._settingsRegistered) return;
		this._settingsRegistered = true;
		for (const tool of this.tools.values()) {
			game.settings.register(this.id, `${tool.id}.enabled`, {
				name: this.localize(`settings.${tool.id}.enabled.name`),
				hint: this.localize(`settings.${tool.id}.enabled.hint`),
				scope: "world",
				config: true,
				type: Boolean,
				default: tool.enabledDefault ?? true,
				requiresReload: true
			});
			for (const setting of tool.settings ?? []) {
				game.settings.register(this.id, `${tool.id}.${setting.key}`, {
					name: this.localize(`settings.${tool.id}.${setting.key}.name`),
					hint: this.localize(`settings.${tool.id}.${setting.key}.hint`),
					scope: setting.scope ?? "world",
					config: setting.config ?? true,
					type: setting.type,
					default: setting.default,
					onChange: setting.onChange,
					requiresReload: setting.requiresReload
				});
			}
		}
		Hooks.on("renderSettingsConfig", this._renderSettingsCategories.bind(this));
	}

	initialize() {
		for (const tool of this.tools.values()) {
			tool.init?.();
		}
	}

	boot() {
		if (this._booted) return;
		this._booted = true;
		Hooks.on("ready", () => {
			for (const tool of this.tools.values()) {
				if (this.isEnabled(tool.id)) tool.ready?.();
			}
		});
	}

	_renderSettingsCategories(app, html, data) {
		try {
			if (!this.categories.size || !data?.categories?.[this.id]) return;
			const root = html?.jquery ? html[0] : html;
			const pane = root?.querySelector?.(
				`[data-application-part="main"] [data-group="categories"][data-tab="${this.id}"][data-category="${this.id}"]`
			);
			if (!pane) return;
			this._renderReloadIndicators(pane);
			let first = true;
			const placed = new Set();
			for (const category of this.categories) {
				const firstSetting = pane.querySelector(`[name^="${this.id}.${category}"]`);
				const row = firstSetting?.closest(".form-group");
				if (!row) continue;
				const title = this.localize(`settings.categories.${category}`);
				if (placed.has(title)) continue;
				placed.add(title);
				const header = document.createElement("h4");
				header.textContent = title;
				header.style.marginBlock = first ? "0" : "0.5em 0em";
				row.before(header);
				first = false;
			}
		} catch (error) {
			console.debug(`${this.id} | could not render settings categories`, error);
		}
	}

	_renderReloadIndicators(pane) {
		const icon = `<i class="fa-solid fa-rotate-left" data-tooltip="${this.localize("reloadRequired")}"></i>`;
		for (const [key, setting] of game.settings.settings) {
			if (setting.namespace !== this.id || !setting.requiresReload) continue;
			const row = pane.querySelector(`[name="${key}"]`)?.closest(".form-group");
			const label = row?.querySelector?.("label");
			if (!label || label.querySelector(".reload-indicator")) continue;
			const span = document.createElement("span");
			span.className = "reload-indicator";
			span.innerHTML = `  ${icon}`;
			label.append(span);
		}
	}
})();