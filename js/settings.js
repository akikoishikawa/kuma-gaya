// 設定と再生回数。どちらも localStorage に保存する（使えない環境でも動作は続ける）。

const SETTINGS_KEY = 'kuma-gaya:settings:v1';
const STATS_KEY = 'kuma-gaya:stats:v1';
// 保存形式の版。初期値の意味が変わったときに上げ、古い保存値を読み替える
//   2：画面にインカメラ映像を出すようにしたので、カメラの初期値を背面→前面に
const SCHEMA = 2;

export const DEFAULTS = Object.freeze({
  intervalMs: 250,        // 検出間隔（250ms = 約4fps）
  nearPct: 35,            // 反応する範囲：人の枠の面積が画面のこの%未満の人（遠い人）はいないものとみなす
                          //   iPhone XR 背面カメラ・縦向きで、約1m ≈ 40〜50%、1.5m ≈ 30%、2m ≈ 17%、3m ≈ 8%（目安）
  approachPct: 50,        // 接近しきい値：これを超えたら滞在を待たずにすぐ呼びかける
  dwellSec: 1.5,          // 滞在：何秒連続で検出されたら呼びかけるか
  followupSec: 6,         // 呼びかけ後、何秒残っていたら2段目を流すか（0で2段目なし）
  cooldownSec: 25,        // 話し終えてから次の呼びかけまでの休み
  volume: 90,             // 音量（%）
  camera: 'user',         // 'user' = 前面（インカメラ） / 'environment' = 背面
  debug: false,           // デバッグ表示（状態・検出時間などの文字）
  speechFallback: true,   // 音声ファイルがないとき Web Speech API で読み上げる（テスト用）
  lookEnabled: true,      // こっちを向いたら反応する（待機中はすぐ呼びかけ、呼びかけ後はすぐ2段目）
  lookSec: 0.5,           // 何秒こっちを向いていたら反応するか
  lookTolerance: 0.25,    // 正面とみなす範囲（鼻先のずれ÷両目の間隔）。大きいほど甘い
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
    // 「反応する範囲」を足す前の保存値：接近しきい値が旧初期値 25% のままなら新しい初期値にする
    if (!('nearPct' in stored) && stored.approachPct === 25) delete stored.approachPct;
    if ((stored._schema || 1) < 2 && stored.camera === 'environment') delete stored.camera;
    this.values = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (k in stored && typeof stored[k] === typeof DEFAULTS[k]) this.values[k] = stored[k];
    }
  }

  set(key, value) {
    if (!(key in DEFAULTS) || this.values[key] === value) return;
    this.values[key] = value;
    save(SETTINGS_KEY, { ...this.values, _schema: SCHEMA });
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
