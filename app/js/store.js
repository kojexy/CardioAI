// Storage for patients and their ECG records.
// Desktop (local Python server): files in the user's data folder via /api/store.
// Website / Android: IndexedDB inside this browser or app only.

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

class ServerStore {
  constructor(token) { this.token = token; this.kind = 'server'; }
  async call(path, body) {
    const init = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ECG-Token': this.token }, body: JSON.stringify(body),
    };
    const response = await fetch(path, init);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Ошибка ' + response.status);
    return data;
  }
  listPatients() { return this.call('/api/store/patients'); }
  listRecords(patientId) { return this.call('/api/store/patients/' + encodeURIComponent(patientId) + '/records'); }
  savePatient(p) { return this.call('/api/store/patient', p); }
  saveRecord(r) { return this.call('/api/store/record', r); }
  deletePatient(id) { return this.call('/api/store/delete', { kind: 'patient', id }); }
  deleteRecord(id) { return this.call('/api/store/delete', { kind: 'record', id }); }
}

class BrowserStore {
  constructor() { this.kind = 'browser'; this.db = null; }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('cardioai', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('patients', { keyPath: 'id' });
        db.createObjectStore('records', { keyPath: 'id' }).createIndex('patientId', 'patientId');
      };
      req.onsuccess = () => resolve(this.db = req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  }
  listPatients() { return this.tx('patients', 'readonly', s => s.getAll()); }
  listRecords(patientId) { return this.tx('records', 'readonly', s => s.index('patientId').getAll(patientId)); }
  async savePatient(p) { await this.tx('patients', 'readwrite', s => s.put(p)); return p; }
  async saveRecord(r) { await this.tx('records', 'readwrite', s => s.put(r)); return r; }
  async deleteRecord(id) { await this.tx('records', 'readwrite', s => s.delete(id)); return { ok: true }; }
  async deletePatient(id) {
    for (const r of await this.listRecords(id)) await this.deleteRecord(r.id);
    await this.tx('patients', 'readwrite', s => s.delete(id));
    return { ok: true };
  }
}

export async function openStore() {
  const token = document.querySelector('meta[name="cardioai-token"]')?.content;
  if (token && token !== '__TOKEN__') {
    try {
      const status = await (await fetch('/api/status')).json();
      if (status.storage) return { store: new ServerStore(token), status };
    } catch { /* fall back to browser storage */ }
  }
  return { store: new BrowserStore(), status: null };
}

// Full backup: one JSON file with every patient and record.
export async function exportAll(store) {
  const patients = await store.listPatients();
  const records = [];
  for (const p of patients) records.push(...await store.listRecords(p.id));
  return { format: 'cardioai-backup', version: 1, exportedAt: new Date().toISOString(), patients, records };
}

export async function importAll(store, data) {
  if (data?.format !== 'cardioai-backup' || !Array.isArray(data.patients) || !Array.isArray(data.records))
    throw Error('Это не файл резервной копии CardioAI');
  const known = new Set(data.patients.map(p => p.id));
  for (const p of data.patients) await store.savePatient(p);
  let records = 0;
  for (const r of data.records) if (known.has(r.patientId)) { await store.saveRecord(r); records++; }
  return { patients: data.patients.length, records };
}
