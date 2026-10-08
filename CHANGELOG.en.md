# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

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
