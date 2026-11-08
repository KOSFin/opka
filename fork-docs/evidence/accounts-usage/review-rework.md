# Usage review rework evidence

2026-11-08, existing Accounts and Usage attempt. `StatusBarSurface` still supplies the established Claude/Codex switcher menus. `UsageRosterPanel` now places one submenu action after each provider's flat account rows. The submenu restores saved-account selection, CLI login and applicable host/WSL runtime controls without adding a second provider heading to the main panel. The action is withheld when the owner snapshot is unverified, so a remote host cannot fall back to local accounts.

Account row triggers are Radix menu items. ArrowDown from the production Usage trigger reaches a specific account row; Enter opens it and Tab reaches its pin, management and reset buttons. Reset opens the existing confirmation dialog. Escape returns focus to Usage. The interaction test uses synthetic remote profiles and stubs every reset RPC. The existing Claude/Codex switcher tests cover the real menu controllers; the production-trigger test substitutes their submenu bodies to isolate the Radix and flat-panel wiring.

The visible Pinned list is now omitted for accounts already represented by the current rows. A collapsed **Other pinned accounts** cleanup remains for pins on another runtime or a removed account. The explanatory shared-budget footer was removed. Other provider rows and Usage history remain in their previous positions.

Synthetic UI: `review-actions.png` shows the initial panel; `review-actions-scrolled.png` shows the Codex reset and switch action after scrolling. They come from the production panel's rendered DOM and current style tokens, captured by headless Chromium. The images are not a connected Electron session. No host accounts or reset credits were mutated.
