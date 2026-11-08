export function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function fit(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function drawLine(canvas, { points = [], marks = [], emptyLabel = "Waiting for the first trade" } = {}) {
  const { ctx, w, h } = fit(canvas);
  const pad = 16;
  if (!points.length) {
    ctx.strokeStyle = "rgba(235,235,245,0.3)";
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(pad, h / 2);
    ctx.lineTo(w - pad, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(235,235,245,0.6)";
    ctx.font = "14px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(emptyLabel, w / 2, h / 2 - 14);
    return;
  }
  const xs = points.map((p) => new Date(p.ts).getTime());
  const ys = points.map((p) => Number(p.value));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const xOf = (t) => pad + ((t - minX) / spanX) * (w - pad * 2);
  const yOf = (v) => h - pad - ((v - minY) / spanY) * (h - pad * 2);
  const up = ys[ys.length - 1] >= ys[0];
  ctx.strokeStyle = up ? "#00d35a" : "#ff453a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xOf(new Date(p.ts).getTime());
    const y = yOf(Number(p.value));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  marks.forEach((m) => {
    const t = new Date(m.ts).getTime();
    if (t < minX || t > maxX) return;
    const nearest = points.reduce((a, p) =>
      Math.abs(new Date(p.ts) - t) < Math.abs(new Date(a.ts) - t) ? p : a
    );
    const x = xOf(t);
    const y = yOf(Number(nearest.value));
    ctx.fillStyle = m.kind === "bought" ? "#00d35a" : m.kind === "rejected" ? "rgba(235,235,245,0.45)" : "#ff453a";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    if (m.label) {
      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(m.label), x, y - 6);
    }
  });
}

export function drawCandles(canvas, { candles = [], exitLines = {} } = {}) {
  const { ctx, w, h } = fit(canvas);
  if (!candles.length) {
    ctx.fillStyle = "rgba(235,235,245,0.6)";
    ctx.font = "14px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No candles yet", w / 2, h / 2);
    return;
  }
  const volH = Math.round(h * 0.22);
  const top = 8;
  const bottom = h - volH - 8;
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const minY = Math.min(...lows, exitLines.stop ?? Infinity, exitLines.trail ?? Infinity);
  const maxY = Math.max(...highs, exitLines.stop ?? -Infinity, exitLines.trail ?? -Infinity);
  const spanY = (maxY - minY) || 1;
  const yOf = (v) => bottom - ((v - minY) / spanY) * (bottom - top);
  const slot = (w - 16) / candles.length;
  const cw = Math.max(2, slot * 0.62);
  candles.forEach((c, i) => {
    const x = 8 + i * slot + slot / 2;
    const o = Number(c.open);
    const cl = Number(c.close);
    const up = cl >= o;
    ctx.strokeStyle = ctx.fillStyle = up ? "#00d35a" : "#ff453a";
    ctx.beginPath();
    ctx.moveTo(x, yOf(Number(c.high)));
    ctx.lineTo(x, yOf(Number(c.low)));
    ctx.stroke();
    const y1 = yOf(Math.max(o, cl));
    const y2 = yOf(Math.min(o, cl));
    ctx.fillRect(x - cw / 2, y1, cw, Math.max(1, y2 - y1));
  });
  const vols = candles.map((c) => Math.abs(Number(c.volume) || 0));
  const maxV = Math.max(1, ...vols);
  candles.forEach((c, i) => {
    const x = 8 + i * slot + slot / 2;
    const vh = (vols[i] / maxV) * (volH - 6);
    ctx.fillStyle = "rgba(235,235,245,0.3)";
    ctx.fillRect(x - cw / 2, h - 4 - vh, cw, vh);
  });
  const drawExit = (price, dashed, label) => {
    if (price == null) return;
    const y = yOf(Number(price));
    ctx.strokeStyle = "#ff9f0a";
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dashed ? [6, 5] : []);
    ctx.beginPath();
    ctx.moveTo(8, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = "#ff9f0a";
      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(label), 10, y - 2);
    }
  };
  if (exitLines.trail != null) drawExit(exitLines.trail, true, exitLines.trailLabel || "");
  else if (exitLines.stop != null) drawExit(exitLines.stop, true, exitLines.stopLabel || "");
}

export function drawScoreRing(canvas, score) {
  const { ctx, w, h } = fit(canvas);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 8;
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(235,235,245,0.3)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  ctx.strokeStyle = n >= 70 ? "#00d35a" : n >= 50 ? "#ff9f0a" : "#ff453a";
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * n) / 100);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "700 28px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(Math.round(n)), cx, cy);
}
