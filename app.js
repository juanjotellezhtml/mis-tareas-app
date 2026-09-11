/* ============================================================
   GESTOR DE TAREAS - PWA
   Arquitectura:
   - Datos compartidos (tareas, bandejas) en tasks.json (repo GitHub)
   - Datos locales (grupos, virtuales, prefs) por usuario
   - Motor IA: Google Gemini API (conversacional)
   ============================================================ */

'use strict';

/* ============ ESTADO ============ */
const LS = {
  token: 'gt_github_token',
  gemini: 'gt_gemini_key',
  repo: 'gt_github_repo',
  user: 'gt_user',
  theme: 'gt_theme',
  model: 'gt_gemini_model',
};

const DEFAULT_MODEL = 'gemini-3.6-flash';

const APP_REPO = 'juanjotellezhtml/mis-tareas-app';

const TASK_STATUSES = ['propuesta', 'pendiente', 'accepted', 'en_progreso', 'completada', 'cancelada'];

let state = {
  user: null,        // { login, name }
  config: null,      // { token, gemini, repo, model }
  data: null,        // shared data from GitHub
  local: null,       // local per-user data (groups, virtuals, prefs)
  chat: [],          // chat history [{role, content}]
  attachments: [],   // pending files for analysis
  aiReady: false,
  lastSync: null,
};

/* ============ HELPERS ============ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function now() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

async function sha256(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toast(msg, type = '') {
  const t = el('div', `toast ${type}`, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function setSyncDot(state2) {
  const ind = $('#sync-indicator');
  ind.className = 'sync-dot ' + state2;
}

/* ============ LOGIN / AUTH ============ */
function loadConfig() {
  return {
    token: localStorage.getItem(LS.token) || '',
    gemini: localStorage.getItem(LS.gemini) || '',
    repo: localStorage.getItem(LS.repo) || '',
    model: localStorage.getItem(LS.model) || DEFAULT_MODEL,
  };
}

function saveConfig(c) {
  localStorage.setItem(LS.token, c.token || '');
  localStorage.setItem(LS.gemini, c.gemini || '');
  localStorage.setItem(LS.repo, c.repo || '');
  localStorage.setItem(LS.model, c.model || DEFAULT_MODEL);
}

function applyTheme() {
  const t = document.documentElement.getAttribute('data-theme') || localStorage.getItem(LS.theme) || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'light' ? '#f1f5f9' : '#111827');
}

async function githubGetUser(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error('Token de GitHub inválido (' + res.status + ')');
  return res.json();
}

async function login() {
  const token = $('#github-token').value.trim();
  const gemini = $('#gemini-key').value.trim();
  const repo = $('#github-repo').value.trim();
  $('#login-error').textContent = '';

  if (!token || !gemini || !repo) { $('#login-error').textContent = 'Completa todos los campos'; return; }

  try {
    const user = await githubGetUser(token);
    const repoFull = normalizeRepo(repo, user.login);
    state.config = { token, gemini, repo: repoFull, model: DEFAULT_MODEL };
    saveConfig(state.config);
    state.user = { login: user.login, name: user.name || user.login };

    // Load theme
    const theme = localStorage.getItem(LS.theme) || 'dark';
    document.documentElement.setAttribute('data-theme', theme);

    await initApp();
    showScreen('screen-app');
    await syncFromGitHub();
    navigate('inbox');
    toast('Bienvenido, ' + (user.name || user.login));
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
}

function logout() {
  localStorage.removeItem(LS.token);
  localStorage.removeItem(LS.gemini);
  localStorage.removeItem(LS.repo);
  localStorage.removeItem(LS.user);
  state = { ...state, user: null, config: null, data: null, local: null };
  $('#screen-app').classList.add('hidden');
  $('#screen-login').classList.remove('hidden');
}

/* ============ ACCESO POR USUARIO Y CONTRASEÑA ============ */
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptConfig(config, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(config)));
  return { v: 1, salt: bufToB64(salt), iv: bufToB64(iv), data: bufToB64(cipher) };
}
async function decryptConfig(payload, password) {
  try {
    const key = await deriveKey(password, b64ToBuf(payload.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(payload.iv) }, key, b64ToBuf(payload.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    throw new Error('Contraseña incorrecta');
  }
}
function credsPath(username) {
  return 'creds/' + encodeURIComponent(username.toLowerCase().trim()) + '.json';
}
function credsRawUrl(username) {
  return 'https://raw.githubusercontent.com/' + APP_REPO + '/main/' + credsPath(username);
}

function initPasswordToggles() {
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.pwdReady) return;
    input.dataset.pwdReady = '1';
    const wrap = el('div', 'pwd-wrap');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = el('button', 'pwd-toggle', '👁');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Mostrar u ocultar contraseña');
    btn.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
    };
    wrap.appendChild(btn);
  });
}

function toggleLoginMode(showCreds) {
  const on = !!showCreds;
  $('#div-creds-login').classList.toggle('hidden', !on);
  $('#div-technical-login').classList.toggle('hidden', on);
  const tg = $('#btn-toggle-login');
  tg.textContent = on ? 'Usar PAT y claves directamente' : '🔑 Entrar con usuario y contraseña';
  tg.classList.toggle('btn-primary', on);
  tg.classList.toggle('btn-outline', !on);
  if (on) $('#creds-user').focus();
}

async function loginWithCreds() {
  const username = $('#creds-user').value.trim();
  const password = $('#creds-pass').value;
  const err = $('#creds-error');
  err.textContent = '';
  if (!username || !password) { err.textContent = 'Introduce tu usuario y contraseña'; return; }
  try {
    const res = await fetch(credsRawUrl(username));
    if (!res.ok) throw new Error('No existe el acceso "' + username + '". Créalo primero en Ajustes de la app.');
    const payload = await res.json();
    const config = await decryptConfig(payload, password);
    if (!config.token || !config.gemini || !config.repo) throw new Error('Los datos de ese acceso no son válidos');
    const user = await githubGetUser(config.token);
    state.config = { token: config.token, gemini: config.gemini, repo: config.repo, model: config.model || DEFAULT_MODEL };
    saveConfig(state.config);
    state.user = { login: user.login, name: user.name || user.login };
    const theme = localStorage.getItem(LS.theme) || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    await initApp();
    showScreen('screen-app');
    await syncFromGitHub();
    navigate('inbox');
    toast('Bienvenido, ' + (user.name || user.login));
  } catch (e) {
    err.textContent = e.message;
  }
}

async function saveAccessCredential() {
  const username = $('#set-creds-user').value.trim();
  const password = $('#set-creds-pass').value;
  const confirm = $('#set-creds-confirm').value;
  const out = $('#set-creds-status');
  out.textContent = '';
  if (!username || !password || !confirm) { out.textContent = 'Completa usuario y contraseña.'; return; }
  if (password !== confirm) { out.textContent = 'Las contraseñas no coinciden.'; return; }
  if (password.length < 6) { out.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
  const c = loadConfig();
  c.token = $('#set-github-token').value || c.token;
  c.gemini = $('#set-gemini-key').value || c.gemini;
  c.repo = normalizeRepo($('#set-github-repo').value, state.user ? state.user.login : '') || c.repo;
  const payload = await encryptConfig({ token: c.token, gemini: c.gemini, repo: c.repo, model: c.model || DEFAULT_MODEL }, password);
  const pathName = credsPath(username);
  try {
    let sha = null;
    try { const existing = await api('/repos/' + APP_REPO + '/contents/' + pathName); sha = existing.sha; }
    catch (e2) { if (e2.status !== 404) throw e2; }
    const body = { message: 'Guardar acceso ' + username, content: bufToB64(new TextEncoder().encode(JSON.stringify(payload))) };
    if (sha) body.sha = sha;
    await api('/repos/' + APP_REPO + '/contents/' + pathName, { method: 'PUT', body: JSON.stringify(body) });
    out.textContent = 'Acceso guardado como "' + username.toLowerCase().trim() + '". Ya puedes entrar desde cualquier dispositivo solo con tu usuario y contraseña.';
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

/* ============ DATA LAYER ============ */
function normalizeRepo(repo, login) {
  repo = (repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!repo) return '';
  // If it's just a repo name (no slash), assume it belongs to the current user
  if (!repo.includes('/')) return login + '/' + repo;
  return repo;
}

function defaultData() {
  return { shared: { tasks: {}, inbox: {}, outbox: {}, analysis: {} }, users: {} };
}

function ensureLocal() {
  if (!state.local) state.local = { groups: {}, prefs: {}, virtuals_pool: {} };
  return state.local;
}

function ensureUserSlot(d) {
  const u = state.user.login;
  if (!d.users[u]) d.users[u] = { groups: {}, prefs: {} };
  return d.users[u];
}

function getMyGroups() {
  const slot = ensureLocal();
  if (!slot.groups || typeof slot.groups !== 'object') slot.groups = {};
  return slot.groups;
}

function getMyInbox() {
  if (!state.data) return [];
  const u = state.user.login;
  return state.data.shared.inbox[u] || [];
}

function getMyOutbox() {
  if (!state.data) return [];
  const u = state.user.login;
  return state.data.shared.outbox[u] || [];
}

function getMyAnalysis() {
  if (!state.data) return [];
  const u = state.user.login;
  return state.data.shared.analysis[u] || [];
}

function saveLocal() {
  localStorage.setItem(LS.user, JSON.stringify(state.local));
}

function backupDataLocal() {
  if (state.data) localStorage.setItem('gt_data_backup', JSON.stringify(state.data));
}

function loadLocal() {
  try { state.local = JSON.parse(localStorage.getItem(LS.user) || 'null') || defaultLocal(); }
  catch (e) { state.local = defaultLocal(); }
}

function defaultLocal() {
  return { groups: {}, prefs: {}, virtuals_pool: {} };
}

/* ============ GITHUB SYNC ENGINE ============ */
async function api(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${state.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || ('Error ' + res.status));
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function fetchFile() {
  try {
    const j = await api(`/repos/${state.config.repo}/contents/tasks.json`);
    if (!j.content) return null;
    return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function writeFile(content, message, providedSha) {
  let sha = providedSha != null ? providedSha : null;
  if (sha == null) {
    try {
      const existing = await api(`/repos/${state.config.repo}/contents/tasks.json`);
      sha = existing.sha;
    } catch (e) { if (e.status !== 404) throw e; }
  }

  const body = { message: message || 'Update tasks', content: b64encode(JSON.stringify(content, null, 2)) };
  if (sha) body.sha = sha;

  await api(`/repos/${state.config.repo}/contents/tasks.json`, { method: 'PUT', body: JSON.stringify(body) });
}

async function syncFromGitHub() {
  setSyncDot('syncing');
  try {
    const f = await fetchFile();
    if (f && f.data) {
      state.data = f.data;
      state.lastSync = now();
      setSyncDot('');
    } else {
      state.data = defaultData();
      await writeFile(state.data, 'Init');
      setSyncDot('');
    }
    renderAll();
    showSyncStatus('ok');
    return true;
  } catch (e) {
    setSyncDot('error');
    console.error(e);
    showSyncStatus('error', e);
    // Fall back to local backup if offline / failed
    if (!state.data) {
      try { const b = localStorage.getItem('gt_data_backup'); if (b) state.data = JSON.parse(b); } catch (e2) {}
    }
    toast('Error de sincronización: ' + e.message, 'error');
    return false;
  }
}

function showSyncStatus(kind, err) {
  const ind = $('#sync-indicator');
  if (kind === 'ok') {
    ind.style.backgroundColor = '';
    ind.title = 'Sincronizado';
  } else if (kind === 'error') {
    setSyncDot('error');
    ind.title = 'Error de sincronización: ' + (err ? err.message : '');
    // Fill current repo for debugging
    const repo = state.config ? state.config.repo : '(configura tu repo)';
    const is404 = err && err.status === 404;
    if (is404) {
      ind.title = 'El repositorio "' + repo + '" no existe o no es accesible. Crealo o revisa el nombre en Ajustes.';
    }
  }
}

async function gitPush(message) {
  setSyncDot('syncing');
  for (let i = 0; i < 3; i++) {
    try {
      // Get latest SHA from server for optimistic locking (do NOT replace local state.data)
      let sha = null;
      try {
        const latest = await fetchFile();
        if (latest) sha = latest.sha;
      } catch (e) { if (e.status !== 404) throw e; }
      // Write the CURRENT local data (which includes any unsaved local changes)
      await writeFile(state.data, message, sha);
      backupDataLocal(); // after successful write, backup is in sync
      setSyncDot('');
      return true;
    } catch (e) {
      if (e.status === 409 && i < 2) { await new Promise((r) => setTimeout(r, 600)); continue; }
      setSyncDot('error');
      backupDataLocal(); // keep a local copy so nothing is lost
      toast('No se pudo sincronizar: ' + e.message, 'error');
      return false;
    }
  }
  return false;
}

/* ============ PERSIST + RENDER ALL ============ */
function renderAll() {
  renderHeader();
  renderInbox();
  renderBoard();
  renderGroups();
}

function renderHeader() {
  if (state.user) {
    $('#user-name').textContent = state.user.name || state.user.login;
    $('#user-login').textContent = '@' + state.user.login;
    $('#avatar').textContent = (state.user.login || '?')[0];
    $('#user-repo').textContent = state.config && state.config.repo ? '📁 ' + state.config.repo : '';
  }
}

/* ============ NAVIGATION ============ */
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
}

function navigate(view) {
  closeSidebar();
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $('#header-title').textContent = { inbox: 'Bandeja de entrada', chat: 'Nueva tarea', board: 'Tablero', groups: 'Grupos', settings: 'Ajustes' }[view] || 'Mis Tareas';
  if (view === 'chat') initChatIfNeeded();
}

function openSidebar() { $('#sidebar').classList.remove('hidden'); setTimeout(() => $('#sidebar').classList.add('open'), 10); $('#sidebar-overlay').classList.remove('hidden'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebar-overlay').classList.add('hidden'); setTimeout(() => $('#sidebar').classList.add('hidden'), 250); }

/* ============ INBOX ============ */
function renderInbox() {
  const inboxEl = $('#view-inbox');
  inboxEl.innerHTML = '';
  const myInbox = getMyInbox();
  const myAnalysis = getMyAnalysis();

  // Inbox count badge
  const pendingInbox = myInbox.filter((i) => i.status === 'pendiente').length;
  const pendingAnalysis = myAnalysis.filter((a) => a.status === 'pendiente').length;
  const totalPending = pendingInbox + pendingAnalysis;
  const badge = $('#badge-inbox');
  if (totalPending > 0) { badge.textContent = totalPending; badge.style.display = ''; } else { badge.style.display = 'none'; }

  if (myInbox.length === 0 && myAnalysis.length === 0) {
    inboxEl.appendChild(el('div', 'empty-state', '<div class="icon">📥</div><p>No tienes nada pendiente.</p><p style="font-size:13px">Toca "Nueva tarea" para enviar un documento o texto.</p>'));
    return;
  }

  // Analysis section
  if (myAnalysis.some((a) => a.status === 'pendiente')) {
    const sec = el('div', 'inbox-section');
    sec.appendChild(el('div', 'inbox-section-title', '📄 Documentos para analizar'));
    myAnalysis.filter((a) => a.status === 'pendiente').forEach((a) => {
      const card = el('div', 'inbox-card item-análisis');
      const n = (a.detected_tasks && a.detected_tasks.length) ? a.detected_tasks.length : (a.detected ? a.detected.length : 0);
      card.innerHTML = `<div class="title">${esc(a.filename || 'Texto pegado')}</div>
        <div class="meta">${timeAgo(a.created_at)} · ${n} tarea(s) detectada(s)</div>
        <div class="desc">${esc((a.objective || a.original_text || '').slice(0, 80))}</div>
        <button class="btn btn-sm btn-primary" data-action="review-analysis" data-id="${esc(a.id)}">🔍 Revisar análisis</button>`;
      card.querySelector('[data-action="review-analysis"]').onclick = () => reviewAnalysis(a.id);
      sec.appendChild(card);
    });
    inboxEl.appendChild(sec);
  }

  // Inbox items section
  if (myInbox.length > 0) {
    const sec = el('div', 'inbox-section');
    sec.appendChild(el('div', 'inbox-section-title', '📋 Tareas asignadas / propuestas'));

    myInbox.forEach((item) => {
      const card = el('div', `inbox-card ${item.status === 'pendiente' ? 'pending' : ''}`);
      const t = item.type || 'propuesta';
      const icon = t === 'asignacion' ? '🔴' : '🟡';
      const task = item.task_id ? (state.data.shared.tasks[item.task_id] || null) : null;

      if (task) {
        const pr = priorityTag(task.priority);
        const st = statusChip(task.status);
        card.innerHTML = `<div class="title">${icon} ${esc(task.title || task.description || 'Tarea')}</div>
          <div class="meta">
            ${task.due_date ? '📅 ' + esc(task.due_date) : 'Sin fecha'}
            ${pr} ${st}
            <br><span>de ${esc(item.from || task.created_by || '?')}</span> · ${timeAgo(item.created_at)}
          </div>
          ${task.description ? `<div class="desc">${esc(task.description)}</div>` : ''}`;
        const btns = el('div', 'icon-btn-group');
        if (item.status === 'pendiente') {
          const accept = el('button', 'btn btn-sm btn-primary', '✅ Aceptar');
          accept.onclick = () => acceptTask(item, task);
          const reject = el('button', 'btn btn-sm btn-danger', '❌ Rechazar');
          reject.onclick = () => rejectTask(item, task);
          btns.appendChild(accept); btns.appendChild(reject);
        } else {
          btns.appendChild(el('span', 'tag tag-baja', 'Respondido'));
        }
        card.appendChild(btns);
      }
      sec.appendChild(card);
    });
    inboxEl.appendChild(sec);
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function timeAgo(iso) {
  if (!iso) return '';
  const t = (Date.now() - new Date(iso).getTime()) / 1000;
  if (t < 60) return 'ahora mismo';
  if (t < 3600) return Math.floor(t / 60) + ' min';
  if (t < 86400) return Math.floor(t / 3600) + ' h';
  return Math.floor(t / 86400) + ' d';
}

function priorityTag(p) {
  const map = { alta: 'tag tag-alta', media: 'tag tag-media', baja: 'tag tag-baja' };
  return `<span class="${map[p] || 'tag tag-baja'}">${esc((p || 'baja').toUpperCase())}</span>`;
}

function statusChip(s) {
  return `<span class="status-chip status-${esc(s || 'pendiente')}">${esc((s || 'pendiente').replace('_', ' '))}</span>`;
}

/* ============ ACCEPT / REJECT TASKS ============ */
async function acceptTask(item, task) {
  // Aceptar propuesta desde bandeja de entrada
  // Actualizar participantes
  const u = state.user.login;
  const part = task.participants || {};
  if (!part[u]) part[u] = {};
  part[u].status = 'accepted';
  part[u].responded_at = now();
  task.participants = part;

  // If created_by == the accepting user, this was a proposal
  if (task.created_by === u && task.status === 'propuesta' || task.status === 'pendiente') {
    // Keep as pending/owned
    // The accepting user takes responsibility; if assigned to self
    if (task.assigned_to === u || !task.assigned_to) {
      task.status = task.status === 'propuesta' ? 'aceptada' : task.status;
    }
  }

  // Mark inbox item responded
  item.status = 'respondido';
  item.responded_at = now();
  item.action = 'aceptada';

  if (await gitPush('Aceptar tarea por ' + u)) {
    // Create calendar event if connected
    tryAddToCalendar(task);
    renderAll();
    toast('Tarea aceptada ✔');
  }
}

async function rejectTask(item, task) {
  const u = state.user.login;
  const part = task.participants || {};
  if (part[u]) { part[u].status = 'rechazada'; part[u].responded_at = now(); }
  task.participants = part;
  item.status = 'respondido';
  item.responded_at = now();
  item.action = 'rechazada';
  if (await gitPush('Rechazar tarea por ' + u)) {
    renderAll();
    toast('Tarea rechazada');
  }
}

/* ============ CHAT / GEMINI ============ */
let chatInit = false;
function initChatIfNeeded() {
  if (chatInit) return;
  chatInit = true;
  const body = $('#chat-body');
  const welcome = el('div', 'chat-msg bot', '<p>¡Hola! Soy tu asistente de tareas. 👋</p><p>Adjunta un documento (PDF, imagen, captura) o escribe directamente qué necesitas hacer. Por ejemplo: <i>"Clasificar los gastos de este extracto, los familiares requieren una transferencia"</i>.</p><p>Iremos dialogando hasta acordar la tarea, y al final la guardaré en tu bandeja de entrada.</p>');
  body.appendChild(welcome);
}

function addAttachment(file) {
  state.attachments.push({ file, name: file.name || 'captura' });
  renderAttachmentPills();
}

function removeAttachment(idx) {
  state.attachments.splice(idx, 1);
  renderAttachmentPills();
}

function renderAttachmentPills() {
  const body = $('#chat-body');
  // Remove existing pills container if present
  const old = $('#attach-pills');
  if (old) old.remove();
  if (state.attachments.length === 0) return;
  const pills = el('div', 'chat-msg user', '');
  pills.id = 'attach-pills';
  state.attachments.forEach((a, i) => {
    const pill = el('span', 'attachment-pill', `📎 ${esc(a.name)} <span class="remove" data-idx="${i}">✕</span>`);
    pill.querySelector('.remove').onclick = () => removeAttachment(i);
    pills.appendChild(pill);
  });
  body.appendChild(pills);
  body.scrollTop = body.scrollHeight;
}

function addChatMsg(role, html) {
  const body = $('#chat-body');
  const m = el('div', 'chat-msg ' + role, html);
  body.appendChild(m);
  body.scrollTop = body.scrollHeight;
  return m;
}

function showTyping() {
  const body = $('#chat-body');
  const m = el('div', 'chat-msg bot');
  m.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  body.appendChild(m);
  body.scrollTop = body.scrollHeight;
  return m;
}

async function sendChatMessage() {
  const text = $('#chat-text').value.trim();
  $('#chat-text').value = '';
  if (!text && state.attachments.length === 0) return;

  // Show user message
  if (text) addChatMsg('user', esc(text));
  if (state.attachments.length > 0) {
    const names = state.attachments.map((a) => a.name).join(', ');
    addChatMsg('user', '📎 Adjunté: ' + esc(names));
  }

  const typing = showTyping();
  const sendBtn = $('#btn-chat-send');
  sendBtn.classList.add('loading');
  sendBtn.disabled = true;

  try {
    // Build message with content parts
    const contents = [];
    if (text) contents.push(text);

    // Attach images/base64 (Gemini supports inline)
    for (const at of state.attachments) {
      const isImage = (at.file.type || '').startsWith('image/');
      const isPdf = at.file.type === 'application/pdf' || at.file.name.toLowerCase().endsWith('.pdf');
      if (isImage || isPdf) {
        const data = await readFileAsBase64(at.file);
        contents.push({
          inline_data: {
            mime_type: isPdf ? 'application/pdf' : at.file.type,
            data,
          },
        });
      } else {
        const txt = await readFileAsText(at.file);
        contents.push('--- Archivo: ' + at.name + ' ---\n' + txt);
      }
    }

    state.chat.push({ role: 'user', parts: contents });

    const aiText = await callGemini(state.chat, systemPromptForConversation());
    typing.remove();
    const m = addChatMsg('bot', '');
    m.innerHTML = renderAiResponse(aiText);
    wireProposalButtons(m);
    state.chat.push({ role: 'model', parts: [{ text: aiText }] });

    // Attachments consumed; keep for clarity but clear after send
    state.attachments = [];
    const pills = $('#attach-pills'); if (pills) pills.remove();
  } catch (e) {
    typing.remove();
    addChatMsg('bot', '⚠️ <b>Error:</b> ' + esc(e.message));
  } finally {
    sendBtn.classList.remove('loading');
    sendBtn.disabled = false;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result || '');
    r.onerror = reject;
    r.readAsText(file);
  });
}

/* ---- AI Response rendering: allow task proposal buttons ---- */
function renderAiResponse(text) {
  let safe = esc(text);
  // Convert markdown-ish
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  safe = safe.replace(/\n/g, '<br>');
  return safe;
}

function wireProposalButtons(msgEl) {
  // Add buttons
  const btnRow = el('div', 'btn-group');
  const proposalBtn = el('button', 'btn btn-sm btn-primary', '📥 Enviar propuestas a mi bandeja');
  proposalBtn.onclick = async () => {
    await saveProposalsFromChat();
  };
  btnRow.appendChild(proposalBtn);
  msgEl.appendChild(btnRow);
}

async function saveProposalsFromChat() {
  // Take last AI message, ask Gemini to output JSON tasks, then save
  const typing = showTyping();
  try {
    const system = systemPromptForExtract();
    const conv = state.chat.slice();
    conv.push({
      role: 'user',
      parts: [{ text: 'En base a la conversación anterior, extrae las tareas ACORDADAS y devuélvelas como JSON en este formato exacto (solo JSON, sin texto adicional, usa TODAS las tareas que el asistente propuso y el usuario confirmó):\n{"tasks":[{"title":"...","description":"...","due_date":"YYYY-MM-DD o null","due_time":"HH:MM en formato 24h o null si no se especifica","priority":"alta|media|baja"}]}' }],
    });
    const aiText = await callGemini(conv, system);
    typing.remove();

    const parsed = extractJson(aiText);
    if (!parsed || !parsed.tasks || parsed.tasks.length === 0) {
      addChatMsg('bot', '⚠️ No pude extraer tareas. Inténtalo de nuevo.');
      return;
    }
    addChatMsg('bot', '✅ Propuestas generadas:<br>' + parsed.tasks.map((t, i) => `${i + 1}. <b>${esc(t.title)}</b> ${t.due_date ? '📅 ' + esc(t.due_date) : ''}`).join('<br>'));
    confirmProposalsModal(parsed.tasks);
  } catch (e) {
    typing.remove();
    toast('Error: ' + e.message, 'error');
  }
}

function confirmProposalsModal(tasks) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const backdrop = el('div', 'modal-backdrop center');
  // Default group
  const myGroups = getMyGroups();
  const groupIds = Object.keys(myGroups);

  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', 'Confirmar tareas propuestas'));
  modal.appendChild(el('p', 'hint', 'Revisa y confirma las tareas que se añadirán a tu lista'));

  const taskForms = [];
  tasks.forEach((t, i) => {
    const box = el('div', 'proposal');
    box.innerHTML = `
      <div class="p-title">Tarea ${i + 1}</div>
      <div class="p-fields">
        <div class="field"><label>Título</label><input type="text" class="t-title" value="${esc(t.title || '')}"></div>
        <div class="field"><label>Descripción</label><textarea class="t-desc" rows="2">${esc(t.description || '')}</textarea></div>
        <div class="field"><label>Fecha (YYYY-MM-DD)</label><input type="date" class="t-date" value="${esc(t.due_date || '')}"></div>
        <div class="field"><label>Hora (opcional)</label><input type="time" class="t-time" value="${esc(t.due_time || '')}"></div>
        <div class="field"><label>Prioridad</label>
          <select class="t-priority">
            <option value="alta" ${t.priority === 'alta' ? 'selected' : ''}>Alta</option>
            <option value="media" ${t.priority === 'media' || !t.priority ? 'selected' : ''}>Media</option>
            <option value="baja" ${t.priority === 'baja' ? 'selected' : ''}>Baja</option>
          </select>
        </div>
        <div class="field"><label>Grupo</label>
          <select class="t-group">
            ${groupIds.length ? groupIds.map((g) => `<option value="${esc(g)}">${esc(myGroups[g].name)}</option>`).join('') : '<option value="__default__">(sin grupo)</option>'}
          </select>
        </div>
      </div>`;
    taskForms.push(box);
    modal.appendChild(box);
  });

  const actions = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-outline', 'Cancelar');
  cancel.onclick = () => root.innerHTML = '';
  const confirm = el('button', 'btn btn-primary', '✅ Crear tareas');
  confirm.onclick = async () => {
    const finalTasks = taskForms.map((box, i) => ({
      title: box.querySelector('.t-title').value.trim() || ('Tarea ' + (i + 1)),
      description: box.querySelector('.t-desc').value.trim(),
      due_date: box.querySelector('.t-date').value || null,
      due_time: box.querySelector('.t-time').value || null,
      priority: box.querySelector('.t-priority').value || 'media',
      group_id: box.querySelector('.t-group').value === '__default__' ? null : box.querySelector('.t-group').value,
    }));
    root.innerHTML = '';
    await createTasksFromProposals(finalTasks);
  };
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
}

async function createTasksFromProposals(tasks) {
  const u = state.user.login;
  for (const t of tasks) {
    const id = uuid();
    const task = {
      id,
      title: t.title,
      description: t.description || '',
      status: 'pendiente',
      priority: t.priority || 'media',
      due_date: t.due_date,
      due_time: t.due_time || null,
      group_id: t.group_id,
      created_by: u,
      created_at: now(),
      updated_at: now(),
      source: 'bandeja',
      assigned_to: u,
      participants: {},
      shared_with: [],
    };
    // Owner implicitly accepted own task
    task.participants[u] = { status: 'accepted', responded_at: now(), auto: true };
    state.data.shared.tasks[id] = task;
  }
  if (await gitPush('Nuevas tareas por ' + u)) {
    renderAll();
    toast(tasks.length + ' tarea(s) creada(s) ✔');
  }
}

/* ============ GEMINI API ============ */
function systemPromptForConversation() {
  return `Eres un asistente personal experto en convertir documentos, textos e imágenes en tareas concretas para una familia.
La conversación es en español.
Tu objetivo: entender qué necesita hacer el usuario a partir de lo que adjunta o escribe, y dialogar con él hasta acordar UNO O MÁS tareas reales, concretas y accionables.
Cuando el usuario adjunte un documento (recibo, extracto, carta, foto...), analízalo y ayúdale a identificar qué tareas se derivan.
Pide aclaraciones si falta información (ej. el destinatario de una transferencia, la fecha límite).
No inventes datos que no estén en el documento; pregunta.
Al final, cuando esté acordado, di algo como "¿Quieres que guarde estas tareas en tu bandeja?".
Responde de forma natural y breve.`;
}

function systemPromptForExtract() {
  return `Eres un extractor de tareas. Recibes el resultado de una conversación y debes devolver EXCLUSIVAMENTE un objeto JSON válido con el formato:
{"tasks":[{"title":"...","description":"...","due_date":"YYYY-MM-DD o null","due_time":"HH:MM en formato 24h o null si no se especifica","priority":"alta|media|baja"}]}
No añadas texto fuera del JSON.`;
}

async function callGemini(messages, system) {
  const model = state.config.model || DEFAULT_MODEL;
  const contents = messages.map((m) => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: Array.isArray(m.parts) ? m.parts.map(normalizePart) : [{ text: m.parts || m.content || '' }],
  }));

  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(state.config.gemini);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) {
    const msg = (j.error && j.error.message) || ('Error ' + res.status);
    throw new Error(msg);
  }
  try {
    return j.candidates[0].content.parts.map((p) => p.text || '').join('');
  } catch (e) {
    throw new Error('Respuesta vacía de Gemini');
  }
}

function normalizePart(p) {
  if (typeof p === 'string') return { text: p };
  if (p.inline_data) return { inline_data: { mime_type: p.inline_data.mime_type, data: p.inline_data.data } };
  return { text: p.text || '' };
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) {
    // try to fix single quotes
    try { return JSON.parse(m[0].replace(/[{,]\s*'([^']+)'\s*:/g, ',"$1":')); } catch (e2) { return null; }
  }
}

/* ============ REVIEW ANALYSIS ============ */
function reviewAnalysis(id) {
  const items = getMyAnalysis();
  const a = items.find((x) => x.id === id);
  if (!a) return;
  const root = $('#modal-root');
  root.innerHTML = '';
  const backdrop = el('div', 'modal-backdrop center');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', 'Revisar análisis'));

  const dets = a.detected_tasks || a.detected || [];

  modal.appendChild(el('p', '', '<b>Original:</b><br>' + esc((a.original_text || '').slice(0, 300))));

  if (dets.length === 0) {
    modal.appendChild(el('p', 'hint', 'No se detectaron tareas en este documento.'));
  } else {
    dets.forEach((d, i) => {
      modal.appendChild(el('div', 'proposal', `<div class="p-title">${i + 1}. ${esc(d.title || d)}</div>
        <div class="p-meta">${d.date ? '📅 ' + esc(d.date) : ''} ${d.priority ? priorityTag(d.priority) : ''}</div>`));
    });
  }

  const actions = el('div', 'modal-actions');
  const btnAdd = el('button', 'btn btn-primary', '📥 Añadir a tareas');
  btnAdd.onclick = async () => {
    const tasks = dets.map((d) => ({ title: d.title || String(d), description: '', due_date: d.date || null, priority: d.priority || 'media' }));
    root.innerHTML = '';
    await confirmProposalsModal(tasks);
    a.status = 'procesado';
  };
  const cls = el('button', 'btn btn-outline', 'Cerrar');
  cls.onclick = () => root.innerHTML = '';
  actions.appendChild(cls);
  actions.appendChild(btnAdd);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
}

/* ============ BOARD ============ */
function renderBoard() {
  const cols = $('#board-columns');
  cols.innerHTML = '';
  if (!state.data) return;

  const myTasks = Object.values(state.data.shared.tasks || {});
  const statusFilter = $('#filter-status').value;
  const groupFilter = $('#filter-group').value;
  const search = ($('#board-search').value || '').toLowerCase();

  // Build group filter options
  const myGroups = getMyGroups();
  const myGroupIds = Object.keys(myGroups);
  const fg = $('#filter-group');
  const current = fg.value;
  fg.innerHTML = '<option value="all">Todos los grupos</option>' + myGroupIds.map((g) => `<option value="${esc(g)}">${esc(myGroups[g].name)}</option>`).join('') + '<option value="none">Sin grupo</option>';
  fg.value = myGroupIds.includes(current) ? current : 'all';

  // Show tasks I created or I'm a participant of
  const u = state.user.login;

  const mine = myTasks.filter((t) => {
    if (t.created_by === u || (t.assigned_to === u)) return true;
    if (t.participants && t.participants[u]) return true;
    return false;
  });

  const filtered = mine.filter((t) => {
    if (groupFilter === 'all') {}
    else if (groupFilter === 'none') { if (t.group_id) return false; }
    else { if (t.group_id !== groupFilter) return false; }
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (search && !((t.title || '').toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search))) return false;
    return true;
  });

  const statuses = ['pendiente', 'en_progreso', 'completada'];
  const statusTitles = { pendiente: 'Pendiente', en_progreso: 'En progreso', completada: 'Completada' };

  statuses.forEach((st) => {
    const colTasks = filtered.filter((t) => t.status === st);
    const col = el('div', 'board-col');
    col.appendChild(el('div', 'board-col-title', `<span>${statusTitles[st]}</span><span class="count">${colTasks.length}</span>`));
    if (colTasks.length === 0) col.appendChild(el('div', 'empty-state', '<p style="font-size:12px">Sin tareas</p>'));
    colTasks.forEach((t) => col.appendChild(taskCard(t)));
    cols.appendChild(col);
  });
}

function taskCard(t) {
  const card = el('div', 'task-card' + (t.due_date && t.due_date < todayStr() && t.status !== 'completada' ? ' overdue' : ''));
  const assigneeName = participantName(t.assigned_to);
  card.innerHTML = `
    <div class="title">${esc(t.title || t.description || 'Tarea')}</div>
    <div class="meta">${t.due_date ? '📅 ' + esc(t.due_date) + (t.due_time ? ' ⏰ ' + esc(t.due_time) : '') : 'Sin fecha'} ${priorityTag(t.priority || 'media')} ${statusChip(t.status)}</div>
    ${assigneeName ? `<div class="assigned">👤 ${esc(assigneeName)}</div>` : ''}
    <div class="actions">
      <button class="btn btn-sm btn-outline" data-a="edit" data-id="${esc(t.id)}">✏️</button>
      ${advanceBtn(t)}
      <button class="btn btn-sm btn-outline" data-a="del" data-id="${esc(t.id)}">🗑️</button>
    </div>`;
  card.querySelector('[data-a="edit"]').onclick = () => editTaskModal(t.id);
  card.querySelector('[data-a="del"]').onclick = () => deleteTask(t.id);
  const adv = card.querySelector('[data-a="advance"]');
  if (adv) { const id = t.id; adv.onclick = () => advanceStatus(id); }
  const rwd = card.querySelector('[data-a="rewind"]');
  if (rwd) { const id = t.id; rwd.onclick = () => rewindStatus(id); }
  return card;
}

function advanceBtn(t) {
  let out = '';
  if (t.status === 'en_progreso' || t.status === 'completada') {
    out += '<button class="btn btn-sm btn-outline" data-a="rewind" data-id="' + esc(t.id) + '">◀</button>';
  }
  if (t.status === 'pendiente') out += '<button class="btn btn-sm btn-outline" data-a="advance" data-id="' + esc(t.id) + '">▶</button>';
  if (t.status === 'en_progreso') out += '<button class="btn btn-sm btn-outline" data-a="advance" data-id="' + esc(t.id) + '">✔</button>';
  return out;
}

function participantName(login) {
  if (!login) return '';
  // If it's a virtual member, show its name
  const myGroups = getMyGroups();
  for (const g of Object.keys(myGroups)) {
    const vm = myGroups[g].virtual_members || {};
    if (vm[login]) return vm[login].display_name + ' (virtual)';
  }
  return login;
}

async function advanceStatus(id) {
  const t = state.data.shared.tasks[id];
  if (!t) return;
  if (t.status === 'pendiente') t.status = 'en_progreso';
  else if (t.status === 'en_progreso') t.status = 'completada';
  t.updated_at = now();
  if (await gitPush('Cambiar estado ' + id)) { renderAll(); }
}

async function rewindStatus(id) {
  const t = state.data.shared.tasks[id];
  if (!t) return;
  if (t.status === 'en_progreso') t.status = 'pendiente';
  else if (t.status === 'completada') t.status = 'en_progreso';
  t.updated_at = now();
  if (await gitPush('Reabrir estado ' + id)) { renderAll(); }
}

async function deleteTask(id) {
  if (!confirm('¿Borrar esta tarea?')) return;
  delete state.data.shared.tasks[id];
  if (await gitPush('Borrar tarea ' + id)) { renderAll(); }
}

function editTaskModal(id) {
  const t = state.data.shared.tasks[id];
  if (!t) return;
  const root = $('#modal-root');
  root.innerHTML = '';
  const backdrop = el('div', 'modal-backdrop center');
  const modal = el('div', 'modal');
  const myGroups = getMyGroups();
  modal.innerHTML = `<h3>Editar tarea</h3>
    <div class="field"><label>Título</label><input id="e-title" value="${esc(t.title)}"></div>
    <div class="field"><label>Descripción</label><textarea id="e-desc" rows="2">${esc(t.description || '')}</textarea></div>
    <div class="field"><label>Fecha</label><input type="date" id="e-date" value="${esc(t.due_date || '')}"></div>
    <div class="field"><label>Hora (opcional)</label><input type="time" id="e-time" value="${esc(t.due_time || '')}"></div>
    <div class="field"><label>Prioridad</label>
      <select id="e-priority">
        <option value="alta" ${t.priority === 'alta' ? 'selected' : ''}>Alta</option>
        <option value="media" ${t.priority === 'media' || !t.priority ? 'selected' : ''}>Media</option>
        <option value="baja" ${t.priority === 'baja' ? 'selected' : ''}>Baja</option>
      </select>
    </div>
    <div class="field"><label>Estado</label>
      <select id="e-status">
        ${TASK_STATUSES.map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Grupo</label>
      <select id="e-group">
        <option value="">Sin grupo</option>
        ${Object.keys(myGroups).map((g) => `<option value="${esc(g)}" ${t.group_id === g ? 'selected' : ''}>${esc(myGroups[g].name)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="e-cancel">Cancelar</button>
      <button class="btn btn-primary" id="e-save">Guardar</button>
    </div>`;
  modal.querySelector('#e-cancel').onclick = () => root.innerHTML = '';
  modal.querySelector('#e-save').onclick = async () => {
    t.title = modal.querySelector('#e-title').value.trim() || t.title;
    t.description = modal.querySelector('#e-desc').value.trim();
    t.due_date = modal.querySelector('#e-date').value || null;
    t.due_time = modal.querySelector('#e-time').value || null;
    t.priority = modal.querySelector('#e-priority').value;
    t.status = modal.querySelector('#e-status').value;
    t.group_id = modal.querySelector('#e-group').value || null;
    t.updated_at = now();
    root.innerHTML = '';
    if (await gitPush('Editar tarea ' + id)) { renderAll(); }
  };
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
}

/* ============ GROUPS ============ */
function renderGroups() {
  const list = $('#groups-list');
  list.innerHTML = '';
  const groups = getMyGroups();
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    list.appendChild(el('div', 'empty-state', '<div class="icon">👥</div><p>Crea tu primer grupo para organizar tus tareas</p>'));
    return;
  }
  keys.forEach((gid) => {
    const g = groups[gid];
    const card = el('div', 'group-card');
    card.innerHTML = `<div class="group-name">📁 ${esc(g.name)}</div>
      <div class="group-desc">${esc(g.description || '')}</div>
      <div class="group-members"></div>
      <div class="group-actions">
        <button class="btn btn-sm btn-outline" data-a="vm" data-id="${esc(gid)}">+ Virtual</button>
        <button class="btn btn-sm btn-outline btn-danger" data-a="delg" data-id="${esc(gid)}">Eliminar</button>
      </div>`;
    const memRow = card.querySelector('.group-members');
    const virtuals = g.virtual_members || {};
    Object.keys(virtuals).forEach((vid) => {
      const chip = el('span', 'member-chip virtual', esc(virtuals[vid].display_name) + ' <span class="remove" data-g="' + esc(gid) + '" data-v="' + esc(vid) + '">✕</span>');
      chip.querySelector('.remove').onclick = () => removeVirtual(gid, vid);
      memRow.appendChild(chip);
    });
    if (Object.keys(virtuals).length === 0) memRow.appendChild(el('span', 'hint', 'Sin miembros virtuales'));
    card.querySelector('[data-a="vm"]').onclick = () => addVirtualModal(gid);
    card.querySelector('[data-a="delg"]').onclick = () => deleteGroup(gid);
    list.appendChild(card);
  });
}

function addVirtualModal(gid) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const backdrop = el('div', 'modal-backdrop center');
  const modal = el('div', 'modal');
  modal.innerHTML = `<h3>Añadir miembro virtual</h3>
    <div class="field"><label>Nombre</label><input id="vm-name" placeholder="Ej: Fontanero, Cerrajero, Proveedor..."></div>
    <div class="modal-actions"><button class="btn btn-outline" id="vm-cancel">Cancelar</button><button class="btn btn-primary" id="vm-save">Añadir</button></div>`;
  const rootCleanup = () => root.innerHTML = '';
  modal.querySelector('#vm-cancel').onclick = rootCleanup;
  modal.querySelector('#vm-save').onclick = async () => {
    const name = modal.querySelector('#vm-name').value.trim();
    if (!name) return;
    const groups = getMyGroups();
    const g = groups[gid];
    if (!g.virtual_members) g.virtual_members = {};
    const vid = 'vrt-' + uuid().slice(0, 8);
    g.virtual_members[vid] = { id: vid, display_name: name };
    saveLocal();
    rootCleanup();
    renderGroups();
    toast('Miembro virtual añadido');
  };
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
}

function removeVirtual(gid, vid) {
  const groups = getMyGroups();
  delete groups[gid].virtual_members[vid];
  saveLocal();
  renderGroups();
}

function deleteGroup(gid) {
  if (!confirm('¿Eliminar este grupo? Las tareas se mantienen pero quedan sin grupo.')) return;
  const groups = getMyGroups();
  delete groups[gid];
  saveLocal();
  renderGroups();
}

function newGroupModal() {
  const root = $('#modal-root');
  root.innerHTML = '';
  const backdrop = el('div', 'modal-backdrop center');
  const modal = el('div', 'modal');
  modal.innerHTML = `<h3>Nuevo grupo</h3>
    <div class="field"><label>Nombre</label><input id="g-name" placeholder="Ej: Casa, Trabajo, Proyecto..."></div>
    <div class="field"><label>Descripción</label><textarea id="g-desc" rows="2"></textarea></div>
    <div class="modal-actions"><button class="btn btn-outline" id="g-cancel">Cancelar</button><button class="btn btn-primary" id="g-save">Crear</button></div>`;
  const cleanup = () => root.innerHTML = '';
  modal.querySelector('#g-cancel').onclick = cleanup;
  modal.querySelector('#g-save').onclick = () => {
    const name = modal.querySelector('#g-name').value.trim();
    if (!name) return;
    const groups = getMyGroups();
    const gid = 'grp-' + uuid().slice(0, 8);
    groups[gid] = { id: gid, name, description: modal.querySelector('#g-desc').value.trim(), virtual_members: {} };
    saveLocal();
    cleanup();
    renderGroups();
    toast('Grupo creado');
  };
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
}

/* ============ CALENDAR (stub) ============ */
let calendarToken = null;
function tryAddToCalendar(task) {
  // Placeholder for Google Calendar integration
  if (calendarToken && task.due_date) {
    // Would call Google Calendar API here
    toast('🔔 Tarea añadida a tu calendario');
  }
}

/* ============ EVENT WIRING ============ */
function wireEvents() {
  $('#btn-login').onclick = login;
  $('#btn-toggle-login').onclick = () => toggleLoginMode($('#div-creds-login').classList.contains('hidden'));
  $('#btn-back-technical').onclick = () => toggleLoginMode(false);
  $('#btn-creds-login').onclick = loginWithCreds;
  $('#creds-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginWithCreds(); });
  $('#btn-set-creds').onclick = saveAccessCredential;

  // Sidebar
  $('#btn-menu').onclick = openSidebar;
  $('#btn-close-sidebar').onclick = closeSidebar;
  $('#sidebar-overlay').onclick = closeSidebar;
  $$('.nav-item[data-view]').forEach((b) => { b.onclick = () => navigate(b.dataset.view); });
  $('#btn-logout').onclick = logout;
  $('#btn-logout-2').onclick = logout;
  $('#btn-user').onclick = openSidebar;
  $('#btn-fab').onclick = () => navigate('chat');

  // Settings
  $('#btn-save-settings').onclick = () => {
    const c = loadConfig();
    c.token = $('#set-github-token').value || c.token;
    c.gemini = $('#set-gemini-key').value || c.gemini;
    c.repo = normalizeRepo($('#set-github-repo').value, state.user ? state.user.login : '') || c.repo;
    c.model = $('#set-model').value;
    saveConfig(c);
    state.config = c;
    const t = $('#set-theme').value;
    localStorage.setItem(LS.theme, t);
    document.documentElement.setAttribute('data-theme', t);
    toast('Ajustes guardados');
  };

  // Chat send
  $('#btn-chat-send').onclick = sendChatMessage;
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  // File dropzone
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => { Array.from(e.target.files).forEach(addAttachment); fileInput.value = ''; };
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('hover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('hover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('hover');
    Array.from(e.dataTransfer.files).forEach(addAttachment);
  });

  // Camera
  const camInput = $('#camera-input');
  $('#btn-camera').onclick = () => camInput.click();
  camInput.onchange = (e) => { if (e.target.files[0]) addAttachment(e.target.files[0]); camInput.value = ''; };

  // Board filters
  $('#filter-status').onchange = renderBoard;
  $('#filter-group').onchange = renderBoard;
  $('#board-search').oninput = renderBoard;

  // Groups
  $('#btn-new-group').onclick = newGroupModal;

  // Auto-refresh
  setInterval(() => { if (state.user && !document.hidden) syncFromGitHub(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) syncFromGitHub(); });
}

/* ============ INIT ============ */
async function initApp() {
  loadLocal();
  renderHeader();
  applyTheme();
  fillSettingsFromConfig();
}

function fillSettingsFromConfig() {
  const c = loadConfig();
  if (c.token) $('#set-github-token').value = c.token;
  if (c.gemini) $('#set-gemini-key').value = c.gemini;
  if (c.repo) $('#set-github-repo').value = c.repo;
  const model = c.model || DEFAULT_MODEL;
  $('#set-model').value = model;
  $('#set-theme').value = document.documentElement.getAttribute('data-theme') || 'dark';
}

/* ============ BOOTSTRAP ============ */
function boot() {
  applyTheme();
  initPasswordToggles();
  const c = loadConfig();
  if (c.token && c.gemini && c.repo) {
    // Attempt auto-login
    state.config = c;
    githubGetUser(c.token).then((user) => {
      state.user = { login: user.login, name: user.name || user.login };
      loadLocal();
      renderHeader();
      showScreen('screen-app');
      syncFromGitHub().then(() => navigate('inbox'));
      toast('Bienvenido de nuevo, ' + (user.name || user.login));
    }).catch(() => {
      // fall back to login screen
    });
  } else {
    showScreen('screen-login');
  }
  wireEvents();
}

document.addEventListener('DOMContentLoaded', boot);

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
