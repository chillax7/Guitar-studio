alphaTab 1.8.4 (https://www.alphatab.net/), self-hosted rather than loaded
from a CDN, matching this app's local-first design — see README.md.

Vendored files (from the @coderline/alphatab npm package's dist/ folder):
  - alphaTab.min.mjs        MPL-2.0 (LICENSE.txt) — the small "main thread"
                            entry point tabview.js actually imports.
  - alphaTab.core.mjs       Same license — alphaTab.min.mjs's own real
                            dependency (a relative "./alphaTab.core.mjs"
                            import baked into the published file). Not
                            minified even from the "min" wrapper in this
                            package version — that's how upstream ships it,
                            not a mistake made vendoring it here.
  - alphaTab.worker.mjs,
    alphaTab.worklet.mjs    Tiny (~1.6KB each) — alphaTab's Environment
                            init registers factories that construct these
                            by a hardcoded relative URL if a rendering
                            worker / real-time audio worklet ever actually
                            gets used, regardless of core.useWorkers.
                            Vendored for safety rather than betting on
                            never hitting that path with core.useWorkers=
                            false (single-threaded rendering, set in
                            tabview.js's alphaTab settings).
  - font/Bravura.woff2      SIL OFL 1.1 (font/Bravura-OFL.txt) — music notation glyphs
  - soundfont/
      FluidR3Mono_GM.sf3    MIT (soundfont/LICENSE.txt) — browser-side MIDI
                            playback for Tab View's tab-notation synth.
                            Not from the alphatab npm package (which only
                            ships the much lower-quality Sonivox EAS font
                            this replaced) — pulled from the @librescore/sf3
                            npm package instead (npm registry only, no CDN,
                            matching this app's local-first policy), which
                            bundles the same FluidR3Mono/MuseScore_General/
                            TimGM6mb fonts MuseScore itself ships. Renamed
                            from its upstream ".sf3.wasm" (a naming trick
                            for CDN Brotli compression, not real wasm bytecode
                            — the file itself is a plain RIFF/sfbk SoundFont2
                            binary either way) back to a plain ".sf3".
