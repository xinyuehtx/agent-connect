'use strict';

const claude = require('./claude');
const qoder = require('./qoder');
const qwen = require('./qwen');

// Claude Code 有原生运行态注册表（~/.claude/sessions），发现最干净；
// qodercli 是其衍生品（transcript 同构，在 ~/.qoderwork/projects），无运行态注册表，走 ps+lsof 发现；
// QwenWorkCN 是桌面 app（~/.qwenworkcn/projects，transcript 同构），无 CLI/tmux → 只读监控。
const ADAPTERS = {
  claude,
  qoder,
  qwen,
};

/**
 * 取指定工具的适配器。
 * @param {string} tool
 * @returns {object|null}
 */
function getAdapter(tool) {
  return ADAPTERS[tool] || null;
}

/**
 * 取全部已接入的适配器。
 * @returns {object[]}
 */
function getAdapters() {
  return Object.values(ADAPTERS);
}

module.exports = { getAdapter, getAdapters };
