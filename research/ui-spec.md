# Backing Track Studio — macOS UI Specification

**Status:** Design spec, derived from `engine-spec.md` (the built-and-validated audio engine) and `backing-track-tone-match-spec.md` (the two-stage product vision).

**Scope decision:** Full UI for **Step 1** (Backing Track Creator — the engine that exists today) plus a designed-but-unbuilt **Step 2 stub** (Live Tone Matcher) so the app shell accommodates it without re-architecture.

**Shell decision:** **Native SwiftUI front end + embedded Python engine.** The Python engine (`backing_track.py`) is bundled and reused as-is for the heavy batch work (separation, guitar split, export). The SwiftUI/AVAudioEngine layer owns the responsive UI and **real-time stem playback**, per `engine-spec.md` §6.1. The two communicate over a local JSON-RPC channel.

This document specifies *what the user sees and does*, and the contract between the UI and the embedded engine. It does not restate the DSP algorithms — those live in `engine-spec.md`.

---

## 1. Design goals

1. **Expose every engine capability** — separate, list/inventory, guitar lead/rhythm split, mixdown/export with per-stem gain, full-track mute, time-range muting, loudness target — through direct-manipulation UI, not a command console.
2. **GarageBand-familiar mental model.** A track is a vertical stack of stem lanes; each lane has a waveform, a mute/solo/fader header, and paintable mute regions. Anyone who has used a DAW should be productive in minutes.
3. **Live toggling, not re-rendering.** Muting/unmuting a stem or nudging a fader during playback is an instant audio-graph parameter change (§6.1 of the engine spec). Export ("bounce to file") is a separate, explicit action.
4. **Honesty about limitations.** The separation quality ceiling (§4), the guitar-split "candidate, not guaranteed lead/rhythm" caveat (§3.4), and the loudness-normalization artifact issue (§3.3.1) are surfaced *in the UI* — not hidden — so the user's expectations match reality.
5. **Offline-first.** No network required after install. Model weights bundled; ffmpeg (or AVFoundation codecs) bundled.

---

## 2. Architecture overview (UI ↔ engine)

```
┌───────────────────────────────────────────────────────────┐
│ SwiftUI app (Backing Track Studio.app)                     │
│                                                            │
│  ┌── UI layer (SwiftUI) ──────────────────────────────┐    │
│  │  Library · Workspace · Mixer · Timeline · Export   │    │
│  └───────────────┬────────────────────┬───────────────┘    │
│                  │                     │                    │
│   real-time      │                     │  batch / async     │
│                  ▼                     ▼                    │
│  ┌── AVAudioEngine graph ──┐   ┌── Engine client ───────┐  │
│  │ 1 player node + gain    │   │ JSON-RPC over stdio to  │  │
│  │ + mixer input per stem  │   │ bundled Python process  │  │
│  │ + master + level meter  │   └───────────┬─────────────┘  │
│  │ (Step 2: + input node)  │               │                │
│  └─────────────────────────┘               │                │
└─────────────────────────────────────────────┼──────────────┘
                                              ▼
              ┌── Embedded Python engine (bundled venv/PyInstaller) ──┐
              │  separate · list · split-guitar · mix   (engine-spec) │
              │  Demucs + pyloudnorm + ffmpeg, all bundled            │
              └──────────────────┬───────────────────────────────────┘
                                 ▼
                    Stem cache  +  per-track output folder  +  .btrack project
```

**Division of labor:**

| Job | Owner | Why |
|---|---|---|
| Import, browse, transport, faders, live mute/solo | SwiftUI + AVAudioEngine | Must be instant; native audio is real-time-safe |
| Waveform rendering | SwiftUI (from stem WAVs) | Native, GPU-cheap |
| Separation, guitar split, file export/encode | Python engine (async) | Reuse validated code; these are batch jobs anyway |
| Loudness metering / normalization on export | Python engine | Already implemented (`pyloudnorm`) |
| Project persistence | SwiftUI (writes `.btrack`), engine reads manifest | UI owns session state |

The engine runs as a **long-lived subprocess** launched at app start (not one process per command), so separation state and cache awareness persist across operations within a session. Progress and log lines stream back over the same channel.

---

## 3. Information architecture & navigation

Single-window, three-region layout (standard macOS document app):

```
┌────────────┬──────────────────────────────────────┬─────────────┐
│  SIDEBAR   │            MAIN CANVAS                │  INSPECTOR  │
│            │                                       │             │
│ Library    │  Toolbar / transport                 │ Context     │
│  · Track A │  ┌─────────────────────────────────┐ │ panel for   │
│  · Track B │  │ Stem lane   ▸ waveform          │ │ current     │
│  · Track C │  │ Stem lane   ▸ waveform          │ │ selection   │
│            │  │ Stem lane   ▸ waveform          │ │ (stem /     │
│ + Import   │  │ ...                             │ │  export /   │
│            │  └─────────────────────────────────┘ │  split)     │
│ [Play      │  Master strip + LUFS readout          │             │
│  Along]    │                                       │             │
└────────────┴──────────────────────────────────────┴─────────────┘
```

**Sidebar** — the Library: every imported track/project as a row (thumbnail waveform, title, model badge, "separated / not separated" status). Drag-and-drop target for audio files. A `Play Along` entry at the bottom opens the Step 2 stub.

**Main canvas** — the workspace for the selected track. Its content depends on track state (see §4 states) and the active view mode (Mixer / Timeline).

**Inspector** — right-hand contextual panel. Shows details/controls for whatever is selected: a stem (gain, mute, split origin, file info), the export settings, or the guitar-split setup. Collapsible.

**View modes** (segmented control in toolbar):
- **Mixer** — channel-strip emphasis, compact waveforms. Best for quick "which stems are in the backing track" work.
- **Timeline** — tall waveforms with paintable mute-region lanes. Best for surgical time-range muting (§3.3.2).

Both modes share the same underlying stem list, transport, and selection.

---

## 4. Track lifecycle & main-canvas states

A track moves through states; the canvas adapts.

### 4.1 Imported, not yet separated
Canvas shows a large **Separate** call-to-action:
- **Model picker** (dropdown) with plain-language descriptions of what each yields:

  | Model | Label shown | Stems |
  |---|---|---|
  | `htdemucs` | "Standard (4 stems) — fastest, default" | vocals, drums, bass, other |
  | `htdemucs_ft` | "Standard, fine-tuned (4 stems) — slower, cleaner" | vocals, drums, bass, other |
  | `htdemucs_6s` | "Extended (6 stems) — adds guitar & piano" | vocals, drums, bass, guitar, piano, other |
  | `mdx` / `mdx_extra` | "Alternative engine (4 stems)" | vocals, drums, bass, other |

  A note under the picker: *"Choose Extended (6 stems) if you want to isolate or split guitar."* This is the discoverability hook for the guitar-split feature.
- Primary button: **Separate**. Estimated time shown (≈¼–⅕ of song length on Apple Silicon; e.g. "~1 min for a 4-min song").
- The model list is **not hardcoded UI** — it's populated from the engine's model table so future models appear automatically (mirrors the engine's "discover from disk" philosophy, §3.5).

### 4.2 Separating (in progress)
- Progress bar with phase text (loading model / separating / writing stems) and elapsed/remaining estimate.
- Cancelable.
- Non-blocking: the user can switch to other tracks in the sidebar; the job continues.

### 4.3 Separated (the main working state)
Full mixer/timeline appears — this is §5.

### 4.4 Stale (source file changed)
If the source file's size/mtime no longer match the fingerprint recorded at separation (engine-spec §3.1), a **non-destructive amber banner** appears above the canvas:

> ⚠️ The source file for this track has changed since it was separated. Existing stems may not match the current file. **[Re-separate]** **[Dismiss]**

Nothing is auto-invalidated or deleted — matching the engine's non-destructive staleness policy. Re-separate is the only path that overwrites, and it's explicit (maps to the engine's `force` flag).

---

## 5. The stem mixer (core screen)

Each stem is a **lane**. Lanes are listed in a stable, meaningful order (vocals, drums, bass, guitar, piano, other, then derived stems). The lane list is a **directory listing of what exists on disk** (engine-spec §3.2) — so derived guitar stems (§7) and any future model's stems appear automatically without UI changes.

### 5.1 Lane header (channel strip)
Per stem, left of the waveform:

- **Stem name + icon** (mic / drum / bass / guitar / piano / waveform-generic).
- **Mute** button (M) — real-time; toggles that stem's gain node to 0 instantly.
- **Solo** button (S) — real-time; mutes all others. Solo is a *monitoring* convenience and does not itself change what gets exported (see §5.4).
- **Gain fader** (vertical or horizontal) — linear gain, default unity (1.0). Maps directly to the engine's per-stem gain map. Range presented in dB with a unity detent; 0.0 = "off".
- **Per-stem level meter** during playback.
- **Derived-stem badge** if applicable (e.g. "from guitar · spectral") with a link back to the split panel.

### 5.2 Waveform
- Rendered natively from the stem WAV.
- Shared horizontal time axis with a synced playhead across all lanes (app-spec req 1.4).
- In **Timeline** mode, waveforms are tall and mute-regions are painted directly on them (§6).

### 5.3 Transport bar (top of canvas)
- Play / Pause / Stop, return-to-start.
- Timecode display (current / total) in `M:SS`.
- **Loop region** toggle + draggable loop handles on the timeline (for practicing a section).
- **Master fader** + master level meter.
- **Live LUFS readout** of the current live mix (informational; the exported value is set separately in Export). Helps the user see how loud their current combination actually is before committing.

### 5.4 Live mix vs. export — an important distinction (surfaced in UI)
The live mixer state (which stems are audible, at what gain, with what mute regions) **is** the export recipe. A small persistent hint reads: *"Export bounces exactly what you hear."* Solo is the only exception — it's a temporary monitoring state and shows a subtle "SOLO active — not part of export" indicator so nobody exports a soloed-only file by accident.

---

## 6. Time-range muting (mute-automation lanes)

Maps to engine-spec §3.3.2 and §6.2 — the UI reuses the engine's exact `(stem, start_sec, end_sec)` representation, no parallel model.

In **Timeline** mode, under each stem's waveform is a thin **mute lane**:

- **Paint a mute region** by click-dragging across the timeline on that stem's lane. The region renders as a shaded block over the waveform.
- Regions show their start/end as `M:SS`; both are editable by dragging edges or typing exact values (the UI accepts `M:SS`, `H:MM:SS`, or raw seconds — matching the engine's timestamp parsing).
- **Multiple regions per stem** supported (e.g. two separate solos); overlapping regions merge visually and are combined by the engine via min-envelope.
- The 30 ms fade in/out is applied by the engine at export and previewed in live playback; the UI needn't expose the fade length as a knob (it's a fixed anti-click measure), but a tooltip explains *"short fades are applied automatically to avoid clicks."*
- Live playback honors mute regions in real time (the gain node is automated on the playhead crossing region boundaries), so the user hears exactly what will export.

**Primary use case flow:** isolate a guitar solo → paint a mute region over just the solo bars on the `guitar` (or `guitar_center`) lane → the guitar stays audible everywhere else. This is the headline "mute just the solo" feature.

---

## 7. Guitar lead/rhythm split (experimental feature)

Maps to engine-spec §3.4. Available **only when a guitar stem exists** (i.e. the track was separated with `htdemucs_6s`). If not, the entry point shows a disabled state with the hint *"Requires Extended (6-stem) separation."*

### 7.1 Entry point
On the `guitar` lane header: a **⑂ Split lead/rhythm** button. Opens the split panel in the Inspector.

### 7.2 Split panel (Inspector)
- **Source stem**: defaults to `guitar` (editable if other stereo stems exist).
- **Method** (segmented): **Spectral (recommended)** / **Mid-side**. Spectral is default and preselected — matches the engine default and its better test results. A one-line description of each.
- **Diagnostic (FYI only):** shows the inter-channel correlation figure the engine computes, explicitly framed: *"Diagnostic only — does not predict split quality. Judge by listening."* It is **not** a gate; the split always runs regardless of this number (per the engine's empirical finding that correlation didn't predict success).
- **Run split** button. Runs the engine's split; on completion, **two new lanes** appear in the mixer: `guitar_center` and `guitar_sides`.

### 7.3 Presenting the results honestly
This is the most important UX rule for this feature (engine-spec §3.4 "Important semantic caveat"):

- The two derived stems are labeled **"Candidate A (center)"** and **"Candidate B (sides)"** — **never** "Lead" and "Rhythm."
- An inline note: *"Neither candidate is guaranteed to be the lead or rhythm part — this is a panning-based guess and varies by song. Solo each and listen to decide."*
- A **quick-audition control**: solo-cycle A / B / original guitar so the user can compare in a couple of clicks.
- Once the user decides, they can **rename** a lane (e.g. to "Lead guitar") themselves — the app never asserts the mapping for them.
- Both derived stems are **first-class lanes** (engine-spec §6.3): full mute/solo/fader/mute-regions, and they participate in export identically to model stems.

---

## 8. Export ("Bounce backing track")

Maps to engine-spec §3.3. Opens as a sheet (or Inspector panel).

- **What gets exported:** a read-only summary of the current mix — which stems are on/off, their gains, and any mute regions — restating "Export bounces exactly what you hear."
- **Format:** WAV / MP3 (MP3 via bundled ffmpeg or AVFoundation encode).
- **Loudness:**
  - **Target LUFS** field, default **−14.0**.
  - **Normalize loudness** toggle (default on) — because §3.3.1 flags normalization as an *open issue*, making it optional is a first-class control, not buried.
  - **Max gain boost cap** slider (default **+10 dB**, per the engine spec's suggested mitigation) shown when normalize is on, with helper text: *"Limits how much quiet mixes get boosted, reducing amplified separation artifacts."*
  - Info note near these controls: *"Large loudness corrections can make separation artifacts more audible, especially on quiet/solo mixes."* — sets expectations honestly.
  - **Peak-safety clamp** (to −0.2 dBFS) is automatic and not user-exposed; a tooltip explains it prevents clipping.
- **Output name & location:** a bare filename auto-resolves into the per-track output folder (engine-spec §3.5); an explicit path is respected. Default suggestion like `SongName - backing (no vocals).wav` derived from which stems are muted.
- **Export** button → runs engine mix; progress; on completion, a "Reveal in Finder" affordance and the file is listed in the track's output section.

### 8.1 Separation quality note (persistent, low-key)
Somewhere unobtrusive in the export panel (and in Help): *"Recombined AI-separated stems have a mild 'processed' character even with nothing muted — this is a limit of the separation engine, not your mix."* This preempts the §4 quality-ceiling surprise.

---

## 9. Project persistence (`.btrack`)

Addresses the gap flagged in engine-spec §6.5 and app-spec req 1.6. The app is document-based; each track/project is a `.btrack` **bundle** (a package folder):

```
MySong.btrack/
  project.json        # UI + engine state (below)
  thumbnail.png       # sidebar waveform preview
  (stems referenced by path into the shared cache, not copied here)
```

`project.json` reuses the engine's data model (engine-spec §5) so nothing is invented twice:

```jsonc
{
  "track":  { "source_path": "...", "identity": "<content-hash>",
              "fingerprint": { "size": ..., "mtime": ... } },
  "model":  "htdemucs_6s",
  "stemSet": [ { "name": "guitar_center", "is_derived": true,
                 "origin": { "from": "guitar", "method": "spectral" } }, ... ],
  "mix": {
     "gains":       { "vocals": 0.0, "guitar": 1.0, ... },
     "mute_ranges": { "guitar_center": [ [72.0, 96.5] ] },
     "target_lufs": -14.0,
     "normalize": true,
     "max_boost_db": 10.0
  },
  "ui": { "viewMode": "timeline", "loop": [30.0, 45.0], "laneRenames": {...} }
}
```

- **Track identity should be content-hash-based**, upgrading the engine's current filename-based key (engine-spec §5 / §3.1 known limitation). The `.btrack` records both the hash and the size/mtime fingerprint so the app can drive the staleness banner (§4.4).
- Reopening a project restores mixer state, mute regions, loop, view mode, and lane renames without re-separating.

---

## 10. Settings

- **Storage:** cache root and output-folder root (with current sizes; a "Clear cache" that only ever acts on explicit confirmation — never silent, per the engine's no-silent-overwrite rule).
- **Models:** which model weights are installed/bundled; download status (should be pre-bundled for offline-first — app-spec §2.2); default model for new tracks.
- **Audio:** output device, buffer size (relevant now for latency, and required for Step 2).
- **Defaults:** default target LUFS, default normalize on/off, default max-boost cap.
- **Engine health:** a small diagnostics readout confirming the embedded Python engine and ffmpeg are present and the correct pinned versions loaded (engine-spec §4 calls out torch/torchaudio/torchcodec fragility — surfacing a clear "engine OK / engine failed to start" status prevents silent breakage).

---

## 11. Step 2 stub — "Play Along" (designed, not built)

Reached from the sidebar `Play Along` entry, scoped so today's audio-graph decisions don't block it later (engine-spec §6.4: input monitoring must coexist in the same AVAudioEngine graph as playback).

The stubbed screen is laid out but functionally disabled with a "Coming soon" treatment:

- **Input device picker** — enumerate Core Audio USB interfaces (Focusrite/MOTU/etc., class-compliant).
- **Latency/buffer** control (shares the Settings audio buffer).
- **Signal chain rack** (visual placeholders, matching app-spec §3.5): Noise Gate → **Amp/Cab model (NAM `.nam`)** → EQ → Compressor → Delay/Reverb → Output.
- **"Suggest tone from this track's guitar stem"** button — wired to the concept in app-spec §3.3 (Option A: spectral-match the isolated/derived guitar stem against a NAM library). Disabled placeholder for now.
- **Backing track + live guitar play concurrently:** the design note here is that the *same* AVAudioEngine graph built for §5 playback gains an input node and the FX chain — it does not spin up a second audio session. This is the one architectural commitment Step 1 must honor now.

Everything in this screen is visibly marked as a future stage so it's clearly not implied to work in v1.

---

## 12. Engine integration contract (UI ↔ Python)

The SwiftUI `Engine client` speaks JSON-RPC to the bundled Python process. One method per engine capability (a thin API over the CLI subcommands, but as a persistent service rather than per-command processes — engine-spec Appendix notes a library/service API is the right shape for this app):

| UI action | RPC method | Params | Streams back |
|---|---|---|---|
| Separate | `separate` | `source_path, model, force` | progress phases, then `StemSet` manifest |
| Refresh lanes | `list_stems` | `track, model` | stem list (name, duration, sample_rate, is_derived) |
| Guitar split | `split_guitar` | `track, model, source_stem, method` | progress, then 2 new stem entries + correlation diagnostic |
| Export | `mix` | `track, model, gains, mute_ranges, target_lufs, normalize, max_boost_db, format, output_name` | progress, then output file path |
| Engine health | `ping` / `version` | — | engine + ffmpeg + model status |

Real-time playback and live mute/solo/fader/mute-region monitoring are handled **entirely on the Swift/AVAudioEngine side** by loading the stem WAVs the engine produced — the engine is not in the real-time path (engine-spec §6.1). The engine's `mix` path is used only for **file export**, never for live toggling.

---

## 13. Error & edge-case handling (UI-visible)

| Condition | Engine basis | UI behavior |
|---|---|---|
| Source file changed after separation | §3.1 staleness fingerprint | Amber non-destructive banner (§4.4); never auto-invalidate |
| Sample-rate mismatch between stems | §3.3 step 2 (reject, no silent resample) | Block export with a clear error naming the offending stems |
| Silent mix (loudness = −inf) | §3.3.1 | Skip normalization; toast "mix is silent, loudness left unchanged" |
| Huge normalization boost needed | §3.3.1 open issue | Respect max-boost cap; if capped, note "target loudness not fully reached (boost capped at +N dB)" |
| Guitar split requested with no guitar stem | §3.4 precondition | Disabled control + hint to use 6-stem model |
| ffmpeg / engine deps missing at launch | §4 fragility | Engine-health error state in Settings + blocking dialog on export if MP3 requested |
| Model weights not present, offline | §4 offline-first | Should not happen if bundled; if it does, clear "model not installed" message, never a silent network hang |

---

## 14. Visual language (brief)

- Native macOS look — SwiftUI system materials, sidebar translucency, SF Symbols for stem/transport icons, dynamic light/dark.
- DAW-conventional color coding per stem (vocals warm, drums neutral, bass deep, guitar accent, etc.), consistent between lane header, waveform, and level meter.
- Mute = dimmed lane; solo = highlighted; muted-region = diagonal-hatched overlay on the waveform.
- Honesty cues (staleness banner, split caveat, artifact note) use standard system callout styling — informative, not alarmist.

---

## 15. Open questions (carry forward)

1. **Live mute-region automation fidelity** — confirming AVAudioEngine gain automation reproduces the engine's 30 ms fades closely enough that live preview matches the export bit-for-bit perceptually.
2. **Content-hash identity migration** — the engine is currently filename-keyed; the app introduces content hashing (§9). Decide whether the engine adopts it or the app maps hash→filename when calling the engine.
3. **Per-track vs. per-export normalization** — engine-spec §3.3.1 suggests normalizing once per track; the UI's "Normalize + max-boost cap" is the per-export interim. Revisit after A/B listening tests.
4. **Packaging the Python engine** — PyInstaller one-dir vs. an embedded framework; ensuring pinned torch/torchaudio/torchcodec versions and bundled model weights survive notarization/sandboxing (app-spec §5 distribution note favors notarized direct download over Mac App Store for v1).
5. **Step 2 tone-library access** — TONE3000/NAM library query terms (app-spec §5.2) before wiring the "suggest tone" button.

---

*Companion to `engine-spec.md` (the audio core) and `backing-track-tone-match-spec.md` (the product vision). This document covers only the UI and the UI↔engine contract.*
