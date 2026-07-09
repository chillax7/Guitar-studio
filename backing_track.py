#!/usr/bin/env python3
"""
backing_track.py — Step 1 prototype: MP3 -> stems -> muted mixdown.

Uses Demucs (HTDemucs) to separate a song into vocals / drums / bass / other,
then lets you export a backing track with selected stems removed or
gain-adjusted.

This is a CLI validation of the separation + mixing pipeline described in
the Step 1 spec, intended to later be ported into the SwiftUI Mac app
(either by reimplementing the mixing logic in Swift, or by calling this
script / a compiled equivalent as a subprocess).

------------------------------------------------------------------------
SETUP (run once)
------------------------------------------------------------------------
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# torchcodec is required because current torchaudio releases route
# torchaudio.save() through TorchCodec's AudioEncoder; without it,
# `demucs` fails after separating with "ModuleNotFoundError: torchcodec".

# ffmpeg is required by demucs for MP3 decoding, and used here for MP3 export.
# On Mac: brew install ffmpeg

------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------
# 1. Separate a song into stems (cached at ./separated/<model>/<track_name>/*.wav,
#    and also copied to ./output/<track_name>/ for easy browsing)
python3 backing_track.py separate path/to/song.mp3

# Use the 6-stem model to also isolate guitar and piano from "other"
python3 backing_track.py separate path/to/song.mp3 --model htdemucs_6s

# 2. List the stems that were produced for a track
python3 backing_track.py list path/to/song.mp3

# 3. Mix down a backing track, muting the vocals and drums. A bare output
#    filename (no "/") lands in ./output/<track_name>/ automatically,
#    alongside that song's stems; give a path containing "/" to override.
python3 backing_track.py mix path/to/song.mp3 --mute vocals,drums -o backing_track.wav

# 4. Same, but export as MP3 too (requires ffmpeg on PATH)
python3 backing_track.py mix path/to/song.mp3 --mute vocals -o backing_track.mp3

# 5. Fine-grained per-stem gain instead of a hard mute (1.0 = unity gain)
python3 backing_track.py mix path/to/song.mp3 --gain vocals=0,drums=0.4,other=1.2 -o backing_track.wav

# 6. Experimental: split the guitar stem by stereo panning into a
#    "center" proxy (often lead, if mixed centered) and a "sides" proxy
#    (often rhythm, if double-tracked hard left/right). Requires the
#    guitar stem from htdemucs_6s. Quality depends entirely on how the
#    track was actually mixed — check the printed correlation figure.
python3 backing_track.py split-guitar path/to/song.mp3
python3 backing_track.py mix path/to/song.mp3 --mute guitar,guitar_center -o no_lead_guitar.wav

# 7. Mute a stem only during specific time ranges (e.g. just a guitar
#    solo), instead of for the whole track. Timestamps accept M:SS,
#    H:MM:SS, or raw seconds. Repeat the stem for multiple ranges.
python3 backing_track.py mix path/to/song.mp3 --mute-range guitar=1:15-1:45 -o backing_track.wav
python3 backing_track.py mix path/to/song.mp3 --mute-range "guitar=1:15-1:45,guitar=3:00-3:20" -o backing_track.wav

------------------------------------------------------------------------
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import scipy.signal
import soundfile as sf

DEFAULT_MODEL = "htdemucs"
# Anchored to this script's own location, not the process's ambient working
# directory: a plain Path("separated") resolves against whatever CWD the
# process happened to start with, which is only ever correct by accident
# for the CLI (run from a shell already cd'd here) and is flat-out wrong for
# a double-clicked Guitar Studio.app launch (Finder gives it some other
# CWD, so "separated" silently resolved to the wrong place — including, in
# one real case, macOS's read-only sealed system volume).
_PROJECT_ROOT = Path(__file__).resolve().parent
SEPARATED_DIR = _PROJECT_ROOT / "separated"
OUTPUT_DIR = _PROJECT_ROOT / "output"
FINGERPRINT_FILE = ".source.json"
ANALYSIS_FILE = "analysis.json"
PITCH_OFFSET_NOTE_THRESHOLD_CENTS = 8.0  # below this, don't bother the user (BT-16)
DEFAULT_TARGET_LUFS = -14.0
DEFAULT_MAX_BOOST_DB = 10.0  # cap on corrective gain — see normalize_loudness()
MUTE_RANGE_FADE_SECONDS = 0.03  # fade in/out at mute-range edges to avoid clicks
SPECTRAL_SPLIT_NPERSEG = 4096  # STFT window for the frequency-adaptive guitar split
DEFAULT_SPLIT_METHOD = "spectral"
HASH_CHUNK_SIZE = 1 << 20  # 1 MB, for streaming the content hash

# Known Demucs model -> stem names. Models not listed here fall back to the
# standard 4-stem set with a warning, since most Demucs models share it.
MODEL_STEMS = {
    "htdemucs": ("vocals", "drums", "bass", "other"),
    "htdemucs_ft": ("vocals", "drums", "bass", "other"),
    "htdemucs_6s": ("vocals", "drums", "bass", "guitar", "piano", "other"),
    "mdx": ("vocals", "drums", "bass", "other"),
    "mdx_extra": ("vocals", "drums", "bass", "other"),
}
DEFAULT_STEM_NAMES = MODEL_STEMS[DEFAULT_MODEL]

# Models run through the `audio-separator` package (UVR-family checkpoints)
# instead of Demucs. Chosen for BT-13 (see guitar-separation-upgrade-spec.md):
# independent benchmarks put this specific checkpoint's guitar-stem SDR at
# ~9.05 dB, vs. ~2.59 dB for htdemucs_6s's guitar stem — the actual bottleneck
# behind split-guitar's unreliability. Kept alongside htdemucs_6s (not
# replacing it) so the two can be A/B compared on the same songs.
AUDIO_SEPARATOR_MODELS = {
    "bs_roformer_sw": {
        "filename": "BS-Roformer-SW.ckpt",
        "stems": ("vocals", "drums", "bass", "guitar", "piano", "other"),
    },
}

ALL_KNOWN_MODELS = {**MODEL_STEMS, **{k: v["stems"] for k, v in AUDIO_SEPARATOR_MODELS.items()}}


def existing_stems(out_dir: Path) -> tuple:
    """Stem names actually present on disk for this track — includes both
    the original Demucs stems and any derived stems (e.g. from
    split-guitar), so newly derived stems are usable by 'mix' immediately."""
    return tuple(sorted(p.stem for p in out_dir.glob("*.wav")))


def content_hash(path: Path) -> str:
    """SHA-1 of the file's actual bytes, truncated to 12 hex chars. Used as
    part of the cache key (XC-03) so two different files that happen to
    share a filename never collide, and so a strictly stronger staleness
    check than size+mtime is available (catches an in-place edit that
    happens to preserve both)."""
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(HASH_CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def has_cached_stems(out_dir: Path) -> bool:
    """A directory only counts as a real cache entry if it actually has stem
    audio in it — a directory that exists but is empty (e.g. debris from an
    interrupted sync/copy) must never be mistaken for valid cached stems."""
    return out_dir.exists() and any(out_dir.glob("*.wav"))


def track_stem_dir(input_path: Path, model: str) -> Path:
    """Where stems for this track+model are cached, keyed by content hash
    (not just filename) so two different files sharing a name can never
    collide going forward. Falls back to the legacy filename-only location
    for stems separated before this change (staleness for those is still
    checked the old way, via warn_if_stale) — never auto-migrates or
    deletes an existing directory."""
    digest = content_hash(input_path)
    hashed_dir = SEPARATED_DIR / model / f"{input_path.stem}__{digest}"
    if has_cached_stems(hashed_dir):
        return hashed_dir

    legacy_dir = SEPARATED_DIR / model / input_path.stem
    if has_cached_stems(legacy_dir):
        return legacy_dir

    return hashed_dir


def track_output_dir(track_name: str) -> Path:
    """One folder per song under output/, holding both a copy of its stems
    and whatever mixes get exported for it."""
    return OUTPUT_DIR / track_name


def export_stem_files(stem_paths: list, track_name: str, model: str) -> None:
    """Copy stem files into output/<track_name>/, prefixed with the model
    name so stems from multiple models (e.g. htdemucs then htdemucs_6s)
    don't collide (both produce a bass.wav, drums.wav, etc.)."""
    dest_dir = track_output_dir(track_name)
    dest_dir.mkdir(parents=True, exist_ok=True)
    for stem_path in stem_paths:
        shutil.copy2(stem_path, dest_dir / f"{model}_{stem_path.name}")


def resolve_output_path(output_arg: str, track_name: str) -> Path:
    """A bare filename (no directory component) is placed under
    output/<track_name>/ automatically, alongside that song's stems. An
    explicit path (containing '/') is used exactly as given."""
    out_path = Path(output_arg)
    if len(out_path.parts) == 1:
        return track_output_dir(track_name) / out_path.name
    return out_path


def source_fingerprint(path: Path) -> dict:
    stat = path.stat()
    return {"size": stat.st_size, "mtime": stat.st_mtime, "content_hash": content_hash(path)}


def write_fingerprint(out_dir: Path, input_path: Path) -> None:
    (out_dir / FINGERPRINT_FILE).write_text(json.dumps(source_fingerprint(input_path)))


def fingerprint_is_stale(out_dir: Path, input_path: Path) -> bool:
    """True if the source file no longer matches what was recorded when
    these stems were separated. Prefers the content hash (XC-03) when the
    recorded fingerprint has one — catches an in-place edit even if it
    happens to preserve file size and modified-time. Falls back to the
    original size/mtime comparison for fingerprints written before XC-03.
    If no fingerprint was recorded at all (very old stems), we can't tell
    either way, so we don't flag it as stale."""
    meta_file = out_dir / FINGERPRINT_FILE
    if not meta_file.exists():
        return False
    try:
        recorded = json.loads(meta_file.read_text())
    except (json.JSONDecodeError, OSError):
        return False

    if "content_hash" in recorded:
        return recorded["content_hash"] != content_hash(input_path)
    current = source_fingerprint(input_path)
    return recorded.get("size") != current["size"] or recorded.get("mtime") != current["mtime"]


def warn_if_stale(out_dir: Path, input_path: Path) -> None:
    if fingerprint_is_stale(out_dir, input_path):
        print(f"Warning: {input_path.name} has changed (different size/modified "
              f"time) since these stems were separated — stems may be stale. "
              f"Re-run 'separate --force' to refresh.\n")


def run_demucs_backend(input_path: Path, model: str, out_dir: Path) -> None:
    if model not in MODEL_STEMS:
        print(f"Warning: '{model}' isn't a model this script recognizes — "
              f"stems will be whatever Demucs produces for it.")

    print(f"Running Demucs ({model}) on {input_path.name} ...")
    print("This can take a minute or two depending on song length and hardware.")

    result = subprocess.run(
        [
            sys.executable, "-m", "demucs",
            "-n", model,
            "-o", str(SEPARATED_DIR),
            str(input_path),
        ],
        capture_output=False,
    )
    if result.returncode != 0:
        sys.exit("Demucs separation failed. See output above for details.")

    # Demucs always writes to <out root>/<model>/<track filename stem>/*.wav —
    # it has no notion of our content-hash cache key (XC-03), so move its
    # output into the hashed dir the rest of the pipeline expects.
    demucs_out_dir = SEPARATED_DIR / model / input_path.stem
    if demucs_out_dir != out_dir:
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        if out_dir.exists():
            shutil.rmtree(out_dir)
        demucs_out_dir.rename(out_dir)


def run_audio_separator_backend(input_path: Path, model: str, out_dir: Path) -> None:
    """Run separation via the `audio-separator` package (UVR-family
    checkpoints) instead of Demucs. Writes stems into out_dir using the same
    <stem>.wav naming convention Demucs stems use, so 'list'/'mix'/
    'split-guitar' work identically regardless of which backend produced
    them (per engine-spec's stem-discovery-from-disk design). Imported
    lazily so a Demucs-only install doesn't need this dependency."""
    from audio_separator.separator import Separator

    model_info = AUDIO_SEPARATOR_MODELS[model]
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Running audio-separator ({model_info['filename']}) on {input_path.name} ...")
    print("First run downloads the model checkpoint (~700 MB) — subsequent runs reuse it.")

    separator = Separator(output_dir=str(out_dir), output_format="WAV")
    separator.load_model(model_filename=model_info["filename"])
    produced_names = separator.separate(str(input_path))
    produced = [out_dir / name for name in produced_names]

    # audio-separator names outputs like "<input_stem>_(guitar)_BS-Roformer-SW.wav";
    # rename each to "<stem>.wav" to match the convention every other command expects.
    for stem in model_info["stems"]:
        match = next((p for p in produced if f"({stem})" in p.name.lower()), None)
        if match is None:
            sys.exit(f"Expected a '{stem}' stem in audio-separator's output but didn't "
                      f"find one among: {[p.name for p in produced]}")
        match.rename(out_dir / f"{stem}.wav")


def analyze_track(out_dir: Path) -> dict:
    """BT-01/BT-16: best-effort tempo + reference-pitch analysis. Tempo comes
    from the drums stem (present for every model) via librosa's beat
    tracker; pitch offset from A=440 (in cents) comes from librosa's own
    tuning estimator run on the first harmonic-ish stem available. Either
    figure is simply omitted from the result if its stem is missing or the
    estimate fails — a missing BPM/pitch reading is fine; this must never
    be the reason a separation run fails."""
    import librosa

    result = {}

    drums_path = out_dir / "drums.wav"
    if drums_path.exists():
        try:
            y, sr = librosa.load(str(drums_path), sr=None, mono=True)
            tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
            bpm = float(np.asarray(tempo).reshape(-1)[0])
            if bpm > 0:
                result["bpm"] = round(bpm, 1)
        except Exception:
            pass

    for name in ("other", "guitar", "piano"):
        stem_path = out_dir / f"{name}.wav"
        if not stem_path.exists():
            continue
        try:
            y, sr = librosa.load(str(stem_path), sr=None, mono=True)
            tuning = librosa.estimate_tuning(y=y, sr=sr)
            result["pitch_offset_cents"] = round(float(tuning) * 100, 1)
            break
        except Exception:
            continue

    return result


def read_analysis(out_dir: Path) -> dict:
    meta_file = out_dir / ANALYSIS_FILE
    if not meta_file.exists():
        return {}
    try:
        return json.loads(meta_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def write_analysis(out_dir: Path, analysis: dict) -> None:
    (out_dir / ANALYSIS_FILE).write_text(json.dumps(analysis))


def ensure_analysis(out_dir: Path) -> dict:
    """Return cached analysis if present; otherwise compute it once and
    cache it. Lets stems separated before BT-01/BT-16 existed get backfilled
    lazily (on next 'separate', 'list', or app open) rather than requiring a
    forced re-separation."""
    existing = read_analysis(out_dir)
    if existing:
        return existing
    try:
        analysis = analyze_track(out_dir)
    except Exception:
        analysis = {}
    if analysis:
        write_analysis(out_dir, analysis)
    return analysis


def cmd_separate(args: argparse.Namespace) -> None:
    input_path = Path(args.input).resolve()
    if not input_path.exists():
        sys.exit(f"Error: input file not found: {input_path}")

    out_dir = track_stem_dir(input_path, args.model)
    if has_cached_stems(out_dir) and not args.force:
        print(f"Stems already exist at {out_dir} (use --force to redo).")
        warn_if_stale(out_dir, input_path)
        export_stem_files(list(out_dir.glob("*.wav")), input_path.stem, args.model)
        print_analysis(ensure_analysis(out_dir))
        return

    if args.model in AUDIO_SEPARATOR_MODELS:
        run_audio_separator_backend(input_path, args.model, out_dir)
    else:
        run_demucs_backend(input_path, args.model, out_dir)

    write_fingerprint(out_dir, input_path)
    export_stem_files(list(out_dir.glob("*.wav")), input_path.stem, args.model)
    print(f"\nDone. Stems written to: {out_dir}")
    print(f"Stems also copied to: {track_output_dir(input_path.stem)}")
    print_analysis(ensure_analysis(out_dir))


def print_analysis(analysis: dict) -> None:
    if "bpm" in analysis:
        print(f"Detected tempo: {analysis['bpm']:.1f} BPM")
    if "pitch_offset_cents" in analysis:
        offset = analysis["pitch_offset_cents"]
        if abs(offset) >= PITCH_OFFSET_NOTE_THRESHOLD_CENTS:
            print(f"This song appears to be {offset:+.1f} cents from A=440 — "
                  f"consider applying it via Tune.")
        else:
            print(f"Reference pitch: {offset:+.1f} cents from A=440 (close enough to ignore).")


def cmd_list(args: argparse.Namespace) -> None:
    input_path = Path(args.input).resolve()
    out_dir = track_stem_dir(input_path, args.model)
    if not has_cached_stems(out_dir):
        sys.exit(
            f"No stems found for {input_path.name} with model '{args.model}'. "
            f"Run 'separate' first."
        )
    warn_if_stale(out_dir, input_path)

    print(f"Stems for {input_path.name}:")
    for stem_file in sorted(out_dir.glob("*.wav")):
        info = sf.info(str(stem_file))
        mins, secs = divmod(int(info.duration), 60)
        print(f"  {stem_file.stem:10s}  {mins}:{secs:02d}  {info.samplerate} Hz")
    print_analysis(ensure_analysis(out_dir))


def parse_gains(mute_arg: str, gain_arg: str, valid_stems: tuple) -> dict:
    """Build a per-stem linear gain map. Defaults to 1.0 for every stem,
    --mute forces a stem to 0.0, and --gain overrides with an explicit
    linear multiplier (applied after --mute, so an explicit --gain value
    wins if a stem is listed in both)."""
    gains = {stem: 1.0 for stem in valid_stems}

    muted = set(s.strip().lower() for s in mute_arg.split(",") if s.strip())
    unknown = muted - set(valid_stems)
    if unknown:
        sys.exit(f"Unknown stem name(s) in --mute: {', '.join(unknown)}. "
                  f"Available stems: {', '.join(valid_stems)}")
    for stem in muted:
        gains[stem] = 0.0

    if gain_arg:
        for entry in gain_arg.split(","):
            entry = entry.strip()
            if not entry:
                continue
            if "=" not in entry:
                sys.exit(f"Invalid --gain entry '{entry}'. Use stem=value, e.g. drums=0.5")
            stem, _, value = entry.partition("=")
            stem = stem.strip().lower()
            if stem not in valid_stems:
                sys.exit(f"Unknown stem name in --gain: '{stem}'. "
                          f"Available stems: {', '.join(valid_stems)}")
            try:
                gains[stem] = float(value)
            except ValueError:
                sys.exit(f"Invalid gain value for '{stem}': '{value}' is not a number")

    return gains


def parse_timestamp(value: str) -> float:
    """Parse M:SS, H:MM:SS, or raw seconds into a float number of seconds."""
    value = value.strip()
    if ":" in value:
        parts = value.split(":")
        try:
            parts = [float(p) for p in parts]
        except ValueError:
            sys.exit(f"Invalid timestamp '{value}': expected M:SS, H:MM:SS, or seconds")
        if len(parts) == 2:
            minutes, seconds = parts
            return minutes * 60 + seconds
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return hours * 3600 + minutes * 60 + seconds
        sys.exit(f"Invalid timestamp '{value}': expected M:SS, H:MM:SS, or seconds")
    try:
        return float(value)
    except ValueError:
        sys.exit(f"Invalid timestamp '{value}': expected M:SS, H:MM:SS, or seconds")


def format_timestamp(seconds: float) -> str:
    minutes, secs = divmod(max(seconds, 0.0), 60)
    return f"{int(minutes)}:{secs:04.1f}"


def parse_mute_ranges(arg: str, valid_stems: tuple) -> dict:
    """Parse --mute-range into {stem: [(start_sec, end_sec), ...]}. A stem
    can appear multiple times to mute several ranges (e.g. two solos)."""
    ranges = {stem: [] for stem in valid_stems}
    if not arg:
        return ranges

    for entry in arg.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            sys.exit(f"Invalid --mute-range entry '{entry}'. Use stem=start-end, "
                      f"e.g. guitar=1:15-1:45")
        stem, _, span = entry.partition("=")
        stem = stem.strip().lower()
        if stem not in valid_stems:
            sys.exit(f"Unknown stem name in --mute-range: '{stem}'. "
                      f"Available stems: {', '.join(valid_stems)}")
        if "-" not in span:
            sys.exit(f"Invalid --mute-range span '{span}' for '{stem}'. "
                      f"Use start-end, e.g. 1:15-1:45")
        start_str, end_str = span.split("-", 1)
        start_sec = parse_timestamp(start_str)
        end_sec = parse_timestamp(end_str)
        if end_sec <= start_sec:
            sys.exit(f"Invalid --mute-range for '{stem}': end ({end_str}) must be "
                      f"after start ({start_str})")
        ranges[stem].append((start_sec, end_sec))

    return ranges


def build_mute_envelope(num_samples: int, samplerate: int, ranges: list) -> np.ndarray:
    """Build a per-sample gain envelope (1.0 = audible, 0.0 = muted) with a
    short fade at each mute boundary so cuts don't click."""
    envelope = np.ones(num_samples, dtype=np.float32)
    fade_len = max(1, int(samplerate * MUTE_RANGE_FADE_SECONDS))

    for start_sec, end_sec in ranges:
        start = max(0, min(int(start_sec * samplerate), num_samples))
        end = max(0, min(int(end_sec * samplerate), num_samples))
        if end <= start:
            continue

        fade_out_start = max(0, start - fade_len)
        if start > fade_out_start:
            ramp = np.linspace(1.0, 0.0, start - fade_out_start, dtype=np.float32)
            envelope[fade_out_start:start] = np.minimum(envelope[fade_out_start:start], ramp)

        envelope[start:end] = 0.0

        fade_in_end = min(num_samples, end + fade_len)
        if fade_in_end > end:
            ramp = np.linspace(0.0, 1.0, fade_in_end - end, dtype=np.float32)
            envelope[end:fade_in_end] = np.minimum(envelope[end:fade_in_end], ramp)

    return envelope


def midside_pan_split(left: np.ndarray, right: np.ndarray) -> tuple:
    """Blunt whole-track split: everything identical in both channels goes
    to 'center', everything different goes to 'sides', with one fixed
    50/50 weighting applied across the entire signal. Works when a track
    is cleanly mixed with one part dead-center and the other hard-panned,
    but can't adapt if panning is partial or inconsistent across the
    frequency range."""
    mid = (left + right) / 2
    side = (left - right) / 2
    return mid, side


def spectral_pan_split(left: np.ndarray, right: np.ndarray, samplerate: int) -> tuple:
    """Frequency-adaptive version of the same idea: for each time/frequency
    bin, estimate how centered vs. panned that bin is (from the relative
    magnitude of L and R), and weight the mid/side split per-bin instead of
    applying one fixed 50/50 split to the whole track. This can separate
    partially- or inconsistently-panned mixes better than the blunt
    time-domain version, since a bin that's mostly centered contributes
    almost entirely to 'center' and vice versa."""
    nperseg = min(SPECTRAL_SPLIT_NPERSEG, len(left))
    if nperseg < 8:
        return midside_pan_split(left, right)

    stft_kwargs = dict(fs=samplerate, nperseg=nperseg, noverlap=nperseg * 3 // 4)
    _, _, left_f = scipy.signal.stft(left, **stft_kwargs)
    _, _, right_f = scipy.signal.stft(right, **stft_kwargs)

    mag_l, mag_r = np.abs(left_f), np.abs(right_f)
    total = mag_l + mag_r + 1e-9
    balance = mag_l / total  # 0.5 = centered, 0 or 1 = hard-panned to one side
    centeredness = 1.0 - 2.0 * np.abs(balance - 0.5)  # 1 = centered, 0 = panned

    mid_f = (left_f + right_f) / 2
    side_f = (left_f - right_f) / 2

    istft_kwargs = dict(fs=samplerate, nperseg=nperseg, noverlap=nperseg * 3 // 4)
    _, center = scipy.signal.istft(centeredness * mid_f, **istft_kwargs)
    _, sides = scipy.signal.istft((1.0 - centeredness) * side_f, **istft_kwargs)

    return _match_length(center, len(left)), _match_length(sides, len(left))


def _match_length(signal: np.ndarray, target_len: int) -> np.ndarray:
    """ISTFT framing can return a slightly different length than the
    original signal; pad or trim so all stems still line up sample-for-sample."""
    if len(signal) < target_len:
        return np.pad(signal, (0, target_len - len(signal)))
    return signal[:target_len]


def cmd_split_guitar(args: argparse.Namespace) -> None:
    """Experimental: split a stereo guitar stem by panning position rather
    than timbre. This is NOT a real lead/rhythm separation model — no such
    model exists off the shelf. It's a stereo mid/side heuristic: content
    that's identical in both channels (the 'center' proxy) vs. content that
    differs between channels (the 'sides' proxy). It only works to the
    extent the source was actually mixed with lead centered and rhythm
    hard-panned (or vice versa) — some mixes won't split usefully at all,
    which the printed correlation figure is meant to help you judge."""
    input_path = Path(args.input).resolve()
    out_dir = track_stem_dir(input_path, args.model)
    if not has_cached_stems(out_dir):
        sys.exit(
            f"No stems found for {input_path.name} with model '{args.model}'. "
            f"Run 'separate' first."
        )
    warn_if_stale(out_dir, input_path)

    stem_path = out_dir / f"{args.stem}.wav"
    if not stem_path.exists():
        sys.exit(f"No '{args.stem}' stem found in {out_dir}. This split needs a "
                  f"guitar stem — try 'separate --model htdemucs_6s' first.")

    audio, sr = sf.read(str(stem_path), dtype="float32")
    if audio.ndim < 2 or audio.shape[1] < 2:
        sys.exit(f"'{args.stem}' stem is mono — a panning-based split needs stereo "
                  f"audio to have anything to work with.")

    left, right = audio[:, 0], audio[:, 1]
    if np.std(left) > 0 and np.std(right) > 0:
        correlation = float(np.corrcoef(left, right)[0, 1])
    else:
        correlation = 1.0

    if args.method == "spectral":
        center_mono, sides_mono = spectral_pan_split(left, right, sr)
    else:
        center_mono, sides_mono = midside_pan_split(left, right)
    center = np.stack([center_mono, center_mono], axis=1)
    sides = np.stack([sides_mono, -sides_mono], axis=1)

    center_path = out_dir / f"{args.stem}_center.wav"
    sides_path = out_dir / f"{args.stem}_sides.wav"
    sf.write(str(center_path), center, sr)
    sf.write(str(sides_path), sides, sr)

    print(f"Split method: {args.method}")
    print(f"Inter-channel correlation of '{args.stem}': {correlation:.2f} "
          f"(1.0 = fully mono/centered, 0.0 = fully independent stereo channels). "
          f"In practice this hasn't reliably predicted split quality — treat it as "
          f"informational, and judge by listening.")
    export_stem_files([center_path, sides_path], input_path.stem, args.model)

    print(f"Wrote {center_path.name} — proxy for whatever's mixed dead-center "
          f"(often lead, if the mix puts solos in the middle)")
    print(f"Wrote {sides_path.name} — proxy for whatever's hard-panned/stereo-spread "
          f"(often rhythm, if it's double-tracked left/right)")
    print(f"Both copied to: {track_output_dir(input_path.stem)}")
    print(f"\nBoth are now usable as stems in 'mix', e.g.:\n"
          f"  --mute {args.stem},{args.stem}_center   (keep the 'sides' proxy, drop the rest)\n"
          f"  --mute {args.stem},{args.stem}_sides    (keep the 'center' proxy, drop the rest)")


def cmd_mix(args: argparse.Namespace) -> None:
    input_path = Path(args.input).resolve()
    out_dir = track_stem_dir(input_path, args.model)
    if not has_cached_stems(out_dir):
        sys.exit(
            f"No stems found for {input_path.name} with model '{args.model}'. "
            f"Run 'separate' first."
        )
    warn_if_stale(out_dir, input_path)

    valid_stems = existing_stems(out_dir)
    gains = parse_gains(args.mute, args.gain, valid_stems)
    mute_ranges = parse_mute_ranges(args.mute_range, valid_stems)
    active_stems = [s for s in valid_stems if gains[s] != 0.0]
    if not active_stems:
        sys.exit("All stems muted/zeroed — nothing to mix.")

    summary = ", ".join(f"{s}({gains[s]:.2f})" for s in active_stems)
    silent = [s for s in valid_stems if gains[s] == 0.0]
    print(f"Mixing stems: {summary} (muted: {', '.join(silent) or 'none'})")

    for stem, spans in mute_ranges.items():
        if not spans:
            continue
        span_str = ", ".join(f"{format_timestamp(s)}-{format_timestamp(e)}" for s, e in spans)
        if stem in silent:
            print(f"  Note: '{stem}' is already muted entirely — --mute-range for it has no effect.")
        else:
            print(f"  Time-muting {stem} during: {span_str}")

    mix = None
    samplerate = None
    for stem in active_stems:
        stem_path = out_dir / f"{stem}.wav"
        if not stem_path.exists():
            sys.exit(f"Missing stem file: {stem_path}")
        audio, sr = sf.read(str(stem_path), dtype="float32")
        if samplerate is None:
            samplerate = sr
        elif sr != samplerate:
            sys.exit(f"Sample rate mismatch in {stem_path.name}: {sr} vs {samplerate}")

        audio = audio * gains[stem]
        if mute_ranges.get(stem):
            envelope = build_mute_envelope(len(audio), sr, mute_ranges[stem])
            audio = audio * envelope[:, np.newaxis]
        if mix is None:
            mix = audio
        else:
            # Pad shorter arrays with silence so lengths always match.
            if len(audio) < len(mix):
                audio = np.pad(audio, ((0, len(mix) - len(audio)), (0, 0)))
            elif len(mix) < len(audio):
                mix = np.pad(mix, ((0, len(audio) - len(mix)), (0, 0)))
            mix += audio

    mix, norm_info = normalize_loudness(mix, samplerate, args.target_lufs,
                                         normalize=args.normalize,
                                         max_boost_db=args.max_boost_db)
    if not args.normalize:
        pass
    elif norm_info["measured_lufs"] is None:
        print("Mix is effectively silent — skipping loudness normalization.")
    else:
        print(f"Measured loudness {norm_info['measured_lufs']:.1f} LUFS — applying "
              f"{norm_info['applied_gain_db']:+.1f} dB to reach target {args.target_lufs:.1f} LUFS.")
        if norm_info["boost_capped"]:
            print(f"  (boost capped at +{args.max_boost_db:.1f} dB — target loudness not fully reached)")
    if norm_info["peak_clamped"]:
        print("Peak level exceeded 0 dBFS — normalizing to avoid clipping.")

    out_path = resolve_output_path(args.output, input_path.stem)
    write_audio(mix, samplerate, out_path)
    print(f"Backing track written to: {out_path}")


def normalize_loudness(mix: np.ndarray, samplerate: int, target_lufs: float,
                       normalize: bool = True, max_boost_db: float = None) -> tuple:
    """Normalize to a target integrated loudness (LUFS) so backing tracks
    with different stems muted/gained still feel consistently loud, then
    apply a hard peak-safety clamp since loudness normalization can still
    push transient peaks over 0 dBFS.

    'normalize=False' skips the LUFS step entirely (still peak-clamps) —
    a first-class off switch, not buried, since large corrective gain on
    quiet/solo mixes is a known way to make separation artifacts more
    audible (see the "known open issue" this was designed around).
    'max_boost_db' caps how much gain a quiet mix can get boosted by, for
    the same reason; reported back via 'boost_capped' when it fires.

    Returns (normalized_mix, info) rather than printing directly, so both
    the CLI and the HTTP API's JSON response derive their user-facing
    numbers from one place instead of each re-deriving them from the audio
    after the fact."""
    meter = pyln.Meter(samplerate)
    loudness = meter.integrated_loudness(mix)
    info = {
        "measured_lufs": float(loudness) if np.isfinite(loudness) else None,
        "applied_gain_db": 0.0,
        "peak_clamped": False,
        "boost_capped": False,
    }

    if normalize and np.isfinite(loudness):
        gain_db = target_lufs - loudness
        if max_boost_db is not None and gain_db > max_boost_db:
            gain_db = max_boost_db
            info["boost_capped"] = True
        info["applied_gain_db"] = gain_db
        mix = mix * (10 ** (gain_db / 20))

    peak = np.max(np.abs(mix)) if mix.size else 0.0
    if peak > 1.0:
        mix = mix / peak * 0.98
        info["peak_clamped"] = True

    return mix, info


def find_ffmpeg() -> str | None:
    """Robust lookup beyond shutil.which(): GUI-launched processes (a
    double-clicked .app bundle, this project's own dev-preview tooling)
    often don't inherit the PATH an interactive shell would — notably
    missing Homebrew's /opt/homebrew/bin on Apple Silicon, where ffmpeg can
    be genuinely installed and still invisible to shutil.which(). Returns
    None (not a bare "ffmpeg" guess) when truly not found, so callers can
    give a clear error instead of a confusing subprocess failure."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"):
        if Path(candidate).exists():
            return candidate
    return None


def write_audio(audio: np.ndarray, samplerate: int, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = out_path.suffix.lower()
    if suffix == ".wav":
        sf.write(str(out_path), audio, samplerate)
        return

    if suffix == ".mp3":
        # soundfile can't write MP3 directly; write a temp WAV then use ffmpeg.
        tmp_wav = out_path.with_suffix(".tmp.wav")
        sf.write(str(tmp_wav), audio, samplerate)
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            tmp_wav.unlink(missing_ok=True)
            sys.exit("ffmpeg not found. Is it installed? (brew install ffmpeg)")
        result = subprocess.run(
            [ffmpeg, "-y", "-i", str(tmp_wav), "-q:a", "2", str(out_path)],
            capture_output=True, text=True,
        )
        tmp_wav.unlink(missing_ok=True)
        if result.returncode != 0:
            sys.exit(f"ffmpeg MP3 export failed:\n{result.stderr}\n"
                      f"Is ffmpeg installed? (brew install ffmpeg)")
        return

    sys.exit(f"Unsupported output format: {suffix}. Use .wav or .mp3.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backing track creator (Step 1 prototype)")
    sub = parser.add_subparsers(dest="command", required=True)

    def model_help(default: str) -> str:
        return (f"Separation model to use (default: {default}). "
                f"Demucs models: {', '.join(MODEL_STEMS)}. "
                f"audio-separator models: {', '.join(AUDIO_SEPARATOR_MODELS)} "
                f"(BT-13: much better guitar-stem quality — see "
                f"guitar-separation-upgrade-spec.md). "
                f"Use htdemucs_6s or bs_roformer_sw to get separate guitar/piano stems.")

    p_sep = sub.add_parser("separate", help="Run Demucs source separation on a track")
    p_sep.add_argument("input", help="Path to input MP3/WAV file")
    p_sep.add_argument("--model", default=DEFAULT_MODEL, help=model_help(DEFAULT_MODEL))
    p_sep.add_argument("--force", action="store_true", help="Re-run even if stems already exist")
    p_sep.set_defaults(func=cmd_separate)

    p_list = sub.add_parser("list", help="List stems already separated for a track")
    p_list.add_argument("input", help="Path to input MP3/WAV file")
    p_list.add_argument("--model", default=DEFAULT_MODEL, help=model_help(DEFAULT_MODEL))
    p_list.set_defaults(func=cmd_list)

    p_split = sub.add_parser("split-guitar",
                              help="Experimental: split a guitar stem by stereo panning "
                                   "into 'center' and 'sides' proxies")
    p_split.add_argument("input", help="Path to input MP3/WAV file")
    p_split.add_argument("--model", default="htdemucs_6s", help=model_help("htdemucs_6s"))
    p_split.add_argument("--stem", default="guitar",
                          help="Name of the stereo stem to split (default: guitar)")
    p_split.add_argument("--method", choices=["spectral", "midside"], default=DEFAULT_SPLIT_METHOD,
                          help="Split algorithm (default: spectral). 'spectral' adapts the "
                               "center/sides split per frequency bin, which can separate "
                               "partially- or inconsistently-panned mixes better than the "
                               "blunt whole-track 'midside' split.")
    p_split.set_defaults(func=cmd_split_guitar)

    p_mix = sub.add_parser("mix", help="Mix down a backing track with stems muted/gained")
    p_mix.add_argument("input", help="Path to input MP3/WAV file (used to locate its stems)")
    p_mix.add_argument("--model", default=DEFAULT_MODEL, help=model_help(DEFAULT_MODEL))
    p_mix.add_argument("--mute", default="",
                        help=f"Comma-separated stems to remove, from: {', '.join(DEFAULT_STEM_NAMES)} "
                             f"(depends on --model; see 'list')")
    p_mix.add_argument("--gain", default="",
                        help="Comma-separated stem=value linear gain overrides, e.g. "
                             "'drums=0.4,other=1.2'. Applied after --mute; a stem "
                             "given both is muted unless --gain overrides it.")
    p_mix.add_argument("--mute-range", default="",
                        help="Comma-separated stem=start-end time ranges to mute within "
                             "(instead of muting the whole stem), e.g. "
                             "'guitar=1:15-1:45' to cut just a solo. Timestamps accept "
                             "M:SS, H:MM:SS, or raw seconds. Repeat the stem for multiple "
                             "ranges: 'guitar=1:15-1:45,guitar=3:00-3:20'.")
    p_mix.add_argument("--target-lufs", type=float, default=DEFAULT_TARGET_LUFS,
                        help=f"Target integrated loudness in LUFS for the export "
                             f"(default: {DEFAULT_TARGET_LUFS})")
    p_mix.add_argument("--no-normalize", dest="normalize", action="store_false",
                        help="Skip loudness normalization entirely (still peak-clamps). "
                             "Large corrective gain on quiet/solo mixes can make separation "
                             "artifacts more audible — this is a first-class off switch, not "
                             "a hidden default.")
    p_mix.add_argument("--max-boost-db", type=float, default=DEFAULT_MAX_BOOST_DB,
                        help=f"Cap how much a quiet mix can be boosted to reach the target "
                             f"loudness, for the same reason as --no-normalize (default: "
                             f"{DEFAULT_MAX_BOOST_DB})")
    p_mix.add_argument("-o", "--output", default="backing_track.wav",
                        help="Output file path (.wav or .mp3)")
    p_mix.set_defaults(func=cmd_mix)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
