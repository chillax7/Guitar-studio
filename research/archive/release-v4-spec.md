# Orpheus Guitar Studio — Release v4 Spec & Plan

**Status:** planning document, written at the v3.0 checkpoint (tag `v3.0`
exists locally at the end of the `claude/v3-spec-bxgwnz` branch; all of
release-v3-spec.md M1–M6 shipped). Like the v3 spec, this is written to be
handed to a **fresh working session** as its starting brief.

**Companion docs:** [rate-my-take-spec.md](rate-my-take-spec.md) (full
design for this release's headline feature),
[appstore-plan.md](../appstore-plan.md) (distribution track, deliberately
kept OUT of this feature release),
[post-v3-backlog-audit.md](post-v3-backlog-audit.md) (what became of
every item in the now-retired enhancements-backlog.md — IDs like BT-04
refer to it), [USER-MANUAL.md](../USER-MANUAL.md),
[TEST-PLAN.md](../TEST-PLAN.md),
[FIRST-SESSION-CHECKLIST.html](../FIRST-SESSION-CHECKLIST.html).

**Version note (2026-07-16):** the on-screen version bumped straight to
**v4.5**, not v4.0 — this build shipped V4-F1/F3/F4 (chords, playlists,
practice log) plus real extras this doc never scoped (continuous timeline
zoom, the key-detection fix, the Rate My Take CLI research spike) while
V4-F2/F5/F6 and the full Rate My Take UI (R1b/c) are still open. "v4.5"
reflects that mixed state honestly — meaningfully past a clean v4.0 cut in
places, not a complete v4 in others — rather than mislabeling it either
way.

---

## 0. The v4 thesis: guitar only

Decision made at the v3 checkpoint: **Orpheus is a guitar practice app,
not a general stem-player.** Every comparable product (Moises, Fadr,
LALAL) chases vocalists — lyrics, vocal pitch tracking, karaoke. We don't.
Consequences, so nobody re-litigates them mid-release:

- Vocals/piano/other stems remain first-class **for muting and mixing**
  (a backing track is defined by what you remove) — but no vocal-facing
  features will be built: no lyrics, no vocal pitch display, no
  karaoke-style scoring of singing. Backlog items that only serve
  vocalists are dead, not deferred.
- Analysis effort (key, beats, chords, Rate My Take) is tuned for and
  tested against **guitar parts** first. Where a trade-off exists (e.g.
  chord-template sets, octave ranges), choose the guitar-favouring side.
- The competitive scan (July 2026) confirmed the moat is the
  *combination*: stems-of-your-own-library + NAM-grade rig + practice
  intelligence + recording, local and private. v4 deepens that
  combination rather than widening into adjacent audiences.

## 1. Where v3.0 stands

Everything in USER-MANUAL.md exists; headless verification is done but
**the v3 hardware pass (TEST-PLAN.md / FIRST-SESSION-CHECKLIST.html) is
still owed** — v4 work must not start on any area whose v3 hardware
verification found open bugs. Bug fixes from that pass are v3.0.x
hotfixes, not v4 work.

## 2. Headline: Rate My Take (V4-R1 · L, research spike first)

Score how close a take was to the original record, using the isolated
guitar stem as the reference. Full design, phasing, honesty constraints,
and test plan live in **[rate-my-take-spec.md](rate-my-take-spec.md)** —
that doc is the contract; this section is just the release-planning view:

- **V4-R1a · Research spike — M.** Offline-only: given an existing riff
  WAV + guitar stem, produce per-beat chroma/onset agreement scores and
  a plot. Go/no-go gate for the rest — if scores don't correlate with
  the user's own judgement of good vs. sloppy takes on real material,
  stop and re-scope before building any UI.
- **V4-R1b · Capture & scoring pipeline — M.** Dry-signal take capture
  on the shared transport clock; scoring service in the Python engine.
- **V4-R1c · UI — M.** Timeline heatmap + per-marker-section scores +
  overall "closeness" percentage, wired into the loop/speed-trainer
  remediation flow.

Prior art note (from the backlog's GP-09, which this supersedes): shipping
products score against tabs/MIDI (Rocksmith+, Yousician), never against
the record itself; the academic literature does reference-vs-student
comparison but nothing productized for guitar. Our unfair advantage is
the shared transport clock — no alignment problem.

## 3. Feature picks from the backlog

**V4-F1 = BT-04 · Chord detection & chord lane — L — ✅ SHIPPED (revised v4 build, 2026-07-15)**
The #1 functional gap vs. Moises/Capo found in the competitive scan, and
newly cheap: beat grid (BT-02) and chroma extraction (BT-03) already
exist in `backing_track.py`. Beat-synchronous chroma → template matching
(maj/min/7 to start) → chord lane above the ruler, transposing live with
the Tune slider. Honesty note in the UI ("assistive, best on pop/rock").
Shipped as `detect_chords()`/`CHORD_TEMPLATE_MATRIX` in `backing_track.py`
(cosine similarity against 36 maj/min/7 templates, one guess per beat-grid
interval, `ANALYSIS_VERSION` bumped to 3) and `#chord-lane`/`renderChordLane()`
in app.js (chip-per-beat, `chordSymbol()` transposes live with Tune via the
same `transposedKeyName()` BT-03's key hint already used). Low-confidence
beats render as a dimmed "?" chip rather than a gap or a guess. Capo
suggestions from the original guitar-only-lens ambition were **not**
built — chord names only, scoped down to keep this a clean L rather than
letting it grow into the AI Lab territory release-v5-spec.md §1 separately
adopted this item into. That adoption note is now satisfied by this
shipped version, not superseded by it.

**Follow-up fix (2026-07-16), from real usage:** two real bugs surfaced
looking at an actual song ("Too Much, Too Young, Too Fast") — (1) the
chord lane rendered one chip per beat, so a chord held for bars looked
like a run of identical slivers, and at full-song zoom hundreds of them
just read as one solid bar (indistinguishable from "nothing's being
detected"); fixed by merging consecutive same-chord beats into one wider
chip (417 chips → 211 runs on that song). (2) `detect_key`'s chroma-
profile correlation confidently reported C# minor on a song that's
straightforwardly in A (270/417 chord-lane beats were some form of A) —
the classical Krumhansl major/minor profiles it correlates against fit
blues/rock's dominant-7-heavy harmony poorly. Fixed by adding
`key_from_chords()`, which overrides `detect_key`'s guess with "root of
the most frequent confident chord" whenever the chord lane has confident
data — same fix corrected Highway to Hell's key reading too (also C#
minor before, also actually A), confirming this wasn't a one-song fluke.
`ANALYSIS_VERSION` bumped to 4.

**V4-F2 = GP-06 · Looper pedal — L**
Record/overdub/undo loop layers from the live rig, beat-synced via the
beat grid, or free-running with no song loaded. Big footswitch-friendly
buttons; quantized start/stop when a grid exists. Complements Rate My
Take: loop a section, practice against it, then score against the record.

**V4-F3 = BT-09 · Playlists / setlists — M — ✅ SHIPPED (revised v4 build, 2026-07-15)**
Ordered song lists with per-song project auto-recall (projects + rig
attach already exist, so this is mostly Library UI + a JSON blob). Shipped
as `/api/playlists` (server.py, same shared-blob pattern as rig presets)
plus a Playlists picker in the sidebar that repurposes `#track-list`
itself as the playlist view (reorder/remove controls, Prev/Next setlist
navigation, "+ Add current song") rather than building a second list
widget — see `renderPlaylistTrackList` in app.js.

**V4-F4 = BT-10 · Practice log — S/M — ✅ SHIPPED (revised v4 build, 2026-07-15)**
Per-song focused-playback time, last-practiced date in the Library,
simple history. No gamification — honest numbers. Natural companion to
Rate My Take scores (both are "how is my practice actually going?").
Shipped as a periodic `Audio.playing` sampler (`practiceLogTick`, app.js)
that flushes small increments to `/api/practice_log`, content-hash-keyed
like projects so a rename doesn't reset the count; Library rows show a
plain dim time readout, no streaks/badges/scores. "Simple history" beyond
the running total (e.g. a day-by-day log) was **not** built — out of
scope for this pass, flagged here for whoever picks it up next.

**V4-F5 = GP-11 · MIDI foot controller — M**
Web MIDI: map program/CC to rig-preset recall, looper transport, and
tuner toggle. Rig presets (v3) were the prerequisite; this closes the
hands-free loop for actual practice sessions.

**V4-F6 = BT-15 · Artifact cleanup pass — M (timeboxed)**
Post-separation artifact reduction on the guitar stem specifically —
directly raises Rate My Take's reference quality. Timeboxed: if a week of
effort doesn't audibly beat the raw stem, ship nothing and note why.

**Explicitly dead under the guitar-only thesis:** lyrics/vocal anything;
BT-16 off-pitch auto-detect stays (it serves guitarists tuning to old
records). **Deferred, not dead:** BT-12 gain automation, BT-18 batch ops,
GP-05 IR management, XC-06 Windows parity (revisit only if distribution —
see appstore-plan.md — demands it).

## 4. Milestones

**Note (2026-07-15):** the project never actually ran M1–M6 in order —
v3.0 went straight to v3.1/v3.2 hardening and enhancement work instead
(see post-v3-backlog-audit.md, release-v5-spec.md's status note). The
"revised v4 build" that shipped V4-F1/F3/F4 above picked those three
specifically because other backlog work (AI Lab, this doc's own §5
compatibility phase) depends on them, out of milestone order — M1–M3
(hardware pass, Rate My Take) were not prerequisites for that and remain
exactly as scoped below, still open.

- **M1 — v3 hardening:** full TEST-PLAN + FIRST-SESSION-CHECKLIST pass on
  real hardware; fix what falls out; push tag `v3.0` (blocked in the v3
  session by credential scope). *Gate:* checklist complete, no open
  P1 bugs.
- **M2 — Rate My Take spike (V4-R1a).** *Gate:* the go/no-go call in
  rate-my-take-spec §6, made honestly.
- **M3 — Rate My Take feature (V4-R1b/c).** *Gate:* score a real
  learn-a-solo session end to end; user agrees the numbers match their
  own ears.
- **M4 — Practice depth: ✅ V4-F1 chords, ✅ V4-F4 practice log** (shipped
  out of order, see note above). *Gate met:* chord lane produces plausible
  reads on real material (Highway to Hell's I-IV-V blues-rock progression);
  not yet run against 3 songs of genuinely different styles — worth doing
  before leaning on it hard.
- **M5 — Live rig depth:** V4-F2 looper, V4-F5 MIDI.
  *Gate:* a full hands-free practice session (preset recall + looper by
  foot).
- **M6 — Polish & release:** ✅ V4-F3 playlists (shipped out of order, see
  M4's note), V4-F6 artifact pass (timeboxed, still open), USER-MANUAL +
  TEST-PLAN + checklist updates, tag v4.0.

Each milestone ends the v3 way: update the docs for what shipped, commit
with root-cause-style messages, push, user run-through before the next.

## 5. After v4: the compatibility line (decided 2026-07-12)

User decision at the v3.0 checkpoint: **v4 ships and is fully tested on
the Mac, then a line is drawn under new features** before any
cross-platform work. Nothing platform-related belongs in v4 itself.
The post-v4 compatibility phase, in the order a July 2026 audit ranked
the effort:

1. **Linux — days.** Backend already proven on Linux (every headless dev
   verification runs the real stack there); `find_ffmpeg()` already
   covers `/usr/bin/ffmpeg`. Needs: platform-dispatched reveal
   (`org.freedesktop.FileManager1` ShowItems, `xdg-open` fallback),
   `run.sh` + `.desktop`, a setup doc. Bonus: cleanest torch-CUDA path
   of any platform.
2. **Windows — about a week (XC-06).** Same reveal dispatch
   (`explorer /select,`), Windows ffmpeg lookup + install docs, a real
   `run.bat` (the backlog's claim that one exists is wrong — none is in
   the repo), `SETUP-WINDOWS.md`, and an honesty note that browser audio
   on Windows is shared-mode WASAPI (~20–50 ms round trip, no ASIO) so
   the live rig feels less immediate than CoreAudio.
3. **Chromebook — don't port.** Crostini + typical Chromebook hardware
   can't carry the separation models or the WASM NAM realtime budget.
   The right answer is **LAN mode**: opt-in server bind beyond loopback
   with a simple token, so a Mac does the ML and any browser device
   (Chromebook, tablet, laptop) is a practice-rig client. Same
   companion-device shape as appstore-plan.md's iOS story. Spec it as a
   new backlog item when the phase starts.
