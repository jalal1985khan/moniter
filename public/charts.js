// Small SVG charts for the dashboard: a step/line chart with reference lines and a crosshair,
// and bar charts (diverging around zero, or per category with an "expected" tick).
// No libraries, so the dashboard works offline. Colors come from CSS variables.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };

  // One floating tooltip for every chart. Text goes in with textContent only.
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));
  function showTip(evt, lines) {
    tip.replaceChildren(...lines.map(([value, label]) => {
      const row = document.createElement('div');
      const b = document.createElement('b'); b.textContent = value;
      const s = document.createElement('span'); s.textContent = label ? ' ' + label : '';
      row.append(b, s); return row;
    }));
    tip.hidden = false;
    const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY - h - pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y < 8) y = evt.clientY + pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  function empty(host, text) {
    const d = document.createElement('div');
    d.className = 'viz-empty'; d.textContent = text;
    host.replaceChildren(d);
  }

  // A bar with a 4px rounded data end; the baseline end stays square.
  function barPath(x, w, y0, y1, r = 4) {
    const up = y1 < y0, h = Math.abs(y1 - y0);
    r = Math.min(r, w / 2, h);
    if (h < 0.5) return '';
    if (up) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
    return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
  }

  // points: [{x, y}], step: draw as steps (a balance holds until it changes).
  // refs: [{y, label, cls}] dashed reference lines. tipFor(i) -> [[value, label], ...].
  function line(host, {points, step = false, refs = [], yFmt = String, xFmt = String, tipFor, height = 180, yMin, yMax, color = 'var(--series-1)', emptyText = 'No data yet.', includeZero = false}) {
    if (!points || points.length < 2) return empty(host, emptyText);
    const W = Math.max(240, host.clientWidth || 600), H = height;
    const m = {l: 54, r: 10, t: 10, b: 22};
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    let lo = Math.min(...ys, ...refs.map(r => r.y)), hi = Math.max(...ys, ...refs.map(r => r.y));
    if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (yMin != null) lo = yMin; if (yMax != null) hi = Math.max(yMax, hi);
    const ticks = niceTicks(lo, hi);
    const y0 = ticks[0], y1 = ticks.at(-1);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const X = v => m.l + (x1 === x0 ? 0 : (v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = v => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    const svg = el('svg', {viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz', role: 'img'});
    for (const t of ticks) {
      el('line', {x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? 'viz-base' : 'viz-grid'}, svg);
      el('text', {x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'viz-axis'}, svg).textContent = yFmt(t);
    }
    el('text', {x: m.l, y: H - 6, class: 'viz-axis'}, svg).textContent = xFmt(x0);
    el('text', {x: W - m.r, y: H - 6, 'text-anchor': 'end', class: 'viz-axis'}, svg).textContent = xFmt(x1);
    for (const r of refs) {
      el('line', {x1: m.l, x2: W - m.r, y1: Y(r.y), y2: Y(r.y), class: 'viz-ref ' + (r.cls || '')}, svg);
      el('text', {x: W - m.r - 4, y: Y(r.y) - 4, 'text-anchor': 'end', class: 'viz-reflbl'}, svg).textContent = r.label;
    }
    let d = `M${X(points[0].x)},${Y(points[0].y)}`;
    for (let i = 1; i < points.length; i++) {
      d += step ? `H${X(points[i].x)}V${Y(points[i].y)}` : `L${X(points[i].x)},${Y(points[i].y)}`;
    }
    el('path', {d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round'}, svg);
    const last = points.at(-1);
    el('circle', {cx: X(last.x), cy: Y(last.y), r: 4, fill: color, class: 'viz-ring'}, svg);
    // Crosshair: snaps to the nearest point; the whole plot is the hit target.
    const cross = el('line', {y1: m.t, y2: H - m.b, class: 'viz-cross', visibility: 'hidden'}, svg);
    const dot = el('circle', {r: 4, fill: color, class: 'viz-ring', visibility: 'hidden'}, svg);
    const hit = el('rect', {x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent'}, svg);
    hit.addEventListener('pointermove', e => {
      const box = svg.getBoundingClientRect();
      const px = (e.clientX - box.left) * (W / box.width);
      let best = 0, bd = Infinity;
      points.forEach((p, i) => { const dd = Math.abs(X(p.x) - px); if (dd < bd) { bd = dd; best = i; } });
      const p = points[best];
      cross.setAttribute('x1', X(p.x)); cross.setAttribute('x2', X(p.x)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', X(p.x)); dot.setAttribute('cy', Y(p.y)); dot.setAttribute('visibility', 'visible');
      showTip(e, tipFor ? tipFor(best) : [[yFmt(p.y), xFmt(p.x)]]);
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
    host.replaceChildren(svg);
  }

  // bars: [{value, label, color?, expected?, tip: [[v, l], ...]}]. Diverging when values go below 0
  // (positive = var(--win), negative = var(--loss)); otherwise each bar uses its own color.
  function bars(host, {bars: data, yFmt = String, height = 180, emptyText = 'No data yet.', showLabels = false, yMax}) {
    if (!data || !data.length) return empty(host, emptyText);
    const W = Math.max(240, host.clientWidth || 600), H = height;
    const m = {l: 54, r: 10, t: 10, b: showLabels ? 26 : 10};
    const vals = data.flatMap(b => [b.value, b.expected ?? b.value]);
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals, yMax ?? 0));
    const y0 = ticks[0], y1 = ticks.at(-1);
    const Y = v => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    const svg = el('svg', {viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz', role: 'img'});
    for (const t of ticks) {
      el('line', {x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? 'viz-base' : 'viz-grid'}, svg);
      el('text', {x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', class: 'viz-axis'}, svg).textContent = yFmt(t);
    }
    const band = (W - m.l - m.r) / data.length, gap = 2;
    const w = Math.max(1, Math.min(band - gap, showLabels ? 56 : 24));
    data.forEach((b, i) => {
      const x = m.l + i * band + (band - w) / 2;
      const color = b.color || (b.value >= 0 ? 'var(--win)' : 'var(--loss)');
      const path = el('path', {d: barPath(x, w, Y(0), Y(b.value)), fill: color, class: 'viz-bar'}, svg);
      if (b.expected != null) {
        el('line', {x1: x - 4, x2: x + w + 4, y1: Y(b.expected), y2: Y(b.expected), class: 'viz-expect'}, svg);
      }
      if (showLabels) el('text', {x: x + w / 2, y: H - 8, 'text-anchor': 'middle', class: 'viz-axis'}, svg).textContent = b.label;
      // Hit target: the full band height, wider than the bar.
      const hit = el('rect', {x: m.l + i * band, y: m.t, width: band, height: H - m.t - m.b, fill: 'transparent'}, svg);
      hit.addEventListener('pointermove', e => { path.classList.add('on'); showTip(e, b.tip || [[yFmt(b.value), b.label]]); });
      hit.addEventListener('pointerleave', () => { path.classList.remove('on'); hideTip(); });
    });
    host.replaceChildren(svg);
  }

  window.Viz = {line, bars};
})();
