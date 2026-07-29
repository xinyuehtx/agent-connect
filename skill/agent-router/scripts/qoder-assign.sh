#!/bin/bash
# 向指定项目指派新任务
# 用法: qoder-assign.sh [--timeout <seconds>] <project_dir> "<task_description>"
# 输出: 任务创建结果
#
# 文件创建后需要添加可执行权限：
#   chmod +x scripts/qoder-assign.sh

set -euo pipefail

# 引入公共函数库
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
    cat <<'EOF'
用法: qoder-assign.sh [选项] <project_dir> "<task_description>"

向指定项目指派一个新的后台任务。

参数:
  <project_dir>          项目目录（必填，且必须存在）
  <task_description>     任务描述（必填）

选项:
  --timeout <seconds>    使用 timeout 命令包装，超时秒数（正整数）
  -h, --help             显示本帮助信息

示例:
  qoder-assign.sh /path/to/project "修复登录页面的样式问题"
  qoder-assign.sh --timeout 120 /path/to/project "补充单元测试"
EOF
}

main() {
    local timeout_secs=""
    local positional=()

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
                while [[ $# -gt 0 ]]; do positional+=("$1"); shift; done
                ;;
            -*)
                die "未知选项: $1"
                ;;
            *)
                positional+=("$1")
                shift
                ;;
        esac
    done

    # 参数校验
    [[ ${#positional[@]} -ge 1 ]] || { usage >&2; die "缺少必填参数: project_dir"; }
    [[ ${#positional[@]} -ge 2 ]] || { usage >&2; die "缺少必填参数: task_description"; }
    [[ ${#positional[@]} -le 2 ]] || die "参数过多，task_description 含空格时请使用引号包裹"

    local project_dir="${positional[0]}"
    local task_desc="${positional[1]}"

    [[ -d "$project_dir" ]] || die "项目目录不存在或不是目录: $project_dir"
    [[ -n "$task_desc" ]] || die "task_description 不能为空"

    # 检查 CLI
    check_cli

    # 执行
    run_with_timeout "$timeout_secs" "$QODER_CLI" -p -w "$project_dir" -f stream-json "/quest $task_desc"
}

main "$@"
