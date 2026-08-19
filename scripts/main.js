import { Manager } from "./core/manager.js";
import { TemplateEffectsTool } from "./tools/template-effects.js";
import { ShieldedArmTool } from "./tools/shielded-arm.js";
import { CalmEffectsTool } from "./tools/calm-effects.js";
import { HideCursorTool } from "./tools/hide-cursor.js";
import { InvisibleTokenTool } from "./tools/invisible-token.js";
import { SpellShieldTrackerTool } from "./tools/spell-shield-tracker.js";
import { AttributeRollTool } from "./tools/attribute-roll.js";
import { PopoutInitiativeTool } from "./tools/popout-initiative.js";
import { PopoutSortableRepairTool } from "./tools/popout-sortable-repair.js";
import { VolumePersistenceTool } from "./tools/volume-persistence.js";
import { SustainReminderTool } from "./tools/sustain-reminder.js";
import { EffectAnimationTool } from "./tools/effect-animation.js";
import { ActionTrackerTool } from "./tools/action-tracker.js";
import { RollCounterTool } from "./tools/roll-counter.js";

Hooks.once("init", () => {
	Manager.register(TemplateEffectsTool).register(ShieldedArmTool).register(CalmEffectsTool).register(InvisibleTokenTool).register(HideCursorTool).register(SpellShieldTrackerTool).register(AttributeRollTool).register(PopoutInitiativeTool).register(PopoutSortableRepairTool).register(VolumePersistenceTool).register(SustainReminderTool).register(EffectAnimationTool).register(ActionTrackerTool).register(RollCounterTool).registerSettings();
	Manager.initialize();
	Manager.boot();
});