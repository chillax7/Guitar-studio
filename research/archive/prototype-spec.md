# Backing Track Studio — Prototype Build Spec

**Purpose:** a hand-to-a-developer spec to build a working **prototype** of the macOS app described in `ui-spec.md`, reusing the validated Python engine (`backing_track.py` / `engine-spec.md`). This is the buildable, opinionated version: concrete stack, project layout, IPC protocol, audio graph, packaging, and a milestone order.

**Companion docs:** `engine-spec.md` (audio DSP — do not re-derive it here), `ui-spec.md` (full UI/interaction design), `backing-track-tone-match-spec.md` (product vision / Step 2).

---

## 0. Locked decisions (rationale)

| Decision | Choice | Why |
|---|---|---|
| App shell | **Native SwiftUI + embedded Python engine** | Real-time playback/toggling needs native audio (AVAudioEngine); Python reused as-is for batch jobs. |
| Track identity | **App owns content-hash; engine stays filename-keyed** | Latency-neutral; zero engine rewrite; identity lives with the `.btrack` project the app already owns. |
| Packaging | **Notarized direct-download, Python bundled via PyInstaller** | Mac App Store sandbox historically throttles low-latency Core Audio + bundled ML subprocesses. Better for the future live-guitar path and easier now. |
| Engine transport | **Persistent subprocess, newline-delimited JSON (JSONL) over stdio** | One long-lived process (not per-command); simple, no ports, no network. |
| Real-time path | **AVAudioEngine owns playback; engine never in the RT path** | Engine produces stem WAVs + manifest; Swift plays them. Engine's `mix` used only for file export. |

---

## 1. Prototype scope

**In (must work end-to-end):**
- Import an audio file (MP3/WAV/FLAC) via drag-and-drop or file picker.
- Separate with `htdemucs` (4-stem) and `htdemucs_6s` (6-stem), cached, non-destructive, with staleness detection.
- Live stem mixer: per-stem mute / solo / gain fader, synced multi-lane waveform + playhead, transport (play/pause/stop, loop region).
- Time-range muting painted as regions, previewed live, honored on export.
- Guitar lead/rhythm split (`spectral` default + `midside`), results shown as unlabeled **Candidate A/B**.
- Export mixdown → WAV / MP3 with target LUFS, optional normalize + max-boost cap.
- Save / reopen a `.btrack` project.

**Out (prototype stubs or deferred):**
- Step 2 live tone matcher — a **disabled placeholder screen only** (device picker + FX rack chrome, no audio). Architected-for, not built.
- Cloud separation, model management UI beyond "is it installed," per-track (vs per-export) loudness normalization, multi-window.

---

## 2. Technology stack

**Front end**
- Swift 5.9+, SwiftUI, macOS 14 (Sonoma) minimum, Apple Silicon.
- AVFoundation / AVAudioEngine (playback, mixing, export tap).
- Accelerate/`AVAudioFile` for waveform peak extraction.

**Embedded engine (bundled, unchanged logic)**
- Python 3.11, the existing `backing_track.py` functions wrapped in a JSONL service (`engine_service.py`).
- Demucs (HTDemucs family), `pyloudnorm`, `numpy`, `scipy` (STFT for the spectral split), `soundfile`.
- **ffmpeg** binary bundled for MP3 decode/encode.
- **Pin exact versions** of torch / torchaudio / torchcodec (engine-spec §4 — this chain broke mid-build once already). Freeze a working `requirements.lock`.
- Model weights **bundled at build time** (offline-first) — do not rely on first-run download.

---

## 3. Repository layout

```
BackingTrackStudio/
├── app/                          # Xcode project (SwiftUI)
│   ├── BackingTrackStudio/
│   │   ├── App.swift
│   │   ├── Audio/
│   │   │   ├── PlaybackEngine.swift      # AVAudioEngine graph
│   │   │   ├── StemPlayer.swift          # one player+gain per stem
│   │   │   └── WaveformCache.swift
│   │   ├── Engine/
│   │   │   ├── EngineClient.swift        # spawns + talks JSONL to Python
│   │   │   └── EngineTypes.swift         # Codable request/response
│   │   ├── Model/
│   │   │   ├── Project.swift             # .btrack model (mirrors engine §5)
│   │   │   ├── Track.swift  Stem.swift  MixState.swift
│   │   ├── Views/
│   │   │   ├── LibrarySidebar.swift
│   │   │   ├── Workspace.swift  MixerLane.swift  Transport.swift
│   │   │   ├── TimelineMuteLane.swift
│   │   │   ├── GuitarSplitPanel.swift  ExportSheet.swift
│   │   │   └── PlayAlongStub.swift
│   │   └── Resources/
│   └── BackingTrackStudio.xcodeproj
├── engine/                       # Python
│   ├── backing_track.py          # existing, unchanged
│   ├── engine_service.py         # NEW: JSONL stdio service (thin wrapper)
│   ├── requirements.lock
│   └── build_engine.sh           # PyInstaller → onedir binary
├── vendor/
│   ├── ffmpeg                     # bundled binary
│   └── models/                    # bundled demucs weights
└── scripts/
    ├── bundle.sh                  # copy engine binary + ffmpeg + models into .app
    └── notarize.sh
```

---

## 4. Embedded engine service (`engine_service.py`)

A **thin** wrapper — it must not reimplement any DSP. It imports the existing functions from `backing_track.py` and exposes them over JSONL on stdio.

### 4.1 Wire protocol

- Transport: newline-delimited JSON on **stdin (requests)** / **stdout (responses + progress)**. `stderr` is free-form logging only.
- Request: `{"id": <int>, "method": <str>, "params": {…}}`
- Progress notification (zero or more, same `id`, non-terminal): `{"id": …, "event": "progress", "phase": <str>, "fraction": <0..1|null>, "message": <str>}`
- Terminal success: `{"id": …, "event": "result", "result": {…}}`
- Terminal error: `{"id": …, "event": "error", "error": {"code": <str>, "message": <str>}}`
- One request may be in flight per `id`; the app may pipeline different ids.

### 4.2 Methods (each maps to an existing engine capability)

```jsonc
// ── ping ──────────────────────────────────────────────
req  { "method": "ping" }
res  { "result": { "engine": "0.1", "ffmpeg": true,
                   "models_installed": ["htdemucs","htdemucs_6s"],
                   "torch_ok": true } }

// ── separate ──────────────────────────────────────────
req  { "method": "separate",
       "params": { "source_path": "...", "model": "htdemucs_6s", "force": false } }
// streams progress: phase ∈ {loading_model, separating, writing}
res  { "result": { "cache_dir": "...", "output_dir": "...",
                   "fingerprint": { "size": 1234, "mtime": 170… },
                   "stems": [ { "name":"guitar","path":"...","duration":348.2,
                                "sample_rate":44100,"is_derived":false }, … ] } }

// ── list_stems ────────────────────────────────────────
req  { "method": "list_stems", "params": { "source_path":"...", "model":"htdemucs_6s" } }
res  { "result": { "stems": [ …same shape as above… ],
                   "stale": false } }          // stale ← fingerprint mismatch (§3.1)

// ── split_guitar ──────────────────────────────────────
req  { "method": "split_guitar",
       "params": { "source_path":"...", "model":"htdemucs_6s",
                   "source_stem":"guitar", "method":"spectral" } }
res  { "result": { "new_stems": [ {"name":"guitar_center", …},
                                  {"name":"guitar_sides", …} ],
                   "correlation": 0.64 } }      // FYI diagnostic only — never a gate

// ── mix (export only) ─────────────────────────────────
req  { "method": "mix",
       "params": { "source_path":"...", "model":"htdemucs_6s",
                   "gains": { "vocals":0.0, "guitar":1.0, … },
                   "mute_ranges": { "guitar_center": [[72.0,96.5]] },
                   "target_lufs": -14.0, "normalize": true, "max_boost_db": 10.0,
                   "format": "wav", "output_name": "Song - backing.wav" } }
// streams progress: phase ∈ {reading, summing, normalizing, encoding, writing}
res  { "result": { "output_path": "...", "measured_lufs": -22.1,
                   "applied_gain_db": 7.9, "boost_capped": false,
                   "peak_clamped": false } }
```

### 4.3 Engine-side rules the wrapper must honor (all already in `engine-spec.md`)
- **`normalize` + `max_boost_db`** are new params over today's CLI: when `normalize` is true, compute `target - measured`, then clamp the boost to `max_boost_db` before applying; report `boost_capped`. When false, skip normalization entirely (§3.3.1). This is the one small engine addition the prototype needs.
- Reject sample-rate mismatch across stems (no silent resample). Return error `code:"sample_rate_mismatch"`.
- Silent mix (`-inf` LUFS) → skip normalization, `applied_gain_db: 0`.
- 30 ms fades on mute ranges; min-envelope combine for overlaps.
- Never overwrite cache without `force`. Staleness = fingerprint (size+mtime) mismatch, warn-only.
- Discover stems by **directory listing**, so derived stems appear automatically.

### 4.4 Progress for `separate`
Demucs runs as a subprocess (matches validated behavior). Parse its stderr progress if present; otherwise emit coarse `phase` events (`loading_model` → `separating` (fraction null/indeterminate) → `writing`). Prototype-acceptable: an indeterminate bar plus the ~¼-of-song-length ETA from `ui-spec.md` §4.1.

---

## 5. Swift app

### 5.1 Audio graph (`PlaybackEngine.swift`) — the latency-sensitive core

```
                     ┌── StemPlayer (vocals) ── AVAudioPlayerNode ─┐
 AVAudioEngine       ├── StemPlayer (drums) ─────────────────────── ┤
   (single, shared)  ├── StemPlayer (bass) ─────────────────────────┤─► mainMixerNode ─► outputNode
   session NOT       ├── StemPlayer (guitar) ───────────────────────┤       │
   exclusively owned ├── StemPlayer (guitar_center) ────────────────┤   (level meter tap)
   → Step 2 input    └── … one per stem, incl. derived …────────────┘
   node can join later
```

- **One `AVAudioPlayerNode` + one `AVAudioMixerNode` input per stem.** Gain = mixer input `volume`. Mute = `volume 0`. Solo = others to 0 (monitoring only; does not alter export recipe).
- **Sample-synced start:** schedule every player node with the same future `AVAudioTime` (`lastRenderTime + small offset`) so lanes stay phase-locked (stems share length/SR from one separation run).
- **Loop region:** schedule buffer segments for the loop window; reschedule on loop.
- **Live mute regions:** drive mixer-input volume via a playhead-synced ramp (target the engine's 30 ms fade) using a render-thread-safe scheduled ramp or a high-rate timer on the audio queue. **Prototype note:** this preview is *perceptually* matched, not bit-identical to the engine's export — acceptable for v1 (flagged in `ui-spec.md` §15.1). Export always goes through the Python `mix` for the exact result.
- **Do not let playback assume it owns the whole audio session.** Keep the engine instance and its lifecycle separable so a future input node + FX chain (Step 2) can attach to the *same* `AVAudioEngine` (engine-spec §6.4). This is the one forward-looking constraint the prototype must not violate.
- Waveforms: precompute min/max peak bins per stem off the main thread into `WaveformCache`; render with a SwiftUI `Canvas`.

### 5.2 Engine client (`EngineClient.swift`)
- Spawn the bundled Python binary as a `Process` at app launch; keep it alive.
- Write JSONL to its stdin; read stdout on a background thread, split on `\n`, decode, route by `id`.
- Expose async methods (`separate`, `listStems`, `splitGuitar`, `mix`, `ping`) returning results and publishing progress via an `AsyncStream`/Combine subject the views subscribe to.
- On `ping` failure or process exit, surface an "engine failed to start" state (Settings + a blocking dialog before any export) — engine-spec §4 dependency fragility must be visible, never silent.

### 5.3 State model
- `Project` (the `.btrack` document) mirrors engine-spec §5: `track` (source path, content-hash identity, size/mtime fingerprint), `model`, `stemSet[]`, `mix` (gains, mute_ranges, target_lufs, normalize, max_boost_db), `ui` (viewMode, loop, laneRenames).
- `MixState` is the single source of truth shared by the live audio graph **and** the export call — "export bounces exactly what you hear" (`ui-spec.md` §5.4).

### 5.4 Views
Build the ones in `ui-spec.md`: `LibrarySidebar`, `Workspace` (Mixer/Timeline segmented), `MixerLane`, `Transport`, `TimelineMuteLane`, `GuitarSplitPanel`, `ExportSheet`, `PlayAlongStub`. Honesty cues are required, not optional: staleness banner (§4.4), Candidate-A/B labeling with the "not guaranteed lead/rhythm" note (§7.3), the normalization-artifact note near the boost cap (§8), and the separation quality-ceiling note (§8.1).

---

## 6. Project file format (`.btrack`)

A document bundle (package directory):

```
Song.btrack/
  project.json      # the Project model above
  thumbnail.png
  # stems are referenced by path into the shared cache, not copied in
```

- **Identity is content-hash** (app-computed, e.g. SHA-256 of the source file), stored alongside the size/mtime fingerprint. The hash is the app's project identity; the engine is still called with the plain `source_path` (locked decision §0).
- Reopening restores full mixer state, mute regions, loop, view mode, and lane renames without re-separating.
- The app compares the current source file's size/mtime to the stored fingerprint on open → drives the staleness banner. Re-separation is the only overwrite path and always explicit (engine `force:true`).

---

## 7. Real-time / latency notes

- **Step 1 playback is file-based**, so buffer size is not latency-critical here; use a comfortable default. Do **not** hardcode assumptions that block small buffers later.
- The single-`AVAudioEngine`, non-exclusive-session design (§5.1) is the deliberate low-latency investment: when Step 2 adds a live USB guitar input node + real-time FX, it joins this same graph rather than fighting a second audio session — the packaging choice (§0, notarized direct-download) keeps Core Audio low-latency device access unobstructed.
- Keep the Python engine strictly off the real-time path (it's batch-only). Nothing the audio render thread does may block on IPC.

---

## 8. Packaging & build

1. **Freeze the engine:** create `requirements.lock` with exact torch/torchaudio/torchcodec + Demucs versions known to run (engine-spec §4). Verify `torchaudio.save()` works with the pinned `torchcodec`.
2. **Build the engine binary:** `build_engine.sh` runs PyInstaller (`--onedir`) over `engine_service.py`, producing a self-contained folder. Bundle `ffmpeg` and the Demucs model weights alongside.
3. **Embed in the app:** `bundle.sh` copies the engine onedir + ffmpeg + models into `BackingTrackStudio.app/Contents/Resources/engine/`. `EngineClient` launches the binary from there.
4. **Sign & notarize:** hardened runtime; sign the app, the embedded Python binary, ffmpeg, and dylibs; notarize; staple. Ship as a notarized DMG (direct download, not App Store).
5. **Offline check:** on a network-disabled machine, confirm separation runs from bundled weights (no download).

---

## 9. Build milestones (recommended order)

1. **Engine service skeleton.** `engine_service.py` with `ping` + `list_stems`; PyInstaller build; a tiny Swift `EngineClient` that spawns it and round-trips `ping`. Proves the embedded-Python bridge end-to-end.
2. **Separate + inventory.** `separate` with progress; Library sidebar + import + the §4.1 Separate CTA; staleness fingerprint plumbed.
3. **Live mixer.** AVAudioEngine graph, per-stem player+gain, waveforms, transport, mute/solo/fader, loop. No export yet.
4. **Export.** `mix` with normalize + max-boost cap; ExportSheet; WAV then MP3.
5. **Time-range muting.** Timeline mode, paint/edit regions, live preview ramp, export honors ranges.
6. **Guitar split.** `split_guitar` (spectral + midside); Candidate A/B lanes + audition; honest labeling.
7. **Persistence.** `.btrack` save/open; content-hash identity; restore full state.
8. **Play Along stub + packaging.** Disabled Step 2 screen; sign/notarize/DMG; offline verification.

A usable demo exists after milestone 4; the full prototype after 8.

---

## 10. Acceptance tests

Functional gates per milestone, plus these engine-behavior checks (from `engine-spec.md`, using known-good material):

- **Separation cache:** re-running `separate` without `force` reuses cache; with `force` re-runs. Changing the source file's mtime surfaces the staleness banner and does **not** auto-delete anything.
- **Round-trip quality:** all stems at unity, nothing muted → export is recognizably the song (accepting the mild "processed" character — this is the baseline ceiling, not a bug).
- **Time-range mute:** muted region measures ≈ −91 dBFS with clean 30 ms fades and no clicks; instrument audible outside the region.
- **Guitar split (spectral):** on **Sultans of Swing**, **Scream Aim Fire**, and **Moonlight Shadow**, the split produces `guitar_center`/`guitar_sides` that audibly differ and give a usable lead/rhythm separation. (These are the validated-good tracks; the Iron Maiden twin-lead tracks are the known-hard cases — see engine-spec §3.4. Do **not** gate on the correlation number.)
- **Loudness:** an isolated quiet solo mix respects the +10 dB boost cap; report shows `boost_capped:true` when hit; peak clamp keeps output ≤ 0 dBFS.
- **Live == export:** the file exported from a given mixer state matches what was heard (mute/solo/gain/regions), solo excepted.
- **Offline:** full separate→mix flow works with networking disabled.

---

## 11. Carry-forward risks (from engine-spec, restated for the builder)

- torch/torchaudio/torchcodec chain is fragile — pin and lock, test `torchaudio.save()` explicitly.
- ffmpeg is a hard dependency for MP3 — bundle it (or use AVFoundation encode on the Swift side as an alternative for export).
- Model weights are tens of MB and download on first use — bundle them for offline-first.
- Loudness normalization can amplify separation artifacts — the max-boost cap is the prototype mitigation; leave normalization toggleable.
- Guitar split is a panning heuristic, not real separation — never assert which candidate is lead/rhythm.

---

*Build this against `ui-spec.md` for exact screen/interaction detail and `engine-spec.md` for exact DSP behavior. This document is the glue: stack, protocol, packaging, and order.*
