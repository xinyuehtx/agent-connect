'use strict';

const { sendViaCcConnect } = require('../im/deliver');
const { getAdapter } = require('../agents');

/**
 * 会话状态监听器：仅在两种情况下向 IM 主动推送消息——
 *   ① 需要用户确认/输入（会话进入 waiting）
 *   ② 任务完成（busy → idle）
 * 其余状态变化不打扰。只在"状态发生变化"时触发，并按 (会话,类型) 冷却去重。
 */
class SessionNotifier {
  /**
   * @param {object} deps { plane, cfg, runtime, getMessages }
   *   plane: ControlPlane（EventEmitter）
   *   cfg: { enabled, scope, on_needs_confirm, on_task_done, cooldown_ms }
   *   runtime: { lastSessionKey, project }（由 /im/handle 更新，作为默认推送目标）
   */
  constructor(deps) {
    this.plane = deps.plane;
    this.cfg = deps.cfg || {};
    this.runtime = deps.runtime || {};
    this.getMessages = deps.getMessages;
    this.send = deps.send || sendViaCcConnect; // 可注入，便于测试
    this._prev = new Map();     // sessionId -> status
    this._seeded = new Set();   // 首次同步不推送
    this._lastAt = new Map();   // `${id}:${kind}` -> ts
    this._onEvent = this._handle.bind(this);
  }

  start() {
    if (!this.cfg.enabled) {
      return;
    }
    this.plane.on('event', this._onEvent);
  }

  stop() {
    this.plane.off('event', this._onEvent);
  }

  _handle(e) {
    if (e.type === 'session.removed') {
      this._prev.delete(e.sessionId);
      this._seeded.delete(e.sessionId);
      return;
    }
    if (e.type !== 'session.updated') {
      return;
    }
    const s = e.session;
    const id = s.sessionId;
    const status = s.status;
    const prev = this._prev.get(id);
    this._prev.set(id, status);

    if (!this._seeded.has(id)) {
      this._seeded.add(id); // 启动/首见时只登记，不推送
      return;
    }
    if (status === prev) {
      return;
    }
    if (this.cfg.scope === 'controllable' && !s.controllable) {
      return;
    }
    // 纯监控型 GUI 应用（无 CLI，不可控制/咨询，如 qwen/qoderwork）默认不推主动通知——
    // 用户在其 App 内直接操作，完成状态本就可见，远程通知无可操作价值、且易被记忆会话刷屏。
    if (this.cfg.monitor_only !== true) {
      const ad = s.tool && getAdapter(s.tool);
      if (ad && ad.bin === '') {
        return;
      }
    }
    if (status === 'waiting' && this.cfg.on_needs_confirm !== false) {
      this._notify('needs_confirm', s);
    } else if (prev === 'busy' && status === 'idle' && this.cfg.on_task_done !== false) {
      this._notify('task_done', s);
    }
  }

  async _notify(kind, s) {
    const key = `${s.sessionId}:${kind}`;
    const now = Date.now();
    const cooldown = this.cfg.cooldown_ms || 30000;
    if (now - (this._lastAt.get(key) || 0) < cooldown) {
      return;
    }
    this._lastAt.set(key, now);

    const short = String(s.sessionId).slice(0, 8);
    const name = s.name || short;
    const proj = s.cwd ? s.cwd.split('/').slice(-1)[0] : '?';
    const agent = s.tool ? ` · ${s.tool}` : '';
    let snippet = '';
    try {
      if (this.getMessages) {
        const events = await this.getMessages(s.sessionId, { limit: 4 });
        const last = [...events].reverse().find((x) => x.kind === 'assistant' && x.text);
        if (last) snippet = last.text.slice(0, 300);
      }
    } catch (err) { /* ignore */ }

    const head = kind === 'needs_confirm'
      ? `⏳ 需要你确认/输入 · 来自 ${name}（${proj}${agent}）[${short}]`
      : `✅ 任务完成 · 来自 ${name}（${proj}${agent}）[${short}]`;
    const message = snippet ? `${head}\n\n${snippet}` : head;

    const r = this.send({
      project: this.runtime.project,
      sessionKey: this.runtime.lastSessionKey || undefined,
      message,
    });
    if (r && r.then) {
      r.catch(() => {});
    }
  }
}

module.exports = { SessionNotifier };
