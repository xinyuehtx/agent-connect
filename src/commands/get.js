'use strict';

const { loadConfig, getNestedValue } = require('../lib/config-store');

/**
 * agent-connect config get <key>
 * 获取指定点号路径的配置值。
 * @param {string} key
 */
function get(key) {
  const config = loadConfig();
  const value = getNestedValue(config, key);

  if (value === undefined) {
    console.error(`未找到配置项: ${key}`);
    process.exit(1);
  }

  console.log(JSON.stringify(value, null, 2));
}

module.exports = get;
