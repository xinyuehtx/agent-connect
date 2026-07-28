'use strict';

const { timingSafeEqual } = require('crypto');

/**
 * 恒定时间比较 token。
 * @param {string|undefined} provided
 * @param {string} expected
 * @returns {boolean}
 */
function checkToken(provided, expected) {
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 从请求头/cookie 提取 token。
 * @param {object} req { headers, cookies }
 * @returns {string|undefined}
 */
function extractToken(req) {
  if (req.cookies && req.cookies.ccr_token) {
    return String(req.cookies.ccr_token);
  }
  const auth = req.headers && req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return undefined;
}

module.exports = { checkToken, extractToken };
