// db.js — 标准汉字笔顺数据库：按需分块加载 + 条目缓存
// 数据由 tools/build_db.js 从 Make Me a Hanzi（ARPHIC PL 授权）生成：
//   data/meta.json      { total: 覆盖字数 }
//   data/chunks/XX.json  按 Unicode 码点高 2 位分块（写什么字才下载对应分块）
//   条目格式 { "s": 轮廓path[1024坐标系,y向下], "mc": 每笔点数, "m": 打平中轴线坐标 }

import { resample, bboxOf } from './geometry.js';

let total = 0;
let metaPromise = null;

// 加载元信息（轻量，首屏即取）
export function loadDB() {
  if (!metaPromise) {
    metaPromise = fetch('data/meta.json')
      .then(r => { if (!r.ok) throw new Error('数据库元信息加载失败'); return r.json(); })
      .then(m => { total = m.total; return m; })
      .catch(err => { total = 0; throw err; });
  }
  return metaPromise;
}

export function dbSize() { return total; }

const chunkCache = new Map();   // 块 key -> Promise<dict>
const entryCache = new Map();   // 字 -> entry | null

function chunkKey(ch) {
  return ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0').slice(0, 2);
}

function inCjk(cp) {
  return (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x4E00 && cp <= 0x9FFF) ||
         (cp >= 0xF900 && cp <= 0xFAFF);
}

// 获取标准笔顺条目（异步：首次遇到某字时分块下载，之后走缓存）
export async function getEntry(ch) {
  if (entryCache.has(ch)) return entryCache.get(ch);
  const cp = ch.codePointAt(0);
  if (!ch || ch.length !== 1 || !inCjk(cp)) return null;
  const key = chunkKey(ch);
  if (!chunkCache.has(key)) {
    chunkCache.set(key,
      fetch(`data/chunks/${key}.json`)
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({})));
  }
  const dict = await chunkCache.get(key);
  const raw = dict[ch];
  if (!raw || !Array.isArray(raw.s)) { entryCache.set(ch, null); return null; }

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
  const entry = {
    ch,
    strokes: raw.s,
    medians,
    medRes: medians.map(m => resample(m, 32)),
    bbox: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 },
    n: raw.s.length
  };
  entryCache.set(ch, entry);
  return entry;
}
