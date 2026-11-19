// 隠し設定パネル。画面の左上の隅を 3 回タップで開く。

import { DEFAULTS } from './settings.js';

const CORNER_PX = 90;
const TAP_WINDOW_MS = 1200;

const FIELDS = [
  { key: 'intervalMs', label: '検出間隔', min: 100, max: 2000, step: 50, fmt: (v) => `${v} ms（約 ${(1000 / v).toFixed(1)} fps）` },
  { key: 'nearPct', label: '反応する範囲（これより小さく写る遠い人は無視）', min: 1, max: 90, step: 1, fmt: (v) => `人の枠が画面の ${v}% 以上` },
  { key: 'approachPct', label: '接近しきい値（超えたら滞在を待たずに呼びかけ）', min: 5, max: 100, step: 1, fmt: (v) => `画面の ${v}%` },
  { key: 'dwellSec', label: '滞在時間', min: 0.5, max: 10, step: 0.1, fmt: (v) => `${v.toFixed(1)} 秒` },
  { key: 'followupSec', label: '2段目までの待ち時間', min: 0, max: 30, step: 0.5, fmt: (v) => (v === 0 ? '2段目なし' : `${v} 秒`) },
  { key: 'cooldownSec', label: 'クールダウン', min: 0, max: 180, step: 1, fmt: (v) => `${v} 秒` },
  { key: 'volume', label: '音量', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: 'camera', label: '使用カメラ', type: 'select', options: [['user', '前面（インカメラ）'], ['environment', '背面']] },
  { key: 'lookEnabled', label: 'こっちを向いたら反応（待機中はすぐ呼びかけ、呼びかけ後はすぐ2段目）', type: 'checkbox' },
  { key: 'lookSec', label: 'こっちを向いている時間', min: 0.2, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)} 秒` },
  { key: 'debug', label: 'デバッグ表示（状態・検出時間・枠の大きさなどの文字）', type: 'checkbox' },
  { key: 'speechFallback', label: '音声ファイルがないとき読み上げで代用（テスト用・本番はOFF）', type: 'checkbox' },
];

const ADVANCED = [
  { key: 'minScore', label: '人と判定する信頼度', min: 0.2, max: 0.9, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'lookTolerance', label: '正面とみなす範囲（鼻のずれ）', min: 0.1, max: 0.6, step: 0.05, fmt: (v) => `${v.toFixed(2)}（大きいほど甘い）` },
  { key: 'lostGraceMs', label: '見失いの猶予', min: 0, max: 3000, step: 100, fmt: (v) => `${v} ms` },
  { key: 'delegate', label: '検出の処理方式', type: 'select', options: [['CPU', 'CPU（推奨）'], ['GPU', 'GPU']] },
];

const CALIB_WAIT_SEC = 5;    // ボタンを押してから測り始めるまで（立ち位置に移動する時間）
const CALIB_MEASURE_SEC = 3; // 測る時間
const CALIB_MARGIN = 0.9;    // 測った大きさより少しだけ小さめを境目にする（その位置の人を確実に含める）

const CATEGORY_LABEL = { call: '呼びかけ', followup: '2段目' };
const REASON_LABEL = { look: '向いて呼びかけ', approach: '接近', dwell: '滞在', stay: '居残り', lookNext: '向いて2段目' };

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
    // 枠の色の説明には設定の数字が入るので、設定が変わったら書き直す
    settings.addEventListener('change', () => this.isOpen && this.legendBox?.replaceChildren(this.legend()));
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
    this.legendBox = el('div', {}, this.legend());
    this.logEl = el('pre', { class: 'status log' });
    this.offlineEl = el('div', { class: 'offline' }, '確認中…');
    this.phrasesEl = el('div');
    this.statsEl = el('div');
    this.flashEl = el('p', { class: 'flash' });

    r.append(
      el('header', {},
        el('h2', {}, 'くまガヤ 設定'),
        el('button', { type: 'button', class: 'close', onclick: () => this.close() }, '閉じる')),
      this.flashEl,
      el('section', {}, el('h3', {}, '画面の枠の色'), this.legendBox),
      el('section', {}, el('h3', {}, '動作'), ...FIELDS.map((f) => this.field(f))),
      el('section', {}, el('h3', {}, '反応する範囲を合わせる'),
        el('p', { class: 'note' }, 'ここに立った人より遠い人（小さく写る人）には話しかけなくなります。会場に置いたら最初にやってください。'),
        el('ol', { class: 'steps' },
          el('li', {}, 'スタートした状態で、下の「いまの立ち位置を境目にする」を押す'),
          el('li', {}, `${CALIB_WAIT_SEC} 秒以内に、ぬいぐるみから反応させたい距離（例：1m）に、ぬいぐるみの方を向いて立つ`),
          el('li', {}, `「ピッ」から ${CALIB_MEASURE_SEC} 秒間測り、「ピピッ」で終わり。そのまま動かずに待つ`),
          el('li', {}, `測った大きさより 1 割小さい値が「反応する範囲」になる（その位置に立った人は確実に含まれる）`)),
        el('p', { class: 'note' }, '・測る間は、ほかの人が近くに写らないようにする\n・子ども向けなら子どもに立ってもらう（大人で合わせると、子どもはもう少し近づかないと反応しない）\n・結果はこの画面の上に表示され、「動作」の「反応する範囲」に入る'),
        el('div', { class: 'buttons' }, el('button', { type: 'button', onclick: (ev) => this.calibrate(ev.currentTarget) }, 'いまの立ち位置を境目にする'))),
      el('details', {}, el('summary', {}, '詳細設定'), ...ADVANCED.map((f) => this.field(f))),
      el('section', {}, el('h3', {}, '動作確認'), el('div', { class: 'buttons' }, ...testBtns), this.statusEl),
      el('section', {}, el('h3', {}, '最近の動き（新しい順）'),
        el('p', { class: 'note' }, '話しかけなかった・2回目が出なかったときは、ここで理由を確かめられます。アプリを開き直すと消えます。'),
        this.logEl),
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
      el('p', { class: 'note' }, `初期値：検出 ${DEFAULTS.intervalMs}ms／範囲 ${DEFAULTS.nearPct}%／接近 ${DEFAULTS.approachPct}%／滞在 ${DEFAULTS.dwellSec}秒／2段目 ${DEFAULTS.followupSec}秒／クールダウン ${DEFAULTS.cooldownSec}秒`),
    );
    this.renderStats();
    this.renderPhrases();
    this.checkOffline();
  }

  // 枠の色の見方。数字は今の設定から出す
  legend() {
    const s = this.settings.values;
    const item = (cls, name, text) => el('li', {}, el('span', { class: `swatch ${cls}` }), el('b', {}, name), `　${text}`);
    return el('div', {},
      el('ul', { class: 'legend' },
        item('far', '灰色の点線', `遠い人（枠が画面の ${s.nearPct}% 未満）。いないものとして扱い、話しかけない`),
        item('near', '青', `反応する範囲の人（${s.nearPct}% 以上 ${s.approachPct}% 未満）。${s.dwellSec} 秒いるか、こっちを ${s.lookSec} 秒向いたら話しかける`),
        item('close', '赤', `すぐ近くの人（${s.approachPct}% 以上＝接近しきい値）。待たずにすぐ話しかける`)),
      el('p', { class: 'note' }, `・%は人の枠が画面に占める広さ。近いほど大きい（数字はデバッグ表示 ON で枠の上に出る）\n・境目は「反応する範囲」と「接近しきい値」で変えられる\n・一度範囲に入った人は、${Math.round(s.nearPct * 0.6)}%（境目の6割）まで下がっても青のまま（話しかけられて一歩下がっても続きを話すため）`));
  }

  // 立ってもらった位置での人の大きさを測り、「反応する範囲」にする
  async calibrate(btn) {
    if (!this.getStatus().started) {
      this.flash('先にスタートしてから（カメラが動いている状態で）測ってください');
      return;
    }
    btn.disabled = true;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = CALIB_WAIT_SEC; i > 0; i--) {
      this.flash(`${i} 秒後に測ります。立ち位置へどうぞ`);
      await sleep(1000);
    }
    this.beep(1);
    const samples = [];
    const end = performance.now() + CALIB_MEASURE_SEC * 1000;
    while (performance.now() < end) {
      this.flash(`測っています…（${((end - performance.now()) / 1000).toFixed(0)} 秒）`);
      const n = this.getStatus().nearest;
      if (n > 0) samples.push(n);
      await sleep(150);
    }
    this.beep(2);
    btn.disabled = false;
    if (samples.length < 3) {
      this.flash('人が写っていませんでした。カメラの向きを確かめて、もう一度やってください');
      return;
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const pct = Math.max(1, Math.min(90, Math.round(median * 100 * CALIB_MARGIN)));
    this.settings.set('nearPct', pct);
    this.build();
    const s = this.settings.values;
    this.flash(`測った大きさ ${Math.round(median * 100)}% → 反応する範囲を ${pct}% にしました。${s.approachPct <= pct ? '（接近しきい値がこれ以下なので、範囲に入るとすぐ呼びかけます）' : ''}`);
  }

  beep(times) {
    const ctx = this.player.ctx;
    if (!ctx) return;
    for (let i = 0; i < times; i++) {
      const t = ctx.currentTime + i * 0.18;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = 1200;
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    }
  }

  flash(text) {
    this.flashEl.textContent = text;
  }

  refreshStatus() {
    const s = this.getStatus();
    const cam = s.camera ? `${s.camera.width}×${s.camera.height} ${s.camera.facingMode || ''}` : '未起動';
    this.statusEl.textContent = [
      `動作中　${s.started ? 'はい' : 'いいえ（スタート前）'}`,
      `検出　　${s.delegate || '-'}　人 ${s.detectMs.toFixed(0)} ms／顔 ${s.faceMs.toFixed(0)} ms　${s.fps.toFixed(1)} fps`,
      `カメラ　${cam}`,
      `音声　　${s.audio}　　画面ロック防止 ${s.wakeState}`,
    ].join('\n');
    const t = (d) => d.toLocaleTimeString('ja-JP', { hour12: false });
    this.logEl.textContent = s.log.length
      ? [...s.log].reverse().map((e) => `${t(e.at)}  ${e.text}`).join('\n')
      : 'まだ何もありません';
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
      顔検出モデル: 'models/blaze_face_short_range.tflite',
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
