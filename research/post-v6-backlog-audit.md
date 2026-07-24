# Post-v6 Backlog Audit — Consolidated

**Status:** written 2026-07-24, the same job
[post-v4-backlog-audit.md](post-v4-backlog-audit.md) and
[post-v5-backlog-audit.md](post-v5-backlog-audit.md) did at their own
checkpoints: the single current-state answer to "what's shipped and
what's actually still open," so nothing gets silently re-proposed or
silently forgotten. Same rule as both of those: this stops at "what's
open and how big is it" — the actual next-release plan is
[release-v7-spec.md](release-v7-spec.md), a separate deliberate step.

**Why this doc exists in the first place — a process note worth stating
plainly:** the session that wrote it started from a stale mental model
of the project — treating release-v5-spec.md as the current frontier and
extending it (§11, market review, latency work) without first checking
whether a v6 already existed. It did: release-v6-spec.md had already
been written *and substantially built* (Looper, MIDI, measured latency,
export presets) before that session's own work began, and a further wave
of real, shipped work happened after v6 closed without ever being
captured in a versioned spec. This audit's §3 reconciles that
overlap honestly rather than quietly absorbing it. The lesson, stated
once so it doesn't recur: **before any planning work, `git log --oneline
-30` and `ls research/` first** — this project's own history is the
source of truth, not whichever spec doc happens to be open.

---

## 1. Shipped since release-v6-spec.md was written

**v6 core (release-v6-spec.md's own M0–M4, restated as the baseline):**
the Looper pedal (GP-06) — record/overdub/undo/quantize-to-bar, per-song
persistence, verified end-to-end including a real transferable-object
bug caught along the way; MIDI hands-free footswitch control (device
picker, Learn mode, forward/backward cycle mapping) — first build,
verified against simulated MIDI only; measured round-trip latency
(GP-13) and social export presets (VD-07) — both built and verified
against the real server; TONE3000 unblock research — done, the actual
registration/email is the user's own next step (§2).

**Chord/key detection accuracy — a continuing real-song validation
pass, CD-5 through CD-7 plus BT-03b (chord-detection-v2-spec.md):**
- **CD-5** (two real-song passes): "Too Much, Too Young, Too Fast"
  (distorted rock) fixed a raw-chroma gate; "Mull of Kintyre" (simple
  acoustic, 3/4) fixed the non-bass gate chroma, a phantom-seventh
  guard, and a drumless beat-grid fallback.
- **CD-7**, "Norwegian Wood" pass — chord identity now comes off the
  non-bass mix entirely; CD-1…CD-6 had inadvertently over-fitted to
  rock/metal songs.
- **BT-03b**, "Hotel California" pass — key detection now finds the
  tonic via Krumhansl-Schmuckler profile correlation instead of
  most-frequent-chord-root, which had been confidently wrong on
  progressions that play their tonic *least* often. `ANALYSIS_VERSION`
  13→14.
- **BT-03b addendum**, "Holiday" pass — margin-aware key confidence:
  a thirdless power-chord progression can't be resolved to one key from
  chord content alone (near-identical profile fit across several
  candidates), so confidence now scales with the margin between the
  top two profiles instead of reporting a confident wrong answer.
  `ANALYSIS_VERSION` 14→15.
- **CD-6** logged explicitly as backlog within its own spec (not
  silently dropped): downbeat detection, a madmom A/B behind a flag,
  mid-song key changes — see §4 below for where mid-song key changes
  already lives elsewhere.

**AI Lab "Song Structure" — a full new feature (SS-1 through SS-4,
ai-lab-song-structure-spec.md), built on song-section detection
(BT-20, shipped as its own item first, see below):**
part-by-part structural map (intro/verse/chorus/etc, click to jump/loop)
with LLM enrichment (names, role, difficulty, learning order), moved
into the AI Assistant mode toggle alongside This Track/This Artist,
cross-linked bidirectionally with the Mixer (SS-3/SS-4: jump between the
two, follow-highlight while playing, "Practise this part"). Along the
way: song_structure()'s full per-visit librosa re-decode (no caching,
unlike ensure_analysis) was found and fixed — cached to structure.json,
first call ~9s, every call after ~0.2ms.

**Song-section detection (BT-20, song-section-detection-spec.md) —
shipped, then superseded by the feature above.** Originally a standalone
Mixer ribbon (release-v5-spec.md's V5-S2 stretch item); built, then
hidden from the Mixer (`SECTION_RIBBON_ON_MIXER = false`) once Song
Structure gave it a better home — detection and code stay intact, just
not surfaced twice. **V5-S2 is therefore closed, not open** — see §3.

**UI polish, not pre-planned milestones:** a native-`prompt()` replacement
(the blocking dialog used for renaming tracks/playlists/stems/takes/
markers could freeze the tab if it appeared while unfocused — now a
non-blocking in-app dialog); a button-consistency pass (quiet-at-rest
state model, zoom-to-loop playhead fix); Bright Spark theme refinement
(monochromatic grey accent, lighter mute ribbon); several Mixer layout
fixes (frozen label column left-justified/inset, scroll position
preserved across re-renders — this second one was already listed shipped
in post-v5-backlog-audit.md, so no new claim here, just confirming it
held).

**This session — five real bugs found and fixed, one revoice, one
diagnosis-and-honesty-note, all against the actual running app:**
- **Tremolo silently doing nothing** — the LFO oscillator was created
  but never connected to its own depth-modulation gain node, so engaging
  it applied a static volume cut with zero audible pulse. One missing
  `.connect()` call.
- **Wah cutting volume very low** — a narrow bandpass filter with no
  makeup gain; measured −6.66dB RMS loss against a real separated guitar
  stem, fixed with a calibrated makeup-gain stage.
- **Mixer sidebar-resize leaving lanes stale** — dragging the sidebar
  handle changes a CSS grid column but never fires a `window resize`
  event, so the waveform lanes kept their pre-drag width. Now
  recomputed live during the drag, redrawn on release.
- **Speed/Tune leaving playback permanently silent on a failed mode
  switch** — no error handling in the direct→processed transition; any
  failure partway through building the pitch-shift worklets left
  playback stopped forever, recoverable only by reloading. Now wrapped
  in try/catch with a clean fallback to direct playback.
- **Speed/Tune OOM-crashing the tab on long multi-stem songs** — applying
  Tune held the whole song's PCM twice (main-thread buffers + a copy in
  each per-stem worklet), ~1.9GB for a 7-minute 6-stem song, enough to
  crash the tab after a few minutes. Fixed by freeing the redundant
  main-thread copies once the worklets own the audio (halves sustained
  memory) with a lightweight envelope backing the waveform lanes, plus a
  pre-switch guard that warns before a genuinely huge song is attempted.
- **Analog amp revoiced** against a real Marshall-simulation reference
  recording the user provided — the old chain was effectively a hard
  clipper with no pre/post voicing; the new chain (tighten → pre-emphasis
  → asymmetric soft clip → de-emphasis → fixed voicing → cab-style
  lowpass) was tuned and verified to land within ~1.5dB of the reference
  on its dominant harmonics.
- **OneDrive/TCC launcher fix** — the double-clicked, unsigned app was
  silently dying on launch (bouncing Dock icon, then nothing) because the
  project lives inside an OneDrive-synced path and File Provider/TCC
  denies the launcher's log-file write from that context. Fixed by
  logging to `/tmp` instead.
- **Silent-rip guardrail** — a Rip capture with the Mac's output not
  actually routed into BlackHole produces digital silence, which then
  fails separation with a cryptic `audio-separator` error minutes later.
  Server-side `volumedetect` on the existing remux pass now flags a
  silent capture immediately, with the routing fix explained right there.
- **Output device picker** (Tone Lab's Output card) — routes the whole
  shared AudioContext via `setSinkId`, so the app can monitor through an
  audio interface while the rest of the Mac stays on its speakers; using
  the interface for both input and output removes cross-device
  resampling, the single biggest practical latency lever after the
  `latencyHint: 0` context change (also shipped this session).
- **Separation memory pressure — diagnosed, not fixed.** A real
  BS-RoFormer separation was measured dropping system-wide free memory
  from 83% to ~21% on a 16GB Mac (a ~10GB transient MPS unified-memory
  spike, invisible to `ps`). Not a code bug — the job completes
  server-side regardless and the browser recovers cached stems on
  reopen — so this shipped as an honest UI note (separation screen: it's
  RAM-heavy, close other memory-hungry apps, a crash mid-separation loses
  nothing) rather than a fix. The real fix (forcing smaller
  `mdxc_params` processing segments) is logged as a gated v7 candidate —
  see §4.
- **Market review vs. the 2026 field** (market-review-2026.md) — Moises,
  Chordify/UG/Songsterr, Anytune/deCoda, the NAM ecosystem (TONE3000 at
  6500+ models), AmpliTube/Neural DSP. Confirmed nobody else combines
  local separation + mixer + live NAM rig + practice loop; the two real
  structural gaps are mobility and measured-vs-estimated latency (the
  latter now closed — see v6's GP-13 above).

---

## 2. Still open from release-v6-spec.md's own tail

- **MIDI hands-free control — real-hardware confirmation.** Verified
  only against simulated MIDI messages; a specific footswitch's channel/
  debounce/message-type quirks can't be predicted from simulation. Cheap
  to close once the ordered hardware arrives — an S validation pass, not
  a build.
- **Looper pedal — sustained real-use validation.** Built and verified
  (quantization, overdub, undo, persistence) but "genuinely not yet
  exercised in real, sustained practice use" per the spec's own words —
  long sessions, many overdub cycles, unusual loop lengths.
- **TONE3000 unblock — the actual action.** Research is done
  (tone3000-unblock-spec.md has the two specific questions ready); the
  registration + email to support@tone3000.com was never confirmed sent.
  This is a real user action (an email), not something a coding session
  can execute — needs the user to actually do it, or explicitly decide
  not to.

## 3. Reconciliation: this session's release-v5-spec.md §11 vs. what v6
actually decided

The session that opened this audit had added §11 to release-v5-spec.md
(promoting GP-13 measured latency, proposing a LAN-mode spec-only spike,
listing song-section detection as a v5 stretch item) without knowing v6
already existed. Recording the actual outcome for each, honestly:

- **GP-13 measured latency** — independently reached the same
  conclusion (promote it), and v6 actually built it. No conflict, just
  redundant reasoning arrived at twice.
- **LAN mode** — §11 proposed a spec-only spike for v5/v6. v6 went
  further and **declined even the spike**, moving it straight to plain
  backlog — "the second release in a row it would've been 'spec only,
  not build'... rather than carry it forward a third time... it's moved
  to straight backlog, out of scope for v6 entirely." That's a more
  decisive call than §11 proposed, and it's the one that stands. See §4.
- **Song-section detection** — §11 listed it as a v5 stretch candidate.
  It shipped post-v6 (BT-20) and was then folded into the bigger Song
  Structure feature (§1). **Closed**, not carried forward.
- **TONE3000 unblock** — §11 proposed "one email/API-terms check this
  release." v6 did the research half properly (a real spec with the
  actual current API terms, not a vague placeholder) but the email
  itself is still the open, undone action — see §2.

## 4. New backlog surfaced since v6, not yet in any spec's picked list

- **Unresolved browser-freeze investigation (USER-MANUAL.md §8's
  Troubleshooting table) — two real, un-root-caused user reports.** (1)
  Muting/unmuting stems then soloing the guitar stem on a ripped song.
  (2) Using AI Lab's Song Structure mode, switching away, then back. A
  real performance bug was found and fixed in the second case
  (song_structure()'s uncached re-decode, §1) but isn't confirmed as the
  actual freeze cause — a thorough code review of the mute/solo path
  (listener leaks, audio-graph node leaks, blocking dialogs, runaway
  loops) found nothing definitive either. **Directly in this session's
  demonstrated wheelhouse**: the exact same live-headless-repro +
  memory-profiling methodology that root-caused the Tune OOM crash and
  the separation-memory pressure this session (both real, both proven
  out with hard measurements) is the obvious next tool to point at this.
- **Reduce separation peak memory (logged this session, carried
  forward).** BS-RoFormer's ~10GB MPS unified-memory spike (§1). Fix
  path: `mdxc_params` with `override_model_segment_size: True` + a
  smaller `segment_size` in `run_audio_separator_backend`. **Gate:**
  must measure the actual peak-memory reduction AND A/B the output
  quality by ear (smaller roformer segments risk chunk-boundary seams) —
  a test spike, not a blind config change.
- **Artifact cleanup pass (BT-15 / V5-B2) — silently dropped across
  three release cycles, not declined.** First picked as **V4-F6** in
  release-v4-spec.md (timeboxed, "ship nothing if it doesn't audibly
  beat the raw stem"). Still listed open in post-v4-backlog-audit.md.
  Carried into release-v5-spec.md's own picks. Still listed open in
  post-v5-backlog-audit.md §2. **Then it simply isn't mentioned anywhere
  in release-v6-spec.md** — not picked, not explicitly declined, just
  absent. This is exactly the failure mode these audits exist to catch,
  and it caught itself this time only because this audit went looking.
  Real backlog item, needs an actual decision in v7: build it (timeboxed,
  same exit clause as always) or explicitly kill it — not a fourth
  silent drop.
- **CD-6's mid-song key changes** duplicates the already-tracked
  "windowed/segmented key detection" item (release-v5-spec.md §9,
  restated in release-v6-spec.md §0's declined list). Same item, two
  names — worth merging under one heading in v7 so it doesn't read as
  two separate asks.
- **Thirdless-progression tonic resolution** (BT-03b addendum's honest
  leftover) — a power-chord-only progression's true tonic needs cues the
  chord list alone doesn't carry (riff/bass emphasis). Manual key
  correction covers it today; "possibly a bass-root tonic bias, validated
  on real audio" is the noted future direction. Small, research-flavored,
  not urgent.

## 5. Doc/process currency gaps found this pass

- **The app's own version badge (`#app-version` in index.html) still
  reads "v5"**, and USER-MANUAL.md's title still says "(v5)" — despite
  v6 having shipped and closed. V6-P1 (release-v6-spec.md §5) committed
  to a doc-currency pass at the close of *each milestone*; the version
  string itself wasn't part of that check and slipped through all of
  v6. Small, mechanical, worth folding into whatever process commitment
  v7 makes (§ below) — and worth just fixing outright once v7's own
  scope is settled, rather than another audit finding it stale again.
- **QUEST-PLAN-BOSS-EDITION.md** is a manual QA checklist (unchecked by
  design — it's run by a human, not completed via commits), not a
  backlog source; confirmed it doesn't carry any hidden open items of
  its own.

## 6. Everything already declined, unchanged — not re-litigated here

Custom lead/rhythm ML model, Linux/Windows/native macOS app, BT-12 gain
automation, BT-18 batch operations — release-v5-spec.md §9 and
release-v6-spec.md §0 already gave these reasoning that hasn't changed.
**LAN mode** graduates from "declined for this release" to real,
un-spiked backlog per §3 above — see release-v7-spec.md for whether it
finally gets a real decision.

## 7. Where this leaves the actual next step

Same shape as every checkpoint before it: this document is the map, not
the route. [release-v7-spec.md](release-v7-spec.md) picks a coherent
subset of §§2 and 4 above — the freeze investigation is the standout
candidate given this session's directly-proven track record on exactly
this class of bug — with real gates and milestones, not "build
everything eventually."
