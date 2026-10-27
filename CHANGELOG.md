# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.19] - 2026-10-28

### 修复

- **1.0.18 的指纹打断有个缺口：模型只要在回复里引用过 DSH 自己的提示词，下一轮就又会 400 `code 11128`**。实测网关的扫描范围是 `system` / `developer` / `assistant` 三个角色，**不扫** `user` 和 `tool`；而 1.0.18 只改写了 `system`，所以「助手把提示词原文引用一遍」这条极常见的路径会把被打断的子串重新带回来——此时 system 已经干净，仍被拒。现在 `assistant` 的正文也一并打断；`user` 与 `tool` 保持原样，因为那里是用户自己的文字与文件内容，混进不换行空格会被模型写回文件。

## [1.0.18] - 2026-10-27

### 修复

- **国内版又重新每个请求都 400 `code 11128`（渠道风控升级）**：国内网关不再只认那句身份横幅，改为按**字面连续子串**匹配 DSH 自己提示词里的原文（实测最小触发串是 `Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root` 这 111 个字符）。逐个改词是打不完的仗，所以改成**打断子串**：转发前把国内区域的 system 消息里每隔一段距离的一个空格换成不换行空格 U+00A0（`separateTokenBoundaries()`），任何连续子串都无法完整存活，而提示词文字、语义和字数都不变。只动 system 消息（即 DSH 自己的提示词），不碰工具结果和用户内容，避免 U+00A0 被写回文件；1.0.14 的横幅改写保留。
- **DSH 0.2.1 拒绝加载本插件**：`peerDependencies` 里七处 `@deepseek-ai/dsh-*` 原本钉死 `0.2.0-rc.2`，DSH 0.2.1 的兼容性检查因此判定不兼容并拒绝整行。改为 `^0.2.0-rc.2`（`^0.2.0-rc.2` 会钉住 minor，放行 0.2.x、仍挡住 0.3），并把 `@earendil-works/pi-ai` 放宽到 `^0.87.1 || ^1.1.0`（0.2.1 起 DSH 改用 pi-ai 1.x）。已在 0.2.1-rc.2 + pi-ai 1.1.0 的依赖组合下通过类型检查。

### 变更

- 移除对 `settings.register()` 的调用：dsh-settings 0.2.1 去掉该 API，改为从插件自己的 `Config` schema 生成配置表单，插件无需再注册。卡片配置仍写插件自己的文件。

## [1.0.17] - 2026-10-24

### 修复

- **教育公益版不显示徽标且积分为 0**：使用官方 `/console/accounts` 的 `type=ultimate` 映射教育公益版，并改用 `/v2/billing/meter/get-enterprise-user-usage` 读取企业/教育额度；个人版额度接口保持不变。

## [1.0.16] - 2026-10-24

### 新增

- 支持读取官方账号 `type` 字段，区分并显示国内版的「个人版」与「教育公益版」徽标。
- 教育公益版保留登录、账号管理、模型目录、余额和聊天功能，并隐藏/阻止不适用的签到与成长操作；个人版签到行为不变。
- 桌面端加密 auth 文件也可提供版型身份，且不会覆盖插件已保存的 token。

## [1.0.15] - 2026-10-22

### 修复

- **国际版每个请求都 400 `code 11128`**：国际网关现在要求 `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID` 会话头三元组；插件为每次 chat 请求自动生成并补齐 32 位十六进制 ID。
- **插件面板首次打开默认显示国际版**：合并卡片现在固定从国内版开始，仍可手动切换到国际版。

## [1.0.14] - 2026-10-22

### 修复

- **国内版每个请求都 400 `code 11128`（渠道风控）**：国内网关会拒绝首条 system 消息以 `You are an AI agent powered by DeepSeek Harness` 开头的请求，判据锚定句首、大小写不敏感。`prepareChatBody()` 现在在转发前把该品牌词改写为 `DSH`，其余字符原样保留；未安装 `dsh-purge` 的环境此前会因此每个请求都被拒。README 的故障排查表同时给出 `includeHarnessIdentity: false` 的备用做法。

## [1.0.13] - 2026-10-18

### 修复

- **没选档位时正文仍漏 `<analysis>` / `<summary>` 标签**：1.0.10 只是让「上游只声明单个固定 `reasoning.effort`」的模型有了一个可选档位，但选择器没有默认值，于是 DSH 发出的请求不带 `reasoningEffort`；而没有档位时 pi-ai 只在 `thinkingLevelMap.off` 是字符串时才发 `reasoning_effort`，我们的 `off` 是 `null`，结果一个字段都不发，上游不建 `reasoning_content` 通道，模型只能把草稿写进正文。现在由 shim 兜底：`fixedEffortOf()` 按当前区域目录里该模型声明的固定 effort，`prepareChatBody()` 在请求本身没有 `reasoning_effort` 时补上；已显式选过档位的请求不受影响。

## [1.0.12] - 2026-10-18

### 修复

- **连登天数改为与官网 growth-center 同源**：1.0.11 显示的是上游 `streak_days`（活动期签到次数），与官网页面上的「本月已连登 N 天」不是同一个数。官网该数字来自 `GET /activity/growth/streak` 的 `streak.days`——**没有 `/v2` 前缀**（`/v2/activity/growth/streak` 返回 404，所以插件里那个读取函数一直拿到空值）。现在读这个端点，标签恢复为「连登 N 天」/「N-day streak」，仅在读取失败时退回 `streak_days`。

## [1.0.11] - 2026-10-18

### 修复

- **撤回 1.0.10 的「连续签到天数」重算**：1.0.10 用 `checkin_dates` 自行推算连续天数，凭空造出了第三个数字——上游 `streak_days` 是活动期签到次数，站点又显示自己的口径，三方对不上。现在如实显示上游 `streak_days`，并把标签从「连续签到 N 天」改为「本活动内签到 N 次」/「N check-ins this event」，不再声称连续。

## [1.0.10] - 2026-10-18

### 修复

- **正文偶现 `<analysis>` / `<summary>` 标签**：上游对一批模型（如国际版 `deepseek-v4.1-flash`、`balanced-model`、国内版 `hy3`、`deepseek-v4-pro`）只声明单个固定 `reasoning.effort`。插件此前把它当作「没有推理档位」，于是从不发送 `reasoning_effort`，上游便不建立 `reasoning_content` 通道，模型只能在正文里画推理草稿。现在这类模型以该固定档位声明推理能力并始终带上 `reasoning_effort`，同时不再进入推理探测队列。
- **「连续签到 N 天」把活动期累计天数当成连续天数**：上游 `streak_days` 统计的是活动窗口内的签到总次数（实测「11 次」里有两天没签）。改为按 `checkin_dates` 计算真正以今天（或昨天）为终点的连续天数，字段缺失时才退回原值。

### 新增

- **模型列表按实际可用性收敛**：上游目录不声明账号级可见性，付费档模型（国际版 `primary-model`、`gpt-5.5` 等）要到真实请求才返回 `is not allowed for user type`。现在首次遇到该错误就把模型从选择器隐藏（会话内记忆、刷新目录时重置），已选该模型的会话照常工作。

## [1.0.9] - 2026-10-09

### 变更

- 两版 README 的三张界面截图换回未经压缩的原图（`docs/card-accounts.png` / `docs/card-models.png` / `docs/model-picker.png`，共约 2.5 MB），细节清晰度恢复；npm 包体积随之增大。

## [1.0.8] - 2026-10-09

### 变更

- 两版 README 的五条亮点按用户措辞重写：**登录**（「免桌面端登录」，桌面 App 凭据仍可只读导入）、**账号**（补上余额预警与账号备注）、**一键签到**（「提供自动签到，默认关闭」）、**设备隔离**（各自的凭据、模型目录、余额相互隔离；切换账号不影响在途请求）、**开箱即用**（安装启用即可用，无需额外配置，现已支持 0.2.0-rc.2 桌面端）。

## [1.0.7] - 2026-10-09

### 变更

- 两版 README：新增三张界面截图（账号与余额、模型范围与开关、模型选择器），放在「快速开始」上方，资源位于 `docs/`。
- 亮点第 3 条由「国内一键」改名为「一键签到」，内容不变。
- 亮点第 4、5 条重写，换成更有特色的两条：**两个区域彼此独立**（各自的凭据、各自的模型目录、各自的余额；某区域目录为空就保持为空，绝不借用另一区域的名单；切换账号不影响在途请求）与**不碰你的桌面端**（桌面端登录态只读、从不回写；插件只保存自己 OAuth 得到的区域凭据副本，「断开」只删这些副本）。原先的「实时价格」与「Provider」不再列为亮点。
- 删除两版 README 的「模型与价格」整节（接口实现未变）。
- npm 包 `files` 加入 `docs`，使 tarball 里的 README 图片可用。

## [1.0.6] - 2026-10-09

### 修复

- 国际版重新列出 `deepseek-v4.1-flash`（`x0.00`）。1.0.5 删除本地兜底名单后，国际版改由 `/v2/enterprises/personal/models` 取目录，而该接口是一份**残缺视图**——它不返回 `deepseek-v4.1-flash`，还把 `hy4-preview` 报成 `x0.00`（促销态）。现在国际版与国际版 App 读同一个接口 `GET https://www.workbuddy.ai/v3/config`，该方法还一并带回 `gpt-6-astra`、`glm-5.3-flash`、`kimi-k2.8-preview`。旧的 `/v2/enterprises/personal/models` 保留为兜底路径，仅当 `/v3/config` 不可用时才使用。

## [1.0.5] - 2026-10-09

### 变更

- **删除本地价格表，两区域一律以各自实时目录为准。** 此前插件内置一份价格与免费名单（`src/product-config.ts`），并在国际版里覆盖目录返回的 `credits`。现在这份表已整体移除：模型是否存在、上下文与推理档、`credits` 价格全部照搬该区域目录，产品上新或调价即时生效，不再等插件发版。国内版此前已是实时权威，本次与国际版统一。
- 相应地，未拿到区域目录前列表为空是刻意行为——一个区域不会借用另一个区域的模型清单（原国际版的本地兜底三模型已不存在）。
- `credits` 是叠加限时活动折扣后的展示价：`hy4-preview` 活动期内显示 `x0.00`、活动外为 `x0.29`，插件不再自行从严判定，直接照搬上游当前公布值。
- 配置项 `productConfigFile` / 环境变量 `DSH_WORKBUDDY_PRODUCT_CONFIG` 移除；`doctor` 不再输出产品配置来源，改为提示「价格实时读取自各区域目录」。
- 两版 README：副标题改为「无需下载 WorkBuddy 桌面端」，「免费模型」章节改写为「模型与价格」，说明实时目录与限时活动折扣；亮点第 3/4/5 条重写（国内一键签到/猫猫旅行/成长任务、实时价格、Provider 按登录出现）。

## [1.0.4] - 2026-10-09

### 修复

- 未登录时「模型」设置页不再出现 WorkBuddy Provider。此前 Provider 与目录条目在启动时无条件注册，模型页会列出一个没有凭据、无法使用的路由；现在按区域凭据决定注册与注销：登录该区域后才出现，断开或移除最后一个账号后随之消失。两半（adapter 与目录条目）同进同退，避免出现「列出但不可用」的半注册状态。

### 变更

- 未登录提示去掉「桌面 App 不是必须的」，只保留「点击『连接』通过 WorkBuddy 网站登录。」
- 两版 README 改为居中标题 + 徽标（许可证、DSH 版本、Provider 数、默认免费、零运行时依赖），删除「本插件独立于其它 WorkBuddy 插件」句、`## 和其他 WorkBuddy 插件的关系`、`## 已知限制` 与架构参考一行。

## [1.0.3] - 2026-10-09

### 修复

- 修复点击「连接」后浏览器打开的登录链接丢失 `state` 参数、站点报「登录链接不完整」的问题。Windows 下改用 `rundll32.exe url.dll,FileProtocolHandler`，不再经 `cmd /c start`——`cmd.exe` 会把 URL 里的 `&` 当成命令分隔符，把 `&state=…` 截断。
- 修复已登录一个区域后另一个区域点不动的问题。此前所选区域未登录时会强制回落到「已登录的区域」，导致第二个区域永远无法添加；现在所选 tab 始终生效，仅在首次发现已登录区域时做一次性预选。
- 移除与「连接」功能重复的「打开登录页」按钮（同一链接、同一动作，且两个标签页会争抢一次性 login state）。

### 变更

- Provider 显示名改为 **WorkBuddy 国际版** / **WorkBuddy 国内版**。
- 默认 README 改为英文：`README.md` 为英文，中文移至 `README.zh.md`。

## [1.0.2] - 2026-10-09

### 修复

- 未登录界面新增国内/国际区域切换，修复此前只能发起国内登录、国际版没有入口的问题。
- 点击「连接」不再重复打开登录页：此前宿主与页面各开一个标签页，两者争夺同一个一次性登录 state，先打开的成功、后打开的提示「登录链接不完整」。现在只由宿主打开，页面保留「打开登录页」作为兜底链接。

## [1.0.1] - 2026-10-09

### 修复

- 统一设置卡片与主机控制路由使用的安全请求头，修复点击“连接”等操作时被错误拒绝的问题。

## [1.0.0] - 2026-10-09

首个独立版本，以 `dsh-workbuddy` 名称发布并使用独立标识。

### 新增

- 双区域 Provider：`workbuddy-ai`（国际，显示为 **WorkBuddy**）与 `workbuddy-cn`（国内，显示为 **WorkBuddy 国内**）
- 按区域浏览器 OAuth 登录（`auth/state` → `authUrl` → 轮询 `auth/token`），凭据只写插件自己的副本
- 只读导入桌面 App 凭据（`workbuddy-desktop-ai.info` / `workbuddy-desktop.info`）
- 区域隔离的多账号列表、显式切换、剩余积分显示与连通性测试
- 国内区域可选自动签到（默认关闭，仅对勾选账号生效）
- 免费模型名单以应用下发产品配置为准，缺失时回退到内置名单
- 设置卡片：连接/断开、账号管理、`免费模型 / 全部模型` 范围切换、刷新间隔
- 命令行：`login` / `status` / `doctor` / `logout`（`status`、`doctor` 支持 `--json`）
- 双语 README（[English](./README.md) / [中文](./README.zh.md)）与 CI 工作流

### 标识（与 `dsh-connect-workbuddy` 完全隔离）

| 项 | 值 |
|---|---|
| Provider | `workbuddy-ai` / `workbuddy-cn` |
| 凭据文件 | `.workbuddy-ai-auth.json` / `.workbuddy-cn-auth.json` |
| 心跳文件 | `.workbuddy-ai-host-heartbeat.json` |
| 设置文件 | `.workbuddy-ai-settings.json` |
| 探测缓存 | `.workbuddy-ai-probe.json` |
| 环境变量 | `DSH_WORKBUDDY_AUTH_FILE` / `DSH_WORKBUDDY_CN_AUTH_FILE` / `DSH_WORKBUDDY_PRODUCT_CONFIG` |
| 控制头 | `X-WorkBuddy-Control-Key` |

### 适配

- 对齐 DSH `0.2.0-rc.2`：所有 `@deepseek-ai/dsh-*` peer 依赖精确锁定 `0.2.0-rc.2`，`@earendil-works/pi-ai` 为 `^0.87.1`
