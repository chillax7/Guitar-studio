# Backing Track Engine — Specification

**Status:** derived from a working, tested Python CLI prototype (`backing_track.py`). This document specifies the *engine* — the audio processing core — independent of any particular language or UI, so it can be reimplemented (e.g. natively in Swift, or wrapped as a bundled backend service) as part of building the full application described in `backing-track-tone-match-spec.md`.

**Relationship to the app spec:** `backing-track-tone-match-spec.md` describes the two-stage product (Step 1: Backing Track Creator, Step 2: Live Tone Matcher) and a suggested architecture. This document is a detailed spec for the parts of Step 1 that have actually been built and validated, plus one experimental extension (guitar lead/rhythm splitting) that came out of user testing. It also calls out the architectural implications of the planned UI (§6) so the engine isn't designed in a way that has to be re-architected later.

---

## 1. Purpose & Scope

The engine takes a source audio file and produces:
1. A set of isolated **stems** (vocals, drums, bass, guitar, piano, other, plus derived stems — see §3.4)
2. A **mixdown** of any combination of those stems, with per-stem mute/gain, time-limited muting, and loudness normalization

It does not include: a UI, a persistent project file format, real-time audio I/O, or the Step 2 guitar tone matcher. See §6 for how this engine is expected to plug into those.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| Track | A source song (one input audio file) |
| Model | A source-separation model (e.g. `htdemucs`, `htdemucs_6s`) — determines which stems are producible and their quality |
| Stem | One isolated audio component of a track, as a stereo WAV at the model's native sample rate |
| Derived stem | A stem computed from another stem rather than directly by the separation model (currently: `guitar_center` / `guitar_sides`, see §3.4) |
| Mix | The result of summing a chosen subset of stems (with gains/time-ranges applied) into a single stereo signal |

---

## 3. Functional Specification

### 3.1 Source separation

- **Input:** any audio file readable by the separation backend (MP3 confirmed working; WAV/FLAC should work identically since decoding is delegated to the backend/ffmpeg).
- **Backend:** Demucs (Hybrid Transformer Demucs / HTDemucs family). Invoked as an external process in the prototype (`python -m demucs -n <model> -o <dir> <input>`); a native reimplementation could instead link a Core ML/ONNX conversion of the same model per the app spec's suggested architecture.
- **Model selection determines available stems:**

  | Model | Stems produced |
  |---|---|
  | `htdemucs` (default) | vocals, drums, bass, other |
  | `htdemucs_ft` | vocals, drums, bass, other |
  | `htdemucs_6s` | vocals, drums, bass, guitar, piano, other |
  | `mdx`, `mdx_extra` | vocals, drums, bass, other |

  An engine implementation should treat this as a lookup table, not a hardcoded assumption — an unrecognized/future model should still work, just with its stem list determined by inspecting whatever files it actually produces (see §3.5's "discover stems from disk" pattern, which the prototype uses precisely to stay correct as new models/derived stems are added).

- **Caching:** separation is expensive (real time to run, though observed in testing at roughly 4–5x faster than real-time on Apple Silicon CPU). Results must be cached keyed by **(track identity, model)** and reused unless explicitly forced to re-run.
  - **Prototype's cache key is filename-based** (track's filename stem + model name), **not content-based**. This is a known limitation: two different files with the same name collide, and edits to a file under the same name are not auto-detected as requiring re-separation.
  - **Staleness detection implemented:** a fingerprint (file size + mtime) is recorded alongside cached stems at separation time. On every subsequent access, if the source file's current size/mtime don't match the recorded fingerprint, the engine warns (non-destructively — it does not auto-invalidate or auto-delete anything) that stems may be stale and a forced re-separation may be needed. A production engine should upgrade this to a content hash if source files are likely to be replaced-in-place under the same name.
  - Cache must **not** silently overwrite existing stems; only an explicit force flag/action may trigger re-separation of an existing cache entry.

### 3.2 Stem inventory

Given a track + model, the engine must be able to report which stems currently exist on disk (name, duration, sample rate). This should be a **directory listing**, not a static list derived from the model name — because derived stems (§3.4) get added to the same location after the fact and must show up automatically.

### 3.3 Mixdown / export

**Inputs:**
- Track + model (selects which cached stem set to read from)
- A per-stem linear gain map (default 1.0 = unity for every available stem)
- Optionally, a set of **time-limited mute ranges** per stem (§3.3.2)
- A target loudness in LUFS (default **-14.0**)
- Output format: WAV or MP3

**Algorithm:**
1. For every stem with non-zero effective gain, read its audio.
2. Validate all stems share a sample rate (reject/error on mismatch — do not silently resample).
3. Apply the stem's static gain (multiply).
4. Apply the stem's time-range mute envelope, if any (§3.3.2).
5. Sum all processed stems into one buffer. Pad the shorter of any two mismatched-length arrays with trailing silence before summing (stems from the same separation run should always match length in practice, but don't assume it).
6. **Loudness-normalize** the summed mix to the target LUFS (§3.3.1).
7. **Peak-safety clamp:** if any sample in the normalized mix exceeds 0 dBFS (peak > 1.0), scale the entire mix down so peak lands at 0.98 (i.e. ~-0.2 dBFS headroom). This is a last-resort linear scale, not a limiter/compressor — it only fires when normalization pushes a quiet mix up far enough to clip.
8. Write output: WAV natively; MP3 via an intermediate WAV + external encode (ffmpeg `-q:a 2` in the prototype) since no pure-Python/Swift MP3 encoder was used.

#### 3.3.1 Loudness normalization

Uses ITU-R BS.1770-style integrated loudness metering (the prototype uses `pyloudnorm`). Steps:
- Measure integrated loudness of the full summed mix.
- If finite (i.e. the mix isn't effectively silent), compute `gain_db = target_lufs - measured_lufs` and apply `10^(gain_db/20)` as a linear multiplier to the whole mix.
- If the mix is silent (measured loudness is `-inf`), skip normalization rather than dividing by zero / amplifying noise.

**⚠️ Known open issue, not yet resolved:** gain corrections observed in testing ranged from small (±1 dB) up to **very large** (+20 to +25 dB) on quiet stems/combinations (e.g. isolated guitar solos). Large corrective gain appears to make residual separation artifacts (see §4) more audible, contributing to a "processed"/artificial character users can hear in some exports. A production engine should consider:
- Making normalization optional, or applying a **maximum gain correction cap** (e.g. never boost more than +10 dB) rather than always hitting the exact target.
- Normalizing once per *track* (based on a representative full mix) rather than independently per export, so quiet solo/derived exports don't get pushed disproportionately loud relative to their actual source material.
- This needs A/B listening tests to isolate from the separately-known Demucs artifact issue (§4) before deciding on a fix.

#### 3.3.2 Time-limited stem muting

Allows a stem to be silenced only within specific time windows rather than for the whole track (e.g. muting just a guitar solo section, leaving the instrument audible elsewhere). Multiple ranges per stem are supported (e.g. two separate solos).

**Algorithm** (per stem, per mute range `[start_sec, end_sec)`):
1. Convert start/end seconds to sample indices at the stem's sample rate.
2. Build a per-sample gain envelope, initialized to 1.0 everywhere.
3. Apply a linear fade **down** to 0.0 over a short window (**30ms**) immediately before `start`, hold at 0.0 through the range, then fade **up** to 1.0 over 30ms after `end`. This is essential — a hard instantaneous cut produces an audible click; validated by measuring the muted region at ~-91 dBFS (effectively silent) while the surrounding fade-in/out regions remained clean.
4. When multiple ranges are given for the same stem, combine by taking the minimum envelope value at each sample (so overlapping/adjacent ranges don't fight each other).
5. Multiply the stem's audio by this envelope (per-channel) before summing into the mix.

Timestamps should be accepted in multiple human-friendly formats: `M:SS`, `H:MM:SS`, or raw seconds.

### 3.4 Experimental: guitar lead/rhythm split

**Motivation:** users want to mute a lead guitar solo while keeping rhythm guitar audible (a feature seen in commercial apps). No off-the-shelf source-separation model performs true *timbral* lead-vs-rhythm separation — to a model, "guitar" is one class; "lead" vs "rhythm" is a mix *role*, not a distinct sound. This is explicitly a heuristic based on **stereo panning position**, not a real separation model, and its success is highly mix-dependent.

**Precondition:** requires a stereo guitar stem (from a model that isolates guitar, e.g. `htdemucs_6s`).

**Two algorithms, both should be implemented (results differed meaningfully by track in testing):**

**(a) `midside` — whole-track, fixed weighting:**
```
mid  = (L + R) / 2      # → "center" proxy
side = (L - R) / 2      # → "sides" proxy
```
Output stems are reconstructed as stereo: `center = [mid, mid]`, `sides = [side, -side]` (phase-inverted pair, standard for reconstructing a "sides-only" signal with stereo width).

**(b) `spectral` — frequency-adaptive weighting (default; generally performed better in testing):**
1. STFT both channels. Prototype parameters: window size 4096 samples, hop = 1/4 window (75% overlap). Window size should shrink automatically for very short inputs.
2. Per time/frequency bin, compute a **balance** ratio `|L|/(|L|+|R|)` (0.5 = perfectly centered, 0 or 1 = hard-panned to one side).
3. Convert to a **centeredness** weight: `1 - 2*|balance - 0.5|` → 1.0 for fully centered bins, 0.0 for fully panned bins.
4. Compute `mid_f = (L_f + R_f)/2` and `side_f = (L_f - R_f)/2` in the frequency domain.
5. Weight: `center_f = centeredness * mid_f`, `sides_f = (1 - centeredness) * side_f`.
6. Inverse-STFT both back to time domain; pad/trim to exactly match the original sample count (ISTFT framing can shift length slightly).
7. Reconstruct stereo outputs the same way as (a): `[center, center]` and `[sides, -sides]`.

**Output:** two new derived stems, `<stem>_center.wav` and `<stem>_sides.wav`, written alongside the original stems and immediately usable in mixdown exactly like any other stem (§3.2's directory-listing approach picks them up automatically).

**Diagnostics:** the prototype computes and reports the raw inter-channel Pearson correlation of the source stem as an FYI figure. **This was empirically found to NOT reliably predict split quality** across 5 real songs tested (the lowest-correlation track failed; the highest-correlation track worked well) — it must not be used as an automated accept/reject gate. Quality can only currently be judged by listening.

**Validation results (informal, single-listener, 5 real songs — for context, not to be treated as a general accuracy claim):**

| Track | Correlation | `midside` result | `spectral` result |
|---|---|---|---|
| Scream Aim Fire | -0.09 | worked (lead faint but acceptable) | good |
| Sultans of Swing | 0.64 | good | good |
| Moonlight Shadow | 0.40 | worked (lead less suppressed) | good |
| Wrathchild (Iron Maiden) | 0.19 | did not work well | OK (improved) |
| Killers (Iron Maiden) | 0.13 | not tested | not good |

**Working hypothesis for the Iron Maiden failures:** the band is known for **twin/harmonized lead guitars**, likely mixed panned apart from each other rather than one part dead-center — which breaks the "center = lead" assumption at the root, since neither lead nor rhythm may sit cleanly in "center." Not yet confirmed; worth testing directly (e.g. does `guitar_sides` on these two tracks contain *two* distinguishable lead lines rather than rhythm?).

**Important semantic caveat:** neither `_center` nor `_sides` is guaranteed to correspond to "lead" or "rhythm" — that mapping is a *guess*, not a guarantee, and was found to be inconsistent in this testing. The engine and any UI built on it must present both as unlabeled candidates for the user to audition, not assert one is definitely the lead.

### 3.5 Output organization

For browsing/deliverable purposes, all stems and all mixdown exports for a given track should be collected into **one folder per track**, distinct from the internal cache:

- **Cache (source of truth for the mixing engine):** namespaced by model, e.g. `<cache_root>/<model>/<track_name>/*.wav`. This is what §3.1–3.3 actually read from.
- **Output/browse folder (convenience copy):** `<output_root>/<track_name>/`, containing:
  - A copy of every stem that's been separated for that track, across every model that's been run, **prefixed by model name** to avoid collisions (both `htdemucs` and `htdemucs_6s` produce a `bass.wav`, `drums.wav`, etc. — these are different audio and must not overwrite each other).
  - Every mixdown exported for that track.
- A bare output filename (no path separator) should resolve into this per-track output folder automatically; an explicit path should be respected as-is. This removes the need for the caller to manually construct `output/<track>/...` paths for every export.

---

## 4. Known limitations / lessons learned (carry these forward)

- **Demucs separation has an inherent quality ceiling.** Even with zero muting (all stems included at unity gain), recombining separated stems does not perfectly reconstruct the original mix — there's a mild but perceptible "processed"/phasey character inherent to current AI source separation. This is not something the mixing/normalization logic can fix; it should be treated as a baseline quality limit of the separation backend, and any future backend swap (fine-tuned model, paid engine, etc.) should be evaluated partly on how much it reduces this.
- **Runtime dependency fragility:** the Demucs/torch/torchaudio/torchcodec dependency chain broke between the prototype's initial pip install and actually running (`torchaudio.save()` started requiring `torchcodec`, which is not a stated Demucs dependency). Pin exact versions; do not assume "install demucs" alone is sufficient going forward.
- **ffmpeg is a hard runtime dependency** for MP3 decode/encode. A native app must bundle it or achieve equivalent functionality via a platform codec (e.g. AVFoundation on macOS) rather than shelling out.
- **Model weights download on first use** (tens of MB per model) and require network access at that moment. An offline-first app (per the app spec's non-functional requirements) needs these bundled at install time instead.
- **Loudness normalization can amplify separation artifacts** — see §3.3.1's open issue.

---

## 5. Data model summary (for a from-scratch implementation)

```
Track
  - identity: currently filename-based; should become content-hash-based
  - source file: path, size, mtime (or hash)

StemSet (one per Track × Model)
  - model: str
  - stems: [{ name: str, path/buffer, duration, sample_rate, is_derived: bool }]
  - fingerprint: { size, mtime } of the source file at separation time

MixRequest
  - track, model
  - gains: { stem_name: float }        # default 1.0, 0.0 = fully muted
  - mute_ranges: { stem_name: [(start_sec, end_sec), ...] }
  - target_lufs: float                  # default -14.0
  - output format: wav | mp3

GuitarSplitRequest
  - track, model, source_stem (default "guitar")
  - method: "midside" | "spectral"      # default "spectral"
  → produces two new entries in that track's StemSet: "<stem>_center", "<stem>_sides"
```

---

## 6. Forward-looking implications for the planned UI

The target UI (per the user's direction): select a track → choose operations → play the result → **toggle stems on/off live during playback**, GarageBand-mixer style → eventually monitor a **live USB guitar input** alongside playback.

This has real architectural consequences the engine should be designed around now, rather than retrofitted later:

1. **Static rendering is not enough.** Everything specified above produces a *rendered file*. Live stem on/off toggling means the playback layer needs each stem loaded as an **independent audio source with its own live gain node** (e.g. an `AVAudioEngine` graph with one player node + mixer input per stem), so a toggle is an instant parameter change, not a re-render. The engine's job becomes: produce the *stem files*, and hand a stem manifest (§5's `StemSet`) to a separate real-time playback layer — the batch "mixdown to one file" path (§3.3) should remain available for **export**, but should not be the mechanism the live mixer UI uses for on/off toggling.
2. **Time-range muting (§3.3.2) maps naturally to a mute-automation lane** in a timeline UI (paint mute regions under each stem's waveform) — worth designing the UI's data model to reuse the same `(stem, start, end)` representation the engine already uses, rather than inventing a parallel one.
3. **Derived stems (§3.4) must be first-class** in the live mixer once generated — same on/off toggle, same gain node — not a special case bolted on separately from real Demucs stems.
4. **Guitar input (Step 2, out of scope here) will likely share the same audio graph** as this playback engine in the final app (backing track playback + live guitar monitoring running concurrently so the user can play along). Design the playback layer's audio engine ownership so it can coexist with an input monitoring chain in the same process/graph, rather than assuming playback owns the entire audio session exclusively.
5. **A persistent project format is required** for "pick a track, do some processing, come back later and keep switching stems on/off" to survive an app restart — this does not exist yet (flagged in the original app spec §2.1 requirement 1.6) and should be designed alongside the `StemSet`/`MixRequest` data model in §5, not as an afterthought.

---

## 7. Out of scope for this document

- UI/visual design
- Live guitar tone matching (Step 2 of `backing-track-tone-match-spec.md`)
- Persistent project file format (flagged above as required, but not designed here)
- Automated/objective quality scoring of the guitar split (currently manual listening only)

---

## Appendix: current CLI reference behavior

The prototype (`backing_track.py`) is a Python CLI exposing this engine as four subcommands. This is **not** the interface a production engine should necessarily expose (a library/service API is more appropriate for the app in §6) — it's included here so the exact current, validated behavior is unambiguous for anyone reimplementing it.

| Command | Purpose | Key flags |
|---|---|---|
| `separate <input>` | Run separation, populate cache + output folder | `--model`, `--force` |
| `list <input>` | List stems on disk for a track/model | `--model` |
| `split-guitar <input>` | Run §3.4 on a stem | `--model`, `--stem`, `--method` |
| `mix <input>` | Render a mixdown per §3.3 | `--model`, `--mute`, `--gain`, `--mute-range`, `--target-lufs`, `-o` |

Full flag semantics are documented in `README.md` in this repository.
