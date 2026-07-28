# Application Specification: Backing Track Creator & Guitar Tone Matcher (macOS)

**Version:** 0.1 (draft for research/vendor evaluation)
**Date:** July 2026

---

## 1. Purpose & Scope

A macOS application, delivered in two stages:

- **Step 1 — Backing Track Creator:** Import an MP3, separate it into isolated instrument/vocal stems using AI source separation, then let the user mute/remove selected stems (e.g. lead vocal, rhythm guitar) and export a mixed-down backing track.
- **Step 2 — Live Tone Matcher:** Take a clean guitar signal from a USB audio interface and process it in real time so it sounds tonally similar to the guitar heard in the backing track, so the user can play along with a matching tone.

These are architecturally almost separate subsystems sharing a project file and a UI shell. It's worth treating them as two products that happen to live in one app.

---

## 2. Step 1 — Backing Track Creator

### 2.1 Functional Requirements

| # | Requirement |
|---|---|
| 1.1 | Import MP3 (and ideally WAV/FLAC/AAC) files via file picker or drag-and-drop |
| 1.2 | Run source separation to produce stems: at minimum **vocals / drums / bass / other**; ideally also **guitar** and **piano** as separate stems |
| 1.3 | Per-stem mute/solo, and per-stem gain fader, with real-time preview playback |
| 1.4 | Waveform display per stem, synced playhead |
| 1.5 | Export final mixdown as WAV/MP3 with only the selected stems included |
| 1.6 | Save/reopen a "project" (original file + stem cache + mix settings) so re-separation isn't needed every session |
| 1.7 | Reasonable processing time on Apple Silicon (target: faster than real-time for a 4-minute song, ideally under 1–2 minutes) |

### 2.2 Non-Functional Requirements

- Native macOS app (Apple Silicon optimized — M-series has capable on-device ML acceleration via Core ML / Metal Performance Shaders), minimum macOS 14 (Sonoma) recommended.
- Offline-capable for the separation step (privacy + no ongoing cloud cost), though a cloud option can be offered for convenience/speed.
- Separation quality should aim for "clean enough to jam over," not necessarily mastering-grade — some bleed is acceptable for a personal backing track.

### 2.3 Technology Options (this is genuinely a solved problem — build vs. buy)

**Don't build a separation model yourself.** Wrap an existing engine:

1. **Demucs / HTDemucs (Meta, open source)** — the de facto industry standard underlying most tools below. The fine-tuned Hybrid Transformer Demucs is the modern default for clean four-stem splits, and newer BS-Roformer-family models have topped separation-quality leaderboards in 2025–2026. Runs locally, has a Python package, and Core ML conversion is feasible for a native Mac build.
2. **Ultimate Vocal Remover (UVR)** — a free, open-source GUI for running various separation models locally, on Windows, macOS and Linux. Good reference implementation to study, or could be scripted/embedded rather than reinventing the wheel.
3. **Cloud APIs** (LALAL.AI, Moises, Audioshake, AudioStrip) — AudioStrip, for example, lets you separate to vocals, instrumental, bass, drums, other, piano and guitar — useful if you want guitar/piano isolated specifically (relevant for Step 2 later). Trade-off: per-minute cost, requires internet, and your users' music gets uploaded to a third party.
4. **iZotope RX Music Rebalance** — SDK/plugin route if you want a licensed commercial engine with support, rather than open-source.

**Recommendation for a first build:** local Demucs (HTDemucs) via a bundled Python/Core ML backend, called from a native Swift front end. Free, no ongoing cost, keeps everything on-device, and quality is competitive with paid tools.

### 2.4 Suggested Architecture (Step 1)

```
SwiftUI front end (waveform view, mixer, transport controls)
        │
        ▼
AVFoundation / AVAudioEngine (playback, mixing, export)
        │
        ▼
Separation engine (bundled Python+Core ML, or a compiled
Demucs/ONNX runtime invoked as a background process)
        │
        ▼
Stem cache on disk (per-project temp folder)
```

---

## 3. Step 2 — Live Guitar Tone Matcher

This is the part worth being upfront about: **it's not an existing off-the-shelf feature.** Here's why, and what's realistic.

### 3.1 How tone-matching technology actually works today

The leading tone-capture technologies — **Neural Amp Modeler (NAM)** and **IK Multimedia's TONEX** — work by feeding a test signal into a real amplifier and training a neural network on the resulting input/output data, or using a specially prepared audio file of actual guitar and bass signals, not just test tones, to capture your rig in true-to-life detail. Both require **direct access to the actual amp/pedal you want to model**, via a DI/reamp box — not just a finished recording of someone else playing through it.

That means there is no mature, reliable pipeline that goes "here's a mixed song → here's a plugin that now makes your guitar sound like the guitar on that song." What you're describing — deriving a tone purely from a reference recording — is closer to an open research/creative problem than a shipped feature.

### 3.2 What's realistically achievable, in increasing order of ambition

**Option A — Preset matching by ear/spectral similarity (most achievable)**
- Use Step 1's separation to isolate the guitar stem from the backing track (using a guitar-capable separation model — see §2.3, option 3).
- Compare that isolated guitar's spectral/EQ profile against a library of existing amp models (NAM captures from TONE3000/ToneHunt, or TONEX's 60,000+ community Tone Models) and suggest the closest matches, similar to how "Match EQ" tools in mastering software compare spectral curves.
- The user (or app) then picks the closest-sounding preset and fine-tunes EQ/gain/effects manually.
- This is buildable now: NAM is open-source and free, its training and playback code lives in public repos (neural-amp-modeler for training, NeuralAmpModelerPlugin for real-time playback), and TONE3000 hosts thousands of free NAM profiles capturing everything from clean tones to high-gain amps that could be searched programmatically.

**Option B — AI-assisted "closest preset" with automatic parameter nudging**
- As A, but automatically apply EQ/gain adjustments on top of the chosen preset to better match the reference stem's frequency response, using standard spectral-matching DSP (comparable to "match EQ" plugins). More automation, still not a from-scratch tone reconstruction.
- Community workarounds already exist in this spirit — e.g. people using isolated guitar stems plus AI chat tools to guess at plausible TONEX pedal settings for a given song, isolating the guitar audio and attempting to match it against Tonex settings as a manual, imprecise process.

**Option C — Full reference-based neural tone transfer (research territory)**
- Train a model that takes (dry guitar input, target reference audio) and outputs a matched tone without any preset library — true "style transfer" for guitar tone.
- This does not exist as a reliable shipping product today. It would be a genuine R&D undertaking (data collection, model training, real-time inference optimization) — worth knowing before committing a roadmap to it.

**Recommendation:** design Step 2 around **Option A**, with Option B as a stretch goal, and treat Option C as a possible future research track rather than a v1 requirement.

### 3.3 Functional Requirements (Step 2, Option A/B scope)

| # | Requirement |
|---|---|
| 2.1 | Detect and select a USB audio interface as input device (Core Audio device enumeration) |
| 2.2 | Low-latency monitoring: guitar in → effects chain → output, with round-trip latency low enough to play comfortably (target **<10ms**, achievable per real-world NAM/TONEX users at small buffer sizes) |
| 2.3 | Load an amp/cab tone model (NAM `.nam` file or equivalent) into a real-time processing chain |
| 2.4 | Given a backing track project (from Step 1) with an isolated guitar stem, suggest one or more matching tone models from a local/online library |
| 2.5 | Manual override: browse and load any tone model directly, adjust gain/EQ/effects |
| 2.6 | Save a "rig" (tone model + EQ + effects settings) per backing-track project, recallable later |
| 2.7 | Basic effects chain beyond amp/cab: noise gate, EQ, compressor, delay, reverb |

### 3.4 Non-Functional Requirements

- Real-time audio thread must be lock-free / realtime-safe (no allocation, no locking) — standard Core Audio / AVAudioEngine best practice.
- Support common Class-Compliant USB audio interfaces (Focusrite Scarlett, MOTU M-series, IK Multimedia's own interfaces, etc.) with no custom drivers needed — macOS Core Audio handles low-latency routing natively with no additional driver setup required.
- Buffer size should be user-adjustable to trade latency vs. CPU stability (typical guitarist target: 64–128 samples at 44.1/48kHz).

### 3.5 Suggested Architecture (Step 2)

```
USB Audio Interface
        │  (Core Audio, class-compliant)
        ▼
AVAudioEngine input node
        │
        ▼
AudioUnit (AUv3) processing chain, on realtime thread:
   Noise Gate → NAM inference (amp/cab model) → EQ →
   Compressor → Delay/Reverb → Output
        │
        ▼
AVAudioEngine output node → interface output / headphones
```

- **Build vs. buy for the amp modeling core itself:** don't write your own neural amp modeling engine — embed the open-source **NeuralAmpModelerCore** (C++ library powering NAM), which already has real-time-safe inference code and macOS AU/VST builds you can study or link against directly, rather than reinventing amp-modeling DSP from scratch.
- **Tone model library access:** TONE3000 (formerly ToneHunt) is the largest free community library of NAM captures and could potentially be queried via API/scraping for the "suggest a match" feature — confirm their terms of use/API availability before building on it.

---

## 4. Combined App: Data Flow

```
[MP3 import] → [Stem separation] → [Mixer/export = backing track]
                         │
                         ▼
              [Isolated guitar stem]
                         │
                         ▼
           [Tone-matching suggestion engine]
                         │
                         ▼
     [User's live guitar via USB] → [Amp/cab model + FX] → [Output]
                         (monitored while backing track plays)
```

---

## 5. Key Open Questions to Resolve Before Building

1. **Separation quality on guitar specifically** — most free separation models split into vocals/drums/bass/other; "other" often bundles guitar with keys/synths. You may need a paid engine (AudioStrip, Moises Pro) or a fine-tuned model to reliably isolate guitar alone.
2. **Licensing** — Demucs (MIT-ish/open), NAM (open source), TONE3000 model library (check redistribution/API terms), any commercial SDKs (TONEX has no public SDK for third-party apps as far as current information shows — confirm directly with IK Multimedia if integration is desired).
3. **CPU budget** — running separation (Step 1) and real-time NAM inference (Step 2) concurrently on the same Mac is fine since they don't run simultaneously, but confirm minimum supported Apple Silicon chip for acceptable NAM real-time latency.
4. **How "matching" is actually validated** — decide early whether success means "plausible same-genre tone" (Option A, achievable) or "indistinguishable from the record" (Option C, not currently achievable reliably).
5. **Distribution** — Mac App Store sandboxing has historically been awkward for apps needing low-latency Core Audio device access and running bundled ML processes; a direct-download (notarized, outside the App Store) build may be simpler for v1.

---

## 6. Suggested Build Order

1. Step 1 MVP: import → Demucs separation → mixer → export. No Step 2 yet.
2. Add USB audio I/O with a *fixed* set of pre-existing NAM tone models (no reference matching) — validates the Core Audio real-time path independently.
3. Add guitar-stem isolation + "suggest closest tone model" (Option A) as the tone-matching feature.
4. Only after 1–3 are solid, evaluate whether Option B (auto EQ nudging) or Option C (true tone transfer) is worth pursuing as R&D.

---

*This spec is intended as a starting point for evaluating existing tools/SDKs and scoping build vs. buy decisions — not a final locked design.*
