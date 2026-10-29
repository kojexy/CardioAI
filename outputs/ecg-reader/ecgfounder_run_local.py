#!/usr/bin/env python3
"""Local ECGFounder 150-label inference; standard input remains ten seconds."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform

import numpy as np
from scipy.signal import resample_poly
import torch

APP = Path(__file__).resolve().parent
ROOT = APP.parents[1]
WORK = Path(os.environ.get('CARDIOAI_WORK') or ROOT / 'work')
UPSTREAM = WORK / 'ECGFounder'
WEIGHTS = WORK / 'ecgfounder-weights/12_lead_ECGFounder.pth'
MANIFEST = APP / 'ecgfounder-source-manifest.json'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def verified_assets():
    manifest = json.loads(MANIFEST.read_text())
    for name, expected in manifest['source_files'].items():
        if digest(UPSTREAM / name) != expected:
            raise ValueError('ECGFounder source SHA256 mismatch: ' + name)
    weight = json.loads(WEIGHTS.with_suffix('.pth.json').read_text())
    if (weight['sha256'] != manifest['weight_sha256']
            or weight['revision'] != manifest['weight_revision']
            or WEIGHTS.stat().st_size != manifest['weight_size']
            or digest(WEIGHTS) != manifest['weight_sha256']):
        raise ValueError('ECGFounder weight integrity check failed')
    labels = (UPSTREAM / 'tasks.txt').read_text().splitlines()
    if len(labels) != 150 or len(set(labels)) != 150:
        raise ValueError('Expected 150 unique labels in official order')
    return manifest, weight, labels


def normalize(x):
    """Exact global z-score from official PTBXL_Dataset, not per-lead scaling."""
    x = np.asarray(x, dtype=np.float64)
    if (x.ndim != 2 or x.shape[1] != 12 or x.shape[0] < 2
            or not np.isfinite(x).all() or np.any(np.ptp(x, axis=0) == 0)):
        raise ValueError('Expected finite non-flat 12-lead signal')
    return ((x - np.mean(x)) / (np.std(x) + 1e-8)).astype(np.float32)


def prepare_standard(signal):
    if (not isinstance(signal, np.ndarray) or signal.shape != (2500, 12)
            or signal.dtype.kind not in 'fiu' or not np.isfinite(signal).all()
            or np.any(np.ptp(signal, axis=0) == 0)):
        raise ValueError('Standard ECGFounder adapter requires (2500,12), 250 Hz, ten seconds')
    # Change sampling density, preserving ten seconds. Never stretch a short ECG.
    return normalize(resample_poly(signal.astype(np.float64), 2, 1, axis=0))


def load_model():
    manifest, weight, labels = verified_assets()
    spec = importlib.util.spec_from_file_location('ecgfounder_net1d_pinned', UPSTREAM / 'net1d.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    torch.set_num_threads(2)
    model = module.Net1D(in_channels=12, base_filters=64, ratio=1,
                         filter_list=[64,160,160,400,400,1024,1024],
                         m_blocks_list=[2,2,2,3,3,4,4], kernel_size=16, stride=2,
                         groups_width=16, verbose=False, use_bn=False,
                         use_do=False, n_classes=150)
    # The verified official checkpoint includes a NumPy validation scalar.
    # Keep PyTorch's restricted loader; allow only these known numeric types.
    with torch.serialization.safe_globals([
            (np._core.multiarray.scalar, 'numpy.core.multiarray.scalar'),
            np.dtype, np.dtypes.Float64DType,
            np.dtypes.Float32DType]):
        checkpoint = torch.load(WEIGHTS, map_location='cpu', weights_only=True)
    model.load_state_dict(checkpoint['state_dict'], strict=True)
    return model.eval(), manifest, weight, labels


def evaluate(model, normalized, labels):
    if (normalized.ndim != 2 or normalized.shape[1] != 12
            or not np.isfinite(normalized).all()):
        raise ValueError('Invalid model tensor')
    tensor = torch.from_numpy(np.asarray(normalized.T.copy(), dtype=np.float32)).unsqueeze(0)
    with torch.inference_mode():
        scores = torch.sigmoid(model(tensor)).cpu().numpy()
    if scores.shape != (1, 150) or not np.isfinite(scores).all():
        raise ValueError('Expected 150 finite model scores')
    return {label: float(value) for label, value in zip(labels, scores[0])}


def infer(signal):
    normalized = prepare_standard(signal)
    model, manifest, weight, labels = load_model()
    scores = evaluate(model, normalized, labels)
    return dict(model='PKUDigitalHealth/ECGFounder', device='cpu', scores=scores,
                weights=weight, upstream_revision=manifest['source_revision'],
                preprocessing=manifest['preprocessing'], model_input_shape=[1,12,5000],
                runtime=dict(python=platform.python_version(), torch=torch.__version__,
                             numpy=np.__version__, platform=platform.machine(), evaluation_mode=True),
                diagnosis_assigned=False,
                note='Raw model scores, not calibrated individual probabilities; clinical validation on ECG301 not established')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path)
    parser.add_argument('--smoke-test', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.smoke_test == bool(args.input_dir):
        parser.error('Choose --smoke-test or --input-dir')
    if args.report.exists():
        parser.error('Report already exists')
    if args.smoke_test:
        t = np.arange(2500) / 250
        signal = (.08*np.sin(2*np.pi*1.2*t[:,None]+np.arange(12)[None,:]/10)
                  + .02*np.sin(2*np.pi*15*t[:,None])).astype(np.float32)
        source = 'SYNTHETIC ENGINEERING TEST; NOT A PATIENT ECG'
        synthetic = True
    else:
        from deepecg_local_server import check_provenance
        raw = (args.input_dir / 'signal_mV_250Hz.npy').read_bytes()
        source = json.loads((args.input_dir / 'provenance.json').read_text())
        check_provenance(source, raw)
        signal = np.load(args.input_dir / 'signal_mV_250Hz.npy', allow_pickle=False)
        synthetic = source.get('synthetic_input') is True
    result = infer(signal)
    result.update(source=source, synthetic_test=synthetic)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('ECGFounder CPU inference complete; 150 scores; synthetic=' + str(synthetic))


if __name__ == '__main__':
    main()
