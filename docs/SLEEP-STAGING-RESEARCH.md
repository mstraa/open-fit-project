# Sleep-Staging Algorithm Research

> Research into which sleep-stage classification algorithm OpenFit should adopt to
> replace the current unvalidated HR-rank proportional heuristic.
>
> **Date:** 2026-06-04 · **Method:** multi-agent fact-checked web sweep (53 agents,
> every headline accuracy figure verified against the primary source).
> **Scope:** non-EEG (cardiac / motion) sleep staging suitable for a consumer wearable.

---

## 1. TL;DR — the one fact that decides everything

**Almost every algorithm with strong 4-class accuracy needs _beat-to-beat_ intervals
(RR / IBI), not the per-minute averaged HR OpenFit reliably has today.** That resolution
gap is the whole story:

| Signal we feed the model | Realistic accuracy ceiling |
|---|---|
| **Per-minute averaged HR** (what we have) | Good 2-class sleep/wake (κ ≈ 0.30–0.45); weak 3-class wake/NREM/REM (κ ≈ 0.20–0.35). **No published method does reliable 4-class light/deep from this.** |
| **Beat-to-beat RR / IBI** (would need to capture) | Real 4-class staging, κ ≈ 0.55–0.66. |

Consequences:

1. Our current HR-rank heuristic is **already near the per-minute-HR ceiling**. The honest
   near-term win is making it _validated and probabilistic_, not materially more accurate.
2. **REM-vs-light and deep (N3) are intrinsically hard from cardiac signals.** Deep is the
   single worst class for _every_ cardiac method (recall ~0.48–0.52 even with beat-to-beat
   data + respiration), because the discriminating autonomic information lives in
   high-frequency HRV (RSA, RMSSD, LF/HF) that per-minute HR cannot represent.
3. The pivotal open question — **does the Helio ring expose an RR-interval or raw-PPG
   characteristic over BLE?** — determines the entire roadmap. It's worth a ~30-minute BLE
   GATT investigation _before_ committing engineering effort to any algorithm.

---

## 2. The candidate landscape (all numbers verified vs primary source)

| Method | Signals | Classes | Accuracy vs PSG | Code / Data | Fits per-min HR? |
|---|---|---|---|---|---|
| **Walch 2019** | HR(bpm) + motion + clock | 2 & 3 | 2-cls acc 0.80, κ 0.32–0.46¹; AUC 0.878; 3-cls acc 0.72, κ 0.28 | ✅ **MIT** code + **ODC-BY** data | ⚠️ Closest fit, HR feature wants <30 s HR |
| **Sridhar 2020** | 2 Hz instantaneous HR | **4** | SHHS 77 % / κ **0.66**; CinC 72 % / κ 0.55; deep recall ~0.48 | ❌ no code/weights | ❌ Needs beat-to-beat IBI |
| **Radha / Fonseca 2019** | 132 HRV features from RR → BiLSTM | **4** | κ **0.61** (ECG); **0.63 on wrist-PPG** via transfer | ❌ no code | ❌ Needs RR (RMSSD/LF-HF undefined at 1/min) |
| **CReSS / Bakker 2021** | IHR + respiration | **4** | κ **0.643** (0.68 w/ thoracic effort) | ❌ proprietary (Philips) | ❌ Needs RR + respiration |
| **Topalidis 2023** | 2 Hz IBI (consumer chest-strap / PPG) | **4** | κ **0.69** (Polar H10 & Verity Sense) | ❌ proprietary | ❌ Needs RR; proves consumer RR works |
| **Beattie 2017** | PPG RR + 3-D accel | **4** | acc 69 %, κ **0.52** | ❌ proprietary | ❌ Needs RR + motion |
| **SLAMSS / Song 2023** | activity counts + HR-mean + HR-SD | 3 & 4 | 3-cls MCC 0.66; 4-cls MCC 0.58 | ⚠️ successor *SLAMSS-IFS* BSD-3 | ⚠️ HR-SD needs <30 s HR |
| **Sundararajan 2021** | raw accelerometer only | 2 (+weak multi) | sleep/wake κ 0.50; **REM F1 only 12 %** | ✅ **Apache-2.0** + weights (Zenodo) | ❌ Needs raw accel; staging fails w/o HR |

¹ See §3 fact-check corrections below.

---

## 3. Fact-check corrections (what the verifiers caught)

The adversarial verification pass corrected several widely-repeated misstatements:

- **Walch sleep/wake κ.** The paper reports κ = **0.455** at the 90 %-sensitivity operating
  point and ~0.322 at the balanced point — different operating points of the _same_ model.
  MESA external validation gives κ = 0.525. The famous **"90 % accuracy"** is a
  sensitivity-tuned point (sleep sensitivity 0.93, **wake specificity only 0.60**), **not**
  balanced accuracy (0.80, spec 0.816). Do **not** quote 90 % as overall accuracy.
- **Walch is 2-class and 3-class only — never 4-class.** Its source enum is literally
  `SleepWakeLabel(wake=0, sleep=1)` and `ThreeClassLabel(wake=0, nrem=1, rem=2)`. Secondary
  citing papers (e.g. PMC8521802) mislabel its 3-class κ≈0.30 result as "4-class" — it isn't.
- **"HR-only" almost always means _instantaneous_ HR.** In Sridhar, Radha, CReSS, Topalidis
  and Beattie, "heart rate" means a beat-to-beat-derived IHR/RR series resampled to 2–10 Hz —
  **never** the per-minute averages OpenFit has. Quoting their 4-class κ as achievable from
  per-minute HR would be wrong.
- **Sridhar / Radha / CReSS / Topalidis report _only_ 4-class metrics.** Any 2- or 3-class
  number attributed to those papers is fabricated/unverifiable.
- **Sundararajan's non-wear was real protocol data, not synthetic** (minor, but corrected).
- **SLAMSS uses MCC, not Cohen's κ**, deliberately ("κ unsuitable for imbalanced multi-class").
  Its HR-SD feature needs sub-30 s HR; only HR-mean is per-minute-friendly. The original 2023
  model has no code; a _different_ successor (SLAMSS-IFS, BSD-3, ~Aug 2025) does.

---

## 4. Why 4-class is intrinsically hard from cardiac signals

- **Deep (N3) is the worst class for every cardiac method** — recall 0.48–0.52 even with
  beat-to-beat RR + a respiration channel (CReSS). This is not an implementation flaw; it's
  the limit of the signal. Sridhar: "Deep sleep is underestimated by our model in favor of
  light sleep… underestimates deep sleep in women."
- **REM vs light** depends on high-frequency HRV (RSA, RMSSD, LF/HF). Per-minute HR throws
  this away entirely; even windowed-variance of per-minute HR is only a weak RMSSD surrogate.
- **Motion helps WAKE, not depth.** In Walch, motion-alone AUC (0.815) beats HR-alone (0.737)
  for sleep/wake, but motion contributes almost nothing to NREM-depth separation.
- **Respiration adds little once you have good RR** (CReSS: HR-only sibling Radha loses only
  ~0.03 κ vs HR + airflow). It is a slow, weak signal on its own.

---

## 5. OpenFit codebase reality (verified during research)

- **Per-minute data we already store:** HR for all nights; for **Zepp-imported nights**,
  per-minute respiration **and** per-minute vendor stage labels
  (`crates/ofit-ingest/src/zepp.rs` `parse_sleep_minute()` emits `SleepStage` + `HeartRate`
  + `Respiration` from the `SLEEP_MINUTE` CSV).
- **Garmin nights are weak labels.** `crates/ofit-ingest/src/garmin.rs` gives per-minute
  auto-HR but only **synthesized** per-minute stages (back-filled to match daily durations)
  and daily-only respiration/SpO2/RHR. **Exclude Garmin from per-minute training**; use only
  as duration-level sanity checks.
- **Data model is ready.** `crates/ofit-core/src/wellness.rs` `WellnessKind` already has
  `Respiration`, `SpO2`, `Steps`, `Hrv`, `RestingHeartRate` variants — no schema work to add
  features.
- **Nothing captures IBI / RR / raw-PPG / accelerometer today** (confirmed by grep). Adding
  RR or motion is a firmware/BLE question, not a data-model question.
- **Current staging:** `crates/ofit-analytics/src/hr_sleep.rs` (HR-rank proportional heuristic
  + a `calibrate()` that already learns per-person stage fractions from labelled nights) and
  the summary in `crates/ofit-analytics/src/algorithms/sleep.rs`.
- **No ML runtime present** (`ort`/`tract`/`linfa`/`candle` all absent). The analytics stack
  is pure-Rust with a plugin / `code_version` / param-set system where "every constant is a
  setting" — so a hand-rolled logistic regression or small tree fits the existing idiom far
  better than an ONNX runtime would. (Cross-ref: `docs/ADDING-A-PLUGIN.md`, and the
  computed-values plugin overhaul.)

---

## 6. Recommendation (ranked, tailored to OpenFit)

### ① Near-term — do now (low risk, ~1–2 weeks)

**Walch-style features → small interpretable classifier**, replacing the unvalidated
HR-rank proportional split.

- **Features:**
  - HR variability band-pass: interpolate HR to a regular grid, convolve with a
    **difference-of-Gaussians filter (σ₁ = 120 s, σ₂ = 600 s, scalar 0.75)**, normalize by
    the 90th percentile of |signal|, take the **std over a ±285 s window** per epoch. (A few
    hundred lines of DSP — `hr_sleep.rs` already has `smooth()` and block detection.)
  - **Time-of-night circadian cosine proxy** — Walch's single biggest accuracy booster
    (+14 % wake specificity); needs **only clock time + the already-detected sleep window**,
    zero new sensors.
  - **Per-minute respiration** as an extra feature on Zepp nights (free — already ingested).
- **Classifier:** logistic regression (literally a dot product in Rust — no ONNX) or a
  shallow random forest. Fit **offline** on PhysioNet sleep-accel, **calibrate on our own
  Zepp nights**, emit softmax probability as the requested confidence.
- **Output:** confident 2-class + 3-class; keep deep/light as a **low-confidence heuristic
  flag**. Wire as a new plugin `code_version` so it coexists with the current heuristic.
- **Honest framing:** this makes the current ceiling _measured and probabilistic_ — it does
  not raise it. We'd be swapping an unvalidated assumption for a published-feature model and a
  real κ against our own data.
- **Port from:** `github.com/ojwalch/sleep_classifiers` (MIT) —
  `heart_rate_feature_service.py` (DoG filter) and `circadian_service.py` (cosine proxy);
  reuse `classifier_service.py` logic offline to fit coefficients. **No pretrained model ships
  in the repo — we must retrain** (minutes on 31 subjects).

### ② The unlock — investigate FIRST, then build if viable

**Does the Helio ring expose RR/IBI or raw PPG over BLE?** This yes/no answer decides whether
the ceiling is κ ≈ 0.3 or κ ≈ 0.6.

If **yes** → implement the **Sridhar 2020 instantaneous-HR CNN** (best-specified, fully
reimplementable, ONNX-exportable via `tract`/`ort`):
- Architecture: 3 conv blocks → 128-dim embedding + 5 dilated conv layers (kernels 7,
  dilations 2/4/8/16/32). Input: 2 Hz IHR (reciprocal of IBIs), padded to 72 000 samples
  (10 h), per-night z-normalized.
- Train on **SHHS + MESA** (NSRR), test on the fully-public **CinC-2018**, fine-tune on Zepp.
- Expected: genuine 4-class κ ≈ 0.55–0.66 (deep still weakest, ~0.48 recall).
- Radha's wrist-PPG transfer result (κ 0.63) is direct evidence a ring's PPG-derived RR can
  carry this.
- Cost: a multi-week ML project + an ONNX runtime dependency in the otherwise-pure-Rust stack
  + RR ingestion plumbing through the BLE layer + a new `WellnessKind::Rr`.

### ③ Defer — ring accelerometer capture

Motion is the strongest **wake** discriminator (tightens sleep/wake and the wake boundary)
but does almost nothing for deep/light. If we're going to do BLE/firmware work anyway, **RR
(②) has far higher payoff than motion.** (Note: commit `dd554ec` recently
_dropped_ raw IMU capture for activities in favour of an on-device step detector, so the
cost/complexity of raw motion capture is known here.)

### ④ Fallback — formalize the HR-only model (if neither RR nor motion is possible)

Keep pure-Rust HR-only, but replace the proportional split with a fitted LR / decision-stump
on simple features (rolling HR mean, windowed variance as a coarse HRV proxy, slope,
time-since-onset, HR-percentile-within-night), calibrated on Zepp nights, reporting 2-class
confidently and 3/4-class as low-confidence. Days, not weeks. Raises nothing — just makes the
current ceiling validated, probabilistic, and honest.

---

## 7. Datasets for training / calibration

| Rank | Dataset | Access | Contents | Use |
|---|---|---|---|---|
| 1 | **PhysioNet sleep-accel v1.0.0** (Walch) | **ODC-BY**, no DUA | 31 subj; HR(bpm/few-sec) + motion + steps; labels with **full N1/N2/N3/REM** | Immediate training/sanity-check for ①/③. Down-sample HR to per-minute to match our ring. Caveat: young/healthy (mean age 29). |
| 2 | **Our own Zepp per-minute nights** | local | per-minute (stage, HR, respiration) at our exact resolution + hardware | The **real calibration + validation target**. Caveat: vendor-estimated labels, not PSG → semi-supervised, validate-against not gold-train-on. |
| 3 | **CinC-2018** | PhysioNet, public | 993 nights, PSG + ECG (RR-derivable), AASM | For the ② RR path; Sridhar's independent test set, easiest gold RR+PSG without a DUA. |
| 4 | **SHHS + MESA** (NSRR) | free, credentialed DUA (sleepdata.org) | >10 000 PSG+ECG nights | Training data for the ② CNN. Also: down-sample their ECG-HR to per-minute to **quantify how much accuracy per-minute HR loses vs beat-to-beat on identical subjects** before committing to RR work. |
| — | SIESTA (Radha/CReSS) | proprietary | — | Skip — commercial agreement required. |

**Exclude Garmin per-minute stages from training** (synthesized, not real per-minute scoring).

---

## 8. Product call & open questions

**Product call:** ship **3-class (wake/NREM/REM) confidently now** with a low-confidence
deep/light flag, and **gate true 4-class behind RR capture**. Acquire a handful of true PSG or
consumer-EEG (Dreem/Muse) nights so we can quote a defensible κ rather than agreement-with-Zepp.

**Open questions to resolve:**

1. **Does the Helio ring expose beat-to-beat RR/IBI or raw PPG over BLE?** Pivotal — decides
   κ ≈ 0.3 vs ≈ 0.6 ceiling. Firmware/protocol question, no code path exists today.
2. Can the ring's accelerometer be captured overnight without unacceptable battery/storage
   cost? (Determines ③ feasibility; raw IMU capture was deliberately dropped for activities.)
3. How many Zepp staged nights do we have, per user? <10/user → global model; many →
   per-person calibration (the existing `calibrate()` pattern).
4. Are Zepp vendor stages trustworthy enough to _train_ on, or only to _validate_ against?
   (They are not PSG — calibrating on them propagates Zepp's own errors.)
5. Does per-night z-normalization (Sridhar/Topalidis) conflict with any need to stage
   incrementally / mid-night? Our recompute is batch/synchronous, so likely fine — confirm.
6. Carry attribution for ODC-BY (sleep-accel) and MIT (sleep_classifiers) if we ship ported
   feature code.

---

## 9. Primary sources

- **Walch et al. 2019**, *SLEEP* 42(12):zsz180 — <https://academic.oup.com/sleep/article/42/12/zsz180/5549536>
  · code <https://github.com/ojwalch/sleep_classifiers> (MIT)
  · data <https://physionet.org/content/sleep-accel/1.0.0/> (ODC-BY)
- **Sridhar et al. 2020**, *npj Digital Medicine* — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7441407/>
- **Radha / Fonseca et al. 2019**, *Scientific Reports* s41598-019-49703-y — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6775145/> · preprint arXiv:1809.06221
- **Bakker et al. (CReSS) 2021**, *JCSM* — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8314617/>
- **Topalidis et al. 2023**, *Sensors* 23(5):2390 — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10006886/>
- **Beattie et al. 2017**, *Physiological Measurement* 38(11):1968 — <https://doi.org/10.1088/1361-6579/aa9047>
- **Song et al. (SLAMSS) 2023**, *PLOS ONE* e0285703 — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10191307/> · successor code <https://github.com/BIDSLabUMass/SLAMSS-IFS> (BSD-3)
- **Sundararajan et al. 2021**, *Scientific Reports* — <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7794504/> · code <https://github.com/wadpac/Sundararajan-SleepClassification-2021> (Apache-2.0) · models Zenodo 10.5281/zenodo.3752645 (CC BY 4.0)
