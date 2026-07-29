'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { listProcesses } = require('../proc');
const {
  resolveTranscript, searchTranscript, encodeCwd,
} = require('../transcript');

const HOME = os.homedir();
// QoderWork.app 是 Electron 桌面应用（区别于 Qoder CLI），会话数据与 Claude Code 同构：
//   ~/.qoderwork/projects/<转义cwd>/<sessionId>.jsonl
const QODERWORK_DIR = process.env.QODERWORK_CONFIG_DIR || path.join(HOME, '.qoderwork');
const PROJECTS_DIR = path.join(QODERWORK_DIR, 'projects');
const BUSY_WINDOW_MS = 15000;
const LIVE_WINDOW_MS = 24 * 3600 * 1000;

/**
 * QoderWork 主进程是否在运行（桌面 app，非 CLI）。
 * @returns {boolean}
 */
function appRunning() {
  return listProcesses().some((p) => /QoderWork\.app\/Contents\/MacOS\/QoderWork(\s|$)/.test(p.command));
}

/**
 * 从 transcript 头部读出 cwd（只读前 8KB）。
 * @param {string} file
 * @returns {string|null}
 */
function cwdFromTranscript(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
  } catch (e) {
    return null;
  }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.cwd) return o.cwd;
    if (Array.isArray(o.directories) && o.directories[0]) return o.directories[0];
  }
  return null;
}

function transcriptPath(cwd, sessionId) {
  return resolveTranscript(PROJECTS_DIR, cwd, sessionId);
}

function findTranscript(idOrPrefix) {
  return searchTranscript(PROJECTS_DIR, idOrPrefix);
}

/**
 * 发现 qoderwork 会话：桌面应用，无 pid 注册表——按 transcript 枚举 + mtime 近似（近 24h）。
 * @returns {Array<object>}
 */
function discover() {
  const live = appRunning();
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch (e) {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const d of dirs) {
    let files;
    try {
      files = fs.readdirSync(path.join(PROJECTS_DIR, d)).filter((f) => f.endsWith('.jsonl'));
    } catch (e) {
      continue;
    }
    for (const f of files) {
      const file = path.join(PROJECTS_DIR, d, f);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch (e) { continue; }
      if (now - mtime > LIVE_WINDOW_MS) continue;
      out.push({
        tool: 'qoderwork',
        pid: null,
        sessionId: f.replace(/\.jsonl$/, ''),
        cwd: cwdFromTranscript(file),
        name: null,
        kind: 'app',
        status: live ? (now - mtime < BUSY_WINDOW_MS ? 'busy' : 'idle') : 'idle',
        version: null,
        updatedAt: mtime,
        alive: live,
      });
    }
  }
  return out;
}

// 桌面应用，无 CLI/tmux → 只读监控。
function resumeArgs() { return []; }
function launchArgs() { return []; }

module.exports = {
  tool: 'qoderwork',
  bin: '', // 无 CLI：不可控制、不可只读 fork 咨询
  defaultMode: '',
  QODERWORK_DIR,
  PROJECTS_DIR,
  encodeCwd,
  appRunning,
  cwdFromTranscript,
  transcriptPath,
  findTranscript,
  discover,
  resumeArgs,
  launchArgs,
};
