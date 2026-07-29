'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { listProcesses } = require('../proc');
const {
  resolveTranscript, searchTranscript, encodeCwd,
} = require('../transcript');

const HOME = os.homedir();
// QwenWorkCN（通义灵码「灵动工作台」）是 Electron 桌面应用，会话数据与 Claude Code 同构：
//   ~/.qwenworkcn/projects/<转义cwd>/<sessionId>.jsonl（同样的 JSONL schema）
const QWEN_DIR = process.env.QWEN_CONFIG_DIR || path.join(HOME, '.qwenworkcn');
const PROJECTS_DIR = path.join(QWEN_DIR, 'projects');
const BUSY_WINDOW_MS = 15000; // transcript 在此窗内被写过 → busy
const LIVE_WINDOW_MS = 24 * 3600 * 1000; // 只纳入近 24h 有活动的会话，避免列出海量历史

/**
 * QwenWorkCN 主进程是否在运行（桌面 app，非 CLI）。
 * @returns {boolean}
 */
function appRunning() {
  return listProcesses().some((p) => /QwenWorkCN\.app\/Contents\/MacOS\/QwenWorkCN(\s|$)/.test(p.command));
}

/**
 * 从 transcript 头部读出 cwd（workspace-directories / cwd 字段），只读前 8KB。
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
    try { o = JSON.parse(line); } catch (e) { continue; } // 半截行跳过
    if (o.cwd) return o.cwd;
    if (Array.isArray(o.directories) && o.directories[0]) return o.directories[0];
  }
  return null;
}

/**
 * 定位某会话 transcript。
 */
function transcriptPath(cwd, sessionId) {
  return resolveTranscript(PROJECTS_DIR, cwd, sessionId);
}

/**
 * 按完整 ID 或前缀搜索 transcript。
 */
function findTranscript(idOrPrefix) {
  return searchTranscript(PROJECTS_DIR, idOrPrefix);
}

/**
 * 发现 qwen 会话：无原生 pid 注册表，也非终端进程——按 transcript 枚举 + mtime 近似。
 * app 运行 = 会话可视为 live；status 按 mtime（近 15s busy，否则 idle）。仅纳入近 24h 活动的会话。
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
      if (now - mtime > LIVE_WINDOW_MS) continue; // 只看近 24h
      out.push({
        tool: 'qwen',
        pid: null,
        sessionId: f.replace(/\.jsonl$/, ''),
        cwd: cwdFromTranscript(file),
        name: null, // qwen transcript 不带 name，展示回退到短 ID
        kind: 'app', // 桌面应用，非交互终端 → 只读通道
        status: live ? (now - mtime < BUSY_WINDOW_MS ? 'busy' : 'idle') : 'idle',
        version: null,
        updatedAt: mtime,
        alive: live,
      });
    }
  }
  return out;
}

// qwenwork 是桌面应用，无 CLI/tmux —— 不可 resume/launch/接管，仅只读监控。
function resumeArgs() { return []; }
function launchArgs() { return []; }

module.exports = {
  tool: 'qwen',
  bin: '', // 无 CLI：控制面写操作与只读咨询(fork)对 qwen 不可用
  defaultMode: '',
  QWEN_DIR,
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
