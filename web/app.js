'use strict';
const $ = (id) => document.getElementById(id);

const state = {
  view: 'board',
  sessions: new Map(),
  detailId: null,
  detailKeys: new Set(),
  mKeys: new Set(),
  agentEnabled: false,
  mTimer: null,
  windowDays: 3,
};

const STATUS = {
  busy: { rank: 0, dot: 'busy', label: '运行中', emoji: '🔄' },
  waiting: { rank: 1, dot: 'wait', label: '待输入', emoji: '⏳' },
  idle: { rank: 2, dot: 'idle', label: '空闲', emoji: '✅' },
  unknown: { rank: 3, dot: 'unknown', label: '未知', emoji: '❓' },
  dead: { rank: 4, dot: 'dead', label: '已退出', emoji: '💀' },
};
const st = (s) => STATUS[s.status] || STATUS.unknown;

async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts });
  if (r.status === 401 && path !== '/api/login') showLogin('需要访问令牌。');
  return r;
}

/* ---------- boot ---------- */
async function init() {
  const r = await api('/api/agent/enabled');
  if (r.status === 401) { showLogin(); return; }
  const j = await r.json().catch(() => ({ enabled: false }));
  state.agentEnabled = !!j.enabled;
  boot();
}
function showLogin(msg) { $('login').style.display = 'grid'; $('app').classList.remove('is-ready'); if (msg) $('loginErr').textContent = msg; }
async function doLogin() {
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) });
  if (r.status === 204) location.reload(); else $('loginErr').textContent = '令牌无效。';
}
function boot() {
  $('login').style.display = 'none';
  $('app').classList.add('is-ready');
  loadFilter();
  refreshSessions();
  connectStream();
  setView('board');
}

async function loadFilter() {
  const r = await api('/api/config/filter');
  if (!r.ok) return;
  const j = await r.json().catch(() => ({}));
  state.windowDays = Number(j.window_days || 0);
  $('filterWindow').value = String(state.windowDays);
}
// 时效过滤：运行中/待输入始终显示；其余仅保留最近 windowDays 内的
function withinWindow(s) {
  if (!state.windowDays) return true;
  if (s.status === 'busy' || s.status === 'waiting') return true;
  return s.updatedAt && s.updatedAt >= Date.now() - state.windowDays * 86400000;
}

/* ---------- view switching ---------- */
function setView(v) {
  state.view = v;
  for (const t of document.querySelectorAll('#viewTabs .tab')) t.classList.toggle('is-active', t.dataset.view === v || (v === 'detail' && t.dataset.view === 'board'));
  $('view-board').style.display = v === 'board' ? 'flex' : 'none';
  $('view-detail').style.display = v === 'detail' ? 'flex' : 'none';
  $('view-messenger').style.display = v === 'messenger' ? 'flex' : 'none';
  if (state.mTimer) { clearInterval(state.mTimer); state.mTimer = null; }
  if (v === 'board') renderBoard();
  if (v === 'messenger') openMessenger();
}

/* ---------- sessions / board ---------- */
async function refreshSessions() {
  const r = await api('/api/sessions');
  if (!r.ok) return;
  const list = await r.json();
  state.sessions = new Map(list.map((s) => [s.sessionId, s]));
  if (state.view === 'board') renderBoard();
}
function sortedSessions() {
  return [...state.sessions.values()].filter(withinWindow).sort((a, b) => {
    const r = st(a).rank - st(b).rank;
    return r !== 0 ? r : (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}
function renderFleet() {
  let busy = 0; let wait = 0; let idle = 0;
  for (const s of state.sessions.values()) {
    if (s.status === 'busy') busy += 1; else if (s.status === 'waiting') wait += 1; else if (s.live) idle += 1;
  }
  $('cntBusy').textContent = busy; $('cntWait').textContent = wait; $('cntIdle').textContent = idle;
}
function renderBoard() {
  renderFleet();
  const wrap = $('board');
  wrap.innerHTML = '';
  const sessions = sortedSessions();
  if (!sessions.length) { wrap.innerHTML = '<div class="rail__empty">还没有运行中的会话。</div>'; return; }
  for (const s of sessions) wrap.appendChild(boardCard(s));
}
function boardCard(s) {
  const info = st(s);
  const short = s.sessionId.slice(0, 8);
  const proj = s.cwd ? s.cwd.split('/').slice(-1)[0] : '?';
  const el = document.createElement('div');
  el.className = `card card--${info.dot}${(s.status === 'busy' || s.status === 'waiting') ? ' card--pin' : ''}`;
  el.innerHTML = `
    <div class="card__top">
      <span class="vital-dot is-${info.dot}"></span>
      <span class="card__name"></span>
      <span class="card__badge">${info.emoji} ${info.label}</span>
    </div>
    <div class="card__meta mono"></div>
    <div class="card__last"></div>
    <div class="card__actions"></div>`;
  el.querySelector('.card__name').textContent = s.name || short;
  el.querySelector('.card__meta').textContent = `${s.tool} · ${proj} · ${short} · ${s.channel}`;
  el.querySelector('.card__last').textContent = s.lastUser ? `▸ ${s.lastUser}` : (s.lastAssistant ? s.lastAssistant : '');
  const acts = el.querySelector('.card__actions');
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  acts.appendChild(btn('详情', 'btn--ghost', () => openDetail(s.sessionId)));
  if (s.live && !s.controllable && s.channel !== 'ide') acts.appendChild(btn('接管', 'btn--ghost', () => takeover(s.sessionId)));
  if (s.live) acts.appendChild(btn('退出', 'btn--ghost', () => exitSession(s.sessionId)));
  el.onclick = () => openDetail(s.sessionId);
  return el;
}

/* ---------- detail view ---------- */
async function openDetail(id) {
  state.detailId = id; state.detailKeys = new Set();
  setView('detail');
  renderDetailHeader();
  $('detailMessages').innerHTML = '';
  const r = await api(`/api/sessions/${id}/messages?limit=200`);
  if (r.ok) renderInto('detailMessages', 'detailView', await r.json(), state.detailKeys, true);
}
function renderDetailHeader() {
  const s = state.sessions.get(state.detailId) || { sessionId: state.detailId };
  const info = st(s);
  $('dName').textContent = s.name || state.detailId.slice(0, 8);
  $('dSub').textContent = `${info.emoji} ${info.label} · ${s.tool || '?'} · ${s.cwd || ''}`;
  $('detailInput').placeholder = s.controllable ? '发送到该会话…' : '未托管，先接管才能发送';
  const acts = $('dActions'); acts.innerHTML = '';
  const btn = (label, fn) => { const b = document.createElement('button'); b.className = 'btn btn--ghost'; b.textContent = label; b.onclick = fn; return b; };
  if (s.live && !s.controllable && s.channel !== 'ide') acts.appendChild(btn('接管', () => takeover(state.detailId)));
  if (s.live) acts.appendChild(btn('退出', () => exitSession(state.detailId)));
}
async function detailSend() {
  const t = $('detailInput').value.trim(); if (!t || !state.detailId) return;
  $('detailInput').value = ''; autoGrow($('detailInput'));
  const r = await api(`/api/sessions/${state.detailId}/messages`, { method: 'POST', body: JSON.stringify({ text: t }) });
  if (r.status === 202) toast('已发送'); else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '发送失败'); }
}
async function takeover(id) {
  const r = await api(`/api/sessions/${id}/takeover`, { method: 'POST', body: '{}' });
  if (r.ok) { toast('已接管'); refreshSessions(); if (state.view === 'detail') renderDetailHeader(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '接管失败'); }
}
async function exitSession(id) {
  if (!confirm('退出并关闭该会话（结束进程 + 关闭 tmux 窗口）？')) return;
  const r = await api(`/api/sessions/${id}/exit`, { method: 'POST', body: '{}' });
  if (r.ok) { toast('已退出'); if (state.view === 'detail') setView('board'); refreshSessions(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '退出失败'); }
}
async function newSession() {
  const cwd = prompt('新会话工作目录 (cwd)'); if (!cwd) return;
  const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) });
  if (r.ok) { toast('已创建'); refreshSessions(); } else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '创建失败'); }
}

/* ---------- messenger view ---------- */
async function openMessenger() {
  if (!state.agentEnabled) { $('mMessages').innerHTML = '<div class="rail__empty">信使未启用。</div>'; return; }
  state.mKeys = new Set(); $('mMessages').innerHTML = '';
  await loadMessenger(true);
  await loadPending();
  await loadCurrent();
  state.mTimer = setInterval(() => { if (state.view === 'messenger') { loadMessenger(false); loadCurrent(); } }, 4000);
}
async function loadMessenger(reset) {
  const r = await api('/api/agent/messages'); if (!r.ok) return;
  renderInto('mMessages', 'mView', await r.json(), state.mKeys, reset);
}
async function loadCurrent() {
  const r = await api('/api/agent/current'); if (!r.ok) return;
  const j = await r.json();
  const badge = $('curBadge');
  if (j.sessionId) {
    const s = state.sessions.get(j.sessionId);
    badge.textContent = `📍 当前: ${(s && s.name) || j.sessionId.slice(0, 8)}`;
    badge.style.display = 'inline-block';
  } else badge.style.display = 'none';
}
async function mSend() {
  const t = $('mInput').value.trim(); if (!t) return;
  $('mInput').value = ''; autoGrow($('mInput'));
  pushLocal('mMessages', 'user', '你', t);
  const r = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ text: t }) });
  if (!r.ok) { toast('发送失败'); return; }
  const res = await r.json();
  await loadMessenger(true); await loadCurrent(); handleAgentResult(res);
}
function handleAgentResult(res) {
  if (res.kind === 'staged') showConfirm(res.actions);
  else if (res.kind === 'executed') { hideConfirm(); pushLocal('mMessages', 'system', '系统', (res.results || []).join('\n')); refreshSessions(); }
  else if (res.kind === 'cancelled') { hideConfirm(); pushLocal('mMessages', 'system', '系统', '已取消。'); }
  else if (res.kind === 'expired') { hideConfirm(); pushLocal('mMessages', 'system', '系统', '确认已超时。'); }
}
async function loadPending() {
  const r = await api('/api/agent/pending'); if (!r.ok) return;
  const list = await r.json(); if (list.length) showConfirm(list); else hideConfirm();
}
function showConfirm(actions) {
  const ul = $('confirmList'); ul.innerHTML = '';
  for (const a of actions) { const li = document.createElement('li'); li.textContent = a.description; ul.appendChild(li); }
  $('confirmBox').style.display = 'block';
}
function hideConfirm() { $('confirmBox').style.display = 'none'; }
async function decide(word) {
  const r = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ text: word }) });
  hideConfirm(); if (!r.ok) { toast('操作失败'); return; }
  await loadMessenger(true); handleAgentResult(await r.json());
}

/* ---------- shared message rendering ---------- */
function renderInto(msgId, viewId, events, keys, reset) {
  const box = $(msgId); const view = $(viewId);
  const bottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
  if (reset) { box.innerHTML = ''; keys.clear(); }
  for (const e of events) {
    const k = e.uuid || JSON.stringify(e).slice(0, 40);
    if (keys.has(k)) continue; keys.add(k);
    for (const n of buildNodes(e)) if (n) box.appendChild(n);
  }
  if (!box.childElementCount) box.innerHTML = '<div class="rail__empty" style="margin-top:32px">还没有消息。</div>';
  if (reset || bottom) view.scrollTop = view.scrollHeight;
}
function buildNodes(e) {
  if (e.kind === 'user') return [bubble('user', '你', e.text)];
  if (e.kind === 'assistant') {
    const nodes = [];
    if (e.text && e.text.trim()) nodes.push(bubble('agent', 'Agent', e.text));
    for (const t of (e.toolUses || [])) nodes.push(trace(`调用 ${t.name}`, safeJson(t.input)));
    return nodes;
  }
  if (e.kind === 'tool_result') return [trace('工具结果', e.content, e.isError)];
  return [];
}
function bubble(role, label, text) {
  const w = document.createElement('div'); w.className = `msg msg--${role}`;
  w.innerHTML = '<div class="msg__bubble"><span class="msg__role"></span><span class="msg__body"></span></div>';
  w.querySelector('.msg__role').textContent = label; w.querySelector('.msg__body').textContent = text; return w;
}
function trace(head, body, isError) {
  const el = document.createElement('div'); el.className = 'trace is-collapsed' + (isError ? ' is-error' : '');
  el.innerHTML = '<div class="trace__head"></div><div class="trace__body"></div>';
  const h = el.querySelector('.trace__head'); h.textContent = head + ' ▸';
  el.querySelector('.trace__body').textContent = body;
  h.onclick = () => { el.classList.toggle('is-collapsed'); h.textContent = head + (el.classList.contains('is-collapsed') ? ' ▸' : ' ▾'); };
  return el;
}
function pushLocal(msgId, role, label, text) {
  const box = $(msgId); const hint = box.querySelector('.rail__empty'); if (hint) hint.remove();
  box.appendChild(bubble(role, label, text)); const v = box.parentElement; v.scrollTop = v.scrollHeight;
}
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }

/* ---------- SSE ---------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('conn').classList.add('is-live'); $('connText').textContent = '实时'; };
  es.onerror = () => { $('conn').classList.remove('is-live'); $('connText').textContent = '重连…'; };
  es.addEventListener('status', (ev) => {
    const d = JSON.parse(ev.data);
    if (Array.isArray(d)) state.sessions = new Map(d.map((s) => [s.sessionId, s]));
    else if (d.type === 'session.updated') state.sessions.set(d.session.sessionId, d.session);
    else if (d.type === 'session.removed') state.sessions.delete(d.sessionId);
    renderFleet();
    if (state.view === 'board') renderBoard();
    if (state.view === 'detail' && state.detailId === (d.session && d.session.sessionId)) renderDetailHeader();
  });
  es.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (state.view === 'detail' && m.sessionId === state.detailId) renderInto('detailMessages', 'detailView', [m.event], state.detailKeys, false);
  });
}

/* ---------- settings ---------- */
async function openSettings() {
  $('settingsModal').classList.add('is-open');
  const [llm, im] = await Promise.all([
    api('/api/config/llm').then((r) => r.json()).catch(() => ({})),
    api('/api/config/im').then((r) => r.json()).catch(() => ({})),
  ]);
  $('llm_provider').value = llm.provider || 'openai-compatible';
  $('llm_model').value = llm.model || ''; $('llm_base_url').value = llm.base_url || '';
  $('llm_api_key').value = ''; $('llm_api_key').placeholder = llm.api_key ? `已设置 ${llm.api_key}` : '未设置';
  $('llm_auth').value = llm.auth_style || '';
  $('llm_reply_language').value = llm.reply_language || 'zh';
  $('im_client_id').value = im.client_id || ''; $('im_client_secret').value = '';
  $('im_client_secret').placeholder = im.client_secret ? '已设置' : '未设置';
  $('im_enabled').checked = !!im.enabled; $('im_prefix').value = im.command_prefix || '';
  $('im_allow').value = (im.allowed_sender_ids || []).join(', ');
  $('im_quote').checked = im.quote_reply !== false;
  $('im_reaction').value = im.reaction_emoji || ''; $('im_done').value = im.done_emoji || '';
}
async function saveLlm() {
  const body = { provider: $('llm_provider').value, model: $('llm_model').value.trim(), base_url: $('llm_base_url').value.trim(), auth_style: $('llm_auth').value.trim(), reply_language: $('llm_reply_language').value };
  const k = $('llm_api_key').value.trim(); if (k) body.api_key = k;
  toast((await api('/api/config/llm', { method: 'POST', body: JSON.stringify(body) })).ok ? 'LLM 已保存' : '保存失败');
}
async function saveIm() {
  const body = {
    client_id: $('im_client_id').value.trim(),
    enabled: $('im_enabled').checked,
    command_prefix: $('im_prefix').value.trim(),
    allowed_sender_ids: $('im_allow').value.split(',').map((s) => s.trim()).filter(Boolean),
    quote_reply: $('im_quote').checked,
    reaction_emoji: $('im_reaction').value.trim(),
    done_emoji: $('im_done').value.trim(),
  };
  const sec = $('im_client_secret').value.trim(); if (sec) body.client_secret = sec;
  toast((await api('/api/config/im', { method: 'POST', body: JSON.stringify(body) })).ok ? 'IM 已保存' : '保存失败');
}

/* ---------- misc ---------- */
let toastTimer;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('is-shown'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-shown'), 2600); }
function autoGrow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; }

/* ---------- wire ---------- */
$('loginBtn').onclick = doLogin;
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
for (const t of document.querySelectorAll('#viewTabs .tab')) t.onclick = () => setView(t.dataset.view);
$('newBtn').onclick = newSession;
$('refreshBtn').onclick = refreshSessions;
$('filterWindow').onchange = async (e) => {
  state.windowDays = Number(e.target.value);
  await api('/api/config/filter', { method: 'POST', body: JSON.stringify({ window_days: state.windowDays }) });
  toast(`时效过滤：${state.windowDays ? `近 ${state.windowDays} 天` : '全部'}（同步生效于钉钉）`);
  renderBoard();
};
$('detailBack').onclick = () => setView('board');
$('detailSend').onclick = detailSend;
$('detailInput').addEventListener('input', (e) => autoGrow(e.target));
$('detailInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); detailSend(); } });
$('mSend').onclick = mSend;
$('mRefresh').onclick = () => loadMessenger(true);
$('mInput').addEventListener('input', (e) => autoGrow(e.target));
$('mInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mSend(); } });
$('confirmYes').onclick = () => decide('确认');
$('confirmNo').onclick = () => decide('取消');
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = () => $('settingsModal').classList.remove('is-open');
$('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) $('settingsModal').classList.remove('is-open'); });
$('llmSave').onclick = saveLlm;
$('imSave').onclick = saveIm;
for (const tab of document.querySelectorAll('.modal__tabs .tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.modal__tabs .tab')) t.classList.remove('is-active');
    for (const p of document.querySelectorAll('.tabpane')) p.classList.remove('is-active');
    tab.classList.add('is-active'); $(`tab-${tab.dataset.tab}`).classList.add('is-active');
  };
}
init();
