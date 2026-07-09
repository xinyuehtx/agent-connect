'use strict';

const fs = require('fs');
const path = require('path');
const { ensureConfigDir } = require('../lib/config-store');
const { CONFIG_DIR, CONFIG_FILE } = require('../lib/paths');

const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'templates', 'config.default.toml');

/**
 * cc-router init
 * 初始化配置目录并生成默认配置文件。
 * @param {{ force?: boolean }} options
 */
function init(options = {}) {
  ensureConfigDir();

  if (fs.existsSync(CONFIG_FILE) && !options.force) {
    console.error(`配置文件已存在: ${CONFIG_FILE}`);
    console.error('如需覆盖，请使用 --force 选项。');
    process.exit(1);
  }

  if (!fs.existsSync(TEMPLATE_FILE)) {
    console.error(`默认模板缺失: ${TEMPLATE_FILE}`);
    process.exit(1);
  }

  fs.copyFileSync(TEMPLATE_FILE, CONFIG_FILE);
  fs.chmodSync(CONFIG_FILE, 0o600);

  console.log('✓ 配置初始化完成');
  console.log(`  配置目录: ${CONFIG_DIR}`);
  console.log(`  配置文件: ${CONFIG_FILE}`);
  console.log('');
  console.log('下一步:');
  console.log('  1. cc-router config set projects.0.platforms.0.options.client_id <你的钉钉 client_id>');
  console.log('  2. cc-router config set projects.0.platforms.0.options.client_secret <你的钉钉 client_secret>');
  console.log('  3. cc-router config set projects.0.agent.options.work_dir <你的工作目录>');
  console.log('  4. cc-router start');
}

module.exports = init;
