// build_db.js — 将 Make Me a Hanzi 的 graphics.txt (JSONL) 转换为分块笔顺数据库
// 用法: node tools/build_db.js
// 输出:
//   data/meta.json          { total: 字数 }
//   data/chunks/XX.json     按 Unicode 码点高 2 位分块的字典
//                           { "字": { "s": [轮廓path...], "mc": [每笔点数...], "m": [x0,y0,...] } }
// 按需加载：写什么字才请求对应分块（配合 Service Worker 离线缓存）。
// 数据许可: makemeahanzi 基于 ARPHIC 公众字型授权，允许再分发。

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'graphics.txt');
const DST = path.join(__dirname, '..', 'data');
const CHDIR = path.join(DST, 'chunks');

const raw = fs.readFileSync(SRC, 'utf8');
const chunks = {};
let n = 0, bad = 0;

for (const line of raw.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  let obj;
  try { obj = JSON.parse(t); } catch (e) { bad++; continue; }
  const ch = obj.character;
  if (!ch || !Array.isArray(obj.strokes) || !Array.isArray(obj.medians)) continue;
  if (obj.strokes.length !== obj.medians.length) continue;
  const cp = ch.codePointAt(0);
  // 仅收录 CJK 区段：扩展A(3400-4DBF) 基本区(4E00-9FFF) 兼容区(F900-FAFF)
  if (!((cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF))) continue;
  const mc = [];
  const medFlat = [];
  for (const m of obj.medians) {
    if (!Array.isArray(m) || m.length < 1) { mc.push(0); continue; }
    mc.push(m.length);
    for (const p of m) medFlat.push(Math.round(p[0]), Math.round(p[1]));
  }
  const key = cp.toString(16).toUpperCase().padStart(4, '0').slice(0, 2);
  (chunks[key] = chunks[key] || {})[ch] = { s: obj.strokes, mc, m: medFlat };
  n++;
}

fs.rmSync(path.join(DST, 'strokes.json'), { force: true });
fs.rmSync(CHDIR, { recursive: true, force: true });
fs.mkdirSync(CHDIR, { recursive: true });
for (const [key, dict] of Object.entries(chunks)) {
  fs.writeFileSync(path.join(CHDIR, `${key}.json`), JSON.stringify(dict));
}
fs.writeFileSync(path.join(DST, 'meta.json'), JSON.stringify({ total: n }));
console.log(`characters: ${n}, skipped: ${bad}, chunks: ${Object.keys(chunks).length}, ` +
  `data: ${(fs.readdirSync(CHDIR).reduce((a, f) => a + fs.statSync(path.join(CHDIR, f)).size, 0) / 1048576).toFixed(2)} MB`);
