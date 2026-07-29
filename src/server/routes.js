'use strict';

const { checkToken, extractToken } = require('./auth');
const { DomainError } = require('../lib/errors');
const { formatResult } = require('../lib/messenger/conductor');

/**
 * 遮掩敏感值。
 * @param {string} v
 * @returns {string}
 */
function mask(v) {
  if (!v) {
    return '';
  }
  const s = String(v);
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

/**
 * 把 AI SDK ModelMessage content 提取为纯文本。
 * @param {*} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * 把信使历史（ModelMessage[]）转为 Web 可渲染事件。
 * @param {object[]} history
 * @returns {object[]}
 */
function historyToEvents(history) {
  const out = [];
  let i = 0;
  for (const m of history) {
    const uuid = `h${i}`;
    i += 1;
    if (m.role === 'user') {
      out.push({ kind: 'user', uuid, text: contentToText(m.content) });
    } else if (m.role === 'assistant') {
      const toolUses = Array.isArray(m.content)
        ? m.content
          .filter((p) => p && (p.type === 'tool-call'))
          .map((p) => ({ id: p.toolCallId, name: p.toolName, input: p.input || p.args }))
        : [];
      const text = contentToText(m.content);
      if (text || toolUses.length) {
        out.push({ kind: 'assistant', uuid, text, toolUses });
      }
    }
  }
  return out;
}

/**
 * 注册所有路由。
 * @param {import('fastify').FastifyInstance} app
 * @param {object} deps
 */
function registerRoutes(app, deps) {
  const {
    plane, token, sse, agent, config,
  } = deps;
  // 令牌可选：为空则视为"本机开放模式"，所有鉴权直通（仅监听 127.0.0.1 时安全）。
  const authOk = (provided) => !token || checkToken(provided, token);

  // 公开健康检查
  app.get('/healthz', async () => ({ ok: true }));

  // 登录：用主令牌换 cookie（开放模式下无需登录，前端不会走到这里）
  app.post('/api/login', async (req, reply) => {
    const body = req.body || {};
    if (!token) {
      return reply.code(204).send();
    }
    if (!checkToken(body.token, token)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'bad token' } });
    }
    reply.setCookie('ccr_token', token, {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365,
    });
    return reply.code(204).send();
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie('ccr_token', { path: '/' });
    return reply.code(204).send();
  });

  // 鉴权：master token（cookie 或 Bearer）。令牌为空 = 开放模式，直通。
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) {
      return undefined;
    }
    if (req.url === '/api/login' || req.url === '/api/logout') {
      return undefined;
    }
    const provided = extractToken({ headers: req.headers, cookies: req.cookies || {} });
    if (!authOk(provided)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
    }
    return undefined;
  });

  const wrap = (reply, fn, ok = 200) => fn()
    .then((v) => reply.code(ok).send(v))
    .catch((e) => {
      if (e instanceof DomainError) {
        return reply.code(e.httpStatus).send({ error: { code: e.code, message: e.message } });
      }
      return reply.code(500).send({ error: { code: 'INTERNAL', message: e.message } });
    });

  // ---- 会话（读平面 + 显式写）----
  app.get('/api/sessions', (req, reply) => {
    const q = req.query || {};
    const windowDays = q.windowDays !== undefined
      ? Number(q.windowDays)
      : (config.getFilter ? config.getFilter().window_days : 0);
    return wrap(reply, () => plane.listSessions({ all: !!q.all, windowDays }));
  });
  app.get('/api/sessions/:id', (req, reply) => wrap(reply, () => plane.getSession(req.params.id)));
  app.get('/api/sessions/:id/messages', (req, reply) => {
    const q = req.query || {};
    return wrap(reply, () => plane.getMessages(req.params.id, {
      sinceUuid: q.sinceUuid, limit: q.limit ? Number(q.limit) : undefined,
    }));
  });
  app.post('/api/sessions/:id/messages', (req, reply) => wrap(reply, async () => {
    await plane.sendMessage(req.params.id, (req.body || {}).text);
    return { ok: true };
  }, 202));
  app.post('/api/sessions/:id/takeover', (req, reply) => wrap(reply, () => plane.takeover(req.params.id, { force: (req.body || {}).force })));
  app.post('/api/sessions/:id/exit', (req, reply) => wrap(reply, () => plane.exit(req.params.id)));
  app.post('/api/sessions', (req, reply) => wrap(reply, () => plane.run(req.body || {}), 201));

  // ---- SSE ----
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sink = { write: (s) => reply.raw.write(s) };
    sse.add(sink);
    plane.listSessions().then((list) => sse.send(sink, 'status', list)).catch(() => {});
    const hb = setInterval(() => reply.raw.write(':\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(hb); sse.remove(sink); });
  });

  // ---- 信使面板 ----
  if (agent) {
    app.get('/api/agent/enabled', (_req, reply) => reply.send({ enabled: true }));
    app.post('/api/agent/message', (req, reply) => wrap(reply, () => agent.conductor.handle(agent.conversationKey, (req.body || {}).text)));
    app.get('/api/agent/pending', (_req, reply) => wrap(reply, async () => agent.pending.get(agent.conversationKey)));
    app.get('/api/agent/messages', (_req, reply) => wrap(reply, async () => historyToEvents(agent.historyStore.get(agent.conversationKey))));
    app.get('/api/agent/current', (_req, reply) => wrap(reply, async () => ({ sessionId: agent.current ? agent.current.get(agent.conversationKey) : null })));
  } else {
    app.get('/api/agent/enabled', (_req, reply) => reply.send({ enabled: false }));
  }

  // ---- 配置页：LLM provider ----
  app.get('/api/config/llm', (_req, reply) => wrap(reply, async () => {
    const m = config.getMessenger();
    return { ...m, api_key: mask(m.api_key) };
  }));
  app.post('/api/config/llm', (req, reply) => wrap(reply, async () => {
    config.setMessenger(req.body || {});
    return { ok: true };
  }));

  // ---- 配置页：IM 连接器（按平台）----
  app.get('/api/config/im', (_req, reply) => wrap(reply, async () => config.getIm()));
  app.post('/api/config/im', (req, reply) => wrap(reply, async () => {
    config.setIm(req.body || {});
    return { ok: true };
  }));

  // ---- 配置页：时效过滤（Web 与 IM 共用）----
  app.get('/api/config/filter', (_req, reply) => wrap(reply, async () => (config.getFilter ? config.getFilter() : { window_days: 0 })));
  app.post('/api/config/filter', (req, reply) => wrap(reply, async () => {
    if (config.setFilter) config.setFilter(req.body || {});
    return { ok: true };
  }));

  // ---- IM 摄入闸门（供 ACP 薄桥调用，平台无关）----
  // 单独 Bearer 校验（preHandler 只管 /api/*）。
  app.post('/im/handle', async (req, reply) => {
    const provided = extractToken({ headers: req.headers, cookies: req.cookies || {} });
    if (!authOk(provided)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } });
    }
    if (!agent) {
      return reply.send({ ignored: true, reason: 'agent disabled' });
    }
    const body = req.body || {};
    const platform = body.platform || 'dingtalk';
    if (deps.onInbound) {
      deps.onInbound(body.sessionKey, platform);
    }
    const gate = config.getGate(platform);
    const cls = deps.classify(body.text, body.senderId, gate);

    if (cls.action === 'ignore') {
      return reply.send({ ignored: true });
    }
    if (cls.action === 'deny') {
      // 明确告知未授权（而不是静默），便于用户排查白名单
      return reply.send({
        reply: `⛔ 无权限：你的 ${platform} 账号 ID（${cls.senderId || '未知'}）不在允许名单中。\n`
          + `请把它加入 im.platforms.${platform}.allowed_sender_ids（或留空该名单以允许所有人）。`,
        denied: true,
      });
    }
    const routed = cls.text;
    if (!routed) {
      return reply.send({ reply: `用法：${gate.command_prefix || ''} <指令>`.trim() });
    }
    try {
      const ctx = {
        sessionKey: body.sessionKey,
        platform,
        project: config.getProjectName ? config.getProjectName() : undefined,
        chromePath: config.getChromePath ? config.getChromePath() : undefined,
      };
      const result = await agent.conductor.handle(agent.conversationKey, routed, ctx);
      return reply.send({ reply: formatResult(result), kind: result.kind });
    } catch (e) {
      console.error('[agent-connect] /im/handle error:', e && e.message);
      return reply.send({ reply: `处理出错: ${(e && e.message) || e}` });
    }
  });
}

module.exports = { registerRoutes, historyToEvents, mask };
