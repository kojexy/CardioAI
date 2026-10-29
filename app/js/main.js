// CardioAI single-page app: patients, ECG history, serial comparison.
import { LEADS, ASSUMED, parseECG301, sha256Hex } from './ecg301.js';
import { deriveMeasurements, ageAt } from './measure.js';
import { compareRecords, autoComparisons, trend, sustainedTrends, rangeStatus, normalRange, LEVEL_TEXT } from './compare.js';
import { RULES, MEASURE_LABELS } from './rules.js';
import { openStore, newId, exportAll, importAll } from './store.js';
import { trendChart, beatOverlay, stripChart } from './charts.js';
import { toMillivolts } from './signal.js';
import { saveFile, readFile, printReport } from './files.js';
import { fileDeviceRecord, linkDeviceName } from './autofile.js';
import { recordReport, comparisonReport } from './report.js';

const state = { store: null, status: null, labelsRu: {}, thresholds: {}, lastImport: null };
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
const notice = (text, cls = '') => h('div', { class: 'notice ' + cls }, text);
// replaceChildren() would print null/false as text; skip empty parts like h() does.
const fill = (el, ...c) => el.replaceChildren(...c.flat().filter(x => x != null && x !== false));
const go = hash => { location.hash = hash; };
const DISCLAIMER = 'Исследовательская программа. Результаты — технические оценки, а не диагноз. Решение принимает врач.';
const SEX = { M: 'мужской', F: 'женский' };

// Line icons (static markup only).
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  compare: '<path d="M7 7h13l-3-3M17 17H4l3 3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  save: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  ecg: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
}
const btn = (label, onclick, cls = '', ico = null) => h('button', { type: 'button', class: cls || null, onclick }, ico ? icon(ico) : null, label);
const backLink = (href, text) => h('a', { class: 'back no-print', href }, icon('back'), text);
function pageHead(title, sub, ...actions) {
  actions = actions.flat().filter(Boolean);
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'row no-print' }, actions) : null);
}
function show(el) {
  el.classList.remove('hidden');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.querySelector('input:not([type=file]),select,textarea')?.focus({ preventScroll: true });
}

// File picker in Russian: a drop zone around a hidden native input (its labels follow the system language).
function dropZone(input, { title = ['Перетащите файл сюда или ', h('b', {}, 'выберите его')], hint = '', compact = false } = {}) {
  const chosen = h('span', { class: 'chosen hidden' });
  const zone = h('label', { class: 'drop' + (compact ? ' compact' : '') }, input, icon('upload'), h('span', {}, title), hint ? h('span', { class: 'hint' }, hint) : null, chosen);
  zone.setText = text => { chosen.textContent = text; chosen.classList.toggle('hidden', !text); zone.classList.toggle('has', !!text); };
  input.addEventListener('change', () => {
    const n = input.files.length;
    zone.setText(!n ? '' : n === 1 ? 'Выбран: ' + input.files[0].name : `Выбрано файлов: ${n}`);
  });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('over');
    if (!e.dataTransfer?.files.length) return;
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event('change'));
  });
  return zone;
}

// Dates typed as ДД.ММ.ГГГГ [ЧЧ:ММ]: the browser's date picker shows the system language and format.
const pad = n => String(n).padStart(2, '0');
function isoToRu(v, withTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` + (withTime && m[4] ? ` ${m[4]}:${m[5]}` : '') : '';
}
function dateField(iso, withTime = false) {
  const input = h('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: withTime ? 'ДД.ММ.ГГГГ ЧЧ:ММ' : 'ДД.ММ.ГГГГ', maxlength: withTime ? 16 : 10 });
  input.withTime = withTime;
  input.setIso = v => { input.value = isoToRu(v, withTime); };
  input.addEventListener('input', e => {
    if (e.inputType?.startsWith('delete')) return;
    const d = input.value.replace(/\D/g, '').slice(0, withTime ? 12 : 8);
    let out = d.slice(0, 2);
    if (d.length > 2) out += '.' + d.slice(2, 4);
    if (d.length > 4) out += '.' + d.slice(4, 8);
    if (d.length > 8) out += ' ' + d.slice(8, 10);
    if (d.length > 10) out += ':' + d.slice(10, 12);
    input.value = out;
  });
  input.setIso(iso);
  return input;
}
// Empty → null; a wrong or future date → Error that names the field.
function readDate(input, what) {
  const v = input.value.trim();
  if (!v) return null;
  const bad = () => { input.focus(); return Error(`${what}: введите в виде ${input.placeholder}`); };
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(v);
  if (!m) throw bad();
  const [, d, mo, y, hh = '0', mm = '0'] = m;
  const dt = new Date(+y, mo - 1, +d, +hh, +mm);
  if (dt.getFullYear() !== +y || dt.getMonth() !== mo - 1 || dt.getDate() !== +d || +hh > 23 || +mm > 59 || +y < 1900 || dt - Date.now() > 864e5) throw bad();
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  return input.withTime ? `${date}T${pad(hh)}:${pad(mm)}:00` : date;
}
// Numbers accept a comma: "0,9".
const numberField = () => h('input', { inputmode: 'decimal', autocomplete: 'off' });
function readNumber(input, what) {
  const v = input.value.trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) { input.focus(); throw Error(`${what}: нужно число`); }
  return n;
}

// In-page dialogs: window.confirm shows English buttons on the Mac and may not show at all on Android.
function ask(text, { ok = 'Удалить', cancel = 'Отмена', danger = true } = {}) {
  if (!window.HTMLDialogElement) return Promise.resolve(cancel ? window.confirm(text) : (window.alert(text), true));
  return new Promise(resolve => {
    const d = h('dialog', {});
    const close = v => { d.close(); d.remove(); resolve(v); };
    const okBtn = btn(ok, () => close(true), danger ? 'primary danger-fill' : 'primary');
    d.append(h('p', {}, text), h('div', { class: 'actions' }, cancel ? btn(cancel, () => close(false)) : null, okBtn));
    d.addEventListener('cancel', e => { e.preventDefault(); close(false); });
    document.body.append(d);
    d.showModal();
    okBtn.focus();
  });
}
const tell = text => ask(text, { ok: 'Понятно', cancel: null, danger: false });

function fmtDate(iso, withTime = false) {
  if (!iso) return 'дата не указана';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) +
    (withTime ? ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
}
function shortDate(iso) {
  const d = new Date(iso);
  return iso && !isNaN(d) ? d.toLocaleDateString('ru-RU') : '—';
}
function fmtPeriod(days) {
  if (days === null || days === undefined) return '';
  if (days < 1) return 'в тот же день';
  if (days < 45) return `через ${days} дн.`;
  const months = Math.round(days / 30.44);
  return months < 18 ? `через ${months} мес.` : `через ${(days / 365.25).toFixed(1).replace('.', ',')} г.`;
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}
const ageText = age => age === null ? null : `${age} ${plural(age, 'год', 'года', 'лет')}`;
const initials = p => [p.surname, p.name].map(s => (s || '').charAt(0)).join('').toUpperCase() || '?';
function fullName(p) { return [p.surname, p.name, p.middleName].filter(Boolean).join(' ') || 'Без имени'; }
function val(v, unit) {
  if (!Number.isFinite(v)) return '—';
  return (Number.isInteger(v) ? v : Math.round(v * 100) / 100) + (unit === '°' ? '°' : unit ? ' ' + unit : '');
}
function logitMargin(p, t) {
  const lg = x => { const q = Math.min(0.999, Math.max(0.001, x)); return Math.log(q / (1 - q)); };
  return lg(p) - lg(t);
}
function labelRu(label) { return state.labelsRu[label] ? `${state.labelsRu[label]} (${label})` : label; }
function sortByDate(records) { return [...records].sort((a, b) => (b.recordedAt || '').localeCompare(a.recordedAt || '')); }
const SOURCE = { ecg301: 'файл прибора ECG301', manual: 'введено вручную', import: 'файл CardioAI' };

// ---------- record creation
async function recordFromECG301(buffer, fileName) {
  const parsed = parseECG301(buffer);
  return {
    id: newId(), source: 'ecg301', fileName, sha256: await sha256Hex(buffer), deviceRecordId: parsed.recordId, devicePatient: parsed.patient,
    recordedAt: parsed.recordedAt, device: parsed.device, measurements: deriveMeasurements(parsed.device),
    signal: { block: 'B', fs: ASSUMED.fsB, leads: parsed.blocks.B,
      calibration: { microvoltsPerCount: ASSUMED.microvoltsPerCount, zeroCounts: ASSUMED.zeroCounts, verified: false } },
    checks: parsed.checks, ai: {}, createdAt: new Date().toISOString(),
  };
}

const MODEL_KEYS = { 'heartwise/EfficientNetV2_77_Classes': 'efficientnet', 'heartwise/WCR_77_Classes': 'wcr', 'PKUDigitalHealth/ECGFounder': 'ecgfounder' };
const MODEL_NAMES = { efficientnet: 'DeepECG SL (EfficientNetV2)', wcr: 'DeepECG SSL (WCR)', ecgfounder: 'ECGFounder' };
// Which network's scores to show and print: all or one, remembered on this device.
const MODEL_PREF = 'cardioai-model';
function showModel(container, value) {
  for (const e of container.querySelectorAll('[data-model]')) e.classList.toggle('hidden', value !== 'all' && e.dataset.model !== value);
}
function modelPicker(container, keys) {
  if (keys.length < 2) return null;
  let value = 'all';
  try { value = localStorage.getItem(MODEL_PREF) || 'all'; } catch { /* storage blocked: show all */ }
  if (!keys.includes(value)) value = 'all';
  const select = h('select', { onchange: () => {
    try { localStorage.setItem(MODEL_PREF, select.value); } catch { /* remembered for this page only */ }
    showModel(container, select.value);
  } }, h('option', { value: 'all' }, 'все'), keys.map(k => h('option', { value: k }, MODEL_NAMES[k] || k)));
  select.value = value;
  showModel(container, value);
  return h('label', { class: 'inline no-print' }, 'Нейросеть', select);
}

// Print button: a separate A4 report (report.js), not the screen. Only the chosen network is printed.
function printButton(title, build, label = 'Печать', cls = '') {
  return btn(label, async () => {
    try {
      let model = 'all';
      try { model = localStorage.getItem(MODEL_PREF) || 'all'; } catch { /* print all */ }
      await printReport(build({ labelsRu: state.labelsRu, model }), title);
    } catch (err) { tell('Не удалось подготовить печать: ' + err.message); }
  }, cls, 'print');
}
// The report for one ECG also shows its comparison with the ECG before it.
function recordReportFor(patient, records, record, ctx) {
  const sorted = sortByDate(records), older = sorted[sorted.indexOf(record) + 1];
  return recordReport(patient, record, { ...ctx, previous: older ? compareRecords(older, record, { sex: patient.sex }) : null });
}

function aiEntry(report, extra = {}) {
  if (!report || typeof report.scores !== 'object') throw Error('В файле нет оценок нейросети (поле scores)');
  const key = MODEL_KEYS[report.model] || String(report.model || 'model');
  const weightsSha = report.weights?.sha256 || report.weights?.finetuned?.sha256 || null;
  // Older reports have no thresholds: on the desktop take them from the installed upstream.
  const thresholds = report.thresholds || (Object.keys(state.thresholds[key] || {}).length ? state.thresholds[key] : null);
  return [key, { model: MODEL_NAMES[key] || report.model, scores: report.scores, thresholds, thresholdSource: report.threshold_source || (thresholds ? 'DeepECG_Docker 77_tasks_final.json' : null), ranges: report.ranges, weightsSha,
    synthetic: report.synthetic_test === true, attachedAt: new Date().toISOString(), ...extra }];
}

// ---------- patients
async function viewPatients() {
  const patients = await state.store.listPatients();
  const info = new Map();
  for (const p of patients) {
    const records = sortByDate(await state.store.listRecords(p.id));
    info.set(p.id, { n: records.length, last: records[0]?.recordedAt || null });
  }
  // Newest ECG first; patients without ECG last, alphabetically.
  const ordered = [...patients].sort((a, b) => (info.get(b.id).last || '').localeCompare(info.get(a.id).last || '') || fullName(a).localeCompare(fullName(b), 'ru'));
  const search = h('input', { type: 'search', placeholder: 'Фамилия пациента', 'aria-label': 'Найти пациента', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'plist' });
  const form = patientForm({}, async p => { await state.store.savePatient(p); go('#/patient/' + p.id); }, () => newCard.classList.add('hidden'));
  const newCard = h('section', { class: 'card hidden' }, h('h2', {}, 'Новый пациент'), form);
  const openNew = () => {
    const q = search.value.trim();
    if (q && !form.fields.surname.value) form.fields.surname.value = q[0].toUpperCase() + q.slice(1);
    show(newCard);
  };
  let shown = [];
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    // Surnames that start with the typed text come first.
    const starts = p => (p.surname || '').toLowerCase().startsWith(q);
    const hits = ordered.filter(p => fullName(p).toLowerCase().includes(q));
    shown = q ? [...hits.filter(starts), ...hits.filter(p => !starts(p))] : hits;
    if (shown.length) { fill(list, shown.map((p, i) => patientRow(p, info.get(p.id), q && i === 0))); return; }
    fill(list, h('div', { class: 'empty' },
      h('p', {}, patients.length ? `Пациент «${search.value.trim()}» не найден.` : 'Пациентов пока нет. Перетащите файлы ЭКГ с прибора выше — карточки создадутся сами.'),
      btn(patients.length ? `Создать пациента «${search.value.trim()}»` : 'Добавить пациента вручную', openNew, 'primary', 'plus')));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter' && shown[0]) go('#/patient/' + shown[0].id);
    if (e.key === 'Escape') { search.value = ''; draw(); }
  });
  draw();
  const result = state.lastImport ? importResult(state.lastImport) : null;
  state.lastImport = null;
  view.replaceChildren(
    pageHead('Пациенты', patients.length ? `${patients.length} ${plural(patients.length, 'пациент', 'пациента', 'пациентов')}` : null, btn('Новый пациент', openNew, 'primary', 'plus')),
    ...[result, newCard, importZone()].filter(Boolean),
    h('div', { class: 'search' }, icon('search'), search),
    list);
  if (matchMedia('(pointer:fine)').matches) search.focus();
}

function patientRow(p, c, first) {
  return h('a', { class: 'prow' + (first ? ' first' : ''), href: '#/patient/' + p.id },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(p)),
    h('div', {}, h('div', { class: 'name' }, fullName(p)),
      h('div', { class: 'meta' }, [ageText(ageAt(p.birthDate)), SEX[p.sex], c.n ? `ЭКГ: ${c.n}` : 'ЭКГ нет'].filter(Boolean).join(' · '))),
    h('div', { class: 'last' }, c.last ? [h('b', {}, shortDate(c.last)), 'последняя ЭКГ'] : null),
    h('span', { class: 'chev' }, icon('next')));
}

// Device files dropped here go to their patients by the name typed on the cardiograph; the import starts at once.
function importZone() {
  const input = h('input', { type: 'file', multiple: true, 'aria-label': 'Файлы ЭКГ с прибора' });
  const zone = dropZone(input, { compact: true, title: ['Перетащите сюда файлы с кардиографа или ', h('b', {}, 'выберите их')],
    hint: 'ЭКГ сами попадут к пациентам по имени, введённому на приборе. Новых пациентов программа создаст.' });
  input.addEventListener('change', async () => {
    if (!input.files.length) return;
    const results = [];
    let i = 0;
    for (const file of input.files) {
      zone.setText(`Добавляю ${++i} из ${input.files.length}…`);
      let res;
      try { res = await fileDeviceRecord(state.store, await recordFromECG301(await readFile(file), file.name)); }
      catch (err) { res = { status: 'error', message: err.message }; }
      results.push({ file: file.name, ...res });
    }
    state.lastImport = results;
    route();
  });
  return zone;
}

function importResult(results) {
  const ok = results.filter(r => r.status === 'ok'), dup = results.filter(r => r.status === 'duplicate'), bad = results.filter(r => r.status === 'error');
  const byPatient = new Map();
  for (const r of ok) {
    const prev = byPatient.get(r.patient.id);
    byPatient.set(r.patient.id, { p: r.patient, n: (prev?.n || 0) + 1, created: prev?.created || r.created });
  }
  const created = [...byPatient.values()].some(x => x.created);
  const box = card(h('div', { class: 'card-head' }, h('h2', {}, ok.length ? `Добавлено ЭКГ: ${ok.length}` : 'Новых ЭКГ нет'), btn('Скрыть', () => box.remove(), 'ghost small')),
    byPatient.size ? h('div', { class: 'chips' }, [...byPatient.values()].map(x =>
      h('a', { class: 'pill ' + (x.created ? 'warn' : 'ok'), href: '#/patient/' + x.p.id }, `${fullName(x.p)} · ${x.n}${x.created ? ' · новый пациент' : ''}`))) : null,
    created ? h('p', { class: 'muted gap' }, 'В карточках новых пациентов проверьте дату рождения и пол.') : null,
    dup.length ? h('p', { class: 'muted gap' }, `Уже были в программе: ${dup.length}.`) : null,
    bad.length ? h('div', {}, h('p', { class: 'error gap' }, `Не удалось добавить: ${bad.length}`),
      h('ul', {}, bad.map(r => h('li', {}, `${r.file}: ${r.message}`)))) : null);
  return box;
}

function patientForm(p, onSave, onCancel, ...extra) {
  const f = {
    surname: h('input', { value: p.surname || '', autocomplete: 'off' }),
    name: h('input', { value: p.name || '', autocomplete: 'off' }),
    middleName: h('input', { value: p.middleName || '', autocomplete: 'off' }),
    birthDate: dateField(p.birthDate),
    sex: h('select', {}, h('option', { value: '' }, 'не указан'), h('option', { value: 'M' }, 'мужской'), h('option', { value: 'F' }, 'женский')),
    notes: h('textarea', { rows: 2 }, p.notes || ''),
  };
  f.sex.value = p.sex || '';
  const msg = h('p', { role: 'alert', class: 'error' });
  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    msg.textContent = '';
    try {
      if (!f.surname.value.trim()) { f.surname.focus(); throw Error('Укажите фамилию'); }
      const birthDate = readDate(f.birthDate, 'Дата рождения');
      await onSave({ ...p, id: p.id || newId(), surname: f.surname.value.trim(), name: f.name.value.trim(),
        middleName: f.middleName.value.trim(), birthDate, sex: f.sex.value || null,
        notes: f.notes.value.trim(), createdAt: p.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    } catch (err) { msg.textContent = err.message; }
  } },
  h('div', { class: 'form-grid' }, h('label', {}, 'Фамилия', f.surname), h('label', {}, 'Имя', f.name), h('label', {}, 'Отчество', f.middleName),
    h('label', {}, 'Дата рождения', f.birthDate), h('label', {}, 'Пол (для норм QTc)', f.sex)),
  h('label', {}, 'Заметки', f.notes), msg,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Сохранить'), onCancel ? btn('Отмена', onCancel, 'ghost') : null, ...extra));
  form.fields = f;
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
  const editCard = h('section', { class: 'card hidden' }, h('h2', {}, 'Данные пациента'),
    patientForm(patient, async p => { await state.store.savePatient(p); route(); }, () => editCard.classList.add('hidden'),
      btn('Удалить пациента', async () => {
        if (!await ask(`Удалить пациента «${fullName(patient)}» и все его ЭКГ (${records.length})? Это нельзя отменить.`)) return;
        await state.store.deletePatient(patient.id); go('#/patients');
      }, 'danger push', 'trash')));
  const addCard = addRecordCard(patient, records);
  if (records.length) addCard.classList.add('hidden');
  const parts = [backLink('#/patients', 'Пациенты'),
    pageHead(fullName(patient), [ageText(ageAt(patient.birthDate)), SEX[patient.sex], patient.birthDate ? 'дата рождения ' + shortDate(patient.birthDate) : null].filter(Boolean).join(' · '),
      btn('Изменить', () => show(editCard), '', 'edit'), btn('Добавить ЭКГ', () => show(addCard), 'primary', 'plus')),
    patient.notes ? h('p', { class: 'muted' }, patient.notes) : null,
    editCard, addCard];
  if (records.length) parts.push(latestCard(patient, records));

  const auto = autoComparisons(records, patient.sex);
  if (auto.previous) {
    const body = h('div');
    const options = [['previous', 'С предыдущей'], ...(auto.baseline ? [['baseline', 'С исходной']] : [])];
    const tabs = options.length > 1 ? h('div', { class: 'tabs', role: 'tablist' }) : null;
    const open = key => {
      if (tabs) for (const b of tabs.children) { b.classList.toggle('on', b.dataset.key === key); b.setAttribute('aria-selected', b.dataset.key === key); }
      const c = auto[key];
      fill(body, comparisonView(c, patient, { compact: true }),
        h('div', { class: 'actions' }, btn('Подробное сравнение', () => go(`#/compare/${patient.id}/${c.older.id}/${c.newer.id}`), '', 'compare'),
          printButton('Сравнение ЭКГ ' + fullName(patient), ctx => comparisonReport(patient, c, ctx), 'Печать сравнения')));
    };
    if (tabs) for (const [key, label] of options) tabs.append(h('button', { type: 'button', role: 'tab', 'data-key': key, onclick: () => open(key) }, label));
    parts.push(card(h('div', { class: 'card-head' }, h('h2', {}, tabs ? 'Сравнение последней ЭКГ' : 'Сравнение с предыдущей ЭКГ'), tabs), body));
    open('previous');
  }

  parts.push(recordsTable(patient, records));

  const keys = ['QTcF_ms', 'heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QTc_ms', 'QRS_axis', 'sokolow_mV', 'RR_cv_pct'];
  const charts = keys.map(k => [k, trend(records, k)]).filter(([, pts]) => pts.length >= 2)
    .map(([k, pts]) => trendChart(pts, { label: MEASURE_LABELS[k].label, unit: MEASURE_LABELS[k].unit, range: normalRange(MEASURE_LABELS[k], patient.sex) }));
  const sustained = sustainedTrends(records);
  if (charts.length) parts.push(h('details', { class: 'fold', open: sustained.length > 0 },
    h('summary', {}, 'Динамика показателей', sustained.length ? h('span', { class: 'pill warn' }, `устойчивых изменений: ${sustained.length}`) : h('span', { class: 'small' }, 'без устойчивых изменений')),
    h('div', { class: 'fold-body' },
      sustained.length ? h('ul', { class: 'highlights' }, sustained.map(t => h('li', {}, pill('minor'), ` ${t.label}: ${t.direction === 'up' ? 'растёт' : 'снижается'} ${t.points - 1} раза подряд, всего ${t.total > 0 ? '+' : ''}${val(t.total, t.unit)}`))) : null,
      h('p', { class: 'muted' }, 'Зелёная полоса — ориентировочная норма для взрослых.'), h('div', { class: 'charts' }, charts))));
  parts.push(notice(DISCLAIMER, 'info'));
  view.replaceChildren(...parts.filter(Boolean));
}

// The newest ECG with its key values: the first thing a doctor looks for.
function latestCard(patient, records) {
  const r = records[0];
  const keys = ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTcF_ms', 'QRS_axis'];
  let outside = 0;
  const vals = keys.filter(k => Number.isFinite(r.measurements?.[k])).map(k => {
    const m = MEASURE_LABELS[k], st = rangeStatus(r.measurements[k], m, patient.sex), off = st && st !== 'normal';
    if (off) outside++;
    return h('div', { class: 'val' + (off ? ' bad' : '') }, h('small', {}, m.label), h('b', {}, val(r.measurements[k], m.unit === '°' ? '°' : '')), m.unit === '°' ? null : h('span', { class: 'small' }, ' ' + m.unit));
  });
  return card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Последняя ЭКГ'), h('p', { class: 'muted' }, fmtDate(r.recordedAt, true))),
    vals.length ? h('span', { class: 'pill ' + (outside ? 'bad' : 'ok') }, outside ? `вне нормы: ${outside}` : 'в пределах нормы') : null),
  vals.length ? h('div', { class: 'vals' }, vals) : h('p', { class: 'muted' }, 'Показателей нет.'),
  h('div', { class: 'actions' }, btn('Открыть ЭКГ', () => go(`#/record/${patient.id}/${r.id}`), 'primary', 'ecg'),
    printButton(`ЭКГ ${fullName(patient)} ${fmtDate(r.recordedAt)}`, ctx => recordReportFor(patient, records, r, ctx))));
}

function recordsTable(patient, records) {
  if (!records.length) return null;
  const chosen = new Set();
  const label = h('span', {}, 'Отметьте 2 ЭКГ');
  const compareBtn = h('button', { type: 'button', class: 'small', disabled: true, onclick: () => {
    // Older first, whatever order they were ticked in.
    const [a, b] = records.filter(r => chosen.has(r.id)).reverse().map(r => r.id);
    go(`#/compare/${patient.id}/${a}/${b}`);
  } }, icon('compare'), label);
  const cols = ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTcF_ms', 'QRS_axis'];
  const rows = records.map(r => {
    const box = h('input', { type: 'checkbox', 'aria-label': 'Выбрать для сравнения: ' + fmtDate(r.recordedAt, true), onchange: e => {
      e.target.checked ? chosen.add(r.id) : chosen.delete(r.id);
      compareBtn.disabled = chosen.size !== 2;
      compareBtn.className = chosen.size === 2 ? 'small primary' : 'small';
      label.textContent = chosen.size === 2 ? 'Сравнить выбранные' : chosen.size > 2 ? 'Отметьте только 2' : 'Отметьте 2 ЭКГ';
    } });
    return h('tr', { class: 'link', onclick: e => { if (!e.target.closest('td.pick')) go(`#/record/${patient.id}/${r.id}`); } },
      h('td', { class: 'pick' }, h('label', {}, box)),
      h('td', {}, h('a', { href: `#/record/${patient.id}/${r.id}` }, fmtDate(r.recordedAt, true)), r.isBaseline ? [' ', h('span', { class: 'pill neutral' }, 'исходная')] : null),
      cols.map(k => {
        const v = r.measurements?.[k], st = rangeStatus(v, MEASURE_LABELS[k], patient.sex);
        return h('td', { class: 'num' + (st && st !== 'normal' ? ' st-' + st : '') }, val(v));
      }),
      h('td', { class: 'muted' }, Object.keys(r.ai || {}).length ? 'есть' : '—'));
  });
  const unit = k => MEASURE_LABELS[k].unit && MEASURE_LABELS[k].unit !== '°' ? ', ' + MEASURE_LABELS[k].unit : '';
  return card(h('div', { class: 'card-head' }, h('h2', {}, `История ЭКГ (${records.length})`), records.length > 1 ? compareBtn : null),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Дата'), cols.map(k => h('th', { class: 'num' }, MEASURE_LABELS[k].label + unit(k))), h('th', {}, 'ИИ'))),
      h('tbody', {}, rows))));
}

function addRecordCard(patient, records) {
  const msg = h('p', { role: 'alert' });
  const say = (text, bad) => { msg.className = bad ? 'error' : 'success'; msg.textContent = text; };
  const save = async record => {
    record.patientId = patient.id;
    if (record.sha256 && records.some(r => r.sha256 === record.sha256)) throw Error('Этот файл уже есть в истории пациента');
    await state.store.saveRecord(record);
    // Next files with this device name go to this patient automatically.
    if (record.devicePatient?.label) await linkDeviceName(state.store, patient, record.devicePatient.label);
    go(`#/record/${patient.id}/${record.id}`);
  };
  // Device file: read at once, then confirm the date.
  const file = h('input', { type: 'file', 'aria-label': 'Файл ЭКГ с прибора' });
  const fileDate = dateField(null, true), fileNotes = h('input', { placeholder: 'например: после нагрузки' });
  let pending = null;
  const fileFields = h('div', { class: 'hidden' },
    h('div', { class: 'form-grid' }, h('label', {}, 'Дата и время ЭКГ', fileDate), h('label', {}, 'Заметка', fileNotes)),
    btn('Добавить ЭКГ', async () => {
      try {
        if (!pending) throw Error('Сначала выберите файл');
        await save({ ...pending, recordedAt: readDate(fileDate, 'Дата ЭКГ') || pending.recordedAt, notes: fileNotes.value.trim() });
      } catch (err) { say(err.message, true); }
    }, 'primary', 'plus'));
  file.addEventListener('change', async () => {
    pending = null;
    fileFields.classList.add('hidden');
    if (!file.files[0]) return;
    try {
      pending = await recordFromECG301(await readFile(file.files[0]), file.files[0].name);
      fileDate.setIso(pending.recordedAt);
      fileFields.classList.remove('hidden');
      const who = pending.devicePatient?.label ? ` Имя в приборе: «${pending.devicePatient.label}».` : '';
      say(`Файл прочитан.${who} Проверьте дату и нажмите «Добавить ЭКГ».`);
    } catch (err) { say(err.message, true); }
  });
  // Manual values from a paper ECG.
  const manualKeys = ['heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTc_ms', 'P_axis', 'QRS_axis', 'T_axis', 'RV5_mV', 'SV1_mV'];
  const inputs = Object.fromEntries(manualKeys.map(k => [k, numberField()]));
  const manualDate = dateField(null, true), manualNotes = h('input', { placeholder: 'например: распечатка из поликлиники' });
  const manualForm = h('div', {}, h('p', { class: 'muted' }, 'Значения с бумажной ЭКГ или из заключения. Пустые поля можно оставить.'),
    h('div', { class: 'form-grid' }, h('label', {}, 'Дата и время ЭКГ', manualDate),
      manualKeys.map(k => h('label', {}, `${MEASURE_LABELS[k].label}, ${MEASURE_LABELS[k].unit}`, inputs[k])), h('label', {}, 'Заметка', manualNotes)),
    btn('Добавить ЭКГ', async () => {
      try {
        const recordedAt = readDate(manualDate, 'Дата ЭКГ');
        if (!recordedAt) { manualDate.focus(); throw Error('Укажите дату ЭКГ'); }
        const device = {};
        for (const k of manualKeys) { const v = readNumber(inputs[k], MEASURE_LABELS[k].label); if (v !== null) device[k] = v; }
        if (!Object.keys(device).length) throw Error('Введите хотя бы один показатель');
        await save({ id: newId(), source: 'manual', recordedAt, device, measurements: deriveMeasurements(device),
          ai: {}, notes: manualNotes.value.trim(), createdAt: new Date().toISOString() });
      } catch (err) { say(err.message, true); }
    }, 'primary', 'plus'));
  // A record saved earlier from CardioAI.
  const jsonFile = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Файл ЭКГ из CardioAI' });
  jsonFile.addEventListener('change', async () => {
    if (!jsonFile.files[0]) return;
    try {
      const data = JSON.parse(new TextDecoder().decode(await readFile(jsonFile.files[0])));
      if (data.format !== 'cardioai-record' || !data.record?.measurements) throw Error('Это не файл ЭКГ из CardioAI');
      await save({ ...data.record, id: newId(), source: 'import', createdAt: new Date().toISOString() });
    } catch (err) { say(err.message, true); }
  });
  const jsonForm = h('div', { class: 'hidden' }, dropZone(jsonFile, { compact: true, title: ['Файл ЭКГ, сохранённый из CardioAI: перетащите или ', h('b', {}, 'выберите')] }));
  const panes = { manual: manualForm, json: jsonForm };
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['manual', 'Ввести вручную'], ['json', 'Файл CardioAI']].map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', class: k === 'manual' ? 'on' : '', onclick: e => {
      for (const b of tabs.children) b.classList.toggle('on', b === e.currentTarget);
      for (const [pk, pane] of Object.entries(panes)) pane.classList.toggle('hidden', pk !== k);
      msg.textContent = '';
    } }, label)));
  return card(h('h2', {}, 'Добавить ЭКГ'),
    dropZone(file, { title: ['Перетащите файл с кардиографа или ', h('b', {}, 'выберите его')], hint: 'Файл прибора ECG301. Дата возьмётся из файла.' }),
    fileFields, msg,
    h('details', {}, h('summary', {}, 'Другие способы: ввести вручную или из файла CardioAI'), h('div', { class: 'gap' }, tabs, manualForm, jsonForm)));
}

// ---------- one ECG
async function viewRecord(pid, rid) {
  const { patient, records } = await loadPatient(pid);
  const record = records.find(r => r.id === rid);
  if (!record) throw Error('ЭКГ не найдена');
  const older = records[records.indexOf(record) + 1];
  const rows = RULES.measurements.filter(m => Number.isFinite(record.measurements?.[m.key])).map(m => {
    const v = record.measurements[m.key], st = rangeStatus(v, m, patient.sex), range = normalRange(m, patient.sex), off = st && st !== 'normal';
    return h('tr', { class: off ? 'abn' : null }, h('td', {}, m.label), h('td', { class: 'num' + (off ? ' st-' + st : '') }, val(v, m.unit)),
      h('td', { class: 'norm' }, range ? `${range[0]}…${range[1]}` : ''),
      h('td', {}, st ? h('span', { class: 'pill ' + (off ? 'bad' : 'ok') }, { low: 'ниже нормы', high: 'выше нормы', normal: 'норма' }[st]) : null));
  });
  const parts = [backLink('#/patient/' + pid, fullName(patient)),
    pageHead('ЭКГ ' + fmtDate(record.recordedAt, true), [fullName(patient), SOURCE[record.source]].filter(Boolean).join(' · '),
      older ? btn('Сравнить с предыдущей', () => go(`#/compare/${pid}/${older.id}/${record.id}`), '', 'compare') : null,
      printButton(`ЭКГ ${fullName(patient)} ${fmtDate(record.recordedAt)}`, ctx => recordReportFor(patient, records, record, ctx), 'Печать', 'primary')),
    record.notes ? h('p', { class: 'muted' }, record.notes) : null];
  if (record.signal) {
    parts.push(card(h('h2', {}, 'Кривая ЭКГ'), stripChart(toMillivolts(record.signal.leads, record.signal.calibration), record.signal.fs, LEADS),
      record.signal.calibration?.verified ? null : h('p', { class: 'small gap' }, 'Масштаб в мВ приблизительный. Форму кривой оценивать можно.')));
  }
  parts.push(card(h('h2', {}, 'Показатели'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Показатель'), h('th', { class: 'num' }, 'Значение'), h('th', {}, 'Норма'), h('th', {}, 'Оценка'))), h('tbody', {}, rows))),
    record.source === 'ecg301' ? h('p', { class: 'small gap' }, 'Значения прочитаны из файла прибора — сверяйте с распечаткой. QTc рассчитаны программой по QT и среднему RR.') : null));
  parts.push(aiCard(patient, record));
  parts.push(card(h('h2', {}, 'Другие действия'),
    h('p', { class: 'muted' }, record.isBaseline ? 'Это исходная ЭКГ: с ней сравниваются новые. Если исходных несколько, берётся их среднее.' : 'Исходная ЭКГ — запись в покое, с которой сравниваются новые.'),
    h('div', { class: 'actions' },
      btn('Сохранить в файл', () => saveFile(JSON.stringify({ format: 'cardioai-record', version: 1, record: { ...record, patientId: undefined } }, null, 2),
        `ECG-${(record.recordedAt || 'record').slice(0, 10)}.json`, 'application/json'), '', 'save'),
      btn(record.isBaseline ? 'Больше не исходная' : 'Сделать исходной', async () => { record.isBaseline = !record.isBaseline; await state.store.saveRecord(record); route(); }),
      btn('Удалить ЭКГ', async () => {
        if (!await ask('Удалить эту ЭКГ из истории пациента?')) return;
        await state.store.deleteRecord(record.id); go('#/patient/' + pid);
      }, 'danger push', 'trash'))));
  view.replaceChildren(...parts.filter(Boolean));
}

function aiCard(patient, record) {
  const box = card();
  const msg = h('p', { role: 'alert', class: 'error' });
  const attach = async (key, entry) => {
    record.ai = { ...(record.ai || {}), [key]: entry };
    await state.store.saveRecord(record);
    route();
  };
  const entries = Object.entries(record.ai || {});
  const head = h('div', { class: 'card-head' }, h('h2', {}, 'Анализ ИИ'));
  box.append(head);
  if (!entries.length) box.append(h('p', { class: 'muted' }, 'Для этой ЭКГ анализа ИИ пока нет.'));
  for (const [key, entry] of entries) {
    const t = entry.thresholds || null;
    // With the authors' operating points: show labels above them, ordered by margin (logit).
    const ranked = t
      ? Object.entries(entry.scores).filter(([l]) => t[l]).map(([l, v]) => [l, v, logitMargin(v, t[l])]).sort((a, b) => b[2] - a[2])
      : Object.entries(entry.scores).sort((a, b) => b[1] - a[1]).map(([l, v]) => [l, v, null]);
    const above = t ? ranked.filter(r => r[2] > 0) : ranked.slice(0, 10);
    box.append(h('div', { 'data-model': key }, h('h3', {}, entry.model || key),
      entry.synthetic ? notice('Это технический тест на искусственном сигнале, а не оценка этой ЭКГ.') : null,
      t ? h('p', { class: 'muted' }, `Выше рабочего порога авторов: ${above.length} из ${ranked.length}. Порог подобран на данных авторов, не на ECG301.`)
        : notice('Для этой нейросети нет опубликованных порогов: числа 0–1 нельзя читать как «есть/нет».'),
      above.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Заключение'), h('th', { class: 'num' }, 'Оценка'), t ? h('th', { class: 'num' }, 'Порог') : null)),
        h('tbody', {}, above.slice(0, 15).map(([label, v]) => h('tr', {}, h('td', {}, labelRu(label)), h('td', { class: 'num' }, v.toFixed(3)),
          t ? h('td', { class: 'num' }, String(t[label])) : null))))) : h('p', {}, 'Ни одно заключение не превышает порог.'),
      h('details', {}, h('summary', {}, `Все оценки (${Object.keys(entry.scores).length})`),
        h('div', { class: 'scroll', style: 'max-height:360px' }, h('table', {}, h('tbody', {},
          Object.entries(entry.scores).sort((a, b) => b[1] - a[1]).map(([label, v]) => h('tr', {}, h('td', {}, labelRu(label)), h('td', { class: 'num' }, v.toFixed(4)))))))),
      h('div', { class: 'actions no-print' }, btn('Открепить', async () => {
        if (!await ask(`Открепить анализ «${entry.model || key}» от этой ЭКГ?`, { ok: 'Открепить' })) return;
        const ai = { ...record.ai }; delete ai[key]; record.ai = ai; await state.store.saveRecord(record); route();
      }, 'danger small', 'trash'))));
  }
  const picker = modelPicker(box, entries.map(([key]) => key));
  if (picker) head.append(picker);
  const jsonFile = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Файл анализа ИИ' });
  jsonFile.addEventListener('change', async () => {
    if (!jsonFile.files[0]) return;
    try {
      const [key, entry] = aiEntry(JSON.parse(new TextDecoder().decode(await readFile(jsonFile.files[0]))), { fileName: jsonFile.files[0].name });
      await attach(key, entry);
    } catch (err) { msg.textContent = err.message; }
  });
  const controls = h('div', { class: 'gap' }, dropZone(jsonFile, { compact: true, title: ['Файл анализа ИИ (.json): перетащите или ', h('b', {}, 'выберите')] }));
  if (state.status) {
    const select = h('select', {}, h('option', { value: '' }, 'Загрузка…'));
    fetch('/api/history').then(r => r.json()).then(jobs => {
      const done = jobs.filter(j => j.state === 'complete');
      select.replaceChildren(h('option', { value: '' }, done.length ? 'Выберите анализ' : 'Готовых анализов нет'),
        ...done.map(j => h('option', { value: j.id }, `${MODEL_NAMES[j.model] || j.model} · ${fmtDate(j.created_at, true)}${j.synthetic ? ' · тест' : ''}`)));
    }).catch(() => select.replaceChildren(h('option', { value: '' }, 'Список недоступен')));
    controls.append(h('label', {}, 'Или готовый анализ на этом компьютере', select), btn('Прикрепить', async () => {
      try {
        if (!select.value) throw Error('Выберите анализ из списка');
        const job = await (await fetch('/api/jobs/' + select.value)).json();
        const [key, entry] = aiEntry(job.report, { jobId: job.id });
        await attach(key, entry);
      } catch (err) { msg.textContent = err.message; }
    }));
  }
  box.append(h('details', { class: 'no-print' }, h('summary', {}, 'Прикрепить анализ ИИ'), controls), msg,
    h('p', { class: 'small gap' }, 'Числа 0–1 — выход нейросети, а не вероятность болезни.'));
  return box;
}

// ---------- comparison
// Warnings that change how the result is read stay visible; the rest fold away.
const KEY_WARNING = /перепутаны электроды|QRS ≥120/;

function comparisonView(c, patient, { compact = false } = {}) {
  const ok = !c.counts.major && !c.counts.minor && (c.measurements.length || c.waveform.available);
  const out = h('div', {},
    h('p', { class: 'headline' + (ok ? ' ok' : '') }, (ok ? '✓ ' : '') + c.headline),
    h('p', { class: 'muted' }, `${fmtDate(c.older.recordedAt)} → ${fmtDate(c.newer.recordedAt)}, ${fmtPeriod(c.days)}`));
  if (c.highlights.length) out.append(h('ul', { class: 'highlights' }, c.highlights.map(m => h('li', {}, pill(m.level), h('span', {}, m.text)))));
  const key = c.warnings.filter(w => KEY_WARNING.test(w)), rest = c.warnings.filter(w => !KEY_WARNING.test(w));
  for (const w of key) out.append(notice(w));
  if (rest.length) out.append(h('details', {}, h('summary', {}, `Замечания о точности (${rest.length})`), h('ul', {}, rest.map(w => h('li', { class: 'muted' }, w)))));
  const table = list => h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Показатель'), h('th', { class: 'num' }, 'Раньше'), h('th', { class: 'num' }, 'Сейчас'), h('th', { class: 'num' }, 'Изменение'), h('th', {}, 'Различие'))),
    h('tbody', {}, list.map(m => h('tr', {},
      h('td', {}, m.label), h('td', { class: 'num' + (m.statusA && m.statusA !== 'normal' ? ' st-' + m.statusA : '') }, val(m.a, m.unit)),
      h('td', { class: 'num' + (m.statusB && m.statusB !== 'normal' ? ' st-' + m.statusB : '') }, val(m.b, m.unit)),
      h('td', { class: 'num' }, (m.delta > 0 ? '↑ +' : m.delta < 0 ? '↓ ' : '') + val(m.delta, m.unit)), h('td', {}, pill(m.level)))))));
  const changed = c.measurements.filter(m => m.level !== 'none');
  if (changed.length) out.append(table(changed));
  else if (c.measurements.length) out.append(h('p', { class: 'muted' }, 'Все показатели в пределах обычной погрешности измерения.'));
  if (!compact && c.measurements.length > changed.length) out.append(h('details', {}, h('summary', {}, `Все показатели (${c.measurements.length})`), table(c.measurements)));

  if (!compact) {
    const w = c.waveform;
    out.append(h('h3', {}, 'Форма комплексов'));
    if (w.available) {
      out.append(h('p', { class: 'muted' }, `Средний комплекс по каждому отведению. Комплексов: ${w.beatsA} и ${w.beatsB}, среднее сходство формы ${String(w.meanCorrelation).replace('.', ',')}.`),
        beatOverlay(w, LEADS),
        h('details', {}, h('summary', {}, 'Таблица по отведениям'), h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Отведение'), h('th', { class: 'num' }, 'Сходство'), h('th', { class: 'num' }, 'Амплитуда сейчас / раньше'), h('th', { class: 'num' }, 'ST, Δ мВ'), h('th', { class: 'num' }, 'T, Δ мВ'), h('th', {}, 'Форма'))),
          h('tbody', {}, w.leads.map(l => h('tr', {}, h('td', {}, l.lead + (l.noisy ? ' (шум)' : '')), h('td', { class: 'num' }, l.correlation.toFixed(3)), h('td', { class: 'num' }, l.amplitudeRatio ?? '—'),
            h('td', { class: 'num' }, l.stDiff_mV), h('td', { class: 'num' }, l.tDiff_mV), h('td', {}, pill(l.level))))))),
          h('p', { class: 'small gap' }, 'Масштаб в мВ для файлов ECG301 приблизительный. Форма может меняться из-за положения электродов.')));
    } else out.append(h('p', { class: 'muted' }, w.reason));

    const aiHead = h('h3', {}, 'Анализ ИИ');
    out.append(aiHead);
    if (!c.scores.length) out.append(h('p', { class: 'muted' }, 'Анализа ИИ одной и той же нейросетью на обеих ЭКГ нет.'));
    for (const s of c.scores) {
      const section = h('div', { 'data-model': s.model });
      out.append(section);
      section.append(h('p', {}, h('b', {}, s.modelName), s.synthetic ? ' — внимание: есть искусственный тест' : ''));
      if (!s.changes.length) { section.append(h('p', { class: 'muted' }, 'Существенных изменений оценок нет.')); continue; }
      if (!s.sameWeights) section.append(notice('Версии нейросети на двух ЭКГ различаются — оценки сравнивать нельзя.'));
      section.append(h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, s.changes.map(x => h('tr', {}, h('td', {}, labelRu(x.label)),
        h('td', { class: 'num' }, `${x.a.toFixed(2)} → ${x.b.toFixed(2)}`),
        h('td', {}, [x.crossed ? (x.b > x.a ? `стала выше порога ${x.threshold}` : `стала ниже порога ${x.threshold}`) : null, x.concordant ? 'так же изменилась в другой нейросети' : 'только эта нейросеть'].filter(Boolean).join('; ')),
        h('td', {}, pill(x.level))))))));
    }
    const picker = modelPicker(out, c.scores.map(s => s.model));
    if (picker) aiHead.after(picker);
    if (c.concordant.length) out.append(h('p', {}, h('b', {}, 'Согласованные изменения (SL и SSL): '), c.concordant.map(g => `${labelRu(g.label)} ${g.direction === 'up' ? '↑' : '↓'}`).join(', ')),
      h('p', { class: 'small' }, 'SL и SSL обучены на общих данных, поэтому их согласие — не полностью независимое подтверждение.'));
    if (c.scores.length) out.append(notice('Небольшие колебания оценок ИИ нормальны. В итог попадают только изменения, где согласны две нейросети.', 'info'));
    out.append(h('details', {}, h('summary', {}, 'Правила сравнения и источники'), h('div', { class: 'scroll' }, h('table', {}, h('tbody', {},
      RULES.measurements.map(r => h('tr', {}, h('td', {}, r.label), h('td', { class: 'muted' }, `шум <${r.noise}, умеренное ≥${r.minor}, выраженное ≥${r.major} ${r.unit}`),
        h('td', { class: 'muted' }, (r.basis === 'source' ? 'по источнику' : 'практический выбор') + (r.ref ? ': ' + r.ref : ''))))))),
      h('p', { class: 'small gap' }, RULES.waveform.ref)));
  }
  return out;
}

async function viewCompare(pid, a, b) {
  if (pid && a && b) {
    const { patient, records } = await loadPatient(pid);
    const ra = records.find(r => r.id === a), rb = records.find(r => r.id === b);
    if (!ra || !rb) throw Error('ЭКГ не найдена');
    const c = compareRecords(ra, rb, { sex: patient.sex });
    view.replaceChildren(backLink('#/patient/' + pid, fullName(patient)),
      pageHead('Сравнение ЭКГ', `${fullName(patient)} · ${shortDate(c.older.recordedAt)} → ${shortDate(c.newer.recordedAt)}`,
        btn('Сохранить в файл', () => saveFile(JSON.stringify(stripTemplates(c), null, 2), 'ECG-comparison.json', 'application/json'), '', 'save'),
        printButton('Сравнение ЭКГ ' + fullName(patient), ctx => comparisonReport(patient, c, ctx), 'Печать', 'primary')),
      card(comparisonView(c, patient)),
      notice(DISCLAIMER, 'info'));
    return;
  }
  // Pick a patient: opens the newest ECG against the one before it.
  const patients = await state.store.listPatients();
  const info = new Map();
  for (const p of patients) info.set(p.id, sortByDate(await state.store.listRecords(p.id)));
  const ordered = [...patients].sort((x, y) => (info.get(y.id)[0]?.recordedAt || '').localeCompare(info.get(x.id)[0]?.recordedAt || '') || fullName(x).localeCompare(fullName(y), 'ru'));
  const search = h('input', { type: 'search', placeholder: 'Фамилия пациента', 'aria-label': 'Найти пациента', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'plist' });
  let shown = [];
  const target = p => { const r = info.get(p.id); return r.length > 1 ? `#/compare/${p.id}/${r[1].id}/${r[0].id}` : null; };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    shown = ordered.filter(p => fullName(p).toLowerCase().includes(q));
    fill(list, shown.length ? shown.map(p => {
      const r = info.get(p.id), href = target(p);
      return h('a', { class: 'prow' + (href ? '' : ' off'), href: href || '#/patient/' + p.id },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(p)),
        h('div', {}, h('div', { class: 'name' }, fullName(p)), h('div', { class: 'meta' }, href ? `${shortDate(r[1].recordedAt)} → ${shortDate(r[0].recordedAt)}` : `ЭКГ: ${r.length} — для сравнения нужно две`)),
        h('div', { class: 'last' }, href ? h('b', {}, 'Сравнить') : null), h('span', { class: 'chev' }, icon('next')));
    }) : h('div', { class: 'empty' }, h('p', {}, patients.length ? 'Никого не найдено.' : 'Пациентов пока нет.')));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', e => { const t = shown[0] && target(shown[0]); if (e.key === 'Enter' && t) go(t); });
  draw();

  const fa = h('input', { type: 'file', 'aria-label': 'Первая ЭКГ' }), fb = h('input', { type: 'file', 'aria-label': 'Вторая ЭКГ' });
  const sex = h('select', {}, h('option', { value: '' }, 'не указан'), h('option', { value: 'M' }, 'мужской'), h('option', { value: 'F' }, 'женский'));
  const out = h('div'), msg = h('p', { role: 'alert', class: 'error' });
  const loadAny = async file => {
    const buffer = await readFile(file);
    if (buffer.byteLength !== 39381) {
      const data = JSON.parse(new TextDecoder().decode(buffer));
      if (data.format === 'cardioai-record') return data.record;
    }
    return recordFromECG301(buffer, file.name);
  };
  view.replaceChildren(pageHead('Сравнение ЭКГ', 'Выберите пациента — откроется его последняя ЭКГ рядом с предыдущей. Другие пары можно отметить в истории ЭКГ пациента.'),
    h('div', { class: 'search' }, icon('search'), search), list,
    h('details', { class: 'fold gap-lg' }, h('summary', {}, 'Сравнить два файла без сохранения'), h('div', { class: 'fold-body' },
      h('p', { class: 'muted' }, 'Файлы прибора ECG301 или файлы ЭКГ из CardioAI. В программу ничего не сохраняется.'),
      h('div', { class: 'form-grid' }, dropZone(fa, { compact: true, title: ['Ранняя ЭКГ: ', h('b', {}, 'выберите файл')] }), dropZone(fb, { compact: true, title: ['Поздняя ЭКГ: ', h('b', {}, 'выберите файл')] })),
      h('label', { class: 'narrow' }, 'Пол (для норм QTc)', sex), msg,
      btn('Сравнить файлы', async () => {
        msg.textContent = '';
        try {
          if (!fa.files[0] || !fb.files[0]) throw Error('Выберите оба файла');
          const [ra, rb] = [await loadAny(fa.files[0]), await loadAny(fb.files[0])];
          if (ra.sha256 && ra.sha256 === rb.sha256) throw Error('Выбран один и тот же файл дважды');
          fill(out, card(comparisonView(compareRecords(ra, rb, { sex: sex.value || null }), { sex: sex.value || null })));
        } catch (err) { msg.textContent = err.message; }
      }, 'primary', 'compare'))),
    out);
  if (matchMedia('(pointer:fine)').matches) search.focus();
}

function stripTemplates(c) {
  const w = { ...c.waveform };
  delete w.templateA; delete w.templateB;
  const brief = r => ({ recordedAt: r.recordedAt, source: r.source, deviceRecordId: r.deviceRecordId, measurements: r.measurements });
  return { format: 'cardioai-comparison', version: 1, ...c, older: brief(c.older), newer: brief(c.newer), waveform: w };
}

// ---------- neural networks
async function viewAI() {
  const parts = [pageHead('Анализ ИИ', null)];
  if (state.status) {
    parts.push(setupCard());
  } else {
    parts.push(card(h('p', {}, 'В веб-версии и на Android нейросети не запускаются: им нужен компьютер и около 3 ГБ.'),
      h('p', {}, 'Запустите анализ в программе CardioAI для Windows или Mac, сохраните результат и прикрепите его к ЭКГ пациента здесь.'),
      h('p', { class: 'muted' }, 'Пациенты, история и сравнение работают полностью и без компьютера.')));
  }
  parts.push(notice(DISCLAIMER, 'info'));
  view.replaceChildren(...parts);
}

// Neural networks: key (as in the server and result files), name, what it gives.
const MODELS = [
  ['efficientnet', 'DeepECG SL', 'быстрая, 77 заключений'],
  ['wcr', 'DeepECG SSL', '77 заключений, обычно точнее SL'],
  ['ecgfounder', 'ECGFounder', '150 заключений'],
];

// Status and one-click install of the neural networks (desktop program only).
function setupCard() {
  const box = card(h('h2', {}, 'Нейросети на этом компьютере'), h('p', { class: 'muted' }, 'Проверка…'));
  const token = document.querySelector('meta[name="cardioai-token"]')?.content;
  let timer = null, chosen = null;
  const gb = v => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  const draw = st => {
    const m = st.models || {};
    const all = MODELS.every(([k]) => m[k]);
    // Which networks to install: by default all that are not installed yet (or all, to re-check).
    chosen ??= new Set(MODELS.map(([k]) => k).filter(k => all || !m[k]));
    const need = () => {
      const weights = [...chosen].reduce((sum, k) => sum + (st.model_gb?.[k] || 0), 0);
      const total = (st.base_gb || 0) + weights;
      return total && !st.base_gb ? total + 0.5 : total;
    };
    // pip reports no progress: show a moving bar instead of a bar stuck at 0 %.
    const bar = h('progress', st.step === 'packages' && st.running ? {} : { max: 1, value: st.progress || 0 });
    const post = async path => {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ECG-Token': token }, body: JSON.stringify({ models: [...chosen] }) });
      const data = await r.json();
      if (!r.ok) { draw({ ...st, error: data.error }); return; }
      draw(data); poll();
    };
    const button = h('button', { type: 'button', class: 'primary', disabled: st.running || !st.supported || !chosen.size, onclick: () => { button.disabled = true; post('/api/setup/start'); } },
      all ? 'Переустановить / проверить' : (st.error ? 'Продолжить установку' : 'Установить выбранные'));
    const size = h('p', { class: 'muted' });
    const showSize = () => {
      size.textContent = `Нужно около ${gb(need())} ГБ${st.free_gb != null ? ', свободно ' + gb(st.free_gb) + ' ГБ' : ''}.`;
      button.disabled = st.running || !st.supported || !chosen.size;
    };
    const choice = h('fieldset', { class: 'models' }, h('legend', {}, 'Какие нейросети установить'),
      MODELS.map(([k, label, about]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: chosen.has(k), disabled: st.running, onchange: e => { e.target.checked ? chosen.add(k) : chosen.delete(k); showSize(); } }),
        h('span', {}, h('b', {}, label), ` — ${about}`, m[k] ? ' · уже установлена' : st.model_gb?.[k] === 0 ? ' · уже скачана' : st.model_gb ? ` · ${gb(Math.max(st.model_gb[k], 0.01))} ГБ` : ''))));
    showSize();
    const cancel = st.running ? btn('Отменить', () => post('/api/setup/cancel')) : null;
    fill(box, h('h2', {}, 'Нейросети на этом компьютере'),
      h('p', {}, 'Анализ идёт только здесь. ЭКГ в интернет не отправляется.'),
      h('div', { class: 'chips' }, MODELS.map(([k, l]) =>
        h('span', { class: 'pill ' + (m[k] ? 'ok' : 'warn') }, l + (m[k] ? ' · готова' : ' · не установлена')))),
      ...(st.warnings || []).map(w => notice(w)),
      st.running || st.finished || st.error ? h('div', { class: 'gap' }, bar, h('p', { class: st.error ? 'error' : 'muted' }, st.error || st.message)) : null,
      all && !st.running ? h('p', { class: 'gap' }, h('a', { href: '/' }, 'Открыть модуль запуска нейросетей →')) : null,
      !st.running ? h('div', { class: 'gap' }, choice) : null,
      !all || st.error ? h('p', { class: 'muted' }, 'Python, PyTorch и веса скачиваются один раз с официальных страниц авторов, каждый файл проверяется. Прерванная загрузка продолжится с того же места.') : null,
      size,
      st.work_dir ? h('details', {}, h('summary', {}, 'Где хранятся нейросети'), h('p', { class: 'muted' }, st.work_dir)) : null,
      st.supported ? null : notice('Для этого компьютера нет готовой сборки нейросетей. Поддерживаются Windows x64 и Mac на Apple Silicon (M1 и новее).'),
      h('div', { class: 'actions' }, button, cancel),
      notice('Файлы прибора ECG301 короче 10 секунд, поэтому нейросети по ним пока не работают. Готовый анализ (файл .json) можно прикрепить к ЭКГ пациента.'));
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
    const toggle = btn(st.enabled ? 'Выключить' : 'Включить', async () => {
      try { draw(await send({ enabled: !st.enabled, folder: folder.value.trim() || null })); }
      catch (err) { draw(st, err.message); }
    }, st.enabled ? '' : 'primary');
    const open = btn('Открыть папку', async () => {
      const r = await fetch('/api/exchange/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ECG-Token': token }, body: '{}' });
      if (!r.ok) draw(st, (await r.json()).error);
    });
    const [pillClass, pillText] = !st.enabled ? ['neutral', 'выключена'] : st.error ? ['bad', 'папка недоступна'] : st.running ? ['ok', 'работает'] : ['bad', 'остановлена — выключите и включите'];
    fill(box, h('div', { class: 'card-head' }, h('h2', {}, 'Папка обмена'), h('span', { class: 'pill ' + pillClass }, pillText)),
      h('p', {}, 'Положите файл прибора в папку «Входящие/Фамилия Имя» — программа сама добавит ЭКГ в карточку пациента и запишет результат в «Результаты». Если есть тёзки, добавьте дату рождения: «Иванов Иван 1980-05-01».'),
      h('p', { class: 'muted' }, 'Если папка лежит в Google Drive, Яндекс Диске или Dropbox, файлы можно присылать с телефона или другого компьютера.'),
      st.cloud ? notice('Папка похожа на облачную. ФИО и ЭКГ пациентов будут храниться и у облачного сервиса. Решите, допустимо ли это для ваших пациентов.') : null,
      h('label', {}, 'Папка', folder),
      h('div', { class: 'row' }, toggle, st.enabled ? open : null, btn('Обновить', refresh, 'ghost')),
      error || st.error ? h('p', { class: 'error gap', role: 'alert' }, error || st.error) : null,
      st.recent?.length ? h('div', { class: 'scroll gap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Файл'), h('th', {}, 'Пациент'), h('th', {}, 'Итог'))),
        h('tbody', {}, [...st.recent].reverse().map(e => h('tr', {}, h('td', {}, e.file), h('td', {}, e.patient || '—'),
          h('td', { class: e.status === 'error' ? 'error' : '' }, (STATUS[e.status] || e.status) + (e.new_patient ? ', новый пациент' : '') + (e.error ? ': ' + e.error : ''))))))) : null,
      h('p', { class: 'small gap' }, 'Папка работает, пока программа открыта на этом компьютере.'));
  };
  const refresh = async () => {
    try { draw(await (await fetch('/api/exchange')).json()); }
    catch (err) { box.replaceChildren(h('p', { class: 'error' }, 'Нет связи с программой: ' + err.message)); }
  };
  refresh();
  return box;
}

// ---------- data and backups
async function viewSettings() {
  const msg = h('p', { role: 'status' });
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Файл резервной копии' });
  const where = state.store.kind === 'server'
    ? 'Данные хранятся в папке на этом компьютере.'
    : 'Данные хранятся только в этом браузере или приложении. Очистка данных браузера сотрёт их — регулярно делайте резервную копию.';
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      if (!await ask(`Восстановить из «${f.name}»? Совпадающие пациенты и ЭКГ будут заменены, остальные останутся.`, { ok: 'Восстановить', danger: false })) return;
      const res = await importAll(state.store, JSON.parse(new TextDecoder().decode(await readFile(f))));
      msg.className = 'success'; msg.textContent = `Загружено: пациентов ${res.patients}, ЭКГ ${res.records}.`;
    } catch (err) { msg.className = 'error'; msg.textContent = err.message; }
  });
  view.replaceChildren(pageHead('Данные', where),
    card(h('h2', {}, 'Резервная копия'), h('p', { class: 'muted' }, 'Один файл со всеми пациентами и ЭКГ. Через него можно перенести данные между компьютером, телефоном и сайтом.'),
      h('div', { class: 'row', style: 'margin-bottom:20px' }, btn('Скачать резервную копию', async () => {
        const data = await exportAll(state.store);
        await saveFile(JSON.stringify(data), `CardioAI-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
        msg.className = 'success'; msg.textContent = `Сохранено: пациентов ${data.patients.length}, ЭКГ ${data.records.length}.`;
      }, 'primary', 'save')),
      dropZone(file, { compact: true, title: ['Восстановить из копии: перетащите файл или ', h('b', {}, 'выберите')] }), msg,
      state.store.kind === 'server' && state.status?.data_dir ? h('details', {}, h('summary', {}, 'Папка с данными'), h('p', { class: 'muted' }, state.status.data_dir)) : null),
    ...(state.store.kind === 'server' ? [exchangeCard()] : []),
    card(h('h2', {}, 'О программе'), h('p', {}, 'CardioAI — локальная исследовательская программа для просмотра ЭКГ, ведения истории и сравнения записей.'),
      h('p', { class: 'muted' }, 'Правила сравнения: версия ' + RULES.version + '. Пороги частично взяты из публикаций, частично — практические (см. docs/research).'), notice(DISCLAIMER, 'info')));
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
    console.error(err);
    // Our own messages are in Russian; anything else is an internal error.
    const ours = /[а-яё]/i.test(err.message);
    view.replaceChildren(pageHead('Не удалось открыть страницу', ours ? err.message : 'Внутренняя ошибка программы. Данные не пострадали.'),
      h('div', { class: 'row' }, btn('К списку пациентов', () => go('#/patients'), 'primary', 'back'), btn('Обновить', () => location.reload())),
      ours ? null : h('details', {}, h('summary', {}, 'Технические подробности'), h('p', { class: 'small' }, String(err.stack || err.message))));
  }
  window.scrollTo(0, 0);
}

async function start() {
  const { store, status } = await openStore();
  state.store = store; state.status = status;
  document.getElementById('mode').textContent = store.kind === 'server' ? 'Данные на этом компьютере' : 'Данные на этом устройстве';
  try { state.labelsRu = await (await fetch('data/labels-ru.json')).json(); } catch { state.labelsRu = {}; }
  if (status) try { state.thresholds = await (await fetch('/api/thresholds')).json(); } catch { state.thresholds = {}; }
  if (store.kind === 'browser' && 'serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor)
    navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('hashchange', route);
  route();
}

start();
