// Small SVG charts: parameter trends and median-beat overlays. No libraries.
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const shortDate = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
};

// points: [{t, v}], range: [lo, hi] normal band or undefined
export function trendChart(points, { label, unit, range } = {}) {
  const W = 320, H = 150, L = 44, R = 12, T = 22, B = 26;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${label}: динамика` });
  svg.append(el('text', { x: L, y: 14, class: 'chart-title' }, `${label}${unit ? ', ' + unit : ''}`));
  if (!points.length) return svg;
  const vs = points.map(p => p.v).concat(range ? range.filter(Number.isFinite) : []);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const ts = points.map(p => new Date(p.t).getTime());
  let t0 = Math.min(...ts), t1 = Math.max(...ts);
  if (t0 === t1) { t0 -= 86400000; t1 += 86400000; }
  const x = t => L + (W - L - R) * (t - t0) / (t1 - t0);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  if (range) {
    const top = y(Math.min(range[1], hi)), bottom = y(Math.max(range[0], lo));
    if (bottom > top) svg.append(el('rect', { x: L, y: top, width: W - L - R, height: bottom - top, class: 'chart-band' }));
  }
  for (const v of [lo + pad, hi - pad]) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }));
    svg.append(el('text', { x: L - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, String(Math.round(v * 10) / 10)));
  }
  svg.append(el('polyline', { points: points.map((p, i) => `${x(ts[i])},${y(p.v)}`).join(' '), class: 'chart-line' }));
  points.forEach((p, i) => {
    const dot = el('circle', { cx: x(ts[i]), cy: y(p.v), r: 4, class: 'chart-dot' });
    dot.append(el('title', {}, `${shortDate(p.t)}: ${p.v}${unit ? ' ' + unit : ''}`));
    svg.append(dot);
  });
  const first = points[0], last = points[points.length - 1];
  svg.append(el('text', { x: L, y: H - 8, class: 'chart-axis' }, shortDate(first.t)));
  if (points.length > 1) svg.append(el('text', { x: W - R, y: H - 8, class: 'chart-axis', 'text-anchor': 'end' }, shortDate(last.t)));
  return svg;
}

// 12 small panels with two median beats overlaid (older vs newer).
export function beatOverlay(waveform, leadNames) {
  const cols = 4, cw = 170, ch = 120, W = cols * cw, H = 3 * ch + 24;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'overlay', role: 'img', 'aria-label': 'Наложение средних комплексов' });
  const { templateA: a, templateB: b, lagMs, fs } = waveform;
  const lag = Math.round(lagMs * fs / 1000);
  let max = 0.2;
  for (const t of [a, b]) for (const lead of t) for (const v of lead) max = Math.max(max, Math.abs(v));
  leadNames.forEach((name, j) => {
    const ox = (j % cols) * cw, oy = Math.floor(j / cols) * ch;
    const info = waveform.leads[j];
    svg.append(el('rect', { x: ox + 2, y: oy + 2, width: cw - 4, height: ch - 4, rx: 6, class: 'overlay-cell ' + (info?.level || '') }));
    svg.append(el('text', { x: ox + 10, y: oy + 18, class: 'overlay-lead' }, name));
    if (info) svg.append(el('text', { x: ox + cw - 10, y: oy + 18, class: 'overlay-corr', 'text-anchor': 'end' }, 'сходство ' + info.correlation.toFixed(2).replace('.', ',')));
    const mid = oy + ch / 2 + 8, scale = (ch / 2 - 18) / max;
    svg.append(el('line', { x1: ox + 8, x2: ox + cw - 8, y1: mid, y2: mid, class: 'chart-grid' }));
    const path = (t, shift) => t[j].map((v, i) => `${ox + 8 + (cw - 16) * (i + shift) / (t[j].length - 1)},${mid - v * scale}`).join(' ');
    svg.append(el('polyline', { points: path(a, 0), class: 'beat-a' }));
    svg.append(el('polyline', { points: path(b, -lag), class: 'beat-b' }));
  });
  svg.append(el('text', { x: 8, y: H - 6, class: 'chart-axis' }, 'Синий — раньше, оранжевый — сейчас. Если форма не изменилась, линии сливаются в одну.'));
  return svg;
}

// Raw 12-lead strip (for record view), assumed mV.
export function stripChart(leadsMv, fs, leadNames) {
  const n = leadsMv[0].length, W = 900, rowH = 46, H = 12 * rowH + 20, L = 40;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'strip', role: 'img', 'aria-label': 'Запись 12 отведений' });
  let max = 0.3;
  for (const lead of leadsMv) for (const v of lead) max = Math.max(max, Math.abs(v));
  const scale = (rowH / 2) / Math.min(max, 2);
  leadNames.forEach((name, j) => {
    const mid = 10 + j * rowH + rowH / 2;
    svg.append(el('text', { x: 4, y: mid + 4, class: 'overlay-lead' }, name));
    svg.append(el('polyline', {
      class: 'strip-line',
      points: leadsMv[j].map((v, i) => `${L + (W - L - 8) * i / (n - 1)},${Math.max(mid - rowH / 2, Math.min(mid + rowH / 2, mid - v * scale))}`).join(' '),
    }));
  });
  svg.append(el('text', { x: L, y: H - 4, class: 'chart-axis' }, `${(n / fs).toFixed(1)} с при предполагаемой частоте ${fs} Гц`));
  return svg;
}
