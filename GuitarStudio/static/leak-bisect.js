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
    // ROUND 3. a), f), g), out() and k() have all now been run, and none of
    // them slowed a climb of about a gigabyte a minute. Suspending the
    // context stops every worklet and node; stopping the tracks ends capture
    // outright. That both changed nothing rules out the audio subsystem
    // entirely — it was never the cause, only the trigger — and no loop or
    // stray timer explains it either: the source has no devicechange
    // listener and no runaway interval.
    //
    // So the question is no longer "which part of the rig" but "what kind of
    // memory". LEAK.watch() answers that directly, and the two cheap
    // experiments below decide whether the page is even involved.
    plan() {
      return [
        'Everything cut so far (a, f, g, out, k) left the climb untouched at ~1GB/min,',
        'so this is not the audio path. Find out WHAT is growing instead:',
        '',
        '1. Get it climbing, then run:  LEAK.watch()',
        '   Leave it a couple of minutes and paste the [watch] lines back.',
        '   dom/opt climbing      -> DOM nodes are accumulating.',
        '   canvasPx climbing     -> canvas backing stores are.',
        '   heap climbing         -> ordinary JS after all.',
        '   ALL flat, task manager still rising -> nothing the page can see is doing',
        '   it, and the cause is below JavaScript.',
        '',
        '2. While it is climbing, press Cmd+R to reload WITHOUT enabling input.',
        '   Still climbing on the fresh page -> our code is exonerated; something in',
        '   the browser is holding on across a reload.',
        '   Stops -> it is this page after all.',
        '',
        '3. If a reload does not stop it, navigate the tab to about:blank.',
        '   Still climbing with no page loaded at all is decisive: report that and',
        '   stop testing, it is a Chrome-level problem, not ours.',
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

    // WATCH: with the context suspended and capture stopped, roughly a
    // gigabyte a minute is still going somewhere, and no amount of reading
    // the source has explained where. This stops guessing at the cause and
    // measures the category instead: whichever counter below climbs in step
    // with the task manager identifies what is actually being allocated.
    //
    // The JS heap has looked flat throughout, so a leak of this size is
    // native — and the two native pools a page can grow without touching
    // that heap are DOM nodes and canvas backing stores, both of which are
    // counted here. If every counter stays flat while the process keeps
    // growing, then nothing the page can see is responsible, and the
    // remaining suspects sit below JavaScript entirely.
    watch(seconds) {
      this.unwatch();
      const t0 = performance.now();
      const base = {};
      const snap = () => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        return {
          dom: document.querySelectorAll('*').length,
          opts: document.querySelectorAll('option').length,
          canvas: canvases.length,
          canvasPx: canvases.reduce((n, c) => n + (c.width * c.height), 0),
          heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null,
          tracks: PA.stream ? PA.stream.getTracks().filter((t) => t.readyState === 'live').length : 0,
          ctx: Audio.ctx.state,
        };
      };
      Object.assign(base, snap());
      console.log('[watch] baseline', JSON.stringify(base));
      this._watchTimer = setInterval(() => {
        const s = snap();
        const d = (k) => (typeof s[k] === 'number' ? (s[k] - base[k] >= 0 ? '+' : '') + (s[k] - base[k]) : '');
        console.log(
          `[watch] t=${((performance.now() - t0) / 1000).toFixed(0)}s ` +
          `dom=${s.dom}(${d('dom')}) opt=${s.opts}(${d('opts')}) ` +
          `canvas=${s.canvas}(${d('canvas')}) canvasPx=${(s.canvasPx / 1e6).toFixed(1)}M(${d('canvasPx')}) ` +
          `heap=${s.heapMB}MB(${d('heapMB')}) liveTracks=${s.tracks} ctx=${s.ctx}`
        );
      }, (seconds || 5) * 1000);
      return 'Watching every ' + (seconds || 5) + 's. Let it run a couple of minutes while the ' +
             'task manager climbs, then paste the lines back. LEAK.unwatch() stops it.';
    },
    unwatch() {
      if (this._watchTimer) clearInterval(this._watchTimer);
      this._watchTimer = null;
      return 'watch stopped.';
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
