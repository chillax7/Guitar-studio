# Measured Round-Trip Latency — Design Spec (GP-13)

**Status:** design spec (release-v6-spec.md §3's V6-B1). Small, S-sized,
no gate — ready to build directly.

**One-line pitch:** Tone Lab's existing latency figure
(`paShowLatencyEstimate`) only ever reports the browser's own
OUTPUT-side buffering — it has no way to see the input side (USB/driver/
interface buffering), which for an external audio interface is usually
the *larger* share of real round-trip latency. This adds an actual
measurement: play a short click out, capture it back in, cross-correlate
for the true delay.

---

## 1. What exists today, and exactly what's changing

`paShowLatencyEstimate` (playalong.js) computes
`(Audio.ctx.baseLatency + Audio.ctx.outputLatency) * 1000` and displays
it with an honest caveat ("excludes input/USB/driver latency entirely").
That caveat stays true and stays in the UI — this doesn't replace the
estimate, it adds a second, real number next to it, computed on demand
(a **Measure** button) rather than continuously.

**What's changing:** a new **Measure round-trip latency** button in the
Input card (next to `pa-calibrate-btn`, same setup-disclosure area),
next to the existing estimate text. Clicking it plays a short test
click through the current output and listens for it on the current
input, requiring a physical loop (interface's direct-out → interface's
own input, or its hardware direct-monitor path) — the UI must say this
explicitly before running, since measuring the acoustic path through the
room instead (speaker → mic) would report a wildly larger, meaningless
number and look like a real result.

## 2. Measurement method

A short (~5ms), sharp transient — a single-sample impulse or a brief
windowed click, not a sine burst (a sine's zero-crossings make onset
timing ambiguous; a sharp transient's autocorrelation peak is
unambiguous) — played through `Audio.ctx.destination` (or the currently
selected sink, same device `paRefreshOutputDevices`/`setSinkId` already
target). Simultaneously, `PA.inAnal` (the existing input analyser,
already wired via `paEnableInput`'s `PA.source.connect(PA.inAnal)`) is
sampled continuously into a rolling buffer for a fixed capture window
(e.g. 1 second — generous enough for a slow interface's buffer chain,
short enough to keep the UI responsive).

**Detection:** cross-correlate the captured buffer against the known
click waveform (or, simpler and sufficient at this precision: find the
first sample in the capture whose absolute amplitude crosses a fixed
threshold well above the interface's noise floor — the same "first
transient above threshold" idea `paCalibrate`'s own peak-detection
already uses, just timing-based here instead of level-based). The
elapsed time between "click was scheduled to play" (an
`AudioContext.currentTime` timestamp captured right before
`source.start()`) and "the transient was detected in the capture" is the
measured round-trip latency.

**Precondition check, not just a caveat:** before measuring, confirm
input is actually enabled (`paEnableInput` has run) — if not, the button
should be disabled with a tooltip explaining why (same pattern the
Click toggle already uses when there's no beat grid, USER-MANUAL.md
§3.7), not silently fail or measure silence.

## 3. Result display

Next to the existing estimate text:

```
Measured round-trip latency: ~34ms (interface looped: direct-out → direct-in)
```

If no transient was detected within the capture window (loop not
actually connected, or output routed somewhere the input can't hear —
a real, expected failure mode, not a bug): "No loopback detected — make
sure your interface's output is physically connected to its input (or
its direct-monitor path is engaged), then try again," not a confusing
zero or a crash.

**One honesty note the UI keeps saying, every time:** this number
requires a deliberate physical loop and describes *that* path, not
necessarily identical to guitar-in-through-effects-out (a real NAM/pedal
chain adds its own, separate, per-block processing latency on top —
already covered by the existing `paShowLatencyEstimate` output-buffering
caveat and NAM's own §4.9 performance notes) — it answers "how fast is
my interface + OS + browser," not "how fast do I hear my own playing,"
and should say so rather than imply the two are the same number.

## 4. What this doesn't do

No continuous/background monitoring (measure-on-demand only, same as
Calibrate) — a live loopback ping running constantly would itself add
CPU load and isn't what a player checking their setup once actually
wants. No attempt to measure NAM/pedal-chain processing latency
specifically (that's a separate, harder problem — this only isolates
the audio I/O path).
