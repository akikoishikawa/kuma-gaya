// 隠し設定パネル。画面の左上の隅を 3 回タップで開く。

import { DEFAULTS } from './settings.js';

const CORNER_PX = 90;
const TAP_WINDOW_MS = 1200;

const FIELDS = [
  { key: 'intervalMs', label: '検出間隔', min: 100, max: 2000, step: 50, fmt: (v) => `${v} ms（約 ${(1000 / v).toFixed(1)} fps）` },
  { key: 'approachPct', label: '接近しきい値（人の枠の面積）', min: 5, max: 90, step: 1, fmt: (v) => `画面の ${v}%` },
  { key: 'dwellSec', label: '滞在時間', min: 0.5, max: 10, step: 0.1, fmt: (v) => `${v.toFixed(1)} 秒` },
  { key: 'followupSec', label: '2段目までの待ち時間', min: 0, max: 30, step: 0.5, fmt: (v) => (v === 0 ? '2段目なし' : `${v} 秒`) },
  { key: 'cooldownSec', label: 'クールダウン', min: 0, max: 180, step: 1, fmt: (v) => `${v} 秒` },
  { key: 'volume', label: '音量', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: 'camera', label: '使用カメラ', type: 'select', options: [['environment', '背面'], ['user', '前面']] },
  { key: 'debug', label: 'デバッグ表示（映像・検出枠・状態）', type: 'checkbox' },
  { key: 'speechFallback', label: '音声ファイルがないとき読み上げで代用（テスト用・本番はOFF）', type: 'checkbox' },
];

const ADVANCED = [
  { key: 'minScore', label: '人と判定する信頼度', min: 0.2, max: 0.9, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'lostGraceMs', label: '見失いの猶予', min: 0, max: 3000, step: 100, fmt: (v) => `${v} ms` },
  { key: 'delegate', label: '検出の処理方式', type: 'select', options: [['CPU', 'CPU（推奨）'], ['GPU', 'GPU']] },
];

const CATEGORY_LABEL = { call: '呼びかけ', followup: '2段目' };
const REASON_LABEL = { approach: '接近', dwell: '滞在', stay: '居残り' };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export class Panel {
  constructor({ settings, stats, player, getStatus, onTestPlay, onUpdateApp }) {
    Object.assign(this, { settings, stats, player, getStatus, onTestPlay, onUpdateApp });
    this.root = document.getElementById('panel');
    this.onClose = null;
    this.taps = [];
    this.statusTimer = 0;
    document.addEventListener('pointerdown', (e) => this.handleTap(e), true);
    stats.addEventListener('change', () => this.isOpen && this.renderStats());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  handleTap(e) {
    if (this.isOpen || e.clientX > CORNER_PX || e.clientY > CORNER_PX) return;
    const now = performance.now();
    this.taps = this.taps.filter((t) => now - t < TAP_WINDOW_MS);
    this.taps.push(now);
    if (this.taps.length >= 3) {
      this.taps = [];
      e.preventDefault();
      this.open();
    }
  }

  open() {
    this.build();
    this.root.hidden = false;
    document.body.classList.add('panel-open');
    this.refreshStatus();
    this.statusTimer = setInterval(() => this.refreshStatus(), 1000);
  }

  close() {
    this.root.hidden = true;
    document.body.classList.remove('panel-open');
    clearInterval(this.statusTimer);
    this.onClose?.();
  }

  field(f) {
    const v = this.settings.values[f.key];
    if (f.type === 'checkbox') {
      const input = el('input', { type: 'checkbox' });
      input.checked = v;
      input.addEventListener('change', () => this.settings.set(f.key, input.checked));
      return el('label', { class: 'row check' }, input, el('span', {}, f.label));
    }
    if (f.type === 'select') {
      const select = el('select');
      for (const [value, text] of f.options) {
        const o = el('option', { value }, text);
        if (value === v) o.selected = true;
        select.append(o);
      }
      select.addEventListener('change', () => this.settings.set(f.key, select.value));
      return el('label', { class: 'row' }, el('span', { class: 'name' }, f.label), select);
    }
    const out = el('output', {}, f.fmt(v));
    const input = el('input', { type: 'range', min: f.min, max: f.max, step: f.step });
    input.value = v;
    input.addEventListener('input', () => {
      const n = Number(input.value);
      out.textContent = f.fmt(n);
      this.settings.set(f.key, n);
    });
    return el('label', { class: 'row range' }, el('span', { class: 'name' }, f.label, out), input);
  }

  build() {
    const r = this.root;
    r.replaceChildren();
    const testBtns = Object.entries(CATEGORY_LABEL).map(([cat, label]) => el('button', {
      type: 'button',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const ok = await this.onTestPlay(cat);
        btn.disabled = false;
        if (!ok) this.flash('再生できませんでした（再生中、または音声も読み上げもない）');
      },
    }, `${label}をテスト再生`));

    this.statusEl = el('pre', { class: 'status' });
    this.offlineEl = el('div', { class: 'offline' }, '確認中…');
    this.phrasesEl = el('div');
    this.statsEl = el('div');
    this.flashEl = el('p', { class: 'flash' });

    r.append(
      el('header', {},
        el('h2', {}, 'くまガヤ 設定'),
        el('button', { type: 'button', class: 'close', onclick: () => this.close() }, '閉じる')),
      this.flashEl,
      el('section', {}, el('h3', {}, '動作'), ...FIELDS.map((f) => this.field(f))),
      el('details', {}, el('summary', {}, '詳細設定'), ...ADVANCED.map((f) => this.field(f))),
      el('section', {}, el('h3', {}, '動作確認'), el('div', { class: 'buttons' }, ...testBtns), this.statusEl),
      el('section', {}, el('h3', {}, '再生回数'), this.statsEl,
        el('div', { class: 'buttons' }, el('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            if (confirm('再生回数をリセットします。よろしいですか？')) this.stats.reset();
          },
        }, '回数をリセット'))),
      el('section', {}, el('h3', {}, 'フレーズ'), this.phrasesEl),
      el('section', {}, el('h3', {}, 'オフライン準備'), this.offlineEl,
        el('div', { class: 'buttons' },
          el('button', { type: 'button', onclick: () => this.checkOffline() }, '再確認'),
          el('button', {
            type: 'button',
            onclick: async () => {
              this.flash('更新を確認しています…');
              try {
                await this.onUpdateApp();
                this.flash('確認しました。新しい版があれば、アプリを開き直すと反映されます。');
              } catch (e) {
                this.flash(`更新できませんでした：${e.message}`);
              }
              this.renderPhrases();
              this.checkOffline();
            },
          }, '音声・アプリを更新'))),
      el('section', {}, el('div', { class: 'buttons' },
        el('button', {
          type: 'button',
          onclick: () => {
            if (confirm('すべての設定を初期値に戻します。よろしいですか？')) {
              this.settings.resetAll();
              this.build();
            }
          },
        }, '設定を初期値に戻す'))),
      el('p', { class: 'note' }, `初期値：検出 ${DEFAULTS.intervalMs}ms／接近 ${DEFAULTS.approachPct}%／滞在 ${DEFAULTS.dwellSec}秒／2段目 ${DEFAULTS.followupSec}秒／クールダウン ${DEFAULTS.cooldownSec}秒`),
    );
    this.renderStats();
    this.renderPhrases();
    this.checkOffline();
  }

  flash(text) {
    this.flashEl.textContent = text;
  }

  refreshStatus() {
    const s = this.getStatus();
    const cam = s.camera ? `${s.camera.width}×${s.camera.height} ${s.camera.facingMode || ''}` : '未起動';
    this.statusEl.textContent = [
      `動作中　${s.started ? 'はい' : 'いいえ（スタート前）'}`,
      `検出　　${s.delegate || '-'}　${s.detectMs.toFixed(0)} ms／回　${s.fps.toFixed(1)} fps`,
      `カメラ　${cam}`,
      `音声　　${s.audio}　　画面ロック防止 ${s.wakeState}`,
    ].join('\n');
  }

  renderStats() {
    const d = this.stats.data;
    const rows = [];
    for (const [cat, label] of Object.entries(CATEGORY_LABEL)) rows.push([label, d.byCategory[cat] || 0]);
    const reasons = Object.entries(REASON_LABEL).map(([k, l]) => `${l} ${d.byReason[k] || 0}`).join('／');
    const byId = this.player.phrases.map((p) => `${p.id}: ${d.byId[p.id] || 0}`).join('　');
    this.statsEl.replaceChildren(
      el('table', {}, ...rows.map(([l, n]) => el('tr', {}, el('th', {}, l), el('td', {}, `${n} 回`)))),
      el('p', { class: 'note' }, `きっかけ：${reasons}`),
      el('p', { class: 'note' }, byId),
      el('p', { class: 'note' }, `集計開始 ${new Date(d.since).toLocaleString('ja-JP')}${d.lastAt ? `／最終 ${new Date(d.lastAt).toLocaleString('ja-JP')}` : ''}`),
    );
  }

  renderPhrases() {
    const items = this.player.phrases.map((p) => {
      const src = this.player.sourceOf(p);
      const hasRaw = this.player.raw.has(p.id);
      let badge;
      if (src === 'file') badge = el('span', { class: 'badge ok' }, '音声');
      else if (hasRaw && !this.player.ctx) badge = el('span', { class: 'badge ok' }, '音声（スタート後に有効）');
      else if (this.player.decodeErrors.has(p.id)) badge = el('span', { class: 'badge ng' }, '音声が壊れている');
      else if (src === 'speech') badge = el('span', { class: 'badge warn' }, '読み上げ代用');
      else badge = el('span', { class: 'badge ng' }, '音声なし');
      return el('li', {}, badge, ` ${p.id}：${p.text}`);
    });
    this.phrasesEl.replaceChildren(el('ul', { class: 'phrases' }, ...items));
  }

  async checkOffline() {
    const out = this.offlineEl;
    if (!('caches' in window) || !('serviceWorker' in navigator)) {
      out.textContent = 'この環境ではオフライン動作に対応していません';
      return;
    }
    const has = async (path) => !!(await caches.match(new URL(path, location.href).href));
    const core = {
      アプリ: 'js/app.js',
      検出モデル: 'models/efficientdet_lite0.tflite',
      'MediaPipe WASM': 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
    };
    const lines = [];
    let allOk = true;
    for (const [label, path] of Object.entries(core)) {
      const ok = await has(path);
      allOk &&= ok;
      lines.push(`${ok ? '✓' : '✗'} ${label}`);
    }
    let audioOk = 0;
    for (const p of this.player.phrases) if (await has(`audio/${p.file}`)) audioOk++;
    lines.push(`${audioOk === this.player.phrases.length ? '✓' : '△'} 音声ファイル ${audioOk} / ${this.player.phrases.length}`);
    const controlled = !!navigator.serviceWorker.controller;
    lines.push(`${controlled ? '✓' : '✗'} Service Worker ${controlled ? '有効' : '未有効（一度開き直してください）'}`);
    out.textContent = `${allOk && controlled ? '機内モードでも動作できます' : 'まだオフラインでは動きません'}\n${lines.join('\n')}`;
  }
}
