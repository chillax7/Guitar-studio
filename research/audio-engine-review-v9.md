# Audio engine review — stems, guitar input, amps, NAM, IR, tab playback

**Status:** review + implementation spec. Written against `redesign/v9-two-rooms`
@ `0a6bab5`; every DSP file reviewed here is **byte-identical to `main`**
(verified with `git diff main --`), so all findings apply to both branches.

**Audience:** this is written to be implemented by a separate session. Each
work item has concrete changes, file/function targets, and acceptance
criteria that can be checked by measurement rather than by ear.

---

## 0. Method, and what this review could NOT test

Everything below marked "measured" was obtained by running the app's **real
DSP code** — not a reimplementation:

- `stretch-processor.js` was loaded unmodified into Node with a stubbed
  `AudioWorkletProcessor`/`sampleRate`, and driven over a **real separated
  drum stem** (`__rmttest`, htdemucs_6s) at real Speed/Tune settings.
- The analog amp chain was **rebuilt node-for-node inside a real
  `OfflineAudioContext`** in headless Chromium and measured with
  Welch-averaged white noise.
- `librosa` 0.11 was used as an independent reference phase vocoder.
- The user's own 20-file TONE3000 A2 pack was used for the `.nam` metadata
  findings.

**Not testable here, and deliberately not guessed at:**

- Anything requiring a **real guitar plugged into a real interface** —
  absolute round-trip latency, feel under the fingers, and whether a given
  amp/NAM model "sounds right". This review can say what the code does to a
  signal and where it deviates from a reference; it cannot say what it
  sounds like.
- **Subjective tone judgements.** Where the user reports "harsh and fizzy",
  I looked for a measurable mechanism; §3 reports what I found *and* what I
  looked for and did not find.
- Real-world CPU headroom on the user's actual machine. The CPU figures in
  §1 are from this container's core and are useful as **relative** costs
  only.

### Two claims I formed mid-review and then retracted

Recording these because they are the kind of plausible-sounding conclusion
that would have wasted implementation effort:

1. **"The phase vocoder runs even at Speed 1.00×/Tune 0¢, so it degrades
   the default case."** *Wrong on the part that matters.* Measured
   unity-path error is **−130.6 dB** (bit-transparent), and `app.js`
   already graph-bypasses the worklet entirely via `Audio.mode`
   `"direct"`/`"processed"` (`setSpeedTune`, app.js:777). No work needed.
2. **"The analog amp has a +6.6 dB peak at 4–5 kHz — that's the fizz."**
   *Wrong — my own measurement bug.* My white-noise generator used
   `s*1103515245` in JS, which exceeds 2^53 and stops being white. With a
   correct `Math.imul` LCG the peak disappears (see §3). The amp's linear
   response is well behaved.

---

## 1. Stem playback — Speed / Tune ("crackly")

### 1.1 What is already correct (do not change)

| Property | Measured |
|---|---|
| Unity (1.00×, 0¢) transparency | **−130.6 dB** error — bit-transparent |
| Graph bypass at unity | Present and correct (`Audio.mode`) |
| Soft limiter engagement | **0.000 %** of samples in every case tested |
| Level control | peak 0.65–0.85, RMS within 2 % of source |
| Clicks / discontinuities | **none** — max sample-to-sample jump is *lower* than the source's |
| Pre-echo | pre/post-onset RMS ratio **0.769** vs source **0.774** — no measurable smearing |
| Steady-tone accuracy @ 0.75× | **0.00 dB** at every frequency 100 Hz–17 kHz |

The identity phase locking works. The earlier fixes (COLA normalisation,
cubic interpolation, one-hop-per-block) all hold up under measurement.

### 1.2 Finding S-1 — CPU is the dominant risk (highest priority)

Measured, 10 s of audio per configuration, as % of the real-time audio budget:

| Configuration | % of budget (this machine) |
|---|---|
| 1 stem, processed | 7.8 % |
| 1 stem, muted (`active:false`) | ~0.0 % |
| **6 stems, processed** | **45.8 %** |
| 6 stems @ 0.60× + −100¢ | 45.9 % |

Cost is **independent of the stretch ratio** — it is paid in full the moment
Speed or Tune leaves unity. On a laptop core 2–3× slower than this one that
is **90–140 % of budget before anything else runs**, and the Play Along rig
(NAM worklet, gate, pedals, looper, riff capture) shares the same audio
thread and the same `latencyHint: 0` context. Overrun on the audio thread
is heard as dropouts/crackle — which matches both the user's report and this
file's own documented history ("fault A").

**This is the most likely mechanism behind the remaining "crackly".**

### 1.3 Finding S-2 — HF rolloff off unity

Measured steady-tone response (input 0.500):

| Freq | 0.75× | **0.60×** | **Tune −100¢** |
|---|---|---|---|
| 6 kHz | 0.00 dB | −0.05 | −0.05 |
| 10 kHz | 0.00 dB | **−0.39** | **−0.38** |
| 14 kHz | 0.00 dB | **−1.39** | **−1.30** |
| 17 kHz | 0.00 dB | **−2.96** | **−2.55** |

**Why 0.75× is perfect and 0.60× is not:** `Ha = SYNTHESIS_HOP * speed /
pitchRatio`. At 0.75× that is exactly **384 samples — an integer**, so
`_readVirtual` never interpolates. At 0.60× it is 307.2, and every read goes
through Catmull-Rom interpolation. **All of the HF loss is the interpolator**,
not the phase vocoder. Independent check: librosa's PV retains 9.19 % HF
share vs source 9.15 %; ours retains 7.99 %.

### 1.4 Finding S-3 — no transient handling (architectural gap, moderate impact)

There is no onset detection and no phase reset (`grep transient|onset|
phaseReset` → nothing). Measured impact is real but moderate: attack
sharpness retains **90–94 %** of source across 0.5×–1.0×. Worth doing after
S-1/S-2, not before.

### 1.5 Work items

**S-1 (do first). Cut processed-mode CPU.** Three independent levers,
roughly in order of payoff-per-risk:

1. **Skip inaudible stems.** `active:false` already costs ~0 %. Extend the
   same treatment to stems whose gain is 0 (not just muted/soloed) — check
   `renderLanes`/mixer gain state in `app.js` and send `active:false`.
2. **Mono-ise where possible.** The FFT already packs L+R into one complex
   transform. For a stem whose two channels are identical (common for
   several htdemucs outputs), transform once and copy. Detect on load
   (`type:"load"`), cache a `monoEqual` flag.
3. **Consider FFT_SIZE 1024 at large stretch factors.** Halves per-hop cost;
   the phase locking is what carries quality now, not window length. Must be
   A/B'd against S-2's response table before adopting.

*Acceptance:* 6 stems in processed mode measurably below **30 %** of budget
on the same harness, with §1.1's transparency table unchanged.

**S-2. Replace Catmull-Rom with a windowed-sinc interpolator** in
`_readVirtual` (stretch-processor.js:484). An 8- or 16-tap Lanczos/Blackman
sinc with a small precomputed polyphase table (e.g. 512 phases) is the
standard fix and is cheap because the table is built once.

*Acceptance:* at 0.60× and at Tune −100¢, response within **±0.15 dB to
14 kHz** and **±0.4 dB to 17 kHz**, with unity still −130 dB and the CPU
figure from S-1 not regressing by more than 3 points.

**S-3. Transient-aware phase reset.** Per hop, compute spectral flux
(sum of positive magnitude change across bins — `mag[]` is already
computed). On a flux spike above an adaptive median-based threshold, take
the existing `!haveState` branch (pass the analysis spectrum straight
through, PVChannel.processSpectrum:278) for that frame only. The machinery
already exists; this is a detector plus one branch.

*Acceptance:* attack sharpness ≥ **98 %** of source at 0.60×; no regression
in the §1.1 table (especially: limiter engagement stays 0.000 %).

---

## 2. Guitar input path and pass-through latency

### 2.1 Verdict: already correct — do not "fix" this

I went looking for the usual latency and tone killers and did not find them:

| Check | Status |
|---|---|
| `echoCancellation` | `false` ✓ (playalong.js:852) |
| `noiseSuppression` | `false` ✓ |
| `autoGainControl` | `false` ✓ |
| `latency: { ideal: 0 }` constraint | present ✓ |
| `latencyHint: 0` on the context | present ✓ (app.js:471) |
| Context sample rate forced? | No — follows the OS device ✓ (correct: avoids output resampling) |
| Pass-through ("clean") path | `ampIn → cleanGain → ampOut` — **one GainNode**, zero added latency ✓ |
| Gate worklet | no lookahead/delay buffer ✓ |
| Looper / riff capture | tapped **after** `outputMute`, not in the monitoring path ✓ |

**Answer to "does pass-through truly represent the input with minimal
latency": architecturally, yes.** Residual latency is hardware + browser
buffer, which the app already exposes via *Measure round-trip latency*.

### 2.2 Finding I-1 — the one real tension (low priority, document only)

`latencyHint: 0` is set on the **shared** context that also runs up to six
phase-vocoder stems. Halving the callback size doubles the callback rate for
that work. This is already acknowledged in the code comment. S-1 is what
actually relieves it; no separate change needed.

---

## 3. Analog amp ("harsh and fizzy")

### 3.1 What I checked and found already correct

The chain is better than its reputation suggests — `tighten → pre-emphasis
→ asymmetric clip → DC block → de-emphasis → voicing → cab LP → tone`, with
`oversample = "4x"` on the WaveShaper and harmonics validated against a real
Marshall sample. Measured confirmations:

- **Pre-emphasis and de-emphasis cancel exactly.** Isolating them measures
  flat; "full chain" and "full chain minus both" are **identical to 0.1 dB**.
- **No aliasing problem.** Response is essentially unchanged from drive 0.3
  to drive 1.0 — the pre/de-emphasis plus the 5 kHz lowpass tame the
  distortion products.
- **No resonant peak.** (This is the claim I retracted — see §0.)

### 3.2 Finding A-1 — the cab rolloff is too shallow (this is the fizz)

Measured linear response, dB relative to 400 Hz:

| | 4 k | 5 k | 6.3 k | 8 k | 10 k | 12.5 k | 16 k |
|---|---|---|---|---|---|---|---|
| **Shipping** (1× LP@5k, Q .75) | +2.1 | +2.2 | −2.7 | **−6.9** | **−13.2** | −18.0 | −27.4 |
| 2× LP@4.5k | +1.3 | −1.8 | −11.3 | −21.2 | −32.8 | −44.1 | −61.6 |
| 3× LP@4.2k | +1.6 | −5.5 | −20.2 | −35.5 | −52.3 | −69.6 | −95.6 |

A single biquad gives only **−12 dB/oct**. A real mic'd guitar cab is
effectively a steep bandpass — typically **−25 to −35 dB by 10 kHz**. Ours is
only **−13.2 dB at 10 kHz**, i.e. it leaves roughly **12–20 dB more 6–12 kHz
energy than a real cab would**. That residual band is exactly where "fizz"
lives, and it is the one measurable way this chain departs from a real
amp+cab.

### 3.3 Work item A-1

In `ensurePAGraph` (playalong.js:286), replace the single `cabTone` lowpass
with **2–3 cascaded lowpass biquads around 4.2–4.5 kHz** (first section
Q ≈ 0.75 to keep a little presence, the rest Q ≈ 0.7). Keep the existing
`voiceWarm`/`voiceScoop`. Consider a shallow notch near 7–9 kHz, which is
what many cab IRs show.

Note the existing code comment already anticipates this ("with a real IR
stage active they stack to slightly darker, which is benign"), so stacking
with an IR remains acceptable.

*Acceptance:* measured response ≤ **−20 dB at 8 kHz** and ≤ **−30 dB at
10 kHz** relative to 400 Hz, with 200 Hz–3 kHz unchanged within ±1 dB.
Re-run the harmonic validation against the Marshall reference (H2 ≈ −21,
H3 ≈ −20, H5 ≈ −32) and confirm it still holds.

---

## 4. NAM engines (A1 + A2) — correctness

### 4.1 Finding N-1 — **sample-rate mismatch is unhandled (most serious correctness issue in this review)**

Verified facts:

1. Every one of the user's 20 real TONE3000 captures declares
   **`sample_rate: 48000.0`**.
2. **Our own A1 engine never reads it.** `grep sample_rate` inside
   `normalizeNamConfig`, `buildModel`, `buildModelWasm` → **0 hits**. The
   only occurrence in the file is `_nam_setSampleRate(sampleRate)` at
   nam-processor.js:936, which is the A2/official path.
3. The AudioContext deliberately follows the OS device rate (app.js:466–470)
   — so on any machine set to **44.1 kHz** (very common on Windows and on
   many interfaces) a 48 kHz-trained model is fed 44.1 kHz audio.
4. The vendored official core exposes no resampling symbols (`grep
   resample` → nothing; only 4 `_nam_setSampleRate` references), so telling
   it the rate does not make it resample either.

**Consequence:** a WaveNet's dilations are defined in *samples*. Running a
48 kHz model at 44.1 kHz stretches every time constant by
48000/44100 = **1.0884**, shifting the model's whole frequency behaviour
down by ~8.8 % (≈1.5 semitones) and lengthening its receptive field by the
same factor. The capture does not sound as intended, **silently**, with no
warning — and this affects **both** engines.

*This directly answers the user's question "are the two NAM engines properly
recreating the sounds as intended": on a 48 kHz device yes; on a 44.1 kHz
device, no.*

### 4.2 Finding N-2 — no cab/no-cab guidance from model metadata

The user's captures carry `"gear_type": "full-rig"` and `"tone_type"` in
`metadata`. The app reads **neither** (`grep gear_type|full-rig|tone_type`
→ nothing). A "full-rig" capture already contains the cab; stacking the
Cab IR on top double-filters it (audibly dull and woolly). An amp-only
capture needs an IR or it sounds raw and fizzy. The app currently gives the
user no signal either way.

### 4.3 Work items

**N-1a (do first — correctness).** Read `sample_rate` in
`normalizeNamConfig` and carry it onto the model object. When it differs
from the context `sampleRate` by more than ~0.1 %:

- **Minimum viable:** surface it clearly in the NAM status line and the
  manual ("This capture was made at 48 kHz but your audio device is running
  at 44.1 kHz — it will not sound exactly as captured. Set your interface to
  48 kHz."). Cheap, honest, and immediately useful.
- **Proper fix:** resample the model's input/output inside the worklet —
  run the model at its native rate by resampling the 44.1 kHz block up to
  48 kHz, processing, and resampling back. A polyphase FIR at a fixed
  147:160 ratio is exact for 44.1↔48 and can share the interpolator built
  for S-2. Note this adds latency (filter length) — measure it and feed it
  into the existing latency reporting.

*Acceptance:* with a device at 44.1 kHz and a 48 kHz model, the rendered
response of a known model matches the same model rendered at 48 kHz within
**±0.5 dB up to 10 kHz**. Add a test that loads one of the user's real
`.nam` files at both rates and compares.

**N-1b.** Prefer a 48 kHz context when nothing else forces otherwise, or at
minimum show the context rate next to the NAM model name (the Tone Lab
latency hint already surfaces the rate — reuse that).

**N-2.** Read `metadata.gear_type` / `tone_type` in `paLoadNamModel` and
display it. When `gear_type` indicates a full rig, show an inline note next
to the Cab IR control ("this capture already includes a cab — an IR on top
will usually sound too dark"). Do **not** auto-toggle the IR; make it advice,
consistent with this app's honesty-hint culture.

*Acceptance:* loading a `full-rig` capture shows the note; loading an
amp-only capture does not.

---

## 5. Cab IR section

### 5.1 Already correct

- `PA.convolver.normalize = false` ✓ (playalong.js:360). This matters —
  `ConvolverNode`'s default auto-normalise rescales by an RMS-ish factor and
  is wrong for guitar IRs.
- Manual peak-normalisation of the loaded impulse to unity ✓ (playalong.js:1847).

### 5.2 Finding R-1 — IR sample-rate conversion is unverified

The same class of problem as N-1: cab IRs are commonly 48 kHz (and often
44.1 kHz), and `decodeAudioData` will resample an IR file to the context
rate. That is *correct* behaviour for an IR (unlike for a NAM model), so
this is likely fine — but it is worth an explicit check that a 48 kHz IR
loaded into a 44.1 kHz context still measures the intended magnitude
response, because IR truncation length also changes with rate.

*Acceptance:* load the same IR into 44.1 and 48 kHz contexts, compare
magnitude response — expect within ±0.5 dB to 10 kHz.

### 5.3 Finding R-2 — no IR length cap

Long IR files (some cab IRs ship at 500 ms–2 s with room tails) cost
convolution CPU proportional to length, on the same audio thread as §1's
stems. A cab IR only needs ~20–50 ms. Consider truncating loaded IRs to
~100 ms with a short fade-out, which is standard practice and materially
cheaper.

---

## 6. Guitar Pro Tab View — MIDI playback

### 6.1 Current state

alphaTab **1.8.4**, playing `FluidR3Mono_GM.sf3` (14.5 MB, MIT). alphaTab
runs its **own AudioContext** (`this._context`), separate from the app's, and
uses a `ScriptProcessor` backend in at least some paths.

### 6.2 Finding T-1 — the soundfont is the ceiling, and it is low for metal

FluidR3's GM programs 29/30 (Overdriven / Distortion Guitar) are the weak
point for exactly the user's use case (hard rock and heavy metal lead).
General-MIDI distortion-guitar samples are typically a single looped sample
with no velocity layers, no palm-mute articulation and no pick-attack
variation — which is why tab playback sounds synthetic no matter how good
the notation is.

### 6.3 Options, with honest trade-offs

**T-1a — Route tab playback through the Tone Lab rig (highest ceiling).**
Play the tab with a *clean* guitar program and feed it through the user's
existing NAM/analog rig. This is the option that best exploits what this app
already has that no tab reader does. Constraint found: alphaTab owns a
separate `AudioContext`, and Web Audio nodes cannot cross contexts — so this
needs a `MediaStreamDestination` → `MediaStreamSource` bridge into the app
context, which **adds latency**. For tab playback (not live monitoring) that
is acceptable. Verify alphaTab 1.8.4 actually exposes its output node
(`get output()` exists — 3 occurrences) before committing to this.

**T-1b — Better samples (lower risk, smaller ceiling).** Swap in a guitar
sample set with velocity layers for programs 29/30. Must stay
locally-vendored and open-licence, consistent with the alphaTab/FluidR3
precedent.

**T-1c — Post-EQ only (cheapest).** A fixed EQ/cab curve on the tab output
to tame GM distortion-guitar buzz. Only possible in combination with the
T-1a bridge, since we otherwise cannot insert into alphaTab's context.

**Recommendation:** prototype **T-1a** behind a toggle ("play tab through my
rig"), keeping the soundfont as the default. If the bridge proves awkward,
fall back to T-1b. Do not do T-1c alone.

*Acceptance:* with the toggle on, a tab track audibly plays through the
selected NAM capture; toggle off restores current behaviour exactly;
latency added is measured and reported.

---

## 7. Suggested order of work

| # | Item | Why this order | Risk | Status |
|---|---|---|---|---|
| 1 | **N-1a** NAM sample-rate detection + warning | Correctness, affects every capture on 44.1 kHz devices, cheap | Low | **Done** (`redesign/v9-two-rooms`) |
| 2 | **S-1** processed-mode CPU | Most likely cause of the actual "crackly" report | Medium | **Done, partial** — see note below |
| 3 | **A-1** steeper cab rolloff | Direct, measured answer to "harsh and fizzy" | Low | **Done** |
| 4 | **N-2** cab/no-cab metadata guidance | Cheap, prevents a common tone mistake | Low | **Done** |
| 5 | **S-2** sinc interpolator | Real measured defect, self-contained | Low | **Done** |
| 6 | **N-1b** proper NAM resampling | Bigger job; do after the warning exists | Medium | Not done |
| 7 | **S-3** transient phase reset | Refinement once CPU headroom exists | Medium | Not done |
| 8 | **R-1/R-2** IR checks + length cap | Verification + cheap CPU win | Low | Not done |
| 9 | **T-1a** tab through rig | Highest ceiling, most exploratory | High | Not done |

### Implementation notes (this pass)

- **N-1a**: implemented client-side in `paLoadNamModel`/`paCheckNamSampleRate`
  (`playalong.js`) rather than in the worklet — the `.nam` file's
  `sample_rate` field and the live `Audio.ctx.sampleRate` are both already
  available on the main thread at load time, so no worklet round-trip was
  needed. Verified against the user's real A2 capture pack (`sample_rate:
  48000.0` present on every file).
- **N-2**: implemented alongside N-1a as `paNamGearIrNote`; reads
  `metadata.gear_type` and shows an inline note next to the Cab IR Bypass
  control. Verified against the same real capture pack (`gear_type:
  "full-rig"`).
- **A-1**: `cabTone` (single lowpass, 5000Hz/Q0.75) replaced with three
  cascaded lowpass biquads (4500Hz/Q0.5 each) in `ensurePAGraph`. Measured:
  -30.2dB@8kHz / -46.3dB@10kHz (targets were ≤-20dB / ≤-30dB), Marshall
  harmonic validation unchanged (H2 -21.8/H3 -20.0/H5 -32.7 vs targets
  -21.1/-19.9/-32.0). Trade-off found during tuning: any cascade steep
  enough to hit the 8kHz/10kHz targets also adds a modest (~+3.6dB) rise
  around 2.5-3.5kHz relative to the old single-biquad response — present in
  the shipped filter too, just smaller (+1.3dB), so this is the existing
  design's character turned up, not a new artifact. Chose the flattest
  configuration that still clears both targets with margin.
- **S-1**: the spec's two named levers were both addressed, but the actual
  CPU win measured smaller than the finding implied it might be:
  - "Skip inaudible/zero-gain stems" was **already implemented** before this
    pass (`active` flag, gated on `gain > 0` in `app.js`) — nothing to do.
  - "Mono-ise identical-channel stems" was genuinely missing and is now
    implemented (`arraysEqual` check at load time, `stretch-processor.js`);
    verified exact (mono output reads back with `L === R` to the bit) via
    the harness. Measured saving: **~3.6-5%** of per-stem CPU on a
    synthetic tone — smaller than hoped, because the file's own prior
    optimization pass already found the FFT itself is ~89% of the cost, and
    this only removes the redundant half of the remaining ~11%
    (identity-phase-locking pass).
  - Added a third lever not in the original spec text: skip the FFT/PV pass
    entirely for any hop that reads back **exact digital silence** (common
    in source-separation stems during sections a model produced nothing
    for), correctly resetting phase-lock state on resume so there's no
    discontinuity at the boundary (verified: resume-point sample jump is
    within 1% of the steady-state jump size elsewhere in the file). Real
    Demucs stems tested had 0% exact-zero content, so this mostly helps
    custom/edited stems with real silent gaps, not typical separation
    output.
  - Net effect: real, verified, and lossless, but modest. The CPU number in
    §1.2's Finding S-1 (45.8% for 6 stems) was not re-measured end-to-end in
    a live 6-stem session after these changes — the harness here only
    measures single-stem, synthetic-signal relative cost. If crackling
    persists after this change, the next lever is a smaller FFT size (a
    real quality/CPU trade-off, unlike the two implemented here) or a
    genuinely shared per-block FFT across all active stems.
- **S-2**: Catmull-Rom replaced with a table-driven windowed-sinc (Lanczos,
  `LANCZOS_A = 6`, 12 taps, 1024-phase precomputed lookup table built once
  at load, not evaluated per-sample). Measured: ±0.06dB to 14kHz, ±0.03dB
  to 17kHz at Speed 0.60 (targets were ±0.15dB / ±0.4dB) — comfortably
  inside spec. Unity transparency re-verified unchanged (-130.6dB, bit
  identical to the pre-change baseline). CPU overhead of the wider kernel
  measured at ~10.8% relative to the old cubic interpolator on the harness
  (a smaller `LANCZOS_A = 4`/8-tap kernel measured ~5.1% overhead and still
  met the 14kHz target, missing only the 17kHz target at -0.65dB — kept
  A=6 to satisfy both acceptance thresholds in the spec).

## 8. Regression guard

Items 2, 5 and 7 all touch `stretch-processor.js`. Before changing it,
**re-create the measurement harness** (§0) and record the current numbers —
§1.1's table is the regression baseline. In particular, the −130.6 dB unity
figure and the 0.000 % limiter engagement are the two numbers that catch the
classes of bug this file has historically had.

---

## 9. Follow-up pass: preset-switch latency + looper footswitch

Not part of the original review — raised directly by the user ("the rig
preset switch takes too long, there is a noticeable delay before the next
rig tone is available") alongside a request for looper footswitch control.

### 9.1 Where the preset-switch delay actually is

Measured in headless Chromium against the real shipped code path
(`paLoadNamModel`), using two of the user's own A2 captures (~295 KB each)
served by the real server, context at 44.1 kHz:

| Step | Cost | Cacheable? |
|---|---|---|
| `fetch` + `JSON.parse` the `.nam` | ~40 ms | yes |
| `paProbeNamModel` (throwaway OfflineAudioContext, `addModule`, wasm instantiate, build, 0.25 s render) | **~600–780 ms** | yes |
| live load into `PA.namNode` (`awaitNamLoad`) | ~440–630 ms | no — see below |
| **total `paLoadNamModel`** | **~1150 ms** | |

The probe was the single largest component and is pure overhead on a
*repeat* switch: it exists only to measure this machine's speed
(`rtFactor`) and the capture's output level (`outputGainDb`), and neither
answer changes between two switches to the same preset at the same sample
rate.

### 9.2 What was done

- Session caches for the two cacheable steps (parsed `.nam` JSON, probe
  result keyed by `filename@sampleRate`), plus the decoded IR `AudioBuffer`.
  Both bounded (12 entries, insertion-order LRU) so a long browsing session
  can't grow without limit.
- `paPrewarmPresetChain()` — fetches and probes the *other* presets in the
  song's chain in the background (sequentially, so the probes don't compete
  with live audio), so even the first switch to each preset skips both
  steps. Triggered on rig-session start, after each cycle/jump, and when a
  preset is added to the chain.

**Measured result:** ~1150 ms → **~525–580 ms** per switch (prewarmed or
repeat). Cold first-ever load is unchanged at ~1150 ms by construction.

### 9.3 What is left, and why it was not fixed here

The residual ~500 ms is `mod._nam_loadModel()` inside the **vendored
official NAM core** (`vendor/nam-official/`) — the C++ model construction
itself. Two hypotheses were measured and **both ruled out**:

- *"`buildModelOfficial` re-serialises the whole model with
  `JSON.stringify` on the render thread"* — true, it does, but measured at
  **~1–6 ms**, not the bottleneck. (`JSON.parse` 1.1 ms, `structuredClone`
  1.2 ms — the whole marshalling layer is negligible.)
- *"structured-cloning the parsed object to the worklet is expensive"* —
  also negligible, per the same measurement.

So the cost is genuinely inside the vendored core and cannot be cached or
marshalled away from JavaScript.

The obvious next step — have the worklet **pre-build** chain models and
swap a pointer on switch — was deliberately **not** taken, for two
specific reasons:

1. It relocates the stall rather than removing it. Model building runs in
   the `port.onmessage` handler on the **render thread**, and every worklet
   in a context shares that one thread — so pre-building during play would
   produce an *unmasked* ~500 ms audio dropout, where today the stall is at
   least hidden behind `paApplyPresetWithFade`'s mute.
2. Holding N built models at once is exactly the condition that caused a
   previously-fixed serious bug (see `disposeModel`'s comment in
   `nam-processor.js`: "switching between several A2/NAM2 captures gets
   slower and eventually silent for ~15 s" — official-core instances
   accumulating in the wasm heap).

A safe version would need to gate pre-building on "not currently playing or
recording" and bound the number of retained instances with explicit
disposal. That is a real change to the model lifecycle and wants its own
pass, not a bolt-on to this one.

### 9.4 Looper footswitch

The two hardcoded MIDI learn targets (`forward`/`backward`) were
generalised into a `PA_MIDI_ACTIONS` table, and two entries added:
looper record/overdub (the existing `paLooperPrimaryPress` full pedal state
machine — record → loop → overdub → stop overdub → resume) and looper stop.
Both reuse the exact functions the on-screen buttons call, so footswitch and
mouse can't drift apart. The preset actions keep their original
localStorage keys, so an already-learned pedal survives the refactor.

Learning a button that is already assigned elsewhere now *steals* it and
says so, instead of silently leaving one physical button firing two
actions.

Verified with 17 synthetic-MIDI assertions in a real browser (learn, store,
label render, live dispatch, release-event rejection, unmapped-button
no-op, conflict stealing, and post-conflict dispatch), plus 15 assertions
covering the caching/prewarm regression surface. Still **not** tested
against real footswitch hardware — the same caveat the original MIDI
feature carries.
