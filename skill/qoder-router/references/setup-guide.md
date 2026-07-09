# qoder-router 安装与配置指南

本指南介绍如何安装、配置并运行 `qoder-router` skill 所依赖的运行环境。

---

## 1. 前置条件

在使用本 skill 之前，请确保以下工具均已安装并加入系统 `PATH`：

| 工具 | 说明 | 验证命令 |
|------|------|----------|
| `cc-connect` | 连接钉钉等平台与 OpenCode 的桥接服务 | `cc-connect --version` |
| `opencode` | OpenCode CLI，作为轻量路由层加载本 skill | `opencode --version` |
| `qodercli` | Qoder CLI，实际执行任务查询 / 指派 / 执行 | `qodercli --version` |

> **macOS 额外依赖**：脚本的 `--timeout` 功能依赖 `timeout` / `gtimeout` 命令。
> macOS 默认不带 `timeout`，请安装 coreutils：
> ```bash
> brew install coreutils
> ```
> 安装后会提供 `gtimeout`，脚本会自动识别使用。

---

## 2. 配置步骤（config.toml）

在仓库根目录准备 `config.toml`，核心字段如下：

```toml
# 钉钉应用凭据（在钉钉开放平台创建应用后获取）
client_id     = "你的_client_id"
client_secret = "你的_client_secret"

# 工作目录：指向本仓库根目录
work_dir = "/Users/huangtengxiao/Documents/code/connect"
```

配置说明：

- **`client_id` / `client_secret`**：来自钉钉开放平台的应用凭据，用于建立 Stream 长连接。请妥善保管，切勿提交到公共仓库。
- **`work_dir`**：cc-connect 的工作目录，应指向本仓库根目录，以便正确加载 `skill/` 与 `scripts/`。

---

## 3. 启动方法

在仓库根目录执行：

```bash
make run
```

该命令等价于：

```bash
cc-connect -c config.toml
```

服务以前台方式运行，便于实时查看日志。启动后即可在钉钉中向应用发送自然语言消息，消息会经 cc-connect → OpenCode → 本 skill 路由到对应的 Qoder CLI 脚本。

如需在启动前检查环境依赖是否完备，可执行：

```bash
make check
```

---

## 4. 项目映射表维护方法

`SKILL.md` 第 3 节「项目目录映射表」负责将用户口语中的项目名转换为脚本所需的绝对目录路径。

维护步骤：

1. 打开 `skill/qoder-router/SKILL.md`，定位到「## 3. 项目目录映射表」。
2. 在表格中新增一行，填写「项目名」与对应的「绝对目录路径」：

   ```markdown
   | 项目名   | 目录                                           |
   |----------|------------------------------------------------|
   | connect  | /Users/huangtengxiao/Documents/code/connect    |
   | opencode | /Users/huangtengxiao/Documents/code/opencode   |
   | myapp    | /Users/huangtengxiao/Documents/code/myapp      |
   ```

3. 目录路径必须为**绝对路径**且真实存在，脚本会校验目录是否存在。
4. 项目名尽量简短、易于口语表达，方便模糊匹配。
5. 修改后无需重启 cc-connect（skill 内容在处理请求时读取），但如遇缓存问题可重启服务确保生效。

---

## 5. 常见问题排查

### 5.1 提示「未找到 'qodercli' 命令」

- 原因：`qodercli` 未安装或未加入 `PATH`。
- 处理：确认已安装，并执行 `which qodercli` 检查；也可通过环境变量覆盖可执行名：
  ```bash
  export QODER_CLI=/absolute/path/to/qodercli
  ```

### 5.2 提示「未找到 timeout/gtimeout 命令」

- 原因：使用了 `--timeout` 但系统缺少 `timeout` / `gtimeout`。
- 处理（macOS）：`brew install coreutils`；或去掉 `--timeout` 参数。

### 5.3 提示「项目目录不存在或不是目录」

- 原因：传入的 `project_dir` 路径错误或映射表配置有误。
- 处理：核对 `SKILL.md` 映射表中的绝对路径是否真实存在。

### 5.4 钉钉消息无响应

- 检查 `config.toml` 中的 `client_id` / `client_secret` 是否正确。
- 查看 `make run` 前台日志是否有连接错误或鉴权失败信息。
- 确认钉钉开放平台应用已启用 Stream 模式并正确配置。

### 5.5 含空格的任务描述被拆分

- 原因：调用脚本时未用引号包裹含空格的参数。
- 处理：任务描述、具体指令等务必用引号包裹，例如：
  ```bash
  ./scripts/qoder-assign.sh /path/to/project "修复登录页面的样式问题"
  ```
