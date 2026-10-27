// feedback.js — 实时反馈：语音提示 / 文字消息 / 画布高亮标注

let zhVoice = null;
let voicesReady = false;

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return null;
  return vs.find(v => /^zh[-_]CN/i.test(v.lang)) ||
         vs.find(v => /^zh/i.test(v.lang)) ||
         vs.find(v => /Chinese|中文|普通话|國語/i.test(v.name)) || null;
}

if ('speechSynthesis' in window) {
  const init = () => { zhVoice = pickVoice(); voicesReady = true; };
  init();
  speechSynthesis.onvoiceschanged = init;
}

export function speak(text, { interrupt = true } = {}) {
  if (!('speechSynthesis' in window)) return;
  try {
    if (interrupt) speechSynthesis.cancel();
    if (!voicesReady) zhVoice = pickVoice();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (zhVoice) u.voice = zhVoice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch (e) { /* 无语音环境时静默降级为文字提示 */ }
}

export function stopSpeak() {
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) { /* noop */ }
}

const TYPE_LABEL = { ORDER: '顺序颠倒', DIRECTION: '方向错误', MISSING: '漏笔', EXTRA: '多笔' };

// 渲染结构化错误记录列表（含每条记录的标准参考信息）
export function renderMessages(container, records, extra) {
  container.innerHTML = '';
  const add = html => {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = html;
    container.appendChild(div);
    return div;
  };
  if (!records.length) {
    const d = add(extra || '选择汉字后，在田字格中按笔顺书写。');
    d.classList.add('msg-info');
    return;
  }
  let ok = 0;
  for (const rec of records) {
    if (rec.type === 'OK') { ok = 1; continue; }
    if (rec.type === 'INFO') { const d = add(rec.detail); d.classList.add('msg-info'); continue; }
    const stdRef = rec.stdStrokeIndex != null
      ? `<span class="std-ref">（对应标准第${rec.stdStrokeIndex + 1}笔${rec.stdStrokeName ? '「' + rec.stdStrokeName + '」' : ''}）</span>`
      : '';
    add(`<span class="tag">${TYPE_LABEL[rec.type] || rec.type}</span>${rec.detail} ${stdRef}`).classList.add('msg-err');
  }
  if (ok) add('✔ 笔顺正确！书写规范，继续保持。').classList.add('msg-ok');
}

// 在书写画布上高亮标注错误笔画、漏笔位置提示
export function drawErrorHighlights(ctx, userStrokes, entry, records) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const rec of records) {
    if (rec.type === 'OK' || rec.type === 'INFO') continue;
    if (rec.type === 'MISSING' && entry && rec.stdStrokeIndex != null) {
      // 漏笔：在标准位置画红色虚线轮廓提示
      const p = new Path2D(entry.strokes[rec.stdStrokeIndex]);
      ctx.save();
      ctx.translate(0, 0);
      ctx.fillStyle = 'rgba(229,57,53,.18)';
      ctx.fill(p);
      ctx.strokeStyle = 'rgba(229,57,53,.8)';
      ctx.lineWidth = 6;
      ctx.setLineDash([18, 12]);
      ctx.stroke(p);
      ctx.restore();
      continue;
    }
    const us = userStrokes[rec.userStrokeIndex];
    if (!us) continue;
    // 错误笔画：红色加粗描红 + 起笔处圆形序号标注
    ctx.save();
    ctx.strokeStyle = 'rgba(229,57,53,.28)';
    ctx.lineWidth = 34;
    ctx.beginPath();
    const pts = us.ptsRes;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    const st = us.start;
    ctx.fillStyle = '#e53935';
    ctx.beginPath();
    ctx.arc(st[0], st[1], 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(rec.userStrokeIndex + 1), st[0], st[1] + 2);
    ctx.restore();
  }
}

// 正确笔画的绿色小勾标注（校验通过时）
export function drawOkMarks(ctx, userStrokes, records) {
  const errSet = new Set();
  for (const r of records) if (r.userStrokeIndex != null) errSet.add(r.userStrokeIndex);
  ctx.save();
  for (let i = 0; i < userStrokes.length; i++) {
    if (errSet.has(i)) continue;
    const st = userStrokes[i].start;
    ctx.strokeStyle = '#2e7d32';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(st[0], st[1], 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(st[0] - 12, st[1]);
    ctx.lineTo(st[0] - 2, st[1] + 11);
    ctx.lineTo(st[0] + 14, st[1] - 12);
    ctx.stroke();
  }
  ctx.restore();
}
