// Serial ECG comparison rules, version 2 (2026-10-29).
// Built from docs/research/serial-ecg-comparison.md. basis: 'source' = threshold taken
// from a publication (named in `ref`); 'practical' = working choice without one source.
// Levels for |delta|: < noise → none; < minor → small; < major → minor (заметное); ≥ major → major.
// crossings: entering a range raises the level; relative: "+25% and new value beyond X" rules.

export const RULES = {
  version: 2,
  minIntervalMinutes: 30,
  measurements: [
    { key: 'heart_rate_bpm', label: 'ЧСС', unit: 'уд/мин', normal: [50, 100], noise: 5, minor: 10, major: 20, basis: 'source',
      ref: 'Philips: ΔЧСС ≥20 = значимо; шум ~5,8 (Zywietz 2003)',
      crossings: [{ below: 50, level: 'minor', text: 'брадикардия (<50)' }, { above: 100, level: 'minor', text: 'тахикардия (>100)' }],
      relative: [{ pct: -25, below: 50, level: 'major' }, { pct: 25, above: 100, level: 'major' }] },
    { key: 'PR_ms', label: 'PR', unit: 'мс', normal: [120, 200], noise: 10, minor: 20, major: 40, basis: 'practical',
      ref: 'норма AHA; правило 25% (TQT)',
      crossings: [{ above: 200, level: 'minor', text: 'PR >200 мс (диапазон АВ-блокады I ст.)' }, { below: 120, level: 'minor', text: 'короткий PR (<120 мс)' }],
      relative: [{ pct: 25, above: 200, level: 'major' }] },
    { key: 'QRS_ms', label: 'QRS', unit: 'мс', normal: [70, 110], noise: 8, minor: 16, major: 25, basis: 'source',
      ref: 'шум/заметно — KORA (Perz 2008); 110/120 мс — AHA',
      crossings: [{ above: 110, level: 'minor', text: 'QRS 110–119 мс' }, { above: 119, level: 'major', text: 'QRS ≥120 мс (диапазон полной блокады ножки)' }],
      relative: [{ pct: 25, above: 120, level: 'major' }] },
    { key: 'QT_ms', label: 'QT (без коррекции)', unit: 'мс', normal: [325, 452], noise: 15, minor: 40, major: 60, basis: 'source',
      ref: 'Mason 2007; зависит от ЧСС — в итог не выносится', summary: false },
    { key: 'QTcF_ms', label: 'QTc Фридеричиа', unit: 'мс', normal: [350, 450], normalF: [350, 460], noise: 10, minor: 30, major: 60, basis: 'source',
      ref: 'ICH E14 (30/60 мс; 450/480/500); шум — Natekar 2011',
      crossings: [{ above: 450, aboveF: 460, level: 'minor', text: 'QTcF выше нормы' }, { above: 480, level: 'major', text: 'QTcF >480 мс' }, { above: 500, level: 'major', text: 'QTcF >500 мс' }] },
    { key: 'QTc_ms', label: 'QTc прибора (Базетт)', unit: 'мс', normal: [360, 450], normalF: [360, 460], noise: 15, minor: 30, major: 60, basis: 'source',
      ref: 'ICH E14; формула Базетта искажает QTc при изменении ЧСС — ориентир QTcF', summary: false,
      crossings: [{ above: 450, aboveF: 460, level: 'minor', text: 'QTc выше нормы' }, { above: 480, level: 'major', text: 'QTc >480 мс' }, { above: 500, level: 'major', text: 'QTc >500 мс' }, { below: 390, level: 'minor', text: 'короткий QTc (≤390)' }] },
    { key: 'P_axis', label: 'Ось P', unit: '°', normal: [0, 75], axis: true, noise: 20, minor: 45, major: 90, basis: 'practical',
      crossings: [{ outside: [0, 90], level: 'minor', text: 'ось P вне 0…+90° (эктопический ритм или перепутанные электроды?)' }] },
    { key: 'QRS_axis', label: 'Ось QRS', unit: '°', normal: [-30, 90], axis: true, noise: 15, minor: 30, major: 60, basis: 'practical',
      ref: 'границы −30/−45/+90 — AHA',
      crossings: [{ below: -30, level: 'minor', text: 'отклонение оси влево (< −30°)' }, { below: -45, level: 'minor', text: 'диапазон БПВЛНПГ (−45…−90°)' },
        { above: 90, level: 'minor', text: 'отклонение оси вправо (> +90°)' }] },
    { key: 'T_axis', label: 'Ось T', unit: '°', normal: [0, 90], axis: true, noise: 20, minor: 45, major: 90, basis: 'practical' },
    { key: 'QRS_T_angle_deg', label: 'Угол QRS–T', unit: '°', normal: [0, 100], noise: 20, minor: 45, major: 90, basis: 'practical',
      crossings: [{ above: 100, level: 'minor', text: 'широкий угол QRS–T (>100°)' }] },
    { key: 'RV5_mV', label: 'RV5', unit: 'мВ', normal: [0.5, 2.6], noise: 0.4, minor: 0.8, major: 1.2, relativeMin: 25, voltage: true, basis: 'practical',
      ref: 'сильно зависит от положения электродов (Angeli 2006)',
      crossings: [{ above: 2.6, level: 'minor', text: 'RV5 >2,6 мВ (вольтажный критерий)' }] },
    { key: 'SV1_mV', label: 'SV1 (модуль)', unit: 'мВ', normal: [0.3, 2.5], noise: 0.4, minor: 0.8, major: 1.2, relativeMin: 25, voltage: true, basis: 'practical' },
    { key: 'sokolow_mV', label: 'Соколов–Лайон', unit: 'мВ', normal: [0, 3.5], noise: 0.5, minor: 1.0, major: 1.5, relativeMin: 25, voltage: true, basis: 'source',
      ref: '3,5 мВ — Sokolow-Lyon; вариабельность ~10–18% (Angeli 2006)',
      crossings: [{ above: 3.5, level: 'minor', text: 'Соколов–Лайон >3,5 мВ (только вольтаж, не диагноз ГЛЖ)' }] },
    { key: 'RR_cv_pct', label: 'Нерегулярность RR', unit: '%', normal: [0, 10], noise: 3, minor: 5, major: 10, basis: 'practical',
      crossings: [{ above: 10, level: 'minor', text: 'ритм заметно нерегулярен' }] },
  ],
  axisReversal: { triggerDeg: 60, limbMaxR: 0.7, precordialMinR: 0.95 },
  waveform: {
    similarR: 0.95, minorR: 0.9, majorR: 0.8, minBeatsReliable: 6, maxShiftSec: 0.04,
    amplitudeIgnoreMv: 0.1, ratioMinor: 0.25, ratioMajor: 0.5,
    stPointSec: 0.12, stMinorMv: 0.07, stMajorMv: 0.1, tMajorMv: 0.2, baselineSwayMaxMvPerSec: 0.3,
    groups: { inferior: ['II', 'III', 'aVF'], lateral: ['I', 'aVL', 'V5', 'V6'], septal: ['V1', 'V2'], anterior: ['V3', 'V4'] },
    groupNames: { inferior: 'нижние', lateral: 'боковые', septal: 'перегородочные', anterior: 'передние' },
    secondaryQrsMs: 120,
    ref: 'ST 0,1 мВ — Philips/UDMI; T 0,2 мВ — Philips; качество — Perz 2008; форма r<0,90 — практический выбор',
  },
  scores: {
    levels: { small: { p: 0.05, logit: 0.3 }, minor: { p: 0.1, logit: 0.5 }, major: { p: 0.2, logit: 1.0 } },
    hysteresisLogit: 0.25, top: 10, basis: 'practical',
  },
  trend: { minPoints: 3 },
};

export const MEASURE_LABELS = Object.fromEntries(RULES.measurements.map(m => [m.key, m]));

// DeepECG label groups (77 labels), used to require agreement between models.
export const LABEL_GROUPS = {
  'ритм': ['Sinusal', 'Regular', 'Afib', 'Atrial flutter', 'Irregularly irregular', 'Regularly irregular', 'Atrial tachycardia (>= 100 BPM)', 'Supraventricular tachycardia', 'Junctional rhythm', 'Ectopic atrial rhythm (< 100 BPM)', 'Ventricular tachycardia', 'Ventricular Rhythm', 'Bradycardia', 'Premature ventricular complex', 'Premature atrial complex'],
  'проводимость': ['Left bundle branch block', 'Right bundle branch block', 'Nonspecific intraventricular conduction delay', '1st degree AV block', '2nd degree AV block - mobitz 1', '2nd degree AV block - mobitz 2', 'Third Degree AV Block', 'Left anterior fascicular block', 'Left posterior fascicular block', "rSR' in V1-V2", 'Delta wave', 'Wolff-Parkinson-White (Pre-excitation syndrome)'],
  'ось': ['Left axis deviation', 'Right axis deviation', 'Right superior axis', 'QRS complex negative in III'],
  'ишемия / рубец': ['Acute MI', 'Q wave (inferior - II, III, aVF)', 'Q wave (lateral- I, aVL, V5-V6)', 'Q wave (septal- V1-V2)', 'Q wave (anterior - V3-V4)', 'Q wave (posterior - V7-V9)', 'QS complex in V1-V2-V3', 'ST elevation (anterior - V3-V4)', 'ST elevation (septal - V1-V2)', 'ST elevation (inferior - II, III, aVF)', 'ST elevation (lateral - I, aVL, V5-V6)', 'ST elevation (posterior - V7-V8-V9)', 'ST depression (inferior - II, III, aVF)', 'ST depression (anterior - V3-V4)', 'ST depression (lateral - I, avL, V5-V6)', 'ST depression (septal- V1-V2)', 'ST downslopping', 'ST upslopping', 'T wave inversion (inferior - II, III, aVF)', 'T wave inversion (lateral -I, aVL, V5-V6)', 'T wave inversion (anterior - V3-V4)', 'T wave inversion (septal- V1-V2)', 'Acute pericarditis', 'Early repolarization', 'Brugada'],
  'гипертрофия / вольтаж': ['Left ventricular hypertrophy', 'Right ventricular hypertrophy', 'SV1 + RV5 or RV6 > 35 mm', 'RaVL > 11 mm', 'RV1 + SV6 > 11 mm', 'R/S ratio in V1-V2 >1', 'R complex in V5-V6', 'qRS in V5-V6-I, aVL', 'Low voltage'],
  'предсердия': ['Left atrial enlargement', 'Right atrial enlargement', 'Bi-atrial enlargement'],
  'реполяризация / QT': ['Prolonged QT', 'U wave'],
  'кардиостимуляция': ['Ventricular paced', 'Atrial paced', 'LV pacing'],
  'технические': ['Lead misplacement', 'no_qrs', 'Monomorph', 'Polymorph'],
};
export const LABEL_GROUP_OF = Object.fromEntries(Object.entries(LABEL_GROUPS).flatMap(([g, ls]) => ls.map(l => [l, g])));
