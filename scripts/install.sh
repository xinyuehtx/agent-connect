#!/usr/bin/env bash
# agent-connect 一键安装脚本 / one-click installer
#
#   curl -fsSL https://raw.githubusercontent.com/xinyuehtx/agent-connect/main/scripts/install.sh | bash
#
# 环境变量 / env:
#   AC_SKIP_CC=1     跳过安装 cc-connect（消息网关）/ skip cc-connect
#   AC_SKIP_INIT=1   跳过 agent-connect init
#   AC_NPM=<bin>     指定 npm 可执行（默认 npm）
set -euo pipefail

PKG="@tengxiaohtx/agent-connect"
NPM="${AC_NPM:-npm}"
info() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

# 1) Node ≥ 18
if ! command -v node >/dev/null 2>&1; then
  err "未检测到 Node.js。请先安装 Node ≥ 18：https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node 版本过低（$(node -v)）。需要 ≥ 18。"
  exit 1
fi
ok "Node $(node -v)"
if ! command -v "$NPM" >/dev/null 2>&1; then
  err "未检测到 npm。"
  exit 1
fi

# 2) 安装 agent-connect
info "安装 $PKG …"
"$NPM" install -g "$PKG"
ok "agent-connect $(agent-connect --version 2>/dev/null || echo '?') 已安装"

# 3) cc-connect（消息网关：钉钉/飞书/… ↔ 本地）
if [ "${AC_SKIP_CC:-0}" != "1" ]; then
  if command -v cc-connect >/dev/null 2>&1; then
    ok "cc-connect 已安装"
  else
    info "安装 cc-connect（消息网关）… 不需要可设 AC_SKIP_CC=1"
    "$NPM" install -g cc-connect || warn "cc-connect 安装失败，可稍后手动：npm i -g cc-connect"
  fi
fi

# 4) tmux（写平面所需；读平面不需要）
if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V | awk '{print $2}')"
else
  warn "未检测到 tmux —— 写操作（转发/接管/新建）需要它。"
  case "$(uname -s)" in
    Darwin) warn "  安装：brew install tmux" ;;
    Linux)  warn "  安装：sudo apt install tmux  /  sudo yum install tmux" ;;
  esac
fi

# 5) 初始化配置
if [ "${AC_SKIP_INIT:-0}" != "1" ]; then
  CFG="${AGENT_CONNECT_CONFIG_DIR:-$HOME/.agent-connect}/config.toml"
  if [ -f "$CFG" ]; then
    ok "配置已存在：$CFG"
  else
    info "初始化配置 …"
    agent-connect init || warn "init 失败，可手动运行：agent-connect init"
  fi
fi

cat <<'NEXT'

──────────────────────────────────────────────
✅ 安装完成 / Done。下一步 / Next:

  1) 启动 Web 控制台守护 / start the web console daemon:
       agent-connect serve
     打开 http://127.0.0.1:8787
       设置 → LLM Provider：base_url / api_key / model
       设置 → IM 连接器：钉钉 client_id / client_secret

  2) 另开终端启动 cc-connect（钉钉 ↔ 本地）:
       agent-connect start

  文档 / docs: https://xinyuehtx.github.io/agent-connect/
──────────────────────────────────────────────
NEXT
