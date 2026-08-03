# Assessment: "Track A" (no-trained-model) lead/rhythm separation, against this project

A user-supplied spec (`guitarleadrhythmseparationspec.md`) proposes a full
classical-DSP pipeline for rhythm/lead guitar separation — no trained
model, built on structural cues (repetition, polyphony, harmonic
tracking) rather than timbre or panning. This assesses it against what
`backing_track.py`'s `split-guitar` command already ships (see
`guitar-separation-upgrade-spec.md`'s options table: spectral, midside,
hybrid, coherent) and recommends what's actually worth building here,
as a feature in this app — not adopting the spec's standalone
`guitar-split/` package wholesale.

## 1. The headline finding: most of Track A is either already shipped, or one librosa call away

| Spec stage | What it wants | What this project already has |
|---|---|---|
| 1.3 Test set | Synthetic ground-truth mixtures + `museval` harness | **Not built, and I'd recommend not building it** — see §4 |
| 2.1 Beat/downbeat tracking | `madmom` or `librosa.beat` | **Already have it** — BT-02's beat grid, cached per-track analysis (`ensure_analysis(out_dir)["beats"]`), already consumed by `hybrid_pan_split` |
| 2.1 Self-similarity / repetition period | Custom or `nussl` | **`librosa.decompose.nn_filter(aggregate=np.median)`** — librosa's own docstring cites this exact call as reproducing **REPET-SIM** (Rafii & Pardo 2012), the spec's own pick as the best-performing repetition method ("expect this to outperform vanilla REPET on real material"). Already a project dependency, zero new packages. |
| 2.1 Multipitch / polyphony scalar | `basic-pitch` (TensorFlow) | **Approximable from the existing chord-detection chroma pipeline** (`_compute_chord_chroma`) — count of chroma bins above a threshold in a beat window is a cheap, dependency-free polyphony proxy. Less precise than a real multipitch model, but avoids pulling in TensorFlow for an occasional-use feature. |
| 2.1 Predominant f0 + confidence | `basic-pitch` | **`librosa.pyin`** — already used elsewhere in this project (tab transcription, the lead/rhythm split diagnostic scripts from the coherent-subtract work) |
| 2.3 Harmonic mask for lead | Custom, f0-informed | Buildable directly on the `pyin` track already in use — no new dependency |
| 2.4 Mask floor, temporal smoothing, gain cap | Custom | **Already built and shipping** — `coherent_subtract`'s regularization epsilon, window-smoothed complex gain, and gain-magnitude cap are exactly this, arrived at independently during the coherent-split work and confirmed by real listening tests |
| 2.4 "Critical" resynthesis: estimate one part well, get the other by complex-domain subtraction, not masking | Custom | **Already built and shipping** — this is precisely what `coherent_subtract` does (`residual = target_stft - gain * ref_stft`). The spec calls this "the difference between usable and unusable output"; we found the same thing the hard way (two magnitude-masking attempts rejected by ear — "still full of lead bleed" / "near-silent squeaks" — before landing on complex-domain subtraction). Independent convergence on the same fix is a good sign the spec's diagnosis is right. |
| 2.4 Multichannel Wiener (`norbert`) | New dependency | **Skip.** `coherent_subtract`'s hand-rolled local complex Wiener-style gain already does this job; norbert would be a second implementation of a problem we've already solved and validated. |
| 2.2 REPET / REPET-SIM / 2DFT / KAM ensemble (`nussl`) | New, fairly heavy dependency | **Skip nussl entirely.** REPET-SIM (the spec's own favorite) is one `librosa` call; 2DFT/KAM add real complexity for a marginal, untested gain over REPET-SIM on this material. |
| Beat tracking via `madmom` | New dependency, spec's own text flags it as having "historically awkward dependency trees" | **Skip** — already have a working beat grid via librosa/onset fallback (BT-02) |

Net: the only genuinely new capability worth building is **repetition-based
reference extraction** — everything else in Track A that's actually
valuable is either already shipped or trivially reachable with
dependencies this project already has.

## 2. Why repetition-based reference extraction is the one real gap

All four existing `split-guitar` methods (spectral, midside, hybrid,
coherent) share one hard dependency: **they all need the lead and rhythm
to be panned differently.** `spectral_pan_split`'s per-bin centeredness,
and `coherent_pan_split`'s reference (which is itself built from
`spectral_pan_split`), both collapse to nothing useful on a genuinely
mono guitar stem, or one where rhythm and lead sit at the same stereo
position. That's a real, structural blind spot — and it's exactly the
case Track A's repetition cue doesn't care about at all: a repeating
rhythm part is detectable from *when the same spectral content recurs*,
regardless of where it sits in the stereo field.

This means a repetition-based method is genuinely **complementary**, not
a fifth variation on the same trick — it's the one approach in this
whole family that still has something to work with when panning gives
nothing.

## 3. Recommended concrete build (reusing what already ships)

1. **`repetition_reference(mono, sr)`** (new, small): magnitude STFT →
   `librosa.segment.recurrence_matrix` (cosine similarity over
   chroma-aligned frames) → `librosa.decompose.nn_filter(aggregate=np.median)`
   to get a denoised "repeating content" magnitude estimate → resynthesize
   to a time-domain reference signal using the mixture's own phase (the
   standard cheap resynthesis librosa's own REPET-SIM example uses).
   This *is* an estimate of the **rhythm** part, structurally — the
   opposite orientation from the panning methods, which all estimate
   the **lead**/center part first.

2. **Reuse `coherent_subtract` unchanged** as the residual step: feed it
   `coherent_subtract(left_or_right, repetition_reference, sr)` to get
   **lead = mix − rhythm** by complex-domain subtraction — this is the
   exact function already shipping for the opposite-orientation
   `coherent` method, applied to a different reference signal. No new
   masking/refinement code needed at all.

3. Wire as a fifth `split-guitar --method repetition`, alongside the
   existing four, in `backing_track.py` / `server.py` / the Mixer's
   split panel — same plumbing pattern already used for `coherent`.

4. **Naming note:** this method's natural outputs are "rhythm" (the
   repetition estimate itself) and "lead" (the residual) — the reverse
   of `center`/`sides`' informal "probably lead / probably rhythm"
   framing. Worth deciding whether to keep the generic `_center`/`_sides`
   file-naming convention (so it drops into the same mixer/export
   plumbing) or give this one method its own `_rhythm`/`_lead` output
   names, since here the identity of which output is which is actually
   known by construction rather than a coin-flip the user has to solo
   and judge.

## 4. What I'd deliberately NOT build

- **The synthetic ground-truth test set + `museval` harness (spec §1.3,
  §2.5).** Good practice for a standalone research project; disproportionate
  for a single feature in a personal practice app. Every method shipped so
  far in this app (`hybrid`, `coherent`) was validated the same way we'd
  validate this: render against a real user-uploaded stem, check a
  handful of stable notes at multiple points across the track, check an
  RMS-floor safety margin, and — the step that actually caught both of
  coherent's failed candidates — listen to the real result. That approach
  has a track record here; a synthetic-mixture harness does not yet.
- **`nussl`, `norbert`, `basic-pitch`, `madmom`.** All four are either
  redundant with code already shipping (`norbert`, `nussl`'s REPET
  family) or heavy/fragile for a marginal, unproven gain (`basic-pitch`
  pulls in TensorFlow; `madmom`'s install pain is called out by the
  spec's own authors).
- **Polyphony/harmonic gating as a full fused system (spec's Stage C).**
  Worth prototyping only if the repetition method's real-world failures
  turn out to be the specific kind it's meant to fix (misattributing a
  repeated lead lick to rhythm) — build it in response to an observed
  failure, not speculatively.

## 5. Honest limitation to set expectations on

Repetition-based separation only works when the rhythm part actually
repeats on a bar/section-length cycle — most rock rhythm playing, but
not all of it. It will misattribute a lead lick that repeats every
chorus, and it will have nothing to grab onto on a through-composed
part with no repeating structure. This is the same honest caveat the
spec itself gives Track A as a whole, and it applies here at the scale
of one method, not the whole pipeline.
