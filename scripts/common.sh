#!/bin/bash
# common.sh — Qoder CLI 封装脚本的公共函数库
#
# 提供统一的错误输出、CLI 存在性检查、超时包装等能力。
# 其他脚本通过 `source` 引入本文件，请勿直接执行。
#
# 注意：文件创建后需要添加可执行权限（对可被 source 的库非必须，但保持一致）：
#   chmod +x scripts/*.sh

set -euo pipefail

# qodercli 可执行文件名，可通过环境变量 QODER_CLI 覆盖
QODER_CLI="${QODER_CLI:-qodercli}"

# ---------------------------------------------------------------------------
# 统一错误输出：输出到 stderr，带 [ERROR] 前缀
# ---------------------------------------------------------------------------
err() {
    echo "[ERROR] $*" >&2
}

# 输出错误并以非 0 状态退出
die() {
    err "$*"
    exit 1
}

# 普通信息输出到 stderr（不污染 stdout 的业务结果）
info() {
    echo "[INFO] $*" >&2
}

# ---------------------------------------------------------------------------
# 检查 qodercli 是否在 PATH 中
# ---------------------------------------------------------------------------
check_cli() {
    if ! command -v "$QODER_CLI" >/dev/null 2>&1; then
        die "未找到 '$QODER_CLI' 命令，请确认 Qoder CLI 已安装并加入 PATH。"
    fi
}

# ---------------------------------------------------------------------------
# 解析可用的 timeout 命令（Linux 为 timeout，macOS coreutils 为 gtimeout）
# ---------------------------------------------------------------------------
resolve_timeout_cmd() {
    if command -v timeout >/dev/null 2>&1; then
        echo "timeout"
    elif command -v gtimeout >/dev/null 2>&1; then
        echo "gtimeout"
    else
        echo ""
    fi
}

# ---------------------------------------------------------------------------
# 校验 --timeout 参数为正整数
# 用法: validate_timeout <value>
# ---------------------------------------------------------------------------
validate_timeout() {
    local value="$1"
    if ! [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" -eq 0 ]]; then
        die "--timeout 参数必须为正整数（秒），当前为: '$value'"
    fi
}

# ---------------------------------------------------------------------------
# 执行命令，可选超时包装
# 用法: run_with_timeout <seconds|空> <cmd> [args...]
# ---------------------------------------------------------------------------
run_with_timeout() {
    local secs="$1"
    shift
    if [[ -n "$secs" ]]; then
        local tcmd
        tcmd="$(resolve_timeout_cmd)"
        if [[ -z "$tcmd" ]]; then
            die "未找到 timeout/gtimeout 命令，无法使用 --timeout。macOS 可执行 'brew install coreutils' 安装。"
        fi
        "$tcmd" "$secs" "$@"
    else
        "$@"
    fi
}
