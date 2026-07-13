# Guitar Separation Upgrade — Specification (BT-13 + BT-14)

**Status:** research + proposal, not yet built. Written to unblock a joint decision: [enhancements-backlog.md](../enhancements-backlog.md) lists **BT-13** (next-gen separation model) and **BT-14** (real ML lead/rhythm guitar split) as separate backlog items, but they are not independent — the choice of separation engine (BT-13) determines the quality of the `guitar` stem that any lead/rhythm split (BT-14) has to work with. This document researches both together and proposes a coupled decision.

**Relationship to other specs:** extends `engine-spec.md` §3.1 (source separation) and §3.4 (guitar lead/rhythm split), which describe the current Demucs `htdemucs_6s` + stereo-panning-heuristic implementation this document proposes to upgrade.

---

## 1. The coupling, stated plainly

`split-guitar` (engine-spec.md §3.4) takes the `guitar` stem produced by separation and heuristically splits it by stereo panning. Its known failure mode — confirmed by ear across the 5-song validation set (Scream Aim Fire, Killers, Wrathchild, Moonlight Shadow, Sultans of Swing; see project memory) — is not really about the panning math. It's that **the `guitar` stem it starts from is itself heavily degraded**: independent benchmarking puts `htdemucs_6s`'s guitar-stem quality at **SDR 2.59 dB** on a 71-song test set, dramatically lower than its vocals/drums/bass performance (~8–9 dB) or than newer architectures' guitar performance (**9.05 dB** for BS-RoFormer SW — see §3). A split algorithm, however good, cannot recover a distinction that's already buried in bleed and artifacts from a noisy source stem.

That means: **any BT-14 work should not start from `htdemucs_6s`'s guitar stem.** Whatever engine wins the BT-13 decision becomes the input to BT-14, so the two have to be decided together, and BT-13 should be evaluated partly on **guitar-stem SDR specifically** (a number most stem-separation coverage doesn't report, because most use cases only care about vocals/drums/bass), not just overall/average SDR.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| SDR | Signal-to-Distortion Ratio (dB) — the standard source-separation quality metric; higher is better, differences of 1–2 dB are perceptually noticeable |
| 4-stem | vocals / drums / bass / other |
| 6-stem | 4-stem + guitar + piano |
| Role split | Splitting a single instrument's stem by *musical function* (lead vs. rhythm guitar) — as opposed to splitting by *instrument identity* (guitar vs. drums) or *timbre* (acoustic vs. distorted electric), which is what all mainstream separation research targets |
| Cascade / hierarchical separation | Running a second, specialized separation stage on the *output* of a first stage (e.g. splitting an already-isolated `guitar` stem further) rather than one model doing everything at once |

---

## 3. Research: separation engine landscape (BT-13)

### 3.1 Where Demucs stands today

- `htdemucs`/`htdemucs_6s` (Meta/FAIR, Hybrid Transformer Demucs) is the model this project already uses. **The upstream repo is no longer actively maintained** — the original author left Meta and maintains a personal fork; only critical bug fixes land. This is itself a reason to plan a migration rather than assume the current engine will keep improving.
- Guitar-stem quality specifically: **SDR 2.59 dB** on a 71-song test set (independent benchmark). For comparison, vocals/drums/bass on the same family of models run **8–11 dB**. The 6th/7th "extra" stems (guitar, piano) were always the weakest part of the 6-stem model, and that gap is the direct cause of `split-guitar`'s unreliability.

### 3.2 Current state of the art

- **BS-RoFormer** (ByteDance, "Band-Split RoPE Transformer") and its sibling **Mel-Band RoFormer** won the Sound Demixing Challenge 2023 (SDX23) and are, as of this research (2026), the community-recognized leading architectures for both 4-stem and 6-stem separation — topping the [MVSEP leaderboard](https://mvsep.com/en/algorithms).
- A 6-stem variant hosted on MVSEP, **"BS Roformer SW"**, reports (Multisong dataset benchmark):

  | Stem | SDR (dB) |
  |---|---|
  | Vocals | 11.30 |
  | Bass | 14.62 |
  | Drums | 14.11 |
  | **Guitar** | **9.05** |
  | Piano | 7.83 |
  | Other | 8.71 |

  The guitar number — **9.05 dB vs. htdemucs_6s's 2.59 dB** — is the headline finding of this research: roughly a 6.5 dB improvement, which is a large, perceptually obvious jump (the difference between "unusable, drowning in bleed" and "clean enough to work with").
- A separate **specialized 2-stem "guitar vs. other" model** also exists on MVSEP (algorithm #17, architectures include MDX23C/Mel-RoFormer/BS-RoFormer), reporting the same 9.05 dB guitar figure with 16.02 dB for "other" — worth evaluating since a model with only one job (isolate guitar) may generalize better than a 6-way split even at matched SDR.

### 3.3 Availability — this is the catch

- The strong 9.05 dB "BS Roformer SW" and guitar-specific models are **hosted by MVSEP** (a solo-developer-run service, `mvsep.com`), not published as downloadable open weights. Checking the open-source training hub for these architectures (`ZFTurbo/Music-Source-Separation-Training`, the same author as MVSEP) confirms: **BS-RoFormer/Mel-Band-RoFormer code (architecture) is open source, but no pretrained 6-stem-with-guitar checkpoint is published there for self-hosting.** The only guitar-stem-producing model with openly downloadable weights in that repo is still Demucs (`htdemucs_6s`).
- MVSEP does offer a **paid, credit-based API** (cost = duration × model multiplier, per-job minimum) with a **free web tier** (queue delays, 100 MB cap). This is a real, individually-purchasable option — unlike Moises (below), which restricts API access to partners.
- Practical read: **the best guitar-stem quality available today is not a drop-in local upgrade.** It's either (a) a cloud call to MVSEP's hosted model, with the usual trade-offs (cost, internet dependency, your music uploaded to a third party — flagged already as a house concern in `backing-track-tone-match-spec.md`), or (b) training/fine-tuning a BS-RoFormer/Mel-Band-RoFormer ourselves on an open dataset (§3.4), which is real engineering effort, not a config change.

### 3.4 A training-data option worth naming: MoisesDB

- **MoisesDB** (Moises' own published research dataset, ISMIR 2023) is a real, usable multitrack dataset with a `Guitar` category split into **Acoustic / Clean Electric / Distorted Electric** — i.e. by *timbre*, not by *role*. It would let us fine-tune an open BS-RoFormer/Mel-Band-RoFormer architecture (the code is open even though pretrained 6-stem weights aren't) to reproduce closer-to-9dB guitar isolation ourselves, without depending on MVSEP's hosted service.
- **License: CC BY-NC-SA 4.0 — non-commercial only.** Fine for this project as a personal/practice tool; would block ever selling a model trained on it without separate data licensing. Worth remembering if this project's status ever changes.
- This does not solve BT-14 (lead/rhythm) directly — see §4 — but it's the most concrete path to a *self-hosted* guitar-stem-SDR upgrade if the MVSEP cloud dependency is unacceptable.

---

## 4. Research: lead/rhythm guitar separation landscape (BT-14)

This is the harder problem, and the research here is much less encouraging than for BT-13.

### 4.1 The one shipped example is a black box

- **Moises** shipped "Lead & Rhythm Guitar Separation" (announced April 2024) alongside "Acoustic & Electric Guitar Separation" — marketed as "the first-ever model that accurately separates lead and rhythm guitars." This is the only commercial product found doing this.
- **No technical disclosure exists.** The announcement is marketing copy only — no architecture, no training data, no accuracy metrics, no benchmark. Moises' own *published* research (the MoisesDB paper/dataset, §3.4) organizes guitars by timbre, not role — meaning even their own public research artifact doesn't contain a lead/rhythm label category. Whatever data or method underlies the shipped feature is undisclosed and not derivable from what they've published.
- **Access:** gated behind Premium/Pro subscription tiers (~$0.04–0.10/minute equivalent). API access is **partner-tier only** — not something a personal project can straightforwardly buy into for evaluation or integration; would require directly contacting Moises to even find out if/how it's purchasable.

### 4.2 No open model or dataset for this exists

Searched specifically for prior art that could be adapted:

- **MoisesDB** — as above, labels by timbre (acoustic/clean-electric/distorted-electric), not role. Not usable as-is for a lead/rhythm classifier or separator.
- **GuitarDuets** (2025 paper) — tackles a structurally similar problem (separating two simultaneous guitar parts), but only for **solo classical guitar duets** (two guitars alone, no band mix, similar nylon-string timbre). The paper's own scope is narrow; it doesn't address full-band electric-guitar mixes with drums/bass/vocals present, and reported results are modest even in its easier setting. Not directly transferable.
- **AudioSep / language-queried separation (LASS)** — general text-conditioned "separate anything you describe" models. These work by associating a *textual/timbral category* (e.g. "guitar" vs. "drums") with an acoustic signature. Lead and rhythm guitar are usually the **same instrument, same tone, same timbre** playing simultaneously — there's no acoustic category for a text query to latch onto, so this class of model doesn't apply to a role-based split.
- **Hierarchical/cascaded separation research** (e.g. an EvoMUSART 2025 ensemble paper) — describes the general idea of running a second separation stage on top of a first-stage stem (this project's own `split-guitar` is already an instance of that idea). But no guitar-specific lead/rhythm case has been demonstrated in the literature; the missing piece everywhere is the same one Moises presumably solved privately: **labeled training data where the ground truth is "this is the lead part, this is the rhythm part" for the same song.**

### 4.3 Why the data problem is the real blocker

Unlike vocals/drums/bass/guitar-vs-other separation — where ground truth is easy to get (record/obtain the isolated multitrack stems from a studio session) — **almost no commercially released song ships with separately labeled "lead guitar" and "rhythm guitar" multitracks.** Both are typically just "guitar tracks" in a session, with no metadata about musical role, and often more than two guitar tracks exist per song (doubles, overdubs) with no consistent labeling convention. Building a supervised dataset would most realistically mean **synthetic mixing**: separately recording or sourcing clean lead-only and rhythm-only guitar performances (e.g. via GuitarSet-style solo recordings, DI capture from willing guitarists, or MIDI-to-audio rendering) and mixing them together to create (mix, lead, rhythm) triples — the same technique MUSDB/MoisesDB used to build their datasets, just with a role label instead of an instrument label. This is a genuine data-collection project, not a weekend script.

---

## 5. Options analysis

### 5.1 BT-13 (separation engine) options

| Option | Guitar SDR | Cost/access | Effort | Risk |
|---|---|---|---|---|
| **A. Stay on `htdemucs_6s`** | 2.59 dB | Free, local, already integrated | None | Upstream unmaintained; guitar quality ceiling stays low |
| **B. MVSEP hosted API** (BS-RoFormer SW or guitar-specific model) | 9.05 dB | Paid per-minute credits; free tier has queue/size limits | Low (API integration) | Cloud dependency, per-use cost, uploads user's music to a third party, service is a solo-developer operation (bus-factor risk) |
| **C. Self-host BS-RoFormer/Mel-Band-RoFormer, fine-tuned on MoisesDB** | Unknown until tried — plausibly close to 9 dB with enough training, likely less without | Free to run once trained | High (GPU training run, dataset licensing is non-commercial, ongoing maintenance) | Genuine ML engineering project; no guarantee of matching the hosted number |
| **D. Self-host open BS-RoFormer/Mel-Band-RoFormer 4-stem checkpoints (no guitar) + keep Demucs only for the guitar/piano stems** | 4-stem quality much improved (~9-11dB vocals/drums/bass), guitar stays at 2.59 dB via Demucs | Free, local | Medium (two models in the pipeline) | Improves everything *except* the one stem BT-14 cares about — solves a different problem than the one motivating this document |

**Recommendation: B for evaluation now, C as the long-term self-hosted target if MVSEP's cloud dependency proves unacceptable in practice.** Concretely: spend a small, cheap first step actually running the 5 validation songs' guitar stems through MVSEP's API/free tier and listening — this is the single highest-value diligence item before committing engineering time to anything else (see §7). If quality and cost are acceptable, B alone may be enough to make `split-guitar`'s existing heuristic dramatically more usable, without touching BT-14 at all.

### 5.2 BT-14 (lead/rhythm split) options

| Option | What it is | Verdict |
|---|---|---|
| **A. Ship a real supervised ML model now** | Train a role-aware separator | **Not viable yet** — no dataset exists (open or ours), and building one is an R&D-scale project (§4.3), not a scoped feature |
| **B. Buy Moises' feature via their API** | Use the one proven implementation | **Blocked pending diligence** — API is partner-tier only; unknown if accessible/priced for a hobby project at all. Even if accessible: black-box quality, no way to verify it generalizes to our songs before paying, ongoing per-minute cost, privacy trade-off (uploads audio) |
| **C. Keep + improve the panning heuristic, fed by a better guitar stem (BT-13)** | No new ML; same `split-guitar` logic, but running on a 9 dB guitar stem instead of 2.59 dB | **Recommended near-term action.** This is very likely to produce a visible quality improvement for close to zero additional engineering, since the validation notes already show the heuristic's failures are entangled with source-stem bleed, not just the panning math itself |
| **D. Enhance the heuristic with additional non-ML signal cues** (e.g. note-density/onset-rate — rhythm parts tend toward static chords locked to the beat grid, lead parts toward sparser, pitch-bent, more rhythmically free lines) | A rules-based upgrade, not a learned model | **Worth a scoped experiment** once BT-02 (beat grid, already in the backlog) exists — it's the only additional cue that doesn't require new training data, and it's honest about not claiming to be ML |
| **E. Real ML split, later** | Revisit once/if a labeled dataset exists (ours, via synthetic mixing, or a future open release) | **Correctly scoped as XL/R&D in the backlog — leave it there.** Don't commit a timeline. |

---

## 6. Recommendation — the coupled decision

1. **Do not build BT-14 as ML work right now.** The research turned up no usable open model, dataset, or affordable API path — the honest state of the art outside Moises' undisclosed internal model is "doesn't exist yet."
2. **Do act on BT-13**, because it's a real, available quality win (2.59 → 9.05 dB on the exact stem `split-guitar` depends on), and it improves the *existing* heuristic split for free — likely the best return on effort of anything in this document.
3. **Treat BT-14 as "improve within the current heuristic paradigm" (options C and D above), not "build/buy an ML model."** Re-badge BT-14 in the backlog picklist from "XL / R&D" to two smaller, honestly-scoped pieces:
   - a near-term item: re-run `split-guitar` against the upgraded guitar stem and re-validate against the 5-song test set (should ride along with whatever BT-13 implementation work happens)
   - a small, separate experiment once BT-02 lands: onset/note-density-informed heuristic refinement
   - keep the true ML ambition on the shelf, explicitly gated on a labeled dataset existing (ours or someone else's) — don't schedule it.
4. **Don't commit to MVSEP as a permanent dependency without testing it first.** It's a solo-maintained cloud service; the immediate action is a cheap evaluation (§7), not an integration commitment.

---

## 7. Open questions / diligence before implementation

1. **Run the 5 validation songs (Scream Aim Fire, Killers, Wrathchild, Moonlight Shadow, Sultans of Swing) through MVSEP's free/paid guitar-stem model and listen**, exactly as was done for the current heuristic. This is the cheapest possible test of whether §3's SDR numbers translate to an audibly better `split-guitar` result on our own material, before any integration work.
2. **Get real MVSEP API pricing** for a typical session (a handful of 3–5 minute songs) — the "credit-based, model-multiplier" pricing found in research wasn't concrete enough to budget from.
3. **Contact Moises** (or search harder) to find out if their lead/rhythm API is purchasable at any tier for a project this size, and if so, get a quote and an audition — don't rule it out solely on "partner-tier" language found in secondary sources.
4. **Check MVSEP's terms of service** on retaining/reusing uploaded audio, given the same privacy concern already flagged for cloud separation generally.
5. **If self-hosting (option C) becomes attractive later**, scope a real feasibility check: can a fine-tuned BS-RoFormer/Mel-Band-RoFormer run at acceptable speed on Apple Silicon (the project's actual hardware), same as the existing "4–5× faster than real-time" benchmark documented for Demucs in `engine-spec.md`.

---

## 8. Out of scope for this document

- Actually implementing any of the above (this is a research + decision document)
- The rest of the BT-13 backlog item's original framing ("evaluate 2-3 candidates") — narrowed here specifically to the guitar-stem question, since that's what couples it to BT-14
- Non-guitar uses of a better separation engine (vocals/drums/bass quality also improve with any of these options, which is a nice side effect but not the driver of this document)

---

## 9. Sources

- BS-RoFormer overview and 2026 standing: [Grokipedia: BS-RoFormer](https://grokipedia.com/page/BS-RoFormer)
- Mel-Band RoFormer paper: [arXiv:2310.01809](https://arxiv.org/pdf/2310.01809)
- MVSEP algorithm benchmarks: [BS Roformer SW (6-stem)](https://mvsep.com/algorithms/77), [MVSep Guitar (guitar/other)](https://mvsep.com/algorithms/17), [MVSEP algorithms index](https://mvsep.com/en/algorithms)
- Open-source training/architecture repo: [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training), [pretrained models doc](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md)
- MVSEP API: [ZFTurbo/MVSep-API-Examples](https://github.com/ZFTurbo/MVSep-API-Examples)
- Demucs maintenance status: [facebookresearch/demucs](https://github.com/facebookresearch/demucs)
- Moises lead/rhythm guitar announcement: [moises.ai newsroom](https://moises.ai/newsroom/product-announcements/new-guitar-separation-models/)
- Moises pricing: [Moises AI Review 2026 (StemSplit)](https://stemsplit.io/blog/moises-ai-review)
- MoisesDB dataset paper: [arXiv:2307.15913](https://arxiv.org/pdf/2307.15913), [Hugging Face dataset card](https://huggingface.co/datasets/wearemusicai/moisesdb)
- GuitarDuets paper: [arXiv:2507.01172](https://arxiv.org/pdf/2507.01172)
- AudioSep / language-queried separation: [arXiv:2308.05037](https://arxiv.org/pdf/2308.05037), [Audio-AGI/AudioSep](https://github.com/Audio-AGI/AudioSep)
- Hierarchical/ensemble separation research: [arXiv:2410.20773](https://arxiv.org/pdf/2410.20773)
- Guitar-stem SDR baseline for htdemucs_6s (2.59 dB, 71-song test set): cited via [LyRuno 2026 AI vocal/stem separation guide](https://lyruno.com/blog/remove-vocals/ai-vocal-separation-guide-latest)
