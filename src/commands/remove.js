'use strict';

const readline = require('readline');
const { loadConfig, saveConfig, deleteNestedValue } = require('../lib/config-store');

/**
 * 询问用户确认。
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * cc-router config remove <key>
 * 删除指定点号路径的配置值。
 * @param {string} key
 * @param {{ yes?: boolean }} options
 */
async function remove(key, options = {}) {
  const config = loadConfig();

  if (!options.yes) {
    const ok = await confirm(`确认删除配置项 "${key}" ? (y/N) `);
    if (!ok) {
      console.log('已取消。');
      return;
    }
  }

  const deleted = deleteNestedValue(config, key);
  if (!deleted) {
    console.error(`未找到配置项: ${key}`);
    process.exit(1);
  }

  saveConfig(config);
  console.log(`✓ 已删除 ${key}`);
}

module.exports = remove;
