'use strict';

const readline = require('readline');
const { loadConfig, saveConfig } = require('../lib/config-store');

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
 * cc-router project remove <name>
 * 从 projects 数组中删除指定名称的项目。
 * @param {string} name
 * @param {{ yes?: boolean }} options
 */
async function projectRemove(name, options = {}) {
  const config = loadConfig();
  const projects = Array.isArray(config.projects) ? config.projects : [];

  const index = projects.findIndex((p) => p.name === name);
  if (index === -1) {
    console.error(`未找到项目: ${name}`);
    process.exit(1);
  }

  if (!options.yes) {
    const ok = await confirm(`确认删除项目 "${name}" ? (y/N) `);
    if (!ok) {
      console.log('已取消。');
      return;
    }
  }

  projects.splice(index, 1);
  config.projects = projects;
  saveConfig(config);
  console.log(`✓ 已删除项目 "${name}"`);
}

module.exports = projectRemove;
