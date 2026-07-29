'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  listProcesses, cwdOf, ttyOf,
} = require('../proc');
const { resolveTranscript, searchTranscript, newestSessionId, encodeCwd } = require('../transcript');

const HOME = os.homedir();
// Qoder CLI（qodercli / /usr/local/bin/qoder）是 Claude Code 衍生品，会话数据在 ~/.qoder/projects/<转义cwd>/<id>.jsonl
// （注意：桌面应用 QoderWork.app 的数据在 ~/.qoderwork，由 qoderwork 适配器只读监控，两者不同）
const QODER_DIR = process.env.QODER_CONFIG_DIR || path.join(HOME, '.qoder');
const PROJECTS_DIR = path.join(QODER_DIR, 'projects');
// 就绪/忙碌判定的时间窗（transcript 在此窗内被写过则视为 busy）
const BUSY_WINDOW_MS = 15000;

/**
 * 判断一个进程命令行是否为 Qoder CLI（qoder / qodercli 终端进程；排除 Qoder.app / QoderWork.app / 扩展）。
 * @param {string} command
 * @returns {boolean}
 */
function isQoderCli(command) {
  if (!/(^|[/\s])qoder(cli)?(\s|$)/i.test(command)) {
    return false;
  }
  return !/(\.app\/|QoderWork|Qoder Helper|qoderwake|qoderwork|chrome-extension|Electron|--type=)/i.test(command);
}

/**
 * 从命令行解析出 sessionId（--resume / -r / --session-id 后的 UUID）。
 * @param {string} command
 * @returns {string|null}
 */
function parseSessionId(command) {
  const m = command.match(/(?:--resume|--session-id|-r)[=\s]+([0-9a-fA-F-]{36})/);
  return m ? m[1] : null;
}

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
 * 发现运行态会话。
 * qodercli 没有 ~/.claude/sessions 那样的原生运行态注册表，故走 ps + lsof：
 *   ps 找到 qodercli 进程 → lsof 取 cwd → 命令行或最新 transcript 定位 sessionId。
 * 状态无原生 busy/idle，用 transcript mtime 近似。
 * @returns {Array<object>}
 */
function discover() {
  const out = [];
  for (const p of listProcesses()) {
    if (!isQoderCli(p.command)) {
      continue;
    }
    const cwd = cwdOf(p.pid);
    let sessionId = parseSessionId(p.command);
    if (!sessionId && cwd) {
      sessionId = newestSessionId(PROJECTS_DIR, cwd);
    }
    if (!sessionId) {
      continue;
    }
    const file = transcriptPath(cwd, sessionId);
    let mtime = null;
    try {
      if (file) {
        mtime = fs.statSync(file).mtimeMs;
      }
    } catch (e) {
      // ignore
    }
    out.push({
      tool: 'qoder',
      pid: p.pid,
      sessionId,
      cwd: cwd || null,
      name: null, // qoder transcript 不带 name，展示时回退到短 ID
      kind: 'interactive',
      status: mtime && Date.now() - mtime < BUSY_WINDOW_MS ? 'busy' : 'idle',
      version: null,
      updatedAt: mtime,
      alive: true,
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
 * @param {string} sessionId
 * @param {string} mode 权限模式
 * @returns {string[]}
 */
function launchArgs(sessionId, mode) {
  return ['--session-id', sessionId, '--permission-mode', mode];
}

module.exports = {
  tool: 'qoder',
  bin: 'qodercli',
  defaultMode: 'bypass_permissions', // qodercli 用下划线（choices: default/accept_edits/bypass_permissions/dont_ask/auto）
  QODER_DIR,
  PROJECTS_DIR,
  encodeCwd,
  isQoderCli,
  parseSessionId,
  transcriptPath,
  findTranscript,
  discover,
  resumeArgs,
  launchArgs,
};
