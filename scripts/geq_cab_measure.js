// GEQ-2: renders the graphic EQ's real filter chain and prints the curve it
// produces, so the "Guitar cab" preset can be checked against what a speaker
// cabinet actually does instead of against a table someone wrote down.
//
//   node scripts/geq_cab_measure.js [port]
//
// Needs the app running locally — it uses the page's own Web Audio
// implementation (BiquadFilterNode.getFrequencyResponse) rather than
// reimplementing the filters, so what it plots is what you will hear.
//
// What a guitar cab actually looks like, and what this is checked against:
//   - nothing much below ~80 Hz
//   - a resonance bump of a few dB around 100-130 Hz
//   - reasonably flat mids, often slightly hollow at 400-800 Hz
//   - a presence peak of a few dB at 2-3 kHz
//   - a CLIFF from ~4.5 kHz: 15-25 dB down by 8 kHz and still falling
// The cliff is the part a graphic EQ cannot do on its own, which is why the
// EQ has cut filters as well as bands.
const { chromium } = require('playwright');

const PORT = process.argv[2] || '8808';

(async () => {
  const browser = await chromium.launch({
    args: ['--no-proxy-server', '--proxy-bypass-list=<-loopback>'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => ensurePAGraph());
  await page.waitForTimeout(400);

  // The cut filters move with setTargetAtTime (so switching them can't
  // click), which means their frequency is still travelling for tens of
  // milliseconds after the button is pressed. Reading the response during
  // that ramp measures a filter that is halfway to where it is going — the
  // first version of this script did exactly that and reported a lowpass at
  // 4.5kHz passing 12kHz at full level.
  await page.evaluate(async () => {
    if (Audio.ctx.state === 'suspended') await Audio.ctx.resume();
    document.getElementById('pa-geq-cab-btn').click();
  });
  await page.waitForTimeout(600);

  const curve = await page.evaluate(() => {

    const freqs = new Float32Array([
      31, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
      1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
    ]);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    const total = new Float64Array(freqs.length).fill(1);

    const accumulate = (node) => {
      node.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < freqs.length; i++) total[i] *= mag[i];
    };
    for (const f of PA.geqLowCut) accumulate(f);
    for (const f of Object.values(PA.geqNodes)) accumulate(f);
    for (const f of PA.geqHighCut) accumulate(f);

    return {
      freqs: Array.from(freqs),
      db: Array.from(total, (m) => 20 * Math.log10(m)),
      settings: {
        lowCut: document.getElementById('pa-geq-lowcut').value,
        highCut: document.getElementById('pa-geq-highcut').value,
        bypass: document.getElementById('pa-geq-bypass').checked,
        // Read back what the filters ACTUALLY settled on, not what was
        // requested — if these don't match the selects, the ramp hadn't
        // finished and every number below is wrong.
        settledLowCut: PA.geqLowCut[0].frequency.value,
        settledHighCut: PA.geqHighCut[0].frequency.value,
      },
    };
  });

  console.log(`  "Guitar cab" preset: low cut ${curve.settings.lowCut} Hz, ` +
              `high cut ${curve.settings.highCut} Hz, bypass ${curve.settings.bypass}`);
  console.log(`  filters settled at: ${curve.settings.settledLowCut.toFixed(0)} Hz / ` +
              `${curve.settings.settledHighCut.toFixed(0)} Hz\n`);
  const peak = Math.max(...curve.db);
  for (let i = 0; i < curve.freqs.length; i++) {
    const f = curve.freqs[i];
    const db = curve.db[i];
    const rel = db - peak;
    const bar = '#'.repeat(Math.max(0, Math.round((rel + 40) / 1.4)));
    console.log(`  ${String(f).padStart(6)} Hz  ${db.toFixed(1).padStart(7)} dB  ${bar}`);
  }

  const at = (f) => curve.db[curve.freqs.indexOf(f)];
  console.log('\n  checks against a real cab\'s shape:');
  const checks = [
    // Measured against the cab's own bass resonance rather than the overall
    // peak: "how much less 50 Hz than the thump the box makes" is the
    // musically meaningful comparison, and it doesn't move when the presence
    // peak is retuned.
    ['sub-bass well below the 125 Hz resonance', at(50) - at(125) < -14,
      `${(at(50) - at(125)).toFixed(1)} dB below 125 Hz`],
    ['cabinet resonance around 100-125 Hz', at(125) - peak > -6, `${(at(125) - peak).toFixed(1)} dB`],
    ['presence peak at 2.5-3.15 kHz', at(3150) >= at(1000), `${(at(3150) - at(1000)).toFixed(1)} dB over 1 kHz`],
    ['cliff has started by 5 kHz', at(5000) - peak < -6, `${(at(5000) - peak).toFixed(1)} dB`],
    ['well down by 8 kHz', at(8000) - peak < -15, `${(at(8000) - peak).toFixed(1)} dB`],
    ['still falling at 16 kHz (a bell would come back up)', at(16000) < at(8000) - 12,
      `${at(16000).toFixed(1)} vs ${at(8000).toFixed(1)} dB`],
  ];
  let fails = 0;
  for (const [name, ok, extra] of checks) {
    if (!ok) fails++;
    console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}  (${extra})`);
  }
  // Level check. A cab curve that is 6dB louder than bypass isn't usable as
  // a "click this" preset — you'd retune the whole rig around it. Weighted
  // by 1/f, which approximates how a guitar's energy is distributed across
  // the spectrum far better than treating every band as equally loud.
  let num = 0, den = 0;
  for (let i = 0; i < curve.freqs.length; i++) {
    const w = 1 / curve.freqs[i];
    num += w * Math.pow(10, curve.db[i] / 10);
    den += w;
  }
  const broadband = 10 * Math.log10(num / den);
  console.log(`\n  broadband level change vs bypass: ${broadband >= 0 ? '+' : ''}${broadband.toFixed(1)} dB` +
              ` (1/f-weighted)  ${Math.abs(broadband) < 3 ? 'OK' : 'NEEDS MAKEUP'}`);
  if (Math.abs(broadband) >= 3) fails++;

  console.log(fails ? `\n  ${fails} FAILED` : '\n  curve matches a cab\'s shape');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
