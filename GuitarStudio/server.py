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

    return {"name": dest_path.name, "path": str(dest_path)}


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
            normalize: bool = True, max_boost_db: float = engine.DEFAULT_MAX_BOOST_DB) -> dict:
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


def svc_recording_save(track: str, ext: str, data: bytes, prefix: str = "take") -> dict:
    # GP-08: "m4a" is an audio-only take (recorder.js's REC_AUDIO_MIME_CANDIDATES)
    # — same MPEG-4 container as mp4, different extension so it reads as what
    # it is. GP-07: "wav" is a riff capture (playalong.js's own WAV encoder —
    # riffs never go through MediaRecorder at all, see riff-capture-processor.js).
    if ext not in ("mp4", "webm", "m4a", "wav"):
        raise ApiError(400, f"Unsupported extension '{ext}' — use mp4, webm, m4a, or wav")
    if prefix not in ("take", "riff"):
        raise ApiError(400, f"Unsupported prefix '{prefix}' — use take or riff")
    if not data:
        raise ApiError(400, "Empty upload")
    track_name = safe_name(track) if track else "_untracked"
    rec_dir = recordings_dir_for(track)
    rec_dir.mkdir(parents=True, exist_ok=True)
    n = next_riff_number(rec_dir) if prefix == "riff" else next_take_number(rec_dir)
    filename = f"{track_name} - {prefix} {n:02d}.{ext}"
    path = rec_dir / filename
    path.write_bytes(data)
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


def svc_recordings_list(track: str) -> dict:
    """VD-02: every take for a track, inline-playable and starrable — ends
    the round-trip to Finder/QuickTime for every review."""
    rec_dir = recordings_dir_for(track)
    takes = []
    if rec_dir.exists():
        starred = _read_starred(rec_dir)
        for f in sorted(rec_dir.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                takes.append({
                    "filename": f.name, "path": str(f), "size": f.stat().st_size,
                    "starred": f.name in starred,
                })
    return {"takes": takes}


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
    target.rename(new_path)
    if was_starred:
        starred.discard(target.name)
        starred.add(new_path.name)
        _write_starred(rec_dir, starred)

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
# flushes at during continuous play, but short enough that stepping away for
# a few minutes (or longer) starts a new row in the log rather than silently
# padding the last one.
SESSION_STITCH_GAP_SEC = 120
PRACTICE_SESSIONS_MAX = 500  # per track — oldest sessions drop off past this


def svc_practice_log_add(track: str, seconds: float) -> dict:
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
    if sessions and now - sessions[-1]["end"] <= SESSION_STITCH_GAP_SEC:
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
                                  float(body.get("max_boost_db", engine.DEFAULT_MAX_BOOST_DB)))
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

            if path == "/api/practice_log":
                body = self._read_json_body()
                result = svc_practice_log_add(body.get("track", ""), float(body.get("seconds", 0)))
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
