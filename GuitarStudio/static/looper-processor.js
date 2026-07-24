"use strict";

// GP-06 (looper-pedal-spec.md): a real-time loop recorder/overdubber.
// Same "raw PCM, controlled by postMessage" lineage as
// riff-capture-processor.js, but bidirectional (it has an OUTPUT for
// playback, not just an input to record) and stateful across an overdub
// cycle instead of a fixed-size ring buffer.
//
// States: idle -> recording -> playing <-> overdubbing, plus "stopped"
// (has a committed loop, but playback paused). See looper-pedal-spec.md
// §3 for the full design this mirrors.
// GP-mem (code review finding): recording used to push a fresh Float32Array
// pair into a plain array every render quantum (~128 frames, ~2.9ms),
// concatenated only at stop_and_loop. Allocating inside process() risks
// GC-induced glitches on this real-time thread, and had no upper bound if a
// recording pass ran long — the same shape of bug just fixed for
// MediaRecorder's own chunk buffering elsewhere, just relocated to the
// worklet thread. RECORD_INITIAL_SECONDS/_ensureRecordCapacity below give
// recording pre-allocated, amortized-growth buffers instead — one
// allocation (doubling capacity, like a growable array) only when actually
// needed, not one every quantum — matching the pre-allocated-buffer
// approach riff-capture-processor.js already uses for the same reason.
const RECORD_INITIAL_SECONDS = 30;

class LooperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = "idle";
    this.recordL = null; // pre-allocated, grown by doubling — see _growRecordCapacity
    this.recordR = null;
    this.recordLen = 0; // samples actually written so far this recording pass
    this.committedL = null;
    this.committedR = null;
    this.previousCommittedL = null; // one level of Undo
    this.previousCommittedR = null;
    this.pendingL = null; // in-progress overdub pass, summed into committed on stop-overdub
    this.pendingR = null;
    this.loopLengthFrames = 0;
    this.playhead = 0;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  // Ensures room for `needed` samples, growing by doubling (amortized O(1)
  // per sample, not one allocation per render quantum) rather than
  // reallocating on every call. Keeps the previous recording's buffer
  // around and reuses it across passes when it's already big enough.
  _ensureRecordCapacity(needed) {
    if (this.recordL && needed <= this.recordL.length) return;
    const newCap = Math.max(needed, this.recordL ? this.recordL.length * 2 : Math.ceil(sampleRate * RECORD_INITIAL_SECONDS));
    const newL = new Float32Array(newCap);
    const newR = new Float32Array(newCap);
    if (this.recordL) {
      newL.set(this.recordL.subarray(0, this.recordLen));
      newR.set(this.recordR.subarray(0, this.recordLen));
    }
    this.recordL = newL;
    this.recordR = newR;
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "start_record":
        this.state = "recording";
        this.recordLen = 0; // reuses the existing recordL/R buffer if it's already allocated
        this.port.postMessage({ type: "started_recording" });
        break;

      case "stop_and_loop": {
        const rawLen = this.recordLen;
        const rawL = this.recordL ? this.recordL.subarray(0, rawLen) : new Float32Array(0);
        const rawR = this.recordR ? this.recordR.subarray(0, rawLen) : new Float32Array(0);
        this.recordLen = 0;

        // msg.barLengthFrames: one bar's length in frames at the song's
        // detected BPM (main thread computes this from State.analysis.bpm,
        // which the worklet has no access to) — null means free-running (no
        // BPM/track loaded). Rounding the ACTUAL recorded length (rawLen) to
        // the nearest whole-bar multiple has to happen here, not on the
        // main thread, since only the worklet knows rawLen precisely (the
        // main thread's own start/stop timestamps would be off by however
        // long the postMessage round trip took). "Resample" means
        // length-adjust only (truncate or zero-pad), never pitch/time-
        // stretch — see looper-pedal-spec.md §1's sync model.
        let targetLen = rawLen;
        let bars = null;
        if (msg.barLengthFrames) {
          bars = Math.max(1, Math.round(rawLen / msg.barLengthFrames));
          targetLen = bars * msg.barLengthFrames;
        }
        const outL = new Float32Array(targetLen);
        const outR = new Float32Array(targetLen);
        const copyLen = Math.min(targetLen, rawLen);
        outL.set(rawL.subarray(0, copyLen));
        outR.set(rawR.subarray(0, copyLen));
        // (targetLen > rawLen leaves the tail correctly zero-filled —
        // Float32Array starts zeroed — a silent pad, not a loud glitch.)

        this.committedL = outL;
        this.committedR = outR;
        this.previousCommittedL = null;
        this.previousCommittedR = null;
        this.loopLengthFrames = targetLen;
        this.playhead = 0;
        this.state = "playing";
        this.port.postMessage({ type: "looped", lengthFrames: targetLen, bars });
        break;
      }

      case "start_overdub":
        if (this.state !== "playing") return;
        this.pendingL = new Float32Array(this.loopLengthFrames);
        this.pendingR = new Float32Array(this.loopLengthFrames);
        this.state = "overdubbing";
        this.port.postMessage({ type: "overdub_started" });
        break;

      case "stop_overdub":
        if (this.state !== "overdubbing") return;
        this.previousCommittedL = this.committedL; // one-level Undo — kept BEFORE merging this pass in
        this.previousCommittedR = this.committedR;
        this.committedL = this.committedL.map((v, i) => Math.max(-1, Math.min(1, v + this.pendingL[i])));
        this.committedR = this.committedR.map((v, i) => Math.max(-1, Math.min(1, v + this.pendingR[i])));
        this.pendingL = null;
        this.pendingR = null;
        this.state = "playing";
        this.port.postMessage({ type: "overdub_stopped" });
        break;

      case "stop":
        if (this.state === "playing" || this.state === "overdubbing") {
          // Overdubbing an in-progress pass gets abandoned on Stop, not
          // silently committed — Stop is meant to just pause, but there's
          // no "playing" version of a half-finished overdub to pause INTO.
          this.pendingL = null;
          this.pendingR = null;
          this.state = "stopped";
          this.port.postMessage({ type: "stopped" });
        }
        break;

      case "resume":
        if (this.state === "stopped" && this.committedL) {
          this.playhead = 0;
          this.state = "playing";
          this.port.postMessage({ type: "resumed" });
        }
        break;

      case "undo":
        if (this.previousCommittedL) {
          this.committedL = this.previousCommittedL;
          this.committedR = this.previousCommittedR;
          this.previousCommittedL = null;
          this.previousCommittedR = null;
          this.port.postMessage({ type: "undone" });
        } else {
          this.port.postMessage({ type: "undo_failed" });
        }
        break;

      case "clear":
        this.state = "idle";
        this.recordLen = 0;
        this.committedL = null;
        this.committedR = null;
        this.previousCommittedL = null;
        this.previousCommittedR = null;
        this.pendingL = null;
        this.pendingR = null;
        this.loopLengthFrames = 0;
        this.playhead = 0;
        this.port.postMessage({ type: "cleared" });
        break;

      case "load":
        // Reopening a song with a previously-saved loop (looper-pedal-
        // spec.md §5) — arrives paused/ready, never auto-playing.
        this.committedL = msg.left;
        this.committedR = msg.right;
        this.loopLengthFrames = msg.left.length;
        this.playhead = 0;
        this.state = "stopped";
        this.port.postMessage({ type: "loaded" });
        break;

      case "dump":
        this.port.postMessage({
          type: "dumped",
          left: this.committedL ? this.committedL.slice() : new Float32Array(0),
          right: this.committedR ? this.committedR.slice() : new Float32Array(0),
          sampleRate,
        });
        break;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const n = outL.length;

    if (this.state === "recording") {
      const inL = (input && input[0]) || null;
      const inR = (input && input.length > 1) ? input[1] : inL;
      this._ensureRecordCapacity(this.recordLen + n);
      if (inL) this.recordL.set(inL, this.recordLen);
      if (inR) this.recordR.set(inR, this.recordLen);
      // (no input yet: recordL/R are already zero-filled at this offset —
      // Float32Array starts zeroed and _ensureRecordCapacity never touches
      // already-written samples, so this is silence, not garbage.)
      this.recordLen += n;
      // Silent output while recording — nothing to play back yet.
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    if ((this.state === "playing" || this.state === "overdubbing") && this.loopLengthFrames > 0) {
      const inL = (input && input[0]) || null;
      const inR = (input && input.length > 1) ? input[1] : inL;
      for (let i = 0; i < n; i++) {
        const idx = (this.playhead + i) % this.loopLengthFrames;
        outL[i] = this.committedL[idx];
        if (outR !== outL) outR[i] = this.committedR[idx];
        if (this.state === "overdubbing" && inL) {
          this.pendingL[idx] += inL[i];
          this.pendingR[idx] += inR ? inR[i] : inL[i];
        }
      }
      this.playhead = (this.playhead + n) % this.loopLengthFrames;
      return true;
    }

    // idle/stopped: silent output, input ignored.
    outL.fill(0);
    if (outR !== outL) outR.fill(0);
    return true;
  }
}

registerProcessor("looper-processor", LooperProcessor);
