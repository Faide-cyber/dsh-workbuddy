# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.6] - 2026-10-09

### Fixed

- The international region lists `deepseek-v4.1-flash` (`x0.00`) again. After 1.0.5 dropped the local fallback list, the international region read `/v2/enterprises/personal/models`, which is a **truncated view**: it omits `deepseek-v4.1-flash` and reports `hy4-preview` as `x0.00` (its promotional price). Both regions now read the catalog the app itself reads, `GET https://www.workbuddy.ai/v3/config`, which also brings in `gpt-6-astra`, `glm-5.3-flash` and `kimi-k2.8-preview`. The old `/v2/enterprises/personal/models` path stays as a fallback, used only when `/v3/config` is unavailable.

## [1.0.5] - 2026-10-09

### Changed

- **The local price table is gone; both regions now follow their own live catalog.** The plugin used to ship a built-in price and free-model list (`src/product-config.ts`) and to override the international catalog's `credits` with it. That file has been removed entirely: which models exist, their context and reasoning efforts, and their `credits` price are all taken verbatim from the region's catalog, so a new model or a price change reaches users immediately instead of waiting for a plugin release. The domestic region was already upstream-authoritative; the international one now matches it.
- Consequently, an empty list before a region's catalog arrives is deliberate — no region borrows another region's lineup (the old three-model local fallback is gone).
- `credits` is the displayed price after any limited-time promotion: `hy4-preview` reads `x0.00` during its promotion and `x0.29` outside it. The plugin no longer second-guesses it and simply mirrors what upstream publishes.
- The `productConfigFile` config key and the `DSH_WORKBUDDY_PRODUCT_CONFIG` environment variable are removed; `doctor` no longer reports a product-config source and instead states that prices are read live from each region's catalog.
- Both READMEs: the subtitle is now "no WorkBuddy desktop app required", the "Free models" section became "Models and prices" (live catalog, promotional discounts), and highlights 3–5 were rewritten (domestic one-click check-in / cat travel / growth tasks, live pricing, providers appearing per sign-in).

## [1.0.4] - 2026-10-09

### Fixed

- WorkBuddy providers no longer appear on the Models settings page while signed out. The provider and its directory entry used to be registered unconditionally at startup, so the page listed a route with no credentials that could not be used; registration now follows each region's credentials — the row appears after signing in to that region and disappears after disconnecting or removing its last account. Both halves (adapter and directory entry) always move together, so a row is never listed but unusable.

### Changed

- The signed-out hint no longer says the desktop app is optional; it now just says to click Connect and sign in through the WorkBuddy website.
- Both READMEs now use a centered title plus badges (license, DSH version, provider count, free-by-default, zero runtime dependencies), and drop the "standalone/isolated from other WorkBuddy plugins" sentence, the `## Relationship to other WorkBuddy plugins` section, `## Known limitations`, and the architecture-credit line.

## [1.0.3] - 2026-10-09

### Fixed

- Connect no longer opens a login URL with the `state` parameter stripped, which made the site report an incomplete login link. On Windows the URL is handed to `rundll32.exe url.dll,FileProtocolHandler` instead of going through `cmd /c start`, because `cmd.exe` treats the `&` in the URL as a command separator and truncates `&state=…`.
- Clicking the other region no longer does nothing after one region is signed in. The card used to fall back to the signed-in region whenever the selected tab was not signed in, so a second region could never be added; the selected tab now always wins, with a one-time preselect of the signed-in region.
- Removed the "Open login page" button, which duplicated Connect (same URL, same action, and two tabs raced for one single-use login state).

### Changed

- Provider display names are now **WorkBuddy 国际版** / **WorkBuddy 国内版**.
- English is now the default README: `README.md` is English and the Chinese one moved to `README.zh.md`.

## [1.0.2] - 2026-10-09

### Fixed

- Added a domestic/international region switch to the signed-out view; previously only a domestic login could be started, leaving the international provider with no entry point.
- Connect no longer opens the login page twice. The host and the card each opened a tab, and both raced for the same single-use login state — the first won, the second showed the site's "login link incomplete" error. Only the host opens it now; the card keeps its "Open login page" link as a fallback.

## [1.0.1] - 2026-10-09

### Fixed

- Unified the security header used by the settings card and host control route, fixing Connect and other card actions being rejected.

## [1.0.0] - 2026-10-09

First standalone release under the `dsh-workbuddy` name with independent identifiers.

### Added

- Two-region providers: `workbuddy-ai` (international, shown as **WorkBuddy**) and `workbuddy-cn` (domestic, shown as **WorkBuddy 国内**)
- Per-region browser OAuth sign-in (`auth/state` → `authUrl` → poll `auth/token`); credentials are written only to the plugin's own copy
- Read-only import of desktop app credentials (`workbuddy-desktop-ai.info` / `workbuddy-desktop.info`)
- Region-isolated multi-account list with explicit switching, remaining credits, and a connectivity test
- Optional domestic auto check-in (off by default; only ticked accounts)
- Free-model list driven by the product config pushed by the app, with a built-in fallback
- Settings card: connect/disconnect, account management, `free / all models` scope, refresh intervals
- CLI: `login` / `status` / `doctor` / `logout` (`status` and `doctor` accept `--json`)
- Bilingual README ([English](./README.md) / [中文](./README.zh.md)) and a CI workflow

### Identifiers (fully isolated from `dsh-connect-workbuddy`)

| Item | Value |
|---|---|
| Providers | `workbuddy-ai` / `workbuddy-cn` |
| Credential files | `.workbuddy-ai-auth.json` / `.workbuddy-cn-auth.json` |
| Heartbeat file | `.workbuddy-ai-host-heartbeat.json` |
| Settings file | `.workbuddy-ai-settings.json` |
| Probe cache | `.workbuddy-ai-probe.json` |
| Environment variables | `DSH_WORKBUDDY_AUTH_FILE` / `DSH_WORKBUDDY_CN_AUTH_FILE` / `DSH_WORKBUDDY_PRODUCT_CONFIG` |
| Control header | `X-WorkBuddy-Control-Key` |

### Compatibility

- Aligned with DSH `0.2.0-rc.2`: every `@deepseek-ai/dsh-*` peer is pinned to exactly `0.2.0-rc.2`, and `@earendil-works/pi-ai` to `^0.87.1`
