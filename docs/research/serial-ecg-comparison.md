# Serial ECG comparison and patient profile: research and spec

Status: research note for the CardioAI `feature/patients-compare-apps` branch (Oct 2026).
Scope: (1) compare two ECGs of the same person; (2) a patient profile that stores all ECGs over time, and always compares the newest ECG with the previous one and with the baseline, with trend charts.
CardioAI is a research tool. Nothing here makes its output a diagnosis. Every rule below is either **[S]** (taken from a cited source) or **[P]** (a practical choice made for this project, with no source that fixes the number).

---

## 1. How established serial-comparison programs work

| Program | What it compares | Published details |
| --- | --- | --- |
| **GE Marquette 12SL + MUSE** | Interpretive statements, measurements **and stored median-beat waveforms**. Re-analyses the old ECG with the current 12SL version. Says "no change" when a statement flips but nothing clinically changed. | GE Statement of Validation and Accuracy, rev. B, p. 64 ([numed.co.uk PDF](https://www.numed.co.uk/documents/download/216)). Patent US7076287 (new LBBB): if both ECGs have LBBB it is "not new"; a waveform change is reported only if the cross-correlation change is **> 25%**; rhythm modifiers are compared only if the dominant rhythm is the same ([Google Patents](https://patents.google.com/patent/US7076287B2/en)). |
| **GE serial chest-pain patent** | Feature blocks (P, Q, QRS, ST elevation, ST depression, T, QT) per lead, each scored as moderate/high severity, combined by fuzzy logic. | US6564090: ST elevation V1–V6 > 200 µV high, 100–200 µV moderate; limb leads > 100 µV high, 70–100 µV moderate; ST depression beyond −100 µV high, −70 to −100 µV moderate; T inversion > 200 µV high; Q duration crossing 40 ms moderate, 60 ms high; QRS crossing 120 ms high; QTc crossing 450 ms moderate, 480 ms high ([Google Patents](https://patents.google.com/patent/US6564090B2/en)). |
| **Philips TraceMasterVue / DXL serial algorithm** | Statements by diagnostic category + waveform measurements. Modifiers: "now present", "now absent", "remains", "more/less prominent", "insignificant measurement". Prior ECG must be ≥ 30 min older (configurable). | "Significant rhythm change" only if **HR changes by ≥ 20 bpm** or the rhythm mechanism changes (e.g. sinus → AF); new AV block or PVCs are *not* a significant rhythm change. Infarct-category changes: **ΔQ 100 µV / 20 ms, ΔST 100 µV, ΔT 200 µV, in ≥ 2 leads** of the lead group. "ST elevation persists" if 0.1 mV remains ([Ariet, Zhou et al., CinC 2005](https://www.cinc.org/old/Proceedings/2005/pdf/0211.pdf)). Serial comparison cut statement mismatches by 29–47% ([J Electrocardiol 2012](https://www.qxmd.com/r/22995382)). |
| **Glasgow program** | Serial statements built in, with 5 summary statements describing how much the tracing changed, because day-to-day fluctuation is normal ([Hedstrom & Macfarlane 1996](https://www.bohrium.com/paper-details/development-of-a-new-approach-to-serial-analysis/812277354888953857-11283)). Replacing hard thresholds with smooth functions improved repeatability (~31%) ([Glasgow thesis](https://theses.gla.ac.uk/76411)). | Numeric criteria not public. |
| **Hannover ECG System (HES), KORA study** | Significant change = individual difference outside the population percentiles of repeat-ECG differences (same equipment, 2 years apart, n = 860). | QRS duration increase **≥ 16 ms = P99, ≥ 8 ms = P97.5, ≥ 4 ms = P95**. Ignore amplitude differences < 100 µV. Exclude records with HF noise ≥ 30 µV or baseline sway ≥ 300 µV/s. Requiring ≥ 2 changed variables at P1/P99 gave an OR of 2.76 for known heart disease ([Perz et al., CinC 2008](https://www.cinc.org/old/Proceedings/2008/pdf/0101.pdf)). |
| **Mortara/Hillrom VERITAS** | No public serial-comparison criteria found. | — |

Lessons for CardioAI:
1. Compare **measurements and waveforms**, not just labels. A label flip with no measured change is not news (GE, Philips).
2. Use **directional, per-parameter thresholds** and **"≥ 2 leads / ≥ 2 variables"** rules to avoid false alarms (Philips, KORA).
3. **Carry forward** the previous result when nothing significant changed (Philips "remains").
4. Comparisons only make sense when **the same measurement method** produced both ECGs (GE stresses that medians and fiducials must come from the same signal processing).

## 2. Measurement noise: what is *not* a change

Two ECGs of a healthy, stable person are never identical. Sources: breathing, posture, electrode position, heart rate, and the algorithm itself ([Schijvenaars et al. 2008](https://www.pubmed.gov/18358483/)).

| Quantity | Repeat variability (source) |
| --- | --- |
| QTcF | Within-subject SD **9.5 ms** with one ECG, **7.3 ms** with the mean of 3 ECGs (n = 124 volunteers) ([Natekar 2011, PMID 20852005](https://pubmed.ncbi.nlm.nih.gov/20852005/)). A single baseline QTcF has SD ≈ 17 ms in pooled data; Bazett is more variable than other corrections. |
| HR, QRS, QT (one healthy man, 12 ECGs in a month, marked electrodes) | SD: HR **5.8 bpm**, QRS **2.8 ms**, QT **13.6 ms**; amplitude CV **6–13%**; T amplitude varied by > 300 µV ([Zywietz et al., CinC 2003](https://www.cinc.org/old/Proceedings/2003/pdf/689.pdf)). Use ≥ 6–8 averaged beats per measurement. |
| QRS duration over 2 years | P95/P97.5/P99 of change = 4 / 8 / 16 ms ([Perz 2008](https://www.cinc.org/old/Proceedings/2008/pdf/0101.pdf)). |
| Intervals between algorithms | 75th-percentile error vs median of 7 programs: PR 4–6 ms, QRS 4–8 ms, QT 6–10 ms ([Bologna study 2020](https://cris.unibo.it/handle/11585/801607)); software versions can shift QT by 12–24 ms ([Weill Cornell](https://vivo.weill.cornell.edu/display/pubid16784927)). |
| PR | Short-term ICC 0.93 (P duration 0.58) ([ECG-age repeatability preprint](https://www.medrxiv.org/content/10.1101/2025.09.04.25335101.full.pdf)). |
| Voltage (Sokolow-Lyon etc.) | CV ≈ **10%** over one week ([pubid 2137478](https://vivo.weill.cornell.edu/display/pubid2137478)), ≈ 18.5% over ~8 days in another study. Electrode position is the main cause; LVH status flipped in **19%** of patients day-to-day without skin marking, 11% with marking ([Angeli 2006, PMID 17060807](https://pubmed.ncbi.nlm.nih.gov/17060807)). |
| QRS axis | No good test-retest data found. VCG QRS elevation SD 1.9° in one subject (Zywietz). Breathing and posture shift the axis. |

**Rule of thumb [S, statistics]:** the 95% repeatability coefficient is `RC = 2.77 × SD_within`. QTcF: 2.77 × 9.5 ≈ 26 ms, which matches the ICH E14 ">30 ms" step. HR: 2.77 × 5.8 ≈ 16 bpm, close to Philips' 20 bpm. QRS: 2.77 × 2.8 ≈ 8 ms, same as KORA P97.5.

**Baseline [S]:** a baseline averaged over 2–3 ECGs is clearly more stable (ICH practice; Natekar 2011). The profile should let the user mark ≥ 1 ECG as baseline and use their mean.

## 3. Regulatory/clinical change thresholds that are published

- **ICH E14 (QT):** categorical QTc analysis at **> 450, > 480, > 500 ms** and **increase from baseline > 30 and > 60 ms**; > 500 ms or > 60 ms over baseline are common stop thresholds; regulatory concern starts at a mean effect around 5 ms (not usable for one person). Bazett overcorrects at high HR and undercorrects below 60 bpm; Fridericia is more accurate ([ICH E14 guideline](https://database.ich.org/sites/default/files/E14_Guideline.pdf)).
- **Trial ECG outlier criteria (common SAP practice):** HR **> 25% decrease to < 50 bpm** or **> 25% increase to > 100 bpm**; PR **> 25% increase to > 200 ms**; QRS **> 25% increase to > 120 ms** ([thorough-QT SAP, NCT03613649](https://cdn.clinicaltrials.gov/large-docs/49/NCT03613649/SAP_001.pdf)).
- **New ST/Q changes (4th Universal Definition of MI):** new ST elevation at J point in 2 contiguous leads ≥ 0.1 mV (V2–V3: ≥ 0.2 mV men ≥ 40 y, ≥ 0.25 mV men < 40 y, ≥ 0.15 mV women); new horizontal/downsloping ST depression ≥ 0.05 mV; T inversion > 0.1 mV with prominent R; pathological Q ≥ 30 ms and ≥ 0.1 mV in 2 contiguous leads (V2–V3: any Q > 20 ms) ([Thygesen 2018, PMID 30165617](https://pubmed.ncbi.nlm.nih.gov/30165617/); Q criteria as summarised in [PMC8051331](https://pmc.ncbi.nlm.nih.gov/articles/PMC8051331/table/t1-sha-33-01-009)). CardioAI's device does not export ST or Q measurements, so these apply only to the waveform module (section 5).
- **New right-axis shift** vs an old ECG: think of PE, sodium-channel blocker toxicity, or **lead misplacement** ([UMEM pearl](https://em.umaryland.edu/educational_pearls/1636/)). No source gives a degree threshold.
- **Lead reversal** is common and changes axis and limb-lead morphology; Glasgow detects arm-lead reversal with ~88% sensitivity at 100% specificity ([Cooper, Clark, Macfarlane, CinC 2008](https://www.cinc.org/old/Proceedings/2008/pdf/0089.pdf)).

## 4. Reference ranges (adult)

| Parameter | Range used | Source |
| --- | --- | --- |
| Heart rate | 50–100 bpm (Mason 2nd–98th pct: 48–98) | [Mason 2007, 79,743 subjects](https://pubmed.ncbi.nlm.nih.gov/17276451) [S] |
| PR | 120–200 ms (first-degree AV block > 200; Mason 113–212) | AHA Part III ([JACC 2009;53:976](https://doi.org/10.1016/j.jacc.2008.12.013)); Mason [S] |
| QRS | < 110 ms normal; 110–119 incomplete BBB / IVCD; ≥ 120 complete BBB (Mason 69–109) | AHA Part III; [MSD Manual](https://www.msdmanuals.com/professional/cardiovascular-disorders/arrhythmias-and-conduction-disorders/bundle-branch-block-and-fascicular-block) [S] |
| QTc (Bazett, device) | Prolonged ≥ 450 ms men / ≥ 460 ms women; ≥ 500 marked; short ≤ 390 ms (Mason QTcB 361–457) | AHA Part IV ([Circulation 2009;119:e241](https://doi.org/10.1161/CIRCULATIONAHA.108.191096)), as listed by [Stanford QTc tool](https://rogerslab.stanford.edu/ep-tools/qtc-calculator/) [S, secondary] |
| QTcF | Same 450/460 cut-offs in practice (Mason QTcF 359–445) | ICH E14, Mason [S] |
| QRS axis | −30° to +90° normal; < −30° LAD; −45° to −90° LAFB range; > +90° RAD; +90° to +180° with other criteria LPFB (Mason −40° to +91°) | AHA Part III; [Wikipedia RAD](https://www.wikipedia.org/wiki/Right_axis_deviation); Mason [S] |
| P axis | 0° to +75° | common textbook range [P] |
| T axis | 0° to +90°; frontal QRS–T angle > 100° abnormal | [P] (no primary source checked) |
| Sokolow-Lyon SV1 + max(RV5, RV6) | > 3.5 mV suggests LVH; often false-positive under ~35–40 y; low sensitivity | [LITFL](https://litfl.com/ecg-criteria-for-left-ventricular-hypertrophy/), AHA Part V [S] |
| RV5 | ≤ 2.6 mV (RV5/RV6 > 2.6 mV is an LVH voltage criterion) | [LITFL](https://litfl.com/ecg-criteria-for-left-ventricular-hypertrophy/) [S] |
| SV1 | ≤ 2.5 mV | [P] |

Age and sex matter a lot (QTc, axis, LVH indices) — see [Rijnbeek 2014 / normalecg.org](https://pure.eur.nl/en/publications/normal-values-of-the-electrocardiogram-for-ages-16-90-years/). If the profile stores sex and birth date, use sex-specific QTc limits.

**QTc formulas.** Bazett `QT/√RR` (RR in s), Fridericia `QT/∛RR`. Bazett over-corrects at high HR, so when HR differs between two ECGs, **compare QTcF, not the device QTc** ([ICH E14](https://database.ich.org/sites/default/files/E14_Guideline.pdf)). AHA prefers linear corrections; Framingham `QT + 154·(1 − RR)` is an option for a third column [S].

### Device-specific notes for ECG301/LE1203

- The reader decodes axes with `<3H` (unsigned). Negative axes may arrive as `360 + a` or `65536 + a`. Normalise to (−180°, +180°] before any comparison [P].
- Device QTc appears to be Bazett with mean RR (the reader already checks `QTc_from_mean_RR`). Compute **QTcF** ourselves from QT and mean RR [P].
- The record holds ~11 RR intervals: enough for a median beat (≥ 6–8 beats, Zywietz) but not for HR variability analysis.
- Both ECGs come from the same device algorithm, which is good (GE's "same methodology" point). If a future import uses another device or another sampling/scale, show a warning and widen thresholds [P].

## 5. Waveform-level comparison

Recommended pipeline [P unless marked]:

1. **Gate on quality.** Skip lead-level waveform comparison when HF noise ≥ 30 µV or baseline drift ≥ 300 µV/s in a lead [S: Perz 2008]; NeuroKit2 `ecg_quality` (template-matching, Zhao 2018) can score beats.
2. **Same grid.** Resample both records to one rate (e.g. 500 Hz; models use 250 Hz). Same filter for both (0.5–40 Hz display; 0.05–150 Hz if measuring ST).
3. **R-peaks** on a global lead (e.g. sum of absolute derivatives of all 12 leads, or lead II): `neurokit2.ecg_peaks`, `biosppy.signals.ecg.ecg` (returns R-peaks and beat templates), or `wfdb.processing.xqrs_detect`.
4. **Median (representative) beat per lead.** Window −250 … +450 ms around R (or HR-adaptive, as in NeuroKit2 `ecg_segment`). Drop beats whose correlation with the first-pass median is < 0.90 (ectopics/noise), then take the sample-wise median of ≥ 6 beats [S for 6–8 beats: Zywietz 2003]. GE 12SL and HES both measure on median/representative beats.
5. **Baseline.** Subtract the PR-segment (isoelectric) level of each median beat. Do **not** normalise amplitude; amplitude change is information.
6. **Alignment.** One time shift for all 12 leads (keeps inter-lead timing): maximise the summed cross-correlation of the QRS window (R ± 60 ms) within ±40 ms. Optional sub-sample refinement by parabolic interpolation.
7. **Metrics per lead and per segment** (QRS: onset→offset; ST-T: J→T end):
   - Pearson r (shape), RMS difference (µV), max |difference| (µV);
   - ST level at J+60 ms difference (µV), T peak amplitude difference (µV);
   - Q-wave duration/amplitude if delineated (`neurokit2.ecg_delineate`).
8. **Interpretation:** r ≥ 0.95 similar, 0.90–0.95 minor, < 0.90 changed [P; GE reports a > 25% cross-correlation change, US7076287]. Amplitude changes < 100 µV ignored [S: Perz]. ST change ≥ 100 µV and T change ≥ 200 µV **in ≥ 2 contiguous leads** = significant [S: Philips/Ariet 2005; UDMI]. A single-lead change is shown but never summarised as significant.
9. **Lead-reversal check:** if limb-lead correlations collapse while precordial leads match (r ≥ 0.95), or lead I is inverted vs prior, show "possible limb-lead reversal" instead of "axis change" [P, motivated by Cooper 2008].
10. **Display:** overlay prior (grey) and current (colour) median beats per lead, plus a thin difference trace (current − prior) on the same mV scale; 12-lead grid side-by-side for full strips.

Open-source tools (Python): [NeuroKit2](https://neuropsychology.github.io/NeuroKit/functions/ecg.html) (`ecg_clean`, `ecg_peaks`, `ecg_segment`, `ecg_delineate`, `ecg_quality`); [BioSPPy](https://biosppy.readthedocs.io/) (`signals.ecg.ecg` gives templates); [wfdb-python](https://wfdb.readthedocs.io/) (I/O, `xqrs_detect`); ecg-kit is MATLAB (not suitable here). SciPy `signal.correlate` is enough for alignment. Verify defaults against the installed version; secondary sources disagree on NeuroKit2 defaults.

## 6. AI-score comparison

What is known:
- **Repeatability of AI-ECG outputs is moderate.** In > 700,000 repeat-ECG pairs (median 1 day apart), CNN outputs had CCC 0.78–0.88 and binary agreement kappa 0.57–0.72; ensembles were more stable (CCC 0.89–0.92); inpatient pairs were less stable ([medRxiv 2025.11.04.25339526](https://www.medrxiv.org/content/10.1101/2025.11.04.25339526.full.pdf), not peer-reviewed). A conference report says about 1 in 6 binary calls of a foundation model changed within 2 weeks with no echo change (unverified secondary source).
- **AI-ECG age** short-term ICC 0.64, SEM 2.6 years ([medRxiv 2025.09.04.25335101](https://www.medrxiv.org/content/10.1101/2025.09.04.25335101.full.pdf)).
- **Trajectories carry information.** Serial ECG-age trajectories ("accelerated ageing") predict mortality, and multiple ECGs beat one ECG (C-index 0.763 vs 0.747, plateau at ~10 ECGs) ([Adelaide/Korean cohort summaries](https://digital.library.adelaide.edu.au/items/9e0993e6-68c3-4e3d-a6f2-8be25e51afa1)). A fall in AI-ECG low-EF score predicted LVEF recovery in HFrEF ([ESC 2025 abstract](https://esc365.escardio.org/journal/88784)). DeepECG-LVSD with **patient-wise recalibration** from prior AI-ECG outputs/prior LVEF kept AUROC 0.94 on follow-up pairs ([JMIR Med Inform 2026](https://medinform.jmir.org/2026/1/e83127/)). Sequential multi-ECG models exist ([Lukyanenko 2026](https://cavalab.org/assets/papers/Lukyanenko%20et%20al.%20-%202026%20-%20Estimation%20of%20Left%20Ventricular%20Systolic%20Function%20i.pdf)).
- **Dedicated delta models:** Sbrollini et al. fed 13 baseline-to-follow-up VCG **difference features** (ΔQRS duration, ΔQT, ΔT amplitude, |Δ| QRS-T angle, etc.) to a neural network to detect new heart failure and acute ischaemia ([BioMed Eng OnLine 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6371549/)). No validated Siamese/delta model for general 12-lead serial change was found.

How CardioAI should compare raw sigmoid scores responsibly [P]:
1. **Same model, same weights, same preprocessing** for both ECGs. Store model name + weight SHA + pipeline version with each score; refuse to compare across versions.
2. **Per-record uncertainty band.** CardioAI already runs DeepECG at 180/200/220 (min/max). Treat `[min, max]` as the record's band. A change counts only if the bands **do not overlap** and the main delta passes the size rules below.
3. **Large deltas only.** Significant if |Δp| ≥ 0.20 **and** |Δlogit| ≥ 1.0 (logit = ln(p/(1−p)), clip p to [0.001, 0.999]). Minor if |Δp| ≥ 0.10 and |Δlogit| ≥ 0.5. The logit rule stops 0.001 → 0.01 being called "10×" while still counting 0.02 → 0.25.
4. **Threshold crossing with hysteresis.** Without validated per-label thresholds, use 0.5 as a *research reference* only. A crossing counts only if old < t − 0.05 and new > t + 0.05 (or reverse).
5. **Rank view.** Show each record's top-10 labels; report labels that enter/leave the top-5 — robust to calibration drift.
6. **Agreement.** "Concordant" only if ≥ 2 models move in the same direction for the same label group (DeepECG SL + WCR share 77 labels; map ECGFounder's 150 labels to the same groups). Otherwise "model-only, discordant".
7. **Label groups** for the summary: rhythm, conduction, ischaemia/infarct (Q, ST, T inversion, Acute MI), hypertrophy/voltage, repolarisation/QT, atrial enlargement, pacing, technical (lead misplacement, no_qrs). Summarise per group (max |Δ| label), not 377 rows.
8. **Cross-check with measurements.** E.g. "Prolonged QT" score ↑ with QTcF ↑ ≥ 30 ms → "consistent"; score ↑ with QTcF unchanged → "model-only". "Left axis deviation" ↑ should match QRS axis moving below −30°. "1st degree AV block" ↑ should match PR > 200 ms.
9. **Wording:** "research score change", never "risk increased" or "probability". No percentage symbols on scores.

## 7. UX for comparison and the patient profile

Patterns seen in MUSE/TraceMasterVue/HES and patents ([HES overlay of superimposed beats, CinC 2003](https://www.cinc.org/old/Proceedings/2003/pdf/689.pdf); [GE serial visualisation patent US9591977](https://patents.google.com/patent/US9591977B2/en); [wearable-defibrillator comparator patent](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12447352)), plus practical choices:

1. **Summary first.** One banner: "No significant change since 12 Apr 2026" or a list of ≤ 5 significant changes in plain words ("QTcF +42 ms (412 → 454), now above 450"). Use Philips-style modifiers: *now present*, *no longer present*, *remains*, *more/less prominent*.
2. **Context line:** dates, interval between ECGs, HR of each, device/firmware, quality flags, "baseline = mean of N ECGs".
3. **Delta table:** parameter | previous | current | Δ (signed, unit) | arrow ↑/↓ | level badge (noise / small / notable / major) | normal range, with out-of-range values marked. Colour only for notable (amber) and major (red); noise is grey. Add a text label, not colour alone.
4. **Waveforms:** tabs *Side by side* (full 12-lead strips, same scale and paper speed) and *Overlay* (median beats per lead, prior grey, current colour, difference trace, per-lead r and RMS).
5. **AI panel:** per label group, previous vs current score as two dots on a 0–1 line with uncertainty bars; badges "concordant / model-only"; top-5 rank changes.
6. **Profile timeline:** one small chart per parameter (HR, PR, QRS, QTc, QTcF, axes, RV5, SV1, Sokolow) with the normal band shaded, threshold lines (e.g. QTc 450/480/500), baseline line, and points coloured by change level vs previous. Same x-axis (real dates) for all charts. For ≥ 3 ECGs show a robust slope (Theil–Sen) and flag a "sustained trend" when ≥ 3 consecutive steps go the same way and the total exceeds `minor` [P].
7. **Two comparisons always:** new vs previous (acute change) and new vs baseline (slow drift). Show both columns in the delta table.
8. **Carry forward:** if nothing passes the thresholds, keep the previous summary and say "unchanged".

---

## Implementable rules

Semantics for each measurement (`d = current − reference`):
- `|d| < noise` → **unchanged** (within measurement noise).
- `noise ≤ |d| < minor` → **small** (show value, grey, no summary line).
- `minor ≤ |d| < major` → **notable** (amber, summary line).
- `|d| ≥ major` → **major** (red, summary line).
- `crossings` escalate the level to at least the stated level when the value moves from inside to outside a limit (or back: "no longer").
- `relative_pct`, when given, must also be met (both absolute and relative) for notable/major.
- `sourced` lists which fields come from a cited source; every other number is a practical choice.
- Reference = previous ECG and, separately, the baseline (mean of baseline ECGs).

```json
{
  "version": "2026-10-29",
  "semantics": {
    "levels": ["unchanged", "small", "notable", "major"],
    "delta": "current - reference",
    "reference_kinds": ["previous", "baseline"],
    "baseline": "mean of user-marked baseline ECGs (recommend 2-3); else first ECG",
    "min_interval_minutes": 30,
    "min_interval_source": "Philips TraceMasterVue default (Ariet 2005), configurable",
    "summary_levels": ["notable", "major"],
    "practical_choice_marker": "any number not listed in 'sourced' is a practical choice without a source"
  },
  "measurements": [
    {
      "key": "heart_rate_bpm", "label": "Heart rate", "unit": "bpm",
      "normal": [50, 100], "noise": 5, "minor": 10, "major": 20,
      "relative_pct": null,
      "crossings": [
        {"below": 50, "level": "notable", "text": "bradycardia (<50)"},
        {"above": 100, "level": "notable", "text": "tachycardia (>100)"},
        {"rule": "decrease >25% AND new value <50", "level": "major"},
        {"rule": "increase >25% AND new value >100", "level": "major"}
      ],
      "sourced": ["normal (Mason 2007: 48-98)", "major=20 (Philips: HR change >=20 bpm = significant rhythm change)", "25% outlier rules (TQT SAP NCT03613649)", "noise ~ within-subject SD 5.8 bpm (Zywietz 2003)"],
      "note": "HR is labile; HR change alone is low value unless it crosses 50/100 or the rhythm changes. A rhythm-mechanism change (e.g. sinus -> AF from model/device statement) is always major."
    },
    {
      "key": "PR_ms", "label": "PR interval", "unit": "ms",
      "normal": [120, 200], "noise": 10, "minor": 20, "major": 40,
      "relative_pct": null,
      "crossings": [
        {"above": 200, "level": "notable", "text": "PR >200 ms (first-degree AV block range)"},
        {"rule": "increase >25% AND new value >200", "level": "major"},
        {"below": 120, "level": "notable", "text": "short PR (<120 ms)"}
      ],
      "sourced": ["normal (AHA Part III; Mason 113-212)", "25% rule (TQT SAP)", "algorithm spread 4-6 ms (Bologna 2020)"],
      "note": "Not compared when either ECG is AF/flutter or paced (PR undefined)."
    },
    {
      "key": "QRS_ms", "label": "QRS duration", "unit": "ms",
      "normal": [70, 110], "noise": 8, "minor": 16, "major": 25,
      "relative_pct": null,
      "crossings": [
        {"above": 110, "level": "notable", "text": "QRS 110-119 ms (incomplete BBB / IVCD range)"},
        {"above": 120, "level": "major", "text": "QRS >=120 ms (new complete BBB range)"},
        {"rule": "increase >25% AND new value >120", "level": "major"}
      ],
      "sourced": ["normal/110/120 (AHA Part III)", "noise=8 (KORA P97.5; 2.77 x SD 2.8 ms Zywietz)", "minor=16 (KORA P99, Perz 2008)", "25% rule (TQT SAP)", "QRS crossing 120 ms = high severity (GE US6564090)"],
      "note": "major=25 is practical. A new bundle branch block statement from models must be backed by QRS >=120 to be called 'new BBB'."
    },
    {
      "key": "QT_ms", "label": "QT (uncorrected)", "unit": "ms",
      "normal": [325, 452], "noise": 15, "minor": 40, "major": 60,
      "relative_pct": null,
      "crossings": [],
      "sourced": ["normal (Mason 2007 2nd-98th pct)", "noise ~ SD 13.6 ms (Zywietz 2003)"],
      "note": "Shown for completeness only; never summarised on its own because QT depends on HR. Use QTc/QTcF for decisions."
    },
    {
      "key": "QTc_ms", "label": "QTc (device, Bazett)", "unit": "ms",
      "normal": [360, 450], "noise": 15, "minor": 30, "major": 60,
      "relative_pct": null,
      "sex_specific_upper": {"male": 450, "female": 460},
      "crossings": [
        {"above": 450, "level": "notable", "text": "QTc >450 (use 460 for women)"},
        {"above": 480, "level": "major", "text": "QTc >480"},
        {"above": 500, "level": "major", "text": "QTc >500 (marked prolongation)"},
        {"below": 390, "level": "notable", "text": "short QTc (<=390)"}
      ],
      "sourced": ["minor=30, major=60, crossings 450/480/500 (ICH E14)", "450/460/390 (AHA Part IV via Stanford QTc tool)", "Mason QTcB 361-457"],
      "note": "Bazett is biased when HR differs. If |dHR| >= 10 bpm, downgrade QTc findings to 'small' and rely on QTcF. noise=15 is practical (Bazett is more variable than QTcF)."
    },
    {
      "key": "QTcF_ms", "label": "QTc Fridericia", "unit": "ms",
      "normal": [350, 450], "noise": 10, "minor": 30, "major": 60,
      "relative_pct": null,
      "formula": "QT_ms / (RR_mean_s ** (1/3))",
      "sex_specific_upper": {"male": 450, "female": 460},
      "crossings": [
        {"above": 450, "level": "notable", "text": "QTcF >450 (use 460 for women)"},
        {"above": 480, "level": "major", "text": "QTcF >480"},
        {"above": 500, "level": "major", "text": "QTcF >500"}
      ],
      "sourced": ["minor=30, major=60, 450/480/500 (ICH E14)", "noise=10 ~ within-subject SD 9.5 ms single ECG (Natekar 2011); RC 2.77x9.5=26 ms", "Mason QTcF 359-445"],
      "note": "Preferred QT metric for comparison. Computed by CardioAI from device QT and mean RR. QT in BBB/paced rhythm is prolonged by QRS; flag but do not summarise when QRS >=120 in either ECG."
    },
    {
      "key": "P_axis", "label": "P axis", "unit": "deg",
      "normal": [0, 75], "noise": 20, "minor": 45, "major": 90,
      "circular": true, "relative_pct": null,
      "crossings": [
        {"rule": "P axis moves outside 0..+90 (e.g. negative in II direction)", "level": "notable", "text": "possible ectopic atrial rhythm or limb-lead reversal"}
      ],
      "sourced": [],
      "note": "All numbers practical. P axis is noisy with small P waves; ignore when either ECG is AF/flutter/paced."
    },
    {
      "key": "QRS_axis", "label": "QRS axis", "unit": "deg",
      "normal": [-30, 90], "noise": 15, "minor": 30, "major": 60,
      "circular": true, "relative_pct": null,
      "crossings": [
        {"below": -30, "level": "notable", "text": "left axis deviation (< -30)"},
        {"below": -45, "level": "notable", "text": "LAFB range (-45..-90)"},
        {"above": 90, "level": "notable", "text": "right axis deviation (> +90); new RAD: consider PE, drugs, lead misplacement"}
      ],
      "sourced": ["normal/-30/-45/+90 (AHA Part III; Mason -40..+91)", "new RAD differential (UMEM pearl)"],
      "note": "Degree thresholds are practical; no test-retest source found. Use the wrapped difference ((b - a + 180) mod 360) - 180. Before calling a change, run the lead-reversal check."
    },
    {
      "key": "T_axis", "label": "T axis", "unit": "deg",
      "normal": [0, 90], "noise": 20, "minor": 45, "major": 90,
      "circular": true, "relative_pct": null,
      "derived": {"key": "QRS_T_angle_deg", "formula": "abs(wrapped(T_axis - QRS_axis))", "notable_above": 100},
      "crossings": [],
      "sourced": [],
      "note": "All numbers practical. A T-axis swing with stable QRS axis suggests a repolarisation change; check ST-T in the waveform module."
    },
    {
      "key": "RV5_mV", "label": "R in V5", "unit": "mV",
      "normal": [0.5, 2.6], "noise": 0.4, "minor": 0.8, "major": 1.2,
      "relative_pct": 25,
      "crossings": [{"above": 2.6, "level": "notable", "text": "RV5 >2.6 mV (LVH voltage criterion)"}],
      "sourced": ["2.6 mV (LITFL LVH criteria)", "single-lead amplitude variability is large (Angeli 2006; Zywietz CV 6-13%)"],
      "note": "Electrode position dominates. Never summarise a voltage change alone as 'new LVH'. Lower normal limit is practical."
    },
    {
      "key": "SV1_mV", "label": "S in V1", "unit": "mV",
      "normal": [0.3, 2.5], "noise": 0.4, "minor": 0.8, "major": 1.2,
      "relative_pct": 25,
      "crossings": [],
      "sourced": [],
      "note": "Practical numbers. Store as a positive magnitude; check the sign convention of the device float."
    },
    {
      "key": "sokolow_mV", "label": "Sokolow-Lyon (SV1+RV5)", "unit": "mV",
      "normal": [0, 3.5], "noise": 0.5, "minor": 1.0, "major": 1.5,
      "relative_pct": 25,
      "formula": "abs(SV1_mV) + RV5_mV",
      "crossings": [{"above": 3.5, "level": "notable", "text": "Sokolow-Lyon >3.5 mV (LVH voltage; low sensitivity, false positives in young people)"}],
      "sourced": ["3.5 mV (Sokolow-Lyon; AHA Part V)", "CV ~10% over 1 week (pubid 2137478), 18.5% over ~8 days; LVH status flips in 11-19% day-to-day (Angeli 2006)"],
      "note": "Device gives RV5 only, not max(RV5,RV6). noise/minor/major are practical (about 1x and 2-3x of SD at 3.5 mV)."
    }
  ],
  "axis": {
    "normalise": "convert unsigned device values: if a > 32767 then a - 65536; then wrap to (-180, 180]",
    "difference": "((b - a + 180) mod 360) - 180",
    "indeterminate": "if QRS is nearly equiphasic in all limb leads (net amplitude < 0.1 mV) mark axis as indeterminate and skip axis rules",
    "categories": [
      {"name": "normal", "range": [-30, 90]},
      {"name": "left_axis_deviation", "range": [-90, -30]},
      {"name": "right_axis_deviation", "range": [90, 180]},
      {"name": "extreme_axis", "range": [-180, -90]}
    ],
    "category_change_level": "notable",
    "lead_reversal_check": {
      "trigger": "QRS_axis change >= 60 deg OR lead I polarity inverted vs reference",
      "rule": "if mean limb-lead median-beat r < 0.7 while mean precordial r >= 0.95, report 'possible limb-lead reversal' instead of an axis change",
      "source": "practical; motivated by Cooper, Clark, Macfarlane CinC 2008"
    },
    "sourced": ["category limits (AHA Part III; Mason 2007)"]
  },
  "scores": {
    "preconditions": [
      "same model name and weight SHA256 for both records",
      "same preprocessing pipeline version and input rate",
      "both records eligible (quality gate passed)"
    ],
    "transform": "logit(p) = ln(p/(1-p)) with p clipped to [0.001, 0.999]",
    "uncertainty_band": "per record [min,max] over the DeepECG 180/200/220 runs; if bands overlap, level is at most 'small'",
    "levels": {
      "small":   {"abs_delta_p": 0.05, "abs_delta_logit": 0.3},
      "notable": {"abs_delta_p": 0.10, "abs_delta_logit": 0.5},
      "major":   {"abs_delta_p": 0.20, "abs_delta_logit": 1.0}
    },
    "threshold_crossing": {
      "reference_threshold": 0.5,
      "hysteresis": 0.05,
      "rule": "count only if old < t-h and new > t+h (or the reverse); 0.5 is a research reference, not a validated cut-off"
    },
    "rank": {"top_k_display": 10, "report_enter_leave_top": 5},
    "concordance": {
      "rule": "'concordant' if >= 2 of the 3 models change in the same direction for the same label group with level >= notable; else 'model-only'",
      "summary_requires": "concordant"
    },
    "label_groups": {
      "rhythm": ["Sinusal", "Regular", "Afib", "Atrial flutter", "Irregularly irregular", "Regularly irregular", "Atrial tachycardia (>= 100 BPM)", "Supraventricular tachycardia", "Junctional rhythm", "Ectopic atrial rhythm (< 100 BPM)", "Ventricular tachycardia", "Ventricular Rhythm", "Bradycardia", "Premature ventricular complex", "Premature atrial complex"],
      "conduction": ["Left bundle branch block", "Right bundle branch block", "Nonspecific intraventricular conduction delay", "1st degree AV block", "2nd degree AV block - mobitz 1", "2nd degree AV block - mobitz 2", "Third Degree AV Block", "Left anterior fascicular block", "Left posterior fascicular block", "rSR' in V1-V2", "Delta wave", "Wolff-Parkinson-White (Pre-excitation syndrome)"],
      "axis": ["Left axis deviation", "Right axis deviation", "Right superior axis", "QRS complex negative in III"],
      "ischaemia_infarct": ["Acute MI", "Q wave (inferior - II, III, aVF)", "Q wave (lateral- I, aVL, V5-V6)", "Q wave (septal- V1-V2)", "Q wave (anterior - V3-V4)", "Q wave (posterior - V7-V9)", "QS complex in V1-V2-V3", "ST elevation (anterior - V3-V4)", "ST elevation (septal - V1-V2)", "ST elevation (inferior - II, III, aVF)", "ST elevation (lateral - I, aVL, V5-V6)", "ST elevation (posterior - V7-V8-V9)", "ST depression (inferior - II, III, aVF)", "ST depression (anterior - V3-V4)", "ST depression (lateral - I, avL, V5-V6)", "ST depression (septal- V1-V2)", "ST downslopping", "ST upslopping", "T wave inversion (inferior - II, III, aVF)", "T wave inversion (lateral -I, aVL, V5-V6)", "T wave inversion (anterior - V3-V4)", "T wave inversion (septal- V1-V2)", "Acute pericarditis", "Early repolarization", "Brugada"],
      "hypertrophy_voltage": ["Left ventricular hypertrophy", "Right ventricular hypertrophy", "SV1 + RV5 or RV6 > 35 mm", "RaVL > 11 mm", "RV1 + SV6 > 11 mm", "R/S ratio in V1-V2 >1", "R complex in V5-V6", "qRS in V5-V6-I, aVL", "Low voltage"],
      "atrial": ["Left atrial enlargement", "Right atrial enlargement", "Bi-atrial enlargement"],
      "repolarisation_qt": ["Prolonged QT", "U wave"],
      "pacing": ["Ventricular paced", "Atrial paced", "LV pacing"],
      "technical": ["Lead misplacement", "no_qrs", "Monomorph", "Polymorph"]
    },
    "ecgfounder_mapping": "map each of the 150 ECGFounder labels to one of the groups above by name; unmapped labels go to 'other' and are never summarised",
    "measurement_cross_checks": [
      {"label": "Prolonged QT", "measurement": "QTcF_ms", "consistent_if": "same direction and |dQTcF| >= 30"},
      {"label": "1st degree AV block", "measurement": "PR_ms", "consistent_if": "new PR > 200"},
      {"label": "Left bundle branch block", "measurement": "QRS_ms", "consistent_if": "new QRS >= 120"},
      {"label": "Right bundle branch block", "measurement": "QRS_ms", "consistent_if": "new QRS >= 120"},
      {"label": "Left axis deviation", "measurement": "QRS_axis", "consistent_if": "new axis < -30"},
      {"label": "Right axis deviation", "measurement": "QRS_axis", "consistent_if": "new axis > 90"},
      {"label": "SV1 + RV5 or RV6 > 35 mm", "measurement": "sokolow_mV", "consistent_if": "new value > 3.5"},
      {"label": "Bradycardia", "measurement": "heart_rate_bpm", "consistent_if": "new HR < 60"}
    ],
    "wording": "research score change; never 'probability' or 'risk'",
    "sourced": [
      "AI-ECG test-retest CCC 0.78-0.92, kappa 0.57-0.82 (medRxiv 2025.11.04.25339526) motivates large-delta-only rules",
      "serial AI-ECG trajectories are informative (ECG-age trajectory studies; ESC 2025 low-EF delta abstract; JMIR 2026 DeepECG LVSD recalibration)"
    ],
    "note": "All numeric score thresholds are practical choices; no source defines them for these models."
  },
  "waveform": {
    "quality_gate": {"hf_noise_uV_max": 30, "baseline_sway_uV_per_s_max": 300, "source": "Perz 2008 (KORA/HES)"},
    "resample_hz": 500,
    "filter_display_hz": [0.5, 40],
    "r_peak_lead": "global (sum of |derivative| over 12 leads) or lead II",
    "median_beat": {"window_ms": [-250, 450], "min_beats": 6, "exclude_if_r_below": 0.90, "statistic": "median", "source": "min_beats 6-8 (Zywietz 2003); rest practical"},
    "baseline_correction": "subtract PR-segment median level per lead; no amplitude normalisation",
    "alignment": {"method": "single shift for all leads maximising summed QRS cross-correlation", "qrs_window_ms": [-60, 60], "max_shift_ms": 40},
    "segments": {"qrs": "onset..offset (delineated) or R-60..R+60 ms", "st_t": "J..T end or R+60..R+400 ms", "st_point": "J+60 ms"},
    "metrics": ["pearson_r", "rms_diff_uV", "max_abs_diff_uV", "st_j60_diff_uV", "t_peak_diff_uV"],
    "shape_levels": {"similar_r_min": 0.95, "minor_r_min": 0.90, "changed_r_below": 0.90, "source": "practical; GE reports QRS waveform change when cross-correlation change > 25% (US7076287)"},
    "amplitude_ignore_below_uV": 100,
    "amplitude_ignore_source": "Perz 2008",
    "st_change_uV": {"notable": 70, "major": 100, "precordial_elevation_major": 200, "source": "major 100 uV (Philips/Ariet 2005; UDMI 0.1 mV); 70 uV moderate and 200 uV precordial (GE US6564090)"},
    "t_change_uV": {"major": 200, "source": "Philips/Ariet 2005; GE US6564090 T inversion >200 uV"},
    "q_wave": {"new_duration_ms_notable": 30, "new_duration_ms_major": 40, "delta_duration_ms": 20, "delta_amp_uV": 100, "source": "UDMI 2018 (>=30 ms, >=0.1 mV); GE US6564090 (40/60 ms); Philips (20 ms, 100 uV)"},
    "contiguous_leads_required": 2,
    "contiguous_groups": {
      "inferior": ["II", "III", "aVF"],
      "lateral": ["I", "aVL", "V5", "V6"],
      "septal": ["V1", "V2"],
      "anterior": ["V3", "V4"]
    },
    "summary_rule": "a waveform finding is summarised only if it meets its threshold in >= 2 leads of one contiguous group",
    "display": ["side_by_side_12_lead", "overlay_median_beats_prior_grey_current_colour", "difference_trace", "per_lead_r_and_rms"]
  },
  "trend": {
    "min_points_for_slope": 3,
    "slope_method": "Theil-Sen per year",
    "sustained_trend_rule": ">= 3 consecutive changes in the same direction and total change vs baseline >= minor",
    "chart": "normal band shaded, threshold lines (e.g. QTc 450/480/500), baseline line, points coloured by level vs previous, shared real-date x-axis",
    "source": "practical"
  }
}
```

### Open points to verify before relying on them

- AHA Part IV QTc limits (450/460/390) were checked only through a secondary source; the primary text was not accessible (HTTP 403).
- GE 12SL and Philips DXL physician guides were not accessible; their exact serial thresholds remain unknown beyond what is cited above.
- Axis, P/T-axis, voltage and all AI-score thresholds are practical choices. They should be tuned on repeat recordings of stable people made with the same ECG301 device (record 2–3 ECGs 5 minutes apart and compute the within-person SD for each parameter; set `noise ≈ 1 SD`, `minor ≈ 2.77 SD`).
