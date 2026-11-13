#!/usr/bin/env node
// phrases.json の text から、Gemini の声で audio/*.wav を一括生成する。依存パッケージなし（Node 18+）。
//
// 既定は Google Cloud Text-to-Speech の Gemini TTS（gemini-2.5-flash-tts）。
// kinetone の @kinetone/voice と同じ方式で、認証は gcloud ADC、課金先は GOOGLE_TTS_PROJECT で明示する。
//
//   GOOGLE_TTS_PROJECT=kinetone node tools/gen-tts.mjs                 # 未作成のものだけ生成
//   GOOGLE_TTS_PROJECT=kinetone node tools/gen-tts.mjs --only call_01  # 指定したものだけ（既存も上書き）
//   GOOGLE_TTS_PROJECT=kinetone node tools/gen-tts.mjs --force         # 全部作り直す（声は毎回少し変わるので注意）
//   node tools/gen-tts.mjs --voice Achird --only call_01               # 声を変えて試す
//   node tools/gen-tts.mjs --dry-run                                  # 送信内容を表示するだけ
//   node tools/gen-tts.mjs --only call_01 --voice Achird --out-dir tts-trials/Achird   # 試作（audio/ は触らない）
//
// Gemini API（API キー）で作る場合：GEMINI_API_KEY=... node tools/gen-tts.mjs --provider gemini-api
//
// 声・話し方・速さの既定値は tools/tts.config.json（全フレーズ共通）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const config = JSON.parse(await fs.readFile(path.join(root, 'tools/tts.config.json'), 'utf8'));
const provider = opt('provider') || config.provider || 'cloud-tts';
const voice = opt('voice') || config.voice;
const style = opt('style') ?? config.style;
const rate = Number(opt('rate') ?? config.rate ?? 1);
const delayMs = Number(config.delayMs ?? 1500);
const only = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const force = flag('force') || !!only;
const outDir = path.resolve(root, opt('out-dir') || 'audio');
const dryRun = flag('dry-run');
const TAKES = 4; // 出来上がりの確認で弾かれたときの録り直し上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Google Cloud TTS（Gemini TTS） ---------------- */

const CLOUD_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const cloudModel = opt('model') || config.model;
const project = process.env.GOOGLE_TTS_PROJECT;

// 内容は変えさせず、話し方だけを指定する。これを抜くと挨拶や相づちを勝手に足すことがある
const buildPrompt = (s) =>
  'Read the given text in Japanese exactly as written, verbatim. '
  + 'Do NOT add, remove, reorder, paraphrase, or insert any words or sounds. '
  + 'Do NOT add greetings, interjections, fillers, or self-introductions. '
  + 'Do NOT change the content. Only control speaking style. '
  + `Speaking style: ${s}`;

function cloudRequest(text) {
  return {
    input: style ? { prompt: buildPrompt(style), text } : { text },
    voice: { languageCode: 'ja-JP', name: voice, model_name: cloudModel },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: rate },
  };
}

let token = null;
async function accessToken() {
  if (token) return token;
  try {
    const { stdout } = await execFileP('gcloud', ['auth', 'application-default', 'print-access-token']);
    token = stdout.trim();
    return token;
  } catch {
    throw new Error('gcloud の認証を取得できませんでした。次を実行してください：\n  gcloud auth application-default login');
  }
}

async function cloudSynthesize(text) {
  const res = await fetch(CLOUD_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      // ADC の既定プロジェクトではなく、ここで指定した先に課金する
      'x-goog-user-project': project,
      'content-type': 'application/json',
    },
    body: JSON.stringify(cloudRequest(text)),
  });
  if (!res.ok) throw Object.assign(new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 500)}`), { status: res.status });
  const json = await res.json();
  if (!json.audioContent) throw new Error('audioContent が空です');
  return Buffer.from(json.audioContent, 'base64');
}

/* ---------------- Gemini API（API キー） ---------------- */

const apiModel = opt('model') || config.geminiApi?.model;
const apiEndpoint = config.geminiApi?.endpoint;
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

function apiRequest(text) {
  const content = { type: 'text', text };
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  return {
    model: apiModel,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  };
}

function findAudio(node) {
  let found = null;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.data === 'string' && (n.type === 'audio' || /^audio\//.test(n.mime_type || n.mimeType || ''))) found = n;
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  walk(node);
  return found;
}

async function apiSynthesize(text) {
  const res = await fetch(apiEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(apiRequest(text)),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`), { status: res.status });
  const audio = findAudio(await res.json());
  if (!audio) throw new Error('レスポンスに音声がありません');
  const bytes = Buffer.from(audio.data, 'base64');
  const sr = Number(/rate=(\d+)/.exec(audio.mime_type || audio.mimeType || '')?.[1]) || 24000;
  return isWav(bytes) ? bytes : pcmToWav(bytes, sr);
}

/* ---------------- WAV ---------------- */

const isWav = (b) => b.subarray(0, 4).toString('ascii') === 'RIFF';

function pcmToWav(pcm, sampleRate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// 16bit モノラル WAV の data チャンクを読む
function readWav(buf) {
  let off = 12;
  let sr = 24000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') sr = buf.readUInt32LE(off + 12);
    if (id === 'data') {
      const end = Math.min(buf.length, off + 8 + size);
      const n = (end - off - 8) >> 1;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { sr, x };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV の data チャンクがありません');
}

/* ---------------- 出来上がりの確認（kinetone-aiube の検査を簡略化して移植） ----------------
   話し方は指示するだけなので録り上がりがぶれる。機械で確かめて、だめなら録り直す。
   ・末尾が大きいまま終わっている → 途中で切れている
   ・途中に長い無音がある         → 頼んでいない一言が足されている疑い
   ・文字数のわりに長すぎる */
function inspect(wav, text) {
  const { sr, x } = readWav(wav);
  const sec = x.length / sr;
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (!peak) return { sec, why: '無音' };
  const tailN = Math.round(sr * 0.2);
  let tailPeak = 0;
  for (let i = Math.max(0, x.length - tailN); i < x.length; i++) tailPeak = Math.max(tailPeak, Math.abs(x[i]));
  if (tailPeak / peak > 0.3) return { sec, why: `末尾が大きいまま終わっている（${Math.round((tailPeak / peak) * 100)}%）` };

  const frame = Math.round(sr * 0.02);
  const loud = [];
  for (let i = 0; i + frame <= x.length; i += frame) {
    let sq = 0;
    for (let j = i; j < i + frame; j++) sq += x[j] * x[j];
    loud.push(Math.sqrt(sq / frame) > peak * 0.03);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  let gap = 0;
  let run = 0;
  for (let i = first; i <= last; i++) {
    run = loud[i] ? 0 : run + 1;
    gap = Math.max(gap, run);
  }
  const gapSec = (gap * frame) / sr;
  if (gapSec >= 0.8) return { sec, why: `途中で ${gapSec.toFixed(1)} 秒途切れている` };
  if (sec > 2 + text.length * 0.3) return { sec, why: `文字数のわりに ${sec.toFixed(1)} 秒と長い` };
  return { sec, why: null };
}

/* ---------------- 実行 ---------------- */

const synthesize = provider === 'gemini-api' ? apiSynthesize : cloudSynthesize;

async function withRetry(text) {
  for (let i = 0; ; i++) {
    try {
      return await synthesize(text);
    } catch (e) {
      if (![429, 500, 503].includes(e.status) || i >= 5) throw e;
      const wait = 5 * 2 ** i;
      console.log(`  上限に達したので ${wait} 秒待って再試行します…`);
      await sleep(wait * 1000);
    }
  }
}

const phrases = JSON.parse(await fs.readFile(path.join(root, 'phrases.json'), 'utf8'));
if (only) {
  const unknown = only.filter((id) => !phrases.some((p) => p.id === id));
  if (unknown.length) {
    console.error(`phrases.json に無い id：${unknown.join(', ')}`);
    process.exit(1);
  }
}
const targets = phrases.filter((p) => !only || only.includes(p.id));

console.log(provider === 'gemini-api'
  ? `Gemini API／モデル ${apiModel}／声 ${voice}`
  : `Cloud TTS／モデル ${cloudModel}／声 ${voice}／速さ ${rate}／課金先 ${project || '(未指定)'}`);
console.log(`話し方：${style}\n`);

if (!dryRun) {
  if (provider === 'gemini-api' && !apiKey) {
    console.error('環境変数 GEMINI_API_KEY を設定してください。');
    process.exit(1);
  }
  if (provider !== 'gemini-api' && !project) {
    console.error('課金先のプロジェクトを指定してください：\n  GOOGLE_TTS_PROJECT=<GCP プロジェクトID> node tools/gen-tts.mjs');
    process.exit(1);
  }
}

await fs.mkdir(outDir, { recursive: true });
let made = 0;
let failed = 0;
for (const p of targets) {
  const out = path.join(outDir, p.file);
  if (!/\.wav$/i.test(p.file)) console.warn(`- ${p.id}: ファイル名が .wav ではありません（${p.file}）。中身は WAV で書き出します`);
  if (!force && await fs.stat(out).then(() => true, () => false)) {
    console.log(`- ${p.id}: 既にあるのでスキップ（--only か --force で作り直し）`);
    continue;
  }
  if (dryRun) {
    console.log(`- ${p.id}:`, JSON.stringify(provider === 'gemini-api' ? apiRequest(p.tts || p.text) : cloudRequest(p.tts || p.text)));
    continue;
  }
  try {
    const takes = [];
    let chosen = null;
    for (let i = 1; i <= TAKES; i++) {
      let wav = await withRetry(p.tts || p.text);
      if (!isWav(wav)) wav = pcmToWav(wav);
      const check = inspect(wav, p.tts || p.text);
      takes.push({ wav, ...check });
      if (!check.why) {
        chosen = takes.at(-1);
        break;
      }
      console.log(`  ${p.id} ${i}回目は録り直し：${check.why}`);
      await sleep(delayMs);
    }
    const take = chosen ?? takes.sort((a, b) => a.sec - b.sec)[0];
    await fs.writeFile(out, take.wav);
    made++;
    console.log(`${chosen ? '✓' : '!'} ${p.id}  ${take.sec.toFixed(2)}秒  ${p.tts || p.text}`);
    if (!chosen) console.log(`  （${TAKES} 回試して確認を通りませんでした。聞いて確かめてください）`);
  } catch (e) {
    failed++;
    console.log(`✗ ${p.id}  ${e.message}`);
  }
  await sleep(delayMs);
}

if (!dryRun) {
  console.log(`\n生成 ${made} 件、失敗 ${failed} 件。`);
  if (made > 0) console.log('配信し直すときは sw.js の VERSION を上げてください（端末のキャッシュを入れ替えるため）。');
}
process.exit(failed ? 1 : 0);
