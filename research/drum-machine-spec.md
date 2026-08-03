# Basic Rock Drum Machine — Specification

**Status: v1 shipped.** Built per this spec with the two decisions made
directly: excluded from Riff Capture (§6, hardcoded via routing — no
checkbox in v1), and sampled one-shots for the kit (§4, option B) — with
one deviation worth flagging: the samples are offline-synthesized
one-shots baked to WAV files, not downloaded acoustic recordings. Real
licensed acoustic samples would need sourcing + the same license-audit
diligence already done once for this project; offline synthesis (real
kick/snare/hihat/crash DSP recipes — pitched sine sweep + transient for
the kick, tone+filtered noise for the snare, the classic 6-oscillator
metallic-ring technique for hihat/crash) gets a genuinely usable kit with
zero licensing exposure, at the architecture level this doc's option B
described (pre-rendered one-shots, fetched and `decodeAudioData`-decoded,
no live oscillator scripting per hit). Swapping in real acoustic samples
later is a drop-in replacement of the files in `static/drums/` — no code
changes needed. Ships 4 one-shots (kick, snare, closed hi-hat, crash), not
5 — none of the 6 v1 patterns use an open hi-hat, so that file was left
unshipped rather than included unused; add it back if a future pattern
needs it.

**Retuned once already:** the first snare render was reported "too
fizzy" — its noise band was 1800–9500Hz decaying over 90ms, too wide/
high and too slow to read as a tight rock crack. Retuned to a
2500–6000Hz band decaying over 45ms, plus a 2ms broadband click at the
onset and a harder drive stage, confirmed as an improvement by ear.

## 1. What this is

A practice companion that sits next to the existing Metronome in Play
Along's Riff Capture card: instead of a plain click, it plays a looping
rock drum groove at a BPM you set. Same philosophy as the Metronome
(`playalong.js`'s `Metro` object) — deliberately **not** tied to
whatever backing track is loaded, just a tempo and a beat pattern you
pick, for practising rhythm/riffs on their own or warming up. It is
**not**:

- a song-following auto-drummer (no beat-grid sync to the loaded
  track's detected tempo — that's the separate `#click-toggle` feature
  already in the toolbar, a different thing from the standalone
  Metronome this sits beside),
- a full DAW-style step sequencer (no per-user pattern editing in v1),
- a multi-genre kit library (rock only, per the request).

## 2. Parameters (v1 scope)

| Parameter | Range / options | Notes |
|---|---|---|
| **BPM** | 1–300 | Recommend **sharing** `Metro.bpm`/the existing `#metro-bpm` slider rather than a second independent BPM control — see §6 |
| **Beat pattern** | One of the standard rock patterns in §3 | Dropdown, same idiom as `#metro-subdiv` |
| **Start / Stop** | toggle | Same idiom as `#metro-toggle-btn` |
| **Volume** | 0–200%, 100% = default level | Same idiom as `#metro-volume` |

Explicitly **not** v1 parameters (candidates for later): swing/humanize
amount, fill-every-N-bars, multiple kits (metal/punk/jazz), per-song
tempo sync, exporting the pattern as MIDI.

## 3. Standard rock beat pattern library

Each pattern is a 1-bar (or 2-bar, noted) grid of 16th-note steps
(0-indexed, 16 steps = 1 bar of 4/4). `X` = hit, `x` = ghost/softer hit,
blank = nothing. This is deliberately small (6 patterns) — enough
range to feel like "a range of standard rock beats," not an attempt at
completeness.

```
1. Basic Rock (straight 8ths)
Steps:           0   1   2   3   4   5   6   7   8   9   10  11  12  13  14  15
Hi-hat (closed)  X       X       X       X       X       X       X       X
Snare                            X                               X
Kick             X                       X       X

2. Basic Rock (driving, extra kick before the bar)
Steps:           0   1   2   3   4   5   6   7   8   9   10  11  12  13  14  15
Hi-hat (closed)  X       X       X       X       X       X       X       X
Snare                            X                               X
Kick             X                       X       X                       X

3. Four-on-the-floor Rock
Steps:           0   1   2   3   4   5   6   7   8   9   10  11  12  13  14  15
Hi-hat (closed)  X       X       X       X       X       X       X       X
Snare                            X                               X
Kick             X               X               X               X

4. Rock Ballad (half-time feel)
Steps:           0   1   2   3   4   5   6   7   8   9   10  11  12  13  14  15
Hi-hat (closed)  X       X       X       X       X       X       X       X
Snare                                            X
Kick             X                       X

5. Punk / Fast Rock (16th-note hi-hat)
Steps:           0   1   2   3   4   5   6   7   8   9   10  11  12  13  14  15
Hi-hat (closed)  X   X   X   X   X   X   X   X   X   X   X   X   X   X   X   X
Snare                            X                               X
Kick             X                       X       X

6. Rock Shuffle (triplet feel, 12 steps/bar — not 16)
Steps:           0   1   2   3   4   5   6   7   8   9   10  11
Hi-hat (closed)  X       X   X       X   X       X   X       X
Snare                        X                       X
Kick             X                       X
```

Every pattern also gets a **crash** on step 0 of the first bar only
when the pattern (re)starts from Stop — a real drummer doesn't crash
on every single loop repeat, and constant crashing on every bar would
be fatiguing in a practice tool meant to loop indefinitely.

Patterns 1–5 repeat every 1 bar; pattern 6 (shuffle) needs 12
subdivisions per bar instead of 16 since it's a triplet feel — the
scheduler (§5) needs to support a per-pattern step count, not assume
16 universally.

## 4. Sound engine — synthesized vs. sampled

The rest of this app deliberately ships **zero bundled audio assets**
— the Metronome's click is a synthesized oscillator+envelope
(`metroScheduleClick`), and the reverb impulse is generated at runtime
from filtered noise (`paMakeReverbImpulse`), not a recorded IR file.
Two ways to build the kit:

| Option | Quality ceiling | Cost |
|---|---|---|
| **A. Fully synthesized** (oscillators + filtered noise, same idiom as the Metronome click) | Decent/plausible for a practice tool, not studio-real — a synthesized snare/hihat is recognizably "electronic" next to a sampled kit | Zero assets to ship, zero licensing diligence (same clean-room posture as everything else in this app), trivial to add a 7th/8th pattern later |
| **B. Sampled** (real one-shot kick/snare/hihat/crash WAVs) | Genuinely "decent sounding" in the way the request asks for | Breaks the app's no-bundled-assets pattern; needs sourced royalty-free samples plus the same license-audit diligence already done once for this project (see the completed "License audit for free distribution + donation link" item) before anything ships; adds a `static/drums/` asset directory and a fetch+decode step (`decodeAudioData`), mirroring how NAM/IR files are already loaded from disk elsewhere in this app |

**Recommendation: B for the kit itself, A as the fallback/bootstrap.**
The Metronome's click gets away with synthesis because it's
deliberately *not* trying to sound like a real instrument — it's a
reference tick. A drum machine explicitly asked to sound like "a
decent rock kit" is a different bar, and synthesized snare/hihat in
particular tend to read as cheap/electronic no matter how much
filter/envelope tuning goes into them. A small set of real one-shot
samples (kick, snare, closed hihat, open hihat, crash — 5 short WAV/OGG
files, sourced from a clearly-licensed free pack, e.g. CC0) gets a
genuinely "decent" kit for very little asset weight (one-shots are tiny
— a few hundred KB total), at the cost of doing the license paperwork
once. Build A first as a working placeholder/fallback (fast, zero
dependencies) if sample sourcing takes longer than the rest of the
feature.

Either way, hits are one-shot samples/synth voices triggered per step
— no velocity layers or round-robin variation in v1.

## 5. Scheduling architecture

Reuse the Metronome's existing look-ahead scheduler pattern instead of
inventing a second one — `playalong.js` already has exactly this
problem solved (`metroTick`/`METRO_LOOKAHEAD_SEC`/`METRO_TIMER_MS`):
scheduling ahead on the audio clock rather than firing from
`setInterval` directly avoids main-thread jitter and background-tab
timer throttling.

Generalization needed: Metro schedules one evenly-spaced click;
Drums needs to walk a **pattern grid** (array of steps, each step a set
of instruments to trigger) and loop back to step 0 at the end.

```
DrumMachine = {
  on: false, bpm: 100, patternId: "basic1",
  volume: 1, gain: null, timer: null,
  nextTime: 0, stepIndex: 0, barCount: 0,
}

function drumStepInterval() {
  const stepsPerBar = DRUM_PATTERNS[DrumMachine.patternId].stepsPerBar; // 16 or 12
  return (60 / DrumMachine.bpm) * (4 / stepsPerBar);
  // 16 steps/bar => 16th notes; 12 steps/bar => 8th-note triplets
}

function drumTick() {
  if (!DrumMachine.on) return;
  const pattern = DRUM_PATTERNS[DrumMachine.patternId];
  while (DrumMachine.nextTime < Audio.ctx.currentTime + METRO_LOOKAHEAD_SEC) {
    const hits = pattern.steps[DrumMachine.stepIndex]; // e.g. ["kick","hihatClosed"]
    for (const inst of hits) drumScheduleHit(inst, DrumMachine.nextTime);
    if (DrumMachine.stepIndex === 0 && DrumMachine.barCount === 0) drumScheduleHit("crash", DrumMachine.nextTime);
    DrumMachine.nextTime += drumStepInterval();
    DrumMachine.stepIndex = (DrumMachine.stepIndex + 1) % pattern.steps.length;
    if (DrumMachine.stepIndex === 0) DrumMachine.barCount++;
  }
}
```

`drumScheduleHit` plays the pre-decoded sample buffer for that
instrument (or, under option A, runs the equivalent synth voice) through
a per-instrument gain into `DrumMachine.gain`, same "straight to
speakers, not through the rig" routing the Metronome already uses (see
§6) — one shared `AudioBufferSourceNode` start per hit, no manual
envelope needed for sampled one-shots (only the synthesized fallback
needs the exponential-ramp envelope trick `metroScheduleClick` uses).

## 6. Integration decisions

- **Shares the BPM control with the Metronome, doesn't duplicate it.**
  A second independent BPM slider two inches from the first would be
  confusing and the two are never meaningfully different tempos in
  practice. Recommend restyling the existing Metronome section as a
  **mode switch** — "Click" vs. "Drum kit" — with the shared BPM
  slider/tap-tempo/±buttons above a mode-specific control row below
  (subdivision+accent dropdowns for Click; pattern dropdown for Drum
  kit). Only one of Click/Drums plays at a time; switching modes while
  running should carry the transport state over (still playing,
  same BPM) rather than requiring a stop/restart.
- **Routing:** same as `Metro.gain` — connects straight to
  `Audio.ctx.destination`, not through the pedal chain, and (this is
  worth a deliberate decision, not a default) the same "not in Riff
  Capture" exclusion the plain click already gets. Open question: does
  a drum *groove* belong in a saved riff the way a click doesn't? A
  plain click is genuinely not part of "the take" — arguably a rock
  beat you were jamming along to is more a part of what you'd want to
  remember about that riff. Recommend making this a checkbox default
  in the Drums section, defaulting to **excluded** (consistent with
  existing behavior) rather than silently changing what Riff Capture
  already does.
- **Placement:** same Riff Capture card, immediately below the
  (now mode-switched) Metronome section — no new top-level card needed.

## 7. Out of scope for v1 (explicitly)

- Fills / bar-end variations
- Swing/humanize amount beyond the one built-in shuffle pattern
- Multiple kits or genres beyond rock
- Per-song tempo sync (that's `#click-toggle`'s job, a different
  feature already in the app)
- User-editable/custom patterns (step editor)
- MIDI export of the pattern

## 8. Effort estimate

Small-to-medium. The scheduler is a close variant of code that already
exists and works (`Metro`); the real work is (a) sourcing/licensing 5
one-shot samples if going with option B in §4, and (b) the mode-switch
UI restyle in §6. No server-side work at all — this is 100%
client-side WebAudio, same as the Metronome.
