# PF2e VibeModuleRP

A personal collection of quality-of-life tools for **Pathfinder 2e** on **Foundry Virtual Tabletop**, bundled into one module.

## Requirements

- Foundry VTT v12 or newer (verified on v14.365)
- The official [PF2e system](https://foundryvtt.com/packages/pf2e)

## Installation

Install from the module management screen using this manifest URL:

```
https://raw.githubusercontent.com/DaliusLuksa/PF2eVibeModuleRP/main/module.json
```

Or download the latest release from the [Releases page](https://github.com/DaliusLuksa/PF2eVibeModuleRP/releases) and install it manually. The module has no module dependencies — only the PF2e system is required.

## Features

Each tool can be enabled or disabled individually in the module settings.

- **Template Effects** — when a spell area template is placed, shows a targeting dialog (who to target: allies/enemies/both, include self/neutral) and optionally auto-applies the matching `Spell Effect: <name>` item from your compendiums to the targeted creatures. When a player applies effects to actors they don't own, the application is routed through a connected GM automatically.
- **Shielded Arm** — restores the missing "Spell Effect: Shielded Arm" compendium entry (AC, shield HP and hardness), including proper Heightened scaling.
- **Spell Shield Tracker** — tracks the HP of spell-effect shields (e.g. Fire Shield), displays current HP in the character sheet, lets blocking damage reduce it, and ends the effect when the shield is destroyed.
- **Improved Invisibility** — hide a token when the Invisible condition is applied, show it again when the condition ends, and clear everyone's targets on the now-invisible actor.
- **Player Token Invisibility Toggle** — each player can toggle whether their canvas cursor and movement previews are hidden from other players (default key: F9).
- **Direct Attribute Rolls** — adds a d20 button to each attribute on character sheets: click to roll, Shift-click for the check dialog (bonuses, fortune/misfortune), Ctrl/Cmd-click for a blind roll (GM).
- **Popout Initiative Sync** — keeps the initiative roll button in sync on character sheets opened in popout windows.
- **Volume Persistence** — remembers the Music, Environment and Interface volume sliders across sessions, even when browser storage is cleared or the server address changes (e.g. rotating Cloudflare tunnel links). Each user keeps their own volumes.

## Compatibility

The module is developed for the installed PF2e system version and Foundry release; verify compatibility after updating either. If anything breaks, open an [issue](https://github.com/DaliusLuksa/PF2eVibeModuleRP/issues).

## Development

This module is built from a private Foundry install via `build-module.bat` (copies the module folder into this repo). Versioning follows semantic versioning: bug fixes bump the patch digit, new features the minor digit.
