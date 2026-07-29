# 变更报告 · agent-connect 重构（2026-07-29）

> 本轮把项目从 `cc-connect-router` 全面重构为 **agent-connect**，并按反馈重做了信使职责、接管/退出流程、消息归属、Web 控制台。供审阅。

版本：`@tengxiaohtx/connect@1.2.7` → **`@tengxiaohtx/agent-connect@1.3.0`**（新包名）。测试 42 项全绿。

---

## 1. 全面改名 → agent-connect
- npm 包：`@tengxiaohtx/connect` → **`@tengxiaohtx/agent-connect`**（旧包保留不动）。
- CLI 命令：`cc-router` → **`agent-connect`**（并加短别名 **`ac`**）。
- 配置目录：`~/.cc-connect-router` → **`~/.agent-connect`**，并**自动迁移**旧目录（首次运行复制配置/历史，并把旧 acp `cmd = "cc-router"` 改为 `agent-connect`）。`AGENT_CONNECT_CONFIG_DIR` 为新环境变量（兼容旧 `CC_ROUTER_CONFIG_DIR`）。
- skill：`skill/qoder-router` → **`skill/agent-router`**，SKILL.md 标注为「历史参考」。
- 代码/模板/Makefile/日志前缀 `[agent-connect]`、README（双语）、官网全部改名；外部依赖 `cc-connect` 名称保持不变。
- 关键文件：`package.json`、`bin/cli.js`、`src/lib/paths.js`、`src/lib/config-store.js`(migrateLegacyDir)、`templates/config.default.toml`。

## 2. 信使重构为「manager 路由器」（不再是主 Loop）
之前信使像个持久累积上下文的多步 agent；现在收敛为**纯路由/意图识别**：
- **当前会话指针（cwd 机制）**：新增 `src/lib/messenger/current-store.js`，按会话记住「当前正在沟通的 worker」，类似 shell 的 cwd。
- **意图/工具**（`src/lib/messenger/agent.js`）：`list_sessions`（列出）、`switch_current`（切换当前）、`read_reply`（读回复，默认当前）、`propose_forward`（转发消息给当前/指定会话）、`propose_takeover`（接管）、`propose_exit`（退出关闭）、`propose_run`（新建）、`snapshot_session`（截图）。变更类一律走「提议→确认」。
- **真正任务交给 worker**：信使只把消息路由过去，不代替 worker 思考/产出；系统提示明确禁止长篇作答。
- **瘦身**：对话只保留 8 条短窗口（不再无限累积），`max_steps` 默认 8 → **4**。
- **cwd 门禁**：执行转发/接管/退出前校验当前会话有效；**失效则清空指针并明确提示**「会话已失效，请重新 switch_current」。

## 3. 接管 / 退出流程
- **接管反馈**：`takeover` 现在返回 `ready`（tmux 是否就绪），回复区分「已就绪可直接发指令」/「已恢复，请稍候确认」。
- **退出关闭**：新增 `ControlPlane.exit()` 与 `propose_exit`——不只结束 claude 进程，**还关闭其 tmux 窗口**（`tmux.killSession`）。Web 详情页也有「退出」按钮（`POST /api/sessions/:id/exit`）。

## 4. 消息来源归属（from xxx agent）
- 主动通知与快照均带来源：`✅ 任务完成 · 来自 <名称>（<项目> · <agent>）[短ID]`。
- `list_sessions`/`read_reply` 返回项目、Agent、状态、最近输入/回复，便于信使转达时标注来源。

## 5. Web 控制台三视图重构（`web/*` + `src/server/routes.js`）
- **看板视图**：所有会话卡片，**运行中/待输入置顶**（pin，醒目描边），显示状态/项目/Agent/最近输入 + 详情/接管/退出。
- **单 Agent 详情视图**：该会话消息流（SSE 实时）、状态头、发送/接管/退出。
- **信使视图**：与信使对话、待确认卡片、**📍当前会话**徽标（`GET /api/agent/current`）。
- **延迟优化**：控制面轮询 2.5s → **1.2s**，SSE 即时推送状态/消息事件。
- 新增端点：`/api/sessions/:id/exit`、`/api/agent/current`。

## 6. 其它反馈
- **令牌可选（开放模式）**：`web.token` 留空即 127.0.0.1 开放访问，不强制令牌（本轮已在配置中默认清空）。
- **主动通知**：仅在 `waiting`(需确认) 与 `busy→idle`(任务完成) 两种转变时推送，其余不打扰。
- **「未配置语音转录…」** 这条消息：**来自 cc-connect**（其钉钉语音/STT 功能），不在本项目代码内；如需去除请在 cc-connect 侧配置。

---

## 待你关注的取舍 / 已知小项
- **Web 消息气泡暂以纯文本显示 Markdown**（钉钉端正常渲染）；如需网页也渲染表格/加粗，可后续加一个轻量 Markdown 渲染。
- **仓库名与 Pages 未改**：GitHub 仍是 `xinyuehtx/connect`、站点 `xinyuehtx.github.io/connect`（只改了产品名 agent-connect；如需连仓库一起改名请告知）。
- 迁移是**复制**而非移动：旧 `~/.cc-connect-router` 仍保留，确认无误后可自行删除。

## 验证
- `node --test` → 42 项全绿（新增 current-store / manager 工具 switch+forward+stale 门禁 / exit describe 等）。
- `agent-connect --help`、`agent-connect serve`（开放模式 + 主动通知）、Web 三视图（Playwright 实测无报错、看板置顶正确）。
