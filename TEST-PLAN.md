# Orpheus Guitar Studio — Regression Test Plan

**Status:** covers the app through v3.0 (release-v3-spec.md, M1–M6). A
manual, real-hardware checklist — every item here needs an actual USB
audio interface + guitar (or at minimum real playback/mic input) to mean
anything; headless/automated checks in this codebase (Playwright DOM/JS
verification during development) cover wiring and math, never real-time
audio behavior, timing, or perceived quality. Run this after any change
that touches the areas it covers, not just at release time.

Checkbox format is for your own copy — tick as you go. Group headers
roughly match the sidebar/UI areas so a targeted change only needs its own
section re-run, not the whole file. For a first-time walkthrough in the
order a new user would actually hit each feature (rather than grouped by
app area), see [FIRST-SESSION-CHECKLIST.html](FIRST-SESSION-CHECKLIST.html)
instead — open it directly in a browser, no server required.

---

## 1. Import & Separation

- [ ] Drag-and-drop an audio file onto the sidebar imports it and it appears in the Library.
- [ ] Click-to-import (file picker) works the same way.
- [ ] Selecting a track with no cached stems shows "Separate" and produces stems within a minute or two.
- [ ] Switching models on an already-separated track re-separates (or reuses a cache hit for a model already run).
- [ ] Re-running separation on a track whose source file changed on disk shows the stale banner; Re-separate/Dismiss both work.

## 2. Mixer

- [ ] Each stem lane's Mute/Solo/fader work independently; Solo silences every other lane; un-soloing restores the prior mute state.
- [ ] Waveforms render for every stem and match audible content roughly (peaks track loud passages).
- [ ] Mute-lane click-drag paints a region; clicking an existing region removes it; painted regions match what actually mutes on playback.
- [ ] A/B loop: dragging both ruler handles sets a region; Loop toggle enables/disables; playback wraps correctly at the loop boundary.
- [ ] **Pan (BT-11):** dragging a stem's Pan slider audibly moves it left/right; label reads correctly (C / L50 / R30 etc.).
- [ ] **Per-stem EQ (BT-11):** the EQ disclosure toggles open/closed; each of Bass/Mid/Treble audibly changes that stem's tone; Solo/Pan/EQ do NOT affect what gets exported (§9 below).
- [ ] **Section markers (BT-08):** **+ Marker** drops a marker at the playhead and prompts for a name; clicking a marker seeks to it; double-clicking loops from it to the next marker (or track end) and turns Loop on; hovering reveals a delete **×**; markers persist across a reload of the same song.
- [ ] **Waveform zoom (BT-17):** with a loop set, **Zoom to loop** rescales the ruler/waveforms to that region with real added detail (not the same picture stretched); ruler clicks, loop-handle drags, and mute-painting all still land on the correct time while zoomed; **Zoom out** restores the full view; zoom resets on track switch.
- [ ] **Finer nudge (BT-17):** Alt+←/→ moves the playhead in ~100ms steps (Shift+←/→ still does 5s).
- [ ] **Beat grid + Click (BT-02):** faint beat ticks appear on the ruler (brighter = downbeat) once a track's analysis includes them; the **Click** toggle produces an audible metronome click synced to those beats during playback, accenting every 4th beat; toggling Click on/off (including mid-playback), seeking, and looping don't cause the click to drift or burst; on a track separated by an older app version, Click is grayed out at most once — reselecting the track re-analyzes and enables it.
- [ ] **Speed Trainer (BT-07):** **Start at Start%** sets Speed to the configured percentage; **Step up** increases Speed by Step%, clamping exactly at Target% without overshooting; BPM display scales with Speed throughout.
- [ ] **Key detection + Tune (BT-03):** the inspector shows a detected key (with a confidence caveat); moving Tune shows the resulting transposed key live; Tune's range covers a full octave (±1200¢).
- [ ] Speed/Tune reset to unity on track switch; Volume does not.
- [ ] **BPM correction:** on a track where the detected BPM looks halved/doubled from the real tempo, the ½×/2× buttons fix it in one click and the correction is remembered on reselecting that song later.
- [ ] Count-in (2 bars of click) plays before playback starts when enabled, synced to the track's detected BPM.

## 3. Guitar Split (experimental)

- [ ] Split panel only appears once a `guitar` stem exists; Spectral and Mid-side methods both run and report a correlation figure; both candidates are audibly different pans of the same take.

## 4. Screen nav (Mixer / Tone Lab / Play Along / Help)

- [ ] All 4 sidebar buttons (🎚 Mixer, 🎛 Tone Lab, 🎸 Play Along, ❓ Help) are visually identical in size/shape; the current screen's button (Mixer/Tone Lab/Play Along only — Help never does) shows an active/highlighted state.
- [ ] Opening Tone Lab while Play Along is open closes Play Along, and vice versa — never both visible at once; Mixer closes whichever is open.
- [ ] Selecting a track in the Library from either Tone Lab or Play Along drops back to the Mixer (both overlays close).
- [ ] Opening either Tone Lab or Play Along for the first time after a track loads builds the rig (Enable Input becomes usable, meters move) without needing to visit the other screen first.

## 5. Play Along — top strip

- [ ] Backing Track transport (Play/Stop/Loop/Count-in/BPM/Speed/Tune/Volume) mirrors the mixer's own state in both directions.
- [ ] Tuner: toggling on mutes both the backing track and your live guitar tone (both restore to their actual prior levels, not just unity, on toggling off); note/cents/needle read correctly against a tuned reference.
- [ ] Double-clicking the Speed/Tune value readout (mixer and Play Along) resets that slider to 1.00×/0¢; double-clicking a stem's volume percentage in the mixer resets it to 100%.
- [ ] **Rig Preset quick-picker:** shows the same list and current selection as Tone Lab's Rig Presets dropdown at all times; picking a name here applies it immediately (no separate Load click) and updates Tone Lab's dropdown to match.
- [ ] **Rig preset auto-recall:** attaching a preset (from Tone Lab), reselecting the track (or any other track and back), and reopening either Tone Lab or Play Along recalls the rig AND shows the "attach" checkbox (Tone Lab) still checked against the right preset name.
- [ ] **Auto-calibrate:** requires Input enabled first (with an instrument connected, not a bare microphone) and says so clearly if it isn't; with a genuine pause before strumming, the reported offset falls in a plausible range (roughly 50-300ms); an implausible result says so explicitly rather than silently applying a bad number.
- [ ] **Riff Capture (GP-07):** "Save that!" (with no prior setup) saves a WAV file capturing roughly the last ~20s of backing+guitar audio; saving doesn't interrupt the rolling capture (playing right after and saving again produces a second, different riff file); riff files are numbered independently from regular takes; the rolling capture starts whether you open Tone Lab or Play Along first.

## 6. Tone Lab — input & pedalboard

- [ ] Input: meter and clip light respond to real input level; clip light latches until Clear or a new input session; the device/Calibrate disclosure stays open across uses until you collapse it yourself.
- [ ] **Default input device:** with a USB interface connected and mic permission already granted in a prior session, "Enable Input" defaults to the USB interface, not the Mac's built-in mic; switching devices and reopening Tone Lab later remembers the last device used.
- [ ] Every rig card's collapse arrow hides/reveals its content; collapse state persists across a reload.
- [ ] Amp modes (Clean/Analog/Neural) switch cleanly with no clicks/pops; only the active mode's chain produces sound.
- [ ] **NAM Tweaker (V3-T1):** loading a `.nam` capture shows its metadata (or an honest "no metadata" message), architecture, and speed-probe percentage; Drive (renamed from Input trim, now -24..+48dB) audibly changes distortion character; the post-NAM Bass/Mid/Treble/Presence tone stack is flat by default and audibly shapes tone when moved; Output level shows an auto-calibration readout when the capture has no loudness metadata; loading a parametric (non-WaveNet) capture shows the "not yet supported" message instead of a confusing failure.
- [ ] **NAM live-overrun guardrail (V3-E3):** a capture that clears the offline speed probe but turns out too slow live rolls back automatically within ~100ms of going live, restoring the previous rig state and updating the status text — verify on a friend's/older Mac if possible, since this is exactly the case the offline probe alone can miss.
- [ ] Cab IR: picking one turns bypass off automatically; bypass toggle is audible.
- [ ] **IR tone shaper (v3.1 §2.3):** Low cut/High cut sliders are audible when Tone shape bypass is unchecked; toggling Tone shape bypass on returns to the untouched IR sound (wide open, no audible change from IR-alone); the dry (IR-bypassed) path is unaffected by these sliders regardless of their position.
- [ ] Post-chain EQ/Compressor/Delay/Reverb: each bypass is audible and independent; parameter sliders behave as labeled.
- [ ] **Expanded pedalboard (v3.1 §2.2, post-v3-backlog-audit.md §2.2):** each of the eight new cards — Boost/Overdrive, Graphic EQ, Chorus, Flanger, Phaser, Tremolo, Auto-Wah, Octaver — is audible when unbypassed and transparent when bypassed; every slider audibly changes its labeled parameter (Rate/Depth/Mix/Feedback/Drive/Level/Blend/Center as applicable). Octaver is expected to track cleanly only on single notes and get messy on chords — that's the documented limitation, not a bug. Auto-Wah sweeps on its own timer and is NOT expected to respond to picking dynamics or an expression pedal.
- [ ] **Drag-to-reorder (GP-03, extended v3.1):** dragging any of the twelve reorderable cards (Cab IR, EQ, Compressor, Delay/Reverb, Boost, Graphic EQ, Chorus, Flanger, Phaser, Tremolo, Auto-Wah, Octaver) by its ⠿ handle to a new position changes the actual signal chain order (audibly — e.g. Auto-Wah before vs. after Boost sounds different); Gate and Amp stay fixed at the front, Output stays fixed at the end; order persists across reloads.
- [ ] **Signal-flow arrows (v3.1 §3):** an arrow is visible between each consecutive pair of cards in chain order; dragging a card to reorder, collapsing/expanding a card, and resizing the window (including crossing the 900px single-column breakpoint) all redraw the arrows to match the new layout without a page reload; no arrow ever points to/from a nonexistent card.
- [ ] Output level slider and meter respond correctly; latency estimate shows on Tone Lab open (labeled as browser-reported, not measured).
- [ ] Suggest (NAM or Analog) picks a plausible tone from the loaded guitar stem, skips overly-heavy captures, and is clearly labeled as a rough heuristic.
- [ ] **Rig presets (V3-T2/GP-02, extended v3.1):** saving captures the full rig (amp mode, NAM capture + Tweaker knobs, IR + tone shaper, EQ, Comp, Delay/Reverb, the eight new pedals, Output, pedal order); loading a preset restores every one of those; Attach to this song + reload the song auto-recalls the preset the next time either Tone Lab or Play Along opens; deleting a preset that's attached to the current song detaches it; a preset saved before v3.1 (missing the new fields) loads without error, leaving the new pedals at their default state.

## 7. Recording

- [ ] The Record performance and Takes cards are on the Play Along screen, always visible with the camera/quality/sync setup expanded by default.
- [ ] **Audio-only takes (GP-08):** with no camera enabled, Record produces a `.m4a`/`.webm` audio file and the mode hint says "audio-only" beforehand; enabling a camera switches the hint to "will include video" and produces a video file as before.
- [ ] Camera preview only appears once a camera is actually enabled (no permanent black box beforehand); framing guides toggle correctly.
- [ ] Record/Stop works with and without "start backing track"/count-in; the REC pill appears in the main toolbar while recording and is clickable to jump back to Play Along; Stop also stops the backing track.
- [ ] A take finalizes (remuxes) and offers Reveal/Discard; A/V sync calibration (auto and manual) produces a sensible offset for a video take.
- [ ] Takes list: star/rename/reveal/delete all work; Play loads a take into the inline player; Trim start/end produces a new, losslessly-trimmed file without touching the original.

## 8. Projects

- [ ] Mix/loop/markers/rig-preset-attachment autosave a moment after changing and restore on reselecting the same song.
- [ ] **Rename-following (M6):** save a project, rename the source file in Finder/on disk, reselect the (now differently-named) track — the mix/loop/markers all still load correctly.
- [ ] The Library sidebar shows a small dot next to any track with a saved project.
- [ ] A project saved before this v3 checkpoint (filename-keyed) still loads correctly the first time, and migrates to the new scheme transparently.

## 9. Export

- [ ] Export bounces exactly the mixer's mute/gain state (NOT solo, pan, or per-stem EQ — those are monitoring-only); format (WAV/MP3), output name, target LUFS, normalize toggle, and boost cap all take effect.

## 10. Cross-cutting

- [ ] **In-app Help (XC-04):** auto-shows on first-ever launch; reachable any time via the sidebar's ❓ button; doesn't reappear on later launches.
- [ ] Keyboard shortcuts legend (**?**) lists every current shortcut accurately, including Alt for the fine nudge; none of the shortcuts fire while a text field has focus.
- [ ] AudioContext survives being backgrounded/idled (no full-silence lockup requiring a page reload) — V3-E1's event-driven resume.
- [ ] Stems and NAM/IR files load fast on repeat selection (server-side caching, V3-E4) rather than re-downloading in full every time; a video take seeks correctly (Range support).
