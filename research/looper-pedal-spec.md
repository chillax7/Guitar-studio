# Looper Pedal — Design Spec (GP-06)

**Status:** design spec only (release-v6-spec.md §1's M0 gate) — **the
build (M1) and MIDI hands-free control (M2) are both deliberately on
hold**, per direct instruction: there's no MIDI footswitch on hand to
test M2 against right now, and starting M1 without knowing what M2 needs
from it risks having to rework the control surface later. This doc
exists so both can start immediately, back-to-back, whenever a
footswitch is available — nothing about "what to build" should still be
an open question at that point.

**One-line pitch:** a real-time loop recorder/overdubber living
alongside Backing Track/Tuner/Riff Capture in Play Along's top strip —
lay down a rhythm part (or anything else), have it loop back
continuously, and play or solo over it, the same workflow every
standalone looper pedal (Boss RC-1, TC Ditto, etc.) offers, which this
app currently has no answer for at all.

---

## 1. Resolving release-v6-spec.md §1's open questions

**Where it lives — a top-strip card, not a pedal-chain icon.** The
icon-chain redesign's cards (Gate/Amp/pedals/Output) are all *inline*
processors — the live signal passes *through* them, in signal order,
and each one is individually bypassable. A looper doesn't transform the
signal in line; it taps a copy of it and plays a recorded copy back in
parallel — architecturally the same category as Riff Capture (§2 below
spells out exactly why they can even share a tap point), which already
lives in the top strip next to Backing Track/Tuner/Rig Preset. A new
**Looper** card joins that row.

**Sync model — quantized-to-the-beat-grid when a BPM exists, free-running
otherwise.** This app already has a detected BPM/beat grid (BT-02) that a
standalone hardware looper never has access to — using it is a real,
concrete differentiator, not just cloning hardware behavior for its own
sake. If `State.analysis.bpm` exists for the loaded song, the loop
length locks to the nearest whole-bar boundary (assuming 4/4 — same
known limitation the Click already carries, USER-MANUAL.md §9) rather
than whatever exact duration you happened to stop recording at. If no
track is loaded, or `bpm` never resolved, the loop free-runs at exactly
the length between your two button presses — same as a hardware looper.
Either way, once a length is set, it's fixed until Clear.

**Interaction with the backing track — turns out to be a non-issue, not
a design decision.** §2 below shows this resolves itself once the tap
point is chosen correctly: the looper only ever touches *your processed
guitar signal*, never the backing track. It works identically whether
the backing track is playing, paused, looped, or not loaded at all —
there's no real interaction to design around.

**Controls — the universal 5-button hardware vocabulary, one primary
button plus three secondary:** Record/Overdub/Play (one button, cycles
through state — see §4), Stop, Undo (last overdub only), Clear. Matching
what a player who's ever touched a real looper pedal already knows cold
beats inventing a new interaction model.

**Persistence — per-song, like everything else that isn't a listening
preference.** Mix, rig chain, markers, key/BPM corrections — all
per-song. A saved loop should be no different; §5 covers the save/reload
shape.

---

## 2. The signal tap: recording your guitar without looping the backing
track, and why recordings need one new node

Today (`recorder.js`'s `ensureRecordBus`): a Take/Riff Capture mixes
`Audio.analyser` (backing track) and `PA.outputMute` (your fully
processed guitar, post-Gate→Amp→every pedal→Output — the very end of the
Tone Lab chain) into one bus, because a Take is supposed to sound like
"what the audience heard."

The looper needs a **different** tap: `PA.outputMute` alone, never the
backing track. That's the guitar signal after every effect, which is
exactly right — a looped rhythm part should carry your amp/cab/pedal
tone, not a dry DI signal.

The one real architecture change this requires: today, `PA.outputMute`
connects straight to `PA.outAnal` → destination (playalong.js line
~498). A loop needs to be summed back in **before** that point, not
after — otherwise your loop would be audible on your speakers (fine)
but silently missing from any Take or Riff Capture recorded while it's
playing (not fine — the entire point of looping under a Take is
capturing "me playing over my own loop" as one file). Concretely:

```
// today:
PA.outputGain → PA.outputMute → PA.outAnal → destination

// with the looper:
PA.outputGain → PA.outputMute → PA.loopSum → PA.outAnal → destination
                     ↓                ↑
              (record tap)   (loop playback node feeds in here)
```

`PA.loopSum` is a new plain `GainNode` — `PA.outputMute` and the
looper's own playback output both connect into it, and it replaces
`PA.outputMute` as what `recorder.js`'s `ensureRecordBus` and Riff
Capture's `Recorder.recordBus`/`riffCaptureNode` tap (a one-line change
in each — swap which node they `.connect()` from). Once that swap is
made, a Take or a Riff Capture recorded while the loop is running
correctly contains "backing track + your loop + your live playing," with
zero special-casing in either of those two features — they just now
listen one node further downstream than before.

---

## 3. DSP: a new AudioWorkletProcessor, same lineage as riff-capture-processor.js

Riff Capture (`riff-capture-processor.js`) is the closest existing
precedent — a worklet holding its own PCM ring buffer, controlled by
`postMessage`. The looper needs the same shape, but **bidirectional**
(an input for recording, an output for playback — riff capture only
ever dumps, it never plays back) and stateful across an overdub cycle.

**`looper-processor.js` (new), sketch of its internal state machine:**

- `idle` — silent output, input ignored (recording not started).
- `recording` (first pass only) — writes input frames into a
  growing buffer; length is unknown until the second button press
  stops it.
- On stop-and-play: if a BPM/beat-grid was supplied at start (main
  thread passes it in the `postMessage` that kicks off recording), the
  captured buffer is resampled-by-truncation-or-pad to the nearest
  whole-bar length at the song's tempo; otherwise the raw captured
  length is kept as-is. This becomes `loopLengthFrames`, fixed until
  Clear.
- `playing` — loops `committedBuffer` (initially just that first pass)
  from playhead 0 back to `loopLengthFrames` continuously, writing it
  to output every block.
- `overdubbing` — same playback as `playing`, **plus** input frames for
  this pass are summed into a separate `pendingBuffer` at the same
  playhead position (sample-accurate, since both are driven by the same
  loop-relative playhead counter) — never written directly into
  `committedBuffer` while still in progress.
- On stop-overdub (back to `playing`): `previousCommitted =
  committedBuffer` (kept for one level of Undo), then `committedBuffer
  += pendingBuffer` (sample-wise sum, clamped), `pendingBuffer` cleared.
- `Undo` message: if `previousCommitted` exists, `committedBuffer =
  previousCommitted`, `previousCommitted = null` (one level only —
  undoing twice in a row does nothing the second time, same honest
  limitation a cheap hardware looper's own single-undo has).
- `Clear` message: everything resets to `idle`, `loopLengthFrames = null`.

**Main-thread control (`playalong.js`, new `PA.looperNode`), mirroring
`ensureRiffCapture`'s own setup exactly:** created lazily via
`ensurePAGraph`, `PA.outputMute.connect(PA.looperNode)` for the record
tap, `PA.looperNode.connect(PA.loopSum)` for the playback return (both
directions through the *same* worklet node — an `AudioWorkletNode` can
have input and output channel counts independently, this doesn't need
two separate nodes).

---

## 4. UI: the Looper card

New top-strip card, same visual family as Riff Capture:

```
┌─ LOOPER ──────────────────────────────┐
│  [ ● Record ]              0:00 / —   │
│  Stop     Undo     Clear              │
│  Loop length: locked to 4 bars (120 BPM)   ← only shown once a length exists
└────────────────────────────────────────┘
```

The single primary button's label/action cycles with state, exactly
like a real pedal's one footswitch would (this is also *why* it's
designed as one button first — it's a straight 1:1 hookup for M2's
eventual single-button footswitch, no redesign needed once that lands):

| Current state | Button reads | Press does |
|---|---|---|
| idle (nothing recorded) | **● Record** | starts recording pass 1 |
| recording (pass 1) | **■ Stop & Loop** | stops, sets loop length (§1), starts playback |
| playing | **● Overdub** | starts an overdub pass on top of the running loop |
| overdubbing | **■ Stop Overdub** | commits this pass (§3), back to playing |

**Stop** (secondary button, always visible once a loop exists): stops
playback entirely, keeps the recorded loop in memory — pressing the
primary button again resumes playback from the top, doesn't re-record.
**Undo**: one level, per §3. **Clear**: wipes the loop, back to the idle
row above, secondary buttons disabled again.

A length readout ("Loop length: locked to 4 bars (120 BPM)" or "Loop
length: 3.8s (free-running — no song loaded)") sets honest expectations
about which sync mode is active, the same "always say which heuristic
mode you're in" posture as the chord lane's confidence caveats.

---

## 5. Persistence

On **Stop** (not Clear — stopping keeps the loop, clearing discards it),
auto-save the current `committedBuffer` to disk the same way Riff
Capture's `saveRiff()` does: encode via the existing `wavEncode` helper,
`POST /api/recording/save?track=<name>&ext=wav&prefix=loop` (the
existing endpoint already used by both Takes and Riffs — no new server
route needed, just a new `prefix`). Reopening the same song later loads
that file back into the worklet's `committedBuffer` (paused, `idle`→
`playing`-ready, **not auto-playing** — same "explicit action to
reactivate something saved" posture the manual key-correction Reset
button and rig-preset auto-recall both already use) rather than
silently resuming playback the moment the song opens.

A song with no saved loop shows the idle row with no length readout, as
today's mock above.

---

## 6. What this deliberately doesn't do (v6 scope, restated for the build)

- **No MIDI/footswitch control yet** — M2, explicitly on hold. The
  single-primary-button design above is what makes that a pure wiring
  exercise later (`paCyclePresetChain`-style: one incoming MIDI message
  → whichever action row 1's table says the current state maps to) —
  no rework anticipated, but not to be assumed correct until an actual
  footswitch is on hand to test against, same caution GP-14's own MIDI
  half (release-v6-spec.md §2) already calls out.
- **No loop-length editing after the fact** (nudging bar count up/down
  post-hoc) — Clear-and-redo is the only way to change a locked length.
  Real gap if it turns out to matter in practice; not worth guessing at
  up front.
- **No multiple independent loop tracks** (a "layers" view, solo/mute
  per overdub pass) — this is a single accumulating loop, one Undo level
  deep, matching a genuinely cheap hardware looper rather than a
  multi-track live-looping rig (Ableton Live Session View-class tools
  already own that end of the market; competing there isn't this app's
  identity).
- **No export of the loop as its own standalone file** beyond the
  auto-save in §5 — it's reachable from disk (`output/<song>/recordings/`,
  same as any Take/Riff) but there's no dedicated "export my loop" UI
  distinct from that.
