'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/**
 * 探测本机可用的 Chrome/Chromium 可执行文件（用于把文本渲染成图片）。
 * @param {string} [override] 配置里的 chrome_path
 * @returns {string|null}
 */
function findChrome(override) {
  const candidates = [
    override,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const r = spawnSync('command', ['-v', name], { encoding: 'utf8', shell: '/bin/bash' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 把纯文本（如终端 pane）渲染成一张深色"终端截图"PNG。需要本机有 Chrome。
 * @param {string} text
 * @param {object} [opts] { chromePath, title }
 * @returns {string|null} 生成的 png 路径；无渲染器返回 null
 */
function renderTextToImage(text, opts = {}) {
  const chrome = findChrome(opts.chromePath);
  if (!chrome) {
    return null;
  }
  const lines = String(text || '').split('\n');
  const height = Math.min(4000, Math.max(160, lines.length * 20 + 96));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#0d1017}
    .term{padding:20px 22px;font:13px/1.5 "SF Mono",Menlo,Consolas,monospace;color:#e6ebf2;white-space:pre;tab-size:4}
    .bar{display:flex;gap:7px;padding:12px 16px;background:#151a23;border-bottom:1px solid #232b38}
    .dot{width:11px;height:11px;border-radius:50%}
    .r{background:#f0674a}.y{background:#f5a623}.g{background:#38d39f}
    .title{color:#8b97a8;font:12px/1 monospace;margin-left:8px}
  </style></head><body>
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">${escapeHtml(opts.title || 'session')}</span></div>
    <div class="term">${escapeHtml(text)}</div>
  </body></html>`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-shot-'));
  const htmlPath = path.join(dir, 'in.html');
  const pngPath = path.join(dir, `shot-${crypto.randomUUID().slice(0, 8)}.png`);
  fs.writeFileSync(htmlPath, html);
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--force-device-scale-factor=2',
    `--screenshot=${pngPath}`, '--window-size=980,' + height,
    `file://${htmlPath}`,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 || !fs.existsSync(pngPath)) {
    return null;
  }
  return pngPath;
}

/**
 * 经 cc-connect 向当前 IM 会话发送消息/图片（带外，不走 ACP 文本回复）。
 * @param {object} args { sessionKey, project, message, imagePath, ccBin }
 * @returns {{ok:boolean, error?:string}}
 */
function sendViaCcConnect(args = {}) {
  const bin = args.ccBin || 'cc-connect';
  const a = ['send'];
  if (args.project) a.push('-p', args.project);
  if (args.sessionKey) a.push('-s', args.sessionKey);
  if (args.message) a.push('--message', args.message);
  if (args.imagePath) a.push('--image', args.imagePath);
  if (a.length === 1) {
    return { ok: false, error: 'nothing to send' };
  }
  const r = spawnSync(bin, a, { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || '').trim() || `exit ${r.status}` };
  }
  return { ok: true };
}

module.exports = { findChrome, renderTextToImage, sendViaCcConnect, escapeHtml };
