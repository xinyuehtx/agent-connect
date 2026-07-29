'use strict';

/**
 * 把待确认动作渲染为中文文案（IM/Web 确认卡片用）。
 * @param {string} kind 'send' | 'takeover' | 'run'
 * @param {object} params
 * @returns {string}
 */
function describeAction(kind, params = {}) {
  const short = params.sessionId ? String(params.sessionId).slice(0, 8) : '?';
  if (kind === 'send') {
    return `向会话 ${short} 发送: ${params.text}`;
  }
  if (kind === 'takeover') {
    return `接管会话 ${short}${params.force ? '（强制）' : ''}`;
  }
  if (kind === 'run') {
    const at = params.cwd || '(当前目录)';
    return `在 ${at} 新建会话${params.prompt ? `，首条: ${params.prompt}` : ''}`;
  }
  if (kind === 'exit') {
    return `退出并关闭会话 ${short}（结束进程 + 关闭 tmux 窗口）`;
  }
  return String(kind);
}

module.exports = { describeAction };
