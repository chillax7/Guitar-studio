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

**V4-F1 = BT-04 · Chord detection & chord lane — L**
The #1 functional gap vs. Moises/Capo found in the competitive scan, and
newly cheap: beat grid (BT-02) and chroma extraction (BT-03) already
exist in `backing_track.py`. Beat-synchronous chroma → template matching
(maj/min/7 to start) → chord lane above the ruler, transposing live with
the Tune slider. Honesty note in the UI ("assistive, best on pop/rock").
Guitar-only lens: template set and voicing display favour guitar keys and
capo suggestions, not generic lead sheets.

**V4-F2 = GP-06 · Looper pedal — L**
Record/overdub/undo loop layers from the live rig, beat-synced via the
beat grid, or free-running with no song loaded. Big footswitch-friendly
buttons; quantized start/stop when a grid exists. Complements Rate My
Take: loop a section, practice against it, then score against the record.

**V4-F3 = BT-09 · Playlists / setlists — M**
Ordered song lists with per-song project auto-recall (projects + rig
attach already exist, so this is mostly Library UI + a JSON blob).

**V4-F4 = BT-10 · Practice log — S/M**
Per-song focused-playback time, last-practiced date in the Library,
simple history. No gamification — honest numbers. Natural companion to
Rate My Take scores (both are "how is my practice actually going?").

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

- **M1 — v3 hardening:** full TEST-PLAN + FIRST-SESSION-CHECKLIST pass on
  real hardware; fix what falls out; push tag `v3.0` (blocked in the v3
  session by credential scope). *Gate:* checklist complete, no open
  P1 bugs.
- **M2 — Rate My Take spike (V4-R1a).** *Gate:* the go/no-go call in
  rate-my-take-spec §6, made honestly.
- **M3 — Rate My Take feature (V4-R1b/c).** *Gate:* score a real
  learn-a-solo session end to end; user agrees the numbers match their
  own ears.
- **M4 — Practice depth:** V4-F1 chords, V4-F4 practice log.
  *Gate:* chord lane useful on 3 real songs of different styles.
- **M5 — Live rig depth:** V4-F2 looper, V4-F5 MIDI.
  *Gate:* a full hands-free practice session (preset recall + looper by
  foot).
- **M6 — Polish & release:** V4-F3 playlists, V4-F6 artifact pass
  (timeboxed), USER-MANUAL + TEST-PLAN + checklist updates, tag v4.0.

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
