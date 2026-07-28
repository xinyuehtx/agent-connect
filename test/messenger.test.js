'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FilePendingStore } = require('../src/lib/messenger/pending-store');
const { FileHistoryStore } = require('../src/lib/messenger/history-store');
const { AgentConductor, formatResult } = require('../src/lib/messenger/conductor');
const { describeAction } = require('../src/lib/messenger/describe');
const { classifyMessage, isDecision } = require('../src/lib/im/gate');
const { parseSessionKey } = require('../src/lib/im/session-key');
const { validateProviderConfig } = require('../src/lib/messenger/provider');
const { llmErrorMessage } = require('../src/lib/messenger/agent');
const { historyToEvents, mask } = require('../src/server/routes');
const { toSummary, toEvent } = require('../src/lib/control-plane');
const { gateFor } = require('../src/lib/app-config');
const { escapeHtml, sendViaCcConnect } = require('../src/lib/im/deliver');
const { SessionNotifier } = require('../src/lib/notify/watcher');
const { EventEmitter } = require('node:events');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-')), name);
}

/* ---------------- gate ---------------- */

test('gate.classifyMessage: no prefix routes everything', () => {
  const gate = { enabled: true, command_prefix: '' };
  assert.deepStrictEqual(classifyMessage({ text: '  hi  ', gate }), { action: 'route', text: 'hi' });
});

test('gate.classifyMessage: prefix strips; non-prefixed ignored', () => {
  const gate = { enabled: true, command_prefix: '/ai' };
  assert.deepStrictEqual(classifyMessage({ text: '/ai 列出会话', gate }), { action: 'route', text: '列出会话' });
  assert.strictEqual(classifyMessage({ text: '闲聊', gate }).action, 'ignore');
});

test('gate.classifyMessage: allowlist denies non-members (with clear signal)', () => {
  const gate = { enabled: true, command_prefix: '', allowed_sender_ids: ['u1'] };
  assert.deepStrictEqual(classifyMessage({ text: 'x', senderId: 'u1', gate }), { action: 'route', text: 'x' });
  const denied = classifyMessage({ text: 'x', senderId: 'u2', gate });
  assert.strictEqual(denied.action, 'deny');
  assert.strictEqual(denied.senderId, 'u2');
});

test('gate.classifyMessage: disabled → ignore', () => {
  assert.strictEqual(classifyMessage({ text: 'x', gate: { enabled: false } }).action, 'ignore');
});

test('gate.classifyMessage: bare confirm/cancel routes only when pending exists', () => {
  const gate = {
    enabled: true, command_prefix: '/ai', confirm_words: ['确认'], cancel_words: ['取消'],
  };
  assert.strictEqual(classifyMessage({ text: '确认', gate, pendingCount: 0 }).action, 'ignore');
  assert.deepStrictEqual(classifyMessage({ text: '确认', gate, pendingCount: 1 }), { action: 'route', text: '确认' });
  assert.ok(isDecision('取消', gate));
});

test('app-config.gateFor merges defaults for any platform', () => {
  const raw = { im: { platforms: { telegram: { command_prefix: '/x' } } } };
  const g = gateFor(raw, 'telegram');
  assert.strictEqual(g.command_prefix, '/x');
  assert.ok(Array.isArray(g.confirm_words)); // default merged
  // unknown platform → all defaults (enabled, empty allowlist = allow all)
  assert.strictEqual(gateFor(raw, 'slack').enabled, true);
});

/* ---------------- session-key ---------------- */

test('parseSessionKey: direct with sender', () => {
  assert.deepStrictEqual(parseSessionKey('dingtalk:d:conv123:staff9'), {
    platform: 'dingtalk', scope: 'd', conversationId: 'conv123', senderId: 'staff9',
  });
});

test('parseSessionKey: group without sender', () => {
  assert.deepStrictEqual(parseSessionKey('dingtalk:g:convG'), {
    platform: 'dingtalk', scope: 'g', conversationId: 'convG', senderId: '',
  });
});

test('parseSessionKey: empty/garbage', () => {
  assert.strictEqual(parseSessionKey(undefined).conversationId, '');
  assert.strictEqual(parseSessionKey('').senderId, '');
});

/* ---------------- describe ---------------- */

test('describeAction renders send/takeover/run', () => {
  assert.match(describeAction('send', { sessionId: 'abcd1234-x', text: 'go' }), /向会话 abcd1234 发送: go/);
  assert.match(describeAction('takeover', { sessionId: 'abcd1234-x', force: true }), /接管会话 abcd1234（强制）/);
  assert.match(describeAction('run', { cwd: '/x', prompt: 'test' }), /在 \/x 新建会话，首条: test/);
});

/* ---------------- pending / history stores ---------------- */

test('FilePendingStore get/set/clear', () => {
  const store = new FilePendingStore(tmpFile('p.json'));
  assert.deepStrictEqual(store.get('k'), []);
  store.set('k', [{ id: '1' }]);
  assert.strictEqual(store.get('k').length, 1);
  store.clear('k');
  assert.deepStrictEqual(store.get('k'), []);
});

test('FileHistoryStore truncates to maxMessages', () => {
  const store = new FileHistoryStore(tmpFile('h.json'), 3);
  store.set('k', [1, 2, 3, 4, 5].map((n) => ({ role: 'user', content: String(n) })));
  const got = store.get('k');
  assert.strictEqual(got.length, 3);
  assert.strictEqual(got[0].content, '3');
});

/* ---------------- conductor state machine ---------------- */

function mkConductor(overrides = {}) {
  const executed = [];
  const plane = {
    sendMessage: async (id, text) => { executed.push(['send', id, text]); },
    takeover: async (id) => { executed.push(['takeover', id]); return { sessionId: id }; },
    run: async (o) => { executed.push(['run', o.cwd]); return { sessionId: 'new1234-xxxx' }; },
  };
  const messenger = {
    run: async (key, text, stage) => {
      if (text.includes('发')) { stage('send', { sessionId: 'abcd1234-x', text: '继续' }); return '准备发送'; }
      return '3 个会话';
    },
  };
  let now = 1000;
  const clock = { now: () => now };
  const pending = new FilePendingStore(tmpFile('pc.json'));
  const cond = new AgentConductor({
    messenger, plane, pending, clock, confirmTtlMs: 5000, ...overrides,
  });
  return {
    cond, executed, setNow: (n) => { now = n; }, pending,
  };
}

test('conductor: plain reply when no staged action', async () => {
  const { cond } = mkConductor();
  const r = await cond.handle('m', '列出会话');
  assert.strictEqual(r.kind, 'reply');
  assert.strictEqual(r.text, '3 个会话');
});

test('conductor: stage then confirm executes', async () => {
  const { cond, executed } = mkConductor();
  const staged = await cond.handle('m', '给 abcd 发：继续');
  assert.strictEqual(staged.kind, 'staged');
  assert.strictEqual(staged.actions.length, 1);
  const done = await cond.handle('m', '确认');
  assert.strictEqual(done.kind, 'executed');
  assert.deepStrictEqual(executed, [['send', 'abcd1234-x', '继续']]);
});

test('conductor: cancel drops staged action', async () => {
  const { cond, executed } = mkConductor();
  await cond.handle('m', '给 abcd 发：继续');
  const r = await cond.handle('m', '取消');
  assert.strictEqual(r.kind, 'cancelled');
  assert.strictEqual(executed.length, 0);
});

test('conductor: expired pending after TTL', async () => {
  const { cond, setNow } = mkConductor();
  await cond.handle('m', '给 abcd 发：继续');
  setNow(1000 + 999999);
  const r = await cond.handle('m', '确认');
  assert.strictEqual(r.kind, 'expired');
});

test('conductor: non-decision while pending starts a new turn', async () => {
  const { cond, pending } = mkConductor();
  await cond.handle('m', '给 abcd 发：继续');
  const r = await cond.handle('m', '列出会话');
  assert.strictEqual(r.kind, 'reply');
  assert.deepStrictEqual(pending.get('m'), []);
});

test('conductor: confirmWords/cancelWords/ttl as live getters', async () => {
  let words = ['go'];
  let ttl = 5000;
  const { cond, executed } = mkConductor({
    confirmWords: () => words,
    cancelWords: () => ['nope'],
    confirmTtlMs: () => ttl,
  });
  // default "确认" no longer matches; live word "go" does
  await cond.handle('m', '给 abcd 发：继续');
  const notYet = await cond.handle('m', '确认');
  assert.strictEqual(notYet.kind, 'reply'); // treated as new turn, not a confirm
  // change the live word set, then confirm with it
  await cond.handle('m', '给 abcd 发：继续');
  words = ['确认'];
  const done = await cond.handle('m', '确认');
  assert.strictEqual(done.kind, 'executed');
  assert.strictEqual(executed.length, 1);
});

/* ---------------- formatResult ---------------- */

test('formatResult renders each kind', () => {
  assert.strictEqual(formatResult({ kind: 'reply', text: 'hi' }), 'hi');
  assert.match(formatResult({ kind: 'staged', reply: 'r', actions: [{ description: 'd' }] }), /待执行:\n• d/);
  assert.strictEqual(formatResult({ kind: 'executed', results: ['a', 'b'] }), 'a\nb');
  assert.strictEqual(formatResult({ kind: 'cancelled' }), '已取消。');
  assert.strictEqual(formatResult({ kind: 'expired' }), '确认已超时，请重新发起。');
});

/* ---------------- provider validation ---------------- */

test('validateProviderConfig flags missing base_url/model/key', () => {
  assert.strictEqual(validateProviderConfig({ provider: 'openai-compatible', model: 'm', base_url: '', api_key: 'k' }).ok, false);
  assert.strictEqual(validateProviderConfig({ provider: 'openai-compatible', model: '', base_url: 'u', api_key: 'k' }).ok, false);
  assert.strictEqual(validateProviderConfig({ provider: 'openai-compatible', model: 'm', base_url: 'u', api_key: 'k' }).ok, true);
  // anthropic: base_url optional (defaults to api.anthropic.com), needs model + key
  assert.strictEqual(validateProviderConfig({ provider: 'anthropic', model: 'claude-x', api_key: 'k' }).ok, true);
  assert.strictEqual(validateProviderConfig({ provider: 'anthropic', model: '', api_key: 'k' }).ok, false);
});

/* ---------------- routes helpers ---------------- */

test('mask hides all but last 4', () => {
  assert.strictEqual(mask('secretkey123'), '****y123');
  assert.strictEqual(mask('ab'), '****');
  assert.strictEqual(mask(''), '');
});

test('llmErrorMessage surfaces real reason from responseBody', () => {
  const e = { statusCode: 400, message: '', responseBody: JSON.stringify({ message: '超过了10次/60.0分钟' }) };
  assert.strictEqual(llmErrorMessage(e), '[400] 超过了10次/60.0分钟');
  // falls back to error.message
  assert.strictEqual(llmErrorMessage({ message: 'boom' }), 'boom');
  // handles nested error.message shape
  assert.match(llmErrorMessage({ statusCode: 401, responseBody: JSON.stringify({ error: { message: 'bad key' } }) }), /bad key/);
});

test('deliver.escapeHtml escapes markup', () => {
  assert.strictEqual(escapeHtml('<a>&"b"'), '&lt;a&gt;&amp;"b"');
});

test('deliver.sendViaCcConnect refuses empty payload', () => {
  const r = sendViaCcConnect({});
  assert.strictEqual(r.ok, false);
});

/* ---------------- notifier ---------------- */

function mkNotifier(cfg) {
  const plane = new EventEmitter();
  const sent = [];
  const n = new SessionNotifier({
    plane,
    cfg: {
      enabled: true, scope: 'all', on_needs_confirm: true, on_task_done: true, cooldown_ms: 0, ...cfg,
    },
    runtime: { project: 'messenger' },
    getMessages: async () => [],
    send: (a) => { sent.push(a); return { ok: true }; },
  });
  n.start();
  const ev = (id, status, extra) => plane.emit('event', {
    type: 'session.updated',
    session: {
      sessionId: id, name: 'demo', cwd: '/x/proj', status, controllable: true, ...extra,
    },
  });
  return { sent, ev };
}

test('notifier: only fires on needs-confirm (waiting) and task-done (busy→idle)', async () => {
  const { sent, ev } = mkNotifier();
  ev('a', 'busy'); // seed → no send
  ev('a', 'idle'); // busy→idle → task_done
  ev('b', 'idle'); // seed
  ev('b', 'waiting'); // → needs_confirm
  ev('a', 'busy'); // idle→busy → NOT a trigger
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 2);
  assert.match(sent[0].message, /任务完成/);
  assert.match(sent[1].message, /需要你确认/);
});

test('notifier: seed (first observation) never notifies', async () => {
  const { sent, ev } = mkNotifier();
  ev('x', 'waiting'); // first time we see x → seed only, no send
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 0);
});

test('notifier: scope=controllable skips non-controllable sessions', async () => {
  const { sent, ev } = mkNotifier({ scope: 'controllable' });
  ev('c', 'busy', { controllable: false });
  ev('c', 'idle', { controllable: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 0);
});

test('notifier: disabled does not subscribe', async () => {
  const { sent, ev } = mkNotifier({ enabled: false });
  ev('d', 'busy'); ev('d', 'idle');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 0);
});

test('historyToEvents maps user/assistant + tool calls', () => {
  const events = historyToEvents([
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'list_sessions', input: {} },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1' }] },
  ]);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].kind, 'user');
  assert.strictEqual(events[1].kind, 'assistant');
  assert.strictEqual(events[1].toolUses[0].name, 'list_sessions');
});

/* ---------------- control-plane pure helpers ---------------- */

test('toSummary maps alive/channel to live/controllable', () => {
  const s = toSummary({
    sessionId: 'id', tool: 'claude', alive: true, status: 'idle', channel: 'tmux', cwd: '/x',
  });
  assert.strictEqual(s.live, true);
  assert.strictEqual(s.controllable, true);
  const dead = toSummary({ sessionId: 'id', tool: 'claude', alive: false, channel: 'dead' });
  assert.strictEqual(dead.status, 'dead');
  assert.strictEqual(dead.controllable, false);
});

test('toEvent maps assistant tool_use and user text', () => {
  const a = toEvent({
    type: 'assistant', uuid: 'u1', timestamp: 1,
    message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
  });
  assert.strictEqual(a.kind, 'assistant');
  assert.strictEqual(a.text, 'hi');
  assert.strictEqual(a.toolUses[0].name, 'Bash');
  const u = toEvent({ type: 'user', uuid: 'u2', message: { content: 'q' } });
  assert.strictEqual(u.kind, 'user');
  assert.strictEqual(u.text, 'q');
});
