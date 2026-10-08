<h1 align="center">DSH WorkBuddy</h1>

<p align="center">
  <em>Bring WorkBuddy (domestic and international) models into DeepSeek Harness — no WorkBuddy desktop app required.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-65a30d?style=flat" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/dsh-0.2.0--rc.2-4f46e5?style=flat" alt="DSH 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/providers-two-0ea5e9?style=flat" alt="two providers">
  <img src="https://img.shields.io/badge/prices-live_catalog-brightgreen?style=flat" alt="prices from the live catalog">
  <img src="https://img.shields.io/badge/runtime_dependencies-zero-brightgreen?style=flat" alt="zero runtime dependencies">
</p>

<p align="center">
  <b>English</b> · <a href="./README.zh.md">中文</a>
</p>

- **Sign-in**: per-region browser OAuth — the desktop app is not needed; an existing desktop credential can still be imported read-only
- **Accounts**: region-isolated multi-account list, explicit switching, credit display; the plugin keeps its own copy separate from the desktop auth files
- **One-click check-in**: daily check-in, the cat's growth trip, and every growth-center task (签到 / 猫猫旅行) collected in one action — auto check-in is optional and off by default
- **The two regions stay strangers**: each keeps its own credential, its own catalog and its own credit balance; an empty region stays empty rather than borrowing the other one's lineup, and switching accounts never touches in-flight requests
- **Nothing is done to your desktop app**: its login state is only ever read, never written; the plugin stores its own per-region credential copies, and Disconnect deletes only those

<p align="center">
  <img src="./docs/card-accounts.png" alt="DSH WorkBuddy settings card: accounts and credits" width="46%">
  <img src="./docs/card-models.png" alt="DSH WorkBuddy settings card: model scope and switches" width="46%">
</p>

<p align="center">
  <img src="./docs/model-picker.png" alt="Picking a WorkBuddy model in the DSH model selector" width="92%">
</p>

## Quick start

1. Node 22+, with DSH installed.
2. Install the plugin and start:

```sh
dsh plugin --profile web add github:Faide-cyber/dsh-workbuddy
dsh web
```

3. Open **Settings → Plugins → DSH WorkBuddy**, click **Connect**, and sign in on the WorkBuddy page that opens.
4. Pick a **WorkBuddy** model in the model selector — with the default **free models only** scope, the list is exactly what that region's catalog prices `x0.00` right now.

You can also sign in from a terminal:

```sh
dsh plugin --profile web exec dsh-workbuddy login
```

**Restart `dsh web`** after installing, updating, or signing in. Refreshing the browser is not enough — Node modules stay in memory.

The default model can be set in `~/.dsh/settings.yaml`:

```yaml
agent-default-model:
  provider: workbuddy-ai
  model: hy3
  reasoningEffort: high
```

Use an id the region actually lists: the model list is whatever that region's live catalog returns, so a pinned default can become stale. `hy3` is free in both regions at the time of writing.

## How sign-in works

Each region uses the official CLI auth endpoints independently:

1. `POST /v2/plugin/auth/state?platform=CLI&nonce=` (international `www.workbuddy.ai`, domestic `copilot.tencent.com`)
2. Open the returned `authUrl`
3. Poll `GET /v2/plugin/auth/token?state=` (upstream returns `11217` while still pending)
4. The token is written to the region's plugin copy: international `$DSH_HOME/.workbuddy-ai-auth.json`, domestic `$DSH_HOME/.workbuddy-cn-auth.json`

The desktop app's `workbuddy-desktop-ai.info` (international) and `workbuddy-desktop.info` (domestic) are read-only — the plugin never writes them. It only stores its own per-region credential copies obtained through OAuth.

The settings card lists every imported account. Switching only affects subsequent requests; in-flight requests keep using the original account, and bulk credit/check-in operations do not change the current selection.

**Disconnect** / `logout` only deletes that region's own plugin credentials; the desktop app is untouched.

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
| Signed in but no models | The region's catalog request failed or returned nothing — check connectivity and whether the token is still valid; the list stays empty rather than borrowing the other region's models |
| `doctor` says signed-out | Run `login` first, or confirm the international desktop app is signed in |
| Want paid models | Switch the scope to "All models" on the settings card — credits will be burned |
| A model shows `x0.00` but you expected a price | It is inside a limited-time free promotion; the paid rate returns when the promotion ends |

```sh
dsh plugin --profile web exec dsh-workbuddy doctor
```

## Disclaimer

For personal learning and research only, driving your own WorkBuddy account on your own machine. Follow the WorkBuddy terms of service. This project is not affiliated with Tencent, WorkBuddy, or DeepSeek.

## License

[MIT](./LICENSE)
