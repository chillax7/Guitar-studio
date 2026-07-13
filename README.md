# Backing Track Creator (Step 1 prototype)

CLI tool that separates a song into stems (vocals/drums/bass/other, or
guitar/piano too with the 6-stem model) using Demucs, then mixes down a
backing track with chosen stems muted or gain-adjusted.

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

Or use `bs_roformer_sw` (BT-13) instead — a newer model (via the
`audio-separator` package) with much better guitar-stem quality than
`htdemucs_6s` (benchmarked ~9 dB vs. ~2.6 dB SDR on guitar specifically; see
`research/guitar-separation-upgrade-spec.md`). Produces the same 6 stems. Kept
alongside `htdemucs_6s`, not replacing it, so you can A/B the two on the same
song — both get cached under `separated/<model>/` and copied into
`output/<track>/` with a model-name prefix so nothing collides:

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

Two split algorithms are available via `--method`:

- `spectral` (default) — estimates how centered vs. panned each
  time/frequency bin is, and weights the center/sides split per-bin. Can
  separate mixes where panning is partial or inconsistent across the
  frequency range.
- `midside` — the original blunt version: one fixed 50/50 mid/side split
  applied across the whole track. Simpler, but can't adapt if the panning
  isn't clean and consistent throughout.

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

## Flags reference

| Flag | Commands | Meaning |
|---|---|---|
| `--model` | separate, list, mix | Demucs model (`htdemucs`, `htdemucs_ft`, `htdemucs_6s`, `mdx`, `mdx_extra`) or the `audio-separator` model `bs_roformer_sw` (BT-13 — better guitar-stem quality). Default `htdemucs`. |
| `--force` | separate | Re-run separation even if stems already exist |
| `--mute` | mix | Comma-separated stems to silence, e.g. `vocals,drums` |
| `--gain` | mix | Comma-separated `stem=value` linear gain overrides, e.g. `drums=0.4,other=1.2` |
| `--mute-range` | mix | Comma-separated `stem=start-end` time ranges to mute within, e.g. `guitar=1:15-1:45`. Repeat the stem for multiple ranges. |
| `--target-lufs` | mix | Target integrated loudness for the export (default `-14`) |
| `-o, --output` | mix | Output path, `.wav` or `.mp3` |
| `--stem` | split-guitar | Name of the stereo stem to split (default `guitar`) |
| `--method` | split-guitar | Split algorithm: `spectral` (default, per-frequency-bin) or `midside` (whole-track, blunt) |

## Notes

- Valid stem names depend on `--model` — run `list` to see what's available for a given track/model.
- Stems are cached by filename under `separated/`; re-separating an edited file with the same name requires `--force` (the tool will warn you if it detects the source changed).
- `output/<track_name>/` is meant as a one-stop folder per song: it holds a copy of every stem you've separated (model-prefixed) plus every mix you've exported for that song. `separated/` remains the source of truth `mix` actually reads from — `output/` is just for browsing/listening.
