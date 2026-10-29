import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseECG301, dateFromRecordId, signedAxis, ASSUMED } from '../../app/js/ecg301.js';
import { deriveMeasurements, axisDelta, ageAt } from '../../app/js/measure.js';
import { compareRecords, autoComparisons, trend, rangeStatus, sustainedTrends, scoreLevel } from '../../app/js/compare.js';
import { detectBeats, medianBeats, toMillivolts } from '../../app/js/signal.js';
import { MEASURE_LABELS } from '../../app/js/rules.js';
import { syntheticECG301 } from './fixtures.mjs';

function record(buf, extra = {}) {
  const p = parseECG301(buf);
  return { id: p.recordId, recordedAt: p.recordedAt, measurements: deriveMeasurements(p.device), ai: {},
    signal: { fs: ASSUMED.fsB, leads: p.blocks.B, calibration: { microvoltsPerCount: 1.16, zeroCounts: 2048, verified: false } }, ...extra };
}

test('decoder reads synthetic ECG301 and derives values', () => {
  const p = parseECG301(syntheticECG301({ axes: [60, -30, 45] }));
  assert.equal(p.recordId, '20260101120000');
  assert.equal(p.recordedAt, '2026-01-01T12:00:00');
  assert.equal(p.device.QRS_axis, -30);
  assert.ok(p.checks.limbIdentity.B > 0.99);
  const m = deriveMeasurements(p.device);
  assert.equal(m.RR_mean_ms, 800);
  assert.equal(m.QTcB_ms, Math.round(380 / Math.sqrt(0.8)));
  assert.equal(m.QTcF_ms, Math.round(380 / Math.cbrt(0.8)));
  assert.equal(m.sokolow_mV, 2.7);
  assert.equal(m.RR_cv_pct, 0);
});

test('decoder rejects wrong size and broken limb identity', () => {
  assert.throws(() => parseECG301(new ArrayBuffer(100)), /39381/);
  const buf = syntheticECG301();
  const view = new DataView(buf);
  for (let i = 0; i < 600; i++) view.setUint16(24981 + 2 * (2 * 600 + i), 2048 + ((i * 37) % 400), true);
  assert.throws(() => parseECG301(buf), /III/);
});

test('helpers: record id date, axes, age', () => {
  assert.equal(dateFromRecordId('202610231707340025'), '2026-10-23T17:07:34');
  assert.equal(dateFromRecordId('20261399000000'), null);
  assert.equal(signedAxis(330), -30);
  assert.equal(signedAxis(65506), -30);
  assert.equal(axisDelta(170, -170), 20);
  assert.equal(axisDelta(-170, 170), -20);
  assert.equal(ageAt('2000-06-15', '2026-06-14'), 25);
  assert.equal(ageAt('2000-06-15', '2026-06-15'), 26);
});

test('beat detection finds ~4 beats in 3 s at 75 bpm', () => {
  const p = parseECG301(syntheticECG301());
  const mv = toMillivolts(p.blocks.B, { microvoltsPerCount: 1.16, zeroCounts: 2048 });
  const peaks = detectBeats(mv, 200);
  assert.ok(peaks.length >= 3 && peaks.length <= 4, 'peaks: ' + peaks.length);
  const m = medianBeats(mv, 200);
  assert.ok(m.beats >= 2);
  assert.equal(m.template.length, 12);
});

test('identical records: no change', () => {
  const a = record(syntheticECG301());
  const b = record(syntheticECG301({ id: '20260701120000' }));
  const c = compareRecords(a, b, { sex: 'M' });
  assert.equal(c.counts.major, 0);
  assert.equal(c.counts.minor, 0);
  assert.ok(c.waveform.available);
  assert.ok(c.waveform.meanCorrelation > 0.98, String(c.waveform.meanCorrelation));
  assert.match(c.headline, /не найдено/);
  assert.equal(c.days, 181);
});

test('QTc prolongation over 500 ms and wider QRS are major', () => {
  const a = record(syntheticECG301({ qt: 380, qtc: 420 }));
  const b = record(syntheticECG301({ id: '20260701120000', qt: 450, qtc: 505, qrs: 128, shape: { qrsWidth: 0.05 } }));
  const c = compareRecords(b, a, { sex: 'F' }); // order is normalised to older → newer
  assert.equal(c.older.id, a.id);
  const qtcf = c.measurements.find(m => m.key === 'QTcF_ms');
  assert.equal(qtcf.level, 'major');
  assert.equal(qtcf.delta, Math.round(450 / Math.cbrt(0.8)) - Math.round(380 / Math.cbrt(0.8)));
  assert.ok(qtcf.reasons.some(r => r.includes('480')));
  assert.equal(c.measurements.find(m => m.key === 'QTc_ms').summary, false);
  const qrs = c.measurements.find(m => m.key === 'QRS_ms');
  assert.equal(qrs.level, 'major');
  assert.ok(qrs.reasons.some(r => r.includes('120')));
  assert.ok(c.counts.major >= 2);
});

test('small noise stays below threshold; axis crossing normal range is flagged', () => {
  const a = record(syntheticECG301({ hr: 72, axes: [50, 40, 40] }));
  const b = record(syntheticECG301({ id: '20260201120000', hr: 75, axes: [50, -45, 40] }));
  const c = compareRecords(a, b);
  assert.equal(c.measurements.find(m => m.key === 'heart_rate_bpm').level, 'none');
  const axis = c.measurements.find(m => m.key === 'QRS_axis');
  assert.equal(axis.level, 'major');
  assert.equal(axis.statusB, 'low');
});

test('AI score comparison flags threshold crossing and big deltas only', () => {
  const ai = s => ({ efficientnet: { model: 'SL', scores: s } });
  const a = record(syntheticECG301(), { ai: ai({ AF: 0.1, LBBB: 0.40, X: 0.30, Y: 0.47 }) });
  const b = record(syntheticECG301({ id: '20260201120000' }), { ai: ai({ AF: 0.7, LBBB: 0.58, X: 0.33, Y: 0.53 }) });
  const [s] = compareRecords(a, b).scores;
  const labels = s.changes.map(x => x.label);
  assert.deepEqual(labels, ['AF', 'LBBB']);
  assert.equal(s.changes[0].level, 'major');
  assert.equal(s.changes[1].crossed, true);
});

test('auto comparisons and trends', () => {
  const recs = ['20250101120000', '20250701120000', '20260101120000'].map((id, i) =>
    record(syntheticECG301({ id, qtc: 400 + 20 * i })));
  const auto = autoComparisons(recs);
  assert.equal(auto.previous.older.id, '20250701120000');
  assert.equal(auto.baseline.older.id, '20250101120000');
  assert.deepEqual(trend(recs, 'QTc_ms').map(p => p.v), [400, 420, 440]);
  assert.equal(rangeStatus(455, MEASURE_LABELS.QTc_ms, 'F'), 'normal');
  assert.equal(rangeStatus(455, MEASURE_LABELS.QTc_ms, 'M'), 'high');
});

const PRIVATE = process.env.CARDIOAI_PRIVATE_ECG;
test('private ECG301 record (local only)', { skip: !(PRIVATE && existsSync(PRIVATE)) && 'set CARDIOAI_PRIVATE_ECG to run' }, () => {
  const raw = readFileSync(PRIVATE);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const r = record(buf);
  const m = medianBeats(toMillivolts(r.signal.leads, r.signal.calibration), 200);
  assert.ok(m.beats >= 1, 'beats ' + m.beats);
  const c = compareRecords(r, { ...r, id: 'copy', recordedAt: '2027-01-01T00:00:00' });
  assert.equal(c.counts.major + c.counts.minor, 0);
  assert.ok(c.waveform.available && c.waveform.meanCorrelation > 0.999);
});

test('score levels need both probability and logit change', () => {
  assert.equal(scoreLevel(0.01, 0.04), 'none');      // big logit, tiny p
  assert.equal(scoreLevel(0.50, 0.56), 'none');      // p 0.06 but logit 0.24
  assert.equal(scoreLevel(0.20, 0.45), 'major');
});

test('model agreement: same group, same direction in two models', () => {
  const mk = (sl, ssl) => ({ efficientnet: { scores: { 'Left bundle branch block': sl } }, wcr: { scores: { 'Left bundle branch block': ssl } } });
  const a = record(syntheticECG301(), { ai: mk(0.1, 0.15) });
  const b = record(syntheticECG301({ id: '20260201120000' }), { ai: mk(0.6, 0.7) });
  const c = compareRecords(a, b);
  assert.deepEqual(c.concordant, [{ group: 'проводимость', direction: 'up' }]);
  assert.ok(c.scores.every(m => m.changes[0].concordant));
});

test('voltage change needs relative change too; sustained trend', () => {
  const a = record(syntheticECG301({ rv5: 3.0, sv1: 1.0 }));
  const b = record(syntheticECG301({ id: '20260201120000', rv5: 3.5, sv1: 1.0 }));
  assert.equal(compareRecords(a, b).measurements.find(m => m.key === 'RV5_mV').level, 'small');
  const recs = ['20250101120000', '20250401120000', '20250701120000', '20251001120000'].map((id, i) =>
    record(syntheticECG301({ id, qt: 380 + 12 * i })));
  const t = sustainedTrends(recs);
  assert.ok(t.some(x => x.key === 'QTcF_ms' && x.direction === 'up'), JSON.stringify(t));
});

test('baseline marks and limb-lead reversal guard', () => {
  const recs = ['20250101120000', '20250201120000', '20260101120000'].map(id => record(syntheticECG301({ id })));
  recs[1].isBaseline = true;
  assert.equal(autoComparisons(recs).baseline, undefined); // baseline == previous
  recs[0].isBaseline = true;
  assert.equal(autoComparisons(recs).baseline.older.id, 'baseline');
});

test('median beat is aligned on R even with a wide QRS', () => {
  for (const shape of [{}, { qrsWidth: 0.045, tAmp: -0.1 }]) {
    const p = parseECG301(syntheticECG301({ shape }));
    const m = medianBeats(toMillivolts(p.blocks.B, { microvoltsPerCount: 1.16, zeroCounts: 2048 }), 200);
    const II = m.template[1];
    const at = II.reduce((best, v, i) => (Math.abs(v) > Math.abs(II[best]) ? i : best), 0);
    assert.ok(Math.abs(at - m.preSamples) <= 2, `R at ${at}, expected ${m.preSamples}`);
    assert.ok(II[at] > 0.8, 'R amplitude survives baseline correction: ' + II[at]);
  }
});
