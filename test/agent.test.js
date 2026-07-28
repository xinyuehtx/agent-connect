'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transcript = require('../src/lib/transcript');
const claude = require('../src/lib/agents/claude');
const qoder = require('../src/lib/agents/qoder');
const registry = require('../src/lib/registry');

test('transcript.textFromContent handles string / array / mixed blocks', () => {
  assert.strictEqual(transcript.textFromContent('hi'), 'hi');
  assert.strictEqual(
    transcript.textFromContent([
      { type: 'text', text: 'a' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb',
  );
  assert.strictEqual(transcript.textFromContent([{ type: 'tool_result', content: 'x' }]), '');
  assert.strictEqual(transcript.textFromContent(null), '');
});

test('transcript.summarize extracts last assistant text, tool, counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'mode', mode: 'normal' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '第一个问题' }, timestamp: 1000 }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '旧回复' }, { type: 'tool_use', name: 'Read' }] },
        timestamp: 2000,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '最新回复' }] },
        timestamp: 3000,
      }),
      'broken-json-line',
    ].join('\n'),
  );

  const sum = transcript.summarize(file);
  assert.strictEqual(sum.lastAssistant, '最新回复');
  assert.strictEqual(sum.lastUser, '第一个问题');
  assert.strictEqual(sum.lastTool, 'Read');
  assert.strictEqual(sum.messageCount, 3);
  assert.strictEqual(sum.lastTs, 3000);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude.encodeCwd replaces / and . with -', () => {
  assert.strictEqual(
    claude.encodeCwd('/Users/x/Documents/code/connect'),
    '-Users-x-Documents-code-connect',
  );
  assert.strictEqual(claude.encodeCwd('/Users/x/.qoderwork'), '-Users-x--qoderwork');
});

test('registry.tmuxName derives stable name from tool + short id', () => {
  assert.strictEqual(
    registry.tmuxName('claude', 'cb457534-5088-46f4-bcc2-d19d5693386d'),
    'ccr-claude-cb457534',
  );
});

test('registry.classifyChannel marks dead sessions when process gone', () => {
  const c = registry.classifyChannel({ tool: 'claude', sessionId: 'x'.repeat(36), alive: false });
  assert.strictEqual(c.channel, 'dead');
  assert.strictEqual(c.target, null);
});

test('qoder.isQoderCli matches CLI but not IDE/app/extension', () => {
  assert.ok(qoder.isQoderCli('/Users/x/.local/bin/qodercli -r abc'));
  assert.ok(qoder.isQoderCli('node /Users/x/.local/bin/qodercli -p "hi"'));
  assert.ok(!qoder.isQoderCli('/Applications/Qoder.app/Contents/MacOS/qodercli'));
  assert.ok(!qoder.isQoderCli('/Users/x/.qoderwake/qodercli --type=renderer'));
  assert.ok(!qoder.isQoderCli('/usr/bin/node server.js'));
});

test('qoder.parseSessionId extracts uuid from --resume / --session-id / -r', () => {
  const id = '0c73ac42-e7f3-4c19-b884-64e866f7d622';
  assert.strictEqual(qoder.parseSessionId(`qodercli --resume ${id}`), id);
  assert.strictEqual(qoder.parseSessionId(`qodercli -r ${id} -w /x`), id);
  assert.strictEqual(qoder.parseSessionId(`qodercli --session-id=${id}`), id);
  assert.strictEqual(qoder.parseSessionId('qodercli -p "hello"'), null);
});

test('qoder adapter defaults to snake_case permission mode', () => {
  assert.strictEqual(qoder.defaultMode, 'bypass_permissions');
  assert.strictEqual(claude.defaultMode, 'bypassPermissions');
  assert.deepStrictEqual(qoder.resumeArgs('id', qoder.defaultMode), [
    '-r', 'id', '--permission-mode', 'bypass_permissions',
  ]);
});

test('transcript.searchTranscript finds by full id and by prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-proj-'));
  const proj = path.join(root, '-Users-x-demo');
  fs.mkdirSync(proj, { recursive: true });
  const full = 'abcd1234-e7f3-4c19-b884-64e866f7d622';
  fs.writeFileSync(path.join(proj, `${full}.jsonl`), '{}\n');

  assert.strictEqual(transcript.searchTranscript(root, full), path.join(proj, `${full}.jsonl`));
  assert.strictEqual(transcript.searchTranscript(root, 'abcd1234'), path.join(proj, `${full}.jsonl`));
  assert.strictEqual(transcript.searchTranscript(root, 'nope'), null);

  fs.rmSync(root, { recursive: true, force: true });
});
