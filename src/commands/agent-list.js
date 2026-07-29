'use strict';

const registry = require('../lib/registry');

const STATUS_EMOJI = {
  busy: '🔄',
  idle: '✅',
  dead: '💀',
  unknown: '❓',
};

const CHANNEL_LABEL = {
  tmux: '🖥  tmux',
  tty: '⌨️  tty',
  ide: '🧩 ide',
  dead: '—',
};

/**
 * 人性化的"多久以前"。
 * @param {number|null} ts
 * @returns {string}
 */
function fmtAge(ts) {
  if (!ts) {
    return '—';
  }
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  return `${Math.floor(s / 3600)}h`;
}

/**
 * agent-connect agent list
 * 列出运行中的 Agent 会话（一对多看板的数据源）。
 * @param {object} opts
 */
function agentList(opts) {
  const sessions = registry.list({ all: !!opts.all });

  if (opts.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (!sessions.length) {
    console.log('没有发现运行中的 Agent 会话。');
    return;
  }

  console.log(`共 ${sessions.length} 个会话：\n`);
  for (const s of sessions) {
    const emoji = STATUS_EMOJI[s.status] || '❓';
    const short = String(s.sessionId).slice(0, 8);
    const proj = s.cwd ? s.cwd.split('/').slice(-2).join('/') : '?';
    const channel = CHANNEL_LABEL[s.channel] || s.channel;
    console.log(`${emoji} ${s.name || short}  [${short}]`);
    console.log(`   ${s.tool} · ${proj} · ${channel} · ${s.status} · ${fmtAge(s.updatedAt)} 前`);
  }
  console.log('\n查看: agent-connect agent read <id>   派活: agent-connect agent send <id> "..."');
}

module.exports = agentList;
