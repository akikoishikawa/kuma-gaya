import { Settings, Stats } from './settings.js';
import { Player } from './player.js';
import { Detector } from './detector.js';
import { FaceWatcher } from './face.js';
import { Trigger } from './trigger.js';
import { Panel } from './panel.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const statusEl = $('status');
const errorEl = $('error');
const startScreen = $('start');
const startBtn = $('start-btn');
const startMsg = $('start-msg');

const settings = new Settings();
const stats = new Stats();
const player = new Player(settings);
const detector = new Detector();
const faceWatcher = new FaceWatcher();
const trigger = new Trigger({ settings, player, stats });

let stream = null;
let started = false;
let timer = 0;
let wakeLock = null;
let wakeState = '未取得';
let lastTick = 0;
let fps = 0;
let nearest = 0; // 直近フレームで一番大きい人の枠の面積比（遠い人も含む。範囲の合わせ込み用）

// ---- Service Worker（オフライン用）。?nosw を付けると登録しない（開発用）
let swRegistration = null;
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register('./sw.js').then((reg) => { swRegistration = reg; })
    .catch((e) => console.warn('Service Worker を登録できませんでした', e));
}

const panel = new Panel({
  settings,
  stats,
  player,
  getStatus: () => ({
    started,
    delegate: detector.delegate,
    detectMs: detector.lastMs,
    faceMs: faceWatcher.lastMs,
    nearest,
    fps,
    wakeState,
    audio: player.contextState,
    camera: stream?.getVideoTracks()[0]?.getSettings?.() || null,
  }),
  onTestPlay: async (category) => {
    if (!player.ctx) player.unlock();
    await player.decodeAll();
    return player.play(category);
  },
  onUpdateApp: async () => {
    await player.reloadAudio();
    if (swRegistration) await swRegistration.update();
  },
});

// ---- 起動
player.loadPhrases().catch((e) => showError(e.message));

startBtn.addEventListener('click', async () => {
  // ここまでは同期的に（タップの直後に）実行する必要がある
  player.unlock();
  requestWakeLock();
  enterFullscreen();

  startBtn.disabled = true;
  startMsg.textContent = '準備中…（初回は少し時間がかかります）';
  try {
    await Promise.all([
      startCamera(),
      detector.init({ delegate: settings.values.delegate, minScore: settings.values.minScore }),
      initFaces(),
      player.decodeAll(),
    ]);
  } catch (e) {
    startBtn.disabled = false;
    startMsg.textContent = explainError(e);
    console.error(e);
    return;
  }
  started = true;
  startScreen.hidden = true;
  startMsg.textContent = '';
  applyDebug();
  loop();
});

// 全画面にする。iPhone の Safari はページの全画面に対応していないので、
// ホーム画面に追加したアプリとして開く（それで全画面になる）。対応している端末（PC・Android・iPad）だけ効く
function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => {});
  } catch { /* 非対応 */ }
}

// 顔検出は「こっちを向いた」反応と画面表示に使う。初期化に失敗しても本体は止めない
async function initFaces() {
  try {
    await faceWatcher.init({ delegate: settings.values.delegate });
  } catch (e) {
    console.warn('顔検出を初期化できませんでした（こっちを向いた反応は無効）', e);
  }
}

function explainError(e) {
  if (e?.name === 'NotAllowedError') return 'カメラが許可されていません。設定 > Safari > カメラ を「許可」にしてから再度スタートしてください。';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'カメラが見つかりません。設定パネルで前面/背面を切り替えてみてください。';
  if (!window.isSecureContext) return 'HTTPS で開いてください（カメラは HTTPS でしか使えません）。';
  return `起動できませんでした：${e?.message || e}`;
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = !text;
}

// ---- カメラ
async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: settings.values.camera },
      // 検出モデルの入力は 320x320 なので大きな映像は不要。負荷と発熱を抑える
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 15, max: 30 },
    },
  });
  video.srcObject = stream;
  await video.play();
  const mirror = settings.values.camera === 'user';
  video.classList.toggle('mirror', mirror);
  canvas.classList.toggle('mirror', mirror);
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---- 画面スリープ防止
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    wakeState = '非対応（自動ロックを「なし」に）';
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeState = '有効';
    wakeLock.addEventListener('release', () => { wakeState = '解除された'; });
  } catch (e) {
    wakeState = `失敗：${e.name}`;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !started) return;
  await requestWakeLock();
  player.resume();
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') {
    try {
      await startCamera();
      showError('');
    } catch (e) {
      showError(explainError(e));
    }
  }
});

// ---- 検出ループ（毎フレームではなく設定間隔で実行）
function loop() {
  clearTimeout(timer);
  const t0 = performance.now();
  if (!document.hidden && video.readyState >= 2 && video.videoWidth > 0) {
    let boxes = [];
    let near = [];
    let faces = null;
    const area = video.videoWidth * video.videoHeight;
    try {
      boxes = detector.detect(video);
      // 小さく写っている人（遠い人＝通路の向こう側など）はいないものとみなす
      const minRatio = settings.values.nearPct / 100;
      for (const b of boxes) b.ratio = Math.min(1, (b.width * b.height) / area);
      near = boxes.filter((b) => b.ratio >= minRatio);
      // 人が写っていれば顔を調べる（画面に点を描くため、遠い人も含めて大きい順に 2 人まで）
      if (boxes.length > 0 && faceWatcher.ready) {
        faces = faceWatcher.detect(video, boxes, settings.values.lookTolerance);
      }
    } catch (e) {
      console.error(e);
    }
    nearest = boxes.reduce((m, b) => Math.max(m, b.ratio || 0), 0);
    // 反応に使うのは範囲内の人の顔だけ
    const nearFaces = faces && faces.filter((f) => near.includes(f.person));
    trigger.update(t0, near, video.videoWidth, video.videoHeight, nearFaces);
    if (lastTick) {
      const inst = 1000 / (t0 - lastTick);
      fps = fps ? fps * 0.8 + inst * 0.2 : inst;
    }
    lastTick = t0;
    render(boxes, near.length, faces, t0);
  }
  const wait = settings.values.intervalMs - (performance.now() - t0);
  timer = setTimeout(loop, Math.max(10, wait));
}

// ---- デバッグ表示
const ctx2d = canvas.getContext('2d');

function applyDebug() {
  const on = settings.values.debug;
  document.body.classList.toggle('debug', on);
  statusEl.hidden = !on || !started;
}

// 顔の 6 点（右目・左目・鼻先・口・右耳・左耳）をつなぐ線
const FACE_LINES = [[0, 1], [0, 2], [1, 2], [2, 3], [0, 4], [1, 5]];

function render(boxes, nearCount, faces, now) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw;
    canvas.height = vh;
  }
  ctx2d.clearRect(0, 0, vw, vh);
  const threshold = settings.values.approachPct / 100;
  const nearMin = settings.values.nearPct / 100;
  const unit = Math.max(vw, vh) / 640; // 映像の大きさに合わせて線と文字の太さを決める
  ctx2d.lineWidth = 3 * unit;
  ctx2d.font = `bold ${Math.round(18 * unit)}px sans-serif`;
  // 枠の色：遠い（無視）＝灰の点線、範囲内＝水色、接近＝赤
  for (const b of boxes) {
    const r = b.ratio ?? (b.width * b.height) / (vw * vh);
    const far = r < nearMin;
    ctx2d.strokeStyle = far ? '#777' : r >= threshold ? '#ff5a3c' : '#3cd2ff';
    ctx2d.setLineDash(far ? [ctx2d.lineWidth * 3, ctx2d.lineWidth * 3] : []);
    ctx2d.strokeRect(b.originX, b.originY, b.width, b.height);
    ctx2d.setLineDash([]);
    if (!settings.values.debug) continue; // 枠の大きさの数字はデバッグ表示のときだけ
    const label = `${Math.round(r * 100)}%${far ? ' 遠い' : ''} / ${Math.round(b.score * 100)}`;
    ctx2d.fillStyle = ctx2d.strokeStyle;
    // 前面カメラは canvas ごと左右反転しているので文字も反転して書く
    if (video.classList.contains('mirror')) {
      ctx2d.save();
      ctx2d.scale(-1, 1);
      ctx2d.fillText(label, -(b.originX + b.width), b.originY - 6);
      ctx2d.restore();
    } else {
      ctx2d.fillText(label, b.originX, b.originY - 6);
    }
  }
  // 顔：6 点を線でつないで描く。正面なら黄、横向きなら白
  for (const f of faces || []) {
    const color = f.facing ? '#ffd23c' : '#e8e8e8';
    const kp = f.keypoints;
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 2 * unit;
    ctx2d.beginPath();
    for (const [a, b] of FACE_LINES) {
      if (!kp[a] || !kp[b]) continue;
      ctx2d.moveTo(kp[a].x, kp[a].y);
      ctx2d.lineTo(kp[b].x, kp[b].y);
    }
    ctx2d.stroke();
    for (const [i, k] of kp.entries()) {
      ctx2d.beginPath();
      ctx2d.arc(k.x, k.y, (i < 3 ? 5 : 4) * unit, 0, Math.PI * 2);
      ctx2d.fillStyle = color;
      ctx2d.fill();
      ctx2d.lineWidth = 1.5 * unit;
      ctx2d.strokeStyle = '#000';
      ctx2d.stroke();
    }
  }
  if (!settings.values.debug) return;
  const d = trigger.describe(now);
  const s = settings.values;
  statusEl.textContent = [
    `状態　${d.label}`,
    `人　　範囲内 ${nearCount} 人／遠い ${boxes.length - nearCount} 人　最大 ${Math.round(nearest * 100)}%（範囲 ${s.nearPct}%〜・接近 ${s.approachPct}%）`,
    `滞在　${d.stay.toFixed(1)} / ${s.dwellSec} 秒`,
    `顔　　${s.lookEnabled ? `${faces ? `${faces.length} 個（範囲内 ${d.faces}）` : '調べていない'}　正面 ${d.look.toFixed(1)} / ${s.lookSec} 秒${faces && faces[0] ? `（ずれ ${faces[0].offset.toFixed(2)}／許容 ${s.lookTolerance}）` : ''}` : 'OFF'}`,
    `検出　人 ${detector.lastMs.toFixed(0)} ms　顔 ${faces ? faceWatcher.lastMs.toFixed(0) : '-'} ms　${fps.toFixed(1)} fps（${detector.delegate}）`,
    `映像　${vw}×${vh}　音声 ${player.contextState}　画面ロック防止 ${wakeState}`,
  ].join('\n');
}

// ---- 設定の変更を反映
settings.addEventListener('change', async (e) => {
  const { key, value } = e.detail;
  if (key === 'debug') applyDebug();
  if (!started) return;
  try {
    if (key === 'camera') await startCamera();
    if (key === 'delegate') {
      await detector.init({ delegate: value, minScore: settings.values.minScore });
      await initFaces();
    }
    if (key === 'minScore') await detector.setMinScore(value);
    showError('');
  } catch (err) {
    showError(explainError(err));
  }
});

panel.onClose = applyDebug;
