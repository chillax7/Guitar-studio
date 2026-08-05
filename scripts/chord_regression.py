#!/usr/bin/env python3
"""Synthetic chord-detection regression suite.

The real-song bench (chord_bench.py) says whether a change helps on the
material that motivated it. This says whether it broke everything else —
specifically the failure modes the CD-2/CD-5 gates were built to stop:
triads reading as power chords, plain majors reading as dominant 7ths, a
held chord fragmenting.

Each case renders its own stem directory (drums/bass/other) from a known
progression and runs the REAL pipeline over it, so a case failing here
means the shipped code is wrong, not that a model of it is.

Synthesis is deliberately simple but not naive: notes are struck (not held
DC), each with a decaying harmonic series, and the power-chord cases go
through a tanh stage — the point of those cases is precisely the
intermodulation junk distortion adds near the flat seventh, which is what
fools an ungated matcher.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import backing_track as bt  # noqa: E402

SR = 22050
BPM = 100.0
BEAT = 60.0 / BPM
BEATS_PER_CHORD = 8  # two bars each, well past any minimum-run rule

NOTE_PC = {n: i for i, n in enumerate(bt.KEY_NOTE_NAMES)}
QUALITY = dict(bt.CHORD_QUALITY_INTERVALS)


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12.0)


def pluck(freq: float, dur: float, harmonics: int = 8, decay: float = 4.0) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    env = np.exp(-decay * t)
    out = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        out += (1.0 / h ** 1.4) * np.sin(2 * np.pi * freq * h * t)
    return (out * env).astype(np.float32)


def render_case(chords: list, distort: bool, out_dir: Path) -> None:
    """chords: [(root_name, quality), …], each held BEATS_PER_CHORD beats."""
    out_dir.mkdir(parents=True, exist_ok=True)
    total = int(len(chords) * BEATS_PER_CHORD * BEAT * SR) + SR
    guitar = np.zeros(total, dtype=np.float32)
    bass = np.zeros(total, dtype=np.float32)
    drums = np.zeros(total, dtype=np.float32)
    rng = np.random.default_rng(7)

    for ci, (root, quality) in enumerate(chords):
        root_pc = NOTE_PC[root]
        for b in range(BEATS_PER_CHORD):
            beat_idx = ci * BEATS_PER_CHORD + b
            at = int(beat_idx * BEAT * SR)
            # guitar: the chord, voiced from E3 upward
            for interval in QUALITY[quality]:
                m = 52 + ((root_pc - 4) % 12) + interval
                note = pluck(midi_hz(m), BEAT * 1.6)
                guitar[at:at + len(note)] += note[:max(0, total - at)][:len(note)]
            # bass: the root, two octaves down, on every beat
            bnote = pluck(midi_hz(28 + ((root_pc - 4) % 12)), BEAT * 1.2, harmonics=4, decay=5.0)
            bass[at:at + len(bnote)] += bnote[:max(0, total - at)][:len(bnote)]
            # drums: a broadband hit per beat so beat tracking has something
            hit = (rng.standard_normal(int(0.05 * SR)) *
                   np.exp(-40 * np.arange(int(0.05 * SR)) / SR)).astype(np.float32)
            drums[at:at + len(hit)] += hit

    if distort:
        guitar = np.tanh(6.0 * guitar / (np.max(np.abs(guitar)) or 1.0)).astype(np.float32)

    import soundfile as sf
    for name, sig in (("other", guitar), ("bass", bass), ("drums", drums)):
        peak = np.max(np.abs(sig)) or 1.0
        sf.write(out_dir / f"{name}.wav", (sig / peak * 0.8).astype(np.float32), SR)


CASES = [
    # (name, chords, distort, what must hold)
    ("triads_major_minor", [("C", "maj"), ("A", "min"), ("F", "maj"), ("G", "maj")], False,
     "clean triads must NOT read as power chords"),
    ("sevenths", [("G", "7"), ("C", "7"), ("G", "7"), ("C", "7")], False,
     "genuine dominant 7ths must read as 7"),
    ("power_chords_distorted", [("A", "5"), ("D", "5"), ("G", "5"), ("E", "5")], True,
     "distorted power chords must read as 5, not 7 and not maj"),
    ("held_chord", [("C", "maj")] * 6, False,
     "one chord held for 12 bars must be ONE chip"),
    ("major_minor_same_root", [("A", "maj"), ("A", "min"), ("A", "maj"), ("A", "min")], False,
     "a real maj->min move on one root must still be seen"),
]


def evaluate(name: str, chords_truth: list, detected: list) -> dict:
    runs = []
    for c in detected:
        lab = (c["root"], c["quality"])
        if runs and runs[-1][0] == lab:
            runs[-1][1] += 1
        else:
            runs.append([lab, 1])
    counts = Counter((c["root"], c["quality"]) for c in detected)
    truth_set = {(r, q) for r, q in chords_truth}
    top = [lab for lab, _ in counts.most_common(len(truth_set))]
    return {
        "chips": len(runs),
        "expected_chips": len(chords_truth),
        "top_labels": top,
        "correct_top": set(top) == truth_set,
        "share_in_truth": round(
            sum(n for lab, n in counts.items() if lab in truth_set) / max(len(detected), 1), 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", type=Path, default=Path("/tmp/chord_regression"))
    ap.add_argument("--case", action="append", help="run only these cases")
    args = ap.parse_args()

    failures = 0
    print(f"{'case':26s} {'chips':>6s} {'want':>5s} {'in-truth':>9s} {'labels ok':>10s}  note")
    print("-" * 110)
    for name, chords, distort, note in CASES:
        if args.case and name not in args.case:
            continue
        d = args.work / name
        render_case(chords, distort, d)
        analysis = bt.analyze_track(d)
        detected = analysis.get("chords") or []
        if not detected:
            print(f"{name:26s} {'-':>6s} {len(chords):>5d} {'-':>9s} {'NO CHORDS':>10s}  {note}")
            failures += 1
            continue
        r = evaluate(name, chords, detected)
        ok = "yes" if r["correct_top"] else "NO"
        if not r["correct_top"] or r["chips"] > r["expected_chips"] * 2:
            failures += 1
        print(f"{name:26s} {r['chips']:>6d} {r['expected_chips']:>5d} "
              f"{r['share_in_truth']:>9} {ok:>10s}  {note}")
        print(f"{'':26s} detected: {[bt._chord_display_name(a, b) if a else 'N' for a, b in r['top_labels']]}")

    print(f"\n{failures} case(s) failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
