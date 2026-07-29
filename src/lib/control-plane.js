'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const registry = require('./registry');
const tmux = require('./tmux');
const proc = require('./proc');
const { readEvents, textFromContent, summarize } = require('./transcript');
const { getAdapter, getAdapters } = require('./agents');
const { NotFoundError, NotControllableError, ConflictError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 交互式登录 shell 包裹，确保 CLI 的 shell function 包装与 PATH 生效。
 * inner 由 argv join 而来（UUID/枚举 token），单引号包裹安全。
 * @param {string} inner
 * @returns {string}
 */
function shellWrap(inner) {
  const shell = process.env.SHELL || '/bin/zsh';
  return `${shell} -i -c '${inner}'`;
}

/**
 * 把 registry 会话规范化为 Web/信使统一使用的 summary。
 * @param {object} s
 * @returns {object}
 */
function toSummary(s) {
  return {
    sessionId: s.sessionId,
    name: s.name || null,
    cwd: s.cwd || null,
    tool: s.tool,
    status: s.alive ? (s.status || 'unknown') : 'dead',
    live: !!s.alive,
    channel: s.channel,
    controllable: s.channel === 'tmux',
    updatedAt: s.updatedAt || null,
    pid: s.pid,
  };
}

/**
 * 把一条 transcript 原始事件对象规范化为结构化事件（供 Web 渲染）。
 * @param {object} o
 * @returns {object|null}
 */
function toEvent(o) {
  if (!o || typeof o !== 'object') {
    return null;
  }
  const ts = o.timestamp
    ? (typeof o.timestamp === 'number' ? o.timestamp : Date.parse(o.timestamp)) : 0;
  const msg = o.message;

  if (o.type === 'assistant' && msg) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content
      .filter((b) => b && b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return {
      kind: 'assistant', uuid: o.uuid, ts, text: textFromContent(msg.content), toolUses,
    };
  }
  if (o.type === 'user' && msg) {
    const content = msg.content;
    if (Array.isArray(content)) {
      const tr = content.find((b) => b && b.type === 'tool_result');
      if (tr) {
        return {
          kind: 'tool_result',
          uuid: o.uuid,
          ts,
          toolUseId: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          isError: !!tr.is_error,
        };
      }
    }
    return { kind: 'user', uuid: o.uuid, ts, text: textFromContent(content) };
  }
  return { kind: 'meta', uuid: o.uuid, ts, type: String(o.type || 'unknown') };
}

/**
 * 解析 `claude -p --output-format json` 输出（可能是事件数组或单对象），提取最终文本。
 * @param {string} stdout
 * @returns {string}
 */
function extractResult(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch (e) { return (stdout || '').trim(); }
  if (Array.isArray(parsed)) {
    const result = [...parsed].reverse().find((e) => e && e.type === 'result');
    if (result && result.result) return String(result.result);
    const asst = [...parsed].reverse().find((e) => e && e.type === 'assistant');
    const txt = asst && Array.isArray(asst.message && asst.message.content)
      ? asst.message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    return txt || (stdout || '').trim();
  }
  return parsed.result || parsed.text || (stdout || '').trim();
}

/**
 * 读写平面的唯一出入口。
 * 读方法（listSessions/getSession/getMessages）只读落盘文件，零副作用、不碰 worker 进程。
 * 写方法（sendMessage/takeover/run）经 tmux，是"带内、刻意"的操作。
 * EventEmitter：轮询 diff 出 session 事件 + fs.watch transcript 推 message 事件（供 SSE）。
 */
class ControlPlane extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.pollIntervalMs = opts.pollIntervalMs || 1200;
    this._lastSeen = new Set();
    this._emitted = new Map(); // sessionId -> Set<uuid>
    this._timer = null;
    this._watchers = [];
  }

  /* ---------------- 读平面 ---------------- */

  /**
   * 列出会话（含通道分类）。
   * @param {object} [opts] { all, activity, windowDays }
   *   windowDays>0 时按时效过滤：仅隐藏"非运行中/待输入且最近活动超过 N 天"的会话（运行中/待输入始终保留）。
   * @returns {Promise<object[]>}
   */
  async listSessions(opts = {}) {
    let list = registry.list({ all: !!opts.all }).map(toSummary);
    const win = Number(opts.windowDays || 0);
    if (win > 0) {
      const cutoff = Date.now() - win * 86400000;
      list = list.filter((s) => {
        if (s.status === 'busy' || s.status === 'waiting') return true; // 活跃始终显示
        return s.updatedAt && s.updatedAt >= cutoff; // 其余按最近活动时效
      });
    }
    if (!opts.activity) {
      return list;
    }
    return list.map((s) => {
      const adapter = getAdapter(s.tool);
      const file = adapter && s.cwd ? adapter.transcriptPath(s.cwd, s.sessionId) : null;
      let act = { lastUser: '', lastAssistant: '', lastTool: null };
      if (file) {
        try { act = summarize(file); } catch (e) { /* ignore */ }
      }
      return {
        ...s,
        lastUser: act.lastUser || '',
        lastAssistant: act.lastAssistant || '',
        lastTool: act.lastTool || null,
      };
    });
  }

  /**
   * 抓取某 tmux 会话可见 pane 文本（用于"截图"/快照）。非 tmux 通道返回 null。
   * @param {string} id
   * @param {number} [lines=200]
   * @returns {{text:string, session:object}|null}
   */
  capturePane(id, lines = 200) {
    const s = registry.find(id);
    if (!s || s.channel !== 'tmux' || !s.target) {
      return null;
    }
    return { text: tmux.capturePane(s.target, lines), session: toSummary(s) };
  }

  /**
   * 取单会话详情（含 transcript 路径与消息数）。
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getSession(id) {
    const s = registry.find(id);
    if (!s) {
      throw new NotFoundError(`会话不存在: ${id}`);
    }
    const { file } = registry.locate(id);
    const count = file ? readEvents(file).length : 0;
    return { ...toSummary(s), transcriptPath: file || null, messageCount: count };
  }

  /**
   * 读会话消息（结构化事件）。跨工具自动定位，进程退出也能读。
   * @param {string} id
   * @param {object} [opts] { limit, sinceUuid }
   * @returns {Promise<object[]>}
   */
  async getMessages(id, opts = {}) {
    const { file } = registry.locate(id);
    if (!file) {
      return [];
    }
    let events = readEvents(file).map(toEvent).filter(Boolean);
    if (opts.sinceUuid) {
      const idx = events.findIndex((e) => e.uuid === opts.sinceUuid);
      if (idx >= 0) {
        events = events.slice(idx + 1);
      }
    }
    if (opts.limit && events.length > opts.limit) {
      events = events.slice(-opts.limit);
    }
    return events;
  }

  /**
   * 只读咨询：fork 目标会话为一个新会话，用 plan（只读）模式提问，答毕即弃。
   * 绝不修改原会话、也不做任何写操作。用于「问它 / 总结 / 为什么 / 怎么改」类咨询。
   * @param {string} id
   * @param {string} question
   * @param {object} [opts] { timeoutMs }
   * @returns {Promise<{ok:boolean, answer?:string, from?:object, error?:string}>}
   */
  async consult(id, question, opts = {}) {
    const s = registry.find(id);
    if (!s) {
      throw new NotFoundError(`会话不存在: ${id}`);
    }
    const adapter = getAdapter(s.tool);
    if (!adapter) {
      throw new NotFoundError(`未知 agent 类型: ${s.tool}`);
    }
    const args = [
      '-p', question,
      '--resume', s.sessionId,
      '--fork-session',
      '--permission-mode', 'plan', // 只读：只规划/回答，不编辑
      '--output-format', 'json',
    ];
    const cwd = s.cwd || process.cwd();
    const from = { name: s.name || String(s.sessionId).slice(0, 8), tool: s.tool, short: String(s.sessionId).slice(0, 8) };
    return new Promise((resolve) => {
      execFile(adapter.bin, args, {
        cwd, timeout: opts.timeoutMs || 120000, maxBuffer: 16 * 1024 * 1024, env: process.env,
      }, (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({ ok: false, error: ((stderr || err.message || '').trim()).slice(0, 200), from });
          return;
        }
        resolve({ ok: true, answer: extractResult(stdout), from });
      });
    });
  }

  /* ---------------- 写平面 ---------------- */

  /**
   * 向 tmux 托管的活会话注入指令。非 tmux 通道拒绝（需先 takeover）。
   * @param {string} id
   * @param {string} text
   * @returns {Promise<{ok:true}>}
   */
  async sendMessage(id, text) {
    this._requireTmux();
    const s = registry.find(id);
    if (!s) {
      throw new NotFoundError(`会话不存在: ${id}`);
    }
    if (s.channel !== 'tmux') {
      if (s.channel === 'ide') {
        throw new NotControllableError('该会话由 IDE 占用，请在 IDE 内操作。');
      }
      throw new NotControllableError(
        `会话通道为 ${s.channel}，无法直接注入；请先接管：takeover ${String(s.sessionId).slice(0, 8)}`,
      );
    }
    const r = tmux.sendText(s.target, text, { enter: true });
    if (r.status !== 0) {
      throw new Error(`注入失败：${(r.stderr || '').trim()}`);
    }
    return { ok: true };
  }

  /**
   * 接管非 tmux 会话：kill 原进程后在 tmux 中 resume。
   * @param {string} id
   * @param {object} [opts] { force, mode }
   * @returns {Promise<object>} 接管后的 summary
   */
  async takeover(id, opts = {}) {
    this._requireTmux();
    const s = registry.find(id);
    if (!s) {
      throw new NotFoundError(`会话不存在: ${id}`);
    }
    const adapter = getAdapter(s.tool);
    if (!adapter) {
      throw new NotFoundError(`未知 agent 类型: ${s.tool}`);
    }
    if (s.channel === 'tmux') {
      return toSummary(s);
    }
    if (s.channel === 'ide') {
      throw new NotControllableError('该会话由 IDE 占用，接管会与 IDE 冲突，已拒绝。');
    }
    if (s.alive && s.status === 'busy' && !opts.force) {
      throw new ConflictError('会话正在执行中（busy）。接管会 kill 当前进程，丢失在飞的这一轮。加 force 强制。');
    }

    const name = registry.tmuxName(s.tool, s.sessionId);
    if (s.alive) {
      proc.killPid(s.pid, 'SIGTERM');
      for (let i = 0; i < 10 && proc.isAlive(s.pid); i += 1) {
        await sleep(300);
      }
      if (proc.isAlive(s.pid)) {
        proc.killPid(s.pid, 'SIGKILL');
      }
      await sleep(400);
    }

    const mode = opts.mode || adapter.defaultMode;
    const inner = `${adapter.bin} ${adapter.resumeArgs(s.sessionId, mode).join(' ')}`;
    const r = tmux.newDetached(name, s.cwd || process.cwd(), shellWrap(inner));
    if (r.status !== 0) {
      throw new Error(`启动 tmux 会话失败：${(r.stderr || '').trim()}`);
    }
    const ready = await this._awaitTranscript(adapter, s.cwd, s.sessionId);

    const updated = registry.find(s.sessionId);
    const summary = updated ? toSummary(updated) : { sessionId: s.sessionId };
    return { ...summary, tmuxSession: name, ready };
  }

  /**
   * 退出并关闭会话：结束 agent 进程 + 关闭其 tmux 窗口（不只是退出 claude 进程）。
   * @param {string} id
   * @returns {Promise<{ok:true, sessionId:string, killedTmux:boolean}>}
   */
  async exit(id) {
    const s = registry.find(id);
    if (!s) {
      throw new NotFoundError(`会话不存在: ${id}`);
    }
    // 1) 结束 agent 进程
    if (s.alive && s.pid) {
      proc.killPid(s.pid, 'SIGTERM');
      for (let i = 0; i < 10 && proc.isAlive(s.pid); i += 1) {
        await sleep(200);
      }
      if (proc.isAlive(s.pid)) {
        proc.killPid(s.pid, 'SIGKILL');
      }
    }
    // 2) 关闭 tmux 窗口（我们托管的命名会话，或命中的 target）
    let killedTmux = false;
    if (tmux.isInstalled()) {
      const name = registry.tmuxName(s.tool, s.sessionId);
      if (tmux.hasSession(name)) {
        tmux.killSession(name);
        killedTmux = true;
      }
      if (s.channel === 'tmux' && s.target && s.target !== name && tmux.hasSession(s.target)) {
        tmux.killSession(s.target);
        killedTmux = true;
      }
    }
    return { ok: true, sessionId: s.sessionId, killedTmux };
  }

  /**
   * 在 tmux 中启动一个可远控的新会话。
   * @param {object} opts { cwd, prompt, tool, mode }
   * @returns {Promise<{sessionId:string, tmuxSession:string, cwd:string}>}
   */
  async run(opts = {}) {
    this._requireTmux();
    const tool = opts.tool || 'claude';
    const adapter = getAdapter(tool);
    if (!adapter) {
      throw new NotFoundError(`未知 agent 类型: ${tool}`);
    }
    const cwd = opts.cwd ? require('path').resolve(opts.cwd) : process.cwd();
    if (!fs.existsSync(cwd)) {
      throw new NotFoundError(`目录不存在: ${cwd}`);
    }
    const sessionId = crypto.randomUUID();
    const name = registry.tmuxName(tool, sessionId);
    const mode = opts.mode || adapter.defaultMode;
    const inner = `${adapter.bin} ${adapter.launchArgs(sessionId, mode).join(' ')}`;
    const r = tmux.newDetached(name, cwd, shellWrap(inner));
    if (r.status !== 0) {
      throw new Error(`启动失败：${(r.stderr || '').trim()}`);
    }
    await this._awaitTranscript(adapter, cwd, sessionId);
    if (opts.prompt && opts.prompt.trim()) {
      await sleep(600);
      tmux.sendText(name, opts.prompt, { enter: true });
    }
    return { sessionId, tmuxSession: name, cwd };
  }

  /* ---------------- 事件（SSE 数据源）---------------- */

  /**
   * 启动轮询 + transcript 监听。
   */
  async start() {
    await this._pollOnce();
    this._timer = setInterval(() => { this._pollOnce().catch(() => {}); }, this.pollIntervalMs);
    for (const adapter of getAdapters()) {
      const dir = adapter.PROJECTS_DIR;
      if (!dir || !fs.existsSync(dir)) {
        continue;
      }
      try {
        const w = fs.watch(dir, { recursive: true }, (_evt, filename) => {
          if (!filename) {
            return;
          }
          const m = String(filename).match(/([0-9a-f-]{36})\.jsonl$/i);
          if (m) {
            this._ingest(m[1]).catch(() => {});
          }
        });
        this._watchers.push(w);
      } catch (e) {
        // 某些平台不支持 recursive；忽略，仅靠轮询
      }
    }
  }

  /**
   * 停止。
   */
  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const w of this._watchers) {
      try { w.close(); } catch (e) { /* ignore */ }
    }
    this._watchers = [];
  }

  async _pollOnce() {
    const list = await this.listSessions({ all: false });
    const now = new Set();
    for (const s of list) {
      now.add(s.sessionId);
      this.emit('event', { type: 'session.updated', session: s });
    }
    for (const id of this._lastSeen) {
      if (!now.has(id)) {
        this.emit('event', { type: 'session.removed', sessionId: id });
      }
    }
    this._lastSeen = now;
  }

  async _ingest(sessionId) {
    const { file } = registry.locate(sessionId);
    if (!file) {
      return;
    }
    const seen = this._emitted.get(sessionId) || new Set();
    for (const o of readEvents(file)) {
      const e = toEvent(o);
      if (!e || !e.uuid) {
        continue;
      }
      if (seen.has(e.uuid)) {
        continue;
      }
      seen.add(e.uuid);
      this.emit('event', { type: 'message', sessionId, event: e });
    }
    this._emitted.set(sessionId, seen);
  }

  /* ---------------- 内部 ---------------- */

  _requireTmux() {
    if (!tmux.isInstalled()) {
      throw new NotControllableError('未安装 tmux，无法执行写操作。请先 `brew install tmux`。');
    }
  }

  async _awaitTranscript(adapter, cwd, sessionId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const file = adapter.transcriptPath(cwd, sessionId);
      if (file && fs.existsSync(file)) {
        return true;
      }
      await sleep(300);
    }
    return false;
  }
}

module.exports = { ControlPlane, toSummary, toEvent, extractResult };
