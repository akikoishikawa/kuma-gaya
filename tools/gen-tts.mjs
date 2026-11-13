#!/usr/bin/env node
// phrases.json の text から Gemini API の音声合成（TTS）で audio/*.wav を一括生成する。
// 依存パッケージなし（Node 18+ の fetch を使用）。
//
//   export GEMINI_API_KEY=...                       # キーはリポジトリに入れない
//   node tools/gen-tts.mjs                          # 未作成のものだけ生成
//   node tools/gen-tts.mjs --force                  # 全部作り直す
//   node tools/gen-tts.mjs --only call_01,follow_02 # 指定したものだけ（既存も上書き）
//   node tools/gen-tts.mjs --voice Achird --style "元気いっぱいに"
//   node tools/gen-tts.mjs --dry-run                # 送信内容を表示するだけ
//
// 声・話し方・モデルの既定値は tools/tts.config.json。全フレーズ共通で使う。
// API：Gemini Interactions API（POST /v1beta/interactions）。2026-11 時点の公式ドキュメント
// https://ai.google.dev/gemini-api/docs/speech-generation に合わせている。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const config = JSON.parse(await fs.readFile(path.join(root, 'tools/tts.config.json'), 'utf8'));
const model = opt('model') || config.model;
const voice = opt('voice') || config.voice;
const style = opt('style') ?? config.style;
const endpoint = config.endpoint;
const delayMs = Number(config.delayMs ?? 1500);
const only = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const force = flag('force') || !!only;
const dryRun = flag('dry-run');

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey && !dryRun) {
  console.error('環境変数 GEMINI_API_KEY を設定してください（https://aistudio.google.com/apikey で発行）。');
  process.exit(1);
}

const phrases = JSON.parse(await fs.readFile(path.join(root, 'phrases.json'), 'utf8'));
const targets = phrases.filter((p) => !only || only.includes(p.id));
if (only) {
  const unknown = only.filter((id) => !phrases.some((p) => p.id === id));
  if (unknown.length) console.warn(`phrases.json に無い id：${unknown.join(', ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildRequest(text) {
  const content = { type: 'text', text };
  // 話し方の指示は本文に混ぜず speech_metadata.style で渡す（本文はそのまま読まれるため）
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  return {
    model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  };
}

// レスポンスから最後の音声ブロックを探す（steps[].content[] の type:"audio"）
function findAudio(node) {
  let found = null;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (n.type === 'audio' && typeof n.data === 'string') found = n;
    else if (typeof n.data === 'string' && /^audio\//.test(n.mime_type || n.mimeType || '')) found = n;
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  walk(node);
  return found;
}

// ヘッダなしの 16bit PCM が返ってきた場合に WAV ヘッダを付ける
function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(text) {
  const body = JSON.stringify(buildRequest(text));
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });
    if (res.ok) return res.json();
    const detail = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  ${res.status} のため ${wait / 1000} 秒後に再試行します`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 800)}`);
  }
}

console.log(`モデル ${model}／声 ${voice}／話し方「${style}」`);
await fs.mkdir(path.join(root, 'audio'), { recursive: true });

let made = 0;
let failed = 0;
for (const p of targets) {
  const out = path.join(root, 'audio', p.file);
  if (!/\.wav$/i.test(p.file)) {
    console.warn(`- ${p.id}: ファイル名が .wav ではありません（${p.file}）。WAV 形式で書き出します`);
  }
  if (!force && await fs.stat(out).then(() => true, () => false)) {
    console.log(`- ${p.id}: 既にあるのでスキップ（--force で作り直し）`);
    continue;
  }
  if (dryRun) {
    console.log(`- ${p.id}:`, JSON.stringify(buildRequest(p.text)));
    continue;
  }
  process.stdout.write(`- ${p.id}: ${p.text} … `);
  try {
    const json = await synthesize(p.text);
    const audio = findAudio(json);
    if (!audio) throw new Error(`音声がレスポンスにありません：${JSON.stringify(json).slice(0, 800)}`);
    let bytes = Buffer.from(audio.data, 'base64');
    if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF') {
      const rate = Number(/rate=(\d+)/.exec(audio.mime_type || audio.mimeType || '')?.[1]) || 24000;
      bytes = pcmToWav(bytes, rate);
    }
    await fs.writeFile(out, bytes);
    made++;
    console.log(`OK（${(bytes.length / 1024).toFixed(0)} KB）`);
  } catch (e) {
    failed++;
    console.log('失敗');
    console.error(`  ${e.message}`);
  }
  await sleep(delayMs);
}

console.log(`\n生成 ${made} 件、失敗 ${failed} 件。`);
if (made > 0) console.log('配信し直すときは sw.js の VERSION を上げてください（端末のキャッシュを入れ替えるため）。');
process.exit(failed ? 1 : 0);
