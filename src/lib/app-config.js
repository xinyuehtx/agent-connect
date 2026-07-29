'use strict';

const os = require('os');
const { loadConfig, saveConfig } = require('./config-store');

/**
 * 信使/Web/IM 的默认值。cc-connect 用的 [[projects]] 不在此处规范化。
 */
const DEFAULTS = {
  web: { host: '127.0.0.1', port: 8787, token: '' },
  messenger: {
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    api_key: '',
    base_url: '',
    max_steps: 8,
    conversation_key: 'messenger',
    // 信使回复语言（worker 回复若为其他语种，信使自动附上译文）。默认中文。
    reply_language: 'zh',
  },
  dingtalk: {
    enabled: true,
    command_prefix: '/ai',
    allowed_sender_ids: [],
    confirm_words: ['确认', '确定', 'yes', 'y', 'ok'],
    cancel_words: ['取消', 'no', 'n'],
    confirm_ttl_ms: 300000,
    // 回复时在正文前引用触发指令（内容层「引用回复」，避免多指令线程混乱）。钉钉无原生引用回复。
    quote_reply: true,
  },
  notify: {
    enabled: true,
    scope: 'all', // all | controllable
    on_needs_confirm: true,
    on_task_done: true,
    cooldown_ms: 30000,
  },
  filter: {
    // 已完成/不活跃任务的时效过滤（天）：仅隐藏空闲/退出且超过该时长的会话；运行中/待输入始终显示。0 = 不过滤。
    window_days: 3,
  },
};

/**
 * 展开以 ~ 开头的路径。
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~')
    ? os.homedir() + p.slice(1)
    : p;
}

/**
 * 读取并规范化应用配置（合并默认值）。
 * @returns {{ web:object, messenger:object, im:object, raw:object }}
 */
function loadAppConfig() {
  const raw = loadConfig();
  const im = (raw.im && raw.im.platforms) || {};
  return {
    web: { ...DEFAULTS.web, ...(raw.web || {}) },
    messenger: { ...DEFAULTS.messenger, ...(raw.messenger || {}) },
    im: {
      platforms: {
        dingtalk: { ...DEFAULTS.dingtalk, ...(im.dingtalk || {}) },
      },
    },
    notify: { ...DEFAULTS.notify, ...(raw.notify || {}) },
    filter: { ...DEFAULTS.filter, ...(raw.filter || {}) },
    raw,
  };
}

/**
 * 定位第一个 dingtalk 平台的 options（cc-connect 用的 client_id/secret）。
 * @param {object} raw 原始配置
 * @returns {object|null}
 */
function findDingtalkPlatformOptions(raw) {
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  for (const p of projects) {
    const platforms = Array.isArray(p.platforms) ? p.platforms : [];
    for (const pf of platforms) {
      if (pf.type === 'dingtalk') {
        pf.options = pf.options || {};
        return pf.options;
      }
    }
  }
  return null;
}

/**
 * 取指定 IM 平台的闸门配置（合并默认值）。平台未配置时返回默认（enabled + 空白名单=允许所有）。
 * @param {object} raw 原始配置
 * @param {string} platform 如 'dingtalk' / 'feishu' / 'telegram' / 'slack' ...
 * @returns {object}
 */
function gateFor(raw, platform) {
  const platforms = (raw.im && raw.im.platforms) || {};
  return { ...DEFAULTS.dingtalk, ...(platforms[platform] || {}) };
}

module.exports = {
  DEFAULTS,
  expandHome,
  loadAppConfig,
  saveConfig,
  loadConfig,
  findDingtalkPlatformOptions,
  gateFor,
};
