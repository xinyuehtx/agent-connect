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
  '你是 cc-connect-router 的「信使」助手：帮用户从聊天里监控与控制本机上其它正在运行的 coding agent 会话（Claude Code / qodercli）。',
  '',
  '工具：',
  '- 只读：list_sessions（含项目/Agent/状态/最近一条用户输入与回复）、read_session、get_status。',
  '- 截图/图片：snapshot_session（把某会话终端画面渲染成图片发到聊天）、send_image（发送本机图片文件）。',
  '- 变更（需确认）：propose_send / propose_takeover / propose_run —— 只提议，用户「确认」后才执行。',
  '',
  '铁律：任何对 worker 会话的变更（注入 / 接管 / 新建）都只能通过 propose_* 工具提议，绝不要声称已经执行。',
  '',
  '输出格式（聊天窗口会渲染 Markdown，请让回复美观、不简陋）：',
  '- 用 **加粗** 标关键项；用 emoji 标状态：✅ 空闲 / 🔄 运行中 / 💀 已退出 / 🧩 IDE。',
  '- 列多个会话时用 Markdown 表格（状态 / 名称 / 项目 / Agent / 最近输入），或清晰的分条列表。',
  '- 终端输出、命令、代码片段放进 ``` 代码块。',
  '- 用户想看某会话实时画面时，主动调用 snapshot_session 发一张截图，再配一句总结。',
  '- 引用会话时展示 8 位短 ID，但调用工具时用完整 sessionId。回复精炼、结构化。',
].join('\n');

/**
 * 构造绑定到 ControlPlane 与 stage 回调的工具集。
 * @param {object} deps { plane, stage, tool }
 * @returns {object} AI SDK tools
 */
function buildTools({
  plane, stage, tool, ctx,
}) {
  const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : (s || ''));
  return {
    list_sessions: tool({
      description: '列出本机所有运行中的 agent 会话（含项目、Agent、状态、最近一条用户输入/回复）。',
      inputSchema: z.object({}),
      execute: async () => {
        const list = await plane.listSessions({ all: false, activity: true });
        return list.map((s) => ({
          sessionId: s.sessionId,
          short: String(s.sessionId).slice(0, 8),
          name: s.name,
          project: s.cwd ? s.cwd.split('/').slice(-2).join('/') : null,
          cwd: s.cwd,
          agent: s.tool,
          status: s.status,
          channel: s.channel,
          controllable: s.controllable,
          lastUser: clip(s.lastUser, 120),
          lastReply: clip(s.lastAssistant, 160),
        }));
      },
    }),

    read_session: tool({
      description: '只读查看某会话的状态与最新回复（不会打扰该会话）。',
      inputSchema: z.object({ sessionId: z.string().describe('完整或前缀 sessionId') }),
      execute: async ({ sessionId }) => {
        const events = await plane.getMessages(sessionId, { limit: 6 });
        const lastAssistant = [...events].reverse().find((e) => e.kind === 'assistant' && e.text);
        let detail = null;
        try {
          detail = await plane.getSession(sessionId);
        } catch (e) { /* 进程可能已退出 */ }
        return {
          sessionId,
          status: detail ? detail.status : '(已退出)',
          channel: detail ? detail.channel : null,
          messageCount: detail ? detail.messageCount : events.length,
          lastAssistant: lastAssistant ? lastAssistant.text.slice(0, 1200) : '(暂无回复)',
        };
      },
    }),

    get_status: tool({
      description: '快速查询某会话是否可控与忙/闲状态。',
      inputSchema: z.object({ sessionId: z.string() }),
      execute: async ({ sessionId }) => {
        const s = await plane.getSession(sessionId);
        return { status: s.status, live: s.live, controllable: s.controllable, channel: s.channel };
      },
    }),

    snapshot_session: tool({
      description: '把某会话的当前终端画面渲染成图片并发到聊天里（可视化"截图"）。仅 tmux 会话可截图；否则退回发送最近文本。',
      inputSchema: z.object({
        sessionId: z.string(),
        caption: z.string().optional().describe('图片说明文字'),
      }),
      execute: async ({ sessionId, caption }) => {
        if (!ctx || !ctx.sessionKey) {
          return { ok: false, note: '当前非 IM 会话，无法发送图片（请在钉钉等聊天里使用）。' };
        }
        const { renderTextToImage, sendViaCcConnect } = require('../im/deliver');
        const cap = await plane.capturePane(sessionId, 200);
        let paneText = cap && cap.text;
        let title = cap && cap.session ? (cap.session.name || sessionId.slice(0, 8)) : sessionId.slice(0, 8);
        if (!paneText) {
          // 非 tmux：用最近 transcript 文本兜底
          const events = await plane.getMessages(sessionId, { limit: 8 });
          paneText = events.map((e) => {
            if (e.kind === 'user') return `> ${e.text}`;
            if (e.kind === 'assistant') return e.text;
            if (e.kind === 'tool_result') return `[tool] ${String(e.content).slice(0, 200)}`;
            return '';
          }).filter(Boolean).join('\n\n');
        }
        if (!paneText) {
          return { ok: false, note: '没有可截图的内容。' };
        }
        const png = renderTextToImage(paneText, { chromePath: ctx.chromePath, title: `session ${title}` });
        if (png) {
          const r = sendViaCcConnect({
            sessionKey: ctx.sessionKey, project: ctx.project, imagePath: png, message: caption || `📸 ${title} 的当前画面`,
          });
          return r.ok ? { ok: true, note: '已发送截图。' } : { ok: false, note: `发送失败: ${r.error}` };
        }
        // 无渲染器：以代码块文本兜底发送
        const r = sendViaCcConnect({
          sessionKey: ctx.sessionKey, project: ctx.project,
          message: `${caption || `📸 ${title}`}\n\n\`\`\`\n${paneText.slice(0, 3000)}\n\`\`\``,
        });
        return r.ok ? { ok: true, note: '本机无图片渲染器，已改发文本快照。' } : { ok: false, note: `发送失败: ${r.error}` };
      },
    }),

    send_image: tool({
      description: '把本机某张已存在的图片文件发到聊天里（如生成的图表/截图）。',
      inputSchema: z.object({
        path: z.string().describe('图片绝对路径'),
        caption: z.string().optional(),
      }),
      execute: async ({ path: imgPath, caption }) => {
        if (!ctx || !ctx.sessionKey) {
          return { ok: false, note: '当前非 IM 会话，无法发送图片。' };
        }
        const fs = require('fs');
        if (!fs.existsSync(imgPath)) {
          return { ok: false, note: `文件不存在: ${imgPath}` };
        }
        const { sendViaCcConnect } = require('../im/deliver');
        const r = sendViaCcConnect({
          sessionKey: ctx.sessionKey, project: ctx.project, imagePath: imgPath, message: caption || '',
        });
        return r.ok ? { ok: true, note: '已发送图片。' } : { ok: false, note: `发送失败: ${r.error}` };
      },
    }),

    propose_send: tool({
      description: '提议向某会话注入一条指令（需用户确认后执行）。',
      inputSchema: z.object({
        sessionId: z.string().describe('目标会话的完整 sessionId'),
        text: z.string().describe('要注入的指令文本'),
      }),
      execute: async ({ sessionId, text }) => stage('send', { sessionId, text }),
    }),

    propose_takeover: tool({
      description: '提议接管一个非 tmux 会话（kill 原进程 + 在 tmux 中 resume），需用户确认。',
      inputSchema: z.object({
        sessionId: z.string(),
        force: z.boolean().optional().describe('busy 时是否强制接管'),
      }),
      execute: async ({ sessionId, force }) => stage('takeover', { sessionId, force: !!force }),
    }),

    propose_run: tool({
      description: '提议在 tmux 中新建一个可远控会话，需用户确认。',
      inputSchema: z.object({
        cwd: z.string().describe('工作目录（绝对路径）'),
        prompt: z.string().optional().describe('首条指令'),
        tool: z.enum(['claude', 'qoder']).optional(),
      }),
      execute: async ({ cwd, prompt, tool: t }) => stage('run', { cwd, prompt, tool: t }),
    }),
  };
}

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

    const history = this.historyStore.get(conversationKey);
    const messages = [...history, { role: 'user', content: userText }];

    let result;
    try {
      result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        stopWhen: stepCountIs(cfg.max_steps || 8),
      });
    } catch (e) {
      // 抛出带真实原因的错误（限流/鉴权/模型权限等），避免上层只拿到空串
      const err = new Error(llmErrorMessage(e));
      err.cause = e;
      throw err;
    }

    const updated = [...messages, ...result.response.messages];
    this.historyStore.set(conversationKey, updated);
    return result.text || '(信使无文本回复)';
  }
}

module.exports = { Messenger, buildTools, SYSTEM_PROMPT, llmErrorMessage };
