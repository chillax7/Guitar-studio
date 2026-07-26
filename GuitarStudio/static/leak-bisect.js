"use strict";

// In-app bisect for the "enabling the Helix makes this tab's memory climb
// until Chrome dies" report. Load it from the app's console with:
//
//     fetch('/leak-bisect.js').then(r => r.text()).then(eval)
//
// then follow LEAK.plan().
//
// Why this exists rather than more guessing: mic-leak-test.html established
// that raw capture, an AudioContext with a MediaStreamSource, per-frame
// analyser reads and a gate worklet are ALL clean with the real interface —
// while the app, doing the same things plus its rig, is not. So the cause
// is somewhere in the rig, and the fastest way to find it is to keep
// halving the live graph until the growth stops.
//
// Every step below only disconnects things. Nothing is created, no settings
// are written, and reloading the page undoes all of it.

(() => {
  const riff = () => (typeof riffCaptureNode !== 'undefined' ? riffCaptureNode : null);

  window.LEAK = {
    plan() {
      return [
        'Watch the Memory footprint of this tab in Chrome task manager (Shift+Esc).',
        'Confirm it is climbing BEFORE cutting anything, or the results mean nothing.',
        '',
        '1. LEAK.info()  -- device + rig facts, no change. Send me this.',
        '2. LEAK.a()     -- cut the input off the whole graph. Wait ~2 min.',
        '     still climbing -> the audio graph is NOT the cause; stop here and tell me.',
        '     stopped        -> it is downstream of the input; continue.',
        '3. LEAK.b()     -- input -> meters analyser only. Wait ~2 min.',
        '4. LEAK.c()     -- input -> rig chain only. Wait ~2 min.',
        '     whichever of b/c climbs contains the cause.',
        '5. If c) climbs, reload the page, re-enable input, then try',
        '   LEAK.d() (riff capture) and LEAK.e() (looper), ~2 min each.',
        '6. LEAK.f()     -- stop the meter animation loop.',
        '',
        'LEAK.restore() puts the signal path back. Reload the page to undo d/e.',
      ].join('\n');
    },

    // Facts only — changes nothing. The channel count here is the number I
    // have never been able to see from my side: a multichannel USB interface
    // widens every node downstream of it, because PA.gateNode is built with
    // channelCountMode "max".
    info() {
      const t = PA.stream && PA.stream.getAudioTracks()[0];
      return {
        ctxRate: Audio.ctx.sampleRate,
        ctxBaseLatency: Audio.ctx.baseLatency,
        ctxState: Audio.ctx.state,
        track: t ? t.getSettings() : null,
        sourceChannels: PA.source ? PA.source.channelCount : null,
        gateChannels: PA.gateNode ? PA.gateNode.channelCount : null,
        gateMode: PA.gateNode ? PA.gateNode.channelCountMode : null,
        namLoaded: PA.namLoaded || null,
        irLoaded: PA.irLoaded || null,
        looperState: PA.looperState,
        riffRunning: !!riff(),
        meterRafRunning: !!PA.meterRaf,
      };
    },

    // A: cut the live signal off everything at once. This is the single most
    // informative step — it separates "something in the audio graph grows"
    // from "something else entirely grows and the input merely coincides
    // with it", and those two lead to completely different investigations.
    a() {
      PA.source.disconnect();
      return 'A: input disconnected from the entire graph. Wait ~2 min, then report climbing or not.';
    },

    // B and C split what A cut into its two halves.
    b() {
      PA.source.disconnect();
      PA.source.connect(PA.inAnal);
      return 'B: input -> meters/tuner analyser ONLY (rig chain cut). Wait ~2 min.';
    },
    c() {
      PA.source.disconnect();
      PA.source.connect(PA.gateNode);
      return 'C: input -> rig chain ONLY (analyser cut). Wait ~2 min.';
    },

    // D and E: the two worklets that start running as soon as the rig exists
    // and keep running whether or not you ever press their buttons, which
    // makes them easy to overlook as always-on work.
    d() {
      const r = riff();
      if (!r) return 'D: riff capture is not running — nothing to cut.';
      r.disconnect();
      return 'D: riff-capture worklet disconnected. Wait ~2 min. (Reload to undo.)';
    },
    e() {
      if (!PA.looperNode) return 'E: looper is not running — nothing to cut.';
      PA.looperNode.disconnect();
      return 'E: looper worklet disconnected. Wait ~2 min. (Reload to undo.)';
    },

    // F: the requestAnimationFrame loop that reads both analysers and writes
    // the meter widths every frame.
    f() {
      if (PA.meterRaf) cancelAnimationFrame(PA.meterRaf);
      PA.meterRaf = null;
      return 'F: meter animation loop stopped. Wait ~2 min.';
    },

    restore() {
      try { PA.source.disconnect(); } catch (e) { /* already disconnected */ }
      PA.source.connect(PA.gateNode);
      PA.source.connect(PA.inAnal);
      if (!PA.meterRaf) paStartMeters();
      return 'Restored the signal path and meters. If you ran d) or e), reload the page to bring ' +
             'riff capture and the looper back — this cannot reconnect them from outside.';
    },
  };

  return 'LEAK ready — run LEAK.plan() for the sequence.';
})()
