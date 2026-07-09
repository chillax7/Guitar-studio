# Guitar Studio v0.4 "Orpheus" — Release Specification

**Status:** planning document — nothing in here is built yet. Scopes the next release: 14 items selected from [enhancements-backlog.md](enhancements-backlog.md) — **BT-01, BT-05, BT-06, BT-16, GP-01, GP-05, GP-10, GP-13, VD-01, VD-03, VD-04, VD-09, XC-02, XC-03** — mostly the "Quick win" tier plus a few small Core items that round out a coherent practice-session workflow. BT-13 (separation engine upgrade) already shipped; not part of this release.

---

## 0. Why this set

Read together, these 14 items tell a story: **make a practice session self-contained end to end** — know the tempo and pitch of what you're playing along to (BT-01, BT-16), loop the hard part (BT-05) with a clean count-in (BT-06), tune up and check your signal before you start (GP-01, GP-10, GP-13), load your tone (GP-05), and if you record it, get a synced take with the dead air trimmed (VD-01, VD-04, VD-03, VD-09) — all without leaving the app (XC-02) or fighting a stale cache (XC-03).

Deliberately **not** in this release: chord detection (BT-04), rig presets (GP-02), the full pedalboard (GP-03), playlists (BT-09), the takes browser (VD-02). Those are larger and better scoped on their own.

---

## 1. Build order

Dependencies among this set are shallow, but a few items share implementation work or block each other:

```
XC-03 (cache key)        ─ independent, do first (infrastructure, de-risks everything else)
BT-01 + BT-16            ─ share one analysis pass (librosa on drums/harmonic stems) — build together
BT-05                    ─ independent (timeline UI)
BT-06                    ─ wants BT-01's BPM but has a manual fallback
VD-01                    ─ depends on BT-06 (reuses its count-in click generator)
GP-01, GP-05, GP-10, GP-13 ─ independent of everything above and each other (all Play Along rig)
VD-04, VD-09             ─ independent (recording/camera UI)
VD-03                    ─ see §2.4's flagged scope note before starting
XC-02                    ─ do last — binds shortcuts to buttons/actions that may still be shifting
```

Suggested milestone order: **XC-03 → BT-01/BT-16 → BT-05 → BT-06 → VD-01 → (GP-01, GP-05, GP-10, GP-13 in any order) → (VD-04, VD-09) → VD-03 → XC-02.**

---

## 2. Backing Tracks

### 2.1 BT-01 — BPM detection & live BPM readout

**What:** detect each song's tempo once, store it, and show the *effective* BPM live as the Speed slider moves.

**Approach:** run `librosa.beat.beat_track` on the **drums stem** (not the mixed source) at separation time — the isolated stem is far more reliable than mixed audio. `librosa` is already a transitive dependency (pulled in by `audio-separator`, confirmed installed) — no new package needed.

**Where it lives:**
- `backing_track.py`: new `analyze_track()` step, run once after separation (or lazily on first `list`/UI open), writing a sidecar `separated/<model>/<track>/analysis.json` — same directory convention as stems, so it's naturally per-(track, model) and survives re-separation the same way stems do.
- `engine_service.py`: expose via `/api/analysis?filename=&model=` (new route in `server.py`).
- `app.js`: show BPM next to the timecode; recompute `Math.round(bpm * speedMultiplier)` live as the Speed slider (§6.1 in USER-MANUAL) moves.

**Acceptance:** any track with a drums stem shows a BPM figure within a session of separating it; the number updates immediately (no re-analysis) as Speed changes; tracks without a detectable beat show "—" rather than a wrong number.

### 2.2 BT-16 — Off-pitch auto-detect

**What:** estimate how far a recording sits from A=440 and offer a one-click fix into the existing Tune control.

**Approach:** same analysis pass as BT-01 (batch them — one audio load, one librosa call) — build a pitch-class histogram (chromagram) over the harmonic stems and measure its offset from equal-tempered bins in cents.

**Where it lives:** same `analysis.json` sidecar, adds a `pitch_offset_cents` field. UI: a small banner near the Tune control — *"This song appears to be −23¢ from A=440 — apply?"* — only shown when `|offset| > 8` cents (avoid noise on already-in-tune songs). Clicking it just sets the existing Tune slider; no new pitch-shift code path.

**Acceptance:** offset banner appears only above the threshold; "Apply" sets Tune to exactly the detected value; doesn't fire on the project's known in-tune validation songs.

### 2.3 BT-05 — Proper A/B loop region

**What:** replace the current fixed middle-of-song loop with draggable start/end handles.

**Approach:** two handles on the Timeline-mode ruler (drag to set), or "Set A" / "Set B" buttons that capture the current playhead position — whichever is less UI work turns out to be in practice; both should be offered if cheap. Store as `State.ui.loop = {start, end}` (a field that already exists as `null` in the codebase — this fills it in properly instead of the current placeholder). Feed the same `{start, end}` into the existing loop-playback logic that today assumes a fixed middle region.

**Acceptance:** loop plays only within the chosen region and wraps cleanly (no click/gap at the seam, reusing the existing mute-region fade pattern if needed); works in both Mixer and Timeline view modes; a sensible default (e.g. whole track) when no region has been set yet.

### 2.4 BT-06 — Count-in

**What:** 1–2 bars of click before playback (and, via VD-01, before recording) starts.

**Approach:** synthesize clicks with a couple of Web Audio oscillator blips (no audio file needed) at the track's BPM (BT-01) if known, else a manual default (120 BPM) with a small note that it's a guess. A "Count-in" toggle near the transport controls this for regular playback; VD-01 reuses the same generator.

**Acceptance:** with count-in on, Play produces exactly 2 bars of evenly-spaced clicks at the right tempo before the mix starts; toggling it off restores instant playback; works with no BPM detected (falls back cleanly, doesn't error).

---

## 3. Guitar Performance

### 3.1 GP-01 — Chromatic tuner

**What:** an always-available tuner using the existing live guitar input.

**Approach:** pitch detection (autocorrelation or YIN) on the input stream the Play Along signal chain already taps — no new audio routing, just a new analysis node reading the same input. Render nearest note name + cents deviation as a needle/meter.

**Where it lives:** Play Along panel, new "Tuner" view — likely reusing the existing input-monitoring toggle rather than adding a second "enable input" flow.

**Acceptance:** a single played note resolves to the correct note name within ±5 cents against a reference tone; updates fast enough to feel live (sub-100ms is fine for a tuner, this isn't the low-latency monitoring path).

### 3.2 GP-05 — IR library & management

**What:** a `models/ir/` folder (mirroring the existing `models/nam/` pattern) scanned into a picker, instead of loading one `.wav` file at a time every session.

**Approach:** new `/api/ir/list` route (same shape as the existing NAM list endpoint), scanning `GuitarStudio/models/ir/*.wav`. Rack UI gets a picker with Load buttons next to the existing single-file "Load cab IR" control (kept, not removed — the library is additive).

**Acceptance:** dropping a `.wav` into `models/ir/` makes it appear in the picker (after a refresh, no restart needed); loading from the library convolves identically to the existing single-file path.

### 3.3 GP-10 — Input calibration & clip indicator

**What:** an input gain meter with too-hot/too-cold zones and a persistent clip light, plus a one-time "play your loudest chord" calibration wizard.

**Approach:** meter reads the existing input-monitoring analyser node (already present for the level meter mentioned in the manual). Clip light latches red on any sample above a fixed threshold (e.g. −1 dBFS) until manually cleared or a new Play Along session starts — deliberately *not* self-clearing, since the point is to catch transient clips you'd otherwise miss.

**Acceptance:** clipping a single loud transient lights and holds the indicator; the calibration wizard suggests an output-level starting point after a few seconds of playing.

### 3.4 GP-13 — Latency meter

**What:** show the user their actual monitoring latency instead of the manual's generic "typically 20–40 ms."

**Approach — honesty note:** a *true* round-trip measurement needs a physical loopback (output cable into input), which can't be assumed. Default to an **estimate** from the Web Audio API's own reported figures (`AudioContext.baseLatency` + `outputLatency`), clearly labeled as an estimate — and offer an optional "measure it for real" mode (play a click, have the user confirm when they hear it, or a proper loopback test if a cable is plugged in) for a true reading. Don't present the cheap estimate as a measured fact — that's exactly the kind of overclaim this project's documentation style avoids elsewhere (tone-match §12.3, video A/V sync §12.6).

**Acceptance:** a number is always shown, with a visible label distinguishing "estimated" from "measured."

---

## 4. Video

### 4.1 VD-01 — Count-in & auto-punch record

**What:** "Start with count-in" in the Record panel — count-in clicks play, then recording and playback begin together on beat 1.

**Approach:** directly reuses BT-06's click generator; slots in next to the existing "Start backing track with recording" toggle (USER-MANUAL §12.6) as a second checkbox, not a replacement.

**Acceptance:** with both toggles on, the take's audio begins exactly at the first click after count-in — no beat is lost or duplicated at the seam.

### 4.2 VD-04 — Auto clap-sync wizard

**What:** replace the manual QuickTime-frame-stepping calibration (USER-MANUAL §12.6) with an automated wizard.

**Approach — exactly as sketched in `video-recording-spec.md`'s deferred-items list: record a short (~5s) take, then**
- detect the clap's audio transient (simple onset/energy-spike detection — no ML needed)
- detect the hands-meeting video frame (frame-to-frame pixel-difference spike via canvas — also no ML)
- offset = video frame's timestamp − audio transient's timestamp, stored per camera (keyed by device label/id).

**Acceptance:** running the wizard and clapping once auto-fills the existing "Advanced: A/V sync calibration" field; the user can still override it manually afterward — the wizard is a shortcut to the field, not a replacement for it.

### 4.3 VD-09 — Camera framing aids

**What:** a preview-only thirds/grid overlay and a "fretboard visible?" guide box.

**Approach:** pure canvas overlay on the live preview, drawn on top of (never into) the recorded frame — same "preview vs. recorded" separation the mirrored-preview note in USER-MANUAL §12.6 already establishes.

**Acceptance:** overlay is visible while framing the shot, absent from the saved file.

### 4.4 VD-03 — In-app trim — ⚠ scope note, read before starting

**What the backlog describes:** "Top/tail trim on a take (slider on the inline player → lossless ffmpeg `-ss/-to` copy)."

**The gap:** there is currently **no in-app take player at all** — per USER-MANUAL §12.6, a finished take only offers "Reveal in Finder" / "Discard take." The "inline player" VD-03 assumes is really part of **VD-02 (Takes browser)**, which is *not* in this release.

**Resolution for this release (recommended, not yet built — flagging the call rather than making it silently):** build the minimum surface VD-03 needs and no more — a single-take inline `<audio>`/`<video>` player that appears **immediately after a take finishes recording** (where today's toast with Reveal/Discard appears), with trim handles added to it. This gets VD-03 working without building the full multi-take list/rename/star browser VD-02 describes. If a fuller browsing experience matters sooner than planned, that's a reason to pull VD-02 into this release instead — worth a quick check-in before starting this item.

**Acceptance (for the minimal-player version):** after a take finishes, an inline player with top/tail trim handles appears; trimming produces a losslessly-cut file via ffmpeg `-ss`/`-to` (stream copy, no re-encode); the original take is never modified in place.

---

## 5. Cross-cutting

### 5.1 XC-02 — Keyboard shortcuts

**What:** `L` loop, `[`/`]` loop handles (BT-05), `M`/`S` on the hovered lane, `R` record, arrow keys to nudge the playhead, `?` for an overlay listing them all.

**Note:** deliberately scheduled last in this release — several of these bind to UI that other items in this release (BT-05's loop handles especially) are actively changing. Binding shortcuts to a moving target first would mean rework.

**Acceptance:** each listed shortcut performs the same action as its corresponding button; `?` shows a legend; shortcuts don't fire while a text input has focus.

### 5.2 XC-03 — Content-based separation cache key

**What:** replace the filename-based cache key (engine-spec §49's documented known limitation) with a content hash, so two different files sharing a name don't collide and in-place edits are auto-detected.

**Approach:** hash the source file's content (not just size/mtime, which the existing staleness check already uses) at separation time; fold into the cache key alongside model name. This is pure `backing_track.py`/`engine_service.py` engine work — no UI change required, though the existing "stale" banner logic should be re-verified against the new key.

**Acceptance:** re-separating a file that was renamed but has identical content reuses the existing cache; two different files that happen to share a filename no longer collide; existing stale-detection behavior (amber banner) still works.

---

## 6. Explicitly out of scope for v0.4

- VD-02 (takes browser) — see the VD-03 scope note above; only a minimal single-take player is built here, not the full browser.
- BT-02 (beat grid) — BT-01's BPM is a single number, not a full beat grid; the click track in BT-06 is a fixed-tempo metronome, not beat-synced to the actual recording.
- Anything requiring GP-02 (rig presets) — GP-05's IR library is additive to the existing single-file flow, not a full save/recall system.
- BT-04, GP-03, GP-06 through GP-09, BT-09, BT-11 through BT-15 — all separately scoped, larger items.

---

## 7. Acceptance summary (release-level)

This release is done when: a user can open an unseparated song, see its BPM and any pitch-offset suggestion, loop a section with a proper A/B region and a count-in, tune up and check their input level before playing, load an IR from a library instead of a file dialog, see an honest latency figure, record a take with count-in and auto-punch, get it auto-synced and trimmed without leaving the browser, and do most of the above from the keyboard — all without touching a stale cache from a renamed or edited source file.
