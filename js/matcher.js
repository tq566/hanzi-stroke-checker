// matcher.js — 笔画匹配与笔顺错误判定核心
// 用户提供的是 1024×1024 坐标系下的笔迹（与标准字同空间，书写时有底字参考）

import { resample, normalizeStroke, dtw, bboxOf, dist, pathLength, strokeName, directionPhrase } from './geometry.js';

// ---------- 单笔配对打分 ----------
// userStroke: { ptsRes, bbox, length, start, end }（app 侧已重采样）
// stdMed: 标准笔画中轴线（1024 空间）
export function pairScore(userStroke, stdMed) {
  const u = normalizeStroke(userStroke.ptsRes);
  const s = normalizeStroke(stdMed);
  const f = dtw(u, s);                       // 正向形状代价
  const r = dtw([...u].reverse(), s);        // 反向书写时的形状代价
  const stdBb = bboxOf(stdMed);
  const posD = dist([userStroke.bbox.cx, userStroke.bbox.cy], [stdBb.cx, stdBb.cy]) / 1024;
  const lr = Math.abs(Math.log((userStroke.length + 1e-6) / (pathLength(stdMed) + 1e-6)));
  const base = Math.min(f, r);
  const score = base + 0.35 * posD + 0.25 * Math.min(lr, 1.5);
  // 端点对调检验：用户起点更靠近标准终点 → 方向写反
  const dSS = dist(userStroke.start, stdMed[0]) + dist(userStroke.end, stdMed[stdMed.length - 1]);
  const dSE = dist(userStroke.start, stdMed[stdMed.length - 1]) + dist(userStroke.end, stdMed[0]);
  const reversed = r < f * 0.8 && dSE < dSS * 0.7;
  return { score, f, r, reversed };
}

// ---------- 匈牙利算法（最小代价分配）----------
function hungarianMin(a, n) {
  const INF = 1e15;
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(INF);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = -1;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      if (j1 < 0) break;
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const ans = new Int32Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) ans[p[j] - 1] = j - 1;
  return ans;
}

// 带虚拟行列的矩形分配：真实对 cost + "多笔/漏笔"惩罚 P
const PAD = 0.5;
function solveAssignment(cost, nU, nS) {
  const N = nU + nS;
  const mat = [];
  for (let i = 0; i < N; i++) {
    const row = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      if (i < nU && j < nS) row[j] = cost[i][j];
      else if (i < nU || j < nS) row[j] = PAD; // 用户笔→虚拟(多笔) 或 虚拟→标准笔(漏笔)
      else row[j] = 0;
    }
    mat.push(row);
  }
  const rowsToCols = hungarianMin(mat, N);
  const pairs = [], extra = [], missing = [];
  for (let i = 0; i < nU; i++) {
    const j = rowsToCols[i];
    if (j < nS) pairs.push({ u: i, s: j });
    else extra.push(i);
  }
  const takenStd = new Set(pairs.map(p => p.s));
  for (let j = 0; j < nS; j++) if (!takenStd.has(j)) missing.push(j);
  return { pairs, extra, missing };
}

// ---------- 实时逐笔匹配（书写过程中）----------
// 追踪已占用的标准笔画 takenSet；返回该用户笔画的匹配结论
export function matchStrokeIncremental(stroke, entry, takenSet, strict) {
  let best = null;
  for (let j = 0; j < entry.n; j++) {
    if (takenSet.has(j)) continue;
    const sc = pairScore(stroke, entry.medRes[j]);
    if (!best || sc.score < best.score) best = Object.assign({ stdIdx: j }, sc);
  }
  const acceptT = 0.24 * strict;
  if (best && best.score < acceptT) {
    return { matched: true, stdIdx: best.stdIdx, score: best.score, reversed: best.reversed };
  }
  return { matched: false, score: best ? best.score : Infinity };
}

// ---------- 最终校验：全量最优分配 + 错误分类 ----------
export function analyzeFinal(userStrokes, entry, strict) {
  const nU = userStrokes.length, nS = entry.n;
  // detail[i][j] = {score,f,r,reversed}；cost 为纯数值矩阵供匈牙利分配使用
  const detail = userStrokes.map(u => entry.medRes.map(m => pairScore(u, m)));
  const cost = detail.map(row => row.map(c => c.score));
  const { pairs, extra, missing } = solveAssignment(cost, nU, nS);

  const acceptT = 0.30 * strict;
  const records = [];
  const validPairs = [];
  const stdName = j => strokeName(entry.medRes[j]);
  const num = k => `第${k + 1}笔`;

  // 有效配对中代价过高的 → 同时记为多笔 + 漏笔
  for (const pr of pairs) {
    const c = detail[pr.u][pr.s];
    if (c.score < acceptT) {
      validPairs.push({ u: pr.u, s: pr.s, score: c.score, reversed: c.reversed });
    } else {
      extra.push(pr.u);
      missing.push(pr.s);
    }
  }
  extra.sort((a, b) => a - b);
  missing.sort((a, b) => a - b);

  // 1) 顺序错误：有效配对序列中的逆序对
  const seq = validPairs.map(p => p.s);
  for (let a = 0; a < seq.length; a++) {
    for (let b = a + 1; b < seq.length; b++) {
      if (seq[a] > seq[b]) {
        records.push({
          type: 'ORDER',
          userStrokeIndex: b,           // 后写的这一笔
          stdStrokeIndex: seq[b],
          expectedStdIndex: seq[a],
          stdStrokeName: stdName(seq[b]),
          expectedStrokeName: stdName(seq[a]),
          detail: `第${b + 1}笔（标准${num(seq[b])}「${stdName(seq[b])}」）与第${a + 1}笔（标准${num(seq[a])}「${stdName(seq[a])}」）顺序颠倒，应先写「${stdName(seq[b])}」`
        });
      }
    }
  }

  // 2) 方向错误
  for (const p of validPairs) {
    if (p.reversed) {
      records.push({
        type: 'DIRECTION',
        userStrokeIndex: p.u,
        stdStrokeIndex: p.s,
        stdStrokeName: stdName(p.s),
        expectedPhrase: directionPhrase(entry.medRes[p.s]),
        detail: `第${p.u + 1}笔「${stdName(p.s)}」书写方向错误，应${directionPhrase(entry.medRes[p.s])}书写`
      });
    }
  }

  // 3) 漏笔
  for (const j of missing) {
    records.push({
      type: 'MISSING',
      userStrokeIndex: null,
      stdStrokeIndex: j,
      stdStrokeName: stdName(j),
      expectedPhrase: directionPhrase(entry.medRes[j]),
      detail: `漏写了标准${num(j)}「${stdName(j)}」`
    });
  }

  // 4) 多笔
  for (const i of extra) {
    records.push({
      type: 'EXTRA',
      userStrokeIndex: i,
      stdStrokeIndex: null,
      detail: `第${i + 1}笔为多余笔画，与标准笔画均不匹配`
    });
  }

  return {
    pairs: validPairs, extra, missing, records,
    matchedCount: validPairs.length,
    correct: records.length === 0 && nU === nS
  };
}

export { strokeName, directionPhrase };
