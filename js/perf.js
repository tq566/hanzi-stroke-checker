// perf.js — 性能监控 HUD：单笔分析耗时 / 摄像头帧耗时 / FPS

export class PerfMonitor {
  constructor(el) {
    this.el = el;
    this.lastAnalysisMs = 0;
    this.rolling = [];       // 最近 20 次分析耗时
    this.camFrameMs = 0;
    this.camFps = 0;
    this._camShown = false;
  }

  reportAnalysis(ms) {
    this.lastAnalysisMs = ms;
    this.rolling.push(ms);
    if (this.rolling.length > 20) this.rolling.shift();
    this.render();
  }

  reportCamera(frameMs, fps, show) {
    this.camFrameMs = frameMs;
    this.camFps = fps;
    this._camShown = show;
    this.render();
  }

  render() {
    const avg = this.rolling.length
      ? this.rolling.reduce((a, b) => a + b, 0) / this.rolling.length
      : 0;
    const analysisOk = this.lastAnalysisMs < 100;
    let txt = `⚡分析 ${this.lastAnalysisMs.toFixed(1)}ms`;
    if (this.rolling.length > 1) txt += ` (均${avg.toFixed(1)}ms)`;
    if (this._camShown) txt += `\n📷帧 ${this.camFrameMs.toFixed(1)}ms · ${this.camFps}fps`;
    txt += analysisOk ? '' : '\n⚠ 超过100ms';
    this.el.textContent = txt;
    this.el.classList.toggle('over', !analysisOk && this.rolling.length > 0);
  }
}
