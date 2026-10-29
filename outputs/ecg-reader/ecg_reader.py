#!/usr/bin/env python3
"""Experimental ECG301 / LE1203 reader. Python 3 standard library only.
No clinical interpretation. Units are ADC counts unless independently calibrated.
"""
import argparse, csv, hashlib, json, math, struct
from pathlib import Path

SIZE=39381
LEADS=['I','II','III','aVR','aVL','aVF','V1','V2','V3','V4','V5','V6']

def correlation(a,b):
    ma=sum(a)/len(a); mb=sum(b)/len(b)
    aa=[v-ma for v in a]; bb=[v-mb for v in b]
    den=math.sqrt(sum(v*v for v in aa)*sum(v*v for v in bb))
    return sum(x*y for x,y in zip(aa,bb))/den if den else 0

def read_record(blob):
    if len(blob)!=SIZE: raise ValueError(f'Unsupported layout: {len(blob)} bytes; expected {SIZE}. File left unchanged.')
    rid=blob[6:20].decode('ascii',errors='strict')
    if not rid.isdigit(): raise ValueError('Invalid record identifier')
    def channels(start,n):
        nums=struct.unpack_from('<'+str(n*12)+'H',blob,start)
        if any(x>4095 for x in nums): raise ValueError('Signal outside candidate 12-bit layout. Unsupported file.')
        return [list(nums[i*n:(i+1)*n]) for i in range(12)]
    a=channels(79,1000); b=channels(24981,600)
    hr,pr,qrs,qt,qtc=struct.unpack_from('<5H',blob,24079)
    rr=list(struct.unpack_from('<11H',blob,24089))
    if not (20<=hr<=300 and 20<=qrs<=400 and 100<=qt<=800 and all(200<=v<=3000 for v in rr)):
        raise ValueError('Metadata does not match supported candidate layout')
    scores={}
    for name,y in [('A',a),('B',b)]:
        scores[name]=correlation([v-u for u,v in zip(y[0],y[1])],y[2])
        if scores[name]<.95: raise ValueError('Limb-lead identity failed: ordering or layout is unsupported')
    return dict(record_id=rid,sha256=hashlib.sha256(blob).hexdigest(),file_size=len(blob),
        block_A=a,block_B=b,
        inferred_metadata=dict(heart_rate_bpm=hr,PR_ms=pr,QRS_ms=qrs,QT_ms=qt,QTc_ms=qtc,RR_ms=rr,axes_degrees=list(struct.unpack_from('<3H',blob,24451)),RV5_mV=struct.unpack_from('<f',blob,24459)[0],SV1_mV=struct.unpack_from('<f',blob,24463)[0]),
        paper_check=dict(reference_sha256='610860ddcc8cdc747f314da2aa6b33bd163f0f29ec9a44ffc4d79241b3fe1cce',matches_reference=hashlib.sha256(blob).hexdigest()=='610860ddcc8cdc747f314da2aa6b33bd163f0f29ec9a44ffc4d79241b3fe1cce',calibration_status='Estimated from photos only; B about 200 Hz, A about 1000 Hz, voltage about 1.16 microvolt/count'),
        checks=dict(limb_identity_correlation=scores,RR_mean_ms=sum(rr)/len(rr),
          QTc_from_mean_RR=qt/math.sqrt(sum(rr)/len(rr)/1000)),
        lead_order_hypothesis=LEADS,
        status='EXPERIMENTAL: no confirmed sampling rate, voltage scale or manufacturer specification')

def export_csv(path,channels):
    with path.open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['sample_index']+[f'channel_{i+1:02d}_raw_counts' for i in range(12)])
        for i,row in enumerate(zip(*channels)):w.writerow([i,*row])

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('file',type=Path);p.add_argument('--out',type=Path,required=True)
    args=p.parse_args();data=read_record(args.file.read_bytes());args.out.mkdir(parents=True,exist_ok=True)
    for key in ['block_A','block_B']:export_csv(args.out/(key+'_raw_counts.csv'),data[key])
    report={k:v for k,v in data.items() if k not in ['block_A','block_B']}
    (args.out/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
