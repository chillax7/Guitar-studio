# Post-v5 Backlog Audit — Consolidated

**Status:** written at the v5 checkpoint (2026-07-23), after a long
real-usage QA pass ("Quest Plan Boss Rush Edition" — QUEST-PLAN-BOSS-EDITION.md)
surfaced and fixed a steady stream of real bugs and small feature gaps,
none of which were pre-planned milestones. This doc is the same job
[post-v4-backlog-audit.md](post-v4-backlog-audit.md) did at the v4.5
checkpoint: the single current-state answer to "what's shipped and
what's actually still open," so nothing gets silently re-proposed or
silently forgotten. Same rule as that doc: this stops at "what's open
and how big is it" — the actual next-release plan is
[release-v6-spec.md](release-v6-spec.md), a separate deliberate step.

---

## 1. Shipped since release-v5-spec.md §§9–11 was written

**v5 core (already covered by release-v5-spec.md's own M0–M3, restated
here only because it's the baseline everything below built on):** AI Lab
shipped as a fourth screen — Scales/Mode Advisor (deterministic theory),
Rate My Take (note-level scoring, passed its real go/no-go gate), and AI
Assistant (Lick Ideas/Ask AI/Practice Tips/This Track/This Artist, with
a Claude/Google/Groq provider picker). Chord detection v2 (CD-1 through
CD-4: Viterbi smoothing, power-chord template, cleaner chroma front end,
bass-stem root bonus) fixed real riff/power-chord misreads found against
actual songs.

**v4.7 / "ui-review-v5-full.md" build:** Tone Lab's icon-chain redesign
(one icon per pedal/amp/gate/output stage, exactly one panel open below
at a time, drag-to-reorder including Amp's own position); the rig status
pill (top banner, live/clipped state visible from any screen); the Quest
Log first-use checklist (replaces the empty-state Speed Trainer/Export
dead controls, reachable any time from Help); "Molten Obsidian" dark
theme as the new default.

**This session (a real multi-day usage pass, not a planned milestone —
each item below was a genuine "here's what's wrong" report, fixed and
verified against the running app, not implemented speculatively):**

- **Bright Spark** — a second, light theme (white background, dark
  text), completing a real 3-theme cycle (Molten → Bright Spark →
  Studio); a shared font across all three per direct feedback (readability
  over theme flourish, for now).
- **Chord ribbon color** — three real rounds of the same underlying
  complaint ("the chord ribbon reads as blue/wrong"), ending with the
  ribbon (and the fretboard root dot) using the exact same color as that
  song's stem waveform in every theme, rather than an independent accent
  — chord analysis now visually reads as belonging to the audio it
  describes.
- **Mixer scroll-jump fix** — clicking Mute/Solo (or anything else that
  re-renders the lane list) used to snap the view back to the top even
  with several stems scrolled out of view; now the scroll position is
  preserved across same-track re-renders, and still resets to top on a
  genuine track switch.
- **Solo now un-mutes** — soloing a muted stem used to still play
  silence (the mute flag was never cleared); soloing now clears it, same
  as a real mixing console.
- **Rate My Take / AI Assistant song-switch state bugs** — a previous
  song's rating (and a previous song's AI Assistant answer) used to
  still show after switching tracks; both now blank/reset on switch and
  reshow correctly if you switch back to the original song.
- **Mark a stem as the guitar (imported packs)** — an imported stem pack
  never produces a stem literally named `guitar`; a 🎸 button lets you
  designate a stand-in so Suggest a tone / Rate My Take / Practice Tips
  all work the same as with a real separated stem.
- **Play Along tuner redesign** — replaced the old needle-meter with a
  semicircular arc gauge, big center mic button (later halved in
  diameter per feedback), and Hz/Cents readouts, filling its card
  properly instead of only the top portion.
- **Collapsible right-hand inspector** — the Track/Speed Trainer/Export
  panel (and Quest Log) on the Mixer can now collapse to free up width
  for the lanes, state remembered across reloads.
- **Quest Log: two real bugs, not one** — (1) the four Mixer-only quests'
  "go" button was a silent no-op from any other screen (no `screen` was
  ever set for them, since they "already happen on the Mixer" — but
  clicking go from Tone Lab/Play Along/AI Lab did nothing); (2) "Summon a
  song" never ticked on the inline empty-state panel specifically (it's
  computed live from the track list rather than via the usual
  mark-done event, and the inline panel was never re-rendered when a
  track list changed — only the Help modal re-renders fresh on every
  open, which is why it always looked correct there).
- **Gemini AI Assistant truncation** — replies were cut to one sentence;
  `gemini-flash-latest` is a "thinking" model that was spending most of
  its token budget on invisible reasoning tokens before writing the
  visible answer. Fixed with a minimal thinking budget plus a larger
  output ceiling.
- **Manual key correction** — key detection is a global heuristic and
  can occasionally favor a related key over the right one (a real
  example: "Afterlife" read as A# major, actually D minor by ear); a
  root+mode picker next to the key hint now lets you override it
  directly, with a Reset back to the real detection.
- **Cold-start stems-fetch resilience** — "stems failed to fetch" on the
  first track picked right after starting the app (a bare network-level
  failure racing the backend's own startup) used to surface as a
  blocking `alert()` with no visible loading state at all (the alert
  stole the paint). API GETs now retry transparently a few times before
  giving up, and a genuine persistent failure shows a proper
  non-blocking error state with a Retry button instead.
- **NAM/IR library drop zones** — adding amp captures or cab IRs used to
  mean hand-copying files into `models/nam/`/`models/ir/` in Finder; a
  drop zone above each picker now takes a single file, a whole folder
  (nested subfolders preserved), or a `.zip` pack, with the same
  folder-preserving extraction the multi-stem-import zip path already
  established.
- Smaller polish: Takes screen's compare-checkbox hint text clarified.

---

## 2. Still open from release-v5-spec.md's own tail (§§9–11) — none of
this shipped this session; the whole session above was reactive QA, not
a continuation of the planned v5 milestone list

- **M4, MIDI half (V5-B3)** — the keyboard-cycling half of "hands-free
  rig" already shipped (GP-14: per-song rig preset chain + configurable
  forward/backward cycle keys). Actual MIDI hardware footswitch control
  was never built.
- **M5 (V5-B4 + V5-B2 + V5-B5)** — social export presets (pure ffmpeg
  presets: 9:16/1:1/normalized web export), the Artifact cleanup pass,
  and measured round-trip latency (GP-13's loopback-ping approach) —
  none built.
- **V5-S1** — LAN-mode spec spike (not written; still just the market
  review's finding that mobility is the biggest competitive gap).
- **V5-S2** — song-section detection (verse/chorus segmentation over the
  existing beat grid), stretch-scoped behind AI Lab — not built.
- **TONE3000 unblock-or-drop** — the task to actually ask about API
  terms (rather than leave `backing-track-tone-match-spec.md` Option A
  in permanent limbo) was never done.
- **GP-06 Looper pedal** — explicitly named in release-v5-spec.md §9 as
  "first candidate for a v6 release, not dropped." Still not built —
  the single most-flagged real gap carried forward twice now.
- **BT-12 gain automation, BT-18 batch operations** — "deferred, not
  dead" since the original backlog, no new urgency, still parked.
- **Everything release-v5-spec.md §9 already declined** (custom
  lead/rhythm ML model, Linux/Windows/native app, windowed key
  detection) — no change in status, not re-litigated here.

## 3. A process gap this session's QA surfaced, worth naming for v6

Two of USER-MANUAL.md's own screenshots and its opening section had gone
stale for a full release cycle — the manual's first page still said "AI
Lab — planned for v5, not in this build" months after AI Lab actually
shipped, and three of the seven screenshots (plus one explicitly
self-flagged as outdated in its own caption) predated the icon-chain
Tone Lab redesign, the new tuner, and the theme system entirely. Nothing
in the release process currently checks "does the manual's own intro/
TOC/screenshots match what's actually in the app" — it's been ad hoc,
whoever happens to touch that section during a given change. Worth a
concrete, cheap habit for v6: a doc-currency pass as part of closing out
each milestone (or at minimum each version checkpoint), not just when a
change happens to touch the same section already being edited for
another reason.

## 4. Where this leaves the actual next step

Same as the v4.5 checkpoint: this document is the map, not the route.
[release-v6-spec.md](release-v6-spec.md) picks a coherent subset of §2
above (GP-06 Looper is the standout repeat candidate) plus whatever new
material is worth adding, with real gates and milestones — not "build
everything eventually."
