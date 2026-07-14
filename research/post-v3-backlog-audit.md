# Post-v3 Backlog Audit — What's Left From enhancements-backlog.md

**Status:** written at the v3.0 checkpoint to retire
`enhancements-backlog.md` (deleted alongside this doc — its ~50 items
have almost all shipped, and the picklist/scoring format it used has
been superseded by [release-v4-spec.md](release-v4-spec.md)'s milestone
structure). This doc is the closing audit: every item from that backlog,
checked against what's actually in the app today, with the handful of
genuine survivors given a proper new home below.

**Answer to "is anything left unimplemented?"** Almost nothing, and
what's left was already known and is already tracked in release-v4-spec.md
— except **six small items** that fell through the cracks of every
later planning doc. Those six are this document's actual payload (§2).

---

## 1. Full audit (BT/GP/VD/XC)

Legend: ✅ Shipped · 🔜 Open, tracked in release-v4-spec.md or
appstore-plan.md already (no need to duplicate) · 🟡 Open, **not tracked
anywhere until now** — see §2 · ⛔ Superseded/dead.

| ID | Item | Status | Notes |
|---|---|---|---|
| BT-01 | BPM detection + live readout | ✅ | Shipped, plus the ½×/2× octave-error correction added during v3 hardware testing |
| BT-02 | Beat grid + click stem | ✅ | Click metronome, beat-grid ticks on the ruler |
| BT-03 | Key detection + semitone transpose | ✅ | Key detection heuristic; Tune widened to ±1200¢ (±1 octave) |
| BT-04 | Chord detection & chord lane | 🔜 | Picked as **V4-F1** |
| BT-05 | Draggable A/B loop | ✅ | |
| BT-06 | Count-in | ✅ | |
| BT-07 | Speed trainer | ✅ | |
| BT-08 | Section markers | ✅ | |
| BT-09 | Playlists / setlists | 🔜 | Picked as **V4-F3** |
| BT-10 | Practice log | 🔜 | Picked as **V4-F4** |
| BT-11 | Per-stem EQ & pan | ✅ | |
| BT-12 | Gain automation (volume ramps) | 🔜 | Listed "deferred, not dead" in release-v4-spec.md §3 |
| BT-13 | Next-gen separation models | ✅ | Shipped (`bs_roformer_sw`) |
| BT-14 | Real lead/rhythm guitar split | 🟡 | See §2.1 — the near-term (non-ML) half of this item was never actually re-run; the ML half is properly tracked in [lead-rhythm-split-research.md](lead-rhythm-split-research.md) |
| BT-15 | Artifact cleanup pass | 🔜 | Picked as **V4-F6** (timeboxed) |
| BT-16 | Off-pitch auto-detect | ✅ | "This song appears to be ±N¢ from A=440 — apply?" |
| BT-17 | Waveform zoom | ✅ | |
| BT-18 | Batch operations | 🔜 | Listed "deferred, not dead" in release-v4-spec.md §3 |
| GP-01 | Chromatic tuner | ✅ | |
| GP-02 | Rig presets, per-song recall | ✅ | |
| GP-03 | Expanded pedalboard + reorder | ✅ | v3.1: the eight new effect types (§2.2) shipped — Boost/Overdrive, Graphic EQ, Chorus, Flanger, Phaser, Tremolo, Auto-Wah, Octaver — as reorderable cards alongside the original four |
| GP-04 | WaveNet .nam (WASM) | ✅ | |
| GP-05 | IR library & management | ✅ | v3.1: the IR tone shaper (§2.3, low/high-cut on the wet path) shipped |
| GP-06 | Looper pedal | 🔜 | Picked as **V4-F2** |
| GP-07 | Riff capture buffer | ✅ | |
| GP-08 | Audio-only takes | ✅ | |
| GP-09 | Performance feedback vs. the record | ⛔ | Superseded by [rate-my-take-spec.md](rate-my-take-spec.md) — a fully redesigned, better-scoped version of this idea, not a gap |
| GP-10 | Input calibration + clip light | ✅ | |
| GP-11 | MIDI foot control | 🔜 | Picked as **V4-F5** |
| GP-12 | Bounce performance into export | 🟡 | See §2.4 — never picked up by any later doc |
| GP-13 | Latency meter | 🟡 | See §2.5 — shipped thin (browser-reported estimate only); the originally-specced *measured* version is still open |
| VD-01 | Count-in + auto-punch record | ✅ | |
| VD-02 | Takes browser | ✅ | |
| VD-03 | In-app trim | ✅ | |
| VD-04 | Auto clap-sync wizard | ✅ | Shipped, and reworked during v3 hardware testing to calibrate against a guitar strum instead of a clap (a clap was never audible in the actual recorded signal — see USER-MANUAL.md §10.2) |
| VD-05 | Multi-take practice mode | 🟡 | See §2.6 — never picked up by any later doc |
| VD-06 | Recording overlays | 🟡 | See §2.6 |
| VD-07 | Social export presets | 🟡 | See §2.6 |
| VD-08 | Side-by-side take compare | 🟡 | See §2.6 |
| VD-09 | Camera framing aids | ✅ | |
| XC-01 | Project format v2 | ✅ | |
| XC-02 | Keyboard shortcuts | ✅ | |
| XC-03 | Content-based cache key | ✅ | Stems *and* projects, both content-hash keyed |
| XC-04 | Onboarding / in-app help | ✅ | |
| XC-05 | Native macOS app | 🔜 | Fully superseded by [appstore-plan.md](../appstore-plan.md) — a much more detailed, tiered plan than this backlog item ever was |
| XC-06 | Windows parity | 🔜 | Superseded by release-v4-spec.md §5's compatibility-phase plan, which is more detailed than this backlog item |

**Score (at the time this audit was written): 30 shipped, 6 already
correctly tracked in release-v4-spec.md, 2 superseded by better docs, 6
genuine survivors below.** Since then, v3.1 shipped two of those six
(§2.2, §2.3) — see their sections for what changed; the table above
reflects the current (post-v3.1) status.

---

## 2. The six items that fell through the cracks

### 2.1 BT-14's near-term action was never actually done

The original recommendation (before BT-13 shipped) was: once a better
guitar stem exists, **re-run `split-guitar` against it and re-validate
against the 5-song test set** — very likely a free quality win, since
the heuristic's failures were entangled with source-stem bleed, not the
panning math. `bs_roformer_sw` shipped, but this re-validation step
itself was never done as a discrete task, and the manual's guitar-split
section still reads as if nothing changed. **Size: S** — no new code,
just re-running the existing heuristic against the better stem and
updating the honesty notes in USER-MANUAL.md §7 with whatever the result
actually is.

### 2.2 GP-03's actual expanded effect palette — ✅ SHIPPED v3.1

What shipped under "GP-03" was drag-to-reorder for the *existing* four
post-amp cards (Cab IR, EQ, Compressor, Delay/Reverb) — genuinely useful,
but not what GP-03 originally specified. The actual ask — **chorus,
flanger, phaser, tremolo, wah/auto-wah, octaver, a dedicated boost/
overdrive pedal, and a graphic EQ** as real Web Audio pedal cards — is now
built: all eight are reorderable pedalboard cards alongside the original
four (twelve total between Gate/Amp and Output), each with its own
bypass, controls, and rig-preset round-trip. Auto-Wah is named that (not
"Wah") since it's LFO-swept, not expression-pedal controlled — there's
still no MIDI/expression input (GP-11, still open). Octaver is a
rectify-and-filter sub-octave approximation, not a true pitch tracker —
flagged honestly in its own card hint, same spirit as the chord-detection
and off-pitch-detect honesty notes elsewhere. v3.1 also added a
signal-flow visualization (arrows between pedalboard cards, following
chain order) that wasn't part of the original GP-03 ask but was requested
alongside it.

### 2.3 GP-05's one missing piece: IR-specific tone shaping — ✅ SHIPPED v3.1

The folder-scanned IR picker, search, and per-preset recall all shipped.
The one specific piece of the original ask that didn't, until now: **an
optional high/low-cut filter placed right after the loaded IR**, for
shaping a cab sim's extreme top/bottom end independently of the
general-purpose EQ card further down the chain — two biquad filters on
the existing IR card's wet path, wide open (no-op) by default.

### 2.4 GP-12: bounce your live performance into the normal export

The video-recording path already proves program-mix capture (backing
track + processed guitar, mixed and leveled) — GP-12 asked for that same
captured performance to be routable through the **existing Python export
pipeline** (WAV/MP3, LUFS normalization, boost cap) as "me + backing
track," instead of only existing as a raw take file. Nobody picked this
up after the video spec's original mention. **Size: M** — the capture
side already exists (recorder.js); needs a server endpoint that treats a
finished take's audio the same way `svc_mix` treats a stem mix.

### 2.5 GP-13: the latency meter still isn't measuring anything

Flagged explicitly in release-v3-spec.md's own "where v2.5 stands"
section and never revisited since: Play Along's latency figure reads the
**browser's own reported values**, not an actual measured round-trip.
The originally-specced version — a loopback ping through the real audio
graph — is still open. **Size: S**, mechanically (schedule a click,
measure the round-trip via the input path), but needs the user plugged
in with a real interface to mean anything, so it's a hardware-verified
feature, not a headless one.

### 2.6 The video/recording ideas nobody picked back up (VD-05/06/07/08)

Four small-to-medium recording features from the original video spec
were never revisited after VD-01 through VD-04 (and VD-09) shipped:

- **VD-05 · Multi-take practice mode** — loop a section with auto-retake,
  each pass saved as its own take, review and keep the best (needs
  BT-05 + VD-02, both shipped — no longer blocked).
- **VD-06 · Recording overlays** — burned-in title/take-number lower
  third, live chord display (blocked on BT-04, which is now picked for
  v4 — natural pairing once that lands).
- **VD-07 · Social export presets** — one-click re-crop to 9:16/1:1 and
  a normalized web-friendly H.264+AAC version of a take, pure ffmpeg
  presets over an existing file.
- **VD-08 · Side-by-side take compare** — play two takes synced against
  their shared backing track to compare (needs VD-02, shipped).

None of these are large; they were simply never re-surfaced once the
core recording feature set (VD-01–04, VD-09) shipped and attention moved
to Play Along and practice intelligence.

---

## 3. Recommendation

None of these six were release-blocking, and several are natural fits
alongside work release-v4-spec.md already has scheduled — 2.1 pairs with
the artifact-cleanup pass (V4-F6), 2.6's VD-06 pairs with chords (V4-F1).
**Update:** 2.2 and 2.3 shipped as v3.1, ahead of v4 — they turned out
self-contained enough (both scoped entirely within the existing
reorderable-pedal-chain architecture, no dependency on v4's Rate My Take
or guitar-only-thesis work) to pull forward rather than wait. Remaining
suggested treatment, unchanged for 2.1/2.4/2.5/2.6: fold 2.1 into
whichever v4 milestone touches the artifact-cleanup pass (V4-F6) as a
small bonus item, and leave 2.4/2.5/2.6 as a genuine "v5 or whenever it's
wanted" pile — this document is their record so they don't need
re-discovering from scratch later.
