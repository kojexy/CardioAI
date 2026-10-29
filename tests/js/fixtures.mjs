// Synthetic ECG301 files for tests. Not a patient record.
import { LEADS } from '../../app/js/ecg301.js';

function beat(t, fs, rate, { qrsWidth = 0.025, amp = 1, tAmp = 0.25 } = {}) {
  const period = 60 / rate;
  const x = (t / fs) % period - 0.3;
  const g = (c, w, a) => a * Math.exp(-((x - c) ** 2) / (2 * w * w));
  return g(-0.16, 0.02, 0.12) + g(0, qrsWidth, amp) + g(-0.03, 0.01, -0.1 * amp) + g(0.25, 0.04, tAmp);
}

// Returns an ArrayBuffer laid out like the studied ECG301 variant.
export function syntheticECG301({ id = '20260101120000', rate = 75, hr = 75, pr = 160, qrs = 92, qt = 380, qtc = 410,
  axes = [50, 45, 40], rv5 = 1.8, sv1 = 0.9, shape = {}, patient = [] } = {}) {
  const buf = new ArrayBuffer(39381), view = new DataView(buf), bytes = new Uint8Array(buf);
  for (let i = 0; i < 14; i++) bytes[6 + i] = id.charCodeAt(i);
  // Text typed on the device: [field at 22, at 34, at 47], as in app/js/ecg301.js PATIENT_FIELDS.
  patient.forEach((text, k) => bytes.set(new TextEncoder().encode(text), [22, 34, 47][k]));
  const gain = 1.16 / 1000; // mV per count
  const write = (off, n, fs) => {
    // Simple lead model: I and II from the beat, the rest derived so that III = II - I holds.
    for (let i = 0; i < n; i++) {
      const v = beat(i, fs, rate, shape);
      const I = 0.6 * v, II = 1.0 * v, III = II - I;
      const leads = [I, II, III, -(I + II) / 2, I - II / 2, II - I / 2, -0.5 * v, 0.2 * v, 0.6 * v, 0.9 * v, 1.0 * v, 0.8 * v];
      leads.forEach((mv, j) => view.setUint16(off + 2 * (j * n + i), Math.round(2048 + mv / gain), true));
    }
  };
  write(79, 1000, 1000);
  write(24981, 600, 200);
  [hr, pr, qrs, qt, qtc].forEach((v, i) => view.setUint16(24079 + 2 * i, v, true));
  for (let i = 0; i < 11; i++) view.setUint16(24089 + 2 * i, Math.round(60000 / rate), true);
  axes.forEach((v, i) => view.setUint16(24451 + 2 * i, v < 0 ? v + 360 : v, true));
  view.setFloat32(24459, rv5, true);
  view.setFloat32(24463, sv1, true);
  return buf;
}

export { LEADS };
