"""Verified, read-only ECGFounder research results; no inference on GET."""
import csv
import hashlib
import io
import json
import math
from pathlib import Path

APP = Path(__file__).resolve().parent
FOLDER = APP.parent / 'ecg-research-2026-10-26'
MANIFEST = APP / 'ecgfounder-comparison-manifest.json'
FILES = {'founder': FOLDER/'ecgfounder-results.json',
         'deep': FOLDER/'research-results.json',
         'comparison': FOLDER/'comparison-PM-DeepECG-ECGFounder.md',
         'pm': FOLDER/'PMcardio-original.pdf',
         'source': APP/'202610231707340025'}

# Similar concepts, not identical diagnostic definitions or interchangeable scores.
MAPPING = [
    ('Синусовый ритм','Sinusal','SINUS RHYTHM'),
    ('Фибрилляция предсердий','Afib','ATRIAL FIBRILLATION'),
    ('Трепетание предсердий','Atrial flutter','ATRIAL FLUTTER'),
    ('Желудочковые экстрасистолы','Premature ventricular complex','PREMATURE VENTRICULAR COMPLEXES'),
    ('Предсердные экстрасистолы','Premature atrial complex','PREMATURE ATRIAL COMPLEXES'),
    ('Блокада правой ножки','Right bundle branch block','RIGHT BUNDLE BRANCH BLOCK'),
    ('Блокада левой ножки','Left bundle branch block','LEFT BUNDLE BRANCH BLOCK'),
    ('АВ-блокада I степени','1st degree AV block','WITH 1ST DEGREE AV BLOCK'),
    ('Отклонение оси влево','Left axis deviation','LEFT AXIS DEVIATION'),
    ('Отклонение оси вправо','Right axis deviation','RIGHT AXIS DEVIATION'),
    ('Гипертрофия левого желудочка','Left ventricular hypertrophy','LEFT VENTRICULAR HYPERTROPHY'),
    ('Гипертрофия правого желудочка','Right ventricular hypertrophy','RIGHT VENTRICULAR HYPERTROPHY'),
    ('Увеличение левого предсердия','Left atrial enlargement','LEFT ATRIAL ENLARGEMENT'),
    ('Увеличение правого предсердия','Right atrial enlargement','RIGHT ATRIAL ENLARGEMENT'),
    ('Увеличение обоих предсердий','Bi-atrial enlargement','BIATRIAL ENLARGEMENT'),
    ('Удлинённый QT','Prolonged QT','PROLONGED QT'),
    ('Ранняя реполяризация','Early repolarization','EARLY REPOLARIZATION'),
    ('Острый перикардит','Acute pericarditis','ACUTE PERICARDITIS'),
    ('Наджелудочковая тахикардия','Supraventricular tachycardia','SUPRAVENTRICULAR TACHYCARDIA'),
    ('Желудочковая тахикардия','Ventricular tachycardia','VENTRICULAR TACHYCARDIA'),
    ('Неспецифическая задержка внутрижелудочкового проведения',
     'Nonspecific intraventricular conduction delay','NONSPECIFIC INTRAVENTRICULAR CONDUCTION DELAY'),
]


def load_founder_report():
    manifest = json.loads(MANIFEST.read_text())
    for name,path in FILES.items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest['sha256'][name]:
            raise ValueError('Checksum mismatch: '+name)
    founder = json.loads(FILES['founder'].read_text())
    deep = json.loads(FILES['deep'].read_text())
    for data in [founder,deep]:
        if (data['source_sha256'] != manifest['sha256']['source']
                or data['patient_record'] is not True or data['synthetic'] is not False
                or data['standard_pipeline_eligible'] is not False
                or data['clinical_interpretation_validated'] is not False
                or data['no_padding_to_ten_seconds'] is not True
                or data['no_repetition'] is not True):
            raise ValueError('Invalid research identity or input contract')
    if founder['model'] != 'PKUDigitalHealth/ECGFounder':
        raise ValueError('Unexpected model')
    labels = list(founder['runs']['200']['scores'])
    if len(labels) != 150 or len(set(labels)) != 150:
        raise ValueError('Expected 150 unique labels')
    all_runs = [founder['runs']] + [deep['models'][model]['runs'] for model in ['efficientnet','wcr']]
    for runs in all_runs:
        expected = set(runs['200']['scores'])
        for rate in ['180','200','220']:
            scores = runs[rate]['scores']
            if set(scores) != expected:
                raise ValueError('Mismatched run labels')
            if any(isinstance(v,bool) or not isinstance(v,(int,float))
                   or not math.isfinite(v) or not 0<=v<=1 for v in scores.values()):
                raise ValueError('Invalid model score')
    rows = []
    for label in labels:
        values = [founder['runs'][rate]['scores'][label] for rate in ['180','200','220']]
        rows.append(dict(label=label,score=values[1],minimum=min(values),maximum=max(values)))
    common = []
    for ru,deep_label,founder_label in MAPPING:
        item = dict(label_ru=ru,deep_label=deep_label,founder_label=founder_label,
                    founder=founder['runs']['200']['scores'][founder_label])
        for model in ['efficientnet','wcr']:
            item[model] = deep['models'][model]['runs']['200']['scores'][deep_label]
        common.append(item)
    return dict(available=True,research_only=True,standard_pipeline_eligible=False,
                source_sha256=founder['source_sha256'],record_id=founder['record_id'],
                common_rows=common,rows=rows,summary=manifest['summary'],
                json_url='/founder/results.json',csv_url='/founder/scores.csv',
                comparison_url='/founder/comparison.md',pm_pdf_url='/founder/pm-original.pdf')


def founder_csv(report):
    stream=io.StringIO(newline=''); writer=csv.writer(stream)
    writer.writerow(['RESEARCH ONLY - SHORT INPUT - NOT DIAGNOSES OR INDIVIDUAL PROBABILITIES'])
    writer.writerow(['source_sha256',report['source_sha256']])
    writer.writerow(['label','score_200Hz','minimum_180_200_220Hz','maximum_180_200_220Hz'])
    for row in report['rows']:
        writer.writerow([row['label'],row['score'],row['minimum'],row['maximum']])
    return ('\ufeff'+stream.getvalue()).encode('utf-8')
