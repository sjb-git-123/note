// app.js — 화면 전환 / 인증 / 노트·페이지 관리 / 자동 저장 / 오프라인 대응
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ---------- IndexedDB (오프라인 임시 보관 + 페이지 캐시) ----------

const IDB = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('mynote', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('pendingSaves', { keyPath: 'pageId' });
        req.result.createObjectStore('pageCache', { keyPath: 'pageId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },
  async put(store, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async get(store, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getAll(store) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async delete(store, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ---------- 앱 상태 ----------

let engine = null;
let currentUser = null;
let currentNotebook = null;  // { id, title }
let pages = [];              // [{ id, page_number }]
let pageIdx = 0;
let dirty = false;
let saveTimer = null;

const AUTOSAVE_DELAY = 2000; // 필기 멈춘 후 2초 뒤 디바운스 저장

// ---------- 화면 전환 ----------

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
  $('#loading').classList.add('hidden');
  if (id === '#editor-screen' && engine) engine.resize();
}

// ---------- 저장 상태 표시 ----------

function setStatus(state) {
  const el = $('#save-status');
  el.className = 'save-status ' + state;
  el.textContent = {
    saved: '저장됨',
    pending: '변경됨',
    saving: '저장 중…',
    offline: '오프라인',
  }[state];
}

// ---------- 자동 저장 ----------

function scheduleSave() {
  dirty = true;
  setStatus('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, AUTOSAVE_DELAY);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!dirty || !pages[pageIdx]) return;
  const page = pages[pageIdx];
  const strokes = engine.getStrokes();
  dirty = false;
  setStatus('saving');
  try {
    await DB.savePage(page.id, currentNotebook.id, strokes);
    await IDB.put('pageCache', { pageId: page.id, strokes });
    if (!dirty) setStatus('saved');
  } catch (err) {
    console.warn('저장 실패 — 오프라인 큐에 보관:', err.message);
    await IDB.put('pendingSaves', {
      pageId: page.id,
      notebookId: currentNotebook.id,
      strokes,
      queuedAt: Date.now(),
    });
    await IDB.put('pageCache', { pageId: page.id, strokes });
    setStatus('offline');
  }
}

// 온라인 복귀 시 오프라인 중 쌓인 저장 업로드
async function flushPending() {
  let items;
  try { items = await IDB.getAll('pendingSaves'); } catch { return; }
  if (items.length === 0) return;
  for (const item of items) {
    try {
      await DB.savePage(item.pageId, item.notebookId, item.strokes);
      await IDB.delete('pendingSaves', item.pageId);
    } catch {
      return; // 아직 오프라인 — 다음 기회에 재시도
    }
  }
  if (!dirty && !$('#editor-screen').classList.contains('hidden')) setStatus('saved');
}

window.addEventListener('online', flushPending);

// 화면을 벗어나거나 앱이 백그라운드로 갈 때 즉시 저장
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) saveNow();
});

// ---------- 인증 ----------

async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  handleSession(session);
  sb.auth.onAuthStateChange((_event, session) => handleSession(session));
}

function handleSession(session) {
  const user = session ? session.user : null;
  if (user && currentUser && user.id === currentUser.id) return; // 토큰 갱신은 무시
  currentUser = user;
  if (user) {
    showScreen('#list-screen');
    refreshNotebooks();
    flushPending();
  } else {
    showScreen('#auth-screen');
  }
}

$('#auth-send').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim();
  const msg = $('#auth-msg');
  if (!email) {
    msg.className = 'auth-msg error';
    msg.textContent = '이메일을 입력해 주세요.';
    return;
  }
  $('#auth-send').disabled = true;
  msg.className = 'auth-msg';
  msg.textContent = '보내는 중…';
  try {
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    msg.className = 'auth-msg ok';
    msg.textContent = '메일함에서 로그인 링크를 눌러 주세요.';
  } catch (err) {
    msg.className = 'auth-msg error';
    msg.textContent = '발송 실패: ' + err.message;
  } finally {
    $('#auth-send').disabled = false;
  }
});

$('#auth-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#auth-send').click();
});

$('#logout').addEventListener('click', async () => {
  await sb.auth.signOut();
});

// ---------- 노트 목록 ----------

async function refreshNotebooks() {
  let notebooks;
  try {
    notebooks = await DB.listNotebooks();
  } catch (err) {
    $('#list-empty').classList.remove('hidden');
    $('#list-empty').textContent = '노트 목록을 불러오지 못했습니다: ' + err.message;
    return;
  }
  const list = $('#note-list');
  list.innerHTML = '';
  $('#list-empty').classList.toggle('hidden', notebooks.length > 0);
  for (const nb of notebooks) {
    const card = document.createElement('div');
    card.className = 'note-card';
    const date = new Date(nb.updated_at).toLocaleString('ko-KR', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    card.innerHTML = `
      <div class="title"></div>
      <div class="date">${date}</div>
      <div class="card-actions">
        <button data-act="rename">이름 변경</button>
        <button data-act="delete">삭제</button>
      </div>`;
    card.querySelector('.title').textContent = nb.title;
    card.addEventListener('click', e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'rename') return renameNotebook(nb);
      if (act === 'delete') return deleteNotebook(nb);
      openNotebook(nb);
    });
    list.appendChild(card);
  }
}

async function renameNotebook(nb) {
  const title = prompt('노트 이름:', nb.title);
  if (!title || title === nb.title) return;
  await DB.renameNotebook(nb.id, title);
  refreshNotebooks();
}

async function deleteNotebook(nb) {
  if (!confirm(`"${nb.title}" 노트를 삭제할까요? 모든 페이지가 함께 삭제됩니다.`)) return;
  await DB.deleteNotebook(nb.id);
  refreshNotebooks();
}

$('#new-note').addEventListener('click', async () => {
  const nb = await DB.createNotebook(currentUser.id);
  openNotebook(nb);
});

// ---------- 필기 화면 ----------

async function openNotebook(nb) {
  currentNotebook = nb;
  $('#editor-title').textContent = nb.title;
  showScreen('#editor-screen');
  try {
    pages = await DB.listPages(nb.id);
    if (pages.length === 0) pages = [await DB.createPage(nb.id, 1)];
  } catch (err) {
    alert('노트를 열지 못했습니다: ' + err.message);
    showScreen('#list-screen');
    return;
  }
  await loadPageAt(0);
}

async function loadPageAt(idx) {
  if (dirty) await saveNow(); // 페이지를 떠나기 전 저장
  pageIdx = idx;
  const page = pages[idx];
  let strokes = [];
  try {
    strokes = await DB.loadPage(page.id);
    await IDB.put('pageCache', { pageId: page.id, strokes });
  } catch {
    // 오프라인 — 로컬 캐시로 대체
    const cached = await IDB.get('pageCache', page.id).catch(() => null);
    if (cached) strokes = cached.strokes;
    setStatus('offline');
  }
  // 오프라인 중 저장 대기분이 있으면 그것이 최신
  const pending = await IDB.get('pendingSaves', page.id).catch(() => null);
  if (pending) strokes = pending.strokes;

  engine.load(strokes);
  engine.resetView();
  dirty = false;
  if (navigator.onLine) setStatus('saved');
  updatePageUI();
}

function updatePageUI() {
  $('#page-indicator').textContent = `${pageIdx + 1} / ${pages.length}`;
  $('#btn-prev').disabled = pageIdx === 0;
  $('#btn-next').disabled = pageIdx >= pages.length - 1;
  updateUndoUI();
}

function updateUndoUI() {
  $('#btn-undo').disabled = !engine.canUndo();
  $('#btn-redo').disabled = !engine.canRedo();
}

$('#btn-back').addEventListener('click', async () => {
  if (dirty) await saveNow();
  currentNotebook = null;
  showScreen('#list-screen');
  refreshNotebooks();
});

$('#btn-prev').addEventListener('click', () => {
  if (pageIdx > 0) loadPageAt(pageIdx - 1);
});
$('#btn-next').addEventListener('click', () => {
  if (pageIdx < pages.length - 1) loadPageAt(pageIdx + 1);
});
$('#btn-add-page').addEventListener('click', async () => {
  try {
    const page = await DB.createPage(currentNotebook.id, pages.length + 1);
    pages.push(page);
    loadPageAt(pages.length - 1);
  } catch (err) {
    alert('페이지 추가 실패 (오프라인?): ' + err.message);
  }
});

// ---------- 툴바 ----------

$('#tool-pen').addEventListener('click', () => {
  engine.tool = 'pen';
  $('#tool-pen').classList.add('active');
  $('#tool-eraser').classList.remove('active');
});
$('#tool-eraser').addEventListener('click', () => {
  engine.tool = 'eraser';
  $('#tool-eraser').classList.add('active');
  $('#tool-pen').classList.remove('active');
});

$$('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    engine.color = btn.dataset.color;
    engine.tool = 'pen';
    $('#tool-pen').classList.add('active');
    $('#tool-eraser').classList.remove('active');
    $$('.color-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

$$('.width-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    engine.baseWidth = parseFloat(btn.dataset.width);
    $$('.width-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

$('#btn-undo').addEventListener('click', () => engine.undo());
$('#btn-redo').addEventListener('click', () => engine.redo());
$('#btn-fit').addEventListener('click', () => engine.resetView());

document.addEventListener('keydown', e => {
  if ($('#editor-screen').classList.contains('hidden')) return;
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); engine.undo(); }
  else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault(); engine.redo();
  }
});

// ---------- 시작 ----------

function init() {
  engine = new CanvasEngine($('#note-canvas'), $('#canvas-wrap'));
  engine.onChange = () => {
    scheduleSave();
    updateUndoUI();
  };
  initAuth();
}

init();
