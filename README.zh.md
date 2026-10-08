<h1 align="center">DSH WorkBuddy</h1>

<p align="center">
  <em>把 WorkBuddy 国内版与国际版模型接进 DeepSeek Harness —— 浏览器 OAuth，默认只列免费模型。</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-65a30d?style=flat" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/dsh-0.2.0--rc.2-4f46e5?style=flat" alt="DSH 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/providers-two-0ea5e9?style=flat" alt="two providers">
  <img src="https://img.shields.io/badge/default-free_models-brightgreen?style=flat" alt="free models by default">
  <img src="https://img.shields.io/badge/runtime_dependencies-zero-brightgreen?style=flat" alt="zero runtime dependencies">
</p>

<p align="center">
  <a href="./README.md">English</a> · <b>中文</b>
</p>

- **登录**：按区域使用浏览器 OAuth，或只读导入桌面 App 的凭据
- **账号**：区域隔离的多账号列表、显式切换、余额显示；插件副本与桌面 auth 文件分离
- **国内版**：可选自动签到（默认关闭，仅勾选账号）
- **默认模型**：国际版按产品配置列出免费模型；国内版按该区域实时目录列出免费模型
- **Provider**：`workbuddy-ai`（国际）与 `workbuddy-cn`（国内）—— 只有登录过该区域，模型列表里才会出现对应 Provider

## 快速开始

1. Node 22+，已安装 DSH。
2. 安装插件并启动：

```sh
dsh plugin --profile web add github:Faide-cyber/dsh-workbuddy
dsh web
```

3. 打开 **设置 → 插件 → DSH WorkBuddy**，点 **连接**，在弹出的 WorkBuddy 网站里登录。
4. 模型选择器里选 **WorkBuddy / Deepseek-V4.1-Flash**。

也可以在终端登录：

```sh
dsh plugin --profile web exec dsh-workbuddy login
```

安装、更新或登录后必须**重启 `dsh web`**。刷新浏览器不够，Node 模块常驻内存。

默认模型可以写在 `~/.dsh/settings.yaml`：

```yaml
agent-default-model:
  provider: workbuddy-ai
  model: deepseek-v4.1-flash
  reasoningEffort: max
```

## 登录怎么工作

每个区域独立走官方 CLI 登录接口：

1. `POST /v2/plugin/auth/state?platform=CLI&nonce=`（国际 `www.workbuddy.ai`，国内 `copilot.tencent.com`）
2. 打开返回的 `authUrl`
3. 轮询 `GET /v2/plugin/auth/token?state=`（还在等时上游返回 `11217`）
4. Token 写入区域专属的插件副本：国际 `$DSH_HOME/.workbuddy-ai-auth.json`，国内 `$DSH_HOME/.workbuddy-cn-auth.json`

桌面 App 的 `workbuddy-desktop-ai.info`（国际）与 `workbuddy-desktop.info`（国内）只读、不写；插件只保存自己通过 OAuth 获得的区域凭据副本。

设置卡片会显示所有已导入账号。切换只影响后续请求，在途请求继续使用原账号；批量余额/签到不会改变当前选择。

**断开** / `logout` 只删对应区域插件自己的凭据，不影响桌面 App。

## 免费模型

国际版目录接口（`/v2/enterprises/personal/models`）会漏掉部分模型，而且目录里的 `credits` 不一定准。插件以应用下发的产品配置为准：

`~/.workbuddy-ai/cache/acc-product-config-v3.json`

读不到这份缓存时，用插件内置的免费名单。当前免费（`x0.00`）模型：

| 模型 | 上下文 | 图像 | 推理档 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1M | 是 | 默认 high；实测接受 low / medium / high / xhigh / max |
| `hy4-preview-f` | 1M | 是 | 声明 high |
| `hy3` | 192k | 是 | 声明 low / high |

目录不返回 `deepseek-v4.1-flash` 和 `hy4-preview-f`，插件会按产品配置补进列表。

`hy4-preview`（不带 `-f`）在目录里可能显示 `x0.00`，产品配置里是 `x0.29`。按产品配置从严，避免误当免费而扣费。

设置卡片可以把范围改成 **全部模型**。付费模型名称后会显示倍率，选用会真实扣积分。

## 配置

设置 → 插件 → **DSH WorkBuddy**：

- **连接 / 断开**：按区域浏览器登录，或删掉该区域插件凭据
- 国内/国际账号列表、显式切换、剩余积分和连通性测试
- 国内勾选账号、自动签到（默认关闭）
- 当前账号默认每 15 分钟、其他账号默认每 60 分钟只读刷新，可自定义
- **仅免费模型**（默认）/ **全部模型**

也可以在 profile 的 `cordis.patch.yml` 里写：

```yaml
- id: llm-workbuddy
  config:
    modelScope: free          # 国际版：或 all
    cnModelScope: free        # 国内版：或 all
    probeConsent: false       # 真实模型探测默认关闭
    autoCheckin: false        # 国内自动签到默认关闭
    refreshActiveMinutes: 15
    refreshInactiveMinutes: 60
    # 局域网打开 DSH Web 时写访问用的 Host（不要写进 LOOPBACK）
    # allowedHosts: ["192.168.1.10"]
    # authFile / cnAuthFile: 一般不用；仅在桌面凭据不在默认位置时写绝对路径
```

环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_WORKBUDDY_AUTH_FILE` | 覆盖国际桌面凭据路径（OAuth 凭据仍写插件自己的文件） |
| `DSH_WORKBUDDY_CN_AUTH_FILE` | 覆盖国内桌面凭据路径 |
| `DSH_WORKBUDDY_PRODUCT_CONFIG` | 覆盖产品配置 JSON 路径 |

## 命令行

```sh
dsh plugin --profile web exec dsh-workbuddy login
dsh plugin --profile web exec dsh-workbuddy status
dsh plugin --profile web exec dsh-workbuddy doctor
dsh plugin --profile web exec dsh-workbuddy logout
```

`status` / `doctor` 可加 `--json`。`logout` 只删 `$DSH_HOME/.workbuddy-ai-auth.json`。

## 故障排查

| 现象 | 处理 |
|---|---|
| 设置里没有这张卡片 / 模型列表没有 WorkBuddy | 重启 `dsh web`，不要只刷新浏览器 |
| 点连接后 `dsh web` 进程退出 | 无头 Linux 没有 `xdg-open` 时请更新到含 spawn `error` 处理的版本；用卡片上的登录链接 |
| 局域网 IP 打开卡片 403 `request-not-trusted` | 在 `allowedHosts` 里写该 IP/主机名，不要把它加进回环名单 |
| 登录成功但没有免费模型 | 看 `doctor` 是否读到产品配置；没有缓存时用内置三模型名单 |
| `doctor` 显示 signed-out | 先 `login`，或确认国际版桌面 App 已登录 |
| 想用付费模型 | 设置卡片把范围改成「全部模型」，注意会扣积分 |

```sh
dsh plugin --profile web exec dsh-workbuddy doctor
```

## 免责声明

仅供个人学习和研究，只驱动你自己的 WorkBuddy 账号在本机调用。请遵守 WorkBuddy 服务条款。本项目与腾讯、WorkBuddy、DeepSeek 均无关联。

## 许可证

[MIT](./LICENSE)
