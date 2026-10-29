// Printable A4 reports: one ECG (protocol) and a comparison of two ECGs.
// Pure functions that return a complete HTML document (no DOM), so the same report is printed
// from a browser, opened in the system browser by the desktop program, or shared on Android.
// Built for a monochrome laser printer: nothing depends on colour; the ECG grid prints as light grey.
import { LEADS } from './ecg301.js';
import { toMillivolts } from './signal.js';
import { RULES } from './rules.js';
import { normalRange, rangeStatus, LEVEL_TEXT } from './compare.js';

const esc = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v, digits = 0) => Number(v).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const r = v => Math.round(v * 100) / 100;  // SVG coordinates in mm, 0.01 mm is enough

export const DISCLAIMER = 'CardioAI — исследовательская программа. Результаты — технические оценки, а не диагноз. Решение принимает врач.';
const FOOT = 'CardioAI — исследовательская программа; не диагноз, решение принимает врач.';
const MODEL_NAMES = { efficientnet: 'DeepECG SL', wcr: 'DeepECG SSL', ecgfounder: 'ECGFounder' };
const SEX = { M: 'мужской', F: 'женский' };

function fmtDate(iso, withTime = false) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '—';
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return withTime ? `${date}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : date;
}
function fullName(p) { return [p.surname, p.name, p.middleName].filter(Boolean).join(' ') || 'Без имени'; }
function ageAt(birth, when) {
  const b = new Date(birth), w = new Date(when || Date.now());
  if (!birth || isNaN(b) || isNaN(w)) return null;
  return w.getFullYear() - b.getFullYear() - (w < new Date(w.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
}
function years(n) {
  const t = n % 10, h = n % 100;
  return `${n} ${t === 1 && h !== 11 ? 'год' : t >= 2 && t <= 4 && (h < 12 || h > 14) ? 'года' : 'лет'}`;
}

// ---------- ECG paper (SVG in mm: 1 user unit = 1 mm)
function grid(w, h) {
  let minor = '', major = '';
  for (let x = 0; x <= w + 0.001; x += 1) (Math.round(x) % 5 ? (minor += `M${r(x)} 0V${h}`) : (major += `M${r(x)} 0V${h}`));
  for (let y = 0; y <= h + 0.001; y += 1) (Math.round(y) % 5 ? (minor += `M0 ${r(y)}H${w}`) : (major += `M0 ${r(y)}H${w}`));
  return `<path class="g1" d="${minor}"/><path class="g5" d="${major}"/>`;
}
// 1 mV calibration pulse: 10 mm high, 5 mm wide (0.2 s at 25 mm/s), standing on the baseline.
const pulse = (x, y) => `<path class="cal" d="M${r(x)} ${r(y)}h1.5v-10h5v10h1.5"/>`;
function trace(samples, fs, x0, y0, mmPerSec, mmPerMv, clip) {
  const step = mmPerSec / fs, out = [];
  let gap = true;  // a missing sample breaks the line; drawing restarts after it
  samples.forEach((v, i) => {
    if (!Number.isFinite(v)) { gap = true; return; }
    out.push(`${gap ? 'M' : 'L'}${r(x0 + i * step)} ${r(Math.max(y0 - clip, Math.min(y0 + clip, y0 - v * mmPerMv)))}`);
    gap = false;
  });
  return out.join('');
}
const hasSignal = rec => rec?.signal?.leads?.length === 12 && rec.signal.fs > 0 && rec.signal.leads.every(l => l?.length > 1) &&
  Number.isFinite(rec.signal.calibration?.microvoltsPerCount) && Number.isFinite(rec.signal.calibration?.zeroCounts);
const MAX_COL_MM = 89;  // two columns + pulse fit the 190 mm text width

// 12 leads as 6 rows × 2 columns (limb leads left, V1–V6 right), the same time window in both:
// ECG301 keeps only 3 s, so the 3×4 + rhythm layout of 10-second devices is not possible.
// Calibration pulse at the start of each row; traces may run into the next row, as on a cardiograph.
function stripSvg(record, rowH = 15) {
  const { leads, fs, calibration } = record.signal;
  const mv = toMillivolts(leads, calibration);
  const n = Math.min(...mv.map(l => l.length));
  const colW = Math.min(MAX_COL_MM, n / fs * 25), gap = 3, left = 7;
  const W = left + 2 * colW + gap + 2, H = 6 * rowH;
  let body = grid(W, H);
  for (let row = 0; row < 6; row++) {
    const y0 = row * rowH + rowH * 0.6;
    body += pulse(-0.5, y0);
    body += `<path class="sep" d="M${r(left + colW + gap / 2)} ${r(y0 - 1.5)}v3"/>`;
    for (let col = 0; col < 2; col++) {
      const j = col * 6 + row, x0 = left + col * (colW + gap);
      body += `<path class="ecg" d="${trace(mv[j].slice(0, Math.round(colW / 25 * fs)), fs, x0, y0, 25, 10, rowH * 1.5)}"/>`;
      body += `<text class="lead" x="${r(x0 + 0.8)}" y="${r(row * rowH + 3.4)}">${LEADS[j]}</text>`;
    }
  }
  return `<svg class="paper" viewBox="0 0 ${r(W)} ${H}" width="${r(W)}mm" height="${H}mm" role="img" aria-label="ЭКГ, 12 отведений">${body}</svg>`;
}
function settingsLine(record) {
  const total = Math.min(...record.signal.leads.map(l => l.length)) / record.signal.fs, shown = Math.min(total, MAX_COL_MM / 25);
  const seconds = shown < total ? `${num(shown, 1)} с (показано из ${num(total, 1)} с)` : `${num(total, 1)} с`;
  return `25 мм/с · 10 мм/мВ (печать A4, масштаб 100 %: импульс = 10 мм) · I–aVF и V1–V6 — одни и те же ${seconds}, синхронно · фильтры: нет данных. ` +
    (record.signal.calibration?.verified ? '' : `Калибровка не подтверждена производителем: ${record.signal.fs} Гц и мВ определены программой — масштабы, амплитуды и калибровочный импульс ориентировочные. `) +
    'Не заменяет ЭКГ 10 с.';
}

// Median beats of two ECGs on one grid: ECG 1 dashed, ECG 2 solid (readable in black and white).
function overlaySvg(waveform) {
  const { templateA: a, templateB: b, lagMs, fs } = waveform;
  const lag = Math.round(lagMs * fs / 1000), speed = 50, cols = 4, rows = 3;
  const beatW = (a[0].length - 1) / fs * speed, cellW = beatW + 10, cellH = 40;
  const W = cols * cellW, H = rows * cellH;
  let body = grid(W, H);
  LEADS.forEach((name, j) => {
    const x0 = (j % cols) * cellW + 4, top = Math.floor(j / cols) * cellH, y0 = top + cellH * 0.58;
    const info = waveform.leads[j];
    body += `<path class="ecg before" d="${trace(a[j], fs, x0, y0, speed, 10, cellH * 0.55)}"/>`;
    body += `<path class="ecg" d="${trace(b[j].slice(Math.max(0, lag)), fs, x0 + Math.max(0, -lag) * speed / fs, y0, speed, 10, cellH * 0.55)}"/>`;
    body += `<text class="lead" x="${r(x0)}" y="${r(top + 4.5)}">${name}</text>`;
    if (info) body += `<text class="corr${info.level === 'major' || info.level === 'minor' ? ' hit' : ''}" x="${r(x0 + beatW)}" y="${r(top + 4.5)}" text-anchor="end">сходство ${signed(info.correlation, 2, false)}${info.level === 'major' ? ' ▲▲' : info.level === 'minor' ? ' ▲' : ''}</text>`;
  });
  return `<svg class="paper" viewBox="0 0 ${r(W)} ${H}" width="${r(W)}mm" height="${H}mm" role="img" aria-label="Наложение средних комплексов">${body}</svg>`;
}

// ---------- numbers and norms as written in Russian protocols
const MINUS = '−';
function signed(v, digits = 0, plus = true) {
  return (v < 0 ? MINUS : v > 0 && plus ? '+' : '') + num(Math.abs(v), digits);
}
const AXES = ['P_axis', 'QRS_axis', 'T_axis', 'QRS_T_angle_deg'];
function value(v, unit, key) {
  if (!Number.isFinite(v)) return '—';
  if (unit === '°') return (key === 'QRS_T_angle_deg' ? num(v) : signed(v)) + '°';
  if (unit === 'мВ') return '≈' + num(v, 2);  // scale of the device not confirmed
  return num(v, unit === '%' ? 1 : 0);
}
// Electrical axis of the heart (ЭОС) by the Russian textbook classes; cut-offs differ between sources.
function eos(angle) {
  if (!Number.isFinite(angle)) return '';
  if (angle < 0) return 'отклонение влево';
  if (angle < 30) return 'горизонтальная';
  if (angle < 70) return 'нормальная';
  if (angle <= 90) return 'вертикальная';
  return 'отклонение вправо';
}
const SEXNORM = { M: ' (муж.)', F: ' (жен.)' };
// Norm column. Flags still come from rules.js, so the app and the paper agree.
function normText(key, rule, sex) {
  if (key === 'QT_ms') return 'зависит от ЧСС';
  if (key === 'QRS_axis') return '0…+90°';
  if (key === 'RV5_mV') return '≤ 2,6';
  if (key === 'SV1_mV') return '—';
  if (key === 'sokolow_mV') return '< 3,5';
  if (key === 'QTc_ms' || key === 'QTcF_ms') return sex === 'F' ? '≤ 460' + SEXNORM.F : sex === 'M' ? '≤ 450' + SEXNORM.M : '≤ 450 / 460';
  const range = rule ? normalRange(rule, sex) : null;
  if (!range) return '';
  return rule.unit === '°' ? `${signed(range[0])}…${signed(range[1])}°` : `${num(range[0])}…${num(range[1])}`;
}
// Russian protocol order: ЧСС → интервалы → ЭОС и оси → вольтаж.
const MAIN = ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTc_ms', 'QTcF_ms', 'QRS_axis', 'P_axis', 'T_axis', 'RV5_mV', 'SV1_mV', 'sokolow_mV'];
const SHORT = { heart_rate_bpm: 'ЧСС', PR_ms: 'Интервал PQ', QRS_ms: 'QRS', QT_ms: 'QT', QTc_ms: 'QTc (Базетт)', QTcF_ms: 'QTc (Фридеричиа)',
  P_axis: 'Ось P', QRS_axis: 'ЭОС (ось QRS)', T_axis: 'Ось T', RV5_mV: 'R в V5', SV1_mV: 'S в V1', sokolow_mV: 'SV1 + RV5 (упрощ., без V6)',
  RR_cv_pct: 'Разброс RR', QRS_T_angle_deg: 'Угол QRS–T' };
const UNIT = { 'уд/мин': 'уд/мин', 'мс': 'мс', 'мВ': 'мВ', '%': '%', '°': '' };
const label = (key, rule) => `${SHORT[key] || rule?.label || key}${UNIT[rule?.unit] ? `, <span class="unit">${UNIT[rule.unit]}</span>` : ''}`;
const RULE = Object.fromEntries(RULES.measurements.map(m => [m.key, m]));
function flag(key, st, v) {
  if (key === 'QT_ms' || !st || st === 'normal') return key === 'QRS_axis' ? eos(v) : '';
  if (AXES.includes(key)) return key === 'QRS_axis' ? `${eos(v)}` : 'вне нормы';
  return st === 'high' ? '↑ выше нормы' : '↓ ниже нормы';
}

// ---------- blocks
function header(title, patient, when, extra = '') {
  const age = ageAt(patient.birthDate, when);
  const facts = [
    patient.birthDate ? `дата рождения ${fmtDate(patient.birthDate)}${age !== null ? ` (${years(age)})` : ''}` : null,
    SEX[patient.sex] ? `пол ${SEX[patient.sex]}` : null,
  ].filter(Boolean).join(' · ');
  return `<header class="head">
  <div class="title"><h1>${esc(title)}</h1><div class="brand">CardioAI</div></div>
  <div class="who"><div class="name">${esc(fullName(patient))}</div><div class="facts">${esc(facts || 'дата рождения и пол не указаны')}</div></div>
  ${extra}
</header>`;
}
// Identity on every following page, so a loose sheet cannot be mixed up with another patient's.
const runhead = (patient, title) => `<div class="runhead"><b>${esc(fullName(patient))}</b>${patient.birthDate ? ` · ${esc(fmtDate(patient.birthDate))}` : ''}<span>${esc(title)}</span></div>`;

function measurementsTable(record, sex) {
  const rows = MAIN.filter(k => Number.isFinite(record.measurements?.[k])).map(k => {
    const rule = RULE[k], v = record.measurements[k], st = rule && k !== 'QT_ms' ? rangeStatus(v, rule, sex) : null;
    const out = st && st !== 'normal';
    return `<tr class="${out ? 'out' : ''}"><th>${label(k, rule)}</th><td class="v">${value(v, rule?.unit, k)}</td>
<td class="n">${esc(normText(k, rule, sex))}</td><td class="f">${esc(flag(k, st, v))}</td></tr>`;
  });
  if (!rows.length) return '<p>Измерений нет.</p>';
  const table = part => `<table class="meas"><thead><tr><th>Показатель</th><th class="v">Значение</th><th class="n">Норма</th><th>Оценка</th></tr></thead><tbody>${part.join('')}</tbody></table>`;
  if (rows.length <= 4) return table(rows);
  const half = Math.ceil(rows.length / 2);
  return `<div class="cols2">${table(rows.slice(0, half))}${table(rows.slice(half))}</div>`;
}
function rrLine(record) {
  const rr = (record.device?.RR_ms || []).filter(Number.isFinite);
  return `<p class="rhythm"><b>Ритм:</b> оценивает врач — запись 3 с недостаточна для оценки ритма и экстрасистол.${rr.length ? ` RR, мс: ${rr.map(v => num(v)).join(' · ')}.` : ''}</p>`;
}

function aiBlock(record, ctx) {
  const entries = Object.entries(record.ai || {}).filter(([key]) => !ctx.model || ctx.model === 'all' || ctx.model === key);
  if (!entries.length) return '';
  const items = entries.map(([key, e]) => {
    const t = e.thresholds;
    const ranked = Object.entries(e.scores || {}).filter(([l, v]) => Number.isFinite(v) && (!t || (t[l] && v >= t[l])))
      .sort((x, y) => (t ? y[1] / t[y[0]] - x[1] / t[x[0]] : y[1] - x[1])).slice(0, 5);
    const list = ranked.length ? ranked.map(([l, v]) => `<li>«${esc(ctx.labelsRu?.[l] || l)}» — оценка ${num(v, 2)}${t ? ` (порог ${num(t[l], 2)})` : ''}</li>`).join('')
      : '<li>Признаков выше порога модели нет.</li>';
    return `<div class="model"><b>${esc(MODEL_NAMES[key] || e.model || key)}</b>${e.synthetic ? ' — технический тест на искусственном сигнале, не оценка этой ЭКГ' : ''}${t ? '' : ' (у модели нет порогов — показаны наибольшие оценки)'}<ul>${list}</ul></div>`;
  }).join('');
  return `<section class="block ai"><h2>Автоматический анализ (исследовательские нейросети) — справочно</h2>
<p class="small">Признаки, отмеченные моделью. Модели не проверены на записях 3 с прибора ECG301. Оценка — не вероятность и не диагноз.</p><div class="models">${items}</div></section>`;
}

function conclusion(lines) {
  return `<section class="block concl"><h2>Заключение врача</h2>
<div class="prompts"><span>Ритм <i></i></span><span>ЧСС <i class="short"></i></span><span>ЭОС <i></i></span></div>
<div class="lines">${'<div></div>'.repeat(lines)}</div>
<div class="sign"><span>Врач <i></i></span><span>/ <i></i> /</span><span>Дата <i class="tiny"></i>.<i class="tiny"></i>.20<i class="tiny"></i></span></div>
<div class="sign-hint"><span>подпись</span><span>Ф. И. О.</span><span></span></div></section>`;
}

// Each page is laid out on its own (the page breaks are ours), so every page gets the footer with
// the patient, the disclaimer and its number — no browser support for page margin boxes needed.
function document_(title, pages, patient, printedAt) {
  const initials = [patient.name, patient.middleName].filter(Boolean).map(n => n[0] + '.').join(' ');
  const who = `${patient.surname ? `${patient.surname} ${initials}`.trim() : fullName(patient)}${patient.birthDate ? ', ' + fmtDate(patient.birthDate) : ''}`;
  const sheets = pages.map((body, i) => `<section class="sheet">${body}
<footer class="foot"><span>${esc(who)} · ${esc(FOOT)}</span><span>Напечатано ${esc(fmtDate(printedAt, true))} · стр. ${i + 1} из ${pages.length}</span></footer></section>`);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${sheets.join('')}</body></html>`;
}

// ctx: { labelsRu, model ('all' | key), printedAt, previous: comparison with the previous ECG or null }
export function recordReport(patient, record, ctx = {}) {
  const printedAt = ctx.printedAt || new Date().toISOString();
  const source = [record.source === 'ecg301' ? 'кардиограф ECG301' : record.source === 'manual' ? 'введено вручную' : 'импорт',
    record.deviceRecordId ? `запись № ${record.deviceRecordId}` : null].filter(Boolean).join(', ');
  const when = `<div class="when"><div><span class="k">Дата записи</span> ${esc(fmtDate(record.recordedAt, true))}</div><div><span class="k">Источник</span> ${esc(source)}</div></div>`;
  let body = header('Протокол ЭКГ', patient, record.recordedAt, when);
  body += `<section class="block"><h2>Измерения</h2>${measurementsTable(record, patient.sex)}${rrLine(record)}
<p class="small">Интервалы и оси — по данным прибора; QTc Фридеричиа и SV1 + RV5 рассчитаны программой; ≈ — масштаб мВ не подтверждён. Нормы — ориентир для взрослых.</p></section>`;
  if (hasSignal(record)) {
    body += `<section class="block ecg-block"><h2>ЭКГ, 12 отведений</h2>${stripSvg(record)}<p class="small">${esc(settingsLine(record))}</p></section>`;
  }
  const c = ctx.previous;
  let compared = '';
  if (c) {
    const items = c.highlights.slice(0, 2).map(m => `<li>${esc(m.text)} — ${esc(LEVEL_TEXT[m.level])}</li>`).join('');
    const more = c.highlights.length > 2 ? `<li>и ещё ${c.highlights.length - 2} — в отчёте «Сравнение ЭКГ»</li>` : '';
    compared = `<section class="block"><h2>Сравнение с ЭКГ от ${esc(fmtDate(c.older.recordedAt))}</h2>
<p class="lead-line">${esc(c.headline)}</p>${items ? `<ul class="tight">${items}${more}</ul>` : ''}</section>`;
  }
  // Comparison and AI side by side, so the doctor's conclusion stays on the first page.
  const ai = aiBlock(record, ctx);
  body += compared && ai ? `<div class="duo">${compared}${ai}</div>` : compared + ai;
  body += conclusion(ctx.lines ?? (compared && ai ? 3 : compared || ai ? 4 : 6));
  return document_(`ЭКГ ${fullName(patient)} ${fmtDate(record.recordedAt)}`, [body], patient, printedAt);
}

export function comparisonReport(patient, c, ctx = {}) {
  const printedAt = ctx.printedAt || new Date().toISOString();
  const d1 = fmtDate(c.older.recordedAt), d2 = fmtDate(c.newer.recordedAt);
  const when = `<div class="when"><div><span class="k">ЭКГ 1 (раньше)</span> ${esc(fmtDate(c.older.recordedAt, true))}</div><div><span class="k">ЭКГ 2 (сейчас)</span> ${esc(fmtDate(c.newer.recordedAt, true))}</div>${Number.isFinite(c.days) ? `<div>между записями ${esc(c.days)} дн.</div>` : ''}</div>`;
  let body = header('Сравнение ЭКГ', patient, c.newer.recordedAt, when);
  const group = (level, title) => {
    const list = c.highlights.filter(m => m.level === level);
    return list.length ? `<h3>${title} (${list.length})</h3><ul>${list.map(m => `<li>${esc(m.text)}</li>`).join('')}</ul>` : '';
  };
  body += `<section class="block"><h2>Итог</h2><p class="lead-line">${esc(c.headline)}</p>
<p class="small">По порогам программы; клиническую значимость различий оценивает врач.</p>
${group('major', '▲ Выраженные различия')}${group('minor', 'Умеренные различия')}
${c.warnings.map(w => `<p class="warn">${esc(w)}</p>`).join('')}</section>`;
  const order = key => { const i = MAIN.indexOf(key); return i < 0 ? 99 : i; };
  const rows = [...c.measurements].sort((x, y) => order(x.key) - order(y.key)).map(m => {
    const rule = RULE[m.key];
    return `<tr class="${m.level === 'major' || m.level === 'minor' ? 'out' : ''}"><th>${label(m.key, rule || { unit: m.unit })}</th>
<td class="n">${esc(normText(m.key, rule, patient.sex))}</td>
<td class="v">${value(m.a, m.unit, m.key)}</td><td class="v">${value(m.b, m.unit, m.key)}</td>
<td class="v">${Number.isFinite(m.delta) ? signed(m.delta, m.unit === 'мВ' ? 2 : m.unit === '%' ? 1 : 0) + (m.unit === '°' ? '°' : '') : '—'}</td>
<td class="f">${m.level === 'major' ? '▲ ' : ''}${esc(LEVEL_TEXT[m.level] || '')}${m.key === 'QRS_axis' && eos(m.a) !== eos(m.b) ? ` (${esc(eos(m.a))} → ${esc(eos(m.b))})` : ''}</td></tr>`;
  }).join('');
  if (rows) body += `<section class="block"><h2>Измерения</h2><table class="meas wide"><thead><tr><th>Показатель</th><th class="n">Норма</th><th class="v">ЭКГ 1</th><th class="v">ЭКГ 2</th><th class="v">Разница</th><th>Различие</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  // Page 1 is the summary with the doctor's conclusion; the curves follow on the next pages.
  // Fewer lines when the summary is long, so the conclusion stays on this page.
  body += conclusion(ctx.lines ?? Math.max(3, 6 - Math.floor(c.highlights.length / 5)));
  const legend = `<span class="key-now"></span> ЭКГ 2 (${esc(d2)}) &nbsp; <span class="key-before"></span> ЭКГ 1 (${esc(d1)})`;
  const scoreRows = c.scores.filter(s => !ctx.model || ctx.model === 'all' || ctx.model === s.model)
    .flatMap(s => s.changes.slice(0, 4).map(x => `<li>${esc(MODEL_NAMES[s.model] || s.modelName)}: «${esc(ctx.labelsRu?.[x.label] || x.label)}» ${num(x.a, 2)} → ${num(x.b, 2)}${x.crossed ? ' (пересекла порог)' : ''}</li>`));
  const scores = scoreRows.length ? `<section class="block ai"><h2>Изменения оценок нейросетей — справочно</h2><ul>${scoreRows.join('')}</ul></section>` : '';
  const pages = [body];
  if (c.waveform.available || scores) {
    let shape = runhead(patient, 'Сравнение ЭКГ · форма комплексов');
    if (c.waveform.available) {
      const beats = Math.min(c.waveform.beatsA, c.waveform.beatsB);
      shape += `<section class="block ecg-block"><h2>Средний комплекс по отведениям</h2>${overlaySvg(c.waveform)}
<p class="small">${legend} · 50 мм/с · 10 мм/мВ · сходство формы: 1 — одинаковая (по ${beats} комплексам — ориентировочно); ▲ умеренное, ▲▲ выраженное различие формы</p></section>`;
    }
    pages.push(shape + scores);
  }
  // Both full tracings in the order of the table (ЭКГ 1 above ЭКГ 2), so the doctor compares the originals.
  const tracings = [[c.older, 'ЭКГ 1'], [c.newer, 'ЭКГ 2']].filter(([rec]) => hasSignal(rec));
  if (tracings.length) {
    pages.push(runhead(patient, 'Сравнение ЭКГ · записи') + tracings.map(([rec, name]) =>
      `<section class="block ecg-block"><h2>${name} от ${esc(fmtDate(rec.recordedAt, true))}</h2>${stripSvg(rec, 17)}<p class="small">${esc(settingsLine(rec))}</p></section>`).join(''));
  }
  return document_(`Сравнение ЭКГ ${fullName(patient)}`, pages, patient, printedAt);
}

// Monochrome first: black text and traces, light grey grid, emphasis by weight and symbols.
const CSS = `
@page{size:A4 portrait;margin:8mm 10mm}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#e6e6e3;color:#000;font:10pt/1.28 "Segoe UI",Roboto,"PT Sans",Arial,"Noto Sans",sans-serif}
.sheet{width:210mm;min-height:297mm;margin:8mm auto;padding:8mm 10mm;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.2);display:flex;flex-direction:column}
.foot{margin-top:auto;padding-top:1.2mm;display:flex;justify-content:space-between;gap:6mm;font-size:7pt;border-top:.2mm solid #000}
.foot span:last-child{white-space:nowrap}
@media print{
  body{background:#fff}
  .sheet{width:auto;min-height:280mm;margin:0;padding:0;box-shadow:none;break-after:page}
  .sheet:last-child{break-after:auto}
}
h1{font-size:13pt;margin:0;letter-spacing:.03em;text-transform:uppercase}
h2{font-size:9pt;margin:0 0 1.6mm;text-transform:uppercase;letter-spacing:.07em}
h3{font-size:9pt;margin:1.6mm 0 .6mm}
.head>*,.cols2>*,.duo>*{min-width:0}
.name,.facts,.when,.runhead,li,td,th,p{overflow-wrap:anywhere}
.head{border-bottom:.5mm solid #000;padding-bottom:2.5mm;margin-bottom:3.5mm;display:grid;grid-template-columns:1fr auto;gap:1mm 6mm;align-items:end}
.title{grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline}
.brand{font-size:8pt;letter-spacing:.1em}
.name{font-size:12pt;font-weight:700}
.when{text-align:right;font-size:9pt;line-height:1.4}
.k{margin-right:1.5mm;font-size:8pt}
.runhead{display:flex;gap:2mm;font-size:8pt;border-bottom:.2mm solid #000;padding-bottom:1mm;margin-bottom:3mm}
.runhead span{margin-left:auto}
.block{margin-bottom:2.5mm;break-inside:avoid}
.cols2{display:grid;grid-template-columns:1fr 1fr;gap:6mm}
table.meas{width:100%;border-collapse:collapse;font-size:9pt;font-variant-numeric:tabular-nums}
.meas th,.meas td{padding:.35mm 1mm;border-bottom:.15mm solid #000;text-align:left;font-weight:400;vertical-align:baseline}
.meas thead th{font-size:7.5pt;border-bottom:.3mm solid #000;padding-top:0}
.meas .unit{font-size:7.5pt}
.meas .v{text-align:right;white-space:nowrap}
.meas .n{font-size:8pt;white-space:nowrap}
.meas .f{font-size:8pt}
.meas tr.out td.v,.meas tr.out .f{font-weight:700}
.rhythm{font-size:8.5pt;margin:1.2mm 0 0}
.paper{display:block;margin:0;max-width:100%;height:auto;border:.25mm solid #000;overflow:hidden}
.paper .g1{stroke:#f4cccc;stroke-width:.12;fill:none;shape-rendering:crispEdges}
.paper .g5{stroke:#e59999;stroke-width:.2;fill:none;shape-rendering:crispEdges}
.paper .ecg{stroke:#000;stroke-width:.3;fill:none;stroke-linejoin:round;stroke-linecap:round}
.paper .ecg.before{stroke-width:.22;stroke-dasharray:1.2 .9}
.paper .cal,.paper .sep{stroke:#000;stroke-width:.3;fill:none}
.paper text{font-family:"Segoe UI",Roboto,"PT Sans",Arial,sans-serif;fill:#000;paint-order:stroke;stroke:#fff;stroke-width:.9px;stroke-linejoin:round}
.paper .lead{font-size:2.9px;font-weight:700}
.paper .corr{font-size:2.5px}
.paper .corr.hit{font-weight:700}
.small{font-size:7.5pt;margin:1.2mm 0 0;line-height:1.3}
.lead-line{font-weight:700;margin:0 0 1mm}
ul{margin:0;padding-left:5mm}
li{margin:.4mm 0}
ul.tight{font-size:9pt}
.warn{font-size:8pt;border-left:.7mm solid #000;padding:.3mm 0 .3mm 2mm;margin:1.2mm 0}
.ai{border-top:.2mm solid #000;padding-top:1.5mm;font-size:8.5pt}
.ai .models{display:grid;grid-template-columns:repeat(auto-fit,minmax(55mm,1fr));gap:1mm 5mm}
.ai .small{margin:0 0 1mm}
.ai .model ul{padding-left:4mm}
.key-before,.key-now{display:inline-block;width:9mm;vertical-align:middle;border-top:.35mm solid #000}
.key-before{border-top:.3mm dashed #000}
.concl{margin:auto 0 1mm;break-inside:avoid;border:.3mm solid #000;padding:2mm 4mm 2mm}
.concl .prompts,.sign{display:flex;gap:6mm;font-size:9pt}
.concl .prompts{margin:1mm 0 0}
.concl .prompts span,.sign span{display:flex;align-items:flex-end;gap:1.5mm;flex:1;white-space:nowrap}
.concl i{flex:1;border-bottom:.15mm solid #000;height:6mm}
.concl i.short{flex:.6}
.concl i.tiny{flex:0 0 6mm}
.concl .lines div{height:7.5mm;border-bottom:.15mm solid #000}
.sign{margin-top:4mm}
.sign-hint{display:flex;gap:6mm;font-size:6.5pt}
.sign-hint span{flex:1;text-align:center}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:5mm;align-items:start}
.duo .ai .models{grid-template-columns:1fr}
`;
