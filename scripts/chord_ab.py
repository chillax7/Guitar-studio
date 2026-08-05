#!/usr/bin/env python3
"""A/B two versions of the chord decode on identical cached chroma.

Answers the generalization question a single annotated song cannot: does a
decode change help, or merely help on the one song it was tuned against —
**without needing a chord chart for every song**.

Two of the metrics here need no ground truth at all:

  quality-only flips   the share of chord changes where the ROOT did not
                       change and only the label did (A5 -> A -> Am). On a
                       chord ribbon these are almost always wrong whatever
                       the song is: real music changes chord by changing
                       chord, not by changing the name of the chord it is
                       already on. A high number is a defect signal on its
                       own.

  chips / mean run     how much the ribbon is drawing. Not a quality
                       measure by itself — over-merging would improve it —
                       so it is only ever read next to the flip rate and,
                       where a chart exists, the accuracy numbers.

Both versions run over the SAME cached front end (chord_sweep.build_cache),
so nothing but the decode differs. Check first that the two versions really
do share a front end; if _compute_chord_chroma or the beat grid changed
between them, this comparison is meaningless.
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import backing_track as bt  # noqa: E402
from chord_sweep import build_cache, load_cache  # noqa: E402
from chord_bench import fabricate_stems  # noqa: E402


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def decode_new(mod, cache: dict) -> list:
    """CD-8 decode: ungated scores -> root Viterbi -> one name per root run."""
    n = len(cache["beats"]) - 1
    tmpl = np.zeros((n, len(mod.CHORD_TEMPLATE_LABELS)))
    for i in range(n):
        w = cache["main"][i]
        norm = np.linalg.norm(w)
        s = mod.CHORD_TEMPLATE_MATRIX @ (w / norm if norm > 0 else w)
        if cache["bass"] is not None:
            mod._apply_bass_root_bonus(s, cache["bass"][i])
        tmpl[i] = s
    root_scores = np.zeros((n, 13))
    for pc in range(12):
        root_scores[:, pc] = tmpl[:, mod.CHORD_TEMPLATE_ROOT_PC == pc].max(axis=1)
    root_scores[:, 12] = mod.CHORD_CONFIDENCE_FLOOR
    states = mod._decode_root_sequence(root_scores)
    states = mod._merge_short_root_runs(states, root_scores)
    return mod._name_root_runs(states, list(cache["main"]), list(cache["gate_raw"]))


def decode_old(mod, cache: dict) -> list:
    """Pre-CD-8 decode: gated scores -> one 49-state Viterbi -> short-run merge."""
    n = len(cache["beats"]) - 1
    raw = np.zeros((n, len(mod.CHORD_TEMPLATE_LABELS)))
    for i in range(n):
        w = cache["main"][i]
        norm = np.linalg.norm(w)
        s = mod.CHORD_TEMPLATE_MATRIX @ (w / norm if norm > 0 else w)
        mod._gate_power_chord_scores(s, cache["gate_raw"][i])
        mod._gate_seventh_chord_scores(s, cache["gate_raw"][i])
        if cache["bass"] is not None:
            mod._apply_bass_root_bonus(s, cache["bass"][i])
        raw[i] = s
    labels = mod._decode_chord_sequence(raw)
    return mod._merge_short_chord_runs(labels, raw)


def measure(labels: list, beats: list) -> dict:
    runs = []
    for i, lab in enumerate(labels):
        if runs and runs[-1][0] == lab:
            runs[-1][2] = i + 1
        else:
            runs.append([lab, i, i + 1])
    changes = len(runs) - 1
    quality_only = sum(1 for a, b in zip(runs, runs[1:])
                       if a[0][0] is not None and a[0][0] == b[0][0])
    names = {lab for lab, _, _ in runs if lab[0] is not None}
    roots = {lab[0] for lab, _, _ in runs if lab[0] is not None}
    span = (beats[len(labels)] - beats[0]) or 1.0
    return {
        "chips": len(runs),
        "changes": changes,
        "quality_only": quality_only,
        "quality_only_pct": round(100 * quality_only / changes, 1) if changes else 0.0,
        "mean_run_beats": round(len(labels) / max(len(runs), 1), 2),
        "chips_per_min": round(len(runs) / span * 60, 1),
        "distinct_names": len(names),
        "distinct_roots": len(roots),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old", type=Path, required=True, help="the other backing_track.py to compare against")
    ap.add_argument("--mix", type=Path, action="append", default=[], help="repeatable")
    ap.add_argument("--cache-dir", type=Path, required=True)
    ap.add_argument("--work", type=Path, default=Path("/tmp/chord_bench"))
    args = ap.parse_args()

    old = load_module(args.old, "backing_track_old")

    hdr = (f"{'song':26s} {'ver':4s} {'chips':>6s} {'chips/min':>10s} {'runbeats':>9s} "
           f"{'qual-only':>10s} {'names':>6s} {'roots':>6s}")
    print(hdr)
    print("-" * len(hdr))

    for mix in args.mix:
        name = mix.stem[:26]
        cache_path = args.cache_dir / f"{mix.stem}.npz"
        if cache_path.exists():
            cache = load_cache(cache_path)
        else:
            stem_dir = args.work / mix.stem
            fabricate_stems(mix, stem_dir)
            cache = build_cache(stem_dir, cache_path)
        for label, mod, fn in (("v14", old, decode_old), ("CD-8", bt, decode_new)):
            m = measure(fn(mod, cache), cache["beats"])
            print(f"{name if label=='v14' else '':26s} {label:4s} {m['chips']:>6d} "
                  f"{m['chips_per_min']:>10.1f} {m['mean_run_beats']:>9.2f} "
                  f"{str(m['quality_only']) + ' (' + str(m['quality_only_pct']) + '%)':>10s} "
                  f"{m['distinct_names']:>6d} {m['distinct_roots']:>6d}")
        print()


if __name__ == "__main__":
    main()
