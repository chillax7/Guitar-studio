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

  // Populated by LEAK.spy(); read by LEAK.watch().
  let spyCounts = null;
  let spyRestore = null;
  let inWatchLog = false; // stops watch's own console.log counting itself

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
    // ROUND 4. The watch settled the category. DOM, option and canvas counts
    // never moved; the JS heap only sawtoothed between about 30 and 90 MB, so
    // allocation is heavy but collection is working; and a reload stopped the
    // climb outright, which makes this page-scoped rather than a browser or
    // driver problem. Native, page-scoped, invisible to the JS heap, and
    // unaffected by suspending the context or stopping capture — that is Web
    // Audio object creation, which a suspended context does nothing to
    // prevent.
    //
    // Counting beats guessing, so spy() names the constructor being called.
    // ROUND 5. Every audio constructor counted zero across a full minute of
    // ~1GB/min growth, so the page creates no audio objects and that model
    // was wrong. Ruled out by measurement so far: the signal path, the audio
    // render thread, capture itself, the output device, DOM nodes, canvas
    // backing stores, retained JS heap, and audio object construction. Still
    // true: a reload stops it dead, so it is this page.
    //
    // What can still grow native page-scoped memory while allocating nothing
    // the JS heap retains: console retention (held messages pin everything
    // they reference), in-flight network buffers, and worklet/main-thread
    // message traffic, which is serialized natively and is not a constructor
    // call. Those are now counted, along with the timers, whose RATE is
    // itself diagnostic.
    plan() {
      return [
        'Audio construction came back at zero, so that idea is dead. This round',
        'counts console output, network calls, worklet message traffic and timers,',
        'and adds V8\'s total heap next to the used figure.',
        '',
        '  LEAK.spy()      then      LEAK.watch()',
        '',
        'Run it a minute while memory climbs, then paste the lines. Reading them:',
        '',
        '  console.* in the thousands  -> log spam; retained messages pin memory and',
        '                                 none of it shows in the JS heap.',
        '  port.postMessage racing     -> a worklet is flooding the main thread.',
        '  fetch/xhr.send racing       -> a request loop.',
        '  requestAnimationFrame much  -> more than one animation loop is running',
        '  above ~60/sec                  (60/sec is one loop, which is normal).',
        '  heap used flat, total rising -> churn is inflating V8\'s heap; the used',
        '                                 figure alone would hide that.',
        '',
        'If all of these are flat too, say so. That exhausts what the page can see,',
        'and the next step is Chrome\'s own memory breakdown rather than more of my',
        'guesses about which line is at fault.',
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

    // SPY: count every Web Audio object the page constructs.
    //
    // The watch results narrowed this a long way: DOM, option and canvas
    // counts are all exactly flat, the JS heap only sawtooths between
    // roughly 30 and 90 MB (so it is allocating hard but collecting fine),
    // and a reload stops the climb dead. Page-scoped, native, and invisible
    // to the JS heap points squarely at Web Audio, whose objects are large
    // natively while their JS wrappers are small enough to be collected —
    // which is also why suspending the context changed nothing, since a
    // suspended context still lets nodes be CREATED, and why stopping the
    // tracks did not either.
    //
    // So rather than reason about which call site might be looping, count
    // them. Whatever is being constructed thousands of times a minute is the
    // bug, and this reports it by name.
    spy() {
      if (spyCounts) return 'Already spying. LEAK.unspy() first to reset the counts.';
      spyCounts = Object.create(null);
      const bump = (k) => { spyCounts[k] = (spyCounts[k] || 0) + 1; };
      const undo = [];

      const Ctor = window.AudioContext || window.webkitAudioContext;
      const proto = Ctor.prototype;
      // Everything that mints a native audio object: createGain,
      // createBufferSource, createBuffer, createAnalyser, createConvolver,
      // createWaveShaper, createMediaStreamSource, and the rest.
      const names = [];
      for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const n of Object.getOwnPropertyNames(o)) {
          if ((/^create/.test(n) || n === 'decodeAudioData') && names.indexOf(n) === -1) names.push(n);
        }
      }
      for (const n of names) {
        let fn;
        try { fn = proto[n]; } catch (e) { continue; }
        if (typeof fn !== 'function') continue;
        undo.push([proto, n, fn]);
        proto[n] = function (...args) { bump(n); return fn.apply(this, args); };
      }

      if (window.AudioWorkletNode) {
        const Orig = window.AudioWorkletNode;
        undo.push([window, 'AudioWorkletNode', Orig]);
        window.AudioWorkletNode = function (...args) {
          bump('new AudioWorkletNode(' + args[1] + ')');
          return new Orig(...args);
        };
        window.AudioWorkletNode.prototype = Orig.prototype;
      }

      const md = navigator.mediaDevices;
      if (md) {
        for (const n of ['getUserMedia', 'enumerateDevices']) {
          const fn = md[n];
          if (typeof fn !== 'function') continue;
          undo.push([md, n, fn]);
          md[n] = function (...args) { bump('mediaDevices.' + n); return fn.apply(this, args); };
        }
      }

      // The app's own entry point, since a loop here would explain all of it.
      if (typeof window.paEnableInput === 'function') {
        const fn = window.paEnableInput;
        undo.push([window, 'paEnableInput', fn]);
        window.paEnableInput = function (...args) { bump('paEnableInput'); return fn.apply(this, args); };
      }

      // Round 5. The audio counters all came back at zero for a full minute
      // while memory climbed ~1GB/min, so the page is not constructing audio
      // objects and that model was simply wrong. What remains are the ways a
      // page can grow native, page-scoped memory WITHOUT allocating anything
      // the JS heap keeps: console retention (messages and everything they
      // reference are held, and the JS heap does not account for it),
      // in-flight network buffers, and message traffic between the audio
      // worklets and the main thread, which is serialized natively and never
      // shows up as a constructor call.
      //
      // Timers and animation frames are counted too, not because they leak
      // but because the RATE is diagnostic: requestAnimationFrame should sit
      // near 60/sec, so several hundred means several loops are running at
      // once, which would be a bug in itself.
      for (const n of ['log', 'warn', 'error', 'info', 'debug', 'trace', 'dir', 'table']) {
        const fn = console[n];
        if (typeof fn !== 'function') continue;
        undo.push([console, n, fn]);
        console[n] = function (...args) {
          if (!inWatchLog) bump('console.' + n);
          return fn.apply(this, args);
        };
      }
      if (typeof window.fetch === 'function') {
        const fn = window.fetch;
        undo.push([window, 'fetch', fn]);
        window.fetch = function (...a) { bump('fetch'); return fn.apply(this, a); };
      }
      if (window.XMLHttpRequest) {
        const P = XMLHttpRequest.prototype, fn = P.send;
        if (typeof fn === 'function') {
          undo.push([P, 'send', fn]);
          P.send = function (...a) { bump('xhr.send'); return fn.apply(this, a); };
        }
      }
      // AudioWorkletNode.port is a MessagePort, so this catches every message
      // between a worklet and the main thread in both directions.
      if (window.MessagePort) {
        const P = MessagePort.prototype, fn = P.postMessage;
        if (typeof fn === 'function') {
          undo.push([P, 'postMessage', fn]);
          P.postMessage = function (...a) { bump('port.postMessage'); return fn.apply(this, a); };
        }
      }
      for (const n of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
        const fn = window[n];
        if (typeof fn !== 'function') continue;
        undo.push([window, n, fn]);
        window[n] = function (...a) { bump(n); return fn.apply(window, a); };
      }

      spyRestore = () => { for (const [obj, n, fn] of undo) obj[n] = fn; };
      return 'Spying on ' + names.length + ' audio constructors, AudioWorkletNode, ' +
             'getUserMedia, enumerateDevices, paEnableInput, console.*, fetch/XHR, ' +
             'MessagePort.postMessage, and the timers. Run LEAK.watch() — counts appear ' +
             'on each line, busiest first.';
    },
    unspy() {
      if (spyRestore) spyRestore();
      spyRestore = null;
      spyCounts = null;
      return 'spy removed.';
    },

    // RAFSPY: name the animation loops.
    //
    // requestAnimationFrame is being called about 240 times a second on the
    // reporting machine. One loop is 60/sec, and the same app on a machine
    // that does not leak reads 120/sec — the two loops it is supposed to
    // have, app.js's tick and playalong.js's meters. Four means two extra,
    // and duplicates matter here beyond the wasted work: the meter loop
    // walks two 8192-sample analyser buffers per frame with for...of, which
    // allocates an iterator result object PER SAMPLE, so every surplus copy
    // adds roughly a million short-lived objects a second. That matches the
    // sawtoothing used heap and the total heap climbing underneath it.
    //
    // Wrapping the scheduler and keeping the stack of whoever called it
    // turns "four loops" into four named call sites.
    rafspy(seconds) {
      const secs = seconds || 5;
      const orig = window.requestAnimationFrame;
      const hist = Object.create(null);
      window.requestAnimationFrame = function (cb) {
        let st = '';
        try {
          st = (new Error().stack || '')
            .split('\n')
            .slice(1)
            // Drop this wrapper and anything else injected from the console,
            // so the first line left is the real scheduler.
            .filter((l) => !/leak-bisect|<anonymous>:|VM\d+/.test(l))
            .slice(0, 2)
            .map((l) => l.trim())
            .join('  <-  ');
        } catch (e) { st = '(no stack)'; }
        hist[st || '(unknown)'] = (hist[st || '(unknown)'] || 0) + 1;
        return orig.call(window, cb);
      };
      orig.call(window, function done() {}); // keep a frame pumping if idle
      setTimeout(() => {
        window.requestAnimationFrame = orig;
        const rows = Object.keys(hist).map((k) => [k, hist[k]]).sort((a, b) => b[1] - a[1]);
        console.log(`[rafspy] ${rows.length} distinct scheduler(s) over ${secs}s ` +
                    `(~60/sec per loop; expect 2 loops = ~${60 * secs * 2} total):`);
        for (const [k, v] of rows.slice(0, 12)) {
          console.log(`  ${v}x  (${(v / secs).toFixed(0)}/sec)  ${k}`);
        }
      }, secs * 1000);
      return `Sampling animation-frame schedulers for ${secs}s — results print when done. ` +
             `Run this on a FRESH page load (no LEAK.spy() first), or the counts double up.`;
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
          // usedJSHeapSize is what has survived the last collection; totalJSHeapSize
          // is what V8 has actually taken from the OS and mostly does not give back.
          // Used staying flat while total climbs would mean heavy churn is inflating
          // the heap even though nothing is being retained — which the used figure
          // alone cannot show.
          totalMB: performance.memory ? +(performance.memory.totalJSHeapSize / 1e6).toFixed(1) : null,
          tracks: PA.stream ? PA.stream.getTracks().filter((t) => t.readyState === 'live').length : 0,
          ctx: Audio.ctx.state,
        };
      };
      Object.assign(base, snap());
      console.log('[watch] baseline', JSON.stringify(base));
      this._watchTimer = setInterval(() => {
        const s = snap();
        const d = (k) => (typeof s[k] === 'number' ? (s[k] - base[k] >= 0 ? '+' : '') + (s[k] - base[k]) : '');
        // Busiest constructors first — a runaway one goes straight to the
        // front instead of being buried among the calls made once at startup.
        let calls = '';
        if (spyCounts) {
          const top = Object.keys(spyCounts)
            .map((k) => [k, spyCounts[k]])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
          calls = top ? `\n         calls: ${top}` : '\n         calls: (none yet)';
        }
        inWatchLog = true;
        console.log(
          `[watch] t=${((performance.now() - t0) / 1000).toFixed(0)}s ` +
          `dom=${s.dom}(${d('dom')}) opt=${s.opts}(${d('opts')}) ` +
          `canvas=${s.canvas}(${d('canvas')}) canvasPx=${(s.canvasPx / 1e6).toFixed(1)}M(${d('canvasPx')}) ` +
          `heap=${s.heapMB}/${s.totalMB}MB(${d('heapMB')}/${d('totalMB')}) ` +
          `liveTracks=${s.tracks} ctx=${s.ctx}` + calls
        );
        inWatchLog = false;
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
