#!/usr/bin/env python3
"""Local CPU runner for DeepECG EfficientNet/WCR; no network requests."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import platform
import sys

import numpy as np
import pandas as pd
import torch

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / 'work/DeepECG_Docker'
WEIGHT_DIR = ROOT / 'work/deepecg-weights'


def verified_weight(name):
    path = WEIGHT_DIR / name
    manifest = json.loads(path.with_suffix('.pt.json').read_text())
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024*1024):
            digest.update(chunk)
    if digest.hexdigest() != manifest['sha256']:
        raise ValueError('Weight SHA256 mismatch: ' + name)
    return path, manifest


def constant(name):
    tree = ast.parse((UPSTREAM / 'utils/constants.py').read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f'Upstream constant missing: {name}')


def thresholds(architecture, labels):
    """Authors' per-label operating points (sensitivity/specificity balance) from the pinned upstream."""
    key = 'SL_sens_spec_threshold' if architecture == 'efficientnet' else 'SSL_sens_spec_threshold'
    table = json.loads((UPSTREAM / 'thresholds/77_tasks_final.json').read_text())
    out = {}
    for label in labels:
        value = table.get(label, {}).get(key)
        if isinstance(value, (int, float)) and np.isfinite(value) and 0 < value < 1:
            out[label] = float(value)
    return out


def infer(signal, architecture='efficientnet'):
    if (not isinstance(signal, np.ndarray) or signal.shape != (2500, 12)
            or signal.dtype.kind not in 'fiu' or not np.isfinite(signal).all()):
        raise ValueError('Expected finite (2500,12) array at 250 Hz in mV')
    if np.any(np.ptp(signal, axis=0) == 0):
        raise ValueError('Flat lead')
    sys.path.insert(0, str(UPSTREAM))
    from utils.ecg_signal_processor import ECGSignalProcessor
    processor = ECGSignalProcessor(fs=250)
    frame = pd.DataFrame({'ecg_path': ['local.npy'], 'ecg_signal': [signal.copy()]})
    frame = processor.scale_ecg_signals(frame, power_ratio=constant('PTBXL_POWER_RATIO'))
    frame = processor.clean_and_process_ecg_leads(frame, max_workers=1)
    x = np.asarray(frame.iloc[0]['ecg_signal'], dtype=np.float32)
    tensor = torch.from_numpy(x.T.copy()).unsqueeze(0)
    torch.set_num_threads(2)
    if architecture == 'efficientnet':
        path, manifest = verified_weight('efficientnet_deepecg_unscaled.pt')
        # Exact coefficient from official EfficientNetWrapper.__call__.
        tensor = tensor * (1 / 0.0048)
        model = torch.jit.load(str(path), map_location='cpu').eval()
        with torch.inference_mode():
            scores = torch.sigmoid(model(tensor)).cpu().numpy()
    else:
        path, manifest = verified_weight('wcr_77_classes.pt')
        base, base_manifest = verified_weight('base_ssl.pt')
        sys.path.insert(0, str(ROOT / 'work/fairseq-signals'))
        from fairseq_signals.utils import checkpoint_utils
        model, _, _ = checkpoint_utils.load_model_and_task(
            str(path), arg_overrides={'model_path':str(base)}, suffix='')
        model = model.to('cpu').eval()
        with torch.inference_mode():
            output = model(source=tensor, padding_mask=None)
            scores = torch.sigmoid(model.get_logits(output)).cpu().numpy()
        scores = scores[:, constant('WCR_COLUMN_CONVERSION')]
        manifest = dict(finetuned=manifest, pretrained=base_manifest)
    labels = constant('ECG_PATTERNS')
    if scores.shape != (1, len(labels)) or not np.isfinite(scores).all():
        raise ValueError(f'Unexpected model output: {scores.shape}')
    runtime = dict(python=platform.python_version(), torch=torch.__version__,
                   numpy=np.__version__, platform=platform.machine(), evaluation_mode=True)
    if architecture == 'wcr':
        runtime.update(fairseq_revision='bb3901447e2175ed5832b03170b89dbbdcf85062',
                       compatibility_patch_sha256=hashlib.sha256(
                           Path(__file__).with_name('fairseq-python312-compat.patch').read_bytes()).hexdigest())
    return dict(model=('heartwise/EfficientNetV2_77_Classes' if architecture == 'efficientnet' else 'heartwise/WCR_77_Classes'),
                weights=manifest, device='cpu', preprocessing='official pinned DeepECG_Docker',
                runtime=runtime,
                upstream_revision='cabf6c06b74731c86b8c5a27ae7101f14db5ec38',
                scores={label:float(value) for label,value in zip(labels,scores[0])},
                thresholds=thresholds(architecture, labels),
                threshold_source='DeepECG_Docker thresholds/77_tasks_final.json (' + ('SL' if architecture == 'efficientnet' else 'SSL') + '_sens_spec_threshold)',
                diagnosis_assigned=False,
                note='Raw model scores, not calibrated individual disease probabilities; clinical validation not established')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input-dir', type=Path)
    p.add_argument('--smoke-test', action='store_true')
    p.add_argument('--model', choices=['efficientnet', 'wcr'], default='efficientnet')
    p.add_argument('--report', type=Path, required=True)
    args = p.parse_args()
    if args.smoke_test == bool(args.input_dir):
        p.error('Choose either --smoke-test or --input-dir')
    if args.report.exists():
        p.error('Report already exists; choose a new filename')
    if args.smoke_test:
        t = np.arange(2500, dtype=float) / 250
        signal = (.08*np.sin(2*np.pi*1.2*t[:,None]+np.arange(12)[None,:]/10)
                  + .02*np.sin(2*np.pi*15*t[:,None])).astype(np.float32)
        source = 'SYNTHETIC ENGINEERING TEST; NOT A PATIENT ECG'
        synthetic = True
    else:
        meta = json.loads((args.input_dir / 'provenance.json').read_text())
        path = args.input_dir / 'signal_mV_250Hz.npy'
        if meta.get('output_rate_hz') != 250 or meta.get('output_units') != 'mV':
            p.error('Missing expected input metadata')
        if meta.get('signal_sha256') != hashlib.sha256(path.read_bytes()).hexdigest():
            p.error('Signal SHA256 missing or mismatched; regenerate export')
        signal = np.load(path, allow_pickle=False)
        source = meta
        synthetic = meta.get('synthetic_input') is True
    result = infer(signal, args.model)
    result.update(source=source, synthetic_test=synthetic)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f'CPU inference complete; {len(result["scores"])} outputs; synthetic={synthetic}')


if __name__ == '__main__':
    main()
