# Jarvis — AI Desktop Assistant

**▶ Try it in your browser:** https://sangamyo.github.io/ai-desktop-assistant/

Jarvis is a voice assistant you talk to or type to. It answers with live data and does small jobs for you: weather for any city, Wikipedia summaries, word definitions, maths, timers and reminders, notes, web and YouTube search, and opening sites. The desktop app can also launch your apps, play songs from your Music folder and start hand-gesture control.

It started in May 2025 as a small Tkinter script ([`legacy/frontend.py`](legacy/frontend.py)) and was rebuilt as v2. The rebuild added a shared, tested skill engine, a redesigned desktop window and a web edition.

## What you can ask

| Ask | What happens |
|-----|--------------|
| *What's the weather in Mumbai?* | Current conditions, feels-like, high/low, humidity and wind ([Open-Meteo](https://open-meteo.com)) |
| *Tell me about Alan Turing* · *who is…* · *how tall is Mount Everest* | A two-sentence Wikipedia summary with a link |
| *Define serendipity* · *what does ephemeral mean* | Definition from Wiktionary |
| *Calculate 18% of 2,499* · *12 times 7* · *square root of 81* | Safe calculator (a small parser, no `eval`) |
| *Set a timer for 5 minutes* · *remind me in 10 minutes to stretch* | Countdown with a chime and notification |
| *Take a note buy milk* · *show my notes* · *clear notes* | Notes saved on your device |
| *Play lofi beats* · *search for…* · *open GitHub* | YouTube, Google, websites |
| *Open VS Code* · *play music* · *gesture control* | Desktop app: launch apps, play local songs, start gesture control |
| *Tell me a joke* · *flip a coin* · *roll a dice* · *help* | The fun stuff |

## Web edition

`web/` is a static site, so there is no server and no API keys:

- **Voice in** uses the browser's Web Speech API (Chrome, Edge and Safari). **Voice out** uses speech synthesis, with a choice of voice and speed. You can also type.
- **The orb** reacts to what Jarvis is doing: it breathes when idle, follows your voice level while listening (mint), spins while thinking (sky) and pulses while speaking (amber).
- **Answers come as cards**: weather, Wikipedia (with thumbnail), dictionary, calculator, live timer countdowns, notes.
- **Keys:** `Space` to talk, `Esc` to stop, `/` to type.

**Privacy:** in Chrome and Edge, speech recognition is done by the browser's speech service (Google). Notes and settings stay in your browser's local storage. Weather, Wikipedia and Wiktionary requests go straight from your browser to those services.

Run locally: `python -m http.server -d web 8000`, then open http://localhost:8000.

## Desktop app

`desktop/` is a Tkinter app (Python 3.10+). Typing works out of the box; voice needs the optional packages.

```sh
cd desktop
pip install -r requirements.txt   # optional: pyttsx3, SpeechRecognition, PyAudio (voice)
python -m jarvis
```

Settings (environment variables):

| Variable | Default | Used for |
|----------|---------|----------|
| `JARVIS_MUSIC_DIR` | `~/Music` | "play music" picks a random song from here |
| `JARVIS_CITY` | — | city for "what's the weather" when you don't name one |
| `JARVIS_GESTURE_DIR` | — | path to [control_with_hand_gesture](https://github.com/sangamyo/control_with_hand_gesture); otherwise the web demo opens |

Keys: `Ctrl+Space` to talk, `Esc` to stop, `Enter` to send.

## Tests

```sh
cd web && node --test          # skill engine (parsing, calculator, timers, notes, weather)
cd desktop && pytest -q        # same skills in Python, plus apps/music
```

Both suites run on every push. The web edition then deploys to GitHub Pages (`.github/workflows/`).

## Layout

```
web/       index.html · styles.css · app.js (UI, orb, voice) · skills.js (intents + replies) · skills.test.mjs
desktop/   jarvis/skills.py (intents + replies) · jarvis/voice.py · jarvis/app.py (Tkinter UI) · tests/
legacy/    frontend.py — the original 2025 version
```

Built by [Hari Om Kasaundhan](https://sangamyo.github.io/terminal/). Weather by Open-Meteo, answers from Wikipedia and Wiktionary (CC BY-SA).
