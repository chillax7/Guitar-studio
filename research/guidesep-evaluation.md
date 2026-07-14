# GuideSep evaluation — is it worth the weekend?

**Status:** diligence pass only, not a hands-on run. lead-rhythm-split-research.md
§2 flagged [GuideSep](https://github.com/YutongWen/GuideSep) (ISMIR 2025) as
"worth a weekend evaluation on its released checkpoint" — a user-guided
generative separator where "play 4 bars of the part you want isolated" was
floated as a possible alternative UX to `split-guitar`'s panning heuristic.
This is the cheap first step before spending that weekend: read the actual
repo, check what it needs to run, and see whether the premise still holds up
before anyone burns real GPU/wall-clock time on it. Short answer: **the
premise needs revising before this is worth a weekend** — see §4.

## 1. What GuideSep actually is

Not a lead/rhythm splitter, and not a turnkey separation tool. It's the code
release for a research paper: a diffusion-based source separator conditioned
on **two** inputs per separation, not one —

1. **Waveform mimicry** — hum or play the target part (this is the "play 4
   bars" half the research doc's summary was built on).
2. **A hand-sketched mel-spectrogram mask** — drawn by the user in a Jupyter
   widget, as *additional* guidance alongside the waveform condition.

The paper's own framing is "instrument-agnostic separation beyond the
four-stem setup" using generative diffusion instead of a predictive model —
a genuinely different research direction from Demucs/BS-RoFormer-style
separators, aimed at flexibility (isolate *any* part you can hum/sketch, not
just a fixed stem taxonomy), not at speed or turnkey use.

## 2. How you'd actually run it

- **Interface:** `inference.ipynb`, a Jupyter notebook. Loads the checkpoint,
  separates a provided `mix/` file against a `cond/` reference, and "implements
  a simple UI for mask sketching" for the second conditioning input. There is
  no CLI or API — every separation is a manual notebook run.
- **Checkpoint:** hosted on [Hugging Face](https://huggingface.co/YutongCooper/GuideSep-v1),
  publicly downloadable, no gating.
- **License:** MIT on the repo itself — no blocker there (unlike MoisesDB's
  NC license elsewhere in this research track).
- **Environment:** pinned to **Python 3.8** via a dedicated conda env — this
  project's own venv is Python 3.12, so evaluating GuideSep means a fully
  separate environment, not something addable to `requirements.txt`.
  `requirements.txt` itself is plain pip (torch ≥2.0, lightning, hydra,
  soundfile/torchaudio, wandb, pytest, pre-commit — normal research-repo
  scaffolding, nothing exotic or CUDA-hardcoded at the dependency level).
- **Hardware path documented:** the README's install line is
  `conda install pytorch torchvision torchaudio -c pytorch -c nvidia` — written
  for CUDA. Nothing in the repo rules out Apple Silicon (torch's MPS backend
  covers most ops, and requirements.txt has no CUDA-only pin), but nothing
  confirms it either — diffusion U-Nets and complex-STFT masking sometimes hit
  ops MPS doesn't implement, and this would need an actual run to know either
  way. Treat "does it run at usable speed on a Mac" as an open question, not
  an assumption.
- **Diffusion cost:** no inference latency numbers published. Diffusion
  samplers are inherently multi-step (denoise N times per separation) —
  plausibly seconds-to-minutes per song section rather than the near-instant
  panning heuristic. Fine for an offline "separate once, keep the result"
  workflow (this app already treats full-song separation as an offline batch
  step); a blocker if the eventual UX wanted anything interactive.
- **Track record:** MIT-licensed, 31 stars, 4 forks, 0 open issues, last
  pushed 2025-07-31 — light but real interest, no reported breakage, and also
  no independent confirmation of separation quality outside the paper's own
  claims. Normal for a one-paper research release; just means there's no
  crowd-sourced "does this actually work on real songs" signal to lean on.

## 3. The gap between the pitch and the product

lead-rhythm-split-research.md's one-line summary — "play 4 bars of the part
you want isolated" — describes the waveform-mimicry condition accurately,
but leaves out that it's only half the input GuideSep actually wants. The
mel-spectrogram mask sketch is manual, per-separation, notebook-UI work.
Wiring "hum the part" into Guitar Studio as a self-serve feature would mean
either:

- building real UI + backend automation for **both** conditioning inputs
  (a new capture flow for the hum/play reference, *and* something to
  produce a usable mask without asking a practicing guitarist to sketch a
  spectrogram by hand), or
- finding that the mask input can be defaulted/skipped without wrecking
  quality — unconfirmed, would need an actual run against the notebook to
  know.

Either way, that's a scoped UI/integration project in its own right, not a
drop-in fourth `--method` next to `spectral`/`midside`/`hybrid` in
`split-guitar`.

## 4. Verdict

**Worth a narrow, cheap try — not worth a weekend yet, and not what the
original one-liner promised.** Concretely, before committing real time:

1. Set up the isolated Python 3.8 env, pull the HF checkpoint, and run
   `inference.ipynb` as-is (their own bundled `mix/`/`cond/` example first —
   zero risk, confirms the environment actually works) — this alone answers
   the open Apple Silicon / inference-speed questions in §2.
2. If that works, try it once against one real song from this project's
   5-song validation set (guitar-separation-upgrade-spec.md), providing a
   played reference and *some* mask (even a crude one) as the two
   conditioning inputs, and just listen to the result.
3. **Gate before going further:** if the separated output isn't
   noticeably better than what `split-guitar --method hybrid` already gives
   on the same song, stop — the extra UI-automation work in §3 isn't
   justified. If it *is* noticeably better, then and only then does
   scoping the "build a real hum-to-isolate feature" project make sense,
   and that's a new backlog item, not an extension of this one.

This narrows "worth a weekend evaluation" (lead-rhythm-split-research.md) to
"worth an afternoon of environment setup + one listening test" — cheaper
than originally scoped, but also answering a smaller question (does the
checkpoint even work here) rather than the bigger one (is hum-to-isolate a
viable Guitar Studio feature), which stays open pending step 3 above.
