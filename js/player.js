// 音声再生。Web Audio API で鳴らす（スタートのタップでアンロック）。
// 音声ファイルが無いフレーズは、設定が ON なら Web Speech API で読み上げて代用する。

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Player {
  constructor(settings) {
    this.settings = settings;
    this.phrases = [];
    this.raw = new Map();       // id -> ArrayBuffer（取得済みの音声ファイル）
    this.buffers = new Map();   // id -> AudioBuffer（デコード済み）
    this.decodeErrors = new Map();
    this.bags = new Map();      // category -> 残りの id（シャッフル済み）
    this.lastId = new Map();    // category -> 直前に流した id
    this.playing = false;
    this.current = null;
    this.lastPlayedId = null;
    this.ctx = null;
    this.gain = null;
  }

  async loadPhrases() {
    const res = await fetch('phrases.json');
    if (!res.ok) throw new Error(`phrases.json を読めません (${res.status})`);
    this.phrases = await res.json();
    await this.prefetch();
  }

  // 音声ファイルを先に取得しておく（デコードはアンロック後）
  async prefetch() {
    await Promise.all(this.phrases.map(async (p) => {
      if (this.raw.has(p.id)) return;
      try {
        const res = await fetch(`audio/${p.file}`);
        if (res.ok) this.raw.set(p.id, await res.arrayBuffer());
      } catch {
        // 未配置 or オフラインで未キャッシュ
      }
    }));
  }

  // スタートボタンのタップ内で同期的に呼ぶこと（iOS の自動再生制限対策）
  unlock() {
    try {
      // 消音スイッチが入っていても鳴らす（Safari 16.4+）
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* 非対応 */ }

    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    this.ctx.resume();
    const silent = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = silent;
    src.connect(this.ctx.destination);
    src.start(0);

    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }

  async decodeAll() {
    if (!this.ctx) return;
    for (const p of this.phrases) {
      if (this.buffers.has(p.id) || !this.raw.has(p.id)) continue;
      try {
        const buf = await this.ctx.decodeAudioData(this.raw.get(p.id).slice(0));
        this.buffers.set(p.id, buf);
        this.decodeErrors.delete(p.id);
      } catch (e) {
        this.decodeErrors.set(p.id, e?.message || String(e));
      }
    }
  }

  // アプリ起動中に音声ファイルを差し替えたとき用
  async reloadAudio() {
    this.raw.clear();
    this.buffers.clear();
    await this.prefetch();
    await this.decodeAll();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  get contextState() {
    return this.ctx ? this.ctx.state : '未初期化';
  }

  hasCategory(category) {
    return this.phrases.some((p) => p.category === category && this.sourceOf(p) !== 'none');
  }

  // 'file' | 'speech' | 'none'
  sourceOf(p) {
    if (this.buffers.has(p.id)) return 'file';
    if (this.settings.values.speechFallback && 'speechSynthesis' in window) return 'speech';
    return 'none';
  }

  // カテゴリ内でシャッフル再生。全部流し終えたら再シャッフル。直前と同じものは避ける。
  next(category) {
    const playable = this.phrases.filter((p) => p.category === category && this.sourceOf(p) !== 'none');
    if (playable.length === 0) return null;
    const ids = new Set(playable.map((p) => p.id));
    let bag = (this.bags.get(category) || []).filter((id) => ids.has(id));
    if (bag.length === 0) {
      bag = shuffle([...ids]);
      // bag は末尾から取り出す。直前と同じなら先頭と入れ替える
      const last = this.lastId.get(category);
      if (bag.length > 1 && bag[bag.length - 1] === last) {
        [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
    }
    const id = bag.pop();
    this.bags.set(category, bag);
    this.lastId.set(category, id);
    return playable.find((p) => p.id === id);
  }

  // 再生できたら true。再生中・再生できるものが無いときは false（再生中は次を始めない）
  async play(category) {
    if (this.playing) return false;
    const p = this.next(category);
    if (!p) return false;
    const source = this.sourceOf(p);
    this.playing = true;
    this.current = { ...p, source };
    try {
      if (source === 'file') await this.playBuffer(this.buffers.get(p.id));
      else await this.speak(p.text);
      this.lastPlayedId = p.id;
      return true;
    } finally {
      this.playing = false;
      this.current = null;
    }
  }

  async playBuffer(buffer) {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* 下のタイムアウトで抜ける */ }
    }
    this.gain.gain.value = this.settings.values.volume / 100;
    await new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      // iOS で音声が中断されると onended が来ないことがあるので保険
      const timer = setTimeout(done, buffer.duration * 1000 + 3000);
      src.onended = done;
      src.start();
    });
  }

  speak(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('ja'));
      if (voice) u.voice = voice;
      u.rate = 1.0;
      u.pitch = 1.4;
      u.volume = this.settings.values.volume / 100;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 4000 + text.length * 300);
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }
}
