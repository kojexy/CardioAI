// Files a cardiograph ECG under the right patient by the name typed on the device.
// Same rules as outputs/ecg-reader/folder_worker.py (exchange folder); keep them in step.
//
// 1. The same file already in the database → "duplicate", nothing is added.
// 2. A patient linked to this device name (patient.deviceLabels) → that patient.
// 3. Otherwise a patient whose surname + name (+ middle name) are the same words, in any order.
// 4. Otherwise a new patient is created from the device fields (to be corrected by the user).
// Two or more candidates → error: never guess between namesakes.
import { newId } from './store.js';

// Cyrillic → Latin, then fold common spelling variants, because the cardiograph keyboard is
// Latin-only: «Смирнова Анна» must match «smirnova anna», «Пётр» — «petr», «Юлия» — «yuliya».
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i',
  ь: '', э: 'e', ю: 'iu', я: 'ia' };
function foldWord(word) {
  return [...word].map(c => CYR[c] ?? c).join('')
    .replace(/[jy]/g, 'i').replace(/kh/g, 'h').replace(/x/g, 'ks').replace(/shch|sch/g, 'sh')
    .replace(/[^\p{L}\p{N}]/gu, '').replace(/(.)\1+/g, '$1');
}

export function nameKey(text) {
  return String(text || '').normalize('NFC').toLowerCase()
    .split(/\s+/).map(foldWord).filter(Boolean).sort().join(' ');
}

const fullName = (p, middle = true) => [p.surname, p.name, middle ? p.middleName : null].filter(Boolean).join(' ');
const titleCase = text => text.replace(/(^|[\s-])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());

export function matchPatient(patients, label) {
  const key = nameKey(label);
  if (!key) return { reason: 'noname' };
  const linked = patients.filter(p => (p.deviceLabels || []).includes(key));
  const candidates = linked.length ? linked
    : patients.filter(p => nameKey(fullName(p)) === key || nameKey(fullName(p, false)) === key);
  if (candidates.length > 1) return { reason: 'ambiguous', candidates };
  return candidates.length ? { patient: candidates[0], key, linked: linked.length > 0 } : { key };
}

export function patientFromDevice(devicePatient) {
  // Two name fields were seen in a real file (bytes 34–46 and 47–60): taken as surname and name.
  const [, first, second] = devicePatient.fields;
  const surname = titleCase(first || second || devicePatient.label);
  const now = new Date().toISOString();
  return {
    id: newId(), surname, name: first ? titleCase(second || '') : '', middleName: '', birthDate: null, sex: null,
    notes: `Создан автоматически по имени из файла прибора: «${devicePatient.label}». Проверьте ФИО, дату рождения и пол.`,
    deviceLabels: [nameKey(devicePatient.label)], createdAt: now, updatedAt: now,
  };
}

// Remember that this device name belongs to this patient (after a manual or automatic match).
export async function linkDeviceName(store, patient, label) {
  const key = nameKey(label);
  if (!key || (patient.deviceLabels || []).includes(key)) return patient;
  const updated = { ...patient, deviceLabels: [...(patient.deviceLabels || []), key], updatedAt: new Date().toISOString() };
  await store.savePatient(updated);
  return updated;
}

// Returns { status: 'ok' | 'duplicate' | 'error', patient?, created?, message? }.
export async function fileDeviceRecord(store, record) {
  const patients = await store.listPatients();
  for (const p of patients) {
    if ((await store.listRecords(p.id)).some(r => r.sha256 && r.sha256 === record.sha256))
      return { status: 'duplicate', patient: p, message: 'уже есть в истории' };
  }
  const label = record.devicePatient?.label || '';
  const found = matchPatient(patients, label);
  if (found.reason === 'noname')
    return { status: 'error', message: 'в файле не указано имя пациента — добавьте ЭКГ через карточку пациента' };
  if (found.reason === 'ambiguous')
    return { status: 'error', message: `несколько пациентов подходят к имени «${label}»: ${found.candidates.map(p => fullName(p)).join(', ')} — добавьте через нужную карточку` };
  let patient = found.patient, created = false;
  if (patient) patient = await linkDeviceName(store, patient, label);
  else { patient = patientFromDevice(record.devicePatient); await store.savePatient(patient); created = true; }
  await store.saveRecord({ ...record, patientId: patient.id });
  return { status: 'ok', patient, created };
}
