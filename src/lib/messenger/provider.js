'use strict';

/**
 * 按配置构造 AI SDK 语言模型。
 * 首批支持 openai-compatible（自建网关/兼容端点）；预留 openai/anthropic/google。
 * @param {object} cfg messenger 配置 { provider, model, api_key, base_url }
 * @returns {Promise<object>} AI SDK LanguageModel
 */
async function buildModel(cfg) {
  const provider = cfg.provider || 'openai-compatible';

  if (provider === 'openai-compatible' || provider === 'openai') {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({
      apiKey: cfg.api_key || process.env.OPENAI_API_KEY || 'sk-none',
      baseURL: cfg.base_url || undefined,
    });
    // openai-compatible 强制走 /chat/completions（多数兼容端点只实现这个）
    return provider === 'openai-compatible' ? openai.chat(cfg.model) : openai(cfg.model);
  }

  if (provider === 'anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    // 部分网关（如内网 token-hub）要求 Authorization: Bearer 而非默认的 x-api-key。
    // 设 auth_style = "bearer" 即改用 Bearer 头。
    const headers = cfg.auth_style === 'bearer'
      ? { authorization: `Bearer ${cfg.api_key}` }
      : undefined;
    const anthropic = createAnthropic({
      apiKey: cfg.api_key || process.env.ANTHROPIC_API_KEY || 'sk-none',
      baseURL: cfg.base_url || undefined, // 留空则用官方 api.anthropic.com；内网网关填 .../v1
      headers,
    });
    return anthropic(cfg.model);
  }

  // 预留：google 等
  // if (provider === 'google') { ... }

  throw new Error(`暂不支持的 messenger.provider: ${provider}（当前支持 openai-compatible / openai / anthropic）`);
}

/**
 * 校验 provider 配置是否可用（用于 Web 配置页/启动提示）。
 * @param {object} cfg
 * @returns {{ ok:boolean, reason?:string }}
 */
function validateProviderConfig(cfg) {
  if (!cfg.model) {
    return { ok: false, reason: '缺少 model' };
  }
  if (cfg.provider === 'openai-compatible' && !cfg.base_url) {
    return { ok: false, reason: 'openai-compatible 需要 base_url' };
  }
  const hasKey = cfg.api_key || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!hasKey) {
    return { ok: false, reason: '缺少 api_key' };
  }
  return { ok: true };
}

module.exports = { buildModel, validateProviderConfig };
