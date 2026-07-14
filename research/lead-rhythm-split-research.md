# Lead/Rhythm Guitar Separation — Deep Research: How Others Do It, and How We Could Train Our Own

**Status:** research document (July 2026), extending
[guitar-separation-upgrade-spec.md](guitar-separation-upgrade-spec.md) §4,
which established in early 2026 that no open model or dataset for
role-based guitar separation existed. This doc goes further: what Moises
actually does (new evidence), whether the landscape has changed, and a
concrete, costed plan for training our own model — data sources, example
counts, compute, and an honest answer on RLHF.

---

## 1. How the one shipping product does it — new evidence

Since the earlier spec was written, a first-party source surfaced: an
[Apple Developer article on Moises](https://developer.apple.com/articles/moises/)
in which they describe their pipeline. Key facts, now confirmed rather
than guessed:

- **Two-tier separation.** Level 1 splits the mix into instrument stems
  (vocals/guitar/drums/bass). Level 2 runs *within* a stem: lead vs.
  rhythm guitar, or kick vs. snare vs. hi-hat. Our existing
  `split-guitar` cascade (mix → guitar stem → second-stage split) is the
  right shape — Moises does the same thing, just with a trained model as
  the second stage instead of our panning heuristic.
- **The moat is data, not architecture.** Moises trains on licensed
  music, an internal catalog of unreleased songs, and **custom
  commissioned recordings** (they name Abbey Road sessions), all labeled
  **manually, in-house**, using a purpose-built internal annotation app.
  When they find a coverage gap they commission recordings to fill it
  (their example: songs in 5/4 and 6/8 for the time-signature model).
- **Augmentation by random mixing** — recombining stems into endless
  synthetic mixtures — is confirmed as part of their training recipe
  (also described in their [MoisesDB paper](https://arxiv.org/pdf/2307.15913)).
- Architecture is undisclosed, but their public research and the entire
  competitive field (MVSEP's guitar models, the MDX23 winners) sit on
  the **BS-RoFormer / Mel-RoFormer / MDX23C** family — the same family
  our `bs_roformer_sw` stem model already comes from. There is no reason
  to believe the lead/rhythm model is architecturally exotic.

**Conclusion:** Moises' lead/rhythm split is (with high confidence) a
standard two-stem separation network from the known-good family, trained
on a proprietary, manually-labeled corpus of role-labeled guitar
multitracks. The algorithm is replicable; the dataset is the entire
moat. That's actually good news — data is a problem money and cleverness
can solve; a secret architecture wouldn't be.

## 2. Has the open landscape changed since the last look?

Mostly no, with two developments worth knowing:

- **[GuitarDuets](https://arxiv.org/abs/2507.01172) (ISMIR 2025)** — the
  first *monotimbral* (same-instrument) guitar separation dataset/paper:
  ~3 hours of real + synthesized classical guitar duets, Demucs adapted
  to separate two guitars of near-identical timbre, with a joint
  transcription+separation trick to help. Still classical, still
  duet-only, still no band mix — but it demonstrates the core claim that
  a Demucs/RoFormer-family model **can** learn to split two
  same-timbre guitars when given labeled pairs. The "it's impossible
  without a timbre difference" worry is dead; it's purely a data
  problem.
- **[GuideSep](https://github.com/YutongWen/GuideSep) (ISMIR 2025)** —
  user-guided *generative* (diffusion) separation: you hum or play the
  target melody, and it extracts the matching part from the mix. Not a
  turnkey lead/rhythm splitter, but a genuinely interesting fallback UX
  for us: "play 4 bars of the part you want isolated" is something a
  guitarist — our exact user — can do trivially. Worth a weekend
  evaluation on its released checkpoint. **Update (v3.2 diligence pass):**
  see [guidesep-evaluation.md](guidesep-evaluation.md) — the "play 4 bars"
  pitch undersells it: it also wants a hand-sketched mel-spectrogram mask
  per separation via a Jupyter notebook UI, not a turnkey checkpoint run.
  Narrowed to "worth an afternoon of env setup + one listening test," not
  a weekend, and gated before any real UI-integration work is scoped.
- Still **no open role-labeled dataset** and no open lead/rhythm model.
  MoisesDB remains timbre-labeled (acoustic/clean/distorted), not
  role-labeled.

## 3. The plan: could we train one? Yes — here's the full recipe

### 3.1 The framing that makes it tractable

Train a **second-stage, 2-stem model**: input = the guitar stem our
existing separation already produces; outputs = `lead` + `rhythm`.
Never train on full mixes — the first stage already solved that, the
second-stage problem is far cleaner (GuitarDuets validates exactly this
cascade shape), and training a 2-stem model is the cheapest kind there
is.

### 3.2 Training data — the real work

The ground truth needed is `(guitar_mix, lead, rhythm)` triples. Nobody
will hand these to us; here's the sourcing stack, best-leverage first:

**Source A — rendered GuitarPro tabs (the volume play).**
The [DadaGP](https://github.com/dada-bots/dadaGP) corpus is ~26,000
GuitarPro tabs, and GuitarPro files carry **named tracks** — the
community's own labels literally say "Lead Guitar", "Rhythm Guitar",
"Guitar Solo", "Riff". Where names are missing or vague, role can be
inferred *symbolically* (this is the trick: in MIDI/tab domain, the
ground truth is computable — chord density, polyphony ratio, pitch
range, bends/slides frequency separate lead from rhythm with high
precision). Pipeline: filter tabs to ones with ≥2 clearly-roled guitar
tracks → render each track separately through a realistic guitar
synthesis chain (the SynthTab approach) → **re-amp every rendered DI
through randomized NAM captures + cab IRs**. This last step is our
unfair advantage: the project already sits on **261 NAM captures and
~3,000 IRs** — a tone-randomization engine most labs would have to go
build. Output: effectively unlimited role-labeled triples; realistic
target ~40–80 hours after quality filtering.
*Risk: synth-to-real domain gap — rendered tabs sound stiffer than
human performances. Mitigations: humanization (timing/velocity jitter),
the NAM/IR randomization above, and Sources B–D as real-audio anchors.*

**Source B — GuitarSet's built-in role labels (small but real).**
[GuitarSet](https://guitarset.weill.cornell.edu/) recorded every excerpt
twice — a **comping** (rhythm) take and a **soloing** (lead) take, per
player, per progression. That is role-labeled real guitar, ~3 hours,
acoustic. Mix comping+soloing takes of the same progression → real
`(mix, lead, rhythm)` triples. Small, acoustic-only, but zero-cost and
real. EGDB adds ~2h of electric DI (unlabeled by role, usable for tone
augmentation).

**Source C — self-recorded DI takes (the Moises move, at hobby scale).**
Moises commissions Abbey Road; we have a guitarist with a rig this app
literally records DI through. Every practice session with Rate My Take
(v4) captures dry takes; recording deliberate rhythm-part and lead-part
takes over your own backing tracks — and inviting a few guitarist
friends to do the same — builds exactly the data Moises pays for.
Target: 2–5 hours of real, played, role-labeled electric guitar. Small
numbers of *real* examples matter disproportionately when the bulk is
synthetic (they anchor the domain).

**Source D — random-mix augmentation (the multiplier).**
The confirmed Moises/MoisesDB technique: any lead track can be mixed
with any rhythm track (key/tempo-matched or not — separation models
tolerate musical nonsense surprisingly well), at random gains, with
random effects. This multiplies effective dataset size by orders of
magnitude; it's why 40 real hours can train like 400.

**How many examples are enough?** Benchmarks from the field: MUSDB18 —
the dataset behind an entire generation of usable separation models —
is **10 hours / 100 songs**; MoisesDB is **14 hours / 240 songs**;
GuitarDuets got a working monotimbral split from **~3 hours** in its
narrow domain; community fine-tunes on MVSEP routinely reach useful
quality from 50–300 songs. Planning numbers:
- **Proof of concept:** ~10 h (mostly Source A + all of B) —
  fine-tuned, should beat the panning heuristic if it works at all.
- **Genuinely useful:** 40–80 h synthetic + 3–5 h real.
- **Moises-competitive:** unknowable, but plausibly 100 h+ with heavy
  curation — not the first target.

### 3.3 Architecture & training — the easy part

- **Framework:** [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)
  — the community-standard open training repo behind most MVSEP models;
  supports Mel-RoFormer/BS-RoFormer/MDX23C/HTDemucs, has exactly our
  dataset format (folders of stem WAVs), and documented fine-tuning
  ("always better to start from old weights even if shapes don't fully
  match").
- **Recipe:** fine-tune an existing open **guitar-stem** checkpoint
  (already trained to know what guitar is) into a 2-stem lead/rhythm
  head, rather than training from scratch. Loss and eval: standard L1 +
  SDR, nothing exotic needed.
- **Compute:** the repo's configs assume a single 48 GB A6000; with
  gradient accumulation a 24 GB RTX 4090 works. Fine-tuning scale: days,
  not weeks. Rented (RunPod/Lambda, ~$0.40–2/hr), a full experiment
  cycle including false starts is realistically **$100–500 total** —
  the entire compute cost is smaller than one year of a Moises Pro
  subscription. From-scratch training would be 5–10× that; fine-tuning
  makes it unnecessary.
- **Inference/integration:** the trained checkpoint runs through the
  same `audio-separator`/torch stack the app already ships. It slots in
  as a new backend for the existing `split-guitar` command — the UI
  (Candidate A/B, correlation display) barely changes; the candidates
  just get honest names.

### 3.4 Evaluation

- **Objective:** SDR on held-out *synthetic* triples (where true stems
  exist), the same metric the whole field reports.
- **Subjective (the one that matters):** the existing 5-song validation
  set plus an A/B against (a) our current panning heuristic and (b) a
  one-month Moises subscription run over the same songs — that
  subscription is Phase 0 below, and it sets the quality bar honestly
  before any training money is spent.

### 3.5 Is RLHF an option? Honest answer: not the tool for this — but its cousin is

- **Classic RLHF does not fit.** RLHF fine-tunes a *generative policy*
  (an LLM, a diffusion model) against a learned reward of human
  preferences. A mask-based separator is a deterministic regression
  model with exact ground truth available — when you have true stems,
  supervised loss beats any preference signal; there's no "policy" to
  explore and no reward model needed. Audio RLHF/DPO work exists
  ([BATON](https://arxiv.org/pdf/2402.00744),
  [Tango 2](https://arxiv.org/pdf/2404.09956)) but targets
  text-to-audio *generation*, not separation. (One footnote: if the
  field's generative separators like GuideSep mature, DPO-style
  preference tuning becomes applicable to *them* — worth knowing, not
  worth planning on.)
- **What human feedback IS for, per Moises themselves:** labeling and
  ranking. Their in-house annotation app is humans labeling roles and
  ranking separation quality — human-in-the-loop *data curation*, not
  RLHF. Our equivalents, all cheap:
  1. **Label verification:** a small web page (we build web pages…)
     playing a rendered track pair, human confirms/corrects the
     lead/rhythm auto-label — an hour of clicking cleans hundreds of
     examples.
  2. **Checkpoint selection:** A/B listening between training
     checkpoints on real songs (SDR and ears disagree at the margins;
     ears win).
  3. **Active learning:** run the model over the real library, hand-fix
     the worst failures' labels, add to training, repeat. This loop is
     the budget version of what Moises does at scale.

## 4. Sequenced plan with gates

- **Phase 0 — calibrate (days, ~$30).** One month of Moises Premium;
  run the 5-song validation set through their lead/rhythm split.
  *Gate:* if even Moises' output is unusable on our kind of material,
  stop — the state of the art isn't good enough to chase yet. Also
  evaluate GuideSep's checkpoint while at it.
- **Phase 1 — data pipeline (the real project, ~2–4 weeks of effort).**
  DadaGP filtering + symbolic role labeling; SynthTab-style rendering;
  NAM/IR re-amp randomization; GuitarSet triples; first self-recorded
  takes. *Gate:* 10 h of verified triples that sound plausible blind.
- **Phase 2 — proof-of-concept fine-tune (~1 week, <$200).** ZFTurbo
  repo, 2-stem fine-tune from a guitar checkpoint. *Gate:* beats the
  panning heuristic in blind A/B on ≥3 of the 5 validation songs.
- **Phase 3 — scale what worked.** More rendered hours, more real
  anchors, active-learning loop, integrate as a `split-guitar` backend.
- **License note before anything ships publicly:** MoisesDB is
  NC-licensed (fine for personal use, blocks commercialization);
  DadaGP's tabs are community transcriptions of copyrighted songs —
  training on *renders* of them for a personal tool is low-risk, but a
  commercial release would need this looked at properly. Same class of
  caveat already flagged in [appstore-plan.md](../appstore-plan.md).

## 5. Bottom line

Nobody has published how to do this because the answer is boring:
**an ordinary 2-stem separation model, plus a role-labeled dataset
nobody else has bothered to build.** The dataset is buildable at hobby
scale — tab-corpus rendering through our own NAM/IR library gets the
volume, GuitarSet and your own DI takes anchor it in reality, and the
total out-of-pocket cost of finding out (Phase 0→2) is a few hundred
dollars and some weekends. RLHF is the wrong tool; a human-in-the-loop
labeling/ranking loop — the thing Moises actually does — is the right
one, and we're unusually well-equipped for it because the annotator,
the guitarist, and the product owner are the same person.

## Sources

- [Apple Developer — How Moises splits songs](https://developer.apple.com/articles/moises/)
- [Moises guitar-separation announcement](https://moises.ai/newsroom/product-announcements/new-guitar-separation-models/)
- [MoisesDB paper (ISMIR 2023)](https://arxiv.org/pdf/2307.15913)
- [GuitarDuets — classical guitar duet separation (ISMIR 2025)](https://arxiv.org/abs/2507.01172)
- [GuideSep — user-guided generative separation (ISMIR 2025)](https://arxiv.org/abs/2507.01339), [code](https://github.com/YutongWen/GuideSep)
- [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)
- [MVSEP algorithm list (guitar models: MDX23C/Mel-RoFormer/BS-RoFormer family)](https://mvsep.com/en/algorithms)
- [DadaGP GuitarPro corpus](https://github.com/dada-bots/dadaGP)
- [GuitarSet](https://guitarset.weill.cornell.edu/)
- [BATON — text-to-audio human feedback](https://arxiv.org/pdf/2402.00744)
- [Tango 2 — DPO for text-to-audio](https://arxiv.org/pdf/2404.09956)
