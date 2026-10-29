// Experimental ECG301 / LE1203 decoder (same layout as outputs/ecg-reader/ecg_reader.py).
// Units are ADC counts. Sampling rate and voltage scale are NOT confirmed by the manufacturer.
export const LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
export const ECG301_SIZE = 39381;
// Photo-based estimates for block B (unverified, see README).
export const ASSUMED = { fsB: 200, fsA: 1000, microvoltsPerCount: 1.16, zeroCounts: 2048 };

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let s = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; s += u * v; aa += u * u; bb += v * v; }
  return aa && bb ? s / Math.sqrt(aa * bb) : 0;
}

// Record id looks like YYYYMMDDhhmmss + 4 digits; returns ISO local time or null.
export function dateFromRecordId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(id || '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// Device stores axes as unsigned 16-bit; map to (-180, 180].
export function signedAxis(v) {
  let a = v > 32767 ? v - 65536 : v;
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

export async function sha256Hex(buffer) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  const hash = await subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// Text typed on the cardiograph before recording (seen in a real file: two name fields).
// Field meaning is not confirmed by the manufacturer, so the text is kept as typed.
export const PATIENT_FIELDS = [[22, 34], [34, 47], [47, 61]];

function decodeField(bytes) {
  const end = bytes.indexOf(0);
  const raw = end < 0 ? bytes : bytes.slice(0, end);
  if (!raw.length) return '';
  for (const enc of ['utf-8', 'gbk']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(); } catch { /* next */ }
  }
  return '';
}

export function devicePatient(bytes) {
  const fields = PATIENT_FIELDS.map(([a, b]) => decodeField(bytes.slice(a, b)));
  return { fields, label: fields.filter(Boolean).join(' ') };
}

export function parseECG301(buffer) {
  if (buffer.byteLength !== ECG301_SIZE)
    throw Error(`Неизвестный вариант файла: ${buffer.byteLength} байт, ожидалось ${ECG301_SIZE}. Файл не изменён.`);
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  const id = String.fromCharCode(...bytes.slice(6, 20));
  if (!/^\d{14}$/.test(id)) throw Error('Не распознан идентификатор записи');
  const read = (off, n) => Array.from({ length: 12 }, (_, j) => {
    const lead = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = view.getUint16(off + 2 * (j * n + i), true);
      if (v > 4095) throw Error('Данные не соответствуют изученному формату');
      lead[i] = v;
    }
    return lead;
  });
  const A = read(79, 1000), B = read(24981, 600);
  const [hr, pr, qrs, qt, qtc] = Array.from({ length: 5 }, (_, i) => view.getUint16(24079 + 2 * i, true));
  const rr = Array.from({ length: 11 }, (_, i) => view.getUint16(24089 + 2 * i, true));
  if (hr < 20 || hr > 300 || qrs < 20 || qrs > 400 || qt < 100 || qt > 800 || rr.some(v => v < 200 || v > 3000))
    throw Error('Поля записи не прошли проверку формата');
  const checks = {};
  for (const [name, x] of Object.entries({ A, B })) {
    checks[name] = corr(x[1].map((v, i) => v - x[0][i]), x[2]);
    if (checks[name] < 0.95) throw Error('Проверка соотношения отведений (III = II − I) не пройдена');
  }
  const axes = Array.from({ length: 3 }, (_, i) => signedAxis(view.getUint16(24451 + 2 * i, true)));
  return {
    recordId: id,
    recordedAt: dateFromRecordId(id),
    patient: devicePatient(bytes),
    blocks: { A, B },
    device: {
      heart_rate_bpm: hr, PR_ms: pr, QRS_ms: qrs, QT_ms: qt, QTc_ms: qtc, RR_ms: rr,
      // Axis order P/QRS/T is the usual printout order; not confirmed by the manufacturer.
      P_axis: axes[0], QRS_axis: axes[1], T_axis: axes[2],
      RV5_mV: round(view.getFloat32(24459, true), 3), SV1_mV: round(view.getFloat32(24463, true), 3),
    },
    checks: { limbIdentity: checks },
  };
}

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }
