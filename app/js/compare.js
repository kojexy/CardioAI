// Compare ECG records of one person (serial comparison). Pure logic, no DOM.
// Rules and their sources: rules.js and docs/research/serial-ecg-comparison.md.
import { RULES, LABEL_GROUP_OF } from './rules.js';
import { axisDelta, mean } from './measure.js';
import { LEADS } from './ecg301.js';
import { toMillivolts, medianBeats, compareTemplates, baselineSway } from './signal.js';

const ORDER = { none: 0, small: 1, minor: 2, major: 3 };
export const LEVEL_TEXT = { none: 'без изменений', small: 'в пределах погрешности', minor: 'заметное', major: 'значимое' };
const raise = (level, to) => (ORDER[to] > ORDER[level] ? to : level);
const cap = (level, to) => (ORDER[level] > ORDER[to] ? to : level);

function levelOf(abs, rule) {
  if (abs < rule.noise) return 'none';
  if (abs < rule.minor) return 'small';
  if (abs < rule.major) return 'minor';
  return 'major';
}

export function normalRange(rule, sex) {
  return sex === 'F' && rule.normalF ? rule.normalF : rule.normal;
}

export function rangeStatus(value, rule, sex) {
  const range = normalRange(rule, sex);
  if (!range || !Number.isFinite(value)) return null;
  if (value >= range[0] && value <= range[1]) return 'normal';
  if (rule.axis) return axisDelta(range[0], value) < 0 ? 'low' : 'high';
  return value < range[0] ? 'low' : 'high';
}

const fmt = (v, unit) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100).replace('.', ',')) + (unit === '°' ? '°' : ' ' + unit);

// Did the value enter a range between a (old) and b (new)?
function entered(c, va, vb, sex) {
  const above = sex === 'F' && c.aboveF !== undefined ? c.aboveF : c.above;
  if (above !== undefined) return va <= above && vb > above;
  if (c.below !== undefined) return va >= c.below && vb < c.below;
  if (c.outside) {
    const inside = v => v >= c.outside[0] && v <= c.outside[1];
    return inside(va) && !inside(vb);
  }
  return false;
}

function compareMeasurement(rule, va, vb, sex) {
  const delta = rule.axis ? axisDelta(va, vb) : vb - va;
  let level = levelOf(Math.abs(delta), rule);
  const reasons = [];
  // Voltages are dominated by electrode position: require a relative change too.
  if (rule.relativeMin && Math.abs(va) > 0 && 100 * Math.abs(delta) / Math.abs(va) < rule.relativeMin) level = cap(level, 'small');
  // Report only the most severe range the value entered.
  let worst = null;
  for (const c of rule.crossings || []) if (level !== 'none' && entered(c, va, vb, sex) && (!worst || ORDER[c.level] >= ORDER[worst.level])) worst = c;
  if (worst) { reasons.push(worst.text); level = raise(level, worst.level); }
  for (const r of rule.relative || []) {
    const pct = va ? 100 * delta / Math.abs(va) : 0;
    const beyond = r.above !== undefined ? vb > r.above : vb < r.below;
    if (beyond && (r.pct > 0 ? pct > r.pct : pct < r.pct)) {
      reasons.push(`изменение ${r.pct > 0 ? 'более +' : 'более −'}${Math.abs(r.pct)}% до ${fmt(vb, rule.unit)}`);
      level = raise(level, r.level);
    }
  }
  const statusA = rangeStatus(va, rule, sex), statusB = rangeStatus(vb, rule, sex);
  if (statusA === 'normal' && statusB && statusB !== 'normal' && level !== 'none') {
    if (!reasons.length) reasons.push('вышло за пределы нормы');
    level = raise(level, 'minor');
  } else if (statusA && statusA !== 'normal' && statusB === 'normal' && level !== 'none') {
    reasons.push('вернулось в норму');
  }
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  return {
    key: rule.key, label: rule.label, unit: rule.unit, a: va, b: vb, delta: Math.round(delta * 100) / 100,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same', level, statusA, statusB, reasons,
    basis: rule.basis, ref: rule.ref, summary: rule.summary !== false,
    text: `${rule.label}: ${fmt(va, rule.unit)} → ${fmt(vb, rule.unit)} (${sign}${fmt(Math.abs(delta), rule.unit)})` + (reasons.length ? ' — ' + reasons.join('; ') : ''),
  };
}

function compareMeasurements(a, b, sex, rules) {
  const items = [];
  for (const rule of rules.measurements) {
    const va = a.measurements?.[rule.key], vb = b.measurements?.[rule.key];
    if (Number.isFinite(va) && Number.isFinite(vb)) items.push(compareMeasurement(rule, va, vb, sex));
  }
  return items;
}

function prepared(record) {
  const s = record.signal;
  if (!s || !Array.isArray(s.leads) || s.leads.length !== 12) return null;
  const mv = toMillivolts(s.leads, s.calibration);
  return { mv, beats: medianBeats(mv, s.fs), sway: baselineSway(mv, s.fs) };
}

export function compareWaveforms(a, b, rules = RULES) {
  const sa = a.signal, sb = b.signal, w = rules.waveform;
  if (!sa || !sb) return { available: false, reason: 'У одной из записей нет сигнала (например, ручной ввод)' };
  if (sa.fs !== sb.fs) return { available: false, reason: 'Разная частота записи — сравнение формы недоступно' };
  const pa = prepared(a), pb = prepared(b);
  if (!pa?.beats.template || !pb?.beats.template) return { available: false, reason: 'Не удалось выделить комплексы QRS' };
  const result = compareTemplates(pa.beats.template, pb.beats.template, sa.fs, w.maxShiftSec,
    { pre: pa.beats.preSamples, stPointSec: w.stPointSec });
  for (const [j, lead] of result.leads.entries()) {
    const noisy = pa.sway[j] > w.baselineSwayMaxMvPerSec || pb.sway[j] > w.baselineSwayMaxMvPerSec;
    let level = lead.correlation >= w.similarR ? 'none' : lead.correlation >= w.minorR ? 'small'
      : lead.correlation >= w.majorR ? 'minor' : 'major';
    const ratio = lead.amplitudeRatio == null ? 0 : Math.abs(Math.log(lead.amplitudeRatio));
    if (Math.abs(lead.ptpDiff_mV) >= w.amplitudeIgnoreMv) {
      if (ratio >= Math.log(1 + w.ratioMajor)) level = raise(level, 'major');
      else if (ratio >= Math.log(1 + w.ratioMinor)) level = raise(level, 'minor');
    }
    lead.stLevel = Math.abs(lead.stDiff_mV) >= w.stMajorMv ? 'major' : Math.abs(lead.stDiff_mV) >= w.stMinorMv ? 'minor' : 'none';
    lead.tLevel = Math.abs(lead.tDiff_mV) >= w.tMajorMv ? 'major' : 'none';
    lead.noisy = noisy;
    lead.level = noisy ? cap(level, 'small') : level;
  }
  // A waveform finding counts only in ≥2 leads of one contiguous group; one line per kind.
  const byName = Object.fromEntries(result.leads.map(l => [l.lead, l]));
  const kinds = {
    shape: { title: 'Изменилась форма комплекса', hit: l => l.level === 'minor' || l.level === 'major', major: l => l.level === 'major', show: l => l.lead },
    st: { title: 'Смещение ST', hit: l => l.stLevel !== 'none', major: l => l.stLevel === 'major', show: l => `${l.lead} ${l.stDiff_mV > 0 ? '+' : ''}${l.stDiff_mV.toFixed(2)} мВ` },
    t: { title: 'Изменение зубца T', hit: l => l.tLevel !== 'none', major: () => true, show: l => l.lead },
  };
  const findings = [];
  for (const [kind, k] of Object.entries(kinds)) {
    const parts = [], leadsHit = [];
    let level = 'none';
    for (const [group, names] of Object.entries(w.groups)) {
      const hits = names.map(n => byName[n]).filter(l => l && !l.noisy && k.hit(l));
      if (hits.length < 2) continue;
      level = raise(level, hits.filter(k.major).length >= 2 ? 'major' : 'minor');
      parts.push(`${w.groupNames[group]}: ${hits.map(k.show).join(', ')}`);
      leadsHit.push(...hits.map(l => l.lead));
    }
    if (parts.length) findings.push({ kind, level, leads: leadsHit, text: `${k.title} — ${parts.join('; ')}` });
  }
  const limb = result.leads.slice(0, 6).map(l => l.correlation), chest = result.leads.slice(6).map(l => l.correlation);
  const beats = Math.min(pa.beats.beats, pb.beats.beats);
  return {
    available: true, ...result, findings, beatsA: pa.beats.beats, beatsB: pb.beats.beats, fs: sa.fs,
    limbMeanR: Math.round(mean(limb) * 1000) / 1000, precordialMeanR: Math.round(mean(chest) * 1000) / 1000,
    fewBeats: beats < w.minBeatsReliable,
    templateA: pa.beats.template, templateB: pb.beats.template, preSamples: pa.beats.preSamples,
    calibrationVerified: !!(sa.calibration?.verified && sb.calibration?.verified),
  };
}

const logit = p => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };

export function scoreLevel(va, vb, s = RULES.scores) {
  const dp = Math.abs(vb - va), dl = Math.abs(logit(vb) - logit(va));
  for (const level of ['major', 'minor', 'small']) if (dp >= s.levels[level].p && dl >= s.levels[level].logit) return level;
  return 'none';
}

export function compareScores(a, b, rules = RULES) {
  const s = rules.scores, out = [];
  for (const [model, ra] of Object.entries(a.ai || {})) {
    const rb = b.ai?.[model];
    if (!rb?.scores || !ra?.scores) continue;
    const changes = [];
    for (const [label, va] of Object.entries(ra.scores)) {
      const vb = rb.scores[label];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
      const t = ra.thresholds?.[label] ?? s.threshold, hy = s.hysteresis;
      const crossed = (va < t - hy && vb > t + hy) || (va > t + hy && vb < t - hy);
      let level = scoreLevel(va, vb, s);
      // Overlapping uncertainty bands (e.g. 180/200/220 Hz runs) cap the level.
      const ba = ra.ranges?.[label], bb = rb.ranges?.[label];
      if (ba && bb && ba[0] <= bb[1] && bb[0] <= ba[1]) level = cap(level, 'small');
      if (crossed) level = raise(level, 'minor');
      if (ORDER[level] < ORDER.minor) continue;
      changes.push({ label, group: LABEL_GROUP_OF[label] || null, a: va, b: vb, delta: vb - va, crossed, threshold: t, level });
    }
    changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    out.push({ model, modelName: ra.model || model, changes: changes.slice(0, s.top), all: changes, total: changes.length,
      synthetic: !!(ra.synthetic || rb.synthetic), sameWeights: !ra.weightsSha || ra.weightsSha === rb.weightsSha });
  }
  // Agreement: a label group counts in the summary only if ≥2 models move the same way.
  const votes = {};
  for (const m of out) for (const c of m.all) if (c.group) {
    const key = c.group + (c.delta > 0 ? '↑' : '↓');
    (votes[key] ||= new Set()).add(m.model);
  }
  const concordant = Object.entries(votes).filter(([, set]) => set.size >= 2)
    .map(([key]) => ({ group: key.slice(0, -1), direction: key.endsWith('↑') ? 'up' : 'down' }));
  for (const m of out) for (const c of m.all) c.concordant = concordant.some(g => g.group === c.group && (c.delta > 0) === (g.direction === 'up'));
  return { models: out, concordant };
}

function axisReversalSuspected(measurements, waveform, rules) {
  const axis = measurements.find(m => m.key === 'QRS_axis');
  const r = rules.axisReversal;
  return !!(axis && Math.abs(axis.delta) >= r.triggerDeg && waveform.available &&
    waveform.limbMeanR < r.limbMaxR && waveform.precordialMeanR >= r.precordialMinR);
}

export function compareRecords(a, b, { sex, rules = RULES } = {}) {
  // Always compare older → newer.
  if ((a.recordedAt || '') > (b.recordedAt || '')) [a, b] = [b, a];
  const measurements = compareMeasurements(a, b, sex, rules);
  const waveform = compareWaveforms(a, b, rules);
  const scores = compareScores(a, b, rules);
  const warnings = [];
  if (axisReversalSuspected(measurements, waveform, rules)) {
    warnings.push('Возможно, перепутаны электроды на конечностях: форма в грудных отведениях не изменилась, а в отведениях от конечностей — сильно. Сдвиг оси может быть ошибкой наложения.');
    for (const m of measurements) if (m.key.endsWith('_axis') || m.key === 'QRS_T_angle_deg') m.level = cap(m.level, 'small');
  }
  const minutes = a.recordedAt && b.recordedAt ? (new Date(b.recordedAt) - new Date(a.recordedAt)) / 60000 : null;
  if (minutes !== null && minutes < rules.minIntervalMinutes) warnings.push('Записи сделаны с разницей менее 30 минут — изменения, скорее всего, отражают погрешность.');
  if (waveform.available && waveform.fewBeats) warnings.push(`Мало комплексов для среднего (${Math.min(waveform.beatsA, waveform.beatsB)}; надёжно — от ${rules.waveform.minBeatsReliable}). Сравнение формы ориентировочное.`);
  // Wide QRS (bundle branch block range) changes ST-T secondarily; do not read it as ischaemia.
  const qrsB = b.measurements?.QRS_ms;
  if (waveform.available && Number.isFinite(qrsB) && qrsB >= rules.waveform.secondaryQrsMs && waveform.findings.some(f => f.kind !== 'shape')) {
    for (const f of waveform.findings) if (f.kind !== 'shape') { f.level = cap(f.level, 'minor'); f.text += ' (вторично при широком QRS)'; }
    warnings.push('QRS ≥120 мс: изменения ST и T могут быть вторичными из-за нарушения проводимости.');
  }
  if (waveform.available && !waveform.calibrationVerified) warnings.push('Масштаб сигнала в мВ не подтверждён производителем — значения ST/T в мВ приблизительны.');

  const counted = measurements.filter(m => m.summary);
  const counts = { major: 0, minor: 0 };
  for (const m of counted) if (m.level in counts) counts[m.level]++;
  for (const f of waveform.findings || []) counts[f.level]++;
  const days = minutes === null ? null : Math.round(minutes / 1440);
  const highlights = [
    ...counted.filter(m => m.level === 'major'), ...(waveform.findings || []).filter(f => f.level === 'major'),
    ...counted.filter(m => m.level === 'minor'), ...(waveform.findings || []).filter(f => f.level === 'minor'),
  ];
  let headline;
  if (!measurements.length && !waveform.available) headline = 'Недостаточно данных для сравнения';
  else if (!counts.major && !counts.minor) headline = 'Существенных изменений не найдено';
  else headline = `Найдено изменений: значимых ${counts.major}, заметных ${counts.minor}`;
  return { older: a, newer: b, days, measurements, waveform, scores: scores.models, concordant: scores.concordant,
    counts, highlights, warnings, headline, rulesVersion: rules.version };
}

// A baseline built from records the user marked as baseline (mean values), else the first record.
export function baselineRecord(sorted) {
  const marked = sorted.filter(r => r.isBaseline);
  if (marked.length <= 1) return marked[0] || sorted[0];
  const measurements = {};
  const keys = new Set(marked.flatMap(r => Object.keys(r.measurements || {})));
  for (const k of keys) {
    const vs = marked.map(r => r.measurements[k]).filter(Number.isFinite);
    if (vs.length) measurements[k] = Math.round(mean(vs) * 100) / 100;
  }
  const last = marked[marked.length - 1];
  return { ...last, id: 'baseline', measurements, ai: {}, recordedAt: marked[0].recordedAt, baselineOf: marked.map(r => r.id) };
}

// For a patient timeline: newest vs previous and newest vs baseline.
export function autoComparisons(records, sex) {
  const sorted = [...records].sort((x, y) => (x.recordedAt || '').localeCompare(y.recordedAt || ''));
  const out = {};
  if (sorted.length < 2) return out;
  const newest = sorted[sorted.length - 1];
  out.previous = compareRecords(sorted[sorted.length - 2], newest, { sex });
  const base = baselineRecord(sorted.slice(0, -1));
  if (base && base.id !== sorted[sorted.length - 2].id) out.baseline = compareRecords(base, newest, { sex });
  return out;
}

export function trend(records, key) {
  return [...records]
    .filter(r => Number.isFinite(r.measurements?.[key]) && r.recordedAt)
    .sort((x, y) => x.recordedAt.localeCompare(y.recordedAt))
    .map(r => ({ t: r.recordedAt, v: r.measurements[key], id: r.id }));
}

// ≥3 consecutive changes in the same direction, and total change ≥ "minor".
export function sustainedTrends(records, rules = RULES) {
  const out = [];
  for (const rule of rules.measurements) {
    if (rule.summary === false) continue;
    const pts = trend(records, rule.key);
    if (pts.length < rules.trend.minPoints + 1) continue;
    const last = pts.slice(-(rules.trend.minPoints + 1));
    const steps = last.slice(1).map((p, i) => (rule.axis ? axisDelta(last[i].v, p.v) : p.v - last[i].v));
    const total = rule.axis ? axisDelta(last[0].v, last[last.length - 1].v) : last[last.length - 1].v - last[0].v;
    const up = steps.every(d => d > 0), down = steps.every(d => d < 0);
    if ((up || down) && Math.abs(total) >= rule.minor)
      out.push({ key: rule.key, label: rule.label, unit: rule.unit, direction: up ? 'up' : 'down', total: Math.round(total * 100) / 100, points: last.length });
  }
  return out;
}

export { LEADS };
