# CardioAI: critique of the AI analysis

Date: 2026-10-29. Branch `feature/patients-compare-apps`. Upstream pins: DeepECG_Docker `cabf6c0`, fairseq-signals `bb39014`, ECGFounder `04edac7`.

## Scope and method

I read every Python file in `outputs/ecg-reader/` and `scripts/`, the JS comparison engine in `app/js/`, and the pinned upstream code. That covers `utils/ecg_signal_processor.py`, `utils/constants.py`, `utils/files_handler.py`, `utils/analysis_pipeline.py`, both model wrappers and `thresholds/*.json` in DeepECG_Docker, plus `ptbxl_eval.py`, `dataset.py` and `util.py` in ECGFounder.

I did **not** run the models. `work/` is a symlink into iCloud-synced `~/Documents` and Python imports hung there (see H5). Instead I reproduced the upstream scaling and normalisation formulas in plain NumPy on a synthetic 12-lead ECG (temporary script, not kept in the repo). The numbers quoted below are from that script.

**Short verdict:** the plumbing matches upstream line by line:

- lead order;
- the `1/0.0048` factor;
- `PTBXL_POWER_RATIO`;
- sigmoid;
- `WCR_COLUMN_CONVERSION`, applied after the sigmoid as upstream does;
- the ECGFounder `Net1D` arguments and the global z-score.

The weak points are elsewhere: how the scores are **interpreted and presented**, and two preprocessing regimes the authors never validated.

---

## Critical

### C1. Raw scores are shown without the authors' decision thresholds, and the JS comparison assumes 0.5
- **Finding:** Upstream publishes a decision threshold for each label, and the thresholds are far from 0.5. Our runners never emit them, so the UI shows six-decimal raw scores. The comparison engine then falls back to a 0.5 threshold.
  - Upstream `thresholds/77_tasks_final.json` gives `SL_sens_spec_threshold` and `SSL_sens_spec_threshold` for each of the 77 labels.
  - `thresholds/wcr_77_classes_ecg_machine_diagnosis.json` adds the per-label AUC, AUPRC, F1, threshold and prevalence.
  - Examples (SL / SSL threshold):

    | Label | SL | SSL |
    |---|---|---|
    | Afib | 0.074 | 0.004 |
    | LBBB | 0.068 | 0.006 |
    | Atrial flutter | 0.010 | 0.001 |
    | LVH | 0.063 | 0.035 |
    | **Sinusal** | **0.872** | **0.95** |

  - So an SSL "Afib" score of 0.02 is **above** the authors' operating point. An SSL "Sinusal" score of 0.90 is **below** it. A reader of raw numbers concludes the opposite in both cases.
- **Evidence:**
  - `deepecg_run_local.py:84-90` and `ecgfounder_run_local.py:102-108` return `scores` only.
  - `DeepECG-local.html:61` prints `toFixed(6)`.
  - `app/js/main.js:73` reads `report.thresholds`, which is never produced.
  - `app/js/compare.js:166` falls back to `rules.js:62` (`threshold: 0.5`).
  - Upstream: https://github.com/HeartWise-AI/DeepECG_Docker/tree/cabf6c06b74731c86b8c5a27ae7101f14db5ec38/thresholds and `compute_optimal_thresholds.py`, which uses Youden J and best-F1.
- **Fix:**
  - Load the model-specific threshold from `77_tasks_final.json` (SL for EfficientNet, SSL for WCR) and add `thresholds` plus `threshold_source` to each report.
  - Show three things per label:
    1. above or below the operating point;
    2. the margin as logit(score) − logit(threshold);
    3. the authors' AUROC, F1 and prevalence, so that weak labels are visible (e.g. Atrial flutter F1 0.36; Brugada has NaN metrics).
  - Sort by margin, not by label order. Drop the six decimals.
  - ECGFounder publishes **no** fixed thresholds. `util.find_optimal_thresholds` computes Youden thresholds per evaluation dataset. Either derive thresholds on PTB-XL with the official `ptbxl_eval.py`, or show ECGFounder as a rank/percentile only, labelled "no published operating point".

### C2. DeepECG amplitude normalisation runs on a batch of one, a regime upstream never used
- **Finding:** `scale_ecg_signals` multiplies the **whole** record by `PTBXL_POWER_RATIO / mean(|FFT(lead I)|)`.
  - Upstream computes this mean spectrum over a chunk of up to 10 000 ECGs (`analysis_pipeline.py`, `batch_size = 10000`), so the factor is roughly dataset-level.
  - We call it on one record (`deepecg_run_local.py:49-50`). The factor becomes per-record and is driven entirely by lead I.
  - Absolute calibration therefore has no effect at all: doubling the gain gives the same model input.
  - The model input is instead very sensitive to lead-I artefacts. Factor ratio versus a clean synthetic ECG:

    | Change to the input | Factor ratio |
    |---|---|
    | 50 µV white noise | **0.29** |
    | 0.3 mV 0.25 Hz baseline wander | **0.57** |
    | +0.5 mV DC on lead I | **0.64** |
    | 0.1 mV 50 Hz mains on lead I | 0.90 |
    | Low lead-I amplitude (vertical axis, ×0.3) | **3.3** |

  - Voltage-driven labels such as "SV1 + RV5 or RV6 > 35 mm", "RaVL > 11 mm", "Low voltage" and LVH therefore depend on lead-I noise and axis, not on true mV.
  - Side note: `adjust_spectral_power` applies `np.fft.fft` along the lead axis. It is a plain scalar multiply, so it is harmless, but it is not the "spectral" operation its name suggests.
- **Evidence:**
  - Upstream `utils/ecg_signal_processor.py:46-53` (lead index 0 only; DC bin included in the mean).
  - `utils/constants.py:514`.
  - Experiment run with a temporary NumPy script (not kept in the repo).
- **Fix:**
  - Because our input is already calibrated mV, replace the per-record factor with a **fixed reference factor**: `PTBXL_POWER_RATIO / m_ref`, where `m_ref` is the mean lead-I |FFT| of PTB-XL at 250 Hz and 2500 samples.
    - Compute it once on PTB-XL (CC-BY 4.0; HeartWise also hosts `heartwise/PTB-XL_lite`) and pin it in `model-assets`.
  - Always write the factor actually used into the report. Warn when it is more than about 2× from the reference.
  - Add a perturbation check: rerun EfficientNet (7 MB, fast) with factor ×0.7 and ×1.4. Report labels whose threshold decision flips as "unstable".
  - Remove per-lead DC before computing any factor.

---

## High

### H1. ECGFounder runs without the filtering it was trained with
- **Finding:** `ecgfounder-source-manifest.json` declares the unfiltered `ptbxl_eval.py` branch to be "the" inference branch. But:
  - the upstream README tells users to "strictly follow the preprocessing steps in dataset.py, including filtering and z-score normalization";
  - `util.filter_bandpass` applies a 50 Hz notch, a 4th-order Butterworth 0.67–40 Hz band-pass (`filtfilt`) and a 0.4 s median baseline subtraction;
  - the paper (arXiv 2410.04133, §2.1/S3.3) trained with a 0.5–1 Hz high-pass, a notch and a 30–50 Hz low-pass.

  Without a high-pass, the **global** z-score is distorted by per-lead offsets:

  | Condition | Precordial amplitude after normalisation |
  |---|---|
  | Per-lead DC offsets of ±1 mV | shrinks to **0.24×** |
  | 0.3 mV wander | 0.76× |
  | V1–V6 gain error of ×2 | limb leads shrink to 0.56× |

- **Evidence:** `ecgfounder_run_local.py:46-61`; `work/ECGFounder/util.py:28-55`; https://github.com/PKUDigitalHealth/ECGFounder (README).
- **Fix:**
  - Apply `filter_bandpass` (from the pinned `util.py`) at 500 Hz before `z_score`.
  - Report both variants once on a PTB-XL sample to confirm which one reproduces the published AUROCs.
  - Keep `strict=True` loading; it is already stricter than upstream.

### H2. Lead order and lead derivation are only weakly verified
- **Finding:**
  - The decoder accepts a record if corr(II − I, III) ≥ 0.95 (`ecg_reader.py:31-33`). That checks neither the amplitude ratio nor aVR/aVL/aVF.
  - V1–V6 order is an unverified hypothesis (`ecg_reader.py:40`).
  - `deepecg_prepare.py:18` only compares the *metadata string* `lead_order` to `LEADS`.
  - A swapped precordial pair or a gain error on one channel would pass silently and change many labels.
- **Fix:**
  - Check the Einthoven/Goldberger residuals: `III-(II-I)`, `aVR+(I+II)/2`, `aVL-(I-II/2)`, `aVF-(II-I/2)`. RMS residual should be under 2–3 quantisation steps if the device derives these leads. Require slope ≈1, not just correlation.
  - Precordial plausibility: R-wave progression, with the R/S ratio rising from V1 to V5. Each Vn should correlate best with its neighbours.
  - Limb reversal rules:
    - negative P **and** QRS in lead I with positive aVR → LA/RA swap;
    - the Kors & van Herpen reconstruction-correlation method (redundancy of the 12 leads; sensitivity about 95%, specificity over 99% in later inter-lead-correlation work).
  - DeepECG's own "Lead misplacement" output (with its threshold) is a cheap second opinion.

### H3. The signal-quality gate is only "peak-to-peak == 0"
- **Finding:** `deepecg_prepare.py:35`, `deepecg_run_local.py:44`, `ecgfounder_run_local.py:50` and `deepecg_local_server.py:140` reject only an exactly constant lead. There is no check for:
  - saturation;
  - noise;
  - mains interference;
  - baseline wander;
  - low amplitude;
  - pacing.

  C1 and H1 show the models are strongly affected by exactly these.
- **Fix:** add a per-lead QC report before inference, and block or warn on failure:

  | Check | Suggested rule |
  |---|---|
  | Flat or near-flat | Rolling 2 s std < 10 µV |
  | Saturation | ≥3 consecutive samples at ADC rails (0/4095) or at the same extreme |
  | Mains | Power at 50/60 ± 1 Hz versus 5–40 Hz > 0.2 |
  | EMG / high-frequency noise | Power above 40 Hz versus 5–40 Hz |
  | Baseline wander | Range of the 1 s moving average (the JS `baselineSway` already does this) or power below 0.5 Hz |
  | QRS-based SQIs | NeuroKit2 `ecg_quality(method="zhao2018")`: pSQI 5–15/5–40 Hz, kSQI kurtosis > 5, basSQI. Use `averageQRS` for per-beat template correlation. Add bSQI as agreement between two R detectors (`neurokit` and `pantompkins1985`). Note: NeuroKit2 is MIT, not yet in the venv, and zhao2018 has known calibration issues (NeuroKit issue #1023); use it as a warning, not as ground truth. |
  | Pacemaker | Spikes are unreliable at 200–250 Hz. Use the device flag. If block A really is about 1 kHz, detect spikes there with a slope over 50 mV/s for under 2 ms. Mark paced records as out of scope. |

### H4. Device values can verify sampling rate and gain, but they are not used for that
- **Finding:** The blockers "sampling rate / voltage scale unconfirmed" are resolved by photo-fitting (`deepecg_prepare.py:72-77`). Yet the file itself carries `RR_ms` (11 intervals), HR, QRS, QT, `RV5_mV` and `SV1_mV` (`ecg_reader.py:26-36`).
- **Fix:**
  - **Sampling rate:** detect R peaks in the stored block. Match the sequence of RR intervals in samples to `RR_ms`, by cross-correlating the RR pattern, because the stored strip may be shorter than the measurement window. This gives fs = samples / RR_ms × 1000, with an error estimate.
  - **Gain:** measure RV5 and SV1 in counts on a median beat, relative to the QRS-onset baseline. Divide by the device mV values to get µV/count.
  - Agreement within about 2% in both checks is far stronger evidence than photo fitting. Record it as `verification_evidence`.

### H5. Model install inside an iCloud-synced folder hangs inference
- **Finding:** `work/` → a folder inside `~/Documents` (iCloud Desktop & Documents). Many files there are "dataless" (offloaded):
  - `cat` of upstream source files took 60–300 s or more;
  - Python imports of numpy/torch from `work/deepecg-venv` hung at 0% CPU;
  - every run also SHA256-hashes about 2.2 GB of weights (`deepecg_run_local.py:20-29`), which forces a full download.

  The server turns this into a generic "model failed / 10 min timeout" (`deepecg_local_server.py:174-180`).
- **Fix:**
  - Install venv, sources and weights outside iCloud, e.g. `~/Library/Application Support/CardioAI/` or `~/.cache/cardioai/`. Point `work/` there or make the path configurable.
  - In `setup_models.py` and at server start, refuse or warn when the path is under `~/Documents`, `~/Desktop` or `~/Library/Mobile Documents`. Check `stat -f %Sf` for the `dataless` flag.
  - Cache weight hashes by (inode, size, mtime) instead of re-hashing 2 GB per run.

### H6. Cross-model "agreement" in the JS engine is not meaningful as implemented
- **Finding:**
  - `compare.js:181-188` votes per **label group and direction**. "Sinusal ↑" from one model and "Afib ↑" from another both count as "ритм ↑" agreement, although they mean opposite things.
  - `LABEL_GROUP_OF` covers only the 77 DeepECG labels (`rules.js:70-81`), so ECGFounder's 150 upper-case labels never vote.
  - The only possible "≥2 models" agreement is SL + SSL. These share training data (MHI), the BERT-derived labels and the label set, so they are correlated, not independent.
- **Fix:**
  - Vote per **mapped concept** with each model's own threshold.
  - Build one explicit concept table (77 ↔ 150), with relation type exact/broader/narrower. Today `founder_report.py:19-42` maps 21 pairs by name similarity.
  - Count ECGFounder as the independent opinion: different data (HEEDB, Boston/Emory), different labels (12SL-assisted reports).
  - Report "SL+SSL agree" separately from "DeepECG and ECGFounder agree".

---

## Medium

### M1. The score-change rule misses low-threshold labels
- **Finding:** `scoreLevel` (`compare.js:151-155`) requires Δp ≥ 0.05 **and** Δlogit ≥ 0.3. For SSL Afib (threshold 0.004), a change from 0.002 to 0.04 crosses the operating point and is +3 logits, but it is ignored because Δp < 0.05. `logit` clamps at 0.001/0.999 (`compare.js:149`), which equals several SSL thresholds.
- **Fix:** Use the margin, logit(score) − logit(threshold), with a clamp of about 1e-6. Flag threshold crossings with hysteresis in logit space (e.g. ±0.5).

### M2. The JS median-beat and ST measurement is a reasonable first pass but fragile
- **Findings** (`app/js/signal.js`):
  - ST is read at R + 120 ms (`rules.js:54`, `signal.js:147`). "R" is the point of maximum summed |amplitude|, not the J point. With a wide QRS (LBBB, 160 ms) R + 120 ms can still lie inside the QRS.
  - The isoelectric window (200–40 ms before R) can fall into the Q wave when the QRS is wide.
  - There is no exclusion of ectopic or aberrant beats before the median, and no beat-class clustering. With bigeminy the template mixes morphologies.
  - Block B is about 3 s (600 samples at ~200 Hz), so a template is usually a median of only 2–4 beats. `minBeatsReliable: 6` already warns about this; keep it prominent.
  - `detectBeats` uses 0.45 × the 98th percentile of slope energy. Tall, sharp T waves or pacing spikes can create false beats.
- **Fix:**
  - Detect the global QRS onset and offset (J) on the multi-lead template, using the earliest onset and latest offset across leads (CSE/IEC 60601-2-25 "global" convention). Measure ST at J + 60 ms (J + 80 ms below 100 bpm), as is conventional.
  - Drop beats whose correlation with the provisional template is below 0.9.
  - Report the beat count per template.

### M3. No independent classical measurements to cross-check the device
- **Finding:** Intervals and axes come only from the device (`ecg_reader.py:26-36`, `measure.js`).
- **Fix:** yes, compute our own, mainly as a decoder/calibration check (H4) and to catch device errors:
  - R peaks: `nk.ecg_peaks` (two methods for bSQI).
  - Representative beat per lead: median beat, ectopics excluded.
  - Delineation: `nk.ecg_delineate(method="dwt")` on the median beats (NeuroKit2 delineation is not validated against CSE, so treat it as a cross-check). Then global PR, QRS and QT from the earliest onset and latest offset across leads.
  - HR from the RR median.
  - QRS axis: `atan2(aVF_net·2/√3, I_net)` from net QRS area. Same method for the P and T axes.
  - Compare with the device using IEC 60601-2-25 style tolerances: mean difference within about ±10 ms for PR and QRS and about ±25 ms for QT, and about ±15° for axis.
  - Persistent bias means a timing or calibration error in the decoder. Single-record outliers mean noise or the delineator failed.

### M4. Only the first 10 s are analysed, with no window-to-window uncertainty
- **Finding:** `deepecg_prepare.py:42` keeps `y[:2500]`.
- **Fix:** For longer records, run on several (e.g. 50%-overlapping) 10 s windows. Report the median score and the min–max range. Choose the window by the QC score, not by position. This also gives the `ranges` field that `compare.js:170` already supports.

### M5. Tests check plumbing, not numerical fidelity to upstream
- **Finding:**
  - The smoke inputs are sums of sinusoids (`deepecg_run_local.py:105-107`).
  - The tests assert shape, repeatability and hashes (`test_ecgfounder.py:43-50`).
  - Nothing would detect a wrong scale, lead order or filter, and nothing does a real end-to-end comparison with upstream's `main.py` path.
- **Fix:** Add a golden test on 2–3 public PTB-XL records (e.g. one each with AF, LBBB and normal), with outputs computed **once** with the upstream Docker pipeline. Pin the expected scores with tolerance 1e-4. Also assert that `77_tasks_final.json` contains all 77 `ECG_PATTERNS` keys exactly.

### M6. Calibration is not addressed
- **Finding:** None of the three papers reports calibration. Sigmoid outputs reflect training prevalence: MHI Montreal for DeepECG, HEEDB for ECGFounder. The notes "not calibrated probabilities" are correct but give the user nothing usable.
- **Fix:**
  - Short term: use thresholds plus margin (C1) and show the authors' prevalence alongside.
  - Longer term: fit Platt or isotonic calibration per mapped concept on PTB-XL (public labels). Show "PTB-XL-calibrated" values separately from raw values.

---

## Low

- **L1:** Our anti-aliased `resample_poly` (`deepecg_prepare.py:41`) differs from upstream `NPYProcessor`, which decimates with `lead_array[::step]` and no anti-alias filter (`utils/files_handler.py`). Ours is better, but document it as a deliberate deviation.
- **L2:** Everything is forced through 250 Hz and then upsampled 2× for ECGFounder (`ecgfounder_run_local.py:61`). For native 500 Hz sources, feed ECGFounder the original 500 Hz signal; it is trained at 500 Hz.
- **L3:** `audit_record` hard-codes the "200 Hz / 1.16 µV" photo estimates (`deepecg_prepare.py:75-77`). Replace them with the H4 measurements once available.
- **L4:** Upstream threshold JSONs contain duplicates ("Pericarditis" = "Acute pericarditis") and NaN entries ("Brugada"). Show such labels as "no validated operating point".
- **L5:** Paced rhythms, children, and records under 10 s are outside the training distribution. Say so explicitly next to the result, not only in the README.

---

## Newer open ECG models (2024–2026)

| Model | Licence (checked via HF/GitHub API) | Input | Outputs | CPU | Worth adding? |
|---|---|---|---|---|---|
| **HeartWise DeepECG LVEF ≤ 40 / < 50 / AF-5y** (`heartwise/EfficientNetV2_LVEF_equal_under_40`, `…_under_50`, `…_AFIB_5y`, plus WCR variants) | Apache-2.0 | Identical to our 77-class pipeline (250 Hz, 10 s) | Binary risk. Thresholds already in `thresholds/digital_biomarker_final.json` (e.g. LVEF ≤ 40: SL 0.197, SSL 0.002) | EfficientNet: trivial | **Yes, cheapest high-value addition.** Same wrapper and preprocessing. Show as research screening only, with the threshold. Also new: `heartwise/deepecg-sl_finetuned_LVEF_MHI` (2026-03, LVEF regression). |
| **ECG-FM** (bowang-lab, JAMIA Open 2025) | MIT (code and weights) | wav2vec2 / fairseq-signals (already installed); 500 Hz, 5 s segments per paper | MIMIC-IV-ECG fine-tuned labels incl. AF (AUROC 0.996) and LVEF ≤ 40 (0.929) | 90.9 M params, OK on CPU | **Maybe.** A third, independent training population (MIMIC-IV, US) for agreement. Same framework lowers the cost. Add after C1/H6. |
| **ECGFounder** update | MIT | — | Repo added "150-class validation" (Aug 2025); no new 12-lead checkpoint | — | Already used. Fix H1. |
| **HuBERT-ECG** (+ CardioLearning fine-tunes, 164 labels) | **CC BY-NC 4.0** | Downsampled, short windows (check the model card) | 164 harmonised labels | base/large are heavy but feasible | Only for personal non-commercial use. Overlaps with what we have; low priority. |
| **ECG-JEPA, MERL, ST-MEM** | MIT (JEPA, MERL repos) | Representation models | Need our own fine-tuning head | Yes | No. They are not ready-to-use classifiers. |
| **ECG-CPC** (benchmark arXiv 2509.25095) | Weights "to be released" | — | 3.8 M-param SSM; top-tier with ECGFounder and ECG-JEPA on adult interpretation | Ideal for CPU | Watch. Not usable yet. |
| **ECG-language models** (DeepECG-Tok + MedGemma-4B, anyECG-chat, HeartLLM/DiagECG) | Mixed (tokenizer MIT; MedGemma under Health AI terms) | — | Free-text reports | 4 B: slow | **No** for user-facing output. Hallucination risk, and little validation of open models. |

Benchmarks: arXiv 2509.25095 compared 8 open-weight foundation models on 26 tasks. After fine-tuning, ECGFounder, ECG-JEPA and ECG-CPC led adult interpretation, and no model won everywhere. A separate holistic benchmark found ECG-FM and ECGFounder strongest among those it tested. **Conclusion:** our current pair (DeepECG + ECGFounder) is already near the open state of the art for label classification. Gains now come from correct thresholds, QC and preprocessing, not from more classifiers.

Sources:
- https://github.com/HeartWise-AI/DeepECG_Docker
- https://huggingface.co/heartwise
- https://www.medrxiv.org/content/10.1101/2025.03.02.25322575
- https://arxiv.org/html/2410.04133v4
- https://github.com/PKUDigitalHealth/ECGFounder
- https://github.com/bowang-lab/ECG-FM
- https://pubmed.ncbi.nlm.nih.gov/41113504/
- https://huggingface.co/Edoardo-Coppola/HuBERT-ECG-SFT-CardioLearning-base
- https://arxiv.org/html/2509.25095v2
- https://neuropsychology.github.io/NeuroKit/_modules/neurokit2/ecg/ecg_quality.html

---

## Appendix: JS comparison engine (`app/js/`), short review

- **Correct:**
  - `axisDelta` is circular.
  - QTcF uses mean RR.
  - The lag alignment in `compareTemplates` indexes ST consistently after the shift (`signal.js:140-148`).
  - Voltage changes need a relative change of 25% or more.
  - The secondary-ST-T cap applies at QRS ≥ 120 ms.
  - The limb-reversal heuristic (limb r below 0.7, precordial r ≥ 0.95) is sensible.
- **Fix:**
  - Default threshold 0.5 and Δp gating (C1, M1).
  - Group-level voting (H6).
  - ST anchored to R instead of J (M2).
  - No ectopic exclusion (M2).
  - `toMillivolts` uses one scalar `zeroCounts` for all leads; allow per-lead zero, as `deepecg_prepare` does.

---

## Top 5 changes to implement next

1. **Threshold-aware results (C1, M1).**
   - In `deepecg_run_local.py`, read `work/DeepECG_Docker/thresholds/77_tasks_final.json`: `SL_sens_spec_threshold` for efficientnet, `SSL_sens_spec_threshold` for wcr. Add `thresholds`, `margins_logit` and `threshold_source` to the report. Add a test that all 77 labels have a finite threshold, and list the NaN ones.
   - Also emit the per-label AUROC and F1 from `wcr_77_classes_ecg_machine_diagnosis.json`.
   - In the UI, show "above/below the authors' operating point" plus the margin, sorted by margin. Hide the six decimals.
   - In `compare.js`, use margins in logit space. Remove the 0.5 default.
   - For ECGFounder, show "no published operating point" until PTB-XL Youden thresholds are derived with the official `ptbxl_eval.py`.

2. **Fix DeepECG scaling (C2).**
   - Compute `m_ref` once on PTB-XL (250 Hz, 2500 samples, lead I mean |FFT|). Store it in `model-assets/` with provenance.
   - Pass a fixed factor (`PTBXL_POWER_RATIO / m_ref`) instead of calling `scale_ecg_signals` on a batch of one. Subtract the per-lead median first.
   - Log the per-record factor that upstream *would* have used. Warn when it differs by more than 2×.
   - Add an EfficientNet perturbation run at ×0.7 and ×1.4, and mark labels whose decision flips as unstable.

3. **Pre-inference QC and lead checks (H2, H3).**
   - Add `ecg_qc.py`, NumPy plus optional NeuroKit2, with:
     - flat, saturation, mains, high-frequency noise and baseline wander per lead;
     - Einthoven/Goldberger residuals and slope;
     - R-wave progression;
     - LA/RA reversal rule;
     - zhao2018 SQI.
   - Write `qc.json` next to `provenance.json`. Block on hard failures and show warnings beside the scores.

4. **ECGFounder preprocessing and move installs out of iCloud (H1, H5).**
   - Apply the pinned `util.filter_bandpass` (50 Hz notch, 0.67–40 Hz Butterworth, 0.4 s median baseline) at 500 Hz before the global z-score. Update the manifest text.
   - Add a golden PTB-XL test (M5) to confirm the choice.
   - Make the install root configurable, defaulting to `~/Library/Application Support/CardioAI`. Refuse iCloud paths and dataless files. Cache weight hashes.

5. **Verify the decoder from the device's own numbers and build a real concept map (H4, H6).**
   - Detect R peaks in block B. Fit sampling rate to `RR_ms` and gain to `RV5_mV`/`SV1_mV`. Record both as `verification_evidence`.
   - Replace `founder_report.MAPPING` and the group voting with one versioned concept table (77 ↔ 150, relation type).
   - Report agreement per concept, with SL+SSL shown separately from DeepECG-vs-ECGFounder.
