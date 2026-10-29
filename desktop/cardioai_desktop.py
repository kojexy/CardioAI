#!/usr/bin/env python3
"""CardioAI desktop program: the local server inside its own window (Windows, macOS).

Patients, history and comparison work everywhere. Neural networks run only when a full
CardioAI install with models (work/deepecg-venv, work/*-weights) is found; see README.
"""
import json
import os
from pathlib import Path
import sys
import threading
import webbrowser

HERE = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(HERE / 'outputs/ecg-reader'))


def data_dir():
    if os.environ.get('CARDIOAI_DATA'):
        return Path(os.environ['CARDIOAI_DATA'])
    if sys.platform == 'darwin':
        base = Path.home() / 'Library/Application Support'
    elif sys.platform == 'win32':
        base = Path(os.environ.get('APPDATA', Path.home() / 'AppData/Roaming'))
    else:
        base = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    return base / 'CardioAI'


def choose_work_dir(data):
    """Folder for the neural networks (runtime, sources, weights).

    Order: CARDIOAI_WORK; "work_dir" in settings.json of the data folder; an existing
    install with weights (source checkout); otherwise <data folder>/work, where the
    "Install neural networks" button puts everything.
    """
    if os.environ.get('CARDIOAI_WORK'):
        return Path(os.environ['CARDIOAI_WORK'])
    try:
        configured = json.loads((data / 'settings.json').read_text(encoding='utf-8')).get('work_dir')
        if configured:
            return Path(configured)
    except (OSError, ValueError, AttributeError):
        pass
    candidates = [Path(__file__).resolve().parents[1] / 'work'] if not getattr(sys, 'frozen', False) else []
    candidates += [Path.home() / 'CardioAI/work', Path.home() / 'Projects/CardioAI/work']
    for work in candidates:
        if (work / 'deepecg-weights').is_dir():
            return work
    return data / 'work'


class Api:
    """Functions the page can call through window.pywebview.api."""

    def __init__(self):
        self.window = None

    def save_file(self, name, text):
        import webview
        result = self.window.create_file_dialog(webview.SAVE_DIALOG, save_filename=Path(name).name)
        if not result:
            return None
        target = Path(result if isinstance(result, str) else result[0])
        target.write_text(text, encoding='utf-8')
        return str(target)


def main():
    data = data_dir()
    data.mkdir(parents=True, exist_ok=True)
    os.environ['CARDIOAI_DATA'] = str(data)
    os.environ['CARDIOAI_WORK'] = str(choose_work_dir(data))
    if '--exchange' in sys.argv:
        # Home computer mode: process the exchange folder (see outputs/ecg-reader/folder_worker.py).
        os.environ['CARDIOAI_EXCHANGE'] = '1'
    from deepecg_local_server import LocalServer
    headless = '--headless' in sys.argv
    port = int(os.environ.get('CARDIOAI_PORT', '0'))
    server = LocalServer(port)
    url = f'http://127.0.0.1:{server.server_address[1]}/app/'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    if headless:
        # Server only (tests, or a home PC serving other devices later).
        print('CardioAI: ' + url, flush=True)
        try:
            thread.join()
        except KeyboardInterrupt:
            server.shutdown()
        return
    try:
        import webview
    except ImportError:
        # No native window toolkit: use the default browser instead.
        print('CardioAI: ' + url, flush=True)
        webbrowser.open(url)
        try:
            thread.join()
        except KeyboardInterrupt:
            pass
        return
    api = Api()
    webview.settings['ALLOW_DOWNLOADS'] = True
    api.window = webview.create_window('CardioAI', url, js_api=api, width=1240, height=880, min_size=(380, 600))
    try:
        webview.start(private_mode=False)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
