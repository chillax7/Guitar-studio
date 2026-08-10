// IN-2/IN-3: measures the input stage's behaviour on a plucked note, by
// running the REAL gate-processor.js offline over a synthesized pluck.
//
// This exists because of a real report — a "pop" when plucking a string,
// heard through three different interfaces (a USB jack cable, an M-Track
// Solo, an iRig), on a clean sound. Three interfaces agreeing points at
// software, and the only thing this app puts IN SERIES on a clean signal is
// the noise gate, so that is what this measures.
//
//   node scripts/gate_bench.js
//
// The trick is differencing: the same pluck is rendered twice, once through
// the gate and once bypassed, and the two are subtracted. A guitar note has
// its own large low-frequency body, which would swamp any naive "look for a
// step" test — the difference signal contains only what the gate itself did.
//
// It also models the IN-2 input high-pass (as a biquad, matching Web
// Audio's) so the two fixes can be measured together: the gate closing on a
// signal that still carries a DC offset is itself a source of thump, since
// gating an offset steps the output by the size of the offset.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SR = 48000;

function loadGate() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "GuitarStudio", "static", "gate-processor.js"), "utf8");
  let Registered = null;
  const sandbox = {
    sampleRate: SR,
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
    },
    registerProcessor: (name, cls) => { Registered = cls; },
    Math, Float32Array, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "gate-processor.js" });
  return Registered;
}

// RBJ biquad high-pass — the same design Web Audio's BiquadFilterNode uses,
// so this models PA.inputDcBlock rather than approximating it.
function highpass(x, f0, Q) {
  const w0 = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw = Math.cos(w0);
  const b0 = (1 + cosw) / 2, b1 = -(1 + cosw), b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

// A plucked string: near-instant attack, exponential decay, a few
// harmonics, on top of whatever hiss and DC offset the interface
// contributes. Preceded by silence, which is the case the user described —
// pluck a string after a pause, which is exactly when a gate is closed.
function makePluck({ dc = 0, noise = 1e-4, silenceSec = 1.0, noteSec = 1.5, f0 = 196 }) {
  const n = Math.floor((silenceSec + noteSec) * SR);
  const x = new Float32Array(n);
  const start = Math.floor(silenceSec * SR);
  for (let i = 0; i < n; i++) {
    let v = (Math.random() * 2 - 1) * noise;
    if (i >= start) {
      const t = (i - start) / SR;
      const env = Math.exp(-t * 2.2) * (1 - Math.exp(-t * 800));
      v += 0.35 * env * (Math.sin(2 * Math.PI * f0 * t)
                       + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t)
                       + 0.25 * Math.sin(2 * Math.PI * 3 * f0 * t));
    }
    x[i] = v + dc;
  }
  return { x, start };
}

function runGate(x, params = {}) {
  const Cls = loadGate();
  const p = new Cls();
  const q = 128;
  const out = new Float32Array(x.length);
  const inBuf = new Float32Array(q);
  const outBuf = new Float32Array(q);
  const par = {
    thresholdDb: new Float32Array([params.thresholdDb ?? -75]),
    attackMs: new Float32Array([params.attackMs ?? 2]),
    releaseMs: new Float32Array([params.releaseMs ?? 150]),
    bypass: new Float32Array([params.bypass ?? 0]),
  };
  for (let off = 0; off + q <= x.length; off += q) {
    inBuf.set(x.subarray(off, off + q));
    outBuf.fill(0);
    p.process([[inBuf]], [[outBuf]], par);
    out.set(outBuf, off);
  }
  return { out, gate: p };
}

// What the gate itself contributed, isolated by differencing against the
// bypassed render of the identical input.
function gateContribution({ dcDb, noise, dcBlock }) {
  const dc = dcDb === -Infinity ? 0 : Math.pow(10, dcDb / 20);
  let { x, start } = makePluck({ dc, noise });
  if (dcBlock) x = highpass(x, 18, 0.707); // IN-2
  const on = runGate(x).out;
  const off = runGate(x, { bypass: 1 }).out;
  let peak = 0, jump = 0;
  const w = Math.floor(0.001 * SR);
  const from = start - Math.floor(0.05 * SR);
  const to = start + Math.floor(0.2 * SR);
  for (let i = from; i < to; i++) {
    peak = Math.max(peak, Math.abs(on[i] - off[i]));
    if (i + w < on.length) {
      jump = Math.max(jump, Math.abs((on[i + w] - off[i + w]) - (on[i] - off[i])));
    }
  }
  return { peak, jump };
}

function verdict(v) {
  return v > 0.01 ? "AUDIBLE POP" : v > 0.001 ? "faint" : "clean";
}

console.log("Gate defaults: threshold -75 dB, attack 2 ms, release 150 ms\n");
console.log("What the gate adds to a plucked note, over the same note bypassed.");
console.log("A step here IS the reported pop; the note's own body cancels out.\n");
console.log("  DC offset   hiss     IN-2 high-pass   worst 1ms step   verdict");
for (const dcDb of [-Infinity, -60, -40, -30]) {
  for (const dcBlock of [false, true]) {
    const r = gateContribution({ dcDb, noise: 1e-4, dcBlock });
    const label = (dcDb === -Infinity ? "none" : `${dcDb} dBFS`).padEnd(10);
    console.log(`  ${label}  1e-4     ${(dcBlock ? "on " : "off").padEnd(15)}` +
                `  ${r.jump.toFixed(5).padStart(9)}      ${verdict(r.jump)}`);
  }
}

console.log("\nDoes the gate actually close during the silent lead-in?");
console.log("(it tracks |x|, so before IN-3 any DC offset read as permanent signal)\n");
for (const dcDb of [-Infinity, -60, -40]) {
  for (const dcBlock of [false, true]) {
    const dc = dcDb === -Infinity ? 0 : Math.pow(10, dcDb / 20);
    let { x } = makePluck({ dc, noise: 1e-4 });
    if (dcBlock) x = highpass(x, 18, 0.707);
    const { gate } = runGate(x.subarray(0, Math.floor(0.9 * SR)));
    const label = (dcDb === -Infinity ? "none" : `${dcDb} dBFS`).padEnd(10);
    console.log(`  DC ${label} IN-2 ${(dcBlock ? "on " : "off")}  ->  gate gain ` +
                `${gate.gain.toFixed(4)}   ${gate.gain > 0.5 ? "HELD OPEN (not gating at all)" : "closed"}`);
  }
}
