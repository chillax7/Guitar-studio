# Command-line usage

This is the underlying engine (`backing_track.py`) driven directly from a
terminal — useful for scripting or batch work. Most people should use the
web app instead: see [README.md](README.md).

## Setup (once)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
brew install ffmpeg   # if not already installed
```

## Commands

### 1. Separate a track into stems

```bash
python3 backing_track.py separate path/to/song.mp3
```

Writes stems to `separated/<model>/<track_name>/*.wav` (this is the cache
used for staleness checks and to locate stems for `mix`), and also copies
them to `output/<track_name>/`, prefixed with the model name (e.g.
`htdemucs_bass.wav`, `htdemucs_6s_bass.wav`) so stems from multiple models
for the same song don't collide. Skips re-running if stems already exist
(add `--force` to redo). Warns if the source file has changed since the
stems were made.

Use the 6-stem model to also isolate guitar and piano:

```bash
python3 backing_track.py separate path/to/song.mp3 --model htdemucs_6s
```

Or use `bs_roformer_sw` instead — a newer model (via the
`audio-separator` package) with much better guitar-stem quality than
`htdemucs_6s` (benchmarked ~9 dB vs. ~2.6 dB SDR on guitar specifically;
see
[research/guitar-separation-upgrade-spec.md](research/guitar-separation-upgrade-spec.md)).
Produces the same 6 stems. Kept alongside `htdemucs_6s`, not replacing it,
so you can A/B the two on the same song — both get cached under
`separated/<model>/` and copied into `output/<track>/` with a model-name
prefix so nothing collides:

```bash
python3 backing_track.py separate path/to/song.mp3 --model bs_roformer_sw
```

First run downloads the model checkpoint (~700 MB, one-time); subsequent runs
reuse it. Runs entirely locally like Demucs — no cloud dependency.

### 2. List the stems for a track

```bash
python3 backing_track.py list path/to/song.mp3 [--model htdemucs_6s]
```

### 3. Experimental: split guitar into center/sides proxies

```bash
python3 backing_track.py split-guitar path/to/song.mp3
```

Splits the `guitar` stem (from `htdemucs_6s`) by stereo panning into
`guitar_center.wav` (content mixed dead-center) and `guitar_sides.wav`
(content that's hard-panned/stereo-spread). This is a heuristic, not a
real lead/rhythm separation model — it only works to the extent a track
was actually mixed with one part centered and the other panned. Both
derived stems become usable in `mix` immediately, alongside the original
`guitar` stem (don't mix all three together, or you'll triple up the
guitar content).

Four split algorithms are available via `--method`:

- `spectral` (default) — estimates how centered vs. panned each
  time/frequency bin is, and weights the center/sides split per-bin. Can
  separate mixes where panning is partial or inconsistent across the
  frequency range.
- `midside` — the original blunt version: one fixed 50/50 mid/side split
  applied across the whole track. Simpler, but can't adapt if the panning
  isn't clean and consistent throughout.
- `hybrid` — `spectral`, sharpened using how tightly the guitar's note
  onsets line up with the song's detected beat grid (Option D in
  research/guitar-separation-upgrade-spec.md). No ML, no lead/rhythm
  classification — it reuses the existing tempo/beat-tracking output to
  push the per-bin center/sides weighting further toward whichever side
  the panning read already favors during rhythmically-regular
  (strummed/chordal) passages. Falls back to plain `spectral` when there's
  no beat grid to work with (no drums stem, or beat tracking failed).
- `coherent` — for the case where `spectral`'s center output is already a
  clean lead but its sides output still has strong lead bleed in it.
  Instead of guessing from panning alone, it takes `spectral`'s own center
  estimate and cancels it out of the ORIGINAL left/right channels using a
  local phase-coherent (complex-valued) gain, so content is only removed
  where it's genuinely explained by the center signal rather than merely
  as loud as it. Unlike the other three, its "sides" output is real
  independent stereo — each channel is cancelled separately — not a
  synthesized L/-R pair. Worth trying whenever another method's sides
  output still sounds like the lead is mixed in under the rhythm part.

It prints an inter-channel correlation figure, but in testing across 5
real songs this **did not reliably predict** which tracks would split
well — the lowest-correlation track failed while the highest-correlation
one worked. Treat it as informational only; judge each track by listening
to both `guitar_center` and `guitar_sides`.

```bash
python3 backing_track.py split-guitar path/to/song.mp3 --method midside
```

### 4. Mix down a backing track

A bare output filename (no `/`) is placed under `output/<track_name>/`
automatically, alongside that song's stems — e.g. `-o backing_track.wav`
for "song.mp3" writes to `output/song/backing_track.wav`. Give a path
containing `/` to override this and write somewhere else.

Mute whole stems:

```bash
python3 backing_track.py mix path/to/song.mp3 --mute vocals,drums -o backing_track.wav
```

Or use per-stem linear gain instead of a hard mute (`1.0` = unity, `0` = silent):

```bash
python3 backing_track.py mix path/to/song.mp3 --gain vocals=0,drums=0.4,other=1.2 -o backing_track.wav
```

`--gain` overrides `--mute` for any stem listed in both.

Export as MP3 (requires ffmpeg):

```bash
python3 backing_track.py mix path/to/song.mp3 --mute vocals -o backing_track.mp3
```

Control target loudness (default `-14` LUFS):

```bash
python3 backing_track.py mix path/to/song.mp3 --mute vocals --target-lufs -16 -o backing_track.wav
```

Mute a stem only during specific time ranges, instead of for the whole
track — e.g. cut just a guitar solo, leaving the guitar audible everywhere
else:

```bash
python3 backing_track.py mix path/to/song.mp3 --model htdemucs_6s --mute-range guitar=1:15-1:45 -o backing_track.wav
```

Timestamps accept `M:SS`, `H:MM:SS`, or raw seconds. Repeat the stem for
multiple ranges (e.g. two solos):

```bash
python3 backing_track.py mix path/to/song.mp3 --model htdemucs_6s --mute-range "guitar=1:15-1:45,guitar=3:00-3:20" -o backing_track.wav
```

Each cut gets a short (~30ms) fade in/out so it doesn't click.

### 5. Score a take against the song's guitar

The CLI side of the app's Rate My Take feature — compares a dry (unamped,
un-effected) recording of you playing against the song's own separated
guitar stem, beat by beat, and reports how close you got on pitch and
timing.

```bash
python3 backing_track.py rate path/to/my-take.wav path/to/song.mp3
```

The song needs to have been separated first (the guitar stem is what it
scores against). `take` is your recording; `song` is the original file,
used only to find that stem.

The one flag that matters most is `--offset`: the song-time, in seconds,
that your take's very first sample lines up with. If you started
recording 30 seconds into the song, that's `--offset 30`. Get this wrong
and every beat is compared against the wrong part of the song, which
reads as a uniformly terrible score rather than an obvious error:

```bash
python3 backing_track.py rate my-take.wav song.mp3 --offset 30
```

`--offset-search N` searches ±N seconds around your stated offset for a
better alignment and uses it when the match is confident enough,
reporting what it picked. Useful when you know roughly but not exactly
where you came in:

```bash
python3 backing_track.py rate my-take.wav song.mp3 --offset 30 --offset-search 2
```

Other flags: `--stem` (reference stem, default `guitar`), `--model` (which
separation's stems to score against), and `--out` (where to write the
per-beat heatmap PNG).

## Flags reference

| Flag | Commands | Meaning |
|---|---|---|
| `--model` | separate, list, mix, split-guitar, rate | Demucs model (`htdemucs`, `htdemucs_ft`, `htdemucs_6s`, `mdx`, `mdx_extra`) or the `audio-separator` model `bs_roformer_sw` (better guitar-stem quality). Default `bs_roformer_sw`, except `split-guitar`, which defaults to `htdemucs_6s`. |
| `--force` | separate | Re-run separation even if stems already exist |
| `--mute` | mix | Comma-separated stems to silence, e.g. `vocals,drums` |
| `--gain` | mix | Comma-separated `stem=value` linear gain overrides, e.g. `drums=0.4,other=1.2` |
| `--mute-range` | mix | Comma-separated `stem=start-end` time ranges to mute within, e.g. `guitar=1:15-1:45`. Repeat the stem for multiple ranges. |
| `--target-lufs` | mix | Target integrated loudness for the export (default `-14`) |
| `-o, --output` | mix | Output path, `.wav` or `.mp3` |
| `--stem` | split-guitar, rate | Stem to split, or to score against (default `guitar`) |
| `--method` | split-guitar | Split algorithm: `spectral` (default, per-frequency-bin), `midside` (whole-track, blunt), `hybrid` (`spectral` sharpened by beat-grid onset alignment), or `coherent` (cancels `spectral`'s center estimate out of the original channels — best when another method's sides output still has lead bleed) |
| `--offset` | rate | Song-time in seconds that the take's first sample lines up with (default `0`) |
| `--offset-search` | rate | Search ±N seconds around `--offset` for a better alignment, and use it if the match is confident (default `0` = off) |
| `--out` | rate | Where to write the per-beat heatmap PNG |

## Notes

- Valid stem names depend on `--model` — run `list` to see what's available for a given track/model.
- Stems are cached by filename under `separated/`; re-separating an edited file with the same name requires `--force` (the tool will warn you if it detects the source changed).
- `output/<track_name>/` is meant as a one-stop folder per song: it holds a copy of every stem you've separated (model-prefixed) plus every mix you've exported for that song. `separated/` remains the source of truth `mix` actually reads from — `output/` is just for browsing/listening.
