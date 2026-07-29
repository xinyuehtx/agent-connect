#!/bin/bash
# 查询特定任务/会话的执行状态
# 用法: qoder-status.sh [--timeout <seconds>] <session_id>
# 输出: 任务当前状态
#
# 文件创建后需要添加可执行权限：
#   chmod +x scripts/qoder-status.sh

set -euo pipefail

# 引入公共函数库
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
    cat <<'EOF'
用法: qoder-status.sh [选项] <session_id>

查询特定任务/会话的执行状态。

参数:
  <session_id>           会话 ID（必填）

选项:
  --timeout <seconds>    使用 timeout 命令包装，超时秒数（正整数）
  -h, --help             显示本帮助信息

示例:
  qoder-status.sh 1234-abcd-5678
  qoder-status.sh --timeout 30 1234-abcd-5678
EOF
}

main() {
    local timeout_secs=""
    local session_id=""

    # 解析参数
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                usage
                exit 0
                ;;
            --timeout)
                [[ $# -ge 2 ]] || die "--timeout 需要一个参数（秒）"
                validate_timeout "$2"
                timeout_secs="$2"
                shift 2
                ;;
            --)
                shift
                break
                ;;
            -*)
                die "未知选项: $1"
                ;;
            *)
                if [[ -z "$session_id" ]]; then
                    session_id="$1"
                    shift
                else
                    die "多余的参数: $1"
                fi
                ;;
        esac
    done

    # 兼容 -- 之后的位置参数
    if [[ -z "$session_id" && $# -gt 0 ]]; then
        session_id="$1"
    fi

    # 参数校验
    [[ -n "$session_id" ]] || { usage >&2; die "缺少必填参数: session_id"; }

    # 检查 CLI
    check_cli

    # 执行
    run_with_timeout "$timeout_secs" "$QODER_CLI" -r "$session_id" -p "/tasks"
}

main "$@"
