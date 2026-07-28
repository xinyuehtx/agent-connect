'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Claude Code / qodercli 家族的项目目录转义规则：路径中的 "/" 与 "." 均替换为 "-"。
 * 例：/Users/x/code/connect → -Users-x-code-connect
 * @param {string} cwd
 * @returns {string}
 */
function encodeCwd(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

/**
 * 在某个 projects 根目录下定位会话 transcript。
 * 优先按转义规则直算；失败则遍历所有项目目录按 <sessionId>.jsonl 兜底搜索。
 * @param {string} projectsDir projects 根目录（如 ~/.claude/projects）
 * @param {string|null} cwd
 * @param {string} sessionId
 * @returns {string|null}
 */
function resolveTranscript(projectsDir, cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  if (cwd) {
    const p = path.join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) {
        return p;
      }
    }
  } catch (e) {
    // projectsDir 不存在
  }
  return null;
}

/**
 * 在某 projects 根目录下按完整 ID 或前缀搜索 transcript。
 * 供 read 用短 ID 查询已退出会话时使用。
 * @param {string} projectsDir
 * @param {string} idOrPrefix
 * @returns {string|null}
 */
function searchTranscript(projectsDir, idOrPrefix) {
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch (e) {
    return null;
  }
  // 先按完整文件名精确匹配
  for (const d of dirs) {
    const p = path.join(projectsDir, d, `${idOrPrefix}.jsonl`);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  // 再按前缀匹配
  for (const d of dirs) {
    let files;
    try {
      files = fs.readdirSync(path.join(projectsDir, d));
    } catch (e) {
      continue;
    }
    const hit = files.find((f) => f.endsWith('.jsonl') && f.startsWith(idOrPrefix));
    if (hit) {
      return path.join(projectsDir, d, hit);
    }
  }
  return null;
}

/**
 * 定位某 projects 目录下最新的会话 transcript，返回其 sessionId。
 * 用于 ps 发现出的进程无法从命令行拿到 sessionId 时的兜底（如 qodercli）。
 * @param {string} projectsDir
 * @param {string} cwd
 * @returns {string|null}
 */
function newestSessionId(projectsDir, cwd) {
  const dir = path.join(projectsDir, encodeCwd(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const f of files) {
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (m > bestMtime) {
      bestMtime = m;
      best = f;
    }
  }
  return best ? best.replace(/\.jsonl$/, '') : null;
}

/**
 * 读取 JSONL transcript 为事件数组。
 * @param {string} file
 * @param {object} [opts]
 * @param {number} [opts.limit] 仅取末尾 N 行
 * @returns {object[]}
 */
function readEvents(file, opts = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const slice = opts.limit ? lines.slice(-opts.limit) : lines;
  const events = [];
  for (const l of slice) {
    try {
      events.push(JSON.parse(l));
    } catch (e) {
      // 跳过损坏/半截行
    }
  }
  return events;
}

/**
 * 从消息 content 中提取纯文本（content 可能是字符串或 block 数组）。
 * @param {*} content
 * @returns {string}
 */
function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * 汇总一个 transcript：最新 assistant 回复、最近用户输入、最近工具、消息数、最后活动时间。
 * Claude Code 与 qodercli（其衍生品）共用该格式。
 * @param {string} file
 * @returns {{lastAssistant:string, lastUser:string, lastTool:(string|null), messageCount:number, lastTs:(number|null)}}
 */
function summarize(file) {
  const events = readEvents(file);
  let lastAssistant = '';
  let lastUser = '';
  let lastTool = null;
  let messageCount = 0;
  let lastTs = null;

  for (const e of events) {
    const msg = e.message;
    if (e.type === 'assistant' && msg) {
      const t = textFromContent(msg.content);
      if (t) {
        lastAssistant = t;
      }
      if (Array.isArray(msg.content)) {
        const tu = msg.content.filter((b) => b && b.type === 'tool_use').pop();
        if (tu) {
          lastTool = tu.name;
        }
      }
      messageCount += 1;
    } else if (e.type === 'user' && msg) {
      const t = textFromContent(msg.content);
      if (t) {
        lastUser = t;
      }
      messageCount += 1;
    }
    if (e.timestamp) {
      const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(e.timestamp);
      if (!Number.isNaN(ts)) {
        lastTs = ts;
      }
    }
  }

  return { lastAssistant, lastUser, lastTool, messageCount, lastTs };
}

module.exports = {
  encodeCwd,
  resolveTranscript,
  searchTranscript,
  newestSessionId,
  readEvents,
  textFromContent,
  summarize,
};
