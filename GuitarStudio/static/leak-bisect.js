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
    // ROUND 2. a) has now been run on the reporting machine: it silenced
    // monitoring, proving the disconnect took effect, and memory kept
    // climbing anyway. So the signal PATH is cleared, and b)/c)/d)/e) — all
    // of which only rewire that path — cannot explain it either.
    //
    // Two things survive a): the rig's worklets are still pulled every
    // quantum by the audio thread (a disconnected source does not stop
    // nodes that still reach ctx.destination), and the capture device plus
    // the output device are both still open. mic-leak-test.html never
    // rendered any audio out, only captured, so "both directions open on
    // the same interface" is a configuration it never tested.
    //
    // g) and k) below split exactly that, and each one is decisive on its
    // own rather than needing a chain of inference.
    plan() {
      return [
        'Watch this tab in Chrome task manager (Shift+Esc). Confirm it is climbing',
        'before each step, or the result means nothing.',
        '',
        'a) has already told us the signal path is not the cause, so skip b-e.',
        'Run these, ~2 min each, and stop at the first one that halts the growth:',
        '',
        '1. LEAK.f()   -- stop the meter animation loop (main thread, per frame).',
        '2. LEAK.g()   -- suspend the AudioContext: every worklet and node stops',
        '                 being pulled. This is the big split — if growth halts, the',
        '                 cause is on the audio render thread; if not, it is not audio',
        '                 processing at all. LEAK.h() resumes.',
        '3. LEAK.out() -- move playback to the system default output, off the Helix.',
        '                 The bisect page never played audio out, only captured, so',
        '                 running both directions on one interface is untested ground.',
        '4. LEAK.k()   -- stop the capture tracks outright. Ends the last thing that',
        '                 is still touching the device.',
        '',
        'Report which step (if any) stops it, and roughly how fast it was climbing.',
        'Reload the page to undo everything.',
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

    // G: nothing on the audio render thread runs while a context is
    // suspended, so this covers every worklet and node at once — gate, NAM,
    // octave, riff capture, looper, the waveshaper and the convolver —
    // without having to unpick them one at a time. Disconnecting the source
    // never stopped any of them, because they still reach ctx.destination
    // and so are still pulled every quantum with silence flowing through.
    async g() {
      await Audio.ctx.suspend();
      return 'G: AudioContext suspended (state=' + Audio.ctx.state + '). All audio processing ' +
             'has stopped. Wait ~2 min: if the growth stops, it is on the render thread; if it ' +
             'carries on, audio processing is not what is growing. LEAK.h() resumes.';
    },
    async h() {
      await Audio.ctx.resume();
      return 'H: AudioContext resumed (state=' + Audio.ctx.state + ').';
    },

    // OUT: the app monitors through the interface; the bisect page never
    // opened an output at all. That makes "capture and playback both live on
    // the same USB device" the one configuration nothing has tested yet.
    async out() {
      if (!Audio.ctx.setSinkId) return 'OUT: this Chrome cannot switch the output device.';
      const before = Audio.ctx.sinkId;
      await Audio.ctx.setSinkId('');
      return `OUT: playback moved from sink "${before || '(default)'}" to the system default. ` +
             'If the Helix was the output, it is now only capturing. Wait ~2 min.';
    },

    // K: stops capture outright — the device is no longer being read at all.
    k() {
      if (!PA.stream) return 'K: no stream to stop.';
      PA.stream.getTracks().forEach((t) => t.stop());
      return 'K: capture tracks stopped; nothing is reading the interface now. Wait ~2 min. ' +
             '(Reload to get input back.)';
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
