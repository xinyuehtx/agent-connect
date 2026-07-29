'use strict';

/**
 * 信使回复语言 & 译文。用于「Agent 回复消息」跨语种时，由信使触发一次翻译，
 * 把译文附在原文之后，确保用户同时看到原文与译文。默认目标语言为中文。
 */

// 支持的目标语言（Web 下拉与展示名）
const LANGS = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
  it: 'Italiano',
};

/**
 * 语言码 → 展示名（未知码原样返回，空则回退中文）。
 * @param {string} code
 * @returns {string}
 */
function langName(code) {
  return LANGS[code] || code || '中文';
}

/**
 * 统计 CJK 表意字 / 拉丁字母数量，用于快速判定主语种（省一次 LLM 调用）。
 * @param {string} s
 * @returns {{cjk:number, latin:number, total:number}}
 */
function scriptStats(s) {
  let cjk = 0;
  let latin = 0;
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) {
      cjk += 1;
    } else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      latin += 1;
    }
  }
  return { cjk, latin, total: cjk + latin };
}

/**
 * 文本是否「明显已是目标语种」→ 无需翻译。
 * 仅对 zh/en 这类主场景快速判定；其他语言返回 false，交给模型判断（带 __SAME__ 兜底）。
 * @param {string} text
 * @param {string} lang 目标语言码
 * @returns {boolean}
 */
function obviouslyTarget(text, lang) {
  const { cjk, total } = scriptStats(text);
  if (!total) {
    return true; // 纯符号/数字/代码：无可译内容
  }
  const ratio = cjk / total;
  if (lang === 'zh') {
    return ratio >= 0.5; // 以中文为主
  }
  if (lang === 'en') {
    return ratio <= 0.02; // 几乎无 CJK
  }
  return false;
}

/**
 * 构造一个翻译器：把 worker 文本翻成 targetLang。
 * - 已是目标语种（快速判定或模型判为 __SAME__）→ 返回 null（不翻译）。
 * - 翻译失败 → 返回 null（降级：仅展示原文，绝不阻断回复）。
 * @param {object} model 已构建的 AI SDK 模型（复用信使 provider）
 * @param {string} targetLang 目标语言码（默认 zh）
 * @returns {(text:string)=>Promise<{text:string,to:string}|null>}
 */
function makeTranslator(model, targetLang) {
  const lang = targetLang || 'zh';
  const target = langName(lang);
  return async function translate(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t || obviouslyTarget(t, lang)) {
      return null;
    }
    try {
      const { generateText } = await import('ai');
      const prompt = [
        `You are a professional translator. Target language: ${target}.`,
        `If the TEXT below is already essentially in ${target}, output exactly: __SAME__`,
        `Otherwise output ONLY the ${target} translation. Preserve Markdown structure; DO NOT translate code inside code blocks or inline code.`,
        '',
        'TEXT:',
        t,
      ].join('\n');
      const r = await generateText({ model, prompt });
      const out = (r.text || '').trim();
      if (!out || /^_{0,2}SAME_{0,2}$/.test(out)) {
        return null;
      }
      return { text: out, to: target };
    } catch (e) {
      return null; // 静默降级
    }
  };
}

module.exports = {
  makeTranslator, langName, obviouslyTarget, scriptStats, LANGS,
};
