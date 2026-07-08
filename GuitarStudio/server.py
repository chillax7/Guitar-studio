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
import json
import mimetypes
import re
import subprocess
import sys
import traceback
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

SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9 ._\-\[\]()]+")
DEFAULT_PORT = 8765


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
    """Sanitize a user-supplied filename: drop any directory component and
    replace anything that isn't a simple filename character, so upload
    filenames and query params can never be used to escape input/ or
    output/ (e.g. via '../../etc/passwd' or an absolute path)."""
    name = Path(name).name
    name = SAFE_NAME_RE.sub("_", name).strip()
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

def stem_info(out_dir: Path, model: str) -> list:
    known_stems = set(engine.ALL_KNOWN_MODELS.get(model, ()))
    stems = []
    for wav_path in sorted(out_dir.glob("*.wav")):
        info = engine.sf.info(str(wav_path))
        stems.append({
            "name": wav_path.stem,
            "duration": info.duration,
            "sample_rate": info.samplerate,
            "is_derived": wav_path.stem not in known_stems,
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
    """Every importable track under input/, for the Library sidebar."""
    tracks = []
    for path in sorted(INPUT_DIR.iterdir()):
        if path.is_file() and not path.name.startswith("."):
            tracks.append({"name": path.name, "size": path.stat().st_size})
    return {"tracks": tracks}


def svc_nam_models() -> dict:
    """Every .nam capture under models/nam/, for the Play Along amp picker.
    A plain directory listing (GP-05's pattern) so dropping a new capture in
    shows up after a refresh — no separate registration step."""
    models = []
    for path in sorted(NAM_DIR.glob("*.nam")):
        models.append({"name": path.stem, "filename": path.name, "size": path.stat().st_size})
    return {"models": models}


def svc_ir_models() -> dict:
    """Every cab IR under models/ir/, same pattern as svc_nam_models."""
    irs = []
    for path in sorted(IR_DIR.glob("*.wav")):
        irs.append({"name": path.stem, "filename": path.name, "size": path.stat().st_size})
    return {"irs": irs}


def resolve_nam_file(filename: str) -> Path:
    path = NAM_DIR / safe_name(filename)
    if not path.exists():
        raise ApiError(404, f"No NAM model named '{filename}'")
    return path


def resolve_ir_file(filename: str) -> Path:
    path = IR_DIR / safe_name(filename)
    if not path.exists():
        raise ApiError(404, f"No IR named '{filename}'")
    return path


def svc_import(filename: str, data: bytes) -> dict:
    if not data:
        raise ApiError(400, "Empty upload")
    name = safe_name(filename)
    dest = INPUT_DIR / name
    dest.write_bytes(data)
    return {"name": name, "path": str(dest), "size": len(data)}


def svc_separate(source_path: str, model: str, force: bool) -> dict:
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)

    reused = engine.has_cached_stems(out_dir) and not force
    if not reused:
        if model in engine.AUDIO_SEPARATOR_MODELS:
            engine.run_audio_separator_backend(input_path, model, out_dir)
        else:
            engine.run_demucs_backend(input_path, model, out_dir)
        engine.write_fingerprint(out_dir, input_path)

    engine.export_stem_files(list(out_dir.glob("*.wav")), input_path.stem, model)

    return {
        "cache_dir": str(out_dir),
        "output_dir": str(engine.track_output_dir(input_path.stem)),
        "stems": stem_info(out_dir, model),
        "analysis": engine.ensure_analysis(out_dir),
        "stale": engine.fingerprint_is_stale(out_dir, input_path) if reused else False,
        "reused_cache": reused,
    }


def svc_list_stems(source_path: str, model: str) -> dict:
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'. "
                             f"Run separate first.")
    return {
        "stems": stem_info(out_dir, model),
        "stale": engine.fingerprint_is_stale(out_dir, input_path),
        "analysis": engine.ensure_analysis(out_dir),
    }


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

    if method not in ("spectral", "midside"):
        raise ApiError(400, f"Unknown split method '{method}' — use 'spectral' or 'midside'")
    if method == "spectral":
        center_mono, sides_mono = engine.spectral_pan_split(left, right, sr)
    else:
        center_mono, sides_mono = engine.midside_pan_split(left, right)
    center = engine.np.stack([center_mono, center_mono], axis=1)
    sides = engine.np.stack([sides_mono, -sides_mono], axis=1)

    center_path = out_dir / f"{stem}_center.wav"
    sides_path = out_dir / f"{stem}_sides.wav"
    engine.sf.write(str(center_path), center, sr)
    engine.sf.write(str(sides_path), sides, sr)
    engine.export_stem_files([center_path, sides_path], input_path.stem, model)

    updated = stem_info(out_dir, model)
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

    valid_stems = engine.existing_stems(out_dir)
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
    out_path = engine.resolve_output_path(output_name, input_path.stem)
    engine.write_audio(mix, samplerate, out_path)

    return {"output_path": str(out_path), **norm_info}


def resolve_stem_file(source_path: str, model: str, stem: str) -> Path:
    """For streaming stem audio to the browser's Web Audio graph — the
    playback path M2 needs that M1's route set didn't cover yet."""
    input_path = resolve_source_path(source_path)
    out_dir = engine.track_stem_dir(input_path, model)
    if not engine.has_cached_stems(out_dir):
        raise ApiError(404, f"No stems found for {input_path.name} with model '{model}'.")
    stem_path = out_dir / f"{safe_name(stem)}.wav"
    if not stem_path.exists():
        raise ApiError(404, f"No '{stem}' stem found in this track/model.")
    return stem_path


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


def svc_recording_save(track: str, ext: str, data: bytes) -> dict:
    if ext not in ("mp4", "webm"):
        raise ApiError(400, f"Unsupported extension '{ext}' — use mp4 or webm")
    if not data:
        raise ApiError(400, "Empty upload")
    track_name = safe_name(track) if track else "_untracked"
    rec_dir = recordings_dir_for(track)
    rec_dir.mkdir(parents=True, exist_ok=True)
    take = next_take_number(rec_dir)
    filename = f"{track_name} - take {take:02d}.{ext}"
    path = rec_dir / filename
    path.write_bytes(data)
    return {"path": str(path), "filename": filename, "take": take}


def svc_recordings_list(track: str) -> dict:
    rec_dir = recordings_dir_for(track)
    takes = []
    if rec_dir.exists():
        for f in sorted(rec_dir.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                takes.append({"filename": f.name, "path": str(f), "size": f.stat().st_size})
    return {"takes": takes}


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
    if abs(offset_sec) > 1e-6:
        cmd += ["-itsoffset", f"{offset_sec:.3f}", "-i", str(target), "-map", "0:v", "-map", "1:a"]
    cmd += ["-c", "copy"]
    if ext == ".mp4":
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


def svc_load_project(track: str) -> dict:
    path = PROJECTS_DIR / f"{safe_name(track)}.json"
    if not path.exists():
        raise ApiError(404, f"No saved project for '{track}'")
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise ApiError(500, f"Could not read project file: {exc}")


def svc_save_project(track: str, project: dict) -> dict:
    path = PROJECTS_DIR / f"{safe_name(track)}.json"
    path.write_text(json.dumps(project, indent=2))
    return {"ok": True, "path": str(path)}


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "GuitarStudio/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    # -- helpers --------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
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

    def _send_file(self, file_path: Path) -> None:
        content_type, _ = mimetypes.guess_type(str(file_path))
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
            if path == "/api/project":
                result = svc_load_project(query.get("track", ""))
                return self._send_json(200, result)
            if path == "/api/stem":
                stem_path = resolve_stem_file(query.get("source_path", ""),
                                               query.get("model", engine.DEFAULT_MODEL),
                                               query.get("stem", ""))
                return self._send_file(stem_path)
            if path == "/api/output":
                out_path = resolve_output_file(query.get("path", ""))
                return self._send_file(out_path)
            if path == "/api/nam_models":
                return self._send_json(200, svc_nam_models())
            if path == "/api/nam_model_file":
                return self._send_file(resolve_nam_file(query.get("filename", "")))
            if path == "/api/ir_models":
                return self._send_json(200, svc_ir_models())
            if path == "/api/ir_model_file":
                return self._send_file(resolve_ir_file(query.get("filename", "")))
            if path == "/api/recordings":
                return self._send_json(200, svc_recordings_list(query.get("track", "")))
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

            if path == "/api/separate":
                body = self._read_json_body()
                result = svc_separate(body.get("source_path", ""),
                                       body.get("model", engine.DEFAULT_MODEL),
                                       bool(body.get("force", False)))
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
                result = svc_recording_save(query.get("track", ""), query.get("ext", "webm"), self._read_body())
                return self._send_json(200, result)

            if path == "/api/recording/finalize":
                body = self._read_json_body()
                result = svc_recording_finalize(body.get("path", ""), float(body.get("av_offset_ms", 0) or 0))
                return self._send_json(200, result)

            if path == "/api/recording/discard":
                body = self._read_json_body()
                result = svc_recording_discard(body.get("path", ""))
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
