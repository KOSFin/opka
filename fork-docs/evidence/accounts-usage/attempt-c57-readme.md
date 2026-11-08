# Accounts and Usage synthetic UI evidence

Generated on 2026-11-08 from the current React components with `.test` identities and quota data. `AccountsPane.test.tsx` rendered the collapsed provider list. `UsageAccountsContext.test.tsx` rendered a focused active Codex row and an expanded inactive Codex row, including 5h/7d windows, reset count and expiry. The HTML uses CSS compiled from the current `main.css` and changed components. Headless Chromium rendered the PNG files without opening a desktop window.

- `attempt-c57-accounts.png`: all eleven provider sections collapsed.
- `attempt-c57-usage-active.png`: keyboard focused row and confirmable reset action.
- `attempt-c57-usage-inactive.png`: separate select-account action and disabled reset action.

These are synthetic component renders, not a connected Electron session. The Android equivalent was checked with targeted React Native component tests; no Android emulator image was captured.
