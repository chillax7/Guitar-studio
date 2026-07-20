# Orpheus Guitar Studio — Regression Test Plan

**Status:** covers every area of the app, including the Rate My Take CLI
research spike. A manual, real-hardware checklist — every item here needs
an actual USB audio interface + guitar (or at minimum real playback/mic
input) to mean anything; headless/automated checks in this codebase
(Playwright DOM/JS verification during development) cover wiring and
math, never real-time audio behavior, timing, or perceived quality. Run
this after any change that touches the areas it covers, not just at
release time.

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
- [ ] **Stem-pack ZIP import:** clicking "or import a stem pack (.zip)" (or dropping a `.zip` anywhere on the sidebar — it's routed automatically, not treated as a broken audio file) imports every audio file inside as its own stem lane, named exactly as the file was; long names wrap in the lane header instead of overflowing.
- [ ] The imported track shows the mixer immediately on selection — no Separate step — with the model badge reading `imported`, and does **not** appear anywhere with a `.zip` extension in the Library list.
- [ ] BPM, beat grid, chord lane, and detected key all populate for an imported stem pack, matching a real reference (not blank/zero) — this depends on fuzzy stem-name matching since an imported pack's names won't match the app's usual fixed vocabulary.
- [ ] A zip with two files that would collide to the same sanitized stem name fails up front with a message naming both files, rather than silently overwriting one.
- [ ] A non-zip file or a zip with no usable audio inside fails with a clear message, not a crash; `__MACOSX/`/`._*` junk entries in a real Finder-compressed zip are silently ignored, not shown as broken stems.
- [ ] **Custom stems (v4.7):** dragging an MP3/WAV onto the mixer's lane area for an already-separated track shows the "Drop to add as a new stem" overlay while dragging, and adds it as a new lane tagged **custom** on drop — mute/solo/fader/pan/EQ/mute-painting/export all work on it identically to a model-produced stem. Dropping onto the lane area on a track with **no** separated stems yet does nothing (no overlay, no upload attempt).
- [ ] A custom stem survives switching to a different separation model for the same song (it isn't tied to whichever model produced the other stems) **and** survives re-separating (even with force/Re-separate) — it should never disappear or need re-adding.
- [ ] Dragging in a same-named file again replaces the existing custom stem rather than erroring or duplicating it.
- [ ] The **✕** next to a custom stem's name removes it (after a confirmation) and it's gone from the lane list immediately.
- [ ] A custom stem literally named "guitar" does **not** trigger the Guitar Split panel (§5) — only a real model-produced `guitar` stem should.
- [ ] **Custom stem timeline positioning (GP-15):** the cursor turns to ↔ over a custom stem's waveform; dragging it left/right slides the clip and leaves blank space in the lane before/after it; a plain click (no drag) still seeks the transport like any other lane instead of moving the clip. The blank/waveform boundary tracks correctly across zoom levels and after scrolling. Reloading the page keeps the clip wherever it was dropped. If playback is running when you drop it, it resyncs immediately — audible if the clip is muted or unmuted right around the seam. Exporting bounces the clip at its dropped position, not song-start. Repositioning with Speed or Tune off their defaults is a known limitation — the clip is expected to play from the wrong spot until they're back to 1.00×/0¢, not something to file as a new bug.

## 2. Rip system audio

- [ ] With no BlackHole-named input device present, the Rip panel shows install instructions (`brew install blackhole-2ch`) rather than a confusing empty/silent device list.
- [ ] With BlackHole installed and selected as the Mac's output, the device dropdown auto-selects it and the hint text explains you'll hear silence while ripping unless a Multi-Output Device is also set up.
- [ ] **Start Rip** requests input permission (first time only) and visibly starts (button swaps to Stop, elapsed time counts up).
- [ ] **Stop Rip** prompts for a name, uploads, and the resulting mp3 appears in the Library, selectable and playable like any normal import.
- [ ] Audio actually played through BlackHole during the capture window is present and audible in the resulting file.

## 3. Library — Playlists & Practice log

- [ ] **Playlists:** no standalone "Playlists" section or "+ New playlist" button above the Library — a playlist is created from a song's own row (click its **+**, then **+ New playlist…**), seeded with that song. A playlist appears as its own collapsible group below All Tracks, in playlist order, with **▲ / ▼** reorder and **✕** remove controls on each member row; its header carries **◀ Prev** / **+ Add current song** / **Next ▶** / **✎ Rename** / **✕ Delete**. Deleting a playlist never deletes the songs in it.
- [ ] A song can belong to any number of playlists at once and always still shows under All Tracks too — adding it to a playlist is never a move.
- [ ] **◀ Prev** / **Next ▶** step through the playlist relative to the loaded song and stop at either end (no wraparound); clicking any song in either view loads it the normal way (project auto-recall included).
- [ ] Playlists persist across a server restart (stored server-side, shared across songs like rig presets).
- [ ] **Library button styling:** every small utility button in the Library section (rename/delete on a track row, the playlist add/prev/next/rename/delete controls, reorder/remove on a playlist member row) shares the same subtle look — dim panel background, dim text, blue outline — not solid blue; solid blue is reserved for real primary actions elsewhere (Separate, Enable Input, etc.), not a whole cluster of small icon buttons here.
- [ ] **Practice log:** a song's Library row shows a small dim time readout (e.g. "12m") once you've played it for at least a minute, with the exact total + last-practiced date in the tooltip; time accumulates during real playback (Mixer or Play Along, any reason playback is running) and stops accumulating when paused/stopped.
- [ ] Practice time follows a renamed source file (content-hash keyed) the same way projects do.
- [ ] **Practice log session grouping:** playing a song, pausing for several minutes (well past the old 120s gap) without selecting a different song, then resuming and playing more — should land in the SAME session row, not a new one. Switching to a different song for a real stretch and then back should still start a new row. Leaving the same song loaded and idle for several hours (a genuinely new sitting, even with no other song touched in between) should also start a new row rather than merging into a days-old one.

## 4. Mixer

- [ ] Each stem lane's Mute/Solo/fader work independently; Solo silences every other lane; un-soloing restores the prior mute state.
- [ ] Waveforms render for every stem and match audible content roughly (peaks track loud passages).
- [ ] Mute-lane click-drag paints a region; clicking an existing region removes it; painted regions match what actually mutes on playback.
- [ ] A/B loop: dragging both ruler handles sets a region; Loop toggle enables/disables; playback wraps correctly at the loop boundary.
- [ ] **Pan:** dragging a stem's Pan slider audibly moves it left/right; label reads correctly (C / L50 / R30 etc.).
- [ ] **Per-stem EQ:** the EQ disclosure toggles open/closed; each of Bass/Mid/Treble audibly changes that stem's tone; Solo/Pan/EQ do NOT affect what gets exported (§11 below).
- [ ] **Section markers:** **+ Marker** drops a marker at the playhead and prompts for a name; clicking a marker seeks to it; double-clicking loops from it to the next marker (or track end) and turns Loop on; hovering reveals a delete **×**; markers persist across a reload of the same song.
- [ ] **Waveform zoom (Zoom to loop / Zoom out):** with a loop set, **Zoom to loop** rescales the ruler/waveforms to that region with real added detail (not the same picture stretched); ruler clicks, loop-handle drags, and mute-painting all still land on the correct time while zoomed; **Zoom out** restores the full view; zoom resets on track switch.
- [ ] **Continuous zoom (Zoom slider):** dragging the slider widens the ruler/waveforms/chord lane beyond the window and the area becomes horizontally scrollable; stem names + M/S/fader/pan/EQ controls stay pinned on the left while scrolling (never scroll away, never show waveform content underneath them); click-to-seek, loop-handle drag, and mute-painting all remain correct at any zoom/scroll position.
- [ ] **Continuous zoom during playback:** the view follows the playhead once it crosses the middle of the visible window, and snaps back to center on a big jump (loop wrap, marker double-click, manual seek) rather than leaving the playhead off-screen.
- [ ] **Continuous zoom composes with Zoom to loop:** zooming to a loop first, then dragging the slider, zooms in further within just that region; double-clicking the slider resets to fit-width; both zoom mechanisms reset together on track switch.
- [ ] **Chord lane:** once a track has chord analysis, a row of chord chips appears above the ruler; chips span multiple beats when the chord holds (not one sliver per beat); clicking a chip jumps the playhead there; low-confidence beats (e.g. palm-muted chugs) show as a dimmed **?** rather than a guess; chord roots transpose live with the Tune slider.
- [ ] **Finer nudge:** Alt+←/→ moves the playhead in ~100ms steps (Shift+←/→ still does 5s).
- [ ] **Beat grid + Click:** faint beat ticks appear on the ruler (brighter = downbeat) once a track's analysis includes them; the **Click** toggle produces an audible metronome click synced to those beats during playback, accenting every 4th beat; toggling Click on/off (including mid-playback), seeking, and looping don't cause the click to drift or burst.
- [ ] **Speed Trainer:** **Start at Start%** sets Speed to the configured percentage; **Step up** increases Speed by Step%, clamping exactly at Target% without overshooting; BPM display scales with Speed throughout.
- [ ] **Key detection + Tune:** the inspector shows a detected key (with a confidence caveat) — on a song with a clear chord progression, sanity-check the detected key/root against what the chord lane is actually showing (they should agree, since key detection now defers to the chord lane's own data when it's confident); moving Tune shows the resulting transposed key live; Tune's range covers a full octave (±1200¢).
- [ ] Speed/Tune reset to unity on track switch; Volume does not.
- [ ] **BPM correction:** on a track where the detected BPM looks halved/doubled from the real tempo, the ½×/2× buttons fix it in one click and the correction is remembered on reselecting that song later.
- [ ] Count-in (2 bars of click) plays before playback starts when enabled, synced to the track's detected BPM.

## 5. Guitar Split (experimental)

- [ ] Split panel only appears once a `guitar` stem exists; Spectral, Mid-side, and Hybrid methods all run and report a correlation figure; all three candidates are audibly plausible pans/variants of the same take.
- [ ] The currently-selected method button is visibly highlighted (brighter/ringed, not just the same blue every button already is) — clicking a different method moves the highlight.
- [ ] Hybrid falls back gracefully (no error) on a track with no beat grid.

## 6. Screen nav (Mixer / Tone Lab / Play Along / AI Lab / Help)

- [ ] The 4 real-screen sidebar buttons (🎚 Mixer, 🎛 Tone Lab, 🎸 Play Along, 🧠 AI Lab) are visually identical in size/shape and sit together in one 2x2 group; ❓ Help sits on its own row underneath them, same button style, never gets an active/highlighted state.
- [ ] The current screen's button (Mixer/Tone Lab/Play Along/AI Lab) shows an active/highlighted state that updates as you switch screens.
- [ ] The top banner shows the app name/version on the left and the current screen name (Mixer/Tone Lab/Play Along/AI Lab) centered on the full window width, in all four screens — no overlap between the banner and any rig screen's own header.
- [ ] Opening any one of Tone Lab / Play Along / AI Lab closes whichever of the other two was open — never two visible at once; Mixer closes whichever is open.
- [ ] Selecting a track in the Library from Tone Lab, Play Along, or AI Lab drops back to the Mixer (all overlays close).
- [ ] Opening either Tone Lab or Play Along for the first time after a track loads builds the rig (Enable Input becomes usable, meters move) without needing to visit the other screen first.
- [ ] **Sidebar resize:** dragging the seam where the sidebar meets the canvas (cursor turns to ↔) resizes it live; it won't go narrower/wider than the set min/max; double-clicking the seam resets it to the default width; the chosen width survives a page reload; nothing in the sidebar (buttons, track rows, playlist names) overlaps or clips oddly at a much narrower or much wider setting.

## 6a. AI Lab — Scale/Mode Advisor (V5-F2)

- [ ] **Per chord mode:** a chord ribbon (same chords as the Mixer's chord lane) sits above a stacked, scrollable list of every scale/mode that fits the selected chord's root+quality — each with its own labeled 24-fret fretboard diagram (position markers at 3/5/7/9/12/15/17/19/21/24), not one diagram behind a click. On first opening AI Lab, whichever chord region contains the current playhead position is auto-selected, not just chord #1.
- [ ] Clicking a different chord chip re-picks that chord's scale stack and seeks the playhead there, same as the Mixer's own chord lane; a chord with no confident read shows dimmed/unclickable, with an honest empty-state message instead of a suggestion.
- [ ] **Whole song mode:** the toggle switches to scales for the song's overall detected key instead of one chord; today this is always exactly one key region (windowed/segmented key-change detection is backlog, not built — release-v5-spec.md §2a/§9), and the screen says so honestly rather than implying it detects modulations it doesn't yet.
- [ ] Moving the Tune slider live-updates AI Lab's chord names, key name, and which fret is marked as the root — same transposition the chord lane and key hint already apply, checked in both Per chord and Whole song modes.
- [ ] The scale-name chips above the stack jump-scroll to that scale's diagram rather than hiding the others; a track with no chord analysis yet shows an honest message in Per chord mode instead of an empty blank area.
- [ ] Switching tracks while AI Lab is open re-renders against the new track's chords/key (and re-picks the chord under the playhead) rather than showing stale data from the previous track.

## 7. Play Along — top strip

- [ ] Backing Track transport (Play/Stop/Loop/Count-in/BPM/Speed/Tune/Volume) mirrors the mixer's own state in both directions.
- [ ] Tuner: toggling on mutes both the backing track and your live guitar tone (both restore to their actual prior levels, not just unity, on toggling off); note/cents/needle read correctly against a tuned reference.
- [ ] Double-clicking the Speed/Tune value readout (mixer and Play Along) resets that slider to 1.00×/0¢; double-clicking a stem's volume percentage in the mixer resets it to 100%.
- [ ] **Rig Preset quick-picker:** shows the same list and current selection as Tone Lab's Rig Presets dropdown at all times; picking a name here applies it immediately (no separate Load click) and updates Tone Lab's dropdown to match.
- [ ] **Rig preset chain auto-recall (GP-14):** adding presets to a song's chain (Tone Lab), reselecting the track (or any other track and back), and reopening either Tone Lab or Play Along recalls whichever chain entry was active last, and Tone Lab's chain list shows the same chain with the right row highlighted.
- [ ] **Auto-calibrate:** requires Input enabled first (with an instrument connected, not a bare microphone) and says so clearly if it isn't; with a genuine pause before strumming, the reported offset falls in a plausible range (roughly 50-300ms); an implausible result says so explicitly rather than silently applying a bad number.
- [ ] **Riff Capture:** "Save that!" (with no prior setup) saves a WAV file capturing roughly the last ~20s of backing+guitar audio; saving doesn't interrupt the rolling capture (playing right after and saving again produces a second, different riff file); riff files are numbered independently from regular takes; the rolling capture starts whether you open Tone Lab or Play Along first.

## 8. Tone Lab — input & pedalboard

- [ ] Input: meter and clip light respond to real input level; clip light latches until Clear or a new input session; the device/Calibrate disclosure stays open across uses until you collapse it yourself.
- [ ] **Default input device:** with a USB interface connected and mic permission already granted in a prior session, "Enable Input" defaults to the USB interface, not the Mac's built-in mic; switching devices and reopening Tone Lab later remembers the last device used.
- [ ] **Icon chain (v4.7 redesign):** the chain row shows one icon per stage (Gate, Amp, all 12 pedals, Output) in signal order, wrapping to a second row on a narrow window; exactly one panel is open below at a time; clicking a different icon swaps which panel is showing; on first opening Tone Lab, Gate's panel is open by default (its bypass checkbox is the first thing visible). An icon lights up (blue) when its stage is unbypassed and dims when bypassed, updating live as you toggle that stage's own bypass checkbox — including via a loaded rig preset, not just a manual click.
- [ ] Amp modes (Pass Through/Analog/Neural) switch cleanly with no clicks/pops; only the active mode's chain produces sound.
- [ ] **NAM Tweaker:** loading a `.nam` capture shows its metadata (or an honest "no metadata" message), architecture, and speed-probe percentage; Drive (-24..+48dB) audibly changes distortion character; the post-NAM Bass/Mid/Treble/Presence tone stack is flat by default and audibly shapes tone when moved; Output level shows an auto-calibration readout when the capture has no loudness metadata; loading a parametric (non-WaveNet) capture shows the "not yet supported" message instead of a confusing failure.
- [ ] **NAM live-overrun guardrail:** a capture that clears the offline speed probe but turns out too slow live rolls back automatically within ~100ms of going live, restoring the previous rig state and updating the status text — verify on a friend's/older Mac if possible, since this is exactly the case the offline probe alone can miss.
- [ ] Cab IR: picking one turns bypass off automatically; bypass toggle is audible.
- [ ] **Cab IR loudness:** loading an IR shouldn't cut the overall volume by a large amount compared to bypassed — switching between a few different IR files should sound roughly similar in loudness to each other (peak-normalized on load), not wildly different depending on how "hot" each source file happened to be recorded.
- [ ] **IR tone shaper:** Low cut/High cut sliders are audible when Tone shape bypass is unchecked; toggling Tone shape bypass on returns to the untouched IR sound (wide open, no audible change from IR-alone); the dry (IR-bypassed) path is unaffected by these sliders regardless of their position.
- [ ] Post-chain EQ/Compressor/Delay/Reverb: each bypass is audible and independent; parameter sliders behave as labeled.
- [ ] **Expanded pedalboard:** each of the eight extra cards — Boost/Overdrive, Graphic EQ, Chorus, Flanger, Phaser, Tremolo, Auto-Wah, Octaver — is audible when unbypassed and transparent when bypassed; every slider audibly changes its labeled parameter (Rate/Depth/Mix/Feedback/Drive/Level/Blend/Center as applicable). Octaver is expected to track cleanly only on single notes and get messy on chords — that's the documented limitation, not a bug. Auto-Wah sweeps on its own timer and is NOT expected to respond to picking dynamics or an expression pedal.
- [ ] **Auto-Wah mix range:** at 100% Mix the sweep should be clearly dominant/dramatic, not faint — it's a real dry/wet crossfade (100% = filtered signal alone, no unfiltered dry underneath), unlike Chorus/Flanger/Phaser's Mix, which always keeps the dry signal at full volume underneath the wet by design.
- [ ] **Octaver pitch stability:** playing and holding a single clean note (low E through around the 12th fret on any string) produces a steady one-octave-down pitch that doesn't waver, drift, or intermittently jump to the wrong octave for the duration of the note — across a few different notes and pick dynamics (soft/hard), not just one.
- [ ] **Tremolo depth range:** at low Depth the effect is subtly audible; at 100% Depth it should chop all the way down to near-silence at the bottom of each cycle, not just a mild volume wobble — if 100% still sounds subtle, that's a regression of the depth-scaling fix, not expected behavior.
- [ ] **Drag-to-reorder:** dragging any of the thirteen reorderable icons (Amp, Cab IR, EQ, Compressor, Delay/Reverb, Boost, Graphic EQ, Chorus, Flanger, Phaser, Tremolo, Auto-Wah, Octaver) left/right in the chain row to a new position changes the actual signal chain order (audibly — e.g. Auto-Wah before vs. after Boost sounds different); Gate stays fixed at the front, Output stays fixed at the end; order persists across reloads and works the same whether the icon wraps to a second row or not.
- [ ] **Amp reordering (v4.7):** dragging Amp's own icon anywhere in the row — including before a pedal like Wah or Boost, so the signal is guitar → pedal → Amp — works exactly like reordering any other pedal; clicking Amp's icon afterward still opens its normal 3-mode panel; switching amp modes and reloading the page both preserve wherever Amp was dragged to.
- [ ] Output level slider and meter respond correctly; latency estimate shows on Tone Lab open (labeled as browser-reported, not measured). **Output bypass:** checking it forces unity gain regardless of the slider position (audible if the slider isn't at 0dB); unchecking it restores the slider's level immediately; the Output icon in the chain row dims/lights with this bypass exactly like every other stage.
- [ ] Suggest (NAM or Analog) picks a plausible tone from the loaded guitar stem, skips overly-heavy captures, and is clearly labeled as a rough heuristic.
- [ ] **Rig presets:** saving captures the full rig (amp mode, NAM capture + Tweaker knobs, IR + tone shaper, EQ, Comp, Delay/Reverb, the eight extra pedals, Output, pedal order); loading a preset restores every one of those.
- [ ] **Rig preset chain (GP-14):** "+ Add to this song's chain" appends whichever preset is selected in the dropdown; the chain list shows each entry numbered with the active one highlighted; clicking a row jumps to it live; dragging a row reorders the chain and persists across reloads; "✕" removes an entry without touching the live rig; deleting a preset (via Delete above) that's in the current chain removes it from the chain too.
- [ ] **Cycle keys (GP-14):** pressing the forward key (default `→`) while Tone Lab or Play Along is open advances to the next chain entry and wraps back to the first after the last one; the backward key (default `←`) does the same in reverse; either key does nothing with 0 or 1 chain entries; both are inert while a text field has focus; each key's own "Change…" captures the next key pressed for that direction (Esc cancels) and it's remembered per song; switching presets this way has no audible pop/click on a same-capture swap, and shows as a longer (but still clean) transition when the new preset loads a different NAM capture or IR.
- [ ] **Arrow-key handoff:** with the Mixer showing (both rig screens closed), `←`/`→` nudge the playhead as before; opening Tone Lab or Play Along and pressing `←`/`→` cycles the rig preset chain INSTEAD — the playhead does not also move, and closing back to the Mixer restores the nudge behavior.

## 9. Recording

- [ ] The Record performance and Takes cards are on the Play Along screen, always visible with the camera/quality/sync setup expanded by default.
- [ ] **Audio-only takes:** with no camera enabled, Record produces a `.m4a`/`.webm` audio file and the mode hint says "audio-only" beforehand; enabling a camera switches the hint to "will include video" and produces a video file as before.
- [ ] Camera preview only appears once a camera is actually enabled (no permanent black box beforehand); framing guides toggle correctly.
- [ ] Record/Stop works with and without "start backing track"/count-in; the REC pill appears in the main toolbar while recording and is clickable to jump back to Play Along; Stop also stops the backing track.
- [ ] A take finalizes (remuxes) and offers Reveal/Discard; A/V sync calibration (auto and manual) produces a sensible offset for a video take.
- [ ] Takes list: star/rename/reveal/delete all work; Play loads a take into the inline player; Trim start/end produces a new, losslessly-trimmed file without touching the original.
- [ ] **Practice mode (auto-retake on loop):** with a loop region set and Loop on, checking "Practice mode: auto-retake each loop pass" starts the backing track from the top of the loop and begins recording; each time playback wraps the loop, the just-finished pass saves as its own take and a new recording starts immediately, with the backing track never stopping in between; unchecking the box (or stopping playback) saves whatever pass was in progress as a normal take and re-enables the manual Record button.
- [ ] **Compare two takes:** checking the box on two rows in the Takes list opens a Compare Takes card; both takes play back together from the same starting point and stay in sync; the Listening: A/B toggle switches which one is audible without breaking sync or restarting either; the shared seek bar scrubs both at once; a third checkbox can't be selected until one of the first two is unchecked.
- [ ] **Compare Takes layout:** the card is full-width (same width as Practice Log below it, not squeezed into the narrower Record/Takes column width) and sits just above Practice Log; both videos have real, comparable size side by side, not cramped.

## 10. Projects

- [ ] Mix/loop/markers/rig-preset-attachment autosave a moment after changing and restore on reselecting the same song.
- [ ] **Rename-following:** save a project, rename the source file in Finder/on disk, reselect the (now differently-named) track — the mix/loop/markers all still load correctly.
- [ ] The Library sidebar shows a small dot next to any track with a saved project.

## 11. Export

- [ ] Export bounces exactly the mixer's mute/gain state (NOT solo, pan, or per-stem EQ — those are monitoring-only); format (WAV/MP3), output name, target LUFS, normalize toggle, and boost cap all take effect.

## 12. Rate My Take (CLI research spike — no UI yet)

This is a command-line tool, not an in-app feature — there's nothing to
click in the browser for this section. The actual point of running it is
a judgment call only a human can make (§6 of rate-my-take-spec.md): do
the scores and heatmap match what your ears say happened?

- [ ] Record three real short takes of a part you know well: one tight, one deliberately sloppy, one a tasteful variation.
- [ ] Run each through `python3 backing_track.py rate <take.wav> "input/<song>.mp3" --model bs_roformer_sw --offset <seconds>` (offset = where in the song the take starts) — each run prints per-beat scores, an overall closeness percentage, and writes a heatmap PNG next to the take.
- [ ] The command runs cleanly on a track with no beat grid (falls back to fixed 0.5s scoring windows) and reports a clear error (not a crash) if `--offset` is wrong enough that nothing scores.
- [ ] **The actual test:** do the three takes rank tight > variation > sloppy? Does the heatmap's red (low-agreement) zones line up with where the sloppy take actually fell apart, by ear? Note the result here either way — a "no" is a useful, expected possible outcome at this stage, not a bug to fix.

## 13. Cross-cutting

- [ ] **In-app Help:** auto-shows on first-ever launch; reachable any time via the sidebar's ❓ button; doesn't reappear on later launches.
- [ ] Keyboard shortcuts legend (**?**) lists every current shortcut accurately, including Alt for the fine nudge; none of the shortcuts fire while a text field has focus.
- [ ] AudioContext survives being backgrounded/idled (no full-silence lockup requiring a page reload).
- [ ] Stems and NAM/IR files load fast on repeat selection (server-side caching) rather than re-downloading in full every time; a video take seeks correctly (Range support).
