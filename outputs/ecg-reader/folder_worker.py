#!/usr/bin/env python3
"""Exchange folder: ECG files put into a folder are filed under the patient automatically.

Layout of the exchange folder (it may live in a synced folder: Google Drive, Dropbox,
Yandex Disk, Syncthing…, so files can come from a phone or another computer):

    Входящие/Иванов Иван/<file>   ECG301 file for this patient (created if new)
    Результаты/Иванов Иван/       one "cardioai-record" JSON + short text per ECG;
                                  the JSON can be added on the phone or website
                                  (Пациент → Добавить ЭКГ → Файл CardioAI)
    Обработанные/Иванов Иван/     originals after successful filing
    Ошибки/                       files that could not be read, with the reason

The record format is the same as the app creates (app/js/main.js recordFromECG301);
test_folder_worker.py checks this against the JavaScript decoder.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import time

from ecg_reader import read_record

INBOX, RESULTS, DONE, FAILED = 'Входящие', 'Результаты', 'Обработанные', 'Ошибки'
SKIP = re.compile(r'^[.~]|\.(part|tmp|crdownload|download|icloud|txt|md|json)$', re.I)
# Same photo-based estimates as app/js/ecg301.js ASSUMED (unverified).
FS_B, MICROVOLTS_PER_COUNT, ZERO_COUNTS = 200, 1.16, 2048
MEASURE_RU = [('heart_rate_bpm', 'ЧСС', 'уд/мин'), ('PR_ms', 'PR', 'мс'), ('QRS_ms', 'QRS', 'мс'), ('QT_ms', 'QT', 'мс'),
              ('QTcB_ms', 'QTc (Базетт)', 'мс'), ('QTcF_ms', 'QTc (Фридерика)', 'мс'), ('P_axis', 'Ось P', '°'),
              ('QRS_axis', 'Ось QRS', '°'), ('T_axis', 'Ось T', '°'), ('RV5_mV', 'R V5', 'мВ'), ('SV1_mV', 'S V1', 'мВ'),
              ('sokolow_mV', 'Соколов–Лайон', 'мВ'), ('RR_cv_pct', 'Вариабельность RR', '%')]
README = """Папка обмена CardioAI

1. Положите файл ЭКГ с прибора в папку «Входящие/Фамилия Имя» (папку можно создать).
   Например: Входящие/Иванов Иван/202610231707340025
2. Программа CardioAI на этом компьютере сама добавит ЭКГ в карточку пациента
   (новый пациент будет создан) и сравнит с прошлыми записями.
3. В папке «Результаты/Фамилия Имя» появится файл .json — его можно добавить
   в телефоне или на сайте: Пациент → Добавить ЭКГ → Файл CardioAI.

Если папка лежит в Google Drive, Яндекс Диске, Dropbox и т. п., файлы можно класть с телефона.
Файлы, которые не удалось прочитать, попадают в «Ошибки» с объяснением.
"""


def js_round(value, digits=0):
    """Math.round semantics (half up), so stored numbers match the app exactly."""
    k = 10 ** digits
    return math.floor(value * k + 0.5) / k if digits else int(math.floor(value + 0.5))


def signed_axis(v):
    a = v - 65536 if v > 32767 else v
    a %= 360
    return a - 360 if a > 180 else a


def date_from_record_id(rid):
    m = re.match(r'^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})', rid or '')
    if not m:
        return None
    y, mo, d, h, mi, s = map(int, m.groups())
    if not (1 <= mo <= 12 and 1 <= d <= 31 and h <= 23 and mi <= 59 and s <= 59):
        return None
    return '{}-{}-{}T{}:{}:{}'.format(*m.groups())


def derive_measurements(device):
    """Python twin of deriveMeasurements in app/js/measure.js."""
    m = {k: device[k] for k in ('heart_rate_bpm', 'PR_ms', 'QRS_ms', 'QT_ms', 'QTc_ms', 'P_axis', 'QRS_axis',
                                'T_axis', 'RV5_mV', 'SV1_mV') if isinstance(device.get(k), (int, float))}
    rr = [v for v in device.get('RR_ms', []) if isinstance(v, (int, float))]
    rr_mean = sum(rr) / len(rr) if rr else (60000 / m['heart_rate_bpm'] if m.get('heart_rate_bpm') else math.nan)
    if len(rr) >= 3:
        sd = math.sqrt(sum((v - rr_mean) ** 2 for v in rr) / (len(rr) - 1))
        m['RR_mean_ms'] = js_round(rr_mean)
        m['RR_sd_ms'] = js_round(sd)
        m['RR_cv_pct'] = js_round(100 * sd / rr_mean, 2)
    if 'QT_ms' in m and rr_mean > 0:
        rr_sec = rr_mean / 1000
        m['QTcB_ms'] = js_round(m['QT_ms'] / math.sqrt(rr_sec))
        m['QTcF_ms'] = js_round(m['QT_ms'] / rr_sec ** (1 / 3))
    if 'SV1_mV' in m:
        m['SV1_mV'] = abs(m['SV1_mV'])
    if 'RV5_mV' in m and 'SV1_mV' in m:
        m['sokolow_mV'] = js_round(abs(m['RV5_mV']) + m['SV1_mV'], 2)
    if 'QRS_axis' in m and 'T_axis' in m:
        d = ((m['T_axis'] - m['QRS_axis']) % 360 + 360) % 360
        m['QRS_T_angle_deg'] = abs(d - 360 if d > 180 else d)
    return m


def record_from_ecg301(blob, file_name):
    """Python twin of recordFromECG301 in app/js/main.js (without patientId)."""
    r = read_record(blob)
    meta = r['inferred_metadata']
    axes = [signed_axis(v) for v in meta['axes_degrees']]
    device = dict(heart_rate_bpm=meta['heart_rate_bpm'], PR_ms=meta['PR_ms'], QRS_ms=meta['QRS_ms'], QT_ms=meta['QT_ms'],
                  QTc_ms=meta['QTc_ms'], RR_ms=meta['RR_ms'], P_axis=axes[0], QRS_axis=axes[1], T_axis=axes[2],
                  RV5_mV=js_round(meta['RV5_mV'], 3), SV1_mV=js_round(meta['SV1_mV'], 3))
    return dict(id=os.urandom(16).hex(), source='ecg301', fileName=file_name, sha256=r['sha256'],
                deviceRecordId=r['record_id'], recordedAt=date_from_record_id(r['record_id']), device=device,
                measurements=derive_measurements(device),
                signal=dict(block='B', fs=FS_B, leads=r['block_B'],
                            calibration=dict(microvoltsPerCount=MICROVOLTS_PER_COUNT, zeroCounts=ZERO_COUNTS, verified=False)),
                checks=dict(limbIdentity=r['checks']['limb_identity_correlation']), ai={},
                createdAt=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))


def patient_key(text):
    return ' '.join(text.lower().replace('ё', 'е').split())


def safe_name(text):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', text).strip(' .')[:120] or 'Без имени'


class FolderWorker:
    """Scans the inbox every few seconds in a background thread."""

    def __init__(self, store, root, interval=4.0):
        self.store = store
        self.root = Path(root)
        self.interval = interval
        self.seen = {}  # path -> (size, mtime) from the previous scan; a file is taken once it stops changing
        self.log = []
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.error = None

    # ----- control
    def start(self):
        for sub in (INBOX, RESULTS, DONE, FAILED):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        readme = self.root / 'Как пользоваться.txt'
        if not readme.exists():
            readme.write_text(README, encoding='utf-8')
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def running(self):
        return bool(self.thread and self.thread.is_alive() and not self.stop_event.is_set())

    def status(self):
        with self.lock:
            return dict(folder=str(self.root), running=self.running(), error=self.error, recent=list(self.log[-20:]))

    def _note(self, **entry):
        entry['at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        with self.lock:
            self.log.append(entry)
            del self.log[:-100]

    def _loop(self):
        while not self.stop_event.is_set():
            try:
                self.scan()
                self.error = None
            except OSError as exc:  # e.g. a sync folder that is temporarily unavailable
                self.error = str(exc)
            self.stop_event.wait(self.interval)

    # ----- work
    def scan(self):
        inbox = self.root / INBOX
        current = {}
        for path in inbox.rglob('*'):
            if path.is_file() and not SKIP.search(path.name) and len(path.relative_to(inbox).parts) <= 2:
                st = path.stat()
                current[path] = (st.st_size, st.st_mtime)
        ready = [p for p, sig in current.items() if self.seen.get(p) == sig]
        self.seen = current
        for path in sorted(ready):
            self.process(path)
            self.seen.pop(path, None)
        return len(ready)

    def process(self, path):
        inbox = self.root / INBOX
        parts = path.relative_to(inbox).parts
        folder = parts[0] if len(parts) == 2 else None
        try:
            if not folder:
                raise ValueError('Положите файл в папку с фамилией и именем пациента: Входящие/Фамилия Имя/')
            blob = path.read_bytes()
            record = record_from_ecg301(blob, path.name)
            patient, created = self.find_or_create_patient(folder)
            existing = self.store.list_records(patient['id'])
            duplicate = any(r.get('sha256') == record['sha256'] for r in existing)
            if not duplicate:
                record['patientId'] = patient['id']
                self.store.save_record(record)
            self.write_result(patient, record, duplicate, len(existing) + (0 if duplicate else 1))
            self.move(path, self.root / DONE / safe_name(folder))
            self._note(file=path.name, patient=folder, status='duplicate' if duplicate else 'ok', new_patient=created)
        except (ValueError, UnicodeError, KeyError) as exc:
            target = self.move(path, self.root / FAILED)
            target.with_name(target.name + '.txt').write_text(f'Файл не обработан: {exc}\n', encoding='utf-8')
            self._note(file=path.name, patient=folder, status='error', error=str(exc))

    def find_or_create_patient(self, folder):
        words = folder.split()
        key = patient_key(folder)
        for p in self.store.list_patients():
            if patient_key(' '.join(filter(None, [p.get('surname'), p.get('name'), p.get('middleName')]))) == key \
                    or patient_key(' '.join(filter(None, [p.get('surname'), p.get('name')]))) == key:
                return p, False
        now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        patient = dict(id=os.urandom(16).hex(), surname=words[0], name=words[1] if len(words) > 1 else '',
                       middleName=' '.join(words[2:]), birthDate=None, sex=None,
                       notes='Создан автоматически из папки обмена', createdAt=now, updatedAt=now)
        return self.store.save_patient(patient), True

    def write_result(self, patient, record, duplicate, count):
        folder = self.root / RESULTS / safe_name(' '.join(filter(None, [patient.get('surname'), patient.get('name')])))
        folder.mkdir(parents=True, exist_ok=True)
        stem = (record['recordedAt'] or record['deviceRecordId']).replace(':', '-')
        export = {k: v for k, v in record.items() if k not in ('id', 'patientId')}
        (folder / f'{stem}.json').write_text(json.dumps(dict(
            format='cardioai-record', version=1, exportedAt=record['createdAt'],
            patient={k: patient.get(k) for k in ('surname', 'name', 'middleName', 'birthDate', 'sex')},
            record=export), ensure_ascii=False), encoding='utf-8')
        m = record['measurements']
        lines = [' '.join(filter(None, [patient.get('surname'), patient.get('name')])),
                 'ЭКГ от ' + (record['recordedAt'] or '?').replace('T', ' '),
                 'Уже была в истории — повторно не добавлена.' if duplicate else f'Добавлена в историю пациента (всего ЭКГ: {count}).', '']
        lines += [f'{label}: {m[key]} {unit}' for key, label, unit in MEASURE_RU if key in m]
        lines += ['', 'Сравнение с прошлыми ЭКГ — в программе CardioAI, в карточке пациента.',
                  'Исследовательская программа, не медицинское заключение.']
        (folder / f'{stem}.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    @staticmethod
    def move(path, folder):
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / path.name
        n = 1
        while target.exists():
            target = folder / f'{path.stem} ({n}){path.suffix}'
            n += 1
        shutil.move(str(path), str(target))
        return target


def default_folder(data_root):
    return Path(data_root) / 'Папка обмена'


def load_settings(data_root):
    try:
        value = json.loads((Path(data_root) / 'settings.json').read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(data_root, **changes):
    settings = dict(load_settings(data_root), **changes)
    path = Path(data_root) / 'settings.json'
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)
    return settings


if __name__ == '__main__':  # quick manual run: python folder_worker.py <exchange folder> <store folder>
    import sys
    from patient_store import PatientStore
    worker = FolderWorker(PatientStore(sys.argv[2]), sys.argv[1])
    worker.start()
    while True:
        time.sleep(1)
