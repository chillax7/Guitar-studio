# Neural Engine Audit — "artificial / fizzy / harsh" (GP-16)

**Status:** research + audit, done at the user's request after they raised
doubts about NAM tone quality — not sure if it's a bad model choice, an
engine bug, or a missing/wrong Cab IR. Conclusion up front: **the engine
itself checks out** (see §1) — the fizz is almost certainly the classic
"amp-only capture with no cab IR" problem every NAM/Kemper/Helix user hits
at some point, which is exactly the user's own third guess. §2 gives a
concrete Marshall/Free-style capture + IR combo to test against a Helix
pass-through. §3 covers the one real, unavoidable trade-off (no
oversampling) worth understanding even though it isn't being changed.

---

## 1. Engine audit — what was checked, and why it's very unlikely to be the cause

`nam-processor.js` is a from-scratch reimplementation of the standard
(non-A2) WaveNet architecture, reverse-engineered directly from the
official `sdatkinson/NeuralAmpModelerCore` C++ source (see the file's own
header comment) — not guessed. Specifically verified during this audit:

- **Weight layout/topology**: the file's own header notes this was checked
  against a real downloaded model (TONE3000's `deluxe.nam`) by hand-
  computing the expected weight count from the layer config and confirming
  it matches the file's actual weight array length exactly. That's a
  meaningful structural correctness check, not just "it runs."
- **Activation function**: `fastTanh` is the same rational Padé
  approximation (`x*(27+x²)/(27+9x²)`) the reference C++ itself uses for
  speed, ~5e-3 max error near the clamp boundary — inaudible for an amp
  nonlinearity, and not a plausible source of audible harshness.
- **Output gain convention**: `outputGainDb = -18 - metadata.loudness`
  matches the reference wrapper's own LUFS-ish normalization convention
  (already documented in the code), so different captures land at
  comparable perceived loudness rather than wildly different levels.
- **Cab IR volume bug**: already found and fixed in this same work session
  (`ConvolverNode`'s default auto-normalize was cutting overall volume
  significantly — see the "IR section... cuts the total volume" fix
  earlier in this conversation). If you were testing right after that fix
  landed, that specific problem is gone; if a session's tab was open
  before the fix deployed, a hard reload picks it up.
- **Sample-rate handling**: confirmed the app does **not** resample the
  model or re-derive its dilation timing from a stored sample rate — but
  also confirmed (via the official `neural-amp-modeler` Python export
  code) that **the standard `.nam` file format has no sample-rate field at
  all**. This isn't a gap specific to our engine; every real-time NAM
  implementation (including the official plugin) runs a capture natively
  at whatever the host's sample rate happens to be, with no correction.
  Worth knowing as a genuine (if rare in practice, since most rigs run
  48kHz) limitation of the format itself, not something fixable on our end
  without inventing a convention the ecosystem doesn't use.

Nothing here points at an engine bug well-suited to explain "artificial /
fizzy / harsh" specifically — that description matches a very different,
much more common cause, covered next.

## 2. The far more likely cause: missing (or mismatched) Cab IR

Straight from current NAM-community consensus (TONE3000's own published
guide, checked during this audit): *"If you're using a NAM capture of just
an Amp Head, you'll need to pair it with an IR to add the speaker
cabinet — without an IR your tone will sound thin and harsh... a raw amp
signal without a speaker cabinet sounds like a swarm of angry, fizzy
bees."* A real 12" guitar speaker rolls off hard above roughly 5-6kHz; an
amp-only capture retains the full unfiltered spectrum above that, which is
most of what reads as "fizzy" or "artificial" rather than "like an amp."

The overwhelming majority of public captures (TONE3000/ToneHunt included)
are deliberately amp-only, precisely so you can pair any cab IR you want —
captures that already include the cab are usually labeled "full rig" or
"combo." **Check the Cab IR card first**: if it's bypassed (its default
state, and it stays that way until you actually load an IR) and the loaded
capture is an amp-only one, that alone explains the complaint, independent
of which capture you picked or how the engine renders it. USER-MANUAL.md
§4.4 now says this explicitly (this audit's one shipped doc change).

## 3. A candidate tone to test: sweet overdriven Marshall, Free/Kossoff-style

Kossoff's actual tone (per Marshall-forum accounts from owners of his amps,
checked during this research) was less about EQ and more about a
**non-master-volume 100W Marshall driven loud enough for natural power-amp
and speaker breakup** — moderate gain, not high-gain, mids/bass forward
rather than scooped. He used Super Bass/Super Lead heads (both JTM45-
lineage/Plexi-era circuits) into 4x12s. A concrete recipe to try:

- **Capture**: search TONE3000 (tone3000.com, formerly ToneHunt) for
  **"Marshall JTM45"**, **"Marshall Plexi"**, or **"Super Lead"** — pick an
  **amp-only** capture (not "full rig"/"combo"), ideally one with a normal
  gain-stage range rather than a high-gain variant. TONE3000 also has a
  published roundup ("5 Iconic Marshall Amps: Free NAM Profiles and IRs")
  worth checking directly for a curated starting point.
- **Cab IR**: a 4x12 loaded with **Celestion G12M Greenbacks** (the classic
  Marshall 1960-cab speaker, and the closest widely-available public IR to
  what Kossoff actually played through). Two free, well-regarded packs to
  grab: **Redwirez's free Marshall 1960 IR pack** (a real Marshall 1960A
  cab, 4 mic options including SM57) and the **Aegean Music 200+ free
  Marshall 4x12 pack**. Either gives you several mic-position variants to
  A/B — an SM57-near-the-cone-edge position is the classic "British crunch"
  starting point.
- **Gain staging**: keep **Drive near 0dB** initially (the model's own
  captured gain is the starting point, not something to push further) and
  raise **Output level** to taste rather than cranking Drive — matches
  Kossoff's own "volume, not knob-twiddling" tone philosophy, and avoids
  pushing the model into distortion character it wasn't trained on
  (a plausible secondary contributor to "artificial"-sounding results if
  Drive had been pushed up to compensate for something else, like a
  missing cab making the tone feel thin).
- **A/B against the Helix pass-through**: save each as its own Rig Preset
  (§4.3) so you can A/B instantly via the per-song preset chain (GP-14) or
  Tone Lab's dropdown, rather than re-dialing knobs each time.

## 4. Known, unaddressed trade-off: no oversampling

Community research (checked during this audit) confirms standard
(non-A2) WaveNet NAM models are documented to produce more aliasing/
ringing artifacts than the newer A2 architecture, and that the *official*
ecosystem's answer is a **separate oversampling plugin** (e.g.
`NAM-Oversampler`) layered on top of the stock NAM plugin — meaning the
stock plugin itself, like this engine, does **not** oversample by default.
So the lack of oversampling here matches parity with the reference
implementation, not a regression from it.

Implementing oversampling ourselves would roughly double-to-quadruple the
per-sample compute cost of an already CPU-tight hot path — the code's own
comments note standard-architecture captures measured 1.4-1.5x *slower*
than real-time with `Math.tanh` before the fast rational approximation
brought it back under budget. Adding 2x/4x oversampling in plain JS would
very likely blow that budget on typical hardware without a much larger
rework (WASM/SIMD), so this is flagged as a known, real limitation rather
than something attempted in this pass. Worth revisiting if a future
architecture change (A2 support, or a WASM inference path) is ever
undertaken for other reasons.

## 5. Non-goals / not done here

- **A2/parametric model support.** Explicitly out of scope for the
  existing engine (see nam-processor.js's own header) — a real WaveNet-
  architecture change, not a tweak.
- **Oversampling implementation** — see §4; a real engine change with a
  real performance risk, not attempted speculatively.
- **Reading/honoring `input_level_dbu`/`output_level_dbu`** (the official
  schema's dBu-referenced calibration fields, distinct from the
  `loudness` field this engine already uses) — real captures overwhelmingly
  don't populate these either in practice; revisit only if it turns out to
  matter for specific real captures the user tries.
