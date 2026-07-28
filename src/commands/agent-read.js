'use strict';

const registry = require('../lib/registry');
const { summarize } = require('../lib/transcript');

/**
 * 截断长文本。
 * @param {string} t
 * @param {number} n
 * @returns {string}
 */
function truncate(t, n) {
  if (!t) {
    return '';
  }
  return t.length > n ? `${t.slice(0, n)}\n…（已截断，共 ${t.length} 字，加 --full 看完整）` : t;
}

/**
 * cc-router agent read <sessionId>
 * 读平面：只读 transcript，输出状态与最新回复，绝不向会话注入（零上下文污染）。
 * 跨工具（claude / qoder）自动定位。
 * @param {string} sessionId 完整或前缀 ID
 * @param {object} opts
 */
function agentRead(sessionId, opts) {
  const { session, tool, file } = registry.locate(sessionId);
  if (!file) {
    console.error(`未找到会话 ${sessionId} 的记录。`);
    process.exit(1);
  }

  const summary = summarize(file);
  const sid = session ? session.sessionId : sessionId;

  if (opts.json) {
    console.log(JSON.stringify({
      session, tool, summary, file,
    }, null, 2));
    return;
  }

  const status = session ? session.status : '（进程已退出）';
  console.log(`会话 ${sid}   工具: ${tool || '?'}   状态: ${status}`);
  if (session) {
    console.log(`项目: ${session.cwd || '?'}   通道: ${session.channel}`);
  }
  console.log(
    `消息数: ${summary.messageCount}${summary.lastTool ? `   最近工具: ${summary.lastTool}` : ''}`,
  );
  console.log('\n— 最新回复 —');
  console.log(
    truncate(summary.lastAssistant, opts.full ? Number.MAX_SAFE_INTEGER : 1200)
      || '（暂无 assistant 回复）',
  );
}

module.exports = agentRead;
