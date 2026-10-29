import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from deepecg_local_server import LocalServer

PID = 'a' * 32
RID = 'b' * 32


class PatientStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = LocalServer(0, Path(cls.temp.name))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def call(self, path, data=None, token=True):
        headers = {'Content-Type': 'application/json', 'Origin': self.base}
        if token:
            headers['X-ECG-Token'] = self.server.token
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(self.base + path, data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_01_app_is_served_with_token(self):
        status, body = self.call('/app/')
        self.assertEqual(status, 200)
        self.assertIn(self.server.token.encode(), body)
        self.assertEqual(self.call('/app/js/compare.js')[0], 200)
        self.assertEqual(self.call('/app/../deepecg_local_server.py')[0], 404)
        self.assertEqual(self.call('/app/%2e%2e/README.md')[0], 404)
        status, body = self.call('/api/status')
        self.assertTrue(json.loads(body)['storage'])

    def test_02_patient_and_record_round_trip(self):
        self.assertEqual(self.call('/api/store/patient', {'id': PID, 'surname': 'Тест'}, token=False)[0], 403)
        self.assertEqual(self.call('/api/store/patient', {'id': '../x', 'surname': 'Тест'})[0], 400)
        self.assertEqual(self.call('/api/store/patient', {'id': PID, 'surname': ' '})[0], 400)
        self.assertEqual(self.call('/api/store/patient', {'id': PID, 'surname': 'Тестов', 'name': 'Иван'})[0], 200)
        record = {'id': RID, 'patientId': PID, 'recordedAt': '2026-10-23T17:07:34', 'measurements': {'QTc_ms': 401}}
        self.assertEqual(self.call('/api/store/record', dict(record, patientId='c' * 32))[0], 400)
        self.assertEqual(self.call('/api/store/record', record)[0], 200)
        patients = json.loads(self.call('/api/store/patients')[1])
        self.assertEqual([p['surname'] for p in patients], ['Тестов'])
        records = json.loads(self.call(f'/api/store/patients/{PID}/records')[1])
        self.assertEqual(records[0]['measurements']['QTc_ms'], 401)
        self.assertEqual(self.call('/api/store/delete', {'kind': 'patient', 'id': PID})[0], 200)
        self.assertEqual(json.loads(self.call(f'/api/store/patients/{PID}/records')[1]), [])
        self.assertEqual(json.loads(self.call('/api/store/patients')[1]), [])


if __name__ == '__main__':
    unittest.main()
