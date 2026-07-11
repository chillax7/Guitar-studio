"use strict";

// GP-07: riff capture rolling buffer — "Save that!" for an idea you only
// realize was good after you've already played it. Continuously writes the
// live mix (backing track + processed guitar, same signal recorder.js's
// takes capture — see ensureRiffCapture in playalong.js) into a fixed-size
// stereo ring buffer; nothing is ever encoded to a file until "Save that!"
// actually asks for a dump, so the rolling window itself costs no more than
// the memory for its own samples.
//
// Why a ring buffer instead of MediaRecorder with a sliding window of
// chunks: MediaRecorder's container header (WebM's EBML segment info, MP4's
// moov/ftyp) lives in the FIRST chunk of a recording — dropping old chunks
// off the front to keep a rolling window would leave the remaining chunks
// without a valid header, producing an undecodable file. Raw PCM in a ring
// buffer has no such constraint: any contiguous (or wrapped) span of it is
// just samples, trivially valid once wrapped in a WAV header at dump time
// (see wavEncode in playalong.js).
class RiffCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const seconds = (options.processorOptions && options.processorOptions.seconds) || 20;
    this.capacity = Math.ceil(seconds * sampleRate);
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.writePos = 0;
    this.filled = 0; // total samples ever written, capped at capacity — lets dump() know whether the buffer has wrapped yet
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type !== "dump") return;
    const n = Math.min(this.filled, this.capacity);
    // Reassemble in chronological order (oldest sample first): if the
    // buffer hasn't wrapped yet, that's just [0, n); if it has, the oldest
    // sample is the one about to be overwritten next, i.e. at writePos.
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    if (this.filled <= this.capacity) {
      outL.set(this.left.subarray(0, n));
      outR.set(this.right.subarray(0, n));
    } else {
      const tail = this.capacity - this.writePos;
      outL.set(this.left.subarray(this.writePos), 0);
      outL.set(this.left.subarray(0, this.writePos), tail);
      outR.set(this.right.subarray(this.writePos), 0);
      outR.set(this.right.subarray(0, this.writePos), tail);
    }
    this.port.postMessage(
      { type: "dumped", left: outL, right: outR, sampleRate },
      [outL.buffer, outR.buffer]
    );
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    for (let i = 0; i < inL.length; i++) {
      this.left[this.writePos] = inL[i];
      this.right[this.writePos] = inR[i];
      this.writePos = (this.writePos + 1) % this.capacity;
      this.filled++;
    }
    return true;
  }
}

registerProcessor("riff-capture-processor", RiffCaptureProcessor);
