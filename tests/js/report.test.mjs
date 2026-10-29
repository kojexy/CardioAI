import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseECG301, ASSUMED } from '../../app/js/ecg301.js';
import { deriveMeasurements } from '../../app/js/measure.js';
import { compareRecords } from '../../app/js/compare.js';
import { recordReport, comparisonReport } from '../../app/js/report.js';
import { syntheticECG301 } from './fixtures.mjs';

function record(id) {
  const p = parseECG301(syntheticECG301({ id }));
  return { id, source: 'ecg301', deviceRecordId: p.recordId, recordedAt: p.recordedAt, measurements: deriveMeasurements(p.device),
    signal: { block: 'B', fs: ASSUMED.fsB, leads: p.blocks.B, calibration: { microvoltsPerCount: ASSUMED.microvoltsPerCount, zeroCounts: ASSUMED.zeroCounts, verified: false } }, ai: {} };
}
const patient = { surname: 'Иванов', name: 'Пётр', birthDate: '1958-04-12', sex: 'M' };

test('one-ECG report has the patient, measurements, the ECG on paper and a conclusion box', () => {
  const html = recordReport(patient, record('20261023170734'), { printedAt: '2026-10-29T16:00:00' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Иванов Пётр/);
  assert.match(html, /Интервал PQ/);
  assert.match(html, /<svg class="paper"/);
  assert.equal((html.match(/class="ecg"/g) || []).length, 12);
  assert.match(html, /Заключение врача/);
  assert.match(html, /25 мм\/с · 10 мм\/мВ/);
});

test('patient text is escaped', () => {
  const html = recordReport({ ...patient, surname: '<img src=x onerror=alert(1)>' }, record('20261023170734'));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('a record without a signal still prints, without the ECG grid', () => {
  const r = { ...record('20261023170734'), signal: null };
  const html = recordReport(patient, r);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /Заключение врача/);
});

test('comparison report shows both dates, the overlay and both tracings; AI filter keeps one network', () => {
  const a = record('20260301100000'), b = record('20261023170734');
  a.ai = { wcr: { model: 'WCR', scores: { X: 0.1 }, thresholds: { X: 0.5 } } };
  b.ai = { wcr: { model: 'WCR', scores: { X: 0.9 }, thresholds: { X: 0.5 } } };
  const c = compareRecords(a, b, { sex: 'M' });
  const html = comparisonReport(patient, c, { model: 'ecgfounder' });
  assert.match(html, /01\.03\.2026/);
  assert.match(html, /23\.10\.2026/);
  assert.match(html, /Средний комплекс/);
  assert.equal((html.match(/<svg class="paper"/g) || []).length, 3);
  assert.doesNotMatch(html, /Изменения оценок нейросетей/);
});
