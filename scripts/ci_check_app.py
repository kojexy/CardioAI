#!/usr/bin/env python3
"""Check a built CardioAI program the way a user would (used by GitHub Actions).

Starts the program without a window, opens the app page, checks storage, and with
--install presses "Install neural networks" and runs the self-test of every model.
Standard library only; data and models go to temporary folders.
"""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}'
        self.token = None

    def get(self, path, raw=False):
        with urllib.request.urlopen(self.base + path, timeout=30) as response:
            body = response.read()
        return body.decode('utf-8') if raw else json.loads(body)

    def post(self, path, value):
        request = urllib.request.Request(self.base + path, data=json.dumps(value).encode(), method='POST', headers={
            'Content-Type': 'application/json', 'X-ECG-Token': self.token, 'Origin': self.base})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())


def wait(check, seconds, label):
    end = time.time() + seconds
    while time.time() < end:
        result = check()
        if result:
            return result
        time.sleep(5)
    raise SystemExit(f'Timeout: {label}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('program', help='CardioAI executable (inside the .app on macOS)')
    parser.add_argument('--install', action='store_true', help='install the neural networks and run all self-tests')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')  # Windows consoles default to cp1252; messages are Russian

    temp = Path(tempfile.mkdtemp(prefix='cardioai-ci-'))
    port = free_port()
    env = dict(os.environ, CARDIOAI_DATA=str(temp / 'data'), CARDIOAI_PORT=str(port))
    if args.install:
        env['CARDIOAI_WORK'] = str(temp / 'work')  # otherwise the program chooses it, as for a user
    log = (temp / 'program.log').open('w')
    program = subprocess.Popen([args.program, '--headless'], env=env, stdout=log, stderr=subprocess.STDOUT)
    client = Client(port)
    try:
        def started():
            if program.poll() is not None:
                raise SystemExit('Program exited:\n' + (temp / 'program.log').read_text())
            try:
                return client.get('/api/status')
            except OSError:
                return None
        status = wait(started, 120, 'program start')
        print('status:', json.dumps(status, ensure_ascii=False))

        page = client.get('/app/', raw=True)
        client.token = re.search(r'name="cardioai-token" content="([0-9a-f]{64})"', page).group(1)
        for asset in ('js/main.js', 'js/compare.js', 'data/labels-ru.json', 'css/app.css'):
            client.get('/app/' + asset, raw=True)

        patient = client.post('/api/store/patient', {'id': os.urandom(16).hex(), 'surname': 'Тест', 'name': 'CI'})
        if not any(p['id'] == patient['id'] for p in client.get('/api/store/patients')):
            raise SystemExit('Patient was not stored')
        print('app page and storage: ok')

        # The model page has Russian text: on Windows this broke without UTF-8 mode.
        if 'DeepECG' not in client.get('/', raw=True):
            raise SystemExit('Model page is wrong')
        exchange = client.post('/api/exchange', {'enabled': True, 'folder': str(temp / 'exchange')})
        if not (exchange['running'] and (temp / 'exchange' / 'Входящие').is_dir()):
            raise SystemExit('Exchange folder did not start: ' + json.dumps(exchange, ensure_ascii=False))
        client.post('/api/exchange', {'enabled': False, 'folder': str(temp / 'exchange')})
        print('model page and exchange folder: ok')

        setup = client.get('/api/setup')
        print('setup:', json.dumps(setup, ensure_ascii=False))
        if not args.install:
            work = Path(setup['work_dir'])
            if sys.platform == 'win32' and 'Roaming' in work.parts:
                raise SystemExit('Models folder must not be in the roaming profile: ' + str(work))
            return
        client.post('/api/setup/start', {'confirm': True})
        last = ['']

        def installed():
            state = client.get('/api/setup')
            if state['message'] != last[0]:
                last[0] = state['message']
                print(f"[{state.get('step')}] {state['progress']:.0%} {state['message']}", flush=True)
            if state.get('error'):
                log_file = temp / 'work/setup.log'
                tail = log_file.read_text(errors='replace')[-6000:] if log_file.is_file() else ''
                raise SystemExit('Install failed: ' + state['error'] + '\n' + tail)
            return state if state.get('finished') else None
        wait(installed, 90 * 60, 'neural network install')

        models = client.get('/api/status')['models']
        print('models:', models)
        if not all(models.values()):
            raise SystemExit('Not all models are ready after install')
        for model in models:
            job = client.post('/api/run', {'model': model, 'mode': 'self_test'})

            def done():
                state = client.get('/api/jobs/' + job['id'])
                return state if state['state'] != 'running' else None
            result = wait(done, 15 * 60, model + ' self-test')
            if result['state'] != 'complete':
                raise SystemExit(f"{model} failed: {result.get('error')}\n" + client.get(f"/api/jobs/{job['id']}/log", raw=True)[-4000:])
            print(f"{model}: {len(result['report']['scores'])} scores")
        print('neural networks: ok')
    finally:
        program.terminate()
        try:
            program.wait(timeout=20)
        except subprocess.TimeoutExpired:
            program.kill()
        log.close()


if __name__ == '__main__':
    main()
