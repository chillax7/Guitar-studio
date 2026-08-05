# Spec: Lead/Rhythm Splitter Bench — an A/B rig for every method we've tried

**Status:** ready to build, as a standalone app.
**Audience:** an agent/developer starting from a clean context. This
document is deliberately self-contained — it assumes you have never seen
Orpheus Guitar Studio and carries everything you need, including the
methods that FAILED and why, because re-deriving those costs days.

**Purpose:** take one guitar stem, run every splitting method we know
against it, and make the outputs trivially A/B-able by ear. This is a
listening instrument, not a product. It exists so a future V10 strategy
(possibly a trained model) can be judged against an honest baseline
instead of a vague memory of "the old one sounded bad".

---

## 0. The problem, stated honestly

Input is a **guitar-only stem** — already separated out of a full mix by
something like Demucs or BS-RoFormer. The goal is to split it again into
**rhythm** (chordal/accompaniment) and **lead** (melodic/solo).

This is not a normal source-separation problem. Rhythm and lead are
routinely the same player, same guitar, same amp, same preset, recorded
minutes apart. There is frequently **no timbral difference to exploit at
all.** The only reliable differences are structural and musical:

| Cue | Rhythm | Lead |
|---|---|---|
| Polyphony | Chords | Mostly one note at a time |
| Repetition | Repeats with the bar/section | Doesn't repeat |
| Register | Lower/mid, open position | Often higher up the neck |
| Articulation | Strums, palm mutes | Bends, vibrato, slides |
| Stereo placement | Often double-tracked hard L/R | Often centred |

**No open model does this.** One commercial product (Moises) ships a
lead/rhythm split; its model and data are undisclosed. The public
MoisesDB taxonomy splits guitar only into acoustic / clean electric /
distorted electric, with **no role labels**. If V10 goes the trained
route, the role annotations are the moat and the dataset is the whole
project — the architectures are all public and comparatively easy.

---

## 1. What the bench must do

```
guitar-stem.wav
      │
      ├── method A ──► rhythm_A.wav  +  lead_A.wav
      ├── method B ──► rhythm_B.wav  +  lead_B.wav
      ├── ...
      └── method N ──► rhythm_N.wav  +  lead_N.wav
                          │
                    A/B listening UI
```

### Hard requirements

1. **One input, every method, one command.** Point it at a stem, get
   every method's pair of outputs.
2. **Instant A/B switching at a fixed playhead.** Switching method must
   NOT restart playback. Judging these is impossible if you lose your
   place each time — the differences live in a few seconds around a
   specific lick.
3. **Loudness-matched comparison, with a bypass.** Perceived quality
   tracks loudness so strongly that unmatched A/B is worthless. Match by
   default; allow raw.
4. **Solo either half.** Most judgements are "is the lead gone from the
   rhythm output" — that needs the rhythm output alone.
5. **Reproducible.** Every output carries the exact method + parameters
   that produced it, so a good result can be recreated.

### Explicit non-goals

- Not a product, not a plugin, no installer.
- No real-time processing — offline render, then play.
- Do NOT try to auto-pick a winner. Ranking these by metric is exactly
  the trap described in §4.

---

## 2. The methods

Implement all of these. The four marked SHIPPED are lifted from
`backing_track.py` in Orpheus and are known-working code, not sketches.

Every method takes a **stereo** guitar stem and returns two mono or
stereo signals. Note the orientation difference in §2.6 — it matters.

### 2.1 `midside` — blunt mid/side (SHIPPED)

The naive baseline. Keep it: it's the control.

```python
mid  = (left + right) / 2      # "centre"
side = (left - right) / 2      # "sides"
```

Works only when the mix is cleanly hard-panned. Fails on anything
partial or inconsistent. Include it so the others have something to beat.

### 2.2 `spectral` — per-bin panning weight (SHIPPED, current default)

Same idea, but decided per time/frequency bin instead of once for the
whole track.

```python
NPERSEG = 4096, noverlap = NPERSEG * 3 // 4
L, R = stft(left), stft(right)
balance      = |L| / (|L| + |R| + 1e-9)     # 0.5 = centred
centeredness = 1 - 2*|balance - 0.5|        # 1 = centred, 0 = hard panned
centre = istft(centeredness * (L + R)/2)
sides  = istft((1 - centeredness) * (L - R)/2)
```

Genuinely better than midside on partially-panned material. **Its known
weakness is the whole reason this bench exists:** on a track where the
lead is dead-centre, `centre` comes out a near-clean lead, but `sides`
STILL has strong lead bleed in it — because "sides" is a panning guess,
not a lead-content guess.

### 2.3 `hybrid` — spectral sharpened by beat-grid alignment (SHIPPED)

`spectral`, plus a confidence nudge from rhythm regularity.

- Detect note onsets; measure how tightly they land on the song's beat
  grid (tolerance = half the median beat spacing).
- Where onsets are grid-locked (strummed/chordal playing), push
  `centeredness` further from 0.5 in whichever direction it already
  leans, by `HYBRID_SHARPEN_STRENGTH = 0.6`.
- Falls back to plain `spectral` with no beat grid.

Needs a beat grid. In the bench, derive it with `librosa.beat.beat_track`
on the stem itself (Orpheus uses the song's drums stem, which you won't
have here — note the difference when comparing results).

### 2.4 `coherent` — phase-coherent cancellation (SHIPPED, best current)

The one that finally worked. **Orientation: it estimates the LEAD first
(via `spectral`'s centre) and gets rhythm as the residual.**

```python
centre, _ = spectral_pan_split(left, right)   # the lead estimate
rhythm_L  = coherent_subtract(left,  centre)
rhythm_R  = coherent_subtract(right, centre)
```

with:

```python
NPERSEG = 4096, noverlap = NPERSEG * 3 // 4
WINDOW = 3          # frames of smoothing on the complex gain
GAIN_CAP = 1.6      # ceiling on |gain|

T, C = stft(target), stft(ref)
num = T * conj(C)
den = (C * conj(C)).real
# smooth numerator and denominator SEPARATELY over a short sliding
# window BEFORE dividing — not the raw single-frame ratio
num_s = convolve2d(num, ones(WINDOW)/WINDOW, mode="same", boundary="symm")
den_s = convolve2d(den, ones(WINDOW)/WINDOW, mode="same", boundary="symm")
eps  = 1e-6 * mean(den_s)          # relative, NOT a fixed tiny constant
gain = num_s / (den_s + eps)
gain = clip_magnitude(gain, GAIN_CAP)
residual = istft(T - gain * C)
```

**Why this works where magnitude masking didn't:** the gain is
*complex*, so it only removes content actually phase-correlated with the
reference. A magnitude mask can't tell "the reference has energy at this
bin" from "the reference's content at this bin is what's in the target",
and that distinction is the entire problem.

Three details that are load-bearing, all learned by failing without them:

- Smoothing **numerator and denominator separately before dividing**. A
  single-frame ratio is unstable and degenerate; a whole-track ratio
  can't track drift. Both were tried and rejected.
- `eps` **relative to the signal's own mean power**, not a fixed
  constant — otherwise the gain blows up wherever the reference is
  momentarily near-silent.
- A **cap on |gain|**, not a `[0,1]` clip. This is genuine subtraction,
  not gating; an over-confident gain needs a ceiling, not a floor.

Verified on a real user stem: lead fundamental reduced to ~2.5–4% of its
level in the reference, with a worst-case 5-second RMS floor of 0.29–0.64
relative to the original (i.e. no near-silent stretches).

### 2.5 `repetition` — REPET-SIM (PROTOTYPED, not shipped)

**The only method here that does not depend on panning at all**, and
therefore the only one with anything to work with on a mono stem or one
where lead and rhythm sit in the same place. Complementary, not another
variation.

Rhythm repeats; lead doesn't.

```python
HOP = 1024                       # 2048 also tried; 1024 = better time resolution
D = stft(mono, n_fft=4096, hop_length=HOP)
chroma = librosa.feature.chroma_cqt(y=mono, hop_length=HOP)
rec    = librosa.segment.recurrence_matrix(chroma, mode="affinity",
                                           sym=True, sparse=True, k=K)
rhythm_mag = librosa.decompose.nn_filter(|D|, rec=rec, aggregate=np.median)
```

`librosa`'s own docs state `nn_filter(aggregate=np.median)` reproduces
**REPET-SIM** (Rafii & Pardo 2012). No extra dependency needed.

Two variants were tried; **implement both as separate bench entries**,
since the second was never judged:

- **v1:** `K=60`, `HOP=2048`, hard clip `min(rhythm_mag, |D|)`, resynth
  with mixture phase. Verdict from the user: *"working... in fact the
  rhythm and lead parts — but poor quality, underwater."*
- **v2 (unjudged):** `K=20`, `HOP=1024`, and instead of a hard clip, a
  proper normalized soft mask smoothed on BOTH axes:
  ```python
  residual   = maximum(|D| - rhythm_mag, 0)
  mask       = rhythm_mag / (rhythm_mag + residual + eps)
  mask       = medfilt2d(mask, kernel_size=(5, 5))   # time AND frequency
  mask       = clip(mask, 0.05, 0.95)                # floor AND ceiling
  rhythm     = istft(mask * D)
  ```
  Rationale: less cross-time averaging (smaller `K`) should reduce the
  magnitude/phase decorrelation that causes the underwater sound.

Then get lead by feeding that rhythm estimate into `coherent_subtract`
as the reference — note this is the **opposite orientation** to §2.4.

### 2.6 Orientation matters — record it per method

| Method | Estimates first | Gets by residual |
|---|---|---|
| midside / spectral / hybrid | both directly | — |
| coherent | **lead** (centre) | rhythm |
| repetition | **rhythm** (what repeats) | lead |

This is not cosmetic. **Whichever part is the residual absorbs every
error in the estimate.** Artefacts land there. If the rhythm output is
the residual, expect artefacts in the rhythm; flip the orientation and
they move. Label the outputs by role (`rhythm`/`lead`), not by
`centre`/`sides`, and state the orientation in the UI.

### 2.7 Combinations worth having

- `coherent` where the reference comes from `hybrid` instead of
  `spectral`.
- `repetition` → rhythm, then `coherent_subtract` for lead, then feed
  THAT lead back as a reference for a second-pass rhythm.

Cheap to add once the harness exists; possibly better than any single
method.

---

## 3. Methods that FAILED — do not re-derive these

Each of these was built, rendered, and rejected **by ear on real
material**. They are recorded so nobody spends a day rediscovering them.
Keep them in the bench as selectable entries, clearly marked, so the
failure modes stay audible for comparison.

### 3.1 Best-fit scalar gain — REJECTED

`g = dot(target, ref) / dot(ref, ref)` over the whole track, then
`target - g*ref`. Scored near-zero residual correlation. Verdict: *"the
lead guitar is still there with the rhythm."*

**Why it fails:** a time-invariant filter cannot cancel a time-varying
signal. Bleed ratio changes constantly with reverb tails, panning drift
and separation-model noise.

### 3.2 Per-frequency-band Wiener gain (time-invariant) — REJECTED

Same as above but per STFT bin, averaged over all time. Same verdict,
same reason. Per-bin doesn't help if it's still fixed in time.

### 3.3 Magnitude spectral subtraction — REJECTED (twice)

```python
ratio = |C| / (|T| + 1e-9)
mask  = clip(1 - alpha*ratio, floor, 1.0)
out   = istft(mask * T)
```

Swept `alpha` 2.0–4.0, `floor` 0.0–0.05, median smoothing 5×5 and 7×7.

- `alpha=2.5, floor=0.03, 5×5` — *"better, the lead is quiet compared to
  the rhythm now, yes it is warbly."*
- `alpha=4.0, floor=0.0, 5×5` — *"hardly any sound at all and it's just
  little squeaks."*
- `alpha=2.5, floor=0.03, 7×7` — *"very warbly and still with the lead
  guitar in the mix."*

**Why it fails:** magnitude-only masking conflates "the reference is loud
here" with "the reference explains what's here". Push it hard enough to
remove the lead and it guts any bin where the reference has incidental
broadband energy — hence near-silence. Back it off and the lead stays.
There is no good setting; the mechanism is wrong. This is what motivated
the complex-gain approach in §2.4.

---

## 4. Evaluation — the part that actually matters

**The single most expensive lesson from this work: proxy metrics
repeatedly said things were improving when they sounded worse.** Design
the bench so ears are the primary instrument and numbers are only ever
corroborating evidence.

### 4.1 Metrics that MISLED (kept only as diagnostics)

- **Whole-track residual correlation.** Near-zero for methods that
  audibly still had the full lead present. Useless alone.
- **Single-note magnitude at one timestamp.** Drove two rounds of tuning
  that both got rejected. One cherry-picked note does not generalise.
- **Mask "warble" proxy** (RMS of frame-to-frame mask differences). Went
  down while perceived warble went up. Actively harmful.

### 4.2 Checks that EARNED their place

- **Multi-point suppression.** Use `librosa.pyin` on the reference to
  find 5+ confident, stable pitched runs **spread across the timeline**
  (enforce a minimum separation, e.g. 20s, so they don't cluster). At
  each, measure the fundamental's magnitude in the output vs the
  reference. Report every point, not an average — an average hides a
  region that failed.
- **Windowed RMS floor** — the check that caught the "squeaks" disaster
  before it reached the user:
  ```python
  # worst-case 5s-window RMS of output vs original; skip windows where
  # the ORIGINAL is itself near-silent
  ratios = [rms(out[w]) / rms(orig[w])
            for w in windows(5.0) if rms(orig[w]) > 0.01]
  worst, median = min(ratios), np.median(ratios)
  ```
  A healthy result was worst ≈ 0.29–0.64. Anything collapsing toward
  zero means over-suppression, regardless of how good the suppression
  numbers look.
- **Just listening.** Non-negotiable. Every rejected candidate above
  passed at least one metric.

### 4.3 Methodology rules — learned the hard way, twice

1. **Never compare variants under conditions that differ.** In a
   separate memory investigation in this same codebase, four variants
   were measured in one long-running process; ordering effects made one
   look 82% better than the others. Measured with a fresh process per
   variant, all four were identical. The "win" was an artefact of
   measurement order. **Randomise or isolate. Same input, same length,
   same loudness, ideally blind.**
2. **A metric that improves while the audio worsens means the metric is
   wrong.** Fix the metric or drop it; do not tune against it.
3. **State what a number does NOT cover.** The inter-channel correlation
   figure in Orpheus has a UI note saying it does not predict split
   quality — because it was tested on 5 real songs and didn't. Every
   number here needs that treatment.

### 4.4 Suggested UI

- Waveform + spectrogram per output, aligned, sharing one playhead.
- Method switcher that swaps audio **without restarting playback**.
- A/B blind mode: hide labels, shuffle, reveal after judging.
- Per-method panel: parameters used, the §4.2 numbers, runtime.
- One-click export of a chosen output.
- Free-text verdict per method, saved. The verbatim user reactions in §3
  ("warbly", "little squeaks") were far more actionable than any metric.

---

## 5. Test material

Include, at minimum:

1. **Lead dead-centre, rhythm double-tracked L/R** — the easy case
   `spectral`/`coherent` are built for.
2. **Both centred, same amp preset** — the hardest case, where every
   panning method must collapse. If a method claims to work here, it
   should be doing something structural.
3. **Mono, or near-mono, stem** — panning methods have nothing; only
   `repetition` should show signal.
4. **Bus reverb over everything** — reverb tails break the "instantaneous
   mixing" assumption every panning method rests on.
5. **A real separated stem, artefacts and all** — not a clean studio
   multitrack. What the app actually receives is a Demucs/RoFormer
   output with its own noise.
6. **A long stretch of rhythm with no lead at all.** Critical: a method
   that "removes the lead" by gutting everything scores well on
   suppression and fails here obviously.

Known-good reference material from this work: a BS-RoFormer guitar stem
of a track with a centred lead solo starting ~2 minutes in, where
`coherent` was judged *"usable and better than what we had before"*.

---

## 6. Build order

1. IO + a `Splitter` interface: `split(stereo, sr) -> {"rhythm":…, "lead":…}`.
   Everything behind one interface, no exceptions — comparability is the
   entire point.
2. `midside`, then `spectral`. Establishes the floor.
3. The A/B player. **Before** more methods — without it you cannot judge
   anything, and judging is the bottleneck.
4. `coherent` (port from `backing_track.py`; it is known-good).
5. `repetition` v1 and v2.
6. The §4.2 checks, reported but never used to auto-rank.
7. `hybrid`, then the §2.7 combinations.
8. Write down verdicts per method per test file. That table is the real
   deliverable.

---

## 7. Honest expectations

Every method here is a heuristic. On well-arranged material with clear
panning or clear repetition they produce something usable; on dense,
through-composed, or heavily-processed guitar they degrade, and on a
same-guitar-same-amp centred double-track they will essentially fail.
`coherent` is the current best and it is a "usable, better than before"
result, not a solved problem.

The point of the bench is to make that ceiling **audible and
undeniable**, so a V10 model has a fair baseline to beat and so the
effort of building a labelled dataset can be justified with evidence
rather than a hunch.

---

## Appendix: source pointers

All shipped code is in `backing_track.py` in the Orpheus repo:

| What | Where |
|---|---|
| `midside_pan_split` | blunt mid/side |
| `spectral_pan_split` | per-bin centeredness |
| `hybrid_pan_split` + `_onset_regularity_curve` | beat-grid sharpening |
| `coherent_subtract` + `coherent_pan_split` | complex-gain cancellation |
| `normalize_split_outputs` | peak-normalises each output to the source's own peak — **note this makes the outputs non-additive**, which breaks naive "subtract one from the other" experiments. Bench should keep raw and normalised copies. |
| Constants | `SPECTRAL_SPLIT_NPERSEG=4096`, `HYBRID_SHARPEN_STRENGTH=0.6`, `COHERENT_SUB_NPERSEG=4096`, `COHERENT_SUB_WINDOW=3`, `COHERENT_SUB_GAIN_CAP=1.6` |

Background reading in `research/`: `guitar-separation-upgrade-spec.md`
(options analysis), `lead-rhythm-split-research.md` (why training one is a
data problem), `lead-rhythm-track-a-assessment.md` (assessment of a
classical-DSP pipeline proposal against what already exists here).
