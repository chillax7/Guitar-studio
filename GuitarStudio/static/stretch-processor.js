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
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const tableStep = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += tableStep) {
          const l = j + halfSize;
          const angleIdx = ((k * sign) % n + n) % n;
          const cos = this.cosTable[angleIdx];
          const sin = this.sinTable[angleIdx];
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
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
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
  }

  reset() {
    this.prevInRe.fill(0);
    this.prevInIm.fill(0);
    this.prevOutRe.fill(0);
    this.prevOutIm.fill(0);
    this.haveState = false;
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
    for (let k = 0; k < bins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

    if (!this.haveState) {
      // First frame after a load/seek: nothing to advance from, so pass the
      // spectrum through untouched and let the next frame lock onto it.
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

    // Save this frame's spectra for the next hop's phase advance.
    for (let k = 0; k < bins; k++) {
      prevInRe[k] = re[k]; prevInIm[k] = im[k];
      prevOutRe[k] = outRe[k]; prevOutIm[k] = outIm[k];
    }
  }
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new FFT(FFT_SIZE);
    this.window = hannWindow(FFT_SIZE);
    this.olaGain = colaNormalization(this.window, SYNTHESIS_HOP);
    this.channels = [new PVChannel(), new PVChannel()];

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
  // (file header §1) via Catmull-Rom cubic interpolation.
  //
  // This was 2-point linear interpolation, which is a surprisingly poor
  // reconstruction filter: measured as a real treble rolloff on anything
  // off unity — -1.9dB at 15kHz, -1.3dB at 12kHz, i.e. an audible dulling
  // of cymbals and pick attack that showed up as "the quality gets
  // significantly worse" whenever Speed or Tune was touched. A 4-point
  // cubic is far closer to flat (measured below -0.6dB at 15kHz) for two
  // extra multiply-adds per sample.
  _readVirtual(channelIdx, resampledIndex) {
    const src = this.sourceChannels[channelIdx];
    const originalIndex = resampledIndex * this.pitchRatio;
    const i1 = Math.floor(originalIndex);
    const t = originalIndex - i1;
    const len = this.sourceLength;
    // Clamp at the edges rather than reading zeros — a zero neighbour would
    // put a step into the interpolation right at the buffer boundary.
    const i0 = i1 > 0 ? i1 - 1 : 0;
    const i2 = i1 + 1 < len ? i1 + 1 : len - 1;
    const i3 = i1 + 2 < len ? i1 + 2 : len - 1;
    if (i1 < 0 || i1 >= len) return 0;
    const sm1 = src[i0], s0 = src[i1], s1 = src[i2], s2 = src[i3];
    return s0 + 0.5 * t * (s1 - sm1 +
      t * (2 * sm1 - 5 * s0 + 4 * s1 - s2 +
      t * (3 * (s0 - s1) + s2 - sm1)));
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
      const win = this.window;
      // Pack: left into the real part, right into the imaginary part, so a
      // single complex FFT transforms both channels at once.
      for (let j = 0; j < n; j++) {
        const w = win[j];
        packRe[j] = this._readVirtual(0, this.readPos + j) * w;
        packIm[j] = this._readVirtual(1, this.readPos + j) * w;
      }
      this.fft.forward(packRe, packIm);

      // Unpack. For two real inputs l, r packed as z = l + i*r, the two
      // spectra separate exactly by conjugate symmetry:
      //   L[k] = (Z[k] + conj(Z[N-k])) / 2
      //   R[k] = -i * (Z[k] - conj(Z[N-k])) / 2
      const Lre = this.specRe[0], Lim = this.specIm[0];
      const Rre = this.specRe[1], Rim = this.specIm[1];
      for (let k = 0; k < bins; k++) {
        const kk = (n - k) % n;
        const a = packRe[k], b = packIm[k], c = packRe[kk], d = packIm[kk];
        Lre[k] = (a + c) * 0.5; Lim[k] = (b - d) * 0.5;
        Rre[k] = (b + d) * 0.5; Rim[k] = (c - a) * 0.5;
      }

      const oLre = this.outSpecRe[0], oLim = this.outSpecIm[0];
      const oRre = this.outSpecRe[1], oRim = this.outSpecIm[1];
      this.channels[0].processSpectrum(Lre, Lim, oLre, oLim, Ha);
      this.channels[1].processSpectrum(Rre, Rim, oRre, oRim, Ha);

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
      for (let i = 0; i < BLOCK_SIZE; i++) dst[i] = softLimit(ext[i] / this.olaGain);
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
