"""Read-only access to the explicitly identified short-record research report."""
import csv
import hashlib
import io
import json
import math
from pathlib import Path
from urllib.parse import urlparse

APP=Path(__file__).resolve().parent
PDF=APP.parent/'ECG301-DeepECG-full-report-2026-10-26.pdf'
RESULTS=APP.parent/'ecg-research-2026-10-26/research-results.json'
MANIFEST=APP/'research-report-manifest.json'
SOURCE=APP/'202610231707340025'


def load_report():
    manifest=json.loads(MANIFEST.read_text())
    raw=RESULTS.read_bytes();pdf=PDF.read_bytes()
    for name,data in [('results',raw),('pdf',pdf),('source',SOURCE.read_bytes())]:
        if hashlib.sha256(data).hexdigest()!=manifest[name+'_sha256']:
            raise ValueError('Контрольная сумма материалов отчёта не совпала')
    result=json.loads(raw)
    if (result.get('source_sha256')!=manifest['source_sha256']
            or result.get('synthetic') is not False
            or result.get('patient_record') is not True
            or result.get('standard_pipeline_eligible') is not False):
        raise ValueError('Тип или источник исследовательского результата не подтверждён')
    labels=list(result['models']['efficientnet']['runs']['200']['scores'])
    if len(labels)!=77 or len(set(labels))!=77:
        raise ValueError('Неверный список выходов моделей')
    names=json.loads((APP/'research-labels-ru.json').read_text())
    if set(names)!=set(labels) or not all(isinstance(v,str) for v in names.values()):
        raise ValueError('Не совпал русский словарь меток')
    url=urlparse(manifest['drive_url'])
    if url.scheme!='https' or url.netloc!='drive.google.com':
        raise ValueError('Некорректная ссылка на Google Диск')
    rows=[]
    for label in labels:
        row={'label':label,'label_ru':names[label]}
        for arch in ['efficientnet','wcr']:
            runs=result['models'][arch]['runs']
            values=[]
            for rate in ['180','200','220']:
                scores=runs[rate]['scores']
                if set(scores)!=set(labels):raise ValueError('Метки разных прогонов не совпали')
                value=scores[label]
                if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=1:
                    raise ValueError('Недопустимая оценка модели')
                values.append(value)
            row[arch]=runs['200']['scores'][label]
            row[arch+'_min']=min(values);row[arch+'_max']=max(values)
        rows.append(row)
    return dict(available=True,date=result['date'],record_id=result['record_id'],
                source_sha256=manifest['source_sha256'],pages=manifest['pages'],
                research_only=True,standard_pipeline_eligible=False,
                pdf_url='/research/report.pdf',json_url='/research/results.json',
                csv_url='/research/comparison.csv',drive_url=manifest['drive_url'],rows=rows)


def csv_report(report):
    stream=io.StringIO(newline='')
    writer=csv.writer(stream)
    writer.writerow(['RESEARCH ONLY - SHORT INPUT - NOT DIAGNOSES OR INDIVIDUAL PROBABILITIES'])
    writer.writerow(['source_sha256',report['source_sha256']])
    keys=['label','label_ru','efficientnet','wcr','efficientnet_min','efficientnet_max','wcr_min','wcr_max']
    writer.writerow(keys)
    for row in report['rows']:writer.writerow([row[k] for k in keys])
    return ('\ufeff'+stream.getvalue()).encode('utf-8')
