'use strict';

const registry = require('../lib/registry');
const tmux = require('../lib/tmux');

/**
 * cc-router agent send <sessionId> <text>
 * 写平面：向 tmux 托管的活会话注入指令（这是"带内、刻意"的唯一入口）。
 * 非 tmux 通道需先 takeover。
 * @param {string} sessionId
 * @param {string} text
 * @param {object} opts
 */
function agentSend(sessionId, text, opts) {
  if (!tmux.isInstalled()) {
    console.error('未安装 tmux，无法注入。请先 `brew install tmux`。');
    process.exit(1);
  }

  const s = registry.find(sessionId);
  if (!s) {
    console.error(`未找到会话 ${sessionId}。`);
    process.exit(1);
  }

  if (s.channel !== 'tmux') {
    const short = String(s.sessionId).slice(0, 8);
    console.error(`会话「${s.name || short}」当前通道为 ${s.channel}，无法直接注入。`);
    if (s.channel === 'ide') {
      console.error('该会话由 IDE 占用，请在 IDE 内操作。');
    } else {
      console.error(`先接管：cc-router agent takeover ${short}`);
    }
    process.exit(1);
  }

  const r = tmux.sendText(s.target, text, { enter: opts.enter !== false });
  if (r.status !== 0) {
    console.error('注入失败：', (r.stderr || '').trim());
    process.exit(1);
  }
  console.log(`已向「${s.name || String(s.sessionId).slice(0, 8)}」注入${opts.enter === false ? '（未回车）' : '并回车'}。`);
}

module.exports = agentSend;
