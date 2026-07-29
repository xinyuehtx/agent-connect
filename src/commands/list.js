'use strict';

const { loadConfig } = require('../lib/config-store');

const SENSITIVE_KEYS = ['client_secret'];

/**
 * 对敏感字段做部分遮掩显示。
 * @param {string} value
 * @returns {string}
 */
function maskValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  if (value.length <= 4) {
    return '****';
  }
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/**
 * 递归遮掩配置中的敏感字段。
 * @param {*} node
 * @returns {*}
 */
function maskSensitive(node) {
  if (Array.isArray(node)) {
    return node.map(maskSensitive);
  }
  if (node && typeof node === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(node)) {
      if (SENSITIVE_KEYS.includes(key)) {
        result[key] = maskValue(val);
      } else {
        result[key] = maskSensitive(val);
      }
    }
    return result;
  }
  return node;
}

/**
 * agent-connect config list
 * 输出完整配置（敏感字段遮掩）。
 */
function list() {
  const config = loadConfig();
  if (Object.keys(config).length === 0) {
    console.log('配置为空，请先运行 agent-connect init。');
    return;
  }
  const masked = maskSensitive(config);
  console.log(JSON.stringify(masked, null, 2));
}

module.exports = list;
