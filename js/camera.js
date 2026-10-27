// camera.js — 摄像头实时预览与笔迹自动识别
// 原理：开启后自动锁定纸面背景（画面稳定时拍照记忆灰度），
//       之后每帧与背景对比：新出现且持续变暗的区域 = 书写墨迹的生长前沿，
//       其质心即笔尖。黑笔/铅笔/红笔等在白纸上书写均可识别，无需手动取色。
// 防干扰：新增面积过小(噪点)/过大(手影、纸张移动)/暗化不足(阴影)一律忽略。

const PW = 320, PH = 240;       // 处理分辨率
const LIFT_FRAMES = 8;           // 连续无新增墨迹帧数视为抬笔（约 260ms @30fps）
const MIN_STROKE_PTS = 4;       // 少于该点数视为噪声
const JUMP_DIST = PW * 0.35;     // 帧间质心瞬移阈值：超过视为重新落笔（不画飞线）
const MIN_PIX = 4;               // 新增墨迹面积下限（像素）
const MAX_PIX = 2000;            // 新增墨迹面积上限（超过视为阴影/纸张移动）
const INK_DIFF = 0.16;           // 比背景暗多少算墨迹
const INK_MAX_GRAY = 0.62;       // 墨迹亮度上限（更亮的区域视为阴影/纸面）
const TIP_STRONG = 0.22;         // 新增区域平均暗化强度下限（滤弱阴影边缘）
const LEARN_STABLE_FRAMES = 5;   // 画面连续稳定帧数 → 锁定背景
const LEARN_TIMEOUT_MS = 6000;   // 最长学习时间（超时强制锁定）

export class CameraCapture {
  constructor(video, overlay, opts) {
    this.video = video;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.octx.lineCap = 'round'; this.octx.lineJoin = 'round';
    this.h = opts; // { onTip(x,y), onStrokeEnd(points), onStatus(text) }
    this.running = false;
    this.stream = null;
    this.trail = [];           // 当前笔画点（视频像素坐标）
    this.lostFrames = 0;
    this.smooth = null;        // 平滑后的笔尖
    this.jump = false;         // 本帧质心是否瞬移（重新落笔）
    this.phase = 'idle';       // idle → learning(锁定背景) → ready(识别书写)
    this.bg = null;            // 背景灰度 Float32Array
    this.prevInk = null;       // 上一帧墨迹掩膜 Uint8Array
    this._stableCount = 0;
    this._learnStart = 0;
    this._prevLearnGray = null;
    this.frameMs = 0;
    this.fps = 0;
    this._fpsT = performance.now(); this._fpsC = 0;
    this._proc = document.createElement('canvas');
    this._proc.width = PW; this._proc.height = PH;
    this._pctx = this._proc.getContext('2d', { willReadFrequently: true });
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // 覆盖层尺寸对齐视频像素
    this.overlay.width = this.video.videoWidth || 1280;
    this.overlay.height = this.video.videoHeight || 720;
    this.guide = this._guideRect(); // 取景框（映射到 1024×1024 书写坐标系）
    this.running = true;
    this._beginLearn();          // 自动锁定纸面背景
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.trail = []; this.smooth = null; this.jump = false;
    this.phase = 'idle'; this.bg = null; this.prevInk = null;
    this._prevLearnGray = null; this._stableCount = 0;
  }

  // 换纸/挪动纸后手动重新校准背景
  recalibrate() {
    if (!this.running) return;
    this.trail = []; this.smooth = null; this.jump = false;
    this._beginLearn();
  }

  _beginLearn() {
    this.phase = 'learning';
    this.bg = null; this.prevInk = null; this._prevLearnGray = null;
    this._stableCount = 0;
    this._learnStart = performance.now();
    this.h.onStatus('正在锁定纸面背景 · 请移开手，保持纸面稳定…');
  }

  // 取景框：视频中央正方形（与 CSS .cam-guide 对应），映射到 1024×1024
  _guideRect() {
    const vw = this.overlay.width, vh = this.overlay.height;
    const side = Math.min(vw, vh) * 0.85;
    return { x: (vw - side) / 2, y: (vh - side) / 2, side, vw, vh };
  }

  to1024(px, py) {
    const g = this.guide || this._guideRect();
    const s = g.side || 1;
    return [
      Math.max(0, Math.min(1024, (px - g.x) / s * 1024)),
      Math.max(0, Math.min(1024, (py - g.y) / s * 1024))
    ];
  }

  resetTrail() {
    this.trail = []; this.smooth = null;
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  _loop() {
    if (!this.running) return;
    const t0 = performance.now();
    try { this._processFrame(); } catch (e) { /* 忽略单帧异常，保持采集连续 */ }
    this.frameMs = performance.now() - t0;
    this._fpsC++;
    const now = performance.now();
    if (now - this._fpsT >= 1000) { this.fps = this._fpsC; this._fpsC = 0; this._fpsT = now; }
    requestAnimationFrame(() => this._loop());
  }

  _processFrame() {
    const { data } = this._grab();
    const tip = this._findTip(data);
    if (tip) {
      if (this.jump) {
        // 质心瞬移：先提交已写笔画，再重新落笔，避免两位置间画出飞线
        if (this.trail.length >= MIN_STROKE_PTS) this.h.onStrokeEnd(this._commitTrail());
        this.trail = [];
        this.jump = false;
      }
      const p = this.to1024(tip.x * (this.overlay.width / PW), tip.y * (this.overlay.height / PH));
      this.trail.push([tip.x, tip.y]);
      this.lostFrames = 0;
      this.h.onTip(p[0], p[1]);
    } else {
      this.lostFrames++;
      if (this.lostFrames === LIFT_FRAMES && this.trail.length >= MIN_STROKE_PTS) {
        // 抬笔：结束当前笔画
        this.h.onStrokeEnd(this._commitTrail());
      } else if (this.lostFrames > LIFT_FRAMES) {
        this.trail = [];
      }
    }
    this._drawOverlay(tip);
  }

  // 将当前轨迹转换为 1024×1024 书写坐标并清空轨迹
  _commitTrail() {
    const pts = this.trail.map(([x, y]) => {
      const q = this.to1024(x * (this.overlay.width / PW), y * (this.overlay.height / PH));
      return [q[0], q[1], performance.now()];
    });
    this.trail = [];
    return pts;
  }

  _grab() {
    this._pctx.drawImage(this.video, 0, 0, PW, PH);
    return this._pctx.getImageData(0, 0, PW, PH);
  }

  // 笔迹识别状态机：
  //   learning — 检测画面稳定性，稳定后拍下背景灰度
  //   ready    — 每帧找出「新增墨迹」(本帧墨迹且上帧不是墨迹)，质心即笔尖
  _findTip(data) {
    const gray = new Float32Array(PW * PH);
    for (let i = 0, px = 0; px < PW * PH; px++, i += 4) {
      gray[px] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    }

    if (this.phase === 'learning') {
      let changed = 0;
      if (this._prevLearnGray) {
        for (let px = 0; px < gray.length; px++) {
          if (Math.abs(gray[px] - this._prevLearnGray[px]) > 0.12) changed++;
        }
      }
      this._prevLearnGray = gray;
      this._stableCount = (this._prevLearnGray && changed < PW * PH * 0.008) ? this._stableCount + 1 : 0;
      if (this._stableCount >= LEARN_STABLE_FRAMES || performance.now() - this._learnStart > LEARN_TIMEOUT_MS) {
        this.bg = gray; this.prevInk = null; this.phase = 'ready';
        this.h.onStatus('背景已锁定 · 请直接书写，墨迹自动识别');
      }
      return null;
    }

    if (this.phase !== 'ready' || !this.bg) { this.smooth = null; return null; }

    // pass 1：墨迹掩膜（比背景显著变暗且足够暗）
    const ink = new Uint8Array(PW * PH);
    let inkTotal = 0;
    for (let px = 0; px < gray.length; px++) {
      if (this.bg[px] - gray[px] > INK_DIFF && gray[px] < INK_MAX_GRAY) { ink[px] = 1; inkTotal++; }
    }
    if (inkTotal > PW * PH * 0.30) {
      // 画面大面积变化：纸张移动/遮挡 → 提示重校准，本帧不识别
      this.h.onStatus('画面变化过大 · 请点「重新校准」');
      this.smooth = null; this.prevInk = ink;
      return null;
    }
    // pass 2：新增墨迹（正在生长的笔画前沿）= 本帧墨迹 − 上帧墨迹
    let cx = 0, cy = 0, cnt = 0, sumd = 0;
    if (this.prevInk) {
      for (let py = 0; py < PH; py++) {
        const row = py * PW;
        for (let px = 0; px < PW; px++) {
          const idx = row + px;
          if (ink[idx] && !this.prevInk[idx]) {
            cx += px; cy += py; cnt++;
            sumd += this.bg[idx] - gray[idx];
          }
        }
      }
    }
    this.prevInk = ink;
    if (cnt < MIN_PIX || cnt > MAX_PIX || sumd / cnt < TIP_STRONG) {
      this.smooth = null;
      return null;
    }
    const x = cx / cnt, y = cy / cnt;
    if (this.smooth && Math.hypot(x - this.smooth[0], y - this.smooth[1]) > JUMP_DIST) {
      // 帧间瞬移：重置平滑状态并标记跳变，由 _processFrame 重开笔画
      this.jump = true;
      this.smooth = [x, y];
    } else {
      // 指数平滑，抑制单帧抖动
      this.smooth = this.smooth
        ? [this.smooth[0] + 0.45 * (x - this.smooth[0]), this.smooth[1] + 0.45 * (y - this.smooth[1])]
        : [x, y];
    }
    return { x: this.smooth[0], y: this.smooth[1] };
  }

  _drawOverlay(tip) {
    const c = this.octx, W = this.overlay.width, H = this.overlay.height;
    c.clearRect(0, 0, W, H);
    // 已成轨迹
    if (this.trail.length > 1) {
      c.strokeStyle = 'rgba(255,80,80,.9)';
      c.lineWidth = Math.max(2, W / 240);
      c.beginPath();
      c.moveTo(this.trail[0][0] * (W / PW), this.trail[0][1] * (H / PH));
      for (let i = 1; i < this.trail.length; i++) c.lineTo(this.trail[i][0] * (W / PW), this.trail[i][1] * (H / PH));
      c.stroke();
    }
    if (tip) {
      const r = Math.max(6, W / 100);
      c.strokeStyle = '#00e676';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(tip.x * (W / PW), tip.y * (H / PH), r, 0, Math.PI * 2);
      c.stroke();
    }
  }
}
