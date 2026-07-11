"use strict";

// Simple envelope-follower noise gate. Web Audio has no native gate node
// (DynamicsCompressorNode only does downward compression, not expansion/
// gating), so this is a small, standard AudioWorklet: track a smoothed
// signal envelope, open/close a gain toward 1/0 with independent attack
// and release time constants so the cutoff isn't a click.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "thresholdDb", defaultValue: -50, minValue: -80, maxValue: 0 },
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
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }

    const bypass = parameters.bypass[0] >= 0.5;
    if (bypass) { output.set(input); return true; }

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
    const attackCoeffK = attackIsKRate
      ? Math.exp(-1 / (Math.max(0.1, attackMsArr[0]) / 1000 * sampleRate)) : 0;
    const releaseCoeffK = releaseIsKRate
      ? Math.exp(-1 / (Math.max(0.1, releaseMsArr[0]) / 1000 * sampleRate)) : 0;

    for (let i = 0; i < input.length; i++) {
      const thresholdLinear = thresholdIsKRate ? thresholdLinearK : Math.pow(10, thresholdDbArr[i] / 20);

      const x = Math.abs(input[i]);
      this.envelope = Math.max(x, this.envelope * envCoeff);

      const targetGain = this.envelope >= thresholdLinear ? 1 : 0;
      const rising = targetGain > this.gain;
      const coeff = rising
        ? (attackIsKRate ? attackCoeffK : Math.exp(-1 / (Math.max(0.1, attackMsArr[i]) / 1000 * sampleRate)))
        : (releaseIsKRate ? releaseCoeffK : Math.exp(-1 / (Math.max(0.1, releaseMsArr[i]) / 1000 * sampleRate)));
      this.gain = targetGain + (this.gain - targetGain) * coeff;

      output[i] = input[i] * this.gain;
    }
    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
