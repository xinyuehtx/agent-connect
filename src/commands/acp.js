'use strict';

const crypto = require('crypto');
const { loadAppConfig } = require('../lib/app-config');
const { parseSessionKey } = require('../lib/im/session-key');

/**
 * 从 ACP prompt 数组提取纯文本。
 * @param {Array} prompt
 * @returns {string}
 */
function textFromPrompt(prompt) {
  if (!Array.isArray(prompt)) {
    return '';
  }
  return prompt
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/**
 * 把消息转发到 daemon 的 /im/handle，返回回复文本（或忽略）。
 * @param {string} text
 * @returns {Promise<{reply?:string, ignored?:boolean}>}
 */
async function forwardToDaemon(text) {
  const app = loadAppConfig();
  const { host, port, token } = app.web;
  const { conversationId, senderId } = parseSessionKey(process.env.CC_SESSION_KEY);
  const url = `http://${host}:${port}/im/handle`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversationId, senderId, text }),
    });
    if (!r.ok) {
      return { reply: `信使服务返回 ${r.status}` };
    }
    return await r.json();
  } catch (e) {
    return { reply: '信使服务未启动，请先在本机运行 `cc-router serve`。' };
  }
}

/**
 * cc-router acp
 * 作为 cc-connect 的 acp agent：stdio 上的最小 ACP (JSON-RPC 2.0，行分隔) server。
 * 每条钉钉消息 = 一个 session/prompt，转发给 daemon /im/handle，回复经 session/update 流回。
 */
function acp() {
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
  const errorReply = (id, message) => out({
    jsonrpc: '2.0', id, error: { code: -32603, message },
  });

  const handle = async (msg) => {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
        });
        break;
      case 'authenticate':
        reply(id, {});
        break;
      case 'session/new':
        reply(id, { sessionId: crypto.randomUUID() });
        break;
      case 'session/load':
        reply(id, {});
        break;
      case 'session/prompt': {
        const sessionId = params && params.sessionId;
        const text = textFromPrompt(params && params.prompt);
        const res = await forwardToDaemon(text);
        if (res && res.reply) {
          out({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: res.reply } },
            },
          });
        }
        reply(id, { stopReason: 'end_turn' });
        break;
      }
      case 'session/cancel':
        // 无 id 的通知无需回复；有 id 则回空
        if (id !== undefined) reply(id, {});
        break;
      default:
        if (id !== undefined) errorReply(id, `unsupported method: ${method}`);
        break;
    }
  };

  let buf = '';
  let inflight = 0;
  let ended = false;
  const maybeExit = () => { if (ended && inflight === 0) process.exit(0); };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { msg = null; }
        if (msg && msg.method) {
          inflight += 1;
          handle(msg)
            .catch((e) => { if (msg.id !== undefined) errorReply(msg.id, e.message); })
            .finally(() => { inflight -= 1; maybeExit(); });
        }
      }
      nl = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
}

module.exports = acp;
module.exports.textFromPrompt = textFromPrompt;
