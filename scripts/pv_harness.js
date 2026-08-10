// Runs the REAL stretch-processor.js worklet code offline, in Node, over real
// audio, so Speed/Tune artifacts can be measured rather than guessed at — and
// so a change to that file can be proved to leave the output alone (render
// the same passage through the old and new copies via PV_SRC and difference
// them).
//
//   node scripts/pv_harness.js <in.f32> <speed> <startSec> <durSec> <out.f32> [pitchRatio]
//
// Raw files are f32le, stereo interleaved, 44.1k, both in and out:
//   ffmpeg -i stem.wav -ac 2 -ar 44100 -f f32le stem.f32
//   ffmpeg -f f32le -ar 44100 -ac 2 -i out.f32 out.wav
//
// PV_SRC / PV_PATCH work exactly as in pv_bench.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 44100;

function loadProcessor() {
  let src = fs.readFileSync(
    process.env.PV_SRC || path.join(__dirname, '..', 'GuitarStudio', 'static', 'stretch-processor.js'), 'utf8');
  if (process.env.PV_PATCH) {
    for (const pair of process.env.PV_PATCH.split(';;')) {
      const i = pair.indexOf('=>');
      const from = pair.slice(0, i), to = pair.slice(i + 2);
      if (!src.includes(from)) throw new Error('patch target not found: ' + from);
      src = src.split(from).join(to);
    }
  }
  let Registered = null;
  const sandbox = {
    sampleRate: SR,
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
    },
    registerProcessor: (name, cls) => { Registered = cls; },
    Math, Float32Array, Uint32Array, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'stretch-processor.js' });
  return Registered;
}

function makeInstance(Cls) {
  // The real class assigns this.port.onmessage in its constructor; give it a
  // port object that just records the handler so we can post into it.
  return new Cls();
}

function main() {
  const [rawPath, speedStr, startStr, durStr, outPath, prStr] = process.argv.slice(2);
  const pitchRatio = prStr ? parseFloat(prStr) : 1.0;
  const speed = parseFloat(speedStr);
  const startSec = parseFloat(startStr);
  const durSec = parseFloat(durStr);

  const buf = fs.readFileSync(rawPath);
  const inter = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const nFrames = inter.length / 2;
  const L = new Float32Array(nFrames), R = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }

  const Cls = loadProcessor();
  const p = makeInstance(Cls);

  // Instrumentation: count the paths that break phase continuity.
  const send = (m) => p.port.onmessage({ data: m });
  const stats = { onset: 0, passthrough: 0, hops: 0, silentHops: 0, gapResets: 0, limited: 0 };
  for (const ch of p.channels) {
    const orig = ch.processSpectrum.bind(ch);
    ch.processSpectrum = function (re, im, oRe, oIm, Ha) {
      const had = this.haveState;
      orig(re, im, oRe, oIm, Ha);
      stats.hops++;
      if (!had) stats.passthrough++;
      else {
        // recompute the onset decision cheaply: passthrough writes out === in
        let same = true;
        for (let k = 0; k < 64; k++) if (oRe[k] !== re[k]) { same = false; break; }
        if (same) stats.onset++;
      }
    };
  }

  send({ type: 'load', channels: [L, R] });
  send({ type: 'params', speed, pitchRatio });
  send({ type: 'transport', action: 'seek', positionSec: startSec });
  send({ type: 'transport', action: 'play' });

  const outFrames = Math.floor((durSec / speed) * SR);
  const outL = new Float32Array(outFrames), outR = new Float32Array(outFrames);
  const q = 128;
  const chans = [new Float32Array(q), new Float32Array(q)];
  let w = 0;
  while (w < outFrames) {
    chans[0].fill(0); chans[1].fill(0);
    p.process([], [chans]);
    const n = Math.min(q, outFrames - w);
    outL.set(chans[0].subarray(0, n), w);
    outR.set(chans[1].subarray(0, n), w);
    w += n;
  }

  const out = new Float32Array(outFrames * 2);
  for (let i = 0; i < outFrames; i++) { out[2 * i] = outL[i]; out[2 * i + 1] = outR[i]; }
  fs.writeFileSync(outPath, Buffer.from(out.buffer));

  stats.silentHops = 0;
  console.log(JSON.stringify({ speed, startSec, durSec, outFrames, stats }));
}

main();
