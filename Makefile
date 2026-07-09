.PHONY: setup run install test-local check publish-skill npm-publish help

# 默认目标：显示帮助信息
help:
	@echo "可用命令："
	@echo "  make setup         - 初始化配置（cc-router init）"
	@echo "  make install       - 安装依赖，设置脚本权限"
	@echo "  make run           - 启动 cc-connect 服务"
	@echo "  make test-local    - 本地测试脚本可用性"
	@echo "  make check         - 检查环境依赖"
	@echo "  make publish-skill - 发布 skill 到 skills.sh 的步骤提示"
	@echo "  make npm-publish   - 发布 npm 包（npm publish）"
	@echo "  make help          - 显示此帮助信息"

# 初始化配置：调用 cc-router init
setup:
	cc-router init

# 安装：设置脚本可执行权限
install:
	chmod +x scripts/*.sh
	@echo "✅ 脚本权限设置完成"

# 启动 cc-connect（前台运行，方便查看日志）
# 优先使用 ~/.cc-connect-router/config.toml，若不存在则回退到本地 config.toml
run:
	@if [ -f "$$HOME/.cc-connect-router/config.toml" ]; then \
		echo "使用配置: $$HOME/.cc-connect-router/config.toml"; \
		cc-connect -c "$$HOME/.cc-connect-router/config.toml"; \
	else \
		echo "使用配置: config.toml（本地开发）"; \
		cc-connect -c config.toml; \
	fi

# 本地测试：验证各脚本是否可正常调用
test-local:
	@echo "=== 测试 qoder-tasks.sh ==="
	./scripts/qoder-tasks.sh --help
	@echo ""
	@echo "=== 测试 qoder-assign.sh ==="
	./scripts/qoder-assign.sh --help
	@echo ""
	@echo "=== 测试 qoder-status.sh ==="
	./scripts/qoder-status.sh --help
	@echo ""
	@echo "=== 测试 qoder-exec.sh ==="
	./scripts/qoder-exec.sh --help
	@echo ""
	@echo "✅ 所有脚本可正常调用"

# 环境检查：快速确认依赖与配置是否就绪
check:
	@echo "检查依赖..."
	@which cc-connect > /dev/null 2>&1 && echo "✅ cc-connect 已安装" || echo "❌ cc-connect 未找到"
	@which opencode > /dev/null 2>&1 && echo "✅ opencode 已安装" || echo "❌ opencode 未找到"
	@which qodercli > /dev/null 2>&1 && echo "✅ qodercli 已安装" || echo "❌ qodercli 未找到"
	@echo ""
	@echo "检查配置..."
	@test -f "$$HOME/.cc-connect-router/config.toml" && echo "✅ ~/.cc-connect-router/config.toml 存在" || echo "ℹ️  ~/.cc-connect-router/config.toml 不存在（可运行 make setup 生成）"
	@test -f config.toml && echo "✅ config.toml（本地）存在" || echo "❌ config.toml 不存在"
	@test -d scripts && echo "✅ scripts/ 目录存在" || echo "❌ scripts/ 目录不存在"
	@test -d skill/qoder-router && echo "✅ skill/qoder-router/ 目录存在" || echo "❌ skill/qoder-router/ 目录不存在"

# 发布 skill 到 skills.sh
publish-skill:
	@echo "发布 skill 到 skills.sh 的步骤："
	@echo ""
	@echo "  1. 确认 skill 目录结构完整："
	@echo "       skill/qoder-router/SKILL.md"
	@echo "       skill/qoder-router/scripts/"
	@echo "       skill/qoder-router/references/"
	@echo "  2. 提交并推送到 GitHub 仓库 (huangtengxiao/connect)。"
	@echo "  3. 其他用户即可通过以下命令安装："
	@echo "       npx skills add huangtengxiao/connect/skill/qoder-router"
	@echo ""
	@echo "ℹ️  skills.sh 直接从 GitHub 仓库路径拉取 skill，无需额外发布操作。"

# 发布 npm 包
npm-publish:
	npm publish
