'use strict';

const { loadConfig, saveConfig, setNestedValue } = require('../lib/config-store');

/**
 * 将字符串值推断为合适的类型（数字 / 布尔值 / 字符串）。
 * @param {string} raw
 * @returns {*}
 */
function inferType(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return raw;
}

/**
 * agent-connect config set <key> <value>
 * 设置指定点号路径的配置值（自动类型推断）。
 * @param {string} key
 * @param {string} value
 */
function set(key, value) {
  const config = loadConfig();
  const typedValue = inferType(value);

  setNestedValue(config, key, typedValue);
  saveConfig(config);

  console.log(`✓ 已设置 ${key} = ${JSON.stringify(typedValue)}`);
}

module.exports = set;
