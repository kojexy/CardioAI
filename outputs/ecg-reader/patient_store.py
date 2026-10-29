#!/usr/bin/env python3
"""Local file storage for patients and their ECG records (one JSON file each)."""
import json
from pathlib import Path
import re
import threading

ID = re.compile(r'^[0-9a-f]{32}$')
MAX_RECORD = 1024 * 1024


def strict_loads(text):
    def invalid(value):
        raise ValueError('Недопустимое число в JSON: ' + value)
    return json.loads(text, parse_constant=invalid)


class PatientStore:
    def __init__(self, root):
        self.root = Path(root)
        self.patients = self.root / 'patients'
        self.records = self.root / 'records'
        for folder in (self.root, self.patients, self.records):
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()

    @staticmethod
    def check_id(value):
        if not isinstance(value, str) or not ID.match(value):
            raise ValueError('Некорректный идентификатор')
        return value

    def _write(self, path, item):
        raw = json.dumps(item, ensure_ascii=False, allow_nan=False)
        if len(raw.encode()) > MAX_RECORD:
            raise ValueError('Запись слишком большая')
        temp = path.with_suffix('.tmp')
        temp.write_text(raw, encoding='utf-8')
        temp.replace(path)

    def _read_all(self, folder):
        items = []
        for path in sorted(folder.glob('*.json')):
            try:
                item = strict_loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            if isinstance(item, dict) and item.get('id') == path.stem:
                items.append(item)
        return items

    def list_patients(self):
        with self.lock:
            return self._read_all(self.patients)

    def list_records(self, patient_id):
        self.check_id(patient_id)
        with self.lock:
            return [r for r in self._read_all(self.records) if r.get('patientId') == patient_id]

    def save_patient(self, patient):
        if not isinstance(patient, dict):
            raise ValueError('Ожидается объект пациента')
        self.check_id(patient.get('id'))
        if not isinstance(patient.get('surname'), str) or not patient['surname'].strip():
            raise ValueError('Укажите фамилию')
        with self.lock:
            self._write(self.patients / (patient['id'] + '.json'), patient)
        return patient

    def save_record(self, record):
        if not isinstance(record, dict):
            raise ValueError('Ожидается объект записи')
        self.check_id(record.get('id'))
        self.check_id(record.get('patientId'))
        if not isinstance(record.get('measurements'), dict):
            raise ValueError('В записи нет показателей')
        with self.lock:
            if not (self.patients / (record['patientId'] + '.json')).is_file():
                raise ValueError('Пациент не найден')
            self._write(self.records / (record['id'] + '.json'), record)
        return record

    def delete(self, kind, item_id):
        self.check_id(item_id)
        with self.lock:
            if kind == 'record':
                (self.records / (item_id + '.json')).unlink(missing_ok=True)
            elif kind == 'patient':
                for record in self.list_records(item_id):
                    (self.records / (record['id'] + '.json')).unlink(missing_ok=True)
                (self.patients / (item_id + '.json')).unlink(missing_ok=True)
            else:
                raise ValueError('Неизвестный тип')
        return {'ok': True}
