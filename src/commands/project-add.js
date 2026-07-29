'use strict';

const fs = require('fs');
const { loadConfig, saveConfig } = require('../lib/config-store');

const VALID_AGENTS = ['opencode', 'qoder'];
const VALID_PLATFORMS = ['dingtalk'];

/**
 * agent-connect project add <name> <work_dir>
 * 在 projects 数组中新增一个项目配置块。
 * @param {string} name
 * @param {string} workDir
 * @param {{ agent?: string, platform?: string }} options
 */
function projectAdd(name, workDir, options = {}) {
  const agent = options.agent || 'opencode';
  const platform = options.platform || 'dingtalk';

  if (!VALID_AGENTS.includes(agent)) {
    console.error(`不支持的 agent 类型: ${agent}（可选: ${VALID_AGENTS.join(', ')}）`);
    process.exit(1);
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    console.error(`不支持的 platform 类型: ${platform}（可选: ${VALID_PLATFORMS.join(', ')}）`);
    process.exit(1);
  }

  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    console.error(`工作目录不存在或不是目录: ${workDir}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (!Array.isArray(config.projects)) {
    config.projects = [];
  }

  if (config.projects.some((p) => p.name === name)) {
    console.error(`项目已存在: ${name}`);
    process.exit(1);
  }

  config.projects.push({
    name,
    agent: {
      type: agent,
      options: {
        work_dir: workDir,
        mode: 'default',
      },
    },
    platforms: [
      {
        type: platform,
        options: {
          client_id: '',
          client_secret: '',
        },
      },
    ],
  });

  saveConfig(config);
  console.log(`✓ 已添加项目 "${name}" (agent=${agent}, platform=${platform})`);
  console.log(`  work_dir: ${workDir}`);
}

module.exports = projectAdd;
