'use strict';

const fs = require('fs');
const path = require('path');
const { ensureConfigDir } = require('../lib/config-store');
const { CONFIG_DIR, CONFIG_FILE } = require('../lib/paths');

const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'templates', 'config.default.toml');

/**
 * agent-connect init
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
  console.log('  1. agent-connect serve                     # 启动 Web 控制台（首次会打印访问 token）');
  console.log('  2. 浏览器打开 http://127.0.0.1:8787    # 在配置页填 LLM provider 与钉钉凭证');
  console.log('     或用 CLI:');
  console.log('       agent-connect config set messenger.base_url <你的兼容端点/v1>');
  console.log('       agent-connect config set messenger.api_key <你的 key>');
  console.log('       agent-connect config set projects.0.platforms.0.options.client_id <钉钉 client_id>');
  console.log('       agent-connect config set projects.0.platforms.0.options.client_secret <钉钉 client_secret>');
  console.log('  3. agent-connect start                     # 另开一个终端拉起 cc-connect（钉钉↔本地）');
}

module.exports = init;
