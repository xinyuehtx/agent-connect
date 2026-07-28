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
  },
  dingtalk: {
    enabled: true,
    command_prefix: '/ai',
    allowed_sender_ids: [],
    confirm_words: ['确认', '确定', 'yes', 'y', 'ok'],
    cancel_words: ['取消', 'no', 'n'],
    confirm_ttl_ms: 300000,
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

module.exports = {
  DEFAULTS,
  expandHome,
  loadAppConfig,
  saveConfig,
  loadConfig,
  findDingtalkPlatformOptions,
};
