'use strict';

/**
 * 解析 cc-connect 注入的 CC_SESSION_KEY。
 * 格式: dingtalk:{g|d}:{conversationId}[:{senderStaffId}]
 * conversationId 一般不含冒号；若含，取最后一段为 senderId（当段数 >= 4）。
 * @param {string|undefined} key
 * @returns {{ platform:string|null, scope:string|null, conversationId:string, senderId:string }}
 */
function parseSessionKey(key) {
  const empty = {
    platform: null, scope: null, conversationId: '', senderId: '',
  };
  if (!key || typeof key !== 'string') {
    return empty;
  }
  const parts = key.split(':');
  if (parts.length < 3) {
    return { ...empty, platform: parts[0] || null };
  }
  const platform = parts[0];
  const scope = parts[1];
  if (parts.length >= 4) {
    const senderId = parts[parts.length - 1];
    const conversationId = parts.slice(2, -1).join(':');
    return { platform, scope, conversationId, senderId };
  }
  return { platform, scope, conversationId: parts.slice(2).join(':'), senderId: '' };
}

module.exports = { parseSessionKey };
