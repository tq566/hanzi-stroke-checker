// capture.js — 触屏 / 手写笔轨迹采集
// 基于 Pointer Events，使用 getCoalescedEvents 获取高频合并事件，
// 保证常规书写速度下的完整轨迹捕捉（不受渲染帧率限制）

export class TouchCapture {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers; // { onStrokeStart, onStrokeAdd(x,y,t), onStrokeEnd(points) }
    this.drawing = false;
    this.pointerId = null;
    this.points = [];
    this._bind();
  }

  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) / r.width * 1024,
      (e.clientY - r.top) / r.height * 1024
    ];
  }

  _bind() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', e => {
      if (this.drawing) return; // 忽略多点触控的第二根手指
      e.preventDefault();
      this.drawing = true;
      this.pointerId = e.pointerId;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = this.toLocal(e);
      this.points = [[x, y, performance.now()]];
      this.h.onStrokeStart();
    });

    cv.addEventListener('pointermove', e => {
      if (!this.drawing || e.pointerId !== this.pointerId) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const last = this.points[this.points.length - 1];
      for (const ev of evs) {
        const [x, y] = this.toLocal(ev);
        const dx = x - last[0], dy = y - last[1];
        if (dx * dx + dy * dy < 2.25) continue; // 去除 1.5px 内的重复点
        this.points.push([x, y, performance.now()]);
      }
      if (this.points[this.points.length - 1] !== last) {
        this.h.onStrokeAdd(...this.points[this.points.length - 1]);
      }
    });

    const finish = e => {
      if (!this.drawing || e.pointerId !== this.pointerId) return;
      e.preventDefault();
      this.drawing = false;
      this.pointerId = null;
      this.h.onStrokeEnd(this.points);
      this.points = [];
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', finish);
  }
}
