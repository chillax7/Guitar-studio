// NAM WaveNet forward-pass inference core, WASM/SIMD port of the JS engine
// in nam-processor.js (processLayerArrayBlock / forwardBlock). Mirrors that
// JS exactly, operand for operand — see nam-processor.js's file header for
// the provenance of the math itself (reverse-engineered from
// sdatkinson/NeuralAmpModelerCore C++). This file only changes WHERE the
// math runs (WASM linear memory, SIMD dot products) not WHAT it computes.
//
// Memory model: this module owns one exported linear `memory`. JS lays out
// every weight matrix, bias vector, ring-history buffer and scratch buffer
// for a model by calling `allocBytes()` repeatedly (a simple bump
// allocator whose base is self-discovered via a Zig global's address, so
// it never collides with Zig's own stack/statics — no hardcoded offsets),
// then writes a "layout table" of the resulting byte offsets, then calls
// `resetArena()`+rebuilds on the next model load (arena is fully reused,
// not leaked, since only ever one or two models are live at a time).
//
// `forward()` walks that layout table and reproduces
// processLayerArrayBlock/forwardBlock's control flow exactly: rechannel,
// head-accumulator carry, per-dilation-layer conv+gate+1x1+residual with
// ping-ponged block buffers, head rechannel, and a final unscaled head-tap
// copy to `outPtr` (headScale and everything downstream — DC blocker,
// gain, bypass — stays in JS, this module is only the WaveNet core).

// ---------------------------------------------------------------------------
// Arena allocator
// ---------------------------------------------------------------------------

var heap_base_marker: u8 = 0;
var bump_ptr: u32 = 0;

fn align4(x: u32) u32 {
    return (x + 3) & ~@as(u32, 3);
}

export fn resetArena() void {
    bump_ptr = align4(@intFromPtr(&heap_base_marker));
}

export fn allocBytes(n: u32) u32 {
    const nAligned = align4(n);
    const needed_end = bump_ptr + nAligned;
    const cur_bytes: u32 = @as(u32, @intCast(@wasmMemorySize(0))) * 65536;
    if (needed_end > cur_bytes) {
        const extra_bytes = needed_end - cur_bytes;
        const extra_pages: u32 = @intCast((extra_bytes + 65535) / 65536);
        _ = @wasmMemoryGrow(0, extra_pages);
    }
    const off = bump_ptr;
    bump_ptr = needed_end;
    return off;
}

export fn heapBaseDbg() u32 {
    return align4(@intFromPtr(&heap_base_marker));
}

// ---------------------------------------------------------------------------
// Pointer helpers (all "pointers" that cross the JS/Zig boundary are plain
// byte offsets into the shared linear memory)
// ---------------------------------------------------------------------------

fn f32p(off: u32) [*]f32 {
    return @as([*]f32, @ptrFromInt(off));
}
fn i32p(off: u32) [*]i32 {
    return @as([*]i32, @ptrFromInt(off));
}

// Scratch buffers for the per-layer z/activated arrays, module-level statics
// rather than function locals: real standard-architecture .nam captures
// have convOutCh/bottleneck well under these caps (channels/bottleneck in
// the tens, not hundreds), and keeping them as statics (laid out by the
// linker before heap_base_marker, so resetArena()'s self-discovered arena
// base still lands after them) avoids repeated large-stack-frame setup in
// the innermost hot loop, which runs once per WaveNet layer per block.
var g_z: [128 * 512]f32 = undefined;
var g_activated: [128 * 256]f32 = undefined;

// ---------------------------------------------------------------------------
// SIMD dot product — the shared hot primitive for every matVec row in the
// network (rechannel, conditioning mix-in, dilated-conv taps, 1x1 + head
// rechannel all reduce to "row of weights . contiguous input vector").
// ---------------------------------------------------------------------------

fn dot(a: [*]const f32, b: [*]const f32, len: u32) f32 {
    var i: u32 = 0;
    var accv: @Vector(4, f32) = @splat(0.0);
    while (i + 4 <= len) : (i += 4) {
        const av: @Vector(4, f32) = a[i..][0..4].*;
        const bv: @Vector(4, f32) = b[i..][0..4].*;
        accv += av * bv;
    }
    var acc: f32 = @reduce(.Add, accv);
    while (i < len) : (i += 1) {
        acc += a[i] * b[i];
    }
    return acc;
}

// ---------------------------------------------------------------------------
// Activations — bit-for-bit the same formulas as nam-processor.js
// ---------------------------------------------------------------------------

fn fastTanh(x: f32) f32 {
    if (x > 3.0) return 1.0;
    if (x < -3.0) return -1.0;
    const x2 = x * x;
    return (x * (27.0 + x2)) / (27.0 + 9.0 * x2);
}
fn sigmoidF(x: f32) f32 {
    return 0.5 * (fastTanh(0.5 * x) + 1.0);
}
fn softsignF(x: f32) f32 {
    return x / (1.0 + @abs(x));
}
fn reluF(x: f32) f32 {
    return if (x > 0.0) x else 0.0;
}
// activation codes: 0=tanh(fast) 1=sigmoid 2=softsign 3=relu 4=identity
fn activate(code: i32, x: f32) f32 {
    return switch (code) {
        0 => fastTanh(x),
        1 => sigmoidF(x),
        2 => softsignF(x),
        3 => reluF(x),
        else => x,
    };
}

// ---------------------------------------------------------------------------
// Layout table field indices (word offsets; all "ptr" fields are byte
// offsets into linear memory). Kept in sync with buildModelWasm() in
// nam-wasm-bridge.js — see that file for the authoritative field list.
// ---------------------------------------------------------------------------

const LA_CHANNELS: u32 = 0;
const LA_BOTTLENECK: u32 = 1;
const LA_CONDSIZE: u32 = 2;
const LA_INPUTSIZE: u32 = 3;
const LA_HEADSIZE: u32 = 4;
const LA_GATED: u32 = 5;
const LA_ACT: u32 = 6;
const LA_NUMLAYERS: u32 = 7;
const LA_HEADOUTSIZE: u32 = 8;
const LA_RECHAN_W: u32 = 9;
const LA_HEAD_MAT: u32 = 10;
const LA_HEAD_BIAS: u32 = 11;
const LA_LAYERS_PTR: u32 = 12;
const LA_BLKA: u32 = 13;
const LA_BLKB: u32 = 14;
const LA_HEADACCUM: u32 = 15;
const LA_HEADOUT: u32 = 16;
const LA_STRIDE: u32 = 18;

const LY_DIL: u32 = 0;
const LY_K: u32 = 1;
const LY_CONVOUTCH: u32 = 2;
const LY_CONVMATS: u32 = 3;
const LY_CONVBIAS: u32 = 4;
const LY_MIXINW: u32 = 5;
const LY_L1X1W: u32 = 6;
const LY_L1X1B: u32 = 7;
const LY_HISTBUF: u32 = 8;
const LY_HISTLEN: u32 = 9;
const LY_HISTPOS: u32 = 10;
const LY_STRIDE: u32 = 11;

// ---------------------------------------------------------------------------
// Forward pass
// ---------------------------------------------------------------------------

// n <= MAX_BLOCK. condPtr/outPtr are float32 buffers of n samples.
export fn forward(modelPtr: u32, condPtr: u32, outPtr: u32, n: u32) void {
    const hdr = i32p(modelPtr);
    const numLA: u32 = @intCast(hdr[0]);
    const laBase = modelPtr + 4;
    const outBuf = f32p(outPtr);

    var curBlockPtr: u32 = condPtr;
    var prevHeadPtr: u32 = 0;
    var prevHeadSize: u32 = 0;
    var lastHeadPtr: u32 = 0;
    var lastHeadSize: u32 = 1;

    var la_i: u32 = 0;
    while (la_i < numLA) : (la_i += 1) {
        const laOff = laBase + la_i * LA_STRIDE * 4;
        const la = i32p(laOff);
        const channels: u32 = @intCast(la[LA_CHANNELS]);
        const bottleneck: u32 = @intCast(la[LA_BOTTLENECK]);
        const condSize: u32 = @intCast(la[LA_CONDSIZE]);
        const inputSize: u32 = @intCast(la[LA_INPUTSIZE]);
        const headSize: u32 = @intCast(la[LA_HEADSIZE]);
        const gated: bool = la[LA_GATED] != 0;
        const actCode: i32 = la[LA_ACT];
        const numLayers: u32 = @intCast(la[LA_NUMLAYERS]);
        const headOutSize: u32 = @intCast(la[LA_HEADOUTSIZE]);
        const rechanW = f32p(@intCast(la[LA_RECHAN_W]));
        const headMat = f32p(@intCast(la[LA_HEAD_MAT]));
        const headBias = f32p(@intCast(la[LA_HEAD_BIAS]));
        const layersPtr: u32 = @intCast(la[LA_LAYERS_PTR]);
        var blkA = f32p(@intCast(la[LA_BLKA]));
        const blkB = f32p(@intCast(la[LA_BLKB]));
        const headAccum = f32p(@intCast(la[LA_HEADACCUM]));
        const headOut = f32p(@intCast(la[LA_HEADOUT]));

        const inputBlock = f32p(curBlockPtr);
        const condBlock = f32p(condPtr);

        // --- Rechannel input -> blkA -------------------------------------
        {
            var t: u32 = 0;
            if (inputSize == 1) {
                while (t < n) : (t += 1) {
                    const x = inputBlock[t];
                    const base = t * channels;
                    var c: u32 = 0;
                    while (c < channels) : (c += 1) blkA[base + c] = rechanW[c] * x;
                }
            } else {
                while (t < n) : (t += 1) {
                    const inBase = t * inputSize;
                    const outBase = t * channels;
                    var c: u32 = 0;
                    while (c < channels) : (c += 1) {
                        blkA[outBase + c] = dot(rechanW + c * inputSize, inputBlock + inBase, inputSize);
                    }
                }
            }
        }

        // --- Head accumulator <- previous array's head output (or zero) --
        {
            if (prevHeadPtr != 0) {
                const headCarry = f32p(prevHeadPtr);
                const copyW: u32 = if (prevHeadSize < headOutSize) prevHeadSize else headOutSize;
                var t: u32 = 0;
                while (t < n) : (t += 1) {
                    const src = t * prevHeadSize;
                    const dst = t * headOutSize;
                    var i: u32 = 0;
                    while (i < copyW) : (i += 1) headAccum[dst + i] = headCarry[src + i];
                    i = copyW;
                    while (i < headOutSize) : (i += 1) headAccum[dst + i] = 0;
                }
            } else {
                const total = n * headOutSize;
                var i: u32 = 0;
                while (i < total) : (i += 1) headAccum[i] = 0;
            }
        }

        const condIsScalar = condSize == 1;
        var cur = blkA;
        var out = blkB;

        var ly_i: u32 = 0;
        while (ly_i < numLayers) : (ly_i += 1) {
            const lyOff = layersPtr + ly_i * LY_STRIDE * 4;
            const ly = i32p(lyOff);
            const dilation: u32 = @intCast(ly[LY_DIL]);
            const K: u32 = @intCast(ly[LY_K]);
            const convOutCh: u32 = @intCast(ly[LY_CONVOUTCH]);
            const convBias = f32p(@intCast(ly[LY_CONVBIAS]));
            const mixinW = f32p(@intCast(ly[LY_MIXINW]));
            const l1x1W = f32p(@intCast(ly[LY_L1X1W]));
            const l1x1B = f32p(@intCast(ly[LY_L1X1B]));
            const histBuf = f32p(@intCast(ly[LY_HISTBUF]));
            const histLen: u32 = @intCast(ly[LY_HISTLEN]);
            var histPos: u32 = @intCast(ly[LY_HISTPOS]);

            // Push this block into the ring history (matches RingHistory.pushBlock).
            const startIdx = histPos;
            {
                const firstChunk: u32 = if (n < histLen - startIdx) n else histLen - startIdx;
                var t: u32 = 0;
                while (t < firstChunk) : (t += 1) {
                    const src = t * channels;
                    const dst = (startIdx + t) * channels;
                    var c: u32 = 0;
                    while (c < channels) : (c += 1) histBuf[dst + c] = cur[src + c];
                }
                if (firstChunk < n) {
                    var t2: u32 = firstChunk;
                    while (t2 < n) : (t2 += 1) {
                        const src = t2 * channels;
                        const dst = (t2 - firstChunk) * channels;
                        var c: u32 = 0;
                        while (c < channels) : (c += 1) histBuf[dst + c] = cur[src + c];
                    }
                }
                histPos = (startIdx + n) % histLen;
                ly[LY_HISTPOS] = @intCast(histPos);
            }

            // z <- bias + conditioning mix-in
            const z: [*]f32 = &g_z;
            if (condIsScalar) {
                var t: u32 = 0;
                while (t < n) : (t += 1) {
                    const c0 = condBlock[t];
                    const base = t * convOutCh;
                    var i: u32 = 0;
                    while (i < convOutCh) : (i += 1) z[base + i] = convBias[i] + mixinW[i] * c0;
                }
            } else {
                var t: u32 = 0;
                while (t < n) : (t += 1) {
                    const cBase = t * condSize;
                    const base = t * convOutCh;
                    var i: u32 = 0;
                    while (i < convOutCh) : (i += 1) {
                        z[base + i] = convBias[i] + dot(mixinW + i * condSize, condBlock + cBase, condSize);
                    }
                }
            }

            // Dilated conv: k outermost so each tap matrix stays hot.
            {
                const convMatsBase: u32 = @intCast(ly[LY_CONVMATS]);
                var k: u32 = 0;
                while (k < K) : (k += 1) {
                    const mat = f32p(convMatsBase + k * convOutCh * channels * 4);
                    var idxSigned: i64 = @as(i64, startIdx) - @as(i64, dilation) * @as(i64, K - 1 - k);
                    while (idxSigned < 0) idxSigned += histLen;
                    var idx: u32 = @intCast(idxSigned);
                    var t: u32 = 0;
                    while (t < n) : (t += 1) {
                        const hBase = idx * channels;
                        const zBase = t * convOutCh;
                        var i: u32 = 0;
                        while (i < convOutCh) : (i += 1) {
                            z[zBase + i] += dot(mat + i * channels, histBuf + hBase, channels);
                        }
                        idx += 1;
                        if (idx == histLen) idx = 0;
                    }
                }
            }

            // Activation (+gate), head accumulation, 1x1 + residual.
            const activated: [*]f32 = &g_activated;
            {
                var t: u32 = 0;
                while (t < n) : (t += 1) {
                    const zBase = t * convOutCh;
                    const aBase = t * bottleneck;
                    if (gated) {
                        var i: u32 = 0;
                        while (i < bottleneck) : (i += 1) {
                            activated[aBase + i] = activate(actCode, z[zBase + i]) * sigmoidF(z[zBase + bottleneck + i]);
                        }
                    } else {
                        var i: u32 = 0;
                        while (i < bottleneck) : (i += 1) {
                            activated[aBase + i] = activate(actCode, z[zBase + i]);
                        }
                    }
                }
            }

            {
                var t: u32 = 0;
                while (t < n) : (t += 1) {
                    const aBase = t * bottleneck;
                    const hBase = t * headOutSize;
                    var i: u32 = 0;
                    while (i < headOutSize) : (i += 1) headAccum[hBase + i] += activated[aBase + i];
                }
            }

            {
                var t: u32 = 0;
                while (t < n) : (t += 1) {
                    const aBase = t * bottleneck;
                    const ioBase = t * channels;
                    var c: u32 = 0;
                    while (c < channels) : (c += 1) {
                        out[ioBase + c] = cur[ioBase + c] + l1x1B[c] + dot(l1x1W + c * bottleneck, activated + aBase, bottleneck);
                    }
                }
            }

            const tmp = cur;
            cur = out;
            out = tmp;
        }

        // --- Head rechannel ------------------------------------------------
        {
            var t: u32 = 0;
            while (t < n) : (t += 1) {
                const hBase = t * headOutSize;
                const oBase = t * headSize;
                var i: u32 = 0;
                while (i < headSize) : (i += 1) {
                    headOut[oBase + i] = headBias[i] + dot(headMat + i * headOutSize, headAccum + hBase, headOutSize);
                }
            }
        }

        curBlockPtr = @intFromPtr(cur);
        prevHeadPtr = @intFromPtr(headOut);
        prevHeadSize = headSize;
        lastHeadPtr = @intFromPtr(headOut);
        lastHeadSize = headSize;
    }

    var t: u32 = 0;
    while (t < n) : (t += 1) {
        outBuf[t] = f32p(lastHeadPtr)[t * lastHeadSize];
    }
}
