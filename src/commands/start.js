'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { CONFIG_FILE } = require('../lib/paths');

/**
 * agent-connect start
 * 使用当前配置文件在前台启动 cc-connect。
 */
function start() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`配置文件不存在: ${CONFIG_FILE}`);
    console.error('请先运行 agent-connect init。');
    process.exit(1);
  }

  console.log(`启动 cc-connect (配置: ${CONFIG_FILE})...`);

  const child = spawn('cc-connect', ['--config', CONFIG_FILE], {
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('未找到 cc-connect 可执行文件，请确认已安装并在 PATH 中。');
    } else {
      console.error(`启动失败: ${err.message}`);
    }
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code == null ? 0 : code);
  });
}

module.exports = start;
