// Beat detection, median (representative) beats and waveform comparison.
// Works on raw 12-lead arrays. Calibration is passed in explicitly; for ECG301
// it is an unverified estimate, so absolute mV values are approximate. Two
// records from the same device share that error, so relative comparison
// (shape, correlation, ratio) is still meaningful.

import { LEADS } from './ecg301.js';

function median(xs) {
  const s = Float64Array.from(xs).sort();
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
}

function movingAverage(x, w) {
  const out = new Float64Array(x.length), half = Math.max(1, w >> 1);
  let sum = 0, count = 0, lo = 0, hi = -1;
  for (let i = 0; i < x.length; i++) {
    while (hi < Math.min(x.length - 1, i + half)) { sum += x[++hi]; count++; }
    while (lo < i - half) { sum -= x[lo++]; count--; }
    out[i] = sum / count;
  }
  return out;
}

export function toMillivolts(leads, { microvoltsPerCount, zeroCounts }) {
  return leads.map(lead => {
    const mv = lead.map(v => (v - zeroCounts) * microvoltsPerCount / 1000);
    const base = median(mv);
    return mv.map(v => v - base);
  });
}

// Returns sample indices of QRS complexes using multi-lead slope energy.
export function detectBeats(leads, fs) {
  const n = leads[0].length;
  const energy = new Float64Array(n);
  for (const lead of leads)
    for (let i = 1; i < n - 1; i++) energy[i] += Math.abs(lead[i + 1] - lead[i - 1]);
  const smooth = movingAverage(energy, Math.round(0.08 * fs));
  const sorted = Float64Array.from(smooth).sort();
  const level = sorted[Math.floor(0.98 * (n - 1))];
  const threshold = 0.45 * level;
  const refractory = Math.round(0.3 * fs);
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (smooth[i] < threshold || smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < refractory) {
      if (smooth[i] > smooth[last]) peaks[peaks.length - 1] = i;
    } else peaks.push(i);
  }
  return peaks;
}

// Median beat per lead, window [-pre, +post] seconds around each detected QRS.
export function medianBeats(leads, fs, { pre = 0.25, post = 0.45 } = {}) {
  const n = leads[0].length;
  // Move each slope-energy peak to the dominant deflection (sum of |amplitude| over leads):
  // with a wide QRS the energy peak falls on the upstroke, not on R.
  const reach = Math.round(0.08 * fs);
  const peaks = detectBeats(leads, fs).map(p => {
    let best = p, bestValue = -1;
    for (let i = Math.max(0, p - reach); i <= Math.min(n - 1, p + reach); i++) {
      let s = 0;
      for (const lead of leads) s += Math.abs(lead[i]);
      if (s > bestValue) { bestValue = s; best = i; }
    }
    return best;
  });
  const a = Math.round(pre * fs), b = Math.round(post * fs);
  const usable = peaks.filter(p => p - a >= 0 && p + b < n);
  if (!usable.length) return { beats: 0, peaks, template: null, fs };
  // Isoelectric reference per beat: the flattest 20 ms window 200…40 ms before R (PR segment).
  const w = Math.max(2, Math.round(0.02 * fs)), from = a - Math.round(0.2 * fs), to = a - Math.round(0.04 * fs) - w;
  const isoStart = usable.map(p => {
    let best = Math.max(0, from), bestFlat = Infinity;
    for (let s = Math.max(0, from); s <= to; s++) {
      let flat = 0;
      for (const lead of leads) for (let i = s; i < s + w; i++) flat += Math.abs(lead[p - a + i + 1] - lead[p - a + i]);
      if (flat < bestFlat) { bestFlat = flat; best = s; }
    }
    return best;
  });
  const template = leads.map(lead => {
    const segments = usable.map((p, k) => {
      const seg = lead.slice(p - a, p + b + 1);
      const ref = median(seg.slice(isoStart[k], isoStart[k] + w));
      return seg.map(v => v - ref);
    });
    return Array.from({ length: a + b + 1 }, (_, i) => median(segments.map(s => s[i])));
  });
  return { beats: usable.length, peaks, template, fs, preSamples: a };
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let s = 0, xx = 0, yy = 0;
  for (let i = 0; i < n; i++) { const u = x[i] - mx, v = y[i] - my; s += u * v; xx += u * u; yy += v * v; }
  return xx && yy ? s / Math.sqrt(xx * yy) : 0;
}

function shifted(t, lag) {
  // positive lag: t is moved later
  return lag >= 0 ? [t.slice(0, t.length - lag), lag] : [t.slice(-lag), 0];
}

// Compare two median-beat sets (same sampling rate). Finds one common lag.
function valueNear(t, i) { return t[Math.max(0, Math.min(t.length - 1, i))]; }
function extremeIn(t, i0, i1) {
  let best = 0;
  for (let i = Math.max(0, i0); i < Math.min(t.length, i1); i++) if (Math.abs(t[i]) > Math.abs(best)) best = t[i];
  return best;
}

// Baseline sway per lead in mV/s (slow drift), for the quality gate.
export function baselineSway(leadsMv, fs) {
  return leadsMv.map(lead => {
    const slow = movingAverage(lead, Math.round(fs));
    return (Math.max(...slow) - Math.min(...slow)) / (lead.length / fs);
  });
}

// pre: samples before R in the templates; stPointSec: R → ST measurement point (≈ J + 60 ms).
export function compareTemplates(t1, t2, fs, maxLagSec = 0.04, { pre = 0, stPointSec = 0.12 } = {}) {
  const maxLag = Math.round(maxLagSec * fs);
  const len = Math.min(t1[0].length, t2[0].length);
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let j = 0; j < 12; j++) {
      const [x, off] = shifted(t2[j].slice(0, len), lag);
      score += pearson(t1[j].slice(off, off + x.length), x);
    }
    if (score > best.score) best = { lag, score };
  }
  const leads = LEADS.map((name, j) => {
    const [y, off] = shifted(t2[j].slice(0, len), best.lag);
    const x = t1[j].slice(off, off + y.length);
    let sq = 0, maxAbs = 0;
    for (let i = 0; i < x.length; i++) { const d = y[i] - x[i]; sq += d * d; maxAbs = Math.max(maxAbs, Math.abs(d)); }
    const ptp = a => Math.max(...a) - Math.min(...a);
    const p1 = ptp(x), p2 = ptp(y);
    const st = pre - off + Math.round(stPointSec * fs);
    const tStart = pre - off + Math.round(0.2 * fs), tEnd = pre - off + Math.round(0.45 * fs);
    return {
      stDiff_mV: round(valueNear(y, st) - valueNear(x, st), 3),
      tDiff_mV: round(extremeIn(y, tStart, tEnd) - extremeIn(x, tStart, tEnd), 3),
      ptpDiff_mV: round(p2 - p1, 3),
      lead: name,
      correlation: round(pearson(x, y), 3),
      rmsDiff_mV: round(Math.sqrt(sq / x.length), 3),
      maxDiff_mV: round(maxAbs, 3),
      amplitudeRatio: p1 > 0 ? round(p2 / p1, 2) : null,
    };
  });
  const cs = leads.map(l => l.correlation);
  return {
    lagMs: Math.round(1000 * best.lag / fs),
    meanCorrelation: round(cs.reduce((s, v) => s + v, 0) / cs.length, 3),
    minCorrelation: Math.min(...cs),
    leads,
  };
}

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }
