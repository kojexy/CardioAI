#!/usr/bin/env python3
"""Choice of neural networks in the installer: sizes, validation and the --models list (no downloads)."""
import json
import os
from pathlib import Path
import tempfile
import unittest

import model_setup
from model_setup import MODEL_WEIGHTS, ModelSetup, check_models, weight_files


class ModelChoiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_same_networks_as_the_download_script(self):
        script = (model_setup.RESOURCES / 'scripts/setup_models.py').read_text(encoding='utf-8')
        for files in MODEL_WEIGHTS.values():
            for name in files:
                self.assertIn(repr(name), script)

    def test_weight_files_follow_the_choice(self):
        self.assertEqual({n for n, _, _ in weight_files()}, {n for f in MODEL_WEIGHTS.values() for n in f})
        self.assertEqual([n for n, _, _ in weight_files(['ecgfounder'])], ['12_lead_ECGFounder.pth'])
        self.assertEqual(sorted(n for n, _, _ in weight_files(['wcr'])), ['base_ssl.pt', 'wcr_77_classes.pt'])

    def test_bad_choice_is_refused(self):
        for bad in ([], ['gpt'], 'wcr', [1]):
            with self.assertRaises(ValueError):
                check_models(bad)
        self.assertEqual(check_models(['ecgfounder', 'efficientnet']), ['efficientnet', 'ecgfounder'])

    def test_space_needed_counts_only_missing_chosen_weights(self):
        setup = ModelSetup()
        small = setup.need_gb(self.work, ['efficientnet'])
        big = setup.need_gb(self.work, ['wcr'])
        self.assertGreater(big - small, 2.0)  # WCR weights are about 2.2 GB
        self.assertAlmostEqual(setup.need_gb(self.work, []), 2.5)  # Python and packages only
        # A weight already in place is not counted again.
        name, folder, size = weight_files(['efficientnet'])[0]
        (self.work / folder).mkdir(parents=True)
        with open(self.work / folder / name, 'wb') as out:
            out.truncate(size)
        self.assertEqual(setup.missing_gb(self.work, ['efficientnet']), 0)

    def test_status_reports_sizes_per_network(self):
        os.environ['CARDIOAI_WORK'] = str(self.work)
        try:
            status = ModelSetup().status()
        finally:
            del os.environ['CARDIOAI_WORK']
        self.assertEqual(set(status['model_gb']), set(MODEL_WEIGHTS))
        self.assertGreater(status['model_gb']['wcr'], status['model_gb']['ecgfounder'])
        self.assertIn('base_gb', status)


if __name__ == '__main__':
    unittest.main()
