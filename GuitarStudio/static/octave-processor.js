"use strict";

// v3.1 fix: real octave-down via zero-crossing frequency division — the
// classic analog-octave-pedal technique (Boss OC-2 and similar): track the
// input's rising zero-crossings and flip a square-wave output on every
// OTHER one, halving the perceived frequency. The first version of this
// pedal used a WaveShaper "rectify and lowpass" trick instead, which
// doesn't actually produce sub-octave content — full-wave rectification of
// a sine DOUBLES its frequency (that's an octave UP), so low-passing away
// that doubled content just leaves a near-DC blob that muddies whatever
// it's blended with, which is what "cuts the sound" actually was. Only a
// genuine frequency divider goes down.
//
// Monophonic by construction (one zero-crossing counter tracks one pitch
// at a time) — the same honest limitation already documented on the
// pedal's own UI card and in USER-MANUAL.md.
class OctaveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.envelope = 0;
    this.envCoeff = Math.exp(-1 / (0.01 * sampleRate)); // 10ms follower — tracks picking dynamics
    this.prevSample = 0;
    this.square = 1;
    this.smoothed = 0;
    // Softens the raw square wave's harsh edges a little without eating
    // the "synthy" character that makes an octave-down effect recognizable.
    this.smoothCoeff = Math.exp(-1 / (0.0015 * sampleRate));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }

    if (parameters.bypass[0] >= 0.5) { output.set(input); return true; }

    const NOISE_FLOOR = 0.01; // below this, hold state instead of chasing noise-triggered crossings

    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.envelope = Math.max(Math.abs(x), this.envelope * this.envCoeff);

      // A sine has exactly ONE rising zero-crossing per cycle, so flipping
      // the square's sign on every rising crossing gives it a full cycle
      // (two flips) every TWO input cycles — half the frequency, one
      // octave down. (Flipping on every OTHER crossing, tried first here,
      // actually divides by 4: two crossings per flip x two flips per
      // square cycle.)
      if (this.envelope > NOISE_FLOOR && this.prevSample <= 0 && x > 0) {
        this.square = -this.square;
      }
      this.prevSample = x;

      const target = this.envelope > NOISE_FLOOR ? this.square * this.envelope : 0;
      this.smoothed = target + (this.smoothed - target) * this.smoothCoeff;
      output[i] = this.smoothed;
    }
    return true;
  }
}

registerProcessor("octave-processor", OctaveProcessor);
