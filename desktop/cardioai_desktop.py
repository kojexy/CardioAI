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


def find_models_home(data):
    """Folder of a full CardioAI checkout with installed models, if any."""
    settings = data / 'settings.json'
    candidates = []
    if os.environ.get('CARDIOAI_HOME'):
        candidates.append(Path(os.environ['CARDIOAI_HOME']))
    try:
        configured = json.loads(settings.read_text(encoding='utf-8')).get('cardioai_home')
        if configured:
            candidates.append(Path(configured))
    except (OSError, ValueError, AttributeError):
        pass
    if not getattr(sys, 'frozen', False):
        candidates.append(Path(__file__).resolve().parents[1])
    candidates += [Path.home() / 'CardioAI', Path.home() / 'Projects/CardioAI']
    for home in candidates:
        if (home / 'outputs/ecg-reader/deepecg_run_local.py').is_file() and (home / 'work').is_dir():
            return home
    return None


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
    home = find_models_home(data)
    if home:
        os.environ['CARDIOAI_HOME'] = str(home)
    from deepecg_local_server import LocalServer
    server = LocalServer(0)
    url = f'http://127.0.0.1:{server.server_address[1]}/app/'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
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
