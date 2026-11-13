import { Settings, Stats } from './settings.js';
import { Player } from './player.js';
import { Detector } from './detector.js';
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
const trigger = new Trigger({ settings, player, stats });

let stream = null;
let started = false;
let timer = 0;
let wakeLock = null;
let wakeState = '未取得';
let lastTick = 0;
let fps = 0;

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

  startBtn.disabled = true;
  startMsg.textContent = '準備中…（初回は少し時間がかかります）';
  try {
    await Promise.all([
      startCamera(),
      detector.init({ delegate: settings.values.delegate, minScore: settings.values.minScore }),
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
    try {
      boxes = detector.detect(video);
    } catch (e) {
      console.error(e);
    }
    trigger.update(t0, boxes, video.videoWidth, video.videoHeight);
    if (lastTick) {
      const inst = 1000 / (t0 - lastTick);
      fps = fps ? fps * 0.8 + inst * 0.2 : inst;
    }
    lastTick = t0;
    if (settings.values.debug) render(boxes, t0);
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
  if (!on) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

function render(boxes, now) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw;
    canvas.height = vh;
  }
  ctx2d.clearRect(0, 0, vw, vh);
  const threshold = settings.values.approachPct / 100;
  ctx2d.lineWidth = Math.max(2, vw / 200);
  ctx2d.font = `${Math.round(vh / 22)}px sans-serif`;
  for (const b of boxes) {
    const r = (b.width * b.height) / (vw * vh);
    ctx2d.strokeStyle = r >= threshold ? '#ff5a3c' : '#3cd2ff';
    ctx2d.strokeRect(b.originX, b.originY, b.width, b.height);
    const label = `${Math.round(r * 100)}% / ${Math.round(b.score * 100)}`;
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
  const d = trigger.describe(now);
  const s = settings.values;
  statusEl.textContent = [
    `状態　${d.label}`,
    `人　　${d.count} 人　最大 ${Math.round(d.ratio * 100)}%（接近 ${s.approachPct}%）`,
    `滞在　${d.stay.toFixed(1)} / ${s.dwellSec} 秒`,
    `検出　${detector.lastMs.toFixed(0)} ms　${fps.toFixed(1)} fps（${detector.delegate}）`,
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
    if (key === 'delegate') await detector.init({ delegate: value, minScore: settings.values.minScore });
    if (key === 'minScore') await detector.setMinScore(value);
    showError('');
  } catch (err) {
    showError(explainError(err));
  }
});

panel.onClose = applyDebug;
