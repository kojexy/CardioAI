import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import folder_worker
from folder_worker import DONE, FAILED, INBOX, RESULTS, FolderWorker, record_from_ecg301
from patient_store import PatientStore
from deepecg_local_server import LocalServer

ROOT = Path(__file__).resolve().parents[2]
# Synthetic ECG301 built by the JavaScript test fixture, with irregular RR and a negative axis;
# prints what the app itself stores for it. Not a patient record.
NODE = """
import { writeFileSync } from 'node:fs';
import { syntheticECG301 } from './tests/js/fixtures.mjs';
import { parseECG301 } from './app/js/ecg301.js';
import { deriveMeasurements } from './app/js/measure.js';
const buf = syntheticECG301({ id: '20261023170734', axes: [-30, 120, 200], sv1: -1.234567, rv5: 2.0456 });
const view = new DataView(buf);
[812, 790, 845, 801, 1210, 640, 799, 833, 780, 905, 760].forEach((v, i) => view.setUint16(24089 + 2 * i, v, true));
writeFileSync(process.argv[1], new Uint8Array(buf));
const p = parseECG301(buf);
console.log(JSON.stringify({ recordedAt: p.recordedAt, deviceRecordId: p.recordId, device: p.device,
  measurements: deriveMeasurements(p.device), leads: p.blocks.B, checks: p.checks }));
"""


def synthetic(path):
    out = subprocess.run(['node', '--input-type=module', '-e', NODE, str(path)], cwd=ROOT, check=True,
                         capture_output=True, text=True).stdout
    return json.loads(out)


@unittest.skipUnless(shutil.which('node'), 'node is needed to build the synthetic file')
class FolderWorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.ecg = self.dir / '20261023170734'
        self.js = synthetic(self.ecg)

    def tearDown(self):
        self.temp.cleanup()

    def test_record_matches_the_app(self):
        record = record_from_ecg301(self.ecg.read_bytes(), self.ecg.name)
        for key in ('recordedAt', 'deviceRecordId', 'device', 'measurements'):
            self.assertEqual(record[key], self.js[key], key)
        self.assertEqual(record['signal']['leads'], self.js['leads'])
        for block in ('A', 'B'):
            self.assertAlmostEqual(record['checks']['limbIdentity'][block], self.js['checks']['limbIdentity'][block], places=9)
        self.assertEqual(record['measurements']['P_axis'], -30)
        self.assertEqual(record['measurements']['T_axis'], -160)

    def drop(self, worker, relative):
        target = worker.root / INBOX / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(self.ecg, target)
        self.assertEqual(worker.scan(), 0)  # first sight: the file may still be syncing
        return worker.scan()

    def test_exchange_folder(self):
        store = PatientStore(self.dir / 'store')
        worker = FolderWorker(store, self.dir / 'exchange')
        worker.start()
        worker.stop()
        self.assertTrue((worker.root / 'Как пользоваться.txt').is_file())

        self.assertEqual(self.drop(worker, 'Иванов Иван/ecg1'), 1)
        [patient] = store.list_patients()
        self.assertEqual((patient['surname'], patient['name']), ('Иванов', 'Иван'))
        [record] = store.list_records(patient['id'])
        self.assertEqual(record['measurements'], self.js['measurements'])
        self.assertTrue((worker.root / DONE / 'Иванов Иван/ecg1').is_file())
        result = json.loads((worker.root / RESULTS / 'Иванов Иван/2026-10-23T17-07-34.json').read_text(encoding='utf-8'))
        self.assertEqual(result['format'], 'cardioai-record')
        self.assertNotIn('patientId', result['record'])
        self.assertIn('ЧСС', (worker.root / RESULTS / 'Иванов Иван/2026-10-23T17-07-34.txt').read_text(encoding='utf-8'))

        # Same file again, other spelling of the name: same patient, not added twice.
        self.drop(worker, 'иванов  иван/ecg1')
        self.assertEqual(len(store.list_patients()), 1)
        self.assertEqual(len(store.list_records(patient['id'])), 1)
        self.assertEqual(worker.status()['recent'][-1]['status'], 'duplicate')

        # Not in a patient folder, or not an ECG file: moved to errors with the reason.
        self.drop(worker, 'loose')
        (worker.root / INBOX / 'Петров Пётр').mkdir()
        (worker.root / INBOX / 'Петров Пётр/photo.jpg').write_bytes(b'not an ecg')
        worker.scan(), worker.scan()
        self.assertTrue((worker.root / FAILED / 'loose.txt').is_file())
        self.assertTrue((worker.root / FAILED / 'photo.jpg.txt').is_file())
        self.assertEqual(len(store.list_patients()), 1)
        self.assertEqual([p for p in (worker.root / INBOX).rglob('*') if p.is_file()], [])

    def test_partial_download_is_ignored(self):
        worker = FolderWorker(PatientStore(self.dir / 'store'), self.dir / 'exchange')
        worker.start()
        worker.stop()
        part = worker.root / INBOX / 'Иванов Иван/ecg.part'
        part.parent.mkdir(parents=True)
        shutil.copy(self.ecg, part)
        self.assertEqual(worker.scan() + worker.scan(), 0)


class ExchangeApiTest(unittest.TestCase):
    def test_turn_on_and_off(self):
        with tempfile.TemporaryDirectory() as temp:
            server = LocalServer(0, Path(temp))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_address[1])

            def call(data=None, token=True):
                headers = {'Content-Type': 'application/json', 'Origin': base}
                if token:
                    headers['X-ECG-Token'] = server.token
                req = urllib.request.Request(base + '/api/exchange', data=json.dumps(data).encode() if data else None, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as exc:
                    return exc.code, json.loads(exc.read())
            try:
                status, value = call()
                self.assertEqual((status, value['enabled']), (200, False))
                self.assertEqual(call({'enabled': True}, token=False)[0], 403)
                self.assertEqual(call({'enabled': True, 'folder': 'relative/path'})[0], 400)
                status, value = call({'enabled': True})
                self.assertEqual((status, value['enabled'], value['running']), (200, True, True))
                self.assertTrue((Path(value['folder']) / INBOX).is_dir())
                self.assertTrue(folder_worker.load_settings(temp)['exchange_enabled'])
                status, value = call({'enabled': False})
                self.assertEqual((status, value['enabled']), (200, False))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main(verbosity=2)
