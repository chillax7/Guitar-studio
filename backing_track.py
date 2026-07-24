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
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import scipy.signal
import soundfile as sf

DEFAULT_MODEL = "bs_roformer_sw"  # BT-13: measurably better guitar-stem SDR than htdemucs
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
# Bump whenever analyze_track() learns a new reading, so tracks analyzed
# under an older version get lazily re-analyzed (ensure_analysis) instead of
# serving a cached result that's silently missing the new keys forever —
# v1: bpm + pitch_offset_cents; v2: + key (BT-03) and beats (BT-02);
# v3: + chords (BT-04); v4: key now prefers key_from_chords over
# detect_key's raw chroma-profile correlation whenever confident chords
# exist (see key_from_chords' docstring for why); v5: key_from_chords picks
# its tonic by total beats-per-root (not per (root, quality) pair) and
# judges major/minor from direct minor-3rd/major-3rd chroma energy at that
# root instead of trusting a single chord's maj/min template label — fixes
# riff/power-chord-heavy rock and metal songs reading as false "major"
# (real user report on real songs; see key_from_chords' docstring); v6:
# detect_chords now Viterbi-decodes the whole beat sequence instead of an
# independent per-beat argmax, fixing chord-lane flicker on ordinary chroma
# noise (chord-detection-v2-spec.md CD-1; real user report: "way too busy");
# v7: detect_chords adds a "5" (power chord) template, gated to only win
# where a beat's third is genuinely absent — a bare root+fifth no longer
# gets force-labeled maj or min by whichever way overtone noise leans that
# beat (chord-detection-v2-spec.md CD-2); v8: detect_chords' chroma now
# gets harmonic/percussive separation, tuning estimation, and log
# compression before template matching (CD-3), and gets a small bonus
# toward whatever root the isolated bass stem agrees with each beat (CD-4);
# v9: the CD-2 power-chord gate now also suppresses maj/min/7 (not just
# enables "5" to compete) when a beat's third is genuinely absent — real
# distorted power chords carry incidental harmonic/distortion energy near
# a flat 7th even with no 3rd at all, and the "7" template being a
# superset of "5"'s two bins kept winning anyway (real user report: power
# chords showing up as "7" almost everywhere instead of "5"); v10: CD-2's
# gate now does its ratio test against raw, pre-log-compression chroma —
# log1p (CD-3) inflates a small bin's apparent share of a large bin's
# energy well past its real physical proportion, so on real distorted
# guitar the gate was still tripping into "third present" at harmonic
# bleed levels that are actually a genuine power chord (real user report,
# with real isolated stems + a chord chart as ground truth this time);
# v11 ("Mull of Kintyre" pass, two real-song fixes verified against the
# actual pipeline): (a) the CD-2 power-chord gate now runs its
# third-presence ratio test on the NON-bass chroma only — summing the bass
# in inflated root+fifth energy and buried a genuinely-played third below
# the threshold, so honest major/minor triads were being labeled bare "5"
# power chords on every song that has a bass guitar; (b) the beat grid (and
# so the whole chord lane, which windows per beat) now falls back to onset
# tracking on the pitched stems when there's no drums stem to track — a
# drumless/acoustic song used to produce no beats at all and an entirely
# empty chord lane; v11b ("Norwegian Wood" pass): chord IDENTITY (root AND
# quality) now reads the non-bass mix for the WHOLE decode, not just the CD-2/
# CD-5 gates — a bass note is near-pure root energy and summed into the chroma
# it buries the third (the one bin telling maj from min) below the noise floor,
# so a plain E major over an E bass was decoding as E minor (real modal-shift
# song, verse read minor); the bass now contributes only through CD-4's
# explicit root bonus. Fixed the maj/min discrimination across the board (also
# resolved a lingering E-major→E-minor wobble in the Mull 4/4 material). Known
# remaining hard case: a sustained tonic drone (sitar/tanpura/bagpipe) still
# floods the non-bass chroma and reads as a power chord — needs background/
# drone subtraction, deferred pending real drone-heavy audio. v12: adds coarse
# song-section detection (BT-20,
# song-section-detection-spec.md) — a beat-free (fixed ~1s grid),
# self-similarity + Foote-novelty pass over the full mix that returns labeled
# {start, end, label} regions (A/B/C… by repetition), for a section ribbon you
# can jump to / loop. Assistive, first-cut, best-effort — same framing as the
# chord lane and key detection; simply omitted when there's no confident read.
# v13 ("Hotel California" pass): key_from_chords finds the tonic by
# Krumhansl-Schmuckler key-profile correlation over the chord histogram, not
# "most frequent chord root" — a minor-key song whose tonic is played least of
# all (Hotel California is B minor, but B is the rarest chord in
# Bm-F#-A-E-G-D-Em-F#) was returning a confident wrong "E minor"; the profile
# correlation gets B minor (and also settled a two-chord vamp's tonic that
# root-counting left tied). Mode still uses the CD-2 direct-chroma third check
# so power-chord-heavy rock/metal keeps reading minor when it is.
# v14 ("Holiday" pass): key confidence is now margin-aware — a song built only
# from power chords (no thirds) fits its relative/parallel/neighbouring keys
# almost equally, so the winning profile can score high with a thin margin;
# scaling confidence by that margin reports honestly LOW confidence on such
# inherently-ambiguous keys (Holiday's F-minor power chords also fit Ab/Eb
# major) instead of a confident wrong answer, rather than pretending a
# thirdless progression pins one key. Chord recognition itself unchanged;
# power chords still read "5", fast tempo still tracks.
ANALYSIS_VERSION = 15
PITCH_OFFSET_NOTE_THRESHOLD_CENTS = 8.0  # below this, don't bother the user (BT-16)
DEFAULT_TARGET_LUFS = -14.0
DEFAULT_MAX_BOOST_DB = 10.0  # cap on corrective gain — see normalize_loudness()
MUTE_RANGE_FADE_SECONDS = 0.03  # fade in/out at mute-range edges to avoid clicks
SPECTRAL_SPLIT_NPERSEG = 4096  # STFT window for the frequency-adaptive guitar split
DEFAULT_SPLIT_METHOD = "spectral"
HYBRID_SHARPEN_STRENGTH = 0.6  # how hard onset-grid-alignment can push hybrid_pan_split's centeredness away from 0.5
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

# DEFAULT_MODEL (bs_roformer_sw) lives in AUDIO_SEPARATOR_MODELS, not
# MODEL_STEMS — index the merged dict, not just the Demucs half, or this
# throws KeyError at import time the moment DEFAULT_MODEL isn't a Demucs
# model.
ALL_KNOWN_MODELS = {**MODEL_STEMS, **{k: v["stems"] for k, v in AUDIO_SEPARATOR_MODELS.items()}}
DEFAULT_STEM_NAMES = ALL_KNOWN_MODELS[DEFAULT_MODEL]


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


def custom_stems_dir(digest: str) -> Path:
    """Where user-dropped custom stems (custom-stems-spec.md) live for a
    track — keyed by content hash only, NOT by separation model, unlike
    track_stem_dir above. Two reasons: run_demucs_backend shutil.rmtrees
    a model's own stem_dir on re-separation (a custom stem stored there
    would be silently destroyed), and a stem the user physically provided
    has nothing to do with which ML model is currently active for the
    other stems — switching models shouldn't make it vanish."""
    return SEPARATED_DIR / "_custom" / digest


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


_TQDM_PERCENT_RE = re.compile(r"(\d{1,3})%\|")


def _scan_for_percent(buf: bytes | str, progress_cb) -> None:
    """Both separation backends print tqdm-style progress bars (`43%|...|`)
    that update in place via carriage returns rather than newlines. Given
    one flushed chunk of raw output, pull out the last percentage seen and
    report it — good enough for a UI progress bar without needing either
    library to expose a real progress callback (neither does)."""
    if not progress_cb:
        return
    matches = _TQDM_PERCENT_RE.findall(buf if isinstance(buf, str) else buf.decode("utf-8", "replace"))
    if matches:
        # Cap below 100 — 100 is reserved for "actually finished" (stem
        # files written), which happens slightly after the model's own
        # last progress tick.
        progress_cb(min(99, int(matches[-1])))


def run_demucs_backend(input_path: Path, model: str, out_dir: Path, progress_cb=None) -> None:
    if model not in MODEL_STEMS:
        print(f"Warning: '{model}' isn't a model this script recognizes — "
              f"stems will be whatever Demucs produces for it.")

    print(f"Running Demucs ({model}) on {input_path.name} ...")
    print("This can take a minute or two depending on song length and hardware.")

    process = subprocess.Popen(
        [
            sys.executable, "-m", "demucs",
            "-n", model,
            "-o", str(SEPARATED_DIR),
            str(input_path),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0,
    )
    while True:
        chunk = process.stdout.read(1024)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.flush()
        _scan_for_percent(chunk, progress_cb)
    returncode = process.wait()
    if returncode != 0:
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


class _ProgressStderr:
    """Stand-in for sys.stderr during a run_audio_separator_backend() call.
    audio-separator's own tqdm progress bars (and everything else it or its
    dependencies write to stderr) pass through unchanged; percentages are
    additionally skimmed off and reported via progress_cb — the library has
    no progress-callback API of its own to hook instead."""

    def __init__(self, real, progress_cb):
        self._real = real
        self._progress_cb = progress_cb
        self._buf = ""

    def write(self, s: str) -> int:
        self._real.write(s)
        self._buf += s
        if "\r" in self._buf or "\n" in self._buf:
            _scan_for_percent(self._buf, self._progress_cb)
            self._buf = ""
        return len(s)

    def flush(self) -> None:
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


def run_audio_separator_backend(input_path: Path, model: str, out_dir: Path, progress_cb=None) -> None:
    """Run separation via the `audio-separator` package (UVR-family
    checkpoints) instead of Demucs. Writes stems into out_dir using the same
    <stem>.wav naming convention Demucs stems use, so 'list'/'mix'/
    'split-guitar' work identically regardless of which backend produced
    them (per engine-spec's stem-discovery-from-disk design). Imported
    lazily so a Demucs-only install doesn't need this dependency."""
    from audio_separator.separator import Separator

    # audio-separator shells out to a bare "ffmpeg" command internally (not
    # configurable) to check for its presence — a GUI-launched .app doesn't
    # inherit the PATH find_ffmpeg() below otherwise works around by
    # resolving a full path, so make sure that binary's directory is
    # actually on PATH for this process too before it gets a chance to look.
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found. Is it installed? (brew install ffmpeg)")
    ffmpeg_dir = str(Path(ffmpeg).parent)
    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    if ffmpeg_dir not in path_entries:
        os.environ["PATH"] = os.pathsep.join([ffmpeg_dir, *path_entries])

    model_info = AUDIO_SEPARATOR_MODELS[model]
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Running audio-separator ({model_info['filename']}) on {input_path.name} ...")
    print("First run downloads the model checkpoint (~700 MB) — subsequent runs reuse it.")

    separator = Separator(output_dir=str(out_dir), output_format="WAV")
    old_stderr = sys.stderr
    if progress_cb:
        sys.stderr = _ProgressStderr(old_stderr, progress_cb)
    try:
        separator.load_model(model_filename=model_info["filename"])
        produced_names = separator.separate(str(input_path))
    finally:
        sys.stderr = old_stderr
    produced = [out_dir / name for name in produced_names]

    # audio-separator names outputs like "<input_stem>_(guitar)_BS-Roformer-SW.wav";
    # rename each to "<stem>.wav" to match the convention every other command expects.
    for stem in model_info["stems"]:
        match = next((p for p in produced if f"({stem})" in p.name.lower()), None)
        if match is None:
            sys.exit(f"Expected a '{stem}' stem in audio-separator's output but didn't "
                      f"find one among: {[p.name for p in produced]}")
        match.rename(out_dir / f"{stem}.wav")


# BT-03: Krumhansl-Schmuckler key-profile correlation — a standard,
# well-established key-finding heuristic (not ML, just correlating a
# track's averaged chroma vector against these two rotatable templates).
# Like every other heuristic in this app, it's a starting point to audition
# by ear, not a guaranteed answer — the spec explicitly frames it that way,
# and there's no reason this one would be different.
KEY_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KEY_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# key_from_chords (BT-03b) margin at which the winning key profile is trusted
# completely. A song built only from power chords (root+fifth, no thirds — a
# lot of punk/metal) fits its relative-major, parallel, and neighbouring keys
# almost equally, so the top profile can win with a high absolute correlation
# but a razor-thin margin; scaling confidence by margin/this makes those
# genuinely-ambiguous keys report honestly low confidence instead of a
# confident wrong answer (Green Day's "Holiday" — F-minor power chords that
# also fit Ab/Eb major — was the motivating case).
KEY_MARGIN_FULL_CONF = 0.2


def detect_key(y: "np.ndarray", sr: int) -> dict | None:
    import librosa
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    if chroma_mean.sum() <= 0:
        return None
    chroma_norm = chroma_mean / chroma_mean.sum()
    best = None
    for mode, profile in (("major", KEY_MAJOR_PROFILE), ("minor", KEY_MINOR_PROFILE)):
        profile_norm = profile / profile.sum()
        for root in range(12):
            rotated = np.roll(profile_norm, root)
            corr = np.corrcoef(chroma_norm, rotated)[0, 1]
            if best is None or corr > best[0]:
                best = (corr, root, mode)
    corr, root, mode = best
    return {"key": KEY_NOTE_NAMES[root], "mode": mode, "confidence": round(float(corr), 3)}


# BT-04 (V4-F1): beat-synchronous chroma -> template matching. maj/min/7 is
# the deliberate starter set (release-v4-spec.md's V4-F1 scoping) — the
# chord lane's own UI carries an "assistive, best on pop/rock" honesty note
# forward from here, same spirit as detect_key above. Not ML: a chord
# template is just its notes' pitch classes as a binary chroma vector,
# matched by cosine similarity, exactly like detect_key's rotated
# major/minor profiles are matched by correlation.
CHORD_QUALITY_INTERVALS = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "7": (0, 4, 7, 10),
    "5": (0, 7),  # CD-2 (chord-detection-v2-spec.md §5.1) — power chord; see CHORD_POWER_THIRD_ABSENCE_RATIO for why this doesn't just eat every maj/min match
}
CHORD_CONFIDENCE_FLOOR = 0.5  # below this, report "no chord" rather than a guess that's probably noise

# CD-2: a bare root+fifth is a strict subset of both the maj and min
# templates, so as a candidate it cosine-matches almost anything they do —
# left unguarded, "5" would win a huge share of beats that are actually
# ordinary triads just because the third contributes a little less energy
# than the root/fifth do. Real power chords are common on distorted guitar
# specifically because there IS no third being played at all, not because
# it's merely quiet — so the gate isn't about relative confidence, it's a
# hard "is a third even present" check: at a candidate root, if either the
# minor- or major-third chroma bin holds at least this fraction of the
# root+fifth energy, a third is being played and the ordinary maj/min/7
# templates get to compete for that root as before. Only when both thirds
# are genuinely near-silent does "5" get to compete at all (see
# detect_chords). One constant, tuned against real riffs during CD-5.
CHORD_POWER_THIRD_ABSENCE_RATIO = 0.2

# CD-5 real-song fix ("Mull of Kintyre" pass): the "7" (dominant seventh) template is a
# strict superset of "maj" — the same 0,4,7 plus a b7 — so, exactly like the
# power-chord "5" superset problem the CD-2 gate solves, "7" wins over plain
# "maj" on any incidental b7 energy even when nobody played a seventh. The
# usual source of that phantom b7 is the BASS: a bass root's 7th partial
# lands near the b7, so a plain major triad over a bass note reads as a
# dominant 7 across a whole song. A played seventh, though, shows up as real
# energy in the CHORD instruments, so — like the third-presence gate — this
# runs on the non-bass chroma: at a candidate root, "7" only gets to compete
# against maj/min when the b7 bin genuinely holds at least this fraction of
# that root's root+fifth energy. Guitar-only measurement of a clean major
# triad: b7 sits at ~0.004 of root+fifth (a plucked string's 7th partial is
# weak and HPSS/CQT suppress it further), while a real dominant-7 voicing
# puts the played b7 well above this — clean separation. Tunable against real
# 7-heavy blues/rock material.
CHORD_SEVENTH_ABSENCE_RATIO = 0.2

# chord-detection-v2-spec.md CD-1: per-beat argmax had no memory of the
# previous beat, so ordinary chroma noise (a passing note, a bend, a fill)
# flips single beats to a different template and every flip breaks a run
# into extra chips — the root cause of "the chord lane is way too busy"
# (real user report; also release-v5-spec.md's "Phantom of the Opera"
# finding). Fixed the way the whole chord-recognition literature does it
# since Sheh & Ellis 2003: decode the *sequence* with Viterbi instead of
# picking each frame independently, using a transition matrix that's cheap
# to stay on the current chord and costly to leave it.
CHORD_SELF_TRANSITION_P = 0.88  # probability mass kept on staying put per beat; rest spreads uniformly over every other state
CHORD_EMISSION_TEMPERATURE = 12.0  # softmax sharpness turning raw cosine scores into a per-beat state distribution; higher trusts the raw scores more
CHORD_MIN_RUN_BEATS = 2  # a decoded run shorter than this still reaches the UI as a 1-beat island unless merged into a neighbor (see _merge_short_chord_runs)

# CD-3 (chord-detection-v2-spec.md §5.2): standard chroma preprocessing that
# every published pipeline since NNLS Chroma (2010) uses and we didn't —
# harmonic/percussive separation strips transient smear (a pick attack or
# palm-muted chug has broadband noise energy that pollutes every chroma bin
# for an instant, right when a chord read matters most), tuning estimation
# stops a band that's slightly off A440 from smearing energy across two
# adjacent bins instead of landing cleanly in one, and log compression stops
# a single loud frame inside a beat window from dominating that beat's
# averaged chroma reading.
CHORD_HPSS_MARGIN = 4.0  # librosa.effects.harmonic's margin — higher rejects more of the percussive residual
CHORD_CHROMA_LOG_COMPRESSION_K = 10.0  # np.log1p(k * chroma) — higher compresses harder

# CD-4 (chord-detection-v2-spec.md §5.3): the bass player states a chord's
# root more reliably than any full-mix feature does, and — unlike every
# generic chord-recognition app — we already have the bass isolated as its
# own stem. A small bonus nudges the decode toward whichever root the bass
# stem's dominant pitch class agrees with each beat, without ever forcing
# it (still just one more term in the same per-template score every other
# heuristic here already competes on).
CHORD_BASS_ROOT_BONUS = 0.12


def _build_chord_templates() -> tuple[list[tuple[str, str]], "np.ndarray"]:
    labels = []
    rows = []
    for root in range(12):
        for quality, intervals in CHORD_QUALITY_INTERVALS.items():
            vec = np.zeros(12)
            for interval in intervals:
                vec[(root + interval) % 12] = 1.0
            vec /= np.linalg.norm(vec)
            labels.append((KEY_NOTE_NAMES[root], quality))
            rows.append(vec)
    return labels, np.array(rows)


CHORD_TEMPLATE_LABELS, CHORD_TEMPLATE_MATRIX = _build_chord_templates()
CHORD_TEMPLATE_INDEX = {label: i for i, label in enumerate(CHORD_TEMPLATE_LABELS)}
CHORD_POWER_TEMPLATE_INDEX = {
    root_pc: CHORD_TEMPLATE_INDEX[(KEY_NOTE_NAMES[root_pc], "5")] for root_pc in range(12)
}
CHORD_TEMPLATE_ROOT_PC = np.array([KEY_NOTE_NAMES.index(root) for root, _ in CHORD_TEMPLATE_LABELS])


def _apply_bass_root_bonus(scores: "np.ndarray", bass_window_chroma: "np.ndarray") -> None:
    """CD-4: nudges every template whose root matches the bass stem's
    dominant pitch class this beat, in place. A no-op (not an error) when
    the bass window has no energy (e.g. a bass rest, or beats past the end
    of a shorter bass stem) — same "a missing reading just skips" contract
    as everywhere else; the caller already only invokes this when a bass
    stem was found at all."""
    if not np.any(bass_window_chroma > 0):
        return
    bass_root_pc = int(np.argmax(bass_window_chroma))
    scores[CHORD_TEMPLATE_ROOT_PC == bass_root_pc] += CHORD_BASS_ROOT_BONUS


def _gate_power_chord_scores(scores: "np.ndarray", window_chroma: "np.ndarray") -> None:
    """CD-2 (real-song fix): a third-present/absent gate has to cut both
    ways, not just one. The original version of this only ever suppressed
    "5" when a third WAS present — it never stopped maj/min/7 from
    winning anyway when a third was genuinely ABSENT. That looked fine on
    synthetic tests (a bare root+fifth vector has nothing else to match),
    but on real distorted-guitar audio a bare power chord still carries
    incidental harmonic/distortion energy near a flat 7th (an
    intermodulation artifact of playing a root and its fifth through
    distortion, not a played note) — so the "7" template (root, 3rd, 5th,
    b7), being a superset of "5"'s two bins plus that one, kept
    out-scoring "5" even with zero actual third. Real user report: power
    chords showing up as "7" almost everywhere instead of "5". Fixed by
    making the gate symmetric: when a root's third is genuinely absent,
    every OTHER template that root could compete under (maj/min/7, all of
    which require a 3rd) gets suppressed too, so "5" wins outright instead
    of merely being allowed to compete.

    window_chroma MUST be the pre-log-compression (raw, linear) chroma
    window, not the compressed one template matching uses — this is a
    ratio test, and log compression (CD-3) inflates a small bin's
    apparent share of a large bin's energy well past its real physical
    proportion (measured: ~15% real harmonic bleed at the 3rd reads as
    ~19% after log1p(10x), nearly tripping this gate's 20% threshold —
    see _compute_chord_chroma's docstring). Normalization doesn't matter
    (ratios are scale-invariant), only the log compression does.
    Suppressed scores are set below every real template's possible range
    (cosine similarity of non-negative vectors is >= 0) so a gated
    candidate can never win, including against the N/no-chord state."""
    for root_pc in range(12):
        root_fifth_energy = window_chroma[root_pc] + window_chroma[(root_pc + 7) % 12]
        idx5 = CHORD_POWER_TEMPLATE_INDEX[root_pc]
        if root_fifth_energy <= 0:
            scores[idx5] = -1.0
            continue
        minor3 = window_chroma[(root_pc + 3) % 12]
        major3 = window_chroma[(root_pc + 4) % 12]
        threshold = CHORD_POWER_THIRD_ABSENCE_RATIO * root_fifth_energy
        third_present = minor3 >= threshold or major3 >= threshold
        if third_present:
            scores[idx5] = -1.0
        else:
            for quality in CHORD_QUALITY_INTERVALS:
                if quality == "5":
                    continue
                scores[CHORD_TEMPLATE_INDEX[(KEY_NOTE_NAMES[root_pc], quality)]] = -1.0


def _gate_seventh_chord_scores(scores: "np.ndarray", window_chroma: "np.ndarray") -> None:
    """CD-5 real-song fix (see CHORD_SEVENTH_ABSENCE_RATIO): the same superset problem the
    power-chord gate solves, one template up. "7" (0,4,7,10) is "maj" (0,4,7)
    plus a b7, so it out-scores plain "maj" on any incidental b7 energy — and
    the bass supplies exactly that (its root's 7th partial lands near the b7),
    turning honest major triads into dominant 7ths across a whole song. A
    genuinely-played seventh shows up in the chord instruments, so this — like
    the third-presence gate above — takes the NON-bass chroma: "7" is
    suppressed for a root (so maj/min win) unless that root's b7 bin holds at
    least CHORD_SEVENTH_ABSENCE_RATIO of its root+fifth energy. Same
    out-of-range sentinel (-1.0) so a suppressed candidate can never win.
    Must run on the same non-bass raw chroma the power gate uses."""
    for root_pc in range(12):
        root_fifth_energy = window_chroma[root_pc] + window_chroma[(root_pc + 7) % 12]
        idx7 = CHORD_TEMPLATE_INDEX[(KEY_NOTE_NAMES[root_pc], "7")]
        if root_fifth_energy <= 0:
            scores[idx7] = -1.0
            continue
        b7 = window_chroma[(root_pc + 10) % 12]
        if b7 < CHORD_SEVENTH_ABSENCE_RATIO * root_fifth_energy:
            scores[idx7] = -1.0


def _decode_chord_sequence(raw_scores: "np.ndarray") -> list[tuple]:
    """CD-1 (chord-detection-v2-spec.md §5.4): Viterbi-decode a whole song's
    per-beat template scores at once, instead of picking each beat's argmax
    independently. An explicit N (no confident chord) state is threaded in
    at a fixed emission level (CHORD_CONFIDENCE_FLOOR) so a beat only reads
    as N when every real template scores worse than that baseline — same
    reasoning the old per-beat floor check used, just decided alongside
    every chord state instead of as a special case in front of them.

    The transition matrix is what actually fixes the flicker: staying on
    the previous beat's state is cheap (CHORD_SELF_TRANSITION_P), switching
    to anything else is expensive. A moving riff or palm-muted chug that
    nudges the chroma around beat-to-beat no longer flips the winning
    template unless the underlying harmony has genuinely moved on long
    enough to outweigh that cost.

    Returns one (root, quality) per beat — same shape/order as raw_scores'
    rows — for the caller to zip back up with beat times and per-beat
    confidence."""
    import librosa

    n_beats, n_templates = raw_scores.shape
    n_idx = n_templates  # the N state's column/row index, appended after every chord template

    aug = np.concatenate([raw_scores, np.full((n_beats, 1), CHORD_CONFIDENCE_FLOOR)], axis=1)
    n_states = n_templates + 1

    # Turn raw cosine scores into a per-beat probability distribution over
    # states. Temperature controls how sharply the decode trusts a single
    # beat's raw evidence vs. leaning on the transition prior instead.
    scaled = aug * CHORD_EMISSION_TEMPERATURE
    scaled -= scaled.max(axis=1, keepdims=True)  # numerically stable softmax
    probs = np.exp(scaled)
    probs /= probs.sum(axis=1, keepdims=True)
    prob_matrix = probs.T  # librosa.sequence.viterbi wants (n_states, n_steps)

    off_diag = (1.0 - CHORD_SELF_TRANSITION_P) / (n_states - 1)
    transition = np.full((n_states, n_states), off_diag)
    np.fill_diagonal(transition, CHORD_SELF_TRANSITION_P)
    p_init = np.full(n_states, 1.0 / n_states)

    states = librosa.sequence.viterbi(prob_matrix, transition, p_init=p_init)

    labels = []
    for s in states:
        if int(s) == n_idx:
            labels.append((None, "N"))
        else:
            labels.append(CHORD_TEMPLATE_LABELS[int(s)])
    return labels


def _merge_short_chord_runs(labels: list, raw_scores: "np.ndarray") -> list:
    """CD-1 (chord-detection-v2-spec.md §5.5): belt-and-braces beneath
    Viterbi. The transition cost makes 1-beat islands unlikely, not
    impossible — a genuinely anomalous beat (or one right at a real chord
    boundary) can still decode as its own run. Any run shorter than
    CHORD_MIN_RUN_BEATS is reassigned to whichever neighbor's raw template
    score fits that run's own chroma better, rather than surviving to the
    UI as an extra chip. Only touches the labels list — the caller's
    per-beat dict list still gets one entry per beat, so this relies on the
    UI's existing run-collapsing (renderChordLane/aiLabChordRuns) to fold
    a corrected run into its neighbor's chip."""
    runs = []  # [start, end, label] with end exclusive
    for i, label in enumerate(labels):
        if runs and runs[-1][2] == label:
            runs[-1][1] = i + 1
        else:
            runs.append([i, i + 1, label])

    def score_for(start, end, label):
        if label[1] == "N":
            return CHORD_CONFIDENCE_FLOOR
        idx = CHORD_TEMPLATE_INDEX[label]
        return float(raw_scores[start:end, idx].mean())

    for ri, (start, end, label) in enumerate(runs):
        if end - start >= CHORD_MIN_RUN_BEATS:
            continue
        candidates = [runs[ri - 1][2]] if ri > 0 else []
        if ri + 1 < len(runs):
            candidates.append(runs[ri + 1][2])
        if not candidates:
            continue
        runs[ri][2] = max(candidates, key=lambda l: score_for(start, end, l))

    out = list(labels)
    for start, end, label in runs:
        for i in range(start, end):
            out[i] = label
    return out


def _find_stems_fuzzy(out_dir: Path, exact_names: tuple, hint_words: tuple,
                       exclude_words: tuple = ()) -> list[Path]:
    """Every separation model here produces a fixed, known stem vocabulary
    (drums.wav, guitar.wav, ...) — the fast, exact path every reading in
    analyze_track originally used. An imported stem pack
    (multi-stem-import-spec.md §5) has arbitrary names instead (e.g.
    "Lead_Electric_Guitar_1"), so if none of the exact names exist, fall
    back to substring-matching hint_words against whatever stems do exist
    (skipping anything matching exclude_words) — same cheap,
    good-enough-not-guaranteed spirit as every other heuristic in this
    file. Returns every match (a caller wanting just one picks the
    first); an empty list is the normal "nothing to analyze" case every
    caller already treats as a missing reading, not an error."""
    exact = [out_dir / f"{name}.wav" for name in exact_names]
    exact = [p for p in exact if p.exists()]
    if exact:
        return exact
    matches = []
    for wav_path in sorted(out_dir.glob("*.wav")):
        lname = wav_path.stem.lower()
        if any(w in lname for w in exclude_words):
            continue
        if any(w in lname for w in hint_words):
            matches.append(wav_path)
    return matches


def _compute_chord_chroma(y: "np.ndarray", sr: int) -> tuple:
    """CD-3 (chord-detection-v2-spec.md §5.2): the standard chroma
    preprocessing every published chord-recognition pipeline since NNLS
    Chroma (2010) uses. Harmonic/percussive separation strips transient
    smear (a pick attack or palm-muted chug is broadband noise for an
    instant, landing in every chroma bin right when a chord read matters
    most); explicit tuning estimation keeps a band that's slightly off
    A440 from smearing energy across two adjacent semitone bins instead of
    one; log compression stops a single loud frame from dominating its
    beat window's averaged reading. Returns (chroma_compressed, chroma_raw,
    frame_times) — chroma_raw (pre-log-compression) exists specifically
    for CD-2's power-chord gate, which does a ratio test between bins.
    log1p is monotonic, so it preserves ORDERING between bins (fine for
    cosine template matching, and fine for key_from_chords' minor3-vs-major3
    comparison) but distorts RATIOS between bins of very different
    magnitude — it inflates a small bin's apparent share of a large bin's
    energy well beyond its real, physical proportion (verified: a genuine
    power chord with ~15% real harmonic bleed at the 3rd reads as ~19% in
    log space, nearly tripping the gate's 20% threshold that was designed
    against real physical proportions). A ratio test needs the raw
    values; only cosine similarity and orderings can safely use the
    compressed ones."""
    import librosa

    harmonic = librosa.effects.harmonic(y, margin=CHORD_HPSS_MARGIN)
    tuning = librosa.estimate_tuning(y=harmonic, sr=sr)
    chroma_raw = librosa.feature.chroma_cqt(y=harmonic, sr=sr, tuning=tuning)
    chroma = np.log1p(CHORD_CHROMA_LOG_COMPRESSION_K * chroma_raw)
    frame_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr)
    return chroma, chroma_raw, frame_times


def _beat_windowed_chroma(chroma: "np.ndarray", frame_times: "np.ndarray", beats: list) -> list:
    """Averages a chroma matrix's frames into one vector per beat-grid
    interval [beats[i], beats[i+1]) — the same windowing detect_chords'
    main chroma and CD-4's bass-only chroma both need, factored out so
    they can't drift apart."""
    windows = []
    for start, end in zip(beats, beats[1:]):
        mask = (frame_times >= start) & (frame_times < end)
        windows.append(chroma[:, mask].mean(axis=1) if np.any(mask) else np.zeros(chroma.shape[0]))
    return windows


def detect_chords(out_dir: Path, beats: list) -> tuple[list[dict], "np.ndarray"] | None:
    """One chord guess per beat-grid interval [beats[i], beats[i+1]).
    Chroma source is the sum of every pitched, non-percussive, non-vocal
    stem available (bass/other/guitar/piano) — deliberately excludes vocals
    (a sung melody isn't the harmony backing it) and drums (no pitch
    content, just chroma-bin noise). Returns None if there's no beat grid
    to align to, or no pitched stem to analyze — same "a missing reading is
    fine" contract as every other field in analyze_track.

    Also returns the whole-song mean chroma vector alongside the chords —
    key_from_chords needs it to judge major/minor directly from note
    content at the detected tonic, rather than trusting whichever single
    chord's template happened to win the per-beat match (see that
    function's docstring for why that's unreliable specifically on
    power-chord-heavy material)."""
    if not beats or len(beats) < 2:
        return None

    import librosa

    stem_paths = _find_stems_fuzzy(
        out_dir, exact_names=("bass", "other", "guitar", "piano"),
        hint_words=("guitar", "bass", "piano", "keys", "synth", "organ", "string"),
        exclude_words=("vocal", "vox", "voice", "drum", "kit", "perc"))

    bass_paths = _find_stems_fuzzy(
        out_dir, exact_names=("bass",), hint_words=("bass",),
        exclude_words=("vocal", "vox", "voice", "drum", "kit", "perc"))
    bass_path_set = {str(p) for p in bass_paths}

    sources = []
    harmonic_sources = []  # CD-2 gate: pitched stems EXCLUDING bass (see below)
    sr = None
    for stem_path in stem_paths:
        y, sr = librosa.load(str(stem_path), sr=None, mono=True)
        sources.append(y)
        if str(stem_path) not in bass_path_set:
            harmonic_sources.append(y)
    if not sources:
        return None

    max_len = max(len(y) for y in sources)
    mono = np.zeros(max_len, dtype=np.float32)
    for y in sources:
        mono[:len(y)] += y

    # CD-2 / CD-5 / CD-7 ("Mull of Kintyre" + "Norwegian Wood" passes): a
    # chord's IDENTITY — its root AND quality — is read from the CHORD
    # instruments, never the bass. A bass note is almost pure root energy, and
    # summed into the chroma it swamps the whole vector: it buries the third
    # (the one bin telling maj from min, and telling a triad from a power
    # chord) far below the noise floor. Measured on a clean E-major triad, the
    # major-third bin holds ~0.99 of the root guitar-only but collapses to
    # ~0.04 once an E bass is summed in — at which point random leakage in the
    # minor-third bin (~0.045) actually outscores it and a plain E major
    # decodes as E minor. Same root cause as the power-chord gate reading a
    # triad as "5". So ALL of chord recognition — template matching, the
    # power/seventh gates, and the whole-song mode chroma key_from_chords uses
    # — runs on the non-bass mix; the bass contributes only through CD-4's
    # explicit, controlled root bonus below. Falls back to the full mix when
    # there's no separable non-bass stem (a bass-only or single-stem source).
    if harmonic_sources:
        harmonic_len = max(len(y) for y in harmonic_sources)
        id_mono = np.zeros(harmonic_len, dtype=np.float32)
        for y in harmonic_sources:
            id_mono[:len(y)] += y
    else:
        id_mono = mono
    chroma, chroma_raw, frame_times = _compute_chord_chroma(id_mono, sr)
    chroma_mean = chroma.mean(axis=1)
    main_windows = _beat_windowed_chroma(chroma, frame_times, beats)
    gate_windows_raw = _beat_windowed_chroma(chroma_raw, frame_times, beats)  # raw (pre-log) ratios for the gates

    # CD-4: the bass stem states a chord's root more reliably than the full
    # mix — a small per-beat bonus toward whatever root the bass agrees
    # with, skipped silently (not an error) when there's no bass stem, or
    # its feature extraction hits an edge case (e.g. a near-silent bass
    # part on a mostly-acoustic passage).
    bass_windows = None
    if bass_paths:
        try:
            bass_y, bass_sr = librosa.load(str(bass_paths[0]), sr=None, mono=True)
            bass_chroma, _, bass_frame_times = _compute_chord_chroma(bass_y, bass_sr)
            bass_windows = _beat_windowed_chroma(bass_chroma, bass_frame_times, beats)
        except Exception:
            bass_windows = None

    raw_scores = np.zeros((len(beats) - 1, len(CHORD_TEMPLATE_LABELS)))
    for i, window_chroma in enumerate(main_windows):
        norm = np.linalg.norm(window_chroma)
        normed_chroma = window_chroma / norm if norm > 0 else window_chroma
        scores = CHORD_TEMPLATE_MATRIX @ normed_chroma
        _gate_power_chord_scores(scores, gate_windows_raw[i])  # CD-2 — non-bass raw ratios (see above)
        _gate_seventh_chord_scores(scores, gate_windows_raw[i])  # CD-5 real-song fix — phantom-b7 (bass overtone) guard
        if bass_windows is not None:
            _apply_bass_root_bonus(scores, bass_windows[i])  # CD-4
        raw_scores[i] = scores

    # CD-1: decode the whole beat sequence at once (Viterbi, not per-beat
    # argmax) so ordinary chroma noise no longer flips single beats to a
    # different chord — see _decode_chord_sequence's docstring.
    labels = _decode_chord_sequence(raw_scores)
    labels = _merge_short_chord_runs(labels, raw_scores)

    chords = []
    for i, start in enumerate(beats[:-1]):
        root, quality = labels[i]
        confidence = float(raw_scores[i].max())
        chords.append({"time": round(float(start), 3), "root": root, "quality": quality,
                        "confidence": round(confidence, 3)})
    return chords, chroma_mean


def key_from_chords(chords: list, chroma_mean: "np.ndarray" = None) -> dict | None:
    """A tonic-frequency key estimate from the chord lane (BT-04) itself,
    used in analyze_track to override detect_key's raw chroma-profile
    correlation when confident chords exist. Caught by a real song where
    detect_key confidently reported C# minor while the chord lane clearly
    showed A as the tonic (270/417 beats some form of A, next-most-common
    barely a fifth of that) — the classical Krumhansl major/minor profiles
    detect_key correlates against fit blues/rock's dominant-7-heavy
    harmony poorly to begin with, where this song's chords are a much
    more direct signal.

    Tonic is found by Krumhansl-Schmuckler key-profile correlation over the
    chord-content histogram (BT-03b, "Hotel California" pass), replacing an
    earlier "most frequent chord root is the tonic" rule. That rule's own
    caveat — "a real song can spend more beats on IV or bVII than I" — turned
    out to be Hotel California exactly: Bm-F#-A-E-G-D-Em-F# is plainly B minor,
    yet root-counting ranks E and F# highest and B nearly lowest and returns a
    confident "E minor". Correlating the whole pitch-class content against the
    24 rotated major/minor profiles weighs the tonal hierarchy properly and
    finds B minor even though B is the least-played chord in the loop (it also
    resolved a I-IV two-chord vamp — "That's Entertainment" — that
    root-counting left tied between the two chords).

    Mode is judged directly from minor-3rd vs major-3rd chroma energy at
    that root (whole-song mean, same chroma detect_chords already
    computed) rather than from whichever quality label the single
    most-frequent chord happened to get. This predates detect_chords having
    an explicit "5" (power chord) template (CD-2, chord-detection-v2-spec.md):
    before that, a genuine power chord (root+5th, no 3rd at all) was a tie
    between the maj (0,4,7) and min (0,3,7) templates — both share 2 of 3
    active bins and get zero contribution from the one bin that would tell
    them apart — resolved arbitrarily to whichever template was built first
    (maj), and a distorted guitar's real harmonic series naturally adds
    energy at the major-3rd overtone regardless of the chord's intended
    quality. Both effects systematically biased riff/power-chord-heavy rock
    and metal — a genre this app specifically targets — toward false
    'major' reads. Checking the actual note energy at the chosen tonic
    sidesteps that bias directly rather than inheriting it from a label —
    and stays correct now that "5"-quality chords carry no mode information
    of their own to inherit in the first place. Falls back to the naive
    quality-label rule if no chroma_mean is available (keeps this function
    usable
    without a re-run for any old caller)."""
    # Tonic via Krumhansl-Schmuckler key-profile correlation over a
    # chord-content histogram — NOT "most frequent root" (BT-03b, "Hotel
    # California" pass). A real song can play its tonic chord LEAST of all
    # while sitting on the dominant, relative major, or a bVII/bVI far more:
    # Hotel California's Bm-F#-A-E-G-D-Em-F# is plainly B minor, but counting
    # roots ranks E and F# highest and B nearly lowest, giving a confidently
    # wrong "E minor". Correlating the whole pitch-class content against the 24
    # rotated major/minor key profiles weighs the tonal hierarchy the way
    # key-finding actually works and finds B minor even though B is barely
    # played. The chord lane is a cleaner input for this than raw audio chroma
    # (no timbre, no drone, no bleed), which is exactly why key_from_chords
    # beats detect_key's audio-chroma correlation on chord-rich material.
    hist = np.zeros(12)
    for c in chords:
        if not c.get("root") or c.get("quality") == "N":
            continue
        root_pc = KEY_NOTE_NAMES.index(c["root"])
        for interval in CHORD_QUALITY_INTERVALS.get(c["quality"], (0,)):
            hist[(root_pc + interval) % 12] += 1.0
    if hist.sum() <= 0:
        return None

    scored = []  # (corr, root_pc, mode)
    for mode_name, profile in (("major", KEY_MAJOR_PROFILE), ("minor", KEY_MINOR_PROFILE)):
        profile_norm = profile / profile.sum()
        for root_pc in range(12):
            corr = float(np.corrcoef(hist, np.roll(profile_norm, root_pc))[0, 1])
            scored.append((corr, root_pc, mode_name))
    scored.sort(key=lambda t: t[0], reverse=True)
    best_corr, root_pc, mode_krum = scored[0]
    runner_corr = scored[1][0] if len(scored) > 1 else 0.0
    root = KEY_NOTE_NAMES[root_pc]

    # Margin-aware confidence (BT-03b): a high correlation isn't enough on its
    # own. A power-chord-only song fits several relative/parallel/neighbouring
    # keys almost equally, so the winner can post a high absolute score with a
    # thin margin over the next key — a confident-looking wrong answer. Scaling
    # by the margin makes those genuinely-ambiguous keys report honestly low
    # confidence ("check / correct this"), while a clear tonal centre (wide
    # margin) keeps its full score. See KEY_MARGIN_FULL_CONF.
    margin = best_corr - runner_corr
    confidence = round(max(0.0, best_corr) * min(1.0, margin / KEY_MARGIN_FULL_CONF), 3)

    # Mode: keep the CD-2-era direct chroma check (minor-3rd vs major-3rd
    # energy at the chosen tonic) when chroma is available — it's what makes
    # power-chord-heavy rock/metal read minor when it is minor (a power chord
    # carries no third, so the chord histogram alone can't tell the mode and
    # the profile correlation is a near-coin-flip there). Falls back to the
    # profile-correlation's own mode when there's no chroma to check.
    if chroma_mean is not None:
        minor3 = float(chroma_mean[(root_pc + 3) % 12])
        major3 = float(chroma_mean[(root_pc + 4) % 12])
        mode = "minor" if minor3 >= major3 else "major"
    else:
        mode = mode_krum

    return {"key": root, "mode": mode, "confidence": confidence}


# BT-20 (song-section detection, song-section-detection-spec.md): the same
# beat-synchronous, self-similarity + Foote-novelty recipe the MIR structure
# literature has used since Foote 2000 / MSAF. NOT a verse/chorus transcriber:
# it finds where the song's *texture and harmony* change enough to call a
# boundary, then labels repeated material with the same letter (A/B/C…), so
# the UI can show "this bit here comes back later" and let you jump to / loop a
# section — the same assistive-not-authoritative framing as the chord lane and
# key detection. Semantic names (intro/verse/chorus/solo) are deliberately out
# of scope for a first cut: they need reliable repetition-counting + loudness
# heuristics that mislabel more than they help, and a wrong "Chorus" tag reads
# worse than an honest "Section B".
# A fixed ~1s feature grid, NOT a beat-synchronous one. Beat-sync is the
# textbook choice, but it depends on the beat tracker covering the whole song,
# and a quiet drumless intro (Mull of Kintyre again) gets no beats there — so
# that whole passage collapses into a single feature column and can't be seen
# as its own section. A uniform time grid has no such blind spot, its
# time-mapping is trivial (column j starts at j * window seconds), and at ~1s
# resolution it's easily fine for the coarse boundaries this feature reports.
SECTION_WINDOW_SECONDS = 1.0        # feature-grid resolution: frames pooled into ~1s windows
SECTION_MIN_SECONDS = 8.0           # real-music floor: sections shorter than this get merged away (drop their weakest-novelty boundary) — a 5-second "section" is over-segmentation, not structure
SECTION_KERNEL_HALF_SECONDS = 12.0  # Foote checkerboard half-width in seconds — the timescale section changes are looked for at
SECTION_NOVELTY_DELTA = 0.06        # peak-pick threshold on the normalized novelty curve; higher = fewer, more confident boundaries
SECTION_LABEL_SIM = 0.72            # cosine similarity between two segments' mean features above which they get the SAME letter (are "the same kind of section")
SECTION_MAX_LABELS = 8              # never invent more distinct letters than this — beyond it, structure reads as noise, not sections


def _checkerboard_kernel(half: int) -> "np.ndarray":
    """A Gaussian-radially-tapered checkerboard kernel (Foote 2000): +1 in the
    top-left / bottom-right quadrants (self-similar past & future), -1 in the
    off-diagonal quadrants (past vs future differ). Slid down a self-similarity
    matrix's diagonal it peaks exactly where the block structure switches — a
    section boundary. The Gaussian taper weights the cell nearest the diagonal
    most, so a sharp local change matters more than distant material."""
    axis = np.arange(-half, half)
    xx, yy = np.meshgrid(axis, axis)
    sigma = half / 2.0
    gauss = np.exp(-(xx ** 2 + yy ** 2) / (2 * sigma ** 2))
    return np.sign(xx) * np.sign(yy) * gauss


def _foote_novelty(ssm: "np.ndarray", half: int) -> "np.ndarray":
    """Correlate the checkerboard kernel along the SSM diagonal → a novelty
    curve, one value per beat, normalized to [0,1]. Zero-padded at the ends
    (the very start/end are always boundaries anyway, so their edge artifacts
    don't matter)."""
    n = ssm.shape[0]
    ker = _checkerboard_kernel(half)
    padded = np.pad(ssm, half, mode="constant", constant_values=0.0)
    nov = np.empty(n)
    for i in range(n):
        nov[i] = float(np.sum(ker * padded[i:i + 2 * half, i:i + 2 * half]))
    nov = np.maximum(nov, 0.0)
    peak = nov.max()
    return nov / peak if peak > 0 else nov


def _label_segments(feat_norm: "np.ndarray", bounds: list) -> list:
    """Greedy cosine labeling: walk the segments in order, giving each one an
    existing letter if its mean feature vector is within SECTION_LABEL_SIM of
    that letter's centroid, otherwise a fresh letter (up to SECTION_MAX_LABELS,
    after which the nearest existing letter is reused). Repeated material
    (verse, verse-reprise) collapses to one letter; genuinely new material gets
    its own. Returns a label string per segment."""
    centroids = []  # (unit-normalized centroid, count) per letter
    labels = []
    for a, b in zip(bounds, bounds[1:]):
        m = feat_norm[:, a:b].mean(axis=1)
        m = m / (np.linalg.norm(m) + 1e-9)
        sims = [float(m @ c) for c, _ in centroids]
        best = int(np.argmax(sims)) if sims else -1
        if best >= 0 and (sims[best] >= SECTION_LABEL_SIM or len(centroids) >= SECTION_MAX_LABELS):
            c, cnt = centroids[best]
            merged = (c * cnt + m)
            centroids[best] = (merged / (np.linalg.norm(merged) + 1e-9), cnt + 1)
            labels.append(best)
        else:
            centroids.append((m, 1))
            labels.append(len(centroids) - 1)
    return [chr(ord("A") + i) for i in labels]


def detect_sections(out_dir: Path, beats: list = None) -> list | None:
    """BT-20: coarse song structure — a list of {start, end, label} regions.
    Uses the FULL mix (every stem summed, drums and vocals included) on
    purpose: instrumentation and texture changes (drums or vocals entering, a
    solo) are exactly the cues a section boundary rides on, the opposite of
    detect_chords which strips them. Works on a fixed ~1s feature grid (not the
    beat grid — see SECTION_WINDOW_SECONDS), so a quiet drumless intro is
    covered like anything else. `beats` is accepted for signature stability but
    unused. Returns None (a fine "no reading" — never fatal) when the song is
    too short to have structure worth showing."""
    import librosa

    wavs = [w for w in sorted(out_dir.glob("*.wav"))
            if w.stem.lower() not in ("click", "beat", "beats", "metronome")]
    if not wavs:
        return None

    sources = []
    sr = None
    for w in wavs:
        y, sr = librosa.load(str(w), sr=None, mono=True)
        sources.append(y)
    max_len = max(len(y) for y in sources)
    mono = np.zeros(max_len, dtype=np.float32)
    for y in sources:
        mono[:len(y)] += y

    hop = 512
    song_end = float(len(mono) / sr)
    frame_sec = hop / sr
    pool = max(1, int(round(SECTION_WINDOW_SECONDS / frame_sec)))  # frames per ~1s window
    win_sec = pool * frame_sec
    min_win = max(2, int(round(SECTION_MIN_SECONDS / win_sec)))

    # Timbre (MFCC — catches instrumentation/texture) + harmony (chroma —
    # catches a verse/chorus that differs by chords), the two complementary
    # feature families the structure literature stacks — pooled from the native
    # frame rate into fixed ~1s windows.
    mfcc = librosa.feature.mfcc(y=mono, sr=sr, n_mfcc=13, hop_length=hop)
    chroma = librosa.feature.chroma_cqt(y=mono, sr=sr, hop_length=hop)
    n_frames = min(mfcc.shape[1], chroma.shape[1])
    n = n_frames // pool
    if n < 2 * min_win:
        return None

    def _pool(x):
        usable = n * pool
        return x[:, :usable].reshape(x.shape[0], n, pool).mean(axis=2)

    def _znorm(x):
        return (x - x.mean(axis=1, keepdims=True)) / (x.std(axis=1, keepdims=True) + 1e-9)

    feat = np.vstack([_znorm(_pool(mfcc[:, :n_frames])), _znorm(_pool(chroma[:, :n_frames]))])
    feat_norm = feat / (np.linalg.norm(feat, axis=0, keepdims=True) + 1e-9)
    ssm = feat_norm.T @ feat_norm  # cosine self-similarity, one column/row per ~1s window

    half = max(2, min(int(round(SECTION_KERNEL_HALF_SECONDS / win_sec)), n // 2 - 1))
    novelty = _foote_novelty(ssm, half)

    peaks = librosa.util.peak_pick(
        novelty, pre_max=min_win, post_max=min_win,
        pre_avg=min_win, post_avg=min_win,
        delta=SECTION_NOVELTY_DELTA, wait=min_win)

    # Fixed grid → trivial time-mapping: window j starts at j * win_sec, and the
    # final boundary is the true song end.
    boundtimes = np.concatenate([np.arange(n) * win_sec, [song_end]])

    bounds = [0] + [int(p) for p in peaks if min_win <= int(p) <= n - min_win] + [n]
    bounds = sorted(set(bounds))
    if len(bounds) < 2:
        return None

    # Real-music floor: merge away any segment shorter than SECTION_MIN_SECONDS
    # by dropping the weaker (lower-novelty) of the boundaries bordering it,
    # until every surviving section clears the floor. A 5-second "section" is
    # over-segmentation from a transient (a fill, a single loud hit), not
    # structure worth showing.
    def _novelty_at(col):
        return float(novelty[col]) if 0 <= col < len(novelty) else 1.0

    while len(bounds) > 2:
        durs = [boundtimes[b] - boundtimes[a] for a, b in zip(bounds, bounds[1:])]
        i = int(np.argmin(durs))
        if durs[i] >= SECTION_MIN_SECONDS:
            break
        cands = []
        if i > 0:
            cands.append(i)          # drop the left border of segment i
        if i + 1 < len(bounds) - 1:
            cands.append(i + 1)      # drop the right border of segment i
        if not cands:
            break
        bounds.pop(min(cands, key=lambda k: _novelty_at(bounds[k])))

    labels = _label_segments(feat_norm, bounds)

    # Collapse consecutive same-letter segments (a boundary the novelty found
    # inside what turns out to be one kind of section) into a single run.
    merged_bounds = [bounds[0]]
    merged_labels = []
    for idx, label in enumerate(labels):
        if merged_labels and merged_labels[-1] == label:
            merged_bounds[-1] = bounds[idx + 1]
        else:
            merged_labels.append(label)
            merged_bounds.append(bounds[idx + 1])

    sections = []
    for (a, b), label in zip(zip(merged_bounds, merged_bounds[1:]), merged_labels):
        start = float(boundtimes[a])
        end = float(boundtimes[min(b, len(boundtimes) - 1)])
        if end - start <= 0:
            continue
        sections.append({"start": round(start, 3), "end": round(end, 3), "label": label})
    return sections or None


def analyze_track(out_dir: Path) -> dict:
    """BT-01/BT-16/BT-03/BT-04: best-effort tempo + reference-pitch + key +
    chord analysis. Tempo comes from the drums stem (present for every
    model) via librosa's tempo estimator; pitch offset from A=440 (in
    cents) and detected key both come from librosa run on the first
    harmonic-ish stem available; chords (see detect_chords) need the beat
    grid computed just above them. Any figure is simply omitted from the
    result if its stem is missing or the estimate fails — a missing
    reading is fine; this must never be the reason a separation run
    fails."""
    import librosa
    import librosa.feature.rhythm

    result = {"version": ANALYSIS_VERSION}

    drums_matches = _find_stems_fuzzy(
        out_dir, exact_names=("drums",), hint_words=("drum", "kit", "percussion"))
    drums_path = drums_matches[0] if drums_matches else None
    if drums_path is not None:
        try:
            y, sr = librosa.load(str(drums_path), sr=None, mono=True)
            # librosa's tempo estimator defaults to a start_bpm=120 prior,
            # which on fast material reliably locks onto half the true
            # tempo instead (the autocorrelation genuinely finds stronger
            # periodicity at half-speed for some drum patterns — this
            # isn't a fluke of one song). Verified against this project's
            # own real tracks: default settings misread four different
            # fast rock/metal songs at ~85-88 BPM when the true tempo is
            # ~170-178; a start_bpm=140 prior corrects all four to within
            # a few BPM of their known tempo while leaving every
            # already-correct mid-tempo track (~90-115 BPM) completely
            # unchanged — the true tempo dominates the estimate regardless
            # of prior once it's not competing with a spuriously-stronger
            # half-tempo peak.
            onset_env = librosa.onset.onset_strength(y=y, sr=sr)
            tempo = librosa.feature.rhythm.tempo(onset_envelope=onset_env, sr=sr, start_bpm=140)
            bpm = float(np.asarray(tempo).reshape(-1)[0])
            if bpm > 0:
                result["bpm"] = round(bpm, 1)

            # BT-02: the beat grid — individual beat timestamps, not just a
            # single averaged BPM figure. Reuses the same onset envelope/
            # prior as the BPM estimate above (same half-tempo failure mode
            # this start_bpm already corrects for) so the two stay
            # consistent with each other. Powers the click stem and any
            # future beat-aligned UI; a separate try so a beat-tracking
            # failure doesn't cost the BPM reading that already succeeded.
            try:
                _, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, start_bpm=140)
                beat_times = librosa.frames_to_time(beat_frames, sr=sr)
                if len(beat_times):
                    result["beats"] = [round(float(t), 3) for t in beat_times]
            except Exception:
                pass
        except Exception:
            pass

    # BT-02 fallback (real-song fix, "Mull of Kintyre" pass): the beat grid —
    # and therefore the whole chord lane, which is windowed per beat interval
    # — was derived ONLY from the drums stem. A drumless song (a fingerpicked
    # acoustic piece, a hymn, the quiet intro before the band comes in) has no
    # drums.wav worth tracking, so it produced no beats at all and an entirely
    # empty chord lane — nothing for the Mixer chord ribbon or AI Lab to show.
    # A plucked/strummed chord is a perfectly good onset source, so when the
    # drums stem is missing or yielded no beats, fall back to onset tracking on
    # the pitched stems (bass included — its note onsets help). Same start_bpm
    # prior as the drums path so the two stay consistent; a separate try so a
    # fallback failure never costs readings that already succeeded.
    if "beats" not in result:
        try:
            fb_paths = _find_stems_fuzzy(
                out_dir, exact_names=("other", "guitar", "piano", "bass"),
                hint_words=("guitar", "piano", "keys", "synth", "organ", "string", "bass"),
                exclude_words=("vocal", "vox", "voice", "drum", "kit", "perc"))
            fb_sources = []
            fb_sr = None
            for p in fb_paths:
                fy, fb_sr = librosa.load(str(p), sr=None, mono=True)
                fb_sources.append(fy)
            if fb_sources:
                fb_len = max(len(fy) for fy in fb_sources)
                fb_mono = np.zeros(fb_len, dtype=np.float32)
                for fy in fb_sources:
                    fb_mono[:len(fy)] += fy
                fb_onset = librosa.onset.onset_strength(y=fb_mono, sr=fb_sr)
                if "bpm" not in result:
                    fb_tempo = librosa.feature.rhythm.tempo(onset_envelope=fb_onset, sr=fb_sr, start_bpm=140)
                    fb_bpm = float(np.asarray(fb_tempo).reshape(-1)[0])
                    if fb_bpm > 0:
                        result["bpm"] = round(fb_bpm, 1)
                _, fb_frames = librosa.beat.beat_track(onset_envelope=fb_onset, sr=fb_sr, start_bpm=140)
                fb_times = librosa.frames_to_time(fb_frames, sr=fb_sr)
                if len(fb_times):
                    result["beats"] = [round(float(t), 3) for t in fb_times]
        except Exception:
            pass

    pitched_matches = _find_stems_fuzzy(
        out_dir, exact_names=("other", "guitar", "piano"),
        hint_words=("guitar", "piano", "keys", "synth", "organ", "string"),
        exclude_words=("vocal", "vox", "voice", "drum", "kit", "perc", "bass"))
    for stem_path in pitched_matches:
        try:
            y, sr = librosa.load(str(stem_path), sr=None, mono=True)
            tuning = librosa.estimate_tuning(y=y, sr=sr)
            result["pitch_offset_cents"] = round(float(tuning) * 100, 1)
            key = detect_key(y, sr)
            if key:
                result["key"] = key
            break
        except Exception:
            continue

    # BT-04: needs the beat grid above it, so runs last and is skipped
    # entirely if beat tracking didn't produce one — separate try so a
    # chord-detection failure never costs the bpm/beats/key readings that
    # already succeeded.
    try:
        chord_result = detect_chords(out_dir, result.get("beats"))
        if chord_result:
            chords, chroma_mean = chord_result
            result["chords"] = chords
            chord_key = key_from_chords(chords, chroma_mean)
            if chord_key:
                result["key"] = chord_key  # overrides detect_key's chroma-profile guess — see key_from_chords' docstring
    except Exception:
        pass

    # BT-20: coarse song structure (see detect_sections). Its own try — a
    # segmentation failure never costs the readings above it — and, like every
    # other field here, simply omitted when there's no confident reading.
    try:
        sections = detect_sections(out_dir, result.get("beats"))
        if sections:
            result["sections"] = sections
    except Exception:
        pass

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
    """Return cached analysis if current; otherwise (re)compute and cache.
    Lets stems separated before an analysis reading existed get backfilled
    lazily (on next 'separate', 'list', or app open) rather than requiring a
    forced re-separation. The version check matters as much as the existence
    check: a cache written before ANALYSIS_VERSION's readings existed would
    otherwise be served forever with those keys silently missing — the
    browser's click stem doing nothing because a pre-beat-grid cache never
    gains a "beats" key was exactly this bug."""
    existing = read_analysis(out_dir)
    if existing and existing.get("version", 1) >= ANALYSIS_VERSION:
        return existing
    try:
        analysis = analyze_track(out_dir)
    except Exception:
        analysis = {}
    if analysis:
        write_analysis(out_dir, analysis)
        return analysis
    return existing


# V4-R1a (rate-my-take-spec.md §3/§6): the research spike's scoring core.
# Confidence-weighted per-beat agreement between a dry take and the
# isolated guitar stem it's meant to match — pitch via chroma cosine
# similarity (octave/tone-blind, so a Strat take vs. a Les Paul record
# compares fairly), timing via onset-envelope cross-correlation in a small
# window, confidence via reference-stem RMS (a beat where the reference
# guitar is nearly silent shouldn't be scored as if it were authoritative).
RATE_ONSET_LAG_WINDOW_MS = 150  # widened from spec §3's original 80ms — see timing_score's comment below
RATE_PITCH_WEIGHT = 0.6
RATE_TIMING_WEIGHT = 0.4
RATE_CONFIDENCE_FLOOR = 0.02  # reference RMS below this = no real signal to score against, excluded from the aggregate
# Vibrato spreads a note's pitch content across its own neighboring semitone
# bins in the chroma vector — two independent vibrato sweeps on "the same"
# note don't line up bin-for-bin, which can read as pitch disagreement even
# though a listener hears the same note. A small circular smoothing kernel
# blurs each chroma bin's energy slightly into its immediate neighbors
# before comparing, so real player-to-player vibrato/intonation variance
# costs a bit less than getting the wrong note outright.
#
# Deliberately weak, after measuring the tradeoff directly: a synthetic
# genuinely-wrong-note take (root shifted 1-4 semitones, no vibrato at all)
# scored pitch=0.68 with no smoothing, but 0.84 at the first version's
# (0.15, 0.70, 0.15) weights — the smoothing was blurring wrong-note
# discrimination away almost as much as it helped real vibrato, and
# realistic vibrato/intonation wobble (+-30-50 cents, well under a full
# semitone) barely benefited from smoothing at all either way (>=0.98 with
# or without it) — raw chroma cosine similarity already tolerates that much
# on its own, since it falls mostly within the same bin. The only case
# smoothing meaningfully helped was extreme (70-100 cent) mistuning, which
# reads more as playing sharp/flat than vibrato. Kept small rather than
# removed entirely, as a modest safety margin for that extreme case,
# without meaningfully compromising wrong-note discrimination the way the
# original weights did.
CHROMA_VIBRATO_SMOOTH_KERNEL = (0.05, 0.90, 0.05)  # (prev semitone, self, next semitone)

# Real-audio finding (rate-my-take-spec.md's Update): chroma cosine
# similarity is octave-blind and averaged across a whole beat window, which
# is exactly right for chords/rhythm but far too coarse for a monophonic
# solo — proven with a "guitar stem vs. itself, 5 seconds misaligned"
# sanity test, which SHOULD read as ~0% (completely different content) but
# read as 59% on chroma alone, since a solo that stays in one key/scale
# still shares most of its pitch classes with any other few-second excerpt
# of itself. Real pitch-tracking (fundamental frequency, not aggregate
# pitch-class energy) discriminates a specific wrong note the way a
# listener does; the same sanity test reads ~100% at zero offset and ~0%
# at 5 seconds off once real F0 comparison is used instead.
#
# Confidence filtering (RATE_PITCH_VOICED_PROB_FLOOR) turned out to matter
# as much as the F0 tracking itself: a home-recorded dry take is noisier
# than the pristine separated reference stem, and low-confidence pyin
# frames (bends mid-slide, palm-muted transients, string noise, silence)
# produce essentially random pitch estimates that read as wild "wrong
# note" cents differences even on a genuinely well-played take if left
# unfiltered. Measured directly on a real Good/Bad take pair: unfiltered
# F0 gave mean pitch 0.41 (Good) vs. 0.10 (Bad) — real discrimination,
# but noisy; filtering to only high-confidence frames on both sides
# sharpened that to median 0.84 (Good) vs. 0.00 (Bad).
#
# A beat with no confident F0 reading on either side (a chord strum, a
# palm-muted chug, near-silence) falls back to the chroma method above —
# monophonic pitch tracking doesn't apply there, chroma still does.
RATE_PITCH_FMIN_HZ = 82.4    # E2, low E string open
RATE_PITCH_FMAX_HZ = 1318.5  # E6, generous headroom for high frets/bends
RATE_PITCH_VOICED_PROB_FLOOR = 0.5  # pyin frames below this confidence are excluded, not just low-weighted
RATE_PITCH_CENTS_WINDOW = 100  # cents (~1 semitone); beyond this a note reads as genuinely different, not intonation/vibrato

# First real-data calibration pass (rate-my-take-spec.md's third Update).
# Still not "done" — one real Good/Bad pair is enough to move off the
# original arbitrary 0.3/0.9 (which was never checked against anything
# real), not enough to fit precisely. A real Good/Bad pair with monophonic
# pitch-tracking (see RATE_PITCH_CENTS_WINDOW above) scored raw 0.688
# (Good) and 0.572 (Bad) — a genuine but narrow gap. Deliberately NOT
# fit exactly to those two numbers (e.g. floor/ceiling chosen so Good
# lands on some target percentage and Bad on another): with only two data
# points, any straight line can be solved to hit two arbitrary targets
# exactly, which would prove nothing about whether the mapping
# generalizes to a third take — that's overfitting, not calibration.
# Instead these bracket the observed raw range with margin on both sides:
# floor sits just below Bad's raw score (so Bad reads low but doesn't get
# slammed to a literal 0%, leaving room below for a genuinely worse take
# to still read lower), ceiling sits comfortably above Good's raw score
# (so a better take than this "Good" one still has room to climb, rather
# than every reasonably-good take maxing out at 100%). Needs more real
# Good/Bad/Variation triples to tighten further — see cmd_rate's printed
# reminder of exactly that.
# Second real-data calibration pass, after RATE_CHROMA_SHARPEN_POWER's
# fallback-pitch fix above changed the raw-score distribution (as expected —
# see that fix's comment). Same three real dry takes, this time scored by
# the app itself (correct per-take offset, unlike this session's own earlier
# guessed-offset reproduction): good take raw 0.59 (16% under the old 0.55/
# 0.80 mapping), best take raw 0.763 (85.2%), bad take unknown exact raw
# (clamped to 0% — was at or below the old 0.55 floor). User's own ears:
# bad "could score a few percent higher" (not literal 0%), good "should be
# over 50% at least", best "OK, could be up to 90%". Floor/ceiling solved
# from the two known-exact raw values against those two targets (good ->
# ~55%, best -> ~88%, leaving headroom on both sides rather than snapping
# exactly to 50/90): span = (0.763-0.59)/(0.88-0.55) = 0.524, floor =
# 0.59-0.55*0.524 = 0.302. Rounded to 0.30/0.83. Bad take's exact raw score
# still isn't known (only bounded above by the *old* floor, which no longer
# applies post-sharpening) — `overall_raw` is now also shown in the AI Lab
# UI (see ailab.js) specifically so this doesn't require guessing next
# time; still needs one more real check that the bad take's new pct lands
# in the few-percent range its raw score is expected to produce.
RATE_CALIBRATION_FLOOR = 0.30   # raw blended score presumed to map to ~0%
RATE_CALIBRATION_CEILING = 0.83  # raw blended score presumed to map to ~100%
RATE_OFFSET_SEARCH_MIN_QUALITY = 0.15  # below this, refine_offset's match is noise, not a real alignment


def _smooth_chroma_for_vibrato(vec: "np.ndarray") -> "np.ndarray":
    """Circularly blurs a 12-bin chroma vector across its own semitone
    neighbors — see CHROMA_VIBRATO_SMOOTH_KERNEL's comment for why. Circular
    (np.roll, not a plain shift) because chroma bins wrap: the semitone
    'below' bin 0 (C) is bin 11 (B), not nothing."""
    prev_w, self_w, next_w = CHROMA_VIBRATO_SMOOTH_KERNEL
    return self_w * vec + prev_w * np.roll(vec, 1) + next_w * np.roll(vec, -1)


# Real-data bug (three real takes of the same solo): whenever pyin can't get
# a confident monophonic reading on both sides for a beat (chords, palm
# mutes, pick noise, quiet passages — the majority of beats on a real "bad"
# take, since sloppy playing is exactly what breaks a clean monophonic pitch
# read), pitch scoring falls back to plain chroma cosine similarity — and
# that fallback turned out to be almost uninformative: measured directly on
# the real takes' own chroma-fallback beats, a plainly *bad* take's fallback
# scores ran 0.60-0.98 (mean 0.84), while a genuinely good take's ran barely
# any higher (0.72-0.99, mean 0.95) — nowhere near the ~5%-vs-~80% spread a
# guitarist hears. Root cause: raw chroma vectors from real guitar audio
# share so much broadband harmonic energy that cosine similarity between
# almost any two of them clusters high regardless of whether the actual
# notes match — the same coarseness already documented in
# RATE_PITCH_CENTS_WINDOW's docstring for whole-take chroma comparison, just
# resurfacing here in the fallback path. Raising each (already
# vibrato-smoothed) chroma vector to a power before the cosine similarity
# sharpens it — bins near the peak keep dominating, everything else shrinks
# toward zero — without touching the vibrato-tolerant smoothing above it.
# Power 4 was picked by directly comparing the fallback-beat score
# distributions across powers 1/2/4/8 on the three real takes: power 4 pulls
# the bad take's mean down substantially (0.84 -> 0.33) while the good take
# stays clearly separated (0.95 -> 0.77); power 8 over-sharpens and starts
# collapsing every take's fallback scores toward zero, losing the
# separation it's meant to preserve.
RATE_CHROMA_SHARPEN_POWER = 4


def _sharpen_chroma(vec: "np.ndarray") -> "np.ndarray":
    sharpened = np.clip(vec, 0.0, None) ** RATE_CHROMA_SHARPEN_POWER
    norm = np.linalg.norm(sharpened)
    return sharpened / norm if norm > 0 else sharpened


def _extract_confident_f0(y: "np.ndarray", sr: int, time_offset: float) -> tuple:
    """Monophonic pitch contour via pyin, confidence-filtered — see
    RATE_PITCH_VOICED_PROB_FLOOR's docstring for why the filtering matters
    as much as the tracking itself. Returns (f0_hz, times) with every
    low-confidence/unvoiced frame already dropped, so callers never see
    them. time_offset shifts the returned times into the same song-time
    axis every other reading in score_take already uses (take audio needs
    +offset_sec; a reference excerpt that doesn't start at song-time 0
    needs its own excerpt start — same idiom as chroma/onset above)."""
    import librosa

    f0, _, voiced_prob = librosa.pyin(y, fmin=RATE_PITCH_FMIN_HZ, fmax=RATE_PITCH_FMAX_HZ, sr=sr)
    times = librosa.times_like(f0, sr=sr) + time_offset
    confident = ~np.isnan(f0) & (voiced_prob >= RATE_PITCH_VOICED_PROB_FLOOR)
    return f0[confident], times[confident]


def score_take(take_path: Path, reference_path: Path, beats: list, offset_sec: float = 0.0) -> dict:
    """offset_sec: take.wav's sample 0 corresponds to song-time offset_sec
    — substitutes here for the shared-transport-clock alignment the real
    in-app capture (R1b) will provide for free (see spec §1.2/§3); this
    spike takes an already-recorded WAV with no such clock, so the caller
    has to say where it starts. NOT auto-detected — get this wrong and
    every score in the run is meaningless, not just off by a little."""
    import librosa

    take_y, sr = librosa.load(str(take_path), sr=None, mono=True)
    ref_y, _ = librosa.load(str(reference_path), sr=sr, mono=True)  # resampled to the take's rate

    if not beats or len(beats) < 2:
        # No beat grid — fixed 0.5s windows, per spec §3's fallback. The
        # overlap is bounded by the take's own duration and by however much
        # of the reference remains after offset_sec (not the reference's
        # full duration) — a take starting late in a long reference file
        # would otherwise get a duration bigger than what's actually left
        # to compare against, and negative "duration" was even possible on
        # a real test (a fixed offset applied to a take longer than the
        # remaining reference), silently producing 0 beats.
        duration = min(len(take_y) / sr, len(ref_y) / sr - offset_sec)
        beats = list(np.arange(0, max(duration, 0), 0.5))
        if len(beats) < 2:
            return {"beats": [], "overall_pct": None, "overall_raw": None,
                     "overall_pitch": None, "overall_timing": None}

    take_chroma = librosa.feature.chroma_cqt(y=take_y, sr=sr)
    take_chroma_t = librosa.frames_to_time(np.arange(take_chroma.shape[1]), sr=sr) + offset_sec
    ref_chroma = librosa.feature.chroma_cqt(y=ref_y, sr=sr)
    ref_chroma_t = librosa.frames_to_time(np.arange(ref_chroma.shape[1]), sr=sr)

    take_onset = librosa.onset.onset_strength(y=take_y, sr=sr)
    take_onset_t = librosa.frames_to_time(np.arange(len(take_onset)), sr=sr) + offset_sec
    ref_onset = librosa.onset.onset_strength(y=ref_y, sr=sr)
    ref_onset_t = librosa.frames_to_time(np.arange(len(ref_onset)), sr=sr)

    # Monophonic pitch tracking (see RATE_PITCH_CENTS_WINDOW's docstring for
    # why chroma alone is too coarse for a solo) — used per-beat below
    # whenever both sides have a confident reading; falls back to chroma
    # otherwise (a chord strum, a palm-muted chug, near-silence). pyin is
    # meaningfully slower than chroma/onset, so it only ever runs over the
    # take's own span of the reference (beats is already trimmed to that
    # span by the caller — trim_beats_to_take_span) rather than the whole
    # reference file, which can be several minutes for one scored take.
    ref_pitch_lo = max(0.0, beats[0] - 1.0)
    ref_pitch_hi = min(len(ref_y) / sr, beats[-1] + 1.0)
    ref_y_for_pitch = ref_y[int(ref_pitch_lo * sr):int(ref_pitch_hi * sr)]
    take_f0, take_f0_t = _extract_confident_f0(take_y, sr, offset_sec)
    ref_f0, ref_f0_t = _extract_confident_f0(ref_y_for_pitch, sr, ref_pitch_lo)
    onset_hop_sec = librosa.frames_to_time(1, sr=sr)

    lag_window_sec = RATE_ONSET_LAG_WINDOW_MS / 1000
    beat_scores = []
    for start, end in zip(beats, beats[1:]):
        take_mask = (take_chroma_t >= start) & (take_chroma_t < end)
        ref_mask = (ref_chroma_t >= start) & (ref_chroma_t < end)
        if not np.any(take_mask) or not np.any(ref_mask):
            beat_scores.append({"time": round(float(start), 3), "score": None, "confidence": 0.0})
            continue

        take_f0_beat = take_f0[(take_f0_t >= start) & (take_f0_t < end)]
        ref_f0_beat = ref_f0[(ref_f0_t >= start) & (ref_f0_t < end)]
        if len(take_f0_beat) and len(ref_f0_beat):
            # Confident monophonic pitch on both sides — compare the actual
            # note, not aggregate pitch-class energy (see
            # RATE_PITCH_CENTS_WINDOW's docstring for why this matters).
            cents = 1200 * np.log2(np.median(take_f0_beat) / np.median(ref_f0_beat))
            pitch_score = max(0.0, 1.0 - (abs(cents) / RATE_PITCH_CENTS_WINDOW) ** 2)
        else:
            # No confident monophonic reading on one or both sides (a chord,
            # a palm-muted chug, near-silence) — chroma still applies here.
            # Sharpened (see RATE_CHROMA_SHARPEN_POWER's docstring) after the
            # vibrato-tolerant smoothing, not instead of it.
            take_c = _sharpen_chroma(_smooth_chroma_for_vibrato(take_chroma[:, take_mask].mean(axis=1)))
            ref_c = _sharpen_chroma(_smooth_chroma_for_vibrato(ref_chroma[:, ref_mask].mean(axis=1)))
            take_norm, ref_norm = np.linalg.norm(take_c), np.linalg.norm(ref_c)
            pitch_score = (float(np.dot(take_c, ref_c)) / (take_norm * ref_norm)) if take_norm > 0 and ref_norm > 0 else 0.0
            pitch_score = max(0.0, min(1.0, pitch_score))

        # Interpolate both onset envelopes onto one shared, fine time grid
        # covering this beat + the lag search margin, rather than
        # correlating each source's own independently-quantized frame
        # grid directly. Without this, whenever offset_sec isn't an exact
        # multiple of the onset hop (~11.6ms at typical sample rates —
        # true for almost any real offset), the take's and reference's
        # frame grids sit a fraction of a hop apart from each other, which
        # cross-correlation reads as a spurious constant lag even for
        # genuinely simultaneous audio. Caught by this spike's own
        # self-take sanity check: an identical take scored ~0.855 timing
        # agreement instead of 1.0, a systematic ~11ms "lag" on zero-lag
        # audio, before this fix.
        common_hop_sec = onset_hop_sec / 2  # oversample a bit for interpolation accuracy
        grid = np.arange(start - lag_window_sec, end + lag_window_sec, common_hop_sec)
        timing_score = 0.0
        if len(grid) > 1:
            take_seg = np.interp(grid, take_onset_t, take_onset, left=0.0, right=0.0)
            ref_seg = np.interp(grid, ref_onset_t, ref_onset, left=0.0, right=0.0)
            if np.any(take_seg) and np.any(ref_seg):
                corr = np.correlate(take_seg - take_seg.mean(), ref_seg - ref_seg.mean(), mode="full")
                # BUG (found on a real Gary Moore solo test): mode="full"
                # correlates over the ENTIRE grid, so its lag range is as
                # wide as the whole beat interval plus margin (often
                # several hundred ms for a slow song), not the intended
                # ±RATE_ONSET_LAG_WINDOW_MS. Sustained/legato lead playing
                # has closely-spaced micro-transients (vibrato ripples,
                # slides, pick noise on a bend) that can correlate more
                # strongly at a large, spurious lag than the true
                # near-zero one — confirmed on real takes: raw signed
                # lags ranged -843ms to +789ms despite a correct offset,
                # essentially uncorrelated with actual timing quality, so
                # good and bad takes came back statistically
                # indistinguishable (~51% vs ~49%) instead of the ~80%
                # vs ~5% a guitarist would call it. Restricting the
                # argmax search to the intended window BEFORE picking a
                # winner (not just clamping the score after the fact)
                # means "best lag" is actually the best lag within the
                # window the score is supposed to represent, not whatever
                # happened to win a much wider, unintended search.
                center = len(ref_seg) - 1
                lag_limit_samples = max(1, int(round(lag_window_sec / common_hop_sec)))
                lo = max(0, center - lag_limit_samples)
                hi = min(len(corr), center + lag_limit_samples + 1)
                windowed_corr = corr[lo:hi]
                best_lag_idx = int(np.argmax(windowed_corr)) + lo - center
                best_lag_ms = abs(best_lag_idx * common_hop_sec * 1000)
                # Squared falloff, not linear: felt too harsh in practice —
                # a linear penalty means a lag at, say, half the window
                # already costs half the score, which punishes ordinary
                # human timing variation (not just genuine sloppiness) more
                # than it should. Squaring keeps small, real-world lags
                # (a few tens of ms either side of the reference) close to
                # full credit while still reaching 0 at the same window
                # edge as before — the window widened too (150ms, was
                # 80ms), but the curve shape is most of what "harsh" was.
                lag_fraction = min(1.0, best_lag_ms / RATE_ONSET_LAG_WINDOW_MS)
                timing_score = max(0.0, 1.0 - lag_fraction ** 2)

        ref_start_sample, ref_end_sample = int(start * sr), min(int(end * sr), len(ref_y))
        ref_segment = ref_y[ref_start_sample:ref_end_sample]
        confidence = float(np.sqrt(np.mean(ref_segment ** 2))) if len(ref_segment) else 0.0

        agreement = RATE_PITCH_WEIGHT * pitch_score + RATE_TIMING_WEIGHT * timing_score
        beat_scores.append({
            "time": round(float(start), 3), "score": round(agreement, 3),
            "pitch": round(pitch_score, 3), "timing": round(timing_score, 3),
            "confidence": round(confidence, 4),
        })

    confident = [b for b in beat_scores if b["score"] is not None and b["confidence"] >= RATE_CONFIDENCE_FLOOR]
    if confident:
        weights = np.array([b["confidence"] for b in confident])
        scores = np.array([b["score"] for b in confident])
        overall_raw = float(np.average(scores, weights=weights))
        span = RATE_CALIBRATION_CEILING - RATE_CALIBRATION_FLOOR
        overall_pct = max(0.0, min(100.0, (overall_raw - RATE_CALIBRATION_FLOOR) / span * 100)) if span > 0 else None
        # Diagnostic breakdown, same weighting as overall_raw itself — lets
        # a surprising overall score (e.g. "this is clearly a bad take, why
        # is it scoring ~50?") be traced to pitch vs. timing specifically,
        # rather than guessing which side of the 60/40 blend is the culprit.
        overall_pitch = float(np.average([b["pitch"] for b in confident], weights=weights))
        overall_timing = float(np.average([b["timing"] for b in confident], weights=weights))
    else:
        overall_raw = overall_pct = overall_pitch = overall_timing = None

    return {
        "beats": beat_scores,
        "overall_raw": round(overall_raw, 3) if overall_raw is not None else None,
        "overall_pct": round(overall_pct, 1) if overall_pct is not None else None,
        "overall_pitch": round(overall_pitch, 3) if overall_pitch is not None else None,
        "overall_timing": round(overall_timing, 3) if overall_timing is not None else None,
    }


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
    if "key" in analysis:
        key = analysis["key"]
        print(f"Detected key: {key['key']} {key['mode']} (confidence {key['confidence']:.2f} — "
              f"a heuristic starting point, not guaranteed; check by ear).")
    if "beats" in analysis:
        print(f"Beat grid: {len(analysis['beats'])} beats detected — powers the click stem in the browser UI.")


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


def _onset_regularity_curve(mono: np.ndarray, samplerate: int, beat_times: list,
                             frame_times: np.ndarray) -> np.ndarray:
    """How tightly note onsets in `mono` cluster around the beat grid,
    resampled onto `frame_times` (hybrid_pan_split's STFT time axis). 1.0 =
    an onset lands right on a beat (strummed/chordal rhythm playing usually
    looks like this over a whole passage); 0.0 = no onset nearby, or one
    that lands well off the grid (sustained notes, bends, freer lead
    lines). Purely a confidence signal for hybrid_pan_split to lean on —
    not a lead/rhythm classifier by itself."""
    import librosa
    if not beat_times or len(mono) == 0:
        return np.zeros(len(frame_times), dtype=np.float32)

    onset_times = librosa.onset.onset_detect(y=mono, sr=samplerate, units="time")
    if len(onset_times) == 0:
        return np.zeros(len(frame_times), dtype=np.float32)

    beats = np.asarray(beat_times, dtype=np.float64)
    # Tolerance for "on the grid" is half the median beat spacing — roughly
    # how far ahead of/behind the click a strum still reads as locked-in.
    spacing = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
    tolerance = max(spacing / 2, 1e-3)

    nearest_beat_dist = np.array([np.min(np.abs(beats - t)) for t in onset_times])
    onset_grid_score = np.clip(1.0 - nearest_beat_dist / tolerance, 0.0, 1.0)

    # Spread each onset's score across a tolerance-wide window around it and
    # average onto the STFT frame grid, turning the sparse onset list into a
    # continuous per-frame curve.
    curve = np.zeros(len(frame_times), dtype=np.float32)
    counts = np.zeros(len(frame_times), dtype=np.float32)
    for onset_t, score in zip(onset_times, onset_grid_score):
        mask = np.abs(frame_times - onset_t) <= tolerance
        curve[mask] += score
        counts[mask] += 1
    return np.where(counts > 0, curve / np.maximum(counts, 1), 0.0).astype(np.float32)


def hybrid_pan_split(left: np.ndarray, right: np.ndarray, samplerate: int,
                      beat_times: list) -> tuple:
    """Option D (research/guitar-separation-upgrade-spec.md,
    research/post-v3-backlog-audit.md): spectral_pan_split sharpened using
    onset-to-beat-grid alignment. Still no ML and no lead/rhythm
    classification — the beat grid is BT-02's existing tempo/beat output,
    reused rather than trained on. During passages where note onsets land
    tightly on the beat (typically strummed/chordal rhythm playing), the
    per-bin center/sides weighting gets pushed further toward whichever
    side the panning read already favors, on the theory that rhythm
    playing tends to sit at a more decisively fixed stereo position than
    lead lines wandering under bends/vibrato. Falls back to plain
    spectral_pan_split when there's no beat grid to work with (e.g. no
    drums stem, or beat tracking failed) — same fallback spectral_pan_split
    itself uses for a too-short signal."""
    nperseg = min(SPECTRAL_SPLIT_NPERSEG, len(left))
    if nperseg < 8 or not beat_times:
        return spectral_pan_split(left, right, samplerate)

    stft_kwargs = dict(fs=samplerate, nperseg=nperseg, noverlap=nperseg * 3 // 4)
    _, frame_times, left_f = scipy.signal.stft(left, **stft_kwargs)
    _, _, right_f = scipy.signal.stft(right, **stft_kwargs)

    mag_l, mag_r = np.abs(left_f), np.abs(right_f)
    total = mag_l + mag_r + 1e-9
    balance = mag_l / total
    centeredness = 1.0 - 2.0 * np.abs(balance - 0.5)

    mono = (left + right) / 2
    regularity = _onset_regularity_curve(mono, samplerate, beat_times, frame_times)
    sharpen = HYBRID_SHARPEN_STRENGTH * regularity[np.newaxis, :]
    centeredness = np.clip(centeredness + sharpen * (centeredness - 0.5), 0.0, 1.0)

    mid_f = (left_f + right_f) / 2
    side_f = (left_f - right_f) / 2

    istft_kwargs = dict(fs=samplerate, nperseg=nperseg, noverlap=nperseg * 3 // 4)
    _, center = scipy.signal.istft(centeredness * mid_f, **istft_kwargs)
    _, sides = scipy.signal.istft((1.0 - centeredness) * side_f, **istft_kwargs)

    return _match_length(center, len(left)), _match_length(sides, len(left))


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
    elif args.method == "hybrid":
        beats = ensure_analysis(out_dir).get("beats", [])
        center_mono, sides_mono = hybrid_pan_split(left, right, sr, beats)
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


def _render_rate_heatmap(beat_scores: list, out_path: Path, take_name: str, song_name: str,
                          overall_pct: float = None) -> None:
    import matplotlib
    matplotlib.use("Agg")  # headless — no display server needed, this just writes a PNG
    import matplotlib.pyplot as plt

    times = [b["time"] for b in beat_scores]
    scores = [b["score"] if b["score"] is not None else np.nan for b in beat_scores]
    scores_arr = np.array(scores).reshape(1, -1)

    cmap = plt.get_cmap("RdYlGn").copy()
    cmap.set_bad(color="#888888")  # unscored beats (no reference/take signal) — visually distinct, not just missing

    span = (times[-1] - times[-2]) if len(times) > 1 else 1.0
    fig, ax = plt.subplots(figsize=(max(6, len(beat_scores) * 0.15), 2.2))
    im = ax.imshow(scores_arr, aspect="auto", cmap=cmap, vmin=0, vmax=1,
                    extent=[times[0], times[-1] + span, 0, 1])
    ax.set_yticks([])
    ax.set_xlabel("Song time (s)")
    ax.set_title(f"Rate My Take spike — {take_name} vs. {song_name}\n"
                 f"green = agreement, red = drift, gray = no confident read")

    # Overall closeness front and center — the actual go/no-go number
    # (rate-my-take-spec.md §6), not just buried in the console output the
    # heatmap is meant to be judged alongside.
    score_label = f"{overall_pct}%" if overall_pct is not None else "--"
    ax.text(0.99, 0.97, f"Overall: {score_label}", transform=ax.transAxes,
            ha="right", va="top", fontsize=15, fontweight="bold", color="#1a1a1a",
            bbox=dict(boxstyle="round,pad=0.35", facecolor="white", edgecolor="#333333", alpha=0.9))

    fig.colorbar(im, ax=ax, orientation="horizontal", pad=0.35, label="per-beat agreement (raw, uncalibrated)")
    fig.tight_layout()
    fig.savefig(str(out_path), dpi=150)
    plt.close(fig)


RATE_OFFSET_SEARCH_CANDIDATES = 5  # top onset-correlation peaks to disambiguate with chroma
RATE_OFFSET_SEARCH_MIN_PEAK_GAP_SEC = 0.35  # candidate peaks closer than this are treated as one


def refine_offset(take_path: Path, reference_path: Path, rough_offset: float,
                   search_radius: float = 3.0) -> dict:
    """Cross-correlates onset-strength envelopes to snap a rough, by-ear
    --offset guess (scrubbing a transport, or trial-and-error re-running
    'rate' at a few candidate values and eyeballing the heatmap — exactly
    the manual process this replaces) to the actual best-aligned value,
    within +/-search_radius seconds of the guess. Same idea as score_take's
    per-beat onset-envelope cross-correlation (used there for the timing
    sub-score), just over a much wider window: that one asks 'how tight is
    this one beat,' this one asks 'where does the take actually start.'

    Onset timing alone is genuinely ambiguous on rhythmically repetitive
    material — a steady rock rhythm or a riff that repeats every bar can
    correlate just as strongly a full cycle early/late as at the true
    offset, since the onset envelope alone can't tell two similarly-timed
    bars apart. Caught by a synthetic test with a semi-regular ~0.6s pulse
    train: onset-only correlation locked onto a peak 7 cycles (~4.3s) off,
    with a deceptively high correlation score. Fixed by taking the top
    RATE_OFFSET_SEARCH_CANDIDATES onset-correlation peaks and re-ranking
    them by chroma similarity (actual pitch content, which two different
    bars of a riff usually don't share identically even when their rhythm
    does) — the same pitch-vs-timing blend score_take itself uses per
    beat, just applied once here to pick the right global alignment first.

    Returns the refined offset plus a normalized quality score (0-1,
    blending onset-correlation and chroma-similarity) so a bad rough guess
    or unrelated audio reads as low-confidence instead of a silently wrong
    answer — cmd_rate uses this to warn rather than trust a poor match."""
    import librosa

    take_y, sr = librosa.load(str(take_path), sr=None, mono=True)
    take_duration = len(take_y) / sr

    window_start = max(0.0, rough_offset - search_radius)
    window_duration = take_duration + 2 * search_radius
    ref_y, _ = librosa.load(str(reference_path), sr=sr, mono=True,
                             offset=window_start, duration=window_duration)

    take_onset = librosa.onset.onset_strength(y=take_y, sr=sr)
    ref_onset = librosa.onset.onset_strength(y=ref_y, sr=sr)
    hop_sec = librosa.frames_to_time(1, sr=sr)

    # Both onto one fine shared time grid — same reasoning as score_take's
    # per-beat lag search: two independent librosa.load calls' frame grids
    # don't line up sample-for-sample, which cross-correlating them
    # directly would misread as a spurious lag.
    fine_hop = hop_sec / 2
    take_t = librosa.frames_to_time(np.arange(len(take_onset)), sr=sr)
    ref_t = librosa.frames_to_time(np.arange(len(ref_onset)), sr=sr)
    fine_take_t = np.arange(0, take_duration, fine_hop)
    fine_ref_t = np.arange(0, window_duration, fine_hop)
    take_fine = np.interp(fine_take_t, take_t, take_onset, left=0.0, right=0.0)
    ref_fine = np.interp(fine_ref_t, ref_t, ref_onset, left=0.0, right=0.0)

    clipped = len(ref_fine) < len(take_fine)  # reference window ran off the start/end of the song
    if clipped or not np.any(take_fine) or not np.any(ref_fine):
        return {"offset": rough_offset, "quality": 0.0, "clipped": clipped}

    take_centered = take_fine - take_fine.mean()
    ref_centered = ref_fine - ref_fine.mean()
    corr = np.correlate(ref_centered, take_centered, mode="valid")
    denom = np.linalg.norm(ref_centered) * np.linalg.norm(take_centered)
    corr_norm = corr / denom if denom > 0 else np.zeros_like(corr)

    # Top candidate peaks, at least RATE_OFFSET_SEARCH_MIN_PEAK_GAP_SEC
    # apart (greedy: take the best remaining peak, zero out its neighbors,
    # repeat) — a periodic signal's true peaks all show up within one or
    # two correlation-array samples of each other otherwise, which would
    # just re-pick the same cycle RATE_OFFSET_SEARCH_CANDIDATES times.
    gap_samples = max(1, int(RATE_OFFSET_SEARCH_MIN_PEAK_GAP_SEC / fine_hop))
    work = corr_norm.copy()
    candidates = []
    for _ in range(RATE_OFFSET_SEARCH_CANDIDATES):
        idx = int(np.argmax(work))
        if not np.isfinite(work[idx]) or work[idx] <= -np.inf:
            break
        candidates.append(idx)
        lo, hi = max(0, idx - gap_samples), min(len(work), idx + gap_samples + 1)
        work[lo:hi] = -np.inf

    # Frame-by-frame chroma similarity, not a single averaged vector over
    # the whole take: averaging first throws away note ORDER, which is
    # exactly what's needed to tell "this riff, this way round" apart from
    # a shifted/rotated repeat of the same pitch classes — caught by a
    # synthetic test where a cyclic melody's mean chroma vector looked
    # almost identical a few note-periods off, even though the actual note
    # sequence at that offset was wrong.
    take_chroma = librosa.feature.chroma_cqt(y=take_y, sr=sr)
    take_chroma_norms = np.linalg.norm(take_chroma, axis=0)

    best_idx, best_combined, best_onset, best_chroma_sim = candidates[0], -1.0, 0.0, 0.0
    for idx in candidates:
        candidate_offset = window_start + idx * fine_hop
        start_sample = int(round((candidate_offset - window_start) * sr))
        ref_slice = ref_y[start_sample:start_sample + len(take_y)]
        if len(ref_slice) < len(take_y):
            continue
        ref_chroma = librosa.feature.chroma_cqt(y=ref_slice, sr=sr)
        n_frames = min(take_chroma.shape[1], ref_chroma.shape[1])
        ref_chroma_norms = np.linalg.norm(ref_chroma[:, :n_frames], axis=0)
        dots = np.sum(take_chroma[:, :n_frames] * ref_chroma[:, :n_frames], axis=0)
        denom_frames = take_chroma_norms[:n_frames] * ref_chroma_norms
        frame_sims = np.divide(dots, denom_frames, out=np.zeros(n_frames), where=denom_frames > 0)
        chroma_sim = max(0.0, min(1.0, float(np.mean(frame_sims)))) if n_frames else 0.0
        onset_score = max(0.0, min(1.0, float(corr_norm[idx])))
        # Chroma weighted higher — it's what actually disambiguates two
        # similarly-timed repeats of a riff; onset correlation alone can't.
        combined = 0.35 * onset_score + 0.65 * chroma_sim
        if combined > best_combined:
            best_idx, best_combined, best_onset, best_chroma_sim = idx, combined, onset_score, chroma_sim

    refined_offset = window_start + best_idx * fine_hop
    return {
        "offset": round(refined_offset, 3),
        "quality": round(max(0.0, min(1.0, best_combined)), 3),
        "onset_quality": round(best_onset, 3),
        "chroma_quality": round(best_chroma_sim, 3),
        "clipped": False,
    }


def trim_beats_to_take_span(beats: list, offset: float, take_path: Path) -> list | None:
    """A take is usually a short section of a full song (a solo, a verse)
    — scoring/rendering against the WHOLE song's beat grid produces one
    gray (unscored) entry per beat outside the take's actual span,
    drowning the real result in noise on both the printed table and the
    heatmap. Trims to just the beats bounding the take's actual time
    range: the last beat at-or-before the take's start (so the first
    window still starts in the right place) through the first beat
    at-or-after its end (so the last window has a real closing edge, not
    a hard cut mid-window). Returns None if there aren't at least 2 beats
    left, so callers can trigger the fixed-window fallback the same way a
    missing beat grid already does.

    Shared by cmd_rate and the /api/rate/score HTTP endpoint (server.py)
    so both trim identically rather than keeping two copies in sync."""
    if not beats:
        return None
    import librosa

    # librosa.get_duration(path=...), not raw soundfile — a take can be a
    # video file (the Play Along video-take feature saves .mp4), which
    # libsndfile can't open at all; get_duration falls back to audioread
    # the same way librosa.load already does elsewhere in scoring, instead
    # of crashing on a format soundfile alone can't read.
    take_duration = librosa.get_duration(path=str(take_path))
    end_time = offset + take_duration
    idx_start = 0
    for i, b in enumerate(beats):
        if b <= offset:
            idx_start = i
        else:
            break
    idx_end = len(beats)
    for i, b in enumerate(beats):
        if b >= end_time:
            idx_end = i + 1
            break
    return beats[idx_start:idx_end] or None


def cmd_rate(args: argparse.Namespace) -> None:
    """Phase R1a (rate-my-take-spec.md §6): the go/no-go research spike.
    No UI — prints per-beat scores and renders a heatmap PNG. The only
    test that actually matters: record three real takes of a part you
    know (one tight, one deliberately sloppy, one tasteful variation) and
    check the scores rank tight > variation > sloppy, with the heatmap's
    red zones landing where your own ears say the sloppy take fell apart.
    This command cannot make that call for you — that judgment is the
    entire point of a spike, not a formality on top of it."""
    take_path = Path(args.take).resolve()
    if not take_path.exists():
        sys.exit(f"Take file not found: {take_path}")

    song_path = Path(args.song).resolve()
    out_dir = track_stem_dir(song_path, args.model)
    if not has_cached_stems(out_dir):
        sys.exit(f"No stems found for {song_path.name} with model '{args.model}'. Run 'separate' first.")
    reference_path = out_dir / f"{args.stem}.wav"
    if not reference_path.exists():
        sys.exit(f"No '{args.stem}' stem found in {out_dir}. This needs a guitar stem — "
                  f"try 'separate --model htdemucs_6s' or 'bs_roformer_sw' first.")

    analysis = ensure_analysis(out_dir)
    beats = analysis.get("beats")
    if beats:
        print(f"Using the detected beat grid ({len(beats)} beats).")
    else:
        print("No beat grid available — falling back to fixed 0.5s scoring windows (rate-my-take-spec.md §3).")

    offset = args.offset
    if args.offset_search > 0:
        refined = refine_offset(take_path, reference_path, args.offset, search_radius=args.offset_search)
        if refined["clipped"]:
            print(f"\n--offset-search {args.offset_search}s around {args.offset}s ran off the start/end of "
                  f"{song_path.name} — using your --offset as given.")
        elif refined["quality"] < RATE_OFFSET_SEARCH_MIN_QUALITY:
            print(f"\n--offset-search found its best alignment at {refined['offset']}s, but the match quality "
                  f"({refined['quality']}) is too low to trust — using your --offset as given. Try a wider "
                  f"--offset-search, or your rough --offset guess may be further off than the search radius.")
        else:
            print(f"\n--offset-search refined {args.offset}s -> {refined['offset']}s (match quality {refined['quality']}).")
            offset = refined["offset"]

    beats = trim_beats_to_take_span(beats, offset, take_path)

    result = score_take(take_path, reference_path, beats, offset_sec=offset)
    beat_scores = result["beats"]
    scored = [b for b in beat_scores if b["score"] is not None]
    if not scored:
        sys.exit(f"No beats could be scored — check --offset (does take.wav's start really line up "
                  f"with song time {offset}s?) and that both files have real audio in them.")

    print(f"\nScored {len(scored)}/{len(beat_scores)} beats.")
    if result["overall_pct"] is not None:
        print(f"Overall closeness: {result['overall_pct']}% "
              f"(raw blended score: {result['overall_raw']} — UNCALIBRATED, see "
              f"RATE_CALIBRATION_FLOOR/CEILING in backing_track.py)")
        print(f"  Pitch (weight {RATE_PITCH_WEIGHT}): {result['overall_pitch']}   "
              f"Timing (weight {RATE_TIMING_WEIGHT}): {result['overall_timing']}")
    else:
        print("Overall closeness: -- (every scored beat was below the reference-confidence floor; "
              "the reference guitar may be silent/very quiet throughout the scored range)")

    print(f"\n{'time':>8}  {'score':>6}  {'pitch':>6}  {'timing':>6}  {'conf':>6}")
    for b in beat_scores:
        if b["score"] is None:
            print(f"{b['time']:8.2f}  {'--':>6}  {'--':>6}  {'--':>6}  {'--':>6}")
        else:
            print(f"{b['time']:8.2f}  {b['score']:6.3f}  {b['pitch']:6.3f}  {b['timing']:6.3f}  {b['confidence']:6.4f}")

    out_path = Path(args.out) if args.out else take_path.with_name(f"{take_path.stem}_rate_heatmap.png")
    _render_rate_heatmap(beat_scores, out_path, take_path.name, song_path.name, result["overall_pct"])
    print(f"\nHeatmap written to: {out_path}")
    print("\nGo/no-go call (rate-my-take-spec.md §6): does this ranking and heatmap match what your "
          "ears say happened? That judgment call is the actual point of this command — nothing above "
          "makes it for you.")


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
    p_split.add_argument("--method", choices=["spectral", "midside", "hybrid"], default=DEFAULT_SPLIT_METHOD,
                          help="Split algorithm (default: spectral). 'spectral' adapts the "
                               "center/sides split per frequency bin, which can separate "
                               "partially- or inconsistently-panned mixes better than the "
                               "blunt whole-track 'midside' split. 'hybrid' (Option D) further "
                               "sharpens 'spectral' using onset-to-beat-grid alignment — falls "
                               "back to plain 'spectral' if no beat grid is available.")
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

    p_rate = sub.add_parser("rate", help="V4-R1a research spike: score a dry take against the song's guitar stem")
    p_rate.add_argument("take", help="Path to the dry take WAV to score")
    p_rate.add_argument("song", help="Path to the original song file (used to locate its guitar stem)")
    p_rate.add_argument("--model", default=DEFAULT_MODEL, help=model_help(DEFAULT_MODEL))
    p_rate.add_argument("--stem", default="guitar", help="Reference stem to score against (default: guitar)")
    p_rate.add_argument("--offset", type=float, default=0.0,
                         help="Song-time (seconds) that take.wav's sample 0 corresponds to — "
                              "get this wrong and every score is meaningless (default: 0.0, "
                              "i.e. the take starts at the top of the song). With --offset-search, "
                              "this only needs to be a rough, by-ear guess.")
    p_rate.add_argument("--offset-search", type=float, default=0.0,
                         help="Seconds to search around --offset for the actual best-aligned start "
                              "(onset-envelope cross-correlation), instead of trusting --offset exactly. "
                              "0 (default) disables this and uses --offset as given; try 2-3 if your "
                              "--offset is a rough guess (e.g. eyeballed from a transport or scrubbing "
                              "video) rather than a known-exact value.")
    p_rate.add_argument("--out", default=None,
                         help="Heatmap PNG output path (default: <take>_rate_heatmap.png next to the take)")
    p_rate.set_defaults(func=cmd_rate)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
