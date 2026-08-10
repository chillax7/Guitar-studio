"use strict";

// Simple envelope-follower noise gate. Web Audio has no native gate node
// (DynamicsCompressorNode only does downward compression, not expansion/
// gating), so this is a small, standard AudioWorklet: track a smoothed
// signal envelope, open/close a gain toward 1/0 with independent attack
// and release time constants so the cutoff isn't a click.
//
// IN-3, from a real report of a "pop" when plucking a string, chased across
// three different interfaces (a USB jack cable, an M-Track Solo and an
// iRig). Two genuine defects were found here by running this exact worklet
// offline over a synthesized pluck — see scripts/gate_bench.js:
//
//   1. The gate CHOPPED THE FRONT OFF EVERY NOTE IT OPENED ON. The envelope
//      follower has instant attack, so the threshold is crossed within
//      microseconds of the pick — but the gain then took its attack time to
//      travel from 0 to 1, and a guitar pluck reaches its peak inside those
//      same 2ms. The loudest part of every note was therefore multiplied by
//      a gain sweeping up from zero. Measured: a 0.149 amplitude jump inside
//      one millisecond, which is a click.
//
//      Fixed the standard way, with LOOKAHEAD: the audio is delayed by a
//      few milliseconds while the detector still sees it live, so the gain
//      is already open by the time the transient arrives. The ramp is also
//      linear now rather than exponential — an exponential only ever
//      asymptotes toward 1, so "2ms attack" reached 63%, whereas a linear
//      ramp actually finishes inside the lookahead window. This is what the
//      report asked for in the first place: a rapid linear ramp instead of
//      an instantaneous jump.
//
//   2. A DC OFFSET SILENTLY DEFEATED THE GATE ENTIRELY. The detector tracked
//      |x| rather than |x - mean|, so a constant offset — which cheap
//      interfaces do produce — read as permanent signal. At -40dBFS of DC
//      the envelope sat at 0.01, two orders of magnitude above the -75dB
//      threshold, and the gate never closed at any point. Fixed with a DC
//      blocker on the DETECTOR's input only; the audio path is untouched
//      here (IN-2 puts a proper high-pass at the top of the input stage).
//
// The lookahead is a real cost: it adds its own length to monitoring
// latency. It is deliberately a small fixed constant rather than tracking
// the attack parameter, so that latency is predictable and doesn't move
// when a knob does, and it is applied in bypass too — otherwise toggling
// bypass would shift the signal in time by exactly the lookahead and click
// on every toggle, trading a rare pop for a guaranteed one.
const LOOKAHEAD_MS = 3;

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Real user report: -50dB gated too aggressively for normal playing
      // dynamics — softer picking/palm-muted passages were getting cut off.
      { name: "thresholdDb", defaultValue: -75, minValue: -80, maxValue: 0 },
      { name: "attackMs", defaultValue: 2, minValue: 0.1, maxValue: 100 },
      { name: "releaseMs", defaultValue: 150, minValue: 1, maxValue: 2000 },
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.envelope = 0; // smoothed |signal|, 0..~1
    this.gain = 0;
    // V3-E5: sampleRate is fixed for this processor's whole lifetime, so
    // this envelope-follower time constant (5ms) is truly constant — it was
    // an exp() call recomputed on every single sample before.
    this.envCoeff = Math.exp(-1 / (0.005 * sampleRate));

    // IN-3 lookahead ring. Sized from the constant, so its length — and
    // therefore the latency it adds — never changes at runtime.
    this.lookaheadSamples = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate));
    this.delayLine = new Float32Array(this.lookaheadSamples);
    this.delayPos = 0;

    // IN-3 detector-only DC blocker, y[n] = x[n] - x[n-1] + R*y[n-1]. R set
    // for a corner near 20Hz: high enough to kill an offset quickly, low
    // enough to leave a low E's fundamental (82Hz) alone so the gate still
    // sees the note it is deciding about.
    this.dcR = 1 - (2 * Math.PI * 20) / sampleRate;
    this.dcX1 = 0;
    this.dcY1 = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }

    const bypass = parameters.bypass[0] >= 0.5;
    const delayLine = this.delayLine;
    const lookahead = this.lookaheadSamples;

    // IN-3: bypass still runs the delay line, so switching it does not move
    // the signal in time — see the note on LOOKAHEAD_MS. It skips only the
    // detector and the gain, which is the expensive part.
    if (bypass) {
      for (let i = 0; i < input.length; i++) {
        const delayed = delayLine[this.delayPos];
        delayLine[this.delayPos] = input[i];
        this.delayPos = (this.delayPos + 1) % lookahead;
        output[i] = delayed;
      }
      return true;
    }

    const thresholdDbArr = parameters.thresholdDb;
    const attackMsArr = parameters.attackMs;
    const releaseMsArr = parameters.releaseMs;
    const envCoeff = this.envCoeff;

    // V3-E5: these AudioParams are k-rate in practice (no scheduled
    // automation, length 1) — hoist their Math.pow/Math.exp conversions out
    // of the per-sample loop instead of recomputing an identical value 128
    // times per quantum, same pattern as nam-processor.js's gain hoisting.
    const thresholdIsKRate = thresholdDbArr.length === 1;
    const attackIsKRate = attackMsArr.length === 1;
    const releaseIsKRate = releaseMsArr.length === 1;
    const thresholdLinearK = thresholdIsKRate ? Math.pow(10, thresholdDbArr[0] / 20) : 0;
    // IN-3: the attack is now a LINEAR ramp, so what's hoisted is a
    // per-sample step (1 / attack in samples) rather than an exponential
    // coefficient. An exponential toward 1 never actually arrives — at
    // "2ms attack" it reached 63% after 2ms — so the gain was still climbing
    // straight through the pick attack even with lookahead in front of it.
    const attackStepK = attackIsKRate
      ? 1 / Math.max(1, (Math.max(0.1, attackMsArr[0]) / 1000) * sampleRate) : 0;
    // Release stays exponential: it is a fade-out into silence, where an
    // asymptote is the natural shape and nothing has to arrive on time.
    const releaseCoeffK = releaseIsKRate
      ? Math.exp(-1 / (Math.max(0.1, releaseMsArr[0]) / 1000 * sampleRate)) : 0;

    const dcR = this.dcR;

    for (let i = 0; i < input.length; i++) {
      const thresholdLinear = thresholdIsKRate ? thresholdLinearK : Math.pow(10, thresholdDbArr[i] / 20);
      const raw = input[i];

      // Detector path: DC-blocked, so a constant offset can't hold the gate
      // open forever (measured: -40dBFS of DC pinned it open permanently).
      const dcY = raw - this.dcX1 + dcR * this.dcY1;
      this.dcX1 = raw;
      this.dcY1 = dcY;
      this.envelope = Math.max(Math.abs(dcY), this.envelope * envCoeff);

      const targetGain = this.envelope >= thresholdLinear ? 1 : 0;
      if (targetGain > this.gain) {
        const step = attackIsKRate
          ? attackStepK
          : 1 / Math.max(1, (Math.max(0.1, attackMsArr[i]) / 1000) * sampleRate);
        this.gain = Math.min(1, this.gain + step);
      } else {
        const coeff = releaseIsKRate
          ? releaseCoeffK
          : Math.exp(-1 / (Math.max(0.1, releaseMsArr[i]) / 1000 * sampleRate));
        this.gain = targetGain + (this.gain - targetGain) * coeff;
      }

      // Audio path: delayed by the lookahead, so the gain above — decided
      // from the signal as it is RIGHT NOW — is already open by the time
      // this sample's transient actually reaches the output.
      const delayed = delayLine[this.delayPos];
      delayLine[this.delayPos] = raw;
      this.delayPos = (this.delayPos + 1) % lookahead;

      output[i] = delayed * this.gain;
    }
    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
