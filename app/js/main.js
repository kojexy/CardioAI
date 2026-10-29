// CardioAI single-page app: patients, ECG history, serial comparison.
import { LEADS, ASSUMED, parseECG301, sha256Hex } from './ecg301.js';
import { deriveMeasurements, ageAt } from './measure.js';
import { compareRecords, autoComparisons, trend, sustainedTrends, rangeStatus, normalRange, LEVEL_TEXT } from './compare.js';
import { RULES, MEASURE_LABELS } from './rules.js';
import { openStore, newId, exportAll, importAll } from './store.js';
import { trendChart, beatOverlay, stripChart } from './charts.js';
import { toMillivolts } from './signal.js';
import { saveFile, readFile } from './files.js';

const state = { store: null, status: null, labelsRu: {}, thresholds: {} };
const view = document.getElementById('view');

// ---------- small DOM helpers (textContent only; never innerHTML with user data)
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}
const card = (...c) => h('section', { class: 'card' }, ...c);
const pill = level => h('span', { class: 'pill lvl-' + level }, LEVEL_TEXT[level]);
const notice = text => h('div', { class: 'notice' }, text);
// replaceChildren() would print null/false as text; skip empty parts like h() does.
const fill = (el, ...c) => el.replaceChildren(...c.flat().filter(x => x != null && x !== false));
const DISCLAIMER = 'Исследовательская программа. Результаты — технические оценки, а не диагноз. Решение принимает врач.';

function fmtDate(iso, withTime = false) {
  if (!iso) return 'дата не указана';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) +
    (withTime ? ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
}
function fmtPeriod(days) {
  if (days === null || days === undefined) return '';
  if (days < 1) return 'в тот же день';
  if (days < 45) return `через ${days} дн.`;
  const months = Math.round(days / 30.44);
  return months < 18 ? `через ${months} мес.` : `через ${(days / 365.25).toFixed(1)} г.`;
}
function fullName(p) { return [p.surname, p.name, p.middleName].filter(Boolean).join(' ') || 'Без имени'; }
function normalizeDate(v) { return v && v.length === 16 ? v + ':00' : v || null; }
function val(v, unit) {
  if (!Number.isFinite(v)) return '—';
  return (Number.isInteger(v) ? v : Math.round(v * 100) / 100) + (unit === '°' ? '°' : unit ? ' ' + unit : '');
}
function logitMargin(p, t) {
  const lg = x => { const q = Math.min(0.999, Math.max(0.001, x)); return Math.log(q / (1 - q)); };
  return lg(p) - lg(t);
}
function labelRu(label) { return state.labelsRu[label] ? `${state.labelsRu[label]} (${label})` : label; }
async function confirmAction(text) { return window.confirm(text); }
function sortByDate(records) { return [...records].sort((a, b) => (b.recordedAt || '').localeCompare(a.recordedAt || '')); }

// ---------- record creation
async function recordFromECG301(buffer, fileName) {
  const parsed = parseECG301(buffer);
  return {
    id: newId(), source: 'ecg301', fileName, sha256: await sha256Hex(buffer), deviceRecordId: parsed.recordId,
    recordedAt: parsed.recordedAt, device: parsed.device, measurements: deriveMeasurements(parsed.device),
    signal: { block: 'B', fs: ASSUMED.fsB, leads: parsed.blocks.B,
      calibration: { microvoltsPerCount: ASSUMED.microvoltsPerCount, zeroCounts: ASSUMED.zeroCounts, verified: false } },
    checks: parsed.checks, ai: {}, createdAt: new Date().toISOString(),
  };
}

const MODEL_KEYS = { 'heartwise/EfficientNetV2_77_Classes': 'efficientnet', 'heartwise/WCR_77_Classes': 'wcr', 'PKUDigitalHealth/ECGFounder': 'ecgfounder' };
const MODEL_NAMES = { efficientnet: 'DeepECG SL (EfficientNetV2)', wcr: 'DeepECG SSL (WCR)', ecgfounder: 'ECGFounder' };
function aiEntry(report, extra = {}) {
  if (!report || typeof report.scores !== 'object') throw Error('В файле нет оценок модели (поле scores)');
  const key = MODEL_KEYS[report.model] || String(report.model || 'model');
  const weightsSha = report.weights?.sha256 || report.weights?.finetuned?.sha256 || null;
  // Older reports have no thresholds: on the desktop take them from the installed upstream.
  const thresholds = report.thresholds || (Object.keys(state.thresholds[key] || {}).length ? state.thresholds[key] : null);
  return [key, { model: MODEL_NAMES[key] || report.model, scores: report.scores, thresholds, thresholdSource: report.threshold_source || (thresholds ? 'DeepECG_Docker 77_tasks_final.json' : null), ranges: report.ranges, weightsSha,
    synthetic: report.synthetic_test === true, attachedAt: new Date().toISOString(), ...extra }];
}

// ---------- views
async function viewPatients() {
  const patients = await state.store.listPatients();
  const counts = new Map();
  for (const p of patients) {
    const records = await state.store.listRecords(p.id);
    counts.set(p.id, { n: records.length, last: sortByDate(records)[0]?.recordedAt });
  }
  const list = h('div', { class: 'grid' });
  const search = h('input', { type: 'search', placeholder: 'Поиск по фамилии или имени', 'aria-label': 'Поиск пациента' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = patients.filter(p => fullName(p).toLowerCase().includes(q))
      .sort((a, b) => fullName(a).localeCompare(fullName(b), 'ru'));
    list.replaceChildren(...shown.map(p => {
      const c = counts.get(p.id), age = ageAt(p.birthDate);
      return h('a', { class: 'patient', href: '#/patient/' + p.id }, h('b', {}, fullName(p)),
        h('span', { class: 'muted' }, [age !== null ? age + ' лет' : null, `ЭКГ: ${c.n}`, c.last ? 'последняя ' + fmtDate(c.last) : null].filter(Boolean).join(' · ')));
    }));
    if (!shown.length) list.append(h('p', { class: 'muted' }, patients.length ? 'Никого не найдено.' : 'Пациентов пока нет. Добавьте первого.'));
  };
  search.oninput = draw;
  draw();
  view.replaceChildren(h('h1', {}, 'Пациенты'), card(search, h('div', { style: 'margin-top:12px' }, list)),
    card(h('h2', {}, 'Новый пациент'), patientForm({}, async p => { await state.store.savePatient(p); location.hash = '#/patient/' + p.id; })));
}

function patientForm(p, onSave) {
  const f = {
    surname: h('input', { value: p.surname || '', required: true, autocomplete: 'off' }),
    name: h('input', { value: p.name || '', autocomplete: 'off' }),
    middleName: h('input', { value: p.middleName || '', autocomplete: 'off' }),
    birthDate: h('input', { type: 'date', value: p.birthDate || '' }),
    sex: h('select', {}, h('option', { value: '' }, 'не указан'), h('option', { value: 'M' }, 'мужской'), h('option', { value: 'F' }, 'женский')),
    notes: h('textarea', { rows: 2 }, p.notes || ''),
  };
  f.sex.value = p.sex || '';
  const msg = h('p', { role: 'status' });
  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    if (!f.surname.value.trim()) { msg.className = 'error'; msg.textContent = 'Укажите фамилию'; return; }
    try {
      await onSave({ ...p, id: p.id || newId(), surname: f.surname.value.trim(), name: f.name.value.trim(),
        middleName: f.middleName.value.trim(), birthDate: f.birthDate.value || null, sex: f.sex.value || null,
        notes: f.notes.value.trim(), createdAt: p.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    } catch (err) { msg.className = 'error'; msg.textContent = err.message; }
  } },
  h('div', { class: 'grid' }, h('label', {}, 'Фамилия', f.surname), h('label', {}, 'Имя', f.name), h('label', {}, 'Отчество', f.middleName),
    h('label', {}, 'Дата рождения', f.birthDate), h('label', {}, 'Пол (для норм QTc)', f.sex)),
  h('label', {}, 'Заметки', f.notes), h('button', { class: 'primary', type: 'submit' }, 'Сохранить'), msg);
  return form;
}

async function loadPatient(id) {
  const patients = await state.store.listPatients();
  const patient = patients.find(p => p.id === id);
  if (!patient) throw Error('Пациент не найден');
  return { patient, records: sortByDate(await state.store.listRecords(id)) };
}

async function viewPatient(id) {
  const { patient, records } = await loadPatient(id);
  const age = ageAt(patient.birthDate);
  const edit = h('div', { class: 'hidden' }, patientForm(patient, async p => { await state.store.savePatient(p); route(); }));
  const head = card(
    h('h1', {}, fullName(patient)),
    h('p', { class: 'muted' }, [patient.birthDate ? 'родился(ась) ' + fmtDate(patient.birthDate) : null, age !== null ? age + ' лет' : null,
      { M: 'мужской', F: 'женский' }[patient.sex], `ЭКГ в истории: ${records.length}`].filter(Boolean).join(' · ')),
    patient.notes ? h('p', {}, patient.notes) : null,
    h('div', { class: 'row no-print' },
      h('button', { onclick: () => edit.classList.toggle('hidden') }, 'Изменить данные'),
      h('button', { class: 'danger', onclick: async () => {
        if (!await confirmAction(`Удалить пациента «${fullName(patient)}» и все его ЭКГ (${records.length})? Это нельзя отменить.`)) return;
        await state.store.deletePatient(patient.id); location.hash = '#/patients';
      } }, 'Удалить пациента')),
    edit);

  const parts = [h('p', { class: 'no-print' }, h('a', { href: '#/patients' }, '← Все пациенты')), head, addRecordCard(patient, records)];

  const auto = autoComparisons(records, patient.sex);
  if (auto.previous) {
    const tabs = h('div', { class: 'tabs' }), body = h('div');
    const options = [['previous', 'Последняя и предыдущая'], ...(auto.baseline ? [['baseline', 'Последняя и самая первая']] : [])];
    const show = key => {
      for (const b of tabs.children) b.classList.toggle('on', b.dataset.key === key);
      const c = auto[key];
      body.replaceChildren(comparisonView(c, patient, { compact: true }),
        h('p', {}, h('a', { href: `#/compare/${patient.id}/${c.older.id}/${c.newer.id}` }, 'Открыть подробное сравнение →')));
    };
    for (const [key, label] of options) tabs.append(h('button', { 'data-key': key, onclick: () => show(key) }, label));
    parts.push(card(h('h2', {}, 'Автоматическое сравнение'), tabs, body));
    show('previous');
  } else if (records.length === 1) {
    parts.push(card(h('h2', {}, 'Автоматическое сравнение'), h('p', { class: 'muted' }, 'Сравнение появится после второй ЭКГ этого пациента.')));
  }

  const keys = ['QTcF_ms', 'QTc_ms', 'heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QRS_axis', 'sokolow_mV', 'RR_cv_pct'];
  const charts = keys.map(k => [k, trend(records, k)]).filter(([, pts]) => pts.length >= 2)
    .map(([k, pts]) => trendChart(pts, { label: MEASURE_LABELS[k].label, unit: MEASURE_LABELS[k].unit, range: normalRange(MEASURE_LABELS[k], patient.sex) }));
  const sustained = sustainedTrends(records);
  if (charts.length) parts.push(card(h('h2', {}, 'Динамика показателей'),
    sustained.length ? h('ul', {}, sustained.map(t => h('li', {}, pill('minor'), ` ${t.label}: устойчиво ${t.direction === 'up' ? 'растёт' : 'снижается'} ${t.points - 1} раза подряд, всего ${t.total > 0 ? '+' : ''}${val(t.total, t.unit)}`))) : null,
    h('p', { class: 'muted' }, 'Зелёная полоса — ориентировочная норма для взрослых.'), h('div', { class: 'charts' }, charts)));

  parts.push(recordsTable(patient, records));
  parts.push(notice(DISCLAIMER));
  view.replaceChildren(...parts);
}

function recordsTable(patient, records) {
  if (!records.length) return card(h('h2', {}, 'История ЭКГ'), h('p', { class: 'muted' }, 'Записей пока нет.'));
  const chosen = new Set();
  const compareBtn = h('button', { class: 'primary', disabled: true, onclick: () => {
    const [a, b] = [...chosen];
    location.hash = `#/compare/${patient.id}/${a}/${b}`;
  } }, 'Сравнить две отмеченные');
  const cols = ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTcF_ms', 'QRS_axis'];
  const rows = records.map(r => {
    const box = h('input', { type: 'checkbox', 'aria-label': 'Выбрать для сравнения', onchange: e => {
      e.target.checked ? chosen.add(r.id) : chosen.delete(r.id);
      compareBtn.disabled = chosen.size !== 2;
    } });
    return h('tr', {}, h('td', {}, box), h('td', {}, h('a', { href: `#/record/${patient.id}/${r.id}` }, fmtDate(r.recordedAt, true)), r.isBaseline ? h('span', { class: 'pill lvl-none', style: 'margin-left:6px' }, 'исходная') : null),
      h('td', {}, { ecg301: 'файл прибора', manual: 'вручную', import: 'импорт' }[r.source] || r.source),
      cols.map(k => {
        const v = r.measurements?.[k], st = rangeStatus(v, MEASURE_LABELS[k], patient.sex);
        return h('td', { class: 'num' + (st && st !== 'normal' ? ' st-' + st : '') }, val(v));
      }),
      h('td', {}, Object.keys(r.ai || {}).length ? Object.keys(r.ai).length + ' мод.' : '—'));
  });
  return card(h('h2', {}, 'История ЭКГ'), h('p', { class: 'muted' }, 'Отметьте две записи, чтобы сравнить их между собой.'),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Дата'), h('th', {}, 'Источник'), cols.map(k => h('th', { class: 'num' }, MEASURE_LABELS[k].label)), h('th', {}, 'ИИ'))),
      h('tbody', {}, rows))),
    h('div', { class: 'row', style: 'margin-top:12px' }, compareBtn));
}

function addRecordCard(patient, records) {
  const msg = h('p', { role: 'status' });
  const say = (text, bad) => { msg.className = bad ? 'error' : 'success'; msg.textContent = text; };
  const save = async record => {
    record.patientId = patient.id;
    if (record.sha256 && records.some(r => r.sha256 === record.sha256)) throw Error('Этот файл уже есть в истории пациента');
    await state.store.saveRecord(record);
    route();
  };
  // ECG301 file
  const file = h('input', { type: 'file' }), fileDate = h('input', { type: 'datetime-local' }), fileNotes = h('input', { placeholder: 'например: после нагрузки' });
  let pending = null;
  file.onchange = async () => {
    pending = null;
    if (!file.files[0]) return;
    try {
      pending = await recordFromECG301(await readFile(file.files[0]), file.files[0].name);
      fileDate.value = (pending.recordedAt || '').slice(0, 16);
      say(`Файл прочитан: запись ${pending.deviceRecordId}. Проверьте дату и нажмите «Добавить».`);
    } catch (err) { say(err.message, true); }
  };
  const fileForm = h('div', {}, h('p', { class: 'muted' }, 'Исходный файл кардиографа ECG301 (без расширения). Дата берётся из номера записи.'),
    h('div', { class: 'grid' }, h('label', {}, 'Файл', file), h('label', {}, 'Дата и время записи', fileDate), h('label', {}, 'Заметка', fileNotes)),
    h('button', { class: 'primary', onclick: async () => {
      try {
        if (!pending) throw Error('Сначала выберите файл');
        await save({ ...pending, recordedAt: normalizeDate(fileDate.value) || pending.recordedAt, notes: fileNotes.value.trim() });
      } catch (err) { say(err.message, true); }
    } }, 'Добавить ЭКГ'));
  // Manual
  const manualKeys = ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTc_ms', 'P_axis', 'QRS_axis', 'T_axis', 'RV5_mV', 'SV1_mV'];
  const inputs = Object.fromEntries(manualKeys.map(k => [k, h('input', { type: 'number', step: 'any', inputmode: 'decimal' })]));
  const manualDate = h('input', { type: 'datetime-local' }), manualNotes = h('input', { placeholder: 'например: распечатка из поликлиники' });
  const manualForm = h('div', { class: 'hidden' }, h('p', { class: 'muted' }, 'Значения с бумажной ЭКГ или заключения. Пустые поля можно оставить.'),
    h('div', { class: 'grid' }, h('label', {}, 'Дата и время записи', manualDate),
      manualKeys.map(k => h('label', {}, `${MEASURE_LABELS[k].label}, ${MEASURE_LABELS[k].unit}`, inputs[k])), h('label', {}, 'Заметка', manualNotes)),
    h('button', { class: 'primary', onclick: async () => {
      try {
        if (!manualDate.value) throw Error('Укажите дату записи');
        const device = {};
        for (const k of manualKeys) if (inputs[k].value !== '') device[k] = Number(inputs[k].value);
        if (!Object.keys(device).length) throw Error('Введите хотя бы один показатель');
        await save({ id: newId(), source: 'manual', recordedAt: normalizeDate(manualDate.value), device, measurements: deriveMeasurements(device),
          ai: {}, notes: manualNotes.value.trim(), createdAt: new Date().toISOString() });
      } catch (err) { say(err.message, true); }
    } }, 'Добавить ЭКГ'));
  // Exported record JSON
  const jsonFile = h('input', { type: 'file', accept: '.json,application/json' });
  const jsonForm = h('div', { class: 'hidden' }, h('p', { class: 'muted' }, 'Запись, ранее выгруженная из CardioAI (кнопка «Скачать запись» на странице ЭКГ).'),
    h('label', {}, 'Файл JSON', jsonFile), h('button', { class: 'primary', onclick: async () => {
      try {
        if (!jsonFile.files[0]) throw Error('Выберите файл');
        const data = JSON.parse(new TextDecoder().decode(await readFile(jsonFile.files[0])));
        if (data.format !== 'cardioai-record' || !data.record?.measurements) throw Error('Это не файл записи CardioAI');
        await save({ ...data.record, id: newId(), source: 'import', createdAt: new Date().toISOString() });
      } catch (err) { say(err.message, true); }
    } }, 'Добавить ЭКГ'));
  const panes = { file: fileForm, manual: manualForm, json: jsonForm };
  const tabs = h('div', { class: 'tabs' }, [['file', 'Файл прибора'], ['manual', 'Ввести вручную'], ['json', 'Файл CardioAI']].map(([k, label]) =>
    h('button', { class: k === 'file' ? 'on' : '', 'data-k': k, onclick: e => {
      for (const b of tabs.children) b.classList.toggle('on', b === e.currentTarget);
      for (const [pk, pane] of Object.entries(panes)) pane.classList.toggle('hidden', pk !== k);
      msg.textContent = '';
    } }, label)));
  return card(h('h2', {}, 'Добавить ЭКГ'), tabs, fileForm, manualForm, jsonForm, msg);
}

async function viewRecord(pid, rid) {
  const { patient, records } = await loadPatient(pid);
  const record = records.find(r => r.id === rid);
  if (!record) throw Error('Запись не найдена');
  const rows = RULES.measurements.filter(m => Number.isFinite(record.measurements?.[m.key])).map(m => {
    const v = record.measurements[m.key], st = rangeStatus(v, m, patient.sex), range = normalRange(m, patient.sex);
    return h('tr', {}, h('td', {}, m.label), h('td', { class: 'num' + (st && st !== 'normal' ? ' st-' + st : '') }, val(v, m.unit)),
      h('td', { class: 'muted' }, range ? `${range[0]}…${range[1]}` : ''), h('td', {}, { low: 'ниже', high: 'выше', normal: 'норма' }[st] || ''));
  });
  const parts = [
    h('p', { class: 'no-print' }, h('a', { href: '#/patient/' + pid }, '← ' + fullName(patient))),
    card(h('h1', {}, 'ЭКГ ' + fmtDate(record.recordedAt, true)),
      h('p', { class: 'muted' }, [{ ecg301: 'Файл прибора ECG301', manual: 'Введено вручную', import: 'Импорт' }[record.source], record.deviceRecordId ? 'запись ' + record.deviceRecordId : null, record.fileName].filter(Boolean).join(' · ')),
      record.notes ? h('p', {}, record.notes) : null,
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Показатель'), h('th', { class: 'num' }, 'Значение'), h('th', {}, 'Норма (ориентир)'), h('th', {}))), h('tbody', {}, rows))),
      record.source === 'ecg301' ? notice('Значения прочитаны из файла прибора; назначение полей восстановлено по одной записи и не подтверждено производителем. QTc Фридеричиа и Базетта рассчитаны программой по QT и среднему RR.') : null),
  ];
  if (record.signal) {
    parts.push(card(h('h2', {}, 'Запись'), stripChart(toMillivolts(record.signal.leads, record.signal.calibration), record.signal.fs, LEADS),
      record.signal.calibration?.verified ? null : notice('Частота и масштаб в мВ — предварительная оценка по фото распечатки. Форма сигнала верна, абсолютные значения приблизительны.')));
  }
  parts.push(aiCard(patient, record));
  parts.push(card(h('h2', {}, 'Действия'), h('p', { class: 'muted' }, 'Исходные ЭКГ — записи в спокойном состоянии, с которыми сравниваются новые. Если отмечено несколько, берётся их среднее.'), h('div', { class: 'row' },
    h('button', { onclick: () => saveFile(JSON.stringify({ format: 'cardioai-record', version: 1, record: { ...record, patientId: undefined } }, null, 2),
      `ECG-${(record.recordedAt || 'record').slice(0, 10)}.json`, 'application/json') }, 'Скачать запись'),
    h('button', { onclick: () => window.print() }, 'Печать'),
    h('button', { onclick: async () => { record.isBaseline = !record.isBaseline; await state.store.saveRecord(record); route(); } },
      record.isBaseline ? 'Снять отметку «исходная»' : 'Отметить как исходную (базовую)'),
    h('button', { class: 'danger', onclick: async () => {
      if (!await confirmAction('Удалить эту ЭКГ из истории пациента?')) return;
      await state.store.deleteRecord(record.id); location.hash = '#/patient/' + pid;
    } }, 'Удалить ЭКГ'))));
  view.replaceChildren(...parts);
}

function aiCard(patient, record) {
  const box = card(h('h2', {}, 'Оценки нейросетей'));
  const msg = h('p', { role: 'status' });
  const attach = async (key, entry) => {
    record.ai = { ...(record.ai || {}), [key]: entry };
    await state.store.saveRecord(record);
    route();
  };
  const entries = Object.entries(record.ai || {});
  if (!entries.length) box.append(h('p', { class: 'muted' }, 'К этой ЭКГ пока не прикреплены результаты моделей.'));
  for (const [key, entry] of entries) {
    const t = entry.thresholds || null;
    // With the authors' operating points: show labels above them, ordered by margin (logit).
    const ranked = t
      ? Object.entries(entry.scores).filter(([l]) => t[l]).map(([l, v]) => [l, v, logitMargin(v, t[l])]).sort((a, b) => b[2] - a[2])
      : Object.entries(entry.scores).sort((a, b) => b[1] - a[1]).map(([l, v]) => [l, v, null]);
    const above = t ? ranked.filter(r => r[2] > 0) : ranked.slice(0, 10);
    box.append(h('h3', {}, entry.model || key),
      entry.synthetic ? notice('Это технический тест на искусственном сигнале, а не оценка этой ЭКГ.') : null,
      t ? h('p', { class: 'muted' }, `Выше рабочего порога авторов модели: ${above.length} из ${ranked.length}. Порог — баланс чувствительности и специфичности на данных авторов, не на ECG301.`)
        : notice('Для этой модели нет опубликованных порогов: сырые оценки 0–1 нельзя читать как «есть/нет».'),
      above.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Метка'), h('th', { class: 'num' }, 'Оценка'), t ? h('th', { class: 'num' }, 'Порог') : null, t ? h('th', { class: 'num' }, 'Запас (логит)') : null)),
        h('tbody', {}, above.slice(0, 15).map(([label, v, m]) => h('tr', {}, h('td', {}, labelRu(label)), h('td', { class: 'num' }, v.toFixed(3)),
          t ? h('td', { class: 'num' }, String(t[label])) : null, t ? h('td', { class: 'num' }, (m > 0 ? '+' : '') + m.toFixed(1)) : null)))) : h('p', {}, 'Ни одна метка не превышает порог.'),
      h('details', {}, h('summary', {}, `Все оценки (${Object.keys(entry.scores).length})`),
        h('div', { class: 'scroll', style: 'max-height:360px' }, h('table', {}, h('tbody', {},
          Object.entries(entry.scores).sort((a, b) => b[1] - a[1]).map(([label, v]) => h('tr', {}, h('td', {}, labelRu(label)), h('td', { class: 'num' }, v.toFixed(4)))))))),
      h('button', { class: 'danger no-print', onclick: async () => {
        const ai = { ...record.ai }; delete ai[key]; record.ai = ai; await state.store.saveRecord(record); route();
      } }, 'Открепить'));
  }
  const jsonFile = h('input', { type: 'file', accept: '.json,application/json' });
  const controls = h('div', { class: 'no-print' }, h('h3', {}, 'Прикрепить результат'),
    h('label', {}, 'Файл результата модели (JSON из модуля «Анализ ИИ»)', jsonFile),
    h('button', { onclick: async () => {
      try {
        if (!jsonFile.files[0]) throw Error('Выберите файл');
        const [key, entry] = aiEntry(JSON.parse(new TextDecoder().decode(await readFile(jsonFile.files[0]))), { fileName: jsonFile.files[0].name });
        await attach(key, entry);
      } catch (err) { msg.className = 'error'; msg.textContent = err.message; }
    } }, 'Прикрепить файл'));
  if (state.status) {
    const select = h('select', {}, h('option', { value: '' }, 'Загрузка…'));
    fetch('/api/history').then(r => r.json()).then(jobs => {
      const done = jobs.filter(j => j.state === 'complete');
      select.replaceChildren(h('option', { value: '' }, done.length ? 'Выберите расчёт' : 'Готовых расчётов нет'),
        ...done.map(j => h('option', { value: j.id }, `${MODEL_NAMES[j.model] || j.model} · ${fmtDate(j.created_at, true)}${j.synthetic ? ' · тест' : ''}`)));
    }).catch(() => select.replaceChildren(h('option', { value: '' }, 'История недоступна')));
    controls.append(h('label', {}, 'Или расчёт из истории этого компьютера', select), h('button', { onclick: async () => {
      try {
        if (!select.value) throw Error('Выберите расчёт');
        const job = await (await fetch('/api/jobs/' + select.value)).json();
        const [key, entry] = aiEntry(job.report, { jobId: job.id });
        await attach(key, entry);
      } catch (err) { msg.className = 'error'; msg.textContent = err.message; }
    } }, 'Прикрепить расчёт'));
  }
  box.append(controls, msg, h('p', { class: 'muted' }, 'Оценки 0–1 — сырые выходы моделей, не вероятность болезни.'));
  return box;
}

function comparisonView(c, patient, { compact = false } = {}) {
  const sex = patient?.sex;
  const ok = !c.counts.major && !c.counts.minor && !c.leadsChanged.length && (c.measurements.length || c.waveform.available);
  const out = h('div', {},
    h('p', { class: 'headline' + (ok ? ' ok' : '') }, c.headline),
    h('p', { class: 'muted' }, `${fmtDate(c.older.recordedAt)} → ${fmtDate(c.newer.recordedAt)} ${fmtPeriod(c.days)}`));
  if (c.highlights.length) out.append(h('ul', {}, c.highlights.map(m => h('li', {}, pill(m.level), ' ', m.text))));
  for (const w of c.warnings) out.append(notice(w));
  const rows = c.measurements.filter(m => !compact || m.level !== 'none').map(m => h('tr', {},
    h('td', {}, m.label), h('td', { class: 'num' + (m.statusA && m.statusA !== 'normal' ? ' st-' + m.statusA : '') }, val(m.a, m.unit)),
    h('td', { class: 'num' + (m.statusB && m.statusB !== 'normal' ? ' st-' + m.statusB : '') }, val(m.b, m.unit)),
    h('td', { class: 'num' }, (m.delta > 0 ? '↑ +' : m.delta < 0 ? '↓ ' : '') + val(m.delta, m.unit)), h('td', {}, pill(m.level))));
  if (rows.length) out.append(h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Показатель'), h('th', { class: 'num' }, 'Раньше'), h('th', { class: 'num' }, 'Сейчас'), h('th', { class: 'num' }, 'Изменение'), h('th', {}, 'Оценка'))),
    h('tbody', {}, rows))));
  else if (compact && c.measurements.length) out.append(h('p', { class: 'muted' }, 'Все показатели в пределах обычной погрешности измерения.'));

  if (!compact) {
    const w = c.waveform;
    out.append(h('h3', {}, 'Форма комплексов (средний комплекс по каждому отведению)'));
    if (w.available) {
      out.append(h('p', { class: 'legend muted' }, `Комплексов: ${w.beatsA} и ${w.beatsB}. Средняя корреляция формы ${w.meanCorrelation}.`,
        h('span', { style: 'background:var(--a)' }), 'раньше', h('span', { style: 'background:var(--b)' }), 'сейчас'),
      beatOverlay(w, LEADS),
      h('details', {}, h('summary', {}, 'Таблица по отведениям'), h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Отведение'), h('th', { class: 'num' }, 'Корреляция'), h('th', { class: 'num' }, 'Амплитуда сейчас / раньше'), h('th', { class: 'num' }, 'ST, Δ мВ*'), h('th', { class: 'num' }, 'T, Δ мВ*'), h('th', {}, 'Форма'))),
        h('tbody', {}, w.leads.map(l => h('tr', {}, h('td', {}, l.lead + (l.noisy ? ' (шум)' : '')), h('td', { class: 'num' }, l.correlation.toFixed(3)), h('td', { class: 'num' }, l.amplitudeRatio ?? '—'),
          h('td', { class: 'num' }, l.stDiff_mV), h('td', { class: 'num' }, l.tDiff_mV), h('td', {}, pill(l.level)))))))),
      h('p', { class: 'muted' }, '* Масштаб в мВ для файлов ECG301 приблизителен. Изменение формы может быть вызвано положением электродов — проверяйте наложение.'));
    } else out.append(h('p', { class: 'muted' }, w.reason));

    out.append(h('h3', {}, 'Оценки нейросетей'));
    if (!c.scores.length) out.append(h('p', { class: 'muted' }, 'Для сравнения нужны результаты одной и той же модели на обеих ЭКГ.'));
    for (const s of c.scores) {
      out.append(h('p', {}, h('b', {}, s.modelName), s.synthetic ? ' — внимание: есть искусственный тест' : ''));
      if (!s.changes.length) { out.append(h('p', { class: 'muted' }, 'Существенных изменений оценок нет.')); continue; }
      if (!s.sameWeights) out.append(notice('Версии весов модели на двух ЭКГ различаются — оценки сравнивать нельзя.'));
      out.append(h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, s.changes.map(x => h('tr', {}, h('td', {}, labelRu(x.label)),
        h('td', { class: 'num' }, `${x.a.toFixed(2)} → ${x.b.toFixed(2)}`),
        h('td', {}, [x.crossed ? (x.b > x.a ? `стала выше порога ${x.threshold}` : `стала ниже порога ${x.threshold}`) : null, x.concordant ? 'та же метка так же изменилась в другой модели' : 'только эта модель'].filter(Boolean).join('; ')),
        h('td', {}, pill(x.level))))))));
    }
    if (c.concordant.length) out.append(h('p', {}, h('b', {}, 'Согласованные изменения (SL и SSL, одна и та же метка): '), c.concordant.map(g => `${labelRu(g.label)} ${g.direction === 'up' ? '↑' : '↓'}`).join(', ')),
      h('p', { class: 'muted' }, 'SL и SSL обучены на общих данных, поэтому их согласие — не полностью независимое подтверждение.'));
    out.append(notice('Оценки моделей не откалиброваны как вероятности; небольшие колебания между записями нормальны. В итог выносятся только изменения, в которых согласны хотя бы две модели. ' + DISCLAIMER));
    out.append(h('details', {}, h('summary', {}, 'Правила сравнения и источники'), h('div', { class: 'scroll' }, h('table', {}, h('tbody', {},
      RULES.measurements.map(r => h('tr', {}, h('td', {}, r.label), h('td', { class: 'muted' }, `шум <${r.noise}, заметно ≥${r.minor}, значимо ≥${r.major} ${r.unit}`),
        h('td', { class: 'muted' }, (r.basis === 'source' ? 'по источнику' : 'практический выбор') + (r.ref ? ': ' + r.ref : ''))))))),
      h('p', { class: 'muted' }, RULES.waveform.ref)));
  }
  return out;
}

async function viewCompare(pid, a, b) {
  if (pid && a && b) {
    const { patient, records } = await loadPatient(pid);
    const ra = records.find(r => r.id === a), rb = records.find(r => r.id === b);
    if (!ra || !rb) throw Error('Запись не найдена');
    const c = compareRecords(ra, rb, { sex: patient.sex });
    view.replaceChildren(h('p', { class: 'no-print' }, h('a', { href: '#/patient/' + pid }, '← ' + fullName(patient))),
      card(h('h1', {}, 'Сравнение ЭКГ · ' + fullName(patient)), comparisonView(c, patient),
        h('div', { class: 'row no-print', style: 'margin-top:12px' }, h('button', { onclick: () => window.print() }, 'Печать'),
          h('button', { onclick: () => saveFile(JSON.stringify(stripTemplates(c), null, 2), 'ECG-comparison.json', 'application/json') }, 'Скачать JSON'))));
    return;
  }
  // Pick from a patient, or compare two files without saving.
  const patients = (await state.store.listPatients()).sort((x, y) => fullName(x).localeCompare(fullName(y), 'ru'));
  const pSel = h('select', {}, h('option', { value: '' }, patients.length ? 'Выберите пациента' : 'Пациентов пока нет'), patients.map(p => h('option', { value: p.id }, fullName(p))));
  const aSel = h('select', {}), bSel = h('select', {});
  pSel.onchange = async () => {
    const recs = pSel.value ? sortByDate(await state.store.listRecords(pSel.value)) : [];
    const opts = () => recs.map(r => h('option', { value: r.id }, fmtDate(r.recordedAt, true)));
    aSel.replaceChildren(...opts()); bSel.replaceChildren(...opts());
    if (recs.length > 1) { aSel.selectedIndex = 1; bSel.selectedIndex = 0; }
  };
  const fa = h('input', { type: 'file' }), fb = h('input', { type: 'file' });
  const sex = h('select', {}, h('option', { value: '' }, 'не указан'), h('option', { value: 'M' }, 'мужской'), h('option', { value: 'F' }, 'женский'));
  const out = h('div'), msg = h('p', { role: 'status', class: 'error' });
  const loadAny = async file => {
    const buffer = await readFile(file);
    if (buffer.byteLength !== 39381) {
      const data = JSON.parse(new TextDecoder().decode(buffer));
      if (data.format === 'cardioai-record') return data.record;
    }
    return recordFromECG301(buffer, file.name);
  };
  view.replaceChildren(h('h1', {}, 'Сравнение двух ЭКГ'),
    card(h('h2', {}, 'Из истории пациента'), h('div', { class: 'grid' }, h('label', {}, 'Пациент', pSel), h('label', {}, 'Первая ЭКГ', aSel), h('label', {}, 'Вторая ЭКГ', bSel)),
      h('button', { class: 'primary', onclick: () => {
        if (!pSel.value || !aSel.value || !bSel.value || aSel.value === bSel.value) { msg.textContent = 'Выберите пациента и две разные ЭКГ'; return; }
        location.hash = `#/compare/${pSel.value}/${aSel.value}/${bSel.value}`;
      } }, 'Сравнить')),
    card(h('h2', {}, 'Два файла без сохранения'), h('p', { class: 'muted' }, 'Файлы прибора ECG301 или записи CardioAI в JSON. Ничего не сохраняется.'),
      h('div', { class: 'grid' }, h('label', {}, 'Первая ЭКГ', fa), h('label', {}, 'Вторая ЭКГ', fb), h('label', {}, 'Пол (для норм QTc)', sex)),
      h('button', { class: 'primary', onclick: async () => {
        msg.textContent = '';
        try {
          if (!fa.files[0] || !fb.files[0]) throw Error('Выберите оба файла');
          const [ra, rb] = [await loadAny(fa.files[0]), await loadAny(fb.files[0])];
          if (ra.sha256 && ra.sha256 === rb.sha256) throw Error('Выбран один и тот же файл дважды');
          out.replaceChildren(card(comparisonView(compareRecords(ra, rb, { sex: sex.value || null }), { sex: sex.value || null })));
        } catch (err) { msg.textContent = err.message; }
      } }, 'Сравнить файлы')),
    msg, out);
}

function stripTemplates(c) {
  const w = { ...c.waveform };
  delete w.templateA; delete w.templateB;
  const brief = r => ({ recordedAt: r.recordedAt, source: r.source, deviceRecordId: r.deviceRecordId, measurements: r.measurements });
  return { format: 'cardioai-comparison', version: 1, ...c, older: brief(c.older), newer: brief(c.newer), waveform: w };
}

async function viewAI() {
  const parts = [h('h1', {}, 'Анализ ИИ')];
  if (state.status) {
    parts.push(setupCard());
  } else {
    parts.push(card(h('p', {}, 'В веб-версии и на Android нейросети не запускаются: модели весят около 3 ГБ и требуют компьютера.'),
      h('p', {}, 'Запустите расчёт в программе CardioAI для Windows или Mac, скачайте результат JSON и прикрепите его к ЭКГ пациента здесь.'),
      h('p', { class: 'muted' }, 'Профили пациентов, история и сравнение работают полностью и без компьютера.')));
  }
  parts.push(notice(DISCLAIMER));
  view.replaceChildren(...parts);
}

// Status and one-click install of the neural networks (desktop program only).
function setupCard() {
  const box = card(h('h2', {}, 'Нейросети на этом компьютере'), h('p', { class: 'muted' }, 'Проверка…'));
  const token = document.querySelector('meta[name="cardioai-token"]')?.content;
  let timer = null;
  const gb = v => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  const draw = st => {
    const m = st.models || {};
    const all = ['efficientnet', 'wcr', 'ecgfounder'].every(k => m[k]);
    // pip reports no progress: show a moving bar instead of a bar stuck at 0 %.
    const bar = h('progress', st.step === 'packages' && st.running ? { style: 'width:100%' } : { max: 1, value: st.progress || 0, style: 'width:100%' });
    const post = async path => {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ECG-Token': token }, body: '{}' });
      const data = await r.json();
      if (!r.ok) { draw({ ...st, error: data.error }); return; }
      draw(data); poll();
    };
    const button = h('button', { class: 'primary', disabled: st.running || !st.supported, onclick: () => { button.disabled = true; post('/api/setup/start'); } },
      all ? 'Переустановить / проверить' : (st.error ? 'Продолжить установку' : 'Установить нейросети'));
    const cancel = st.running ? h('button', { onclick: () => post('/api/setup/cancel') }, 'Отменить') : null;
    fill(box, h('h2', {}, 'Нейросети на этом компьютере'),
      h('p', {}, 'Расчёт идёт только здесь. Запись ЭКГ в интернет не отправляется.'),
      h('div', { class: 'row' }, [['efficientnet', 'DeepECG SL'], ['wcr', 'DeepECG SSL'], ['ecgfounder', 'ECGFounder']].map(([k, l]) =>
        h('span', { class: 'pill ' + (m[k] ? 'lvl-none' : 'lvl-minor') }, l + (m[k] ? ' · готова' : ' · не установлена')))),
      ...(st.warnings || []).map(w => notice(w)),
      st.running || st.finished || st.error ? h('div', {}, bar, h('p', { class: st.error ? 'error' : 'muted' }, st.error || st.message)) : null,
      all && !st.running ? h('p', {}, h('a', { href: '/' }, 'Открыть модуль запуска моделей →')) : null,
      !all || st.error ? h('p', { class: 'muted' }, `Один раз скачивается около 4 ГБ: Python, PyTorch и веса моделей с официальных страниц авторов; каждый файл проверяется по контрольной сумме. Прерванная загрузка продолжается с того же места. Нужно ещё около ${gb(st.need_gb ?? 7)} ГБ свободного места${st.free_gb != null ? ' (сейчас свободно ' + gb(st.free_gb) + ' ГБ)' : ''}. Папка: ${st.work_dir}.`) : null,
      st.supported ? null : notice('Для этого компьютера нет готовой сборки нейросетей. Поддерживаются Windows x64 и Mac на Apple Silicon (M1 и новее).'),
      h('div', { class: 'row' }, button, cancel),
      notice('Файл прибора ECG301 содержит 3 секунды записи, а моделям нужно 10 секунд с подтверждённой калибровкой. Поэтому по файлам прибора нейросети пока не запускаются. Готовый результат расчёта (файл JSON) можно прикрепить к ЭКГ пациента кнопкой «Прикрепить расчёт».'));
  };
  const poll = async () => {
    clearTimeout(timer);
    if (!box.isConnected && timer) return;
    try {
      const st = await (await fetch('/api/setup')).json();
      draw(st);
      if (st.running) timer = setTimeout(poll, 1500);
    } catch (err) { box.replaceChildren(h('p', { class: 'error' }, 'Нет связи с программой: ' + err.message)); }
  };
  poll();
  return box;
}

// Exchange folder: ECG files dropped into a (synced) folder are filed under the patient (desktop only).
function exchangeCard() {
  const box = card(h('h2', {}, 'Папка обмена'), h('p', { class: 'muted' }, 'Проверка…'));
  const token = document.querySelector('meta[name="cardioai-token"]')?.content;
  const STATUS = { ok: 'добавлена', duplicate: 'уже была', error: 'ошибка' };
  const send = async body => {
    const r = await fetch('/api/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ECG-Token': token }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    return data;
  };
  const draw = (st, error) => {
    const folder = h('input', { value: st.folder || '', 'aria-label': 'Путь к папке обмена', spellcheck: 'false' });
    const toggle = h('button', { class: st.enabled ? '' : 'primary', onclick: async () => {
      try { draw(await send({ enabled: !st.enabled, folder: folder.value.trim() || null })); }
      catch (err) { draw(st, err.message); }
    } }, st.enabled ? 'Выключить' : 'Включить');
    const open = h('button', { onclick: async () => {
      const r = await fetch('/api/exchange/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ECG-Token': token }, body: '{}' });
      if (!r.ok) draw(st, (await r.json()).error);
    } }, 'Открыть папку');
    const [pillClass, pillText] = !st.enabled ? ['lvl-small', 'выключена'] : st.error ? ['lvl-major', 'папка недоступна'] : st.running ? ['lvl-none', 'работает'] : ['lvl-major', 'остановлена — выключите и включите'];
    fill(box, h('h2', {}, 'Папка обмена'),
      h('p', {}, 'Положите файл прибора в папку «Входящие/Фамилия Имя» — программа сама добавит ЭКГ в карточку пациента и запишет результат в «Результаты». Если есть тёзки, добавьте дату рождения: «Иванов Иван 1980-05-01».'),
      h('p', { class: 'muted' }, 'Если папка лежит в Google Drive, Яндекс Диске или Dropbox, файлы можно присылать с телефона или другого компьютера.'),
      st.cloud ? notice('Папка похожа на облачную. ФИО и ЭКГ пациентов будут храниться и у облачного сервиса. Решите, допустимо ли это для ваших пациентов.') : null,
      h('label', {}, 'Папка', folder),
      h('div', { class: 'row' }, toggle, st.enabled ? open : null, h('button', { onclick: refresh }, 'Обновить'),
        h('span', { class: 'pill ' + pillClass }, pillText)),
      error || st.error ? h('p', { class: 'error' }, error || st.error) : null,
      st.recent?.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Файл'), h('th', {}, 'Пациент'), h('th', {}, 'Итог'))),
        h('tbody', {}, [...st.recent].reverse().map(e => h('tr', {}, h('td', {}, e.file), h('td', {}, e.patient || '—'),
          h('td', { class: e.status === 'error' ? 'error' : '' }, (STATUS[e.status] || e.status) + (e.new_patient ? ', новый пациент' : '') + (e.error ? ': ' + e.error : ''))))))) : null,
      h('p', { class: 'muted' }, 'Папка работает, пока программа открыта на этом компьютере.'));
  };
  const refresh = async () => {
    try { draw(await (await fetch('/api/exchange')).json()); }
    catch (err) { box.replaceChildren(h('p', { class: 'error' }, 'Нет связи с программой: ' + err.message)); }
  };
  refresh();
  return box;
}

async function viewSettings() {
  const msg = h('p', { role: 'status' });
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const where = state.store.kind === 'server'
    ? `Данные хранятся в папке на этом компьютере: ${state.status.data_dir || 'папка программы'}.`
    : 'Данные хранятся только в этом браузере или приложении. Удаление данных браузера сотрёт их — регулярно делайте резервную копию.';
  view.replaceChildren(h('h1', {}, 'Данные'),
    card(h('h2', {}, 'Где хранятся данные'), h('p', {}, where), h('p', { class: 'muted' }, 'Через резервную копию можно перенести пациентов между компьютером, телефоном и сайтом.')),
    card(h('h2', {}, 'Резервная копия'), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
      const data = await exportAll(state.store);
      await saveFile(JSON.stringify(data), `CardioAI-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      msg.className = 'success'; msg.textContent = `Выгружено: пациентов ${data.patients.length}, ЭКГ ${data.records.length}.`;
    } }, 'Скачать резервную копию')),
    h('h3', {}, 'Восстановить из копии'), h('p', { class: 'muted' }, 'Записи с теми же номерами будут заменены, остальные сохранятся.'),
    h('label', {}, 'Файл копии', file), h('button', { onclick: async () => {
      try {
        if (!file.files[0]) throw Error('Выберите файл');
        const res = await importAll(state.store, JSON.parse(new TextDecoder().decode(await readFile(file.files[0]))));
        msg.className = 'success'; msg.textContent = `Загружено: пациентов ${res.patients}, ЭКГ ${res.records}.`;
      } catch (err) { msg.className = 'error'; msg.textContent = err.message; }
    } }, 'Загрузить копию'), msg),
    ...(state.store.kind === 'server' ? [exchangeCard()] : []),
    card(h('h2', {}, 'О программе'), h('p', {}, 'CardioAI — локальная исследовательская программа для просмотра ЭКГ, ведения истории и сравнения записей.'),
      h('p', { class: 'muted' }, 'Правила сравнения: версия ' + RULES.version + '. Пороги частично взяты из публикаций, частично — практические (см. docs/research).'), notice(DISCLAIMER)));
}

// ---------- router
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const page = parts[0] || 'patients';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.dataset.nav === (page === 'patient' || page === 'record' ? 'patients' : page));
  try {
    if (page === 'patient') await viewPatient(parts[1]);
    else if (page === 'record') await viewRecord(parts[1], parts[2]);
    else if (page === 'compare') await viewCompare(parts[1], parts[2], parts[3]);
    else if (page === 'ai') await viewAI();
    else if (page === 'settings') await viewSettings();
    else await viewPatients();
  } catch (err) {
    view.replaceChildren(card(h('p', { class: 'error' }, err.message), h('a', { href: '#/patients' }, 'К списку пациентов')));
  }
  window.scrollTo(0, 0);
}

async function start() {
  const { store, status } = await openStore();
  state.store = store; state.status = status;
  document.getElementById('mode').textContent = store.kind === 'server' ? 'Программа на компьютере · данные локально' : 'Веб-версия · данные в этом устройстве';
  try { state.labelsRu = await (await fetch('data/labels-ru.json')).json(); } catch { state.labelsRu = {}; }
  if (status) try { state.thresholds = await (await fetch('/api/thresholds')).json(); } catch { state.thresholds = {}; }
  if (store.kind === 'browser' && 'serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor)
    navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('hashchange', route);
  route();
}

start();
