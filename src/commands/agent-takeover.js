'use strict';

const fs = require('fs');
const registry = require('../lib/registry');
const tmux = require('../lib/tmux');
const { getAdapter } = require('../lib/agents');
const { killPid, isAlive } = require('../lib/proc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造交给 tmux 运行的 shell 命令。
 * 用交互式登录 shell（-i）执行，确保 claude/qodercli 的 shell function 包装（含埋点 preload）与 PATH 生效。
 * inner 由 argv join 而来，均为 UUID / 枚举 token，不含单引号，故单引号包裹安全。
 * @param {string} inner
 * @returns {string}
 */
function shellWrap(inner) {
  const shell = process.env.SHELL || '/bin/zsh';
  return `${shell} -i -c '${inner}'`;
}

/**
 * agent-connect agent takeover <sessionId>
 * 接管非 tmux 会话：kill 原进程（若在跑）后在 tmux 中 resume，之后即可用 send 注入。
 * @param {string} sessionId
 * @param {object} opts
 */
async function agentTakeover(sessionId, opts) {
  if (!tmux.isInstalled()) {
    console.error('未安装 tmux。请先 `brew install tmux`。');
    process.exit(1);
  }

  const s = registry.find(sessionId);
  if (!s) {
    console.error(`未找到会话 ${sessionId}。`);
    process.exit(1);
  }

  const adapter = getAdapter(s.tool);
  if (!adapter) {
    console.error(`未知 agent 类型: ${s.tool}`);
    process.exit(1);
  }
  const name = registry.tmuxName(s.tool, s.sessionId);

  if (s.channel === 'tmux') {
    console.log(`会话已在 tmux（${s.target}），无需接管，直接 send 即可。`);
    return;
  }
  if (s.channel === 'ide') {
    console.error('该会话由 IDE 占用，接管会与 IDE 冲突，已拒绝。');
    process.exit(1);
  }

  // 1) 存活则先 kill（并发 resume 同一会话文件会损坏，必须先 kill 干净）
  if (s.alive) {
    if (s.status === 'busy' && !opts.force) {
      console.error('会话正在执行中（busy）。接管会 kill 当前进程，丢失在飞的这一轮。');
      console.error('确认请加 --force。');
      process.exit(1);
    }
    console.log(`kill 原进程 pid=${s.pid} …`);
    killPid(s.pid, 'SIGTERM');
    for (let i = 0; i < 10 && isAlive(s.pid); i += 1) {
      await sleep(300);
    }
    if (isAlive(s.pid)) {
      killPid(s.pid, 'SIGKILL');
    }
    await sleep(400);
  }

  // 2) 在 tmux 中 resume
  const mode = opts.mode || adapter.defaultMode;
  const inner = `${adapter.bin} ${adapter.resumeArgs(s.sessionId, mode).join(' ')}`;
  const r = tmux.newDetached(name, s.cwd || process.cwd(), shellWrap(inner));
  if (r.status !== 0) {
    console.error('启动 tmux 会话失败：', (r.stderr || '').trim());
    process.exit(1);
  }

  // 3) 等待 transcript 复现（就绪信号）
  const file = adapter.transcriptPath(s.cwd, s.sessionId);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (file && fs.existsSync(file)) {
      break;
    }
    await sleep(300);
  }

  const short = String(s.sessionId).slice(0, 8);
  console.log(`已接管到 tmux 会话「${name}」。`);
  console.log(`派活: agent-connect agent send ${short} "下一步指令"`);
  console.log(`附加: tmux attach -t ${name}`);
}

module.exports = agentTakeover;
