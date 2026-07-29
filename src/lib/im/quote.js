'use strict';

/**
 * 生成「引用回复」抬头：把用户本条指令压成单行摘要的 Markdown 引用块，
 * 贴在回复正文最前，确保用户一眼看出这条回复对应哪条指令（线程不混乱）。
 *
 * 背景：钉钉经 cc-connect **无原生引用回复**（reply_to_trigger 仅飞书支持，
 * 钉钉适配器无引用选项、二进制亦有 "dingtalk: quoted message type not supported"），
 * 故在**内容层**实现引用，跨所有平台一致生效。
 * @param {string} command 用户原始指令文本
 * @param {object} [opts] { max=80 }
 * @returns {string} 形如 "> 🗨️ 你：列出会话\n\n"；command 为空时返回 ''
 */
function quoteHeader(command, opts = {}) {
  const max = opts.max || 80;
  let s = String(command == null ? '' : command).replace(/\s+/g, ' ').trim();
  if (!s) {
    return '';
  }
  if (s.length > max) {
    s = `${s.slice(0, max - 1)}…`;
  }
  return `> 🗨️ 你：${s}\n\n`;
}

/**
 * 给回复正文加引用抬头。
 * enabled=false、command 为空、或正文为空时原样返回（不发只有一行引用的空回复）。
 * @param {string} command 用户原始指令
 * @param {string} reply 回复正文
 * @param {boolean} [enabled=true]
 * @param {object} [opts] 透传给 quoteHeader
 * @returns {string}
 */
function withQuote(command, reply, enabled = true, opts = {}) {
  const body = reply == null ? '' : String(reply);
  if (!enabled || !body.trim()) {
    return body;
  }
  const head = quoteHeader(command, opts);
  return head ? head + body : body;
}

module.exports = { quoteHeader, withQuote };
