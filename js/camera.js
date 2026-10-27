// camera.js — 摄像头实时预览与笔尖轨迹追踪
// 流程：getUserMedia 预览 → rAF 连续帧采集（降采样至 320×240 处理）→
//       笔尖检测（HSV 颜色追踪 / 运动差分兜底）→ 轨迹平滑 → 抬笔切分 → 回调笔画

const PW = 320, PH = 240;      // 处理分辨率
const LIFT_FRAMES = 5;         // 连续丢帧数视为抬笔（约 160ms @30fps）
const MIN_STROKE_PTS = 4;      // 少于该点数视为噪声
const MIN_PIX = 3;             // 匹配像素数下限

export class CameraCapture {
  constructor(video, overlay, opts) {
    this.video = video;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.octx.lineCap = 'round'; this.octx.lineJoin = 'round';
    this.h = opts; // { onTip(x1024,y1024), onStrokeEnd(points1024), onStatus(text) }
    this.running = false;
    this.stream = null;
    this.targetColor = null;   // {r,g,b,h,s,v}
    this.trail = [];           // 当前笔画点（视频像素坐标）
    this.lostFrames = 0;
    this.smooth = null;        // 平滑后的笔尖
    this.frameMs = 0;
    this.fps = 0;
    this._fpsT = performance.now(); this._fpsC = 0;
    this._prevGray = null;
    this._motionWarned = false;
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
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.trail = []; this.smooth = null; this._prevGray = null;
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

  // 用户点按画面采样笔色
  sampleColor(clientX, clientY) {
    const r = this.video.getBoundingClientRect();
    const sx = (clientX - r.left) / r.width * PW;
    const sy = (clientY - r.top) / r.height * PH;
    const img = this._pctx.getImageData(0, 0, PW, PH).data;
    const idx = (Math.round(sy) * PW + Math.round(sx)) * 4;
    const rgb = [img[idx], img[idx + 1], img[idx + 2]];
    const hsv = rgb2hsv(...rgb);
    this.targetColor = { r: rgb[0], g: rgb[1], b: rgb[2], h: hsv[0], s: hsv[1], v: hsv[2] };
    this._motionWarned = false;
    return this.targetColor;
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
      const p = this.to1024(tip.x * (this.overlay.width / PW), tip.y * (this.overlay.height / PH));
      this.trail.push([tip.x, tip.y]);
      this.lostFrames = 0;
      this.h.onTip(p[0], p[1]);
    } else {
      this.lostFrames++;
      if (this.lostFrames === LIFT_FRAMES && this.trail.length >= MIN_STROKE_PTS) {
        // 抬笔：结束当前笔画
        const pts = this.trail.map(([x, y]) => {
          const q = this.to1024(x * (this.overlay.width / PW), y * (this.overlay.height / PH));
          return [q[0], q[1], performance.now()];
        });
        this.h.onStrokeEnd(pts);
        this.trail = [];
      } else if (this.lostFrames > LIFT_FRAMES) {
        this.trail = [];
      }
    }
    this._drawOverlay(tip);
  }

  _grab() {
    this._pctx.drawImage(this.video, 0, 0, PW, PH);
    return this._pctx.getImageData(0, 0, PW, PH);
  }

  // 笔尖检测：优先颜色追踪；未取色时使用帧间运动差分（会提示建议取色）
  _findTip(data) {
    let cx = 0, cy = 0, cnt = 0;
    const tgt = this.targetColor;
    let prev = this._prevGray;
    const useMotion = !tgt;
    if (useMotion && !this._motionWarned) {
      this._motionWarned = true;
      this.h.onStatus('未取笔色，当前使用运动追踪（建议点击「取笔色」后点按笔尖）');
    }
    const gray = new Float32Array(PW * PH);
    for (let i = 0, px = 0; px < PW * PH; px++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      gray[px] = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      if (tgt) {
        if (matchColor(r, g, b, tgt)) { cx += px % PW; cy += (px / PW) | 0; cnt++; }
      } else if (prev) {
        if (Math.abs(gray[px] - prev[px]) > 0.09) { cx += px % PW; cy += (px / PW) | 0; cnt++; }
      }
    }
    this._prevGray = gray;
    if (cnt < MIN_PIX) {
      this.smooth = null;
      return null;
    }
    let x = cx / cnt, y = cy / cnt;
    // 指数平滑，抑制单帧抖动
    this.smooth = this.smooth ? [this.smooth[0] + 0.45 * (x - this.smooth[0]), this.smooth[1] + 0.45 * (y - this.smooth[1])] : [x, y];
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

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 3) / 6;
    else h = ((r - g) / d + 5) / 6;
  }
  return [h, mx ? d / mx : 0, mx];
}

function matchColor(r, g, b, t) {
  const [h, s, v] = rgb2hsv(r, g, b);
  if (t.s >= 0.28) {
    // 彩色笔：以色相为主
    let dh = Math.abs(h - t.h);
    if (dh > 0.5) dh = 1 - dh;
    return dh < 0.085 && s > 0.28 && Math.abs(v - t.v) < 0.45;
  }
  // 深色笔（黑/蓝黑）：亮度显著低于纸面
  return v < 0.35 && s < 0.75 && Math.abs(v - t.v) < 0.22;
}
