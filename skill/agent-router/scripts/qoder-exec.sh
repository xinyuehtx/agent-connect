#!/bin/bash
# 在指定项目中执行指令
# 用法: qoder-exec.sh [--timeout <seconds>] <project_dir> "<prompt>"
# 输出: 执行结果（流式输出）
#
# 文件创建后需要添加可执行权限：
#   chmod +x scripts/qoder-exec.sh

set -euo pipefail

# 引入公共函数库
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
    cat <<'EOF'
用法: qoder-exec.sh [选项] <project_dir> "<prompt>"

在指定项目中执行指令，结果以流式（stream-json）输出。

参数:
  <project_dir>          项目目录（必填，且必须存在）
  <prompt>               要执行的指令 / 提示词（必填）

选项:
  --timeout <seconds>    使用 timeout 命令包装，超时秒数（正整数）
  -h, --help             显示本帮助信息

示例:
  qoder-exec.sh /path/to/project "列出所有 TODO 注释"
  qoder-exec.sh --timeout 300 /path/to/project "重构 utils 模块"
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
    [[ ${#positional[@]} -ge 2 ]] || { usage >&2; die "缺少必填参数: prompt"; }
    [[ ${#positional[@]} -le 2 ]] || die "参数过多，prompt 含空格时请使用引号包裹"

    local project_dir="${positional[0]}"
    local prompt="${positional[1]}"

    [[ -d "$project_dir" ]] || die "项目目录不存在或不是目录: $project_dir"
    [[ -n "$prompt" ]] || die "prompt 不能为空"

    # 检查 CLI
    check_cli

    # 执行
    run_with_timeout "$timeout_secs" "$QODER_CLI" -p -w "$project_dir" -f stream-json "$prompt"
}

main "$@"
