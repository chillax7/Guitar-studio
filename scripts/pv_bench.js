// How much of the real-time audio budget does ONE stretch-processor instance
// need? Same V8 the browser runs, the same worklet source file, real audio.
//
// The budget is the whole point: producing one second of output must cost
// well under one second of CPU, and every stem in the song needs its own
// slice of that same one second. Six stems at 30% each is not "a bit slow",
// it is impossible, and it comes out of the speakers as crackle and dropouts.
// Speed/Tune quality complaints have twice now turned out to be this rather
// than the algorithm, so measure here before touching the arithmetic.
//
//   node scripts/pv_bench.js <raw f32le stereo 44.1k> [label]
//
// Make the input with:
//   ffmpeg -i stem.wav -ac 2 -ar 44100 -f f32le stem.f32
//
// PV_SRC=<path>   benchmark a different copy of the worklet (e.g. the version
//                 in git HEAD, for a before/after)
// PV_PATCH='a=>b' textual substitution before evaluating, to ablate one part
//                 of the algorithm and see what it was costing. Several
//                 substitutions can be separated by ';;'. Errors if a target
//                 string is absent, so a stale ablation fails loudly instead
//                 of silently measuring the unmodified code.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SR = 44100;

function load() {
  let src = fs.readFileSync(
    process.env.PV_SRC || path.join(__dirname, '..', 'GuitarStudio', 'static', 'stretch-processor.js'),
    'utf8');
  if (process.env.PV_PATCH) {
    for (const pair of process.env.PV_PATCH.split(';;')) {
      const i = pair.indexOf('=>');
      const from = pair.slice(0, i), to = pair.slice(i + 2);
      if (!src.includes(from)) throw new Error('patch target not found: ' + from);
      src = src.split(from).join(to);
    }
  }
  let R = null;
  const sb = {
    sampleRate: SR,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } },
    registerProcessor: (n, c) => { R = c; },
    Math, Float32Array, Uint32Array, console,
  };
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'stretch-processor.js' });
  return R;
}

function run(rawPath, speed, pitchRatio, seconds) {
  const buf = fs.readFileSync(rawPath);
  const inter = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const n = inter.length / 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }

  const Cls = load();
  const p = new Cls();
  const send = (m) => p.port.onmessage({ data: m });
  send({ type: 'load', channels: [L, R] });
  send({ type: 'params', speed, pitchRatio });
  send({ type: 'transport', action: 'seek', positionSec: 20 });
  send({ type: 'transport', action: 'play' });

  const q = 128;
  const chans = [new Float32Array(q), new Float32Array(q)];
  const quanta = Math.floor((seconds * SR) / q);
  for (let i = 0; i < 400; i++) p.process([], [chans]); // warm the JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < quanta; i++) p.process([], [chans]);
  const t1 = process.hrtime.bigint();
  const cpuSec = Number(t1 - t0) / 1e9;
  const outSec = (quanta * q) / SR;
  return (cpuSec / outSec) * 100;
}

const raw = process.argv[2];
const label = process.argv[3] || '';
const cases = [[0.85, 1.0], [1.0, 1.0], [1.0, 1.0595]];
const out = cases.map(([s, pr]) => {
  const runs = [run(raw, s, pr, 6), run(raw, s, pr, 6), run(raw, s, pr, 6)];
  return { s, pr, pct: Math.min(...runs) };
});
for (const o of out) {
  console.log('  %s  speed %s pitch %s : %s%% of real-time per stem  (6 stems: %s%%)',
    label.padEnd(10), String(o.s).padEnd(5), String(o.pr).padEnd(6),
    o.pct.toFixed(1).padStart(5), (o.pct * 6).toFixed(0).padStart(4));
}
