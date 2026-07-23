# Social Export Presets — Design Spec (VD-07)

**Status:** design spec (release-v6-spec.md §3's V6-B2). Small, S-sized,
no gate — ready to build directly.

**One-line pitch:** a **Export for...** button on each Take row
(recorder.js's `takes-list`) that runs one of three pure-ffmpeg presets
over the existing file and produces a new sibling file next to it — no
new recording pipeline, no new UI screen, just ffmpeg invocations over a
file that already exists on disk.

---

## 1. The three presets

- **9:16 (Reels/Shorts/Stories)** — vertical crop + scale. Video only;
  disabled (not shown) for an audio-only take.
- **1:1 (square feed post)** — center crop + scale. Video only, same
  restriction.
- **Normalized for web** — loudness-normalized audio only, aspect ratio
  (or audio-only format) untouched. Available for every take, video or
  audio-only — this is the one preset that also matters for an
  audio-only Rate My Take dry take someone wants to share.

**Video-vs-audio-only detection:** don't trust the file extension (a
`.webm` can be either) — `ffprobe -show_streams` the actual file
server-side and check for a video stream. The two crop presets simply
aren't offered (grayed out with a tooltip, not hidden — "no video in
this take") when there isn't one.

## 2. Crop math

Both crop presets center-crop from whatever the source's actual
dimensions are (typically 1280×720 or the resolution picked in Record
Performance's Quality dropdown, USER-MANUAL.md §5.2) rather than
assuming a fixed input size:

- **9:16:** crop width down to `height * 9/16` (centered horizontally —
  matches the existing framing-guide's own assumption that a
  seated player's face/guitar-neck line falls roughly centered, USER-
  MANUAL.md §5.2's framing-guide description), then scale to a standard
  vertical delivery size (1080×1920).
- **1:1:** crop the shorter dimension to match the longer one (centered
  both ways), scale to 1080×1080.

ffmpeg filter chain (video presets), reusing `find_ffmpeg()` exactly the
way `svc_recording_finalize`/`_ffmpeg_convert_to_wav` already do:

```
-vf "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920"   # 9:16
-vf "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080"              # 1:1
```

Audio re-encoded alongside (`-c:a aac -b:a 192k`), video re-encoded
(`-c:v libx264 -crf 20`) since a crop can't be a lossless `-c copy` the
way `svc_recording_finalize`'s remux is.

## 3. Loudness normalization ("Normalized for web")

Reuses the exact target this app already uses everywhere else
(`engine.DEFAULT_TARGET_LUFS`, -14 LUFS — the same figure the Mixer's
own Export already normalizes to, `svc_mix`) rather than inventing a
different number for "social" specifically — one consistent loudness
target across the whole app is a real, if small, honesty/consistency
win. Single-pass `loudnorm` filter is sufficient at this scale (two-pass
gets more accurate long-term integrated-loudness measurement, but a
short take clip doesn't need that precision):

```
-af "loudnorm=I=-14:TP=-1.5:LRA=11"
```

Applies to the full container (video kept, `-c:v copy` since only audio
changes) or an audio-only file (m4a/webm as-is, re-encoded through the
same filter).

## 4. Server: one new route, mirroring `svc_recording_finalize`'s own
containment + temp-file-then-replace pattern (but writing a **new**
file, never touching the original take)

```python
def svc_export_social(path: str, preset: str) -> dict:
    """preset in {"9x16", "1x1", "web_loudnorm"}. Writes a new sibling
    file (never overwrites the original take) — same containment check
    svc_recording_finalize already does."""
    target = Path(path).resolve()
    target.relative_to(PROJECT_ROOT.resolve())  # ApiError(400) on failure, same as finalize
    if not target.exists():
        raise ApiError(404, "Recording not found")

    has_video = _ffprobe_has_video_stream(target)  # new small helper, ffprobe -show_streams
    if preset in ("9x16", "1x1") and not has_video:
        raise ApiError(400, "This take has no video to crop.")

    suffix = {"9x16": "_9x16.mp4", "1x1": "_1x1.mp4", "web_loudnorm": f"_web{target.suffix}"}[preset]
    dest = target.with_name(target.stem + suffix)
    # ... build the ffmpeg cmd per §2/§3, subprocess.run, same error-
    # surfacing pattern as svc_recording_finalize (ffmpeg stderr tail on
    # failure, not a bare "failed") ...
    return {"ok": True, "path": str(dest), "filename": dest.name}
```

New POST route `/api/recording/export_social` (`{path, preset}` JSON
body), same shape as the existing `/api/recording/rename`.

## 5. Client: one new button per take row, reusing the Reveal idiom

```
<button class="take-export-btn">Export for...</button>
```

Click opens a tiny 3-option menu (9:16 / 1:1 / Normalized for web — the
two video ones disabled with a tooltip if `!has_video`, known from the
take's filename extension client-side as a fast first-pass check before
the server's own ffprobe check is the real authority). On success, the
result reuses `/api/reveal` immediately — "Exported: takename_9x16.mp4
— **Reveal in Finder**" — rather than adding a second list of derived
files to track in the UI; the export lives on disk next to the take,
discoverable the same way any other file there already is.

## 6. What this doesn't do

No batch export (one take, one preset, one click — batch operations are
already separately parked as BT-18, not folded in here). No custom crop
position/zoom controls — center-crop only, matching "small, self-
contained" scope; if center-crop turns out wrong often enough in
practice to matter, that's a real follow-up, not guessed at now. No
upload-to-platform integration (this produces a file on disk, ready for
you to upload yourself — actual platform APIs are a different, much
bigger scope than this release picked).
