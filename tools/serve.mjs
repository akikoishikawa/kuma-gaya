#!/usr/bin/env node
// 開発用の静的サーバー（依存パッケージなし、Node 18+）
//
//   node tools/serve.mjs                 → http://localhost:8000（PCのブラウザで確認用。localhost はカメラ可）
//   node tools/serve.mjs --https         → https://<このPCのIP>:8443（iPhone 実機確認用。certs/ の証明書を使う）
//
// オプション：--port 番号 / --cert certs/cert.pem / --key certs/key.pem

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const useHttps = args.includes('--https');
const port = Number(opt('port', useHttps ? 8443 : 8000));
const certFile = path.resolve(root, opt('cert', 'certs/cert.pem'));
const keyFile = path.resolve(root, opt('key', 'certs/key.pem'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown; charset=utf-8',
};

function handler(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(root, pathname);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  if (pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.well-known') || pathname.startsWith('/certs/')) {
    res.writeHead(404).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err2, data) => {
      const status = err2 ? 404 : 200;
      console.log(`${status} ${req.method} ${pathname}`);
      if (err2) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  });
}

if (useHttps) {
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.error(`証明書がありません：${certFile} / ${keyFile}\nREADME の「iPhone 実機で確認する（mkcert）」を参照してください。`);
    process.exit(1);
  }
  https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler)
    .listen(port, '0.0.0.0', () => {
      const ips = Object.values(os.networkInterfaces()).flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
      console.log('HTTPS で配信中：');
      for (const ip of ['localhost', ...ips]) console.log(`  https://${ip}:${port}/`);
    });
} else {
  http.createServer(handler).listen(port, '127.0.0.1', () => {
    console.log(`http://localhost:${port}/ で配信中（この PC からのみ）`);
  });
}
