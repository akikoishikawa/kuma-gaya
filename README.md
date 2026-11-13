# くまガヤ（kuma-gaya）

展示ブースの「話しかけてくる熊のぬいぐるみ」用 Web アプリ。
ぬいぐるみの中に仕込んだ iPhone（XR / iOS 18 / Safari）のカメラで人の接近を検出し、
あらかじめ用意した音声（定型フレーズ）を再生して来場者の足を止めます。

- 静的 HTML/JS のみ。ビルド不要
- 人検出：MediaPipe Object Detector（EfficientDet-Lite0 int8）。WASM とモデルはリポジトリに同梱（CDN 不使用）
- Service Worker で全アセット（音声含む）をキャッシュ。**初回読み込み後は機内モードでも動作**
- 会話機能はなし。通信もしない

---

## 構成

```
index.html             起動画面・黒画面・デバッグ表示
manifest.webmanifest   ホーム画面に追加したときの全画面起動用
sw.js                  Service Worker（全アセットを事前キャッシュ）。差し替え時は VERSION を上げる
phrases.json           フレーズ定義
audio/                 音声ファイル（Gemini で生成して置く）
css/app.css
js/app.js              起動・カメラ・検出ループ・Wake Lock・デバッグ描画
js/detector.js         MediaPipe Object Detector（person のみ）
js/trigger.js          呼びかけの状態機械
js/player.js           Web Audio 再生・シャッフル・読み上げフォールバック
js/settings.js         設定と再生回数（localStorage）
js/panel.js            隠し設定パネル
vendor/mediapipe/      @mediapipe/tasks-vision 1.2.0（Apache-2.0）の bundle と WASM（SIMD 版）
models/                efficientdet_lite0.tflite（int8）
icons/                 アプリアイコン
tools/serve.mjs        開発用サーバー（HTTP / HTTPS、依存なし）
tools/gen-tts.mjs      Gemini TTS で音声を一括生成（依存なし）
tools/tts.config.json  TTS の声・話し方・モデル
```

## 動作

```
待機 ─(接近 or 滞在)→ 呼びかけ再生 → 2段目待ち ─(残っている)→ 2段目再生 → クールダウン → 待機
                                          └─(いなくなった)──────────────→ クールダウン
```

| 項目 | 初期値 | 内容 |
|---|---|---|
| 検出間隔 | 250 ms（約4fps） | 毎フレームではなくこの間隔で検出（発熱・電池対策） |
| 接近しきい値 | 25% | 人の枠の面積が画面のこの割合を超えたら呼びかけ |
| 滞在時間 | 1.5 秒 | 人が連続してこの時間検出されたら呼びかけ |
| 2段目待ち | 6 秒 | 呼びかけ後、人がこの時間残っていたら「2段目」を再生（0 で 2段目なし） |
| クールダウン | 25 秒 | 話し終えてからこの時間は呼びかけない |
| 見失いの猶予 | 800 ms | 一瞬検出が途切れても「いる」とみなす時間（詳細設定） |

- フレーズはカテゴリ内でシャッフル再生。全部流したら再シャッフル（直前と同じものは続けない）
- 再生中は次の再生を始めない
- 再生回数はカテゴリ別・フレーズ別・きっかけ別（接近／滞在／居残り）に記録

## 画面と設定パネル

- 起動画面の **スタート** をタップ → カメラ開始＋音声のアンロック（iOS の自動再生制限対策）＋画面スリープ防止
- 動作中、デバッグ OFF なら **画面は真っ黒**（ぬいぐるみからの光漏れ防止・省電力）
- **画面左上の隅（約 90×90pt）を 3 回続けてタップ** → 隠し設定パネル
  - 検出間隔／接近しきい値／滞在時間／2段目待ち／クールダウン／音量／前面・背面カメラ／デバッグ表示
  - 読み上げフォールバック ON/OFF（音声ファイルがないとき Web Speech API で代用。**本番は OFF**）
  - 詳細：検出の信頼度、見失いの猶予、CPU/GPU
  - テスト再生、再生回数の確認・リセット、フレーズごとの音声の有無、オフライン準備状況
  - 設定は localStorage に保存（次回起動時も同じ）
- デバッグ ON：カメラ映像・検出枠（枠の面積%／信頼度）・状態（待機／再生中／2段目待ち／クールダウン残り秒）・検出時間と fps

## 音声ファイル

`phrases.json` に 1 フレーズ 1 行で定義し、`audio/` にファイルを置きます。

```json
{ "id": "call_01", "category": "call", "file": "call_01.wav", "text": "こんにちは！ちょっとだけ寄っていってよ" }
```

- `category`：`call`（呼びかけ）／`followup`（2段目）
- 形式は WAV 推奨（mp3 / m4a も可。`file` の拡張子を合わせる）
- 音声ファイルがないフレーズは、読み上げフォールバックが ON なら `text` を読み上げ、OFF なら選ばれません
- 音声を足したり差し替えたりして配信し直すときは、**`sw.js` の `VERSION` を上げる**（端末のキャッシュを入れ替えるため）

### Gemini TTS で一括生成する

```bash
export GEMINI_API_KEY=xxxxxxxx      # https://aistudio.google.com/apikey で発行。リポジトリには入れない
node tools/gen-tts.mjs              # 未作成のものだけ生成
node tools/gen-tts.mjs --force      # 全部作り直す
node tools/gen-tts.mjs --only call_02,follow_01
node tools/gen-tts.mjs --voice Achird --style "元気いっぱいに、ゆっくり"
node tools/gen-tts.mjs --dry-run    # 送信内容だけ確認
```

- 声・話し方・モデルの既定値は `tools/tts.config.json`（全フレーズ共通）
  - `voice`：既定 `Puck`（男性・Upbeat）。ほかの男性の声は `Achird`（Friendly）、`Sadachbia`（Lively）、`Fenrir`（Excitable）、`Umbriel`（Easy-going）など。全 30 種
  - 声を聴き比べるときは `node tools/gen-tts.mjs --only call_01 --voice Achird` のように 1 件だけ作り直す
  - `style`：話し方の指示。本文には混ぜず `speech_metadata.style` として渡します（本文はそのまま読まれるため）
  - `model`：既定 `gemini-3.8-flash-tts`。安く速くしたいときは `gemini-3.8-flash-lite-tts`
- API は Gemini Interactions API（`POST /v1beta/interactions`）。2026年11月時点の公式ドキュメント
  （https://ai.google.dev/gemini-api/docs/speech-generation ）に合わせています。仕様が変わってエラーになる場合は、
  エラー本文が表示されるので `buildRequest()` を直してください
- 出力は 24kHz・モノラル・16bit の WAV

## ローカル開発

Node 18 以上があれば、追加のインストールは不要です。

### PC のブラウザで確認（HTTP）

```bash
node tools/serve.mjs
```

http://localhost:8000/ を開きます。`localhost` は HTTPS でなくてもカメラが使えます。
Service Worker のキャッシュが邪魔なときは `http://localhost:8000/?nosw` で開きます（登録しない）。
登録済みのものは、開発者ツール > Application > Service Workers で解除します。

### iPhone 実機で確認（HTTPS）

iPhone からカメラを使うには HTTPS が必要です。2 通りあります。

**A. mkcert で LAN 内 HTTPS（Service Worker まで確認できる）**

```bash
brew install mkcert
mkcert -install
mkdir -p certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 $(ipconfig getifaddr en0)
node tools/serve.mjs --https
```

1. `mkcert -CAROOT` で表示されるフォルダの `rootCA.pem` を AirDrop で iPhone に送る
2. iPhone：設定 > 一般 > VPN とデバイス管理 → プロファイルをインストール
3. 設定 > 一般 > 情報 > 証明書信頼設定 → mkcert のルート証明書を ON
4. iPhone（同じ Wi-Fi）の Safari で `https://<表示された PC の IP>:8443/` を開く

`certs/` は `.gitignore` 済みです。iPhone のルート証明書は確認が終わったら削除してください。

**B. Cloudflare Tunnel（証明書の準備がいらない）**

```bash
brew install cloudflared
node tools/serve.mjs
cloudflared tunnel --url http://localhost:8000
```

表示された `https://xxxx.trycloudflare.com` を iPhone で開きます。URL は毎回変わるので、
展示本番用ではなく動作確認用です（オフライン用キャッシュは URL ごとに別になるため）。

## デプロイ（GitHub Pages）

1. GitHub にリポジトリを作って push
   ```bash
   gh repo create kuma-gaya --private --source . --push
   ```
   （GitHub Pages を private リポジトリで使うには有料プランが必要。無料なら `--public`）
2. GitHub の Settings > Pages > Build and deployment
   - Source：**Deploy from a branch**
   - Branch：`main` / `/(root)` → Save
3. 数分後に `https://<ユーザー名>.github.io/kuma-gaya/` で公開されます

ほかの静的ホスティング（Cloudflare Pages、Netlify、Firebase Hosting など）でも、リポジトリのルートをそのまま配信すれば動きます。
`.wasm` が `application/wasm` で配信されることだけ確認してください。

**更新するとき**：ファイルを変えたら `sw.js` の `VERSION`（例：`v1` → `v2`）を上げてから push。
iPhone ではアプリを開いた状態で設定パネル >「音声・アプリを更新」を押し、アプリを開き直すと反映されます。

## iPhone の準備（展示用）

### 1. ホーム画面に追加して全画面で起動する

1. Safari で公開 URL を開く
2. 共有ボタン（□↑）>「ホーム画面に追加」> 追加
3. 以後はホーム画面の「くまガヤ」アイコンから起動（アドレスバーなしの全画面）

**注意：ホーム画面のアプリは Safari とキャッシュ・設定が別管理です。**
オフライン準備は必ず「ホーム画面のアイコンから起動した状態」で行ってください。

### 2. オフライン準備（展示の前日まで、Wi-Fi のある場所で）

1. ホーム画面のアイコンから起動 → スタート → カメラを許可
2. 一度アプリを閉じて開き直す（Service Worker が有効になる）
3. 左上を 3 回タップ → 設定パネルの「オフライン準備」が
   **「機内モードでも動作できます」**・音声ファイル 9/9 になっていることを確認
4. 機内モードにして、アプリを閉じて開き直し、スタート → 呼びかけまで動くことを確認

### 3. 自動ロックを切る

アプリは Screen Wake Lock API で画面スリープを防ぎますが、念のため本体設定でも切ります。

- 設定 > 画面表示と明るさ > 自動ロック > **なし**
- 設定パネルの「画面ロック防止」が「失敗」「非対応」のときは、この設定が必須です

### 4. アクセスガイドで固定する（ほかの操作をされない・誤ってアプリが閉じない）

1. 設定 > アクセシビリティ > アクセスガイド > ON
2. 「パスコード設定」でアクセスガイド用パスコードを設定
3. 同じ画面の「画面の自動ロック」を **なし**（本体の自動ロックとは別設定なので注意）
4. くまガヤを起動してスタートしたあと、**サイドボタンを 3 回押す** → 右上の「開始」
5. 終了するときはサイドボタンを 3 回押してパスコードを入力 >「終了」

アクセスガイド中も画面左上 3 回タップの設定パネルは使えます。

### 5. そのほか

- **音量**：本体の音量ボタンで最大近くに。アプリ側の音量は設定パネルで調整
- **消音スイッチ**：iOS 16.4 以降はアプリ側で鳴るよう指定していますが、念のため消音を解除
- **明るさ**：画面は真っ黒ですが、明るさも最小に（光漏れ・発熱・電池対策）
- **低電力モード**：OFF 推奨（処理が間引かれて検出が遅れることがある）
- **電源**：展示中は給電しながら使う。ぬいぐるみの中は熱がこもるので、ケーブルの取り回しと放熱に注意
- **通知**：集中モード（おやすみモード）で通知や着信の割り込みを止める
- **カメラの向き**：既定は背面カメラ（画面をぬいぐるみの内側に向けられる）。前面にしたいときは設定パネルで切り替え

## 実機での動作確認手順

1. 設定パネルでデバッグ表示を ON
2. 確認すること
   - 人がフレームに入ると枠が出る（接近しきい値を超えると枠が赤）
   - 状態が「待機 → 再生中 → 2段目待ち → 再生中 → クールダウン → 待機」と進む
   - クールダウン中は人がいても呼びかけない
   - 2段目待ちの途中で離れるとクールダウンに移る
   - 「検出」の ms と fps（設定どおりの fps が出ていれば OK。1回の ms が検出間隔に近いときは間隔を延ばす）
3. 置き場所で調整
   - 通りすがりにも反応しすぎる → 接近しきい値を上げる／滞在時間を延ばす
   - なかなか反応しない → 接近しきい値を下げる／信頼度を下げる（詳細設定）
   - 枠がちらつく → 見失いの猶予を延ばす
4. 発熱の確認：デバッグ OFF で 30 分〜1 時間置き、本体が熱くなりすぎないか確認。
   熱いときは検出間隔を 400〜500ms（2〜2.5fps）に延ばす。CPU/GPU の切り替えで軽くなる場合もある
5. 展示後：設定パネルの「再生回数」をスクリーンショットして記録 →「回数をリセット」

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 「カメラが許可されていません」 | 設定 > Safari > カメラ を「確認」か「許可」に。ホーム画面アプリは起動ごとに許可を聞かれることがある |
| 音が鳴らない | 本体の音量・消音スイッチを確認。スタートをタップせずに起動していないか。設定パネルの「音声」が `running` か |
| しばらくすると止まる | 自動ロック（本体設定とアクセスガイドの両方）が「なし」か。アプリを裏に回すとカメラが止まる（戻ると自動で再開） |
| 機内モードで開けない | ホーム画面のアイコンから一度オンラインで起動したか（Safari とは別管理）。設定パネルのオフライン準備を確認 |
| 音声を差し替えたのに古いまま | `sw.js` の `VERSION` を上げて配信し、設定パネル >「音声・アプリを更新」→ 開き直す |

## ライセンス

- `vendor/mediapipe/`：[@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) 1.2.0（Apache License 2.0）
- `models/efficientdet_lite0.tflite`：MediaPipe 提供のモデル（Apache License 2.0）
