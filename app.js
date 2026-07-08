// app.js — 화면 전환 / 인증 / 노트·페이지 관리 / 텍스트 입력 / 검색·책갈피 / 자동 저장 / 오프라인 대응
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
let notebooks = [];          // 목록 화면 데이터
let pages = [];              // [{ id, page_number, bookmarked }]
let pageIdx = 0;
let dirty = false;
let saveTimer = null;
let editingText = null;      // { x, y, item } — 텍스트 입력창 상태

const AUTOSAVE_DELAY = 2000;              // 필기 멈춘 후 2초 뒤 디바운스 저장
const TEXT_SIZES = { 1.5: 30, 3: 44, 6: 64 }; // 굵기 단계 → 글자 크기

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

// 페이지의 타이핑 텍스트만 모아 검색용 본문 생성
function extractText(strokes) {
  return strokes.filter(s => s.tool === 'text').map(s => s.text).join('\n');
}

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
  const textContent = extractText(strokes);
  dirty = false;
  setStatus('saving');
  try {
    await DB.savePage(page.id, currentNotebook.id, strokes, textContent);
    await IDB.put('pageCache', { pageId: page.id, strokes });
    if (!dirty) setStatus('saved');
  } catch (err) {
    console.warn('저장 실패 — 오프라인 큐에 보관:', err.message);
    await IDB.put('pendingSaves', {
      pageId: page.id,
      notebookId: currentNotebook.id,
      strokes,
      textContent,
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
      await DB.savePage(item.pageId, item.notebookId, item.strokes, item.textContent || '');
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
  if (document.visibilityState === 'hidden') {
    commitTextEditor();
    if (dirty) saveNow();
  }
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
  const password = $('#auth-password').value;
  const msg = $('#auth-msg');
  const setMsg = (cls, text) => { msg.className = 'auth-msg ' + cls; msg.textContent = text; };
  if (password.length < 6) {
    setMsg('error', '비밀번호는 6자 이상이어야 합니다.');
    return;
  }
  $('#auth-send').disabled = true;
  setMsg('', '로그인 중…');
  try {
    const { error } = await sb.auth.signInWithPassword({ email: OWNER_EMAIL, password });
    if (!error) return; // onAuthStateChange가 화면 전환

    // 로그인 실패 → 첫 사용이면 계정 생성 시도
    const { data, error: signUpErr } = await sb.auth.signUp({ email: OWNER_EMAIL, password });
    if (signUpErr) {
      setMsg('error', signUpErr.message.includes('already registered')
        ? '비밀번호가 틀렸습니다.' : '로그인 실패: ' + signUpErr.message);
    } else if (data.user && data.user.identities && data.user.identities.length === 0) {
      // 이미 가입된 이메일 — signUp이 조용히 무시된 경우
      setMsg('error', '비밀번호가 틀렸습니다.');
    } else if (data.session) {
      setMsg('ok', '계정을 만들었습니다.'); // 자동 확인 설정 — 바로 로그인됨
    } else {
      setMsg('ok', '계정을 만들었습니다. 메일함에서 확인 링크를 누른 뒤 다시 로그인하세요.');
    }
  } catch (err) {
    setMsg('error', '연결 실패: ' + err.message);
  } finally {
    $('#auth-send').disabled = false;
  }
});

$('#auth-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#auth-send').click();
});

$('#logout').addEventListener('click', async () => {
  await sb.auth.signOut();
});

// ---------- 노트 목록 / 정렬 / 탭 ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function refreshNotebooks() {
  try {
    notebooks = await DB.listNotebooks();
  } catch (err) {
    $('#list-empty').classList.remove('hidden');
    $('#list-empty').textContent = '노트 목록을 불러오지 못했습니다: ' + err.message;
    return;
  }
  renderNotebooks();
}

function renderNotebooks() {
  const sort = $('#sort-select').value;
  const sorted = notebooks.slice().sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'ko');
    if (sort === 'created') return b.created_at.localeCompare(a.created_at);
    return b.updated_at.localeCompare(a.updated_at);
  });
  const list = $('#note-list');
  list.innerHTML = '';
  $('#list-empty').classList.toggle('hidden', sorted.length > 0 || !isTab('notes'));
  for (const nb of sorted) {
    const card = document.createElement('div');
    card.className = 'note-card';
    const date = new Date(nb.updated_at).toLocaleString('ko-KR', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    card.innerHTML = `
      <div class="title"></div>
      <div class="date">${date} · ${nb.pageCount}쪽</div>
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

$('#sort-select').addEventListener('change', () => {
  localStorage.setItem('mynote-sort', $('#sort-select').value);
  renderNotebooks();
});

function isTab(name) {
  const active = $('#list-tabs button.active');
  return active && active.dataset.tab === name;
}

$$('#list-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#list-tabs button').forEach(b => b.classList.toggle('active', b === btn));
    $('#search-input').value = '';
    applyListView();
  });
});

function applyListView() {
  const q = $('#search-input').value.trim();
  const searching = q.length > 0;
  $('#search-results').classList.toggle('hidden', !searching);
  $('#note-list').classList.toggle('hidden', searching || !isTab('notes'));
  $('#bookmark-list').classList.toggle('hidden', searching || !isTab('bookmarks'));
  if (searching) runSearch(q);
  else if (isTab('bookmarks')) renderBookmarks();
  else renderNotebooks();
}

// ---------- 검색 ----------

let searchTimer = null;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyListView, 300);
});

function snippetHtml(text, q) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return escapeHtml(text.slice(0, 60));
  const start = Math.max(0, idx - 25);
  const end = Math.min(text.length, idx + q.length + 35);
  return (start > 0 ? '…' : '') +
    escapeHtml(text.slice(start, idx)) +
    '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' +
    escapeHtml(text.slice(idx + q.length, end)) +
    (end < text.length ? '…' : '');
}

async function runSearch(q) {
  const box = $('#search-results');
  box.innerHTML = '<p class="list-empty">검색 중…</p>';

  // 제목 검색 (로컬)
  const titleHits = notebooks.filter(nb => nb.title.toLowerCase().includes(q.toLowerCase()));
  // 내용 검색 (서버 — 타이핑 텍스트만)
  let pageHits = [];
  try {
    pageHits = await DB.searchPages(q);
  } catch (err) {
    box.innerHTML = '<p class="list-empty">검색 실패 (오프라인?): ' + escapeHtml(err.message) + '</p>';
    return;
  }
  if ($('#search-input').value.trim() !== q) return; // 입력이 바뀌었으면 무시

  box.innerHTML = '';
  for (const nb of titleHits) {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = `<div class="where">📓 ${snippetHtml(nb.title, q)}</div>`;
    item.addEventListener('click', () => openNotebook(nb));
    box.appendChild(item);
  }
  for (const hit of pageHits) {
    const item = document.createElement('div');
    item.className = 'result-item';
    const title = hit.notebooks ? hit.notebooks.title : '(노트)';
    item.innerHTML = `
      <div class="where">📄 ${escapeHtml(title)} — ${hit.page_number}쪽</div>
      <div class="snippet">${snippetHtml(hit.text_content, q)}</div>`;
    item.addEventListener('click', () =>
      openNotebook({ id: hit.notebook_id, title }, hit.page_number));
    box.appendChild(item);
  }
  if (titleHits.length === 0 && pageHits.length === 0) {
    box.innerHTML = '<p class="list-empty">검색 결과가 없습니다. (손글씨는 검색되지 않고, T 도구로 타이핑한 텍스트만 검색됩니다)</p>';
  }
}

// ---------- 책갈피 ----------

async function renderBookmarks() {
  const box = $('#bookmark-list');
  box.innerHTML = '<p class="list-empty">불러오는 중…</p>';
  let items;
  try {
    items = await DB.listBookmarks();
  } catch (err) {
    box.innerHTML = '<p class="list-empty">책갈피를 불러오지 못했습니다: ' + escapeHtml(err.message) + '</p>';
    return;
  }
  box.innerHTML = '';
  if (items.length === 0) {
    box.innerHTML = '<p class="list-empty">책갈피가 없습니다. 필기 화면에서 🔖 버튼으로 추가하세요.</p>';
    return;
  }
  for (const bm of items) {
    const item = document.createElement('div');
    item.className = 'result-item';
    const title = bm.notebooks ? bm.notebooks.title : '(노트)';
    const preview = (bm.text_content || '').slice(0, 60);
    item.innerHTML = `
      <div class="where">🔖 ${escapeHtml(title)} — ${bm.page_number}쪽</div>
      ${preview ? `<div class="snippet">${escapeHtml(preview)}</div>` : ''}`;
    item.addEventListener('click', () =>
      openNotebook({ id: bm.notebook_id, title }, bm.page_number));
    box.appendChild(item);
  }
}

// ---------- 노트 CRUD ----------

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

async function openNotebook(nb, targetPageNumber) {
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
  let idx = 0;
  if (targetPageNumber) {
    const found = pages.findIndex(p => p.page_number === targetPageNumber);
    if (found !== -1) idx = found;
  }
  await loadPageAt(idx);
}

async function loadPageAt(idx) {
  commitTextEditor();
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
  $('#btn-bookmark').classList.toggle('active', !!pages[pageIdx].bookmarked);
  updateUndoUI();
}

function updateUndoUI() {
  $('#btn-undo').disabled = !engine.canUndo();
  $('#btn-redo').disabled = !engine.canRedo();
}

$('#btn-back').addEventListener('click', async () => {
  commitTextEditor();
  if (dirty) await saveNow();
  currentNotebook = null;
  showScreen('#list-screen');
  refreshNotebooks();
  applyListView();
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

$('#btn-del-page').addEventListener('click', async () => {
  if (pages.length === 1) {
    if (!confirm('마지막 페이지입니다. 내용을 모두 지울까요?')) return;
    engine.load([]);
    dirty = true;
    await saveNow();
    return;
  }
  if (!confirm(`${pageIdx + 1}쪽을 삭제할까요?`)) return;
  const page = pages[pageIdx];
  try {
    await DB.deletePage(page.id);
    // 뒷 페이지들 번호 당기기 (오름차순이라 unique 충돌 없음)
    for (let i = pageIdx + 1; i < pages.length; i++) {
      await DB.setPageNumber(pages[i].id, pages[i].page_number - 1);
      pages[i].page_number--;
    }
    pages.splice(pageIdx, 1);
    dirty = false;
    await loadPageAt(Math.min(pageIdx, pages.length - 1));
  } catch (err) {
    alert('페이지 삭제 실패 (오프라인?): ' + err.message);
  }
});

$('#btn-bookmark').addEventListener('click', async () => {
  const page = pages[pageIdx];
  const on = !page.bookmarked;
  page.bookmarked = on;
  $('#btn-bookmark').classList.toggle('active', on);
  try {
    await DB.setBookmark(page.id, on);
  } catch (err) {
    page.bookmarked = !on; // 실패 시 되돌림
    $('#btn-bookmark').classList.toggle('active', !on);
    alert('책갈피 저장 실패 (오프라인?): ' + err.message);
  }
});

// ---------- 텍스트 입력 (타자 필기) ----------

function currentTextSize() {
  return TEXT_SIZES[engine.baseWidth] || 44;
}

function openTextEditor(p, item) {
  commitTextEditor(); // 이전 입력이 열려 있으면 먼저 확정
  const ta = $('#text-input');
  const s = engine._scale();
  const size = item ? item.size : currentTextSize();
  const color = item ? item.color : engine.color;
  const x = item ? item.x : p.x;
  const y = item ? item.y : p.y;

  editingText = { x, y, item, size, color };
  if (item) {
    engine.editing = item;
    engine.render();
  }
  ta.value = item ? item.text : '';
  ta.style.left = engine.panX + x * s + 'px';
  ta.style.top = engine.panY + y * s - 2 + 'px';
  ta.style.fontSize = size * s + 'px';
  ta.style.color = color;
  ta.style.minWidth = '120px';
  ta.style.maxWidth = $('#canvas-wrap').clientWidth - (engine.panX + x * s) - 8 + 'px';
  ta.style.width = 'auto';
  ta.classList.remove('hidden');
  autosizeTextInput();
  ta.focus();
}

function autosizeTextInput() {
  const ta = $('#text-input');
  ta.style.height = 'auto';
  ta.style.width = 'auto';
  ta.style.width = Math.max(120, ta.scrollWidth + 8) + 'px';
  ta.style.height = ta.scrollHeight + 'px';
}

function commitTextEditor() {
  if (!editingText) return;
  const ctx = editingText;
  editingText = null;
  const ta = $('#text-input');
  ta.classList.add('hidden');
  engine.commitText(ctx.item, {
    x: ctx.x, y: ctx.y,
    text: ta.value,
    color: ctx.color,
    size: ctx.size,
  });
  ta.value = '';
}

function cancelTextEditor() {
  if (!editingText) return;
  editingText = null;
  const ta = $('#text-input');
  ta.classList.add('hidden');
  ta.value = '';
  engine.cancelTextEdit();
}

$('#text-input').addEventListener('input', autosizeTextInput);
$('#text-input').addEventListener('blur', commitTextEditor);
$('#text-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); cancelTextEditor(); }
  e.stopPropagation(); // 입력 중 Ctrl+Z 등이 캔버스 단축키로 새지 않게
});

// ---------- 툴바 ----------

function selectTool(tool) {
  engine.tool = tool;
  $('#tool-pen').classList.toggle('active', tool === 'pen');
  $('#tool-text').classList.toggle('active', tool === 'text');
  $('#tool-eraser').classList.toggle('active', tool === 'eraser');
  if (tool !== 'text') commitTextEditor();
}

$('#tool-pen').addEventListener('click', () => selectTool('pen'));
$('#tool-text').addEventListener('click', () => selectTool('text'));
$('#tool-eraser').addEventListener('click', () => selectTool('eraser'));

$$('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    engine.color = btn.dataset.color;
    if (engine.tool === 'eraser') selectTool('pen');
    $$('.color-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

$$('.width-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    engine.baseWidth = parseFloat(btn.dataset.width);
    $$('.width-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

$('#btn-undo').addEventListener('click', () => { commitTextEditor(); engine.undo(); });
$('#btn-redo').addEventListener('click', () => { commitTextEditor(); engine.redo(); });
$('#btn-fit').addEventListener('click', () => { commitTextEditor(); engine.resetView(); });

document.addEventListener('keydown', e => {
  if ($('#editor-screen').classList.contains('hidden')) return;
  if (document.activeElement === $('#text-input')) return;
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
  engine.onTextClick = (p, hitItem) => openTextEditor(p, hitItem);
  const savedSort = localStorage.getItem('mynote-sort');
  if (savedSort) $('#sort-select').value = savedSort;
  initAuth();
}

init();
