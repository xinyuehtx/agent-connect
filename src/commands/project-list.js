'use strict';

const { loadConfig } = require('../lib/config-store');

/**
 * 按列宽填充字符串（考虑中文全角字符）。
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function pad(str, width) {
  const s = String(str == null ? '' : str);
  let displayLen = 0;
  for (const ch of s) {
    displayLen += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  const padding = Math.max(0, width - displayLen);
  return s + ' '.repeat(padding);
}

/**
 * cc-router project list
 * 以表格形式列出所有项目。
 */
function projectList() {
  const config = loadConfig();
  const projects = Array.isArray(config.projects) ? config.projects : [];

  if (projects.length === 0) {
    console.log('暂无项目。使用 cc-router project add <name> <work_dir> 添加。');
    return;
  }

  const rows = projects.map((p) => ({
    name: p.name || '',
    agent: (p.agent && p.agent.type) || '',
    workDir: (p.agent && p.agent.options && p.agent.options.work_dir) || '',
  }));

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const agentW = Math.max(5, ...rows.map((r) => r.agent.length));

  console.log(`${pad('NAME', nameW)}  ${pad('AGENT', agentW)}  WORK_DIR`);
  for (const r of rows) {
    console.log(`${pad(r.name, nameW)}  ${pad(r.agent, agentW)}  ${r.workDir}`);
  }
}

module.exports = projectList;
