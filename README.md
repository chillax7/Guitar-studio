# Orpheus Guitar Studio

Split any song into separate parts (vocals/drums/bass/guitar/piano/
other), build your own backing track by muting whichever parts you don't
want, then plug in a guitar and jam over the result with amp modeling, a
tuner, effects, and the ability to record yourself playing. Everything
runs locally in your browser, talking to a small Python server on your
own Mac — nothing is uploaded anywhere.

No coding experience needed to set this up — the steps below are
copy-paste commands into Terminal, one at a time.

---

## Setup

**Before you start:** a Mac (Apple Silicon is faster for the song-splitting
step, but an Intel Mac works too), about **10GB of free disk space** (the
separation engine pulls down several GB of machine-learning libraries and
model files), and **20–30 minutes**, mostly spent waiting on downloads.

### 1. Open Terminal

Press `Cmd + Space`, type **Terminal**, press Enter. Each command block
below gets pasted in (`Cmd + V`) and run one at a time — wait for one to
finish before starting the next.

### 2. Install Homebrew (skip if you already have it)

Homebrew is the standard way to install developer tools on a Mac. Not
sure if you have it? Type `brew --version` — if that prints a version
number, skip to step 3.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It'll ask for your Mac password at some point (typing it shows nothing on
screen — that's normal) and may print extra instructions at the end about
adding Homebrew to your PATH. If it does, copy-paste and run whatever
command it shows you before continuing.

### 3. Install the tools the app needs

```bash
brew install python@3.12 ffmpeg git
```

### 4. Download the app

This puts it on your Desktop — feel free to pick somewhere else.

```bash
cd ~/Desktop
git clone https://github.com/chillax7/Guitar-studio.git
cd Guitar-studio
```

### 5. One-time setup

```bash
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

That last command is the slow one — it's installing the actual
song-separation engine (a few GB) and can take 10–15 minutes. Let it run;
it's normal for it to look like nothing is happening for stretches at a
time.

### 6. Build the launcher and start the app

```bash
bash scripts/build_app.sh
```

This creates **Guitar Studio.app** inside the folder. Double-click it in
Finder to launch — from now on, that's the only thing you need to do to
open the app.

**First launch only:** macOS will block it because it isn't from the App
Store. Right-click the app → **Open** → **Open** again to confirm. (Or:
System Settings → Privacy & Security → scroll down → **Open Anyway**.)
You only have to do this once. Your browser should then open on its own
to the app.

### Starting it again later

Just double-click **Guitar Studio.app**. None of the setup steps need
repeating.

---

## Using the app

A quick tour — see [USER-MANUAL.md](USER-MANUAL.md) for the full version
of every feature below, plus keyboard shortcuts and troubleshooting.

**Import a song.** Drag an MP3 or WAV onto the sidebar (or click it to
pick a file). Click the song to select it.

**Separate it into stems.** Pick a model and click **Separate** — this
runs entirely on your Mac and typically takes a fraction of the song's
length. The first time you use a given model it also downloads its
weights (up to ~700MB, one-time, needs internet), so your very first
separation is slower than every one after it. `bs_roformer_sw` (the
default) gives the cleanest guitar isolation.

**Mix.** Each stem gets its own lane: Mute/Solo, a volume fader, Pan, and
a 3-band EQ. Paint over a waveform to mute just a section (e.g. a guitar
solo). Set an A/B loop, add section markers, use the Speed Trainer to
practice a hard passage slow and step it up to full tempo, and turn on
the **Click** for a metronome synced to the song's actual beat. Whatever
you set up is saved automatically per song.

**Play Along.** Click **🎸 Play Along** to plug in a guitar (or use your
Mac's built-in mic) and play over what you built — sharing the exact
same audio engine as the mixer, so there's no extra latency. The rig
runs Gate → Amp (Clean/Analog/Neural amp-modeling) → Cab IR → EQ →
Compressor → Delay/Reverb → Output, with a tuner and input meter always
visible. Save a whole rig setup as a named preset and recall it instantly,
or attach one to a song so it loads automatically. A rolling ~20-second
buffer is always capturing, so **Save that!** rescues a take you didn't
plan to record.

**Record yourself.** With or without a camera — audio-only takes need no
setup at all. Every take is saved and browsable, with lossless trimming.

**Export.** Bounces exactly your mute/gain choices (not Solo/Pan/EQ,
which are for monitoring while you play) to WAV or MP3, with loudness
normalization.

---

## More

- **[USER-MANUAL.md](USER-MANUAL.md)** — every feature, in full detail.
- **[FIRST-SESSION-CHECKLIST.html](FIRST-SESSION-CHECKLIST.html)** — open
  it directly in a browser for a tickable, first-time walkthrough.
- **[TEST-PLAN.md](TEST-PLAN.md)** — a regression checklist for after any
  change.
- **[CLI.md](CLI.md)** — drive the separation/mixing engine directly from
  a terminal, for scripting or batch work.

### If something goes wrong

- **"command not found"** for `brew`, `python3.12`, or `git` — close
  Terminal completely and reopen it, then try again.
- **`pip install` fails partway through** — just run
  `pip install -r requirements.txt` again; a dropped connection
  mid-download is the most common cause, and it resumes sensibly.
- **"Apple could not verify..." when opening the app** — see step 6
  above, right-click → Open.
- **Anything else** — see the Troubleshooting section in
  [USER-MANUAL.md](USER-MANUAL.md).
