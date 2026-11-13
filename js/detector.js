// MediaPipe Object Detector（EfficientDet-Lite0, int8）で「人」だけを検出する。
// WASM とモデルはリポジトリ同梱のものを使う（CDN は使わない）。

const BASE = new URL('../', import.meta.url);
const FILESET = {
  // iOS 18 の Safari は WASM SIMD 対応なので SIMD 版だけを同梱している
  wasmLoaderPath: new URL('vendor/mediapipe/wasm/vision_wasm_internal.js', BASE).href,
  wasmBinaryPath: new URL('vendor/mediapipe/wasm/vision_wasm_internal.wasm', BASE).href,
};
const MODEL = new URL('models/efficientdet_lite0.tflite', BASE).href;

export class Detector {
  constructor() {
    this.od = null;
    this.delegate = '';
    this.lastTs = 0;
    this.lastMs = 0;
  }

  get ready() {
    return !!this.od;
  }

  async init({ delegate = 'CPU', minScore = 0.5 } = {}) {
    const { ObjectDetector } = await import('../vendor/mediapipe/vision_bundle.mjs');
    this.close();
    const create = (d) => ObjectDetector.createFromOptions(FILESET, {
      baseOptions: { modelAssetPath: MODEL, delegate: d },
      runningMode: 'VIDEO',
      scoreThreshold: minScore,
      maxResults: 5,
      categoryAllowlist: ['person'],
    });
    try {
      this.od = await create(delegate);
      this.delegate = delegate;
    } catch (e) {
      if (delegate !== 'GPU') throw e;
      console.warn('GPU で初期化できなかったので CPU に切り替えます', e);
      this.od = await create('CPU');
      this.delegate = 'CPU（GPU失敗）';
    }
  }

  async setMinScore(minScore) {
    if (this.od) await this.od.setOptions({ scoreThreshold: minScore });
  }

  // 戻り値：人の枠 [{originX, originY, width, height, score}]（映像のピクセル座標）
  detect(video) {
    if (!this.od) return [];
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1; // タイムスタンプは単調増加が必須
    this.lastTs = ts;
    const t0 = performance.now();
    const result = this.od.detectForVideo(video, ts);
    this.lastMs = performance.now() - t0;
    return result.detections.map((d) => ({
      ...d.boundingBox,
      score: d.categories[0]?.score ?? 0,
    }));
  }

  close() {
    if (this.od) {
      try { this.od.close(); } catch { /* noop */ }
    }
    this.od = null;
  }
}
