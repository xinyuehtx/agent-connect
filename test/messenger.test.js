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
const { extractResult } = require('../src/lib/control-plane');
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
  assert.match(describeAction('exit', { sessionId: 'abcd1234-x' }), /退出并关闭会话 abcd1234/);
});

test('FileCurrentStore get/set/clear (cwd pointer)', () => {
  const { FileCurrentStore } = require('../src/lib/messenger/current-store');
  const store = new FileCurrentStore(tmpFile('cur.json'));
  assert.strictEqual(store.get('k'), null);
  store.set('k', 'sid-123');
  assert.strictEqual(store.get('k'), 'sid-123');
  store.clear('k');
  assert.strictEqual(store.get('k'), null);
});

test('messenger tools: switch_current + forward-defaults-to-current + stale gate', async () => {
  const { buildTools } = require('../src/lib/messenger/agent');
  const staged = [];
  const stage = (kind, params) => { staged.push({ kind, params }); return { staged: true, description: 'x' }; };
  const plane = {
    getSession: async (id) => {
      if (String(id).startsWith('aaaa')) return { sessionId: 'aaaa1111-full', name: 'A', tool: 'claude', status: 'idle' };
      throw new Error('not found');
    },
    listSessions: async () => [],
    getMessages: async () => [],
  };
  const ctx = { currentSessionId: null, setCurrent(id) { this.currentSessionId = id || null; } };
  const tools = buildTools({ plane, stage, tool: (d) => d, ctx });

  // no current yet → forward returns "no current"
  const noCur = await tools.propose_forward.execute({ text: 'go' });
  assert.strictEqual(noCur.ok, false);
  assert.match(noCur.note, /没有「当前会话」/);

  // switch sets current (resolves full id)
  const sw = await tools.switch_current.execute({ sessionId: 'aaaa1111' });
  assert.strictEqual(sw.ok, true);
  assert.strictEqual(ctx.currentSessionId, 'aaaa1111-full');

  // forward now defaults to current
  const fwd = await tools.propose_forward.execute({ text: '继续' });
  assert.strictEqual(fwd.staged, true);
  assert.deepStrictEqual(staged.at(-1), { kind: 'send', params: { sessionId: 'aaaa1111-full', text: '继续' } });

  // current goes stale → gate clears it and warns
  ctx.currentSessionId = 'zzzz9999-gone';
  const stale = await tools.propose_forward.execute({ text: 'x' });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(ctx.currentSessionId, null); // cleared
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

test('notifier: monitor-only GUI agent (qwen) is skipped by default', async () => {
  const { sent, ev } = mkNotifier();
  ev('q', 'busy', { tool: 'qwen' }); // seed
  ev('q', 'idle', { tool: 'qwen' }); // busy→idle but monitor-only → skip
  ev('c', 'busy', { tool: 'claude' }); // seed
  ev('c', 'idle', { tool: 'claude' }); // real agent → notify
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].message, /任务完成/);
});

test('notifier: monitor_only=true re-enables GUI agent notifications', async () => {
  const { sent, ev } = mkNotifier({ monitor_only: true });
  ev('q', 'busy', { tool: 'qwen' }); // seed
  ev('q', 'idle', { tool: 'qwen' }); // now allowed
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 1);
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

test('extractResult: array result event / assistant fallback / single object', () => {
  assert.strictEqual(extractResult(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'done' }])), 'done');
  assert.strictEqual(extractResult(JSON.stringify([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hey' }] } }])), 'hey');
  assert.strictEqual(extractResult(JSON.stringify({ result: 'x' })), 'x');
  assert.strictEqual(extractResult('not json'), 'not json');
});

test('contextExcerpt starts from latest compaction summary (excludes pre-compaction)', () => {
  const { contextExcerpt } = require('../src/lib/transcript');
  const f = tmpFile('compact.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'PRE_COMPACT old message' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'PRE_COMPACT old reply' } }),
    JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'SUMMARY did A B C' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'POST reply after compaction' } }),
  ].join('\n'));
  const r = contextExcerpt(f);
  assert.strictEqual(r.fromCompaction, true);
  assert.match(r.text, /最近一次压缩摘要/);
  assert.match(r.text, /SUMMARY did A B C/);
  assert.match(r.text, /POST reply after compaction/);
  assert.ok(!r.text.includes('PRE_COMPACT'), 'pre-compaction messages excluded');
});

test('contextExcerpt falls back to recent tail when no compaction', () => {
  const { contextExcerpt } = require('../src/lib/transcript');
  const f = tmpFile('nocompact.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi back' } }),
  ].join('\n'));
  const r = contextExcerpt(f);
  assert.strictEqual(r.fromCompaction, false);
  assert.match(r.text, /hello there/);
});

test('qwen adapter: registered, monitor-only (no CLI bin), parses cwd from transcript', () => {
  const { getAdapter } = require('../src/lib/agents');
  const qwen = getAdapter('qwen');
  assert.ok(qwen, 'qwen adapter registered');
  assert.strictEqual(qwen.bin, '', 'qwen has no CLI → monitor-only');
  // cwdFromTranscript reads cwd / workspace-directories from the head
  const f = tmpFile('qwen.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'workspace-directories', directories: ['/Users/x/proj'] }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  ].join('\n'));
  assert.strictEqual(qwen.cwdFromTranscript(f), '/Users/x/proj');
});

test('adapters: qoder(CLI)=controllable dir ~/.qoder, qoderwork(GUI)=monitor-only', () => {
  const { getAdapter } = require('../src/lib/agents');
  const qoder = getAdapter('qoder');
  const qoderwork = getAdapter('qoderwork');
  assert.ok(qoder && qoderwork);
  assert.match(qoder.PROJECTS_DIR, /\.qoder\/projects$/); // CLI data dir fixed (not .qoderwork)
  assert.strictEqual(qoder.bin, 'qodercli'); // controllable
  assert.strictEqual(qoderwork.bin, ''); // GUI → monitor-only
  assert.match(qoderwork.PROJECTS_DIR, /\.qoderwork\/projects$/);
  // isQoderCli matches CLI, excludes the two desktop apps
  assert.ok(qoder.isQoderCli('/usr/local/bin/qoder -r abc'));
  assert.ok(!qoder.isQoderCli('/Applications/QoderWork.app/Contents/MacOS/QoderWork'));
  assert.ok(!qoder.isQoderCli('/Applications/Qoder.app/Contents/MacOS/Qoder'));
});

test('consult_session: read-only fork returns attributed answer; stale gate applies', async () => {
  const { buildTools } = require('../src/lib/messenger/agent');
  const plane = {
    getSession: async (id) => { if (String(id).startsWith('aaaa')) return { sessionId: 'aaaa-full', name: 'A', tool: 'claude' }; throw new Error('gone'); },
    consult: async (id, q) => ({ ok: true, answer: `[fork answer to: ${q}]`, from: { name: 'A', tool: 'claude', short: 'aaaa' } }),
  };
  const ctx = { currentSessionId: 'aaaa-full', setCurrent(v) { this.currentSessionId = v || null; } };
  const tools = buildTools({ plane, stage: () => ({}), tool: (d) => d, ctx });
  const r = await tools.consult_session.execute({ question: '怎么改' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'read-only-fork');
  assert.match(r.from, /A·claude/);
  assert.match(r.answer, /fork answer/);
  // stale current → gated
  ctx.currentSessionId = 'zzzz-gone';
  const stale = await tools.consult_session.execute({ question: 'x' });
  assert.strictEqual(stale.stale, true);
});

/* ---------------- 引用回复（内容层线程绑定） ---------------- */

const { quoteHeader, withQuote } = require('../src/lib/im/quote');

test('quoteHeader: single-line blockquote of the command', () => {
  assert.strictEqual(quoteHeader('列出会话'), '> 🗨️ 你：列出会话\n\n');
});

test('quoteHeader: collapses newlines/whitespace to one line', () => {
  assert.strictEqual(quoteHeader('切到  c233\n再跑测试'), '> 🗨️ 你：切到 c233 再跑测试\n\n');
});

test('quoteHeader: truncates long commands with ellipsis', () => {
  const long = 'x'.repeat(200);
  const h = quoteHeader(long, { max: 20 });
  assert.ok(h.startsWith('> 🗨️ 你：'));
  assert.ok(h.includes('…'));
  // 20 字上限：19 个 x + 省略号
  assert.strictEqual(h, `> 🗨️ 你：${'x'.repeat(19)}…\n\n`);
});

test('quoteHeader: empty/whitespace command → no header', () => {
  assert.strictEqual(quoteHeader(''), '');
  assert.strictEqual(quoteHeader('   \n  '), '');
  assert.strictEqual(quoteHeader(null), '');
});

test('withQuote: prepends header to reply body', () => {
  assert.strictEqual(withQuote('列出会话', '3 个会话'), '> 🗨️ 你：列出会话\n\n3 个会话');
});

test('withQuote: disabled → body unchanged', () => {
  assert.strictEqual(withQuote('列出会话', '3 个会话', false), '3 个会话');
});

test('withQuote: blank body → unchanged (no lone quote line)', () => {
  assert.strictEqual(withQuote('列出会话', ''), '');
  assert.strictEqual(withQuote('列出会话', '   '), '   ');
});

test('gate default: quote_reply is on', () => {
  const g = gateFor({}, 'dingtalk');
  assert.strictEqual(g.quote_reply, true);
});

/* ---------------- conductor 串行化（同一会话不并发） ---------------- */

test('conductor.handle: serializes turns per conversationKey (no overlap)', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const messenger = {
    run: async (key, text) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      order.push(text);
      return `ok:${text}`;
    },
  };
  const pending = new FilePendingStore(tmpFile('pc-ser.json'));
  const cond = new AgentConductor({ messenger, plane: {}, pending });
  // 同一 key 同时发起两轮：必须串行（maxActive===1）且按到达顺序完成
  const [r1, r2] = await Promise.all([
    cond.handle('m', 'A'),
    cond.handle('m', 'B'),
  ]);
  assert.strictEqual(maxActive, 1, '同一会话不得并发执行');
  assert.deepStrictEqual(order, ['A', 'B'], '须按到达顺序处理');
  assert.strictEqual(r1.text, 'ok:A');
  assert.strictEqual(r2.text, 'ok:B');
});

test('conductor.handle: a failed turn does not break the next one', async () => {
  let n = 0;
  const messenger = {
    run: async () => { n += 1; if (n === 1) throw new Error('boom'); return 'second-ok'; },
  };
  const pending = new FilePendingStore(tmpFile('pc-err.json'));
  const cond = new AgentConductor({ messenger, plane: {}, pending });
  const p1 = cond.handle('m', 'first');
  const p2 = cond.handle('m', 'second');
  await assert.rejects(p1, /boom/);
  const r2 = await p2;
  assert.strictEqual(r2.text, 'second-ok');
});

test('conductor.handle: different keys run concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  const messenger = {
    run: async (key, text) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return text;
    },
  };
  const pending = new FilePendingStore(tmpFile('pc-multi.json'));
  const cond = new AgentConductor({ messenger, plane: {}, pending });
  await Promise.all([cond.handle('a', 'x'), cond.handle('b', 'y')]);
  assert.strictEqual(maxActive, 2, '不同会话应可并发');
});

/* ---------------- 回复语言 / 译文 ---------------- */

const {
  langName, obviouslyTarget, scriptStats, makeTranslator,
} = require('../src/lib/messenger/translate');

test('translate.langName maps codes, falls back', () => {
  assert.strictEqual(langName('zh'), '中文');
  assert.strictEqual(langName('en'), 'English');
  assert.strictEqual(langName('xx'), 'xx');
  assert.strictEqual(langName(''), '中文');
});

test('translate.scriptStats counts CJK vs latin', () => {
  const s = scriptStats('你好 hello');
  assert.strictEqual(s.cjk, 2);
  assert.strictEqual(s.latin, 5);
});

test('translate.obviouslyTarget: zh target skips Chinese, flags English', () => {
  assert.strictEqual(obviouslyTarget('这是中文回复', 'zh'), true);
  assert.strictEqual(obviouslyTarget('this is english', 'zh'), false);
  assert.strictEqual(obviouslyTarget('   ', 'zh'), true); // 无可译内容
});

test('translate.obviouslyTarget: en target skips English, flags Chinese', () => {
  assert.strictEqual(obviouslyTarget('this is english', 'en'), true);
  assert.strictEqual(obviouslyTarget('这是中文', 'en'), false);
});

test('makeTranslator returns null for already-target text (no LLM call)', async () => {
  let called = 0;
  const model = { get generateText() { called += 1; return null; } };
  const tr = makeTranslator(model, 'zh');
  assert.strictEqual(await tr('这是中文，无需翻译'), null);
  assert.strictEqual(called, 0, '同语种应快速跳过，不调用模型');
});

test('consult_session appends translation to display when languages differ', async () => {
  const { buildTools } = require('../src/lib/messenger/agent');
  const plane = {
    getSession: async (id) => ({ sessionId: id, name: 'A', tool: 'claude', status: 'idle' }),
    consult: async () => ({ ok: true, answer: 'Fixed the null pointer bug.', from: { name: 'A', tool: 'claude', short: 'aaaa' } }),
  };
  const ctx = { currentSessionId: 'aaaa-full', setCurrent() {} };
  const translate = async (t) => ({ text: `【译】${t}`, to: '中文' });
  const tools = buildTools({
    plane, stage: () => ({}), tool: (d) => d, ctx, translate,
  });
  const r = await tools.consult_session.execute({ question: '改了啥' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.translation, '【译】Fixed the null pointer bug.');
  assert.strictEqual(r.translated_to, '中文');
  assert.match(r.display, /Fixed the null pointer bug\./); // 原文
  assert.match(r.display, /🌐 信使译文（中文）/); // 译文标注
  assert.match(r.display, /【译】Fixed the null pointer bug\./); // 译文内容
});

test('consult_session: no translation → display has original only', async () => {
  const { buildTools } = require('../src/lib/messenger/agent');
  const plane = {
    getSession: async (id) => ({ sessionId: id, name: 'A', tool: 'claude', status: 'idle' }),
    consult: async () => ({ ok: true, answer: '已修复空指针。', from: { name: 'A', tool: 'claude', short: 'aaaa' } }),
  };
  const ctx = { currentSessionId: 'aaaa-full', setCurrent() {} };
  const translate = async () => null; // 同语种
  const tools = buildTools({
    plane, stage: () => ({}), tool: (d) => d, ctx, translate,
  });
  const r = await tools.consult_session.execute({ question: '改了啥' });
  assert.ok(!r.translation);
  assert.match(r.display, /已修复空指针。/);
  assert.doesNotMatch(r.display, /信使译文/);
});

test('read_reply appends translation to display when languages differ', async () => {
  const { buildTools } = require('../src/lib/messenger/agent');
  const plane = {
    getSession: async (id) => ({ sessionId: id, name: 'W', tool: 'claude', status: 'idle' }),
    getMessages: async () => [{ kind: 'assistant', text: 'Build passed, all green.' }],
  };
  const ctx = { currentSessionId: 'bbbb-full', setCurrent() {} };
  const translate = async (t) => ({ text: `【译】${t}`, to: '中文' });
  const tools = buildTools({
    plane, stage: () => ({}), tool: (d) => d, ctx, translate,
  });
  const r = await tools.read_reply.execute({});
  assert.strictEqual(r.translated_to, '中文');
  assert.match(r.display, /Build passed, all green\./);
  assert.match(r.display, /🌐 信使译文（中文）/);
});
