#!/usr/bin/env bash
# Rebuilds GuitarStudio/static/nam.wasm from nam.zig.
#
# Toolchain: Zig (0.16.0 at the time this was written), targeting
# wasm32-freestanding with simd128, -fno-entry -rdynamic for a bare
# STANDALONE module — no Emscripten JS glue/runtime/filesystem shims, no
# libc. This has to instantiate inside AudioWorkletGlobalScope with a plain
# `WebAssembly.instantiate(bytes_or_module, {})` (empty imports object) —
# freestanding+no-entry means the module declares no imports at all, so
# there's nothing to wire up.
#
# Install (if `zig` isn't on PATH): `brew install zig`.
set -euo pipefail
cd "$(dirname "$0")"
zig build-exe nam.zig \
  -target wasm32-freestanding \
  -mcpu=generic+simd128 \
  -fno-entry -rdynamic \
  -O ReleaseFast \
  -femit-bin=../nam.wasm
echo "Built ../nam.wasm ($(stat -f%z ../nam.wasm 2>/dev/null || stat -c%s ../nam.wasm) bytes)"
