# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

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
