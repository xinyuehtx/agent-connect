'use strict';

/**
 * 有些 Anthropic 兼容网关（如 idealab 的推理模型 Peach）返回的 thinking 块缺少 signature 字段，
 * 会让 AI SDK 的严格校验在 200 响应上报错。此 fetch 包装：对 JSON 消息响应，剔除缺 signature 的
 * thinking 块（我们只用最终 text，不依赖 reasoning），从而让这类模型可用。流式(SSE)响应原样放行。
 * @returns {typeof fetch}
 */
function makeAnthropicFetch() {
  return async (url, init) => {
    const res = await fetch(url, init);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return res;
    }
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      if (j && Array.isArray(j.content)) {
        j.content = j.content.filter((b) => !(b && b.type === 'thinking' && !b.signature));
      }
      const h = new Headers(res.headers);
      h.delete('content-length');
      return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: h });
    } catch (_) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  };
}

/**
 * 按配置构造 AI SDK 语言模型。
 * 首批支持 openai-compatible（自建网关/兼容端点）与 anthropic；预留 google。
 * @param {object} cfg messenger 配置 { provider, model, api_key, base_url, auth_style }
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
      fetch: makeAnthropicFetch(), // 兼容返回无 signature thinking 块的推理模型
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
