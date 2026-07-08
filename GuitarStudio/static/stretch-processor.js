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
const BLOCK_SIZE = 8192; // samples of output regenerated per synthesis pass
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

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (size - 1));
  return w;
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

    const outRe = new Float32Array(n);
    const outIm = new Float32Array(n);

    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(this.re[k], this.im[k]);
      const phase = Math.atan2(this.im[k], this.re[k]);

      if (!this.haveState) {
        this.sumPhase[k] = phase;
      } else {
        const expected = (TWO_PI * k * Ha) / n;
        let delta = phase - this.lastPhase[k] - expected;
        delta -= TWO_PI * Math.round(delta / TWO_PI); // wrap to [-pi, pi]
        this.sumPhase[k] += expected + delta;
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
        break;
      case "params":
        if (typeof msg.speed === "number") this.speed = msg.speed;
        if (typeof msg.pitchRatio === "number") this.pitchRatio = msg.pitchRatio;
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
    for (const b of this.outBlocks) b.fill(0);
    if (!this.sourceChannels) { this.blockPos = 0; return; }

    const Ha = SYNTHESIS_HOP * (this.speed / this.pitchRatio);
    let written = 0;

    while (written < BLOCK_SIZE) {
      if (this.readPos >= this._virtualLength()) { this.ended = true; break; }

      for (let ch = 0; ch < 2; ch++) {
        const frame = new Float32Array(FFT_SIZE);
        for (let j = 0; j < FFT_SIZE; j++) {
          frame[j] = this._readVirtual(ch, this.readPos + j) * this.window[j];
        }
        const synth = this.channels[ch].synthesize(frame, Ha);
        for (let j = 0; j < FFT_SIZE; j++) {
          const idx = written + j;
          if (idx >= 0 && idx < BLOCK_SIZE) this.outBlocks[ch][idx] += synth[j];
        }
      }
      this.readPos += Ha;
      written += SYNTHESIS_HOP;
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
