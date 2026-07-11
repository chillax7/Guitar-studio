# Setup Guide — Orpheus Guitar Studio

A guide for getting the app running on your own Mac. No coding
experience needed — you're just copy-pasting a handful of commands into
Terminal, one at a time. Everything runs locally on your machine; nothing
you do here uploads anything anywhere.

**What you'll end up with:** an app that splits a song into separate
parts (vocals/drums/bass/guitar/etc.), lets you build your own backing
track by muting whichever parts you don't want, and a "Play Along" mode
so you can plug in a guitar and jam over the result — with amp
modeling, a tuner, and the ability to record yourself playing.

## Before you start

- A Mac. Apple Silicon (M1/M2/M3/M4) is noticeably faster for the
  song-splitting step; an Intel Mac still works, just slower.
- **About 10GB of free disk space** — the audio-separation engine pulls
  down several GB of machine-learning libraries and model files.
- **20–30 minutes**, mostly spent waiting on downloads rather than
  actually doing anything.

## Step 1 — Open Terminal

Press `Cmd + Space`, type **Terminal**, press Enter. A plain black/white
window opens with a blinking cursor — that's where every command below
gets pasted.

Each block below is one command. Paste it in (`Cmd + V`), press Enter,
and wait for it to finish before moving to the next one.

## Step 2 — Install Homebrew (skip if you already have it)

Homebrew is the standard way to install developer tools on a Mac. If
you're not sure whether you have it, type `brew --version` — if that
prints a version number, skip to Step 3.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It'll ask for your Mac password at some point (typing it shows nothing on
screen — that's normal, just type it and press Enter) and may print
extra instructions at the end about adding Homebrew to your PATH. If it
does, copy-paste and run whatever command it shows you before continuing.

## Step 3 — Install the tools the app needs

```bash
brew install python@3.12 ffmpeg git
```

## Step 4 — Download the app

This puts it on your Desktop — feel free to pick somewhere else.

```bash
cd ~/Desktop
git clone https://github.com/chillax7/Guitar-studio.git
cd Guitar-studio
```

## Step 5 — One-time setup

```bash
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

That last command is the slow one — it's installing the actual
song-separation engine (a few GB), and can take 10–15 minutes depending
on your internet connection. Let it run; it's normal for it to look like
nothing is happening for stretches at a time.

## Step 6 — Build the launcher and start the app

```bash
bash scripts/build_app.sh
```

This creates **Guitar Studio.app** inside the folder. Double-click it in
Finder to launch — from now on, that's the only thing you need to do to
open the app.

**First launch only:** macOS will block it because it isn't from the App
Store. Right-click the app → **Open** → **Open** again to confirm. (Or:
System Settings → Privacy & Security → scroll down → **Open Anyway**.)
You only have to do this once.

Your browser should open on its own to the app.

## Step 7 — Try it out

- Drag an MP3 or WAV onto the sidebar (or click it to pick a file).
- Click **Separate** — the first time you use a given model it also
  downloads its weights (up to ~700MB, one-time, needs internet), so the
  very first separation is slower than every one after it.
- Mute/solo stems, drag faders, build your backing track.
- Click **🎸 Play Along** to plug in a guitar (or use your Mac's built-in
  mic) and play over what you built.

For the full feature tour — Export, looping, the tuner, recording
yourself, everything — open **USER-MANUAL.md** from the folder you just
downloaded.

## Starting it again later

Just double-click **Guitar Studio.app**. None of the setup steps need
repeating — that's a one-time thing.

## If something goes wrong

- **"command not found"** for `brew`, `python3.12`, or `git` — close
  Terminal completely and reopen it, then try again (a fresh window
  picks up changes Homebrew made to your PATH).
- **`pip install` fails partway through** — just run
  `pip install -r requirements.txt` again; a dropped connection
  mid-download is the most common cause, and it resumes sensibly.
- **"Apple could not verify..." when opening the app** — see Step 6,
  right-click → Open.
- **Anything else** — check the Troubleshooting section in
  USER-MANUAL.md, or reach out to Chris.
