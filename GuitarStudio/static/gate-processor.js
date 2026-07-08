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

    for (let i = 0; i < input.length; i++) {
      const thresholdDb = thresholdDbArr.length > 1 ? thresholdDbArr[i] : thresholdDbArr[0];
      const attackMs = attackMsArr.length > 1 ? attackMsArr[i] : attackMsArr[0];
      const releaseMs = releaseMsArr.length > 1 ? releaseMsArr[i] : releaseMsArr[0];
      const thresholdLinear = Math.pow(10, thresholdDb / 20);

      const x = Math.abs(input[i]);
      // Envelope follower: fast-ish rectified level tracking (5ms time constant)
      const envCoeff = Math.exp(-1 / (0.005 * sampleRate));
      this.envelope = Math.max(x, this.envelope * envCoeff);

      const targetGain = this.envelope >= thresholdLinear ? 1 : 0;
      const timeConstantMs = targetGain > this.gain ? attackMs : releaseMs;
      const coeff = Math.exp(-1 / (Math.max(0.1, timeConstantMs) / 1000 * sampleRate));
      this.gain = targetGain + (this.gain - targetGain) * coeff;

      output[i] = input[i] * this.gain;
    }
    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
