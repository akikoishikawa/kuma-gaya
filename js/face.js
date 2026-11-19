// こっちを向いているかを見る。MediaPipe Face Detector（BlazeFace short range）を使う。
// 顔の 6 点（右目・左目・鼻先・口・右耳・左耳）のうち、両目と鼻の位置から顔の向きを見積もる。
//
// short range は近い顔向けのモデルで、画面の中で顔が小さいと見つからない。
// そこで、人の枠の上のほう（頭のあたり）を切り出して拡大してから探す。
// 発熱を抑えるため、人がいるときだけ呼ぶ（app.js 側で判断）。結果は画面にも描く。

const BASE = new URL('../', import.meta.url);
const FILESET = {
  wasmLoaderPath: new URL('vendor/mediapipe/wasm/vision_wasm_internal.js', BASE).href,
  wasmBinaryPath: new URL('vendor/mediapipe/wasm/vision_wasm_internal.wasm', BASE).href,
};
const MODEL = new URL('models/blaze_face_short_range.tflite', BASE).href;
const CROP_SIZE = 256; // 切り出した頭のあたりをこの大きさ（正方形）にして渡す

// 鼻先が両目の中点から、両目を結ぶ向きにどれだけずれているか（両目の間隔を 1 としたとき）。
// 0 なら真正面。横を向くほど大きくなる。首をかしげている（顔が傾いている）分は数えない。
// keypoints は 0〜1 の割合なので、ピクセルに直してから測る（縦横で割る数が違うことがあるため）。
export function noseOffset(keypoints, width = 1, height = 1) {
  const [eyeR, eyeL, nose] = keypoints;
  if (!eyeR || !eyeL || !nose) return Infinity;
  const ex = (eyeL.x - eyeR.x) * width;
  const ey = (eyeL.y - eyeR.y) * height;
  const eyeDist = Math.hypot(ex, ey);
  if (eyeDist <= 0) return Infinity;
  const nx = (nose.x - (eyeR.x + eyeL.x) / 2) * width;
  const ny = (nose.y - (eyeR.y + eyeL.y) / 2) * height;
  return Math.abs((nx * ex + ny * ey) / eyeDist) / eyeDist;
}

// 人の枠から、頭が入りそうな正方形を決める（映像のピクセル座標）
export function headRegion(box, frameW, frameH) {
  const side = Math.min(Math.max(box.width, box.height * 0.45), frameW, frameH);
  const cx = box.originX + box.width / 2;
  const x = Math.min(Math.max(0, cx - side / 2), frameW - side);
  const y = Math.min(Math.max(0, box.originY - side * 0.05), frameH - side);
  return { x, y, side };
}

export class FaceWatcher {
  constructor() {
    this.fd = null;
    this.lastTs = 0;
    this.lastMs = 0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CROP_SIZE;
    this.canvas.height = CROP_SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
  }

  get ready() {
    return !!this.fd;
  }

  async init({ delegate = 'CPU', minScore = 0.6 } = {}) {
    const { FaceDetector } = await import('../vendor/mediapipe/vision_bundle.mjs');
    this.close();
    const create = (d) => FaceDetector.createFromOptions(FILESET, {
      baseOptions: { modelAssetPath: MODEL, delegate: d },
      runningMode: 'VIDEO',
      minDetectionConfidence: minScore,
    });
    try {
      this.fd = await create(delegate);
    } catch (e) {
      if (delegate !== 'GPU') throw e;
      this.fd = await create('CPU');
    }
  }

  // 人の枠ごとに頭のあたりを切り出して顔を探す。
  // 戻り値：[{ box, keypoints（映像のピクセル座標）, offset, facing, person（元の人の枠） }]
  detect(video, personBoxes, tolerance) {
    if (!this.fd) return [];
    const fw = video.videoWidth;
    const fh = video.videoHeight;
    const t0 = performance.now();
    const faces = [];
    // 大きい（近い）人から 2 人まで
    const boxes = [...personBoxes].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 2);
    for (const pb of boxes) {
      const r = headRegion(pb, fw, fh);
      if (r.side < 16) continue;
      this.ctx.drawImage(video, r.x, r.y, r.side, r.side, 0, 0, CROP_SIZE, CROP_SIZE);
      let ts = performance.now();
      if (ts <= this.lastTs) ts = this.lastTs + 1;
      this.lastTs = ts;
      const result = this.fd.detectForVideo(this.canvas, ts);
      const scale = r.side / CROP_SIZE;
      for (const d of result.detections) {
        const kp = (d.keypoints || []).map((k) => ({ x: r.x + k.x * r.side, y: r.y + k.y * r.side }));
        const offset = noseOffset(d.keypoints || []);
        const b = d.boundingBox;
        faces.push({
          box: { originX: r.x + b.originX * scale, originY: r.y + b.originY * scale, width: b.width * scale, height: b.height * scale },
          keypoints: kp,
          offset,
          facing: offset <= tolerance,
          region: r,
          person: pb,
        });
      }
    }
    this.lastMs = performance.now() - t0;
    return faces;
  }

  close() {
    if (this.fd) {
      try { this.fd.close(); } catch { /* noop */ }
    }
    this.fd = null;
  }
}
