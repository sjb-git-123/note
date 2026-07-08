// canvas.js — Canvas 필기 엔진 (그리기 / 필압 / 지우개 / Undo / 팬·줌)
'use strict';

// 좌표계는 고정 해상도 기준으로 저장 → 기기 간 표시 일관성 확보
const PAGE_W = 1920;
const PAGE_H = 2712;

const MAX_HISTORY = 50;      // Undo 최대 단계
const ERASER_RADIUS = 14;    // 지우개 반경 (페이지 좌표 기준)
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;

class CanvasEngine {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');

    this.strokes = [];       // 확정된 스트로크 목록
    this.undoStack = [];     // 이전 상태 스냅숏 (스트로크 배열의 얕은 복사)
    this.redoStack = [];

    this.tool = 'pen';       // 'pen' | 'eraser' | 'text'
    this.color = '#000000';
    this.baseWidth = 3;
    this.textSize = 44;      // 텍스트 도구 글자 크기 (페이지 좌표 기준)

    this.editing = null;     // 편집 중인 텍스트 항목 (렌더링에서 숨김)
    this.onTextClick = null; // 텍스트 도구로 캔버스를 눌렀을 때 콜백 (p, hitItem)

    // 펜 입력이 한 번이라도 감지되면 손가락 터치로는 그리지 않음 (팜 리젝션)
    this.hasPen = false;

    this.active = null;      // 진행 중 스트로크 { tool,color,width,points,pointerId }
    this._eraseSnapshot = null;
    this._erasedAny = false;

    // 뷰 변환: 화면 크기에 맞춘 기본 배율(fitScale) × 사용자 줌
    this.fitScale = 1;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    this._touches = new Map();  // 팬/핀치줌용 터치 포인터 위치
    this._gesture = null;       // { type:'pan'|'pinch', ... }

    this.onChange = null;       // 스트로크 변경 콜백 (자동 저장 트리거)

    this._bind();
    this.resize();
  }

  // ---------- 뷰 ----------

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.fitScale = Math.min(w / PAGE_W, h / PAGE_H);
    this._clampView();
    this.render();
  }

  resetView() {
    this.zoom = 1;
    this._clampView();
    this.render();
  }

  _scale() { return this.fitScale * this.zoom; }

  _clampView() {
    // 페이지가 화면보다 작으면 가운데 정렬, 크면 여백이 생기지 않게 팬 범위 제한
    const s = this._scale();
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const pw = PAGE_W * s, ph = PAGE_H * s;
    if (pw <= w) this.panX = (w - pw) / 2;
    else this.panX = Math.min(0, Math.max(w - pw, this.panX));
    if (ph <= h) this.panY = (h - ph) / 2;
    else this.panY = Math.min(0, Math.max(h - ph, this.panY));
  }

  _zoomAt(cx, cy, factor) {
    const s0 = this._scale();
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const s1 = this._scale();
    // 커서/핀치 중심점이 화면상 같은 위치를 가리키도록 팬 보정
    this.panX = cx - (cx - this.panX) * (s1 / s0);
    this.panY = cy - (cy - this.panY) * (s1 / s0);
    this._clampView();
  }

  // 화면 좌표 → 페이지 좌표
  _toPage(e) {
    const rect = this.canvas.getBoundingClientRect();
    const s = this._scale();
    return {
      x: (e.clientX - rect.left - this.panX) / s,
      y: (e.clientY - rect.top - this.panY) / s,
    };
  }

  // ---------- 입력 ----------

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._onDown(e));
    c.addEventListener('pointermove', e => this._onMove(e));
    c.addEventListener('pointerup', e => this._onUp(e));
    c.addEventListener('pointercancel', e => this._onUp(e));
    c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    window.addEventListener('resize', () => this.resize());
  }

  _canDraw(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.buttons === 1;
    // 터치: 펜이 있는 기기에서는 손가락으로 그리지 않음 (팜 리젝션)
    return !this.hasPen;
  }

  _onDown(e) {
    if (e.pointerType === 'pen') this.hasPen = true;
    // 이미 해제된 포인터 등에서 예외가 날 수 있음 — 캡처 실패해도 필기는 계속
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();

    if (e.pointerType === 'touch') {
      const rect = this.canvas.getBoundingClientRect();
      this._touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

      if (this._touches.size === 2) {
        // 두 번째 손가락 → 진행 중이던 터치 스트로크는 취소하고 핀치줌 시작
        if (this.active && this.active.pointerType === 'touch') this._cancelActive();
        this._startPinch();
        return;
      }
      if (this._touches.size === 1 && !this._canDraw(e)) {
        // 펜 기기에서 손가락 1개 → 팬
        this._gesture = { type: 'pan', lastX: e.clientX, lastY: e.clientY };
        return;
      }
    }

    if (!this._canDraw(e) || this.active) return;

    if (this.tool === 'text') {
      const p = this._toPage(e);
      if (this.onTextClick) this.onTextClick(p, this.hitTextAt(p));
      return;
    }

    if (this.tool === 'eraser') {
      this._eraseSnapshot = this.strokes.slice();
      this._erasedAny = false;
      this.active = { tool: 'eraser', pointerId: e.pointerId, pointerType: e.pointerType };
      this._eraseAt(this._toPage(e));
    } else {
      const p = this._toPage(e);
      this.active = {
        tool: 'pen',
        color: this.color,
        width: this.baseWidth,
        points: [this._pt(p, e.pressure)],
        pointerId: e.pointerId,
        pointerType: e.pointerType,
      };
    }
  }

  _onMove(e) {
    if (this._gesture) {
      if (this._gesture.type === 'pan' || this._gesture.type === 'pinch') {
        if (e.pointerType === 'touch') {
          const rect = this.canvas.getBoundingClientRect();
          if (this._touches.has(e.pointerId)) {
            this._touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
          }
        }
        if (this._gesture.type === 'pinch') this._updatePinch();
        else {
          this.panX += e.clientX - this._gesture.lastX;
          this.panY += e.clientY - this._gesture.lastY;
          this._gesture.lastX = e.clientX;
          this._gesture.lastY = e.clientY;
          this._clampView();
          this.render();
        }
      }
      return;
    }

    if (!this.active || this.active.pointerId !== e.pointerId) return;
    e.preventDefault();

    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    if (this.active.tool === 'eraser') {
      for (const ev of events) this._eraseAt(this._toPage(ev));
    } else {
      for (const ev of events) {
        const p = this._pt(this._toPage(ev), ev.pressure);
        const pts = this.active.points;
        const last = pts[pts.length - 1];
        if (Math.abs(p[0] - last[0]) < 0.3 && Math.abs(p[1] - last[1]) < 0.3) continue;
        pts.push(p);
        this._drawSegment(this.active, pts.length - 2); // 새 구간만 증분 렌더
      }
    }
  }

  _onUp(e) {
    if (e.pointerType === 'touch') {
      this._touches.delete(e.pointerId);
      if (this._gesture) {
        if (this._touches.size === 0) this._gesture = null;
        else if (this._touches.size === 1 && this._gesture.type === 'pinch') {
          // 손가락 하나 남으면 팬으로 전환
          this._gesture = { type: 'pan', lastX: e.clientX, lastY: e.clientY };
        }
        if (!this.active) return;
      }
    }

    if (!this.active || this.active.pointerId !== e.pointerId) return;

    if (this.active.tool === 'eraser') {
      if (this._erasedAny) this._commit(this._eraseSnapshot);
      this._eraseSnapshot = null;
    } else if (this.active.points.length > 0) {
      const stroke = {
        tool: 'pen',
        color: this.active.color,
        width: this.active.width,
        points: this.active.points,
      };
      this._commit(this.strokes.slice());
      this.strokes.push(stroke);
    }
    this.active = null;
    this.render();
    if (this.onChange) this.onChange();
  }

  _cancelActive() {
    this.active = null;
    this._eraseSnapshot = null;
    this.render();
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      const rect = this.canvas.getBoundingClientRect();
      this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    } else {
      this.panX -= e.shiftKey ? e.deltaY : e.deltaX;
      this.panY -= e.shiftKey ? 0 : e.deltaY;
      this._clampView();
    }
    this.render();
  }

  _startPinch() {
    const [a, b] = [...this._touches.values()];
    this._gesture = {
      type: 'pinch',
      lastDist: Math.hypot(b.x - a.x, b.y - a.y),
      lastMidX: (a.x + b.x) / 2,
      lastMidY: (a.y + b.y) / 2,
    };
  }

  _updatePinch() {
    if (this._touches.size < 2) return;
    const [a, b] = [...this._touches.values()];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const g = this._gesture;
    if (g.lastDist > 0 && dist > 0) this._zoomAt(midX, midY, dist / g.lastDist);
    this.panX += midX - g.lastMidX;
    this.panY += midY - g.lastMidY;
    this._clampView();
    g.lastDist = dist; g.lastMidX = midX; g.lastMidY = midY;
    this.render();
  }

  // ---------- 스트로크 ----------

  // 좌표는 소수점 1자리로 반올림해 용량 절약
  _pt(p, pressure) {
    return [
      Math.round(p.x * 10) / 10,
      Math.round(p.y * 10) / 10,
      Math.round((pressure || 0.5) * 100) / 100,
    ];
  }

  _commit(prevSnapshot) {
    this.undoStack.push(prevSnapshot);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this.strokes);
    this.strokes = this.undoStack.pop();
    this.render();
    if (this.onChange) this.onChange();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this.strokes);
    this.strokes = this.redoStack.pop();
    this.render();
    if (this.onChange) this.onChange();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  // 지우개: 닿은 스트로크를 통째로 삭제
  _eraseAt(p) {
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(s => !this._strokeHit(s, p));
    if (this.strokes.length !== before) {
      this._erasedAny = true;
      this.render();
    }
  }

  // ---------- 텍스트 항목 ----------

  _textBounds(t) {
    this.ctx.font = t.size + 'px sans-serif';
    const lines = t.text.split('\n');
    let w = 0;
    for (const l of lines) w = Math.max(w, this.ctx.measureText(l).width);
    return { x: t.x, y: t.y, w, h: lines.length * t.size * 1.3 };
  }

  hitTextAt(p) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (s.tool !== 'text') continue;
      const b = this._textBounds(s);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return s;
    }
    return null;
  }

  // 텍스트 입력 확정: existing이 있으면 수정(빈 문자열이면 삭제), 없으면 새로 추가
  commitText(existing, data) {
    this.editing = null;
    const text = (data.text || '').replace(/\s+$/, '');
    const snapshot = this.strokes.slice();
    if (existing) {
      const idx = this.strokes.indexOf(existing);
      if (idx === -1) { this.render(); return; }
      if (!text) this.strokes.splice(idx, 1);
      else if (text === existing.text) { this.render(); return; } // 변경 없음
      else this.strokes[idx] = { ...existing, text };
    } else {
      if (!text) { this.render(); return; }
      this.strokes.push({ tool: 'text', x: data.x, y: data.y, text, color: data.color, size: data.size });
    }
    this._commit(snapshot);
    this.render();
    if (this.onChange) this.onChange();
  }

  cancelTextEdit() {
    this.editing = null;
    this.render();
  }

  _drawText(t) {
    const ctx = this.ctx;
    ctx.font = t.size + 'px sans-serif';
    ctx.fillStyle = t.color;
    ctx.textBaseline = 'top';
    const lines = t.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], t.x, t.y + i * t.size * 1.3);
    }
  }

  _strokeHit(stroke, p) {
    if (stroke.tool === 'text') {
      const b = this._textBounds(stroke);
      const m = ERASER_RADIUS / this.zoom;
      return p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
    }
    const r = ERASER_RADIUS / this.zoom + stroke.width;
    const pts = stroke.points;
    if (pts.length === 1) {
      return Math.hypot(pts[0][0] - p.x, pts[0][1] - p.y) < r;
    }
    for (let i = 1; i < pts.length; i++) {
      if (this._segDist(pts[i - 1], pts[i], p) < r) return true;
    }
    return false;
  }

  _segDist(a, b, p) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(a[0] + t * dx - p.x, a[1] + t * dy - p.y);
  }

  // ---------- 렌더링 ----------

  _applyTransform() {
    const dpr = window.devicePixelRatio || 1;
    const s = this._scale();
    this.ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.panX, dpr * this.panY);
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._applyTransform();

    // 페이지 배경
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PAGE_W, PAGE_H);
    ctx.clip();
    for (const s of this.strokes) {
      if (s === this.editing) continue; // 편집 중인 텍스트는 입력창이 대신 표시
      this._drawStroke(s);
    }
    if (this.active && this.active.tool === 'pen') this._drawStroke(this.active);
    ctx.restore();
  }

  // 필압(pressure)에 따라 선 굵기 가변
  _segWidth(stroke, p1, p2) {
    const pressure = ((p1[2] || 0.5) + (p2[2] || 0.5)) / 2;
    return Math.max(0.4, stroke.width * (0.4 + pressure * 1.2));
  }

  _drawStroke(stroke) {
    if (stroke.tool === 'text') { this._drawText(stroke); return; }
    const ctx = this.ctx;
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;
    ctx.strokeStyle = ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      const w = this._segWidth(stroke, pts[0], pts[0]);
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      ctx.lineWidth = this._segWidth(stroke, pts[i - 1], pts[i]);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
  }

  // 진행 중 스트로크의 마지막 구간만 그려서 지연 최소화
  _drawSegment(stroke, fromIdx) {
    if (fromIdx < 0) return;
    const ctx = this.ctx;
    this._applyTransform();
    const p1 = stroke.points[fromIdx], p2 = stroke.points[fromIdx + 1];
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this._segWidth(stroke, p1, p2);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.stroke();
  }

  // ---------- 데이터 입출력 ----------

  load(strokes) {
    this.strokes = Array.isArray(strokes) ? strokes : [];
    this.undoStack = [];
    this.redoStack = [];
    this.active = null;
    this.render();
  }

  getStrokes() {
    return this.strokes;
  }
}
