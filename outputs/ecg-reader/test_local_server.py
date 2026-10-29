import base64
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from deepecg_local_server import LocalServer, check_provenance, main


class LocalServerTest(unittest.TestCase):
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

    def request(self, path, data=None, headers=None, raw=None):
        request_headers = {'Content-Type': 'application/json', 'Origin': self.base,
                           'X-ECG-Token': self.server.token}
        request_headers.update(headers or {})
        body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        req = urllib.request.Request(self.base + path, data=body, headers=request_headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_01_host_origin_token_and_invalid_body(self):
        self.assertEqual(self.request('/api/status', headers={'Host': 'malicious.invalid'})[0], 403)
        self.assertEqual(self.request('/api/run', {}, {'Origin': 'https://malicious.invalid'})[0], 403)
        self.assertEqual(self.request('/api/run', {}, {'X-ECG-Token': 'invalid'})[0], 403)
        self.assertEqual(self.request('/api/run', {}, {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/run', raw=b'{broken')[0], 400)
        self.assertEqual(self.request('/api/run', raw=b'{"mode":NaN}')[0], 400)
        self.assertEqual(self.request('/api/run', {'mode':'self_test','model':'unknown'})[0], 400)
        self.assertEqual(self.request('/api/jobs/../../etc/passwd')[0], 404)
        with self.assertRaises(OSError):
            LocalServer(self.server.server_address[1], Path(self.temp.name))
        self.assertEqual(self.request('/verification/photo-check.md')[0],200)

    @unittest.skipUnless(Path(__file__).with_name('202610231707340025').is_file(), 'Private ECG fixture is not distributed')
    def test_02_original_stays_blocked_and_is_preserved(self):
        original = Path(__file__).with_name('202610231707340025').read_bytes()
        status, body = self.request('/api/audit', dict(filename='../../original',
                                    record=base64.b64encode(original).decode()))
        self.assertEqual(status, 200)
        report = json.loads(body)
        self.assertFalse(report['ready_for_deepecg'])
        self.assertEqual(report['source_filename'], 'original')
        saved = list(Path(self.temp.name).glob('*/original.ecg301'))
        self.assertTrue(any(p.read_bytes() == original for p in saved))
        status, body = self.request('/api/audit', dict(record=base64.b64encode(original[:-1]).decode()))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['status'], 'UNSUPPORTED_LAYOUT')

    def test_03_prepared_metadata_and_invalid_arrays(self):
        import numpy as np
        import hashlib
        raw = b'not an array'
        with self.assertRaises(ValueError):
            check_provenance({}, raw)
        x = np.ones((2500,12),dtype=np.float32)
        buffer = io.BytesIO(); np.save(buffer,x); raw = buffer.getvalue()
        meta = dict(signal_sha256=hashlib.sha256(raw).hexdigest(),
                    lead_order=['I','II','III','aVR','aVL','aVF','V1','V2','V3','V4','V5','V6'],
                    output_shape=[2500,12],output_rate_hz=250,output_units='mV',
                    conversion=dict(timing_verified=True,calibration_verified=True,simultaneous_verified=True),
                    verification_evidence='Synthetic test fixture')
        payload = dict(model='wcr',mode='prepared',signal=base64.b64encode(raw).decode(),
                       provenance=base64.b64encode(json.dumps(meta).encode()).decode())
        status, body = self.request('/api/run', payload)
        self.assertEqual(status,400)
        self.assertIn('без сигнала',json.loads(body)['error'])
        meta['conversion']['calibration_verified']=False
        payload['provenance']=base64.b64encode(json.dumps(meta).encode()).decode()
        self.assertEqual(self.request('/api/run',payload)[0],400)

    def test_04_real_wcr_job_and_download(self):
        status, body = self.request('/api/run',dict(model='wcr',mode='self_test'))
        self.assertEqual(status,202)
        job = json.loads(body); self.assertTrue(job['synthetic'])
        self.assertEqual(self.request('/api/run',dict(model='wcr',mode='self_test'))[0],409)
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            status, body=self.request('/api/jobs/'+job['id'])
            state=json.loads(body)
            if state['state']!='running':break
            time.sleep(.2)
        self.assertEqual(state['state'],'complete',state)
        self.assertEqual(len(state['report']['scores']),77)
        self.assertTrue(state['report']['synthetic_test'])
        status, body=self.request('/api/jobs/'+job['id']+'/report')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['model'],'heartwise/WCR_77_Classes')
        self.assertEqual(self.request('/api/jobs/'+job['id']+'/log')[0],200)
        self.assertEqual(self.request('/api/jobs/not-a-job')[0],404)

    def test_05_history_recovery_and_launcher_reuse(self):
        status, body=self.request('/api/history')
        self.assertEqual(status,200)
        self.assertTrue(any(job['state']=='complete' and job['synthetic'] for job in json.loads(body)))
        restored=LocalServer(0,Path(self.temp.name))
        try:
            self.assertTrue(any(job['state']=='complete' and len(job['report']['scores'])==77 for job in restored.jobs.values()))
        finally:
            restored.server_close()
        with patch('sys.argv',['server','--port',str(self.server.server_address[1]),'--open']), patch('webbrowser.open') as opened:
            main()
            opened.assert_called_once_with(self.base+'/')


class LifecycleTest(unittest.TestCase):
    def test_closing_server_stops_its_child_process(self):
        with tempfile.TemporaryDirectory() as folder:
            server=LocalServer(0,Path(folder))
            child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True)
            server.children.add(child)
            try:
                server.server_close()
                self.assertNotEqual(child.wait(timeout=5),0)
            finally:
                if child.poll() is None:
                    child.kill();child.wait()


if __name__=='__main__':
    unittest.main()
