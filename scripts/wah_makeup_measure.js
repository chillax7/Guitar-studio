// CH-4: measures the makeup gain the Manual Wah needs (PA_MWAH_MAKEUP_GAIN
// in playalong.js).
//
// A bandpass filter is 0dB AT its centre frequency, which makes it tempting
// to assume it needs no makeup gain at all. It does: a guitar's energy is
// spread across the spectrum, and a Q=4 band keeps only a slice of it, so
// the filtered signal is far quieter in RMS than the dry one. Without
// compensation, engaging the wah reads as "the volume dropped", which is
// not what a real wah — with its own buffer and gain stage — does.
//
// Measured rather than reasoned about, because the answer depends on the
// spectrum of actual guitar signal, not on the filter alone. Runs the real
// Web Audio BiquadFilterNode in an OfflineAudioContext (same implementation
// the rig uses, so this is not an approximation of it) over a real
// separated guitar stem, sweeping heel to toe the way a foot would, and
// reports the dry/wet RMS ratio.
//
//   node scripts/wah_makeup_measure.js [port]
//
// Needs the app running locally, since it pulls a real stem from /api/stem.
const { chromium } = require('playwright');

const PORT = process.argv[2] || '8805';

(async () => {
  const browser = await chromium.launch({
    args: ['--no-proxy-server', '--proxy-bypass-list=<-loopback>'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof State !== 'undefined' && (State.tracks || []).length, null, { timeout: 30000 });

  // Load a track through the app's own path rather than guessing at stem
  // URLs — whichever track has separated stems will do.
  const tracks = await page.evaluate(() => State.tracks.map((t) => t.name || t));
  let ready = false;
  for (const t of tracks) {
    await page.evaluate((x) => selectTrack(x), t);
    try {
      await page.waitForFunction(() => Object.keys(Audio.buffers || {}).length > 0, null, { timeout: 20000 });
      ready = true;
      break;
    } catch (e) { /* no stems for this one */ }
  }
  if (!ready) {
    console.log('  no separated track available to measure against');
    await browser.close();
    return;
  }

  const result = await page.evaluate(async () => {
    const name = Object.keys(Audio.buffers).find((n) => /guitar|other/.test(n)) ||
                 Object.keys(Audio.buffers)[0];
    const buf = Audio.buffers[name];
    if (!buf) return { error: 'no stem buffer decoded' };

    const HEEL = 350, TOE = 2200, Q = 4;
    const dur = Math.min(20, buf.duration);
    const len = Math.floor(dur * buf.sampleRate);

    const render = async (withFilter) => {
      const ctx = new OfflineAudioContext(1, len, buf.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      let node = src;
      if (withFilter) {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = Q;
        // Sweep heel -> toe -> heel across the take, logarithmically, the
        // way the pedal itself maps treadle position to frequency.
        const steps = 200;
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps) * dur;
          const tri = 1 - Math.abs((i / steps) * 2 - 1); // 0 -> 1 -> 0
          f.frequency.setValueAtTime(HEEL * Math.pow(TOE / HEEL, tri), t);
        }
        src.connect(f);
        node = f;
      }
      node.connect(ctx.destination);
      src.start();
      const out = await ctx.startRendering();
      const d = out.getChannelData(0);
      let s = 0, peak = 0;
      for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
      return { rms: Math.sqrt(s / d.length), peak };
    };

    const dry = await render(false);
    const wet = await render(true);
    const ratio = dry.rms / wet.rms;
    return {
      dry: dry.rms, wet: wet.rms, ratio, db: 20 * Math.log10(wet.rms / dry.rms),
      // Matching RMS is the right target for "does engaging it change the
      // volume", but the makeup gain multiplies peaks too — so check that a
      // level-matched wah can't drive the output into clipping on a signal
      // that was already near full scale.
      dryPeak: dry.peak, wetPeakAfterMakeup: wet.peak * ratio,
      headroomDb: 20 * Math.log10(1 / (wet.peak * ratio)),
      seconds: dur, Q, HEEL, TOE, stem: name,
    };
  });

  if (result.error) {
    console.log('  ' + result.error);
  } else {
    console.log(`  measured over ${result.seconds.toFixed(1)}s of the "${result.stem}" stem, Q=${result.Q}, ` +
                `sweep ${result.HEEL}-${result.TOE} Hz`);
    console.log(`  dry RMS ${result.dry.toFixed(6)}   wet RMS ${result.wet.toFixed(6)}`);
    console.log(`  bandpass loses ${(-result.db).toFixed(2)} dB  ->  makeup gain ${result.ratio.toFixed(2)}x`);
    console.log(`  peak with that makeup ${result.wetPeakAfterMakeup.toFixed(3)} ` +
                `(dry peak ${result.dryPeak.toFixed(3)}, ${result.headroomDb.toFixed(1)} dB of headroom left)`);
  }
  await browser.close();
})();
