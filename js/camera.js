// camera.js — 摄像头实时预览与笔迹自动识别 v5
// 原理：开启后自动锁定纸面背景（取景框内画面稳定后记忆灰度），
//       之后每帧在【取景框内】与背景对比：新出现且持续变暗的区域 = 书写墨迹的生长前沿，
//       其质心即笔尖。黑笔/铅笔/红笔等在白纸上书写均可识别，无需手动取色。
// v5 关键改进（针对真机手持/抖动/阴影干扰）：
//   1) 处理分辨率随视频方向自适应（横屏/竖屏都保持等比，不压扁笔画形态）
//   2) 视频容器、覆盖层、取景框三者像素级对齐（红色轨迹与实际笔画不再错位）
//   3) 仅识别取景框内的墨迹：框外的手影/笔杆/环境晃动一律忽略
//   4) 书写中新增墨迹必须紧邻上一笔尖（笔画是连续生长的），
//      远处孤立暗斑（阴影/抖动）不再拉动轨迹
//   5) 落笔需连续多帧稳定确认才起笔，误动/瞬时阴影不再触发书写

const PROC_W = 320;             // 处理宽度基准（按视频长宽比等比缩放）
const PROC_H_MAX = 480;         // 处理高度上限（竖屏视频）
const LIFT_FRAMES = 8;           // 连续无新增墨迹帧数视为抬笔
const MIN_STROKE_PTS = 4;       // 少于该点数视为噪声
const MIN_PIX = 6;               // 新增墨迹面积下限（像素）
const MAX_PIX = 2000;            // 新增墨迹面积上限（超过视为阴影/纸张移动）
const INK_DIFF = 0.16;           // 比背景暗多少算墨迹
const INK_MAX_GRAY = 0.62;       // 墨迹亮度上限（更亮的区域视为阴影/纸面）
const TIP_STRONG = 0.28;         // 新增区域平均暗化强度下限（滤阴影边缘）
const ASPECT_MAX = 6;            // 新增区域长宽比上限：细长条=移动的影子/笔杆影像，丢弃
const CONFIRM_FRAMES = 5;        // 像素连续存在帧数 → 确认为真墨迹（墨迹持久，影子扫过不持久）
const ARM_CONFIRM = 3;           // 落笔确认次数：新增质心连续稳定才正式起笔
const ARM_RADIUS = 44;           // 落笔确认半径（处理像素）
const GROW_RADIUS = 44;          // 书写中新增墨迹距上一笔尖的最大距离：超出=远处干扰，忽略
const VANISH_WARN = 120;         // 已确认墨迹单帧消失量：超过=光照突变/遮挡，丢帧
const LEARN_STABLE_FRAMES = 5;   // 取景框内画面连续稳定帧数 → 锁定背景
const LEARN_TIMEOUT_MS = 6000;   // 最长学习时间（超时强制锁定）
const ROI_MARGIN = 0.04;         // 识别区域相对取景框的内缩比例

export class CameraCapture {
  constructor(video, overlay, opts) {
    this.video = video;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.octx.lineCap = 'round'; this.octx.lineJoin = 'round';
    this.h = opts; // { onTip(x,y), onStrokeEnd(points), onStatus(text) }
    this.running = false;
    this.stream = null;
    this.pw = 320; this.ph = 240;  // 处理分辨率（start 时按视频长宽比自适应）
    this.jumpDist = 112;             // 帧间质心瞬移阈值（处理像素）
    this.roi = { x0: 0, y0: 0, x1: 320, y1: 240 };
    this.roiArea = 320 * 240;
    this.trail = [];           // 当前笔画点（处理像素坐标）
    this.lostFrames = 0;
    this.smooth = null;        // 平滑后的笔尖
    this.jump = false;         // 本帧质心是否瞬移（重新落笔）
    this.phase = 'idle';       // idle → learning(锁定背景) → ready(识别书写)
    this.bg = null;            // 背景灰度 Float32Array
    this.age = null;           // 像素连续墨迹帧计数 Uint16Array
    this.prevConfirmed = null; // 上一帧已确认墨迹掩膜
    this.prevConfirmedCount = 0;
    this.armed = true;         // true=等待落笔确认，false=书写中
    this.candidate = null;     // 落笔候选质心
    this.confirmCount = 0;     // 候选连续确认次数
    this._stableCount = 0;
    this._learnStart = 0;
    this._prevLearnGray = null;
    this.frameMs = 0;
    this.fps = 0;
    this._fpsT = performance.now(); this._fpsC = 0;
    this._proc = document.createElement('canvas');
    this._proc.width = this.pw; this._proc.height = this.ph;
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
    if (!this.video.videoWidth) {
      await new Promise(r => this.video.addEventListener('loadedmetadata', r, { once: true }));
    }
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    // 覆盖层尺寸 = 视频原始像素；容器宽高比 = 视频宽高比 → 三者像素级对齐
    this.overlay.width = vw;
    this.overlay.height = vh;
    const wrap = this.video.parentElement;
    if (wrap) wrap.style.aspectRatio = `${vw} / ${vh}`;
    this.guide = this._guideRect(); // 取景框（映射到 1024×1024 书写坐标系）
    this._layoutGuideDom();
    this._setupProc(vw, vh);
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
    this.phase = 'idle'; this.bg = null; this.age = null;
    this.prevConfirmed = null; this.prevConfirmedCount = 0;
    this.armed = true; this.candidate = null; this.confirmCount = 0;
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
    this.bg = null; this.age = null;
    this.prevConfirmed = null; this.prevConfirmedCount = 0;
    this.armed = true; this.candidate = null; this.confirmCount = 0;
    this._prevLearnGray = null; this._stableCount = 0;
    this._learnStart = performance.now();
    this.h.onStatus('正在锁定纸面背景 · 请移开手，保持纸面稳定…');
  }

  // 取景框：视频中央正方形，映射到 1024×1024 书写坐标系
  _guideRect() {
    const vw = this.overlay.width, vh = this.overlay.height;
    const side = Math.min(vw, vh) * 0.85;
    return { x: (vw - side) / 2, y: (vh - side) / 2, side, vw, vh };
  }

  // 取景框 DOM 与识别 ROI 对齐（覆盖层与视频像素一一对应，百分比定位即可）
  _layoutGuideDom() {
    const gd = document.getElementById('cam-guide');
    if (!gd || !this.guide) return;
    const { x, y, side, vw, vh } = this.guide;
    gd.style.left = (x / vw * 100) + '%';
    gd.style.top = (y / vh * 100) + '%';
    gd.style.width = (side / vw * 100) + '%';
    gd.style.height = (side / vh * 100) + '%';
  }

  // 处理分辨率按视频长宽比等比自适应；取景框 → 处理坐标 ROI
  _setupProc(vw, vh) {
    let pw = PROC_W;
    let ph = Math.round(PROC_W * vh / vw);
    if (ph > PROC_H_MAX) { const k = PROC_H_MAX / ph; ph = PROC_H_MAX; pw = Math.max(160, Math.round(pw * k)); }
    if (ph < 100) { const k = 100 / ph; ph = 100; pw = Math.round(pw * k); }
    this.pw = pw; this.ph = ph;
    this._proc.width = pw; this._proc.height = ph;
    this.jumpDist = Math.round(pw * 0.35);
    const g = this.guide, s = pw / vw;
    const m = Math.max(2, Math.round(g.side * s * ROI_MARGIN));
    this.roi = {
      x0: Math.max(0, Math.ceil(g.x * s) + m),
      y0: Math.max(0, Math.ceil(g.y * s) + m),
      x1: Math.min(pw, Math.floor((g.x + g.side) * s) - m),
      y1: Math.min(ph, Math.floor((g.y + g.side) * s) - m)
    };
    this.roiArea = Math.max(1, (this.roi.x1 - this.roi.x0) * (this.roi.y1 - this.roi.y0));
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
        // 质心瞬移：先提交已写笔画，再等待新落笔确认，避免两位置间画出飞线
        if (this.trail.length >= MIN_STROKE_PTS) this.h.onStrokeEnd(this._commitTrail());
        this.trail = [];
        this.jump = false;
        this.armed = true; this.candidate = null; this.confirmCount = 0;
      }
      const p = this.to1024(tip.x * (this.overlay.width / this.pw), tip.y * (this.overlay.height / this.ph));
      this.trail.push([tip.x, tip.y]);
      this.lostFrames = 0;
      this.h.onTip(p[0], p[1]);
    } else {
      this.lostFrames++;
      if (this.lostFrames === LIFT_FRAMES && this.trail.length >= MIN_STROKE_PTS) {
        // 抬笔：结束当前笔画，回到待落笔状态
        this.h.onStrokeEnd(this._commitTrail());
        this.armed = true; this.candidate = null; this.confirmCount = 0;
      } else if (this.lostFrames > LIFT_FRAMES) {
        this.trail = [];
      }
    }
    this._drawOverlay(tip);
  }

  // 将当前轨迹转换为 1024×1024 书写坐标并清空轨迹
  _commitTrail() {
    const pts = this.trail.map(([x, y]) => {
      const q = this.to1024(x * (this.overlay.width / this.pw), y * (this.overlay.height / this.ph));
      return [q[0], q[1], performance.now()];
    });
    this.trail = [];
    return pts;
  }

  _grab() {
    this._pctx.drawImage(this.video, 0, 0, this.pw, this.ph);
    return this._pctx.getImageData(0, 0, this.pw, this.ph);
  }

  // 笔迹识别状态机：
  //   learning — 检测【取景框内】画面稳定性（框外的手/环境晃动不影响锁定），稳定后记忆背景
  //   ready    — 每帧在取景框内找出「新增墨迹」(本帧确认且上帧未确认)，质心即笔尖
  _findTip(data) {
    const pw = this.pw, ph = this.ph, N = pw * ph;
    const gray = new Float32Array(N);
    for (let i = 0, px = 0; px < N; px++, i += 4) {
      gray[px] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    }

    const { x0, y0, x1, y1 } = this.roi;

    if (this.phase === 'learning') {
      let changed = 0;
      if (this._prevLearnGray) {
        for (let py = y0; py < y1; py++) {
          const row = py * pw;
          for (let px = x0; px < x1; px++) {
            if (Math.abs(gray[row + px] - this._prevLearnGray[row + px]) > 0.12) changed++;
          }
        }
      }
      this._prevLearnGray = gray;
      this._stableCount = (this._prevLearnGray && changed < this.roiArea * 0.008) ? this._stableCount + 1 : 0;
      if (this._stableCount >= LEARN_STABLE_FRAMES || performance.now() - this._learnStart > LEARN_TIMEOUT_MS) {
        this.bg = gray; this.age = null; this.prevConfirmed = null;
        this.armed = true; this.candidate = null; this.confirmCount = 0;
        this.phase = 'ready';
        this.h.onStatus('背景已锁定 · 请在虚线取景框内书写，墨迹自动识别');
      }
      return null;
    }

    if (this.phase !== 'ready' || !this.bg) { this.smooth = null; return null; }

    // pass 1：取景框内瞬时墨迹 → 连续存在 CONFIRM_FRAMES 帧的像素确认为真墨迹。
    // 墨迹持久附着在纸上；手影扫过、笔杆晃过、遮挡只持续几帧，不会确认。
    // 同时维护背景模型的自适应性：
    //   - 非墨迹像素缓慢吸收光照/阴影的渐变（阴影停留后不再算"新增暗区"）
    //   - 大面积同步亮度漂移（手进入画面触发自动曝光/对光变化）→ 背景整体平移补偿
    if (!this.age) this.age = new Uint16Array(N);
    const confirmed = new Uint8Array(N);
    let confirmedCount = 0;
    let sumDiff = 0, diffCnt = 0, bigCnt = 0;  // 非墨迹像素的亮度漂移统计
    for (let py = y0; py < y1; py++) {
      const row = py * pw;
      for (let px = x0; px < x1; px++) {
        const idx = row + px;
        const d = this.bg[idx] - gray[idx];
        if (d > INK_DIFF && gray[idx] < INK_MAX_GRAY) {
          this.age[idx] = this.age[idx] < CONFIRM_FRAMES ? this.age[idx] + 1 : CONFIRM_FRAMES;
        } else {
          this.age[idx] = 0;
          const g = gray[idx] - this.bg[idx];
          sumDiff += g; diffCnt++;
          if (Math.abs(g) > 0.06) bigCnt++;
          // 背景慢速自适应（墨迹像素保持原背景，不会被"写进"背景而丢失）
          this.bg[idx] += 0.02 * g;
        }
        if (this.age[idx] >= CONFIRM_FRAMES) { confirmed[idx] = 1; confirmedCount++; }
      }
    }
    // 曝光突变补偿：过半像素同步亮度漂移 = 曝光跳变（非局部阴影/墨迹），
    // 背景整体平移后继续识别，不会误报"画面变化过大"或假墨迹
    if (diffCnt > 0 && bigCnt > diffCnt * 0.5) {
      const drift = sumDiff / diffCnt;
      if (Math.abs(drift) > 0.02 && Math.abs(drift) < 0.35) {
        for (let i = 0; i < N; i++) this.bg[i] += drift;
      }
    }
    if (confirmedCount > this.roiArea * 0.30) {
      // 取景框内大面积变化：纸张移动/遮挡 → 提示重校准，本帧不识别
      this.h.onStatus('画面变化过大 · 请点「重新校准」');
      this.smooth = null; this.prevConfirmed = confirmed; this.prevConfirmedCount = confirmedCount;
      return null;
    }
    // 已确认墨迹大面积消失 = 光照突变/遮挡恢复，本帧不可信
    if (this.prevConfirmed && this.prevConfirmedCount - confirmedCount > VANISH_WARN) {
      this.smooth = null; this.prevConfirmed = confirmed; this.prevConfirmedCount = confirmedCount;
      return null;
    }
    // pass 2：收集新增确认墨迹像素（正在生长的笔画前沿）= 本帧确认 − 上帧确认
    const prev = this.prevConfirmed;
    const newIdx = [];
    if (prev) {
      for (let py = y0; py < y1; py++) {
        const row = py * pw;
        for (let px = x0; px < x1; px++) {
          const idx = row + px;
          if (confirmed[idx] && !prev[idx]) newIdx.push(idx);
        }
      }
    }
    this.prevConfirmed = confirmed; this.prevConfirmedCount = confirmedCount;
    if (!newIdx.length) { this.smooth = null; return null; }

    // 连通域分离：同帧内可能存在多处新增暗区（真实笔画前沿 + 手影/抖动干扰），
    // 必须分离后只跟踪真实前沿，否则质心混合会把轨迹拉偏。
    if (!this._label || this._label.length !== N) {
      this._label = new Int32Array(N); this._queue = new Int32Array(N); this._gen = 0;
    }
    this._gen++;
    const gen = this._gen, label = this._label, queue = this._queue;
    const comps = [];
    for (const s of newIdx) {
      if (label[s] === gen) continue;
      const st = { cnt: 0, sumd: 0, cx: 0, cy: 0, minx: pw, maxx: 0, miny: ph, maxy: 0 };
      let head = 0, tail = 0;
      queue[tail++] = s; label[s] = gen;
      while (head < tail) {
        const idx = queue[head++];
        const px = idx % pw, py = (idx - px) / pw;
        st.cnt++; st.cx += px; st.cy += py;
        st.sumd += this.bg[idx] - gray[idx];
        if (px < st.minx) st.minx = px; if (px > st.maxx) st.maxx = px;
        if (py < st.miny) st.miny = py; if (py > st.maxy) st.maxy = py;
        // 4 邻接扩散（仍在「新增确认墨迹」集合内才入队）
        if (px > 0 && label[idx - 1] !== gen && confirmed[idx - 1] && !prev[idx - 1]) { label[idx - 1] = gen; queue[tail++] = idx - 1; }
        if (px < pw - 1 && label[idx + 1] !== gen && confirmed[idx + 1] && !prev[idx + 1]) { label[idx + 1] = gen; queue[tail++] = idx + 1; }
        if (py > 0 && label[idx - pw] !== gen && confirmed[idx - pw] && !prev[idx - pw]) { label[idx - pw] = gen; queue[tail++] = idx - pw; }
        if (py < ph - 1 && label[idx + pw] !== gen && confirmed[idx + pw] && !prev[idx + pw]) { label[idx + pw] = gen; queue[tail++] = idx + pw; }
      }
      st.cx /= st.cnt; st.cy /= st.cnt;
      comps.push(st);
    }

    // 连通域选择：
    //   书写中 → 取距上一笔尖最近的连通域（笔画是从笔尖连续生长的）
    //   待落笔 → 取面积最大的连通域（真实落笔墨池 > 噪点闪烁）
    let pick = null;
    if (!this.armed && this.smooth) {
      let bd = Infinity;
      for (const c of comps) {
        const d = Math.hypot(c.cx - this.smooth[0], c.cy - this.smooth[1]);
        if (d < bd) { bd = d; pick = c; }
      }
    } else {
      for (const c of comps) if (!pick || c.cnt > pick.cnt) pick = c;
    }
    if (!pick) { this.smooth = null; return null; }

    const failKeep = () => { if (this.armed || !this.smooth) this.smooth = null; };
    if (pick.cnt < MIN_PIX || pick.cnt > MAX_PIX || pick.sumd / pick.cnt < TIP_STRONG) {
      failKeep();   // 书写中保留锚点，仅跳过本帧（维持连续性校验的基准）
      return null;
    }
    // 形态过滤：细长条的新增区域 = 移动的影子/笔杆影像，丢弃
    const bw = pick.maxx - pick.minx + 1, bh = pick.maxy - pick.miny + 1;
    if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > ASPECT_MAX) {
      failKeep();
      return null;
    }
    const x = pick.cx, y = pick.cy;
    // 落笔确认：新位置需连续 ARM_CONFIRM 帧稳定出现才正式起笔（防抖动/瞬时误报）
    if (this.armed) {
      if (this.candidate && Math.hypot(x - this.candidate[0], y - this.candidate[1]) < ARM_RADIUS) {
        this.confirmCount++;
      } else {
        this.candidate = [x, y];
        this.confirmCount = 1;
      }
      if (this.confirmCount < ARM_CONFIRM) { this.smooth = null; return null; }
      this.armed = false;
      this.smooth = this.candidate;   // 从候选位置起笔
      return { x: this.smooth[0], y: this.smooth[1] };
    }
    if (!this.smooth) { this.smooth = [x, y]; return { x, y }; }  // 恢复锚点
    const d = Math.hypot(x - this.smooth[0], y - this.smooth[1]);
    if (d > this.jumpDist) {
      // 帧间瞬移：重置平滑状态并标记跳变，由 _processFrame 重开笔画
      this.jump = true;
      this.smooth = [x, y];
    } else if (d > GROW_RADIUS) {
      // 连续性校验：书写中笔画从上一笔尖连续生长；
      // 远处孤立暗斑（阴影/抖动）忽略，本帧不移动笔尖
      return null;
    } else {
      // 指数平滑，抑制单帧抖动
      this.smooth = [this.smooth[0] + 0.45 * (x - this.smooth[0]), this.smooth[1] + 0.45 * (y - this.smooth[1])];
    }
    return { x: this.smooth[0], y: this.smooth[1] };
  }

  _drawOverlay(tip) {
    const c = this.octx, W = this.overlay.width, H = this.overlay.height;
    c.clearRect(0, 0, W, H);
    // 取景框外轻微压暗，突出识别区域
    if (this.running && this.phase === 'ready') {
      const g = this.guide;
      c.save();
      c.fillStyle = 'rgba(0,0,0,.18)';
      c.fillRect(0, 0, g.x, H);
      c.fillRect(g.x + g.side, 0, W - g.x - g.side, H);
      c.fillRect(g.x, 0, g.side, g.y);
      c.fillRect(g.x, g.y + g.side, g.side, H - g.y - g.side);
      c.restore();
    }
    // 已成轨迹
    if (this.trail.length > 1) {
      c.strokeStyle = 'rgba(255,80,80,.9)';
      c.lineWidth = Math.max(2, W / 240);
      c.beginPath();
      c.moveTo(this.trail[0][0] * (W / this.pw), this.trail[0][1] * (H / this.ph));
      for (let i = 1; i < this.trail.length; i++) c.lineTo(this.trail[i][0] * (W / this.pw), this.trail[i][1] * (H / this.ph));
      c.stroke();
    }
    if (tip) {
      const r = Math.max(6, W / 100);
      c.strokeStyle = '#00e676';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(tip.x * (W / this.pw), tip.y * (H / this.ph), r, 0, Math.PI * 2);
      c.stroke();
    }
  }
}
