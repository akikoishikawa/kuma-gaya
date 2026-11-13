// 設定と再生回数。どちらも localStorage に保存する（使えない環境でも動作は続ける）。

const SETTINGS_KEY = 'kuma-gaya:settings:v1';
const STATS_KEY = 'kuma-gaya:stats:v1';

export const DEFAULTS = Object.freeze({
  intervalMs: 250,        // 検出間隔（250ms = 約4fps）
  approachPct: 25,        // 接近しきい値：人の枠の面積が画面の何%を超えたら呼びかけるか
  dwellSec: 1.5,          // 滞在：何秒連続で検出されたら呼びかけるか
  followupSec: 6,         // 呼びかけ後、何秒残っていたら2段目を流すか（0で2段目なし）
  cooldownSec: 25,        // 話し終えてから次の呼びかけまでの休み
  volume: 90,             // 音量（%）
  camera: 'environment',  // 'environment' = 背面 / 'user' = 前面
  debug: false,           // デバッグ表示（OFF時は画面真っ黒）
  speechFallback: true,   // 音声ファイルがないとき Web Speech API で読み上げる（テスト用）
  // 詳細
  minScore: 0.5,          // 人と判定する信頼度の下限
  lostGraceMs: 800,       // 一瞬見失っても「いる」とみなす猶予
  delegate: 'CPU',        // MediaPipe の処理方式 'CPU' / 'GPU'
});

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // プライベートモード等。保存できなくても動作は続ける
  }
}

export class Settings extends EventTarget {
  constructor() {
    super();
    const stored = load(SETTINGS_KEY) || {};
    this.values = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (k in stored && typeof stored[k] === typeof DEFAULTS[k]) this.values[k] = stored[k];
    }
  }

  set(key, value) {
    if (!(key in DEFAULTS) || this.values[key] === value) return;
    this.values[key] = value;
    save(SETTINGS_KEY, this.values);
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value } }));
  }

  resetAll() {
    for (const [k, v] of Object.entries(DEFAULTS)) this.set(k, v);
  }
}

function emptyStats() {
  return { since: new Date().toISOString(), byCategory: {}, byId: {}, byReason: {} };
}

// 再生回数（展示後の振り返り用）
export class Stats extends EventTarget {
  constructor() {
    super();
    const stored = load(STATS_KEY);
    this.data = stored && stored.byCategory ? { ...emptyStats(), ...stored } : emptyStats();
  }

  record(category, id, reason) {
    const d = this.data;
    d.byCategory[category] = (d.byCategory[category] || 0) + 1;
    if (id) d.byId[id] = (d.byId[id] || 0) + 1;
    if (reason) d.byReason[reason] = (d.byReason[reason] || 0) + 1;
    d.lastAt = new Date().toISOString();
    save(STATS_KEY, d);
    this.dispatchEvent(new Event('change'));
  }

  reset() {
    this.data = emptyStats();
    save(STATS_KEY, this.data);
    this.dispatchEvent(new Event('change'));
  }
}
