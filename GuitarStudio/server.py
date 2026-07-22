#!/usr/bin/env python3
"""
GuitarStudio/server.py — loopback-only HTTP server exposing backing_track.py's
engine (separate / list / split-guitar / mix) to the browser frontend, plus
track listing, project persistence, and static file serving.

Rebuilt from scratch after the original server.py was lost in a backup
failure (see README.md / git log) — this is a new implementation guided by
prototype-spec.md's and ui-spec.md's engine-integration contract (there
JSON-RPC over stdio to a bundled process, for the native-app path that was
never actually built) adapted to plain REST/JSON over HTTP, since the
browser talks to this process directly and there's no subprocess boundary
to cross.

Run:
    python3 GuitarStudio/server.py [--port 8765]

Binds to 127.0.0.1 only. There is no authentication — do not expose this
port beyond localhost.
"""

import argparse
import io
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
import backing_track as engine  # noqa: E402 (sys.path must be set up first)

GUITARSTUDIO_DIR = Path(__file__).resolve().parent
STATIC_DIR = GUITARSTUDIO_DIR / "static"
PROJECTS_DIR = GUITARSTUDIO_DIR / "projects"
MODELS_DIR = GUITARSTUDIO_DIR / "models"
NAM_DIR = MODELS_DIR / "nam"
IR_DIR = MODELS_DIR / "ir"
INPUT_DIR = PROJECT_ROOT / "input"

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
NAM_DIR.mkdir(parents=True, exist_ok=True)
IR_DIR.mkdir(parents=True, exist_ok=True)
INPUT_DIR.mkdir(parents=True, exist_ok=True)

# Every place input/ needs to tell audio from non-audio (the Library
# listing, multi-stem zip extraction) — input/ now legitimately holds a
# non-audio file too (a staged .zip stem pack, pre-import), so svc_tracks
# needs this same allowlist to not list it as a broken track.
AUDIO_EXTS = {".wav", ".wave", ".mp3", ".flac", ".m4a", ".aiff", ".aif"}

SAFE_NAME_RE = re.compile(r"[\x00/]+")
DEFAULT_PORT = 8765

# Demucs and audio-separator both use PyTorch/MPS + ONNXRuntime/CoreML
# under the hood, neither of which is safe to drive concurrently from two
# threads — running two separations at once has been observed to hang
# indefinitely rather than error. SEPARATION_LOCK serializes the actual
# heavy work; a second request just waits its turn instead of racing the
# first one for the GPU. _JOBS tracks per-(track, model) progress so a
# concurrent status poll can show a real progress bar while a request is
# either queued behind the lock or actively running.
SEPARATION_LOCK = threading.Lock()
_JOBS: dict[tuple[str, str], dict] = {}
_JOBS_LOCK = threading.Lock()


def _set_job(key: tuple[str, str], **fields) -> None:
    with _JOBS_LOCK:
        job = _JOBS.setdefault(key, {"status": "idle", "percent": 0})
        job.update(fields)


def _get_job(key: tuple[str, str]) -> dict:
    with _JOBS_LOCK:
        return dict(_JOBS.get(key, {"status": "idle", "percent": 0}))


class ApiError(Exception):
    """Raised by the service functions below for any client-facing error —
    caught once in the request handler and turned into a JSON error response
    with the given HTTP status, instead of every route hand-rolling its own
    error responses."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------

def safe_name(name: str) -> str:
    """Sanitize a user-supplied filename: drop any directory component
    (Path(...).name is the actual traversal defense — '../../etc/passwd'
    and '/etc/passwd' both collapse to just 'passwd') and strip only NUL
    bytes / stray slashes as a belt-and-suspenders backstop. Deliberately
    permissive beyond that: real music filenames routinely contain commas,
    apostrophes, ampersands, accented characters, etc., and an earlier,
    much stricter character allowlist here was silently mangling those
    (e.g. a comma became '_', so a track saved as "A, B.mp3" could no
    longer be found under its real name)."""
    name = Path(name).name
    name = SAFE_NAME_RE.sub("", name).strip()
    if not name or name in (".", ".."):
        raise ApiError(400, "Invalid or empty name")
    return name


def resolve_source_path(source_path: str) -> Path:
    """Resolve a track reference to a file under input/. Accepts a bare
    filename (what the Library sidebar sends) or an already-absolute path;
    either way the result must resolve inside input/, or it's rejected —
    this is the browser-facing trust boundary the CLI never needed."""
    if not source_path:
        raise ApiError(400, "source_path is required")
    candidate = Path(source_path)
    if not candidate.is_absolute():
        candidate = INPUT_DIR / safe_name(source_path)
    resolved = candidate.resolve()
    try:
        resolved.relative_to(INPUT_DIR.resolve())
    except ValueError:
        raise ApiError(400, f"source_path must be inside input/: {source_path}")
    if not resolved.exists():
        raise ApiError(404, f"Source file not found: {resolved.name}")
    return resolved


# ---------------------------------------------------------------------------
# Service layer — thin orchestration over backing_track.py's primitives.
# Deliberately does not call backing_track's cmd_* functions: those print to
# stdout and call sys.exit() on error, which is fine for a one-shot CLI
# process but wrong for a long-lived server (sys.exit() raises SystemExit,
# which would otherwise propagate and kill the whole server, not just the
# one request). Raising ApiError here keeps every error request-scoped.
# ---------------------------------------------------------------------------

def stem_info(out_dir: Path, model: str, digest: str | None = None) -> list:
    known_stems = set(engine.ALL_KNOWN_MODELS.get(model, ()))
    # Imported stem packs (multi-stem-import-spec.md) have safe_name()'d
    # on-disk keys that don't round-trip back to the original filename —
    # this sidecar carries the raw label so the UI can display it verbatim.
    labels_path = out_dir / "stem_labels.json"
    labels = json.loads(labels_path.read_text()) if labels_path.exists() else {}
    stems = []
    for wav_path in sorted(out_dir.glob("*.wav")):
        info = engine.sf.info(str(wav_path))
        stems.append({
            "name": wav_path.stem,
            "label": labels.get(wav_path.stem),
            "duration": info.duration,
            "sample_rate": info.samplerate,
            "is_derived": wav_path.stem not in known_stems,
            "is_custom": False,
        })
    # custom-stems-spec.md: user-dropped stems live in a track-scoped (not
    # model-scoped) directory so they survive re-separation and model
    # switches — merged in here so every model's stem list includes them.
    if digest:
        stems.extend(custom_stem_info(digest))
    return stems


def custom_stem_info(digest: str) -> list:
    custom_dir = engine.custom_stems_dir(digest)
    if not custom_dir.exists():
        return []
    labels_path = custom_dir / "stem_labels.json"
    labels = json.loads(labels_path.read_text()) if labels_path.exists() else {}
    stems = []
    for wav_path in sorted(custom_dir.glob("*.wav")):
        info = engine.sf.info(str(wav_path))
        stems.append({
            "name": wav_path.stem,
            "label": labels.get(wav_path.stem),
            "duration": info.duration,
            "sample_rate": info.samplerate,
            "is_derived": False,
            "is_custom": True,
        })
    return stems


def svc_models() -> dict:
    """Model list for the UI's model picker — populated from the engine's
    own tables rather than hardcoded, so a new model shows up automatically
    (ui-spec.md §4.1)."""
    models = []
    for name, stems in engine.MODEL_STEMS.items():
        models.append({"name": name, "backend": "demucs", "stems": list(stems)})
    for name, info in engine.AUDIO_SEPARATOR_MODELS.items():
        models.append({"name": name, "backend": "audio-separator", "stems": list(info["stems"])})
    return {"models": models, "default": engine.DEFAULT_MODEL}


def svc_tracks() -> dict:
    """Every importable track under input/, for the Library sidebar.
    has_project hashes each file to check project_path_for's existence
    (falling back to the legacy filename-keyed path) — real cost for a
    personal practice library (dozens of songs, not thousands), same
    trade-off the stem cache already makes per-track; if this library ever
    grows large enough for that to matter, cache the hash the same way a
    separated track's fingerprint already does instead of recomputing it
    on every sidebar refresh. V4-F4: the same digest doubles as the
    practice-log lookup key — one hash, two lookups, not two hashes."""
    practice_log = _read_practice_log()
    tracks = []
    for path in sorted(INPUT_DIR.iterdir()):
        if path.is_file() and not path.name.startswith(".") and path.suffix.lower() in AUDIO_EXTS:
            try:
                digest = engine.content_hash(path)
                has_project = (PROJECTS_DIR / f"{digest}.json").exists() or legacy_project_path(path.name).exists()
            except OSError:
                has_project = False
                digest = None
            entry = practice_log.get(digest) if digest else None
            tracks.append({
                "name": path.name, "size": path.stat().st_size, "has_project": has_project,
                "practice_seconds": (entry or {}).get("seconds", 0.0),
                "last_practiced": (entry or {}).get("last_practiced"),
            })
    return {"tracks": tracks}


def svc_track_rename(track: str, new_name: str) -> dict:
    """Renames the source file in input/, plus every place on disk that's
    keyed off the filename rather than pure content hash. project_path_for
    (saved mixes/practice log) really is hash-only, but track_stem_dir bakes
    the filename INTO the cache dir name too (f"{stem}__{digest}" — see its
    docstring), and recordings/exports live under output/<filename>/ with
    no hash at all. A plain Path.rename() of just the source file quietly
    orphans all of that — separate/list_stems would report "no stems found"
    even though the (now differently-named) cache directory is sitting
    right there. Renamed dirs are matched by exact old name, not a prefix
    scan, so an unrelated orphaned cache that happens to share the old stem
    (e.g. left behind by svc_track_delete, then reused by a same-named but
    different re-import) can never get swept up by mistake. The caller
    (app.js) is responsible for patching any playlist entries, which store
    the literal filename."""
    target = resolve_source_path(track)
    if not new_name:
        raise ApiError(400, "new_name is required")
    stem = safe_name(new_name)
    new_path = target.parent / f"{stem}{target.suffix}"
    if new_path.exists() and new_path != target:
        raise ApiError(409, f"'{new_path.name}' already exists")

    old_stem, old_full_name = target.stem, target.name
    new_stem, new_full_name = new_path.stem, new_path.name
    digest = engine.content_hash(target)

    # Validate every rename target is free before touching anything on
    # disk, so a collision aborts cleanly rather than leaving the track
    # half-renamed (source file moved but its stems left behind, etc.).
    dir_renames = []
    if old_stem != new_stem and engine.SEPARATED_DIR.exists():
        for model_dir in engine.SEPARATED_DIR.iterdir():
            if not model_dir.is_dir():
                continue
            for old_dir_name in (f"{old_stem}__{digest}", old_stem):
                old_dir = model_dir / old_dir_name
                if not old_dir.is_dir():
                    continue
                new_dir = model_dir / old_dir_name.replace(old_stem, new_stem, 1)
                if new_dir.exists():
                    raise ApiError(409, f"Can't rename: 'separated/{model_dir.name}/{new_dir.name}' already exists")
                dir_renames.append((old_dir, new_dir))

    if old_full_name != new_full_name:
        old_out = engine.OUTPUT_DIR / old_full_name
        if old_out.is_dir():
            new_out = engine.OUTPUT_DIR / new_full_name
            if new_out.exists():
                raise ApiError(409, f"Can't rename: 'output/{new_full_name}' already exists")
            dir_renames.append((old_out, new_out))

    if old_stem != new_stem:
        old_out_stem = engine.OUTPUT_DIR / old_stem
        if old_out_stem.is_dir():
            new_out_stem = engine.OUTPUT_DIR / new_stem
            if new_out_stem.exists():
                raise ApiError(409, f"Can't rename: 'output/{new_stem}' already exists")
            dir_renames.append((old_out_stem, new_out_stem))

    target.rename(new_path)
    for old_dir, new_dir in dir_renames:
        old_dir.rename(new_dir)

    return {"ok": True, "name": new_path.name}


def svc_track_delete(track: str) -> dict:
    """Removes the source file from input/ and everything derived from it
    that's on disk purely because that file existed: separated stem caches
    (separated/<model>/<stem>[__<hash>]/ — see track_stem_dir), and its
    output/ directory (recordings + exported mixes/stem copies). Same
    exact-name matching as svc_track_rename, for the same reason: a bare
    stem-name match without the hash suffix could otherwise sweep up an
    unrelated cache. Saved projects/practice history stay (hash-keyed,
    honest history of time spent even if the source file is gone). The
    caller is responsible for dropping the track from any playlists, which
    store the literal filename."""
    target = resolve_source_path(track)
    stem, full_name = target.stem, target.name
    digest = engine.content_hash(target)

    dirs_to_remove = []
    if engine.SEPARATED_DIR.exists():
        for model_dir in engine.SEPARATED_DIR.iterdir():
            if not model_dir.is_dir():
                continue
            for candidate_name in (f"{stem}__{digest}", stem):
                candidate = model_dir / candidate_name
                if candidate.is_dir():
                    dirs_to_remove.append(candidate)

    out_by_full_name = engine.OUTPUT_DIR / full_name
    if out_by_full_name.is_dir():
        dirs_to_remove.append(out_by_full_name)
    out_by_stem = engine.OUTPUT_DIR / stem
    if out_by_stem.is_dir():
        dirs_to_remove.append(out_by_stem)

    target.unlink()
    for d in dirs_to_remove:
        shutil.rmtree(d, ignore_errors=True)

    return {"ok": True}


def _scan_model_dir(root: Path, suffixes: tuple[str, ...]) -> list[dict]:
    """Recursively list matching files under root, for libraries organized
    into pack subfolders (a real user's NAM/IR collection ran to 4600+ files
    across 260+ subdirectories — a flat, non-recursive scan found almost
    none of it). filename is the root-relative path (with '/' separators),
    used both as the picker's grouping key and as the id passed back to
    resolve_nam_file/resolve_ir_file. Suffix match is case-insensitive
    (real packs mix .wav and .WAV)."""
    suffixes_lower = tuple(s.lower() for s in suffixes)
    out = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in suffixes_lower:
            continue
        rel = path.relative_to(root)
        out.append({
            "name": path.stem,
            "filename": str(rel),
            "folder": str(rel.parent) if rel.parent != Path(".") else "",
            "size": path.stat().st_size,
        })
    out.sort(key=lambda m: (m["folder"], m["name"]))
    return out


def svc_nam_models() -> dict:
    """Every .nam capture under models/nam/ (recursively — see
    _scan_model_dir), for the Play Along amp picker. A plain directory
    listing (GP-05's pattern) so dropping a new capture in shows up after a
    refresh — no separate registration step."""
    return {"models": _scan_model_dir(NAM_DIR, (".nam",))}


def svc_ir_models() -> dict:
    """Every cab IR under models/ir/ (recursively), same pattern as
    svc_nam_models. Only .wav — real IR packs also ship .syx (hardware
    sysex dumps) and other formats decodeAudioData can't read."""
    return {"irs": _scan_model_dir(IR_DIR, (".wav",))}


def _resolve_model_file(root: Path, rel_filename: str, kind: str) -> Path:
    """Nested pack subfolders mean this can't use safe_name() (which strips
    '/' as a traversal defense) — resolve the joined path directly and
    verify containment instead, the same pattern _serve_static() uses for
    STATIC_DIR."""
    path = (root / rel_filename).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        raise ApiError(400, f"Invalid {kind} path")
    if not path.exists():
        raise ApiError(404, f"No {kind} named '{rel_filename}'")
    return path


def resolve_nam_file(filename: str) -> Path:
    return _resolve_model_file(NAM_DIR, filename, "NAM model")


def resolve_ir_file(filename: str) -> Path:
    return _resolve_model_file(IR_DIR, filename, "IR")


def svc_import(filename: str, data: bytes) -> dict:
    if not data:
        raise ApiError(400, "Empty upload")
    name = safe_name(filename)
    dest = INPUT_DIR / name
    dest.write_bytes(data)
    return {"name": name, "path": str(dest), "size": len(data)}


# ---------------------------------------------------------------------------
# Multi-stem ZIP import (multi-stem-import-spec.md) — a second import path
# for audio that's already separated (a purchased "custom backing track"
# pack, any pre-split multitrack): skip the ML separation step entirely,
# keep every stem's own audio, name lanes exactly as the files were.
# ---------------------------------------------------------------------------

IMPORTED_MODEL_NAME = "imported"


def _is_junk_zip_entry(name: str) -> bool:
    """__MACOSX/ AppleDouble resource-fork junk — every zip Finder's own
    'Compress' feature produces carries this, and it isn't real audio."""
    basename = Path(name).name
    return name.startswith("__MACOSX/") or basename.startswith("._") or basename == ".DS_Store"


def _ffmpeg_convert_to_wav(src_path: Path, dst_path: Path, target_sr: int | None = None) -> None:
    """Converts any ffmpeg-readable audio file to WAV — the format every
    other stem in this app already is (Demucs/audio-separator both only
    ever produce WAV), so an imported stem needs the same treatment to work
    with the existing mix/waveform/analysis code, all of which assumes it.
    Raises ApiError instead of backing_track.py's write_audio's sys.exit()
    — this runs inside a request, not a one-shot CLI process."""
    ffmpeg = engine.find_ffmpeg()
    if not ffmpeg:
        raise ApiError(500, "ffmpeg not found — required to import stem audio. Is it installed? (brew install ffmpeg)")
    cmd = [ffmpeg, "-y", "-i", str(src_path)]
    if target_sr:
        cmd += ["-ar", str(target_sr)]
    cmd += [str(dst_path)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise ApiError(400, f"Could not read '{src_path.name}' as audio: {result.stderr[-500:]}")


def svc_import_stem_zip(zip_bytes: bytes, zip_filename: str) -> dict:
    """See multi-stem-import-spec.md for the full design. Short version:
    extract every real audio entry (filtering __MACOSX/ junk), convert each
    to WAV, sum them into a synthetic full-mix that becomes this track's
    input/ file (everything else in this app — projects, practice log, the
    stem cache — is content-hash-keyed off one source file, and a multi-file
    import has none until this mixdown creates one), then write the
    converted stems into that hash's stem-cache dir under the pseudo-model
    'imported'. A minimal project pre-seeded with model='imported' means
    the track loads correctly the very first time it's selected, with no
    client-side special-casing needed."""
    if not zip_bytes:
        raise ApiError(400, "Empty upload")
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise ApiError(400, "Not a valid zip file")

    entries = [
        info for info in zf.infolist()
        if not info.is_dir()
        and not _is_junk_zip_entry(info.filename)
        and Path(info.filename).suffix.lower() in AUDIO_EXTS
    ]
    if not entries:
        raise ApiError(400, "No usable audio files found in this zip (after filtering out __MACOSX/ junk)")

    # Stem label = filename minus extension, exactly as given — no vendor-
    # specific pattern-stripping (this needs to work for any zip source,
    # not one vendor's naming convention). safe_name() (already used for
    # every other user-supplied name in this app) makes it filesystem-safe
    # for the on-disk key; the raw label is preserved separately for display.
    seen_keys: dict[str, str] = {}
    stem_entries = []  # (raw_label, safe_key, zip_info)
    for info in entries:
        raw_name = Path(info.filename).name
        raw_label = raw_name.rsplit(".", 1)[0]
        safe_key = safe_name(raw_label)
        if safe_key in seen_keys:
            raise ApiError(400, f"Two stems would collide as '{safe_key}' — rename one and re-zip: "
                                 f"'{seen_keys[safe_key]}' and '{raw_name}'")
        seen_keys[safe_key] = raw_name
        stem_entries.append((raw_label, safe_key, info))

    with tempfile.TemporaryDirectory(prefix="gs_stem_import_") as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        converted = []  # (raw_label, safe_key, wav_path)
        for raw_label, safe_key, info in stem_entries:
            src_ext = Path(info.filename).suffix.lower()
            src_path = tmp_dir / f"{safe_key}_src{src_ext}"
            src_path.write_bytes(zf.read(info))
            wav_path = tmp_dir / f"{safe_key}.wav"
            _ffmpeg_convert_to_wav(src_path, wav_path)
            converted.append((raw_label, safe_key, wav_path))

        # Sum every converted stem into a synthetic full mix — the file this
        # whole import gets hash-keyed off (see docstring). Resample any
        # stem that doesn't match the first one's rate rather than reject
        # the pack outright; real downloaded packs occasionally do differ.
        # Two passes: first pass settles target_sr and re-samples outliers
        # in place, second pass sums at a now-known common length.
        target_sr = None
        stereo_audio = {}  # safe_key -> (n_samples, 2) float32
        for raw_label, safe_key, wav_path in converted:
            audio, sr = engine.sf.read(str(wav_path), dtype="float32", always_2d=True)
            if target_sr is None:
                target_sr = sr
            elif sr != target_sr:
                resampled = tmp_dir / f"{safe_key}_rs.wav"
                _ffmpeg_convert_to_wav(wav_path, resampled, target_sr=target_sr)
                audio, sr = engine.sf.read(str(resampled), dtype="float32", always_2d=True)
            if audio.shape[1] == 1:
                audio = engine.np.repeat(audio, 2, axis=1)
            stereo_audio[safe_key] = audio[:, :2]

        max_len = max(len(a) for a in stereo_audio.values())
        mix = engine.np.zeros((max_len, 2), dtype="float32")
        for audio in stereo_audio.values():
            mix[:len(audio)] += audio

        mix, _norm_info = engine.normalize_loudness(
            mix, target_sr, engine.DEFAULT_TARGET_LUFS, normalize=True, max_boost_db=engine.DEFAULT_MAX_BOOST_DB)

        song_base = safe_name(Path(zip_filename).stem)
        input_path = (INPUT_DIR / f"{song_base}.wav").resolve()
        engine.sf.write(str(input_path), mix, target_sr)

        digest = engine.content_hash(input_path)
        out_dir = engine.SEPARATED_DIR / IMPORTED_MODEL_NAME / f"{song_base}__{digest}"
        out_dir.mkdir(parents=True, exist_ok=True)

        labels = {}
        for raw_label, safe_key, wav_path in converted:
            wav_path.replace(out_dir / f"{safe_key}.wav")
            labels[safe_key] = raw_label
        (out_dir / "stem_labels.json").write_text(json.dumps(labels, indent=2))

    # Pre-seed a project so selecting this track for the very first time
    # loads model='imported' automatically — matches the shape app.js's
    # own saveProjectDebounced() writes (XC-01 project format v2).
    svc_save_project(input_path.name, {
        "version": 2, "model": IMPORTED_MODEL_NAME,
        "mix": {"gains": {}, "muted": {}, "solo": None, "muteRanges": {}, "eq": {}, "pan": {}},
        "ui": {"loop": None, "loopEnabled": False},
        "markers": [], "rigPresetChain": [], "rigPresetIndex": 0,
        "rigPresetCycleKeyForward": None, "rigPresetCycleKeyBackward": None,
        "bpmOverride": None,
    })

    return {
        "name": input_path.name,
        "model": IMPORTED_MODEL_NAME,
        "stems": stem_info(out_dir, IMPORTED_MODEL_NAME, digest),
    }


# ---------------------------------------------------------------------------
# "Rip" — capture whatever's playing on the Mac (system-audio-rip-spec.md).
# The actual system-audio tap happens in the browser (getUserMedia against a
# BlackHole virtual device + MediaRecorder — same primitives Play Along's
# input picker and the take-recorder already use), so this server side is
# just "remux whatever container that produced into an mp3 in input/,"
# mirroring svc_recording_finalize's ffmpeg-subprocess/temp-file pattern.
# Once the mp3 lands in input/, it's an ordinary track — refreshTrackList()
# picks it up exactly like a manual drag-and-drop import.
# ---------------------------------------------------------------------------

RIP_SRC_EXTS = {"webm", "mp4", "m4a", "wav"}

# A dead BlackHole tap (System Settings' output never actually routed to it)
# still "records" successfully — MediaRecorder happily captures 7 seconds of
# silence — so the failure doesn't surface until separation, as a cryptic
# "Expected a 'vocals' stem... but didn't find one among: []" error minutes
# later, with the routing mistake long forgotten. Real captured audio, even
# quiet music, peaks well above this; a silent tap sits at the codec noise
# floor (observed ~-91dB on an actual dead capture) — -60dB is a wide margin
# between the two, not a tight tripwire.
RIP_SILENCE_PEAK_DB = -60.0


def _ffmpeg_peak_db(ffmpeg: str, path: Path) -> float | None:
    """Runs ffmpeg's volumedetect filter (analysis only, no output written)
    over the already-remuxed file and parses the reported max_volume. Same
    ffmpeg invocation family as the remux itself, just a second pass, so
    this doesn't add a new dependency or touch the audio. Returns None if
    the filter's output can't be parsed — a missing-tool/parse issue is
    exactly the kind of failure a "silent rip" guardrail must never turn
    into a false alarm for, since the file is real either way."""
    result = subprocess.run(
        [ffmpeg, "-i", str(path), "-af", "volumedetect", "-vn", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    match = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", result.stderr)
    return float(match.group(1)) if match else None


def svc_rip_save(filename: str, src_ext: str, data: bytes) -> dict:
    if not data:
        raise ApiError(400, "Empty upload")
    src_ext = (src_ext or "webm").lstrip(".").lower()
    if src_ext not in RIP_SRC_EXTS:
        raise ApiError(400, f"Unsupported extension '{src_ext}'")

    name = safe_name(filename) or "Rip"
    name = re.sub(r"\.(mp3|wav|m4a|webm|mp4)$", "", name, flags=re.IGNORECASE)

    ffmpeg = engine.find_ffmpeg()
    if not ffmpeg:
        raise ApiError(500, "ffmpeg not found — required to finish a rip. Is it installed? (brew install ffmpeg)")

    with tempfile.TemporaryDirectory(prefix="gs_rip_") as tmp_dir_str:
        src_path = Path(tmp_dir_str) / f"rip_src.{src_ext}"
        src_path.write_bytes(data)

        dest_path = (INPUT_DIR / f"{name}.mp3").resolve()
        cmd = [ffmpeg, "-y", "-i", str(src_path), "-vn", "-acodec", "libmp3lame", "-q:a", "2", str(dest_path)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise ApiError(400, f"Could not finish the rip: {result.stderr[-500:]}")

        peak_db = _ffmpeg_peak_db(ffmpeg, dest_path)

    # Still saved either way — least-destructive default. A false positive
    # (e.g. a genuinely quiet ambient recording) costs the user one glance
    # at a warning; discarding a real capture on a guess would be much worse.
    response = {"name": dest_path.name, "path": str(dest_path)}
    if peak_db is not None:
        response["peak_db"] = round(peak_db, 1)
        response["silent"] = peak_db < RIP_SILENCE_PEAK_DB
    return response


def svc_separate(source_path: str, model: str, force: bool) -> dict:
    input_path = resolve_source_path(source_path)
    key = (input_path.name, model)
    _set_job(key, status="queued", percent=0)
    try:
        with SEPARATION_LOCK:
            _set_job(key, status="running", percent=0)
            out_dir = engine.track_stem_dir(input_path, model)

            reused = engine.has_cached_stems(out_dir) and not force
            if not reused:
                def progress_cb(pct, _key=key):
                    # Demucs runs multiple internal passes for bagged
                    # models (e.g. mdx_extra ensembles several checkpoints),
                    # each restarting its own 0-100% tqdm bar — never let
                    # the reported percent visibly jump backward.
                    current = _get_job(_key).get("percent", 0)
                    _set_job(_key, status="running", percent=max(current, pct))

                if model in engine.AUDIO_SEPARATOR_MODELS:
                    engine.run_audio_separator_backend(input_path, model, out_dir, progress_cb=progress_cb)
                else:
                    engine.run_demucs_backend(input_path, model, out_dir, progress_cb=progress_cb)
                engine.write_fingerprint(out_dir, input_path)

            engine.export_stem_files(list(out_dir.glob("*.wav")), input_path.stem, model)

            result = {
                "cache_dir": str(out_dir),
                "output_dir": str(engine.track_output_dir(input_path.stem)),
                "stems": stem_info(out_dir, model, engine.content_hash(input_path)),
                "analysis": engine.ensure_analysis(out_dir),
                "stale": engine.fingerprint_is_stale(out_dir, input_path) if reused else False,
                "reused_cache": reused,
            }
        _set_job(key, status="done", percent=100)
        return result
    except Exception:
        _set_job(key, status="error", percent=0)
        raise


def svc_separate_status(source_path: str, model: str) -> dict:
    input_path = resolve_source_path(source_path)
    return _get_job((input_path.name, model))


def svc_list_stems(source_path: str, model: str) -> dict:
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'. "
                             f"Run separate first.")
    return {
        "stems": stem_info(out_dir, model, engine.content_hash(input_path)),
        "stale": engine.fingerprint_is_stale(out_dir, input_path),
        "analysis": engine.ensure_analysis(out_dir),
    }


def svc_stem_rename(source_path: str, model: str, stem: str, new_label: str) -> dict:
    """Sets a stem's display label — stemDisplayName (app.js) shows this
    instead of the raw on-disk key when present. Only the label changes;
    the on-disk filename and State.mix's gain/mute/pan/eq lookups (all
    keyed by the stem's real name) are untouched, so this can't orphan any
    per-stem mix state the way renaming the underlying file could. Most
    useful for imported stem packs (multi-stem-import-spec.md), whose
    on-disk keys are safe_name()'d from often-long original filenames —
    but stem_info reads stem_labels.json for any model's cache dir, so
    this works the same way for a plain Demucs/audio-separator stem too."""
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'.")
    stem_key = safe_name(stem)
    stem_path = out_dir / f"{stem_key}.wav"
    if not stem_path.exists():
        raise ApiError(404, f"No '{stem}' stem found.")
    if not new_label or not new_label.strip():
        raise ApiError(400, "new_label is required")

    labels_path = out_dir / "stem_labels.json"
    labels = json.loads(labels_path.read_text()) if labels_path.exists() else {}
    labels[stem_key] = new_label.strip()
    labels_path.write_text(json.dumps(labels, indent=2))
    return {"ok": True, "name": stem_key, "label": labels[stem_key]}


# ---------------------------------------------------------------------------
# Custom stems (custom-stems-spec.md) — drag an external mp3/wav onto an
# already-separated song's mixer and have it behave as a full stem from
# then on. Stored track-scoped (custom_stems_dir, keyed by content hash
# only), NOT inside any model's own stem-cache dir — that dir gets
# shutil.rmtree'd by run_demucs_backend on re-separation, and a stem the
# user physically provided has nothing to do with which ML model is
# currently active for the others. stem_info() merges these into every
# model's stem list; svc_mix() and resolve_stem_file() both know to look
# here when a stem isn't found in the active model's own out_dir.
# ---------------------------------------------------------------------------

def svc_add_custom_stem(source_path: str, filename: str, audio_bytes: bytes) -> dict:
    if not audio_bytes:
        raise ApiError(400, "Empty upload")
    input_path = resolve_source_path(source_path)

    # This adds to an already-separated track; it doesn't seed a bare
    # import. While checking that, also grab an existing stem's sample
    # rate to match the new one to (so it sums correctly in the same
    # Web Audio graph / svc_mix, regardless of which model is active).
    target_sr = None
    for m in engine.ALL_KNOWN_MODELS:
        d = engine.track_stem_dir(input_path, m)
        existing = sorted(d.glob("*.wav")) if d.exists() else []
        if existing:
            target_sr = engine.sf.info(str(existing[0])).samplerate
            break
    if target_sr is None:
        raise ApiError(404, f"{input_path.name} has no separated stems yet — separate it first.")

    raw_label = Path(filename).stem
    safe_key = safe_name(raw_label)
    digest = engine.content_hash(input_path)
    custom_dir = engine.custom_stems_dir(digest)
    custom_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="gs_custom_stem_") as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        src_path = tmp_dir / f"src{Path(filename).suffix.lower() or '.bin'}"
        src_path.write_bytes(audio_bytes)
        wav_path = tmp_dir / f"{safe_key}.wav"
        _ffmpeg_convert_to_wav(src_path, wav_path, target_sr=target_sr)
        # Re-dropping a file with the same resulting name intentionally
        # replaces it (re-recording an improved take is the expected
        # workflow), not an error — same as any other overwrite-by-name.
        wav_path.replace(custom_dir / f"{safe_key}.wav")

    labels_path = custom_dir / "stem_labels.json"
    labels = json.loads(labels_path.read_text()) if labels_path.exists() else {}
    labels[safe_key] = raw_label
    labels_path.write_text(json.dumps(labels, indent=2))

    info = engine.sf.info(str(custom_dir / f"{safe_key}.wav"))
    return {
        "name": safe_key, "label": raw_label,
        "duration": info.duration, "sample_rate": info.samplerate,
        "is_derived": False, "is_custom": True,
    }


def svc_remove_custom_stem(source_path: str, stem: str) -> dict:
    input_path = resolve_source_path(source_path)
    custom_dir = engine.custom_stems_dir(engine.content_hash(input_path))
    stem_key = safe_name(stem)
    stem_path = custom_dir / f"{stem_key}.wav"
    if not stem_path.exists():
        raise ApiError(404, f"No custom stem named '{stem}' for this track.")
    stem_path.unlink()
    labels_path = custom_dir / "stem_labels.json"
    if labels_path.exists():
        labels = json.loads(labels_path.read_text())
        labels.pop(stem_key, None)
        labels_path.write_text(json.dumps(labels, indent=2))
    return {"ok": True}


def svc_split_guitar(source_path: str, model: str, stem: str, method: str) -> dict:
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'. "
                             f"Run separate first.")

    stem_path = out_dir / f"{stem}.wav"
    if not stem_path.exists():
        raise ApiError(400, f"No '{stem}' stem found. This split needs a stereo guitar "
                             f"stem — try separating with a 6-stem-capable model first.")

    audio, sr = engine.sf.read(str(stem_path), dtype="float32")
    if audio.ndim < 2 or audio.shape[1] < 2:
        raise ApiError(400, f"'{stem}' stem is mono — a panning-based split needs stereo audio.")

    left, right = audio[:, 0], audio[:, 1]
    if engine.np.std(left) > 0 and engine.np.std(right) > 0:
        correlation = float(engine.np.corrcoef(left, right)[0, 1])
    else:
        correlation = 1.0

    if method not in ("spectral", "midside", "hybrid"):
        raise ApiError(400, f"Unknown split method '{method}' — use 'spectral', 'midside', or 'hybrid'")
    if method == "spectral":
        center_mono, sides_mono = engine.spectral_pan_split(left, right, sr)
    elif method == "hybrid":
        beats = engine.ensure_analysis(out_dir).get("beats", [])
        center_mono, sides_mono = engine.hybrid_pan_split(left, right, sr, beats)
    else:
        center_mono, sides_mono = engine.midside_pan_split(left, right)
    center = engine.np.stack([center_mono, center_mono], axis=1)
    sides = engine.np.stack([sides_mono, -sides_mono], axis=1)

    center_path = out_dir / f"{stem}_center.wav"
    sides_path = out_dir / f"{stem}_sides.wav"
    engine.sf.write(str(center_path), center, sr)
    engine.sf.write(str(sides_path), sides, sr)
    engine.export_stem_files([center_path, sides_path], input_path.stem, model)

    updated = stem_info(out_dir, model, engine.content_hash(input_path))
    new_stems = [s for s in updated if s["name"] in (f"{stem}_center", f"{stem}_sides")]
    return {"new_stems": new_stems, "correlation": correlation}


def svc_mix(source_path: str, model: str, gains: dict, mute_ranges: dict,
            target_lufs: float, output_name: str, fmt: str,
            normalize: bool = True, max_boost_db: float = engine.DEFAULT_MAX_BOOST_DB,
            offsets: dict | None = None) -> dict:
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'. "
                             f"Run separate first.")

    # custom-stems-spec.md: a custom stem's file lives in the track-scoped
    # custom dir, not out_dir — existing_stems() only sees out_dir, so
    # union in whatever custom stems this track has for every model.
    custom_dir = engine.custom_stems_dir(engine.content_hash(input_path))
    custom_stem_names = tuple(sorted(p.stem for p in custom_dir.glob("*.wav"))) if custom_dir.exists() else ()
    valid_stems = engine.existing_stems(out_dir) + custom_stem_names
    unknown = set(gains) - set(valid_stems)
    if unknown:
        raise ApiError(400, f"Unknown stem name(s): {', '.join(sorted(unknown))}. "
                             f"Available: {', '.join(valid_stems)}")

    full_gains = {stem: 1.0 for stem in valid_stems}
    full_gains.update(gains)
    active_stems = [s for s in valid_stems if full_gains[s] != 0.0]
    if not active_stems:
        raise ApiError(400, "All stems muted/zeroed — nothing to mix.")

    mix = None
    samplerate = None
    for stem in active_stems:
        stem_path = out_dir / f"{stem}.wav"
        if not stem_path.exists() and stem in custom_stem_names:
            stem_path = custom_dir / f"{stem}.wav"
        if not stem_path.exists():
            raise ApiError(500, f"Missing stem file: {stem_path.name}")
        audio, sr = engine.sf.read(str(stem_path), dtype="float32")
        if samplerate is None:
            samplerate = sr
        elif sr != samplerate:
            raise ApiError(400, f"Sample rate mismatch in {stem}.wav: {sr} vs {samplerate}")

        audio = audio * full_gains[stem]

        # GP-15 (custom-stem timeline offset): a custom stem "patched" in
        # partway through the song is stored as just its own short clip, at
        # buffer-position 0 — this pads that many silent samples onto the
        # FRONT so it lands at the right absolute position in the mix,
        # before mute ranges (which are already in absolute song time, same
        # coordinate system the live mixer's mute-lane paints in) are
        # applied. A stem with no entry in offsets (every stem except a
        # repositioned custom one) pads zero — a no-op.
        offset_sec = (offsets or {}).get(stem, 0.0)
        if offset_sec > 0:
            pad_samples = int(round(offset_sec * sr))
            audio = engine.np.pad(audio, ((pad_samples, 0), (0, 0)))

        spans = mute_ranges.get(stem)
        if spans:
            envelope = engine.build_mute_envelope(len(audio), sr, spans)
            audio = audio * envelope[:, engine.np.newaxis]

        if mix is None:
            mix = audio
        else:
            if len(audio) < len(mix):
                audio = engine.np.pad(audio, ((0, len(mix) - len(audio)), (0, 0)))
            elif len(mix) < len(audio):
                mix = engine.np.pad(mix, ((0, len(audio) - len(mix)), (0, 0)))
            mix += audio

    mix, norm_info = engine.normalize_loudness(mix, samplerate, target_lufs,
                                                normalize=normalize, max_boost_db=max_boost_db)

    output_name = output_name or f"backing_track.{fmt}"
    # The browser's Output name field doesn't require an extension — the
    # Format dropdown is meant to control that — but a name typed without
    # one (e.g. "My Mix") reached write_audio() with an empty suffix and
    # died as "Unsupported output format: .". Append the selected format's
    # extension whenever the given name doesn't already end in a supported
    # one, so the dropdown always wins over a bare name.
    if Path(output_name).suffix.lower() not in (".wav", ".mp3"):
        output_name = f"{output_name}.{fmt}"
    out_path = engine.resolve_output_path(output_name, input_path.stem)
    # Containment check — this is the web boundary. resolve_output_path
    # honors a '/'-bearing or absolute output_name verbatim (intentional for
    # the CLI), but over HTTP that's an arbitrary-file-write primitive: the
    # server binds loopback only, yet any web page in the user's browser can
    # POST /api/mix, so an Export "Output name" of '../../x' or '/tmp/x.wav'
    # must not escape output/. safe_name() on the browser side isn't enough —
    # enforce it here where the write actually happens.
    output_root = engine.OUTPUT_DIR.resolve()
    try:
        out_path.resolve().relative_to(output_root)
    except ValueError:
        raise ApiError(400, "Output name must be a plain filename, not a path.")
    engine.write_audio(mix, samplerate, out_path)

    return {"output_path": str(out_path), **norm_info}


def svc_exported_tracks(source_path: str) -> dict:
    """Real exported mixes for one song (most recent first), for the Play
    Along "Exported Tracks" card — output/<track>/ also holds stem copies
    (export_stem_files, always named "<model>_<stem>.wav" — including
    split-guitar candidates and any other derived stem, since those go
    through the same copy call) and a recordings/ subfolder, which this
    filters out so only actual Export-panel bounces show up."""
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_output_dir(input_path.stem)
    if not out_dir.exists():
        return {"tracks": []}
    known_model_prefixes = tuple(f"{m}_" for m in engine.ALL_KNOWN_MODELS)
    tracks = []
    for f in sorted(out_dir.iterdir()):
        if not f.is_file() or f.suffix.lower() not in (".wav", ".mp3"):
            continue
        if f.name.startswith(known_model_prefixes):
            continue
        tracks.append({"name": f.name, "path": str(f), "size": f.stat().st_size, "modified": f.stat().st_mtime})
    tracks.sort(key=lambda t: t["modified"], reverse=True)
    return {"tracks": tracks}


def resolve_stem_file(source_path: str, model: str, stem: str) -> Path:
    """For streaming stem audio to the browser's Web Audio graph — the
    playback path M2 needs that M1's route set didn't cover yet."""
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'.")
    stem_path = out_dir / f"{safe_name(stem)}.wav"
    if stem_path.exists():
        return stem_path
    # custom-stems-spec.md: a custom stem lives in the track-scoped (not
    # model-scoped) custom dir, so it won't be found in out_dir above
    # regardless of which model is currently selected.
    custom_path = engine.custom_stems_dir(engine.content_hash(input_path)) / f"{safe_name(stem)}.wav"
    if custom_path.exists():
        return custom_path
    raise ApiError(404, f"No '{stem}' stem found in this track/model.")


def resolve_output_file(rel_path: str) -> Path:
    """For streaming an already-exported mix back to the browser (playback
    or download) — must resolve inside output/, same containment pattern as
    every other user-supplied-path route."""
    if not rel_path:
        raise ApiError(400, "path is required")
    candidate = (PROJECT_ROOT / rel_path).resolve()
    output_root = (PROJECT_ROOT / "output").resolve()
    try:
        candidate.relative_to(output_root)
    except ValueError:
        raise ApiError(400, "path must be inside output/")
    if not candidate.exists():
        raise ApiError(404, "File not found")
    return candidate


TAKE_RE = re.compile(r"take (\d+)", re.IGNORECASE)


def recordings_dir_for(track: str) -> Path:
    track_name = safe_name(track) if track else "_untracked"
    return engine.OUTPUT_DIR / track_name / "recordings"


def next_take_number(rec_dir: Path) -> int:
    max_take = 0
    if rec_dir.exists():
        for f in rec_dir.iterdir():
            m = TAKE_RE.search(f.stem)
            if m:
                max_take = max(max_take, int(m.group(1)))
    return max_take + 1


# GP-07: riff captures share the recordings directory with regular takes but
# get their own "riff NN" numbering, so a rolling-buffer save never collides
# with or perturbs regular take numbers (TAKE_RE above only ever matches
# "take (\d+)" — a riff file just doesn't match it at all).
RIFF_RE = re.compile(r"riff (\d+)", re.IGNORECASE)


def next_riff_number(rec_dir: Path) -> int:
    max_riff = 0
    if rec_dir.exists():
        for f in rec_dir.iterdir():
            m = RIFF_RE.search(f.stem)
            if m:
                max_riff = max(max_riff, int(m.group(1)))
    return max_riff + 1


# V5-B1: a regular take/riff records the backing track + guitar together
# (Recorder.recordBus in recorder.js — deliberate, so a take is actually
# listenable/watchable as a normal performance). That's exactly wrong input
# for Rate My Take: scoring a take against the reference guitar stem when
# the take *also contains that same reference bled in* trivially inflates
# every take's agreement regardless of how well it was actually played,
# and compresses real differences between takes into noise (confirmed:
# three real takes meant to rank tight > variation > sloppy came back
# within ~1% of each other, with the deliberately-varied take scoring
# highest). "Dry" recordings tap only the guitar rig output, no backing
# track — a third, independent numbering sequence (own regex, like riffs)
# so it doesn't collide with or get counted by regular take/riff numbering.
DRY_RE = re.compile(r"dry (\d+)", re.IGNORECASE)


def next_dry_number(rec_dir: Path) -> int:
    max_dry = 0
    if rec_dir.exists():
        for f in rec_dir.iterdir():
            m = DRY_RE.search(f.stem)
            if m:
                max_dry = max(max_dry, int(m.group(1)))
    return max_dry + 1


def svc_recording_save(track: str, ext: str, data: bytes, prefix: str = "take") -> dict:
    # GP-08: "m4a" is an audio-only take (recorder.js's REC_AUDIO_MIME_CANDIDATES)
    # — same MPEG-4 container as mp4, different extension so it reads as what
    # it is. GP-07: "wav" is a riff capture (playalong.js's own WAV encoder —
    # riffs never go through MediaRecorder at all, see riff-capture-processor.js).
    if ext not in ("mp4", "webm", "m4a", "wav"):
        raise ApiError(400, f"Unsupported extension '{ext}' — use mp4, webm, m4a, or wav")
    if prefix not in ("take", "riff", "dry"):
        raise ApiError(400, f"Unsupported prefix '{prefix}' — use take, riff, or dry")
    if not data:
        raise ApiError(400, "Empty upload")
    track_name = safe_name(track) if track else "_untracked"
    rec_dir = recordings_dir_for(track)
    rec_dir.mkdir(parents=True, exist_ok=True)
    if prefix == "riff":
        n = next_riff_number(rec_dir)
    elif prefix == "dry":
        n = next_dry_number(rec_dir)
    else:
        n = next_take_number(rec_dir)
    filename = f"{track_name} - {prefix} {n:02d}.{ext}"
    path = rec_dir / filename
    path.write_bytes(data)
    if prefix == "dry":
        dry_takes = _read_dry_takes(rec_dir)
        dry_takes.add(filename)
        _write_dry_takes(rec_dir, dry_takes)
    return {"path": str(path), "filename": filename, "take": n}


STARRED_FILE = ".starred.json"


def _read_starred(rec_dir: Path) -> set:
    meta = rec_dir / STARRED_FILE
    if not meta.exists():
        return set()
    try:
        return set(json.loads(meta.read_text()).get("starred", []))
    except (json.JSONDecodeError, OSError):
        return set()


def _write_starred(rec_dir: Path, starred: set) -> None:
    (rec_dir / STARRED_FILE).write_text(json.dumps({"starred": sorted(starred)}))


# V5-B1: dry-take membership needs to survive a rename (renaming a take is
# an existing, expected action — Play Along's Takes tab already supports
# it), but DRY_RE alone only recognizes the auto-generated "<track> - dry
# NN" filename. Same sidecar-JSON idiom as starred above, so a renamed dry
# take (e.g. to "Good attempt") doesn't silently vanish from Rate My Take's
# takes list the moment its filename stops matching the regex.
DRY_TAKES_FILE = ".dry_takes.json"


def _read_dry_takes(rec_dir: Path) -> set:
    meta = rec_dir / DRY_TAKES_FILE
    if not meta.exists():
        return set()
    try:
        return set(json.loads(meta.read_text()).get("dry", []))
    except (json.JSONDecodeError, OSError):
        return set()


def _write_dry_takes(rec_dir: Path, dry_takes: set) -> None:
    (rec_dir / DRY_TAKES_FILE).write_text(json.dumps({"dry": sorted(dry_takes)}))


# Caches the last Rate My Take result per take filename, so reopening the
# tab (or just picking a take you already scored while comparing a few)
# shows the existing rating/heatmap instantly instead of re-running
# score_take — same sidecar-JSON idiom as starred/dry_takes above, and
# same "survive a rename" requirement (see svc_recording_rename). Deleting
# a take removes its entry and its heatmap file (see svc_recording_discard)
# rather than leaving an orphaned rating pointing at a file that no longer
# exists.
RATINGS_FILE = ".rate_ratings.json"


def _read_ratings(rec_dir: Path) -> dict:
    meta = rec_dir / RATINGS_FILE
    if not meta.exists():
        return {}
    try:
        return json.loads(meta.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _write_ratings(rec_dir: Path, ratings: dict) -> None:
    (rec_dir / RATINGS_FILE).write_text(json.dumps(ratings, indent=2))


def svc_recordings_list(track: str) -> dict:
    """VD-02: every take for a track, inline-playable and starrable — ends
    the round-trip to Finder/QuickTime for every review."""
    rec_dir = recordings_dir_for(track)
    takes = []
    if rec_dir.exists():
        starred = _read_starred(rec_dir)
        dry_takes = _read_dry_takes(rec_dir)
        ratings = _read_ratings(rec_dir)
        for f in sorted(rec_dir.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                takes.append({
                    "filename": f.name, "path": str(f), "size": f.stat().st_size,
                    "starred": f.name in starred,
                    # V5-B1: only a "dry" recording (guitar rig only, no
                    # backing track baked in) is valid input for Rate My
                    # Take — see DRY_RE's comment for why a regular take
                    # scores meaninglessly high regardless of performance.
                    # The sidecar is the real source of truth (survives a
                    # rename — see svc_recording_rename); the regex is only
                    # a fallback for a dry file that predates the sidecar
                    # or was dropped in by hand.
                    "dry": f.name in dry_takes or bool(DRY_RE.search(f.stem)),
                    # Cached Rate My Take result (see RATINGS_FILE's
                    # comment) — None if never scored, so the client can
                    # show a take's last rating instantly on selection
                    # instead of re-running score_take just to compare.
                    "rating": ratings.get(f.name),
                })
    return {"takes": takes}


def svc_rate_score(source_path: str, take_path: str, model: str, stem: str,
                    offset: float, offset_search: float) -> dict:
    """AI Lab's Rate My Take panel — the HTTP-facing twin of cmd_rate
    (backing_track.py), reusing every piece of that CLI spike (score_take,
    refine_offset, trim_beats_to_take_span, _render_rate_heatmap) rather
    than re-implementing any of the scoring math for the browser. Renders
    the heatmap next to the take file and returns a path servable through
    the existing /api/output?path=... route — no new file-serving code."""
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(400, f"No stems found for {input_path.name} with model '{model}'. Separate it first.")
    reference_path = out_dir / f"{stem}.wav"
    if not reference_path.exists():
        raise ApiError(400, f"No '{stem}' stem found for this track/model — this needs a guitar stem.")

    target = Path(take_path).resolve()
    try:
        target.relative_to(engine.OUTPUT_DIR.resolve())
    except ValueError:
        raise ApiError(400, "take_path must be inside output/")
    if not target.exists():
        raise ApiError(404, "Take file not found")

    analysis = engine.ensure_analysis(out_dir)
    beats = analysis.get("beats")

    refine_info = None
    if offset_search and offset_search > 0:
        refined = engine.refine_offset(target, reference_path, offset, search_radius=offset_search)
        refine_info = {"offset": refined["offset"], "quality": refined["quality"], "clipped": refined["clipped"]}
        if not refined["clipped"] and refined["quality"] >= engine.RATE_OFFSET_SEARCH_MIN_QUALITY:
            offset = refined["offset"]
            refine_info["applied"] = True
        else:
            refine_info["applied"] = False

    beats = engine.trim_beats_to_take_span(beats, offset, target)
    result = engine.score_take(target, reference_path, beats, offset_sec=offset)
    scored = [b for b in result["beats"] if b["score"] is not None]
    if not scored:
        raise ApiError(400, f"No beats could be scored at offset {offset}s — check the offset and that "
                             f"both files have real audio in them.")

    # A hidden subfolder, not next to the take directly — svc_recordings_list
    # lists every plain file under the recordings dir for the Takes tab, and
    # a heatmap PNG living there would show up as a fake extra "take" (and,
    # since its filename carries the take's own name, could even mismatch
    # the "dry" flag). iterdir() doesn't recurse, so a subfolder is invisible
    # to that listing without needing its own filter there.
    heatmap_dir = target.parent / ".rate_heatmaps"
    heatmap_dir.mkdir(exist_ok=True)
    heatmap_path = heatmap_dir / f"{target.stem}_rate_heatmap.png"
    engine._render_rate_heatmap(result["beats"], heatmap_path, target.name, input_path.name, result["overall_pct"])

    response = {
        "overall_pct": result["overall_pct"],
        "overall_raw": result["overall_raw"],
        "overall_pitch": result["overall_pitch"],
        "overall_timing": result["overall_timing"],
        "scored_count": len(scored),
        "total_count": len(result["beats"]),
        "used_offset": offset,
        "heatmap_path": str(heatmap_path),
        "refine": refine_info,
    }

    # Cache this result under the take's own filename (see RATINGS_FILE's
    # comment) so reopening/comparing takes doesn't need to re-run
    # score_take just to see a rating that was already computed. Re-scoring
    # the same take (e.g. after adjusting the offset) simply overwrites its
    # entry — the cache always reflects the most recent scoring, not the
    # first one.
    rec_dir = target.parent
    ratings = _read_ratings(rec_dir)
    ratings[target.name] = {**response, "scored_at": time.time()}
    _write_ratings(rec_dir, ratings)

    return response


def svc_recording_star(path: str, starred: bool) -> dict:
    target = Path(path).resolve()
    try:
        target.relative_to(engine.OUTPUT_DIR.resolve())
    except ValueError:
        raise ApiError(400, "path must be inside output/")
    if not target.exists():
        raise ApiError(404, "Recording not found")
    rec_dir = target.parent
    current = _read_starred(rec_dir)
    if starred:
        current.add(target.name)
    else:
        current.discard(target.name)
    _write_starred(rec_dir, current)
    return {"ok": True, "starred": starred}


def svc_recording_rename(path: str, new_name: str) -> dict:
    target = Path(path).resolve()
    try:
        target.relative_to(engine.OUTPUT_DIR.resolve())
    except ValueError:
        raise ApiError(400, "path must be inside output/")
    if not target.exists():
        raise ApiError(404, "Recording not found")
    if not new_name:
        raise ApiError(400, "new_name is required")

    stem = safe_name(new_name)
    new_path = target.parent / f"{stem}{target.suffix}"
    if new_path.exists() and new_path != target:
        raise ApiError(409, f"'{new_path.name}' already exists")

    rec_dir = target.parent
    starred = _read_starred(rec_dir)
    was_starred = target.name in starred
    dry_takes = _read_dry_takes(rec_dir)
    # OR with DRY_RE here too (not just the sidecar) — a dry take saved
    # before this sidecar existed, or dropped in by hand, is still "dry" by
    # its current filename and shouldn't lose that the moment it's renamed
    # to something the regex no longer matches.
    was_dry = target.name in dry_takes or bool(DRY_RE.search(target.stem))
    ratings = _read_ratings(rec_dir)
    old_rating = ratings.get(target.name)
    old_name = target.name
    target.rename(new_path)
    if was_starred:
        starred.discard(old_name)
        starred.add(new_path.name)
        _write_starred(rec_dir, starred)
    if was_dry:
        dry_takes.discard(old_name)
        dry_takes.add(new_path.name)
        _write_dry_takes(rec_dir, dry_takes)
    if old_rating:
        # The heatmap file is keyed by the take's own filename stem — a
        # rename means the OLD heatmap would silently orphan (never found
        # again, since a re-score would generate a new one under the new
        # name) unless it's renamed to match right here.
        old_heatmap = Path(old_rating["heatmap_path"]) if old_rating.get("heatmap_path") else None
        new_rating = dict(old_rating)
        if old_heatmap and old_heatmap.exists():
            new_heatmap = old_heatmap.parent / f"{new_path.stem}_rate_heatmap.png"
            old_heatmap.rename(new_heatmap)
            new_rating["heatmap_path"] = str(new_heatmap)
        ratings.pop(old_name, None)
        ratings[new_path.name] = new_rating
        _write_ratings(rec_dir, ratings)

    return {"ok": True, "path": str(new_path), "filename": new_path.name}


def svc_recording_trim(path: str, start_sec: float, end_sec: float) -> dict:
    """VD-03: lossless top/tail trim (ffmpeg -ss/-to, stream copy, no
    re-encode) into a NEW file — the original take is never modified in
    place, matching the acceptance criterion exactly."""
    target = Path(path).resolve()
    try:
        target.relative_to(engine.OUTPUT_DIR.resolve())
    except ValueError:
        raise ApiError(400, "path must be inside output/")
    if not target.exists():
        raise ApiError(404, "Recording not found")
    if end_sec <= start_sec:
        raise ApiError(400, "end_sec must be after start_sec")

    ffmpeg = engine.find_ffmpeg()
    if not ffmpeg:
        raise ApiError(500, "ffmpeg not installed — can't trim")

    base = target.stem
    suffix = 1
    out_path = target.parent / f"{base} (trimmed){target.suffix}"
    while out_path.exists():
        suffix += 1
        out_path = target.parent / f"{base} (trimmed {suffix}){target.suffix}"

    cmd = [ffmpeg, "-y", "-ss", f"{start_sec:.3f}", "-to", f"{end_sec:.3f}",
           "-i", str(target), "-c", "copy", str(out_path)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        out_path.unlink(missing_ok=True)
        raise ApiError(500, f"ffmpeg trim failed: {result.stderr[-500:]}")

    return {"ok": True, "path": str(out_path), "filename": out_path.name}


def svc_recording_finalize(path: str, av_offset_ms: float) -> dict:
    """Lossless remux (-c copy, always) so MediaRecorder's known container
    quirks (missing/odd duration, non-faststart moov atom) get fixed even
    when no A/V offset is set. When an offset IS set, delay the audio input
    by that amount to match the (typically late) video — never destroys the
    original: works on a temp file, only replaces on ffmpeg success."""
    target = Path(path).resolve()
    try:
        target.relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        raise ApiError(400, "path must be inside the project directory")
    if not target.exists():
        raise ApiError(404, "Recording not found")

    ffmpeg = engine.find_ffmpeg()
    if not ffmpeg:
        return {"finalized": False, "reason": "ffmpeg not installed"}

    ext = target.suffix.lower()
    tmp_path = target.with_suffix(f".tmp{ext}")
    offset_sec = (av_offset_ms or 0) / 1000.0

    cmd = [ffmpeg, "-y", "-i", str(target)]
    # GP-08: an A/V offset only means anything with a video stream to sync
    # against — recorder.js already always sends 0 for an audio-only take,
    # but "-map 0:v" would fail outright on one if it ever didn't.
    if abs(offset_sec) > 1e-6:
        cmd += ["-itsoffset", f"{offset_sec:.3f}", "-i", str(target), "-map", "0:v", "-map", "1:a"]
    cmd += ["-c", "copy"]
    if ext in (".mp4", ".m4a"):
        cmd += ["-movflags", "+faststart"]
    cmd += [str(tmp_path)]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tmp_path.unlink(missing_ok=True)
        return {"finalized": False, "reason": f"ffmpeg failed: {result.stderr[-500:]}"}

    tmp_path.replace(target)
    return {"finalized": True, "path": str(target)}


def svc_recording_discard(path: str) -> dict:
    target = Path(path).resolve()
    try:
        target.relative_to((engine.OUTPUT_DIR).resolve())
    except ValueError:
        raise ApiError(400, "path must be inside output/")
    # Deleting a take (this is also the real "Delete" action, not just the
    # post-recording review discard) shouldn't leave an orphaned Rate My
    # Take rating/heatmap pointing at a file that no longer exists.
    rec_dir = target.parent
    ratings = _read_ratings(rec_dir)
    rating = ratings.pop(target.name, None)
    if rating:
        heatmap = Path(rating["heatmap_path"]) if rating.get("heatmap_path") else None
        if heatmap and heatmap.exists():
            heatmap.unlink()
        _write_ratings(rec_dir, ratings)
    if target.exists():
        target.unlink()
    return {"ok": True}


def svc_reveal(path: str) -> dict:
    target = Path(path).resolve()
    try:
        target.relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        raise ApiError(400, "path must be inside the project directory")
    if not target.exists():
        raise ApiError(404, "Path not found")
    subprocess.run(["open", "-R", str(target)])
    return {"ok": True}


def legacy_project_path(track: str) -> Path:
    return PROJECTS_DIR / f"{safe_name(track)}.json"


def project_path_for(track: str) -> Path:
    """Content-hash-keyed (same content_hash the stem cache already uses,
    XC-03), not filename-keyed — a known v2 gap: renaming a source file
    used to orphan its saved project, since the old scheme kept it under
    the OLD filename with nothing pointing a new selectTrack() call back to
    it. Renaming a file doesn't change its bytes, so hashing it instead
    means the same project is found under either name. Falls back to the
    legacy filename-keyed path if the source file can't be resolved (e.g.
    it's been deleted, not just renamed) — better to still find an existing
    project under the name it was saved as than to report none at all."""
    try:
        return PROJECTS_DIR / f"{content_hash_for_track(track)}.json"
    except ApiError:
        return legacy_project_path(track)


def content_hash_for_track(track: str) -> str:
    return engine.content_hash(resolve_source_path(track))


def svc_load_project(track: str) -> dict:
    path = project_path_for(track)
    if not path.exists():
        # Migration: a project saved under the pre-V3 filename-keyed scheme
        # is still found once here, and gets rewritten under the new
        # hash-keyed path the next time it's saved (svc_save_project always
        # writes to project_path_for, never back to the legacy path).
        legacy = legacy_project_path(track)
        if legacy.exists():
            path = legacy
        else:
            raise ApiError(404, f"No saved project for '{track}'")
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise ApiError(500, f"Could not read project file: {exc}")


def svc_save_project(track: str, project: dict) -> dict:
    path = project_path_for(track)
    path.write_text(json.dumps(project, indent=2))
    return {"ok": True, "path": str(path)}


# GP-02/GP-14: rig presets — unlike per-track projects, these are cross-song
# (a preset is recallable from any song, and a song's project just carries an
# ORDERED LIST of names it wants auto-applied/cycled through — see
# State.rigPresetChain/XC-01), so they
# live in one shared file rather than PROJECTS_DIR's per-track ones. Same
# dumb-blob-store pattern as svc_load_project/svc_save_project: the server
# doesn't interpret a preset's shape at all, just stores whatever dict the
# client sends.
RIG_PRESETS_FILE = PROJECTS_DIR / "_rig_presets.json"


def svc_load_rig_presets() -> dict:
    if not RIG_PRESETS_FILE.exists():
        return {"presets": {}}
    try:
        return json.loads(RIG_PRESETS_FILE.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise ApiError(500, f"Could not read rig presets file: {exc}")


def svc_save_rig_presets(presets: dict) -> dict:
    RIG_PRESETS_FILE.write_text(json.dumps({"presets": presets}, indent=2))
    return {"ok": True}


# V5-R1 (release-v5-spec.md §3/§7): the Lick/Phrasing Assistant's one
# external network dependency in an otherwise fully local/private app —
# opt-in by design. The key lives in this file, never in git (PROJECTS_DIR
# is gitignored — see .gitignore's "per-user saved state" section), and is
# never echoed back to the client once saved (svc_load_settings reports
# only whether one is set, not the key itself) — a locally-run app isn't a
# strong security boundary either way, but there's no reason to make the
# key visible in a browser dev-tools Network tab response on every page
# load when a boolean already answers "is this configured."
SETTINGS_FILE = PROJECTS_DIR / "_settings.json"


# V5-R1 follow-up: a provider picker (Claude/Anthropic, Google AI Studio,
# Groq) rather than one hardcoded provider — Google AI Studio and Groq both
# have a genuinely free tier for a small/fast model, which matters for a
# feature whose whole premise is "cheap enough for casual practice-session
# use." Every provider here still needs its own API key (free tier isn't
# "no key"); settings just grows one optional key per provider instead of
# a single Anthropic-only one. Each provider's own default model is
# next to its LICK_PROVIDERS entry below, not scattered through this file.
LICK_PROVIDERS = {
    "anthropic": {"key_field": "anthropic_api_key", "model": "claude-haiku-4-5-20251001"},
    # "gemini-flash-latest" deliberately, not a dated model string like
    # "gemini-2.5-flash" — real user report: that pinned version got cut
    # off for new API users ("no longer available to new users... update
    # your code to use a newer model") well before its own posted
    # deprecation date. Google maintains this alias to always point at
    # their current fast/cheap tier (Gemini 3.5 Flash as of mid-2026), so
    # it should keep working across their own model rotation instead of
    # needing a code change every time they retire one.
    "google": {"key_field": "google_api_key", "model": "gemini-flash-latest"},
    "groq": {"key_field": "groq_api_key", "model": "llama-3.3-70b-versatile"},
}

# Real user report: Groq's API (fronted by Cloudflare) returned 403 "error
# code: 1010" — a Cloudflare bot block, not a Groq auth/quota error — for a
# request carrying Python urllib's default "Python-urllib/3.x" User-Agent.
# Sent on all three providers' requests (not just Groq's) so none of them
# risk the same block if a provider's own CDN starts fingerprinting on it.
_LICK_HTTP_USER_AGENT = "OrpheusGuitarStudio/5.0 (+lick-ideas)"


def svc_load_settings() -> dict:
    raw = {}
    if SETTINGS_FILE.exists():
        try:
            raw = json.loads(SETTINGS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            raw = {}
    return {f"has_{provider}_key": bool(raw.get(info["key_field"])) for provider, info in LICK_PROVIDERS.items()}


def svc_save_provider_key(provider: str, api_key: str) -> dict:
    if provider not in LICK_PROVIDERS:
        raise ApiError(400, f"Unknown provider '{provider}'. Expected one of: {', '.join(LICK_PROVIDERS)}")
    api_key = (api_key or "").strip()
    raw = {}
    if SETTINGS_FILE.exists():
        try:
            raw = json.loads(SETTINGS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            raw = {}
    key_field = LICK_PROVIDERS[provider]["key_field"]
    if api_key:
        raw[key_field] = api_key
    else:
        raw.pop(key_field, None)  # empty submission clears it, same as any other saved setting
    SETTINGS_FILE.write_text(json.dumps(raw, indent=2))
    return {"ok": True, f"has_{provider}_key": bool(api_key)}


def _load_provider_key(provider: str) -> str:
    if not SETTINGS_FILE.exists():
        return ""
    try:
        raw = json.loads(SETTINGS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return ""
    return (raw.get(LICK_PROVIDERS[provider]["key_field"]) or "").strip()


def _call_anthropic(prompt: str, api_key: str) -> str:
    body = json.dumps({
        "model": LICK_PROVIDERS["anthropic"]["model"],
        "max_tokens": 400,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={
            "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json",
            "user-agent": _LICK_HTTP_USER_AGENT,
        },
    )
    try:
        with urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raise ApiError(exc.code, f"Anthropic API error ({exc.code}): {exc.read().decode('utf-8', errors='replace')[:300]}")
    except URLError as exc:
        raise ApiError(502, f"Couldn't reach the Anthropic API: {exc.reason}")
    return "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")


def _call_google(prompt: str, api_key: str) -> str:
    model = LICK_PROVIDERS["google"]["model"]
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
    req = Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        data=body, method="POST",
        headers={"content-type": "application/json", "user-agent": _LICK_HTTP_USER_AGENT},
    )
    try:
        with urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raise ApiError(exc.code, f"Google AI Studio error ({exc.code}): {exc.read().decode('utf-8', errors='replace')[:300]}")
    except URLError as exc:
        raise ApiError(502, f"Couldn't reach Google AI Studio: {exc.reason}")
    candidates = payload.get("candidates") or []
    if not candidates:
        raise ApiError(502, f"Google AI Studio returned no suggestion (possibly blocked by a safety filter): {payload}")
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def _call_groq(prompt: str, api_key: str) -> str:
    # OpenAI-compatible chat completions shape.
    body = json.dumps({
        "model": LICK_PROVIDERS["groq"]["model"],
        "max_tokens": 400,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = Request(
        "https://api.groq.com/openai/v1/chat/completions", data=body, method="POST",
        headers={
            "authorization": f"Bearer {api_key}", "content-type": "application/json",
            "user-agent": _LICK_HTTP_USER_AGENT,
        },
    )
    try:
        with urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raise ApiError(exc.code, f"Groq API error ({exc.code}): {exc.read().decode('utf-8', errors='replace')[:300]}")
    except URLError as exc:
        raise ApiError(502, f"Couldn't reach the Groq API: {exc.reason}")
    choices = payload.get("choices") or []
    return choices[0]["message"]["content"] if choices else ""


def _summarize_chord_progression(chords: list, max_runs: int = 40) -> str:
    """Collapses consecutive identical (root, quality) beats into runs (same
    idiom as the chord lane's own rendering) and lists them in order — the
    LLM gets the song's actual chord changes, not a beat-by-beat wall of
    duplicates. Capped at max_runs to keep the prompt (and cost) small for a
    long song with lots of changes; a spike judging usefulness doesn't need
    the last chorus repeated back to it."""
    if not chords:
        return ""
    runs = []
    for c in chords:
        if not c.get("root") or c.get("quality") == "N":
            continue
        symbol = c["root"] + ("" if c["quality"] == "maj" else "m" if c["quality"] == "min" else c["quality"])
        if runs and runs[-1] == symbol:
            continue
        runs.append(symbol)
    if len(runs) > max_runs:
        runs = runs[:max_runs] + ["..."]
    return " - ".join(runs)


def svc_lick_suggest(source_path: str, model: str, genre: str, provider: str) -> dict:
    """V5-R1's research spike (release-v5-spec.md §3), delivered as an AI
    Lab panel rather than CLI-only — same underlying judgment call either
    way ("does this read as genuinely useful, specific-to-this-song
    phrasing advice, or generic filler"), just a faster way for the user to
    actually run it against real songs and judge honestly. Sends only
    derived musical data (key/tempo/chord progression + an optional
    free-text style tag) — never raw audio — per §7's privacy posture.

    `provider` picks which of LICK_PROVIDERS actually gets called — same
    prompt either way, since the gate question ("is this genuinely useful
    phrasing advice") doesn't change with which model answers it."""
    api_key = _load_provider_key_or_raise(provider)
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(400, f"No stems found for {input_path.name} with model '{model}'. Separate it first.")
    key, bpm, progression = _song_theory_or_raise(out_dir)

    genre = (genre or "").strip()
    genre_line = f"- Style/genre: {genre}\n" if genre else ""
    prompt = (
        "You are an experienced guitar teacher giving practical lead-guitar phrasing advice.\n\n"
        "Song info:\n"
        f"- Key: {key['key']} {key['mode']}\n"
        f"- Tempo: {bpm:.0f} BPM\n"
        f"- Chord progression (in order): {progression}\n"
        f"{genre_line}\n"
        "Give 2-4 concrete, specific phrasing ideas for a guitar solo over this progression — target notes to "
        "land on over specific chords, call-and-response shapes, or a technique to try at a particular point. "
        "Avoid generic advice (e.g. \"use the pentatonic scale\") unless it's tied to a specific moment in THIS "
        "progression. Keep it concise — a short list, no more than ~150 words total.\n\n"
        f"{_NO_BAR_NUMBER_INSTRUCTION}"
    )

    caller = {"anthropic": _call_anthropic, "google": _call_google, "groq": _call_groq}[provider]
    text = caller(prompt, api_key)
    return {
        "suggestion": text.strip(),
        "key": f"{key['key']} {key['mode']}",
        "bpm": round(bpm, 1),
        "progression": progression,
        "provider": provider,
    }


def _load_provider_key_or_raise(provider: str) -> str:
    if provider not in LICK_PROVIDERS:
        raise ApiError(400, f"Unknown provider '{provider}'. Expected one of: {', '.join(LICK_PROVIDERS)}")
    api_key = _load_provider_key(provider)
    if not api_key:
        raise ApiError(400, f"No {provider} API key saved yet — add one in AI Lab's AI Assistant panel first.")
    return api_key


def _song_theory_or_raise(out_dir: Path) -> tuple:
    analysis = engine.ensure_analysis(out_dir)
    key = analysis.get("key")
    bpm = analysis.get("bpm")
    progression = _summarize_chord_progression(analysis.get("chords") or [])
    if not key or not bpm or not progression:
        raise ApiError(400, "This song needs a detected key, tempo, and chord progression first — run analysis "
                             "(open it in the Mixer) first.")
    return key, bpm, progression


_NO_BAR_NUMBER_INSTRUCTION = (
    "Important: you have no bar/measure or timing information beyond whatever timestamps are explicitly given "
    "above. Do NOT invent specific bar or measure numbers (e.g. \"bar 7\", \"bars 9-14\") — you have no real "
    "information about where those fall. Refer to moments by chord name/context or the given timestamps instead "
    "(e.g. \"over the A7 to B7 change\", \"around 0:45\")."
)


def _format_mmss(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _summarize_weak_beats(beats: list, max_regions: int = 3) -> str:
    """Turns score_take's per-beat breakdown into a short text summary of
    a take's weakest moments — the same read a guitarist already gets off
    the Rate My Take heatmap, handed to an LLM as text instead of a color,
    so Practice Tips can ground its suggestions in this take's actual weak
    spots rather than generic technique advice. Contiguous low-scoring
    beats (within 3s of each other) are merged into one region rather than
    listed beat-by-beat, and only the lowest-scoring regions are kept —
    every reasonably-good take still has *some* weakest beats, but the
    point is calling out what's actually worth practicing, not everything
    that scored under some fixed number."""
    scored = [b for b in beats if b["score"] is not None]
    if len(scored) < 3:
        return ""
    sorted_scores = sorted(b["score"] for b in scored)
    threshold = sorted_scores[len(sorted_scores) // 3]  # bottom third of this take's own beats
    weak = sorted([b for b in scored if b["score"] <= threshold], key=lambda b: b["time"])
    if not weak:
        return ""

    regions = []
    current = [weak[0]]
    for b in weak[1:]:
        if b["time"] - current[-1]["time"] <= 3.0:
            current.append(b)
        else:
            regions.append(current)
            current = [b]
    regions.append(current)

    regions.sort(key=lambda r: sum(b["score"] for b in r) / len(r))
    regions = regions[:max_regions]
    regions.sort(key=lambda r: r[0]["time"])

    lines = []
    for r in regions:
        pitch = sum(b["pitch"] for b in r) / len(r)
        timing = sum(b["timing"] for b in r) / len(r)
        weak_side = "timing" if timing < pitch else "pitch" if pitch < timing else "pitch and timing"
        lines.append(f"- {_format_mmss(r[0]['time'])}-{_format_mmss(r[-1]['time'])}: weaker {weak_side} "
                     f"(pitch {pitch * 100:.0f}%, timing {timing * 100:.0f}%)")
    return "\n".join(lines)


def svc_practice_tips(source_path: str, take_path: str, model: str, stem: str,
                       offset: float, offset_search: float, provider: str) -> dict:
    """AI Assistant's Practice Tips mode (release-v5-spec.md §4) — the one
    mode that's more than Lick Ideas with a different prompt: grounds its
    prompt in *this take's own* Rate My Take result (score_take's per-beat
    breakdown), not just the song's static key/chords/tempo, so the
    suggestions are supposed to trace back to this take's actual weak
    spots. Re-scores the take itself (same score_take/refine_offset path
    as /api/rate/score) rather than trusting a client-cached result — no
    server-side state to go stale, and the offset/offset-search UI is
    already familiar from the Rate My Take tab."""
    api_key = _load_provider_key_or_raise(provider)
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(400, f"No stems found for {input_path.name} with model '{model}'. Separate it first.")
    reference_path = out_dir / f"{stem}.wav"
    if not reference_path.exists():
        raise ApiError(400, f"No '{stem}' stem found for this track/model — this needs a guitar stem.")
    key, bpm, progression = _song_theory_or_raise(out_dir)

    target = Path(take_path).resolve()
    try:
        target.relative_to(engine.OUTPUT_DIR.resolve())
    except ValueError:
        raise ApiError(400, "take_path must be inside output/")
    if not target.exists():
        raise ApiError(404, "Take file not found")

    analysis = engine.ensure_analysis(out_dir)
    beats = analysis.get("beats")
    if offset_search and offset_search > 0:
        refined = engine.refine_offset(target, reference_path, offset, search_radius=offset_search)
        if not refined["clipped"] and refined["quality"] >= engine.RATE_OFFSET_SEARCH_MIN_QUALITY:
            offset = refined["offset"]

    beats = engine.trim_beats_to_take_span(beats, offset, target)
    result = engine.score_take(target, reference_path, beats, offset_sec=offset)
    scored = [b for b in result["beats"] if b["score"] is not None]
    if not scored:
        raise ApiError(400, f"No beats could be scored at offset {offset}s — check the offset and that "
                             f"both files have real audio in them.")

    weak_regions = _summarize_weak_beats(result["beats"])
    weak_line = (f"Weakest moments in this take (lower pitch/timing agreement vs. the reference):\n{weak_regions}\n\n"
                 if weak_regions else "")
    prompt = (
        "You are an experienced guitar teacher giving practical practice advice on a specific recorded take.\n\n"
        "Song info:\n"
        f"- Key: {key['key']} {key['mode']}\n"
        f"- Tempo: {bpm:.0f} BPM\n"
        f"- Chord progression (in order): {progression}\n\n"
        f"{weak_line}"
        "Give 2-3 concrete practice exercises tied to this take's actual weak moments above (if any are listed) — "
        "e.g. slowing down a specific passage with a metronome, isolating a technique at a specific timestamp, "
        "a targeted repetition drill. If no weak moments are listed, say the take was solid throughout rather than "
        "inventing a problem. Avoid generic advice (e.g. \"practice more\") that isn't tied to a specific moment "
        "above. Keep it concise — no more than ~150 words total.\n\n"
        f"{_NO_BAR_NUMBER_INSTRUCTION}"
    )

    caller = {"anthropic": _call_anthropic, "google": _call_google, "groq": _call_groq}[provider]
    text = caller(prompt, api_key)
    return {
        "suggestion": text.strip(),
        "key": f"{key['key']} {key['mode']}",
        "bpm": round(bpm, 1),
        "progression": progression,
        "weak_regions": weak_regions,
        "overall_pct": result["overall_pct"],
        "provider": provider,
    }


def _optional_song_theory(source_path: str, model: str) -> tuple:
    """Same data as _song_theory_or_raise, but never raises — This Track/
    This Artist/Ask AI (release-v5-spec.md §4a) are useful even for a song
    that's never been separated/analyzed (real-world background doesn't
    need any local audio analysis at all), so locally-derived context is
    optional bonus grounding here, not a hard requirement like it is for
    Lick Ideas/Practice Tips."""
    try:
        input_path = resolve_source_path(source_path)
        out_dir = engine.track_stem_dir(input_path, model)
        if not engine.has_cached_stems(out_dir):
            return None, None, None
        return _song_theory_or_raise(out_dir)
    except ApiError:
        return None, None, None


TRACK_INFO_FILE = PROJECTS_DIR / "_track_info.json"


def _guess_title_from_filename(track: str) -> str:
    """Best-effort only, never trusted blindly — real filenames in this
    project have been messy (e.g. "Empty_Rooms__Gary_Moore.mp3__dry_03.m4a"),
    so this just strips a trailing take/stem-style suffix and underscores
    rather than attempting a real artist/title split. The user always
    confirms/edits the actual Artist/Title fields; this is only a prefill
    hint for the title field."""
    name = re.sub(r"\.\w+__(dry|Good|Bad)(_\d+)?(\.\w+)?$", "", Path(track).name)
    stem = Path(name).stem
    return re.sub(r"[_\s]+", " ", stem).strip()


def _load_track_info_all() -> dict:
    if not TRACK_INFO_FILE.exists():
        return {}
    try:
        return json.loads(TRACK_INFO_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def svc_load_track_info(track: str) -> dict:
    info = _load_track_info_all().get(content_hash_for_track(track), {})
    return {
        "artist": info.get("artist", ""),
        "title": info.get("title", ""),
        "guessed_title": _guess_title_from_filename(track),
    }


def svc_save_track_info(track: str, artist: str, title: str) -> dict:
    key = content_hash_for_track(track)
    all_info = _load_track_info_all()
    all_info[key] = {"artist": (artist or "").strip(), "title": (title or "").strip()}
    TRACK_INFO_FILE.write_text(json.dumps(all_info, indent=2))
    return all_info[key]


# This Track/This Artist (release-v5-spec.md §4a) ask the model for
# real-world facts about a real band/guitarist from its own training data —
# a genuinely different trust boundary from every other mode here, which
# only ever reasons over data this app itself computed. This caveat is
# both sent to the model (as an explicit instruction, including the
# no-verbatim-lyrics rule) and returned to the client for display as a
# standing disclaimer, not folded silently into the answer text.
_REAL_WORLD_KNOWLEDGE_CAVEAT = (
    "This draws on general knowledge about real artists/songs, not anything computed from local audio — treat "
    "specific claims (dates, quotes, gear, credits, chart/performance details) as a starting point to verify, not "
    "a citation. Do not reproduce full song lyrics verbatim — commentary and short-fragment quoting only. If "
    "you're not confident about a specific claim, say so rather than stating it as fact."
)


def svc_this_track(source_path: str, model: str, provider: str) -> dict:
    """AI Assistant's This Track mode (release-v5-spec.md §4a)."""
    api_key = _load_provider_key_or_raise(provider)
    info = svc_load_track_info(source_path)
    artist, title = info["artist"], info["title"]
    if not artist and not title:
        raise ApiError(400, "Add this song's Artist/Title above first — needed to look anything up.")

    key, bpm, progression = _optional_song_theory(source_path, model)
    known_line = f"- Song: {title or '(title not given)'} by {artist or '(artist not given)'}\n"
    analysis_line = (
        f"- Detected key: {key['key']} {key['mode']}, tempo {bpm:.0f} BPM, chord progression: {progression}\n"
        if key else ""
    )
    prompt = (
        "You are a knowledgeable music historian and guitar teacher. Give background on this specific song.\n\n"
        f"{known_line}{analysis_line}\n"
        "Cover, briefly: band/release background; the song's structure and feel from a listener's perspective; "
        "technical notes (tie these to the detected key/tempo/progression above if given); the writing process "
        "and lyrical meaning where it's actually publicly known and not disputed (do NOT quote full lyrics "
        "verbatim); one or two notable performances/recordings worth hearing; and a couple of similar songs or "
        "solos worth checking out.\n\n"
        "Keep it concise — a few short paragraphs or bullet points, no more than ~250 words total.\n\n"
        f"{_REAL_WORLD_KNOWLEDGE_CAVEAT}"
    )

    caller = {"anthropic": _call_anthropic, "google": _call_google, "groq": _call_groq}[provider]
    text = caller(prompt, api_key)
    return {
        "info": text.strip(), "artist": artist, "title": title,
        "caveat": _REAL_WORLD_KNOWLEDGE_CAVEAT, "provider": provider,
    }


def svc_this_artist(source_path: str, model: str, provider: str) -> dict:
    """AI Assistant's This Artist mode (release-v5-spec.md §4a)."""
    api_key = _load_provider_key_or_raise(provider)
    info = svc_load_track_info(source_path)
    artist, title = info["artist"], info["title"]
    if not artist:
        raise ApiError(400, "Add this song's Artist above first — needed to look anything up.")

    prompt = (
        "You are a knowledgeable guitar historian and gear expert. Give background on this guitarist's playing "
        "and gear, using the song below as context where relevant.\n\n"
        f"- Guitarist/artist: {artist}\n"
        f"- Song: {title or '(not given)'}\n\n"
        "Cover, briefly: their general gear (amps, pedals, guitars) and how it's shaped their tone; their playing "
        "style and signature licks/techniques; and gear hints specific enough to point toward a NAM amp/pedal "
        "capture worth trying (e.g. \"closest to a certain amp/pedal combination\") — not a promise of exact "
        "tone-matching, just a more informed starting point than guessing blind.\n\n"
        "Keep it concise — a few short paragraphs or bullet points, no more than ~250 words total.\n\n"
        f"{_REAL_WORLD_KNOWLEDGE_CAVEAT}"
    )

    caller = {"anthropic": _call_anthropic, "google": _call_google, "groq": _call_groq}[provider]
    text = caller(prompt, api_key)
    return {
        "info": text.strip(), "artist": artist, "title": title,
        "caveat": _REAL_WORLD_KNOWLEDGE_CAVEAT, "provider": provider,
    }


def svc_ask_ai(source_path: str, model: str, question: str, provider: str) -> dict:
    """AI Assistant's Ask AI mode (release-v5-spec.md §4a) — absorbs the
    original Explain This (single-shot Q&A, no retained history — still a
    deliberate scope cut, not an oversight), broadened with the user's own
    guardrail persona: answer questions about this music/track/artist or
    music theory in general, and actually decline anything else rather
    than answer it anyway."""
    question = (question or "").strip()
    if not question:
        raise ApiError(400, "Ask a question first.")

    api_key = _load_provider_key_or_raise(provider)
    info = svc_load_track_info(source_path)
    artist, title = info["artist"], info["title"]
    key, bpm, progression = _optional_song_theory(source_path, model)

    context_lines = []
    if artist or title:
        context_lines.append(f"- Song: {title or '(title not given)'} by {artist or '(artist not given)'}")
    if key:
        context_lines.append(f"- Detected key: {key['key']} {key['mode']}, tempo {bpm:.0f} BPM, "
                              f"chord progression: {progression}")
    context = ("\n".join(context_lines) + "\n\n") if context_lines else ""

    prompt = (
        "You are a world-leading music theorist, historian, and virtuoso guitar player. Answer questions about "
        "music theory, this specific track, or this artist. If a question is unrelated to music, this track, or "
        "this artist, politely decline and say you're scoped to music-related questions only — do not answer "
        "unrelated questions anyway.\n\n"
        f"{context}"
        f"Question: {question}\n\n"
        "Keep the answer clear and concise — a short paragraph or a few bullet points, no more than ~150 words.\n\n"
        f"{_NO_BAR_NUMBER_INSTRUCTION}\n\n{_REAL_WORLD_KNOWLEDGE_CAVEAT}"
    )

    caller = {"anthropic": _call_anthropic, "google": _call_google, "groq": _call_groq}[provider]
    text = caller(prompt, api_key)
    return {
        "answer": text.strip(), "artist": artist, "title": title,
        "key": (f"{key['key']} {key['mode']}" if key else None),
        "bpm": (round(bpm, 1) if bpm else None),
        "progression": progression,
        "caveat": _REAL_WORLD_KNOWLEDGE_CAVEAT, "provider": provider,
    }


# V4-F3: playlists/setlists — same shared-blob pattern as rig presets above.
# A playlist doesn't own the tracks it lists (just their filenames as they
# appear in input/); per-song state (mix, rig, loop, markers) still lives
# entirely in that song's own project (svc_load_project/svc_save_project) —
# a playlist is just an ordering, never a copy of a song's settings. The
# server doesn't validate that a listed track still exists in input/; a
# renamed/deleted source file just makes that row fail to select, same as
# a stale Library entry would.
PLAYLISTS_FILE = PROJECTS_DIR / "_playlists.json"


def svc_load_playlists() -> dict:
    if not PLAYLISTS_FILE.exists():
        return {"playlists": {}}
    try:
        return json.loads(PLAYLISTS_FILE.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise ApiError(500, f"Could not read playlists file: {exc}")


def svc_save_playlists(playlists: dict) -> dict:
    PLAYLISTS_FILE.write_text(json.dumps({"playlists": playlists}, indent=2))
    return {"ok": True}


# V4-F4: practice log — honest numbers, no gamification (streaks, badges,
# goals). Content-hash-keyed like projects/analysis, so a renamed song
# keeps its history. The client (app.js's practice-time accumulator) sends
# small periodic increments while the backing track is actually playing
# rather than one lump sum at the end, so a crash or a closed tab loses at
# most the last few seconds, not the whole session.
PRACTICE_LOG_FILE = PROJECTS_DIR / "_practice_log.json"


def _read_practice_log() -> dict:
    if not PRACTICE_LOG_FILE.exists():
        return {}
    try:
        return json.loads(PRACTICE_LOG_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


# A session is a run of flush increments with no gap between them bigger
# than this — comfortably above the ~15-20s cadence flushPracticeLog (app.js)
# flushes at during continuous play, but short enough that stepping away to
# a DIFFERENT song for a few minutes (or longer) starts a new row rather
# than silently padding the last one.
SESSION_STITCH_GAP_SEC = 120
# `continuous=True` (app.js) means the player never actually switched to and
# practiced a different song between this flush and the last one for this
# same track — just paused, or the periodic flush cadence happened to land
# a while apart. That's still "the same song played over again without
# switching to a new session," so it gets a much longer allowance instead
# of the short one above — capped, not unlimited, so leaving a tab open for
# days without ever touching another song doesn't merge unrelated sittings
# together into one absurd row.
SESSION_CONTINUOUS_MAX_GAP_SEC = 4 * 3600
PRACTICE_SESSIONS_MAX = 500  # per track — oldest sessions drop off past this


def svc_practice_log_add(track: str, seconds: float, continuous: bool = False) -> dict:
    if seconds <= 0:
        raise ApiError(400, "seconds must be positive")
    if seconds > 300:
        # A single increment this large means the client-side accumulator
        # logic is wrong (or being poked directly), not a real 5-minute-long
        # animation-frame gap — refuse rather than silently trust it.
        raise ApiError(400, "seconds increment too large — expected a short periodic tick")
    digest = engine.content_hash(resolve_source_path(track))
    log = _read_practice_log()
    entry = log.get(digest, {"seconds": 0.0, "last_practiced": None, "track_name": track})
    entry["seconds"] = entry.get("seconds", 0.0) + seconds
    now = time.time()
    entry["last_practiced"] = now
    entry["track_name"] = track  # keeps the display name fresh across renames

    sessions = entry.setdefault("sessions", [])
    allowed_gap = SESSION_CONTINUOUS_MAX_GAP_SEC if continuous else SESSION_STITCH_GAP_SEC
    if sessions and now - sessions[-1]["end"] <= allowed_gap:
        sessions[-1]["end"] = now
        sessions[-1]["seconds"] += seconds
    else:
        sessions.append({"start": now - seconds, "end": now, "seconds": seconds})
    if len(sessions) > PRACTICE_SESSIONS_MAX:
        del sessions[:-PRACTICE_SESSIONS_MAX]

    log[digest] = entry
    PRACTICE_LOG_FILE.write_text(json.dumps(log, indent=2))
    return {"ok": True, "seconds": entry["seconds"], "last_practiced": entry["last_practiced"]}


def svc_practice_sessions(track: str) -> dict:
    """Session-by-session practice history for one track (most recent
    first), for the Play Along practice-log card — the cumulative total
    svc_tracks already exposes is one running number, this is the log
    entries that add up to it."""
    digest = engine.content_hash(resolve_source_path(track))
    log = _read_practice_log()
    entry = log.get(digest, {})
    sessions = sorted(entry.get("sessions", []), key=lambda s: s["start"], reverse=True)
    for s in sessions:
        s["id"] = _session_id(s)
    return {
        "sessions": sessions,
        "seconds": entry.get("seconds", 0.0),
        "last_practiced": entry.get("last_practiced"),
    }


# A session has no explicit stored id — it's derived from its own start
# time (ms resolution comfortably beats SESSION_STITCH_GAP_SEC's 120s, so
# two sessions can never collide) instead, so nothing needed backfilling
# for the sessions already on disk before rating/notes/delete existed.
def _session_id(session: dict) -> str:
    return str(round(session["start"] * 1000))


PRACTICE_RATINGS = ("crap", "bad", "ok", "good", "awesome")


def _find_session_entry(track: str, session_id: str) -> tuple[dict, dict, list]:
    """Returns (log, entry, sessions) with `entry`/`sessions` being the
    live objects inside `log` — callers mutate the returned session dict
    in place, then just re-serialize `log`, same pattern _read_practice_log
    callers already use elsewhere in this file."""
    digest = engine.content_hash(resolve_source_path(track))
    log = _read_practice_log()
    entry = log.get(digest)
    if not entry:
        raise ApiError(404, "No practice history for this track")
    sessions = entry.get("sessions", [])
    target = next((s for s in sessions if _session_id(s) == session_id), None)
    if target is None:
        raise ApiError(404, "Practice session not found")
    return log, entry, target


def svc_practice_session_update(track: str, session_id: str, rating, notes) -> dict:
    if rating is not None and rating not in PRACTICE_RATINGS:
        raise ApiError(400, f"rating must be one of: {', '.join(PRACTICE_RATINGS)}")
    if notes is not None and len(notes) > 60:
        raise ApiError(400, "notes must be 60 characters or fewer")
    # target is the actual dict object living inside log[digest]["sessions"]
    # (a list lookup, not a copy) — mutating it in place already updates
    # log, so writing log back out below is all persistence needs.
    log, _entry, target = _find_session_entry(track, session_id)
    if rating is not None:
        target["rating"] = rating
    if notes is not None:
        target["notes"] = notes
    PRACTICE_LOG_FILE.write_text(json.dumps(log, indent=2))
    return {"ok": True, "id": session_id, "rating": target.get("rating"), "notes": target.get("notes", "")}


def svc_practice_session_delete(track: str, session_id: str) -> dict:
    log, entry, target = _find_session_entry(track, session_id)
    entry["sessions"] = [s for s in entry["sessions"] if _session_id(s) != session_id]
    # Deleting a session (e.g. a bogus/accidental one) drops its seconds
    # from the cumulative total too — same "honest numbers" spirit as the
    # rest of the practice log, not a running total that outlives the
    # entries it's supposed to add up from.
    entry["seconds"] = max(0.0, entry.get("seconds", 0.0) - target.get("seconds", 0.0))
    PRACTICE_LOG_FILE.write_text(json.dumps(log, indent=2))
    return {"ok": True, "seconds": entry["seconds"]}


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "GuitarStudio/2.0"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    # -- helpers --------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Same reasoning as _send_file's no-store: this app is actively
        # developed against a running server, and a stale cached API
        # response (e.g. /api/nam_models missing a field a newer client
        # expects) has already caused real confusion once.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _read_json_body(self) -> dict:
        body = self._read_body()
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON body")

    def _query(self):
        parsed = urlparse(self.path)
        return parsed.path, {k: v[0] for k, v in parse_qs(parsed.query).items()}

    _RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")
    _SEND_FILE_CHUNK = 256 * 1024

    def _send_file(self, file_path: Path, cacheable: bool = False) -> None:
        """V3-E4: streams in fixed-size chunks (was read_bytes() — the whole
        file, hundreds of MB for a stem, loaded into memory per request) and
        honors Range (stems and exported takes are the multi-hundred-MB
        files that actually benefit — a <video> take couldn't seek without
        it, and re-selecting a track re-downloaded every stem in full every
        time).

        cacheable=True is for artifacts that never change underneath an
        existing path once written — stems (keyed by content hash) and
        .nam/.ir library files — safe to let the browser cache hard instead
        of re-fetching hundreds of MB on every track/model reselect. Default
        False covers both app source via _serve_static (the browser reloads
        it live during development — see the no-store reasoning that used
        to live here and still applies) and /api/output (exported mixes sit
        at a fixed, re-exportable filename, so caching those hard would
        serve a stale mix after a re-export).
        """
        file_size = file_path.stat().st_size
        content_type, _ = mimetypes.guess_type(str(file_path))
        start, end, status = 0, file_size - 1, 200

        range_header = self.headers.get("Range")
        if range_header and file_size > 0:
            m = self._RANGE_RE.match(range_header)
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else file_size - 1
                else:
                    # Suffix range ("bytes=-500" == last 500 bytes).
                    start = max(0, file_size - int(m.group(2)))
                if start >= file_size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.end_headers()
                    return
                end = min(end, file_size - 1)
                status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        if cacheable:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # This app is actively developed against a running server — a
            # cached stale copy of a .js file (especially an AudioWorklet
            # module, which only re-registers on a full page reload) has
            # already caused real confusion once. Not worth any browser
            # cache ambiguity for a single-user local app.
            self.send_header("Cache-Control", "no-store")
        self.end_headers()

        try:
            with file_path.open("rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(self._SEND_FILE_CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # Range makes this routine now — a <video> seek or a track
            # reselect that supersedes an in-flight stem fetch both abort
            # the underlying connection mid-stream. Headers are already
            # sent at this point, so there's nothing left to report back;
            # just stop, don't let it read as a server error.
            pass

    def _serve_static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        file_path = (STATIC_DIR / rel).resolve()
        try:
            file_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self._send_json(400, {"error": "Invalid static path"})
            return
        if not file_path.exists() or not file_path.is_file():
            file_path = STATIC_DIR / "index.html"
            if not file_path.exists():
                self._send_json(404, {"error": "Not found"})
                return
        self._send_file(file_path)

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        path, query = self._query()
        try:
            if path == "/api/models":
                return self._send_json(200, svc_models())
            if path == "/api/tracks":
                return self._send_json(200, svc_tracks())
            if path == "/api/list_stems":
                result = svc_list_stems(query.get("source_path", ""),
                                        query.get("model", engine.DEFAULT_MODEL))
                return self._send_json(200, result)
            if path == "/api/separate_status":
                result = svc_separate_status(query.get("source_path", ""),
                                              query.get("model", engine.DEFAULT_MODEL))
                return self._send_json(200, result)
            if path == "/api/project":
                result = svc_load_project(query.get("track", ""))
                return self._send_json(200, result)
            if path == "/api/trackinfo":
                result = svc_load_track_info(query.get("track", ""))
                return self._send_json(200, result)
            if path == "/api/stem":
                stem_path = resolve_stem_file(query.get("source_path", ""),
                                               query.get("model", engine.DEFAULT_MODEL),
                                               query.get("stem", ""))
                return self._send_file(stem_path, cacheable=True)
            if path == "/api/output":
                # Not cacheable=True: unlike stems/.nam/.ir (genuinely
                # content-addressed or static library files), this path also
                # serves exported mixes at a fixed, re-exportable filename
                # (resolve_output_path defaults to "backing_track.<fmt>" per
                # track) — a re-export would otherwise serve the browser's
                # stale cached copy of the old one. Video takes served
                # through this same route (unique "take NN" filenames, never
                # overwritten) would benefit from hard caching too, but
                # there's no cheap way to tell the two apart by path alone
                # here, so this stays no-store; Range (always sent, see
                # _send_file) is what actually fixes take-seeking regardless.
                out_path = resolve_output_file(query.get("path", ""))
                return self._send_file(out_path)
            if path == "/api/nam_models":
                return self._send_json(200, svc_nam_models())
            if path == "/api/nam_model_file":
                return self._send_file(resolve_nam_file(query.get("filename", "")), cacheable=True)
            if path == "/api/ir_models":
                return self._send_json(200, svc_ir_models())
            if path == "/api/ir_model_file":
                return self._send_file(resolve_ir_file(query.get("filename", "")), cacheable=True)
            if path == "/api/recordings":
                return self._send_json(200, svc_recordings_list(query.get("track", "")))
            if path == "/api/exported_tracks":
                return self._send_json(200, svc_exported_tracks(query.get("track", "")))
            if path == "/api/practice_sessions":
                return self._send_json(200, svc_practice_sessions(query.get("track", "")))
            if path == "/api/rig_presets":
                return self._send_json(200, svc_load_rig_presets())
            if path == "/api/playlists":
                return self._send_json(200, svc_load_playlists())
            if path == "/api/settings":
                return self._send_json(200, svc_load_settings())
            if path.startswith("/api/"):
                return self._send_json(404, {"error": f"Unknown route: {path}"})
            return self._serve_static(path)
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"error": "Internal server error"})

    def do_POST(self):
        path, _ = self._query()
        try:
            if path == "/api/import":
                _, query = self._query()
                filename = query.get("filename", "")
                result = svc_import(filename, self._read_body())
                return self._send_json(200, result)

            if path == "/api/import_stem_zip":
                _, query = self._query()
                filename = query.get("filename", "")
                result = svc_import_stem_zip(self._read_body(), filename)
                return self._send_json(200, result)

            if path == "/api/rip/save":
                _, query = self._query()
                result = svc_rip_save(query.get("filename", ""), query.get("src_ext", "webm"), self._read_body())
                return self._send_json(200, result)

            if path == "/api/separate":
                body = self._read_json_body()
                result = svc_separate(body.get("source_path", ""),
                                       body.get("model", engine.DEFAULT_MODEL),
                                       bool(body.get("force", False)))
                return self._send_json(200, result)

            if path == "/api/stem/rename":
                body = self._read_json_body()
                result = svc_stem_rename(body.get("source_path", ""),
                                          body.get("model", engine.DEFAULT_MODEL),
                                          body.get("stem", ""),
                                          body.get("new_label", ""))
                return self._send_json(200, result)

            if path == "/api/custom_stem":
                _, query = self._query()
                result = svc_add_custom_stem(query.get("source_path", ""),
                                              query.get("filename", ""),
                                              self._read_body())
                return self._send_json(200, result)

            if path == "/api/custom_stem/remove":
                body = self._read_json_body()
                result = svc_remove_custom_stem(body.get("source_path", ""), body.get("stem", ""))
                return self._send_json(200, result)

            if path == "/api/split_guitar":
                body = self._read_json_body()
                result = svc_split_guitar(body.get("source_path", ""),
                                           body.get("model", "htdemucs_6s"),
                                           body.get("stem", "guitar"),
                                           body.get("method", engine.DEFAULT_SPLIT_METHOD))
                return self._send_json(200, result)

            if path == "/api/mix":
                body = self._read_json_body()
                mute_ranges = {
                    stem: [tuple(span) for span in spans]
                    for stem, spans in body.get("mute_ranges", {}).items()
                }
                result = svc_mix(body.get("source_path", ""),
                                  body.get("model", engine.DEFAULT_MODEL),
                                  body.get("gains", {}),
                                  mute_ranges,
                                  float(body.get("target_lufs", engine.DEFAULT_TARGET_LUFS)),
                                  body.get("output_name", ""),
                                  body.get("format", "wav"),
                                  bool(body.get("normalize", True)),
                                  float(body.get("max_boost_db", engine.DEFAULT_MAX_BOOST_DB)),
                                  body.get("offsets", {}))
                return self._send_json(200, result)

            if path == "/api/recording/save":
                _, query = self._query()
                result = svc_recording_save(query.get("track", ""), query.get("ext", "webm"),
                                             self._read_body(), query.get("prefix", "take"))
                return self._send_json(200, result)

            if path == "/api/recording/finalize":
                body = self._read_json_body()
                result = svc_recording_finalize(body.get("path", ""), float(body.get("av_offset_ms", 0) or 0))
                return self._send_json(200, result)

            if path == "/api/recording/discard":
                body = self._read_json_body()
                result = svc_recording_discard(body.get("path", ""))
                return self._send_json(200, result)

            if path == "/api/recording/star":
                body = self._read_json_body()
                result = svc_recording_star(body.get("path", ""), bool(body.get("starred", True)))
                return self._send_json(200, result)

            if path == "/api/recording/rename":
                body = self._read_json_body()
                result = svc_recording_rename(body.get("path", ""), body.get("new_name", ""))
                return self._send_json(200, result)

            if path == "/api/rate/score":
                body = self._read_json_body()
                result = svc_rate_score(
                    body.get("source_path", ""), body.get("take_path", ""),
                    body.get("model", engine.DEFAULT_MODEL), body.get("stem", "guitar"),
                    float(body.get("offset", 0) or 0), float(body.get("offset_search", 0) or 0),
                )
                return self._send_json(200, result)

            if path == "/api/recording/trim":
                body = self._read_json_body()
                result = svc_recording_trim(body.get("path", ""),
                                             float(body.get("start_sec", 0)),
                                             float(body.get("end_sec", 0)))
                return self._send_json(200, result)

            if path == "/api/reveal":
                body = self._read_json_body()
                result = svc_reveal(body.get("path", ""))
                return self._send_json(200, result)

            if path == "/api/project":
                body = self._read_json_body()
                track = body.get("track", "")
                result = svc_save_project(track, body.get("project", {}))
                return self._send_json(200, result)

            if path == "/api/rig_presets":
                body = self._read_json_body()
                result = svc_save_rig_presets(body.get("presets", {}))
                return self._send_json(200, result)

            if path == "/api/playlists":
                body = self._read_json_body()
                result = svc_save_playlists(body.get("playlists", {}))
                return self._send_json(200, result)

            if path == "/api/settings/provider_key":
                body = self._read_json_body()
                result = svc_save_provider_key(body.get("provider", ""), body.get("api_key", ""))
                return self._send_json(200, result)

            if path == "/api/lick/suggest":
                body = self._read_json_body()
                result = svc_lick_suggest(
                    body.get("source_path", ""), body.get("model", engine.DEFAULT_MODEL), body.get("genre", ""),
                    body.get("provider", "anthropic"),
                )
                return self._send_json(200, result)

            if path == "/api/practicetips/suggest":
                body = self._read_json_body()
                result = svc_practice_tips(
                    body.get("source_path", ""), body.get("take_path", ""),
                    body.get("model", engine.DEFAULT_MODEL), body.get("stem", "guitar"),
                    float(body.get("offset", 0) or 0), float(body.get("offset_search", 0) or 0),
                    body.get("provider", "anthropic"),
                )
                return self._send_json(200, result)

            if path == "/api/ask/ai":
                body = self._read_json_body()
                result = svc_ask_ai(
                    body.get("source_path", ""), body.get("model", engine.DEFAULT_MODEL),
                    body.get("question", ""), body.get("provider", "anthropic"),
                )
                return self._send_json(200, result)

            if path == "/api/trackinfo":
                body = self._read_json_body()
                result = svc_save_track_info(body.get("track", ""), body.get("artist", ""), body.get("title", ""))
                return self._send_json(200, result)

            if path == "/api/thistrack/info":
                body = self._read_json_body()
                result = svc_this_track(
                    body.get("source_path", ""), body.get("model", engine.DEFAULT_MODEL),
                    body.get("provider", "anthropic"),
                )
                return self._send_json(200, result)

            if path == "/api/thisartist/info":
                body = self._read_json_body()
                result = svc_this_artist(
                    body.get("source_path", ""), body.get("model", engine.DEFAULT_MODEL),
                    body.get("provider", "anthropic"),
                )
                return self._send_json(200, result)

            if path == "/api/practice_log":
                body = self._read_json_body()
                result = svc_practice_log_add(body.get("track", ""), float(body.get("seconds", 0)),
                                               bool(body.get("continuous", False)))
                return self._send_json(200, result)

            if path == "/api/practice_session/update":
                body = self._read_json_body()
                result = svc_practice_session_update(body.get("track", ""), body.get("id", ""),
                                                      body.get("rating"), body.get("notes"))
                return self._send_json(200, result)

            if path == "/api/practice_session/delete":
                body = self._read_json_body()
                result = svc_practice_session_delete(body.get("track", ""), body.get("id", ""))
                return self._send_json(200, result)

            if path == "/api/track/rename":
                body = self._read_json_body()
                result = svc_track_rename(body.get("track", ""), body.get("new_name", ""))
                return self._send_json(200, result)

            if path == "/api/track/delete":
                body = self._read_json_body()
                result = svc_track_delete(body.get("track", ""))
                return self._send_json(200, result)

            return self._send_json(404, {"error": f"Unknown route: {path}"})
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except SystemExit as exc:
            # backing_track's lower-level helpers still call sys.exit() on a
            # handful of hard failures (e.g. Demucs subprocess failure) —
            # this is the one place that must catch it, so it never
            # propagates past the request and kills the whole server.
            self._send_json(500, {"error": str(exc.code) if exc.code else "Engine error"})
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"error": "Internal server error"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Guitar Studio local server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Guitar Studio server running at http://127.0.0.1:{args.port}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
