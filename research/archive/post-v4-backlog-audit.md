# Post-v4.5 Backlog Audit — Consolidated

**Status:** written at the v4.5 checkpoint (2026-07-16). Retires
scattered tracking across [release-v4-spec.md](release-v4-spec.md)'s
"deferred, not dead" notes, [post-v3-backlog-audit.md](post-v3-backlog-audit.md)'s
survivors, [release-v5-spec.md](release-v5-spec.md)'s AI Lab items, and
the priority list in research_review.docx — this doc is the single
current-state answer to "what's shipped and what's actually still open,"
replacing the need to cross-reference all of those. Full designs for
anything with its own spec doc still live there; this is status +
pointers, not a re-explanation. Two new items from this pass —
[multi-stem-import-spec.md](multi-stem-import-spec.md) and
[system-audio-rip-spec.md](system-audio-rip-spec.md) — get their own docs
since they're real new designs, summarized in §3 below.

**This doc's job stops at "what's open and how big is it."** The actual
next-release plan (a V5 spec) is a separate, deliberate step from here —
see the closing note in §4.

---

## 1. Shipped since the v3.0 checkpoint (quick reference, so nothing gets re-proposed)

Grouped by when, not by ID — full detail lives in each release's own
spec/commit history if needed.

**v3.1:** expanded pedalboard — Boost/Overdrive, Graphic EQ, Chorus,
Flanger, Phaser, Tremolo, Auto-Wah, Octaver (GP-03's real scope); IR
tone shaper (GP-05's missing piece); drag-to-reorder across all twelve
post-amp cards; signal-flow arrows.

**v3.2:** multi-take practice mode (VD-05); side-by-side take compare
(VD-08); the panning-split heuristic's onset/beat-grid sharpening,
`--method hybrid` (Option D); GuideSep evaluated (verdict: needs a
hand-sketched spectrogram mask, not a turnkey checkpoint — narrowed to a
cheap go/no-go gate, not built further); title bar consistency fix; the
split-method active-highlight visibility bug fixed.

**v4.5:** chord detection & chord lane (BT-04/V4-F1) —
maj/min/7 templates, transposes live with Tune; playlists/setlists
(BT-09/V4-F3); practice log (BT-10/V4-F4); continuous GarageBand-style
timeline zoom with playback auto-scroll (not originally scoped anywhere
— built alongside the above); a real bug fix to key detection (now
chord-lane-derived, since the old chroma-profile correlation was
confidently wrong on blues/rock material — confirmed on two real songs
in this library); Rate My Take's Phase R1a research spike built and
mechanically verified (`backing_track.py rate`) — **not** the same as
the feature shipping; see §2.

**v4.6 (this build):** both new ideas from §3 below — multi-stem ZIP
import and Rip — both shipped, not just spec'd. One graceful-degradation
gap found and fixed during implementation: `analyze_track`'s tempo/beat/
key detection originally only checked exact stem names (`drums.wav`,
`guitar.wav`, ...), which meant an imported pack got no beat grid, no
key, and no chords at all — `detect_chords`'s own fuzzy fallback (§3's
original design) never even ran, since it needs a beat grid that never
existed. Fixed with one shared fuzzy-stem-matching helper
(`_find_stems_fuzzy`, backing_track.py) used by all three readings, not
just chords. Verified end-to-end against the real 9-stem Iron Maiden
example: BPM, a full beat grid, chord lane, and key (A major) all
populated correctly.

## 2. Rate My Take — the one item that's genuinely half-done

Unlike everything else in §1, this isn't cleanly shipped or open — worth
calling out on its own. The CLI spike (`backing_track.py rate`) works,
is verified against synthetic test cases, and caught/fixed a real onset-
alignment bug in the process. What hasn't happened is the actual point
of a research spike: **the go/no-go judgment call**
(rate-my-take-spec.md §6) needs three real recorded takes (tight,
sloppy, tasteful-variation) of a part a human knows, scored and checked
against their own ears. That can't be simulated or skipped — it's next
whenever there's time to record them. If it passes, R1b/c (the real
capture pipeline + UI) is a real, scoped, ~L-sized build on top. If it
fails, the honest outcome per that doc's own §6 is to stop, not force it.

## 3. Shipped in v4.6: two ideas from real material in hand

- **Multi-stem ZIP import** — a second import path: drop in a `.zip` of
  already-separated stems (a purchased "custom backing track" pack, any
  pre-split multitrack) and it becomes a Library track immediately, no
  separation step, stems named exactly as the files were. Motivated by
  a real example now in `input/` with 9 stems including *already-split*
  lead/rhythm guitar — which sidesteps the panning-heuristic problem
  entirely for material like this. Full design, including the real
  architectural wrinkle (every existing per-song system is keyed off one
  content-hashed source file, and a multi-file import has none — solved
  by synthesizing a full-mix file to hash) and graceful degradation for
  features that assume a known stem vocabulary (chord detection, tempo/
  key detection, the guitar-split panel):
  [multi-stem-import-spec.md](multi-stem-import-spec.md) (status note at
  the top covers what changed during implementation — stems get
  converted to WAV, not preserved byte-for-byte). Verified end-to-end
  against the real Iron Maiden example.

- **"Rip" — capture whatever's playing on the Mac** — a button that
  records system audio (a streaming tab, another app, anything) straight
  into `input/` as a new song, without needing the file already in hand.
  Shipped on the recommended BlackHole path, implemented via the browser
  (`getUserMedia`+`MediaRecorder`, reusing Play Along's device-picker and
  the take-recorder's upload/remux pattern) rather than the server-side
  ffmpeg-subprocess design originally sketched — see
  [system-audio-rip-spec.md](system-audio-rip-spec.md) §4a for what
  actually shipped and why that turned out simpler.

## 4. Everything still open, grouped by theme

Not prioritized here — that's the V5 spec's job once this list exists
(see the closing note below). Sizes are carried over from wherever they
were last estimated (research_review.docx's priority pass, or each
item's own spec).

### Practice & live-rig depth
- **GP-06 Looper pedal (L)** — record/overdub/undo loop layers from the
  live rig, beat-synced or free-running. Never started.
- **GP-11 MIDI foot controller (M)** — Web MIDI mapping to rig-preset
  recall / looper transport / tuner toggle. Never started; would pair
  naturally with GP-14 below.
- **GP-14 Multiple rig presets per song, cycled with one key (M)** —
  logged idea (post-v3-backlog-audit.md §4), never built. Main open
  question is the switching-artifact mitigation (a live mid-song preset
  swap currently has no click-suppression).
- **GP-12 Bounce live performance into normal export (M)** — route a
  captured take through the same export pipeline (`svc_mix`) a stem mix
  gets. "Deferred, not dead" since v4-spec, still true.
- **GP-13 True measured latency meter (S, hardware-gated)** — currently
  browser-estimate only; the loopback-ping measured version needs an
  actual interface plugged in to mean anything, which is why it's
  lingered.
- **BT-12 Gain automation / volume ramps** — deferred since the original
  backlog, still true.
- **BT-18 Batch operations** — same, still deferred.
- **BT-15 / V4-F6 Artifact cleanup pass (M, timeboxed)** — post-
  separation cleanup on the guitar stem specifically, to raise Rate My
  Take's eventual reference quality. Explicitly timeboxed: a week's
  effort with a "ship nothing if it doesn't audibly beat the raw stem"
  exit clause.
- **VD-06 Recording overlays** — burned-in title/chord display; natural
  pairing with the chord lane now that it exists (wasn't true when this
  was last written — chords have since shipped).
- **VD-07 Social export presets (S)** — one-click 9:16/1:1 crop + a
  normalized web export, pure ffmpeg presets over an existing take file.
  Cheap; just never picked up.
- **Multi-take comping UI** — assemble the best parts across several
  takes into one file. Distinct from (superset of) the shipped VD-05/
  VD-08 pair.

### Rate My Take completion
- See §2 above — the gate, then R1b/c if it passes.
- **Non-goals already ruled explicitly out for now** (rate-my-take-spec.md
  §7): real-time scoring while playing, note-level pitch feedback,
  score-history charts (wants the practice log as a home — which now
  exists — worth revisiting once R1b/c ships), scoring a take against
  another take.

### AI Lab (release-v5-spec.md — chord lane's part of this already shipped)
- **V5-F2 Scale/Mode Advisor (M)** — deterministic, free, local; the
  natural next AI Lab piece now that the chord lane (its prerequisite)
  exists.
- **V5-R1 Lick/Phrasing Assistant (M, research-spike-gated)** — cheap
  LLM reasoning over chord/key/tempo data. Needs its own go/no-go spike
  before any UI, same spirit as Rate My Take's.
- **V5-F3 "Explain this" chat (S/M)** — reuses V5-R1's plumbing if that
  spike passes.
- **V5-F4 Solo-skeleton generator (XL, hard-gated)** — explicitly does
  not get built unless V5-R1 clears its gate with real margin.
- **V5-F5 basic-pitch transcription (L)** — free/local/offline
  (Spotify, MIT), independent of the rest of AI Lab; also closes the
  "note-level feedback" gap Rate My Take punted on.

### Tone & rig
- **Tone-suggestion via TONE3000 (backing-track-tone-match-spec.md
  Option A)** — the *shipped* "Suggest a tone" only matches against the
  user's own loaded NAM library; querying TONE3000's community library
  is a different, bigger idea, still blocked on confirming their API
  terms.
- **AI-assisted auto-EQ nudging (Option B)** — natural next step after
  the above, not started.
- **Full neural tone transfer (Option C)** — explicitly "research
  territory," stays parked.
- **NAM capture blend / dual-amp crossfade** — v3 "stretch, if time
  allows" item; no confirmation it ever shipped. Worth a quick check
  before re-scoping — may just need finishing, not designing.
- **Parametric `.nam` support** — explicitly "likely punt" in its own
  spec; detection-stub-only is the honest ceiling here.
- **GP-05's broader IR management** (beyond the shipped per-preset tone
  shaper) — "deferred, not dead."

### Separation & lead/rhythm ML
- **Custom lead/rhythm ML model (XL/R&D)** — the full phased plan in
  lead-rhythm-split-research.md remains "leave it there," not scheduled.
  Multi-stem import (§3) reduces how much this matters for any song
  where a pre-split pack exists, which is worth factoring into whether
  this is still worth chasing at all.
- **Self-host fine-tuned BS-RoFormer** — only if the MVSEP/cloud
  dependency for BT-13-grade separation ever becomes unacceptable; it
  hasn't.
- **Per-track (not per-export) loudness normalization** — unresolved
  design question, flagged in three different docs now, never actually
  decided either way.

### Import & I/O
- **WebCodecs A/V muxing** — the "v2 escape hatch" for A/V sync, only
  needed if the current ffmpeg-remux approach ever proves insufficient
  in practice. It hasn't yet.
- **Multi-track stem recording** (record guitar + backing track as
  separate tracks in one file, rather than pre-mixed) — "niche, revisit
  on demand."

### Platform & distribution
- **Linux support (days)** — backend already proven; needs platform-
  dispatched file-reveal, a launcher, a setup doc. Cheapest item on this
  entire list by effort.
- **Windows parity / XC-06 (about a week)** — reveal dispatch, ffmpeg
  lookup docs, a real `run.bat`, an honesty note on WASAPI shared-mode
  latency.
- **LAN mode** — the deliberate alternative to porting to Chromebook: a
  Mac does the ML/heavy lifting, any browser device is a thin practice
  client. Not yet scoped as a real backlog item.
- **XC-05 Native macOS app** — superseded by `appstore-plan.md`, still
  open there.

## 5. Where this leaves the actual next step

This document is deliberately just the map, not the route — a V5 spec
should pick a coherent subset of §4 (plus whatever else comes up) the
same way release-v4-spec.md picked V4-F1/F3/F4 out of a longer list, with
real gates and milestones, not just "build everything eventually." Doing
that well means weighing effort against payoff with the same rigor the
original research_review.docx priority pass used — worth doing as its
own deliberate step, not folded into this audit.
