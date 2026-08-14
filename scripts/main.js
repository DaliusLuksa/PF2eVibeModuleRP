import { Manager } from "./core/manager.js";
import { TemplateEffectsTool } from "./tools/template-effects.js";
import { ShieldedArmTool } from "./tools/shielded-arm.js";
import { HideCursorTool } from "./tools/hide-cursor.js";
import { InvisibleTokenTool } from "./tools/invisible-token.js";
import { SpellShieldTrackerTool } from "./tools/spell-shield-tracker.js";
import { AttributeRollTool } from "./tools/attribute-roll.js";
import { PopoutInitiativeTool } from "./tools/popout-initiative.js";
import { VolumePersistenceTool } from "./tools/volume-persistence.js";

Hooks.once("init", () => {
	Manager.register(TemplateEffectsTool).register(ShieldedArmTool).register(InvisibleTokenTool).register(HideCursorTool).register(SpellShieldTrackerTool).register(AttributeRollTool).register(PopoutInitiativeTool).register(VolumePersistenceTool).registerSettings();
	Manager.initialize();
	Manager.boot();
});