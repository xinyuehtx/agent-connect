#!/bin/bash
# 查询指定项目的后台任务列表
# 用法: qoder-tasks.sh [--timeout <seconds>] <project_dir>
# 输出: 当前项目的后台任务列表
#
# 文件创建后需要添加可执行权限：
#   chmod +x scripts/qoder-tasks.sh

set -euo pipefail

# 引入公共函数库
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
    cat <<'EOF'
用法: qoder-tasks.sh [选项] <project_dir>

查询指定项目的后台任务列表。

参数:
  <project_dir>          项目目录（必填，且必须存在）

选项:
  --timeout <seconds>    使用 timeout 命令包装，超时秒数（正整数）
  -h, --help             显示本帮助信息

示例:
  qoder-tasks.sh /path/to/project
  qoder-tasks.sh --timeout 30 /path/to/project
EOF
}

main() {
    local timeout_secs=""
    local project_dir=""

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
                if [[ -z "$project_dir" ]]; then
                    project_dir="$1"
                    shift
                else
                    die "多余的参数: $1"
                fi
                ;;
        esac
    done

    # 兼容 -- 之后的位置参数
    if [[ -z "$project_dir" && $# -gt 0 ]]; then
        project_dir="$1"
    fi

    # 参数校验
    [[ -n "$project_dir" ]] || { usage >&2; die "缺少必填参数: project_dir"; }
    [[ -d "$project_dir" ]] || die "项目目录不存在或不是目录: $project_dir"

    # 检查 CLI
    check_cli

    # 执行
    run_with_timeout "$timeout_secs" "$QODER_CLI" -p -w "$project_dir" "/tasks"
}

main "$@"
