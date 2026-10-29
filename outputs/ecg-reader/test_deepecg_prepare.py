import ast
import json
import logging
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np
from deepecg_prepare import LEADS, prepare, audit_record


class PreparationTest(unittest.TestCase):
    def setUp(self):
        t = np.arange(2000) / 200
        self.counts = 2048 + 100*np.sin(2*np.pi*7*t[:, None] + np.arange(12)[None, :]/10)
        self.meta = dict(lead_order=LEADS, sampling_rate_hz=200,
                         microvolts_per_count=1.16, zero_counts=2048,
                         timing_verified=True, calibration_verified=True,
                         simultaneous_verified=True,
                         verification_evidence='Synthetic fixture; not a patient calibration')

    def test_time_and_scale(self):
        y, report = prepare(self.counts, self.meta)
        self.assertEqual(y.shape, (2500, 12))
        self.assertEqual(y.dtype, np.float32)
        t = np.arange(2500)/250
        expected = .116*np.sin(2*np.pi*7*t[:, None]+np.arange(12)[None, :]/10)
        self.assertLess(np.max(np.abs(y[50:-50]-expected[50:-50])), .001)
        self.assertFalse(report['model_run'])

    def test_reject_short_unverified_bad_order_flat_and_nan(self):
        cases = [(self.counts[:600], self.meta),
                 (self.counts, dict(self.meta, calibration_verified=False)),
                 (self.counts, dict(self.meta, simultaneous_verified=False)),
                 (self.counts, dict(self.meta, lead_order=LEADS[::-1])),
                 (np.zeros((2000,12)), self.meta),
                 (self.counts*np.nan, self.meta)]
        for counts, meta in cases:
            with self.subTest(meta=meta), self.assertRaises(ValueError):
                prepare(counts, meta)

    @unittest.skipUnless(Path(__file__).with_name('202610231707340025').is_file(), 'Private ECG fixture is not distributed')
    def test_original_not_ready(self):
        r = audit_record(Path(__file__).with_name('202610231707340025'))
        self.assertFalse(r['ready_for_deepecg'])
        self.assertEqual(r['samples_per_lead'], 600)

    def test_official_validator(self):
        source = Path(__file__).resolve().parents[2]/'work/DeepECG_Docker/utils/files_handler.py'
        tree = ast.parse(source.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'NPYProcessor')
        cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in ('__init__','process_single_file')]
        namespace = dict(np=np, os=os, logger=logging.getLogger(__name__))
        exec(compile(ast.Module(body=[cls], type_ignores=[]), str(source), 'exec'), namespace)
        validator = namespace['NPYProcessor']()
        y, _ = prepare(self.counts, self.meta)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'synthetic.npy'
            np.save(path, y)
            self.assertEqual(validator.process_single_file(str(path))[0][1], 'Success')
            np.save(path, y[:750])
            self.assertEqual(validator.process_single_file(str(path))[0][1], 'Failed')


if __name__ == '__main__':
    unittest.main()
