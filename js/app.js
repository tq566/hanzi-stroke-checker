// app.js — 主控制器：状态管理 / 实时分析流程 / 校验 / UI 事件 / 模式切换

import { loadDB, getEntry, dbSize } from './db.js';
import { resample, bboxOf, pathLength, strokeName, directionPhrase } from './geometry.js';
import { matchStrokeIncremental, analyzeFinal } from './matcher.js';
import { TouchCapture } from './capture.js';
import { CameraCapture } from './camera.js';
import { Animator } from './animator.js';
import { speak, stopSpeak, renderMessages, drawErrorHighlights, drawOkMarks } from './feedback.js';
import { PerfMonitor } from './perf.js';

const $ = id => document.getElementById(id);

const state = {
  ch: '永',
  entry: null,
  strokes: [],       // 已完成笔画 [{points, ptsRes, bbox, length, start, end}]
  live: null,         // 书写中的笔画点列（1024 空间）
  records: [],        // 当前错误记录（实时或校验结果）
  taken: new Set(),   // 实时匹配中已占用的标准笔画
  verified: false,
  strict: 1,
  voice: true, ghost: true, auto: true,
  mode: 'touch',
  lastAnalysisMs: 0
};

let writeCtx, camWriteCtx, perf, animator, camera;
let autoVerifyTimer = null;

// ---------- 画布绘制 ----------
function paint(ctx) {
  if (!ctx) return;
  ctx.clearRect(0, 0, 1024, 1024);
  drawGrid(ctx);
  const e = state.entry;
  if (e && state.ghost) drawGhost(ctx, e);
  // 用户笔迹
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#37474f';
  ctx.lineWidth = 22;
  for (const s of state.strokes) drawPolyline(ctx, s.ptsRes);
  if (state.live && state.live.length > 1) {
    ctx.strokeStyle = '#90a4ae';
    drawPolyline(ctx, state.live);
  }
  // 错误高亮 / 正确标记
  if (state.records.length) {
    drawErrorHighlights(ctx, state.strokes, e, state.records);
    if (state.verified) drawOkMarks(ctx, state.strokes, state.records);
  } else {
    // 非错误笔画显示蓝色书写序号
    drawOrderNumbers(ctx);
  }
}

function drawPolyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function drawGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = '#f4b8b8';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 1012, 1012);
  ctx.setLineDash([16, 16]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(512, 6); ctx.lineTo(512, 1018);
  ctx.moveTo(6, 512); ctx.lineTo(1018, 512);
  ctx.stroke();
  ctx.restore();
}

function drawGhost(ctx, e) {
  ctx.save();
  ctx.fillStyle = '#eceff1';
  for (const p of e.path2ds) ctx.fill(p);
  ctx.restore();
}

function drawOrderNumbers(ctx) {
  ctx.save();
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < state.strokes.length; i++) {
    const st = state.strokes[i].start;
    ctx.fillStyle = 'rgba(47,111,237,.85)';
    ctx.beginPath();
    ctx.arc(st[0], st[1], 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(i + 1), st[0], st[1] + 2);
  }
  ctx.restore();
}

function redraw() {
  paint(writeCtx);
  paint(camWriteCtx);
}

// ---------- 分析流程 ----------
function makeStroke(points) {
  const ptsRes = resample(points.map(p => [p[0], p[1]]), 32);
  const bbox = bboxOf(ptsRes);
  return {
    points,
    ptsRes,
    bbox,
    length: pathLength(ptsRes),
    start: ptsRes[0],
    end: ptsRes[ptsRes.length - 1]
  };
}

// 基于已完成笔画重跑实时（增量）分析：撤销/新笔画后保持稳定
function runRealtimeAnalysis() {
  state.taken = new Set();
  const recs = [];
  const e = state.entry;
  if (!e) return recs;
  for (let k = 0; k < state.strokes.length; k++) {
    const s = state.strokes[k];
    const res = matchStrokeIncremental(s, e, state.taken, state.strict);
    if (res.matched) {
      state.taken.add(res.stdIdx);
      let minUnassigned = -1;
      for (let j = 0; j < res.stdIdx; j++) if (!state.taken.has(j)) { minUnassigned = j; break; }
      if (minUnassigned >= 0) {
        recs.push({
          type: 'ORDER',
          userStrokeIndex: k,
          stdStrokeIndex: res.stdIdx,
          stdStrokeName: strokeName(e.medRes[res.stdIdx]),
          expectedStdIndex: minUnassigned,
          expectedStrokeName: strokeName(e.medRes[minUnassigned]),
          detail: `先写了标准第${res.stdIdx + 1}笔「${strokeName(e.medRes[res.stdIdx])}」，但标准第${minUnassigned + 1}笔「${strokeName(e.medRes[minUnassigned])}」应在其之前`
        });
      }
      if (res.reversed) {
        recs.push({
          type: 'DIRECTION',
          userStrokeIndex: k,
          stdStrokeIndex: res.stdIdx,
          stdStrokeName: strokeName(e.medRes[res.stdIdx]),
          expectedPhrase: directionPhrase(e.medRes[res.stdIdx]),
          detail: `第${k + 1}笔「${strokeName(e.medRes[res.stdIdx])}」书写方向错误，应${directionPhrase(e.medRes[res.stdIdx])}书写`
        });
      }
    } else {
      recs.push({
        type: 'EXTRA',
        userStrokeIndex: k,
        stdStrokeIndex: null,
        detail: `第${k + 1}笔与标准笔画均不匹配（疑似多笔）`
      });
    }
  }
  return recs;
}

// 一笔书写完成 → 即时分析 + 实时纠错提示
export function ingestStroke(points) {
  if (!state.entry || points.length < 1) return;
  const t0 = performance.now();
  state.strokes.push(makeStroke(points));
  state.verified = false;
  state.records = runRealtimeAnalysis();
  const ms = performance.now() - t0;
  state.lastAnalysisMs = ms;
  perf.reportAnalysis(ms);

  // 实时语音纠错（仅播报本笔新产生的问题）
  const e = state.entry;
  const k = state.strokes.length - 1;
  const lastRecs = state.records.filter(r => r.userStrokeIndex === k);
  if (state.voice && lastRecs.length) {
    const r = lastRecs[0];
    const head = r.type === 'ORDER' ? '笔顺错误'
              : r.type === 'DIRECTION' ? '笔画方向错误'
              : '多笔';
    speak(`${head}：${r.type === 'DIRECTION' ? `第${k + 1}笔应${r.expectedPhrase}书写` : (r.stdStrokeName ? `应先写「${r.expectedStrokeName || r.stdStrokeName}」` : '这一笔是多余的')}`);
  }

  redraw();
  updateMessages(`已书写 ${state.strokes.length}/${e.n} 笔。`);
  updateProgressLine();

  // 自动校验：写满标准笔画数且停笔 1.5s，或超出笔画数立即校验
  if (autoVerifyTimer) clearTimeout(autoVerifyTimer);
  if (state.strokes.length >= e.n) {
    if (state.auto && state.strokes.length === e.n) {
      autoVerifyTimer = setTimeout(() => verify(), 1500);
    } else if (state.strokes.length > e.n || state.auto) {
      verify();
    }
  }
}

// 最终校验：全量最优分配 + 结构化错误报告
export function verify() {
  if (!state.entry || !state.strokes.length) {
    updateMessages('请先书写汉字后再校验。');
    return;
  }
  if (autoVerifyTimer) { clearTimeout(autoVerifyTimer); autoVerifyTimer = null; }
  const t0 = performance.now();
  const res = analyzeFinal(state.strokes, state.entry, state.strict);
  state.records = res.records;
  state.verified = true;
  const ms = performance.now() - t0;
  state.lastAnalysisMs = ms;
  perf.reportAnalysis(ms);

  if (res.correct) {
    state.records = [{ type: 'OK', detail: '全部笔画顺序与方向均符合标准。' }];
    if (state.voice) speak('笔顺正确，继续保持！');
  } else {
    const cnt = { ORDER: 0, DIRECTION: 0, MISSING: 0, EXTRA: 0 };
    for (const r of res.records) cnt[r.type] = (cnt[r.type] || 0) + 1;
    const parts = [];
    if (cnt.ORDER) parts.push(`顺序问题${cnt.ORDER}处`);
    if (cnt.DIRECTION) parts.push(`方向错误${cnt.DIRECTION}处`);
    if (cnt.MISSING) parts.push(`漏笔${cnt.MISSING}处`);
    if (cnt.EXTRA) parts.push(`多笔${cnt.EXTRA}处`);
    if (state.voice) speak(`校验完成，发现${parts.join('、')}。`);
  }
  redraw();
  updateMessages();
  updateProgressLine();
}

function updateMessages(prefix) {
  const container = $('messages');
  if (state.records.length) {
    renderMessages(container, state.verified ? state.records : state.records, prefix);
  } else {
    renderMessages(container, [], prefix || (state.entry
      ? `请按笔顺书写「${state.ch}」，共 ${state.entry.n} 笔。`
      : '请选择汉字'));
  }
}

function updateProgressLine() {
  const n = state.entry ? state.entry.n : '?';
  const done = state.strokes.length;
  const el = state.mode === 'touch' ? $('progress-line') : $('cam-progress-line');
  const other = state.mode === 'touch' ? $('cam-progress-line') : $('progress-line');
  let txt = `已书写 ${done}/${n} 笔`;
  if (state.verified) txt += state.records.some(r => r.type === 'OK')
    ? ' · ✅ 校验通过'
    : ` · 共 ${state.records.filter(r => r.type !== 'OK').length} 处笔顺问题`;
  else if (done && state.records.length) txt += ` · 实时发现 ${state.records.length} 处问题`;
  el.textContent = txt;
  other.textContent = txt;
}

// ---------- 字符选择 ----------
const CHIPS = ['永', '火', '心', '中', '国', '山', '水', '木', '人', '大', '小', '上', '下', '口', '日', '月', '白', '我', '你', '好', '学', '文', '字', '汉'];

async function loadChar(ch) {
  if (!ch) return;
  state.ch = ch;
  state.entry = await getEntry(ch);
  state.strokes = [];
  state.live = null;
  state.taken = new Set();
  state.records = [];
  state.verified = false;
  if (autoVerifyTimer) { clearTimeout(autoVerifyTimer); autoVerifyTimer = null; }
  if (state.entry) {
    state.entry.path2ds = state.entry.strokes.map(d => new Path2D(d));
    $('char-input').value = ch;
    $('char-info').textContent = `「${ch}」共 ${state.entry.n} 笔`;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.ch === ch));
  } else {
    $('char-info').textContent = `「${ch}」暂无笔顺数据`;
  }
  redraw();
  updateMessages();
  updateProgressLine();
}

// ---------- 初始化 ----------
async function init() {
  writeCtx = $('write-canvas').getContext('2d');
  camWriteCtx = $('cam-write-canvas').getContext('2d');
  perf = new PerfMonitor($('perf-hud'));
  animator = new Animator($('anim-stage'), $('anim-caption'), $('anim-progress-fill'), $('anim-title'));

  try {
    await loadDB();
    $('char-info').textContent = `笔顺库已就绪（${dbSize()} 字，按需加载）`;
  } catch (err) {
    $('char-info').textContent = '笔顺数据库加载失败：' + err.message;
  }

  // 快选字
  const chips = $('quick-chips');
  for (const ch of CHIPS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.ch = ch;
    b.textContent = ch;
    b.addEventListener('click', () => loadChar(ch));
    chips.appendChild(b);
  }
  await loadChar('永');

  // 输入任意字
  $('char-input').addEventListener('input', e => {
    const v = e.target.value;
    const m = v.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g);
    const ch = m ? m[m.length - 1] : '';
    e.target.value = ch;
    if (ch) loadChar(ch);
  });

  // 触屏采集
  new TouchCapture($('write-canvas'), {
    onStrokeStart: () => { if (state.entry) state.live = []; },
    onStrokeAdd: (x, y, t) => { if (state.entry && state.live) { state.live.push([x, y]); paint(writeCtx); } },
    onStrokeEnd: pts => { state.live = null; ingestStroke(pts); }
  });

  // 摄像头采集
  camera = new CameraCapture($('cam-video'), $('cam-overlay'), {
    onTip: (x, y) => {
      if (!state.entry) return;
      if (!state.live) state.live = [];
      const last = state.live[state.live.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) > 2) state.live.push([x, y]);
      paint(camWriteCtx);
    },
    onStrokeEnd: pts => { state.live = null; ingestStroke(pts); },
    onStatus: t => { $('cam-status').textContent = t; }
  });

  // 模式切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.mode = tab.dataset.mode;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      $('touch-panel').classList.toggle('active', state.mode === 'touch');
      $('camera-panel').classList.toggle('active', state.mode === 'camera');
      if (state.mode !== 'camera' && camera.running) { camera.stop(); $('cam-status').textContent = '摄像头未开启'; }
      perf.reportCamera(camera.frameMs, camera.fps, state.mode === 'camera' && camera.running);
      updateProgressLine();
    });
  });

  // 控制按钮
  $('btn-undo').addEventListener('click', () => {
    if (!state.strokes.length) return;
    state.strokes.pop();
    state.verified = false;
    state.records = runRealtimeAnalysis();
    redraw();
    updateMessages('已撤销上一笔。');
    updateProgressLine();
  });
  $('btn-clear').addEventListener('click', clearAll);
  $('btn-verify').addEventListener('click', verify);
  $('btn-demo').addEventListener('click', openDemo);

  // 设置
  $('opt-voice').addEventListener('change', e => {
    state.voice = e.target.checked;
    if (!state.voice) stopSpeak();
  });
  $('opt-ghost').addEventListener('change', e => { state.ghost = e.target.checked; redraw(); });
  $('opt-auto').addEventListener('change', e => { state.auto = e.target.checked; });
  $('opt-strict').addEventListener('change', e => {
    state.strict = parseFloat(e.target.value);
    if (state.strokes.length) { state.verified ? verify() : (state.records = runRealtimeAnalysis(), redraw(), updateMessages(), updateProgressLine()); }
  });

  // 导出结构化错误记录
  $('btn-export').addEventListener('click', () => {
    const data = {
      character: state.ch,
      totalStandardStrokes: state.entry ? state.entry.n : null,
      writtenStrokes: state.strokes.length,
      strictness: state.strict,
      verified: state.verified,
      errorCount: state.records.filter(r => r.type !== 'OK' && r.type !== 'INFO').length,
      records: state.records,
      capturedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `笔顺记录_${state.ch}_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // 摄像头按钮
  $('btn-cam-start').addEventListener('click', async () => {
    try {
      await camera.start(); // 启动后自动锁定纸面背景（状态由 onStatus 推送）
    } catch (err) {
      $('cam-status').textContent = '无法开启摄像头：' + err.message + '（需 HTTPS 或 localhost 环境）';
    }
  });
  $('btn-cam-stop').addEventListener('click', () => {
    camera.stop();
    $('cam-status').textContent = '摄像头未开启';
    perf.reportCamera(0, 0, false);
  });
  $('btn-cam-color').addEventListener('click', () => {
    if (!camera.running) { $('cam-status').textContent = '请先开启摄像头'; return; }
    camera.recalibrate();
  });
  $('btn-cam-clear').addEventListener('click', () => { camera.resetTrail(); clearAll(); });

  // 定时刷新摄像头性能 HUD
  setInterval(() => {
    if (camera && camera.running) perf.reportCamera(camera.frameMs, camera.fps, true);
  }, 500);

  // 动画演示
  $('btn-anim-close').addEventListener('click', closeDemo);
  $('btn-anim-play').addEventListener('click', () => animator.toggle());
  $('btn-anim-next').addEventListener('click', () => { animator.setStepMode(false); animator.next(); });
  $('btn-anim-prev').addEventListener('click', () => animator.prev());
  $('btn-anim-replay').addEventListener('click', () => { animator.reset(); animator.play(); });
  $('btn-anim-step').addEventListener('click', e => {
    const on = !animator.stepMode;
    animator.setStepMode(on);
    e.target.classList.toggle('primary', on);
    e.target.textContent = on ? '逐笔模式：开' : '逐笔模式';
    if (!animator.playing) animator.play();
  });

  // 扫码分享（当前页面地址 → 二维码）
  $('btn-qr').addEventListener('click', showQR);
  $('btn-qr-close').addEventListener('click', () => $('qr-modal').classList.add('hidden'));

  // PWA Service Worker：外壳预缓存 + 分块按需离线
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 非 HTTPS/localhost 环境忽略 */ });
  }

  // 调试 / 自动化测试接口
  setupTestAPI();
}

function clearAll() {
  state.strokes = [];
  state.live = null;
  state.taken = new Set();
  state.records = [];
  state.verified = false;
  if (autoVerifyTimer) { clearTimeout(autoVerifyTimer); autoVerifyTimer = null; }
  redraw();
  updateMessages();
  updateProgressLine();
}

function openDemo() {
  if (!state.entry) return;
  animator.voiceOn = state.voice;
  $('animator').classList.remove('hidden');
  animator.open(state.entry);
}

function closeDemo() {
  $('animator').classList.add('hidden');
  animator.close();
}

// 生成当前页面地址二维码（手机扫码直达）
function showQR() {
  const url = location.href.split('#')[0];
  const canvas = $('qr-canvas');
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const px = Math.floor(Math.min(canvas.width, canvas.height) / (n + 8));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    const off = Math.floor((canvas.width - n * px) / 2);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) ctx.fillRect(off + c * px, off + r * px, px, px);
  } catch (e) {
    // 二维码库缺失时降级为纯文字展示
  }
  $('qr-url').textContent = url;
  $('qr-modal').classList.remove('hidden');
}

// ---------- 自动化测试接口 ----------
function setupTestAPI() {
  window.__app = {
    state,
    verify,
    clearAll,
    loadChar,
    ingest: ingestStroke
  };
  // __test.write(ch, opts)：按标准中轴线生成带抖动的模拟笔迹并注入
  // opts: { jitter=12, shift=[15,10], order=[stdIdx...书写顺序], reverse=[stdIdx...反向书写],
  //         skip=[stdIdx...漏写], extra=N 多笔, verify=true 是否自动校验 }
  window.__test = {
    async write(ch, opts = {}) {
      const { jitter = 12, shift = [15, 10], order = null, reverse = [], skip = [], extra = 0 } = opts;
      await loadChar(ch);
      const e = state.entry;
      if (!e) return { error: 'no entry' };
      let idxs = order ? order.filter(i => !skip.includes(i) && i >= 0 && i < e.n)
                       : [...Array(e.n).keys()].filter(i => !skip.includes(i));
      const all = [];
      for (const i of idxs) {
        let pts = e.medRes[i].map(([x, y]) => [x + shift[0], y + shift[1]]);
        if (reverse.includes(i)) pts = pts.reverse();
        if (jitter > 0) pts = pts.map(([x, y]) => [x + (Math.random() - 0.5) * jitter, y + (Math.random() - 0.5) * jitter]);
        all.push(pts.map(([x, y]) => [x, y, performance.now()]));
      }
      for (let k = 0; k < extra; k++) {
        const bx = 150 + k * 120;
        all.push([[bx, 180], [bx + 180, 420], [bx - 60, 640], [bx + 220, 760]].map(([x, y]) => [x, y, performance.now()]));
      }
      for (const s of all) ingestStroke(s);
      verify();
      return {
        char: ch,
        strokeCount: state.strokes.length,
        correct: state.verified && state.records.length === 1 && state.records[0].type === 'OK',
        records: state.records
      };
    },
    summary() {
      return {
        char: state.ch,
        strokeCount: state.strokes.length,
        verified: state.verified,
        records: state.records,
        lastAnalysisMs: state.lastAnalysisMs
      };
    }
  };
}

init().catch(err => {
  const el = document.getElementById('messages');
  el.innerHTML = `<div class="msg msg-err">初始化失败：${err.message}</div>`;
});
