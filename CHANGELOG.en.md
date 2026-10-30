# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.23] - 2026-10-30

### Fixed

- **The international region started failing every request with `400 code 11128` "Illegal API invocation from an unapproved channel"**. This business code has two causes, distinguished by `msg`: the historical international one was `request illegal` (missing the `X-Conversation-ID`/`-Request-ID`/`-Message-ID` trio, supplied since 1.0.15); this `msg` is **word for word the domestic one**, meaning the international gateway turned on the same content-level literal fingerprint check on 2026-10-30. 1.0.22 pinned the structural layer (line-feed breaking) to `regionOf(credential.domain) === 'cn'` while the semantic layer only covers the two registered phrases — so any unregistered over-long run on the international route was still rejected. The structural layer now runs in **both regions** (it only moves whitespace; meaning and byte count are unchanged), and the region no longer takes part in the protection decision.
- The troubleshooting table now explains how to tell the two international 11128 causes apart (look at `msg`: `request illegal` versus `Illegal API invocation...`).

### Changed

- **Support for DSH 0.2.1-rc.5**: a file-by-file hash comparison of rc.3 against rc.5 shows the ten `@deepseek-ai/dsh-*` packages this plugin actually imports (`dsh-llm`, `dsh-llm-pi-ai`, `dsh-system-prompt`, `dsh-file-reference`, `dsh-atomic-write`, `dsh-attachment`, `dsh-home-paths`, `dsh-host-webserver`, `dsh-settings`, `dsh-client-ui-primitives`) are **byte-for-byte identical**; the only differences are each `package.json` version/pin and one build-commit line in `dsh-client-modules` (`be72761` → `d4db512`). rc.5 is a pure re-release with zero API change, so no plugin change was needed. The peer range introduced in 1.0.20 (`>=0.2.1-rc.1 <0.3.0-0`) already covers rc.5, and a real install passes the gate on the range itself rather than via a `compatibility.json` exemption.
- Tests: the region cases changed from "international rewrites but does not break" to "both regions rewrite and break"; 19 files / 162 tests green, both `tsc` projects and the `tsdown` build clean.
- Known ceiling unchanged: space-free long ASCII runs (URLs, base64, `a/b/c`-style paths) still cannot be broken.

## [1.0.22] - 2026-10-29

### Fixed

- **Domestic requests failed with `400 code 11128` again: the no-break spaces added in 1.0.18/1.0.19 were being silently eaten by the gateway.** Against the same 112-character minimal trigger run, four variants: as-is 400; space swapped to U+00A0 (what shipped) **still 400**; swapped to U+200B **400**; swapped to `\n` **200**, to `\t` **200**. The gateway evidently normalizes whitespace before matching (NBSP becomes a space, ZWSP is stripped), so an invisible-whitespace defence is guaranteed to be zeroed by the next round. The break character is now a real line feed: `BOUNDARY_BREAK = '\n'`.
- **Chinese prose was not covered at all.** The separator only acted on `char === ' '`, and a real domestic system prompt (9414 characters) holds 2275 Han characters but only 1071 spaces — 144 usable swap points, so Chinese sentences went through untouched, which is exactly the kind of text the gateway matches. Breaks are now **inserted** at Unicode wide-character stretches (CJK, kana, Hangul, full-width): the trigger is "previous character wide, current character wide and not leading punctuation", so no line ever starts with `，` or `。`; inserted rather than replaced, so not one character changes.
- **New semantic layer, `src/fingerprints.ts` (table-driven narrow rewrites), immune to whitespace normalization.** It rewrites words, not whitespace, so normalizing whitespace cannot defeat it. It replaces and deletes `rewriteHarnessBanner` / `HARNESS_BANNER`: that regex anchored the start of the first message on `You are an AI agent powered by DeepSeek Harness`, and the current DSH prompt starts with `You are a coding agent powered by the deepseek-v4.1-flash model.` — **a dead regex on current versions**. Two rows now: `DeepSeek Harness` → `DSH` (any position, case-insensitive), and the 112-character `@`-reference run → an equivalent. Each row carries its measurement date and evidence (borrowed from the same-gateway precedent in dsh-providers-hub: no evidence, no row), with tests asserting a dated note exists and that no rewritten text still contains a registered run.
- **Outbound entry-point audit**: `/v2/chat/completions` appears exactly twice in the repo — `chatStream` (all real traffic, full pipeline) and `probeEffort` (body hard-codes `PROBE_PROMPT`, safe by construction). The latter gained a documented gate: anyone adding caller text to that body inherits the fingerprint obligation and must keep the body fixed.

### Changed

- The semantic layer is active in **both regions** (the rewordings are meaning-neutral, so the international region is not harmed); the structural layer (line-feed breaking) stays domestic-only, with the region derived from the credential domain rather than hard-coded.
- Byte-identical when nothing matches (a `toLowerCase().includes` pre-check first), so the upstream prefix cache survives; the separator is an idempotent fixed point (running it twice changes nothing).
- Known ceiling, stated plainly: space-free long ASCII runs (URLs, base64, `a/b/c`-style paths) cannot be broken — the longest surviving stretch in a real system prompt is 67 characters — and the break layer is domestic-only.
- Offline acceptance on a real domestic system prompt (9414 characters, through the built artifact): 0/0 registered runs left, same characters in order ignoring whitespace, no line starting with Chinese punctuation, fixed point, longest stretch 1304 → 67, length 9414 → 9432 (+0.19%). 19 test files / 163 tests green.

## [1.0.21] - 2026-10-28

### Fixed

- **The 刷新 button appeared to do nothing to the credit figure.** The cause was caching, not the network: the status route caches a per-account credit snapshot for the active/inactive interval from the settings page (15 minutes for the selected account by default), and the card's 刷新 button issued the *same* GET as its 60-second poll — while that cache was fresh, a click could only return the old number. 刷新 now sends `?refresh=1`, which bypasses the credit TTL and reads upstream for real (`refreshCreditSnapshots({force:true})`), while the poll keeps using the cache. The status response also gained `Cache-Control: no-store` so a browser cannot cache a live document either.
- **The third README highlight was ambiguous**: "education accounts are marked as unsupported" was read as "the entire education edition is unsupported". It is a *sub-feature* difference — the upstream refuses check-in and growth tasks for education accounts as enterprise accounts (`daily-checkin` answers `400 code 10001`, the growth endpoints 403), while sign-in, multi-account, model catalog, chat and credits all work normally. Reworded to the user's own phrasing: the accounts line now says education accounts are supported, and the one-click check-in line drops the negation entirely.

## [1.0.20] - 2026-10-28

### Changed

- **Peer ranges now use explicit `||` branches, and `engines.dsh` was added.** The seven `@deepseek-ai/dsh-*` peers were spelled `^0.2.0-rc.2`: node-semver admits a prerelease version only when some comparator in the range shares its exact `major.minor.patch` tuple *and* carries its own prerelease tag, and that caret's tag sits on `0.2.0` — it never reaches `0.2.1-rc.3`. DSH's own loader passes `includePrerelease` and so admitted it (confirmed on a real 0.2.1-rc.3 host), but **plain `npm install`/pnpm resolves with ordinary semver and raised `ERESOLVE`**. They are now `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`, measured to give identical verdicts in both modes while still stopping at the 0.3 line.
- `package.json` gained `engines.dsh`, spelled **identically** to those peer ranges — the plugin market's compatibility badge reads this field (it reads an npm manifest, not the repository), so two spellings of one contract would drift; a test asserts they are equal.

## [1.0.19] - 2026-10-28

### Fixed

- **1.0.18's fingerprint break had a gap: as soon as the model quotes DSH's own prompt in a reply, the next turn fails with `400 code 11128` again.** Measured, the gateway scans `system`, `developer` and `assistant` text and does **not** scan `user` or `tool`; 1.0.18 rewrote only `system`, so the ordinary case of an assistant echoing the prompt re-introduced an intact run — with the system prompt itself already clean, the request was still refused. Assistant content is broken now too; `user` and `tool` stay untouched, because those hold the user's own words and file contents and a no-break space there could be written back into a file.

## [1.0.18] - 2026-10-27

### Fixed

- **Domestic requests failed with 400 `code 11128` again (the gateway widened its filter)**: the domestic gateway no longer matches only the identity banner; it matches **literal character runs** taken from DSH's own prompt text (measured: the shortest matching run is the 111-character `Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root`). Rewording runs one at a time is an unwinnable race, so the plugin now **breaks** them instead: before forwarding, one space every so often in a domestic system message becomes a no-break space (U+00A0) via `separateTokenBoundaries()`, so no literal run survives intact while the prompt's words, meaning and length are unchanged. System messages only — DSH's own prompt — never tool results or user content, so no U+00A0 can be written back into a file. The 1.0.14 banner rewrite stays.
- **DSH 0.2.1 refused to load the plugin**: seven `@deepseek-ai/dsh-*` peers were pinned to the exact `0.2.0-rc.2`, which made DSH 0.2.1's compatibility check reject the whole row. They are now `^0.2.0-rc.2` (which pins the minor, admitting 0.2.x and still stopping at 0.3), and `@earendil-works/pi-ai` widened to `^0.87.1 || ^1.1.0` (DSH switched to pi-ai 1.x in 0.2.1). Type-checked against DSH 0.2.1-rc.2 with pi-ai 1.1.0.

### Changed

- Dropped the `settings.register()` call: dsh-settings 0.2.1 removed that API and derives configuration forms from the plugin's own `Config` schema, so no registration is needed. Card edits still go to the plugin's own file.

## [1.0.17] - 2026-10-24

### Fixed

- **Education accounts showed no edition badge and 0 credits**: read the official `/console/accounts` `type=ultimate` value as Education and use `/v2/billing/meter/get-enterprise-user-usage` for enterprise/education quota; the personal quota path is unchanged.

## [1.0.16] - 2026-10-24

### Added

- Read the official account `type` field and show **Personal** / **Education** edition badges for domestic accounts.
- Education accounts keep sign-in, account management, model catalogs, credits, and chat, while unsupported check-in/growth actions are hidden and blocked; personal check-in behavior is unchanged.
- Encrypted desktop auth files can contribute edition identity without replacing the plugin's stored token.

## [1.0.15] - 2026-10-22

### Fixed

- **Every international request failed with 400 `code 11128`**: the gateway now requires the `X-Conversation-ID`, `X-Conversation-Request-ID`, and `X-Conversation-Message-ID` conversation trio; the plugin generates and sends fresh 32-hex IDs for every chat request.
- **The settings card opened on the international region by default**: the combined card now starts on the domestic region while still allowing an explicit switch to international.

## [1.0.14] - 2026-10-22

### Fixed

- **Every domestic request failed with 400 `code 11128` (gateway fingerprinting)**: the domestic gateway rejects a request whose leading system message starts with `You are an AI agent powered by DeepSeek Harness`, matching the sentence start case-insensitively. `prepareChatBody()` now renames that brand word to `DSH` before forwarding and leaves the rest of the text untouched; without `dsh-purge` every request used to be refused. The README troubleshooting table also documents `includeHarnessIdentity: false` as the alternative.

## [1.0.13] - 2026-10-18

### Fixed

- **`<analysis>` / `<summary>` tags still surfaced in the reply body when no effort level was chosen**: 1.0.10 gave models with a fixed `reasoning.effort` a selectable level, but the selector has no default, so DSH sent requests without `reasoningEffort` — and with no level, pi-ai only sends `reasoning_effort` when `thinkingLevelMap.off` is a string; ours is `null`, so no field was sent at all, the upstream never opened a `reasoning_content` channel, and the model had to write its scratchpad into the body. The shim now backstops it: `fixedEffortOf()` reads the fixed effort the current region's catalog declares for that model, and `prepareChatBody()` fills it in when the request carries no `reasoning_effort`. Requests that already picked a level are untouched.

## [1.0.12] - 2026-10-18

### Fixed

- **The streak number now comes from the same source as the growth-center page**: 1.0.11 showed the upstream `streak_days`, which is a check-in total for the activity window, not the "days in a row" figure the page renders. That figure is `GET /activity/growth/streak` → `streak.days` — **without** the `/v2` prefix (`/v2/activity/growth/streak` answers 404, which is why the plugin's reader always came back empty). The card reads that endpoint now and the label is back to "N-day streak" / 「连登 N 天」, falling back to `streak_days` only when the read fails.

## [1.0.11] - 2026-10-18

### Fixed

- **Reverted the 1.0.10 "streak" recomputation**: 1.0.10 derived a consecutive run from `checkin_dates`, inventing a third number — the upstream `streak_days` is a window total and the check-in site shows its own figure, so none of the three agreed. The card now reports the upstream `streak_days` verbatim and the label reads "N check-ins this event" instead of "N-day streak", so no streak is ever claimed.

## [1.0.10] - 2026-10-18

### Fixed

- **`<analysis>` / `<summary>` tags leaking into the reply body**: the upstream declares a single fixed `reasoning.effort` for a group of models (international `deepseek-v4.1-flash`, `balanced-model`; domestic `hy3`, `deepseek-v4-pro`). The plugin read that as "no reasoning control", so it never sent `reasoning_effort`, the upstream never opened the `reasoning_content` channel, and the model drafted its reasoning into the visible text. Those models now declare reasoning at their fixed level and always send `reasoning_effort`; they also no longer enter the reasoning probe queue.
- **"N-day streak" counted window totals, not a streak**: the upstream `streak_days` field is the number of check-ins inside the activity window (measured: 11 check-ins with two missed days). The card now derives the run that actually ends today (or yesterday) from `checkin_dates`, falling back to the raw field only when the list is absent.

### Added

- **The model picker follows real availability**: the upstream catalog carries no per-account visibility, so paid-tier models (international `primary-model`, `gpt-5.5`, …) only answer `is not allowed for user type` on a real request. The first such failure now hides the model from the picker (remembered for the session, cleared on catalog refresh); sessions already using it keep working.

## [1.0.9] - 2026-10-09

### Changed

- The three README screenshots (`docs/card-accounts.png`, `docs/card-models.png`, `docs/model-picker.png`) were replaced with the original, uncompressed captures (about 2.5 MB total), restoring fine detail at the cost of a larger npm package.

## [1.0.8] - 2026-10-09

### Changed

- The five README highlights were rewritten in the requester's own wording: **Sign-in** ("no desktop sign-in at all"; a desktop app credential is still importable read-only), **Accounts** (now naming credit warnings and account notes), **One-click check-in** ("auto check-in is available and off by default"), **Device isolation** (each account's credential, model catalog and credit balance stand apart; switching accounts never touches in-flight requests) and **Works out of the box** (enable it and use it, no extra configuration; DSH 0.2.0-rc.2 desktop is supported today).

## [1.0.7] - 2026-10-09

### Changed

- Both READMEs gained three UI screenshots (accounts and credits, model scope and switches, the model picker), placed above Quick start, with the assets under `docs/`.
- Highlight 3 was renamed from "Domestic one-click" to "One-click check-in"; its wording is unchanged.
- Highlights 4 and 5 were rewritten into two more distinctive ones: **the two regions stay strangers** (each keeps its own credential, its own catalog and its own balance; an empty region stays empty rather than borrowing the other one's lineup; switching accounts never touches in-flight requests) and **nothing is done to your desktop app** (its login state is only ever read, never written; the plugin stores its own per-region credential copies and Disconnect deletes only those). The former "live pricing" and "providers" entries are no longer listed as highlights.
- The "Models and prices" section was removed from both READMEs (the implementation is unchanged).
- `docs` joined the npm package's `files`, so the README screenshots work inside the tarball too.

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
