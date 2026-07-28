# 🤖 cc-connect-router

**English** | [简体中文](#-cc-connect-router-简体中文)

> Monitor and control **multiple** coding-agent sessions (Claude Code / qodercli) running on your machine — straight from DingTalk on your phone. **Read/write split · one-to-many · messenger agent for intent dispatch · human-confirmed writes.**

📖 **Intro site:** https://xinyuehtx.github.io/connect/

Send one message in DingTalk to see the status of every agent session on your machine, pull results read-only, and inject follow-up instructions into a specific task. A lightweight **messenger agent** (built on the Vercel AI SDK, any OpenAI-compatible model) reads your intent, decides read vs. write, and targets the right session — every mutation of a worker session waits for **your confirmation**. Messages ride [cc-connect](https://github.com/chenhg5/cc-connect) for DingTalk ⇄ local transport; a companion `cc-router serve` provides a web console.

---

## 🏗️ Architecture

Three layers, one job each:

- **Messenger Agent (dispatch, not a re-router)** — built on the AI SDK, decoupled from Claude Code. It only decides *read vs. write / which session / which verb* and calls the control plane via tools; **the task itself still runs in the worker agent.** The messenger keeps its own conversation context (shared by web + DingTalk) and **never enters a worker's context** — that's what makes read/write separation work for natural-language input.
- **Read / write planes** — reads (list/read) only touch Claude Code's on-disk session registry and transcripts: zero side effects, never the worker process. Writes (send/takeover/run) go through tmux, gated by a **propose → confirm → execute** state machine.
- **Transport** — still cc-connect. Because cc-connect only accepts custom programs through its `acp` agent type, the messenger plugs in as a thin **ACP bridge** (`cc-router acp`) that forwards to the `cc-router serve` daemon.

```
DingTalk ─Stream─► cc-connect ─exec─► cc-router acp (bridge) ─HTTP─► cc-router serve (daemon)
                                                                        │
   ┌─────────────────────────────────────────────────────────────────┐ │
   │  Web console + SSE + config       gate (allowlist / prefix / confirm) │◄┘
   │        │  shared conductor / pending / messenger context           │
   │  AgentConductor  ( propose → confirm → execute )                   │
   │  Messenger Agent ( AI SDK, OpenAI-compatible )                     │
   │        │  read tools  /  propose tools                             │
   │  ControlPlane: listSessions·getMessages · sendMessage·takeover·run │
   └──┬──────────────────┬──────────────────┬─────────────────────────┘
   registry.js       transcript.js         tmux.js
```

> **Evolution:** earlier versions argued for “no routing agent” (forward chat straight to the worker, let it interpret). But controlling other sessions from chat that way **pollutes the worker's context** and lacks a safety gate. The current design uses a separate messenger for **addressing/dispatch** (it never re-interprets or re-executes the task) plus plane separation plus human confirmation — keeping the “just say it” UX while staying safe.

---

## 📦 Install

```bash
npm install -g @tengxiaohtx/connect
```

## 🚀 Quick start

```bash
# 1. Create default config at ~/.cc-connect-router/config.toml
cc-router init

# 2. Start the web console daemon (prints an access token on first run)
cc-router serve
#   Open http://127.0.0.1:8787 → log in with the printed token
#   Settings → LLM Provider: base_url / api_key / model (any OpenAI-compatible endpoint)
#   Settings → IM connector: DingTalk client_id / client_secret + gate (prefix / allowlist)

# 3. In another terminal, start cc-connect (DingTalk ⇄ local)
cc-router start
```

Everything is configurable via CLI too (equivalent to the settings page):

```bash
cc-router config set messenger.base_url "https://your-gateway/v1"
cc-router config set messenger.api_key  "sk-..."
cc-router config set messenger.model    "gpt-4o-mini"
cc-router config set projects.0.platforms.0.options.client_id     "your-dingtalk-client-id"
cc-router config set projects.0.platforms.0.options.client_secret "your-dingtalk-client-secret"
```

DingTalk credentials come from an **internal app / bot** on the [DingTalk Open Platform](https://open.dingtalk.com) with **Stream mode** enabled. The default config already wires the messenger as cc-connect's `acp` agent (`cmd = "cc-router"`, `args = ["acp"]`) — no manual edit needed.

> In DingTalk, messages need the `/ai` prefix to reach the messenger (e.g. `/ai list sessions`). Reply `确认`/`取消` (yes/no) to a pending action. The prefix is configurable, or leave it empty to process every message.

---

## 🧠 Messenger agent (dispatch + safety gate)

The messenger is **not** a re-router — it never re-interprets or executes your task. It does three things: decide **read vs. write**, locate **which session**, pick **which verb**, then call control-plane tools. The task still runs in the worker agent.

- **Read tools** (`list_sessions` / `read_session` / `get_status`) — always available, read on-disk files only, zero pollution.
- **Propose tools** (`propose_send` / `propose_takeover` / `propose_run`) — **stage only**, never execute. The messenger returns a pending list; you reply “确认” to run it through tmux, or “取消”/timeout (5 min default) to drop it.

The LLM uses the Vercel AI SDK. First-class support is **OpenAI-compatible** (`base_url` + `api_key` + `model`), covering self-hosted gateways, proxies, and most compatible endpoints — fully decoupled from Claude Code. Switch it in the web settings page or the config file.

---

## 🌐 Any IM (not just DingTalk)

Because cc-connect bridges **many platforms** (DingTalk, Feishu, Telegram, Slack, Discord, WeChat Work, QQ, LINE…), and our messenger plugs in as its platform-agnostic `acp` agent, cc-connect-router works with **any of them**. The ACP bridge reads the platform from cc-connect's `CC_SESSION_KEY` and applies the matching gate.

To add an IM:
1. Configure that platform in the cc-connect side of `~/.cc-connect-router/config.toml` (its own `[[projects.platforms]]` + credentials — see cc-connect docs).
2. (Optional) Add a gate for it: `[im.platforms.<name>]` with `enabled` / `command_prefix` / `allowed_sender_ids` / confirm words. If omitted, defaults apply (enabled, empty allowlist = allow all).

The messenger, read/write planes, and confirm gate are identical across platforms — only the transport differs.

## 📇 Access control & clear denials

When a sender isn't in `allowed_sender_ids`, the bot **replies with an explicit “not authorized” message** (instead of silence), telling you which ID to add. Empty allowlist = allow all. The sender ID is whatever the platform reports (e.g. DingTalk `senderStaffId`).

## 🖌️ Streaming AI card (DingTalk, optional)

For a typewriter-style streaming reply, create an **AI card template** on the DingTalk Open Platform and set its id — `card_template_id` (+ optional `card_template_key`, `card_throttle_ms`) under the DingTalk platform options, or via the web **Settings → IM connector → Streaming AI card**. If unset, replies fall back to normal messages (fully functional, just not streamed).

## 📸 Rich replies & screenshots

Replies are sent as **Markdown** (tables, bold, code blocks, emoji status), so the session list shows project / agent / status / latest input at a glance. The messenger can also send **images**: `snapshot_session` renders a session's terminal pane to a PNG (via headless Chrome, auto-detected; set `messenger.chrome_path` to override) and posts it to the chat; `send_image` delivers any local image file. Both go out via `cc-connect send --image`. If no renderer is found, snapshots fall back to a Markdown code block.

---

## 📖 CLI reference

| Command | Description |
|---------|-------------|
| `cc-router init [--force]` | Create config dir + default config (`--force` overwrites) |
| `cc-router serve [-H host] [-p port]` | Start web console + messenger daemon (planes + gate; prints token on first run) |
| `cc-router acp` | ACP bridge for cc-connect (spawned by cc-connect; don't run by hand) |
| `cc-router start` | Start cc-connect (DingTalk ⇄ local transport) |
| `cc-router config get/set/remove/list` | Read/write config (dot-path keys, sensitive fields masked) |
| `cc-router project add/remove/list` | Manage cc-connect projects |
| `cc-router agent list [-a] [--json]` | List running agent sessions |
| `cc-router agent read <id> [--full]` | Read status + latest reply (read-only, no pollution) |
| `cc-router agent send <id> "<text>"` | Inject an instruction into a tmux session |
| `cc-router agent takeover <id> [--force]` | Adopt a non-tmux session (kill + resume in tmux) |
| `cc-router agent run ["<prompt>"] [-w dir]` | Spawn a new remote-controllable session in tmux |

---

## 📋 Prerequisites

| Dependency | Purpose | Link |
|------------|---------|------|
| **Node.js ≥ 18** | Runs the `cc-router` CLI and `serve` daemon | https://nodejs.org |
| **cc-connect** | Gateway; forwards DingTalk to the messenger via `acp` | https://github.com/chenhg5/cc-connect |
| **OpenAI-compatible LLM** | The messenger's model (`base_url` + `api_key` + `model`) | self-hosted gateway / proxy |
| **tmux** | Needed for the write plane; reads don't need it | `brew install tmux` |
| **Claude Code / qodercli** | The worker agents being controlled (at least one) | — |
| **DingTalk developer account** | Create a bot, get `client_id`/`client_secret`, enable Stream mode | https://open.dingtalk.com |

## 🛠️ Development

```bash
npm test            # node --test
node bin/cli.js --help
```

## 📂 Layout

```
src/lib/control-plane.js   read/write planes (reuses registry/transcript/tmux)
src/lib/messenger/         agent (AI SDK) / conductor / provider / pending / history
src/lib/im/                gate (routing) / session-key (CC_SESSION_KEY parsing)
src/server/                Fastify: http / routes / sse / auth  (web + /im/handle)
web/                       console front-end
docs/                      GitHub Pages intro site
```

## License

MIT

---
---

# 🤖 cc-connect-router (简体中文)

[English](#-cc-connect-router) | **简体中文**

> 从手机（钉钉）监控并控制本机上运行的**多个** coding agent 会话（Claude Code / qodercli）：**读写分离 · 一对多 · 信使 Agent 做意图分派 · 写操作人工确认。**

📖 **使用介绍网站：** https://xinyuehtx.github.io/connect/

在钉钉里发一句话，就能查看本机所有 agent 任务的状态、只读拉取结果、并把后续指令注入到指定的那个任务。一个轻量的**信使 Agent**（Vercel AI SDK，可配置任意 OpenAI 兼容模型）理解你的意图、决定读还是写、定位到哪个会话；任何变更 worker 会话的操作都要你**确认**后才执行。基于 [cc-connect](https://github.com/chenhg5/cc-connect) 做钉钉 ↔ 本地的消息传输，配套 `cc-router serve` 提供 Web 控制台。

---

## 🏗️ 架构

三层，各司其职：

- **信使 Agent（寻址分派，非重路由）**：用 AI SDK 实现、与 Claude Code 解耦。它只判断「读还是写 / 哪个会话 / 哪个动词」，用工具调用控制面；**任务本身仍由 worker agent 执行**。信使自己一个独立会话上下文（Web 与钉钉共享），**永不进入 worker 会话的上下文**——这正是读写分离在自然语言输入下的守门人。
- **读写双平面**：读（list/read）只读 Claude Code 落盘的 sessions 注册表与 transcript，零副作用、不碰 worker 进程；写（send/takeover/run）经 tmux，且必须经**「提议 → 人工确认 → 执行」**安全闸。
- **通信**：继续用 cc-connect。因 cc-connect 只能通过 `acp` agent 类型接入自定义程序，信使以一个 **ACP 薄桥**（`cc-router acp`）作为它的 agent，把消息转发给 `cc-router serve` 守护。

```
钉钉 ─Stream─► cc-connect ─exec─► cc-router acp（薄桥）─HTTP─► cc-router serve（守护）
                                                                  │
   ┌──────────────────────────────────────────────────────────┐ │
   │  Web 控制台 + SSE + 配置页        闸门(白名单/前缀/确认词)   │◄┘
   │        │  共享 conductor / pending / 信使会话上下文         │
   │  AgentConductor（提议→确认→执行 安全闸）                    │
   │  Messenger Agent（AI SDK，OpenAI-compatible）              │
   │        │ 只读工具 / 提议工具                                │
   │  ControlPlane: listSessions·getMessages·sendMessage·takeover·run │
   └──┬───────────────┬──────────────┬────────────────────────┘
   registry.js     transcript.js    tmux.js
```

> **演进说明**：早期版本主张「无路由 Agent」（普通消息直连 worker，由其自行理解）。但那样从聊天做跨会话控制会**污染 worker 上下文**，且缺少安全闸。现改为独立信使做**寻址分派**（不重新理解/执行任务）+ 读写分离 + 人工确认，兼顾「发一句话就行」的体验与安全。

---

## 📦 安装

```bash
npm install -g @tengxiaohtx/connect
```

## 🚀 快速开始

```bash
# 1. 初始化配置（生成 ~/.cc-connect-router/config.toml）
cc-router init

# 2. 启动 Web 控制台守护（首次会打印访问令牌）
cc-router serve
#   浏览器打开 http://127.0.0.1:8787 → 用打印出的令牌登录
#   设置 → LLM Provider：填 base_url / api_key / model（任意 OpenAI 兼容端点）
#   设置 → IM 连接器：填钉钉 client_id / client_secret + 闸门（前缀 / 白名单）

# 3. 另开一个终端，拉起 cc-connect（钉钉 ↔ 本地）
cc-router start
```

也可以全用 CLI 配置（等价于 Web 配置页）：

```bash
cc-router config set messenger.base_url "https://your-gateway/v1"
cc-router config set messenger.api_key  "sk-..."
cc-router config set messenger.model    "gpt-4o-mini"
cc-router config set projects.0.platforms.0.options.client_id     "your-dingtalk-client-id"
cc-router config set projects.0.platforms.0.options.client_secret "your-dingtalk-client-secret"
```

钉钉凭证 `client_id` / `client_secret` 需在[钉钉开放平台](https://open.dingtalk.com)创建**企业内部应用**（或机器人应用），并启用 **Stream 模式**。默认配置已把信使接成 cc-connect 的 `acp` agent（`cmd = "cc-router"`, `args = ["acp"]`），无需手改。

> 钉钉里默认要带前缀 `/ai` 才会路由给信使（如 `/ai 列出会话`）；待确认时直接回「确认 / 取消」。前缀可改或留空（留空 = 处理所有消息）。

---

## 🧠 信使 Agent（寻址分派 + 安全闸）

信使**不是**重路由——它不重新理解或执行你的任务，只做三件事：判断**读还是写**、定位**哪个会话**、选择**哪个动词**，然后调用控制面工具。任务本身仍交给 worker agent。

- **读工具**（`list_sessions` / `read_session` / `get_status`）：随时可用，只读落盘文件，零污染。
- **提议工具**（`propose_send` / `propose_takeover` / `propose_run`）：**只暂存**，不执行。信使会回一张待确认清单，你回「确认」才真正经 tmux 执行，「取消」或超时（默认 5 分钟）则作废。

LLM 用 Vercel AI SDK，首批支持 **OpenAI-compatible**（`base_url` + `api_key` + `model`），覆盖自建网关/代理/多数兼容端点，与 Claude Code 完全解耦。可在 Web 配置页或 config 文件切换。

---

## 🌐 支持任意 IM（不止钉钉）

cc-connect 本身桥接**多种平台**（钉钉、飞书、Telegram、Slack、Discord、企业微信、QQ、LINE…），而我们的信使以**平台无关**的 `acp` agent 接入，所以 cc-connect-router 对**任意平台**都适用。ACP 薄桥从 `CC_SESSION_KEY` 解析出平台名，套用对应闸门。

接入一个新 IM：
1. 在 `~/.cc-connect-router/config.toml` 的 cc-connect 部分配好该平台（它自己的 `[[projects.platforms]]` + 凭证，见 cc-connect 文档）。
2. （可选）给它加一段闸门：`[im.platforms.<平台名>]`，含 `enabled` / `command_prefix` / `allowed_sender_ids` / 确认词。不配则用默认（启用、空白名单=允许所有）。

信使、读写平面、确认闸在所有平台完全一致，只有传输层不同。

## 📇 访问控制与明确拒绝

当发送者不在 `allowed_sender_ids` 时，机器人会**明确回复「无权限」**（而不是静默），并提示该把哪个 ID 加进名单。名单留空 = 允许所有。发送者 ID 取平台上报值（如钉钉 `senderStaffId`）。

## 🖌️ 流式 AI 卡片（钉钉，可选）

想要打字机式流式回复：在钉钉开放平台创建 **AI 卡片模板**，把它的 id 填到钉钉平台选项的 `card_template_id`（另可选 `card_template_key`、`card_throttle_ms`），或在 Web **设置 → IM 连接器 → 流式 AI 卡片** 里填。不填则回退为普通消息（功能不受影响，只是非流式）。

## 📸 富文本回复与截图

回复以 **Markdown** 发送（表格、加粗、代码块、emoji 状态），会话列表因此能一眼看到 项目 / Agent / 状态 / 最近输入。信使还能发**图片**：`snapshot_session` 把某会话的终端画面渲染成 PNG（用自动探测的无头 Chrome；可用 `messenger.chrome_path` 指定）并发到聊天里；`send_image` 发送本机任意图片文件。二者都经 `cc-connect send --image` 投递。若本机没有渲染器，截图会退回为 Markdown 代码块。

---

## 📖 CLI 命令参考

| 命令 | 说明 |
|------|------|
| `cc-router init [--force]` | 初始化配置目录与默认配置（`--force` 覆盖） |
| `cc-router serve [-H host] [-p port]` | 启动 Web 控制台 + 信使守护（读写平面 + 安全闸；首启打印令牌） |
| `cc-router acp` | ACP 薄桥，供 cc-connect 拉起（勿手动运行） |
| `cc-router start` | 启动 cc-connect（钉钉 ↔ 本地 消息传输） |
| `cc-router config get/set/remove/list` | 读写配置（点号路径，敏感字段遮掩） |
| `cc-router project add/remove/list` | 管理 cc-connect 项目 |
| `cc-router agent list [-a] [--json]` | 列出运行中的 agent 会话 |
| `cc-router agent read <id> [--full]` | 只读查看状态与最新回复（不污染上下文） |
| `cc-router agent send <id> "<text>"` | 向 tmux 会话注入指令 |
| `cc-router agent takeover <id> [--force]` | 接管非 tmux 会话（kill + resume 进 tmux） |
| `cc-router agent run ["<prompt>"] [-w dir]` | 在 tmux 中新建可远控会话 |

---

## 📋 前置条件

| 依赖 | 说明 | 链接 |
|------|------|------|
| **Node.js ≥ 18** | 运行 `cc-router` CLI 与 `serve` 守护 | https://nodejs.org |
| **cc-connect** | 消息网关，把钉钉消息经 `acp` 转发到信使 | https://github.com/chenhg5/cc-connect |
| **OpenAI 兼容 LLM 端点** | 信使 Agent 的模型（`base_url` + `api_key` + `model`） | 自建网关 / 代理 |
| **tmux** | 写平面所需；读平面不需要 | `brew install tmux` |
| **Claude Code / qodercli** | 被控制的 worker agent（至少装一个） | — |
| **钉钉开发者账号** | 创建机器人，获取 `client_id`/`client_secret`，启用 Stream 模式 | https://open.dingtalk.com |

## 🛠️ 开发

```bash
npm test            # node --test
node bin/cli.js --help
```

## 📂 目录结构

```
src/lib/control-plane.js   读写平面（复用 registry/transcript/tmux）
src/lib/messenger/         信使栈：agent(AI SDK)/conductor/provider/pending/history
src/lib/im/                gate（闸门路由）/ session-key（CC_SESSION_KEY 解析）
src/server/                Fastify：http/routes/sse/auth（Web + /im/handle）
web/                       控制台前端
docs/                      GitHub Pages 使用介绍网站
```

## 许可证

MIT · 基于 [cc-connect](https://github.com/chenhg5/cc-connect)，设计参考 [lifestream](https://github.com/nitonitori/lifestream)
