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
 * IM 摄入闸门：决定一条消息是否路由给信使、以及路由后的文本。
 * 返回 null = 忽略（非本机器人消息 / 未过白名单 / 无前缀普通消息）。
 * 移植 lifestream ImLinker.route + 白名单逻辑。
 * @param {object} args { text, senderId, gate, pendingCount }
 * @returns {string|null}
 */
function routeMessage({
  text, senderId, gate, pendingCount = 0,
}) {
  if (!gate || !gate.enabled) {
    return null;
  }
  const allow = gate.allowed_sender_ids || [];
  if (allow.length && senderId && !allow.includes(senderId)) {
    return null;
  }
  const trimmed = String(text || '').trim();
  const prefix = gate.command_prefix || '';
  if (!prefix) {
    return trimmed;
  }
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  // 待确认时允许裸「确认/取消」直接决策，无需前缀
  if (pendingCount > 0 && isDecision(trimmed, gate)) {
    return trimmed;
  }
  return null;
}

module.exports = { routeMessage, isDecision };
