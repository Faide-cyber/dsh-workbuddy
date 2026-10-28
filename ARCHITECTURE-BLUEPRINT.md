# dsh-workbuddy 架构蓝图（同构新插件改写指南）

只读分析产出。所有 `文件:行号` 均指参考实现 `E:\dsh\plugin\dsh-workbuddy`。

---

## 0. 总览：一个 DSH LLM provider 插件由哪几块拼成

```
                 ┌──────────────── DSH Host (Node) ────────────────┐
浏览器卡片 ──GET──► /plugins/dsh-workbuddy/status  (web-status.ts)   │
(client/index.tsx)│        │                                        │
        └─POST────► /plugins/dsh-workbuddy/control (control-route.ts)│
                  │        │                                        │
                  │   WorkBuddyAccountStore (auth.ts)  ← 凭据文件     │
                  │   WorkBuddyUpstreamClient (upstream.ts) → 上游    │
                  │   WorkBuddyCatalog (catalog.ts)     ← 实时目录    │
                  │        ▲                                        │
                  │   createWorkBuddyShim (shim.ts) 127.0.0.1:随机端口 │
                  │        ▲  OpenAI 兼容 /v1/chat/completions        │
                  │   PiAiAdapter (adapter.ts) ← 注册进 ctx.llm       │
                  └─────────────────────────────────────────────────┘
```

核心设计取舍（照抄这三条即可同构）：

1. **上游不是 OpenAI 兼容的**，所以插件在本地起一个 loopback shim，把上游的怪癖（强制 stream、`tool_choice` 字符串化、CLI 头）吃掉，然后**用一个标准 pi-ai 的 `openai-completions` provider 指向这个 shim**。适配层因此可以薄到只做"模型列表 + 显示名"。
2. **一个上游 = 两个 provider id**（国际 `workbuddy-ai` / 国内 `workbuddy-cn`）。LLM registry 会拒绝第二个声明同一 route 的 adapter，而用户在同一个 profile 里可能两个都要用，所以 id 必须分开。
3. **模型目录只信上游**。没有本地价格表——上游 `credits` 字段原样透传，改价/上新不用发版。

---

## 1. src/index.ts — 插件入口（Host 半边）

### 1.1 标识与注入

```ts
export const name = 'llm-workbuddy-ai'                 // index.ts:142
export const inject = ['llm']                          // index.ts:145  ← 唯一硬依赖
export const WORKBUDDY_SETTINGS_NS = 'workbuddy-ai' as SettingsNamespace  // index.ts:154
```

`inject` 只声明 `llm`。`webServer` / `settings` / `attachments` 全部走**可选注入**：
- `ctx.inject(['webServer'], webCtx => {...})` (index.ts:666) —— headless profile 无浏览器时整段跳过。
- `ctx.inject(['settings'], settingsCtx => {...})` (index.ts:821) —— 见 1.4。
- `ctx.get('attachments')` (index.ts:902) 惰性取，取不到就传 `undefined`。

`import type {} from '@deepseek-ai/dsh-attachment'` (index.ts:24) 是类型侧的手段：只为让 `Context` 上的 `attachments` 服务在类型层面出现，不产生运行时依赖。

### 1.2 Config schema（Schemastery，完整字段）

`interface Config` (index.ts:157)，schema 在 index.ts:197-218：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `authFile` | `string?` | — | 国际版桌面端 auth 文件路径覆盖 |
| `cnAuthFile` | `string?` | — | 国内版同上 |
| `refreshActiveMinutes` | `number ≥1` | `15` | 当前账号只读刷新间隔（分钟） |
| `refreshInactiveMinutes` | `number ≥1` | `60` | 其他账号刷新间隔 |
| `autoCheckin` | `boolean` | `false` | 国内版每日自动签到 |
| `probeConsent` | `boolean` | `false` | 授权发送推理档位探测（**花积分**，默认关） |
| `modelScope` | `'free'\|'all'` | `'free'` | 国际版模型范围 |
| `cnModelScope` | `'free'\|'all'` | `'free'` | 国内版模型范围 |
| `disabledModels` | `string[]` | `[]` | 只影响 picker 列表，不影响已选模型 |
| `cnDisabledModels` | `string[]` | `[]` | 同上，国内版 |
| `allowedHosts` | `string[]` | `[]` | LAN 访问 DSH Web 时额外信任的 Host/Origin |

写法要点：`z.union([z.const('free'), z.const('all')]).default('free')`、`z.number().min(1).default(15)`、每个字段都 `.description(...)`（description 会出现在设置页）。

### 1.3 `apply(ctx, config)` 全流程（index.ts:226-977）

```
226  const client = new WorkBuddyUpstreamClient()
228  const store    = new WorkBuddyAccountStore({region:'global', desktopPath?:config.authFile, refresh})
233  const cnStore  = new WorkBuddyAccountStore({region:'cn',     desktopPath?:config.cnAuthFile, refresh})
238  const oauth / cnOauth = new WorkBuddyOAuthLogin(client, undefined, 'global'|'cn')

241  let base = () => config                       // settings 服务给出的值
242  const saved = sanitizeSavedConfig(readWorkBuddySettings())   // 卡片自己写的文件
243  const current = (): Config => ({ ...base(), ...saved })      // saved 优先（卡片编辑更新）

245  catalog   = new WorkBuddyCatalog({scope: current().modelScope ?? 'free'})
248  cnCatalog = new WorkBuddyCatalog({scope: current().cnModelScope ?? current().modelScope ?? 'free'})
255  store.setDesktopPath(current().authFile); cnStore.setDesktopPath(current().cnAuthFile)
257  catalog.setDisabled(current().disabledModels ?? []);  cnCatalog.setDisabled(...)

259  shim   = createWorkBuddyShim({store, client, catalog, logger: ctx.logger})
260  cnShim = createWorkBuddyShim({store: cnStore, client, catalog: cnCatalog, logger: ctx.logger})

266  persistConfigPatch(patch) { Object.assign(saved, patch); writeWorkBuddySettings(saved) }  // 写失败要抛，卡片才看得到

287  probeStore   = new WorkBuddyProbeStore({pluginVersion: WORKBUDDY_VERSION})
288  probeService = new WorkBuddyProbeService({store, catalog, credentials: store, client, consent: () => current().probeConsent === true})

339  const controlKey = createControlKey()

666  ctx.inject(['webServer'], ...)   → registerWorkBuddyStatusRoute(...) + registerWorkBuddyControlRoute(..., controlKey)
821  ctx.inject(['settings'], ...)    → settings.register(WORKBUDDY_SETTINGS_NS, Config, {base: config})
869  const backgroundTimer = setInterval(..., 300_000)   // refreshCredits / runAutoCheckin / refreshCheckinStates
877  ctx.effect(() => () => { stopped = true; clearInterval; oauth.cancel(); shim.close(); cnShim.close(); clearHostHeartbeat() })

887  void Promise.all([shim.ready, cnShim.ready]).then(() => {
896     globalAdapter = createWorkBuddyAdapter({shim, store, catalog, provider: WORKBUDDY_PROVIDER, displayName, resolveAttachments, observe})
905     cnAdapter     = createWorkBuddyAdapter({shim: cnShim, store: cnStore, catalog: cnCatalog, provider: WORKBUDDY_CN_PROVIDER, ...})
915     refreshModels = () => { invalidateGlobal?.(); invalidateCn?.(); ctx.emit('llm/adapters-updated') }
922     rows = createProviderRows(ctx.llm, new Map([['global', {...}], ['cn', {...}]]))
937     ctx.effect(() => () => rows?.releaseAll())
941     void syncProviderRows()
946     void writeHostHeartbeat()
952     void (async () => { /* 每个 region 拉一次 fetchModels → catalog.setUpstream */ })()
973  }).catch(err => ctx.logger.error('dsh-workbuddy: loopback endpoint failed to start; provider not registered', err))
```

**改这里就能换平台**：`apply` 里除了 `WORKBUDDY_*` 常量、两个 region 的 store/catalog/oauth 装配，剩下的逻辑都是平台无关的骨架，可以整段照抄。

### 1.4 settings 服务：只读注册 + 自己写文件（重要坑）

index.ts:821-866。**注册了 `settings.register` 但不用它写**——因为在该 profile 里注册从不完成，卡片每次编辑都会在重启后丢失。所以：

- `settings.register(WORKBUDDY_SETTINGS_NS, Config, { base: config })` 返回 `{ get(), watch() }`；
- `base = () => scope.get()`（之后 `current()` 就变成"设置页值 + 卡片文件值"）；
- `scope.watch(...)` 回调里**只补文件里没有的键**：

```ts
const fromSection = sanitizeSavedConfig(scope.get() as Record<string, unknown>)
const filled = saved as Record<string, unknown>
for (const [key, value] of Object.entries(fromSection)) if (!(key in filled)) filled[key] = value
apply()
```

因为 `scope.get()` 永远返回带默认值的全量字段，整份合并会把 `cnModelScope:'free'`、空 disabled 列表盖到用户的文件选择上，下一次卡片编辑就把这份重置固化下来。

`settings.register` 不存在时要 `ctx.logger.info(...)` 后 return，别抛（老版本 host 会 TypeError，被 cordis 吞掉，看起来像插件崩了）。

### 1.5 注册的"能力"清单

| 能力 | 位置 | 机制 |
|---|---|---|
| LLM provider（两个 route） | index.ts:896-935 | `createProviderRows(ctx.llm, ...)` → `llm.registerAdapter([id], adapter)` + `llm.registerConfigurableProviders([...])` |
| 模型列表更新通知 | index.ts:915-920 | `ctx.emit('llm/adapters-updated')` |
| HTTP status 路由（GET） | web-status.ts:260 | `ctx.webServer.register({kind:'exact', path, handler})` |
| HTTP control 路由（POST） | control-route.ts:340 | 同上 |
| 设置卡片 | client/index.tsx:60 | `ctx.slots.register({name:'settings.section', ...})` |
| 后台定时器 | index.ts:869 | `setInterval` + `ctx.effect` 清理 |
| CLI | package.json `bin` → src/bin.ts | `dsh plugin exec dsh-workbuddy status` |
| 心跳文件 | host-heartbeat.ts:50 | `$DSH_HOME/.workbuddy-ai-host-heartbeat.json` |

**没有**注册命令（`ctx.command`）、没有 tool、没有 hook。所有用户交互都在设置卡片里。

### 1.6 平台相关的一堆杂事（可整段照抄，只换常量）

- `storeFor/oauthFor/catalogFor(region)` 三个选择器 (index.ts:388-390)。
- `safeReason(error)` (index.ts:391)：把 JWT 与 `code=/token=` 查询参数脱敏后截 300 字。**这份正则在 web-status.ts:66、control-route.ts:93、bin.ts:17 各存了一份**（三处独立，改一处要改三处）。
- 签到 / 成长计划编排：`doCheckin` (396)、`readGrowth` (424)、`runGrowth` (439)、`runGrowthTasks` (476)、`sweepGrowthTasks` (567)、`checkinAndGrow` (597)、`refreshCheckinStates` (614)、`runAutoCheckin` (646)。节流常量 `GROWTH_REPORT_GAP_MS=1_500` (:382)、`GROWTH_SETTLE_MS=1_500` (:384)、`CHECKIN_SWEEP_WAIT_MS=4_000` (:386)，理由：上报太快上游静默丢弃（**这是正确性旋钮，不是礼貌**）。
- `probeSection()` (index.ts:311) 与 `isProbeCandidate()` (index.ts:305)。

---

## 2. src/adapter.ts — 把上游做成 DSH LLM provider

### 2.1 常量

```ts
export const WORKBUDDY_PROVIDER = 'workbuddy-ai'          // adapter.ts:35  ← provider id 字符串
export const WORKBUDDY_CN_PROVIDER = 'workbuddy-cn'       // adapter.ts:37
export const WORKBUDDY_DISPLAY_NAME = 'WorkBuddy 国际版'   // adapter.ts:40
export const WORKBUDDY_CN_DISPLAY_NAME = 'WorkBuddy 国内版'// adapter.ts:41
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000   // adapter.ts:44
const MAX_REQUEST_IMAGE_BYTES = 20_971_520                // adapter.ts:51
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }  // adapter.ts:62
const RATE_SEPARATOR = ' · '                              // adapter.ts:71
```

`RATE_SEPARATOR` 用中点而不是连字符：模型名本来就带连字符（`Deepseek-V4.1-Flash`），连字符会让"名字到哪结束、倍率从哪开始"变得有歧义。

### 2.2 核心导出

```ts
export function reasoningFields(
  info: WorkBuddyModelInfo,
  observed?: WorkBuddyProbeRecord,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap }   // adapter.ts:141
```

两条来源，严格有序：
1. 行里声明了非空 `supportedEfforts` → 只给这些，**永远优先**，观测结果不能加宽也不能收窄；
2. 否则若本地探测结论是 `validating` → 用探测到的拼写；
3. 都没有 → `{reasoning:false}`（不产生 `reasoning_effort` 上线）。

`off` 只在 `canDisableThinking === true` **且**存在声明集合时给出（探测永远不给 `off`）；`minimal` 恒为 `null`（上游词表里没有）。

```ts
export interface WorkBuddyAdapterOptions {                       // adapter.ts:96
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStoreLike
  catalog: WorkBuddyCatalog
  provider?: string          // 默认 WORKBUDDY_PROVIDER
  displayName?: string
  resolveAttachments?: () => AttachmentStore | undefined
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined
}
export interface WorkBuddyAdapter { adapter: PiAiAdapter; invalidate: () => void }  // adapter.ts:113
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter  // adapter.ts:207
```

`createWorkBuddyAdapter` 的装配（这是"换平台"最需要照抄的一段）：

```ts
const buildModels = (): Model<Api>[] => {
  const baseUrl = `${shim.baseUrl()}/v1`   // OpenAI SDK 会自己拼 /chat/completions，
  return catalog.current().map(info =>     // 所以 shim 的 /v1 前缀正好对齐
    toPiModel(info, baseUrl, providerId, observe?.(info.id)))
}
const base = createProvider({
  id: providerId, name: providerName,
  auth: { apiKey: { name: 'WorkBuddy OAuth bearer token', async resolve({credential}) {...} } },
  models: buildModels(),
  api: openAICompletionsApi(),           // @earendil-works/pi-ai/api/openai-completions.lazy
})
const provider: Provider = { ...base, getModels: () => buildModels() }   // live 读取
```

profile 是**手工拼**的（`ResolvedPiAiProviderProfile` 构造函数不是公开导出）：

```ts
{
  provider, displayName, streamIdleTimeoutMs,
  retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy retryPolicy'),   // @deepseek-ai/dsh-llm
  configuredMaxTokens: new Map(), maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
  piProvider: provider, modelErrors: new Map<string, string>(),
  requestImagePixelBudget: 4_194_304, requestImageMaxBytes: 1_048_576,
} as ResolvedPiAiProviderProfile
```

`WorkBuddyPiAiAdapter extends PiAiAdapter` (adapter.ts:301)：重写两个方法，只为把倍率拼进显示名。

- `listModels(provider)` → `super` 结果先 `.filter(m => !catalog.isDisabled(m.id))`（**只过滤 picker**），再套 `withCatalogDisplay`。
- `resolveModel(provider, model, signal?)` → `super` + 显示名后缀。**不过滤**，所以已经选中一个后来被关掉的模型仍然能解析。
- `infoFor(model)` 用 `catalog.current().find(...)`，**不是** disabled-aware 的列表，理由同上。
- 显示名后缀（`displaySuffix`，adapter.ts:74）是纯展示：上线请求用 `model.id`，picker 提交的是 `{provider, model: id, reasoningEffort}`，宿主不会按名字反查模型。

**额外凭据纪律**（adapter.ts:263-276）：传进去的 `auth.credentials` 三个方法全废（`read`→undefined、`list`→[]、`modify`→抛错、`delete`→空），`authContext.env/fileExists` 也全废。这样 pi-ai 自己的凭据生命周期和"环境变量发现"永远造不出凭据，唯一权威是 `resolveApiKey: async () => shim.token()`。

**换平台要改的**：`WORKBUDDY_PROVIDER/DISPLAY_NAME` 字符串、`toPiModel` 的 `api`（若上游原生支持 openai-completions 就不需要 shim）、`NO_COST`（若上游能报真实价格）。

---

## 3. src/upstream.ts — 上游 HTTP 核心

### 3.1 base URL / 路径表

```ts
const CN_CHAT_BASE    = 'https://copilot.tencent.com'   // upstream.ts:144
const CN_BILLING_BASE = 'https://www.codebuddy.cn'      // upstream.ts:145
const GLOBAL_BASE     = 'https://www.workbuddy.ai'      // upstream.ts:146

const CATALOG_PATH: Record<WorkBuddyRegion, readonly string[]> = {   // upstream.ts:165
  global: ['/v3/config', '/v2/enterprises/personal/models'],
  cn:     ['/v3/config', '/console/enterprises/personal/models'],
}
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'         // upstream.ts:170
const JSON_TIMEOUT_MS = 30_000                          // upstream.ts:171
const ERROR_BODY_LIMIT = 4096                           // upstream.ts:172
```

路径表按顺序尝试。**关键事实**：拿国内路径打 `www.workbuddy.ai` 不是 404，而是 HTTP 500；所以 `fetchModels` 必须按凭据自己的 `domain` 选路径（`regionOf`），不能"两个都试第一个能通就用"。

### 3.2 端点清单

| 方法 | 端点 | 用途 |
|---|---|---|
| `chatStream` | `POST {chatBase}/v2/chat/completions` | SSE 对话（返回原始 `Response`） |
| `refreshToken` | `POST {chatBase}/v2/plugin/auth/token/refresh` | 刷新令牌 |
| `startPluginLogin` | `POST {base}/v2/plugin/auth/state?platform=CLI&nonce=` | 起 OAuth |
| `pollPluginToken` | `GET {base}/v2/plugin/auth/token?state=` | 轮询令牌（`11217` = 还没完成） |
| `fetchModels` | `GET {chatBase}{path}` | 模型目录 |
| `fetchCredits` | `POST {billingBase}/v2/billing/meter/get-user-resource` | 余额/积分 |
| `fetchCheckinStatus` | `POST {billingBase}/v2/billing/meter/checkin-activity-status` | 签到状态（仅国内） |
| `claimDailyCheckin` | `POST {billingBase}/v2/billing/meter/daily-checkin` | 领签到奖励 |
| `probeEffort` | `POST {chatBase}/v2/chat/completions` | 档位探测 |
| — | `/activity/growth/buddy/travel/{status,config,records,depart,claim}` | 成长计划（**无 `/v2` 前缀**） |
| — | `/v2/activity/growth/tasks`, `/v2/activity/growth/tasks/accept`, `/v2/report`, `/activity/growth/tasks/{code}/claim`, `/v2/activity/growth/streak` | 成长任务 |

### 3.3 鉴权头（四种场景）

```ts
commonHeaders(c)      // upstream.ts:356  Accept: 'application/json, text/plain, */*'
                      //                   X-Requested-With: 'XMLHttpRequest'
                      //                   Origin / Referer: `${origin}/`  User-Agent: CLIENT_UA
chatHeaders(c)        // upstream.ts:367  + Content-Type: application/json, X-Product: 'SaaS'
                      //   uid===''      ? 'X-No-User-Id':'1'        : 'X-User-Id': uid
                      //   enterpriseId? 'X-Enterprise-Id'            : 'X-No-Enterprise-Id':'1'
                      //   domain===''   ? 'X-No-Department-Info':'1'  : 'X-Domain': domain
                      //   ★ 聊天请求永不携带 refresh token
pluginAuthHeaders(r)  // upstream.ts:382  未鉴权：X-No-Authorization/X-No-User-Id/
                      //                   X-No-Enterprise-Id/X-No-Department-Info = 'true'
refreshHeaders(c)     // upstream.ts:399  X-Refresh-Token: c.refreshToken
                      //                   X-Auth-Refresh-Source: 'workbuddy'  ← 只在这里出现
billingHeaders(c)     // upstream.ts:412  Authorization: Bearer accessToken
                      //                   X-User-Id / X-Enterprise-Id / X-Tenant-Id / X-Domain
growthHeaders(c)      // upstream.ts:929  Authorization: Bearer ...  X-Codebuddy-Request: '1'
                      //                   X-Client-Platform: 'web'
                      //                   Referer: `${base}/profile/growth-center`  ← 载重头
```

`X-No-*` 的那套写法是官方 CLI 的约定：**缺字段时不是省略头，而是发 `X-No-Xxx: 1`**。

### 3.4 请求体改写 `prepareChatBody`

```ts
export function prepareChatBody(source: string, fixedEffort?: string): string   // upstream.ts:506
```

非 JSON 原样返回；否则五处改写 + 一处条件注入（每处都对应一次实测拒绝）：

1. `stream = true` 强制（上游拒绝非流式）。
2. `normalizeDeveloperRole` (upstream.ts:527)：`role:'developer'` → `'system'`（pi-ai 用 developer 角色发系统提示，上游回 400 code 11128）。
3. `normalizeToolChoice` (upstream.ts:744)：对象形式拍平成字符串；`none` 删 `tool_choice` 连同 `tools`/`functions`；`{type:'function',function:{name}}` → 裸 name。
4. `ensureLeadingSystemMessage` (upstream.ts:543)：首条不是 system 就 `unshift({role:'system',content:'You are a helpful assistant.'})`（上游规定首条必须是 system，否则 11128）。
5. `rewriteFingerprints` (upstream.ts:568)：逐条把 `system`/`assistant` 正文里已登记的字面串改写成同义句，表在 `src/fingerprints.ts`（每条带实测日期与证据；无命中时逐字节不变，护前缀缓存）。2026-10-29 起取代只认句首的 `rewriteHarnessBanner`——后者对现在的首段 `You are a coding agent powered by …` 已不命中。
6. 条件注入 `reasoning_effort = fixedEffort`（仅当行声明 `onlyReasoning` 且 body 无该字段）。

### 3.5 响应包封与错误分类

```ts
interface Envelope { code: number; msg: string; data: unknown }   // upstream.ts:533
readEnvelope(response)     // upstream.ts:539  非 JSON 抛 'workbuddy-ai upstream returned non-JSON (http N): ...'
envelopeError(status, e)   // upstream.ts:559  'workbuddy-ai upstream {kind} (http N): {msg 截 160}'
export function classifyUpstreamError(status, body): UpstreamErrorKind   // upstream.ts:312
```

分类规则（顺序即优先级）：`402`→`hard_credit`；body 命中 `HARD_CREDIT_MARKERS`(upstream.ts:175，含 `insufficient credit`/`quota exceeded`/`积分不足` 等 15 条)→`hard_credit`；`SESSION_DEAD_MARKERS = ['Offline user session not found','12153']`(:189)→`session_dead`；`429`→`soft_rate`；`404`→`not_found`；`>=500`→`server`；`>=400`→`client`。

`UpstreamErrorKind` (upstream.ts:38) 再经 shim 的 `KIND_STATUS`（shim.ts:68）映射成对外的 OpenAI 风格 HTTP 码。

### 3.6 目录解析 `readCatalog`（upstream.ts:687）

```
GET {chatBase}{path}  Bearer
→ envelope.data.models[]  （原始模型表）
→ envelope.data.agents[]  → 找 name === 'cli' 的那条，取其 models[] 作为白名单 id 顺序
逐行过滤：id 非空、disabled !== true、maxInputTokens > 0、maxOutputTokens > 0
映射：  contextWindow = maxInputTokens
        maxTokens     = maxOutputTokens
        supportsImages = (supportsImages === true && disabledMultimodal !== true)
        + resolveUpstreamReasoning(wrapped)   // upstream.ts:192
        + resolveUpstreamBilling(wrapped)     // upstream.ts:288
最终顺序 = cliIds 的顺序（不是上游返回顺序）
```

异常：`'workbuddy-ai model catalog lists no cli agent models'`、`'workbuddy-ai model catalog resolved to an empty list'`。

### 3.7 免费判定与显示

```ts
export function normalizeCredits(credits: string|undefined): string|undefined  // upstream.ts:264
export function isFreeCredits(credits: string|undefined): boolean              // upstream.ts:281
export function parseUpstreamExpiry(value: unknown): number|undefined          // upstream.ts:256
export function regionOf(domain: string): WorkBuddyRegion                      // upstream.ts:337
```

- `normalizeCredits`：trim → 纯 `credits` 字样返回 undefined → 去掉尾部 `\s+credits?` → 语言中立的裸倍率（`x0.79`）。理由：这条字符串会经 host LLM seam 到浏览器，而 host 没有 locale 服务，带单位词会被钉死在英文。
- `isFreeCredits`：只认显式 `x0.00`（`/^x?0(?:\.0+)?$/u`）。**倍率缺失不算免费**——上游有些行不写该字段，当成免费会把付费模型标成免费。
- `parseUpstreamExpiry`：`CycleEndTime` 是北京墙钟无时区，用 `Date.UTC(...) - 8*3_600_000` 解析，绝不用 `new Date(string)`（会按宿主时区解释）。
- `regionOf('')` → `'global'`：本插件是国际版，无标注的凭据归它配置的那个部署；带 `.cn` 的凭据仍按 `domain` 路由。

### 3.8 积分形状（`fetchCredits`，upstream.ts:748）

请求体固定：`{PageNumber:1, PageSize:100, ProductCode:'p_tcaca', Status:[0,3], PackageEndTimeRangeBegin, PackageEndTimeRangeEnd}`，日期格式 `YYYY-MM-DD HH:mm:ss`，区间 `now → now + 365*101 天`。

响应层级：`data.Response.Data.Accounts[]`；每项：

```
CapacityType === 4 → 月套餐：size = CycleCapacitySize, remain = CycleCapacityRemain
否则               → 奖励包：size = CapacitySize,       remain = CapacityRemain
expiresAt = parseUpstreamExpiry(CycleEndTime)   // ExpiredTime 上游永远为空
total += Math.max(0, remain)
```

### 3.9 成长计划 / 任务（可整段删掉，除非新平台也有）

- 前缀 `/activity/growth/buddy/travel`（upstream.ts:955）**不能加 `/v2`**——加了网关回 401 `Authorization Required`。
- `runGrowthTrip` (upstream.ts:1066)：`arrived`→claim；`dailyLimitReached`→`'daily-limit'`；`traveling`→`'traveling'`；**其他未知 state 一律 `'unknown-state'` 不 depart**（怕在活动中的行程上再发一趟）；`locationId === 0` 表示无偏好，取 `/config` 的第一个；`/depart` 拒空 body（400），所以必须有目的地。
- `fetchGrowthRewardToday` (upstream.ts:1038) 读 `/records`，靠 `travel_date === day && claimed_at > 0`：`/status` 一旦 idle 就报 `reward_credit: 0`，只能从日志拿真实额度。
- 任务：`GROWTH_TASKS_PREFIX = '/v2/activity/growth/tasks'` (:1140)；`growthSoftRequest` (:1162) 返回 `{ok,code,msg,data}` —— 业务失败是**结果**不是异常（"还没完成"的 claim 回 400，抛出去会让整轮死在最后一个已完成任务上）；`/v2/report` 的 body 必须是**数组**，即使是单条。
- `arrive_at` 上游发的是**秒**，解析时 ×1000 (:1003)。

---

## 4. src/auth.ts + src/oauth.ts — 登录与凭据

### 4.1 凭据类型与文件布局

```ts
export interface WorkBuddyCredential {          // auth.ts:33
  accessToken: string; refreshToken: string; expiresAtMs: number
  refreshExpiresAtMs?: number; domain: string; uid: string
  enterpriseId?: string; nickname?: string
  source: 'desktop' | 'dsh'                     // reflesh 后一律 'dsh'
}
```

路径常量：

| 常量 | 值 | 行 |
|---|---|---|
| `WORKBUDDY_AUTH_FILENAME` | `.workbuddy-ai-auth.json` | auth.ts:71 |
| `WORKBUDDY_CN_AUTH_FILENAME` | `.workbuddy-cn-auth.json` | auth.ts:73 |
| `WORKBUDDY_ACCOUNTS_SUFFIX` | `.accounts.json` | auth.ts:75 |
| `WORKBUDDY_AUTH_FILE_ENV` | `WORKBUDDY_AUTH_FILE` | auth.ts:78 |
| `WORKBUDDY_CN_AUTH_FILE_ENV` | `WORKBUDDY_CN_AUTH_FILE` | auth.ts:80 |
| `WORKBUDDY_DESKTOP_AUTH_BASENAME` | `workbuddy-desktop-ai.info` | auth.ts:90 |
| `WORKBUDDY_CN_DESKTOP_AUTH_BASENAME` | `workbuddy-desktop.info` | auth.ts:82 |
| `OWN_FORMAT_VERSION` | `1` | auth.ts:93 |
| `DESKTOP_AUTH_DIRECTORY` | `['CodeBuddyExtension','Data','Public','auth']` | auth.ts:110 |

全部落在 `resolveDshHome()`（`@deepseek-ai/dsh-home-paths`）下。

**三个文件的磁盘格式**

```jsonc
// $DSH_HOME/.workbuddy-ai-auth.json —— 主文件（CLI/兼容用，version 1）
{ "version": 1, "credential": { accessToken, refreshToken, expiresAtMs, domain, uid, ... } }

// $DSH_HOME/.workbuddy-ai-auth.json.accounts.json —— 多账号 sidecar
{ "version": 1, "selectedAccountId": "global-ab12…", "accounts": [
    { "id": "global-…", "credential": {...}, "note": "…", "checkinEnabled": false } ] }
```

`accountIdFor(region, credential)` (auth.ts:585) = `` `${region}-${sha256(uid || `${domain}:${accessToken}`).slice(0,20)}` `` —— 只有 uid（或 domain+token）参与哈希，token 本身不落盘。

桌面端文件（只读，永不写）：macOS `~/Library/Application Support/<DESKTOP_AUTH_DIRECTORY>/<basename>`；Windows `~/AppData/Local/...` 再 `~/AppData/Roaming/...`；Linux `~/.config/...`；WSL 优先探挂载的 Windows 配置目录（`isWsl()` auth.ts:114，`windowsPathForWsl` auth.ts:121）。见 `defaultDesktopAuthCandidates()` (auth.ts:151)。

写盘一律 `withFileLock(path)` + `writeFileAtomic(path, json, {mode: 0o600, dirMode: 0o700})`（auth.ts:496、:729）。

### 4.2 两套 store

`WorkBuddyCredentialStoreLike` (auth.ts:330) 是共同契约：

```ts
interface WorkBuddyCredentialStoreLike {
  current(): Promise<WorkBuddyCredential | undefined>
  resolve(): Promise<WorkBuddyCredential>
  status(): Promise<WorkBuddyAuthStatus>
  importCredential(credential: WorkBuddyCredential): Promise<WorkBuddyCredential>
  logout(): Promise<void>
}
```

| | `WorkBuddyCredentialStore` (auth.ts:347) | `WorkBuddyAccountStore` (auth.ts:616) |
|---|---|---|
| 定位 | 单凭据、CLI / bin.ts 用 | 多账号、region 作用域、卡片与 provider 用 |
| 取值 | 桌面文件与自有副本取**过期更晚**的那个 | 选中账号，回退第一条 |
| 刷新 | `refreshNow` 单飞 `inflight`；失败仍返回未过期 token | `resolveFor(id)` 每 id 单飞；`refreshToken===''` 视为**不需要刷新** |
| 额外 | `setDesktopPath` / `desktopAuthPath` / `ownAuthPath` / `desktopFilePresent` | `accounts()` `credentialFor` `selectedId` `select` `setNote` `setCheckinEnabled(accountId,enabled)` `removeAccount` `refreshCreditSnapshots` `creditSnapshot` |

刷新余量默认 5 分钟（`refreshMarginMs ?? 5*60*1000`）。`WorkBuddyCredentialStore.resolve()` 找不到凭据时的报错文案带上了检查过的路径（auth.ts:410），是刻意的运维友好。

`refreshCreditSnapshots(fetchCredits, activeMs, inactiveMs)` (auth.ts:841)：按"当前账号用 active 间隔、其他用 inactive"逐个判断是否到期，in-flight 去重，失败存 `{error, checkedAt}` 而不是抛。

### 4.3 身份解析

```ts
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined   // auth.ts:196
export function credentialFromPluginToken(data, region = 'global'): WorkBuddyCredential  // auth.ts:253
function jwtPayload(token)   // auth.ts:236  只 base64url 解 payload，不验签
```

`parseWorkBuddyAuth` 兼容两种磁盘形状：插件 OAuth 的嵌套 `{auth:{...},account:{...}}` 和面板的扁平形式；无 accessToken 返回 undefined。

`credentialFromPluginToken`：uid 依次取 JWT 的 `userId` / `uid` / `sub`；`expiresAtMs` 优先 JWT `exp`，否则 `Date.now()+expiresIn*1000`；`domain` 缺省 `www.workbuddy.ai`(global) / `www.codebuddy.cn`(cn)。

**自有副本必须逐字段读**（`parseOwnDocument` auth.ts:294），不能复用 `parseWorkBuddyAuth`：自有副本存的是归一化后的 camelCase 凭据，round-trip 会去找 `expiresAt` 和 `account`，两个都找不到，于是把过期时间清零、身份头全丢。

### 4.4 OAuth 流程（src/oauth.ts）

```ts
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000          // oauth.ts:22
export type WorkBuddyOAuthClient = Pick<WorkBuddyUpstreamClient,'startPluginLogin'|'pollPluginToken'>
export type WorkBuddyOAuthPoll = {pending:true} | {auth: WorkBuddyCredential}
export function browserOpenCommand(url): {command: string; args: string[]}   // oauth.ts:42
export function openAuthUrl(url): boolean                                    // oauth.ts:52
export class WorkBuddyOAuthLogin {                                            // oauth.ts:71
  constructor(client, open = openAuthUrl, region: WorkBuddyRegion = 'global')
  start(): Promise<{authUrl: string; opened: boolean}>
  poll(): Promise<WorkBuddyOAuthPoll>
  cancel(): void
}
```

流程：`randomBytes(16).toString('hex')` 生成 nonce → `startPluginLogin(nonce, region)` → 得到 `{state, authUrl}` → 在**进程内存**里保存 `{state, authUrl, startedAt}` → 打开浏览器 → 卡片每 2s `poll()`，`pollPluginToken` 返回 `undefined`（上游 code `11217`）就是还没完成 → 拿到 data 后 `credentialFromPluginToken(data, region)`。

两条硬编码的跨平台坑，照抄即可：

- **Windows 不能用 `cmd /c start`**：cmd 会解析 `&`，而每个 authUrl 都带 `&state=…`，URL 被切在第一个 `&`，站点回 "login link incomplete"，两个标签页还会争抢同一个一次性 state。用 `rundll32.exe ['url.dll,FileProtocolHandler', url]`。
- `spawn(..., {detached:true, stdio:'ignore'}).on('error', ()=>{}).unref()`：headless Linux 没有 `xdg-open`，spawn 的 ENOENT 是**异步 error 事件**，try/catch 抓不到，未处理会直接让 `dsh web` 进程退出。

state 只存在内存，是为了让同源的卡片无法"续接一个不是它发起的轮询"。

---

## 5. src/catalog.ts — 模型目录

```ts
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel          // catalog.ts:25
export type WorkBuddyModelScope = 'free' | 'all'                 // catalog.ts:28
export function composeCatalog(upstream, options = {}): readonly WorkBuddyModelInfo[]  // catalog.ts:48
export class WorkBuddyCatalog { ... }                            // catalog.ts:64
```

**来源：纯实时**。`setUpstream(models)` 由 `index.ts` 在登录成功、切账号、启动时各调一次（`client.fetchModels`）。本地**没有**价格表，也没有静态模型兜底——`current()` 在首个 region 应答之前是空数组，这是刻意的（README:132：登录了没模型就是这个 region 的目录请求失败，不会去借另一个 region 的列表）。

`composeCatalog` 是唯一的作用点：

```ts
if (scope === 'all') return [...upstream]
return upstream.filter(model => model.billing?.free === true)
```

类方法：

| 方法 | 语义 |
|---|---|
| `setUpstream(models)` / `upstreamModels()` | 换/读原始行（策略前） |
| `setScope(scope)` / `currentScope()` | 计费策略 |
| `setDisabled(ids)` / `disabledIds()` / `isDisabled(id)` | picker 开关集合 |
| `current()` | `composeCatalog(upstream, {scope})` —— **解析请求用的就是这个** |
| `all()` | `composeCatalog(upstream, {scope:'all'})` |
| `freeIds()` / `isFree(id)` | 当前 region 的免费 id |
| `displaySuffix(id)` | `normalizeCredits(credits)` + badges，用 `' · '` 连 |

`setDisabled` **绝不改 `current()`**：pi-ai 快照由 `current()` 构建，在这里丢掉一个模型会让已经选中它的会话变成 `UNKNOWN_MODEL`。过滤上移到 adapter 的 `listModels`（只看 picker，请求路径不看）。

免费判定最终落在 `isFreeCredits`（见 3.7）：即上游 `tags` 里的 `badge:限时免费:#FF0000` 这类促销标签不会被当成免费，只有 `credits === 'x0.00'` 才算。

---

## 6. 其余 Host 模块

| 文件 | 职责（一行） |
|---|---|
| `src/settings-file.ts` (102) | 卡片编辑的配置存在插件自己的 `$DSH_HOME/.workbuddy-ai-settings.json`；`readWorkBuddySettings` 永不抛（缺失/损坏=`{}`），`writeWorkBuddySettings` **抛**（control route 转 500 让卡片显示），原子写 `.tmp` + rename；`sanitizeSavedConfig` (settings-file.ts:94) 用 `SAVED_FIELDS` 表逐键按类型校验，磁盘文件是不可信输入 |
| `src/status-paths.ts` (191) | Node-free 常量与类型，Host 与浏览器共用的唯一契约：`WORKBUDDY_STATUS_PATH='/plugins/dsh-workbuddy/status'` (:8)、`WORKBUDDY_CONTROL_PATH='/plugins/dsh-workbuddy/control'` (:21)、`WORKBUDDY_CONTROL_KEY_HEADER='x-workbuddy-control-key'` (:11)，以及 `WorkBuddyWebStatus` / `WorkBuddyWebRegion` / `WorkBuddyWebAccount` / `WorkBuddyWebModelBadge` / `WorkBuddyWebProbeSection` / `WorkBuddyControlAction` 全部状态文档类型 |
| `src/loopback.ts` (94) | 本地 HTTP 面的请求门：`LOOPBACK_HOSTS={127.0.0.1, localhost, [::1]}` (:11)、`hostnameOfHost`（IPv6 方括号感知，只剥数字端口）、`hostIsLoopback`/`originIsLoopback`（缺 Origin 放行=非浏览器客户端）、`normalizeAllowedHost`、`hostIsTrusted`/`originIsTrusted`（LAN 白名单**绝不并入** LOOPBACK_HOSTS，否则等于接受伪造该 Host 的 DNS-rebinding 页）、`requestIsTrusted` (:89) |
| `src/shim.ts` (258) | 见 §2 与 §6.1：`createWorkBuddyShim` 起 `127.0.0.1:0` 的 OpenAI 兼容端点，`SHARED_SECRET`(:118) 内存态、`token()` 给 adapter 当 apiKey，三道门（Host loopback / Origin loopback / 常量时间 Bearer），路由 `/healthz`、`/v1/models`、`/v1/chat/completions` |
| `src/web-status.ts` (271) | GET status 路由：`workBuddyAiWebStatus` (web-status.ts:170) 拼状态文档（signed-out/signed-in/error 三态），`modelBadges` (:93) 把 `catalog.all()` 变成卡片徽章（含 `selectable`/`enabled`），`registerWorkBuddyStatusRoute` (:260) 挂载 |
| `src/control-route.ts` (355) | 唯一的状态变更入口：`createControlKey()` (:75) = `randomBytes(24).toString('hex')`，`parseAction` (:114) 手写白名单校验（未知 action/字段一律 undefined），`workBuddyAiControlHandler` (:215)，`registerWorkBuddyControlRoute` (:340)；两道闸——trusted Host+Origin，以及 `x-workbuddy-control-key` 常量时间比对 |
| `src/provider-rows.ts` (100) | 把"provider 目录项 + adapter"作为一个整体增删：DSH 没有"灰显"状态，未登录=不注册；`setLive(region, live)` 幂等，第二半失败时回滚第一半，`releaseAll()` 在 fiber 消亡时调用 |
| `src/model-switches.ts` (55) | 模型开关的唯一写路径 `applyModelSwitchWrite(target, models, enabled, persist, notify)`：先改内存 → 持久化 → **再** `ctx.emit('llm/adapters-updated')`。notify 必须在 finally 里，因为浏览器模型目录只在 `llm/adapters-updated`/`settings/document-updated`/凭据事件时重读，而这条路写的是插件自己的文件，不通知 picker 就会继续列出刚被关掉的模型 |
| `src/probe.ts` (171) | 推理档位探测协议（纯函数）：baseline→sentinel→levels 三段式。sentinel 用一个绝不可能存在的随机值判断"上游到底验不验这个字段"；`INVALID_EFFORT_CODE='invalid_reasoning_effort'` (:81)，`PROBE_EFFORT_CANDIDATES=['low','medium','high','xhigh','max']` (:32，无 `minimal`/`off`)、`PROBE_PROMPT='ping'`、`PROBE_MAX_TOKENS=1`、`PROBE_REQUEST_TIMEOUT_MS=30_000` |
| `src/probe-store.ts` (258) | 探测结论落盘 `$DSH_HOME/.workbuddy-ai-probe.json`（`WORKBUDDY_PROBE_FILENAME` :25，格式 version 1，TTL 14 天，原子写且**写失败不抛**）；`fingerprintModel` (:80) 只哈希 id+reasoning+supportsImages（改名/促销不清空结论），`set` 规则：`unknown` 不覆盖同指纹的既有关键结论 |
| `src/probe-service.ts` (141) | 串行队列 + 同意闸门 + `recordFor(modelId)`（声明集合永远优先，声明了就不看观测）；`probe(modelId, manualConsent=false)` 的手动同意不改变自动探测配置 |
| `src/display.ts` (123) | Node-free 展示助手（card 与 host 共用）：`formatExpiry`（北京墙钟 `YYYY/MM/DD HH:mm:ss`）、`daysUntilExpiry`（向上取整）、`EXPIRY_SOON_DAYS=7`、`formatCountdown`、`checkinExhausted`、`classifyCheckin` |
| `src/growth-tasks.ts` (188) | 纯数据+纯函数：`GROWTH_TASK_SPECS` (:35) 任务码→`{kind,target}`、`GROWTH_SKIP_KINDS` (:65)、`isSkippedGrowthTask`、`GROWTH_NIGHT_KINDS={cat}`、`inGrowthNightWindow`（北京 23:00–08:00）、`buildGrowthEvent(uid,kind,idx)` (:107)——事件字段必须**全量**复制，`userId` 缺失时上游收下 200 但什么都不计 |
| `src/host-heartbeat.ts` (169) | `$DSH_HOME/.workbuddy-ai-host-heartbeat.json`（`WORKBUDDY_HOST_HEARTBEAT_FILENAME` :21，version 1，含 `package`/`pluginVersion`/`registeredAt`/`pid`）；`isHeartbeatProcessAlive` (:160) 用 `process.kill(pid,0)` + 进程启动时间 ≤ `registeredAt` 双检（避免 PID 复用导致假"运行中"）；`processStartTimeMs` 在 Windows 用 wmic CreationDate，其他用 `ps -o lstart=` |
| `src/version.ts` (18) | `WORKBUDDY_VERSION` 由 tsdown `define` 注入的 `__DSH_WORKBUDDY_VERSION__` 得来，未定义则回退 `'0.0.0-dev'` |
| `src/bin.ts` (203) | 免引导 CLI：`run(argv)` 支持 `doctor` / `status` / `login` / `logout` + `--json`；`if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))` 才执行 (:201) |

### 6.1 shim 逐点（要换平台时最需要理解的一段）

```ts
export interface WorkBuddyShim {          // shim.ts:35
  ready: Promise<void>
  baseUrl(): string      // 'http://127.0.0.1:39271'
  token(): string        // 每进程共享密钥
  close(): Promise<void>
}
export interface WorkBuddyShimOptions {    // shim.ts:52
  store: WorkBuddyCredentialStoreLike
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
}
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024                       // shim.ts:59
const KIND_STATUS: Record<UpstreamErrorKind, number> = {          // shim.ts:68
  hard_credit: 402, soft_rate: 429, session_dead: 401,
  not_found: 502, server: 502, client: 400,
}
```

`createWorkBuddyShim` (shim.ts:110)：

- `SHARED_SECRET = randomBytes(32).toString('base64url')` 只在内存；adapter 把它当 OpenAI apiKey，pi-ai 发成 `Authorization: Bearer`；shim **从不把它转发上游**（真凭据来自 store）。本地攻击者即使能打端口也造不出这个 token。
- `server.listen(0, '127.0.0.1')` —— 只绑环回，且端口随机（`baseUrl()` 从 `server.address()` 现取，所以 adapter 每次读都重新解析 baseUrl）。
- 三道门顺序：`hostIsLoopback(headers.host)` → 403 `host_not_allowed`；`originIsLoopback(headers.origin)` → 403 `origin_not_allowed`；`bearerOk`（`timingSafeEqual`）→ 401 `unauthorized`。
- 路由：`GET /healthz` → `{ok:true}`；`GET /v1/models` → `{object:'list', data:[{id, object:'model', created:0, owned_by:'workbuddy-ai'}]}`（来自 `catalog.current()`）；`POST /v1/chat/completions`；其余 404 `not_found` `no such route: {method} {url}`。
- `chatCompletions` (shim.ts:200)：非 JSON content-type → 415；`store.resolve()` 失败 → 401 `not_signed_in`；`prepareChatBody` 改写；`req.on('close')` 时 abort 上游；上游失败 → `{error:{message,type:kind,code:kind}}` + KIND_STATUS 状态码 + 文案 `workbuddy-ai upstream {kind} (http N): {message 截 400}`；成功 → 200 + `text/event-stream` + `Cache-Control: no-cache` + `Connection: keep-alive` + `X-Accel-Buffering: no`，用 `Readable.fromWeb` 直接 pipe；body 在 `[DONE]` 之前出错就补一个 `data: [DONE]\n\n` 收尾。

---

## 7. 客户端半边（浏览器）

### 7.1 挂载方式：`src/client/index.tsx` (73 行)

```ts
export const name = 'dsh-workbuddy-client'      // index.tsx:26
export const inject = ['slots', 'locale']       // index.tsx:38

export function apply(ctx: ClientContext): void {          // index.tsx:50
  try {
    const namespace = 'settings.workbuddy-ai'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'workbuddy-ai',
      order: 16,
      label: () => t('nav'),
      locale: namespace,
      inject: (): WorkBuddyPluginCardInjected => ({ t }),
    }, WorkBuddyPluginCard))
  } catch (error: unknown) {
    console.error('[dsh-workbuddy] client card failed to load (host provider unaffected):', error)
  }
}
```

要点：

- **sidebar 项**：`slots.inject('settings.section', …)` + `slots.register({name:'settings.section', id:'workbuddy-ai', order:16, label:()=>t('nav'), locale, inject})`。
  - `name` 是插槽 id（由 `@deepseek-ai/dsh-client-ui-settings` 声明）；
  - `id` 是这一项的稳定标识；
  - `order: 16` 紧挨内置项之后（account -10 / general 0 / models 10 / plugins 15），且**故意避开**同样占 15 的 Codex 订阅节；
  - `label` 是侧边栏显示名（走 i18n 的 `nav`）；
  - `inject` 返回传给组件的 props（这里是 `{t}`），组件整体挂载，**没有 region prop**——卡自己带 cn/global 切换页。
- **图标**：这里**没有**注册图标，侧边栏项由 label 文字呈现；卡片自己的折叠箭头是内联 SVG `<ChevronDownOutline14>`（WorkBuddyPluginCard.tsx:82，官方 `IconChevronDownOutline14` 的 14×14 path），刻意内联以免依赖 `dsh-client-ui-primitives` 出现在 ModuleLoader 表里。
- **i18n 注册**：`ctx.locale.register('settings.workbuddy-ai', { zh, en })` 一次注册两个语言包（en 为 `as const` 基准，zh 为 `Record<WorkBuddySettingsKey, string>` 保证键全覆盖）；组件侧用 `props.t`，`props.t ?? ((key) => key)` 兜底。
- **整段 try/catch**：slot API 破坏性变更时降级成 `console.error`，不把异常抛进 DSH loader（那会弹 "Failed to load plugins" 横幅）。host 半边不受影响，`dsh-workbuddy status` 也能经心跳文件报健康。

`ClientContext` 是本地最小的类型声明（index.tsx:13），因为 client 侧的 DSH 服务是运行时注入的：

```ts
interface ClientContext {
  effect(effect: () => void | (() => void), name?: string): void
  locale: { register(namespace: string, copy: unknown): void; bind(namespace: string): unknown }
  slots: { inject(name: string, factory: () => unknown): void; register(spec: unknown, component: unknown): unknown }
}
```

### 7.2 `src/client/locales.ts` (263 行)

```ts
export const en = { nav: 'WorkBuddy', title: 'DSH WorkBuddy', … } as const   // locales.ts:7
export type WorkBuddySettingsKey = keyof typeof en                          // locales.ts:135
export const zh: Record<WorkBuddySettingsKey, string> = { … }               // locales.ts:137
```

约 120 个键，命名分组即卡片区块：导航/状态（`nav` `title` `intro` `expand` `collapse` `loading` `signedOut*` `connect` `refreshing`）、账号（`accountsHeading` `addAccount` `useAccount` `selectedAccount` `testConnectivity` `connectivity*` `editNote`/`saveNote`/`notePlaceholder`）、积分（`creditsHeading` `creditsTotal` `creditBucketPlan` `creditBucketBonus` `creditUsedOfSize` `creditPackageExpires` `creditExpiresInDays` `creditExpired`）、范围（`scopeHeading` `scopeFree` `scopeFreeHint` `scopeAll` `scopeAllHint` `scopeActive` `scopePaid` `scopeHidden`）、模型（`modelsHeading` `modelsIntro` `modelsSwitchHint` `modelEnabled` `modelSearch` `modelsSelectAll` `modelsUnselectAll` `modelsNoMatch` `freeModel` `rate` `contextWindow` `priceSourceUpstream`）、探测（`probeHeading` `probeConsent` `probeStart` `probeRedetect` `probeRunning` `probeResult*` `probeConfirmBody` `probeClear`）、签到/成长（`autoCheckin` `checkinSelected` `todayCreditEarned` `todayCreditPending` `streakDays` `growthTraveling*` `growthArrived*` `growthDoneToday*` `growthClaimed` `growthCountdown` `checkinNow` `checkingIn` `checkinDone` `alreadyCheckedIn` `checkinFailed` `checkinUnsupported`）、刷新策略（`activeRefresh` `inactiveRefresh` `refreshPolicyHint`）、tab（`tabStatus` `tabModels` `regionGlobal` `regionCn` `tabLabelGlobal` `tabLabelCn`）。

插值语法是 `{name}`（如 `rate: '{rate} credits per message'`、`signedInAs: 'Signed in as {nickname}'`），由 DSH locale 服务替换。

### 7.3 `src/client/WorkBuddyPluginCard.tsx` (1165 行) — 卡片 UI 组成

```ts
export interface WorkBuddyPluginCardInjected {          // :26
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  region?: 'cn' | 'global'
}
export type WorkBuddyPluginCardProps = Partial<WorkBuddyPluginCardInjected> & { region?: 'cn' | 'global' }
export function WorkBuddyPluginCard(props): ReactElement   // :382
```

常量与模块级助手：`POLL_INTERVAL_MS = 60_000` (:41)、`LOGIN_POLL_INTERVAL_MS = 2_000` (:43)、`SCOPE_OPTIONS` (:177)、`formatCount`/`formatTime`/`formatContext` (:183/188/198)、`modelBadgeLabel` (:205，把上游徽章 `限时免费` 映射到 `freeModel`)、`growthLabel` (:211)、`GrowthLine` (:241，自带 1 秒计时器的旅行倒计时)、`postControl(key, body)` (:293，key 走 **header** `x-workbuddy-control-key` 而非 body，避免落进记录 payload 的日志)、`ModelRow` (:340)。

区块（顶层是自绘的折叠卡，不是宿主给的容器）：

1. **头部按钮**（`:700`）：标题（`fixedRegion` 存在时拼 `· 国内版/国际版`）+ `intro` + 内联 chevron；`aria-expanded={open}`。
2. **未登录块**（`:718`）：地区 tab（`role="tablist"`，仅当没有 `fixedRegion`）、状态文字（`connecting` / `signedOut`）、`refresh` + `connect` 按钮、`signedOutHint`。**未登录时也要有地区选择器**——以前没有，导致 Connect 永远发起国内登录，国际 provider 根本进不去。
3. **错误块**（`:757`）：`status.status === 'error'` 时渲染 `status.message`。
4. **已登录**（`:761`）：
   - 地区 tab 行（`regionRows` 非空且没有 `fixedRegion` 时）；
   - **状态 / 模型 两个 tab**（`role="tablist"`，`tab` state）；
   - `tab === 'status'`：`accountsHeading` + 国内版才有的 `autoCheckin` master Switch → 账号列表。每行：`account.note ?? account.nickname ?? account.id`、当前账号 chip、`domain`、`useAccount` / `editNote` / `removeAccount`(仅多于一个账号时，两次点击确认) / `testConnectivity`；展开区还有积分（`creditsTotal`、按 `capacityType` 分组的 plan/bonus、`creditUsedOfSize`、过期警告 `expiringSoonStyle`/`expiringVerySoonStyle`）、签到与成长行（`立即领取` 小按钮 + 每账号 `自动签到` Switch、`GrowthLine` 倒计时）、刷新策略两个数字输入（onBlur 提交 `setRefreshPolicy`）、`logout` 按钮；
   - `tab === 'models'`：`scopeHeading` 两个 radio（`SCOPE_OPTIONS`）、`scopeActive` 标注、`priceSourceUpstream` 出处行、`modelSearch` 输入 + `modelsSelectAll`/`modelsUnselectAll`、`ModelRow` 列表（徽章 chip、`rate`/`contextWindow`、`modelEnabled` Switch）、`probeHeading` 区块（`probeConsent` Switch、候选数、每个模型的 `probeStart`/`probeRedetect`、结果 `probeResultVerified`/`probeResultNotAtValidating`/`probeResultAt`、`probeClear`）。
5. **确认对话框**：探测前用 `probeConfirmBody`（含 `{model}`）二次确认再调 `probe`。

状态（`:385-400`）：`open` `tab` `status` `loading` `busy` `error` `waitingLogin` `loginRegion` `regionTab` `removeAccountId` `noteAccountId` `noteDraft` `connectivityFeedback` `checkinFeedback` `modelQuery`，`mounted` ref。

行为约定：

- `load()` (:402) 只 GET status；`useEffect` (:432) 立即加载并每 `POLL_INTERVAL_MS` 重读——**折叠时也保持 host 侧只读缓存热**，且这个轮询里**不含任何模型探测**。
- 地区 tab 一次性 seed (:444) 到已登录的 region（`seededRegion` ref 防止覆盖用户之后的点击）。
- `runControl(body, applyPatch?)` (:491)：所有动作都"发起 → 成功后 `load()` 复核"，绝不乐观显示宿主没接受的值；失败的写入仍 `load()`，因为内存可能已经变了。
- `onConnect` (:534)：**只有 host 打开 URL**（`openAuthUrl`），卡片不再 `window.open`——两个标签页争抢同一个一次性 state，先加载的那个会消耗掉它，另一个显示 "login link incomplete"。
- `onScope` (:578) 等一律显式带 `region: cardRegion`（host 缺 region 时回退 global，不带就会从国内 tab 改到国际配置）。
- 搜索只影响显示，不改变开关语义（`visibleModels` :472）；`toggleable` (:479) 只统计 `selectable === true` 的行，所以"全选"不会假装能打开被免费策略挡住的付费模型。

`src/client/dsh-client-ui-primitives.d.ts` (38 行)：手写 `declare module '@deepseek-ai/dsh-client-ui-primitives'`，**只声明 `Switch`**（`{checked,onChange,label,disabled?,title?,className?}`）。这个包不是依赖项，靠 ModuleLoader 运行时解析；只声明用到的那一个符号，多了就是对不住自己的承诺。

---

## 8. 构建与打包

### 8.1 `package.json`

```jsonc
{
  "name": "dsh-workbuddy", "displayName": "DSH WorkBuddy", "version": "1.0.9",
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "main": "lib/index.js", "types": "lib/index.d.ts",
  "bin": { "dsh-workbuddy": "lib/bin.js" },
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {                                        // ★ 打包器读这个字段
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"],
      "platform": "web"
    }
  },
  "scripts": { "prepack": "npm run build", "build": "tsdown", "test": "vitest run",
               "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.client.json",
               "check": "pnpm run typecheck && pnpm run test && pnpm run build" }
}
```

- `dsh.bundle.patch` 指向 `cordis.patch.yml`：安装时自动往 profile 里插配置。
- `dsh.client.inject` 声明**客户端**需要的 DSH client 插件；cordis 会先把它们激活，本插件的 client fiber 才开始（`@deepseek-ai/dsh-client-ui-settings` 提供 `settings.section` 插槽，`@deepseek-ai/dsh-client-locale` 提供 i18n）。
- `dsh.client.platform: "web"`。
- peerDependencies（宿主提供、绝不打包）：`@deepseek-ai/cordis ^4.0.2`、`dsh-atomic-write`、`dsh-attachment`、`dsh-home-paths`、`dsh-host-webserver`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-settings` 全是 `0.2.0-rc.2`；`@deepseek-ai/schemastery ^3.18.2`、`@earendil-works/pi-ai ^0.87.1`、`react ^18.2.0`。
- devDeps：`@types/node`、`@types/react ~18.3.1`、`react`、`tsdown ^0.22.2`、`typescript ^5.9.3`、`vitest ^4.1.8`。
- `files` 白名单：`lib`、`docs`、`cordis.patch.yml`、两个 README、两个 CHANGELOG、`LICENSE`。

### 8.2 `cordis.patch.yml`（13 行，全文）

```yaml
- insert:
    - id: llm-workbuddy
      name: dsh-workbuddy
      config:
        probeConsent: false
        modelScope: free
```

`id` 是 profile 内的插件实例名，`name` 是 npm 包名，`config` 是默认策略（不改变 profile 当前默认模型）。

### 8.3 `tsdown.config.ts`（70 行）— 两个 build 目标

```ts
const PLUGIN_ID = 'dsh-workbuddy'
const VERSION_DEFINE = { __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION) }
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-slots',
] as const
```

**目标 1（Host）**：`entry {index:'src/index.ts', bin:'src/bin.ts'}` → `outDir:'lib'`，`format:['esm']`，`platform:'node'`，`target:'es2024'`，`fixedExtension:false`，`dts:true`，`clean:true`，`define: VERSION_DEFINE`，`deps.neverBundle` 列出全部 DSH/pi-ai/schemastery 包。

**目标 2（Client）**：`entry {client:'src/client/index.tsx'}` → `format:['cjs']`，`platform:'browser'`，`dts:false`，`clean:false`（不能清掉目标 1 的产物），`neverBundle: CLIENT_EXTERNALS`：

```ts
outputOptions: {
  entryFileNames: 'client.js',
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
}
```

- `lib/client.js` 产出约 80 KB，只被 DSH 的 ModuleLoader 消费。
- 换插件时**三处**必须同步改名：`PLUGIN_ID`（banner 里的 id，CI 会 grep 它）、package.json 的 `dsh.client`、以及 `dsh.bundle.patch` 指向。

### 8.4 TypeScript 双配置

`tsconfig.json`（Host）：`strict`、`noImplicitAny`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`module:'esnext'`、`moduleResolution:'bundler'`、`target:'es2024'`、`lib:['es2024']`、`allowImportingTsExtensions:true`、`noEmit`、`types:['node']`，`include:['src','tests']`，**`exclude:['src/client']`**。

`tsconfig.client.json`（浏览器）：同上基础 + `lib:['es2024','dom','dom.iterable']`、`jsx:'react-jsx'`、`types:[]`（**不要 node 类型**），`include:['src/client','src/status-paths.ts']`。

- 两个配置都必须开 `exactOptionalPropertyTypes`，因为源码大量用 `...cond === undefined ? {} : {key: val}` 展开来满足它——这是该项目全程的一致写法，照抄。
- `allowImportingTsExtensions` + 源码里 `./upstream.ts` 之类带扩展名的 import，是 `noEmit` + bundler 组合下的写法。
- 跨半边共享的只有 `status-paths.ts`（以及被两个 build 各打一份的 `display.ts`）。

### 8.5 `vitest.config.ts`（16 行）

```ts
export default defineConfig({
  define: { __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION) },
  test: { include: ['tests/**/*.spec.ts'], environment: 'node' },
})
```

模块级常量需要在测试里也有定义，所以同一个 define 要重复一次。

### 8.6 CI（`.github/workflows/ci.yml`）

矩阵 `os: [ubuntu-latest, windows-latest, macos-latest] × node: [22]`，`timeout-minutes: 20`，步骤：checkout → pnpm 10 → setup-node → `pnpm install --no-frozen-lockfile` → `pnpm run typecheck` → `pnpm run test` → `pnpm run build` → **smoke test**：

```bash
head -2 lib/client.js | grep -q 'id: "dsh-workbuddy"'
test -f lib/index.js && test -f lib/bin.js
```

---

## 9. tests/ 每个 spec

全部 `environment: 'node'`，`tests/**/*.spec.ts`，测试源码（不带 `src/client`，因为卡片会拉 `dsh-client-ui-primitives`，只有在 DSH 之内才解析得到——这也是 `display.ts` 被单独抽出来的原因）。

| spec | 测什么 |
|---|---|
| `tests/auth.spec.ts` (4 KB) | `WorkBuddyAccountStore`：显式选择在多账号下保持稳定并暴露无 token 的账号行；`setNote` 回传归一化后的值；只有 accessToken 的导入不触发不可用的刷新 |
| `tests/card-format.spec.ts` (10 KB) | `display.ts` 的纯格式化分支：`formatExpiry` 在任何宿主时区都写北京墙钟且永不输出 locale 形状；`daysUntilExpiry` 向上取整/过期归零/边界含入；`classifyCheckin` 读 ok 信封里嵌套的失败原因并携带成长赔付；`formatCountdown` 补零、向下取整、小时不按 24 回绕、过去时间夹到 0；`checkinExhausted` 在任务未领/未签到/行程未耗尽时不置灰 |
| `tests/catalog.spec.ts` (4.7 KB) | `composeCatalog`：region 未应答时什么都不给；原样引用该 region 的 credits（含促销 `x0.00`）；`all` 列出付费；保持上游顺序且不注入 region 没给的模型；默认 free。`WorkBuddyCatalog`：两个 region 相互独立；`freeIds`；picker 开关不缩小 `current()`（那才是解析请求用的）、替换而非累加 disabled 集合 |
| `tests/control-route.spec.ts` (8 KB) | control 路由：写完成后才报成功、失败不谎报 ok、策略写没落地要拒、没有 writer 的 action 要拒、checkin 不接受单独的 growth action、失败的 checkin 嵌在 ok 信封里让卡片能看到原因；模型开关：转发 model+新值+region、拒绝要冒泡、畸形开关在写之前就拒、整批一次请求、空/畸形选择在写之前拒 |
| `tests/growth-tasks.spec.ts` (5.3 KB) | `isSkippedGrowthTask`（未知码跳过、只跳过不该上报的 kind、可跑的任务、`Object.prototype` 继承键的陷阱）；`inGrowthNightWindow` 北京 23:00–08:00 且与宿主时区无关；`buildGrowthEvent` 必带 uid、同一任务内 id 互异、夜/昼不同模型、未知 kind 回退 heartbeat 而不抛、专家任务发的是真实使用事件、每条上报 id 不同（否则上游只计第一条） |
| `tests/loopback.spec.ts` (1.2 KB) | `requestIsTrusted`：loopback 直接接受、LAN host 未列白名单前拒绝、未列出的 rebinding Host 不受信；`openAuthUrl` 在浏览器助手缺失时不抛 |
| `tests/model-switches.spec.ts` (4.2 KB) | `applyModelSwitchWrite`：先持久化再通知 picker、重开一个 id 不影响其他 disabled、整批一次写、写入被拒时仍然通知（内存已改）、以及"去掉 notify 的旧写法会违反真实路径满足的契约"（回归锚点） |
| `tests/oauth.spec.ts` (6.7 KB) | `browserOpenCommand` 在 Windows 传整条 URL（含 state）、mac 和 linux 用原生 opener；`credentialFromPluginToken` 从 JWT 读 uid/enterpriseId、缺省时国际/国内各自默认 domain、无 accessToken 报错；`parseAction` 接受浏览器 OAuth action、接受带 region 的 OAuth 并拒绝已退役的 token 回退路径、仍拒绝未知 action；`WorkBuddyOAuthLogin` 打开 authUrl 并在首个非 pending 轮询导入 token、超时报错；`workBuddyAiWebStatus` 未登录文档带 controlKey 以便卡片能起 OAuth |
| `tests/provider-rows.spec.ts` (3.7 KB) | `createProviderRows`：未登录不注册；两半一起加、逆序撤；重复登录幂等；目录项被拒时回滚 adapter；region 互相独立且 `releaseAll` 清空；未知 region 忽略 |
| `tests/settings-file.spec.ts` (1.5 KB) | `sanitizeSavedConfig`：保留通过 schema 校验的已知字段；未知键与错类型值丢弃；部分非法的数组整体丢弃（不做半份抢救）；空对象（=文件缺失的读法）接受 |
| `tests/upstream.spec.ts` (17.7 KB) | `fetchModels` 读国内 app 目录并回退到旧 roster、读国际 app 目录（旧视图会截断它）；`isFreeCredits` 零倍率无论带什么单位词都算免费；`fetchCredits` 只对月套餐用 cycle 容量、从 `CycleEndTime` 按北京墙钟读到期、空的/畸形的到期不显示成 epoch 0；成长行程：idle 时派出且路径**不带版本前缀**、无目的地时报 no-destination 而不是空 body 出发、显式目的地不再读 config、已到达则认领而不是再派一趟、缺失奖励算 nothing-to-claim 不算错、未知状态绝不出发且 traveling 时不重复派、两种拼写的日限、真实上游失败要透传、epoch 秒读成毫秒、零值/缺失可选字段不渲染占位符、今日赔付从行程日志读而不是从 idle 状态、区分"还没领"和"领了零" |

---

## 10. 换平台改写清单（按改动量排序）

| 层 | 要改的东西 | 参考位置 |
|---|---|---|
| 常量 | `WORKBUDDY_PROVIDER` / `_CN_PROVIDER` / 两个 DISPLAY_NAME、`CN_CHAT_BASE` / `CN_BILLING_BASE` / `GLOBAL_BASE`、`CATALOG_PATH`、`CLIENT_UA` | adapter.ts:35-41、upstream.ts:144-168 |
| 鉴权头 | `commonHeaders` / `chatHeaders` / `pluginAuthHeaders` / `refreshHeaders` / `billingHeaders` | upstream.ts:356-425 |
| 目录解析 | `readCatalog` 里的 `data.models` + `agents[name==='cli']` 白名单、字段映射（`maxInputTokens`/`maxOutputTokens`/`supportsImages`/`tags`） | upstream.ts:687-745 |
| 计费 | `resolveUpstreamBilling` + `isFreeCredits` + `normalizeCredits`（若新平台没有 credits 概念，`composeCatalog` 的 free 过滤整个删掉，scope 固定 'all'） | upstream.ts:264-309、catalog.ts:48 |
| 错误映射 | `HARD_CREDIT_MARKERS` / `SESSION_DEAD_MARKERS` / `classifyUpstreamError` / shim 的 `KIND_STATUS` | upstream.ts:175-189,312、shim.ts:68 |
| 请求改写 | `prepareChatBody` 四处改写（若新上游是真 OpenAI 兼容，整个函数退化成 `return source`，甚至 shim 都可以不要） | upstream.ts:448-530 |
| 登录 | `startPluginLogin` / `pollPluginToken`（含 pending code `11217`）、`credentialFromPluginToken` 的 JWT 字段名、`domain` 默认值 | upstream.ts:620-663、auth.ts:253 |
| 文件 | `.workbuddy-ai-auth.json` / `.workbuddy-cn-auth.json` / `.accounts.json` / `.workbuddy-ai-settings.json` / `.workbuddy-ai-probe.json` / `.workbuddy-ai-host-heartbeat.json` 六个文件名与 env `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_CN_AUTH_FILE` | auth.ts:71-90、settings-file.ts:26、probe-store.ts:25、host-heartbeat.ts:21 |
| 路由 | `/plugins/dsh-workbuddy/status`、`/plugins/dsh-workbuddy/control`、头 `x-workbuddy-control-key` | status-paths.ts:8,11,21 |
| 前端 | locale 命名空间 `settings.workbuddy-ai`、slot `id:'workbuddy-ai'`、`order`、`PLUGIN_ID`（banner）、`dsh.client.inject`、`cordis.patch.yml` 的 `id`/`name` | client/index.tsx:52-67、tsdown.config.ts:4,65、package.json |
| 计划外功能 | 签到 `fetchCheckinStatus`/`claimDailyCheckin`、成长计划 `runGrowthTrip` 一族、成长任务 `growth-tasks.ts`、探测 `probe*.ts`：**没有对应上游接口就整块删**，卡片里对应的 tab/区块与 locale 键一起删 | index.ts:396-664、upstream.ts:806-1303、growth-tasks.ts、probe*.ts |

**不要偷懒省掉的东西**：loopback 三道门 + 常量时间比较（shim）、control route 的双闸 + `parseAction` 白名单（它能让一次探测花掉用户的钱）、`sanitizeSavedConfig` 的磁盘输入校验、`writeWorkBuddySettings` 的抛错语义、`prepareChatBody` 的输入形状保证、`safeMessage`/`safeReason` 的脱敏正则、`spawn(...).on('error')` 的异步 ENOENT 处理。
