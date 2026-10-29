#!/usr/bin/env python3
"""One-click install of the neural-network part for the desktop program.

Steps: standalone Python 3.12 → pinned packages (PyTorch etc.) → upstream sources and
SHA256-verified weights (scripts/setup_models.py) → quick self-test. Standard library only,
so it also runs inside the packaged program. Everything goes into the work folder
(CARDIOAI_WORK); nothing is sent anywhere, only downloaded from pinned official sources.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

APP = (Path(sys._MEIPASS) / 'outputs/ecg-reader' if getattr(sys, 'frozen', False)
       else Path(__file__).resolve().parent)
RESOURCES = APP.parents[1]  # repo root, or the bundle root of the packaged program
PYTHON_RELEASES = 'https://github.com/astral-sh/python-build-standalone/releases/download/'
SF_DATALESS = 0x40000000  # macOS: file content is only in iCloud


def work_dir():
    return Path(os.environ.get('CARDIOAI_WORK') or RESOURCES / 'work')


def platform_key():
    machine = platform.machine().lower()
    if sys.platform == 'darwin' and machine == 'arm64':
        return 'darwin-arm64'
    if sys.platform == 'win32' and machine in ('amd64', 'x86_64'):
        return 'win32-amd64'
    if sys.platform.startswith('linux') and machine in ('x86_64', 'amd64'):
        return 'linux-x86_64'
    return None


def runtime_python(work=None):
    root = (work or work_dir()) / 'runtime/python'
    for candidate in (root / 'bin/python3', root / 'python.exe'):
        if candidate.is_file():
            return candidate
    return None


def packages_ready(work=None):
    """True when the program's Python has the packages of the current requirements.txt."""
    try:
        marker = (work or work_dir()) / 'runtime/packages.json'
        return json.loads(marker.read_text(encoding='utf-8')).get('requirements_sha256') == requirements_digest()
    except (OSError, ValueError):
        return False


def clean_env(**extra):
    """Environment for the program's own Python: no user packages or pip settings from this computer."""
    env = {k: v for k, v in os.environ.items()
           if k not in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'VIRTUAL_ENV') and not k.startswith('PIP_')}
    env.update(PYTHONNOUSERSITE='1', PIP_CONFIG_FILE=os.devnull, PIP_DISABLE_PIP_VERSION_CHECK='1',
               PYTHONDONTWRITEBYTECODE='1', PYTHONUTF8='1', CARDIOAI_WORK=str(work_dir()), **extra)
    return env


def requirements_digest():
    return hashlib.sha256((RESOURCES / 'requirements.txt').read_bytes()).hexdigest()


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def offloaded_files(folder):
    """Files whose content macOS keeps only in iCloud ("dataless"); reading them can hang."""
    if sys.platform != 'darwin' or not folder.is_dir():
        return []
    # Weight files and their manifests are enough to tell (a full scan of the runtime is slow).
    found = []
    for sub in ('deepecg-weights', 'ecgfounder-weights'):
        for path in (folder / sub).glob('*') if (folder / sub).is_dir() else []:
            try:
                if path.is_file() and os.lstat(path).st_flags & SF_DATALESS:
                    found.append(path)
            except OSError:
                continue
    return found


# Weight files of each network; same as MODEL_WEIGHTS in scripts/setup_models.py.
MODEL_WEIGHTS = {'efficientnet': ['efficientnet_deepecg_unscaled.pt'],
                 'wcr': ['base_ssl.pt', 'wcr_77_classes.pt'],
                 'ecgfounder': ['12_lead_ECGFounder.pth']}


def check_models(models):
    """The networks to install: a non-empty subset of MODEL_WEIGHTS (None = all)."""
    if models is None:
        return list(MODEL_WEIGHTS)
    if not isinstance(models, list) or not models or not set(models) <= set(MODEL_WEIGHTS):
        raise ValueError('Выберите хотя бы одну нейросеть из списка')
    return [m for m in MODEL_WEIGHTS if m in models]


def weight_files(models=None):
    wanted = {name for model in check_models(models) for name in MODEL_WEIGHTS[model]}
    out = []
    for meta_path in sorted((RESOURCES / 'model-assets').glob('*.pt*.json')):
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
        name = meta.get('file', meta.get('filename'))
        if name not in wanted:
            continue
        folder = 'ecgfounder-weights' if name.endswith('.pth') else 'deepecg-weights'
        out.append((name, folder, int(meta.get('size_bytes', meta.get('size')))))
    return out


class ModelSetup:
    """Runs the install in a background thread and reports progress."""

    def __init__(self):
        self.lock = threading.Lock()
        self.thread = None
        self.process = None
        self.cancelled = threading.Event()
        self.selected = list(MODEL_WEIGHTS)
        self.state = dict(running=False, step=None, message='', progress=0.0, error=None, finished=False)

    # ----- status
    def status(self, models=None):
        work = work_dir()
        py = runtime_python(work)
        packages = packages_ready(work)
        warnings = []
        if offloaded_files(work):
            warnings.append('Часть файлов моделей хранится только в iCloud. Перенесите папку моделей из «Документов» или «Рабочего стола» — иначе расчёт может зависнуть.')
        try:
            free_gb = shutil.disk_usage(work if work.exists() else work.parent).free / 1e9
        except OSError:
            free_gb = None
        with self.lock:
            state = dict(self.state)
        return dict(state, platform=platform_key(), work_dir=str(work), free_gb=round(free_gb, 1) if free_gb else None,
                    runtime=bool(py), packages=packages, models=models or {}, warnings=warnings,
                    need_gb=round(self.need_gb(work), 1), base_gb=round(self.need_gb(work, []), 1),
                    model_gb={m: round(self.missing_gb(work, [m]), 2) for m in MODEL_WEIGHTS},
                    supported=platform_key() is not None)

    def _set(self, **kw):
        with self.lock:
            self.state.update(kw)

    # ----- run
    def start(self, models=None):
        models = check_models(models)
        with self.lock:
            if self.state['running']:
                raise BlockingIOError('Установка уже идёт')
            if platform_key() is None:
                raise ValueError('Для этого компьютера нет готовой сборки нейросетей (поддерживаются Windows x64, Mac на Apple Silicon, Linux x64)')
            self.state = dict(running=True, step='check', message='Проверка места на диске…', progress=0.0, error=None, finished=False)
            self.cancelled.clear()
            self.selected = models
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        """Cancel the install: stops the running download or pip (the next start continues from here)."""
        self.cancelled.set()
        process = self.process
        if process and process.poll() is None:
            try:
                if hasattr(os, 'killpg'):
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
            except OSError:
                pass

    def _check_cancel(self):
        if self.cancelled.is_set():
            raise RuntimeError('Установка отменена. Нажмите кнопку ещё раз, чтобы продолжить.')

    @staticmethod
    def missing_gb(work, models=None):
        """Size of the weights of these networks that are not downloaded yet."""
        return sum(size for name, folder, size in weight_files(models)
                   if not ((work / folder / name).is_file() and (work / folder / name).stat().st_size == size)) / 1e9

    def need_gb(self, work, models=None):
        """Free space still needed: Python + packages if missing (about 1.3 GB installed, plus downloads),
        plus weights not yet downloaded. models=[] gives only the Python part."""
        need = 0.0 if runtime_python(work) and packages_ready(work) else 2.0
        if models != []:
            need += self.missing_gb(work, models)
        return need + 0.5 if need else 0.0

    def _run(self):
        work = work_dir()
        try:
            work.mkdir(parents=True, exist_ok=True)
            if offloaded_files(work):
                raise RuntimeError('Папка моделей находится в iCloud и часть файлов выгружена. Выберите папку вне iCloud.')
            free, need = shutil.disk_usage(work).free / 1e9, self.need_gb(work, self.selected)
            if free < need:
                raise RuntimeError(f'Недостаточно места: свободно {free:.1f} ГБ, нужно около {need:.1f} ГБ')
            log = (work / 'setup.log').open('a', encoding='utf-8')
            log.write(f'\n=== setup {time.strftime("%Y-%m-%d %H:%M:%S")} {platform_key()} ===\n')
            try:
                self._runtime(work, log)
                self._packages(work, log)
                self._models(work, log)
                self._self_test(work, log)
            finally:
                log.close()
            self._set(running=False, finished=True, step='done', progress=1.0,
                      message='Нейросети установлены. Пробный расчёт на искусственном сигнале прошёл.')
        except Exception as exc:  # reported to the user; details are in setup.log
            self._set(running=False, error=str(exc), message='Установка остановлена.')

    def _download(self, url, target, size, expected, label):
        if target.is_file() and target.stat().st_size == size and sha256(target) == expected:
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + '.part')
        with urllib.request.urlopen(url, timeout=120) as response, part.open('wb') as out:
            done = 0
            while chunk := response.read(1024 * 1024):
                self._check_cancel()
                out.write(chunk)
                done += len(chunk)
                self._set(message=f'{label}: {done / 1e6:.0f} из {size / 1e6:.0f} МБ', progress=min(done / size, 1.0))
        if part.stat().st_size != size or sha256(part) != expected:
            part.unlink()
            raise RuntimeError('Загруженный файл повреждён (контрольная сумма не совпала): ' + target.name)
        part.replace(target)

    def _runtime(self, work, log):
        if runtime_python(work):
            return
        pins = json.loads((RESOURCES / 'model-assets/runtime.json').read_text(encoding='utf-8'))
        build = pins['builds'][platform_key()]
        self._set(step='runtime', message='Загрузка Python…', progress=0.0)
        archive = work / 'downloads' / build['file']
        url = PYTHON_RELEASES + pins['release'] + '/' + build['file'].replace('+', '%2B')
        self._download(url, archive, build['size'], build['sha256'], 'Python')
        staging = work / 'runtime.tmp'
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        with tarfile.open(archive) as tar:
            if any(Path(m.name).parts[:1] != ('python',) for m in tar.getmembers()):
                raise RuntimeError('Неожиданное содержимое архива Python')
            # The 'data' filter rejects absolute paths and links that leave the folder.
            tar.extractall(staging, filter='data')
        target = work / 'runtime'
        shutil.rmtree(target, ignore_errors=True)
        staging.replace(target)
        py = runtime_python(work)
        if not py:
            raise RuntimeError('Python не найден после распаковки')
        subprocess.run([str(py), '-c', 'import ssl, sqlite3'], check=True, stdout=log, stderr=subprocess.STDOUT)
        log.write('runtime ok: ' + str(py) + '\n')

    def _command(self, args, log, label, progress=None):
        self._check_cancel()
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=clean_env(), text=True,
                                   encoding='utf-8', errors='replace', cwd=str(work_dir()),
                                   start_new_session=hasattr(os, 'killpg'))
        self.process = process
        done = threading.Event()

        def tick():  # downloads print one line per file, so refresh the bar from the file sizes
            while not done.wait(1.5):
                self._set(progress=progress())
        if progress:
            threading.Thread(target=tick, daemon=True).start()
        try:
            for line in process.stdout:
                log.write(line)
                log.flush()
                text = line.strip()
                if text:
                    self._set(message=f'{label}: {text[:140]}')
            code = process.wait()
        finally:
            done.set()
            self.process = None
        self._check_cancel()
        if code:
            raise RuntimeError(f'{label}: ошибка (код {code}). Подробности — в файле setup.log')

    def _packages(self, work, log):
        marker = work / 'runtime/packages.json'
        try:
            if json.loads(marker.read_text(encoding='utf-8')).get('requirements_sha256') == requirements_digest():
                return
        except (OSError, ValueError):
            pass
        self._set(step='packages', message='Установка PyTorch и библиотек (около 1 ГБ, 5–30 минут)…', progress=0.0)
        args = [str(runtime_python(work)), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
                '--no-cache-dir', '--prefer-binary', '-r', str(RESOURCES / 'requirements.txt')]
        self._command(args, log, 'Библиотеки')
        marker.write_text(json.dumps({'requirements_sha256': requirements_digest(), 'installed_at': time.time()}))

    def _models(self, work, log):
        files = weight_files(self.selected)
        total = sum(size for _, _, size in files)
        size = f'{total / 1e9:.1f}'.replace('.', ',')
        self._set(step='models', message=f'Загрузка исходников и весов моделей (около {size} ГБ)…', progress=0.0)

        def progress():
            done = 0
            for name, folder, size in files:
                path = work / folder / name
                part = path.with_name(name + '.part')
                done += path.stat().st_size if path.is_file() else (part.stat().st_size if part.is_file() else 0)
            return min(done / total, 1.0)
        self._command([str(runtime_python(work)), str(RESOURCES / 'scripts/setup_models.py'),
                       '--models', ','.join(self.selected)], log, 'Модели', progress)

    def _self_test(self, work, log):
        py = str(runtime_python(work))
        tests = [('efficientnet', 'DeepECG SL', [py, str(APP / 'deepecg_run_local.py'), '--model', 'efficientnet'], 77),
                 ('wcr', 'DeepECG SSL', [py, str(APP / 'deepecg_run_local.py'), '--model', 'wcr'], 77),
                 ('ecgfounder', 'ECGFounder', [py, str(APP / 'ecgfounder_run_local.py')], 150)]
        tests = [t for t in tests if t[0] in self.selected]
        for i, (key, name, command, expected) in enumerate(tests):
            self._set(step='test', message=f'Пробный расчёт {name} на искусственном сигнале…', progress=i / len(tests))
            report = work / 'selftest' / f'{key}.json'
            report.parent.mkdir(exist_ok=True)
            report.unlink(missing_ok=True)
            self._command(command + ['--smoke-test', '--report', str(report)], log, 'Проверка ' + name)
            result = json.loads(report.read_text(encoding='utf-8'))
            if len(result.get('scores', {})) != expected:
                raise RuntimeError(f'Пробный расчёт {name} вернул неожиданный результат')
