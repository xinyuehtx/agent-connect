'use strict';
const $ = (id) => document.getElementById(id);

const MESSENGER = { kind: 'messenger' };
const state = {
  agentEnabled: false,
  sessions: new Map(),
  current: null,
  renderedKeys: new Set(),
  messengerTimer: null,
};

async function api(path, opts) {
  const r = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (r.status === 401 && path !== '/api/login') showLogin('会话已失效，请重新登录。');
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
function showLogin(msg) {
  $('login').style.display = 'grid';
  $('app').classList.remove('is-ready');
  if (msg) $('loginErr').textContent = msg;
}
async function doLogin() {
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) });
  if (r.status === 204) location.reload();
  else $('loginErr').textContent = '令牌无效，请重试。';
}
function boot() {
  $('login').style.display = 'none';
  $('app').classList.add('is-ready');
  refreshSessions();
  connectStream();
  if (state.agentEnabled) selectStream(MESSENGER);
}

/* ---------- sessions / rail ---------- */
async function refreshSessions() {
  const r = await api('/api/sessions');
  if (!r.ok) return;
  const list = await r.json();
  state.sessions = new Map(list.map((s) => [s.sessionId, s]));
  renderRail();
}
function fleetCounts() {
  let busy = 0; let idle = 0;
  for (const s of state.sessions.values()) {
    if (!s.live) continue;
    if (s.status === 'busy') busy += 1; else idle += 1;
  }
  return { busy, idle };
}
function renderRail() {
  const wrap = $('streams');
  wrap.innerHTML = '';
  const { busy, idle } = fleetCounts();
  $('cntBusy').textContent = busy;
  $('cntIdle').textContent = idle;

  if (state.agentEnabled) {
    wrap.appendChild(streamCard({
      kind: 'messenger', name: '信使 Agent', meta: '与钉钉共享上下文', vital: 'brand', tag: 'AGENT',
    }));
  }
  const sessions = [...state.sessions.values()];
  if (!sessions.length && !state.agentEnabled) {
    const e = document.createElement('div');
    e.className = 'rail__empty';
    e.textContent = '还没有运行中的会话。';
    wrap.appendChild(e);
    return;
  }
  for (const s of sessions) {
    const vital = !s.live ? 'dead' : (s.status === 'busy' ? 'busy' : 'idle');
    wrap.appendChild(streamCard({
      kind: 'session',
      id: s.sessionId,
      name: s.name || s.sessionId.slice(0, 8),
      meta: `${s.tool} · ${(s.cwd || '?').split('/').slice(-2).join('/')} · ${s.channel}`,
      vital,
      tag: s.controllable ? '可控' : (s.live ? s.channel : '离线'),
      ctl: s.controllable,
    }));
  }
}
function streamCard(o) {
  const el = document.createElement('div');
  el.className = 'stream' + (o.kind === 'messenger' ? ' stream--pin' : '');
  const active = state.current
    && state.current.kind === o.kind
    && (o.kind === 'messenger' || state.current.id === o.id);
  if (active) el.classList.add('is-active');
  el.innerHTML = `<span class="vital-dot is-${o.vital}"></span>
    <div class="stream__body"><div class="stream__name"></div><div class="stream__meta mono"></div></div>
    <span class="stream__tag${o.ctl ? ' is-ctl' : ''}"></span>`;
  el.querySelector('.stream__name').textContent = o.name;
  el.querySelector('.stream__meta').textContent = o.meta;
  el.querySelector('.stream__tag').textContent = o.tag;
  el.onclick = () => selectStream(o.kind === 'messenger' ? MESSENGER : { kind: 'session', id: o.id });
  return el;
}

/* ---------- stream selection ---------- */
async function selectStream(sel) {
  state.current = sel;
  if (state.messengerTimer) { clearInterval(state.messengerTimer); state.messengerTimer = null; }
  renderRail();
  $('placeholder').style.display = 'none';
  $('consoleView').style.display = 'flex';
  $('confirmBox').style.display = 'none';
  renderHeader();
  await loadMessages(true);
  if (sel.kind === 'messenger') {
    await loadPending();
    state.messengerTimer = setInterval(() => {
      if (state.current && state.current.kind === 'messenger') loadMessages(false);
    }, 5000);
  }
}
function renderHeader() {
  const sel = state.current;
  const actions = $('cvActions');
  actions.innerHTML = '';
  if (sel.kind === 'messenger') {
    $('cvName').textContent = '信使 Agent';
    $('cvSub').textContent = '与钉钉共享同一会话上下文 · 变更操作会先请你确认';
    $('composerInput').placeholder = '对信使说…（如：列出会话 / 给 abc 发：继续）';
  } else {
    const s = state.sessions.get(sel.id);
    $('cvName').textContent = (s && s.name) || sel.id.slice(0, 8);
    $('cvSub').textContent = s ? `${statusLabel(s)} · ${s.cwd || ''}` : sel.id;
    $('composerInput').placeholder = s && s.controllable ? '直接发送到该会话…' : '未托管，先接管才能发送';
    if (s && !s.controllable && s.live && s.channel !== 'ide') {
      const b = document.createElement('button');
      b.className = 'btn btn--ghost';
      b.textContent = '接管';
      b.onclick = () => takeover(sel.id);
      actions.appendChild(b);
    }
  }
  const refresh = document.createElement('button');
  refresh.className = 'btn btn--ghost';
  refresh.textContent = '刷新';
  refresh.onclick = () => loadMessages(true);
  actions.appendChild(refresh);
}
function statusLabel(s) {
  if (!s.live) return '离线';
  return s.status === 'busy' ? '运行中' : (s.status === 'idle' ? '空闲' : '未知');
}

/* ---------- messages ---------- */
async function loadMessages(reset) {
  const sel = state.current;
  const url = sel.kind === 'messenger' ? '/api/agent/messages' : `/api/sessions/${sel.id}/messages?limit=200`;
  const r = await api(url);
  if (!r.ok) { if (reset) renderMessages([]); return; }
  const events = await r.json();
  renderMessages(events, reset);
}
function renderMessages(events, reset) {
  const box = $('messages');
  const view = $('streamView');
  const wasBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
  if (reset) { box.innerHTML = ''; state.renderedKeys = new Set(); }
  let added = 0;
  for (const e of events) {
    const key = e.uuid || JSON.stringify(e).slice(0, 40);
    if (state.renderedKeys.has(key)) continue;
    state.renderedKeys.add(key);
    for (const n of buildNodes(e)) if (n) box.appendChild(n);
    added += 1;
  }
  if (!box.childElementCount) {
    const el = document.createElement('div');
    el.className = 'rail__empty';
    el.style.marginTop = '32px';
    el.textContent = state.current.kind === 'messenger' ? '还没有对话。发一句试试。' : '还没有消息。';
    box.appendChild(el);
  }
  if (reset || wasBottom) view.scrollTop = view.scrollHeight;
  return added;
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
  const w = document.createElement('div');
  w.className = `msg msg--${role}`;
  w.innerHTML = '<div class="msg__bubble"><span class="msg__role"></span><span class="msg__body"></span></div>';
  w.querySelector('.msg__role').textContent = label;
  w.querySelector('.msg__body').textContent = text;
  return w;
}
function trace(head, body, isError) {
  const el = document.createElement('div');
  el.className = 'trace is-collapsed' + (isError ? ' is-error' : '');
  el.innerHTML = '<div class="trace__head"></div><div class="trace__body"></div>';
  const h = el.querySelector('.trace__head');
  h.textContent = head + ' ▸';
  el.querySelector('.trace__body').textContent = body;
  h.onclick = () => {
    el.classList.toggle('is-collapsed');
    h.textContent = head + (el.classList.contains('is-collapsed') ? ' ▸' : ' ▾');
  };
  return el;
}
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }

/* ---------- composer / actions ---------- */
async function send() {
  const input = $('composerInput');
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = ''; autoGrow();
  if (state.current.kind === 'messenger') {
    pushLocalUser(text);
    const r = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ text }) });
    if (!r.ok) { toast('发送失败'); return; }
    const res = await r.json();
    await loadMessages(true);
    handleAgentResult(res);
  } else {
    const r = await api(`/api/sessions/${state.current.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    if (r.status === 202) { pushLocalUser(text); toast('已发送'); }
    else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '发送失败'); }
  }
}
function pushLocalUser(text) {
  const box = $('messages');
  const hint = box.querySelector('.rail__empty');
  if (hint) hint.remove();
  box.appendChild(bubble('user', '你', text));
  const v = $('streamView'); v.scrollTop = v.scrollHeight;
}
function handleAgentResult(res) {
  if (res.kind === 'staged') showConfirm(res.actions);
  else if (res.kind === 'executed') { hideConfirm(); appendStatus((res.results || []).join('\n') || '已执行'); refreshSessions(); }
  else if (res.kind === 'cancelled') { hideConfirm(); appendStatus('已取消。'); }
  else if (res.kind === 'expired') { hideConfirm(); appendStatus('确认已超时，请重新发起。'); }
}
function appendStatus(text) {
  $('messages').appendChild(bubble('system', '系统', text));
  const v = $('streamView'); v.scrollTop = v.scrollHeight;
}
async function loadPending() {
  const r = await api('/api/agent/pending');
  if (!r.ok) return;
  const list = await r.json();
  if (list.length) showConfirm(list); else hideConfirm();
}
function showConfirm(actions) {
  const ul = $('confirmList'); ul.innerHTML = '';
  for (const a of actions) { const li = document.createElement('li'); li.textContent = a.description; ul.appendChild(li); }
  $('confirmBox').style.display = 'block';
}
function hideConfirm() { $('confirmBox').style.display = 'none'; }
async function confirmDecision(word) {
  const r = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ text: word }) });
  hideConfirm();
  if (!r.ok) { toast('操作失败'); return; }
  const res = await r.json();
  await loadMessages(true);
  handleAgentResult(res);
}
async function takeover(id) {
  const r = await api(`/api/sessions/${id}/takeover`, { method: 'POST', body: '{}' });
  if (r.ok) { toast('已接管'); refreshSessions(); renderHeader(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '接管失败'); }
}
async function newSession() {
  const cwd = prompt('新会话工作目录 (cwd)');
  if (!cwd) return;
  const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) });
  if (r.ok) { toast('已创建'); refreshSessions(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '创建失败'); }
}

/* ---------- SSE ---------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('conn').classList.add('is-live'); $('connText').textContent = '实时'; };
  es.onerror = () => { $('conn').classList.remove('is-live'); $('connText').textContent = '重连…'; };
  es.addEventListener('status', (ev) => {
    const data = JSON.parse(ev.data);
    if (Array.isArray(data)) state.sessions = new Map(data.map((s) => [s.sessionId, s]));
    else if (data.type === 'session.updated') state.sessions.set(data.session.sessionId, data.session);
    else if (data.type === 'session.removed') state.sessions.delete(data.sessionId);
    renderRail();
  });
  es.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (state.current && state.current.kind === 'session' && m.sessionId === state.current.id) {
      renderMessages([m.event], false);
    }
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
  $('llm_model').value = llm.model || '';
  $('llm_base_url').value = llm.base_url || '';
  $('llm_api_key').value = '';
  $('llm_api_key').placeholder = llm.api_key ? `已设置 ${llm.api_key}（留空不变）` : '未设置';
  $('llm_max_steps').value = llm.max_steps || 8;

  $('im_client_id').value = im.client_id || '';
  $('im_client_secret').value = '';
  $('im_client_secret').placeholder = im.client_secret ? '已设置（留空不变）' : '未设置';
  $('im_enabled').checked = !!im.enabled;
  $('im_prefix').value = im.command_prefix || '';
  $('im_allow').value = (im.allowed_sender_ids || []).join(', ');
  $('im_ttl').value = im.confirm_ttl_ms || 300000;
}
async function saveLlm() {
  const body = {
    provider: $('llm_provider').value,
    model: $('llm_model').value.trim(),
    base_url: $('llm_base_url').value.trim(),
    max_steps: Number($('llm_max_steps').value) || 8,
  };
  const key = $('llm_api_key').value.trim();
  if (key) body.api_key = key;
  const r = await api('/api/config/llm', { method: 'POST', body: JSON.stringify(body) });
  toast(r.ok ? 'LLM 配置已保存' : '保存失败');
}
async function saveIm() {
  const body = {
    client_id: $('im_client_id').value.trim(),
    enabled: $('im_enabled').checked,
    command_prefix: $('im_prefix').value.trim(),
    allowed_sender_ids: $('im_allow').value.split(',').map((s) => s.trim()).filter(Boolean),
    confirm_ttl_ms: Number($('im_ttl').value) || 300000,
  };
  const secret = $('im_client_secret').value.trim();
  if (secret) body.client_secret = secret;
  const r = await api('/api/config/im', { method: 'POST', body: JSON.stringify(body) });
  toast(r.ok ? 'IM 配置已保存' : '保存失败');
}

/* ---------- misc ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('is-shown');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-shown'), 2600);
}
function autoGrow() {
  const t = $('composerInput'); t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`;
}
async function logout() { await api('/api/logout', { method: 'POST' }); showLogin('已退出。'); }

/* ---------- wire ---------- */
$('loginBtn').onclick = doLogin;
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('newBtn').onclick = newSession;
$('sendBtn').onclick = send;
$('composerInput').addEventListener('input', autoGrow);
$('composerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('confirmYes').onclick = () => confirmDecision('确认');
$('confirmNo').onclick = () => confirmDecision('取消');
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = () => $('settingsModal').classList.remove('is-open');
$('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) $('settingsModal').classList.remove('is-open'); });
$('logoutBtn').onclick = logout;
$('llmSave').onclick = saveLlm;
$('imSave').onclick = saveIm;
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('is-active');
    for (const p of document.querySelectorAll('.tabpane')) p.classList.remove('is-active');
    tab.classList.add('is-active');
    $(`tab-${tab.dataset.tab}`).classList.add('is-active');
  };
}

init();
