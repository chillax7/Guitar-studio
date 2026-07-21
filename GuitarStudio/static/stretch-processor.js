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
// Quality note: this is a standard (non-phase-locked) single-channel-per-bin
// vocoder — adequate for the ±100 cent / 0.5–2x ranges this app exposes,
// with the same "mild artifacts at extremes" honesty this project already
// applies to Demucs separation quality elsewhere. Not intended as a
// mastering-grade time-stretch.

const FFT_SIZE = 2048;
const SYNTHESIS_HOP = 512; // 75% overlap
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
// 1 — and nothing here was ever dividing that back out. For a periodic Hann
// at 4x overlap (2048/512, this file's numbers) that constant is exactly
// 1.5: measured directly (a unit-amplitude 440Hz test tone through the real
// worklet code came back peaking at 1.50, not 1.0) — every processed-mode
// sample was ~50% too loud, which is more than enough headroom to clip
// against downstream gain stages once several stems are summed at the
// mixer, and clipping is exactly what "crackly, unlistenable" sounds like.
// Computed from the actual window/hop (not hardcoded 1.5) so this stays
// correct if either ever changes; COLA windows sum to the same constant at
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

// One phase-vocoder channel: owns its own phase-continuity state (lastPhase/
// sumPhase per bin) and the FFT scratch buffers, so stereo just means two
// independent instances fed from the two channels of the same virtual read.
class PVChannel {
  constructor(fft, window) {
    this.fft = fft;
    this.window = window;
    this.lastPhase = new Float32Array(FFT_SIZE / 2 + 1);
    this.sumPhase = new Float32Array(FFT_SIZE / 2 + 1);
    this.haveState = false;
    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    // V3-E5: preallocated once instead of `new Float32Array` on every
    // synthesize() call (~93.75 hops/sec per channel at 48kHz/512-sample
    // hops — 2 of these per hop per channel, ~3,400 allocations/sec of GC
    // pressure across 6 simultaneous stems before this).
    this.outRe = new Float32Array(FFT_SIZE);
    this.outIm = new Float32Array(FFT_SIZE);
  }

  reset() {
    this.lastPhase.fill(0);
    this.sumPhase.fill(0);
    this.haveState = false;
  }

  // frame: Float32Array(FFT_SIZE) already windowed. Ha: analysis hop used
  // to get to this frame (resampled-domain samples; may be fractional).
  // Returns Float32Array(FFT_SIZE) synthesis frame (already windowed for OLA).
  synthesize(frame, Ha) {
    const n = FFT_SIZE, bins = n / 2 + 1;
    this.re.set(frame);
    this.im.fill(0);
    this.fft.forward(this.re, this.im);

    // Reused scratch, not zeroed: the loop below writes every index of
    // outRe/outIm exactly once (direct writes for k in [0, n/2], mirror
    // writes for k in [n/2+1, n-1]) — no stale data from the previous call
    // can survive.
    const outRe = this.outRe;
    const outIm = this.outIm;

    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(this.re[k], this.im[k]);
      const phase = Math.atan2(this.im[k], this.re[k]);

      if (!this.haveState) {
        this.sumPhase[k] = phase;
      } else {
        const expected = (TWO_PI * k * Ha) / n;
        let delta = phase - this.lastPhase[k] - expected;
        delta -= TWO_PI * Math.round(delta / TWO_PI); // wrap to [-pi, pi]
        // (expected + delta) is how much phase bin k actually advanced
        // across the Ha-sample ANALYSIS hop just taken from the source.
        // Frames are re-emitted every SYNTHESIS_HOP samples regardless of
        // Ha (that's the whole mechanism of time-stretching), so the
        // phase must be rescaled from "advance per Ha samples" to
        // "advance per SYNTHESIS_HOP samples" before accumulating —
        // otherwise, whenever Ha != SYNTHESIS_HOP (i.e. whenever Speed or
        // Tune is off unity), every bin's reconstructed frequency is
        // wrong by the same factor Ha/SYNTHESIS_HOP, which is audible as
        // Speed shifting pitch instead of preserving it.
        this.sumPhase[k] += (expected + delta) * (SYNTHESIS_HOP / Ha);
      }
      this.lastPhase[k] = phase;

      const outPhase = this.sumPhase[k];
      outRe[k] = mag * Math.cos(outPhase);
      outIm[k] = mag * Math.sin(outPhase);
      if (k > 0 && k < n / 2) {
        // mirror to the negative-frequency bin so the IFFT output is real
        outRe[n - k] = outRe[k];
        outIm[n - k] = -outIm[k];
      }
    }
    this.haveState = true;

    this.fft.inverse(outRe, outIm);
    for (let i = 0; i < n; i++) outRe[i] *= this.window[i];
    return outRe;
  }
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new FFT(FFT_SIZE);
    this.window = hannWindow(FFT_SIZE);
    this.olaGain = colaNormalization(this.window, SYNTHESIS_HOP);
    this.channels = [new PVChannel(this.fft, this.window), new PVChannel(this.fft, this.window)];

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
    // (channel, hop) inside _regenerateBlock's loop — see PVChannel's
    // outRe/outIm comment for the allocation-rate math this was part of.
    this.frameScratch = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    this.blockPos = BLOCK_SIZE; // force regeneration on first process()
    this.ended = false;
    this.samplesSinceReport = 0;

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

  // Reads one sample from the virtual "resampled by pitchRatio" domain via
  // linear interpolation against the real source PCM (file header §1).
  _readVirtual(channelIdx, resampledIndex) {
    const src = this.sourceChannels[channelIdx];
    const originalIndex = resampledIndex * this.pitchRatio;
    const i0 = Math.floor(originalIndex);
    const frac = originalIndex - i0;
    const s0 = (i0 >= 0 && i0 < this.sourceLength) ? src[i0] : 0;
    const s1 = (i0 + 1 >= 0 && i0 + 1 < this.sourceLength) ? src[i0 + 1] : 0;
    return s0 + (s1 - s0) * frac;
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

    while (written < BLOCK_SIZE) {
      if (this.readPos >= this._virtualLength()) { this.ended = true; break; }

      for (let ch = 0; ch < 2; ch++) {
        const frame = this.frameScratch[ch];
        for (let j = 0; j < FFT_SIZE; j++) {
          frame[j] = this._readVirtual(ch, this.readPos + j) * this.window[j];
        }
        const synth = this.channels[ch].synthesize(frame, Ha);
        const ext = this.extended[ch];
        for (let j = 0; j < FFT_SIZE; j++) {
          ext[written + j] += synth[j];
        }
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
      for (let i = 0; i < BLOCK_SIZE; i++) dst[i] = ext[i] / this.olaGain;
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
