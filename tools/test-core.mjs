// test-core.mjs — 核心识别算法端到端测试（Node 环境，绕过浏览器 API）
// 用法: node tools/test-core.mjs
// 复刻 app.js 的笔画注入与分析流程，对真实数据验证各错误场景分类。

import { readFileSync, readdirSync } from 'fs';
import { resample, bboxOf, pathLength } from '../js/geometry.js';
import { matchStrokeIncremental, analyzeFinal } from '../js/matcher.js';

// 从分块数据库目录合并加载（浏览器端按需分块的等价数据源）
const db = {};
const chunkDir = new URL('../data/chunks/', import.meta.url);
for (const f of readdirSync(chunkDir)) {
  Object.assign(db, JSON.parse(readFileSync(new URL(f, chunkDir))));
}

function getEntry(ch) {
  const raw = db[ch];
  if (!raw) return null;
  const medians = [];
  let off = 0;
  for (const cnt of raw.mc) {
    const pts = [];
    for (let i = 0; i < cnt * 2; i += 2) pts.push([raw.m[off + i], raw.m[off + i + 1]]);
    off += cnt * 2;
    medians.push(pts);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of medians) {
    for (const p of m) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return { ch, strokes: raw.s, medians, medRes: medians.map(m => resample(m, 32)), n: raw.s.length };
}

function makeStroke(points) {
  const ptsRes = resample(points.map(p => [p[0], p[1]]), 32);
  return {
    points, ptsRes, bbox: bboxOf(ptsRes),
    length: pathLength(ptsRes),
    start: ptsRes[0], end: ptsRes[ptsRes.length - 1]
  };
}

let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }

// 模拟书写：标准中轴线 + 抖动 + 平移（模拟书写位置偏差）
function simulate(entry, { jitter = 12, shift = [15, 10], order = null, reverse = [], skip = [], extra = 0 } = {}) {
  const strokes = [];
  let idxs = order ? order.filter(i => !skip.includes(i) && i >= 0 && i < entry.n)
                    : [...Array(entry.n).keys()].filter(i => !skip.includes(i));
  for (const i of idxs) {
    let pts = entry.medRes[i].map(([x, y]) => [x + shift[0], y + shift[1]]);
    if (reverse.includes(i)) pts = pts.reverse();
    if (jitter > 0) pts = pts.map(([x, y]) => [x + (rnd() - 0.5) * jitter, y + (rnd() - 0.5) * jitter]);
    strokes.push(makeStroke(pts.map(([x, y]) => [x, y, 0])));
  }
  for (let k = 0; k < extra; k++) {
    const bx = 150 + k * 120;
    strokes.push(makeStroke([[bx, 180], [bx + 180, 420], [bx - 60, 640], [bx + 220, 760]].map(([x, y]) => [x, y, 0])));
  }
  return strokes;
}

function runRealtime(entry, strokes) {
  const taken = new Set();
  const recs = [];
  for (let k = 0; k < strokes.length; k++) {
    const res = matchStrokeIncremental(strokes[k], entry, taken, 1);
    if (res.matched) {
      taken.add(res.stdIdx);
      let minUn = -1;
      for (let j = 0; j < res.stdIdx; j++) if (!taken.has(j)) { minUn = j; break; }
      if (minUn >= 0) recs.push({ type: 'ORDER', at: k, got: res.stdIdx, want: minUn });
      if (res.reversed) recs.push({ type: 'DIRECTION', at: k, std: res.stdIdx });
    } else {
      recs.push({ type: 'EXTRA', at: k });
    }
  }
  return recs;
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log('== 核心算法场景测试 ==');

for (const ch of ['永', '火', '中', '国', '大', '我', '学']) {
  const e = getEntry(ch);
  if (!e) { console.log(`  SKIP  ${ch} 无数据`); fail++; continue; }

  // 1. 正确笔顺 + 常规抖动 → 应无错误
  const t0 = performance.now();
  let r = analyzeFinal(simulate(e, { jitter: 12 }), e, 1);
  const ms1 = performance.now() - t0;
  check(`${ch} 正确笔顺(j12)`, r.correct, JSON.stringify(r.records));
  // 大抖动（宽松字风）→ 默认严格度仍应通过
  r = analyzeFinal(simulate(e, { jitter: 28, shift: [30, -25] }), e, 1);
  check(`${ch} 正确笔顺(j28)`, r.correct, JSON.stringify(r.records));

  // 2. 顺序颠倒（0/1 互换）→ ORDER
  r = analyzeFinal(simulate(e, { order: [1, 0, ...[...Array(e.n).keys()].slice(2)], jitter: 10 }), e, 1);
  check(`${ch} 顺序颠倒`, r.records.some(x => x.type === 'ORDER'), JSON.stringify(r.records.map(x => x.type)));

  // 3. 方向错误（第1笔反向）→ DIRECTION
  r = analyzeFinal(simulate(e, { reverse: [0], jitter: 6 }), e, 1);
  check(`${ch} 方向错误`, r.records.some(x => x.type === 'DIRECTION'), JSON.stringify(r.records.map(x => x.type)));

  // 4. 漏笔（跳过第1笔）→ MISSING
  r = analyzeFinal(simulate(e, { skip: [0], jitter: 10 }), e, 1);
  check(`${ch} 漏笔`, r.records.some(x => x.type === 'MISSING') && !r.records.some(x => x.type === 'ORDER'), JSON.stringify(r.records.map(x => x.type)));

  // 5. 多笔 → EXTRA
  r = analyzeFinal(simulate(e, { extra: 1, jitter: 10 }), e, 1);
  check(`${ch} 多笔`, r.records.some(x => x.type === 'EXTRA'), JSON.stringify(r.records.map(x => x.type)));

  // 6. 实时增量分析与终态一致性（正确笔顺下实时不应报错）
  const rt = runRealtime(e, simulate(e, { jitter: 12 }));
  check(`${ch} 实时无误报`, rt.length === 0, JSON.stringify(rt));

  console.log(`        单字校验耗时 ${ms1.toFixed(1)}ms`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
