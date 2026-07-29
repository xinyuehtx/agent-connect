'use strict';

const { z } = require('zod');
const { buildModel } = require('./provider');

/**
 * 从 AI SDK 错误里提取人类可读信息（很多网关把真实原因放在 responseBody，而 error.message 为空）。
 * @param {*} e
 * @returns {string}
 */
function llmErrorMessage(e) {
  let detail = '';
  const body = e && (e.responseBody || (e.data ? JSON.stringify(e.data) : ''));
  if (body) {
    try {
      const j = typeof body === 'string' ? JSON.parse(body) : body;
      detail = j.message || (j.error && j.error.message) || j.detailMessage || '';
    } catch (_) {
      detail = String(body).slice(0, 200);
    }
  }
  const base = (e && e.message) || '';
  const sc = e && e.statusCode ? `[${e.statusCode}] ` : '';
  return `${sc}${detail || base || 'LLM 调用失败'}`;
}

const SYSTEM_PROMPT = [
  '你是 agent-connect 的「信使」——一个**任务管理路由器**，不是干活、也不替 worker 回答问题的 agent。你只做「意图识别 + 路由」。',
  '',
  '你维护一个「当前会话」指针（像 shell 的 cwd）。可用意图：',
  '1) 切换当前会话：switch_current。 2) 列出全部任务：list_sessions。',
  '3) **只读咨询：consult_session**——凡是"问它/为什么/怎么改/总结这次改动/解释/评估"这类需要**会话上下文**才能答的问题，一律 fork 该会话只读提问，把 worker 的回答带回来；**绝不要用你自己的记忆/猜测代替它作答**。',
  '4) 读回复：read_reply（看它最新说了什么/进度）。 5) 转发消息：propose_forward（把指令交给 worker 执行）。',
  '6) 接管：propose_takeover； 7) 退出关闭：propose_exit； 8) 新建：propose_run； 截图：snapshot_session。',
  '',
  '判断规则：',
  '- 需要"会话里的知识/结论"来回答 → consult_session（只读 fork），不要自答。',
  '- 只读咨询的结论若表明"需要真正改动代码/执行" → **建议用户接管该会话进入编辑模式**（并可提议 propose_takeover），不要直接在只读上下文里改。',
  '- 让 worker 真正干活/改东西 → propose_forward（需确认）。',
  '- 只是看状态/列表/最近回复 → list_sessions / read_reply / get_status。',
  '',
  '铁律：对 worker 的任何**变更**只能走 propose_*，绝不声称已执行。当前会话失效（工具返回 stale）如实告知并建议重新 switch_current。',
  '',
  '**回复必须标明来源**，分清两层：',
  '- 你（信使）自己的话：正常文本，可加「🧭 信使：」前缀。',
  '- 来自被管控会话的内容（consult_session / read_reply 的 from/answer）：放进引用块并标注来源，例如：',
  '  > 🔁 来自 <名称·agent>（只读）：<worker 的原话>',
  '不要把 worker 的回答冒充成你自己的话。',
  '',
  '排版：多会话用 Markdown 表格（状态/名称/项目/Agent/最近输入），emoji 标状态（✅ 空闲 / 🔄 运行中 / ⏳ 待输入 / 💀 已退出 / 🧩 IDE），当前会话用 📍。展示 8 位短 ID，调用工具用完整 sessionId。',
].join('\n');

/**
 * 构造信使（manager 路由器）的工具集。信使维护「当前会话」(ctx.currentSessionId, 类似 cwd)，
 * 转发/接管/退出/读取默认作用于当前会话。变更类一律走 stage(需确认)。
 * @param {object} deps { plane, stage, tool, ctx }
 * @returns {object} AI SDK tools
 */
function buildTools({
  plane, stage, tool, ctx,
}) {
  const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : (s || ''));
  const cur = () => (ctx && ctx.currentSessionId) || null;
  const target = (arg) => arg || cur(); // 默认当前会话
  const noCurrent = { ok: false, note: '没有「当前会话」。请先用 switch_current 切换，或在参数里指定 sessionId。' };

  // 门禁：执行路由命令前校验目标会话仍有效。失效则清空当前指针并提示。
  const validateTarget = async (arg) => {
    const explicit = !!arg;
    const id = target(arg);
    if (!id) return { note: noCurrent };
    try {
      await plane.getSession(id);
      return { id };
    } catch (e) {
      if (!explicit && ctx && ctx.setCurrent) ctx.setCurrent(null); // 清空失效的当前会话
      return {
        note: {
          ok: false,
          stale: true,
          note: `⚠️ 会话 ${String(id).slice(0, 8)} 已失效（不存在或已退出）。${explicit ? '' : '当前会话已清空，'}请用 switch_current 重新切换，或指定 sessionId。`,
        },
      };
    }
  };

  return {
    list_sessions: tool({
      description: '列出本机会话（含项目/Agent/状态/最近输入与回复），并标出哪个是当前会话。已按时效过滤掉过旧的已完成任务。',
      inputSchema: z.object({}),
      execute: async () => {
        const list = await plane.listSessions({ all: false, activity: true, windowDays: (ctx && ctx.filterWindowDays) || 0 });
        const current = cur();
        return list.map((s) => ({
          sessionId: s.sessionId,
          short: String(s.sessionId).slice(0, 8),
          isCurrent: s.sessionId === current,
          name: s.name,
          project: s.cwd ? s.cwd.split('/').slice(-2).join('/') : null,
          agent: s.tool,
          status: s.status,
          controllable: s.controllable,
          lastUser: clip(s.lastUser, 100),
          lastReply: clip(s.lastAssistant, 140),
        }));
      },
    }),

    switch_current: tool({
      description: '切换「当前会话」(类似 cd)：之后的转发/接管/退出/读取默认作用于它。',
      inputSchema: z.object({ sessionId: z.string().describe('完整或前缀 sessionId') }),
      execute: async ({ sessionId }) => {
        let full = sessionId;
        let name = null;
        try { const s = await plane.getSession(sessionId); full = s.sessionId; name = s.name; } catch (e) { /* 允许前缀/离线 */ }
        if (ctx && ctx.setCurrent) ctx.setCurrent(full);
        return { ok: true, current: String(full).slice(0, 8), note: `当前会话已切到 ${name || String(full).slice(0, 8)}` };
      },
    }),

    read_reply: tool({
      description: '读取会话最新回复与状态（默认当前会话）。用于"它说什么了 / 看回复 / 当前进度"。只读转录，不打扰会话。',
      inputSchema: z.object({ sessionId: z.string().optional() }),
      execute: async ({ sessionId }) => {
        const id = target(sessionId);
        if (!id) return noCurrent;
        const events = await plane.getMessages(id, { limit: 40 });
        const last = [...events].reverse().find((e) => e.kind === 'assistant' && e.text);
        let detail = null;
        try { detail = await plane.getSession(id); } catch (e) { /* 已退出 */ }
        return {
          sessionId: id,
          from: `${(detail && detail.name) || String(id).slice(0, 8)}·${detail ? detail.tool : '?'}`,
          status: detail ? detail.status : '(已退出)',
          lastReply: last ? last.text.slice(0, 1200) : '(暂无回复)',
        };
      },
    }),

    consult_session: tool({
      description: '【只读咨询】fork 目标会话（默认当前）为只读副本并向它提问，答案来自该 worker 本身且不改动它。'
        + '凡是"问它/为什么/怎么改/总结/解释/评估"这类需要会话上下文来回答的咨询，都用这个，不要自己臆测作答。'
        + '若答案表明需要真正修改，请回复里建议用户「接管」该会话进入编辑模式。',
      inputSchema: z.object({
        question: z.string().describe('要问该会话的问题'),
        sessionId: z.string().optional().describe('不填则默认当前会话'),
      }),
      execute: async ({ question, sessionId }) => {
        const v = await validateTarget(sessionId);
        if (v.note) return v.note;
        const r = await plane.consult(v.id, question);
        if (!r.ok) return { ok: false, note: `只读咨询失败: ${r.error || '未知'}（可尝试接管后再问）` };
        return {
          ok: true,
          mode: 'read-only-fork',
          from: `${r.from.name}·${r.from.tool}`,
          answer: r.answer,
        };
      },
    }),

    get_status: tool({
      description: '快速查询某会话是否可控与忙/闲状态（默认当前会话）。',
      inputSchema: z.object({ sessionId: z.string().optional() }),
      execute: async ({ sessionId }) => {
        const id = target(sessionId);
        if (!id) return noCurrent;
        const s = await plane.getSession(id);
        return { status: s.status, live: s.live, controllable: s.controllable, channel: s.channel };
      },
    }),

    snapshot_session: tool({
      description: '把会话当前终端画面渲染成图片发到聊天（默认当前会话）。',
      inputSchema: z.object({ sessionId: z.string().optional(), caption: z.string().optional() }),
      execute: async ({ sessionId, caption }) => {
        if (!ctx || !ctx.sessionKey) return { ok: false, note: '当前非 IM 会话，无法发图。' };
        const id = target(sessionId);
        if (!id) return noCurrent;
        const { renderTextToImage, sendViaCcConnect } = require('../im/deliver');
        const cap = await plane.capturePane(id, 200);
        let paneText = cap && cap.text;
        const title = cap && cap.session ? (cap.session.name || String(id).slice(0, 8)) : String(id).slice(0, 8);
        if (!paneText) {
          const events = await plane.getMessages(id, { limit: 8 });
          paneText = events.map((e) => (e.kind === 'user' ? `> ${e.text}` : (e.kind === 'assistant' ? e.text : ''))).filter(Boolean).join('\n\n');
        }
        if (!paneText) return { ok: false, note: '没有可截图的内容。' };
        const png = renderTextToImage(paneText, { chromePath: ctx.chromePath, title: `session ${title}` });
        const msg = caption || `📸 来自 ${title} 的当前画面`;
        const r = png
          ? sendViaCcConnect({ sessionKey: ctx.sessionKey, project: ctx.project, imagePath: png, message: msg })
          : sendViaCcConnect({ sessionKey: ctx.sessionKey, project: ctx.project, message: `${msg}\n\n\`\`\`\n${paneText.slice(0, 3000)}\n\`\`\`` });
        return r.ok ? { ok: true, note: '已发送截图。' } : { ok: false, note: `发送失败: ${r.error}` };
      },
    }),

    propose_forward: tool({
      description: '把一条消息/指令转发注入到会话（默认当前会话），需用户确认。用于"信息转发 / 继续 / 让它做X"。',
      inputSchema: z.object({
        text: z.string().describe('要转发给 worker 的消息'),
        sessionId: z.string().optional().describe('不填则默认当前会话'),
      }),
      execute: async ({ text, sessionId }) => {
        const v = await validateTarget(sessionId);
        if (v.note) return v.note;
        return stage('send', { sessionId: v.id, text });
      },
    }),

    propose_takeover: tool({
      description: '提议接管会话（kill 原进程 + 在 tmux 中 resume），默认当前会话，需确认。',
      inputSchema: z.object({ sessionId: z.string().optional(), force: z.boolean().optional() }),
      execute: async ({ sessionId, force }) => {
        const v = await validateTarget(sessionId);
        if (v.note) return v.note;
        return stage('takeover', { sessionId: v.id, force: !!force });
      },
    }),

    propose_exit: tool({
      description: '提议退出并关闭会话：结束进程并关闭其 tmux 窗口，默认当前会话，需确认。',
      inputSchema: z.object({ sessionId: z.string().optional() }),
      execute: async ({ sessionId }) => {
        const v = await validateTarget(sessionId);
        if (v.note) return v.note;
        return stage('exit', { sessionId: v.id });
      },
    }),

    propose_run: tool({
      description: '提议在 tmux 中新建一个可远控会话（新任务），需确认。',
      inputSchema: z.object({
        cwd: z.string().describe('工作目录（绝对路径）'),
        prompt: z.string().optional().describe('首条指令'),
        tool: z.enum(['claude', 'qoder']).optional(),
      }),
      execute: async ({ cwd, prompt, tool: t }) => stage('run', { cwd, prompt, tool: t }),
    }),
  };
}

// 信使只保留很短的对话窗口（寻址分派不需要长期上下文）
const HISTORY_WINDOW = 8;

/**
 * 信使 Agent：用 AI SDK 跑一轮多步工具调用，产出回复（并可能暂存变更动作）。
 */
class Messenger {
  constructor({
    plane, cfg, getCfg, historyStore,
  }) {
    this.plane = plane;
    // getCfg 优先：每轮实时读配置（CLI/文件改动即时生效）；否则退回静态 cfg
    this.getCfg = getCfg || (() => cfg);
    this.historyStore = historyStore;
  }

  /**
   * 处理一轮用户输入。
   * @param {string} conversationKey Web 与 IM 共享的 key
   * @param {string} userText
   * @param {(kind:string, params:object)=>({staged:boolean, description:string})} stage 暂存回调
   * @returns {Promise<string>} 面向用户的回复文本
   */
  async run(conversationKey, userText, stage, ctx) {
    const cfg = this.getCfg();
    const { generateText, stepCountIs, tool } = await import('ai');
    const model = await buildModel(cfg);
    const tools = buildTools({
      plane: this.plane, stage, tool, ctx,
    });

    // 只带最近很短的窗口：信使是分派器，不需要长期累积上下文（避免变成"主 loop"）
    const history = this.historyStore.get(conversationKey).slice(-HISTORY_WINDOW);
    const messages = [...history, { role: 'user', content: userText }];

    let result;
    try {
      result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        stopWhen: stepCountIs(cfg.max_steps || 4),
      });
    } catch (e) {
      // 抛出带真实原因的错误（限流/鉴权/模型权限等），避免上层只拿到空串
      const err = new Error(llmErrorMessage(e));
      err.cause = e;
      throw err;
    }

    // 持久化时也只保留最近窗口，避免历史无限增长
    const updated = [...messages, ...result.response.messages].slice(-(HISTORY_WINDOW * 3));
    this.historyStore.set(conversationKey, updated);
    return result.text || '(信使无文本回复)';
  }
}

module.exports = { Messenger, buildTools, SYSTEM_PROMPT, llmErrorMessage };
