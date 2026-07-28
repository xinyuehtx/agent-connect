'use strict';

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * 是否为裸「确认/取消」决策词。
 * @param {string} text
 * @param {object} gate
 * @returns {boolean}
 */
function isDecision(text, gate) {
  const words = [...(gate.confirm_words || []), ...(gate.cancel_words || [])].map(norm);
  return words.includes(norm(text));
}

/**
 * IM 摄入闸门分类：决定一条消息如何处理。
 *   { action:'route', text } —— 交给信使
 *   { action:'deny', reason, senderId } —— 明确拒绝（不在白名单），应回一条提示
 *   { action:'ignore' } —— 静默忽略（未启用 / 有前缀但非命令的普通闲聊）
 * @param {object} args { text, senderId, gate, pendingCount }
 * @returns {{action:string, text?:string, reason?:string, senderId?:string}}
 */
function classifyMessage({
  text, senderId, gate, pendingCount = 0,
}) {
  if (!gate || !gate.enabled) {
    return { action: 'ignore' };
  }
  const allow = gate.allowed_sender_ids || [];
  if (allow.length && senderId && !allow.includes(senderId)) {
    return { action: 'deny', reason: 'not_allowed', senderId };
  }
  const trimmed = String(text || '').trim();
  const prefix = gate.command_prefix || '';
  if (!prefix) {
    return { action: 'route', text: trimmed };
  }
  if (trimmed.startsWith(prefix)) {
    return { action: 'route', text: trimmed.slice(prefix.length).trim() };
  }
  // 待确认时允许裸「确认/取消」直接决策，无需前缀
  if (pendingCount > 0 && isDecision(trimmed, gate)) {
    return { action: 'route', text: trimmed };
  }
  return { action: 'ignore' };
}

module.exports = { classifyMessage, isDecision };
