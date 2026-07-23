# Orpheus Guitar Studio — Release v6 Spec & Plan: closing the live-rig gap

**Status:** written at the v5 checkpoint (2026-07-23), immediately after
[post-v5-backlog-audit.md](post-v5-backlog-audit.md) — that doc is the
map (what's shipped, what's open); this is the route (a coherent v6
subset with real gates and milestones), same relationship
release-v5-spec.md had to post-v4-backlog-audit.md.

**Companion docs:** [post-v5-backlog-audit.md](post-v5-backlog-audit.md)
(source list for everything picked or declined below),
[rig-preset-chain-spec.md](rig-preset-chain-spec.md) (GP-14 — the
already-shipped keyboard half of "hands-free rig," which §2 below
completes with hardware MIDI), [market-review-2026.md](market-review-2026.md)
(source for the LAN-mode framing in §4), appstore-plan.md (owns any
future native-app/distribution reversal — untouched by this doc, same
separation release-v5-spec.md §9 already established).

---

## 0. The v6 thesis: the one gap real users keep naming

release-v5-spec.md §9 already called out GP-06 (a looper pedal) as "a
real gap, but big enough to deserve its own milestone... first candidate
for a v6 release, not dropped." A full release cycle later — one that
included a long, genuinely adversarial real-usage QA pass
(QUEST-PLAN-BOSS-EDITION.md) that surfaced and fixed a dozen real bugs
across every other screen — GP-06 is still the single backlog item that
keeps getting flagged and keeps getting deferred, never once because it
stopped being real. That repetition is the signal: v6's headline is
finally building it, not finding one more reason to push it again.

Everything else in this release either directly serves the same "real
gap vs. a standalone rig/pedalboard app" framing (MIDI hands-free
control completes what GP-14 started) or is small, already-scoped
honesty/polish work that's been sitting sized-but-unbuilt since v5
(measured latency, export presets) — the same "quick win, just never
picked up" role BT-01/BT-05 played in the v0.4 picklist and VD-07 was
meant to play in v5.

**Explicitly out of scope for v6, and why:**

- **LAN mode build.** Real, and the market review's single biggest
  structural finding — but it's a distribution-track decision
  (appstore-plan.md's territory), same reasoning release-v5-spec.md §9
  used to keep platform work out of a feature release. §4 below keeps it
  alive as a spec-only spike, same as v5 planned and then didn't get to.
- **Song-section detection (V5-S2).** Real and still a good stretch
  candidate, but v6's committed list is already anchored by one L-sized
  build (the Looper) — adding a second medium build risks neither
  finishing well. First pull-forward candidate if a milestone finishes
  early (§6), not committed.
- **Custom lead/rhythm ML model, Linux/Windows/native app, windowed key
  detection** — release-v5-spec.md §9 already declined these with
  reasoning that hasn't changed; not re-litigated here.
- **BT-12 gain automation, BT-18 batch operations** — still "deferred,
  not dead," still no new urgency.

---

## 1. The Looper pedal (GP-06) — L, needs its own design doc first

**Why now, concretely:** every serious standalone pedalboard/rig app
(the same competitive set release-v5-spec.md §11's market review
measured Orpheus against for latency) treats a looper as table stakes —
it's the one live-performance workflow ("lay down a rhythm part, solo
over it") this app currently has no answer for at all. Play Along's Riff
Capture (GP-07) is adjacent but answers a different question ("save what
I just played," always-rolling background capture) — a looper is a
foreground, deliberate, real-time overdub instrument, not a safety net.

**Gate before any build starts:** a real design spec, same rigor
rig-preset-chain-spec.md gave GP-14 before it shipped. That doc needs to
answer, concretely, before implementation begins:

- **Where does it live?** A new pedal-chain card (consistent with the
  icon-chain redesign, sitting in signal order like every other stage),
  or its own top-strip card next to Backing Track/Tuner (consistent with
  Riff Capture's placement)? The two have different implications for
  how it interacts with bypass/reordering vs. always-available transport
  controls.
- **Sync model.** Free-running (first press sets the loop length,
  everything after quantizes to it — the classic hardware-looper
  behavior) vs. beat-grid-locked (snaps to the song's detected BPM/beat
  grid, which this app already has and a real hardware looper doesn't).
  The beat-grid option is a genuine differentiator worth designing for
  specifically, not just cloning hardware behavior by default.
- **Interaction with the backing track.** Can you loop over a playing
  backing track (most useful, most complex — needs to duck/coexist with
  Play Along's existing transport) or is it backing-track-off only for
  v6 (simpler, still useful, honest scoping)? This is the single
  highest-risk open question and should be decided by a spike, not
  assumed.
- **Controls, at minimum:** record/overdub/play/stop/undo (last overdub
  only)/clear, matching the universal 5-button hardware looper vocabulary
  players already know — deviating from it needs a real reason, not just
  "we could add more."
- **Persistence.** Per-song like a rig preset, or session-only (cleared
  on track switch)? Given everything else in this app persists per-song
  (mix, rig chain, markers), session-only would be the surprising choice
  here, not the safe default.

**Sizing note:** L is for the real build once the design gate passes —
DSP-side loop recording/overdubbing in the Web Audio graph, UI, and
whichever sync model gets picked. Don't let the spec phase itself expand
into a second L; timebox it the way GP-14's own design spec was scoped
before its build.

---

## 2. MIDI hands-free control (V5-B3's remaining half) — M

GP-14 (rig-preset-chain-spec.md) already shipped the keyboard half of
"hands-free rig": an ordered per-song rig-preset chain, cycled forward/
backward with configurable keys. What's still missing is the actual
hands-free part — a real player mid-song has both hands on the guitar,
not the keyboard. A Web MIDI-connected footswitch (most commonly a
generic 2–4 button USB/MIDI pedal, program-change or CC messages)
mapped to the same forward/backward cycle actions (and, time-permitting,
individual pedal bypass toggles) closes that gap.

**Spike first (S, folded into this milestone, not a separate gate):**
confirm Web MIDI API browser support is workable for this app's actual
users (Chrome/Edge support it; Safari — which a Mac-default browser
launch makes relevant, see USER-MANUAL.md §1 — historically has not,
though this should be re-checked against the current Safari version
rather than assumed stale). If Safari genuinely can't do Web MIDI, the
feature still ships for Chrome/Edge users with an honest "needs Chrome
or Edge" note, the same honesty posture this app already takes with
NAM's own performance caveats (§4.9) rather than either silently failing
or blocking the whole feature on universal support.

**Build:** a MIDI device picker (same idiom as the existing audio
input/output device pickers), a learn-mode for mapping a footswitch's
buttons to forward/backward cycle (and optionally per-pedal bypass),
persisted per-user like the cycle keys already are.

---

## 3. Small, already-scoped polish — both S, both promoted directly from v5

**V6-B1 = Measured round-trip latency (GP-13, was V5-B5).** Loopback
ping: play a short click out the current output, capture it back
through the enabled input, cross-correlate for the true round-trip
number, shown next to (and shaming) the existing browser-estimate-only
figure. Needs the interface physically looped or its direct-monitor
path — the UI must say so plainly, not silently measure the acoustic
path through the room. Unchanged scope from v5; just never got its turn.

**V6-B2 = Social export presets (was VD-07 / V5-B4).** Pure ffmpeg
presets (9:16, 1:1, normalized web export) over an existing take file —
cheap, self-contained, the release's low-risk quick win, same role
BT-01/BT-05 played in v0.4 and V5-B4 was meant to play here.

**V6-B3 = TONE3000 unblock-or-drop (task, not a milestone).** The
community NAM-capture library is large enough now that "blocked on API
terms" should be resolved by actually asking, once, this release —
release-v5-spec.md §11 already said as much and it still didn't happen.
Outcome either converts `backing-track-tone-match-spec.md` Option A into
a schedulable item or retires it; both beat carrying it as permanent
limbo into a third release.

---

## 4. LAN-mode spec spike (carried forward from v5, still spec-only) — S

Unchanged from release-v5-spec.md §11: the market review's top
structural finding is that mobility is the biggest competitive gap
(a cloud-native rival's core advantage), and LAN mode converts it into a
local-first differentiator instead of a cloud concession. v6 writes the
short spec (auth posture on a LAN, which screens work at phone size,
whether live-rig audio even makes sense remotely or this is mixer/
practice-only) — v7 decides whether to build. This didn't get written
in v5 either; carrying a spec-only item forward twice without ever
producing the spec is itself worth noticing if it happens a third time.

---

## 5. A process commitment, not a feature (V6-P1)

post-v5-backlog-audit.md §3: USER-MANUAL.md's own opening section said
"AI Lab — planned for v5, not in this build" for the entire v5 release
cycle, and three of its seven screenshots (one self-flagged as stale in
its own caption) predated major UI work by months. Nothing in the
release process currently checks this. **Commitment for v6:** a
doc-currency pass — re-read the manual's own intro/TOC and spot-check
its screenshots against the actual running app — as part of closing out
each milestone below, not deferred to a single pass at the very end
(which is exactly how it went stale for a full cycle last time).

---

## 6. v6 milestones

- **M0 — Looper design spec (§1's gate).** Blocking for M1; nothing else
  in this release depends on it, so it can run in parallel with M2–M4.
- **M1 — Looper build (§1) — only after M0's design gate passes.** The
  release's anchor deliverable.
- **M2 — MIDI hands-free control (§2).** Independent of M0/M1; can run
  in parallel.
- **M3 — Polish: measured latency + social export presets (§3's V6-B1/
  B2).**
- **M4 — TONE3000 unblock-or-drop (§3's V6-B3) + LAN-mode spec spike
  (§4).** Both cheap, both parallelizable with everything else.
- **Ongoing, not a milestone — V6-P1 (§5):** a doc-currency check at the
  close of M1, M2, and M3 each, not saved for the end.
- **Stretch, time-permitting, not committed:** song-section detection
  (V5-S2) — first pull-forward candidate if any milestone above finishes
  early.

Each milestone ends the same way every release since v4 has: docs
updated (§5's commitment makes this explicit rather than assumed),
honest commit messages, push, a real user run-through before the next
milestone starts.
