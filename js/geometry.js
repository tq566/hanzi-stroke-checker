// geometry.js — 几何工具：重采样 / 归一化 / DTW / 笔画方向分析

export function dist(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

export function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// 按弧长等距重采样为 n 个点（笔迹分析的标准预处理）
export function resample(pts, n = 32) {
  if (!pts || !pts.length) return [];
  if (pts.length === 1) {
    const p = pts[0];
    return Array.from({ length: n }, () => [p[0], p[1]]);
  }
  const L = pathLength(pts);
  if (L === 0) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const step = L / (n - 1);
  const out = [[pts[0][0], pts[0][1]]];
  let acc = 0, i = 1, prev = pts[0];
  while (out.length < n - 1 && i < pts.length) {
    const d = dist(prev, pts[i]);
    if (acc + d >= step) {
      const t = (step - acc) / (d || 1e-9);
      const q = [prev[0] + (pts[i][0] - prev[0]) * t, prev[1] + (pts[i][1] - prev[1]) * t];
      out.push(q);
      prev = q;
      acc = 0;
    } else {
      acc += d;
      prev = pts[i];
      i++;
    }
  }
  while (out.length < n) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

// 单笔画归一化：包围盒中心移到原点，最长边缩放到 1（保留长宽比，不做旋转归一，
// 以便区分 撇/捺 等方向敏感的笔画）
export function normalizeStroke(pts) {
  const bb = bboxOf(pts);
  const s = Math.max(bb.w, bb.h, 1e-6);
  return pts.map(p => [(p[0] - bb.cx) / s, (p[1] - bb.cy) / s]);
}

// 经典 DTW（动态时间规整），返回按路径长度归一化的平均代价
// a、b 均为归一化后的等长点列
export function dtw(a, b) {
  const N = a.length, M = b.length;
  const INF = 1e15;
  let prev = new Float64Array(M + 1);
  let cur = new Float64Array(M + 1);
  prev[0] = 0;
  for (let j = 1; j <= M; j++) prev[j] = INF;
  for (let i = 1; i <= N; i++) {
    cur[0] = INF;
    const ai = a[i - 1];
    for (let j = 1; j <= M; j++) {
      const bj = b[j - 1];
      const dx = ai[0] - bj[0], dy = ai[1] - bj[1];
      const c = dx * dx + dy * dy;
      const best = Math.min(prev[j], Math.min(prev[j - 1], cur[j - 1]));
      cur[j] = c + best;
    }
    const t = prev; prev = cur; cur = t;
  }
  return Math.sqrt(prev[M]) / (N + M) * 2;
}

// 统计笔画中的显著转折次数（用于识别"折"类笔画）
function countTurns(pts) {
  let turns = 0, prevDir = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    const seg = Math.hypot(dx, dy);
    if (seg < 14) continue; // 忽略抖动
    const dir = Math.atan2(dy, dx);
    if (prevDir !== null) {
      let d = Math.abs(dir - prevDir);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 0.7) turns++; // 转向超过约 40°
    }
    prevDir = dir;
  }
  return turns;
}

// 依据几何形状为笔画起一个中文名（横/竖/撇/捺/点/提/折），用于反馈话术
export function strokeName(pts) {
  if (!pts || pts.length < 2) return '点';
  const s = pts[0], e = pts[pts.length - 1];
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const len = Math.hypot(dx, dy);
  const turns = countTurns(pts);
  if (turns >= 2) return '折';
  if (len < 120) {
    if (dx > 0 && dy < 0) return '提';
    return '点';
  }
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > ay * 1.8) return '横';
  if (ay > ax * 1.8) return '竖';
  if (turns >= 1) return '折';
  if (dx < 0 && dy > 0) return '撇';
  if (dx > 0 && dy > 0) return '捺';
  if (dx > 0 && dy < 0) return '提';
  return '折';
}

// 行笔方向的中文描述（用于"应从X到Y书写"提示）
export function directionPhrase(pts) {
  const s = pts[0], e = pts[pts.length - 1];
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > ay * 2) return dx > 0 ? '从左到右' : '从右到左';
  if (ay > ax * 2) return dy > 0 ? '从上到下' : '从下到上';
  if (dx > 0) return dy > 0 ? '从左上到右下' : '从左下到右上';
  return dy > 0 ? '从右上到左下' : '从右下到左上';
}
