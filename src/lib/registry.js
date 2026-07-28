'use strict';

const tmux = require('./tmux');
const { ttyOf } = require('./proc');
const { getAdapters, getAdapter } = require('./agents');

/**
 * 我们托管的 tmux 会话命名规则：ccr-<tool>-<sessionId 前 8 位>。
 * @param {string} tool
 * @param {string} sessionId
 * @returns {string}
 */
function tmuxName(tool, sessionId) {
  return `ccr-${tool}-${String(sessionId).slice(0, 8)}`;
}

/**
 * 判定一个会话的控制通道：
 *   tmux → 可直接 send-keys 注入（我们托管的，或外部 tmux）
 *   tty  → 裸终端交互，需 takeover 后才能注入
 *   ide  → IDE 占用 / headless，只读，勿动
 *   dead → 进程已退出，可 resume
 * @param {object} session
 * @returns {{channel:string, target:(string|null)}}
 */
function classifyChannel(session) {
  const installed = tmux.isInstalled();

  // 1) 我们托管的 tmux 会话（命名可预测）
  if (installed && tmux.hasSession(tmuxName(session.tool, session.sessionId))) {
    return { channel: 'tmux', target: tmuxName(session.tool, session.sessionId) };
  }

  // 2) 进程已退出
  if (!session.alive) {
    return { channel: 'dead', target: null };
  }

  // 3) 外部 tmux：进程 tty 命中某个 pane
  const tty = ttyOf(session.pid);
  if (installed && tty) {
    const target = tmux.findTargetByTty(tty);
    if (target) {
      return { channel: 'tmux', target };
    }
  }

  // 4) 无 tty 或非交互（IDE/headless）→ 只读
  if (!tty || (session.kind && session.kind !== 'interactive')) {
    return { channel: 'ide', target: null };
  }

  // 5) 裸终端交互
  return { channel: 'tty', target: null };
}

/**
 * 汇总所有适配器发现的会话，并标注控制通道。
 * @param {object} [opts]
 * @param {boolean} [opts.all=false] 是否包含已退出会话
 * @returns {object[]}
 */
function list(opts = {}) {
  const sessions = [];
  for (const adapter of getAdapters()) {
    for (const s of adapter.discover()) {
      sessions.push(s);
    }
  }

  const enriched = sessions.map((s) => ({ ...s, ...classifyChannel(s) }));
  const filtered = opts.all ? enriched : enriched.filter((s) => s.alive);
  filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return filtered;
}

/**
 * 按完整或前缀 sessionId 查找会话（含已退出）。
 * @param {string} sessionId 完整 UUID 或前缀（如 8 位短 ID）
 * @returns {object|null}
 */
function find(sessionId) {
  if (!sessionId) {
    return null;
  }
  const all = list({ all: true });
  return (
    all.find((s) => s.sessionId === sessionId)
    || all.find((s) => String(s.sessionId).startsWith(sessionId))
    || null
  );
}

/**
 * 跨工具定位一个会话的 transcript（供只读的 read 使用，即便进程已退出/未被发现）。
 * 先按 find() 命中的工具直取；否则逐个适配器按 sessionId 搜索。
 * @param {string} sessionId 完整或前缀 ID
 * @returns {{session:(object|null), tool:(string|null), file:(string|null)}}
 */
function locate(sessionId) {
  const session = find(sessionId);
  if (session) {
    const adapter = getAdapter(session.tool);
    const file = adapter && adapter.transcriptPath(session.cwd, session.sessionId);
    if (file) {
      return { session, tool: session.tool, file };
    }
  }
  for (const adapter of getAdapters()) {
    const file = adapter.findTranscript(sessionId);
    if (file) {
      return { session, tool: adapter.tool, file };
    }
  }
  return { session, tool: session ? session.tool : null, file: null };
}

module.exports = {
  list, find, locate, tmuxName, classifyChannel,
};
