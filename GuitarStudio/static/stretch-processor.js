"use strict";

// Phase-vocoder AudioWorkletProcessor: independent Speed (pitch-preserving
// time-stretch) and Tune (pitch-shift, duration-preserving) on a fully
// in-memory stereo PCM buffer, transferred once at load time.
//
// No original implementation survived to recover this from — this is a
// fresh implementation of the standard PV-TSM (phase-vocoder time-scale
// modification) algorithm, combined with a resample stage for pitch shift:
//
//   1. Pitch shift alone (ratio `pitchRatio`) = resample the source by
//      `pitchRatio` (changes pitch AND duration together, like changing
//      turntable speed), then phase-vocoder time-stretch the result back
//      to the original duration (pitch-preserving) — net effect: pitch
//      shifted, duration unchanged.
//   2. Speed alone (ratio `speed`) = phase-vocoder time-stretch by `speed`
//      — pitch preserved, duration divided by `speed`.
//   3. Both together fold into ONE phase-vocoder pass over a virtual
//      "resampled by pitchRatio" source, with combined stretch factor
//      `speed / pitchRatio` — see readVirtualFrame() below.
//
// Quality: identity phase locking (see PVChannel) rather than the plain
// per-bin phase vocoder this started as. Still not a mastering-grade
// time-stretch, but the specific artifacts a plain PV has — "phasiness",
// level overshoot, treble dulling — are addressed rather than tolerated.
//
// Second real-user report on Speed/Tune quality ("distorted, and the volume
// cuts in and out"), investigated by running this exact worklet code
// offline over a real recording (Iron Maiden, "Phantom of the Opera") and
// measuring instead of guessing. Three separate, independent faults, all
// since fixed — recorded here because the earlier round of work on this
// file guessed at one of them and made it worse:
//
//   A. CPU, the actual cause of "volume cutting in and out". One stem was
//      measured needing 42.7% of the available real-time audio budget per
//      render quantum; six simultaneous stems (htdemucs_6s) therefore
//      needed ~256% of it. That is not a glitch, it is arithmetic: the
//      audio thread could not possibly keep up, so it dropped out. Fixed
//      by making the per-hop work far cheaper (phase locking below removes
//      almost all per-bin transcendentals), halving the number of hops
//      (see SYNTHESIS_HOP), transforming both channels in one FFT instead
//      of two (see _regenerateBlock — the FFT measured at 89% of total
//      cost), and skipping the computation entirely for muted stems (see
//      `active`). Measured after: 9.8% per stem, ~59% for six audible
//      stems — and a muted stem now costs ~1% of an active one, so a
//      typical "mute the guitar and play along" session sits far below
//      even that.
//   B. Level overshoot, the actual cause of "distorted". A steady 0.9
//      sine came out at 1.18 (+31%) when time-stretching, which then hit
//      the soft limiter — so the limiter, meant as a rare safety net, was
//      actually engaging constantly and distorting every loud passage. A
//      plain PV overlap-adds phase-incoherent frames, so the reconstruction
//      simply does not land on the COLA gain it is divided by. Phase
//      locking fixes this at the source: same test now reads 0.900.
//   C. Treble dulling. The resampler used 2-point linear interpolation,
//      measured at -1.9dB down at 15kHz — audible on cymbals and pick
//      attack, and exactly the "quality gets significantly worse" part of
//      the report that neither A nor B explains. Now 4-point cubic
//      (-0.67dB at 15kHz) for two extra multiply-adds per sample.
//
// S-4: third real-user report of crackle, this time specifically "slowed to
// 0.85/0.9, mostly on the vocal and drum stems, a bit on the other". Fault A
// had come back. The offline output was measured first and exonerated —
// against the same real stems this file is tuned on, the algorithm at 0.85x
// scored level with ffmpeg's atempo on added-HF-noise and transient-burst
// counts, and at unity speed it reconstructs the source to 136dB, i.e. it is
// exactly transparent when it should be. So the artifact was never in the
// arithmetic; it was that the arithmetic could not finish in time. Measured
// per stem on the same machine, one full second of output:
//
//     before S-4   28.3%  of real time per stem   ->  six stems need 170%
//     after  S-4    8.9%                          ->  six stems need  54%
//
// Which is worth recording, because the intuitive suspects were both wrong:
//
//   * The 12-tap Lanczos kernel S-2 introduced looked like the obvious
//     regression, and it was not — cutting it to 2 taps saved 1.3 points out
//     of 28. What cost 45% of the whole worklet was the per-sample OVERHEAD
//     around those taps, chiefly two bounds branches per tap (24 per output
//     sample) guarding against an edge condition that can only occur within
//     a kernel's reach of the ends of the song. See _fillAnalysisFrame.
//   * The FFT was documented at 89% of total cost, so it looked like the only
//     thing worth attacking. Its own inner loop turned out to be carrying two
//     float modulos per butterfly that were never needed at all (FFT
//     ._transform) — 15% of the total for a two-line change.
//
// Everything in S-4 is a pure speed change: output was compared against the
// previous implementation across speeds 0.85/0.9/1.0, pitch ratios
// 0.94/1.0/1.06, and both buffer edges, and agrees to at least 113dB SNR
// (float reassociation only — no path differs by more than 4e-4).
//
// The lesson for the next person here: a quality complaint about this file
// is a CPU complaint until measured otherwise, and the measurement is
// scripts/pv_bench.js, not intuition about which line looks expensive.

const FFT_SIZE = 2048;
// 4x overlap. This was moved to 8x (hop 256) in an earlier attempt at the
// roughness complaint, on the reasoning that finer time resolution is "the
// standard first lever" for phase-vocoder artifacts. That was treating a
// symptom: the roughness came from phases drifting apart WITHIN each frame's
// spectrum, which a smaller hop only partly masks and never fixes, at double
// the CPU cost — cost which, per fault A above, was itself a major part of
// what the user was actually hearing. With identity phase locking addressing
// the cause directly, the extra overlap no longer buys anything measurable
// (verified: overshoot, frequency response and envelope ripple are all
// equivalent at both hops), so this goes back to the conventional 4x and
// halves the work.
const SYNTHESIS_HOP = 512;
// Samples of output regenerated per synthesis pass. Deliberately equal to
// SYNTHESIS_HOP (i.e. exactly one phase-vocoder hop per regeneration) —
// with up to 6 simultaneous stems (htdemucs_6s), each running its own
// worklet instance, a larger block size (originally 8192 = 16 hops) meant
// every stem burst through 16 hops' worth of FFT work synchronously at
// the same synchronized moment roughly every 170ms, well over 100 FFTs
// total in a single ~128-sample audio callback — enough to blow the
// real-time budget and cause audible dropouts ("volume cutting in and
// out") independent of the overlap-add correctness fix above. One hop at
// a time spreads that same total work evenly across many small callbacks
// instead of bursting it into one.
const BLOCK_SIZE = SYNTHESIS_HOP;
const TWO_PI = Math.PI * 2;

// S-3: onset (transient) detection for phase reset. Identity phase locking
// (PVChannel) rotates every frame's spectrum to match the previous frame's
// phase trajectory — correct for a sustained tone, but a pick attack is
// exactly the opposite: a burst of energy across many bins with NO
// relationship to what came before. Locking it to the previous frame's phase
// smears the attack the same way it would smooth a sustained note. Measured
// impact before this fix: attack sharpness (see the review's transient
// metric) at 91.6% of source at 0.60x speed.
//
// Detector: spectral flux (sum of positive per-bin magnitude increase, the
// standard onset-detection feature — a real attack raises many bins at once,
// so it shows up as a large positive-only sum even though sustained
// harmonic content constantly wobbles bin-to-bin), NORMALISED by the
// frame's own total magnitude before being compared to anything:
//   normFlux  = flux / (this frame's total magnitude)
//   threshold = ONSET_BASE_RATIO + ONSET_MEDIAN_RATIO * median(recent normFlux)
// Comparing raw flux to the mean magnitude ACROSS ALL BINS was tried first
// and measured badly wrong: a single sustained guitar note concentrates
// nearly all its energy into a handful of bins (fundamental + a few
// harmonics), so the mean-across-1025-bins scale is tiny next to that
// peak's own picket-fence jitter — it read as a huge relative flux on
// every frame of a PURE, UNCHANGING TONE. Measured: 18% false-positive
// rate on a steady 220Hz sine that should never fire at all. Normalising
// by the frame's own total magnitude instead asks "what fraction of this
// frame's energy is new," which stays meaningful regardless of how
// concentrated the spectrum is — a steady tone's fraction stays near zero
// no matter how loud or quiet it is, while a real attack's fraction spikes
// because a burst of genuinely new energy is a large share of the frame
// whether the guitar is quiet or distorted and loud.
// ONSET_BASE_RATIO is a floor so a fully decayed history (near silence for
// a while) can't leave the bar at ~0 and trigger on ordinary bin-to-bin
// wobble. ONSET_MEDIAN_RATIO (not a mean) is what keeps a sustained loud,
// spiky passage (e.g. a fast tremolo-picked riff, where every hit floods
// the recent history with real onsets) from ratcheting the bar up so high
// that genuine softer attacks stop being caught.
//
// On a detected onset, that single frame takes the same "pass the analysis
// spectrum straight through" path already used for the first frame after a
// load/seek (PVChannel.haveState) instead of being phase-locked — the
// phase-lock machinery already exists; this only decides which frames skip
// it. Every other frame, and the running state used to reach this decision,
// is completely unaffected: a steady tone still measures the same overshoot-
// free unity gain S-2 verified, and the acceptance target below is attack
// sharpness restored to at least 98% of source at 0.60x.
const ONSET_HISTORY = 8;
// Tuned against a real recording (Iron Maiden, "Phantom of the Opera" — the
// same one faults A-C at the top of this file were diagnosed against) with a
// grid search over both constants, scored against three things at once: a
// pure steady tone's false-positive rate (must stay near zero — a sustained
// note is not a transient), attack sharpness on the real recording at 0.60x
// (target from the review: >= 98% of source), and HF-flatness (must not
// move far from the pre-S-3 baseline, which would mean onsets are firing so
// often the phase-lock's own anti-roughness benefit is being undone). These
// two values are the point in that search where sharpness first cleared the
// target: 98.5% at 0.60x, tone false-positive rate 0.87% of frames (a
// single frame, from picket-fence jitter, not a systematic misfire), and
// HF-flatness within 0.002 of the pre-S-3 number (0.55352 vs 0.55113).
const ONSET_BASE_RATIO = 0.045;
const ONSET_MEDIAN_RATIO = 1.0;

// S-2: windowed-sinc (Lanczos) resampling kernel for _readVirtual, replacing
// the previous 4-point Catmull-Rom. Catmull-Rom measured a real HF rolloff
// whenever the analysis hop is fractional (any Speed/Tune off the values
// that happen to give an integer hop) — up to -2.96dB at 17kHz — because a
// cubic polynomial is a comparatively crude reconstruction filter: it only
// matches sinc's response near DC and falls away increasingly fast as
// frequency rises. A windowed sinc is the theoretically correct band-limited
// interpolator; LANCZOS_A=6 (12 taps) comfortably clears the review's
// acceptance criteria (measured: ±0.06dB to 14kHz, ±0.03dB to 17kHz, vs the
// ±0.15dB / ±0.4dB targets — A=4/8 taps already met the 14kHz target but
// only got to -0.65dB at 17kHz) while staying cheap, because the per-tap
// weights are looked up from a precomputed table (built once here, not per
// sample) rather than evaluating sin()/cos() in the hot path.
const LANCZOS_A = 6;
const LANCZOS_TAPS = LANCZOS_A * 2;
const LANCZOS_PHASES = 1024;
function buildLanczosTable(a, phases) {
  const taps = a * 2;
  const table = new Float32Array(phases * taps);
  const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  for (let p = 0; p < phases; p++) {
    const t = p / phases; // fractional position within [i1, i1+1)
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      // Tap k samples src[i1 - (a - 1) + k]; its distance from the query
      // point (i1 + t) is t - (k - (a - 1)).
      const x = t - (k - (a - 1));
      const w = Math.abs(x) < a ? sinc(x) * sinc(x / a) : 0;
      table[p * taps + k] = w;
      sum += w;
    }
    // Windowed sinc doesn't sum to exactly 1 at every phase (Lanczos is an
    // approximation, not a partition of unity) — renormalizing removes the
    // resulting sub-0.1dB gain ripple across the fractional-position range,
    // which would otherwise show up as a very faint amplitude wobble at the
    // resampling rate.
    if (sum !== 0) for (let k = 0; k < taps; k++) table[p * taps + k] /= sum;
  }
  return table;
}
const LANCZOS_TABLE = buildLanczosTable(LANCZOS_A, LANCZOS_PHASES);

class FFT {
  constructor(size) {
    this.size = size;
    const bits = Math.log2(size);
    this.cosTable = new Float32Array(size);
    this.sinTable = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.cosTable[i] = Math.cos((TWO_PI * i) / size);
      this.sinTable[i] = Math.sin((TWO_PI * i) / size);
    }
    this.reverseTable = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i, rev = 0;
      for (let b = 0; b < bits; b++) { rev = (rev << 1) | (x & 1); x >>= 1; }
      this.reverseTable[i] = rev;
    }
  }

  // In-place forward FFT. inverse=true runs the inverse (unnormalized by
  // convention here — caller divides by size).
  _transform(re, im, inverse) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverseTable[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // S-4: the twiddle index used to be ((k * sign) % n + n) % n — two float
    // modulos in the innermost loop of the single most expensive routine in
    // this file (~11k butterflies per transform, 172 transforms/sec/stem).
    // They were never needed: k only ever reaches (size/2 - 1) * (n/size) <
    // n/2, so it is already in range, and the whole point of the sign is the
    // conjugate twiddle — cos(-x) = cos(x), sin(-x) = -sin(x). Reading the
    // table at k and negating the sine is exactly equivalent and measured
    // 15% off this worklet's total cost on its own.
    const sinSign = inverse ? 1 : -1;
    const cosTable = this.cosTable, sinTable = this.sinTable;
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const tableStep = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += tableStep) {
          const l = j + halfSize;
          const cos = cosTable[k];
          const sin = sinSign * sinTable[k];
          const tre = re[l] * cos - im[l] * sin;
          const tim = re[l] * sin + im[l] * cos;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }

  forward(re, im) { this._transform(re, im, false); }

  inverse(re, im) {
    this._transform(re, im, true);
    const n = this.size;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
  }
}

// Safety net, not a root-cause fix: real guitar/drum transients have a much
// sharper attack and higher crest factor than anything practical to
// synthesize for testing, and this is a non-phase-locked phase vocoder (see
// the file header) — occasional small overshoot right at a transient is
// plausible even with the COLA gain now correct (colaNormalization fixed a
// measured, constant ~50% overshoot; this guards against whatever's left).
// Transparent below the threshold (branch skips the tanh entirely for the
// overwhelming majority of samples — cheap), a smooth asymptotic soft-knee
// above it so any remaining overshoot compresses gently toward the rail
// instead of hard-clipping into audible crackle.
const SOFT_LIMIT_THRESHOLD = 0.95;
function softLimit(v) {
  const sign = v < 0 ? -1 : 1;
  const a = Math.abs(v);
  if (a <= SOFT_LIMIT_THRESHOLD) return v;
  const span = 1 - SOFT_LIMIT_THRESHOLD;
  return sign * (SOFT_LIMIT_THRESHOLD + span * Math.tanh((a - SOFT_LIMIT_THRESHOLD) / span));
}

// Periodic (DFT-even) Hann, denominator `size` — NOT the "symmetric"
// textbook Hann (denominator `size - 1`, what you'd want for windowing a
// standalone signal for spectral analysis). STFT overlap-add needs the
// periodic form specifically; the symmetric form doesn't tile edge-to-edge
// the same way and its constant-overlap-add sum has a small but real ripple
// (measured: ~4e-5 relative, i.e. wrong but not the source of the audible
// crackle below — see colaNormalization for that).
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / size);
  return w;
}

// The real crackle/clipping bug: every sample gets windowed TWICE — once on
// the way in (_regenerateBlock's analysis window) and once on the way out
// (PVChannel.synthesize's synthesis window) — and overlap-added at
// SYNTHESIS_HOP spacing. That's standard analysis+synthesis windowing for a
// phase vocoder, but it means the reconstructed signal's amplitude is
// scaled by whatever the WINDOW SQUARED sums to at that hop spacing, not by
// 1 — and nothing here was ever dividing that back out. At the original 4x
// overlap (2048/512) that constant was exactly 1.5: measured directly (a
// unit-amplitude 440Hz test tone through the real worklet code came back
// peaking at 1.50, not 1.0) — every processed-mode sample was ~50% too
// loud, which is more than enough headroom to clip against downstream gain
// stages once several stems are summed at the mixer, and clipping is
// exactly what "crackly, unlistenable" sounds like. (At the current 8x
// overlap, 2048/256, the constant is 3.0 instead — twice as many
// overlapping copies, same idea.) Computed from the actual window/hop (not
// hardcoded) so this stays correct if either ever changes; COLA windows
// sum to the same constant at
// every sample offset, so any one offset's sum is the answer, but summing
// every offset and taking the max is a cheap safety margin against a window
// that doesn't satisfy COLA as exactly as periodic Hann does.
function colaNormalization(window, hop) {
  const n = window.length;
  let maxSum = 0;
  for (let offset = 0; offset < hop; offset++) {
    let sum = 0;
    for (let i = offset; i < n; i += hop) sum += window[i] * window[i];
    maxSum = Math.max(maxSum, sum);
  }
  return maxSum;
}

// One phase-vocoder channel: owns its own phase-continuity state and the FFT
// scratch buffers, so stereo just means two independent instances fed from
// the two channels of the same virtual read.
//
// IDENTITY PHASE LOCKING (Laroche & Dolson 1999, "Improved phase vocoder
// time-scale modification of audio"). The previous implementation advanced
// every bin's phase INDEPENDENTLY, which is the textbook phase vocoder and
// also its textbook flaw: a single real sinusoid doesn't live in one bin, it
// smears across a small group of neighbouring bins, and those bins only sum
// back to a clean sinusoid if their phases stay in the exact relationship
// the analysis found them in. Advancing them independently lets that
// relationship drift apart, so the partial reconstructs as a smeared,
// wobbling, hollow-sounding version of itself — the classic phase-vocoder
// "phasiness" — and, because the frames no longer overlap-add coherently,
// the output level stops matching the COLA gain the reconstruction is
// divided by (measured on a steady 0.9 sine: up to 1.18 out, i.e. +31%
// overshoot, which then hit the soft limiter and distorted on every loud
// passage — a real user report of exactly that).
//
// The fix: find the spectral PEAKS, do the phase-advance work only there,
// and rotate every bin in a peak's neighbourhood by that SAME rotation.
// Bins belonging to one partial therefore keep their relative phases exactly,
// so the partial stays coherent and the overlap-add reconstructs at the
// level it should.
//
// It's also much cheaper, which matters more than it sounds: this worklet
// runs once per stem, and a 6-stem song was measured needing ~245% of the
// available real-time audio budget (i.e. hopeless — that IS the "volume
// cutting in and out"). The rotation is applied as a plain complex multiply,
// so the expensive transcendentals (atan2/cos/sin) run only at peaks — about
// 17% of bins on real music — instead of at all 1025 bins, and no per-bin
// trig is needed at all.
class PVChannel {
  constructor() {
    // Previous frame's INPUT and OUTPUT spectra. Keeping the output spectrum
    // (rather than an accumulated per-bin phase) is what lets the rotation be
    // derived without a single per-bin atan2: the previous output phase at a
    // peak is recovered by normalising its stored complex value.
    this.prevInRe = new Float32Array(FFT_SIZE / 2 + 1);
    this.prevInIm = new Float32Array(FFT_SIZE / 2 + 1);
    this.prevOutRe = new Float32Array(FFT_SIZE / 2 + 1);
    this.prevOutIm = new Float32Array(FFT_SIZE / 2 + 1);
    this.mag = new Float32Array(FFT_SIZE / 2 + 1);
    this.haveState = false;
    // S-3: previous frame's magnitudes, to compute spectral flux against —
    // kept separately from `mag` (this frame's) rather than diffing prevInRe/
    // prevInIm on the fly, since that would mean an extra sqrt pass over
    // every bin just for the flux, duplicating the one already done above.
    this.prevMag = new Float32Array(FFT_SIZE / 2 + 1);
    this.fluxHistory = new Float32Array(ONSET_HISTORY);
    this.fluxHistoryPos = 0;
    this.fluxScratch = new Float32Array(ONSET_HISTORY); // reused for the median sort
  }

  reset() {
    this.prevInRe.fill(0);
    this.prevInIm.fill(0);
    this.prevOutRe.fill(0);
    this.prevOutIm.fill(0);
    this.prevMag.fill(0);
    this.fluxHistory.fill(0);
    this.fluxHistoryPos = 0;
    this.haveState = false;
  }

  // Median of the recent flux history — see the ONSET_* constants above for
  // why this feeds an adaptive rather than fixed threshold. Sorts a small
  // (ONSET_HISTORY-element) reused scratch buffer; cheap enough to do every
  // hop without measurably affecting the S-1 CPU budget.
  _medianFlux() {
    this.fluxScratch.set(this.fluxHistory);
    this.fluxScratch.sort();
    return this.fluxScratch[ONSET_HISTORY >> 1];
  }

  // Phase-locks one channel's spectrum in place: reads the analysis bins
  // (re/im, length FFT_SIZE/2+1) and writes the synthesis bins (outRe/outIm).
  // The FFT itself lives in StretchProcessor now — both channels share one
  // transform (see _regenerateBlock), so this works on spectra rather than
  // time-domain frames. Ha: analysis hop used to reach this frame
  // (resampled-domain samples; may be fractional).
  processSpectrum(re, im, outRe, outIm, Ha) {
    const n = FFT_SIZE, bins = n / 2 + 1;
    const mag = this.mag;
    const prevInRe = this.prevInRe, prevInIm = this.prevInIm;
    const prevOutRe = this.prevOutRe, prevOutIm = this.prevOutIm;
    // Math.sqrt(a*a+b*b), not Math.hypot: hypot does overflow-safe scaling
    // that costs several times more per call and buys nothing here (these
    // magnitudes are nowhere near float range limits).
    let magSum = 0, flux = 0;
    const prevMag = this.prevMag;
    for (let k = 0; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      magSum += m;
      // Spectral flux: sum of POSITIVE magnitude change only. A sustained
      // tone's bins constantly wobble up and down bin-to-bin (summing signed
      // change would mostly cancel); an attack raises many bins at once, so
      // only counting rises is what makes an onset stand out from the noise.
      const d = m - prevMag[k];
      if (d > 0) flux += d;
    }

    // S-3: normalise flux by this frame's OWN total magnitude before
    // comparing it to anything. Raw flux compared against the mean magnitude
    // ACROSS ALL BINS was tried first and measured badly wrong: a single
    // sustained sine concentrates nearly all of its energy into a handful of
    // bins, so the mean-across-1025-bins scale is tiny relative to that
    // peak's own picket-fence jitter, which then reads as a huge relative
    // flux every frame — measured 18% false-positive rate on a pure tone
    // that should never fire at all. Normalising by the frame's total
    // magnitude instead asks "what fraction of this frame's energy is NEW,"
    // which stays meaningful regardless of how concentrated the spectrum is.
    const normFlux = flux / (magSum + 1e-9);
    const threshold = ONSET_BASE_RATIO + ONSET_MEDIAN_RATIO * this._medianFlux();
    const isOnset = this.haveState && normFlux > threshold;
    this.fluxHistory[this.fluxHistoryPos] = normFlux;
    this.fluxHistoryPos = (this.fluxHistoryPos + 1) % ONSET_HISTORY;

    if (!this.haveState || isOnset) {
      // First frame after a load/seek (nothing to advance from), OR an
      // onset frame (S-3: rotating a transient's phase to match the
      // previous frame is exactly the smearing this is meant to avoid) —
      // either way pass the spectrum through untouched and let the NEXT
      // frame lock onto it. haveState/prevIn/prevOut/prevMag below all keep
      // updating normally regardless of which branch ran, so this affects
      // only the one frame the transient landed in.
      for (let k = 0; k < bins; k++) { outRe[k] = re[k]; outIm[k] = im[k]; }
    } else {
      const stretch = SYNTHESIS_HOP / Ha;
      let peakStart = 0; // first bin of the peak currently being processed
      for (let k = 0; k < bins; k++) {
        // Standard 5-point peak test: a local maximum over +/-2 bins. A
        // partial's main lobe under a Hann window is ~4 bins wide, so this
        // finds one peak per partial rather than several per lobe.
        const isPeak = mag[k] > mag[k - 1] && mag[k] > mag[k - 2] &&
                       mag[k] > mag[k + 1] && mag[k] > mag[k + 2];
        if (!isPeak && k < bins - 1) continue;

        // Phase advance at this peak, via the cross-product X_cur*conj(X_prev):
        // its argument IS (curPhase - prevPhase), already wrapped into
        // (-pi, pi] by atan2 — so one atan2 replaces two plus an explicit wrap.
        const crossRe = re[k] * prevInRe[k] + im[k] * prevInIm[k];
        const crossIm = im[k] * prevInRe[k] - re[k] * prevInIm[k];
        const expected = (TWO_PI * k * Ha) / n;
        let deviation = Math.atan2(crossIm, crossRe) - expected;
        deviation -= TWO_PI * Math.round(deviation / TWO_PI); // wrap to [-pi, pi]
        // (expected + deviation) is the true advance across the Ha-sample
        // ANALYSIS hop. Frames are re-emitted every SYNTHESIS_HOP samples
        // regardless of Ha (that's the whole mechanism of time-stretching),
        // so rescale to "advance per SYNTHESIS_HOP samples" — without this,
        // Speed would shift pitch instead of preserving it.
        const advance = (expected + deviation) * stretch;

        // Target output phase = previous output phase at this peak + advance.
        // Build the rotation that takes the CURRENT input phase there, as a
        // complex number, so it can be applied to a whole group of bins with
        // plain multiplies and no further trig:
        //   rot = unit(prevOut) * e^{i*advance} * conj(unit(X_cur))
        const cosA = Math.cos(advance), sinA = Math.sin(advance);
        const pMag = Math.sqrt(prevOutRe[k] * prevOutRe[k] + prevOutIm[k] * prevOutIm[k]);
        const cMag = mag[k];
        let rotRe = 1, rotIm = 0;
        if (pMag > 1e-12 && cMag > 1e-12) {
          const pr = prevOutRe[k] / pMag, pi = prevOutIm[k] / pMag; // unit(prevOut)
          const cr = re[k] / cMag, ci = im[k] / cMag;               // unit(X_cur)
          // unit(prevOut) * e^{i*advance}
          const ar = pr * cosA - pi * sinA;
          const ai = pr * sinA + pi * cosA;
          // ... * conj(unit(X_cur))
          rotRe = ar * cr + ai * ci;
          rotIm = ai * cr - ar * ci;
        }

        // Region of influence: every bin from the end of the previous peak's
        // region up to the midpoint between this peak and the next one. All
        // of them get the identical rotation — that's the "locking".
        let peakEnd = bins - 1;
        if (isPeak && k < bins - 1) {
          let next = k + 1;
          while (next < bins - 2 && !(mag[next] > mag[next - 1] && mag[next] > mag[next - 2] &&
                                      mag[next] > mag[next + 1] && mag[next] > mag[next + 2])) next++;
          peakEnd = (next >= bins - 2) ? bins - 1 : ((k + next) >> 1);
        }
        for (let j = peakStart; j <= peakEnd; j++) {
          outRe[j] = re[j] * rotRe - im[j] * rotIm;
          outIm[j] = re[j] * rotIm + im[j] * rotRe;
        }
        peakStart = peakEnd + 1;
        if (peakStart >= bins) break;
      }
    }
    this.haveState = true;

    // Save this frame's spectra (and magnitudes, for the next hop's flux) for
    // the next hop's phase advance. Five typed-array copies rather than a
    // 1025-iteration JS loop doing five element writes each — same result,
    // and TypedArray.set is a memcpy (S-4).
    prevInRe.set(re); prevInIm.set(im);
    prevOutRe.set(outRe); prevOutIm.set(outIm);
    prevMag.set(mag);
  }
}

// S-1: exact equality check, used once at load time to decide whether a
// stem's L/R channels are true mono content — see the "load" handler below.
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new FFT(FFT_SIZE);
    this.window = hannWindow(FFT_SIZE);
    this.olaGain = colaNormalization(this.window, SYNTHESIS_HOP);
    this.invOlaGain = 1 / this.olaGain;
    this.channels = [new PVChannel(), new PVChannel()];
    this.mono = false; // set on "load" — see arraysEqual below
    this.silenceGap = false; // set when a hop is skipped as all-zero — see _regenerateBlock

    this.sourceChannels = null; // [Float32Array, Float32Array]
    this.sourceLength = 0;

    this.speed = 1.0;
    this.pitchRatio = 1.0;
    this.playing = false;

    // Read position in the RESAMPLED domain (see file header). Advances by
    // Ha = Hs * speed / pitchRatio each synthesis frame.
    this.readPos = 0;

    this.outBlocks = [new Float32Array(BLOCK_SIZE), new Float32Array(BLOCK_SIZE)];
    // Synthesis frames (FFT_SIZE) always overhang the BLOCK_SIZE boundary
    // since FFT_SIZE > SYNTHESIS_HOP — this scratch buffer holds a full
    // block plus the max possible overhang so that overhang can be carried
    // into the next block instead of being silently dropped (which caused
    // a periodic amplitude dip, audible as "volume cutting in and out",
    // at every block boundary — roughly every 170ms at 48kHz).
    this.extended = [new Float32Array(BLOCK_SIZE + FFT_SIZE), new Float32Array(BLOCK_SIZE + FFT_SIZE)];
    // V3-E5: preallocated once instead of `new Float32Array(FFT_SIZE)` per
    // (channel, hop) inside _regenerateBlock's loop — allocating inside the
    // audio callback is GC pressure on the real-time thread.
    this.frameScratch = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    // Shared transform buffers. Left goes in the real part and right in the
    // imaginary part of ONE complex FFT (see _regenerateBlock) rather than
    // each channel transforming separately — the FFT was measured at 89% of
    // this worklet's total cost, so halving the number of transforms is by
    // far the biggest lever available, and this packing is exact, not an
    // approximation.
    this.packRe = new Float32Array(FFT_SIZE);
    this.packIm = new Float32Array(FFT_SIZE);
    const bins = FFT_SIZE / 2 + 1;
    this.specRe = [new Float32Array(bins), new Float32Array(bins)];
    this.specIm = [new Float32Array(bins), new Float32Array(bins)];
    this.outSpecRe = [new Float32Array(bins), new Float32Array(bins)];
    this.outSpecIm = [new Float32Array(bins), new Float32Array(bins)];
    this.blockPos = BLOCK_SIZE; // force regeneration on first process()
    this.ended = false;
    this.samplesSinceReport = 0;
    // A muted (or not-soloed) stem is still summed into the graph at gain 0
    // — so before this it ran a full phase vocoder every hop purely to
    // produce audio nothing could hear. With up to 6 stems each costing a
    // real slice of the audio thread's budget, that waste was a direct
    // cause of dropouts. app.js flips this from applyMixToGains whenever a
    // stem's base gain reaches/leaves 0; see _regenerateBlock for what it
    // skips (everything expensive) and what it deliberately still does
    // (advance readPos, so unmuting stays sample-aligned with every other
    // stem instead of resuming from where it left off).
    this.active = true;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "load":
        this.sourceChannels = msg.channels;
        this.sourceLength = msg.channels[0].length;
        this.readPos = 0;
        this.blockPos = BLOCK_SIZE;
        this.ended = false;
        this.channels.forEach((c) => c.reset());
        this.extended.forEach((e) => e.fill(0));
        // S-1: many source-separation stems (bass, vocals, some "other"
        // splits) are mono content stored as identical-stereo. When L and R
        // are sample-for-sample equal, the packed spectra this loop derives
        // for them (see _regenerateBlock's unpack step) come out equal too,
        // so the right channel's identity-phase-locking pass (the expensive
        // half of this file's per-hop cost) always reproduces the left
        // channel's output exactly — computing it twice buys nothing. One
        // full-length comparison at load time (not per hop) decides whether
        // to skip it for this stem's whole lifetime.
        this.mono = arraysEqual(msg.channels[0], msg.channels[1]);
        break;
      case "active": {
        const next = !!msg.active;
        if (next !== this.active) {
          this.active = next;
          if (next) {
            // Coming back from idle: the frames that would have carried
            // phase continuity were never computed, so start clean rather
            // than advancing from stale state (identical to what a seek
            // does, and inaudible for the same reason).
            this.channels.forEach((c) => c.reset());
            this.extended.forEach((e) => e.fill(0));
            this.blockPos = BLOCK_SIZE;
          }
        }
        break;
      }
      case "params":
        if (typeof msg.speed === "number") this.speed = msg.speed;
        if (typeof msg.pitchRatio === "number" && msg.pitchRatio !== this.pitchRatio) {
          // readPos is in the resampled domain: the current source position
          // is readPos * pitchRatio (see _readVirtual). Changing pitchRatio
          // without rescaling readPos would instantly move the source
          // position by the ratio old/new — dragging Tune mid-song would
          // skip playback (and the playhead) forward/backward. Rescale so
          // the source position is preserved across the pitch change.
          this.readPos = this.readPos * this.pitchRatio / msg.pitchRatio;
          this.pitchRatio = msg.pitchRatio;
        }
        break;
      case "transport":
        if (msg.action === "play") this.playing = true;
        else if (msg.action === "pause") this.playing = false;
        else if (msg.action === "seek") {
          const originalSample = Math.max(0, msg.positionSec * sampleRate);
          this.readPos = originalSample / this.pitchRatio;
          this.blockPos = BLOCK_SIZE;
          this.ended = false;
          this.channels.forEach((c) => c.reset());
          this.extended.forEach((e) => e.fill(0));
        }
        break;
      default:
        break;
    }
  }

  // Reads one sample from the virtual "resampled by pitchRatio" domain
  // (file header §1) via a windowed-sinc (Lanczos, LANCZOS_A taps) kernel —
  // see buildLanczosTable above for why. Was originally 2-point linear
  // (-1.9dB at 15kHz), then 4-point Catmull-Rom cubic (-2.96dB at 17kHz on
  // a fractional-hop Speed/Tune setting — a cubic's high-frequency response
  // still falls away well before Nyquist). This measures within ±0.15dB to
  // 14kHz and ±0.4dB to 17kHz (see the review's S-2 acceptance criteria).
  // S-4: fills one windowed analysis frame (both channels) from the virtual
  // resampled domain, and reports whether every sample of it came out exactly
  // zero. This is a hand-inlined equivalent of FFT_SIZE calls to
  // _readVirtual() below, and it exists purely for speed: _readVirtual
  // measured 45% of this worklet's ENTIRE cost, which for a while looked like
  // the price of S-2's 12-tap kernel — but cutting the kernel to 2 taps saved
  // almost nothing (27.8% -> 26.5% of real time), so the taps were never
  // where the time went. It was everything the call repeated per sample and
  // did not have to: a method call, three property loads to reach
  // sourceChannels[c], a Math.floor, a Math.min for the table phase, and —
  // worst of all — two bounds branches PER TAP, i.e. 24 branches per output
  // sample, ~98k per hop, for a range check that can only fail within a
  // kernel's reach of the two ends of the song.
  //
  // So: hoist the invariants, decide the range check ONCE for the whole frame,
  // and let the interior case run a straight 12-tap multiply-add with the
  // weights and both channel arrays already in locals. _readVirtual is kept
  // as the reference implementation this must agree with, and as the clamped
  // path for the handful of frames at each end that genuinely need it.
  _fillAnalysisFrame(dstL, dstR) {
    const n = FFT_SIZE;
    const win = this.window;
    const srcL = this.sourceChannels[0], srcR = this.sourceChannels[1];
    const len = this.sourceLength;
    const a = LANCZOS_A, taps = LANCZOS_TAPS, tbl = LANCZOS_TABLE;
    const pr = this.pitchRatio;
    const start = this.readPos * pr;
    let silent = true;

    // Widest source index this whole frame can touch, kernel reach included.
    // readPos never goes negative (seek clamps at 0 and it only advances), so
    // `| 0` truncation is floor here, and the frame is interior unless it is
    // within a few samples of one end of the song.
    const firstIdx = (start | 0) - (a - 1);
    const lastIdx = ((start + (n - 1) * pr) | 0) + a;
    if (firstIdx >= 0 && lastIdx < len) {
      for (let j = 0; j < n; j++) {
        const pos = start + j * pr; // not pos += pr: no accumulated drift
        const i1 = pos | 0;
        const base = (((pos - i1) * LANCZOS_PHASES) | 0) * taps;
        const o = i1 - (a - 1);
        let l = 0, r = 0;
        for (let k = 0; k < taps; k++) {
          const wk = tbl[base + k];
          l += wk * srcL[o + k];
          r += wk * srcR[o + k];
        }
        const w = win[j];
        l *= w; r *= w;
        dstL[j] = l; dstR[j] = r;
        if (l !== 0 || r !== 0) silent = false;
      }
      return silent;
    }

    // Near one end of the buffer — same result, via the reference path.
    for (let j = 0; j < n; j++) {
      const w = win[j];
      const l = this._readVirtual(0, this.readPos + j) * w;
      const r = this._readVirtual(1, this.readPos + j) * w;
      dstL[j] = l; dstR[j] = r;
      if (l !== 0 || r !== 0) silent = false;
    }
    return silent;
  }

  _readVirtual(channelIdx, resampledIndex) {
    const src = this.sourceChannels[channelIdx];
    const originalIndex = resampledIndex * this.pitchRatio;
    const i1 = Math.floor(originalIndex);
    if (i1 < 0 || i1 >= this.sourceLength) return 0;
    const t = originalIndex - i1;
    const len = this.sourceLength;
    const a = LANCZOS_A;
    const taps = LANCZOS_TAPS;
    const phase = Math.min(LANCZOS_PHASES - 1, (t * LANCZOS_PHASES) | 0);
    const base = phase * taps;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      // Same clamp-at-edges idea as before: reflect out-of-range taps to
      // the nearest valid sample rather than reading zero, so the kernel
      // doesn't put a step into the reconstruction right at the buffer
      // boundary.
      let idx = i1 - (a - 1) + k;
      if (idx < 0) idx = 0; else if (idx >= len) idx = len - 1;
      acc += LANCZOS_TABLE[base + k] * src[idx];
    }
    return acc;
  }

  _virtualLength() {
    return this.sourceLength / this.pitchRatio;
  }

  _regenerateBlock() {
    if (!this.sourceChannels) {
      for (const b of this.outBlocks) b.fill(0);
      this.blockPos = 0;
      return;
    }

    // extended[0..FFT_SIZE) starts holding the overhang carried from the
    // previous block's frames (already accumulated there last call); the
    // rest starts at zero. Frame contributions are accumulated with no
    // upper-bound clipping (the buffer is sized to fit the worst-case
    // overhang), then [0, BLOCK_SIZE) is handed to the caller and
    // [BLOCK_SIZE, BLOCK_SIZE+FFT_SIZE) becomes the new overhang, shifted
    // down to [0, FFT_SIZE) for next time.
    for (const e of this.extended) e.fill(0, FFT_SIZE);

    const Ha = SYNTHESIS_HOP * (this.speed / this.pitchRatio);
    let written = 0;

    // Muted/not-soloed: skip every expensive step (interpolated reads, both
    // FFTs, the whole bin pass) but still walk readPos forward exactly as if
    // we had processed, so this stem stays in lockstep with the others and
    // unmuting resumes at the right place rather than wherever it paused.
    if (!this.active) {
      while (written < BLOCK_SIZE) {
        if (this.readPos >= this._virtualLength()) { this.ended = true; break; }
        this.readPos += Ha;
        written += SYNTHESIS_HOP;
      }
      for (const b of this.outBlocks) b.fill(0);
      this.blockPos = 0;
      return;
    }

    while (written < BLOCK_SIZE) {
      if (this.readPos >= this._virtualLength()) { this.ended = true; break; }

      const n = FFT_SIZE, bins = n / 2 + 1;
      const packRe = this.packRe, packIm = this.packIm;
      // Pack: left into the real part, right into the imaginary part, so a
      // single complex FFT transforms both channels at once.
      const silent = this._fillAnalysisFrame(packRe, packIm);
      // S-1: source-separation stems commonly have exact digital silence in
      // sections a model produced nothing for (e.g. a guitar-only stem
      // during a drum fill). An all-zero window transforms, phase-locks, and
      // inverse-transforms to all zero — which is exactly what leaving
      // extended[] untouched already represents, so skip the FFT and phase
      // vocoder entirely for it (still advancing readPos, same as the
      // !this.active fast path above, to stay sample-aligned).
      if (silent) {
        this.readPos += Ha;
        written += SYNTHESIS_HOP;
        this.silenceGap = true;
        continue;
      }
      if (this.silenceGap) {
        // The previous hop(s) were skipped rather than processed, so
        // prevIn/prevOut in each PVChannel describe a frame from before the
        // gap, not "one Ha ago" — using them for phase advance here would
        // measure a bogus (far too large) elapsed phase and audibly glitch.
        // Same recovery as the !active -> active and seek cases: treat this
        // frame as the first one and let the next hop lock onto it.
        this.channels.forEach((c) => c.reset());
        this.silenceGap = false;
      }
      this.fft.forward(packRe, packIm);

      // Unpack. For two real inputs l, r packed as z = l + i*r, the two
      // spectra separate exactly by conjugate symmetry:
      //   L[k] = (Z[k] + conj(Z[N-k])) / 2
      //   R[k] = -i * (Z[k] - conj(Z[N-k])) / 2
      const Lre = this.specRe[0], Lim = this.specIm[0];
      const Rre = this.specRe[1], Rim = this.specIm[1];
      // kk is (n - k) % n, which is n - k for every k except 0 — hoisting the
      // one special case out beats a modulo per bin (S-4).
      {
        const a = packRe[0], b = packIm[0];
        Lre[0] = a; Lim[0] = 0; Rre[0] = b; Rim[0] = 0;
      }
      for (let k = 1; k < bins; k++) {
        const kk = n - k;
        const a = packRe[k], b = packIm[k], c = packRe[kk], d = packIm[kk];
        Lre[k] = (a + c) * 0.5; Lim[k] = (b - d) * 0.5;
        Rre[k] = (b + d) * 0.5; Rim[k] = (c - a) * 0.5;
      }

      const oLre = this.outSpecRe[0], oLim = this.outSpecIm[0];
      const oRre = this.outSpecRe[1], oRim = this.outSpecIm[1];
      this.channels[0].processSpectrum(Lre, Lim, oLre, oLim, Ha);
      if (this.mono) {
        // L and R are identical inputs fed into identically-reset channel
        // state (see the "load"/"active"/"seek" handlers, which reset both
        // channels together) — channels[1] would compute the exact same
        // output every hop, forever. Copy instead of recomputing.
        oRre.set(oLre); oRim.set(oLim);
      } else {
        this.channels[1].processSpectrum(Rre, Rim, oRre, oRim, Ha);
      }

      // Repack the two modified spectra the same way and inverse-transform
      // once. Bins above N/2 are filled from the conjugate symmetry both
      // output spectra still have (they represent real signals).
      for (let k = 0; k < bins; k++) {
        packRe[k] = oLre[k] - oRim[k];
        packIm[k] = oLim[k] + oRre[k];
      }
      for (let k = 1; k < n / 2; k++) {
        packRe[n - k] = oLre[k] + oRim[k];
        packIm[n - k] = oRre[k] - oLim[k];
      }
      this.fft.inverse(packRe, packIm);

      // Unpack the time domain: real part is left, imaginary part is right.
      const extL = this.extended[0], extR = this.extended[1];
      const win = this.window;
      for (let j = 0; j < n; j++) {
        const w = win[j];
        extL[written + j] += packRe[j] * w;
        extR[written + j] += packIm[j] * w;
      }
      this.readPos += Ha;
      written += SYNTHESIS_HOP;
    }

    for (let ch = 0; ch < 2; ch++) {
      const ext = this.extended[ch];
      const dst = this.outBlocks[ch];
      // See colaNormalization above — without this, every processed-mode
      // sample comes out ~1.5x too loud (double-windowed overlap-add,
      // never scaled back down).
      // Reciprocal multiply, and the softLimit call only for the rare sample
      // that is actually above the threshold — the branch here saves a
      // function call on every one of the other ~99.99% (S-4).
      const invOla = this.invOlaGain;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        const v = ext[i] * invOla;
        dst[i] = (v <= SOFT_LIMIT_THRESHOLD && v >= -SOFT_LIMIT_THRESHOLD) ? v : softLimit(v);
      }
      ext.copyWithin(0, BLOCK_SIZE, BLOCK_SIZE + FFT_SIZE);
    }
    this.blockPos = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;

    if (!this.playing || !this.sourceChannels || this.ended) {
      return true; // silence (output channels are already zero-filled)
    }

    let outIdx = 0;
    while (outIdx < frames) {
      if (this.blockPos >= BLOCK_SIZE) {
        this._regenerateBlock();
        if (this.blockPos >= BLOCK_SIZE) break; // nothing left (ended mid-regen)
      }
      const remaining = Math.min(frames - outIdx, BLOCK_SIZE - this.blockPos);
      for (let ch = 0; ch < output.length; ch++) {
        const srcCh = this.outBlocks[Math.min(ch, 1)];
        output[ch].set(srcCh.subarray(this.blockPos, this.blockPos + remaining), outIdx);
      }
      outIdx += remaining;
      this.blockPos += remaining;
    }

    this.samplesSinceReport += outIdx;
    if (this.samplesSinceReport >= 512) {
      this.samplesSinceReport = 0;
      this.port.postMessage({
        type: "position",
        positionSec: (this.readPos * this.pitchRatio) / sampleRate,
        ended: this.ended,
      });
    }
    return true;
  }
}

registerProcessor("stretch-processor", StretchProcessor);
