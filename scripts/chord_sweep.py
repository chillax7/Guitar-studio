#!/usr/bin/env python3
"""Parameter sweep for the chord lane, on top of a cached chroma front end.

The expensive part of detect_chords is the front end (HPSS, tuning, CQT
chroma over a whole song — minutes). Everything the "too detailed" complaint
is actually about lives downstream of that: the gates, the Viterbi
transition prior, the emission temperature, the minimum run length.

So: cache the beat-windowed chroma once (`--cache`), then re-run only the
scoring + decode for as many parameter combinations as you like in seconds.
The scoring/decode code called here is backing_track's own — the constants
are monkeypatched, nothing is reimplemented, so a winning combination can be
pasted straight into backing_track.py.
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import backing_track as bt  # noqa: E402
from chord_bench import fabricate_stems, runs_from_chords, summarize, score_sections  # noqa: E402


def build_cache(stem_dir: Path, cache_path: Path) -> dict:
    """Reproduce detect_chords' front end and save what the decode needs.

    Mirrors detect_chords step for step (same _find_stems_fuzzy calls, same
    non-bass identity mix, same _compute_chord_chroma, same windowing) so a
    sweep result means something about the real pipeline. If detect_chords'
    front end changes, this must change with it."""
    import librosa
    import librosa.feature.rhythm

    # The beat grid, computed exactly the way analyze_track does (same drums
    # stem, same onset envelope, same start_bpm=140 prior) — but WITHOUT
    # calling analyze_track, which would also run detect_chords and
    # detect_sections and roughly triple the cost of building a cache whose
    # entire purpose is to make the expensive part happen once.
    drums = bt._find_stems_fuzzy(stem_dir, exact_names=("drums",),
                                 hint_words=("drum", "kit", "percussion"))
    if not drums:
        raise SystemExit("no drums stem to beat-track")
    dy, dsr = librosa.load(str(drums[0]), sr=None, mono=True)
    onset_env = librosa.onset.onset_strength(y=dy, sr=dsr)
    bpm = float(np.asarray(librosa.feature.rhythm.tempo(
        onset_envelope=onset_env, sr=dsr, start_bpm=140)).reshape(-1)[0])
    _, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=dsr, start_bpm=140)
    beats = [round(float(t), 3) for t in librosa.frames_to_time(beat_frames, sr=dsr)]
    if len(beats) < 2:
        raise SystemExit("no beat grid")

    stem_paths = bt._find_stems_fuzzy(
        stem_dir, exact_names=("bass", "other", "guitar", "piano"),
        hint_words=("guitar", "bass", "piano", "keys", "synth", "organ", "string"),
        exclude_words=("vocal", "vox", "voice", "drum", "kit", "perc"))
    bass_paths = bt._find_stems_fuzzy(
        stem_dir, exact_names=("bass",), hint_words=("bass",),
        exclude_words=("vocal", "vox", "voice", "drum", "kit", "perc"))
    bass_path_set = {str(p) for p in bass_paths}

    harmonic_sources = []
    sr = None
    for p in stem_paths:
        y, sr = librosa.load(str(p), sr=None, mono=True)
        if str(p) not in bass_path_set:
            harmonic_sources.append(y)
    if not harmonic_sources:
        raise SystemExit("no non-bass pitched stem")

    hlen = max(len(y) for y in harmonic_sources)
    id_mono = np.zeros(hlen, dtype=np.float32)
    for y in harmonic_sources:
        id_mono[:len(y)] += y

    chroma, chroma_raw, frame_times = bt._compute_chord_chroma(id_mono, sr)
    main = np.array(bt._beat_windowed_chroma(chroma, frame_times, beats))
    gate_raw = np.array(bt._beat_windowed_chroma(chroma_raw, frame_times, beats))

    bass_win = None
    if bass_paths:
        by, bsr = librosa.load(str(bass_paths[0]), sr=None, mono=True)
        bchroma, _, btimes = bt._compute_chord_chroma(by, bsr)
        bass_win = np.array(bt._beat_windowed_chroma(bchroma, btimes, beats))

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(cache_path, beats=np.array(beats), main=main, gate_raw=gate_raw,
             bass=bass_win if bass_win is not None else np.zeros((0, 12)),
             chroma_mean=chroma.mean(axis=1),
             bpm=np.array([bpm or 0.0]))
    return load_cache(cache_path)


def load_cache(cache_path: Path) -> dict:
    z = np.load(cache_path)
    bass = z["bass"]
    return {"beats": [float(t) for t in z["beats"]], "main": z["main"],
            "gate_raw": z["gate_raw"], "bass": bass if len(bass) else None,
            "chroma_mean": z["chroma_mean"], "bpm": float(z["bpm"][0])}


def run_variant(cache: dict, params: dict) -> list:
    """Score + decode with `params` patched over backing_track's constants."""
    saved = {k: getattr(bt, k) for k in params}
    for k, v in params.items():
        setattr(bt, k, v)
    try:
        beats = cache["beats"]
        n = len(beats) - 1
        # Mirrors detect_chords' decode stage exactly (CD-8): ungated
        # template scores -> per-root evidence -> root Viterbi -> short-run
        # merge -> one quality decision per root run.
        template_scores = np.zeros((n, len(bt.CHORD_TEMPLATE_LABELS)))
        for i in range(n):
            w = cache["main"][i]
            norm = np.linalg.norm(w)
            scores = bt.CHORD_TEMPLATE_MATRIX @ (w / norm if norm > 0 else w)
            if cache["bass"] is not None:
                bt._apply_bass_root_bonus(scores, cache["bass"][i])
            template_scores[i] = scores

        root_scores = np.zeros((n, 13))
        for pc in range(12):
            root_scores[:, pc] = template_scores[:, bt.CHORD_TEMPLATE_ROOT_PC == pc].max(axis=1)
        root_scores[:, 12] = bt.CHORD_CONFIDENCE_FLOOR

        states = bt._decode_root_sequence(root_scores)
        states = bt._merge_short_root_runs(states, root_scores)
        labels = bt._name_root_runs(states, list(cache["main"]), list(cache["gate_raw"]))
        return [{"time": round(float(beats[i]), 3), "root": labels[i][0],
                 "quality": labels[i][1],
                 "confidence": round(float(
                     root_scores[i, 12] if labels[i][0] is None
                     else template_scores[i, bt.CHORD_TEMPLATE_INDEX[labels[i]]]), 3)}
                for i in range(n)]
    finally:
        for k, v in saved.items():
            setattr(bt, k, v)


SWEEPABLE = ("CHORD_ROOT_SELF_TRANSITION_P", "CHORD_MIN_QUALITY_RUN_BEATS",
             "CHORD_EMISSION_TEMPERATURE", "CHORD_MIN_RUN_BEATS",
             "CHORD_POWER_THIRD_ABSENCE_RATIO", "CHORD_SEVENTH_ABSENCE_RATIO",
             "CHORD_BASS_ROOT_BONUS",
             "CHORD_CONFIDENCE_FLOOR")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--stems", type=Path)
    ap.add_argument("--mix", type=Path)
    ap.add_argument("--work", type=Path, default=Path("/tmp/chord_bench"))
    ap.add_argument("--truth", type=Path, required=True)
    ap.add_argument("--grid", action="append", default=[],
                    metavar="NAME=v1,v2,…", help=f"one of {', '.join(SWEEPABLE)}")
    ap.add_argument("--ribbon-for", help="print the full ribbon for this variant label")
    args = ap.parse_args()

    truth = json.loads(args.truth.read_text())

    if args.cache.exists():
        cache = load_cache(args.cache)
        print(f"loaded cache {args.cache} ({len(cache['beats'])} beats, {cache['bpm']:.1f} bpm)")
    else:
        stem_dir = args.stems
        if stem_dir is None:
            if not args.mix:
                raise SystemExit("--cache does not exist; give --stems or --mix to build it")
            stem_dir = args.work / args.mix.stem
            fabricate_stems(args.mix, stem_dir)
        print("building cache (slow, once) …", flush=True)
        cache = build_cache(stem_dir, args.cache)

    grids = {}
    for spec in args.grid:
        name, _, vals = spec.partition("=")
        if name not in SWEEPABLE:
            raise SystemExit(f"{name} is not sweepable; pick from {SWEEPABLE}")
        cur = getattr(bt, name)
        grids[name] = [type(cur)(float(v)) if isinstance(cur, int) else float(v)
                       for v in vals.split(",")]
    if not grids:
        grids = {"CHORD_ROOT_SELF_TRANSITION_P": [bt.CHORD_ROOT_SELF_TRANSITION_P]}

    names = list(grids)
    header = "  ".join(f"{n.replace('CHORD_','')[:13]:>13s}" for n in names)
    print(f"\n{header} | {'chips':>6s} {'chg/min':>8s} {'runbts':>7s} {'distinct':>9s} "
          f"{'N%':>5s} | {'spurious':<22s} {'missed'}")
    print("-" * (len(header) + 90))

    results = []
    for combo in itertools.product(*(grids[n] for n in names)):
        params = dict(zip(names, combo))
        chords = run_variant(cache, params)
        s = summarize(chords, truth)
        label = ",".join(f"{n}={v}" for n, v in params.items())
        results.append((label, params, s, chords))
        vals = "  ".join(f"{v:>13}" for v in combo)
        print(f"{vals} | {s['runs']:>6d} {s['changes_per_min']:>8.1f} {s['mean_run_beats']:>7.2f} "
              f"{s['distinct_chords']:>9d} {s['n_beat_fraction']*100:>4.0f}% | "
              f"{' '.join(s['spurious'])[:22]:<22s} {' '.join(s['missed'])}")

    if args.ribbon_for:
        for label, _, _, chords in results:
            if label == args.ribbon_for:
                print(f"\n--- ribbon for {label} ---")
                for name, start, end, nb in runs_from_chords(chords):
                    print(f"  {start:7.2f}  {end-start:6.2f}s  {nb:4d}b  {name}")
                break
        else:
            print(f"\nno variant labelled {args.ribbon_for!r}; labels are:")
            for label, *_ in results:
                print("  " + label)


if __name__ == "__main__":
    main()
