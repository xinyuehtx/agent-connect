'use strict';

const claude = require('./claude');
const qoder = require('./qoder');
const qwen = require('./qwen');
const qoderwork = require('./qoderwork');

// Claude Code：原生运行态注册表（~/.claude/sessions），发现最干净。
// Qoder CLI（qodercli）：Claude Code 衍生品，~/.qoder/projects，无注册表 → ps 发现，可控 + tmux。
// QwenWorkCN / QoderWork：Electron 桌面应用（~/.qwenworkcn、~/.qoderwork），transcript 同构，无 CLI → 只读监控。
const ADAPTERS = {
  claude,
  qoder,
  qwen,
  qoderwork,
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
