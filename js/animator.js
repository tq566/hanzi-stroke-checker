// animator.js — 标准笔顺动态演示
// 采用 HanziWriter 风格的遮罩揭示动画：沿中轴线生成粗描边蒙版，
// 通过 stroke-dashoffset 从落笔处逐笔"生长"，完整还原标准笔顺。
// 支持播放/暂停、逐笔模式、上一笔/下一笔、重播。

import { pathLength, strokeName } from './geometry.js';
import { speak } from './feedback.js';

const INK = '#263238';
const GHOST = '#eceff1';

function medianPath(pts) {
  return 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L ');
}

export class Animator {
  constructor(stage, caption, progressFill, title) {
    this.stage = stage;
    this.caption = caption;
    this.fill = progressFill;
    this.title = title;
    this.entry = null;
    this.idx = -1;          // 当前正在演示的笔画（0-based），-1 = 未开始
    this.progress = 0;      // 当前笔画进度 0..1
    this.playing = false;
    this.stepMode = false;
    this._raf = null;
    this._last = 0;
    this.voiceOn = true;
  }

  open(entry) {
    this.entry = entry;
    this.title.textContent = `「${entry.ch}」标准笔顺演示 · 共${entry.n}笔`;
    this._build();
    this.reset();
    this.play();
  }

  _build() {
    const e = this.entry;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 1024 1024');
    svg.id = 'anim-svg';
    // 田字格背景
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML = `
      <mask id="anim-reveal"><rect x="0" y="0" width="1024" height="1024" fill="black"/></mask>`;
    // 占位，动态笔画元素在下面重建
    this.stage.innerHTML = '';
    this.stage.appendChild(svg);
    svg.appendChild(defs);

    this.ghostEls = [];
    this.maskPaths = [];
    this.fillEls = [];

    for (let i = 0; i < e.n; i++) {
      const ghost = document.createElementNS(svgNS, 'path');
      ghost.setAttribute('d', e.strokes[i]);
      ghost.setAttribute('fill', GHOST);
      ghost.setAttribute('stroke', '#d9dee3');
      ghost.setAttribute('stroke-width', '2');
      svg.appendChild(ghost);
      this.ghostEls.push(ghost);

      const fill = document.createElementNS(svgNS, 'path');
      fill.setAttribute('d', e.strokes[i]);
      fill.setAttribute('fill', INK);
      fill.setAttribute('opacity', '0');
      svg.appendChild(fill);
      this.fillEls.push(fill);

      const maskPath = document.createElementNS(svgNS, 'path');
      maskPath.setAttribute('d', medianPath(e.medians[i]));
      maskPath.setAttribute('stroke', 'white');
      maskPath.setAttribute('stroke-width', '220');
      maskPath.setAttribute('fill', 'none');
      maskPath.setAttribute('stroke-linecap', 'round');
      maskPath.setAttribute('stroke-linejoin', 'round');
      maskPath.setAttribute('opacity', '0');
      // 独立遮罩：每个笔画自己的揭示蒙版
      const mask = document.createElementNS(svgNS, 'mask');
      mask.setAttribute('id', 'anim-mask-' + i);
      const black = document.createElementNS(svgNS, 'rect');
      black.setAttribute('width', '1024'); black.setAttribute('height', '1024');
      black.setAttribute('fill', 'black');
      mask.appendChild(black);
      mask.appendChild(maskPath);
      defs.appendChild(mask);
      fill.setAttribute('mask', `url(#anim-mask-${i})`);
      this.maskPaths.push(maskPath);

      const L = pathLength(e.medians[i]);
      maskPath.setAttribute('stroke-dasharray', L);
      maskPath.setAttribute('stroke-dashoffset', L);
      maskPath.dataset.len = L;
    }
  }

  _duration(i) {
    return Math.max(260, pathLength(this.entry.medians[i]) * 0.85);
  }

  reset() {
    this.idx = -1;
    this.progress = 0;
    this.playing = false;
    for (let i = 0; i < this.entry.n; i++) this._show(i, 0);
    this._updateCaption('点击播放，查看标准笔顺');
    this._updateProgress();
    this._cancelRaf();
  }

  play() {
    if (this.idx >= this.entry.n - 1 && this.progress >= 1) this.reset();
    if (this.idx < 0) { this.idx = 0; this.progress = 0; this._announce(0); }
    this.playing = true;
    this._last = performance.now();
    this._cancelRaf();
    this._raf = requestAnimationFrame(t => this._tick(t));
  }

  pause() {
    this.playing = false;
    this._cancelRaf();
    this._updateCaption(this.stepMode && this.idx >= 0 ? this._strokeCaption(this.idx) : '已暂停');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  // 逐笔模式：直接完整画出下一笔并暂停
  next() {
    this.playing = false;
    this._cancelRaf();
    if (this.idx < 0) { this.idx = 0; this._announce(0); }
    else if (this.progress < 1) { this.progress = 1; }
    else {
      this.idx++;
      if (this.idx >= this.entry.n) { this.reset(); return; }
      this._announce(this.idx);
    }
    this.progress = 1;
    this._render();
    this._updateCaption(this._strokeCaption(this.idx));
  }

  prev() {
    this.playing = false;
    this._cancelRaf();
    if (this.idx <= 0) { this.reset(); return; }
    // 当前笔画只画了一半 → 先回到该笔起点；否则回退一笔
    if (this.progress < 1) { this.progress = 0; }
    else { this.idx--; }
    this._render();
    this._updateCaption(this._strokeCaption(Math.max(this.idx, 0)));
  }

  setStepMode(on) { this.stepMode = on; }

  _announce(i) {
    if (!this.voiceOn) return;
    speak(`第${i + 1}笔，${strokeName(this.entry.medRes[i])}`, { interrupt: false });
  }

  _strokeCaption(i) {
    return `第${i + 1}笔 / 共${this.entry.n}笔 · ${strokeName(this.entry.medRes[i])}（${this.progress >= 1 ? '已完成' : '书写中'}）`;
  }

  _updateCaption(txt) { this.caption.textContent = txt; }

  _updateProgress() {
    const n = this.entry.n;
    const p = this.idx < 0 ? 0 : (this.idx + this.progress) / n;
    this.fill.style.width = (p * 100).toFixed(1) + '%';
  }

  _tick(t) {
    if (!this.playing) return;
    const dt = t - this._last;
    this._last = t;
    this.progress += dt / this._duration(this.idx);
    if (this.progress >= 1) {
      this.progress = 1;
      this._render();
      if (this.stepMode) {
        this.playing = false;
        this._updateCaption(this._strokeCaption(this.idx));
        this._updateProgress();
        return;
      }
      this.idx++;
      if (this.idx >= this.entry.n) {
        this.playing = false;
        this._updateCaption(`演示完成 ✅ 「${this.entry.ch}」共${this.entry.n}笔`);
        this._updateProgress();
        return;
      }
      this.progress = 0;
      this._announce(this.idx);
    }
    this._render();
    this._updateProgress();
    if (!this.stepMode || this.progress < 1) {
      this._updateCaption(this._strokeCaption(this.idx));
    }
    this._raf = requestAnimationFrame(tt => this._tick(tt));
  }

  _show(i, p) {
    const mp = this.maskPaths[i];
    const L = parseFloat(mp.dataset.len);
    mp.setAttribute('opacity', p > 0 ? '1' : '0');
    mp.setAttribute('stroke-dashoffset', (L * (1 - p)).toFixed(1));
    this.fillEls[i].setAttribute('opacity', p > 0 ? '1' : '0');
    this.ghostEls[i].setAttribute('fill', GHOST);
  }

  _render() {
    for (let i = 0; i < this.entry.n; i++) {
      if (i < this.idx) this._show(i, 1);
      else if (i === this.idx) this._show(i, this.progress);
      else this._show(i, 0);
    }
    // 当前笔画的底字高亮
    for (let i = 0; i < this.entry.n; i++) {
      this.ghostEls[i].setAttribute('stroke', i === this.idx ? '#90a4ae' : '#d9dee3');
      this.ghostEls[i].setAttribute('stroke-width', i === this.idx ? '6' : '2');
    }
  }

  _cancelRaf() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  close() {
    this.playing = false;
    this._cancelRaf();
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* noop */ }
  }
}
