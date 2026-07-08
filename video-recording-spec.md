# Backing Track Studio — Performance Video Recording Spec

**Purpose:** a hand-to-a-developer spec for the next feature: record a **video of yourself playing along** (webcam or the Mac's built-in camera), where the resulting file contains the camera video plus a clean audio mix of **the backing track + your live USB guitar** — exactly what you hear while playing.

**Companion docs:** `prototype-spec.md` (app shell, server, milestones format), `engine-spec.md` (audio DSP), `ui-spec.md` (UI conventions). This builds on the shipped Play Along rig (`app.js` — `Guitar`/`Neural` graph) and the existing stdlib server (`BackingTrackStudio/server.py`).

**Status:** researched and ready for implementation. No code has been written.

---

## 0. Locked decisions (rationale)

| Decision | Choice | Why |
|---|---|---|
| Where recording happens | **Entirely in-browser, `MediaRecorder`** | The whole live rig already runs in one `AudioContext`. Recording in the same context taps the exact signal you monitor — no second clock domain, no IPC, no new process. |
| Audio source | **Tap the existing graph** via a `MediaStreamAudioDestinationNode` (a parallel sink) | A tap adds **zero latency** to the monitoring path — the guitar's ~20–40 ms browser monitor latency is untouched. Recording must never be *in* the signal chain, only *beside* it. |
| What audio gets recorded | Backing-track bus (post-master, post-pitch/speed) **+** guitar rig output (`outGain`). **Never the camera/laptop microphone.** | The file should contain the mix as heard, not room bleed. Camera is opened **video-only** (`audio: false`) so no echo/feedback risk and no accidental mic-vs-USB confusion. |
| Container/codec | **`video/mp4; codecs=avc1.*, mp4a.40.2` (H.264 + AAC) when supported; fall back to WebM (VP9/VP8 + Opus)** | Chrome ≥126 and Safari ≥14.1 record MP4 with **hardware** H.264 (VideoToolbox on macOS). Hardware encode matters here beyond convenience — see §4.3 (CPU headroom vs. the NAM audio worklet). |
| A/V alignment | **Constant-offset correction at save time** (server-side ffmpeg remux, `av_offset_ms` setting), not real-time compensation | Audio is captured at the point of generation (effectively zero delay); webcam frames arrive 50–200 ms late (camera pipeline). Both tracks share one clock so there's **no drift** — just a constant offset, which a lossless remux fixes in <1 s. |
| File destination | `output/<track>/recordings/` via a raw-body POST (same pattern as `/api/import`), with browser download as fallback | Keeps everything in the song's folder the user already knows; reuses existing, proven upload/serve plumbing and `safe_name` validation. |
| Server-side finalize pass | **Always remux when ffmpeg is present** (`-c copy`, no re-encode) | Fixes MediaRecorder's known container quirks (missing/odd duration metadata, non-faststart moov atom) and is where the A/V offset is applied. Lossless and fast. |

**Explicitly rejected alternatives**

| Alternative | Why not |
|---|---|
| Server-side capture (ffmpeg `avfoundation` grabbing camera + audio device) | Two unsynchronized clock domains (browser audio graph vs. OS capture), a second camera permission model, and no access to the in-browser guitar FX/NAM output at all without loopback drivers. A sync nightmare with zero latency benefit. |
| Screen recording (`getDisplayMedia`) of the app window | Records UI, not the performer; still needs the same audio plumbing; adds compositor latency. |
| WebCodecs + JS muxer (e.g. mp4-muxer) with per-frame timestamp control | The most powerful option (could apply the A/V offset per-frame at mux time, in-browser) — but far more code for a correction the ffmpeg pass does in one flag. **Keep as the v2 escape hatch** if constant-offset correction ever proves insufficient (§8). |

---

## 1. Scope

**In (must work end-to-end):**
- Camera picker (built-in FaceTime HD camera or any USB webcam) with live self-view preview (mirrored preview, **unmirrored recording** — standard camera UX).
- Record / stop from the Play Along screen. One take = one file.
- Recorded audio = current backing-track mix (respecting mutes/solos/faders/mute-regions/speed/tune) + the live guitar chain output (clean, analog amp, or neural amp — whatever is active).
- Automatic save into `output/<track name>/recordings/` with sensible take numbering; "Reveal in Finder" on completion (existing `/api/reveal`).
- Works with no track loaded too (guitar-only video — e.g. riff ideas).
- A/V offset calibration setting, persisted, applied at finalize time.

**Out (deferred, architected-for):**
- Multi-take comping UI, in-app video playback/trimming (v1: reveal the file; QuickTime does the rest).
- Count-in / auto-punch record. (Trivial UX add later; nothing in the design blocks it.)
- Audio-only takes (same pipeline with an audio-only mimeType — one conditional; add when wanted.)
- Automatic clap-sync calibration wizard (§5.4 describes the manual procedure v1 ships in help text).

---

## 2. UX (Play Along screen additions)

A new **Record** card on the Play Along screen, below the input-device field:

```
┌─ Record performance ─────────────────────────────────────────┐
│  [camera preview — 16:9, mirrored, shows "camera off" state] │
│                                                              │
│  Camera   [FaceTime HD Camera            ▾]  [Enable camera] │
│  Quality  (•) 720p · 30fps    ( ) 1080p · 30fps              │
│                                                              │
│  ● Record        00:00          [readout: REC + level meter] │
│                                                              │
│  ☑ Start backing track with recording (from current position)│
└──────────────────────────────────────────────────────────────┘
```

Behaviour:
- **Enable camera** requests `getUserMedia({ video: {…}, audio: false })` and starts the preview. Same secure-context rules and error-message care as the guitar input (reuse the pattern from `startGuitar()` — the messages for denied/busy/missing devices are already well-worded there).
- **Record** arms the recorder and (if the checkbox is on and a track is loaded) starts playback in the same gesture. Button becomes **■ Stop**, elapsed-time counter runs. Recording is independent of the transport — pausing/seeking mid-take is allowed and simply captured as heard.
- **Stop** finalizes the take: chunks assembled → uploaded → (ffmpeg present) remuxed with the calibration offset → success toast with **Reveal in Finder** / **Discard** actions.
- Guitar input not enabled → recording still works (you get backing track only); show a gentle inline note "Guitar input is off — enable it above to be in the recording."
- Navigating away from Play Along while recording: keep recording (the graph and recorder are global); show a persistent red ● REC pill in the toolbar that returns you to the screen. Closing the tab triggers the browser's `beforeunload` guard while recording.
- Take naming: `<track name> - take 03.mp4` (or `.webm`), number = 1 + highest existing take number in the folder (server assigns; no clobbering, same policy as import).

---

## 3. Technical design

### 3.1 Audio: tap the existing graph

Current graph (already shipped):

```
stems → per-stem gains → master ─[optional pitchNode]→ analyser → ctx.destination
guitar in → … rig … → outGain ──→ outAnal ──────────────────────→ ctx.destination
```

Add one persistent, always-connected **record bus** (a plain `GainNode`, unity gain) and a `MediaStreamAudioDestinationNode` created lazily on first record:

```
analyser ──→ recordBus ──→ MediaStreamAudioDestinationNode ─→ (audio MediaStreamTrack)
outGain ───→ recordBus ↗
```

Key points:
- **Tap the `analyser`, not `master`** — the analyser is the one node that always carries the final backing signal whether or not the pitch worklet has been spliced in (`master → pitch → analyser` vs `master → analyser`). Tapping it means speed/tune changes are captured exactly as heard.
- `outGain` is the guitar rig's last node before the destination, so every mode (clean DI / analog amp / neural amp / delay / reverb) is included with the output-level knob honored.
- The record bus is **parallel**: it adds no node into the monitored path, so monitor latency is mathematically unchanged. This is the single most important property of the design.
- The camera's `MediaStream` contributes **only its video track**; the recorder's stream is assembled as `new MediaStream([cameraVideoTrack, recDest.stream.getAudioTracks()[0]])`.

### 3.2 Recorder configuration

```js
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',   // H.264 CBP + AAC-LC (HW on macOS)
  'video/mp4',                                 // let the browser pick mp4 codecs
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const mimeType = MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported(m));
new MediaRecorder(stream, {
  mimeType,
  videoBitsPerSecond: 5_000_000,    // 720p30; 8 Mbps for 1080p
  audioBitsPerSecond: 192_000,
});
```

- `isTypeSupported()` returning true does not guarantee the encoder copes at the requested bitrate on a given machine — treat `MediaRecorder`'s `error` event as a first-class path (toast + salvage whatever chunks exist).
- `recorder.start(1000)` — 1 s timeslices so a crash/tab-kill loses at most the last second and memory holds chunks, not one giant blob.
- Camera constraints: `{ width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30} }` (1080p variant when selected). `deviceId: { exact }` with the same OverconstrainedError → default-device fallback already used for audio inputs.

### 3.3 Save + finalize (server)

New endpoints in `server.py`, following existing conventions (`safe_name` everywhere, raw-body upload like `_handle_import`):

| Route | Method | Behaviour |
|---|---|---|
| `/api/recording/save?track=<name>&ext=<mp4\|webm>` | POST (raw body) | Streams body to `output/<track>/recordings/<track> - take NN.<ext>` (server picks NN; creates dirs). Returns `{path, filename, take}`. `track` optional → `output/_untracked/recordings/`. |
| `/api/recording/finalize` | POST JSON `{path, av_offset_ms}` | If ffmpeg present: lossless remux — `ffmpeg -i in [-itsoffset O -i in -map 0:v -map 1:a] -c copy -movflags +faststart out.mp4` — then atomically replaces the original. If ffmpeg missing or remux fails: leave the original untouched, return `{finalized: false, reason}`. Never destroys the only copy. |
| `/api/recordings?track=<name>` | GET | List existing takes (for numbering display / future take browser). |

Why finalize is unconditional (not only when an offset is set): MediaRecorder output has well-documented container quirks — Chrome/Safari MP4s can carry missing or odd duration metadata, and the moov atom is written at the end (not streamable / slow to open). A `-c copy` remux costs well under a second for a 5-minute take, re-encodes nothing, and fixes all of it.

Upload size note: a 5-min 1080p take at 8 Mbps ≈ 320 MB. The existing chunked raw-body reader in `_handle_import` already handles this fine on localhost; reuse it verbatim.

### 3.4 A/V synchronization model

Reality of the capture pipeline:

| Signal | Path to the file | Effective delay vs. what your hands did |
|---|---|---|
| Backing track audio | audio graph → record bus | ~0 (it *is* the reference the performer plays to) |
| Guitar audio | USB in → graph → record bus | input-device latency only (~5–20 ms, part of what you already monitor) |
| Camera video | sensor → USB → decode → `MediaStreamTrack` | **50–200 ms** (consumer webcam pipeline; built-in FaceTime cams typically at the lower end) |

Both tracks are timestamped against the same browser clock by `MediaRecorder`, so **there is no drift** — the error is a *constant*: in the raw file, the video shows each strum ~50–200 ms *after* you hear it.

Correction: delay the **audio** by `av_offset_ms` at finalize time (`-itsoffset` on the audio input, `-c copy`, zero quality cost). Default `av_offset_ms = 0` — at ≤100 ms most viewers don't notice, and a wrong guess is worse than none. The setting lives in the Record card's "advanced" disclosure and persists in `localStorage`.

**Calibration procedure (v1, manual — documented in USER-MANUAL.md):** record a 5-second take where you clap once in front of the camera. Open the file, find the video frame of contact and the audio spike (any viewer with frame-step works), set the offset to the difference. One-time per camera. (An automatic clap-detect wizard is a clean later add — §8.)

### 3.5 Latency budget (what this feature must not break)

The feature adds **nothing** to the live path. Verification gate before merge:

| Path | Budget | How verified |
|---|---|---|
| Guitar monitor latency while recording | Unchanged vs. not recording | A/B loopback measurement (or by ear + `ctx.outputLatency` reading logged before/during) |
| Audio worklet stability (NAM LSTM per-sample inference) while encoding video | Zero added glitches at 720p30 | Record 3 min with neural amp active on battery power; listen for dropouts; watch `requestVideoFrameCallback` drops |
| Renderer load | Preview + meters stay 60 fps | Existing RAF meters keep running during record |

The one real risk is CPU contention: the neural amp burns a core on per-sample LSTM math, and a **software** video encode (VP9 fallback path) could starve it, which manifests as audio crackle — a latency-adjacent failure. Mitigations, in order: (1) MP4/H.264 is hardware-encoded on every Mac this app targets and is the first-choice mimeType; (2) default 720p; (3) if the chosen mimeType is a WebM fallback **and** the neural engine is active, show a one-line heads-up suggesting 720p/analog if crackle appears.

---

## 4. State & code layout (front end)

New module-level object in `app.js`, mirroring the `Guitar` pattern:

```js
const Recorder = {
  camStream: null, camDeviceId: null,     // video-only stream
  recDest: null, recordBus: null,         // lazy, persistent once created
  mediaRecorder: null, chunks: [],
  state: 'idle',                          // idle | armed | recording | saving
  startedAt: 0, mimeType: null,
  quality: '720p', avOffsetMs: 0,         // persisted (localStorage)
};
```

- `ensureRecordBus()` — creates `recordBus` + `recDest` once, wires `analyser → recordBus → recDest` and `Guitar.nodes.outGain → recordBus` (guard: wire outGain at `buildGuitarChain()` time too, whichever comes second).
- `startCamera(deviceId)` / `stopCamera()` — clone of the `startGuitar` device/fallback/error-message pattern, video-only.
- `startRecording()` / `stopRecording()` — assemble stream, run recorder, collect chunks, upload, call finalize, toast with Reveal/Discard.
- UI lives in the existing `openPlayAlong()` template (new card) + a toolbar REC pill. No new screens.

Camera preview element gets `muted playsinline` and CSS `transform: scaleX(-1)` (mirror preview only — the recorded track is untouched).

---

## 5. Failure modes & edge cases

| Case | Behaviour |
|---|---|
| Camera permission denied / camera in use by another app | Same toast quality as guitar input: name the OS setting path, suggest closing the other app. Record button stays disabled until preview is live. |
| `MediaRecorder` fires `error` mid-take | Stop, salvage collected chunks, upload what exists, toast "take ended early — partial file saved". |
| Tab closed / crash mid-take | 1 s timeslices bound the loss; nothing server-side to clean (upload only happens on stop). `beforeunload` guard while recording. |
| Disk full on save | Upload endpoint returns 507-style error; blob is still in memory — offer browser download as rescue. |
| No ffmpeg | File saved as recorded (mp4 from Chrome/Safari is fine unfinalized; webm plays in QuickTime via conversion or in the browser). `finalize:false` surfaced quietly. |
| Track switched / deleted mid-take | Allowed (recording just captures silence/whatever plays); take saves under the track that was loaded at record-start. |
| Backgrounded tab | `MediaRecorder` continues; camera track may throttle frame rate (OS-level) — acceptable, documented. |
| Speed/tune active | Captured as heard (by design — tap is post-pitch). |

Privacy note (USER-MANUAL.md): everything is local — camera frames never leave the machine; the server is loopback-only.

---

## 6. Implementation milestones

1. **M1 — Record bus + camera preview** (no recorder yet): `ensureRecordBus()`, camera picker/preview card, permission errors polished. *Gate: guitar monitor latency measurably unchanged with bus connected.*
2. **M2 — Record/stop → local download**: MediaRecorder with mimeType ladder, chunking, elapsed UI, REC pill; file lands via browser download. *Gate: 3-min take, NAM active, zero audio glitches; A/V offset measured and constant.*
3. **M3 — Server save + finalize**: the three endpoints, take numbering, faststart remux, `av_offset_ms` applied, Reveal in Finder. *Gate: clap test — corrected file within ±1 frame (33 ms) of true sync.*
4. **M4 — Polish**: start-with-playback checkbox, quality toggle, calibration docs in USER-MANUAL.md, `beforeunload` guard, guitar-off inline note.

Rough size: M1+M2 are one focused session; M3 another; M4 half of one.

---

## 7. Acceptance criteria

- Recording a take while playing (neural amp active, 6-stem track, speed 0.9×) produces a file where: backing + guitar are both present at monitored levels, no camera-mic bleed, no audio dropouts, video plays in QuickTime, and after calibration the strum-to-frame error is ≤ 1 video frame.
- Guitar monitor latency with recording running is indistinguishable from not recording.
- Deleting the app's takes is as simple as deleting files in `output/<track>/recordings/` — no hidden state.

---

## 8. Future directions (explicitly not v1)

- **WebCodecs + JS muxing** for in-browser offset correction and streaming-to-disk writes (removes the finalize pass; also enables live filters/overlays like a timecode burn-in).
- Automatic clap-calibration wizard (record 3 s, cross-correlate audio spike with frame-luma spike).
- Audio-only takes; separate stems in the recording (guitar and backing as two mono/stereo tracks in one file via multi-track WebM — niche, revisit on demand).
- In-app take browser with inline `<video>` playback.

---

## 9. Research sources

- [MediaRecorder MP4 container support — Chrome Platform Status](https://chromestatus.com/feature/5163469011943424) and [Intent to ship thread](https://groups.google.com/a/chromium.org/g/blink-dev/c/p1OMVj1FrMI) — MP4 (H.264/AAC) shipped in Chrome 126 (June 2024; originally 120, re-enabled after a `<dialog>` interaction fix).
- [MediaRecorder.isTypeSupported() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static) and [MediaRecorder.mimeType — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/mimeType) — Safari 14.1+ records MP4; `isTypeSupported` is necessary but not sufficient (encoder may still fail at runtime).
- [MediaRecorder browser support & limitations — TestMu](https://www.testmuai.com/learning-hub/mediarecorder-browser-support/) — Chrome writes MP4 only when the platform offers an OS encoder (macOS: VideoToolbox → hardware H.264).
- [Duration in MP4 files produced by Chrome/Safari — addpipe](https://blog.addpipe.com/duration-in-mp4-files-produced-by-chrome-safari/) — the container-metadata quirks motivating the unconditional finalize remux.
- [How to measure glass-to-glass video latency — Vay](https://vay.io/how-to-measure-glass-to-glass-video-latency/) and [Latency, glass-to-glass explained — Forasoft](https://www.forasoft.com/learn/video-streaming/articles-streaming/latency-glass-to-glass-explained) — consumer webcams add ~50–200 ms; measurement techniques behind the calibration procedure.
- [RecordRTC issue #738](https://github.com/muaz-khan/RecordRTC/issues/738) — real-world report of the audio/video offset class of problem on Chrome/Mac; reinforces designing the offset correction in from day one.
