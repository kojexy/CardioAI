// Derived measurements from device values. Pure functions, no DOM.

export function mean(xs) { return xs.reduce((s, v) => s + v, 0) / xs.length; }
export function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}
const r0 = v => Math.round(v);
const r2 = v => Math.round(v * 100) / 100;

// Build the flat measurement set we store and compare. Input: device fields
// (from ECG301 or manual entry). Missing values stay undefined.
export function deriveMeasurements(device) {
  const m = {};
  for (const key of ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTc_ms', 'P_axis', 'QRS_axis', 'T_axis', 'RV5_mV', 'SV1_mV'])
    if (Number.isFinite(device[key])) m[key] = device[key];
  const rr = Array.isArray(device.RR_ms) ? device.RR_ms.filter(Number.isFinite) : [];
  let rrMean = rr.length ? mean(rr) : (Number.isFinite(m.heart_rate_bpm) && m.heart_rate_bpm > 0 ? 60000 / m.heart_rate_bpm : NaN);
  if (rr.length >= 3) {
    m.RR_mean_ms = r0(rrMean);
    m.RR_sd_ms = r0(sd(rr));
    // Simple irregularity index; a hint only, not rhythm classification.
    m.RR_cv_pct = r2(100 * sd(rr) / rrMean);
  }
  if (Number.isFinite(m.QT_ms) && Number.isFinite(rrMean) && rrMean > 0) {
    const rrSec = rrMean / 1000;
    m.QTcB_ms = r0(m.QT_ms / Math.sqrt(rrSec));
    m.QTcF_ms = r0(m.QT_ms / Math.cbrt(rrSec));
  }
  // The device stores S depth as a negative float; keep magnitudes.
  if (Number.isFinite(m.SV1_mV)) m.SV1_mV = Math.abs(m.SV1_mV);
  if (Number.isFinite(m.RV5_mV) && Number.isFinite(m.SV1_mV))
    m.sokolow_mV = r2(Math.abs(m.RV5_mV) + m.SV1_mV);
  if (Number.isFinite(m.QRS_axis) && Number.isFinite(m.T_axis))
    m.QRS_T_angle_deg = Math.abs(axisDelta(m.QRS_axis, m.T_axis));
  return m;
}

export function ageAt(birthDate, when) {
  if (!birthDate) return null;
  const b = new Date(birthDate), w = when ? new Date(when) : new Date();
  if (isNaN(b) || isNaN(w)) return null;
  let age = w.getFullYear() - b.getFullYear();
  if (w.getMonth() < b.getMonth() || (w.getMonth() === b.getMonth() && w.getDate() < b.getDate())) age--;
  return age;
}

// Circular difference of two axes in degrees, signed, in (-180, 180].
export function axisDelta(a, b) {
  let d = ((b - a) % 360 + 360) % 360;
  return d > 180 ? d - 360 : d;
}
