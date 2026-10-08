# DSH WorkBuddy

Bring **WorkBuddy (domestic and international)** models into DeepSeek Harness. This plugin is standalone: its providers, loopback shim, and credential copies are isolated from any other WorkBuddy plugin.

English | [中文](./README.md)

- **Sign-in**: per-region browser OAuth, or a read-only import from the desktop app
- **Accounts**: region-isolated multi-account list, explicit switching, credit display; the plugin keeps its own copy separate from the desktop auth files
- **Domestic**: optional auto check-in (off by default, only ticked accounts)
- **Default models**: international lists free models from the product config; domestic lists free models from that region's live catalog
- **Providers**: `workbuddy-ai` (international) and `workbuddy-cn` (domestic) — coexist with other WorkBuddy plugins

## Quick start

1. Node 22+, with DSH installed.
2. Install the plugin and start:

```sh
dsh plugin --profile web add github:Faide-cyber/dsh-workbuddy
dsh web
```

3. Open **Settings → Plugins → DSH WorkBuddy**, click **Connect**, and sign in on the WorkBuddy page that opens.
4. Pick **WorkBuddy / Deepseek-V4.1-Flash** in the model selector.

You can also sign in from a terminal:

```sh
dsh plugin --profile web exec dsh-workbuddy login
```

**Restart `dsh web`** after installing, updating, or signing in. Refreshing the browser is not enough — Node modules stay in memory.

The default model can be set in `~/.dsh/settings.yaml`:

```yaml
agent-default-model:
  provider: workbuddy-ai
  model: deepseek-v4.1-flash
  reasoningEffort: max
```

## How sign-in works

Each region uses the official CLI auth endpoints independently:

1. `POST /v2/plugin/auth/state?platform=CLI&nonce=` (international `www.workbuddy.ai`, domestic `copilot.tencent.com`)
2. Open the returned `authUrl`
3. Poll `GET /v2/plugin/auth/token?state=` (upstream returns `11217` while still pending)
4. The token is written to the region's plugin copy: international `$DSH_HOME/.workbuddy-ai-auth.json`, domestic `$DSH_HOME/.workbuddy-cn-auth.json`

The desktop app's `workbuddy-desktop-ai.info` (international) and `workbuddy-desktop.info` (domestic) are read-only — the plugin never writes them. It only stores its own per-region credential copies obtained through OAuth.

The settings card lists every imported account. Switching only affects subsequent requests; in-flight requests keep using the original account, and bulk credit/check-in operations do not change the current selection.

**Disconnect** / `logout` only deletes that region's own plugin credentials; the desktop app is untouched.

## Free models

The international catalog endpoint (`/v2/enterprises/personal/models`) omits some models, and its `credits` values are not always accurate. The plugin treats the product config pushed by the app as authoritative:

`~/.workbuddy-ai/cache/acc-product-config-v3.json`

When that cache is unavailable, the plugin falls back to its built-in free list. Currently free (`x0.00`) models:

| Model | Context | Image | Reasoning effort |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1M | yes | defaults to high; accepts low / medium / high / xhigh / max |
| `hy4-preview-f` | 1M | yes | declares high |
| `hy3` | 192k | yes | declares low / high |

The catalog does not return `deepseek-v4.1-flash` or `hy4-preview-f`; the plugin adds them from the product config.

`hy4-preview` (without `-f`) may show `x0.00` in the catalog while the product config says `x0.29`. The plugin takes the stricter value so it is never mistaken for free.

The settings card can switch the scope to **All models**. Paid models show their multiplier after the name, and selecting one really does burn credits.

## Relationship to other WorkBuddy plugins

| | `dsh-connect-workbuddy` | `dsh-workbuddy` |
|---|---|---|
| Providers | `workbuddy` / `workbuddy-global` | `workbuddy-cn` / `workbuddy-ai` |
| Credentials | `.workbuddy-auth.cn.json` / `.global.json` | `.workbuddy-cn-auth.json` / `.workbuddy-ai-auth.json` |
| Catalog endpoints | domestic `/console/...`, international regional endpoints | domestic `/console/...`, international `/v2/enterprises/...` |
| Account features | two-region account pool | two-region account list with explicit switching |
| Check-in | supported for domestic | supported for domestic, off by default |

Both can be installed at the same time. Providers, loopback shims, and credential copies are isolated; if they point at the same upstream account, credits, rate limits, and concurrency are still shared server-side.

```sh
dsh plugin --profile web remove dsh-connect-workbuddy
```

## Configuration

Settings → Plugins → **DSH WorkBuddy**:

- **Connect / Disconnect**: per-region browser sign-in, or delete that region's plugin credentials
- Domestic/international account lists, explicit switching, remaining credits, and a connectivity test
- Tick domestic accounts, auto check-in (off by default)
- The active account refreshes read-only every 15 minutes and others every 60 minutes by default — configurable
- **Free models only** (default) / **All models**

Or configure it in the profile's `cordis.patch.yml`:

```yaml
- id: llm-workbuddy
  config:
    modelScope: free          # international: or all
    cnModelScope: free        # domestic: or all
    probeConsent: false       # real model probing off by default
    autoCheckin: false        # domestic auto check-in off by default
    refreshActiveMinutes: 15
    refreshInactiveMinutes: 60
    # Hosts used to reach DSH Web over the LAN (do not add these to LOOPBACK)
    # allowedHosts: ["192.168.1.10"]
    # authFile / cnAuthFile: rarely needed; only for a non-default desktop credential path
```

Environment variables:

| Variable | Effect |
|---|---|
| `DSH_WORKBUDDY_AUTH_FILE` | Override the international desktop credential path (OAuth credentials still go to the plugin's own file) |
| `DSH_WORKBUDDY_CN_AUTH_FILE` | Override the domestic desktop credential path |
| `DSH_WORKBUDDY_PRODUCT_CONFIG` | Override the product config JSON path |

## CLI

```sh
dsh plugin --profile web exec dsh-workbuddy login
dsh plugin --profile web exec dsh-workbuddy status
dsh plugin --profile web exec dsh-workbuddy doctor
dsh plugin --profile web exec dsh-workbuddy logout
```

`status` / `doctor` accept `--json`. `logout` only deletes `$DSH_HOME/.workbuddy-ai-auth.json`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No card in settings / no WorkBuddy in the model list | Restart `dsh web`; refreshing the browser is not enough |
| `dsh web` exits after clicking Connect | On headless Linux without `xdg-open`, update to a build with spawn `error` handling; use the sign-in link on the card |
| 403 `request-not-trusted` when opening the card over a LAN IP | Add that IP/hostname to `allowedHosts`; do not put it in the loopback list |
| Signed in but no free models | Check whether `doctor` can read the product config; without the cache it uses the built-in three-model list |
| `doctor` says signed-out | Run `login` first, or confirm the international desktop app is signed in |
| Want paid models | Switch the scope to "All models" on the settings card — credits will be burned |

```sh
dsh plugin --profile web exec dsh-workbuddy doctor
```

## Known limitations

- Verified under DSH Web on macOS. On headless Linux, "Connect" no longer crashes the process when `xdg-open` is missing. Credential paths are probed on Windows / WSL but not tested there.
- Depends on WorkBuddy client endpoints (not an official open API); upstream changes may require plugin updates.
- The domestic and international endpoints depend on the WorkBuddy client service; upstream changes may require updates for the affected region.
- Auto check-in is domestic-only and off by default; real model probing never runs on a background timer — opening the card does one low-cost connectivity check.

## Disclaimer

For personal learning and research only, driving your own WorkBuddy account on your own machine. Follow the WorkBuddy terms of service. This project is not affiliated with Tencent, WorkBuddy, or DeepSeek.

Architecture inspired by [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT).

## License

[MIT](./LICENSE)
