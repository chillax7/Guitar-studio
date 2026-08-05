#!/usr/bin/env python3
"""Chord-lane accuracy bench.

Runs the REAL chord pipeline (analyze_track -> detect_chords: the same
chroma front end, the same power/seventh gates, the same Viterbi decode)
over a song and scores the result against a hand-entered ground-truth
chord chart, so "the chord ribbon is too detailed" stops being a matter of
opinion and becomes a number.

Two ways to give it a song:

  --stems DIR    a real separated-stems directory (what the app itself
                 analyzes). This is the honest path — use it whenever the
                 stems exist.

  --mix FILE     a stereo/mono mix. The bench fabricates a stem directory
                 from it by HPSS + a crossover split (percussive ->
                 drums.wav, harmonic below the crossover -> bass.wav,
                 harmonic above -> other.wav) so the untouched pipeline can
                 run on a song whose stems aren't available. These are NOT
                 Demucs stems: bass/other bleed into each other far more
                 than real separation does, so treat absolute accuracy from
                 this path as a floor, not a verdict. The structural
                 numbers (how many chord changes, how long the runs are)
                 survive the surrogate much better than the identity ones.

Ground truth is a JSON file: see research/chord-truth/ for the format.
Because a chart gives chords per SECTION rather than per second, scoring is
done against the chart's chord *set* and *change rate*, plus — when the
truth file carries section times — a per-section majority-chord check.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import backing_track as bt  # noqa: E402


CROSSOVER_HZ = 200.0  # bass/other split for the fabricated-stem path


def _butter(y, sr, cutoff, btype):
    import scipy.signal
    sos = scipy.signal.butter(4, cutoff / (sr / 2), btype=btype, output="sos")
    return scipy.signal.sosfiltfilt(sos, y).astype(np.float32)


def fabricate_stems(mix_path: Path, out_dir: Path) -> None:
    """Fake a stem directory from a full mix so the real pipeline can run.

    Deliberately crude and deliberately documented: the point is to exercise
    detect_chords unchanged, not to compete with Demucs."""
    import librosa
    import soundfile as sf

    out_dir.mkdir(parents=True, exist_ok=True)
    if (out_dir / "other.wav").exists():
        return
    y, sr = librosa.load(str(mix_path), sr=None, mono=True)
    harmonic, percussive = librosa.effects.hpss(y)
    sf.write(out_dir / "drums.wav", percussive, sr)
    sf.write(out_dir / "bass.wav", _butter(harmonic, sr, CROSSOVER_HZ, "lowpass"), sr)
    sf.write(out_dir / "other.wav", _butter(harmonic, sr, CROSSOVER_HZ, "highpass"), sr)


def chord_name(entry: dict) -> str:
    """The label the UI would show for one beat's chord dict."""
    if not entry.get("root"):
        return "N"
    return bt._chord_display_name(entry["root"], entry["quality"])


def runs_from_chords(chords: list) -> list:
    """Collapse per-beat chords into (name, start, end, n_beats) runs — the
    same collapsing renderChordLane/aiLabChordRuns do, so the run count here
    is the chip count the user actually sees."""
    runs = []
    for i, entry in enumerate(chords):
        name = chord_name(entry)
        end = chords[i + 1]["time"] if i + 1 < len(chords) else entry["time"]
        if runs and runs[-1][0] == name:
            runs[-1][2] = end
            runs[-1][3] += 1
        else:
            runs.append([name, entry["time"], end, 1])
    return runs


def summarize(chords: list, truth: dict) -> dict:
    runs = runs_from_chords(chords)
    span = (chords[-1]["time"] - chords[0]["time"]) or 1.0
    names = [r[0] for r in runs]
    counts = Counter(chord_name(c) for c in chords)

    truth_set = set(truth["chords"])
    detected_set = {n for n in names if n != "N"}

    # Root-only comparison: a chart written in power chords (A5) and a
    # pipeline that decided the same beat was A major disagree on quality
    # but agree on the change points, which is most of what the ribbon is
    # for. Scored separately so the two failures don't hide each other.
    def root_of(name):
        return name.rstrip("5m7") if name != "N" else "N"

    truth_roots = {root_of(c) for c in truth["chords"]}
    detected_roots = {root_of(n) for n in detected_set}

    return {
        "beats": len(chords),
        "runs": len(runs),
        "changes_per_min": round(len(runs) / span * 60, 1),
        "mean_run_beats": round(len(chords) / max(len(runs), 1), 2),
        "median_run_seconds": round(float(np.median([r[2] - r[1] for r in runs])), 2),
        "distinct_chords": len(detected_set),
        "distinct_truth": len(truth_set),
        "detected": sorted(detected_set),
        "truth": sorted(truth_set),
        "spurious": sorted(detected_set - truth_set),
        "missed": sorted(truth_set - detected_set),
        "spurious_roots": sorted(detected_roots - truth_roots),
        "missed_roots": sorted(truth_roots - detected_roots),
        "n_beat_fraction": round(counts.get("N", 0) / max(len(chords), 1), 3),
        "top_chords": counts.most_common(8),
    }


def score_sections(chords: list, truth: dict) -> list:
    """Per-section majority-chord check, when the truth file has section
    times. A section whose chart chord is a single held chord (a verse on
    A5) is the sharpest test of the "too detailed" complaint: the ribbon
    should show ONE chip across it."""
    rows = []
    for sec in truth.get("sections", []):
        start, end = sec["start"], sec["end"]
        inside = [c for c in chords if start <= c["time"] < end]
        if not inside:
            continue
        counts = Counter(chord_name(c) for c in inside)
        top, top_n = counts.most_common(1)[0]
        expected = set(sec["chords"])
        rows.append({
            "name": sec["name"],
            "window": f"{start:.0f}-{end:.0f}s",
            "expected": "/".join(sec["chords"]),
            "majority": top,
            "majority_share": round(top_n / len(inside), 2),
            "runs": len(runs_from_chords(inside)),
            "in_chart_share": round(
                sum(n for c, n in counts.items() if c in expected) / len(inside), 2),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--stems", type=Path, help="real separated-stems directory")
    src.add_argument("--mix", type=Path, help="full mix; stems are fabricated (see module docstring)")
    ap.add_argument("--truth", type=Path, required=True, help="ground-truth chart JSON")
    ap.add_argument("--work", type=Path, default=Path("/tmp/chord_bench"),
                    help="scratch dir for fabricated stems")
    ap.add_argument("--json", type=Path, help="also write the full result here")
    ap.add_argument("--ribbon", action="store_true", help="print every run (the chips the user sees)")
    args = ap.parse_args()

    truth = json.loads(args.truth.read_text())

    if args.mix:
        stem_dir = args.work / args.mix.stem
        print(f"fabricating surrogate stems in {stem_dir} …", flush=True)
        fabricate_stems(args.mix, stem_dir)
    else:
        stem_dir = args.stems

    print("running the real analyze_track pipeline …", flush=True)
    analysis = bt.analyze_track(stem_dir)
    chords = analysis.get("chords")
    if not chords:
        print("NO CHORDS — analyze_track returned none. beats:", len(analysis.get("beats") or []))
        sys.exit(1)

    summary = summarize(chords, truth)
    sections = score_sections(chords, truth)

    print(f"\n=== {truth.get('title', args.truth.stem)} ===")
    print(f"chart says: key {truth.get('key','?')}, chords {' '.join(truth['chords'])}")
    print(f"pipeline says: key {analysis.get('key')}, bpm {analysis.get('bpm')}")
    print()
    for k in ("beats", "runs", "changes_per_min", "mean_run_beats", "median_run_seconds",
              "distinct_chords", "distinct_truth", "n_beat_fraction"):
        print(f"  {k:20s} {summary[k]}")
    print(f"  {'detected':20s} {' '.join(summary['detected'])}")
    print(f"  {'spurious':20s} {' '.join(summary['spurious']) or '-'}")
    print(f"  {'missed':20s} {' '.join(summary['missed']) or '-'}")
    print(f"  {'spurious roots':20s} {' '.join(summary['spurious_roots']) or '-'}")
    print(f"  {'missed roots':20s} {' '.join(summary['missed_roots']) or '-'}")
    print(f"  {'top':20s} {summary['top_chords']}")

    if sections:
        print(f"\n  {'section':14s} {'window':12s} {'chart':14s} {'majority':10s} {'share':6s} {'chips':6s} {'in-chart'}")
        for r in sections:
            print(f"  {r['name']:14s} {r['window']:12s} {r['expected']:14s} "
                  f"{r['majority']:10s} {r['majority_share']:<6} {r['runs']:<6} {r['in_chart_share']}")

    if args.ribbon:
        print("\n  --- ribbon (one line per chip) ---")
        for name, start, end, nbeats in runs_from_chords(chords):
            print(f"  {start:7.2f}  {end - start:5.2f}s  {nbeats:3d}b  {name}")

    if args.json:
        args.json.write_text(json.dumps(
            {"summary": summary, "sections": sections, "analysis_key": analysis.get("key"),
             "bpm": analysis.get("bpm"), "chords": chords}, indent=2))
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
