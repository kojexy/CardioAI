#!/usr/bin/env python3
"""Local preparation only; never downloads weights or uploads patient records."""
import argparse
import hashlib
import json
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly
from ecg_reader import LEADS, read_record


def prepare(counts, meta):
    x = np.asarray(counts)
    if x.ndim != 2 or x.shape[1] != 12 or not np.isfinite(x).all():
        raise ValueError('Expected finite numeric array (samples, 12)')
    if meta.get('lead_order') != LEADS:
        raise ValueError('Lead order must be I,II,III,aVR,aVL,aVF,V1..V6')
    for field in ('timing_verified', 'calibration_verified', 'simultaneous_verified'):
        if meta.get(field) is not True:
            raise ValueError(f'{field} is not confirmed')
    if not str(meta.get('verification_evidence', '')).strip():
        raise ValueError('Missing verification evidence')
    fs = float(meta['sampling_rate_hz'])
    gain = float(meta['microvolts_per_count'])
    zero = np.asarray(meta['zero_counts'], dtype=float)
    if not np.isfinite(fs) or fs <= 0 or not np.isfinite(gain) or gain <= 0:
        raise ValueError('Invalid sampling rate or voltage scale')
    if zero.shape not in ((), (12,)) or not np.isfinite(zero).all():
        raise ValueError('zero_counts must be finite scalar or 12 values')
    # Never pad/repeat/stretch to turn a short record into ten seconds.
    if len(x) / fs < 10 - 1e-9:
        raise ValueError(f'Signal too short: {len(x)/fs:.6g} s; need 10 s')
    if np.any(np.ptp(x, axis=0) == 0):
        raise ValueError('At least one lead is flat')
    ratio = Fraction(250 / fs).limit_denominator(10000)
    if abs(float(ratio) * fs - 250) > 1e-7:
        raise ValueError('Unsupported sampling rate ratio')
    mv = (x.astype(np.float64) - zero) * gain / 1000
    y = resample_poly(mv, ratio.numerator, ratio.denominator, axis=0)
    y = np.asarray(y[:2500], dtype=np.float32)
    if y.shape != (2500, 12) or not np.isfinite(y).all():
        raise ValueError('Resampling did not produce finite (2500,12)')
    return y, dict(input_samples=len(x), input_rate_hz=fs,
                   input_duration_seconds=len(x)/fs, output_rate_hz=250,
                   output_shape=[2500, 12], output_units='mV',
                   selected_window='first 10 seconds',
                   resampling='scipy.signal.resample_poly; anti-alias FIR',
                   conversion=dict(microvolts_per_count=gain,
                                   zero_counts=zero.tolist(),
                                   timing_verified=True,
                                   calibration_verified=True,
                                   simultaneous_verified=True),
                   verification_evidence=meta['verification_evidence'],
                   synthetic_input=meta.get('synthetic_input') is True,
                   model_run=False, clinical_validation=False)


def audit_record(path):
    blob = path.read_bytes()
    result = dict(source_sha256=hashlib.sha256(blob).hexdigest(), size_bytes=len(blob),
                  ready_for_deepecg=False, model_run=False)
    try:
        r = read_record(blob)
    except (ValueError, UnicodeError) as e:
        result.update(status='UNSUPPORTED_LAYOUT', reason=str(e))
        return result
    result.update(status='NEEDS_VERIFICATION', record_id=r['record_id'],
                  samples_per_lead=len(r['block_B'][0]),
                  lead_order_candidate=LEADS,
                  blockers=['Storage sampling rate requires confirmation',
                            'Voltage scale requires confirmation',
                            'Simultaneous lead timing requires confirmation'],
                  reference_photo_estimates=dict(rate_hz=200, duration_seconds=3,
                                                 microvolts_per_count=1.16,
                                                 verified=False))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='mode', required=True)
    a = subs.add_parser('audit')
    a.add_argument('record', type=Path)
    a.add_argument('--report', type=Path, required=True)
    e = subs.add_parser('export')
    e.add_argument('counts_npy', type=Path)
    e.add_argument('--metadata', type=Path, required=True)
    e.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'audit':
        report = audit_record(args.record)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return
    blob = args.counts_npy.read_bytes()
    meta = json.loads(args.metadata.read_text())
    digest = hashlib.sha256(blob).hexdigest()
    if meta.get('counts_sha256') != digest:
        parser.error('Metadata is not bound to these counts: SHA256 mismatch')
    try:
        signal, report = prepare(np.load(args.counts_npy, allow_pickle=False), meta)
    except (ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    # Exclusive directory prevents accidental reuse/overwrite of an old export.
    args.out.mkdir(parents=True, exist_ok=False)
    np.save(args.out / 'signal_mV_250Hz.npy', signal, allow_pickle=False)
    report.update(counts_sha256=digest, lead_order=LEADS,
                  signal_sha256=hashlib.sha256((args.out / 'signal_mV_250Hz.npy').read_bytes()).hexdigest())
    (args.out / 'provenance.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print('Prepared numerical input only. Model has not run.')


if __name__ == '__main__':
    main()
