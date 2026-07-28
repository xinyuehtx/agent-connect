'use strict';

const crypto = require('crypto');
const { describeAction } = require('./describe');

const norm = (s) => String(s || '').trim().toLowerCase();
const resolve = (v) => (typeof v === 'function' ? v() : v);

/**
 * 信使会话逻辑：确认状态机 + 信使 agent 轮次。
 * Web 与 IM 用同一 conversationKey 调它 => 共享待确认队列与上下文。
 * 移植并适配 lifestream AgentConductor（动作改为 connect 的 send/takeover/run）。
 *
 * confirmWords / cancelWords / confirmTtlMs 可传数组/数值，也可传**返回它们的函数**
 * （每次 handle 时实时求值），以便 Web 配置页改动即时生效、无需重启 serve。
 */
class AgentConductor {
  constructor(deps) {
    this.messenger = deps.messenger;
    this.plane = deps.plane;
    this.pending = deps.pending;
    this.clock = deps.clock || { now: () => Date.now() };
    this.confirmWords = deps.confirmWords || ['确认', '确定', 'yes', 'y', 'ok'];
    this.cancelWords = deps.cancelWords || ['取消', 'no', 'n'];
    this.confirmTtlMs = deps.confirmTtlMs || 300000;
    this.onExecute = deps.onExecute;
  }

  _matches(words, text) {
    const t = norm(text);
    return (words || []).map(norm).includes(t);
  }

  /**
   * 暂存一个待确认动作，返回给信使工具的结果。
   * @param {string} conversationKey
   * @param {string} kind
   * @param {object} params
   * @returns {{staged:true, description:string}}
   */
  _stage(conversationKey, kind, params) {
    const action = {
      id: crypto.randomUUID(),
      conversationId: conversationKey,
      kind,
      params,
      description: describeAction(kind, params),
      createdAt: this.clock.now(),
    };
    const list = this.pending.get(conversationKey);
    list.push(action);
    this.pending.set(conversationKey, list);
    return { staged: true, description: action.description };
  }

  /**
   * 真正执行一个已确认的动作（经 ControlPlane 写平面）。
   * @param {object} a PendingAction
   * @returns {Promise<string>}
   */
  async _execute(a) {
    const short = a.params.sessionId ? String(a.params.sessionId).slice(0, 8) : '?';
    if (a.kind === 'send') {
      await this.plane.sendMessage(a.params.sessionId, a.params.text);
      return `✅ 已发送到会话 ${short}`;
    }
    if (a.kind === 'takeover') {
      const s = await this.plane.takeover(a.params.sessionId, { force: a.params.force });
      return `✅ 已接管会话 ${String(s.sessionId || a.params.sessionId).slice(0, 8)}`;
    }
    if (a.kind === 'run') {
      const s = await this.plane.run({ cwd: a.params.cwd, prompt: a.params.prompt, tool: a.params.tool });
      return `✅ 已新建会话 ${String(s.sessionId).slice(0, 8)}`;
    }
    return '未知动作';
  }

  /**
   * 处理一轮输入。
   * @param {string} conversationKey
   * @param {string} text
   * @returns {Promise<object>} ConductorResult
   */
  async handle(conversationKey, text, ctx) {
    // 实时求值：Web 配置页改动确认词/超时后立即生效，无需重启
    const confirmWords = resolve(this.confirmWords);
    const cancelWords = resolve(this.cancelWords);
    const confirmTtlMs = resolve(this.confirmTtlMs);

    const pend = this.pending.get(conversationKey);
    if (pend.length > 0) {
      const oldest = Math.min(...pend.map((a) => a.createdAt));
      if (this.clock.now() - oldest > confirmTtlMs) {
        this.pending.clear(conversationKey);
        return { kind: 'expired' };
      }
      if (this._matches(confirmWords, text)) {
        const results = [];
        for (const a of pend) {
          try {
            results.push(await this._execute(a));
            if (this.onExecute) this.onExecute(a, true);
          } catch (e) {
            results.push(`❌ 失败: ${e.message}`);
            if (this.onExecute) this.onExecute(a, false);
          }
        }
        this.pending.clear(conversationKey);
        return { kind: 'executed', results };
      }
      if (this._matches(cancelWords, text)) {
        this.pending.clear(conversationKey);
        return { kind: 'cancelled' };
      }
      // 既非确认也非取消：丢弃旧动作，作为新一轮处理
      this.pending.clear(conversationKey);
    }

    const stage = (kind, params) => this._stage(conversationKey, kind, params);
    const reply = await this.messenger.run(conversationKey, text, stage, ctx);
    const staged = this.pending.get(conversationKey);
    if (staged.length > 0) {
      return { kind: 'staged', reply, actions: staged };
    }
    return { kind: 'reply', text: reply };
  }
}

/**
 * 把 ConductorResult 格式化为纯文本（IM 回复用）。
 * @param {object} r
 * @returns {string}
 */
function formatResult(r) {
  switch (r.kind) {
    case 'reply':
      return r.text;
    case 'staged': {
      const summary = r.actions.map((a) => `• ${a.description}`).join('\n');
      return `${r.reply}\n\n待执行:\n${summary}\n\n回复「确认」执行 / 「取消」放弃`;
    }
    case 'executed':
      return r.results.join('\n');
    case 'cancelled':
      return '已取消。';
    case 'expired':
      return '确认已超时，请重新发起。';
    default:
      return '';
  }
}

module.exports = { AgentConductor, formatResult };
