'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { isAlive } = require('../proc');
const { encodeCwd, resolveTranscript, searchTranscript } = require('../transcript');

const HOME = os.homedir();
// 允许通过环境变量覆盖（与 Claude Code 的 CLAUDE_CONFIG_DIR 对齐）
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions'); // <pid>.json 运行态注册表
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects'); // <转义cwd>/<sessionId>.jsonl

/**
 * 定位某会话的 transcript 文件。
 * @param {string|null} cwd
 * @param {string} sessionId
 * @returns {string|null}
 */
function transcriptPath(cwd, sessionId) {
  return resolveTranscript(PROJECTS_DIR, cwd, sessionId);
}

/**
 * 按完整 ID 或前缀搜索 transcript（供 read 查询已退出会话）。
 * @param {string} idOrPrefix
 * @returns {string|null}
 */
function findTranscript(idOrPrefix) {
  return searchTranscript(PROJECTS_DIR, idOrPrefix);
}

/**
 * 发现运行态会话：读取 ~/.claude/sessions/<pid>.json。
 * 这是 Claude Code 原生的运行态注册表，含 sessionId/cwd/kind/status/name。
 * @returns {Array<object>}
 */
function discover() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }

  const out = [];
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch (e) {
      continue;
    }
    if (!j || !j.sessionId) {
      continue;
    }
    const alive = isAlive(j.pid);
    out.push({
      tool: 'claude',
      pid: j.pid,
      sessionId: j.sessionId,
      cwd: j.cwd || null,
      name: j.name || null,
      kind: j.kind || 'unknown',
      status: alive ? j.status || 'unknown' : 'dead',
      version: j.version || null,
      updatedAt: j.updatedAt || j.statusUpdatedAt || null,
      alive,
    });
  }
  return out;
}

/**
 * 构造 resume 一个已有会话的 argv。
 * @param {string} sessionId
 * @param {string} mode 权限模式
 * @returns {string[]}
 */
function resumeArgs(sessionId, mode) {
  return ['-r', sessionId, '--permission-mode', mode];
}

/**
 * 构造用指定 sessionId 启动新会话的 argv。
 * @param {string} sessionId 预生成的 UUID
 * @param {string} mode 权限模式
 * @returns {string[]}
 */
function launchArgs(sessionId, mode) {
  return ['--session-id', sessionId, '--permission-mode', mode];
}

module.exports = {
  tool: 'claude',
  bin: 'claude',
  defaultMode: 'bypassPermissions', // Claude Code 用驼峰
  readonlyMode: 'plan', // 只读咨询(fork)用 plan 模式
  CLAUDE_DIR,
  SESSIONS_DIR,
  PROJECTS_DIR,
  encodeCwd,
  transcriptPath,
  findTranscript,
  discover,
  resumeArgs,
  launchArgs,
};
