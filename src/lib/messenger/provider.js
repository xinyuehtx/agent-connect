'use strict';

/**
 * 判断某次响应是否为「限流」。
 * idealab 网关把配额限流（MPE-429 / Throttling.AllocationQuota）包在 HTTP 400 里返回，
 * 而 AI SDK 默认只对 429/5xx 重试，会把 400 当作不可重试的客户端错误直接失败——所以这里要
 * 显式识别「400 里其实是 429」的情况，连同真 429 一起触发退避重试。
 * @param {number} status HTTP 状态码
 * @param {string} bodyText 响应体文本
 * @returns {boolean}
 */
function isThrottleResponse(status, bodyText) {
  if (status === 429) return true;
  if (status === 400 && bodyText) {
    return /MPE-429|限流|Throttling|Allocated quota|"code"\s*:\s*"?429/.test(bodyText);
  }
  return false;
}

const THROTTLE_MAX_RETRIES = 3; // 限流最多重试 3 次（共 4 次尝试）
const THROTTLE_BASE_DELAY_MS = 600; // 退避基数：600ms → 1.2s → 2.4s（另加抖动）

/**
 * 有些 Anthropic 兼容网关（如 idealab 的推理模型 Peach）返回的 thinking 块缺少 signature 字段，
 * 会让 AI SDK 的严格校验在 200 响应上报错。此 fetch 包装：对 JSON 消息响应，剔除缺 signature 的
 * thinking 块（我们只用最终 text，不依赖 reasoning），从而让这类模型可用。流式(SSE)响应原样放行。
 *
 * 另外：对限流（含被包进 400 的 MPE-429）做指数退避重试，最多 {@link THROTTLE_MAX_RETRIES} 次；
 * 用尽后把最后一次响应原样返回，交由上层 llmErrorMessage 生成面向用户的限流提示。
 * @param {{maxRetries?:number, baseDelayMs?:number, sleep?:(ms:number)=>Promise<void>}} [opts]
 * @returns {typeof fetch}
 */
function makeAnthropicFetch(opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : THROTTLE_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs != null ? opts.baseDelayMs : THROTTLE_BASE_DELAY_MS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));

  return async (url, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(url, init);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        return res; // 流式(SSE)响应原样放行
      }
      const text = await res.text();

      // 限流：退避后重试；用尽次数则跳出，返回最后一次响应
      if (isThrottleResponse(res.status, text) && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 200);
        console.error(`[agent-connect] messenger 模型限流，第 ${attempt + 1}/${maxRetries} 次退避重试（${delay}ms）`);
        await sleep(delay);
        continue;
      }

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

module.exports = {
  buildModel, validateProviderConfig, makeAnthropicFetch, isThrottleResponse,
};
