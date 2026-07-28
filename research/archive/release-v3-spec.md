# Orpheus Guitar Studio — Release v3 Spec & Plan

**Status:** planning document, written at the v2.5 checkpoint (tag `v2.5`,
plus the WASM NAM engine and app icon that landed just after it). Intended
to be handed to a **fresh working session** as its starting brief — it
assumes no memory of how v2.5 was built, so context that a new session
needs is spelled out rather than implied.

**Companion docs:** enhancements-backlog.md (the full picklist this
selected from — item IDs like GP-02 refer to it; retired at the v3.0
checkpoint, see [post-v3-backlog-audit.md](post-v3-backlog-audit.md) for
what became of every item in it),
[USER-MANUAL.md](../USER-MANUAL.md) (what the app does today),
[TEST-PLAN.md](../TEST-PLAN.md) (regression checklist).

---

## 0. Working in this repo — read first (new session orientation)

- **Layout:** `backing_track.py` = separation/mix engine (pure functions,
  CLI). `GuitarStudio/server.py` = stdlib loopback HTTP server importing
  the engine in-process. `GuitarStudio/static/` = vanilla JS frontend:
  `app.js` (mixer/transport/library), `playalong.js` (live rig),
  `recorder.js` (video takes), plus AudioWorklets (`nam-processor.js`,
  `gate-processor.js`, `stretch-processor.js`) and a Zig-built WASM NAM
  kernel (`nam.wasm`, source in `nam-wasm-src/`, rebuilt by its
  `build.sh`; needs `brew install zig`).
- **Python changes need a server-process restart; JS/CSS/HTML changes only
  need a browser reload.** This distinction caused multiple phantom bugs
  during v2's development — check it before debugging anything.
- The user runs the live server on **port 8765** (`Guitar Studio.app` or
  `.claude/launch.json` → `guitar-studio-server`); use
  `guitar-studio-server-debug` (**port 8767**) for testing so you never
  fight the user's session.
- **Verification culture:** every fix in v2 was verified live in the
  preview browser against real data before shipping, and the user
  re-verifies on real hardware (USB interface + guitar). Headless testing
  CANNOT feel real-time audio deadlines — the worst v2 bug (NAM captures
  killing the whole audio stream) was invisible headless and root-caused
  only via on-hardware diagnostics (`gsDiag()` in playalong.js, still
  there). Never claim a live-audio change verified until the user has
  played through it.
- **House style:** honesty notes in the UI wherever a feature is a
  heuristic or has a quality ceiling; comments explain *why*, not *what*;
  commit messages tell the story of root causes; git tag known-good
  checkpoints before risky work (v2.5 exists for exactly this).
- Real user data lives untracked in `input/`, `output/`,
  `GuitarStudio/models/{nam,ir}` (261 NAM captures, ~3k IRs in pack
  subfolders) — treat as precious, never commit, never delete.

---

## 1. Where v2.5 stands

Everything in USER-MANUAL.md exists and is user-verified on real hardware:
6-stem separation (default `bs_roformer_sw`), live mixer with speed/tune/
volume, mute-painting, A/B loop, count-in, BPM/key-offset analysis, export
with LUFS normalization, Play Along rig (gate → clean/analog/NAM amp →
cab IR → EQ/comp/delay/reverb), WASM WaveNet NAM inference (~10x the JS
engine; per-model realtime-budget guardrail), folder-browsing NAM/IR
pickers with search, tuner (mutes while tuning), input calibration + clip
latch, video recording with count-in/auto-punch, clap-sync wizard, framing
guides, takes browser with lossless trim, autosaved per-song projects,
keyboard shortcuts.

From the backlog: **all v0.4-tier items shipped**, plus GP-04 (WaveNet
WASM — was Stretch-tier) and BT-13. **One v0.4 item shipped thin:** GP-13
"latency meter" currently reads the browser's own reported figures;
the specced version (measured loopback round-trip) is still open — folded
into M3 below.

## 2. Engineering debt to clear early (from the v2.5 code review)

A full multi-angle code review ran at the v2.5 checkpoint. Its
correctness findings are being fixed as v2.5.x hotfixes (see the review
report / recent git history — check `git log` before assuming any of
these still exist). What belongs to **v3** is the structural work the
review surfaced — do these BEFORE piling on features, they make
everything after cheaper and safer:

**V3-E1 · One owner for AudioContext lifetime — S**
"Keep the context alive" is currently three scattered mitigations: state
polls in two rAF loops (app.js `tick()`, playalong.js `paStartMeters`)
plus the −90dB tuner-mute workaround. Replace with a single
`statechange` listener installed in `ensureCtx()` that resumes on
unexpected suspends (event-driven — also works in backgrounded tabs,
which rAF polling doesn't). Then delete the polls.

**V3-E2 · Dedicated mute nodes — S**
Tuner-mute currently overwrites the same gain params the volume sliders
own, so moving a slider while tuning silently un-mutes (a review-confirmed
bug). Insert dedicated mute GainNodes in series (one on the master path,
one on the PA output); mute state and level state become orthogonal, the
−90dB hack becomes deletable (with V3-E1), and slider handlers keep sole
ownership of their own gains.

**V3-E3 · NAM speed guardrail: self-calibrating — M**
`NAM_REFUSE_RT_FACTOR` encodes this one machine's offline-thread-vs-
performance-core ratio. Measure the ratio per session instead (render one
fixed reference workload at startup and normalize probe results against
it), and/or verify after live load by timing actual `process()` quanta
for the first ~100ms with rollback before the stream dies. Matters the
moment friends run this on other Macs — which is happening now.

**V3-E4 · Server: stream + Range + caching — M**
`_send_file` reads whole files into memory with `Cache-Control: no-store`
on everything. Stems re-download in full on every track select (hundreds
of MB), the takes `<video>` can't seek, Suggest re-fetches the same .nam
files repeatedly. Stream in chunks, honor Range for media, and give
immutable artifacts (stems, .nam files) real cache headers — keep
no-store only for HTML/JS/API JSON.

**V3-E5 · Hot-path hygiene — S/M**
Review-measured waste on the real-time thread and per-frame paths: hoist
the gate worklet's per-sample transcendentals (envCoeff is constant;
threshold is k-rate); preallocate stretch-processor's per-hop
Float32Arrays (~3,400 allocations/sec across 6 stems today); cache the
WASM memory view per model instead of two fresh views per quantum; make
app.js `tick()` compute position once, cache its NodeLists, and skip
writes when nothing changed. Render-thread wins here directly widen which
NAM captures pass the guardrail.

**V3-E6 · Shared helpers for review-flagged duplication — S**
`awaitNamLoad(node, msg)` (3 drifted copies of the loaded-ack promise —
the Suggest copy already ignores load failures); parameterize
`paProbeNamModel` so Suggest calls it instead of re-implementing the
guardrail; `dbToLin()`/`rmsOf()` utilities next to `escapeHtml`; single
ping helper inside gsDiag.

## 3. Play Along UI redesign (user-requested)

The mixer page is good. The Play Along page grew card-by-card as features
landed and it shows. Problems, from a fresh-eyes review of the current
layout at desktop width:

- The **signal chain is scattered**: Input (col 2) → Noise Gate (col 3)
  → Amp (col 1, below the fold) → Cab IR (col 2) → EQ (col 3) → … The rig
  doesn't read as a chain, and the tone controls — the thing you touch
  most — are below the fold.
- **Record Performance occupies premium space** (a large, permanently
  black camera preview even with no camera enabled) directly under the
  Backing Track card, while Amp sits below it.
- **Half-empty cards** (Takes with no takes, Tuner's large card for two
  readouts) waste a column.
- Setup-once controls (device pick, calibrate, A/V offset, quality)
  visually interleave with every-session controls (Record button, amp
  knobs).

**Proposed layout (V3-U1 · M):**

1. **Top strip (always visible):** Backing Track transport (as today) +
   a compact Tuner readout (note + cents needle inline; it mutes anyway,
   it doesn't need a card) + Input meter/clip light. The "am I in tune,
   am I clipping, where's the song" glance row.
2. **Main area = the rig, in signal-chain order,** left→right like a
   pedalboard: Input/Gate → Amp (Clean/Analog/NAM tabs) → Cab IR →
   EQ → Comp → Delay/Reverb → Output. Cards collapsible, collapse state
   persisted (XC-01 project format v2 carries it). Amp card gets the
   most width.
3. **Record & Takes become a mode/tab** ("Perform" / "Record"), not
   permanent cards: camera preview only renders once a camera is
   enabled; A/V offset, quality, auto-calibrate live behind a "Setup"
   disclosure inside it. The REC pill already covers "recording while
   elsewhere".
4. Setup-once input controls (device dropdown, Calibrate) fold into a
   disclosure on the Input strip after first successful enable.

Keep: the mirrored Backing Track card concept (it's why the top strip
exists), all existing element IDs where practical (TEST-PLAN.md and
muscle memory), honesty hints.

## 4. NAM Model Tweaker (user-requested, new)

**Goal:** "expose all of the settings for a model e.g. gain, presence,
bass, treble etc. — whatever is there for a particular model," as a
richer tone-shaping surface than today's two trim sliders. Separate
screen/panel is acceptable.

**Honest scoping first — what a .nam file actually is:** a standard NAM
capture is a *snapshot of one amp at one knob setting*. There are no
gain/presence/bass/treble parameters inside it to expose — the knobs were
frozen into the weights when the capture was trained. (A rare parametric
"A2/slimmable" NAM family with real conditioning knobs exists but is a
different architecture our engine explicitly doesn't support, and
community libraries are overwhelmingly standard captures.) So the tweaker
is built *around* the capture, the same way NAM's own plugin does it:

**V3-T1 · Tweaker panel — M/L.** For the loaded capture:
- **Metadata, surfaced:** everything the .nam JSON carries — gear
  make/model, capture author, architecture + measured realtime cost
  (from the existing probe), loudness if present, ESR if in the filename/
  metadata. Today none of this is visible; it answers "what AM I playing
  through?"
- **Drive** (renamed input trim, wider range, prominent knob): genuinely
  changes distortion character — it's how hard you push the captured amp,
  exactly like a boost pedal in front. This is the closest thing to a
  real "gain knob" that physics allows here, and it deserves top billing.
- **Post tone stack:** Bass / Mid / Treble / **Presence** (high-shelf
  tilt ~4–8kHz) as dedicated filters *inside the amp block* (before the
  cab IR), separate from the existing post-chain EQ card — this is the
  "amp's tone stack" feel players expect. Defaults flat = today's sound.
- **Output level + auto-level** (the calibration gain, shown and
  adjustable rather than invisible).
- **Capture blend (stretch, if time allows):** load a second capture and
  crossfade A/B outputs — poor-man's dual-amp / "channel blend". Costs
  double inference; gate behind the realtime-budget probe (sum both
  models' measured cost).
- **Parametric .nam support (R&D, likely punt):** detect the parametric
  architecture and, if a file has real conditioning knobs, expose them.
  Worth a detection stub + honest "this is a parametric capture, not yet
  supported" message even if inference support never lands in v3.

**V3-T2 · Rig presets (GP-02 from the backlog — M) is the natural
companion** and should land in the same milestone: the tweaker creates
exactly the state worth saving. Full rack state (amp mode, capture,
tweaker knobs, IR, FX, output) as named presets, recallable, attachable
to a song so loading the song loads the rig. Needs XC-01 (project format
v2, versioned migration).

## 5. Feature picks from the backlog

Curated for the practice-flow arc, in dependency order (IDs → the
now-retired enhancements-backlog.md — see
[post-v3-backlog-audit.md](post-v3-backlog-audit.md)):

| Pick | Item | Size | Why now |
|---|---|---|---|
| XC-01 | Project format v2 (versioned, carries presets/markers/UI state) | M | Prerequisite for presets, markers, playlists |
| GP-02 | Rig presets + per-song recall | M | Companion to the Tweaker (§4) |
| BT-02 | Beat grid + click stem | M | Unlocks the whole musical-intelligence arc |
| BT-07 | Speed trainer ("Step-It-Up") | S/M | Cheap once loops exist; huge practice value |
| BT-08 | Section markers | M | Click-to-jump/loop a solo; needs XC-01 |
| BT-03 | Key detect + ±12 semitone transpose | M | Existing pitch engine, wider range |
| GP-03 | Expanded pedalboard + drag-to-reorder | M/L | The rig's biggest remaining gap |
| GP-07 | Riff capture rolling buffer | M | "Save that!" — beloved, self-contained |
| GP-08 | Audio-only takes | S | Trivial off the video path |
| GP-13 | **Finish** the latency meter (measured loopback, not estimate) | S | v0.4 leftover |
| BT-11 | Per-stem EQ & pan | M | Carve space to play along |
| BT-17 | Waveform zoom + finer nudge | S/M | Precision loops/mute edges |
| XC-04 | Onboarding / in-app help | S/M | Friends are testing now; nobody reads files |
| — | **Projects UX:** visible per-song project indicator + rename-following (key projects by content hash like the stem cache, not filename) | S/M | Known v2 gap: renaming a source file orphans its mix |

Explicitly **not** in v3 (unchanged reasoning from the backlog): BT-04
chord lane (L, genuinely hard to do honestly — first R&D spike only),
BT-14 ML lead/rhythm split (no dataset exists), GP-09 performance scoring
(R&D), XC-05 native app (feature set still moving), GP-06 looper (L —
good v4 anchor).

## 6. Milestones

Gates are user-verified on real hardware, per the house verification
culture. Tag `v3.0` at M6.

- **M1 — Foundations:** V3-E1..E6 (debt), any v2.5.x hotfixes not yet
  landed. *Gate:* full TEST-PLAN.md pass; NAM guardrail behaves sanely on
  at least one other Mac (a friend's).
- **M2 — Play Along redesign:** V3-U1. *Gate:* user plays a full session
  without leaving Play Along; tuner/meters glanceable while playing;
  no regression in TEST-PLAN §Play-Along items.
- **M3 — Tone:** V3-T1 tweaker + GP-13 finish; V3-T2/GP-02 presets +
  XC-01. *Gate:* build a tone with drive + tone stack, save as preset,
  attach to a song, reload restores everything.
- **M4 — Practice intelligence:** BT-02 beat grid + click stem, BT-07
  speed trainer, BT-08 markers, BT-03 transpose. *Gate:* learn-a-solo
  loop: mark the solo, loop it, train speed 60%→100% with click.
- **M5 — Rig & capture extras:** GP-03 pedalboard, GP-07 riff capture,
  GP-08 audio takes, BT-11 per-stem EQ/pan, BT-17 zoom.
- **M6 — Polish & release:** XC-04 onboarding, projects UX/rename-
  following, USER-MANUAL + TEST-PLAN updates, icon/docs pass, tag v3.0.

Each milestone ends with: update USER-MANUAL.md + TEST-PLAN.md for what
shipped, commit with root-cause-style messages, push, and a user
run-through before starting the next.
