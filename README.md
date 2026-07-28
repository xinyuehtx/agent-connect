# 🤖 cc-connect-router

> 从手机（钉钉）监控并控制本机上正在运行的**多个** coding agent 会话（Claude Code / qodercli）：**读写分离、一对多、无解释型路由夹层**。

在钉钉里发一句话，就能查看本机所有 agent 任务的状态、只读拉取结果、并把后续指令注入到指定的那个任务。基于 [cc-connect](https://github.com/chenhg5/cc-connect) 做钉钉 ↔ 本地的消息传输，本机侧的发现与控制全部由 `cc-router agent` 命令完成。

---

## 🏗️ 架构

**无解释型路由 Agent**：普通消息由 cc-connect 直接转发给绑定的目标 agent 会话——目标 agent（Claude Code / qodercli）本身就是 LLM，自己理解自然语言，不需要中间再夹一个"路由 agent"去翻译意图。跨会话的发现与控制由 `cc-router agent` 这一层**确定性命令**完成。

```
钉钉 ↔ cc-connect ↔ 目标 agent 会话（Claude Code / qodercli，直连，自己理解 NL）
                         ▲
                         │ 发现 / 只读 / 注入 / 接管 / 新建（确定性命令，无 LLM 夹层）
                    cc-router agent  ──►  tmux 托管的会话（可远控，支撑一对多）
```

```
              钉钉用户消息
                   │  DingTalk Stream
                   ▼
        ┌──────────────────────┐
        │      cc-connect       │   钉钉 ↔ 本地 消息传输
        └──────────────────────┘
                   │  普通消息直连转发
                   ▼
        ┌──────────────────────┐        发现/只读/注入/接管
        │   目标 agent 会话     │ ◄─────────────────────────┐
        │ Claude Code/qodercli  │   （自己理解自然语言）      │
        └──────────────────────┘                           │
                   │ 运行于                        ┌──────────────────┐
                   ▼                               │  cc-router agent  │
             tmux 托管会话  ◄─────── 管理/一对多 ───│  控制面（CLI）    │
                                                   └──────────────────┘
```

用 Mermaid 表示：

```mermaid
graph LR
    P[钉钉 / 手机] <-->|DingTalk Stream| CC[cc-connect 消息传输]
    CC <-->|普通消息直连| A[目标 agent 会话<br/>Claude Code / qodercli<br/>自己理解 NL]
    R[cc-router agent<br/>控制面 list/read/send/takeover/run] -->|发现·只读·注入·接管| A
    A -.->|运行于| T[tmux 托管会话]
    R -.->|管理·一对多| T
```

---

## 📦 安装

```bash
npm install -g @tengxiaohtx/connect
```

安装后即可使用 `cc-router` 命令行工具。

---

## 🚀 快速开始

```bash
# 1. 初始化配置（在 ~/.cc-connect-router/config.toml 生成默认配置）
cc-router init

# 2. 配置钉钉凭证
cc-router config set projects.0.platforms.0.options.client_id "your-id"
cc-router config set projects.0.platforms.0.options.client_secret "your-secret"

# 3. 设置项目工作目录
cc-router config set projects.0.agent.options.work_dir "/path/to/project"

# 4. 启动服务
cc-router start
```

其中钉钉凭证 `client_id` / `client_secret` 需在[钉钉开放平台](https://open.dingtalk.com)创建**企业内部应用**（或机器人应用），并在「机器人」配置中启用 **Stream 模式**后获取。

---

## 🧩 无需路由 Agent

本项目**不需要**一个额外的"路由 Agent"来解释钉钉消息：

- **普通消息**：cc-connect 直接转发给绑定的目标 agent 会话，由它（Claude Code / qodercli，本身即 LLM）自行理解并执行。
- **跨会话控制**：用 `cc-router agent list/read/send/takeover/run` 这组**确定性命令**完成发现、只读、注入、接管、新建——没有意图识别的 LLM 夹层，也就没有二次推理的延迟、成本与出错面。

> 早期的 `qoder-router` skill（依赖 OpenCode 路由层、单项目直调 Qoder CLI 的旧流程）仍保留在 `skill/qoder-router/` 作为历史参考，已被上述直连 + 控制面模型取代。

---

## 📖 CLI 命令参考

| 命令 | 说明 |
|------|------|
| `cc-router init [--force]` | 初始化配置目录与默认配置文件（`--force` 覆盖已存在文件） |
| `cc-router config get <key>` | 读取配置项（支持点号路径） |
| `cc-router config set <key> <value>` | 修改配置项（自动类型推断） |
| `cc-router config remove <key> [--yes]` | 删除配置项（`--yes` 跳过确认） |
| `cc-router config list` | 显示完整配置（敏感字段遮掩） |
| `cc-router project add <name> <dir> [--agent type]` | 添加新项目 |
| `cc-router project remove <name> [--yes]` | 删除项目 |
| `cc-router project list` | 列出所有项目 |
| `cc-router start` | 使用当前配置启动 cc-connect |
| `cc-router agent list [-a] [--json]` | 列出本机运行中的 Agent 会话（一对多看板数据源） |
| `cc-router agent read <id> [--json] [--full]` | 只读查看会话状态与最新回复（不污染上下文） |
| `cc-router agent send <id> "<text>"` | 向 tmux 托管的会话注入指令 |
| `cc-router agent takeover <id> [--force]` | 接管非 tmux 会话（kill 原进程 + resume 进 tmux） |
| `cc-router agent run ["<prompt>"] [-w dir]` | 在 tmux 中启动一个可远控的新会话 |

---

## 🎛️ Agent 会话控制（读写双平面）

用一部手机监控并控制本机上**多个**正在运行的 Agent 会话（当前支持 Claude Code，qodercli 为其衍生品、后续接入）。核心是**读写分离**，避免手机上大量查询污染真实工作上下文：

- **读平面（带外、零污染）**：`agent list` / `agent read` 直接读 Claude Code 落盘的运行态注册表（`~/.claude/sessions/<pid>.json`）与会话 transcript（`~/.claude/projects/<cwd>/<id>.jsonl`），**完全不碰 agent 进程**，手机上狂刷也不入任何上下文。
- **写平面（带内、刻意）**：`agent send` 才会真正向会话注入指令。

会话按**控制通道**分类：

| 通道 | 含义 | 可注入？ |
|------|------|----------|
| `tmux` | 我们托管的（`agent run`/`takeover`）或外部 tmux 会话 | ✅ `agent send` 直接注入 |
| `tty` | 裸终端交互会话 | 需先 `agent takeover` 接管进 tmux |
| `ide` | IDE（VS Code 等）占用 / headless | 只读，勿动 |
| `dead` | 进程已退出，仅剩磁盘记录 | `takeover` 直接 resume |

典型流程：

```bash
cc-router agent list                         # 看有哪些会话、谁在忙谁空闲
cc-router agent read a1b2c3d4                 # 任务跑完了？看看结果（只读）
cc-router agent takeover a1b2c3d4             # 若是裸终端会话，先接管进 tmux
cc-router agent send a1b2c3d4 "继续：改用方案 B"  # 继续派活
cc-router agent run -w /path/to/proj "跑单元测试"  # 或全新起一个可远控会话
```

> 依赖 `tmux`（写平面）：`brew install tmux`。读平面（list/read）无需 tmux。


---

## 💬 使用示例

在钉钉中直接用自然语言对机器人说：

| 你发送的消息 | 路由到的脚本 | 作用 |
|--------------|--------------|------|
| 查看 connect 项目的任务 | `qoder-tasks.sh` | 列出项目后台任务 |
| 给 cli 项目指派任务：优化命令行参数解析 | `qoder-assign.sh` | 创建新任务 |
| 看看任务 abc123 的执行进度 | `qoder-status.sh` | 查询会话状态 |
| 在 opencode 项目中实现日志模块 | `qoder-exec.sh` | 立即执行指令 |
| 任意开发问题（如"帮我看下这个报错"） | `qoder-exec.sh`（默认路由） | 交给 Qoder 处理 |

> 意图识别与参数提取由 `skill/qoder-router/SKILL.md` 定义的路由规则完成。

---

## 📂 项目结构

```
connect/
├── bin/
│   └── cli.js                   # cc-router CLI 入口
├── src/
│   ├── commands/                # 各子命令实现（init/get/set/start 等）
│   ├── lib/                     # 配置存取与路径工具
│   └── index.js
├── templates/
│   └── config.default.toml      # 默认配置模板（cc-router init 使用）
├── skill/
│   └── qoder-router/            # skills.sh 标准格式 skill
│       ├── SKILL.md             # skill 定义：意图识别 + 路由规则
│       ├── scripts/             # skill 附带的 shell 脚本
│       └── references/          # 参考文档（如 setup-guide.md）
├── scripts/                     # 本地脚本（开发者模式使用）
│   ├── common.sh                # 公共函数库
│   ├── qoder-tasks.sh           # 查询项目任务列表
│   ├── qoder-assign.sh          # 指派新任务
│   ├── qoder-status.sh          # 查询会话/任务状态
│   └── qoder-exec.sh            # 在项目中执行指令
├── config.toml                  # 本地开发参考配置
├── Makefile                     # setup / run / check 等命令
├── package.json
└── README.md
```

---

## ➕ 添加新项目

```bash
cc-router project add my-backend /path/to/backend --agent qoder
```

添加后可用 `cc-router project list` 查看，无需手动编辑配置文件。

---

## 🛠️ 开发者模式（可选）

如果你直接在本仓库开发调试，也可以使用手动配置方式：

1. 直接编辑本地 `config.toml`，填入钉钉凭证与 `work_dir`。
2. 运行 `make run` 启动服务（会优先使用 `~/.cc-connect-router/config.toml`，若不存在则回退到本地 `config.toml`）。

其他常用命令：

```bash
make install      # 设置 scripts/*.sh 可执行权限
make check        # 检查环境依赖与配置
make test-local   # 本地测试脚本可用性
```

---

## 📋 前置条件

| 依赖 | 说明 | 链接 |
|------|------|------|
| **Node.js >= 18** | 运行 `cc-router` CLI 所需 | https://nodejs.org |
| **cc-connect** | 消息网关，把钉钉消息转发到本地 Agent | https://github.com/chenhg5/cc-connect |
| **OpenCode CLI** | 轻量路由层，理解意图并调用脚本 | https://opencode.ai |
| **Qoder CLI** | 真实执行层，命令名 `qodercli` | — |
| **钉钉开发者账号** | 需在开放平台创建机器人，获取 `client_id` / `client_secret` | https://open.dingtalk.com |

> macOS 使用 `--timeout` 功能需额外安装 coreutils：`brew install coreutils`。

---

## 🔧 故障排查

| 问题 | 可能原因 & 解决方法 |
|------|--------------------|
| **cc-connect 连接失败** | 检查配置中 `client_id` / `client_secret` 是否正确；确认钉钉应用已开启 **Stream 模式**；确认本机能访问外网。 |
| **qodercli 未找到** | 脚本会报 `[ERROR] 未找到 'qodercli' 命令`。请确认 Qoder CLI 已安装并在 `PATH` 中；或用环境变量 `QODER_CLI` 指定可执行文件名。 |
| **钉钉消息收不到** | 确认机器人已加入群聊 / 开启单聊；服务是否在运行；查看前台日志有无报错。 |
| **任务执行超时** | 对耗时操作加 `--timeout <秒>` 参数；macOS 需先 `brew install coreutils` 才能使用 timeout 功能。 |
| **脚本无执行权限** | 运行 `make install` 为 `scripts/*.sh` 添加可执行权限。 |
| **找不到配置文件** | 运行 `cc-router init` 生成 `~/.cc-connect-router/config.toml`。 |

排查前可先跑一遍 `make check` 确认依赖与配置状态，再用 `make test-local` 验证脚本能否正常调用。

---

Made with ❤️ · 让开发像发消息一样简单。
