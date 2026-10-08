# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-02

First standalone release. Derived from `dsh-workbuddyai-connect`, renamed to `dsh-workbuddy` with independent identifiers.

### Added

- Two-region providers: `workbuddy-ai` (international, shown as **WorkBuddy**) and `workbuddy-cn` (domestic, shown as **WorkBuddy 国内**)
- Per-region browser OAuth sign-in (`auth/state` → `authUrl` → poll `auth/token`); credentials are written only to the plugin's own copy
- Read-only import of desktop app credentials (`workbuddy-desktop-ai.info` / `workbuddy-desktop.info`)
- Region-isolated multi-account list with explicit switching, remaining credits, and a connectivity test
- Optional domestic auto check-in (off by default; only ticked accounts)
- Free-model list driven by the product config pushed by the app, with a built-in fallback
- Settings card: connect/disconnect, account management, `free / all models` scope, refresh intervals
- CLI: `login` / `status` / `doctor` / `logout` (`status` and `doctor` accept `--json`)
- Bilingual README ([中文](./README.md) / [English](./README.en.md)) and a CI workflow

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
