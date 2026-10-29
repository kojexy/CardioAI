import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.request

import numpy as np

from ecgfounder_run_local import normalize, prepare_standard, infer
from deepecg_local_server import LocalServer


class FounderTests(unittest.TestCase):
    def fixture(self):
        t = np.arange(2500) / 250
        return np.sin(2*np.pi*7*t[:,None]+np.arange(12)[None,:]/10).astype(np.float32)

    def test_resampling_preserves_time_and_frequency(self):
        x = self.fixture()
        y = prepare_standard(x)
        self.assertEqual(y.shape, (5000,12))
        self.assertAlmostEqual(np.mean(y), 0, places=6)
        self.assertAlmostEqual(np.std(y), 1, places=6)
        f = np.fft.rfftfreq(len(y), 1/500)
        peak = f[np.argmax(abs(np.fft.rfft(y[:,0])))]
        self.assertAlmostEqual(peak, 7, places=6)
        # Global normalization must preserve relative channel amplitudes.
        x[:,0] *= 2
        y = normalize(x)
        self.assertAlmostEqual(np.std(y[:,0])/np.std(y[:,1]), 2, places=5)

    def test_short_invalid_flat_and_nonfinite_are_rejected(self):
        x = self.fixture()
        for invalid in [x[:750], x.T, x.astype(complex), np.ones_like(x),
                        np.where(np.arange(2500)[:,None] == 12, np.nan, x)]:
            with self.subTest(shape=invalid.shape), self.assertRaises(ValueError):
                prepare_standard(invalid)

    def test_real_cpu_and_repeatability(self):
        first = infer(self.fixture())
        second = infer(self.fixture())
        self.assertEqual(len(first['scores']), 150)
        self.assertEqual(first['scores'], second['scores'])
        self.assertFalse(first['diagnosis_assigned'])
        self.assertEqual(first['model_input_shape'], [1,12,5000])
        self.assertEqual(first['weights']['sha256'],
                         'ee199f3781f4ae1f732973267f003da0a759ea12bddb0dd28a77faa60aca7997')

    def test_http_runs_founder_and_persists_result(self):
        with tempfile.TemporaryDirectory() as folder:
            server = LocalServer(0, Path(folder))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_address[1])
            try:
                req = urllib.request.Request(base+'/api/run',
                    data=json.dumps(dict(model='ecgfounder',mode='self_test')).encode(),
                    headers={'Content-Type':'application/json','Origin':base,'X-ECG-Token':server.token})
                with urllib.request.urlopen(req, timeout=20) as response:
                    self.assertEqual(response.status,202)
                    job = json.load(response)
                deadline = time.monotonic()+90
                while time.monotonic()<deadline:
                    with urllib.request.urlopen(base+'/api/jobs/'+job['id'], timeout=10) as response:
                        current = json.load(response)
                    if current['state']!='running':
                        break
                    time.sleep(.2)
                self.assertEqual(current['state'],'complete',current)
                self.assertTrue(current['synthetic'])
                self.assertTrue(current['report']['synthetic_test'])
                self.assertEqual(len(current['report']['scores']),150)
                self.assertTrue((Path(folder)/job['id']/'result.json').is_file())
                with urllib.request.urlopen(base+'/api/jobs/'+job['id']+'/report') as response:
                    self.assertEqual(json.load(response)['model'],'PKUDigitalHealth/ECGFounder')
            finally:
                server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
