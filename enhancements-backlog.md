# Guitar Studio — Enhancement Backlog & Picklist

**Status:** proposal / picklist — nothing here is committed until selected. BT-13 has shipped; 14 items are selected and scoped for the next release — see [release-v0.4-spec.md](release-v0.4-spec.md) (tagged **v0.4** in the picklist below).
**Scope:** candidate features across the three areas of the studio — **Backing Tracks (BT)**, **Guitar Performance (GP)**, **Video (VD)** — plus **cross-cutting (XC)** items. Grounded in the current prototype (browser UI + Web Audio playback, Python engine for separation/export, loopback-only server) and informed by a scan of comparable tools (Moises, Capo, Anytune, Transcribe!, AmpliTube 5, Neural DSP, looper apps).

**How to use this document:** each item has an ID, a size estimate, and notes on dependencies/risk. Pick items by ID; the summary picklist at the end (§6) is the selection sheet. Sizes:

| Size | Meaning (rough) |
|---|---|
| **S** | Hours — mostly UI or a thin wrapper over existing plumbing |
| **M** | A day or two — new component, contained scope |
| **L** | Several days — new subsystem or engine work |
| **XL / R&D** | Uncertain — research risk, may not pan out |

---

## 1. Where we are (baseline)

Already shipped in the prototype, so excluded from the backlog:

- 6-stem separation (Demucs htdemucs_6s), cached, with auto guitar center/sides split
- Live per-stem mute/solo/fader mixer, timeline mute regions with 30 ms fades
- Speed 0.5–2× pitch-held, Tune ±100 cents, loop toggle (fixed middle region)
- WAV/MP3 export with LUFS normalization, boost cap, peak clamp; projects save/restore
- Play Along: live guitar in, analog amp + tone stack + gate/comp/delay/reverb, analog auto-match, NAM/GuitarML LSTM neural amps, cab IR loading, "suggest closest" model ranking
- Performance video recording (camera + program mix, mic never recorded), take numbering, ffmpeg finalize, manual A/V offset calibration

Items already flagged **deferred, architected-for** in existing specs are pulled into this backlog and marked †.

---

## 2. Backing Tracks (BT)

### Tempo, key & musical intelligence

**BT-01 · BPM detection & live BPM readout — S/M**
Analyze each song once at separation time (librosa beat-track or madmom on the drum stem — the isolated drum stem makes this much more reliable than mixed audio) and store BPM in the manifest. Display it in the transport, and show the **effective BPM live** as the speed slider moves (e.g. `120 → 96 BPM @ 0.8×`). This is the "BPM meter to go with the speed up/slow down." Cheap, high visible value. *Every comparable tool (Moises, Capo) shows BPM.*

**BT-02 · Beat grid & smart click track — M**
Extend BT-01 from a single BPM number to per-beat timestamps (handles tempo drift in live recordings). Enables: a metronome **click lane** that is a first-class stem (mute/fader like any other — practice with drums out, click in), beat-snapped loop points (BT-05), and count-in (BT-06). *Moises' "Smart Metronome" is exactly this and is one of its headline features.*

**BT-03 · Key detection & semitone transpose — M**
Detect the song's key (chromagram on the harmonic stems) and show it next to BPM. Extend the existing ±100-cent Tune control with a **±12 semitone transpose** so you can play a song in a friendlier key without a capo. Same pitch-shift engine, wider range — quality note at extremes, same as the current speed warning. *Anytune does ±24 semitones; standard practice-app feature.*

**BT-04 · Chord detection & chord lane — L**
Detect the chord progression (chromagram + template matching over the `other`+`piano`+`guitar` stems, beat-aligned via BT-02) and render a **chord lane** above the waveform: chord names scrolling with the playhead, transposing automatically with BT-03. This is Capo's flagship feature and Moises Premium's biggest practice tool. Realistic accuracy is "good on pop/rock, rough on jazz" — label it as assistive, consistent with our honesty-notes house style. Optional stretch: guitar chord diagrams.

### Practice workflow

**BT-05 · Proper A/B loop region — S**
Replace the fixed middle-of-song loop with **draggable loop handles** on the timeline (click-drag in a loop mode, or "set A / set B" at the playhead). Snap to beats when BT-02 exists. This is the single most-used practice feature in every comparable tool and ours is currently a placeholder.

**BT-06 · Count-in — S** †
1–2 bars of click before playback starts (needs BT-02 for tempo; or a manual BPM tap as fallback). Already flagged as a trivial add in the video spec; also valuable outside recording.

**BT-07 · Speed trainer — S/M**
"Start at 0.6×, +2% each loop pass until 1.0×." A tiny state machine on top of BT-05 + the existing speed control. Beloved feature of Anytune ("Step-It-Up") and Transcribe! users; very cheap once A/B looping exists.

**BT-08 · Section markers — M**
Named markers/sections (Intro / Verse / Solo…) on the timeline: click to jump, loop-a-section in one click, persisted in the project file. Manual placement first; auto-detection of song structure is a possible R&D extension later. *Capo's named sections; Anytune's marks.*

**BT-09 · Playlists / setlists — M**
Ordered lists of songs (with each song's saved mix applied), auto-advance with a configurable gap, shuffle off/on. Lives in the Library sidebar; persisted like projects. Covers both "practice set" and "gig backing set" use cases. *Moises has setlists; ours can be better because each entry carries its full stem mix.*

**BT-10 · Practice log — S/M**
Per-song running total of practice time (playback-while-focused time), last-practiced date in the Library, simple session history. No gamification — just honest numbers. Pairs well with GP-09.

### Mix & audio quality

**BT-11 · Per-stem EQ & pan — M**
Add pan and a simple 3-band EQ (or low/high cut) per lane, applied live via Web Audio nodes and honored in export by the Python engine. Main use cases: carve space when you play along (dip the mids of `other`), rebalance a muddy separation, widen/narrow a stem.

**BT-12 · Gain automation (volume ramps) — M**
Generalize mute regions to **gain regions**: paint a region and set a level (e.g. guitar at 30% during the solo instead of hard mute — "ghost guide" practice). The engine's `(stem, start, end)` model extends naturally with a `gain` field; UI reuses the mute-region painting.

**BT-13 · Separation quality: next-gen models — L/XL → SHIPPED**
Demucs htdemucs_6s is 2022-era and its upstream is no longer actively maintained. Current leaders (BS-RoFormer / Mel-Band RoFormer family) measurably beat it on SDR — and critically, on the **guitar stem specifically** (9.05 dB vs. htdemucs_6s's 2.59 dB), which directly addresses the quality ceiling called out in engine-spec §157 and is the actual bottleneck behind BT-14's unreliability. Full research in [guitar-separation-upgrade-spec.md](guitar-separation-upgrade-spec.md). **Implemented 2026-07-04:** the spec's own "not available as free open weights" conclusion turned out to be wrong — the `audio-separator` package (nomadkaraoke/python-audio-separator) packages the exact `BS-Roformer-SW.ckpt` checkpoint as a free, self-hosted, one-time ~700MB download. Added as `--model bs_roformer_sw`, dispatched via a new backend alongside (not replacing) Demucs, so both can be A/B compared per-song in both the CLI and the GuitarStudio app (new clickable model-switcher on the mixer's model badge). `list`/`mix`/`split-guitar` needed zero changes thanks to the stem-discovery design (engine-spec §46).

**BT-14 · Real lead/rhythm guitar separation — XL / R&D**
Replace the panning heuristic with an actual ML split — researched in depth in [guitar-separation-upgrade-spec.md](guitar-separation-upgrade-spec.md). Finding: **no open model or dataset for role-based (lead vs. rhythm) guitar separation exists anywhere** — Moises' shipped feature is an undisclosed black box (marketing only, no architecture/data/metrics published, API is partner-tier only), and even Moises' own published research dataset (MoisesDB) labels guitars by timbre, not role. Building a real dataset would mean synthetic mixing of separately-sourced lead-only/rhythm-only recordings — a genuine R&D project, not a scoped feature. **Recommended near-term path instead:** feed the existing panning heuristic a much cleaner guitar stem via BT-13 (very likely fixes most of the validation-set failures for near-zero extra engineering), then optionally enhance the heuristic with beat-grid-informed note-density cues (needs BT-02) as a non-ML refinement. True ML split stays shelved pending a labeled dataset.

**BT-15 · Artifact cleanup pass — M/L**
Optional post-separation enhancement per stem: gentle spectral de-bleed / de-noise (e.g. noisereduce or a light spectral gate keyed to the other stems), applied at export or as a "cleaned" derived stem. Won't fix the separation ceiling but can tame the worst bleed on quiet mixes. Needs honest A/B evaluation before shipping — could easily do more harm than good; treat as experiment first.

**BT-16 · Off-pitch auto-detect — S**
Songs mastered off A=440 (the *Phantom of the Opera* case) currently require tuning by ear. Estimate the reference-pitch offset automatically (pitch-class histogram vs. equal temperament) and offer "This song appears to be −23 ¢ from A=440 — apply?" One-click instead of ear-tuning.

**BT-17 · Waveform zoom & finer navigation — S/M**
Zoom in Timeline mode (pinch/scroll), nudge playhead by beat/second with arrow keys. Makes precise mute-region edges and loop points much easier to place. Mostly UI work.

**BT-18 · Batch operations — M**
Apply a mix recipe across many songs: "separate everything in `input/`", "export *no vocals* versions of these 12 songs." A queue UI over the existing engine calls. Big time-saver once the library grows.

---

## 3. Guitar Performance (GP)

### Core tools

**GP-01 · Chromatic tuner — S/M**
Always-accessible tuner using the existing live input (autocorrelation/YIN pitch detection on the input stream, needle + cents display). Currently the app tells you to line up with "your tuner" — it should *be* the tuner. Table stakes in every amp-sim product (AmpliTube's tuner is a headline feature).

**GP-02 · Rig presets (save/load/per-song) — M**
Save the full rack state — signal mode, amp engine, analog knobs, NAM model + knob, IR, FX sends, output — as named presets; recall instantly; **attach a preset to a song/project** so loading the song loads the rig. Already requirement 2.6 in the tone-match spec; the single biggest workflow gap in Play Along today. Prerequisite for MIDI switching (GP-11).

**GP-03 · Expanded pedalboard — M/L**
Add the classic missing effects as Web Audio nodes: **chorus, flanger, phaser, tremolo, wah (auto-wah), octaver, boost/overdrive pedal, graphic EQ**. Include drag-to-reorder of the chain (pre/post amp placement matters — e.g. wah before drive, chorus after). The current gate/comp/delay/reverb row becomes one section of a proper board. *This is the "other plugin effects" item.*

**GP-04 · WaveNet .nam support — L**
The bulk of TONE3000's library is WaveNet captures we currently refuse. Route: compile NAM's WaveNet inference to **WebAssembly (SIMD)** or run it in an AudioWorklet with a WASM kernel; feasibility is proven (NeuralAmpModelerCore compiles to WASM — several web demos exist). Removes the single biggest limitation of the neural amp path. Fallback if real-time budget fails on older machines: keep LSTM as default, WaveNet opt-in with a CPU warning.

**GP-05 · IR library & management — S**
Same treatment models got: a `models/ir/` folder scanned into a picker with Load buttons, remember last-used IR per preset, optional high/low-cut after the IR. Currently IRs are load-one-file-at-a-time.

### Practice & capture

**GP-06 · Looper pedal — L**
Record/overdub/undo loop layers from the live guitar, synced to the backing track's beat grid (BT-02) or free-running with no song. Lay down a rhythm loop, solo over it. *AmpliTube ships one; dedicated looper apps are a whole category.* Web Audio can do this well; the work is in the UX (footswitch-friendly big buttons, quantized start/stop).

**GP-07 · Riff capture (rolling buffer) — M**
An always-on ring buffer (last 30–60 s of your processed guitar) with a "**Save that!**" button — never lose the lick you just improvised. Lands as a WAV in `output/_riffs/` with a timestamp. *The TC WireTap pedal exists solely to do this; Songzap's Loop Record is built on it.*

**GP-08 · Audio-only takes — S** †
Record performance audio (program mix, same as video) without the camera. Already flagged in the video spec as "one conditional — add when wanted."

**GP-09 · Performance feedback vs. the record — XL / R&D**
Compare your live playing against the song's isolated guitar stem: timing offset per phrase, pitch-match heatmap over the timeline. Genuinely hard (polyphonic transcription + alignment) — Yousician-class technology. Honest framing: a rough "how tight was I?" score on monophonic lead lines is achievable; full rhythm-part grading is not. Treat as research spike first.

### I/O & control

**GP-10 · Input calibration & clip indicator — S**
Input gain meter with clear too-hot/too-cold zones and a persistent clip light; one-time setup wizard ("play your loudest chord…"). Cheap insurance against the #1 cause of "my tone sounds terrible" (clipped input into a neural model).

**GP-11 · MIDI foot controller support — M**
Web MIDI: map program changes / CCs to preset switching (GP-02), looper control (GP-06), wah pedal (GP-03), record start/stop (VD). Hands-free operation is what makes a practice rig usable while actually holding a guitar.

**GP-12 · Bounce performance into export — M**
Optionally record your live guitar (processed) as a stem during playback, then include it in the normal Python export — "me + backing track" as an audio file, mixed and normalized like everything else. The video path already proves the program-mix capture; this routes it into the export pipeline instead.

**GP-13 · Latency meter — S**
Measure and display actual round-trip input latency (loopback ping through the graph) instead of the manual's "typically 20–40 ms." Sets expectations honestly and helps users pick the right interface/buffer settings.

---

## 4. Video (VD)

**VD-01 · Count-in & auto-punch record — S** †
Tick "3-2-1 count-in" → record arms, count-in plays (BT-06), recording and playback start together on beat 1. Deferred in the video spec; trivial once count-in exists.

**VD-02 · Takes browser — M** †
In-app list of takes per song (the `/api/recordings` endpoint already exists): inline playback, rename, delete, star the keeper. Ends the round-trip to Finder/QuickTime for every review.

**VD-03 · In-app trim — S/M** †
Top/tail trim on a take (slider on the inline player → lossless ffmpeg `-ss/-to` copy). Kills the dead air of walking to/from the laptop, which every take currently has.

**VD-04 · Auto clap-sync wizard — M** †
Automate the manual §12.6 calibration: record a 5-second take, detect the clap transient in audio (trivial) and the hands-meeting frame in video (frame-difference spike — no ML needed), compute and store the offset per camera. Deferred in the video spec with this exact approach sketched.

**VD-05 · Multi-take practice mode — M/L**
Loop a section (BT-05) with auto-retake: each pass through the loop is saved as its own take, keep going until you nail it, then review the strip in the takes browser (VD-02) and keep the best. This is "comping" for practice — the video spec's deferred multi-take item, made concrete.

**VD-06 · Overlays on the recording — M**
Optional burned-in (or player-side) overlays: song title + take number lower-third, live chord display (BT-04) so viewers/you can follow the changes, REC-safe margins. Compositing happens on a canvas before MediaRecorder, so cost is one `drawImage` pipeline.

**VD-07 · Social export presets — S/M**
One-click re-crop/re-encode of a take for common targets: 9:16 vertical 1080×1920 (Shorts/Reels), 1:1, plus a "web-friendly H.264 + AAC" normalize. Pure ffmpeg presets over existing files; keeps the original untouched.

**VD-08 · Side-by-side take compare — M**
Play two takes synced (aligned by their shared backing track) in a split view to decide which is better / spot technique differences. Needs VD-02 first.

**VD-09 · Camera framing aids — S**
Grid/thirds overlay and a "fretboard visible?" guide box on the preview (preview-only, never recorded). Small quality-of-life win for a camera you set once and stop looking at.

---

## 5. Cross-cutting (XC)

**XC-01 · Project format v2 — M**
Extend the saved project to carry the new state as it lands: rig preset link (GP-02), loop region (BT-05), markers (BT-08), playlist membership (BT-09), chord/key/BPM analysis cache (BT-01…04). Do this alongside the first feature that needs it, with versioned migration from v1 projects.

**XC-02 · Keyboard shortcuts — S**
Beyond Space: `L` loop, `[`/`]` loop handles, `M`/`S` on hovered lane, `R` record, arrows to nudge playhead, `?` overlay listing them. Cheap, big feel-of-quality win.

**XC-03 · Content-based separation cache key — S/M**
Replace the filename-based cache key with content hash (engine-spec §49 known limitation). Ends both failure modes: same-name collisions and silent staleness.

**XC-04 · Onboarding & in-app help — S/M**
First-run tour and a searchable in-app copy of the user manual. The manual is good; nobody reads files.

**XC-05 · Native macOS app (SwiftUI shell) — XL**
The original prototype-spec plan: AVAudioEngine playback + native input path (<10 ms latency vs. 20–40 ms in browser), menu bar, signing/notarization. The browser prototype keeps proving features cheaply; port when the feature set stabilizes. Biggest single payoff: guitar monitoring latency.

**XC-06 · Windows first-class support — M**
`run.bat` exists; promote to parity: test the audio path, document ASIO guidance, CI-check the server on Windows. Only worth it if the app will be shared beyond this Mac.

---

## 6. Summary picklist

Legend: **Value** = expected practice-workflow impact (★–★★★). Suggested tiers: **Quick wins** (do soon, mostly S), **Core** (the substantial features that define the next version), **Stretch/R&D** (uncertain payoff — timebox).

| ID | Item | Area | Size | Value | Depends on | Tier |
|---|---|---|---|---|---|---|
| BT-01 | BPM detection + live readout | BT | S/M | ★★★ | — | **v0.4** |
| BT-05 | Draggable A/B loop | BT | S | ★★★ | — | **v0.4** |
| BT-16 | Off-pitch auto-detect | BT | S | ★★ | — | **v0.4** |
| GP-05 | IR library | GP | S | ★★ | — | **v0.4** |
| GP-10 | Input calibration + clip light | GP | S | ★★ | — | **v0.4** |
| GP-13 | Latency meter | GP | S | ★ | — | **v0.4** |
| VD-03 | In-app trim | VD | S/M | ★★ | needs a minimal VD-02-lite player (see spec) | **v0.4** |
| VD-09 | Camera framing aids | VD | S | ★ | — | **v0.4** |
| XC-02 | Keyboard shortcuts | XC | S | ★★ | — | **v0.4** |
| XC-03 | Content-based cache key | XC | S/M | ★ | — | **v0.4** |
| BT-02 | Beat grid + click stem | BT | M | ★★★ | BT-01 | Core |
| BT-03 | Key detect + semitone transpose | BT | M | ★★★ | — | Core |
| BT-06 | Count-in | BT | S | ★★ | BT-01 (soft — has fallback) | **v0.4** |
| BT-07 | Speed trainer | BT | S/M | ★★ | BT-05 | Core |
| BT-08 | Section markers | BT | M | ★★ | XC-01 | Core |
| BT-09 | Playlists / setlists | BT | M | ★★★ | XC-01 | Core |
| BT-10 | Practice log | BT | S/M | ★ | — | Core |
| BT-11 | Per-stem EQ & pan | BT | M | ★★ | — | Core |
| BT-12 | Gain automation regions | BT | M | ★★ | — | Core |
| BT-17 | Waveform zoom | BT | S/M | ★★ | — | Core |
| BT-18 | Batch separate/export | BT | M | ★★ | — | Core |
| GP-01 | Chromatic tuner | GP | S/M | ★★★ | — | **v0.4** |
| GP-02 | Rig presets, per-song recall | GP | M | ★★★ | XC-01 | Core |
| GP-03 | Expanded pedalboard + reorder | GP | M/L | ★★★ | — | Core |
| GP-07 | Riff capture buffer | GP | M | ★★ | — | Core |
| GP-08 | Audio-only takes | GP | S | ★★ | — | Core |
| GP-11 | MIDI foot control | GP | M | ★★ | GP-02 | Core |
| GP-12 | Bounce performance into export | GP | M | ★★ | — | Core |
| VD-01 | Count-in + auto-punch | VD | S | ★★ | BT-06 | **v0.4** |
| VD-02 | Takes browser | VD | M | ★★★ | — | Core |
| VD-04 | Auto clap-sync wizard | VD | M | ★★ | — | **v0.4** |
| VD-06 | Recording overlays | VD | M | ★ | (BT-04 for chords) | Core |
| VD-07 | Social export presets | VD | S/M | ★★ | — | Core |
| XC-01 | Project format v2 | XC | M | ★★ | — | Core |
| XC-04 | Onboarding / in-app help | XC | S/M | ★ | — | Core |
| BT-04 | Chord detection lane | BT | L | ★★★ | BT-02 | Stretch |
| BT-13 | Next-gen separation models (guitar-stem focus) — **SHIPPED** | BT | L/XL | ★★★ | — | Done |
| BT-14 | Lead/rhythm guitar split — improve heuristic via BT-13, not ML | BT | M (near-term) / XL (true ML, shelved) | ★★★ | BT-13 (done) | Stretch |
| BT-15 | Artifact cleanup pass | BT | M/L | ★ | — | R&D |
| GP-04 | WaveNet .nam (WASM) | GP | L | ★★★ | — | Stretch |
| GP-06 | Looper pedal | GP | L | ★★ | (BT-02 for sync) | Stretch |
| GP-09 | Performance feedback scoring | GP | XL | ★★ | — | R&D |
| VD-05 | Multi-take practice mode | VD | M/L | ★★ | BT-05, VD-02 | Stretch |
| VD-08 | Side-by-side take compare | VD | M | ★ | VD-02 | Stretch |
| XC-05 | Native macOS app | XC | XL | ★★★ | stable feature set | Stretch |
| XC-06 | Windows parity | XC | M | ★ | — | Stretch |

### Suggested first slice (if you want a recommendation)

1. **BT-01 + BT-05 + BT-07** — BPM readout, real A/B loop, speed trainer: transforms the learn-a-solo workflow for a few days' work.
2. **GP-01 + GP-02** — tuner + rig presets: removes the two biggest Play Along frictions.
3. **VD-02 + VD-01** — takes browser + count-in/auto-punch: makes recording sessions self-contained.
4. Then the **BT-02 → BT-06 → BT-04** chain (beat grid → count-in → chords) as the "musical intelligence" arc, and **BT-13** evaluation in the background since it lifts quality everywhere.

---

## 7. Competitive scan sources

- Moises — stem separation incl. lead/rhythm guitar (Premium), smart metronome, chord detection, BPM, setlists: [moises.ai](https://moises.ai/), [Moises AI Review 2026 (StemSplit)](https://stemsplit.io/blog/moises-ai-review), [App Store listing](https://apps.apple.com/us/app/moises-the-musicians-app/id1515796612)
- Capo — chord detection, beat-snapped loop regions, named sections, 25–150% speed: [Capo for macOS](http://supermegaultragroovy.com/products/capo/mac/)
- Anytune — ±24 semitone pitch, 0.05× speed, marks, Step-It-Up trainer: [Anytune on Mac App Store](https://apps.apple.com/us/app/anytune-practice-perfected/id722444976?mt=12), [practice-app comparison](https://www.practicesession.app/blog/practice-session-vs-amazing-slow-downer-vs-anytune/)
- AmpliTube 5 — looper, tuner, recorder, VIR cabs, MIDI: [ikmultimedia.com](https://www.ikmultimedia.com/products/amplitube5/)
- Neural DSP — neural amp capture, snapshot preset switching: [amp-sim roundup](https://universityofrock.com/best-amp-sims-for-guitar/)
- Riff capture / looper category — [TC WireTap](https://www.sweetwater.com/store/detail/Wiretap--tc-electronic-wiretap-riff-recorder-pedal), [Songzap Loop Record](https://songzap.app/looprecord/), [Quantiloop](http://quantiloop.com/)
