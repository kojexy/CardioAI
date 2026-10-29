#!/usr/bin/env python3
"""Exchange folder: ECG files put into a folder are filed under the patient automatically.

Layout of the exchange folder (it may live in a synced folder: Google Drive, Dropbox,
Yandex Disk, Syncthing…, so files can come from a phone or another computer):

    Входящие/<file>               filed by the name typed on the cardiograph (same rules as
                                  app/js/autofile.js); a new name creates a patient
    Входящие/Иванов Иван/<file>   ECG301 file for this patient (created if new); namesakes are
                                  told apart by a birth date: «Иванов Иван 1980-05-01»
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
import subprocess
import sys
import threading
import time
import unicodedata

from ecg_reader import SIZE, read_record

INBOX, RESULTS, DONE, FAILED = 'Входящие', 'Результаты', 'Обработанные', 'Ошибки'
SKIP = re.compile(r'^[.~]|^(desktop\.ini|thumbs\.db)$|\.(part|tmp|crdownload|download|icloud|txt|md|json)$', re.I)
BIRTH_DATE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})$')
CLOUD = re.compile(r'google ?drive|googledrive|dropbox|onedrive|yandex|яндекс|icloud|mobile documents|cloudstorage|mail\.ru|box sync', re.I)
PARTIAL_WAIT = 600  # seconds a too-small file may stay unchanged before it counts as broken (slow sync)
# Same photo-based estimates as app/js/ecg301.js ASSUMED (unverified).
FS_B, MICROVOLTS_PER_COUNT, ZERO_COUNTS = 200, 1.16, 2048
MEASURE_RU = [('heart_rate_bpm', 'ЧСС', 'уд/мин'), ('PR_ms', 'PR', 'мс'), ('QRS_ms', 'QRS', 'мс'), ('QT_ms', 'QT', 'мс'),
              ('QTcB_ms', 'QTc (Базетт)', 'мс'), ('QTcF_ms', 'QTc (Фридерика)', 'мс'), ('P_axis', 'Ось P', '°'),
              ('QRS_axis', 'Ось QRS', '°'), ('T_axis', 'Ось T', '°'), ('RV5_mV', 'R V5', 'мВ'), ('SV1_mV', 'S V1', 'мВ'),
              ('sokolow_mV', 'Соколов–Лайон', 'мВ'), ('RR_cv_pct', 'Вариабельность RR', '%')]
README = """Папка обмена CardioAI

1. Положите файл ЭКГ с прибора прямо в папку «Входящие». Программа прочитает имя,
   введённое на кардиографе, и добавит ЭКГ этому пациенту (или создаст новую карточку).
   Если имя на приборе не введено или есть тёзки — положите файл в папку пациента:
   Входящие/Иванов Иван/202610231707340025 или Входящие/Иванов Иван 1980-05-01/…
2. Программа CardioAI на этом компьютере сама добавит ЭКГ в карточку пациента
   (новый пациент будет создан) и сравнит с прошлыми записями.
3. В папке «Результаты/Фамилия Имя» появится файл .json — его можно добавить
   в телефоне или на сайте: Пациент → Добавить ЭКГ → Файл CardioAI.

Если папка лежит в Google Drive, Яндекс Диске, Dropbox и т. п., файлы можно класть с телефона.
Внимание: тогда ФИО и ЭКГ пациентов хранятся и у облачного сервиса. Решите, допустимо ли это.
Файлы, которые не удалось прочитать, попадают в «Ошибки» с объяснением.
Оригиналы из «Обработанных» можно удалять — запись уже сохранена в программе.
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
                  # Like the app: a non-finite float becomes NaN there, null in JSON, and is skipped.
                  **{k: js_round(meta[k], 3) if math.isfinite(meta[k]) else None for k in ('RV5_mV', 'SV1_mV')})
    return dict(id=os.urandom(16).hex(), source='ecg301', fileName=file_name, sha256=r['sha256'],
                deviceRecordId=r['record_id'], recordedAt=date_from_record_id(r['record_id']), device=device,
                measurements=derive_measurements(device),
                signal=dict(block='B', fs=FS_B, leads=r['block_B'],
                            calibration=dict(microvoltsPerCount=MICROVOLTS_PER_COUNT, zeroCounts=ZERO_COUNTS, verified=False)),
                checks=dict(limbIdentity=r['checks']['limb_identity_correlation']), ai={},
                devicePatient=device_patient(blob),
                createdAt=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))


PATIENT_FIELDS = [(22, 34), (34, 47), (47, 61)]  # as app/js/ecg301.js PATIENT_FIELDS
CYR = dict(zip('абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
               ['a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't',
                'u', 'f', 'h', 'ts', 'ch', 'sh', 'sh', '', 'i', '', 'e', 'iu', 'ia']))


def decode_field(raw):
    raw = raw.split(b'\0', 1)[0]
    for encoding in ('utf-8', 'gbk'):
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        return ' '.join(re.sub(r'[\x00-\x1f]', ' ', text).split())
    return ''


def device_patient(blob):
    """Text typed on the cardiograph (twin of devicePatient in app/js/ecg301.js)."""
    fields = [decode_field(blob[a:b]) for a, b in PATIENT_FIELDS]
    return dict(fields=fields, label=' '.join(f for f in fields if f))


def fold_word(word):
    word = ''.join(CYR.get(c, c) for c in word)
    word = re.sub('[jy]', 'i', word).replace('kh', 'h').replace('x', 'ks')
    word = re.sub('shch|sch', 'sh', word)
    word = ''.join(c for c in word if c.isalnum())
    return re.sub(r'(.)\1+', r'\1', word)


def name_key(text):
    """Twin of nameKey in app/js/autofile.js: order, case, ё and Cyrillic/Latin spelling ignored."""
    return ' '.join(sorted(w for w in map(fold_word, nfc(text or '').lower().split()) if w))


def title_case(text):
    return re.sub(r'(^|[\s-])([^\W\d_])', lambda m: m.group(1) + m.group(2).upper(), text)


def nfc(text):
    # macOS and sync clients often store й/ё as two code points (NFD); the app stores one.
    return unicodedata.normalize('NFC', text)


def patient_key(text):
    return ' '.join(nfc(text).lower().replace('ё', 'е').split())


def full_name(p, middle=True):
    return ' '.join(filter(None, [p.get('surname'), p.get('name'), p.get('middleName') if middle else None]))


def parse_folder(folder):
    """«Фамилия Имя [Отчество] [ГГГГ-ММ-ДД]» → (name words, birth date or None)."""
    words = nfc(folder).split()
    if words and BIRTH_DATE.match(words[-1]):
        return words[:-1], words[-1]
    return words, None


def safe_name(text):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', nfc(text)).strip(' .')[:120] or 'Без имени'


def looks_like_cloud(path):
    return bool(CLOUD.search(str(path)))


def open_in_file_manager(path):
    if sys.platform == 'darwin':
        subprocess.Popen(['open', str(path)])
    elif sys.platform == 'win32':
        os.startfile(str(path))  # noqa: only exists on Windows
    else:
        subprocess.Popen(['xdg-open', str(path)])


class FolderWorker:
    """Scans the inbox every few seconds in a background thread."""

    def __init__(self, store, root, interval=4.0, partial_wait=PARTIAL_WAIT):
        self.store = store
        self.root = Path(root)
        self.interval = interval
        self.partial_wait = partial_wait
        self.seen = {}  # path -> (size, mtime, first time seen unchanged); taken once it stops changing
        self.log = []
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.error = None

    # ----- control
    def start(self):
        # Only the folder itself may be created: a missing drive or cloud folder is an error,
        # not a reason to create a local look-alike that never syncs.
        self.root.mkdir(exist_ok=True)
        for sub in (INBOX, RESULTS, DONE, FAILED):
            (self.root / sub).mkdir(exist_ok=True)
        readme = self.root / 'Как пользоваться.txt'
        if not readme.exists():
            readme.write_text(README, encoding='utf-8')
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        """Stop and wait for a scan in progress; False if it is still busy after 30 s."""
        self.stop_event.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=30)
            return not self.thread.is_alive()
        return True

    def running(self):
        return bool(self.thread and self.thread.is_alive() and not self.stop_event.is_set())

    def status(self):
        with self.lock:
            return dict(folder=str(self.root), running=self.running(), error=self.error, recent=list(self.log[-20:]),
                        cloud=looks_like_cloud(self.root))

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
            except Exception as exc:  # e.g. a sync folder that is temporarily unavailable; keep going
                self.error = f'{type(exc).__name__}: {exc}'
            self.stop_event.wait(self.interval)

    # ----- work
    def scan(self):
        inbox = self.root / INBOX
        current, ready, now = {}, [], time.monotonic()
        for path in inbox.rglob('*'):
            try:
                if not path.is_file() or SKIP.search(path.name) or len(path.relative_to(inbox).parts) > 2:
                    continue
                st = path.stat()
            except OSError:  # removed or renamed by the sync client meanwhile
                continue
            sig = (st.st_size, st.st_mtime)
            before = self.seen.get(path)
            since = before[2] if before and before[:2] == sig else now
            current[path] = (*sig, since)
            if since == now:
                continue  # new or still changing: look again next time
            # An ECG301 file has a fixed size. A smaller one may still be arriving over a slow link.
            if st.st_size == SIZE or st.st_size > SIZE or now - since >= self.partial_wait:
                ready.append(path)
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
            size = path.stat().st_size
            if size != SIZE:  # do not read big unrelated files into memory
                raise ValueError(f'Это не файл ЭКГ прибора ECG301: {size} байт, ожидается {SIZE}. '
                                 'Если файл копировался долго, положите его во «Входящие» ещё раз.')
            record = record_from_ecg301(path.read_bytes(), path.name)
            owner = self.owner_of(record['sha256'])
            label = record['devicePatient']['label']
            if folder:
                patient, created = self.find_or_create_patient(folder, owner)
            else:
                patient, created = self.patient_by_device_name(record['devicePatient'], owner)
            if label and not created:
                patient = self.link_device_name(patient, label)
            existing = self.store.list_records(patient['id'])
            duplicate = owner is not None
            if not duplicate:
                record['patientId'] = patient['id']
                self.store.save_record(record)
            self.write_result(patient, record, duplicate, len(existing) + (0 if duplicate else 1))
            self.move(path, self.root / DONE / safe_name(folder or full_name(patient)))
            self._note(file=path.name, patient=folder or full_name(patient), status='duplicate' if duplicate else 'ok',
                       new_patient=created)
        except Exception as exc:  # any problem with one file must not stop the folder
            message = str(exc) if isinstance(exc, ValueError) else f'{type(exc).__name__}: {exc}'
            try:
                target = self.move(path, self.root / FAILED)
                target.with_name(target.name + '.txt').write_text(
                    f'Файл не обработан.\nПапка пациента: {folder or "—"}\nПричина: {message}\n', encoding='utf-8')
            except OSError:
                pass  # file vanished or folder unavailable; the log below still records it
            self._note(file=path.name, patient=folder, status='error', error=message)

    def owner_of(self, sha):
        """Patient that already has this exact ECG file, if any (searched in the whole database)."""
        for p in self.store.list_patients():
            if any(r.get('sha256') == sha for r in self.store.list_records(p['id'])):
                return p
        return None

    def patient_by_device_name(self, device, owner=None):
        """Same rules as fileDeviceRecord in app/js/autofile.js."""
        if owner is not None:
            return owner, False
        key = name_key(device['label'])
        if not key:
            raise ValueError('В файле не указано имя пациента. Положите его в папку пациента: Входящие/Фамилия Имя/')
        patients = self.store.list_patients()
        linked = [p for p in patients if key in (p.get('deviceLabels') or [])]
        found = linked or [p for p in patients if key in (name_key(full_name(p)), name_key(full_name(p, middle=False)))]
        if len(found) > 1:
            raise ValueError(f'Несколько пациентов подходят к имени «{device["label"]}»: '
                             + ', '.join(full_name(p) for p in found) + '. Положите файл в папку нужного пациента.')
        if found:
            return found[0], False
        _, first, second = device['fields']
        now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        patient = dict(id=os.urandom(16).hex(), surname=title_case(first or second or device['label']),
                       name=title_case(second) if first else '', middleName='', birthDate=None, sex=None,
                       notes=f'Создан автоматически по имени из файла прибора: «{device["label"]}». '
                             'Проверьте ФИО, дату рождения и пол.',
                       deviceLabels=[key], createdAt=now, updatedAt=now)
        return self.store.save_patient(patient), True

    def link_device_name(self, patient, label):
        """Remember the device name for this patient, so later files need no folder."""
        key = name_key(label)
        if not key or key in (patient.get('deviceLabels') or []):
            return patient
        patient = dict(patient, deviceLabels=(patient.get('deviceLabels') or []) + [key],
                       updatedAt=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
        return self.store.save_patient(patient)

    def find_or_create_patient(self, folder, owner=None):
        words, birth = parse_folder(folder)
        if not words:
            raise ValueError('В названии папки нет фамилии')
        key = patient_key(' '.join(words))
        named = [p for p in self.store.list_patients()
                 if key in (patient_key(full_name(p)), patient_key(full_name(p, middle=False)))]
        if birth:
            exact = [p for p in named if p.get('birthDate') == birth]
            unknown = [p for p in named if not p.get('birthDate')]
            named = exact or unknown
        if owner is not None:
            if owner['id'] in {p['id'] for p in named}:
                return owner, False
            raise ValueError(f'Эта ЭКГ уже есть в истории другого пациента: {full_name(owner)}. Проверьте папку.')
        if len(named) > 1:
            raise ValueError('Найдено несколько пациентов с таким именем. Добавьте дату рождения в название папки, '
                             'например «' + ' '.join(words) + ' 1980-05-01», и укажите её в карточке пациента.')
        if named:
            return named[0], False
        now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        patient = dict(id=os.urandom(16).hex(), surname=words[0], name=words[1] if len(words) > 1 else '',
                       middleName=' '.join(words[2:]), birthDate=birth, sex=None,
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
        lines += ['(Порядок осей P/QRS/T и масштаб сигнала взяты по образцу распечатки, производителем не подтверждены.)']
        if not patient.get('birthDate') or not patient.get('sex'):
            lines.append('Укажите в карточке пациента дату рождения и пол — от них зависят нормы QTc.')
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


def default_folder():
    """A visible folder the user can find (the data folder itself is hidden on macOS and Windows).

    On macOS not in Documents: that is often synced to iCloud.
    """
    home = Path.home()
    return (home / 'Documents' if sys.platform == 'win32' else home) / 'CardioAI Обмен'


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
