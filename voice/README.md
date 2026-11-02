# Local voice service (HUD mode, part 6) — phases 1, 2, 4, 5 and 6

One local Python process for speech in and, optionally, speech back. It runs on the machine with the mic,
keeps its models loaded, and serves OpenAI-compatible routes on `127.0.0.1:8765` only. Nothing leaves the
machine. Spec: "Local Voice Service — Spec" (17 Oct 2026); handoff: `docs/hud-mode-handoff.md`, part 6.

```
Ctrl+Alt+B held ─▶ mic 16 kHz ─▶ Silero VAD ─▶ hold recorder ─┬─▶ whisper-tiny language ID (from 1 s in, while you talk)
                                                              └─▶ en ≥ 0.80 ? Phonon-2 : NB-Whisper ─▶ WS /v1/listen  {type: final, …}
                                                                                                  POST /v1/audio/transcriptions
BaseSpace (Vite proxy /voice/*, adds the token) ◀── WS /v1/listen: dictation lands in the launcher (Alt+B)
text ─▶ Kokoro (en) ─▶ wav/pcm        POST /v1/audio/speech   (only with tts.enabled — off by default)
```

**Phase 1:** the service and config, Silero VAD on the live mic, NB-Whisper small (Norwegian; it copes
with English words in Norwegian speech), Kokoro for English speech back, `/health`.

**Phase 4 (reactivity):**
- *Short encoder window.* The encoder is ~85% of NB-Whisper's time and always processed a 30 s window,
  however short the clip. Now it encodes only what the clip needs, at least `stt.min_window_s` (10 s):
  transcribing drops from ~1.4 s to ~0.35 s. 6 s windows started changing words, hence the 10 s floor.
  Clips over 29 s use the normal 30 s path.
- *Speculative transcription.* At `vad.speculative_ms` (250 ms) of silence, the utterance so far is queued.
  If the silence reaches 600 ms, that same utterance is final and its text is usually ready; if speech comes
  back, the result is dropped. Final utterances are never dropped from the queue.
- Warm-up at load was already in phase 1. English partials aren't built yet.

**Phase 2 (bilingual speech-to-text):**
- *Language ID:* vanilla whisper-tiny (int8; NB-Whisper's fine-tune pulls every guess towards Norwegian), on a
  short encoder window like NB-Whisper's, ~60–75 ms. It starts once `lang_id.after_ms` (1 s) of speech is in,
  on its own thread, while you're still talking. A guess under 0.90 is checked again on the whole utterance
  ("What's on my…" came back Malay 0.80 from its first second); that run is hidden in the silence window too.
- *Routing:* English at ≥ 0.80 → **Phonon-2**; everything else (Norwegian, mixed, other, unsure) → NB-Whisper,
  which copes with English words in Norwegian speech while Phonon-2 is English-only.
- *Mode:* Ctrl+Alt+L (`hotkey`) cycles auto → no → en; `POST /v1/control {"mode": …}` sets it. A forced mode
  skips language ID. The hotkey is Windows' `RegisterHotKey`, not a keyboard hook: the service only ever hears
  about that one combination, never what you type. Changes go to `/v1/listen` as `{type: "mode"}`.
- *Sticky language* (the spec's: reuse a ≥ 0.90 detection for 20 s) is built but **off**
  (`lang_id.sticky_window_s: 0`). Live, it caused every misroute: "Open my calendar" right after Norwegian went
  to NB-Whisper (translated to "Åpne kalenderen min!"), and both mixed sentences right after English went to
  Phonon-2 (gibberish). Language ID alone routed all of them right, and skipping it saves nothing you'd
  notice: it runs while you talk.
- *Phonon-2 vs Bark 3.0 Plus:* both are Parakeet TDT 0.6B v3 fine-tunes and fit the `stt.en` slot (Phonon-2
  int8 ONNX through onnx-asr, Bark through sherpa-onnx). On 8 synthetic English clips both got the same words;
  Phonon-2 transcribed in 45–170 ms vs Bark's 56–270 ms, and this Bark export sometimes drops case and
  punctuation. **Phonon-2 is the default.** Bark wasn't tried on the operator's voice:
  `python fetch_models.py --bark` and `stt.en: bark-plus` to try it.
- `final` events now carry `route` (detected / forced / sticky / no-english-engine) and `detected`
  (language, probability, ms); `/health` has the mode, hotkey, English routing status and per-route counts.

**Measured on this PC (i7-11800H), `replay.py`, 4 clips of 1–6 s, end of speech → final, median:**

| | median |
|---|---|
| phase 1 (30 s window, no speculation) | 1,998 ms |
| short window only | 968 ms |
| short window + speculation | 616 ms (600 ms of it is the silence window) |

The spec's target is ≤ 700 ms English / ≤ 900 ms Norwegian. The clips were synthetic English (Kokoro),
which NB-Whisper set to Norwegian *translates*; accuracy on real Norwegian speech is checked live, not by
these numbers. Phase 1's mic test (operator, Norwegian): ~2.7 s, text right in 5 of 6 utterances.

**Phase 2, measured here:**
- 8 synthetic English clips (Kokoro, 8 voices), `replay.py`: 8/8 to Phonon-2, median 602 ms end of speech →
  final (the 600 ms silence window; transcription is done before it closes).
- Live, operator's voice (with sticky on, as first built): 3 Norwegian, 3 English, 2 mixed. Language ID alone
  routed each one right (Norwegian came back "fr 0.95" once, which still means "not English" → NB-Whisper;
  a mixed one came back "en 0.31" → NB-Whisper). All 3 misroutes were sticky reuses, hence sticky off.
  English ~600 ms, Norwegian 740–870 ms: inside the spec's ≤ 700 / ≤ 900 ms. The Norwegian text was right in
  all three ("Legg til…", "Hva står…", "…kulpen?").
- **RAM: ~1.24 GB** with NB-Whisper, whisper-tiny, Phonon-2 and the VAD loaded (Phonon-2 int8 alone is
  ~0.9 GB per its export's card). Over the spec's 1 GB; idle unload is phase 5's job.
- The spec's 60-clip test set (≥ 95% routing) isn't recorded; this is 8 synthetic + 8 live.

**Phase 5 (resources), measured on this PC:**

| | RAM (resident) |
|---|---|
| VAD | 36 MB |
| whisper-tiny (language ID) | 106 MB |
| NB-Whisper small int8 | 358 MB (980 MB peak while loading: the ct2 folder is full precision, made int8 at load) |
| Phonon-2 int8 | 688 MB with onnxruntime's arena off (861 MB with it; same speed, 145 vs 149 ms) |
| Bark 3.0 Plus int8 (only for A/B) | 873 MB |
| the service, everything loaded | 1.17–1.22 GB |
| **after idle unload** | **181 MB** |

- *Idle unload* (`resources.idle_unload_min: 15`): NB-Whisper, the English engine and Kokoro are dropped after
  15 min unused; the VAD and language ID stay. Pressing push-to-talk (or, with the open mic, speech starting)
  reloads them in the background: both in ~3.2 s in parallel, so after a long idle the first sentence is ~1–3 s
  slower, the rest normal. Each model gives its memory back when dropped (lazy.py).
- *Idle CPU:* the VAD's onnxruntime pool of 2 threads never stopped spin-waiting between its 31 frames a second
  and held a whole core in silence (6.3% of this 16-thread machine). On one thread without spinning it's 0.09%.
  With push-to-talk the VAD doesn't run between holds: the whole service idles at **0.04%** (spec: ≤ 3%).
- **Not met:** "≤ 1 GB with everything loaded". Phonon-2 is ~690 MB of it and no smaller ONNX export exists;
  idle unload is what keeps the everyday footprint at ~180 MB.

**Phase 6 (hookup):**
- *Push-to-talk, the default* (`mic.trigger: push_to_talk`, `mic.ptt_key: ctrl+alt+b`): hold the key with any
  window focused, speak, let go. Only that is transcribed; between holds the VAD doesn't run and frames only
  fill the 300 ms pre-roll. The release ends the utterance, so there's no 600 ms silence window: release → text
  was a median 184 ms in `replay.py --ptt` and 114–534 ms live (Phonon-2 / NB-Whisper). Language ID starts
  1 s into the hold. `mic.trigger: always` is the open mic of phases 1–4; live, it turned everything said in the
  room into text, which is why it's no longer the default. `POST /v1/control {"ptt": true|false}` does the same
  as the key (for a button).
- *The token:* every route but `GET /health` needs the Agent-OS gateway's token (`auth.py`). Binding 127.0.0.1
  keeps other machines out, not web pages: browsers don't apply CORS to WebSockets, so any page could have read
  your dictation from `/v1/listen`. The token is the gateway's own (`AGENT_OS_GATEWAY_TOKEN`, else
  `../data/gateway-token`, made in the gateway's format if missing).
- *BaseSpace:* its Vite proxy serves this service at `/voice/*` and adds the token (`ws: true`, so `/v1/listen`
  too). `src/features/voice/voiceClient.ts` keeps one WebSocket for the app. Holding Ctrl+Alt+B opens the
  launcher ("Listening…"); on release the text lands in its input tagged `dictated · NO|EN`, and Enter runs it
  like typed text. Sending it to an agent and speaking replies (`speak()`, there already) is the launcher's AI
  mode, which hud/core wires up.
- `/v1/listen` never worked before this: uvicorn needs the `websockets` package, which wasn't in requirements.

**Not yet:** English partials, the 60-clip routing test set, Piper Norwegian speech, sentence routing and
barge-in (phase 3), dictation reaching an agent and replies spoken (with hud/core's launcher AI mode / HUD).

## Set up (Windows)

```
cd voice
uv venv --python 3.11
.venv\Scripts\activate
uv pip install -r requirements.txt
python fetch_models.py            # Silero VAD, NB-Whisper small, whisper-tiny, Phonon-2 (~1.7 GB download)
python fetch_models.py --bark     # also Bark 3.0 Plus, only to A/B it against Phonon-2
python fetch_models.py --tts      # also Kokoro, only if you turn speech back on
copy voice.example.yaml voice.yaml   # optional: pick the mic, tune the VAD, turn speech back on
python run.py
```

Pick the mic: `python -m sounddevice` lists devices; put the name or index in `audio.input_device`.

## Check it (phase 1 acceptance)

- Speak Norwegian: the console prints `[voice] final (no, nb-whisper-small, … ms): …`, and a client on
  `ws://127.0.0.1:8765/v1/listen` gets `speech_start`, `speech_end` and `final` events.
- With `tts.enabled: true`:
  `curl -X POST http://127.0.0.1:8765/v1/audio/speech -H "content-type: application/json" -d "{\"input\":\"Hello from the OS.\"}" -o hello.wav`
  gives playable English audio. With it off, the route answers 409 and says how to turn it on.
- `curl http://127.0.0.1:8765/health`: loaded models, mic device, RAM, last latencies.
- File transcription: `curl -F file=@clip.wav http://127.0.0.1:8765/v1/audio/transcriptions` (add
  `-F language=en` or `no` to skip language ID).
- Speak English, then Norwegian, then a mix: `final (en, phonon-2, detected en 0.98, …)` for English,
  `nb-whisper-small` for the rest. Ctrl+Alt+L prints `mode: no` / `en` / `auto`.
- Every route but `/health` needs `-H "Authorization: Bearer <agent-os/data/gateway-token>"`; without it, 401.
- With BaseSpace open: hold Ctrl+Alt+B, speak, let go: the launcher opens and the text is in its input.

`python test_voice.py` tests the segmenter, speculation events, push-to-talk holds, routing, idle unload,
the token check, hotkey parsing and config without models or a mic. `python replay.py a.wav b.wav …` plays clips through the real pipeline at real-time pace and
prints each one's engine, route and end of speech → final latency (`--no-speculation`, `--window 0`,
`--en bark-plus|none`, `--mode no|en`, `--ptt` to compare).

## Rules it keeps

- Audio goes from the mic to the transcriber and nowhere else; nothing is stored. Only the text leaves,
  and only to whoever is connected to `/v1/listen` with the token.
- Push-to-talk by default: nothing is transcribed unless the key is held.
- Binds 127.0.0.1; `run.py` refuses any other host.
- Speech back is off unless `tts.enabled: true`; with it off, no TTS model is loaded.
- Below-normal process priority; 4 threads for NB-Whisper, Phonon-2 and Kokoro, 2 for language ID, 1 for the VAD.
- Both hotkeys are registered hotkeys, not keyboard hooks: no other keystroke ever reaches the service.
  Push-to-talk's release is read with GetAsyncKeyState on that one key, only while it's held.
- Phonon-2 and Bark 3.0 Plus weights are CC BY 4.0 (Fermion Research / Conway Research, from NVIDIA's
  Parakeet TDT 0.6B v3); their NOTICE files are kept in `models/`.
