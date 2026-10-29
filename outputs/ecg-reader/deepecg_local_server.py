#!/usr/bin/env python3
"""ECG301 local desktop web interface. Binds only to 127.0.0.1."""
import argparse
import base64
import binascii
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import uuid
import urllib.request
import webbrowser

from ecg_reader import LEADS
from patient_store import PatientStore

# In a packaged desktop build the module sits at the bundle root; resources keep repo layout.
APP = (Path(sys._MEIPASS) / 'outputs/ecg-reader' if getattr(sys, 'frozen', False)
       else Path(__file__).resolve().parent)
# Shared web app (patients, comparison). Inside a packaged desktop build it sits in the bundle.
WEB_APP = Path(getattr(sys, '_MEIPASS', APP.parents[1])) / 'app'
MAX_BODY = 2 * 1024 * 1024
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'}


def code_home():
    """Folder with the CardioAI source checkout and work/ (models, venv)."""
    return Path(os.environ.get('CARDIOAI_HOME') or APP.parents[1])


def model_python():
    home = code_home()
    for candidate in (home / 'work/deepecg-venv/bin/python', home / 'work/deepecg-venv/Scripts/python.exe'):
        if candidate.is_file():
            return str(candidate)
    return None if getattr(sys, 'frozen', False) else sys.executable


def strict_json(data):
    def invalid(value):
        raise ValueError('Недопустимое число в JSON: ' + value)
    return json.loads(data, parse_constant=invalid)


def uploaded(data, key):
    value = data.get(key)
    if not isinstance(value, str):
        raise ValueError('Не выбран файл: ' + key)
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('Файл повреждён при передаче') from None
    if not raw or len(raw) > MAX_BODY:
        raise ValueError('Файл пустой или слишком большой')
    return raw


def check_provenance(meta, raw):
    if not isinstance(meta, dict):
        raise ValueError('Описание входа должно быть объектом JSON')
    if meta.get('signal_sha256') != hashlib.sha256(raw).hexdigest():
        raise ValueError('Контрольная сумма сигнала не совпала с описанием')
    if (meta.get('lead_order') != LEADS or meta.get('output_shape') != [2500, 12]
            or meta.get('output_rate_hz') != 250 or meta.get('output_units') != 'mV'):
        raise ValueError('Нужны 12 отведений, 250 Гц, 10 секунд и единицы мВ')
    conversion = meta.get('conversion', {})
    if not isinstance(conversion, dict) or any(conversion.get(k) is not True for k in
            ('timing_verified', 'calibration_verified', 'simultaneous_verified')):
        raise ValueError('Нет подтверждённых времени, масштаба и синхронности')
    if not str(meta.get('verification_evidence', '')).strip():
        raise ValueError('Нет основания для подтверждения параметров')


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=8766, runs=None):
        runs = runs or os.environ.get('CARDIOAI_DATA')
        self.lock = threading.RLock()
        self.children = set()
        self.stopping = False
        super().__init__(('127.0.0.1', port), Handler)
        self.token = secrets.token_hex(32)
        self.runs = Path(runs) if runs else APP / 'local-runs'
        self.runs.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store = PatientStore(self.runs / 'cardioai-store')
        self.jobs = {}
        self.slot = threading.BoundedSemaphore(1)
        for entry in sorted(self.runs.glob('*/job.json')):
            try:
                job = strict_json(entry.read_text())
                if not isinstance(job, dict) or job.get('id') != entry.parent.name:
                    continue
                uuid.UUID(hex=job['id'])
                if job.get('state') == 'running':
                    job.update(state='failed', error='Расчёт прерван при остановке программы')
                if job.get('state') == 'complete':
                    job['report'] = strict_json((entry.parent / 'result.json').read_text())
                self.jobs[job['id']] = job
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def save_job(self, job_id):
        job = {k:v for k,v in self.jobs[job_id].items() if k != 'report'}
        target = self.runs / job_id / 'job.json'
        temp = target.with_suffix('.tmp')
        temp.write_text(json.dumps(job, ensure_ascii=False, indent=2))
        temp.replace(target)

    def server_close(self):
        with self.lock:
            self.stopping = True
            for child in tuple(self.children):
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
        super().server_close()

    def models(self):
        home = code_home()
        if model_python() is None:
            return {'efficientnet': False, 'wcr': False, 'ecgfounder': False}
        weights = home / 'work/deepecg-weights'
        names = {'efficientnet': ['efficientnet_deepecg_unscaled.pt'],
                 'wcr': ['base_ssl.pt', 'wcr_77_classes.pt']}
        found = {key: all((weights / name).is_file() and
                         (weights / (name + '.json')).is_file() for name in files)
                for key, files in names.items()}
        founder = home / 'work/ecgfounder-weights/12_lead_ECGFounder.pth'
        found['ecgfounder'] = (founder.is_file() and founder.with_suffix('.pth.json').is_file()
                               and (home / 'outputs/ecg-reader/ecgfounder-source-manifest.json').is_file())
        return found

    def start_job(self, data):
        model = data.get('model')
        mode = data.get('mode')
        if model not in ('efficientnet', 'wcr', 'ecgfounder') or mode not in ('self_test', 'prepared'):
            raise ValueError('Неизвестная модель или режим')
        if not self.models()[model]:
            raise ValueError('Весов выбранной модели нет в локальном окружении')
        if not self.slot.acquire(blocking=False):
            raise BlockingIOError('Один расчёт уже выполняется. Дождитесь результата.')
        folder = None
        try:
            raw = meta = None
            if mode == 'prepared':
                raw = uploaded(data, 'signal')
                meta = strict_json(uploaded(data, 'provenance'))
                check_provenance(meta, raw)
                # Check the actual array; JSON flags alone are insufficient.
                import io
                import numpy as np
                array = np.load(io.BytesIO(raw), allow_pickle=False)
                if not isinstance(array, np.ndarray) or array.shape != (2500, 12):
                    raise ValueError('Неверная форма NPY: ожидается (2500,12)')
                if array.dtype.kind not in 'fiu' or not np.isfinite(array).all():
                    raise ValueError('NPY содержит недопустимые значения')
                if np.any(np.ptp(array, axis=0) == 0):
                    raise ValueError('Обнаружено отведение без сигнала')
            job_id = uuid.uuid4().hex
            folder = self.runs / job_id
            folder.mkdir(mode=0o700)
            if raw is not None:
                (folder / 'signal_mV_250Hz.npy').write_bytes(raw)
                (folder / 'provenance.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2))
            with self.lock:
                self.jobs[job_id] = dict(id=job_id, state='running', model=model,
                                         synthetic=(mode == 'self_test' or (meta is not None and meta.get('synthetic_input') is True)),
                                         created_at=datetime.now(timezone.utc).isoformat())
                self.save_job(job_id)
            threading.Thread(target=self.worker, args=(job_id, folder, mode, model), daemon=True).start()
            return self.jobs[job_id].copy()
        except Exception:
            self.slot.release()
            raise

    def worker(self, job_id, folder, mode, model):
        process = None
        try:
            scripts = code_home() / 'outputs/ecg-reader'
            python = model_python()
            if python is None:
                raise RuntimeError('Не найдено окружение моделей (work/deepecg-venv)')
            command = ([python, str(scripts / 'ecgfounder_run_local.py')]
                       if model == 'ecgfounder' else
                       [python, str(scripts / 'deepecg_run_local.py'), '--model', model])
            command += ['--report', str(folder / 'result.json')]
            command += ['--smoke-test'] if mode == 'self_test' else ['--input-dir', str(folder)]
            with (folder / 'run.log').open('w') as log:
                with self.lock:
                    if self.stopping:
                        raise RuntimeError('Локальная программа остановлена')
                    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    self.children.add(process)
                try:
                    returncode = process.wait(timeout=600)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                    raise RuntimeError('Превышено время расчёта — 10 минут') from None
            if returncode:
                raise RuntimeError('Модель завершилась с ошибкой. Подробности — в журнале.')
            report = strict_json((folder / 'result.json').read_text())
            with self.lock:
                self.jobs[job_id].update(state='complete', report=report)
                self.save_job(job_id)
        except Exception as exc:
            with self.lock:
                self.jobs[job_id].update(state='failed', error=str(exc))
                self.save_job(job_id)
        finally:
            if process is not None:
                with self.lock:
                    self.children.discard(process)
            self.slot.release()


class Handler(BaseHTTPRequestHandler):
    server_version = 'ECG301Local/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def allowed_host(self):
        port = self.server.server_address[1]
        return self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')

    def respond(self, status, content, mime='application/json; charset=utf-8', attachment=None):
        raw = content if isinstance(content, bytes) else content.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if attachment:
            self.send_header('Content-Disposition', f'attachment; filename="{attachment}"')
        self.end_headers()
        self.wfile.write(raw)

    def redirect(self, location):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def static_app(self, relative):
        relative = relative.split('?', 1)[0] or 'index.html'
        root = WEB_APP.resolve()
        target = (root / relative).resolve()
        if root not in target.parents or not target.is_file() or target.suffix not in STATIC_TYPES:
            return self.answer(404, {'error': 'Не найдено'})
        if target == root / 'index.html':
            html = target.read_text(encoding='utf-8').replace('__TOKEN__', self.server.token)
            return self.respond(200, html, STATIC_TYPES['.html'])
        return self.respond(200, target.read_bytes(), STATIC_TYPES[target.suffix])

    def answer(self, status, value):
        self.respond(status, json.dumps(value, ensure_ascii=False, allow_nan=False))

    def do_GET(self):
        try:
            self.get()
        except OSError:
            self.answer(404, {'error': 'Файл недоступен в этой установке'})

    def get(self):
        if not self.allowed_host():
            return self.answer(403, {'error': 'Недопустимый адрес сервера'})
        if self.path == '/':
            html = (APP / 'DeepECG-local.html').read_text().replace('__TOKEN__', self.server.token)
            return self.respond(200, html, 'text/html; charset=utf-8')
        if self.path == '/api/status':
            return self.answer(200, dict(app='ECG301-DeepECG-local', version=4,
                                        models=self.server.models(), local_only=True,
                                        storage=True, data_dir=str(self.server.store.root)))
        if self.path == '/app':
            return self.redirect('/app/')
        if self.path.startswith('/app/'):
            return self.static_app(self.path[len('/app/'):])
        if self.path == '/api/store/patients':
            return self.answer(200, self.server.store.list_patients())
        store_parts = self.path.strip('/').split('/')
        if len(store_parts) == 5 and store_parts[:3] == ['api', 'store', 'patients'] and store_parts[4] == 'records':
            try:
                return self.answer(200, self.server.store.list_records(store_parts[3]))
            except ValueError as exc:
                return self.answer(400, {'error': str(exc)})
        if self.path in ('/api/founder-report','/founder/results.json','/founder/scores.csv',
                         '/founder/comparison.md','/founder/pm-original.pdf'):
            try:
                from founder_report import load_founder_report,founder_csv,FILES
                report=load_founder_report()
            except (OSError,ValueError,KeyError,TypeError) as exc:
                return self.answer(404,{'available':False,'error':'Сравнение недоступно или не прошло проверку: '+str(exc)})
            if self.path=='/api/founder-report': return self.answer(200,report)
            if self.path=='/founder/results.json':
                return self.respond(200,FILES['founder'].read_bytes(),attachment='ECGFounder-research-results.json')
            if self.path=='/founder/scores.csv':
                return self.respond(200,founder_csv(report),'text/csv; charset=utf-8',attachment='ECGFounder-research-scores.csv')
            if self.path=='/founder/pm-original.pdf':
                return self.respond(200,FILES['pm'].read_bytes(),'application/pdf',attachment='PMcardio-original.pdf')
            return self.respond(200,FILES['comparison'].read_bytes(),'text/plain; charset=utf-8',attachment='ECG-model-comparison.md')
        if self.path in ('/api/research-report','/research/report.pdf','/research/results.json','/research/comparison.csv'):
            try:
                from research_report import load_report,csv_report,PDF,RESULTS
                report=load_report()
            except (OSError,ValueError,KeyError,TypeError) as exc:
                return self.answer(404,{'available':False,'error':'Материалы отчёта недоступны или не прошли проверку: '+str(exc)})
            if self.path=='/api/research-report':return self.answer(200,report)
            if self.path=='/research/report.pdf':
                return self.respond(200,PDF.read_bytes(),'application/pdf',attachment='ECG301-DeepECG-full-report-2026-10-26.pdf')
            if self.path=='/research/results.json':
                return self.respond(200,RESULTS.read_bytes(),attachment='research-results.json')
            return self.respond(200,csv_report(report),'text/csv; charset=utf-8',attachment='DeepECG-SL-SSL-research-comparison.csv')
        if self.path == '/api/history':
            with self.server.lock:
                jobs = [{k:v for k,v in job.items() if k != 'report'} for job in self.server.jobs.values()]
            jobs.sort(key=lambda job:job.get('created_at',''),reverse=True)
            return self.answer(200, jobs[:50])
        if self.path == '/reader':
            return self.respond(200, (APP / 'ECG301-reader.html').read_bytes(), 'text/html; charset=utf-8')
        if self.path == '/guide':
            return self.respond(200, (APP / 'DeepECG-README-ru.md').read_bytes(), 'text/plain; charset=utf-8')
        reference_files = {'/verification/photo-check.md': 'text/plain; charset=utf-8',
                           '/verification/overlay-1.png': 'image/png',
                           '/verification/overlay-2.png': 'image/png',
                           '/preliminary-calibration.png': 'image/png'}
        if self.path in reference_files:
            return self.respond(200, (APP / self.path.lstrip('/')).read_bytes(), reference_files[self.path])
        parts = self.path.strip('/').split('/')
        if len(parts) in (3, 4) and parts[:2] == ['api', 'jobs']:
            job_id = parts[2]
            with self.server.lock:
                job = self.server.jobs.get(job_id)
                job = job.copy() if job else None
            if not job:
                return self.answer(404, {'error': 'Задание не найдено'})
            if len(parts) == 3:
                return self.answer(200, job)
            filenames = {'report': 'result.json', 'log': 'run.log'}
            filename = filenames.get(parts[3])
            if filename:
                path = self.server.runs / job_id / filename
                if path.is_file():
                    mime = 'application/json; charset=utf-8' if filename.endswith('.json') else 'text/plain; charset=utf-8'
                    return self.respond(200, path.read_bytes(), mime, filename)
        self.answer(404, {'error': 'Не найдено'})

    def do_POST(self):
        if not self.allowed_host():
            return self.answer(403, {'error': 'Недопустимый адрес сервера'})
        if (self.headers.get('X-ECG-Token') != self.server.token or
                self.headers.get('Origin') != 'http://' + self.headers.get('Host', '')):
            return self.answer(403, {'error': 'Откройте программу в этом локальном окне'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.answer(415, {'error': 'Ожидается JSON'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BODY:
                return self.answer(413, {'error': 'Слишком большой или пустой запрос'})
            data = strict_json(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('Ожидается объект JSON')
            if self.path == '/api/audit':
                raw = uploaded(data, 'record')
                name = data.get('filename', '')
                if not isinstance(name, str):
                    raise ValueError('Некорректное имя файла')
                folder = self.server.runs / uuid.uuid4().hex
                folder.mkdir(mode=0o700)
                path = folder / 'original.ecg301'
                path.write_bytes(raw)
                from deepecg_prepare import audit_record
                report = audit_record(path)
                report['source_filename'] = Path(name).name[:200]
                report['original_preserved'] = True
                (folder / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
                return self.answer(200, report)
            if self.path == '/api/run':
                return self.answer(202, self.server.start_job(data))
            if self.path == '/api/store/patient':
                return self.answer(200, self.server.store.save_patient(data))
            if self.path == '/api/store/record':
                return self.answer(200, self.server.store.save_record(data))
            if self.path == '/api/store/delete':
                return self.answer(200, self.server.store.delete(data.get('kind'), data.get('id')))
            return self.answer(404, {'error': 'Не найдено'})
        except BlockingIOError as exc:
            self.answer(409, {'error': str(exc)})
        except ImportError:
            self.answer(400, {'error': 'Эта функция требует полной установки CardioAI с Python и моделями (см. README)'})
        except (ValueError, TypeError, KeyError, UnicodeError, OSError) as exc:
            self.answer(400, {'error': str(exc)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--open', action='store_true')
    parser.add_argument('--legacy', action='store_true', help='open the old model page instead of the patient app')
    args = parser.parse_args()
    try:
        server = LocalServer(args.port)
    except OSError as exc:
        if args.open:
            url = f'http://127.0.0.1:{args.port}/'
            try:
                with urllib.request.urlopen(url + 'api/status', timeout=2) as response:
                    status = strict_json(response.read())
                if status.get('app') == 'ECG301-DeepECG-local':
                    webbrowser.open(url if args.legacy else url + 'app/')
                    return
            except (OSError, ValueError):
                pass
        raise SystemExit(f'Не удалось открыть локальную программу: {exc}')
    url = f'http://127.0.0.1:{server.server_address[1]}/'
    print('ECG301 / DeepECG: ' + url, flush=True)
    if args.open:
        webbrowser.open(url if args.legacy else url + 'app/')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
