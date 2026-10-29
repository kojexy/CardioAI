import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseECG301 } from '../../app/js/ecg301.js';
import { fileDeviceRecord, linkDeviceName, matchPatient, nameKey } from '../../app/js/autofile.js';
import { syntheticECG301 } from './fixtures.mjs';

// In-memory stand-in for the patient store (same methods as ServerStore / BrowserStore).
function memoryStore(patients = []) {
  const P = new Map(patients.map(p => [p.id, p])), R = new Map();
  return {
    listPatients: async () => [...P.values()],
    listRecords: async id => [...R.values()].filter(r => r.patientId === id),
    savePatient: async p => { P.set(p.id, p); return p; },
    saveRecord: async r => { R.set(r.id, r); return r; },
  };
}

let n = 0;
function deviceRecord(patient, id = '20261023170734') {
  const p = parseECG301(syntheticECG301({ id, patient }));
  return { id: String(++n).padStart(32, '0'), sha256: `sha-${id}-${patient.join('|')}`, devicePatient: p.patient, measurements: {} };
}

test('device name fields are read from the file header', () => {
  const p = parseECG301(syntheticECG301({ patient: ['', 'ivanov   ', 'petr'] })).patient;
  assert.deepEqual(p, { fields: ['', 'ivanov', 'petr'], label: 'ivanov petr' });
  assert.deepEqual(parseECG301(syntheticECG301()).patient, { fields: ['', '', ''], label: '' });
});

test('name key ignores order, case, ё, Unicode form and Cyrillic vs Latin spelling', () => {
  assert.equal(nameKey('Пётр  Иванов'), nameKey('иванов петр'));
  assert.equal(nameKey('Сергей'.normalize('NFD')), nameKey('сергей'));
  assert.equal(nameKey('Смирнова Анна'), nameKey('smirnova anna'));
  assert.equal(nameKey('Юлия Хабибуллина'), nameKey('Yuliya Khabibulina'));
  assert.equal(nameKey('Щукин Алексей'), nameKey('Shchukin Aleksei'));
  assert.notEqual(nameKey('Иванов Пётр'), nameKey('Иванова Петра'));
});

test('new name creates a patient; the same name later goes to the same patient', async () => {
  const store = memoryStore();
  const first = await fileDeviceRecord(store, deviceRecord(['', 'ivanov', 'petr'], '20260101100000'));
  assert.equal(first.status, 'ok');
  assert.equal(first.created, true);
  assert.equal(first.patient.surname, 'Ivanov');
  assert.equal(first.patient.name, 'Petr');
  const second = await fileDeviceRecord(store, deviceRecord(['', 'IVANOV', 'Petr'], '20260601100000'));
  assert.equal(second.created, false);
  assert.equal(second.patient.id, first.patient.id);
  assert.equal((await store.listRecords(first.patient.id)).length, 2);
  const again = await fileDeviceRecord(store, deviceRecord(['', 'IVANOV', 'Petr'], '20260601100000'));
  assert.equal(again.status, 'duplicate');
});

test('existing patient is found by name, and a linked device name wins over the name', async () => {
  const anna = { id: 'a'.repeat(32), surname: 'Смирнова', name: 'Анна' };
  const store = memoryStore([anna]);
  // The device keyboard is Latin-only: the Cyrillic card is still found.
  const res = await fileDeviceRecord(store, deviceRecord(['', 'smirnova', 'anna']));
  assert.equal(res.patient.id, anna.id);
  assert.deepEqual(res.patient.deviceLabels, [nameKey('smirnova anna')]);
  // The nurse typed a nickname once; after a manual add it is remembered.
  await linkDeviceName(store, res.patient, 'grisha');
  assert.equal(matchPatient(await store.listPatients(), 'Grisha').patient.id, anna.id);
});

test('namesakes or a missing name are never guessed', async () => {
  const store = memoryStore([
    { id: '1'.repeat(32), surname: 'Петров', name: 'Сергей', birthDate: '1950-01-01' },
    { id: '2'.repeat(32), surname: 'Петров', name: 'Сергей', birthDate: '1980-05-01' },
  ]);
  const twin = await fileDeviceRecord(store, deviceRecord(['', 'petrov', 'sergei']));
  assert.equal(twin.status, 'error');
  assert.match(twin.message, /несколько пациентов/);
  const nameless = await fileDeviceRecord(store, deviceRecord([]));
  assert.equal(nameless.status, 'error');
  assert.equal((await store.listPatients()).length, 2);
});
