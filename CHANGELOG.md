# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-02

首个独立版本。插件基于 `dsh-workbuddyai-connect` 二次开发，重命名为 `dsh-workbuddy` 并改为独立标识。

### 新增

- 双区域 Provider：`workbuddy-ai`（国际，显示为 **WorkBuddy**）与 `workbuddy-cn`（国内，显示为 **WorkBuddy 国内**）
- 按区域浏览器 OAuth 登录（`auth/state` → `authUrl` → 轮询 `auth/token`），凭据只写插件自己的副本
- 只读导入桌面 App 凭据（`workbuddy-desktop-ai.info` / `workbuddy-desktop.info`）
- 区域隔离的多账号列表、显式切换、剩余积分显示与连通性测试
- 国内区域可选自动签到（默认关闭，仅对勾选账号生效）
- 免费模型名单以应用下发产品配置为准，缺失时回退到内置名单
- 设置卡片：连接/断开、账号管理、`免费模型 / 全部模型` 范围切换、刷新间隔
- 命令行：`login` / `status` / `doctor` / `logout`（`status`、`doctor` 支持 `--json`）
- 双语 README（[中文](./README.md) / [English](./README.en.md)）与 CI 工作流

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
