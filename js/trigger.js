// 呼びかけの状態機械
//
//   待機 ──(接近 or 滞在)──▶ 再生中[呼びかけ] ──▶ 2段目待ち ──(残っている)──▶ 再生中[2段目] ──▶ クールダウン ──▶ 待機
//                                                    └──(いなくなった)──────────────────────────▶ クールダウン
//
// クールダウンは「話し終えた時点」から数える。

export const STATE_LABEL = {
  idle: '待機',
  playing: '再生中',
  waitFollowup: '2段目待ち',
  cooldown: 'クールダウン',
};

export class Trigger {
  constructor({ settings, player, stats }) {
    this.settings = settings;
    this.player = player;
    this.stats = stats;
    this.state = 'idle';
    this.presentSince = null;   // 連続して「いる」状態になった時刻
    this.lastSeen = -Infinity;  // 最後に人を検出した時刻
    this.followFrom = 0;
    this.cooldownUntil = 0;
    this.ratio = 0;             // 直近フレームで一番大きい人の枠の面積比
    this.count = 0;
  }

  update(now, boxes, frameW, frameH) {
    const s = this.settings.values;
    const area = frameW * frameH || 1;
    let ratio = 0;
    for (const b of boxes) ratio = Math.max(ratio, (b.width * b.height) / area);
    this.ratio = Math.min(1, ratio);
    this.count = boxes.length;

    if (boxes.length > 0) {
      this.lastSeen = now;
      if (this.presentSince === null) this.presentSince = now;
    } else if (now - this.lastSeen > s.lostGraceMs) {
      this.presentSince = null;
    }
    const present = this.presentSince !== null;

    switch (this.state) {
      case 'idle':
        if (!present) break;
        if (this.ratio >= s.approachPct / 100) this.speak('call', 'approach');
        else if (now - this.presentSince >= s.dwellSec * 1000) this.speak('call', 'dwell');
        break;
      case 'waitFollowup':
        if (!present) this.startCooldown(now);
        else if (now - this.followFrom >= s.followupSec * 1000) this.speak('followup', 'stay');
        break;
      case 'cooldown':
        if (now >= this.cooldownUntil) {
          this.state = 'idle';
          // 同じ人が居続けた場合も、滞在時間は数え直す
          this.presentSince = present ? now : null;
        }
        break;
      default:
        break; // playing：再生の完了は speak() 側で扱う
    }
  }

  async speak(category, reason) {
    this.state = 'playing';
    let ok = false;
    try {
      ok = await this.player.play(category);
    } catch (e) {
      console.error(e);
    }
    if (ok) this.stats.record(category, this.player.lastPlayedId, reason);
    const now = performance.now();
    const s = this.settings.values;
    if (ok && category === 'call' && s.followupSec > 0 && this.player.hasCategory('followup')) {
      this.state = 'waitFollowup';
      this.followFrom = now;
    } else {
      this.startCooldown(now);
    }
  }

  startCooldown(now) {
    this.state = 'cooldown';
    this.cooldownUntil = now + this.settings.values.cooldownSec * 1000;
  }

  describe(now) {
    const s = this.settings.values;
    let label = STATE_LABEL[this.state];
    if (this.state === 'cooldown') label += ` 残り ${Math.max(0, (this.cooldownUntil - now) / 1000).toFixed(1)} 秒`;
    if (this.state === 'waitFollowup') label += ` ${((now - this.followFrom) / 1000).toFixed(1)} / ${s.followupSec} 秒`;
    if (this.state === 'playing' && this.player.current) label += `：${this.player.current.id}（${this.player.current.source === 'file' ? '音声' : '読み上げ'}）`;
    const stay = this.presentSince === null ? 0 : (now - this.presentSince) / 1000;
    return { label, stay, ratio: this.ratio, count: this.count };
  }
}
