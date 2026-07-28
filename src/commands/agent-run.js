'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const tmux = require('../lib/tmux');
const registry = require('../lib/registry');
const { getAdapter } = require('../lib/agents');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 交互式登录 shell 包裹，确保 CLI 的 shell function 包装与 PATH 生效。
 * @param {string} inner
 * @returns {string}
 */
function shellWrap(inner) {
  const shell = process.env.SHELL || '/bin/zsh';
  return `${shell} -i -c '${inner}'`;
}

/**
 * cc-router agent run [prompt]
 * 显式启动器（arun）：在 tmux 中拉起一个"可远控"的新会话。
 * 预生成 sessionId，故启动即可知其 ID；首条指令走 send 通道注入（与后续一致）。
 * 注意：这是显式命令，不是 PATH 劫持——只有你想让某次任务可远控时才用它。
 * @param {string} [prompt]
 * @param {object} opts
 */
async function agentRun(prompt, opts) {
  if (!tmux.isInstalled()) {
    console.error('未安装 tmux。请先 `brew install tmux`。');
    process.exit(1);
  }

  const tool = opts.tool || 'claude';
  const adapter = getAdapter(tool);
  if (!adapter) {
    console.error(`未知 agent 类型: ${tool}`);
    process.exit(1);
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  if (!fs.existsSync(cwd)) {
    console.error(`目录不存在: ${cwd}`);
    process.exit(1);
  }

  const sessionId = crypto.randomUUID();
  const name = registry.tmuxName(tool, sessionId);
  const mode = opts.mode || adapter.defaultMode;
  const inner = `${adapter.bin} ${adapter.launchArgs(sessionId, mode).join(' ')}`;

  const r = tmux.newDetached(name, cwd, shellWrap(inner));
  if (r.status !== 0) {
    console.error('启动失败：', (r.stderr || '').trim());
    process.exit(1);
  }

  console.log(`已在 tmux「${name}」启动 ${tool} 会话，等待就绪…`);

  // 等待 transcript 出现，作为就绪信号
  const file = adapter.transcriptPath(cwd, sessionId);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      break;
    }
    await sleep(300);
  }

  if (prompt && prompt.trim()) {
    await sleep(600); // 给输入框一点稳定时间
    const sr = tmux.sendText(name, prompt, { enter: true });
    if (sr.status !== 0) {
      console.error('首条指令注入失败：', (sr.stderr || '').trim());
    } else {
      console.log('已注入首条指令。');
    }
  }

  const short = sessionId.slice(0, 8);
  console.log(`\n会话 ID: ${sessionId}`);
  console.log(`查看: cc-router agent read ${short}`);
  console.log(`派活: cc-router agent send ${short} "..."`);
  console.log(`附加: tmux attach -t ${name}`);
}

module.exports = agentRun;
