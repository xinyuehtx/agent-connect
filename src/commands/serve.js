'use strict';

const path = require('path');
const crypto = require('crypto');

const { CONFIG_DIR, CONFIG_FILE } = require('../lib/paths');
const {
  loadAppConfig, loadConfig, saveConfig, findDingtalkPlatformOptions,
} = require('../lib/app-config');
const { ControlPlane } = require('../lib/control-plane');
const { SseHub } = require('../server/sse');
const { buildHttp } = require('../server/http');
const { FilePendingStore } = require('../lib/messenger/pending-store');
const { FileHistoryStore } = require('../lib/messenger/history-store');
const { Messenger } = require('../lib/messenger/agent');
const { AgentConductor } = require('../lib/messenger/conductor');
const { routeMessage } = require('../lib/im/gate');
const { validateProviderConfig } = require('../lib/messenger/provider');

/**
 * 确保 web.token 存在（缺失则生成、写回、打印）。
 * @param {object} app 规范化配置
 * @returns {string}
 */
function ensureToken(app) {
  if (app.web.token) {
    return app.web.token;
  }
  const token = crypto.randomBytes(24).toString('hex');
  const raw = loadConfig();
  raw.web = { ...(raw.web || {}), token };
  saveConfig(raw);
  app.web.token = token;
  console.log('');
  console.log('  ┌─ 已生成 Web 访问令牌（首次） ─────────────────');
  console.log(`  │  ${token}`);
  console.log('  └───────────────────────────────────────────────');
  console.log('');
  return token;
}

/**
 * cc-router serve
 * 启动守护：Web 控制台 + 控制面 + 信使栈 + /im/handle 闸门。
 * @param {object} [opts] { host, port }
 */
async function serve(opts = {}) {
  process.on('unhandledRejection', (e) => console.error('[cc-router] unhandledRejection:', e && e.message));

  const app = loadAppConfig();
  const token = ensureToken(app);
  const host = opts.host || app.web.host;
  const port = Number(opts.port || app.web.port);

  // messenger 配置：可变对象，setMessenger 就地更新，Messenger 持引用即热更新
  const messengerCfg = { ...app.messenger };

  const plane = new ControlPlane();
  const sse = new SseHub();
  plane.on('event', (e) => {
    if (e.type === 'message') sse.broadcast('message', e);
    else sse.broadcast('status', e);
  });

  const pending = new FilePendingStore(path.join(CONFIG_DIR, 'pending.json'));
  const historyStore = new FileHistoryStore(path.join(CONFIG_DIR, 'history.json'));
  const messenger = new Messenger({ plane, cfg: messengerCfg, historyStore });
  const conversationKey = messengerCfg.conversation_key || 'messenger';
  const conductor = new AgentConductor({
    messenger,
    plane,
    pending,
    // 实时读取闸门配置：Web 配置页改确认词/超时后立即生效，无需重启
    confirmTtlMs: () => loadAppConfig().im.platforms.dingtalk.confirm_ttl_ms,
    confirmWords: () => loadAppConfig().im.platforms.dingtalk.confirm_words,
    cancelWords: () => loadAppConfig().im.platforms.dingtalk.cancel_words,
    onExecute: (a, ok) => console.log(`[cc-router] execute ${a.kind} ok=${ok}`),
  });

  // 配置 API（Web 配置页用）
  const MSG_FIELDS = ['provider', 'model', 'api_key', 'base_url', 'max_steps', 'conversation_key'];
  const GATE_FIELDS = ['enabled', 'command_prefix', 'allowed_sender_ids', 'confirm_words', 'cancel_words', 'confirm_ttl_ms'];
  const config = {
    getMessenger: () => ({ ...loadAppConfig().messenger }),
    setMessenger: (patch) => {
      const raw = loadConfig();
      raw.messenger = raw.messenger || {};
      for (const k of MSG_FIELDS) {
        if (patch[k] !== undefined && !(k === 'api_key' && patch[k] === '')) {
          raw.messenger[k] = patch[k];
        }
      }
      saveConfig(raw);
      Object.assign(messengerCfg, raw.messenger);
    },
    getIm: () => {
      const gate = loadAppConfig().im.platforms.dingtalk;
      const raw = loadConfig();
      const dt = findDingtalkPlatformOptions(raw) || {};
      return {
        ...gate,
        client_id: dt.client_id || '',
        client_secret: dt.client_secret ? '****' : '',
      };
    },
    setIm: (patch) => {
      const raw = loadConfig();
      raw.im = raw.im || {};
      raw.im.platforms = raw.im.platforms || {};
      raw.im.platforms.dingtalk = raw.im.platforms.dingtalk || {};
      for (const k of GATE_FIELDS) {
        if (patch[k] !== undefined) raw.im.platforms.dingtalk[k] = patch[k];
      }
      const dt = findDingtalkPlatformOptions(raw);
      if (dt) {
        if (patch.client_id !== undefined) dt.client_id = patch.client_id;
        if (patch.client_secret) dt.client_secret = patch.client_secret;
      }
      saveConfig(raw);
    },
    getGate: () => loadAppConfig().im.platforms.dingtalk,
  };

  // /im/handle 的路由闸门（注入 pending 计数以支持裸确认/取消）
  const route = (text, senderId, gate) => routeMessage({
    text, senderId, gate, pendingCount: pending.get(conversationKey).length,
  });

  const server = await buildHttp({
    plane,
    token,
    sse,
    agent: {
      conductor, pending, historyStore, conversationKey,
    },
    config,
    route,
  });

  await plane.start();
  await server.listen({ host, port });

  const v = validateProviderConfig(messengerCfg);
  console.log(`[cc-router] 控制台已启动: http://${host}:${port}`);
  if (!v.ok) {
    console.log(`[cc-router] ⚠ 信使 LLM 未就绪（${v.reason}）——请在控制台「设置 → LLM Provider」中配置。`);
  }
  console.log(`[cc-router] 配置文件: ${CONFIG_FILE}`);

  const shutdown = async (sig) => {
    console.log(`\n[cc-router] ${sig}，正在关闭…`);
    try { await plane.stop(); await server.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = serve;
